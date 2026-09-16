/**
 * The chunked world.
 *
 * Replaces the fixed 144×144 `FloorPlan`. The world is a grid of 32×32 tile
 * chunks, each holding a 33×33 corner heightmap, a 32×32 surface raster, and
 * the placements whose centre falls inside it. Chunks are generated on first
 * touch by `generateChunk`, which is a pure function of `(seed, cx, cy)` — so
 * the authoritative server and client prediction build byte-identical terrain
 * without any of it travelling over the socket.
 *
 * The authored town is a *protected footprint*: the moat's outer square plus a
 * margin, and the gate road out to where it ends. Its pieces are seeded from
 * the committed JSON at boot and player edits never reach those tiles. The
 * chunks the footprint touches (`isTownChunk`) are created up front and never
 * evicted, but the ground in them outside the footprint is ordinary editable
 * terrain.
 *
 * Gameplay reads this module through `maze.ts` — never directly from a
 * component or the WS handler.
 */

import { FORTIFICATIONS, TOWN_MARGIN } from './courtyard'
import { MOAT_STAIRS } from './moat'
import { isHeightAwareKind, rampartIndex } from './ramparts'
import type { RampartIndex } from './ramparts'
import { isTownPlacement, propFromPlacement, propHalfExtents } from './props'
import type { PropSpec, WorldPlacement } from './props'
import { worldTerrainHeight } from './terrain'
import townProps from '../data/courtyard-props.json'
import townStructure from '../data/courtyard-structure.json'

/** Tiles per chunk edge. */
export const CHUNK_SIZE = 32
/** Corner samples per chunk edge — one more than the tiles they bound, so the
 *  last row/column duplicates the neighbour's first. */
export const CHUNK_CORNERS = CHUNK_SIZE + 1
/** Corner heights are quantised to this many units in an `Int16Array`. */
export const HEIGHT_STEP = 0.05
/** One terraform click. */
export const TERRAFORM_STEP = 0.25

/** Surface type raster values (cosmetic in this phase; the renderer reads them
 *  in Phase 2). */
export const SURFACE = { grass: 0, dirt: 1, stone: 2, sand: 3, path: 4, water: 5 } as const
export type SurfaceType = typeof SURFACE[keyof typeof SURFACE]

/**
 * World extent: 32×32 chunks around the town. The plan asked for -440..584;
 * chunk keys are `floor(tile / 32)` so the grid has to land on multiples of 32,
 * which puts the same 1024-tile span at -448..576.
 */
export const WORLD_BOUNDS = { minCx: -14, maxCx: 17, minCy: -14, maxCy: 17 } as const
export type WorldBounds = typeof WORLD_BOUNDS

/** Default generation seed. Terrain relief is positional (it has to match the
 *  landscape mesh); the seed drives surface variation and, from Phase 2, the
 *  scatter of generated vegetation. */
export const WORLD_SEED = 20260915

export interface Chunk {
  cx: number
  cy: number
  /** 33×33 corner heights in `HEIGHT_STEP` units, row-major. */
  heights: Int16Array
  /** 32×32 surface types, row-major. */
  surface: Uint8Array
  /** Placements whose centre falls in this chunk — what gets persisted, sent
   *  and rendered. */
  placements: WorldPlacement[]
  /** Collision specs for every prop whose footprint *overlaps* this chunk,
   *  including ones owned by a neighbour. Duplicated on purpose: every consumer
   *  takes a max or an OR, so a prop seen twice costs nothing and a 3×3 query
   *  can never miss a long piece. */
  props: PropSpec[]
  /** Height-aware pieces (rampart galleries/rails, every stepped ramp)
   *  pre-filtered out of `props`, rebuilt whenever they change. */
  ramparts: RampartIndex
  /**
   * Bumped exactly once per mutation of *this chunk's own content* — its
   * heights, its surface raster, the placements it owns. Lending a long piece
   * to a neighbour, or adopting one from it, is derived index state and never
   * moves a version: that is what keeps a streaming client's number from ever
   * running ahead of the server's, which is what makes "apply when newer" safe.
   */
  version: number
}

export interface World {
  chunkSize: number
  bounds: WorldBounds
  seed: number
  /** Spawn point. */
  start: { x: number, y: number }
  /** Loaded chunks, by `chunkKey`. */
  chunks: Map<string, Chunk>
  /** Whether a missing chunk is generated on demand. */
  generate: boolean
  getChunk: (cx: number, cy: number) => Chunk | undefined
}

