import type { ServerMessage } from '#shared/types/game'
import {
  CHUNK_CORNERS,
  CHUNK_SIZE,
  applyPlace,
  chunkCoord,
  chunkKey,
  createWorld,
  decodeChunk,
  encodeChunk,
  installChunk,
  isChunkInBounds,
  isTownChunk,
  removeChunk,
  townChunks,
  townPlacementsIn,
  worldPlacements,
} from '#shared/utils/world'
import type { Chunk, TerrainEdit, World } from '#shared/utils/world'
import { generateVegetation } from '#shared/utils/vegetation'
import { brushExtent } from '#shared/utils/building'
import type { WorldPlacement } from '#shared/utils/props'
import { chunkStore } from './chunkStore'
import { flushPieceCounts } from './pieces'
import { flushPositions } from './positions'
import type { ChunkWrite, ExpectedVersion, StoredChunk } from './chunkStore'

/**
 * The server's chunk service.
 *
 * `game.ts` owns players; this owns the ground they stand on. It is the only
 * thing that creates, mutates and hands out chunks: it loads them on first
 * touch, keeps a dirty set for the store, and streams them to each session as
 * that player moves — the 5×5 around them, dropped again once they are four
 * chunks away.
 *
 * Interest management is the whole point. One world of 1024×1024 tiles never
 * travels anywhere: a player sees the 25 chunks they are standing in, and every
 * edit is broadcast only to the sessions that hold the chunk it landed in.
 */

/** The one world. The authored town is seeded into the town chunks at boot;
 *  terrain beyond it is generated on first touch, and the nature kit is seeded
 *  on top of it by `loadChunk` the first time anyone comes near. */
export const WORLD: World = createWorld()

/**
 * From here on the server never invents ground on demand.
 *
 * `createWorld` generated the town chunks while it seeded the town; every
 * other chunk now only exists once `loadChunk` has asked the store for it, so a
 * chunk that is still in flight reads as *missing* rather than as freshly
 * generated terrain that a persisted edit is about to move under a player's
 * feet. `terrainHeight` returns -Infinity for a missing chunk, which the shared
 * physics already treats as a wall.
 */
WORLD.generate = false

/** Chunks streamed around a player: the 5×5 they stand in. */
const LOAD_RADIUS = 2
/** How many that is, for `welcome.world.streamed` — the entry screen's
 *  denominator while terrain lands. */
export const STREAMED_CHUNKS = (LOAD_RADIUS * 2 + 1) ** 2
/** The ring that goes out on the spot: the 3×3 a player is standing in or can
 *  step into before the next tick. A late chunk two away is scenery; a late
 *  chunk underfoot is a hole. */
const URGENT_RADIUS = 1
/** ...dropped once they are further than this, so a player pacing over a chunk
 *  border doesn't re-download the same ring every few seconds. */
const DROP_RADIUS = 4
/** Chunks one session is handed per tick from its queue. A welcome's outer
 *  ring is 16 chunks, so it lands within six ticks — a third of a second —
 *  without any single tick paying for the whole neighbourhood. */
const CHUNKS_PER_TICK = 3

/** Whatever `game.ts` calls a session, seen through the streaming contract.
 *  Kept structural so this module never imports the game loop back. */
