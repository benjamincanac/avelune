/**
 * Avelune's world: one hand-authored walled town.
 *
 * Everything that decides where a body can stand lives here — the arena's tile
 * grid, prop collision footprints, and the kinematics. The authoritative server
 * and the client's prediction both call these exact functions, so they can
 * never disagree: same plan in, same position out. Never fork any of this into
 * a component or the WS handler.
 *
 * The arena is fixed, not procedural. Its visible pieces are authored once in
 * the dev editor and committed as JSON (`courtyard-structure.json` for the town
 * buildings, `courtyard-props.json` for free-standing clutter), so no geometry ever
 * travels over the WebSocket — only players.
 */

import { MOAT, isOnMoatStairs, moatGroundHeight, moatWaterDepth, hitsMoatObstacle } from './moat'
import hubProps from '../data/courtyard-props.json'
import hubStructure from '../data/courtyard-structure.json'
import { galleryDeckHeight, hitsRampartRail, isRampartKind, nearRamparts, rampartIndex, rampartStairHeight } from './ramparts'
import type { RampartIndex } from './ramparts'
import { COURTYARD_ASSETS, FOUNTAIN, FORTIFICATIONS, isInMoat, isOnGateBridge } from './courtyard'

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

/** A placed prop. `top > 0` means players can stand on it. */
export interface PropSpec {
  kind: string
  x: number
  y: number
  rot: number
  scale: number
  /** Walkable height of its top surface (0 = decorative, walk-through). */
  top: number
  /** Footprint radius. For boxed kinds this is the broad-phase bounding radius
   *  (hypot of the box half-extents); for round kinds it's the collision disc. */
  r: number
  /** Oriented-box footprint half-extents `[localX, localY]` (tile-plane), for
   *  wall/panel pieces a circle can't fit. When set, collision is a rotated-rect
   *  test inside the `r` broad-phase; absent means the circular `r` is the shape. */
  bx?: number
  by?: number
  /** Hand-placed via the dev editor — lets the editor isolate and re-render just
   *  the props it owns. */
  hand?: boolean
  /** 3D elevation (height off the ground) for building pieces. Render-only:
   *  collision stays ground-based, including for elevated solid kinds. */
  z?: number
  /** Per-axis scale `[x, y, z]`. Overrides uniform `scale` for rendering,
   *  collision footprints, and top height. */
  s3?: [number, number, number]
}

/**
 * A hand-placed prop as stored in `shared/data/courtyard-props.json` (gameplay props)
 * or `shared/data/courtyard-structure.json` (baked town pieces), written by the dev
 * editor. `top`/`r` are never stored — they're always derived through `makeProp`
 * so server collision and client rendering stay in lockstep. `z` is render-only
 * elevation; `s3` scales both the visible mesh and its collision dimensions.
 */
export interface HubPropPlacement {
  kind: string
  x: number
  y: number
  rot: number
  scale: number
  z?: number
  s3?: [number, number, number]
}

export interface FloorPlan {
  /** Tile grid dimensions. */
  width: number
  height: number
  /** Row-major tile grid: 1 = wall, 0 = floor. */
  tiles: Uint8Array
  /** Spawn point. */
  start: { x: number, y: number }
  props: PropSpec[]
  /** Rampart placements (gallery decks, stair flights, rails) pre-filtered out
   *  of `props`, so the 20 Hz step doesn't rescan every prop for them. Rebuild
   *  with `rampartIndex` whenever `props` changes. */
  ramparts: RampartIndex
}

/**
 * Per-kind collision at scale 1. `top` is the walkable surface height: a tall
 * `top` (above jump height) makes a prop an unjumpable blocker; a low one is a
 * ledge you can hop onto. Round kinds give just `r` (a collision disc). Wall/
 * panel kinds a circle can't fit give `box: [localX, localY]` half-extents — an
 * oriented rectangle in the tile plane; `r` is then derived as its bounding
 * radius. `top`/`r`/`box` scale with the placement (per-axis when `s3` is set).
 */
