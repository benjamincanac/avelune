/**
 * Avelune's world physics.
 *
 * Everything that decides where a body can stand lives here — terrain height,
 * prop collision footprints, and the kinematics. The authoritative server and
 * the client's prediction both call these exact functions, so they can never
 * disagree: same world in, same position out. Never fork any of this into a
 * component or the WS handler.
 *
 * The world itself is `shared/utils/world.ts`: a grid of 32×32 tile chunks,
 * generated on first touch from a seed, with the hand-authored town seeded into
 * the protected chunks at the centre from the committed JSON
 * (`courtyard-structure.json` for the buildings, `courtyard-props.json` for the
 * clutter). No geometry travels over the WebSocket — only players.
 *
 * Every spatial query reads at most the 3×3 chunk neighbourhood around the
 * point, never a flat list of every prop in the world.
 */

import { MOAT, isOnMoatStairs, moatGroundHeight, moatWaterDepth, hitsMoatObstacle } from './moat'
import { galleryDeckHeight, hitsRampartRail, indexBlocksCamera, isHeightAwareKind, nearRamparts, rampartStairHeight } from './ramparts'
import type { RampartIndex } from './ramparts'
import { FOUNTAIN, FORTIFICATIONS, isInMoat, isOnGateBridge } from './courtyard'
import { propHalfExtents } from './props'
import type { PropSpec } from './props'
import {
  CHUNK_SIZE,
  CHUNK_CORNERS,
  HEIGHT_STEP,
  WORLD_TILE_MAX,
  WORLD_TILE_MIN,
  chunkCoord,
  isProtectedTile,
} from './world'
import type { Chunk, World } from './world'

/** How far players move, in tiles per second. */
export const PLAYER_SPEED = 3.2
/** Collision radius of a player, in tiles. */
export const PLAYER_RADIUS = 0.3

/* Vertical kinematics (shared by server simulation and client prediction). */
export const GRAVITY = 18
export const JUMP_VELOCITY = 7.5
/** Highest ledge you can walk up without jumping. */
export const STEP_MAX = 0.5
export const DASH_MULTIPLIER = 2.9
export const DASH_DURATION = 0.22
export const DASH_COOLDOWN = 1.1

/** Steepest terrain a body can walk onto, in units of height per tile. Anything
 *  above this reads as a cliff face, which is how terraced terrain gets walls
 *  without a voxel model. */
export const SLOPE_MAX = 1.2

/** How tall a player is, for the vertical band test that decides whether a
 *  raised piece is walked under or walked into. Shared with the moat's
 *  under-bridge clearance so a body has one height everywhere. */
export const BODY_HEIGHT = MOAT.bodyHeight

/** Deterministic PRNG (mulberry32), for cosmetic hashing that must stay stable
 *  across reloads (procedural textures). Never used for gameplay state. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6D2B79F5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* -------------------------------------------------------------------------- */
/* The town                                                                   */
/* -------------------------------------------------------------------------- */

/** The authored town's own extent, still 144 tiles. The world is far larger
 *  (`WORLD_BOUNDS` in `world.ts`) but the editor, the minimap's landmarks and
 *  the composed architecture all address the town square. */
export const HUB_LAYOUT = {
  size: 144,
  center: { x: 72, y: 72 },
  start: FORTIFICATIONS.spawn,
}

/* -------------------------------------------------------------------------- */
/* Chunk neighbourhood queries                                                */
/* -------------------------------------------------------------------------- */

/** The up-to-nine chunks around a point. Every physics query goes through here,
 *  so no code path can ever walk the whole world. */
function* chunksNear(world: World, x: number, y: number): Generator<Chunk> {
  const cx0 = chunkCoord(x)
  const cy0 = chunkCoord(y)
  for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
      const chunk = world.getChunk(cx, cy)
      if (chunk) yield chunk
    }
  }
}

/**
 * Props whose footprint comes within `r` of (x, y), from the 3×3 chunk
 * neighbourhood. A piece straddling a border is bucketed into every chunk it
 * overlaps, so it can be yielded twice — every consumer takes a max or an OR,
 * which makes that harmless.
 */