export interface ChunkViewer {
  /** Chunk keys this socket currently holds. */
  chunks: Set<string>
  /** Chunk keys owed to this socket, nearest first. Insertion order is ring
   *  order, which is what makes a `Set` the queue. */
  pending: Set<string>
  /** Chunk coordinate at the last sync; NaN before the first one. */
  chunkCx: number
  chunkCy: number
  send: (data: string) => void
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/** Chunks whose in-memory state has run ahead of the store. */
const dirty = new Set<Chunk>()

/** Chunks that are ready to be played on: terrain restored or generated, and
 *  their vegetation seeded. Nothing else is handed to a session. */
const loaded = new Set<string>()

/** Chunks currently being read from the store, so twenty players crossing the
 *  same border cost one read. */
const loading = new Map<string, Promise<Chunk | undefined>>()

/**
 * The version we believe the store holds for each chunk, which is what every
 * write compares against. `null` means "the key was absent when we looked", and
 * a write carrying that only lands while it still is — otherwise another
 * instance got there first and we reload instead of trampling it.
 */
const persisted = new Map<string, ExpectedVersion>()

/** Chunks written per flush. A burst of terraforming is drained over a few
 *  ticks rather than sent as one enormous pipeline. */
const FLUSH_LIMIT = 64

/** Attempts at reading a chunk before giving up on it for now. */
const READ_TRIES = 3
/** Backoff between those attempts, in milliseconds. */
const READ_BACKOFF = [60, 240]

/** A chunk holding no session's interest for this long is dropped from memory.
 *  Long enough that a player pacing across a border never pays for it twice. */
const EVICT_AFTER = 60_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Read a chunk from the store, retrying a transient failure.
 *
 * Rejects rather than resolving to `null` once it has run out of tries. The
 * distinction is the whole point: `null` means "nobody has ever changed this
 * chunk, generate it", and treating a failed read as `null` would hand a player
 * fresh terrain and fresh vegetation on top of a chunk somebody has built a
 * house on — and then persist that over them. A chunk we could not read stays
 * missing instead, which physics already treats as a wall, and the next sync
 * asks again.
 */
async function readStored(cx: number, cy: number): Promise<StoredChunk | null> {
  let last: unknown
  for (let attempt = 0; attempt < READ_TRIES; attempt++) {
    if (attempt) await sleep(READ_BACKOFF[attempt - 1] ?? 240)
    try {
      return await chunkStore().get(cx, cy)
    }
    catch (error) {
      last = error
    }
  }
  throw last
}

/** The same, for a whole neighbourhood in one round trip. */
async function readStoredMany(coords: readonly (readonly [number, number])[]): Promise<(StoredChunk | null)[]> {
  let last: unknown
  for (let attempt = 0; attempt < READ_TRIES; attempt++) {
    if (attempt) await sleep(READ_BACKOFF[attempt - 1] ?? 240)
    try {
      return await chunkStore().getMany(coords)
    }
    catch (error) {
      last = error
    }
  }
  throw last
}

/** Where every live placement lives, so a demolish is a lookup and not a scan
 *  of the world. Seeded with the authored town, then maintained on every edit. */
const placementChunks = new Map<string, string>()
for (const placement of worldPlacements(WORLD)) {
  placementChunks.set(placement.id, chunkKey(chunkCoord(placement.x), chunkCoord(placement.y)))
}

/**
 * Create a chunk's terrain, bucketing and rampart index through the shared
 * world code. `createWorld({ generate: false })` is what keeps physics from
 * conjuring ground, so the one place that *is* allowed to make some lifts the
 * flag for exactly one call.
 */
function materialise(cx: number, cy: number): Chunk | undefined {
  WORLD.generate = true
  try {
    return WORLD.getChunk(cx, cy)
  }
  finally {
    WORLD.generate = false
  }
}

/**
 * Replace a chunk's contents with the store's copy.
 *
 * `installChunk` does the work: it refills this exact `Chunk` object in place —
 * the dirty set and the frame cache both hold it — and rebuckets in both
 * directions, so a gallery or a long fence still reaches the neighbours that
 * were already loaded. All that is left here is the placement index.
 */
function restore(chunk: Chunk, saved: StoredChunk) {
  const key = chunkKey(chunk.cx, chunk.cy)
  for (const placement of chunk.placements) placementChunks.delete(placement.id)
  const incoming = decodeChunk(saved)
  // The store never holds the authored town — `encodeChunk` leaves it out, or a
  // restore would double every brick. Put it back in front of the stored
  // placements so the chunk that comes out of `installChunk` is complete.
  if (isTownChunk(chunk.cx, chunk.cy)) {
    incoming.placements = [...townPlacementsIn(chunk.cx, chunk.cy), ...incoming.placements]
  }
  installChunk(WORLD, incoming)
  for (const placement of chunk.placements) placementChunks.set(placement.id, key)
  persisted.set(key, saved.v)
}

/** Finish a load: build the chunk, then either restore what was stored or seed
 *  the deterministic scatter a never-visited chunk grows. */
function install(cx: number, cy: number, saved: StoredChunk | null): Chunk | undefined {
  const chunk = materialise(cx, cy)
  if (!chunk) return undefined
  const key = chunkKey(cx, cy)
  if (loaded.has(key)) return chunk
  loaded.add(key)
  if (saved) {
    restore(chunk, saved)
    return chunk
  }
  persisted.set(key, null)
  for (const placement of generateVegetation(WORLD.seed, cx, cy)) {
    applyPlace(WORLD, placement)
    placementChunks.set(placement.id, key)
  }
  return chunk
}

/** The chunk at (cx, cy) if it is already playable. Synchronous, allocation
 *  free: the tick loop and the streaming both take this path almost always. */
export function residentChunk(cx: number, cy: number): Chunk | undefined {
  if (!loaded.has(chunkKey(cx, cy))) return undefined
  return WORLD.getChunk(cx, cy)
}

/**
 * The chunk at (cx, cy), ready to be played on — from the store if anyone has
 * ever changed it, generated if not. A store that keeps erroring leaves the
 * chunk *unloaded*: nothing is installed, nothing is marked persisted, and the
 * next sync tries again.
 */
export function loadChunk(cx: number, cy: number): Promise<Chunk | undefined> {
  if (!isChunkInBounds(cx, cy)) return Promise.resolve(undefined)
  const ready = residentChunk(cx, cy)
  if (ready) return Promise.resolve(ready)
  const key = chunkKey(cx, cy)
  const inflight = loading.get(key)
  if (inflight) return inflight
  const read = readStored(cx, cy)
  const pending = read
    .then(saved => install(cx, cy, saved))
    .catch((error: unknown) => {
      console.error(`[world] chunk ${key} could not be read after ${READ_TRIES} tries; leaving it unloaded`, error)
      return undefined
    })
    .finally(() => loading.delete(key))
  loading.set(key, pending)
  return pending
}

/** Load a whole neighbourhood in one round trip. Coordinates already loaded or
 *  in flight cost nothing; the rest go out as a single `MGET`. */
export async function loadChunks(coords: readonly (readonly [number, number])[]): Promise<void> {
  const misses: [number, number][] = []
  const waits: Promise<unknown>[] = []
  for (const [cx, cy] of coords) {
    if (!isChunkInBounds(cx, cy)) continue
    const key = chunkKey(cx, cy)
    if (loaded.has(key)) continue
    const inflight = loading.get(key)
    if (inflight) {
      waits.push(inflight)
      continue
    }
    misses.push([cx, cy])
  }
  if (misses.length) {
    const read = readStoredMany(misses)
    // One log line for the batch, not one per chunk in it.
    read.catch((error: unknown) => {
      console.error(`[world] ${misses.length} chunks could not be read after ${READ_TRIES} tries; leaving them unloaded`, error)
    })
    for (const [at, [cx, cy]] of misses.entries()) {
      const key = chunkKey(cx, cy)
      const pending = read
        .then(saved => install(cx, cy, saved[at] ?? null))
        .catch(() => undefined)
        .finally(() => loading.delete(key))
      loading.set(key, pending)
      waits.push(pending)
    }
  }
  await Promise.all(waits)
}

export function markChunkDirty(chunk: Chunk) {
  dirty.add(chunk)
}

/** A conflicted write: somebody else owns the newer chunk. Take theirs, say so
 *  loudly, and hand the corrected chunk to everyone standing on it. */
async function reconcile(chunk: Chunk, viewers: Iterable<ChunkViewer>) {
  const key = chunkKey(chunk.cx, chunk.cy)
  console.error(`[world] chunk ${key} changed under us; reloading from the store`)
  const saved = await chunkStore().get(chunk.cx, chunk.cy)
  if (!saved) {
    // The key went away (a wipe, or a reset). Ours is the only copy left, so
    // keep it and write it back as a fresh one next time.
    persisted.set(key, null)
    dirty.add(chunk)
    return
  }
  restore(chunk, saved)
  resendChunk(viewers, chunk)
}

let flushing = false

/**
 * Write-behind flush, on a 5 second timer and again on shutdown.
 *
 * Each chunk is a compare-and-set against the version the store held when we
 * last read or wrote it. A single instance never loses that race; a redeploy,
 * where the old process is still draining while the new one serves, does — and
 * the loser reloads rather than retries, because by then the store is right and
 * we are not. Returns the number of chunks written.
 */
export async function flushDirtyChunks(viewers: Iterable<ChunkViewer> = []): Promise<number> {
  const written = await writeDirtyChunks(viewers)
  // The piece budget rides the same timer as the chunks: both are write-behind
  // state that a redeploy must not lose.
  await flushPieceCounts()
  await flushPositions()
  evictIdleChunks(viewers)
  return written
}

async function writeDirtyChunks(viewers: Iterable<ChunkViewer>): Promise<number> {
  if (flushing || !dirty.size) return 0
  flushing = true
  const batch: Chunk[] = []
  for (const chunk of dirty) {
    if (batch.length >= FLUSH_LIMIT) break
    batch.push(chunk)
  }
  for (const chunk of batch) dirty.delete(chunk)
  try {
    const writes: ChunkWrite[] = batch.map(chunk => ({
      chunk: encodeChunk(chunk, { omitTown: true }),
      expectedVersion: persisted.get(chunkKey(chunk.cx, chunk.cy)) ?? null,
    }))
    const results = await chunkStore().flush(writes)
    const conflicts: Chunk[] = []
    for (const [at, chunk] of batch.entries()) {
      if (results[at]) persisted.set(chunkKey(chunk.cx, chunk.cy), writes[at]!.chunk.v)
      else conflicts.push(chunk)
    }
    for (const chunk of conflicts) await reconcile(chunk, viewers)
    return batch.length - conflicts.length
  }
  catch (error) {
    // A store that is down must not lose edits: put them back and try again on
    // the next tick.
    console.error('[world] chunk flush failed', error)
    for (const chunk of batch) dirty.add(chunk)
    return 0
  }
  finally {
    flushing = false
  }
}

/* -------------------------------------------------------------------------- */
/* Eviction                                                                   */
/* -------------------------------------------------------------------------- */

/** When each loaded chunk stopped being anybody's interest. Absent means it is
 *  held right now. */
const unheldSince = new Map<string, number>()

/**
 * Drop chunks nobody has held for a while.
 *
 * Without this the cache is a leak with a slow fuse: every chunk anyone has ever
 * walked past stays in `WORLD.chunks`, in `loaded`, in `persisted` and in the
 * frame cache for the life of the process, and a world of a million tiles has a
 * lot of past.
 *
 * Four things are never evicted: a town chunk (its authored pieces came from
 * `seedTown`, not the store, so dropping it would lose them), a dirty chunk (its edits have not reached the
 * store yet), a chunk still in flight, and anything a session holds. Everything
 * else goes through the shared `removeChunk`, which also withdraws what the
 * chunk had lent to its neighbours.
 */
function evictIdleChunks(viewers: Iterable<ChunkViewer>) {
  const held = new Set<string>()
  for (const viewer of viewers) {
    for (const key of viewer.chunks) held.add(key)
  }
  const dirtyKeys = new Set<string>()
  for (const chunk of dirty) dirtyKeys.add(chunkKey(chunk.cx, chunk.cy))

  const now = Date.now()
  for (const key of loaded) {
    if (held.has(key) || dirtyKeys.has(key) || loading.has(key)) {
      unheldSince.delete(key)
      continue
    }
    const [kx, ky] = key.split(',')
    const cx = Number(kx)
    const cy = Number(ky)
    if (isTownChunk(cx, cy)) continue
    const since = unheldSince.get(key)
    if (since === undefined) {
      unheldSince.set(key, now)
      continue
    }
    if (now - since < EVICT_AFTER) continue
    evict(cx, cy, key)
  }
  // A chunk that has already gone has no idle clock to keep.
  for (const key of unheldSince.keys()) {
    if (!loaded.has(key)) unheldSince.delete(key)
  }
}

function evict(cx: number, cy: number, key: string) {
  const chunk = WORLD.chunks.get(key)
  // The placement index is keyed by id and has to shed this chunk's ids with
  // it, or a demolish would find a piece in a chunk that is no longer there.
  if (chunk) {
    for (const placement of chunk.placements) placementChunks.delete(placement.id)
  }
  removeChunk(WORLD, cx, cy)
  loaded.delete(key)
  persisted.delete(key)
  frames.delete(key)
  unheldSince.delete(key)
}

/** Pull the spawn neighbourhood in before anyone can arrive on it, so the first
 *  player of a cold instance doesn't wait on a store read to stand up. */
export async function prefetchSpawn(): Promise<void> {
  const cx = chunkCoord(WORLD.start.x)
  const cy = chunkCoord(WORLD.start.y)
  const coords: [number, number][] = []
  for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
    for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) coords.push([cx + dx, cy + dy])
  }
  // The town chunks come too. `seedTown` put them in `WORLD.chunks` before the
  // store was ever asked about them, so physics would happily read authored
  // ground that a persisted edit is about to move — and a flush would then CAS
  // against a version we never read.
  const seen = new Set(coords.map(([x, y]) => chunkKey(x, y)))
  for (const { cx: tx, cy: ty } of townChunks()) {
    if (seen.has(chunkKey(tx, ty))) continue
    coords.push([tx, ty])
  }
  await loadChunks(coords)
}

