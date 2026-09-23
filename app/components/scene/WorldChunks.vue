<script setup lang="ts">
import { Group } from 'three'
import type { InstancedMesh, Mesh } from 'three'
import { applyPlace, chunkCoord, chunkKey, cornerHeight, isTownChunk, parseChunkKey } from '#shared/utils/world'
import type { Chunk, World } from '#shared/utils/world'
import { generateVegetation } from '#shared/utils/vegetation'
import { createTerrainMaterial, createTerrainMesh, updateTerrainMesh } from '~/utils/terrainChunk'
import type { HeightSampler } from '~/utils/terrainChunk'
import { chunkGrassBlades, createChunkProps, createPavingBank, groundCover } from '~/utils/chunkProps'
import { createGrassBank, updateGrassLod } from '~/utils/courtyardLandscape'
import type { createCritters } from '~/utils/critters'
import type { TownMaterials } from '~/utils/townMaterials'
import type { GraphicsProfile } from '~/utils/graphics'
import { tagSceneShadows } from '~/utils/sceneObjects'

const props = defineProps<{
  world: World
  templates: Map<string, Group>
  materials: TownMaterials
  foliageTime: { value: number }
  quality: GraphicsProfile
  critters: ReturnType<typeof createCritters> | null
  editor?: boolean
}>()
const emit = defineEmits<{ change: [], townChange: [] }>()
const hubWorld = props.world
const critters = props.critters
const stream = useWorld()
const terrainMaterial = createTerrainMaterial(props.materials)
const grassBank = createGrassBank(props.foliageTime)
const pavingBank = createPavingBank(props.materials)
const chunkProps = createChunkProps({ templates: props.templates, materials: props.materials, seed: hubWorld.seed, foliageTime: props.foliageTime, editor: props.editor })
let disposed = false
let changeQueued = false
// Vue attaches/detaches primitives after the shallow collection changes. Scan
// materials and exclusions only after that commit, once for the entire burst.
function sceneChanged() {
  if (changeQueued || disposed) return
  changeQueued = true
  void nextTick(() => {
    changeQueued = false
    if (!disposed) emit('change')
  })
}

/**
 * Terrain reaches out to the camera's far plane so the hills still close the
 * horizon; the detailed pass — props, generated vegetation, grass — is a tight
 * ring around the player, because batching per chunk costs a draw call per kind
 * per chunk and a whole meadow of those would not fit in a frame.
 */
const TERRAIN_RADIUS = 7
const TERRAIN_DROP = 8
/** The detail ring, tightened by the graphics settings (`useGraphics`). Terrain
 *  is not: the hills have to keep closing the horizon whatever the machine, and
 *  the fog is nowhere near thick enough to hide a nearer edge of the world. */
let detailRadius = 2
let detailDrop = 3

/** The authored town is a fixed 25 chunks and reads as one place: half of it
 *  fading out as you cross the square would be worse than the draw calls. It
 *  keeps its detail for as long as it is mounted at all. */
const alwaysDetailed = (cx: number, cy: number) => isTownChunk(cx, cy)
/** Detail level for a chunk, by its distance from the chunk we last synced on.
 *  Shared by the range follower and the streaming listeners so a chunk mounts
 *  at the same level whichever of them gets to it first. */
function detailFor(cx: number, cy: number): boolean {
  if (alwaysDetailed(cx, cy)) return true
  if (Number.isNaN(lastChunkCx)) return true
  return Math.max(Math.abs(cx - lastChunkCx), Math.abs(cy - lastChunkCy)) <= detailRadius
}
/** Milliseconds of a frame a border crossing may spend building chunks. The
 *  first sync ignores it: the whole view is filled at once, while the models are
 *  still streaming in, because a horizon that fades in over the first minute on
 *  a slow machine is far worse than one longer frame at load. */
const MOUNT_BUDGET_MS = 5

interface MountedChunk {
  group: Group
  terrain: Mesh
  props: Group | null
  grass: InstancedMesh | null
  /** Player-laid road. Not detail-gated: a road is architecture, and it has to
   *  still be there when you look back at it from the next hill. */
  paving: Mesh | null
  /** Whether this chunk currently draws its props and grass. */
  detail: boolean
}

const mounted = shallowReactive(new Map<string, MountedChunk>())
const mountQueue: { cx: number, cy: number, detail: boolean, distance: number }[] = []
/** Chunks whose generated vegetation has been placed. Once, like the server. */
const seededChunks = new Set<string>()
let lastChunkCx = Number.NaN
let lastChunkCy = Number.NaN
let chunksPrimed = false

/** Corner heights read across chunk borders, so terrain normals do not crease
 *  along every seam. */
const sampleHeight: HeightSampler = (gx, gy) => cornerHeight(hubWorld, gx, gy)