export function* propsNear(world: World, x: number, y: number, r = 0): Generator<PropSpec> {
  for (const chunk of chunksNear(world, x, y)) {
    for (const prop of chunk.props) {
      if (Math.hypot(x - prop.x, y - prop.y) <= prop.r + r) yield prop
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Terrain                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Bilinear terrain height at a world position. `-Infinity` when the chunk under
 * the point is not loaded, so a body over a late-arriving chunk is treated as
 * standing over nothing rather than falling through the floor.
 *
 * All four corners of a tile live in that tile's own chunk (the 33rd row and
 * column duplicate the neighbour), so this is a single chunk lookup.
 */
export function terrainHeight(world: World, x: number, y: number): number {
  const gx = Math.floor(x)
  const gy = Math.floor(y)
  const chunk = world.getChunk(chunkCoord(gx), chunkCoord(gy))
  if (!chunk) return Number.NEGATIVE_INFINITY
  const lx = gx - chunk.cx * CHUNK_SIZE
  const ly = gy - chunk.cy * CHUNK_SIZE
  const i = ly * CHUNK_CORNERS + lx
  const h00 = chunk.heights[i]!
  const h10 = chunk.heights[i + 1]!
  const h01 = chunk.heights[i + CHUNK_CORNERS]!
  const h11 = chunk.heights[i + CHUNK_CORNERS + 1]!
  const fx = x - gx
  const fy = y - gy
  const top = h00 + (h10 - h00) * fx
  const bottom = h01 + (h11 - h01) * fx
  return (top + (bottom - top) * fy) * HEIGHT_STEP
}

/** Steepest corner-to-corner drop across a tile, in units per tile. */
function tileSlope(chunk: Chunk, tx: number, ty: number): number {
  const i = (ty - chunk.cy * CHUNK_SIZE) * CHUNK_CORNERS + (tx - chunk.cx * CHUNK_SIZE)
  const h00 = chunk.heights[i]!
  const h10 = chunk.heights[i + 1]!
  const h01 = chunk.heights[i + CHUNK_CORNERS]!
  const h11 = chunk.heights[i + CHUNK_CORNERS + 1]!
  return Math.max(Math.abs(h10 - h00), Math.abs(h11 - h01), Math.abs(h01 - h00), Math.abs(h11 - h10)) * HEIGHT_STEP
}

/* -------------------------------------------------------------------------- */
/* Collision                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a tile can be entered at all: inside the world edge, backed by a
 * loaded chunk, and not a cliff face. Prop blocking is *not* decided here —
 * props are ledges you step onto or walls you can't, which `stepBodyOnce`
 * resolves against `STEP_MAX`.
 */
export function isWalkable(world: World, tx: number, ty: number): boolean {
  if (tx < WORLD_TILE_MIN || ty < WORLD_TILE_MIN || tx >= WORLD_TILE_MAX || ty >= WORLD_TILE_MAX) return false
  const chunk = world.getChunk(chunkCoord(tx), chunkCoord(ty))
  if (!chunk) return false
  return tileSlope(chunk, tx, ty) <= SLOPE_MAX
}

/**
 * Move a circle of radius `r` by (dx, dy) with axis-separated collision
 * against blocked tiles, sliding along them instead of sticking.
 * Used by the server for authoritative movement and by the client for
 * third-person prediction — same function, same result.
 */
export function moveWithCollision(
  world: World,
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number = PLAYER_RADIUS,
): { x: number, y: number } {
  const EPSILON = 0.001

  let nx = x + dx
  if (dx !== 0) {
    const edge = Math.floor(nx + Math.sign(dx) * r)
    if (!isWalkable(world, edge, Math.floor(y - r)) || !isWalkable(world, edge, Math.floor(y + r))) {
      nx = dx > 0 ? edge - r - EPSILON : edge + 1 + r + EPSILON
    }
  }

  let ny = y + dy
  if (dy !== 0) {
    const edge = Math.floor(ny + Math.sign(dy) * r)
    if (!isWalkable(world, Math.floor(nx - r), edge) || !isWalkable(world, Math.floor(nx + r), edge)) {
      ny = dy > 0 ? edge - r - EPSILON : edge + 1 + r + EPSILON
    }
  }

  return { x: nx, y: ny }
}

/* -------------------------------------------------------------------------- */
/* Vertical kinematics                                                        */
/* -------------------------------------------------------------------------- */

/** Inverse the model placement, using the same Y rotation as Three.js. */
function fountainPoint(prop: PropSpec, x: number, y: number) {
  const [sx, sy, sz] = prop.s3 ?? [prop.scale, prop.scale, prop.scale]
  const c = Math.cos(prop.rot)
  const s = Math.sin(prop.rot)
  const dx = x - prop.x
  const dy = y - prop.y
  return { x: (dx * c - dy * s) / sx, y: (dx * s + dy * c) / sz, heightScale: sy }
}

function fountainHeight(radius: number) {
  if (radius > FOUNTAIN.outerRadius) return 0
  if (radius > FOUNTAIN.middleStepRadius) return FOUNTAIN.outerStepHeight
  if (radius > FOUNTAIN.rimRadius) return FOUNTAIN.middleStepHeight
  if (radius > FOUNTAIN.waterRadius) return FOUNTAIN.rimHeight
  if (radius > FOUNTAIN.innerStepRadius) return FOUNTAIN.innerStepHeight
  if (radius <= FOUNTAIN.pedestalRadius) return FOUNTAIN.pedestalHeight
  return FOUNTAIN.floorHeight
}

/** Water contact uses local model coordinates and world-space foot depth.
 * Like solid collision, authored elevation remains render-only. */
export function getFountainWaterContact(prop: PropSpec, body: Pick<KinematicBody, 'x' | 'y' | 'z'>) {
  if (prop.kind !== 'Courtyard_Fountain') return null
  const point = fountainPoint(prop, body.x, body.y)
  const radius = Math.hypot(point.x, point.y)
  const surfaceHeight = FOUNTAIN.waterHeight * point.heightScale
  if (radius <= FOUNTAIN.pedestalRadius || radius >= FOUNTAIN.waterRadius || body.z >= surfaceHeight) return null
  return { x: point.x, y: point.y, depth: surfaceHeight - body.z, surfaceHeight }
}

/**
 * Whether a point falls inside a prop's footprint: the bounding radius first (a
 * disc for round kinds, the box's corner reach for oriented ones), then the
 * rotated rectangle for boxed kinds.
 */
function coversPoint(prop: PropSpec, x: number, y: number): boolean {
  const dx = x - prop.x
  const dy = y - prop.y
  if (Math.hypot(dx, dy) > prop.r) return false
  if (prop.bx == null || prop.by == null) return true
  const c = Math.cos(prop.rot)
  const s = Math.sin(prop.rot)
  // Placements use Three.js Y rotation: world X = local X*c + local Z*s,
  // world Z = -local X*s + local Z*c. Invert that transform here.
  return Math.abs(dx * c - dy * s) <= prop.bx && Math.abs(dx * s + dy * c) <= prop.by
}

/**
 * Whether a piece's band supports feet at this height. A ground-based town
 * piece always does — its top *is* its collision, and the step rule turns a
 * tall one into a wall. An elevated piece (`base` set: the build kit, wild
 * vegetation, anything a player placed) supports feet only once they have
 * reached its top, exactly like a gallery deck, which is what leaves the space
 * underneath open.
 */
function supportsFeet(prop: PropSpec, feet: number): boolean {
  // The fountain is a stepped basin, not a slab: its surface is computed
  // radially below and there is nothing to walk under, so it never gates.
  if (prop.base == null || prop.kind === 'Courtyard_Fountain') return true
  return feet >= prop.top - STEP_MAX
}

/**
 * Height of the walkable surface at a point: the terrain, the moat's special
 * floors and the fountain's stepped basin inside the protected region, and the
 * top of whatever prop is standing there — whichever is highest.
 */
export function surfaceHeight(world: World, x: number, y: number, feet = Infinity): number {
  let top = terrainHeight(world, x, y)
  // The moat bed, its bank stair and the gate bridge deck are height-aware
  // surfaces authored on top of the town's level ground, not terrain.
  if (isProtectedTile(x, y) && (isInMoat(x, y) || isOnMoatStairs(x, y))) top = moatGroundHeight(x, y, feet)
  // Stepped ramps (the rampart flight, the build kit's stairs) resolve through
  // `ramparts.ts` instead of their footprint, so their treads win over ground.
  const tread = rampartStairHeight(rampartsAt(world, x, y), x, y)
  if (tread !== null && tread > top) top = tread
  for (const prop of propsNear(world, x, y)) {
    if (prop.height <= 0 || prop.top <= top || isHeightAwareKind(prop.kind)) continue
    if (prop.kind === 'Courtyard_BridgeRail' && feet < -0.5) continue
    if (!supportsFeet(prop, feet)) continue
    if (!coversPoint(prop, x, y)) continue
    if (prop.kind === 'Courtyard_Fountain') {
      const point = fountainPoint(prop, x, y)
      top = Math.max(top, fountainHeight(Math.hypot(point.x, point.y)) * point.heightScale)
    }
    else top = prop.top
  }
  return top
}

/**
 * Whether an elevated piece stands in the way of a body whose feet are here.
 *
 * Ground-based pieces need no such test: they block by presenting a surface too
 * tall to step onto. An elevated one cannot, because it is only a surface once
 * you have climbed it — so the band decides instead. The body occupies
 * `[feet, feet + BODY_HEIGHT]`: below the band it walks underneath, at or above
 * the top it walks on, and anything in between is a wall.
 */
export function hitsRaisedPiece(world: World, x: number, y: number, feet: number): boolean {
  for (const prop of propsNear(world, x, y)) {
    if (prop.base == null || prop.height <= 0) continue
    // Ramps and the fountain basin own their own height-aware surfaces.
    if (isHeightAwareKind(prop.kind) || prop.kind === 'Courtyard_Fountain') continue
    if (feet >= prop.top - STEP_MAX || feet + BODY_HEIGHT <= prop.base) continue
    if (coversPoint(prop, x, y)) return true
  }
  return false
}

/**
 * A display-only wall grid for one chunk: every wall-height solid prop
 * overlapping it, rasterized to its 32×32 tiles. Deterministic and cheap —
 * computed on the client for the minimap, never read by the server. Lets
 * free-placed architecture show up on the map, which reading terrain alone
 * would not.
 *
 * Rasterized by tile-square OVERLAP with each prop's world-space AABB — not by
 * whether a tile *centre* falls inside the footprint. Wall panels are only
 * ~0.44 thick, so they slip between tile centres and a centre test would draw an
 * empty room; overlap makes a thin wall register on the tiles it crosses.
 */
const DISPLAY_WALL_TOP = 1.2
export function occupancyGrid(chunk: Chunk): Uint8Array {
  const grid = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
  const originX = chunk.cx * CHUNK_SIZE
  const originY = chunk.cy * CHUNK_SIZE
  for (const prop of chunk.props) {
    // Band thickness, not absolute top: a floor slab two storeys up is 0.2
    // thick and is not a wall on the map.
    if (prop.height < DISPLAY_WALL_TOP) continue
    let { ax, ay } = propHalfExtents(prop)
    // Only the central column is a wall. The basin and steps are walkable.
    if (prop.kind === 'Courtyard_Fountain') {
      const [sx, , sz] = prop.s3 ?? [prop.scale, prop.scale, prop.scale]
      const c = Math.cos(prop.rot)
      const s = Math.sin(prop.rot)
      ax = FOUNTAIN.pedestalRadius * Math.hypot(sx * c, sz * s)
      ay = FOUNTAIN.pedestalRadius * Math.hypot(sx * s, sz * c)
    }
    const minX = Math.max(originX, Math.floor(prop.x - ax))
    const maxX = Math.min(originX + CHUNK_SIZE - 1, Math.ceil(prop.x + ax))
    const minY = Math.max(originY, Math.floor(prop.y - ay))
    const maxY = Math.min(originY + CHUNK_SIZE - 1, Math.ceil(prop.y + ay))
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        // Does tile square [tx,tx+1]×[ty,ty+1] overlap the prop's AABB?
        if (tx < prop.x + ax && tx + 1 > prop.x - ax && ty < prop.y + ay && ty + 1 > prop.y - ay) {
          grid[(ty - originY) * CHUNK_SIZE + (tx - originX)] = 1
        }
      }
    }
  }
  return grid
}