/* -------------------------------------------------------------------------- */
/* Placement index                                                            */
/* -------------------------------------------------------------------------- */

/** The placement with this id, from the chunk that owns it. */
export function findPlacement(id: string): WorldPlacement | undefined {
  const key = placementChunks.get(id)
  if (!key) return undefined
  const [cx, cy] = key.split(',')
  const chunk = WORLD.getChunk(Number(cx), Number(cy))
  return chunk?.placements.find(p => p.id === id)
}

export function indexPlacement(placement: WorldPlacement) {
  placementChunks.set(placement.id, chunkKey(chunkCoord(placement.x), chunkCoord(placement.y)))
}

export function forgetPlacement(id: string) {
  placementChunks.delete(id)
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

/** Serialized `chunk` frames, keyed by chunk and valid while its version holds.
 *  Thirty bots joining at once then cost one encode per chunk, not thirty. */
const frames = new Map<string, { v: number, data: string }>()

function chunkFrame(chunk: Chunk): string {
  const key = chunkKey(chunk.cx, chunk.cy)
  const cached = frames.get(key)
  if (cached && cached.v === chunk.version) return cached.data
  const data = JSON.stringify({ t: 'chunk', ...encodeChunk(chunk) } satisfies ServerMessage)
  frames.set(key, { v: chunk.version, data })
  return data
}

/**
 * Bring a session's loaded set in line with where its player is standing.
 *
 * Only the 3×3 around them goes out on this call: that is the ground they
 * stand on and the ground they can step onto before the next tick, and a late
 * chunk underfoot is a hole. The surrounding ring is scenery, so it is queued
 * on the session and drained a few chunks per tick, so the one piece of
 * per-join work that grows with how built-up a neighbourhood is never lands on
 * one tick. The store read is still issued for the whole 5×5 right here,
 * one `MGET`, so the ring is resident by the time the queue reaches it.
 *
 * Anything past `DROP_RADIUS` is dropped. Returns whether anything moved, so
 * the caller can log it.
 */
export function syncChunks(viewer: ChunkViewer, x: number, y: number, force = false): boolean {
  const cx = chunkCoord(x)
  const cy = chunkCoord(y)
  if (!force && cx === viewer.chunkCx && cy === viewer.chunkCy) return false
  viewer.chunkCx = cx
  viewer.chunkCy = cy

  const urgent: [number, number][] = []
  const later: [number, number][] = []
  for (let ring = 0; ring <= LOAD_RADIUS; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the outermost row/column of this ring; the inner ones went out
        // on the previous pass.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const kx = cx + dx
        const ky = cy + dy
        if (!isChunkInBounds(kx, ky)) continue
        const key = chunkKey(kx, ky)
        if (viewer.chunks.has(key)) continue
        if (ring > URGENT_RADIUS) {
          // Ring order is insertion order, so the queue drains nearest first.
          viewer.pending.add(key)
          if (!loaded.has(key)) later.push([kx, ky])
          continue
        }
        const chunk = residentChunk(kx, ky)
        if (!chunk) {
          // Still in the store. `urgent` stays in ring order, so the ground
          // underfoot goes out ahead of the rest when the read lands.
          urgent.push([kx, ky])
          // Queue it as well. `sendLoaded` drops a coord whose read lands after
          // the player has moved, or lands without the chunk resident, and
          // nothing would ever ask for it again — the player would hold 24 of
          // their 25 chunks until they walked away and back. The queue is the
          // path that already retries; whichever of the two sends it first, the
          // next `drainChunkQueue` sees it in `viewer.chunks` and drops the key.
          viewer.pending.add(key)
          continue
        }
        viewer.pending.delete(key)
        viewer.chunks.add(key)
        viewer.send(chunkFrame(chunk))
      }
    }
  }
  if (urgent.length) void loadChunks(urgent).then(() => sendLoaded(viewer, urgent))
  if (later.length) void loadChunks(later)

  for (const key of viewer.chunks) {
    const [kx, ky] = key.split(',')
    if (Math.max(Math.abs(Number(kx) - cx), Math.abs(Number(ky) - cy)) <= DROP_RADIUS) continue
    viewer.chunks.delete(key)
    viewer.send(JSON.stringify({ t: 'unchunk', cx: Number(kx), cy: Number(ky) } satisfies ServerMessage))
  }
  return true
}