interface SolidProp { top: number, r: number, box?: [number, number] }
const SOLID_PROPS: Record<string, SolidProp> = {
  // Rampart pieces (gallery/stairs/rail) keep a footprint box for the rampart
  // helpers but a `top` of 0, so the ground-based collision below ignores them:
  // their surfaces are height-aware and owned by `ramparts.ts`.
  ...Object.fromEntries(Object.entries(COURTYARD_ASSETS).map(([kind, asset]) => [kind,
    'radius' in asset
      ? { top: asset.height, r: asset.radius }
      : { top: isRampartKind(kind) ? 0 : asset.height, r: Math.hypot(asset.width / 2, asset.depth / 2), box: [asset.width / 2, asset.depth / 2] },
  ])),
  // Radii track each model's real footprint (measured), so collision hugs the
  // visible mesh instead of a fat invisible ring around it. `Bricks` is left
  // out on purpose: its mesh is a long, tall, thin wall (~1.8×0.55×1.6) that no
  // single circle can fit — a circle wide enough to cover the broad faces reads
  // as an invisible wall, and a full-height one would wall off gaps — so it
  // stays decorative clutter you can walk through.
  Crate: { top: 0.8, r: 0.42 },
  Barrel: { top: 1.05, r: 0.42 },
  Chest: { top: 0.88, r: 0.55 },
  // Fantasy-kit furniture that doubles as a low platform to hop onto.
  Crate_Wooden: { top: 1.1, r: 0.45 },
  Chest_Wood: { top: 0.68, r: 0.55 },
  // Nature/town obstacles: trees and boulders block like walls; the
  // crate/wagon are lower so they read as clutter you can vault with a jump.
  CommonTree_1: { top: 3, r: 0.6 },
  CommonTree_2: { top: 3, r: 0.6 },
  CommonTree_3: { top: 3, r: 0.6 },
  Pine_1: { top: 3, r: 0.6 },
  Pine_2: { top: 3, r: 0.6 },
  Rock_Medium_1: { top: 1.8, r: 0.9 },
  Rock_Medium_2: { top: 1.8, r: 0.85 },
  Rock_Medium_3: { top: 1.8, r: 0.95 },
  Prop_Crate: { top: 0.9, r: 0.55 },
  Prop_Wagon: { top: 1.2, r: 1.05 },
  // Ground-level town building pieces (baked into courtyard-structure.json). Tall
  // `top` (unjumpable) so house walls block; ~1-tile radius so a chain of 2-unit
  // wall panels reads as a solid perimeter. The door frame + gate arch are left
  // OUT so their openings stay walkable. Upper-floor/roof kinds are never listed
  // (cosmetic, and they sit at z>0 where ground collision wouldn't apply).
  Wall_UnevenBrick_Straight: { top: 3.4, r: 1 },
  Wall_UnevenBrick_Window_Wide_Round: { top: 3.4, r: 1 },
  Corner_Exterior_Brick: { top: 3.4, r: 0.7 },
  Prop_Support: { top: 3.4, r: 0.35 },
  Prop_WoodenFence_Single: { top: 1.1, r: 1 },
  // Dungeon/crypt wall + column pieces. Oriented boxes so a chain of panels
  // forms a tight wall instead of a scalloped line of discs; `box` half-extents
  // are [localX, localY] from the convert DIMS (W/2 × D/2). A high `top` makes
  // them unjumpable blockers. Arches/doorways/entrances stay OUT so their
  // openings remain walkable. Dungeon walls run along local X (2.0 wide × 0.44
  // thick); crypt walls run along local Y (0.68 thick × 2.04 long) — note the
  // transposed extents.
  Dungeon_Wall_Modular: { top: 3, r: 1, box: [1, 0.22] }, // 2.00 × 0.44 × 2.01
  Dungeon_Decorative_Wall: { top: 3, r: 1, box: [0.87, 0.22] }, // 1.74 × 0.44 × 1.52
  Dungeon_Column: { top: 4, r: 0.65 }, // 1.30 × 1.30 × 4.07
  Dungeon_Column2: { top: 4, r: 0.65 },
  Crypt_ModularStoneWall: { top: 3, r: 1, box: [0.34, 1.02] }, // 0.68 × 2.04 × 2.04
  Crypt_ModularStoneWall_top: { top: 3, r: 1, box: [0.35, 1.99] }, // 0.70 × 3.98 × 2.26
  Crypt_WallRocks: { top: 3, r: 1, box: [0.1, 1.02] }, // 0.15 × 2.05 × 2.04
  Crypt_Column: { top: 4.9, r: 1 }, // 2.00 × 2.00 × 4.92
}