export interface KinematicBody {
  x: number
  y: number
  /** Height above the floor plane. */
  z: number
  /** Vertical velocity. */
  vz: number
  grounded: boolean
}

/**
 * Advance a body by (dx, dy) over dt seconds: tile collision, prop ledges
 * (small ones are stepped onto, tall ones block until you jump), gravity,
 * and landing. One function, run identically by the server and by client
 * prediction.
 */
export function stepBody(world: World, body: KinematicBody, dx: number, dy: number, dt: number) {
  // Narrow fountain steps and bridge parapets must not be skipped by a dash.
  // Other dry ground keeps the same movement integration.
  const reach = Math.hypot(dx, dy) + PLAYER_RADIUS
  let nearFineCollision = false
  for (const prop of propsNear(world, body.x, body.y, reach)) {
    // Thin raised panels (kit walls, fences, floor slabs) are narrower than a
    // dash-sized displacement, so they get the same fine integration the
    // fountain steps and bridge parapets do.
    if (prop.kind === 'Courtyard_Fountain' || prop.kind === 'Courtyard_BridgeRail' || (prop.base != null && prop.bx != null)) {
      nearFineCollision = true
      break
    }
  }
  const nearRampart = nearRamparts(rampartsAt(world, body.x, body.y), body.x, body.y, reach)
  const nearMoat = isInMoat(body.x, body.y) || isInMoat(body.x + dx, body.y + dy) || isOnMoatStairs(body.x, body.y)
  const steps = nearFineCollision || nearRampart || nearMoat ? Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.12), nearMoat ? Math.ceil(dt * 60) : 1) : 1
  for (let i = 0; i < steps; i++) stepBodyOnce(world, body, dx / steps, dy / steps, dt / steps)
}