/**
 * Send chunks that finished loading to the session that asked for them.
 *
 * A store read takes a few milliseconds, which is long enough for the player to
 * have walked on, disconnected, or already been handed the chunk by another
 * sync. The distance test is written so that a released viewer — whose last
 * chunk is NaN — matches nothing.
 */
function sendLoaded(viewer: ChunkViewer, coords: readonly (readonly [number, number])[]) {
  for (const [kx, ky] of coords) {
    const key = chunkKey(kx, ky)
    if (viewer.chunks.has(key)) continue
    if (!(Math.max(Math.abs(kx - viewer.chunkCx), Math.abs(ky - viewer.chunkCy)) <= LOAD_RADIUS)) continue
    const chunk = residentChunk(kx, ky)
    if (!chunk) continue
    viewer.chunks.add(key)
    viewer.send(chunkFrame(chunk))
  }
}

/**
 * Hand a session the next few chunks it is owed, and no more.
 *
 * Called once per session per tick. The budget is the whole point: a welcome
 * owes 16 chunks of scenery beyond the ground underfoot, and encoding and
 * sending them is the only per-join cost that grows with the number of pieces
 * standing in them. Paying it a few chunks at a time puts a ceiling on it.
 *
 * A queued chunk the player has walked away from is dropped rather than sent —
 * the distance test is written so that a released viewer, whose last chunk is
 * NaN, matches nothing. One that is still in the store stays queued and costs a
 * map lookup a tick; `retry` (once a second from the tick) re-issues the read
 * for those, which is what recovers a neighbourhood whose first read failed.
 */