function makeProp(kind: string, x: number, y: number, rot: number, scale: number, s3?: [number, number, number]): PropSpec {
  const solid = SOLID_PROPS[kind]
  if (!solid) return { kind, x, y, rot, scale, top: 0, r: 0 }
  const [sx, sy, sz] = s3 ?? [scale, scale, scale]
  const spec: PropSpec = {
    kind,
    x,
    y,
    rot,
    scale,
    top: solid.top * sy,
    r: solid.r * Math.max(sx, sz),
  }
  if (solid.box) {
    spec.bx = solid.box[0] * sx
    spec.by = solid.box[1] * sz
    // Bounding radius must cover the rotated rect's far corner for broad-phase.
    spec.r = Math.hypot(spec.bx, spec.by)
  }
  return spec
}

/** Whether a prop kind collides (blocks/ledges) vs. renders purely decorative. */
export function isSolidProp(kind: string): boolean {
  return kind in SOLID_PROPS
}

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
/* The arena                                                                  */
/* -------------------------------------------------------------------------- */

/** The town and its walkable exterior, entered across the southern bridge. */
export const HUB_LAYOUT = {
  size: 144,
  center: { x: 72, y: 72 },
  start: FORTIFICATIONS.spawn,
}

export function generateHub(): FloorPlan {
  const size = HUB_LAYOUT.size
  const tiles = new Uint8Array(size * size)

  // Only the outer world edge uses solid tiles. Moat banks and the bed are
  // height-aware shared surfaces, while authored wall props keep the gate open.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x < FORTIFICATIONS.exteriorMin || x >= FORTIFICATIONS.exteriorMax
        || y < FORTIFICATIONS.exteriorMin || y >= FORTIFICATIONS.exteriorMax) tiles[y * size + x] = 1
    }
  }
  // Explicit border ring (defensive — the town boundary already covers the edges).
  for (let i = 0; i < size; i++) {
    tiles[i] = 1
    tiles[(size - 1) * size + i] = 1
    tiles[i * size] = 1
    tiles[i * size + size - 1] = 1
  }

  // Every visible building, wall, tree and furnishing is a hand placement
  // baked into the committed JSON — appended here, run through makeProp so the
  // server uses the same dimensions as the client. `z` is render-only;
  // `s3` also scales the collision footprint and top height.
  const props: PropSpec[] = []
  const placements = [...hubStructure, ...hubProps] as HubPropPlacement[]
  for (const p of placements) {
    props.push({ ...makeProp(p.kind, p.x, p.y, p.rot, p.scale, p.s3), hand: true, z: p.z, s3: p.s3 })
  }

  return {
    width: size,
    height: size,
    tiles,
    start: { ...HUB_LAYOUT.start },
    props,
    ramparts: rampartIndex(props),
  }
}

/* -------------------------------------------------------------------------- */
/* Collision                                                                  */
/* -------------------------------------------------------------------------- */

export function isWalkable(plan: FloorPlan, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= plan.width || ty >= plan.height) return false
  return plan.tiles[ty * plan.width + tx] === 0
}

/**
 * Move a circle of radius `r` by (dx, dy) with axis-separated collision
 * against wall tiles, sliding along walls instead of sticking to them.
 * Used by the server for authoritative movement and by the client for
 * third-person prediction — same function, same result.
 */
