import type { Ref } from 'vue'
import type { ServerMessage } from '#shared/types/game'
import type { Chunk, TerrainEdit, World } from '#shared/utils/world'
import {
  applyPlace,
  applyRemove,
  applyTerrain,
  chunkCoord,
  chunkKey,
  createWorld,
  decodeChunk,
  installChunk,
  parseChunkKey,
  removeChunk,
} from '#shared/utils/world'
import type { WorldPlacement } from '#shared/utils/props'

/**
 * The client's copy of the world, streamed from the server.
 *
 * Nothing here is reactive: the scene reads chunks every frame and the minimap
 * every 120 ms, so Vue proxies would only cost. `chunkCount` is the one
 * UI-facing bit and it is a ref. The `World` itself is built with
 * `generate: false` and no town, because every byte of it arrives as a `chunk`
 * frame — a client that generated anything locally could disagree with the
 * authority, which is the one thing the shared module exists to prevent.
 *
 * Deltas (`terrain` / `place` / `remove`) carry the chunk version they produce,
 * and are applied only when that version is newer than what we hold. A chunk's
 * version counts mutations of its own content, one per mutation, so the number
 * we hold can only ever trail the server's — which is what makes the rule safe.
 * It is still a *newer* test and not a `+1` one: a delta for a chunk we are not
 * holding never arrives, and a chunk we were just re-sent replays deltas we
 * already folded in, which this drops.
 */
export interface UseWorld {
  /** The live world. Non-reactive on purpose. */
  world: World
  /** How many chunks are loaded, for the HUD. */
  chunkCount: Ref<number>
  /** From `welcome.world`: null until connected, false on a server whose
   *  store is in-memory, where everything built is lost on restart. */
  persistent: Ref<boolean | null>
  /** From `welcome.world`: the realm id this server owns, null until connected. */
  realm: Ref<string | null>
  /** Feed a server frame in. Returns true if it was a world frame. */
  handle: (msg: ServerMessage) => boolean
  /** Drop everything (a disconnect invalidates the loaded set). */
  reset: () => void
  /** A whole chunk landed (or was replaced). */
  onChunk: (fn: ChunkListener) => () => void
  /** A chunk left the loaded set and must be unmounted. */
  onUnchunk: (fn: ChunkListener) => () => void
  /** Corner heights or the surface raster changed. */
  onTerrain: (fn: ChunkListener) => () => void
  /** Placements changed. */
  onProps: (fn: ChunkListener) => () => void
  /**
   * Apply a terraform locally, ahead of the server, and notify the scene. The
   * chunk versions are left untouched so the authoritative `terrain` delta
   * still reads as `version + 1` and overwrites these heights with absolute
   * ones. A refused edit simply stays wrong until the chunk is re-sent.
   */
  predictTerrain: (edit: TerrainEdit) => void
}

export type ChunkListener = (cx: number, cy: number) => void

let singleton: UseWorld | null = null