export function drainChunkQueue(viewer: ChunkViewer, retry = false) {
  if (!viewer.pending.size) return
  let sent = 0
  let stalled: [number, number][] | undefined
  for (const key of viewer.pending) {
    if (sent >= CHUNKS_PER_TICK) break
    const comma = key.indexOf(',')
    const kx = Number(key.slice(0, comma))
    const ky = Number(key.slice(comma + 1))
    if (viewer.chunks.has(key) || !(Math.max(Math.abs(kx - viewer.chunkCx), Math.abs(ky - viewer.chunkCy)) <= LOAD_RADIUS)) {
      viewer.pending.delete(key)
      continue
    }
    const chunk = residentChunk(kx, ky)
    if (!chunk) {
      if (retry && !loading.has(key)) (stalled ??= []).push([kx, ky])
      continue
    }
    viewer.pending.delete(key)
    viewer.chunks.add(key)
    viewer.send(chunkFrame(chunk))
    sent++
  }
  if (stalled) void loadChunks(stalled)
}

/** A session is gone: forget what it held, and make sure no store read still in
 *  flight tries to hand it a chunk. */
export function releaseViewer(viewer: ChunkViewer) {
  viewer.chunks.clear()
  viewer.pending.clear()
  viewer.chunkCx = Number.NaN
  viewer.chunkCy = Number.NaN
}