/**
 * The chunk at (cx, cy), ready to draw. In play this is just a lookup: the
 * chunk either arrived or it did not, and an absent one is not drawn. The
 * editor's local world generates on touch instead, and seeds its wild
 * vegetation exactly once, the way the server's `loadChunk` does.
 */
function ensureChunkContent(cx: number, cy: number): Chunk | undefined {
  const chunk = hubWorld.getChunk(cx, cy)
  if (!chunk || !props.editor) return chunk
  const key = chunkKey(cx, cy)
  if (seededChunks.has(key)) return chunk
  seededChunks.add(key)
  for (const placement of generateVegetation(hubWorld.seed, cx, cy)) applyPlace(hubWorld, placement)
  return chunk
}

/** (Re)build the chunk's flagstones. Driven by the surface raster and the
 *  corner heights, so it belongs with the terrain refresh, not the props. */
function buildChunkPaving(entry: MountedChunk, chunk: Chunk) {
  if (entry.paving) {
    entry.group.remove(entry.paving)
    entry.paving.geometry.dispose()
    entry.paving = null
  }
  entry.paving = pavingBank.patch(chunk, sampleHeight)
  if (entry.paving) entry.group.add(entry.paving)
}

/** (Re)build the chunk's props and grass, or tear them down when it drops back
 *  to being distant terrain. */
function buildChunkDetail(entry: MountedChunk, chunk: Chunk) {
  if (entry.props) {
    entry.group.remove(entry.props)
    chunkProps.release(entry.props)
    entry.props = null
  }
  if (entry.grass) {
    entry.group.remove(entry.grass)
    entry.grass.dispose()
    entry.grass = null
  }
  if (!entry.detail) {
    critters?.unmount(chunk.cx, chunk.cy)
    return
  }
  critters?.mount(chunk.cx, chunk.cy)
  const cover = groundCover(hubWorld, chunk)
  entry.props = chunkProps.build(chunk, cover)
  tagSceneShadows(entry.props)
  entry.group.add(entry.props)
  entry.grass = grassBank.patch(chunkGrassBlades(chunk, hubWorld.seed, cover))
  if (entry.grass) entry.group.add(entry.grass)
}

/**
 * Streaming events and the player's detail ring share these operations.
 * `mountChunk` is idempotent and upgrades a chunk already mounted at lower detail.
 */
function mountChunk(cx: number, cy: number, detail = true): void {
  const key = chunkKey(cx, cy)
  const existing = mounted.get(key)
  if (existing) {
    if (existing.detail === detail) return
    existing.detail = detail
    refreshChunkProps(cx, cy)
    return
  }
  const chunk = ensureChunkContent(cx, cy)
  if (!chunk) return
  const group = new Group()
  group.name = `chunk ${key}`
  const entry: MountedChunk = { group, terrain: createTerrainMesh(chunk, terrainMaterial, sampleHeight), props: null, grass: null, paving: null, detail }
  group.add(entry.terrain)
  mounted.set(key, entry)
  buildChunkPaving(entry, chunk)
  buildChunkDetail(entry, chunk)

  sceneChanged()
}

function unmountChunk(cx: number, cy: number): void {
  const key = chunkKey(cx, cy)
  const entry = mounted.get(key)
  if (!entry) return
  mounted.delete(key)
  critters?.unmount(cx, cy)
  entry.group.visible = false
  if (entry.props) chunkProps.release(entry.props)
  entry.grass?.dispose()
  entry.paving?.geometry.dispose()
  // Terrain geometry is this chunk's alone; its material is shared.
  entry.terrain.geometry.dispose()
  entry.group.clear()
  sceneChanged()
}

/** A `terrain` frame changed this chunk's corner heights or surface raster.
 *  Everything bedded on the ground goes with it: the flagstones a paint stroke
 *  just laid, and the grass and flowers that must not grow through them. */
function refreshChunkTerrain(cx: number, cy: number): void {
  const entry = mounted.get(chunkKey(cx, cy))
  const chunk = entry && hubWorld.getChunk(cx, cy)
  if (!entry || !chunk) return
  updateTerrainMesh(entry.terrain, chunk, sampleHeight)
  buildChunkPaving(entry, chunk)
  buildChunkDetail(entry, chunk)
  sceneChanged()
}

/** A `place` or `remove` frame changed what stands on this chunk. */
function refreshChunkProps(cx: number, cy: number): void {
  const entry = mounted.get(chunkKey(cx, cy))
  const chunk = entry && hubWorld.getChunk(cx, cy)
  if (!entry || !chunk) return
  buildChunkDetail(entry, chunk)
  sceneChanged()
}

/** Follow the player: mount what is in range, drop what is not. The work is
 *  budgeted per frame, so a border crossing spreads over a few frames. */