/* -------------------------------------------------------------------------- */
/* Keys and bounds                                                            */
/* -------------------------------------------------------------------------- */

export function chunkCoord(tile: number): number {
  return Math.floor(tile / CHUNK_SIZE)
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`
}

export function parseChunkKey(key: string): { cx: number, cy: number } {
  const [cx, cy] = key.split(',')
  return { cx: Number(cx), cy: Number(cy) }
}

export function isChunkInBounds(cx: number, cy: number): boolean {
  const b = WORLD_BOUNDS
  return cx >= b.minCx && cx <= b.maxCx && cy >= b.minCy && cy <= b.maxCy
}

/** World edge in tiles: `[min, max)`. A hard wall. */
export const WORLD_TILE_MIN = WORLD_BOUNDS.minCx * CHUNK_SIZE
export const WORLD_TILE_MAX = (WORLD_BOUNDS.maxCx + 1) * CHUNK_SIZE

/**
 * Whether this chunk overlaps the protected footprint.
 *
 * This is *not* what decides whether an edit is allowed — `isProtectedTile` is,
 * and it reads the footprint tile by tile. A town chunk is the coarser fact the
 * chunk service needs: it is seeded from the town JSON by `seedTown`, created
 * up front rather than on first touch, and never evicted. Its tiles outside the
 * footprint are ordinary editable ground.
 */
/**
 * The tiles player edits may never touch, inclusive on both ends: the moat's
 * outer square plus `TOWN_MARGIN`, the bank stair with the same margin, and
 * exactly the paved approach from the bridge to the end of the road. It hugs
 * the geometry on purpose: the first tile beside the road or past its end is
 * where a player continues it.
 */
export const PROTECTED_FOOTPRINT = [
  {
    minX: FORTIFICATIONS.moatOuterMin - TOWN_MARGIN,
    maxX: FORTIFICATIONS.moatOuterMax - 1 + TOWN_MARGIN,
    minY: FORTIFICATIONS.moatOuterMin - TOWN_MARGIN,
    maxY: FORTIFICATIONS.moatOuterMax - 1 + TOWN_MARGIN,
  },
  {
    minX: Math.floor(MOAT_STAIRS.x - MOAT_STAIRS.width / 2) - TOWN_MARGIN,
    maxX: Math.floor(MOAT_STAIRS.x + MOAT_STAIRS.width / 2) + TOWN_MARGIN,
    minY: MOAT_STAIRS.zStart,
    maxY: MOAT_STAIRS.zEnd,
  },
  {
    // The road plane spans `gateX ± bridgeWidth / 2` and ends at `exteriorMax`,
    // so these are its tiles and nothing beside them.
    minX: FORTIFICATIONS.gateX - FORTIFICATIONS.bridgeWidth / 2,
    maxX: FORTIFICATIONS.gateX + FORTIFICATIONS.bridgeWidth / 2 - 1,
    minY: FORTIFICATIONS.moatOuterMax,
    maxY: FORTIFICATIONS.exteriorMax - 1,
  },
] as const

export function isTownChunk(cx: number, cy: number): boolean {
  const minX = cx * CHUNK_SIZE
  const minY = cy * CHUNK_SIZE
  const maxX = minX + CHUNK_SIZE - 1
  const maxY = minY + CHUNK_SIZE - 1
  for (const rect of PROTECTED_FOOTPRINT) {
    if (maxX < rect.minX || minX > rect.maxX || maxY < rect.minY || minY > rect.maxY) continue
    return true
  }
  return false
}

/** Whether this tile is inside the protected footprint (`PROTECTED_FOOTPRINT`
 *  in `courtyard.ts`). Terraform, build and demolish all refuse it, and a brush
 *  is refused if any corner it writes lands inside. */
export function isProtectedTile(x: number, y: number): boolean {
  for (const rect of PROTECTED_FOOTPRINT) {
    if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) return true
  }
  return false
}

/** Every chunk `isTownChunk` accepts. The town is a handful of chunks, so this
 *  walks the footprint's bounding box once rather than the whole world. */
export function* townChunks(): Generator<{ cx: number, cy: number }> {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const rect of PROTECTED_FOOTPRINT) {
    minX = Math.min(minX, rect.minX)
    maxX = Math.max(maxX, rect.maxX)
    minY = Math.min(minY, rect.minY)
    maxY = Math.max(maxY, rect.maxY)
  }
  for (let cy = chunkCoord(minY); cy <= chunkCoord(maxY); cy++) {
    for (let cx = chunkCoord(minX); cx <= chunkCoord(maxX); cx++) {
      if (isTownChunk(cx, cy)) yield { cx, cy }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

const quantise = (h: number) => Math.round(h / HEIGHT_STEP)

/** Stable integer hash, for surface variation that must not drift between the
 *  server and the client. `vegetation.ts` and `chunkProps.ts` each keep their
 *  own hash with a different mixing sequence (more inputs, or an extra
 *  avalanche round), so this is exported for reuse but not force-shared: only
 *  fold another caller's hash into this one if its arithmetic already matches
 *  bit for bit. */
export function hash3(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B)
  h = Math.imul(h ^ a, 0xC2B2AE35)
  h = Math.imul(h ^ b, 0x27D4EB2F)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function surfaceFor(seed: number, gx: number, gy: number, height: number, slope: number): SurfaceType {
  if (slope > 1.2) return SURFACE.stone
  if (isProtectedTile(gx, gy)) return SURFACE.path
  const noise = hash3(seed, gx, gy)
  if (slope > 0.6) return noise < 0.6 ? SURFACE.stone : SURFACE.dirt
  if (height > 18) return noise < 0.5 ? SURFACE.stone : SURFACE.dirt
  return noise < 0.08 ? SURFACE.dirt : SURFACE.grass
}

/**
 * The world's terrain, chunk by chunk. Pure: same seed and coordinates in, same
 * bytes out, on the server, in the client and in the tests.
 *
 * Generated chunks carry no props yet — vegetation arrives in Phase 2 with the
 * renderer that can draw it, because an invisible collider is worse than none.
 */
export function generateChunk(seed: number, cx: number, cy: number): Chunk {
  const heights = new Int16Array(CHUNK_CORNERS * CHUNK_CORNERS)
  for (let ly = 0; ly < CHUNK_CORNERS; ly++) {
    for (let lx = 0; lx < CHUNK_CORNERS; lx++) {
      heights[ly * CHUNK_CORNERS + lx] = quantise(worldTerrainHeight(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly))
    }
  }
  const surface = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const h00 = heights[ly * CHUNK_CORNERS + lx]! * HEIGHT_STEP
      const h10 = heights[ly * CHUNK_CORNERS + lx + 1]! * HEIGHT_STEP
      const h01 = heights[(ly + 1) * CHUNK_CORNERS + lx]! * HEIGHT_STEP
      surface[ly * CHUNK_SIZE + lx] = surfaceFor(seed, cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly, h00, Math.hypot(h10 - h00, h01 - h00))
    }
  }
  return { cx, cy, heights, surface, placements: [], props: [], ramparts: rampartIndex([]), version: 0 }
}

/* -------------------------------------------------------------------------- */
/* Prop bucketing                                                             */
/* -------------------------------------------------------------------------- */

/** Chunk range a placement's footprint overlaps. Long pieces (a gallery run is
 *  78 tiles) land in several chunks so a 3×3 query can never miss them. */
function propChunkRange(prop: PropSpec) {
  const { ax, ay } = propHalfExtents(prop)
  return {
    minCx: chunkCoord(prop.x - ax),
    maxCx: chunkCoord(prop.x + ax),
    minCy: chunkCoord(prop.y - ay),
    maxCy: chunkCoord(prop.y + ay),
  }
}

function reindexRamparts(chunk: Chunk) {
  chunk.ramparts = rampartIndex(chunk.props)
}

/**
 * Add a resolved prop to every *loaded* chunk its footprint touches.
 *
 * Only loaded ones: a chunk that does not exist yet picks the piece up through
 * `adoptOverlapping` the moment it is generated or installed, and conjuring a
 * neighbour here would have a streaming client inventing terrain the server
 * never sent it. No version moves — bucketing is an index, not content.
 */
function bucket(world: World, prop: PropSpec) {
  const range = propChunkRange(prop)
  const rampart = isHeightAwareKind(prop.kind)
  for (let cy = range.minCy; cy <= range.maxCy; cy++) {
    for (let cx = range.minCx; cx <= range.maxCx; cx++) {
      const chunk = world.chunks.get(chunkKey(cx, cy))
      if (!chunk || chunk.props.includes(prop)) continue
      chunk.props.push(prop)
      if (rampart) reindexRamparts(chunk)
    }
  }
}

/** Drop a prop from every chunk it was bucketed into. */
function unbucket(world: World, prop: PropSpec) {
  const range = propChunkRange(prop)
  const rampart = isHeightAwareKind(prop.kind)
  for (let cy = range.minCy; cy <= range.maxCy; cy++) {
    for (let cx = range.minCx; cx <= range.maxCx; cx++) {
      const chunk = world.chunks.get(chunkKey(cx, cy))
      if (!chunk) continue
      const at = chunk.props.indexOf(prop)
      if (at < 0) continue
      chunk.props.splice(at, 1)
      if (rampart) reindexRamparts(chunk)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* World construction                                                         */
/* -------------------------------------------------------------------------- */

export interface WorldOptions {
  seed?: number
  /** Generate missing chunks on first touch. `false` leaves them undefined,
   *  which physics treats as unwalkable — used by a client that streams. */
  generate?: boolean
  /** Seed the authored town into the protected chunks. Defaults to true. */
  town?: boolean
}

/** Force a chunk into existence regardless of the `generate` flag — the town
 *  and any edit need somewhere to live. */
function ensureChunk(world: World, cx: number, cy: number): Chunk | undefined {
  if (!isChunkInBounds(cx, cy)) return undefined
  const key = chunkKey(cx, cy)
  let chunk = world.chunks.get(key)
  if (!chunk) {
    chunk = generateChunk(world.seed, cx, cy)
    world.chunks.set(key, chunk)
    adoptOverlapping(world, chunk)
  }
  return chunk
}

/**
 * How far a placement may reach out of the chunk that owns it, in chunks. The
 * town's gallery runs are 78 tiles long, which is two chunks either side of
 * their centre at the worst alignment.
 */
export const LEND_RADIUS = 2

/** Whether this chunk is the one a prop's centre falls in — the single chunk
 *  that owns it, lists it in `placements`, and persists it. */
function ownsProp(cx: number, cy: number, prop: PropSpec): boolean {
  return chunkCoord(prop.x) === cx && chunkCoord(prop.y) === cy
}

/**
 * A chunk that appears late still has to see the long pieces its neighbours
 * already hold — a gallery run spans three chunks. Scan the loaded neighbours
 * once, on arrival, and take everything whose footprint reaches in.
 */
function adoptOverlapping(world: World, chunk: Chunk) {
  let rampart = false
  for (let cy = chunk.cy - LEND_RADIUS; cy <= chunk.cy + LEND_RADIUS; cy++) {
    for (let cx = chunk.cx - LEND_RADIUS; cx <= chunk.cx + LEND_RADIUS; cx++) {
      const source = world.chunks.get(chunkKey(cx, cy))
      if (!source || source === chunk) continue
      for (const prop of source.props) {
        // Only what that chunk owns: anything it merely borrowed is already
        // reachable from its own owner, which is inside our radius too.
        if (!ownsProp(cx, cy, prop)) continue
        const range = propChunkRange(prop)
        if (chunk.cx < range.minCx || chunk.cx > range.maxCx || chunk.cy < range.minCy || chunk.cy > range.maxCy) continue
        if (chunk.props.includes(prop)) continue
        chunk.props.push(prop)
        rampart ||= isHeightAwareKind(prop.kind)
      }
    }
  }
  if (rampart) reindexRamparts(chunk)
}

/** Take back everything the chunk at (cx, cy) had lent to its neighbours. */
function withdrawLent(world: World, cx: number, cy: number) {
  for (let ny = cy - LEND_RADIUS; ny <= cy + LEND_RADIUS; ny++) {
    for (let nx = cx - LEND_RADIUS; nx <= cx + LEND_RADIUS; nx++) {
      const neighbour = world.chunks.get(chunkKey(nx, ny))
      if (!neighbour) continue
      const kept = neighbour.props.filter(prop => !ownsProp(cx, cy, prop))
      if (kept.length === neighbour.props.length) continue
      neighbour.props = kept
      reindexRamparts(neighbour)
    }
  }
}

/**
 * Install a chunk that came from somewhere else — the wire, or the store.
 *
 * This is the one place cross-chunk bucketing happens for a chunk nobody
 * generated: the incoming placements are bucketed *outward* into the loaded
 * neighbours, the long pieces those neighbours own are adopted *inward*, and
 * both rampart indexes are rebuilt. Without it a streamed chunk would neither
 * lend its 78-tile gallery to the chunk next door nor collide with theirs.
 *
 * A chunk already loaded at those coordinates is refilled in place rather than
 * replaced: the server's dirty set and frame cache hold `Chunk` objects, and a
 * swap would strand them. Versions are taken from `incoming` and never bumped —
 * this installs content, it does not mutate it.
 */
export function installChunk(world: World, incoming: Chunk): Chunk | undefined {
  if (!isChunkInBounds(incoming.cx, incoming.cy)) return undefined
  const key = chunkKey(incoming.cx, incoming.cy)
  const existing = world.chunks.get(key)
  const chunk = existing ?? incoming
  if (existing && existing !== incoming) {
    withdrawLent(world, incoming.cx, incoming.cy)
    existing.heights.set(incoming.heights)
    existing.surface.set(incoming.surface)
    existing.placements = incoming.placements
    existing.version = incoming.version
  }
  chunk.props = []
  world.chunks.set(key, chunk)
  for (const placement of chunk.placements) bucket(world, propFromPlacement(placement))
  adoptOverlapping(world, chunk)
  reindexRamparts(chunk)
  return chunk
}

/** Drop a chunk from the loaded set, and with it everything it had lent to the
 *  neighbours that stay. Returns whether it was there at all. */
export function removeChunk(world: World, cx: number, cy: number): boolean {
  if (!world.chunks.delete(chunkKey(cx, cy))) return false
  withdrawLent(world, cx, cy)
  return true
}

export function createWorld(options: WorldOptions = {}): World {
  const world: World = {
    chunkSize: CHUNK_SIZE,
    bounds: WORLD_BOUNDS,
    seed: options.seed ?? WORLD_SEED,
    start: { ...FORTIFICATIONS.spawn },
    chunks: new Map(),
    generate: options.generate ?? true,
    getChunk(cx, cy) {
      if (!isChunkInBounds(cx, cy)) return undefined
      const chunk = world.chunks.get(chunkKey(cx, cy))
      if (chunk || !world.generate) return chunk
      return ensureChunk(world, cx, cy)
    },
  }
  if (options.town !== false) seedTown(world)
  return world
}

/**
 * Place the committed town into the protected chunks. Every piece keeps a
 * deterministic `town:<index>` id so both sides name the same brick.
 */
export function seedTown(world: World): void {
  // Every town chunk up front: `bucket` only lends into chunks that already
  // exist, and a town chunk holding nothing but the far end of a gallery would
  // otherwise not be there to receive it.
  for (const { cx, cy } of townChunks()) ensureChunk(world, cx, cy)
  for (const placement of townPlacements()) applyPlace(world, placement)
}

let townCache: WorldPlacement[] | undefined

/** The committed town, with the deterministic `town:<index>` id each piece is
 *  known by on both sides. Built once; callers must not mutate the records. */
export function townPlacements(): readonly WorldPlacement[] {
  townCache ??= ([...townStructure, ...townProps] as Omit<WorldPlacement, 'id'>[])
    .map((p, index) => ({ ...p, id: `town:${index}` }))
  return townCache
}

/** The town pieces a given chunk owns. A restored town chunk is re-seeded with
 *  these, because the store never holds them. */
export function townPlacementsIn(cx: number, cy: number): WorldPlacement[] {
  return townPlacements().filter(p => chunkCoord(p.x) === cx && chunkCoord(p.y) === cy).map(p => ({ ...p }))
}

/* -------------------------------------------------------------------------- */
/* Mutation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Place a piece. Returns the chunk that owns it, or undefined out of bounds.
 * Exactly one version moves: the owner's, by one. A piece straddling a border
 * is lent to the neighbour's `props` without touching the neighbour's version,
 * because the neighbour's own content did not change.
 */
export function applyPlace(world: World, placement: WorldPlacement): Chunk | undefined {
  const owner = ensureChunk(world, chunkCoord(placement.x), chunkCoord(placement.y))
  if (!owner) return undefined
  owner.placements.push(placement)
  bucket(world, propFromPlacement(placement))
  owner.version++
  return owner
}

/** Remove a piece by id. Returns the chunk that owned it, if any — again the
 *  only version that moves, by one. */
export function applyRemove(world: World, id: string): Chunk | undefined {
  for (const chunk of world.chunks.values()) {
    const at = chunk.placements.findIndex(p => p.id === id)
    if (at < 0) continue
    chunk.placements.splice(at, 1)
    const prop = chunk.props.find(p => p.id === id)
    if (prop) unbucket(world, prop)
    chunk.version++
    return chunk
  }
  return undefined
}

export type TerraformMode = 'raise' | 'lower' | 'flatten' | 'paint'
export interface TerrainEdit {
  /** Brush centre, in tiles. Snapped to the nearest tile corner. */
  x: number
  y: number
  size: 1 | 2 | 3
  mode: TerraformMode
  /** `paint` only. */
  surface?: SurfaceType
  /** Furthest a single corner may travel in this one operation. `flatten`
   *  otherwise drops a whole cliff in one click; the server always passes
   *  `TERRAFORM_STEP` so no request can move ground faster than a raise. */
  maxStep?: number
}

/** Limit one corner's travel, keeping its direction. */
function clampStep(delta: number, max?: number): number {
  if (max == null || Math.abs(delta) <= max) return delta
  return Math.sign(delta) * max
}

function cornerIndex(chunk: Chunk, gx: number, gy: number): number {
  return (gy - chunk.cy * CHUNK_SIZE) * CHUNK_CORNERS + (gx - chunk.cx * CHUNK_SIZE)
}

/** Read a corner height from whichever chunk holds it. */
export function cornerHeight(world: World, gx: number, gy: number): number {
  const chunk = world.getChunk(chunkCoord(gx), chunkCoord(gy))
  if (!chunk) return Number.NEGATIVE_INFINITY
  return chunk.heights[cornerIndex(chunk, gx, gy)]! * HEIGHT_STEP
}

/**
 * Write a corner height into every chunk that stores it. A corner on a chunk
 * border is duplicated in up to four chunks — they all have to move together or
 * the terrain tears along the seam.
 */
function setCornerHeight(world: World, gx: number, gy: number, height: number, touched: Set<Chunk>) {
  const q = quantise(height)
  const cx = chunkCoord(gx)
  const cy = chunkCoord(gy)
  const onLeft = gx === cx * CHUNK_SIZE
  const onTop = gy === cy * CHUNK_SIZE
  const offsets: [number, number][] = [[0, 0]]
  if (onLeft) offsets.push([-1, 0])
  if (onTop) offsets.push([0, -1])
  if (onLeft && onTop) offsets.push([-1, -1])
  for (const [ox, oy] of offsets) {
    const chunk = world.getChunk(cx + ox, cy + oy)
    if (!chunk) continue
    const i = cornerIndex(chunk, gx, gy)
    if (i < 0 || i >= chunk.heights.length || chunk.heights[i] === q) continue
    chunk.heights[i] = q
    touched.add(chunk)
  }
}

function setSurface(world: World, gx: number, gy: number, value: SurfaceType, touched: Set<Chunk>) {
  const chunk = world.getChunk(chunkCoord(gx), chunkCoord(gy))
  if (!chunk) return
  const i = (gy - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - chunk.cx * CHUNK_SIZE)
  if (chunk.surface[i] === value) return
  chunk.surface[i] = value
  touched.add(chunk)
}

/**
 * Apply one terraform operation. Pure with respect to everything but the chunks
 * it edits: both sides run it on their own world and land on the same bytes.
 * Returns the chunks that actually changed, with their versions already bumped.
 */
export function applyTerrain(world: World, edit: TerrainEdit): Chunk[] {
  const touched = new Set<Chunk>()
  const gx = Math.round(edit.x)
  const gy = Math.round(edit.y)
  const half = Math.floor(edit.size / 2)
  const centre = cornerHeight(world, gx, gy)
  for (let oy = -half; oy < edit.size - half; oy++) {
    for (let ox = -half; ox < edit.size - half; ox++) {
      const x = gx + ox
      const y = gy + oy
      if (edit.mode === 'paint') {
        setSurface(world, x, y, edit.surface ?? SURFACE.dirt, touched)
        continue
      }
      const here = cornerHeight(world, x, y)
      if (!Number.isFinite(here)) continue
      if (edit.mode === 'flatten') setCornerHeight(world, x, y, here + clampStep(centre - here, edit.maxStep), touched)
      else setCornerHeight(world, x, y, here + (edit.mode === 'raise' ? TERRAFORM_STEP : -TERRAFORM_STEP), touched)
    }
  }
  const changed = [...touched]
  for (const chunk of changed) chunk.version++
  return changed
}

/* -------------------------------------------------------------------------- */
/* Iteration                                                                  */
/* -------------------------------------------------------------------------- */

/** Every prop *owned* by a loaded chunk, each exactly once. */
export function* worldProps(world: World): Generator<PropSpec> {
  for (const chunk of world.chunks.values()) {
    for (const prop of chunk.props) {
      if (chunkCoord(prop.x) === chunk.cx && chunkCoord(prop.y) === chunk.cy) yield prop
    }
  }
}

/** Every placement owned by a loaded chunk. */
export function* worldPlacements(world: World): Generator<WorldPlacement> {
  for (const chunk of world.chunks.values()) yield* chunk.placements
}

/* -------------------------------------------------------------------------- */
/* Wire form                                                                  */
/* -------------------------------------------------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Uint8Array(128)
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

function fromBase64(text: string): Uint8Array {
  const clean = text.endsWith('==') ? text.slice(0, -2) : text.endsWith('=') ? text.slice(0, -1) : text
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let at = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean.charCodeAt(i)]!
    const b = B64_INDEX[clean.charCodeAt(i + 1)]!
    const c = B64_INDEX[clean.charCodeAt(i + 2)]!
    const d = B64_INDEX[clean.charCodeAt(i + 3)]!
    bytes[at++] = (a << 2) | (b >> 4)
    if (at < bytes.length) bytes[at++] = ((b & 15) << 4) | (c >> 2)
    if (at < bytes.length) bytes[at++] = ((c & 3) << 6) | d
  }
  return bytes
}

/** Compact transport form: heights and surface as base64 blobs, placements as
 *  JSON. Around 3 KB per chunk before compression. */
export interface EncodedChunk {
  cx: number
  cy: number
  v: number
  /** base64 of the `Int16Array` height buffer, little-endian. */
  h: string
  /** base64 of the surface raster. */
  s: string
  props: WorldPlacement[]
}

export interface EncodeOptions {
  /** Leave the authored `town:` pieces out. The store holds player state only:
   *  the town comes from the committed JSON, and persisting it would double
   *  every brick on the way back in. */
  omitTown?: boolean
}

export function encodeChunk(chunk: Chunk, options: EncodeOptions = {}): EncodedChunk {
  const bytes = new Uint8Array(chunk.heights.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < chunk.heights.length; i++) view.setInt16(i * 2, chunk.heights[i]!, true)
  return {
    cx: chunk.cx,
    cy: chunk.cy,
    v: chunk.version,
    h: toBase64(bytes),
    s: toBase64(chunk.surface),
    props: chunk.placements
      .filter(p => !options.omitTown || !isTownPlacement(p))
      .map(p => ({ ...p, ...(p.s3 ? { s3: [...p.s3] as [number, number, number] } : {}) })),
  }
}

/** Rebuild a chunk from its wire form. It carries only the placements it owns;
 *  neighbours pick up the overlap when they are created. */
export function decodeChunk(encoded: EncodedChunk): Chunk {
  const bytes = fromBase64(encoded.h)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const heights = new Int16Array(CHUNK_CORNERS * CHUNK_CORNERS)
  for (let i = 0; i < heights.length; i++) heights[i] = view.getInt16(i * 2, true)
  const surface = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
  surface.set(fromBase64(encoded.s).subarray(0, surface.length))
  const props = encoded.props.map(p => propFromPlacement(p))
  return {
    cx: encoded.cx,
    cy: encoded.cy,
    heights,
    surface,
    placements: encoded.props,
    props,
    ramparts: rampartIndex(props),
    version: encoded.v,
  }
}

/* -------------------------------------------------------------------------- */
/* Ids                                                                        */
/* -------------------------------------------------------------------------- */

let idCounter = 0
/** Small unique id, no dependency. Town pieces use `town:<index>` instead. */
export function makePlacementId(prefix = 'p'): string {
  idCounter = (idCounter + 1) % 0xFFFFFF
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 0xFFFF).toString(36)}`
}