function stepBodyOnce(world: World, body: KinematicBody, dx: number, dy: number, dt: number) {
  let depth = moatWaterDepth(body.x, body.y, body.z)
  for (const prop of propsNear(world, body.x, body.y)) depth = Math.max(depth, getFountainWaterContact(prop, body)?.depth ?? 0)
  const swimming = getSwimmingContact(world, body)
  const distance = Math.hypot(dx, dy)
  const speed = swimming
    ? Math.min(1, MOAT.swimSpeed * dt / (distance || 1))
    : 1 - 0.4 * Math.min(1, depth / 0.5)
  dx *= speed
  dy *= speed
  // Horizontal, axis-separated so tall props block like walls but slide.
  if (dx !== 0 || dy !== 0) {
    const walled = moveWithCollision(world, body.x, body.y, dx, dy)
    if (bodySurfaceHeight(world, walled.x, body.y, body.z) - body.z <= STEP_MAX && !hitsRaisedPiece(world, walled.x, body.y, body.z) && !hitsRampartRail(rampartsAt(world, walled.x, body.y), walled.x, body.y, body.z, PLAYER_RADIUS, STEP_MAX) && !hitsMoatObstacle(walled.x, body.y, body.z, PLAYER_RADIUS)) body.x = walled.x
    if (bodySurfaceHeight(world, body.x, walled.y, body.z) - body.z <= STEP_MAX && !hitsRaisedPiece(world, body.x, walled.y, body.z) && !hitsRampartRail(rampartsAt(world, body.x, walled.y), body.x, walled.y, body.z, PLAYER_RADIUS, STEP_MAX) && !hitsMoatObstacle(body.x, walled.y, body.z, PLAYER_RADIUS)) body.y = walled.y
  }

  // Vertical: gravity, then land on (or step up to) whatever is below.
  const surface = bodySurfaceHeight(world, body.x, body.y, body.z)
  // Follow descending treads without turning each step into a small fall.
  if (body.grounded && body.vz <= 0 && body.z - surface <= STEP_MAX) body.z = surface
  const underBridge = body.z < -0.5 && isInMoat(body.x, body.y) && isOnGateBridge(body.x, body.y)
  const swim = getSwimmingContact(world, body)
  if (swim) {
    // Exact critically damped spring integration keeps server/client buoyancy
    // stable across render rates and absorbs the velocity of a high fall.
    const offset = body.z - swim.targetFeetHeight
    const frequency = MOAT.buoyancyFrequency
    const impulse = body.vz + frequency * offset
    const decay = Math.exp(-frequency * dt)
    body.z = swim.targetFeetHeight + (offset + impulse * dt) * decay
    body.vz = (body.vz - frequency * impulse * dt) * decay
  }
  else {
    body.vz -= GRAVITY * dt
    body.z += body.vz * dt
  }
  if (underBridge && body.vz > 0 && body.z + MOAT.bodyHeight > MOAT.bridgeUnderside) {
    body.z = MOAT.bridgeUnderside - MOAT.bodyHeight
    body.vz = 0
  }
  if (body.z <= surface && body.vz <= 0) {
    body.z = surface
    body.vz = 0
    body.grounded = !swim
  }
  else {
    body.grounded = false
  }
}