/** Hand a whole chunk back to the sessions holding it — after a CAS conflict
 *  their copy is a world that no longer exists. */
function resendChunk(viewers: Iterable<ChunkViewer>, chunk: Chunk) {
  const key = chunkKey(chunk.cx, chunk.cy)
  let data: string | undefined
  for (const viewer of viewers) {
    if (!viewer.chunks.has(key)) continue
    data ??= chunkFrame(chunk)
    viewer.send(data)
  }
}

/**
 * Send a frame to every session holding a chunk — nobody else has the ground it
 * happened on, so nobody else needs to hear about it.
 *
 * `except` leaves one session out, which is how an edit's author gets its own
 * copy of the frame carrying their new owned-piece total while everyone else
 * gets the plain one.
 */
export function broadcastToChunk(viewers: Iterable<ChunkViewer>, cx: number, cy: number, msg: ServerMessage, except?: ChunkViewer) {
  const key = chunkKey(cx, cy)
  let data: string | undefined
  for (const viewer of viewers) {
    if (viewer === except || !viewer.chunks.has(key)) continue
    data ??= JSON.stringify(msg)
    viewer.send(data)
  }
}

/* -------------------------------------------------------------------------- */
/* Deltas                                                                     */
/* -------------------------------------------------------------------------- */

type TerrainFrame = Extract<ServerMessage, { t: 'terrain' }>