export function moveWithCollision(
  plan: FloorPlan,
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
    if (!isWalkable(plan, edge, Math.floor(y - r)) || !isWalkable(plan, edge, Math.floor(y + r))) {
      nx = dx > 0 ? edge - r - EPSILON : edge + 1 + r + EPSILON
    }
  }

  let ny = y + dy
  if (dy !== 0) {
    const edge = Math.floor(ny + Math.sign(dy) * r)
    if (!isWalkable(plan, Math.floor(nx - r), edge) || !isWalkable(plan, Math.floor(nx + r), edge)) {
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

/** Height of the walkable surface at a point (0 = ground, else a prop top). */
export function surfaceHeight(plan: FloorPlan, x: number, y: number, feet = Infinity): number {
  let top = rampartStairHeight(plan.ramparts, x, y) ?? moatGroundHeight(x, y, feet)
  for (const prop of plan.props) {
    if (prop.top <= 0 || prop.top <= top || (prop.kind === 'Courtyard_BridgeRail' && feet < -0.5)) continue
    const dx = x - prop.x
    const dy = y - prop.y
    // Broad-phase: the bounding radius (a disc for round kinds, the box's corner
    // reach for oriented kinds).
    if (Math.hypot(dx, dy) > prop.r) continue
    // Narrow-phase for boxed kinds: rotate the delta into the prop's local frame
    // and test the axis-aligned rectangle.
    if (prop.bx != null && prop.by != null) {
      const c = Math.cos(prop.rot)
      const s = Math.sin(prop.rot)
      // Placements use Three.js Y rotation: world X = local X*c + local Z*s,
      // world Z = -local X*s + local Z*c. Invert that transform here.
      const lx = dx * c - dy * s
      const ly = dx * s + dy * c
      if (Math.abs(lx) > prop.bx || Math.abs(ly) > prop.by) continue
    }
    if (prop.kind === 'Courtyard_Fountain') {
      const point = fountainPoint(prop, x, y)
      top = Math.max(top, fountainHeight(Math.hypot(point.x, point.y)) * point.heightScale)
    }
    else top = prop.top
  }
  return top
}

/**
 * A display-only wall grid for the minimap: the tile grid plus every
 * wall-height solid prop rasterized in. Deterministic and cheap — computed once
 * on the client, never read by the server. Lets free-placed architecture (the
 * arena's baked structure) show up on the map, which reading raw `tiles`
 * (mostly open) would not.
 *
 * Rasterized by tile-square OVERLAP with each prop's world-space AABB — not by
 * whether a tile *centre* falls inside the footprint. Wall panels are only
 * ~0.44 thick, so they slip between tile centres and a centre test would draw an
 * empty room; overlap makes a thin wall register on the tiles it crosses.
 */
const DISPLAY_WALL_TOP = 1.2
export function occupancyGrid(plan: FloorPlan): Uint8Array {
  const { width, height } = plan
  const grid = plan.tiles.slice()
  for (const prop of plan.props) {
    if (prop.top < DISPLAY_WALL_TOP) continue
    // World-space AABB half-extents: exact for axis-aligned boxes, a slight
    // over-estimate for diagonal ones (fine for a map). Circles use `r`.
    let ax = prop.r
    let ay = prop.r
    // Only the central column is a wall. The basin and steps are walkable.
    if (prop.kind === 'Courtyard_Fountain') {
      const [sx, , sz] = prop.s3 ?? [prop.scale, prop.scale, prop.scale]
      const c = Math.cos(prop.rot)
      const s = Math.sin(prop.rot)
      ax = FOUNTAIN.pedestalRadius * Math.hypot(sx * c, sz * s)
      ay = FOUNTAIN.pedestalRadius * Math.hypot(sx * s, sz * c)
    }
    if (prop.bx != null && prop.by != null) {
      const c = Math.abs(Math.cos(prop.rot))
      const s = Math.abs(Math.sin(prop.rot))
      ax = prop.bx * c + prop.by * s
      ay = prop.bx * s + prop.by * c
    }
    const minX = Math.max(0, Math.floor(prop.x - ax))
    const maxX = Math.min(width - 1, Math.ceil(prop.x + ax))
    const minY = Math.max(0, Math.floor(prop.y - ay))
    const maxY = Math.min(height - 1, Math.ceil(prop.y + ay))
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        // Does tile square [tx,tx+1]×[ty,ty+1] overlap the prop's AABB?
        if (tx < prop.x + ax && tx + 1 > prop.x - ax && ty < prop.y + ay && ty + 1 > prop.y - ay) {
          grid[ty * width + tx] = 1
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
 * Advance a body by (dx, dy) over dt seconds: wall collision, prop ledges
 * (small ones are stepped onto, tall ones block until you jump), gravity,
 * and landing. One function, run identically by the server and by client
 * prediction.
 */
export function stepBody(plan: FloorPlan, body: KinematicBody, dx: number, dy: number, dt: number) {
  // Narrow fountain steps and bridge parapets must not be skipped by a dash.
  // Other dry ground keeps the same movement integration.
  const nearFineCollision = plan.props.some(prop => (prop.kind === 'Courtyard_Fountain' || prop.kind === 'Courtyard_BridgeRail')
    && Math.hypot(body.x - prop.x, body.y - prop.y) <= prop.r + Math.hypot(dx, dy) + PLAYER_RADIUS)
  const nearRampart = nearRamparts(plan.ramparts, body.x, body.y, Math.hypot(dx, dy) + PLAYER_RADIUS)
  const nearMoat = isInMoat(body.x, body.y) || isInMoat(body.x + dx, body.y + dy) || isOnMoatStairs(body.x, body.y)
  const steps = nearFineCollision || nearRampart || nearMoat ? Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.12), nearMoat ? Math.ceil(dt * 60) : 1) : 1
  for (let i = 0; i < steps; i++) stepBodyOnce(plan, body, dx / steps, dy / steps, dt / steps)
}

function stepBodyOnce(plan: FloorPlan, body: KinematicBody, dx: number, dy: number, dt: number) {
  let depth = moatWaterDepth(body.x, body.y, body.z)
  for (const prop of plan.props) depth = Math.max(depth, getFountainWaterContact(prop, body)?.depth ?? 0)
  const swimming = getSwimmingContact(plan, body)
  const distance = Math.hypot(dx, dy)
  const speed = swimming
    ? Math.min(1, MOAT.swimSpeed * dt / (distance || 1))
    : 1 - 0.4 * Math.min(1, depth / 0.5)
  dx *= speed
  dy *= speed
  // Horizontal, axis-separated so tall props block like walls but slide.
  if (dx !== 0 || dy !== 0) {
    const walled = moveWithCollision(plan, body.x, body.y, dx, dy)
    if (bodySurfaceHeight(plan, walled.x, body.y, body.z) - body.z <= STEP_MAX && !hitsRampartRail(plan.ramparts, walled.x, body.y, body.z, PLAYER_RADIUS, STEP_MAX) && !hitsMoatObstacle(walled.x, body.y, body.z, PLAYER_RADIUS)) body.x = walled.x
    if (bodySurfaceHeight(plan, body.x, walled.y, body.z) - body.z <= STEP_MAX && !hitsRampartRail(plan.ramparts, body.x, walled.y, body.z, PLAYER_RADIUS, STEP_MAX) && !hitsMoatObstacle(body.x, walled.y, body.z, PLAYER_RADIUS)) body.y = walled.y
  }

  // Vertical: gravity, then land on (or step up to) whatever is below.
  const surface = bodySurfaceHeight(plan, body.x, body.y, body.z)
  // Follow descending treads without turning each step into a small fall.
  if (body.grounded && body.vz <= 0 && body.z - surface <= STEP_MAX) body.z = surface
  const underBridge = body.z < -0.5 && isInMoat(body.x, body.y) && isOnGateBridge(body.x, body.y)
  const swim = getSwimmingContact(plan, body)
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
export function getSwimmingContact(plan: FloorPlan, body: Pick<KinematicBody, 'x' | 'y' | 'z'>) {
  if (!isInMoat(body.x, body.y) || body.z >= MOAT.waterHeight - 0.05) return null
  let targetFeetHeight = MOAT.waterHeight - MOAT.swimDraft
  if (isOnGateBridge(body.x, body.y)) targetFeetHeight = Math.min(targetFeetHeight, MOAT.bridgeUnderside - MOAT.bodyHeight)
  const floor = bodySurfaceHeight(plan, body.x, body.y, body.z)
  if (floor >= targetFeetHeight - 0.08) return null
  return { waterHeight: MOAT.waterHeight, targetFeetHeight, depth: MOAT.waterHeight - body.z }
}

/** Galleries have ground passages below them. A foot must reach the deck before
 * it can support a body; ordinary authored prop z remains render-only. */
export function bodySurfaceHeight(plan: FloorPlan, x: number, y: number, feet: number) {
  const ground = surfaceHeight(plan, x, y, feet)
  const deck = galleryDeckHeight(plan.ramparts, x, y, feet, STEP_MAX)
  return deck === null ? ground : Math.max(ground, deck)
}