export function useWorld(): UseWorld {
  if (singleton) return singleton

  const world = createWorld({ generate: false, town: false })
  // The owned-piece total is the server's to count: it knows the whole world,
  // and we only ever hold twenty-five chunks of it. Every frame that moves it
  // carries the new number, and only to the player whose number moved.
  const build = useBuild()
  const chunkCount = ref(0)
  const persistent = ref<boolean | null>(null)
  const realm = ref<string | null>(null)

  const listeners = {
    chunk: new Set<ChunkListener>(),
    unchunk: new Set<ChunkListener>(),
    terrain: new Set<ChunkListener>(),
    props: new Set<ChunkListener>(),
  }
  function on(set: Set<ChunkListener>) {
    return (fn: ChunkListener) => {
      set.add(fn)
      return () => set.delete(fn)
    }
  }
  function emit(set: Set<ChunkListener>, cx: number, cy: number) {
    for (const fn of set) fn(cx, cy)
  }

  // A toast is the whole of the reject surface: the edit simply didn't happen,
  // and the reason is one short line the server already phrased for a player.
  const toast = useToast()
  let lastReject = 0
  function reject(reason: string) {
    // The server can refuse a held-down brush eight times a second; one toast
    // per second is plenty to read.
    if (Date.now() - lastReject < 1000) return
    lastReject = Date.now()
    toast.add({ title: reason, icon: 'i-lucide-hand', color: 'warning', duration: 2500 })
  }

  /**
   * A whole chunk landed. `installChunk` is the shared code that buckets its
   * long pieces outward into the neighbours we already hold and adopts theirs
   * inward — the same call the server makes when it restores a chunk from the
   * store, so both sides end up with the same `props` in the same chunks.
   */
  function install(encoded: Extract<ServerMessage, { t: 'chunk' }>) {
    installChunk(world, decodeChunk(encoded))
    chunkCount.value = world.chunks.size
  }

  /* ------------------------------------------------------------------------ */
  /* Frames                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Whether a delta describes a state we do not already hold. */
  function isNewer(chunk: Chunk | undefined, v: number): chunk is Chunk {
    return chunk != null && v > chunk.version
  }

  function handle(msg: ServerMessage): boolean {
    switch (msg.t) {
      case 'welcome':
        build.pieces.value = msg.pieces
        persistent.value = msg.world.persistent
        realm.value = msg.world.realm
        return true
      case 'chunk':
        install(msg)
        emit(listeners.chunk, msg.cx, msg.cy)
        return true
      case 'unchunk': {
        if (!removeChunk(world, msg.cx, msg.cy)) return true
        chunkCount.value = world.chunks.size
        emit(listeners.unchunk, msg.cx, msg.cy)
        return true
      }
      case 'terrain': {
        const chunk = world.getChunk(msg.cx, msg.cy)
        if (!isNewer(chunk, msg.v)) return true
        for (const [index, height] of msg.edits) chunk.heights[index] = height
        if (msg.surface) for (const [index, value] of msg.surface) chunk.surface[index] = value
        chunk.version = msg.v
        emit(listeners.terrain, msg.cx, msg.cy)
        return true
      }
      case 'place': {
        const chunk = world.getChunk(msg.cx, msg.cy)
        if (!isNewer(chunk, msg.v)) return true
        applyPlace(world, msg.piece)
        chunk.version = msg.v
        if (msg.pieces != null) build.pieces.value = msg.pieces
        emitAround(listeners.props, msg.piece)
        return true
      }
      case 'remove': {
        const chunk = world.getChunk(msg.cx, msg.cy)
        if (!isNewer(chunk, msg.v)) return true
        const placement = chunk.placements.find(p => p.id === msg.id)
        applyRemove(world, msg.id)
        chunk.version = msg.v
        if (msg.pieces != null) build.pieces.value = msg.pieces
        if (placement) emitAround(listeners.props, placement)
        else emit(listeners.props, msg.cx, msg.cy)
        return true
      }
      case 'reject':
        reject(msg.reason)
        return true
    }
    return false
  }

  /** A piece can straddle a chunk border, so every chunk that draws it has to
   *  hear about it, not only the one that owns it. */
  function emitAround(set: Set<ChunkListener>, placement: WorldPlacement) {
    const cx = chunkCoord(placement.x)
    const cy = chunkCoord(placement.y)
    for (let ny = cy - 1; ny <= cy + 1; ny++) {
      for (let nx = cx - 1; nx <= cx + 1; nx++) {
        if (world.chunks.has(chunkKey(nx, ny))) emit(set, nx, ny)
      }
    }
  }

  function predictTerrain(edit: TerrainEdit) {
    const versions = new Map<Chunk, number>()
    const gx = Math.round(edit.x)
    const gy = Math.round(edit.y)
    for (let cy = chunkCoord(gy - 2); cy <= chunkCoord(gy + 2); cy++) {
      for (let cx = chunkCoord(gx - 2); cx <= chunkCoord(gx + 2); cx++) {
        const chunk = world.getChunk(cx, cy)
        if (chunk) versions.set(chunk, chunk.version)
      }
    }
    const changed = applyTerrain(world, edit)
    // Keep the versions the server still thinks we are on, so its own delta
    // lands as `version + 1` and overwrites these predicted heights.
    for (const [chunk, version] of versions) chunk.version = version
    for (const chunk of changed) emit(listeners.terrain, chunk.cx, chunk.cy)
  }

  function reset() {
    const keys = [...world.chunks.keys()]
    world.chunks.clear()
    chunkCount.value = 0
    for (const key of keys) {
      const { cx, cy } = parseChunkKey(key)
      emit(listeners.unchunk, cx, cy)
    }
  }

  singleton = {
    world,
    chunkCount,
    persistent,
    realm,
    handle,
    reset,
    onChunk: on(listeners.chunk),
    onUnchunk: on(listeners.unchunk),
    onTerrain: on(listeners.terrain),
    onProps: on(listeners.props),
    predictTerrain,
  }
  return singleton
}