/** Deep moat water supports a floating body; fountain basins remain wading-only. */
export function getSwimmingContact(world: World, body: Pick<KinematicBody, 'x' | 'y' | 'z'>) {
  if (!isInMoat(body.x, body.y) || body.z >= MOAT.waterHeight - 0.05) return null
  let targetFeetHeight = MOAT.waterHeight - MOAT.swimDraft
  if (isOnGateBridge(body.x, body.y)) targetFeetHeight = Math.min(targetFeetHeight, MOAT.bridgeUnderside - MOAT.bodyHeight)
  const floor = bodySurfaceHeight(world, body.x, body.y, body.z)
  if (floor >= targetFeetHeight - 0.08) return null
  return { waterHeight: MOAT.waterHeight, targetFeetHeight, depth: MOAT.waterHeight - body.z }
}

/* -------------------------------------------------------------------------- */
/* Ramparts                                                                   */
/* -------------------------------------------------------------------------- */

/** The rampart index of the chunk under a point. Long gallery runs are bucketed
 *  into every chunk they overlap, so the containing chunk always has them. */
function rampartsAt(world: World, x: number, y: number) {
  const chunk = world.getChunk(chunkCoord(x), chunkCoord(y))
  return chunk ? chunk.ramparts : EMPTY_RAMPARTS
}
const EMPTY_RAMPARTS: RampartIndex = { galleries: [], stairs: [], rails: [] }

