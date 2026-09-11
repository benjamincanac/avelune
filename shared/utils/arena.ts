/**
 * Vercel Stadium's world: one hand-authored stadium arena.
 *
 * Everything that decides where a body can stand lives here — the arena's tile
 * grid, prop collision footprints, and the kinematics. The authoritative server
 * and the client's prediction both call these exact functions, so they can
 * never disagree: same plan in, same position out. Never fork any of this into
 * a component or the WS handler.
 *
 * The arena is fixed, not procedural.
 * Its hand-placed pieces are committed as JSON: `arena-structure.json` (kit pieces), `arena-props.json` (clutter).
 * So no geometry ever travels over the WebSocket — only players.
 */

import hubProps from '../data/arena-props.json'
import hubStructure from '../data/arena-structure.json'

/** How far players move, in tiles per second. */
export const PLAYER_SPEED = 3.2
/** Collision radius of a player, in tiles. */
export const PLAYER_RADIUS = 0.3

/* Vertical kinematics (shared by server simulation and client prediction). */
export const GRAVITY = 18
export const JUMP_VELOCITY = 5.7
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
  /** 3D elevation (height off the ground) — for baked building pieces (upper
   *  floors, roofs). Render-only: collision stays ground-based (see makeProp). */
  z?: number
  /** Per-axis scale `[x, y, z]` for the handful of stretched building pieces
   *  (market canopy, gate arch). Render-only; overrides uniform `scale`. */
  s3?: [number, number, number]
}

/**
 * A hand-placed prop as stored in `shared/data/arena-props.json` (gameplay props)
 * or `shared/data/arena-structure.json` (kit pieces), both edited by hand.
 * `top`/`r` are never stored — they're always derived through `makeProp`
 * so server collision and client rendering stay in lockstep. `z` (elevation) and
 * `s3` (per-axis scale) are optional render-only extras.
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
  // Nature/village obstacles: trees and boulders block like walls; the
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
  // Ground-level village building pieces (baked into arena-structure.json). Tall
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

/**
 * The stadium layout, shared so `generateArena` (collision tiles) and the
 * client renderer (arena sand, stands) never drift apart. World
 * coords in tiles (1 tile = 1 unit).
 *
 * A gigantic stadium: players spawn on the open arena sand in the middle, and
 * an unbroken ring of tiles under the tiered stands walls it in (the parapet
 * visuals sit on top of it). There is no way out — the arena is the whole world.
 * Everything visible is a hand-placed kit piece (baked into arena-structure.json);
 * only the sand and the ring are procedural.
 */
export const ARENA_LAYOUT = {
  size: 56,
  center: { x: 28, y: 28 },
  /** Open arena radius — players roam freely inside this. */
  arenaRadius: 12,
  /** The solid stands ring begins here (tiles at radius ≥ this are wall). */
  wallInner: 13,
  /** Spawn, on the sand just south of centre. */
  start: { x: 28, y: 32 },
}

export function generateArena(): FloorPlan {
  const size = ARENA_LAYOUT.size
  const { center, wallInner } = ARENA_LAYOUT
  const tiles = new Uint8Array(size * size)

  // Solid stands ring: every tile outside the arena is wall.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y)
      if (d >= wallInner) tiles[y * size + x] = 1
    }
  }
  // Explicit border ring (defensive — the arena annulus already covers the edges).
  for (let i = 0; i < size; i++) {
    tiles[i] = 1
    tiles[(size - 1) * size + i] = 1
    tiles[i * size] = 1
    tiles[i * size + size - 1] = 1
  }

  // Every visible piece (arcade, columns, stands, statues) is a hand placement
  // baked into the committed JSON — appended here, run through makeProp so the
  // server simulates collision exactly as the client renders. `z`/`s3` are
  // render-only extras carried onto the spec.
  const props: PropSpec[] = []
  const placements = [...hubStructure, ...hubProps] as HubPropPlacement[]
  for (const p of placements) {
    props.push({ ...makeProp(p.kind, p.x, p.y, p.rot, p.scale, p.s3), z: p.z, s3: p.s3 })
  }

  return {
    width: size,
    height: size,
    tiles,
    start: { ...ARENA_LAYOUT.start },
    props,
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

/** Height of the walkable surface at a point (0 = ground, else a prop top). */
export function surfaceHeight(plan: FloorPlan, x: number, y: number): number {
  let top = 0
  for (const prop of plan.props) {
    if (prop.top <= top) continue
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
      const lx = dx * c + dy * s
      const ly = -dx * s + dy * c
      if (Math.abs(lx) > prop.bx || Math.abs(ly) > prop.by) continue
    }
    top = prop.top
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
  // Horizontal, axis-separated so tall props block like walls but slide.
  if (dx !== 0 || dy !== 0) {
    const walled = moveWithCollision(plan, body.x, body.y, dx, dy)
    if (surfaceHeight(plan, walled.x, body.y) - body.z <= STEP_MAX) body.x = walled.x
    if (surfaceHeight(plan, body.x, walled.y) - body.z <= STEP_MAX) body.y = walled.y
  }

  // Vertical: gravity, then land on (or step up to) whatever is below.
  const surface = surfaceHeight(plan, body.x, body.y)
  body.vz -= GRAVITY * dt
  body.z += body.vz * dt
  if (body.z <= surface && body.vz <= 0) {
    body.z = surface
    body.vz = 0
    body.grounded = true
  }
  else {
    body.grounded = false
  }
}