function syncChunks(x: number, y: number) {
  const cx0 = chunkCoord(x)
  const cy0 = chunkCoord(y)
  if (cx0 !== lastChunkCx || cy0 !== lastChunkCy) {
    lastChunkCx = cx0
    lastChunkCy = cy0
    for (const [key, entry] of [...mounted]) {
      const { cx, cy } = parseChunkKey(key)
      const distance = Math.max(Math.abs(cx - cx0), Math.abs(cy - cy0))
      if (distance > TERRAIN_DROP) unmountChunk(cx, cy)
      else if (distance > detailDrop && entry.detail && !alwaysDetailed(cx, cy)) {
        entry.detail = false
        refreshChunkProps(cx, cy)
      }
    }
    mountQueue.length = 0
    for (let cy = cy0 - TERRAIN_RADIUS; cy <= cy0 + TERRAIN_RADIUS; cy++) {
      for (let cx = cx0 - TERRAIN_RADIUS; cx <= cx0 + TERRAIN_RADIUS; cx++) {
        const distance = Math.max(Math.abs(cx - cx0), Math.abs(cy - cy0))
        const detail = detailFor(cx, cy)
        const entry = mounted.get(chunkKey(cx, cy))
        if (entry && entry.detail === detail) continue
        mountQueue.push({ cx, cy, detail, distance })
      }
    }
    mountQueue.sort((a, b) => a.distance - b.distance)
  }
  const deadline = chunksPrimed ? performance.now() + MOUNT_BUDGET_MS : Number.POSITIVE_INFINITY
  while (mountQueue.length) {
    const next = mountQueue.shift()!
    mountChunk(next.cx, next.cy, next.detail)
    if (performance.now() >= deadline) break
  }
  chunksPrimed = true
}

function clearChunks() {
  for (const key of [...mounted.keys()]) {
    const { cx, cy } = parseChunkKey(key)
    unmountChunk(cx, cy)
  }
  mountQueue.length = 0
  lastChunkCx = Number.NaN
  lastChunkCy = Number.NaN
  chunksPrimed = false
}

/** The templates behind every batch have been replaced (the GLBs landed), so
 *  every mounted chunk has to be rebuilt off the new ones. */
function rebuildChunks() {
  for (const entry of mounted.values()) {
    if (!entry.props) continue
    entry.group.remove(entry.props)
    chunkProps.release(entry.props)
    entry.props = null
  }
  for (const [key, entry] of mounted) {
    const { cx, cy } = parseChunkKey(key)
    const chunk = hubWorld.getChunk(cx, cy)
    if (chunk) buildChunkDetail(entry, chunk)
  }
  sceneChanged()
}

const unsubscribe: (() => void)[] = []
const townChunks = new Set<string>()
if (!props.editor) {
  unsubscribe.push(
    stream.onChunk((cx, cy) => {
      // A chunk that was already mounted has been *replaced* (a resync), so its
      // geometry has to be rebuilt; a fresh mount already built it.
      const remount = mounted.has(chunkKey(cx, cy))
      mountChunk(cx, cy, detailFor(cx, cy))
      if (remount) {
        refreshChunkTerrain(cx, cy)
      }
      // A long piece reaches into its neighbours' batches; they have just
      // adopted it, so redraw them too.
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) if (nx !== cx || ny !== cy) refreshChunkProps(nx, ny)
      }
      const key = chunkKey(cx, cy)
      if (isTownChunk(cx, cy) && !townChunks.has(key)) {
        townChunks.add(key)
        emit('townChange')
      }
    }),
    stream.onUnchunk(unmountChunk),
    stream.onTerrain(refreshChunkTerrain),
    stream.onProps(refreshChunkProps),
  )
}

watch(() => [props.quality.detailRadius, props.quality.detailDrop] as const, ([radius, drop]) => {
  detailRadius = radius
  detailDrop = drop
  lastChunkCx = lastChunkCy = Number.NaN
}, { immediate: true })

function updateGrass(x: number, z: number) {
  for (const entry of mounted.values()) if (entry.grass) updateGrassLod(entry.grass, x, z)
}

function dispose() {
  if (disposed) return
  disposed = true
  for (const off of unsubscribe) off()
  clearChunks()
  grassBank.dispose()
  pavingBank.dispose()
  terrainMaterial.dispose()
}
onBeforeUnmount(dispose)
defineExpose({ sync: syncChunks, rebuild: rebuildChunks, updateGrass, dispose, mountChunk, unmountChunk, refreshChunkTerrain, refreshChunkProps })
</script>

<template>
  <TresGroup
    name="Streamed_World"
    :dispose="null"
  >
    <primitive
      v-for="[key, entry] in mounted"
      :key="key"
      :object="entry.group"
      :dispose="null"
    />
  </TresGroup>
</template>