/** Galleries have ground passages below them. A foot must reach the deck before
 * it can support a body; ordinary authored prop z remains render-only. */
export function bodySurfaceHeight(world: World, x: number, y: number, feet: number) {
  const ground = surfaceHeight(world, x, y, feet)
  const deck = galleryDeckHeight(rampartsAt(world, x, y), x, y, feet, STEP_MAX)
  return deck === null ? ground : Math.max(ground, deck)
}

/** Finite raised solids for camera obstruction, without closing the passage
 *  below. Reads the chunk under the sample point. */
export function isRampartCameraBlocked(world: World, x: number, z: number, elevation: number, radius: number): boolean {
  return indexBlocksCamera(rampartsAt(world, x, z), x, z, elevation, radius)
}

/**
 * The same obstruction test for elevated build-kit and wild pieces: each blocks
 * the camera only across its own band, so a boom that passes under a raised
 * floor is not pushed in. Ground-based pieces are already covered by the
 * `surfaceHeight` test the camera does on its own.
 */
export function isPieceCameraBlocked(world: World, x: number, z: number, elevation: number, radius: number): boolean {
  for (const prop of propsNear(world, x, z, radius)) {
    if (prop.base == null || prop.height <= 0 || prop.kind === 'Courtyard_Fountain') continue
    if (elevation + radius < prop.base || elevation - radius > prop.top) continue
    for (const dx of [-radius, 0, radius]) {
      for (const dz of [-radius, 0, radius]) {
        if (coversPoint(prop, x + dx, z + dz)) return true
      }
    }
  }
  return false
}