/**
 * The `terrain` frames for one applied edit: per changed chunk, the corner
 * indices the brush wrote and their heights as stored (quantised `HEIGHT_STEP`
 * units, exactly what `Chunk.heights` holds), plus the surface entries a paint
 * touched. A border corner belongs to up to four chunks and is reported in each
 * of them, which is what keeps the client's seams from tearing.
 */
export function terrainDeltas(edit: TerrainEdit, changed: Chunk[]): TerrainFrame[] {
  const gx = Math.round(edit.x)
  const gy = Math.round(edit.y)
  const extent = brushExtent(gx, gy, edit.size)
  const out: TerrainFrame[] = []
  for (const chunk of changed) {
    const edits: [number, number][] = []
    const surface: [number, number][] = []
    for (let y = extent.minY; y <= extent.maxY; y++) {
      for (let x = extent.minX; x <= extent.maxX; x++) {
        const lx = x - chunk.cx * CHUNK_SIZE
        const ly = y - chunk.cy * CHUNK_SIZE
        if (lx < 0 || ly < 0 || lx >= CHUNK_CORNERS || ly >= CHUNK_CORNERS) continue
        if (edit.mode === 'paint') {
          if (lx >= CHUNK_SIZE || ly >= CHUNK_SIZE) continue
          const i = ly * CHUNK_SIZE + lx
          surface.push([i, chunk.surface[i]!])
        }
        else {
          const i = ly * CHUNK_CORNERS + lx
          edits.push([i, chunk.heights[i]!])
        }
      }
    }
    if (!edits.length && !surface.length) continue
    out.push({
      t: 'terrain',
      cx: chunk.cx,
      cy: chunk.cy,
      v: chunk.version,
      edits,
      ...(surface.length ? { surface } : {}),
    })
  }
  return out
}
