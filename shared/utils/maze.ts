/**
 * Tempest's world: a colosseum hub and a descent of hand-authored dungeon
 * floors.
 *
 * Both the server (collision, hazards, win detection) and the client
 * (rendering, prediction, spectator maps) build the exact same floors
 * locally, so no geometry ever travels over the WebSocket — only players.
 *
 * The world is fixed, not procedural: the hub and every floor are authored
 * once (in the dev editor) and bundled as JSON, keyed by a constant
 * `TOWER_SEED` only so the decorative placement hashing stays stable. There
 * is no daily reset — the dungeon is carved and eternal; only the runners
 * change.
 */

import hubProps from '../data/hub-props.json'
import hubStructure from '../data/hub-structure.json'
// Authored floors, bundled as ONE top-level-array JSON (like the hub files).
// NOT per-file with a barrel: the Nitro-beta dev worker (rolldown) crashes on
// importing a top-level-*object* JSON — only arrays are safe. The save route
// rewrites this whole array.
import authoredFloorsData from '../data/floors.json'

/** How far players move, in tiles per second (biome modifiers apply). */
export const PLAYER_SPEED = 3.2
/** Collision radius of a player, in tiles (corridors are 2 tiles wide). */
export const PLAYER_RADIUS = 0.3

/** Floor 0 is the colosseum hub; floors 1.. are the dungeon. */
export const HUB_FLOOR = 0
/** Fixed world key. The world no longer rotates daily, so this is a constant
 *  salt for deterministic cosmetic placement rather than a date-derived seed. */
export const TOWER_SEED = 20260708
/** Radius of the teleport circle trigger in the hub. */
export const PORTAL_RADIUS = 1.7
/** Radius of a floor's exit trigger. */
export const EXIT_RADIUS = 1.2
/** Radius at which an active trap kills. */
export const TRAP_RADIUS = 0.55
/** Traps only kill near the ground — a well-timed jump clears them. */
export const TRAP_MAX_Z = 0.4

/* Vertical kinematics (shared by server simulation and client prediction). */
export const GRAVITY = 18
export const JUMP_VELOCITY = 5.7
/** Highest ledge you can walk up without jumping. */
export const STEP_MAX = 0.5
export const DASH_MULTIPLIER = 2.9
export const DASH_DURATION = 0.22
export const DASH_COOLDOWN = 1.1
/** Seconds a killed player lies dead (playing the death clip) before respawning. */
export const DEATH_DELAY = 1.2

export interface Trap {
  x: number
  y: number
  /** Full cycle length in seconds. */
  period: number
  /** How long the trap is lethal each cycle, in seconds. */
  duration: number
  /** Cycle offset in seconds. */
  phase: number
}

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
  /** Hand-placed via the dev editor (vs. daily scatter) — lets the editor
   *  isolate and re-render just the props it owns. */
  hand?: boolean
  /** 3D elevation (height off the ground) — for baked building pieces (upper
   *  floors, roofs). Render-only: collision stays ground-based (see makeProp). */
  z?: number
  /** Per-axis scale `[x, y, z]` for the handful of stretched building pieces
   *  (market canopy, gate arch). Render-only; overrides uniform `scale`. */
  s3?: [number, number, number]
}

/**
 * A hand-placed hub prop as stored in `shared/data/hub-props.json` (gameplay
 * props) or `shared/data/hub-structure.json` (baked village pieces), written by
 * the dev prop editor. `top`/`r` are never stored — they're always derived
 * through `makeProp` so server collision and client rendering stay in lockstep.
 * `z` (elevation) and `s3` (per-axis scale) are optional render-only extras.
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
  floor: number
  seed: number
  /** Tile grid dimensions. */
  width: number
  height: number
  /** Row-major tile grid: 1 = wall, 0 = floor. */
  tiles: Uint8Array
  /** Spawn point for this floor. */
  start: { x: number, y: number }
  /** Exit trigger center (teleport circle in the hub, portal on floors). */
  exit: { x: number, y: number }
  traps: Trap[]
  props: PropSpec[]
  /** Index into BIOMES, or -1 for the hub. */
  biome: number
}

/**
 * An authored dungeon floor as stored in `shared/data/floors/floor-N.json`
 * (hand-built in the dev editor, bundled as JSON — no procedural generation).
 * Walls are placements, not tiles: `size` only drives the border ring + ground,
 * and collision comes from each solid placement's footprint. `maze.ts` turns
 * this into a runtime `FloorPlan` via `planFromAuthored`. `version` lets chests/
 * monsters be added later without a repaint. The data lives in a single
 * top-level-array `shared/data/floors.json` (NOT per-file objects): the
 * Nitro-beta dev worker crashes importing a top-level-object JSON — arrays are
 * safe (same shape as the hub JSON files).
 */
export interface AuthoredFloorData {
  version: 1
  floor: number
  size: number
  biome: number
  start: { x: number, y: number }
  exit: { x: number, y: number }
  traps: Trap[]
  placements: HubPropPlacement[]
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
  // as an invisible wall, and a full-height one would wall off corridors — so
  // it stays decorative clutter you can walk through.
  Crate: { top: 0.8, r: 0.42 },
  Barrel: { top: 1.05, r: 0.42 },
  Chest: { top: 0.88, r: 0.55 },
  // Fantasy-kit furniture that doubles as a low platform to hop onto.
  Crate_Wooden: { top: 1.1, r: 0.45 },
  Chest_Wood: { top: 0.68, r: 0.55 },
  // Hub nature/village obstacles: trees and boulders block like walls; the
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
  // Ground-level village building pieces (baked into hub-structure.json). Tall
  // `top` (unjumpable) so house walls block; ~1-tile radius so a chain of 2-unit
  // wall panels reads as a solid perimeter. The door frame + gate arch are left
  // OUT so their openings stay walkable. Upper-floor/roof kinds are never listed
  // (cosmetic, and they sit at z>0 where ground collision wouldn't apply).
  Wall_UnevenBrick_Straight: { top: 3.4, r: 1 },
  Wall_UnevenBrick_Window_Wide_Round: { top: 3.4, r: 1 },
  Corner_Exterior_Brick: { top: 3.4, r: 0.7 },
  Prop_Support: { top: 3.4, r: 0.35 },
  Prop_WoodenFence_Single: { top: 1.1, r: 1 },
  // Dungeon/crypt wall + column pieces (authored floors). Oriented boxes so a
  // chain of panels forms a tight corridor wall instead of a scalloped line of
  // discs; `box` half-extents are [localX, localY] from the convert DIMS (W/2 ×
  // D/2). A high `top` makes them unjumpable blockers. Arches/doorways/entrances
  // stay OUT so their openings remain walkable. Dungeon walls run along local X
  // (2.0 wide × 0.44 thick); crypt walls run along local Y (0.68 thick × 2.04
  // long) — note the transposed extents.
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

export const BIOMES = [
  { name: 'Stone Dungeon', speed: 1, cause: 'impaled by spike traps' },
  { name: 'Sunken Depths', speed: 0.72, cause: 'swept under by a geyser' },
  { name: 'Verdant Maze', speed: 1, cause: 'devoured by snapping vines' },
  { name: 'Magma Halls', speed: 1.05, cause: 'incinerated by a magma vent' },
] as const

export function biomeIndex(floor: number): number {
  return (floor - 1) % BIOMES.length
}

export function floorSpeed(floor: number): number {
  return floor === HUB_FLOOR ? 1 : BIOMES[biomeIndex(floor)]!.speed
}

/** Whether a trap is lethal at the given epoch-ms timestamp. */
export function isTrapActive(trap: Trap, nowMs: number): boolean {
  const t = nowMs / 1000 + trap.phase
  return t % trap.period < trap.duration
}

/** Deterministic PRNG (mulberry32) so server and client agree on the world. */
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
/* Hub                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A house footprint, as an inclusive tile rectangle, plus which way its door
 * faces: 0 = north (-y), 1 = east (+x), 2 = south (+y), 3 = west (-x).
 * Footprint spans are kept to 4/6/8 tiles so the renderer can cap each house
 * with a matching Medieval-Village gable roof (`Roof_RoundTiles_WxD`).
 */
export interface HubHouse {
  x0: number
  y0: number
  x1: number
  y1: number
  front: 0 | 1 | 2 | 3
}

/**
 * The village hub layout, shared so `generateHub` (which fills the collision
 * tiles) and the client renderer (which places the tower, houses, roads, and
 * portal meshes) never drift apart. World coords in tiles (1 tile = 1 unit).
 *
 * The village: a gigantic tower dead-center on a cobbled plaza, timber-frame
 * houses fronting the plaza and the main street, a market corner, the spawn
 * just inside the south gate, and the portal on the plaza before the tower.
 * All collision lives in the tiles + solid props; roads are cosmetic but are
 * shared here so the daily scatter keeps off them on every client.
 */
export const HUB_LAYOUT = {
  size: 40,
  /** Solid disc of wall tiles; players can't enter — the portal is the way up. */
  tower: { x: 20, y: 20, radius: 4 },
  /** Cobbled plaza disc around the tower. */
  plazaRadius: 9.5,
  /** Main street: from the plaza rim south to the village gate. */
  street: { x: 20, halfW: 1.6, y1: 37.5 },
  /** Village gate arch across the street, at the south tree line. */
  gate: { x: 20, y: 37 },
  /** Vertical portal + teleport trigger, on the plaza south of the tower. */
  exit: { x: 20, y: 26 },
  /** Spawn, on the main street just inside the gate. */
  start: { x: 20, y: 35 },
  /** Market stall corner on the south-west plaza rim. */
  market: { x: 13.5, y: 26.5 },
  houses: [
    // Two grand plaza-front halls flanking the tower.
    { x0: 5, y0: 16, x1: 10, y1: 21, front: 1 },
    { x0: 29, y0: 16, x1: 34, y1: 21, front: 3 },
    // The north row behind the plaza.
    { x0: 9, y0: 6, x1: 14, y1: 9, front: 2 },
    { x0: 25, y0: 6, x1: 30, y1: 9, front: 2 },
    { x0: 17, y0: 4, x1: 22, y1: 7, front: 2 },
    // Two houses flanking the main street by the gate.
    { x0: 12, y0: 28, x1: 15, y1: 33, front: 1 },
    { x0: 24, y0: 28, x1: 27, y1: 33, front: 3 },
  ] as HubHouse[],
}

function generateHub(daySeed: number): FloorPlan {
  const size = HUB_LAYOUT.size
  const tiles = new Uint8Array(size * size).fill(0)

  // Border wall ring (hidden behind the tree line client-side).
  for (let i = 0; i < size; i++) {
    tiles[i] = 1
    tiles[(size - 1) * size + i] = 1
    tiles[i * size] = 1
    tiles[i * size + size - 1] = 1
  }

  // The gigantic central tower: a solid disc of wall tiles.
  const { tower, houses } = HUB_LAYOUT
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - tower.x, y + 0.5 - tower.y) <= tower.radius) {
        tiles[y * size + x] = 1
      }
    }
  }

  // NOTE: houses are no longer stamped as solid tiles. Once the village is baked
  // (dev prop editor → hub-structure.json), each ground-floor wall piece is a
  // solid prop, so house collision follows the editable pieces. `houses` is still
  // used below to keep the daily scatter off the building footprints.

  // Village core: the cobbled plaza, the main street, the market, and a margin
  // around every house stay tidy — daily scatter only lands in the meadow ring
  // between the buildings and the border tree line.
  const { plazaRadius, street, market } = HUB_LAYOUT
  const inCore = (x: number, y: number) => {
    if (Math.hypot(x - tower.x, y - tower.y) < plazaRadius + 2) return true
    if (Math.abs(x - street.x) < street.halfW + 2 && y > tower.y) return true
    if (Math.hypot(x - market.x, y - market.y) < 4) return true
    return houses.some(h => x > h.x0 - 2 && x < h.x1 + 3 && y > h.y0 - 2 && y < h.y1 + 3)
  }

  // Solid clutter: trees, boulders, and market goods the player actually bumps
  // into. These live in the shared plan (so the server simulates their collision
  // the same way the client predicts it); small greenery stays client-side cosmetic.
  const props: PropSpec[] = []
  const rng = createRng((daySeed ^ 0x5f3a29c1) >>> 0)
  const onOpenTile = (x: number, y: number) => tiles[Math.floor(y) * size + Math.floor(x)] === 0
  const clear = (x: number, y: number, dist: number) => props.every(p => Math.hypot(p.x - x, p.y - y) >= dist)
  const scatter = (kinds: string[], count: number, sMin: number, sMax: number, minDist: number) => {
    for (let placed = 0, tries = 0; placed < count && tries < count * 60; tries++) {
      const x = 2.5 + rng() * (size - 5)
      const y = 2.5 + rng() * (size - 5)
      if (!onOpenTile(x, y) || inCore(x, y) || !clear(x, y, minDist)) continue
      props.push(makeProp(kinds[Math.floor(rng() * kinds.length)]!, x, y, rng() * Math.PI * 2, sMin + rng() * (sMax - sMin)))
      placed++
    }
  }
  scatter(['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'Pine_1', 'Pine_2'], 18, 0.6, 0.95, 3)
  scatter(['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'], 10, 0.6, 1, 2.4)
  // Hand-placed props and baked village pieces come from committed JSON files,
  // appended AFTER the daily scatter so the RNG stream — and thus the meadow
  // layout — is identical no matter what's been placed/baked. `top`/`r` are
  // derived through makeProp so the server simulates collision exactly as the
  // client renders; `z` (elevation) and `s3` (per-axis scale) are render-only
  // extras carried onto the spec. `hub-structure.json` is the exploded village
  // (walls/roofs/etc.); `hub-props.json` is free-standing gameplay clutter.
  const placements = [...hubStructure, ...hubProps] as HubPropPlacement[]
  for (const p of placements) {
    props.push({ ...makeProp(p.kind, p.x, p.y, p.rot, p.scale, p.s3), hand: true, z: p.z, s3: p.s3 })
  }

  return {
    floor: HUB_FLOOR,
    seed: daySeed,
    width: size,
    height: size,
    tiles,
    start: { ...HUB_LAYOUT.start },
    exit: { ...HUB_LAYOUT.exit },
    traps: [],
    // Solid clutter is shared (above); small greenery is client-side cosmetic.
    props,
    biome: -1,
  }
}

/* -------------------------------------------------------------------------- */
/* Labyrinth floors                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Corridor/room width in tiles, and the cell-to-cell stride. Cells are
 * `CELL_TILES × CELL_TILES` blocks separated by 1-tile walls, so every corridor
 * and room is `CELL_TILES` wide. Exported so the client renderer lays its
 * modular walls, arches, and furniture on exactly the same grid the server carves.
 */
export const CELL_TILES = 3
export const CELL_STRIDE = CELL_TILES + 1
/** Tile offset of a cell's centre from its origin (for spawn/exit placement). */
const CELL_CENTER = Math.floor(CELL_TILES / 2) + 1

/** Maze size in cells; grows with depth, up to a grand tower-hall footprint. */
function floorCells(floor: number): number {
  return Math.min(9 + floor * 2, 19)
}

/* -------------------------------------------------------------------------- */
/* Authored floors (hand-built in the dev editor, bundled as JSON)            */
/* -------------------------------------------------------------------------- */

// Lazily indexed so nothing touches `AUTHORED_FLOORS` at module-init time — the
// dev bundler can order this module before `../data/floors` finishes evaluating
// (a type-only import cycle it doesn't always erase), and a top-level
// `AUTHORED_FLOORS.map()` would then throw and take the whole server init down.
const AUTHORED = authoredFloorsData as AuthoredFloorData[]
let authoredIndex: Map<number, AuthoredFloorData> | undefined
function authored(): Map<number, AuthoredFloorData> {
  return (authoredIndex ??= new Map(AUTHORED.map(f => [f.floor, f])))
}

/** Whether `floor` has hand-authored data (vs. the procedural fallback). */
export function isAuthoredFloor(floor: number): boolean {
  return authored().has(floor)
}

/** The deepest authored floor (0 if none) — the bottom of the dungeon. */
export function maxAuthoredFloor(): number {
  let max = 0
  for (const f of AUTHORED) if (f.floor > max) max = f.floor
  return max
}

/** Stable per-floor cosmetic salt (replaces the old day-seeded per-floor seed),
 *  so decorative placement hashing on the client stays deterministic. */
export function floorSalt(floor: number): number {
  return Math.imul(floor + 1, 0x9E3779B1) >>> 0
}

/** Build a runtime `FloorPlan` from authored data. Tiles are just a border ring
 *  (like the hub) — collision comes from each solid placement's footprint.
 *  Exported so the editor can render a floor's working doc live. */
export function planFromAuthored(d: AuthoredFloorData): FloorPlan {
  const size = d.size
  const tiles = new Uint8Array(size * size)
  for (let i = 0; i < size; i++) {
    tiles[i] = 1
    tiles[(size - 1) * size + i] = 1
    tiles[i * size] = 1
    tiles[i * size + size - 1] = 1
  }
  const props: PropSpec[] = d.placements.map(p => ({
    ...makeProp(p.kind, p.x, p.y, p.rot, p.scale, p.s3),
    hand: true,
    z: p.z,
    s3: p.s3,
  }))
  return {
    floor: d.floor,
    seed: floorSalt(d.floor),
    width: size,
    height: size,
    tiles,
    start: { ...d.start },
    exit: { ...d.exit },
    traps: d.traps.map(t => ({ ...t })),
    props,
    biome: d.biome,
  }
}

/**
 * Resolve one floor's plan. The hub and authored floors are loaded from data;
 * everything deeper still falls back to the procedural generator (removed once
 * every floor is authored). Server and client both call this, so they agree.
 */
export function generateFloor(floor: number, seed: number): FloorPlan {
  if (floor === HUB_FLOOR) return generateHub(seed)
  const data = authored().get(floor)
  if (data) return planFromAuthored(data)
  return generateProceduralFloor(floor, seed)
}

/**
 * Generate one labyrinth floor: a recursive-backtracker maze with
 * `CELL_TILES`-wide corridors (cells are square tile blocks separated by 1-tile
 * walls), a few dead ends opened into loops, and timed hazards scaled to depth.
 */
function generateProceduralFloor(floor: number, daySeed: number): FloorPlan {
  const seed = (daySeed ^ Math.imul(floor + 1, 0x9E3779B1)) >>> 0
  const rng = createRng(seed)
  const cells = floorCells(floor)
  const S = CELL_STRIDE
  const C = CELL_TILES
  const size = cells * S + 1
  const tiles = new Uint8Array(size * size).fill(1)

  // Carve a C×C tile block for a cell.
  const carveCell = (cx: number, cy: number) => {
    for (let y = cy * S + 1; y <= cy * S + C; y++) {
      for (let x = cx * S + 1; x <= cx * S + C; x++) tiles[y * size + x] = 0
    }
  }
  // Carve the C-tile-wide passage between two adjacent cells.
  const carvePassage = (cx: number, cy: number, dx: number, dy: number) => {
    if (dx !== 0) {
      const x = dx > 0 ? cx * S + S : cx * S
      for (let y = cy * S + 1; y <= cy * S + C; y++) tiles[y * size + x] = 0
    }
    else {
      const y = dy > 0 ? cy * S + S : cy * S
      for (let x = cx * S + 1; x <= cx * S + C; x++) tiles[y * size + x] = 0
    }
  }

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
  const visited = new Uint8Array(cells * cells)
  const stack: Array<[number, number]> = [[0, 0]]
  visited[0] = 1
  carveCell(0, 0)

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1]!
    const neighbors = DIRS.filter(([dx, dy]) => {
      const nx = cx + dx
      const ny = cy + dy
      return nx >= 0 && ny >= 0 && nx < cells && ny < cells && !visited[ny * cells + nx]
    })

    if (!neighbors.length) {
      stack.pop()
      continue
    }

    const [dx, dy] = neighbors[Math.floor(rng() * neighbors.length)]!
    const nx = cx + dx
    const ny = cy + dy
    visited[ny * cells + nx] = 1
    carvePassage(cx, cy, dx, dy)
    carveCell(nx, ny)
    stack.push([nx, ny])
  }

  // Braiding: open some dead ends into loops so groups can split and merge.
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const openings = DIRS.filter(([dx, dy]) => {
        const wx = dx !== 0 ? (dx > 0 ? cx * S + S : cx * S) : cx * S + 1
        const wy = dy !== 0 ? (dy > 0 ? cy * S + S : cy * S) : cy * S + 1
        return tiles[wy * size + wx] === 0
      })
      if (openings.length !== 1 || rng() >= 0.3) continue
      const candidates = DIRS.filter(([dx, dy]) => {
        const nx = cx + dx
        const ny = cy + dy
        return nx >= 0 && ny >= 0 && nx < cells && ny < cells
          && !openings.some(([ox, oy]) => ox === dx && oy === dy)
      })
      const pick = candidates[Math.floor(rng() * candidates.length)]
      if (pick) carvePassage(cx, cy, pick[0], pick[1])
    }
  }

  const start = { x: CELL_CENTER, y: CELL_CENTER }
  const exit = { x: (cells - 1) * S + CELL_CENTER, y: (cells - 1) * S + CELL_CENTER }

  // Timed hazards: denser and tighter with depth, never near start or exit.
  const traps: Trap[] = []
  const trapCount = Math.min(3 + floor * 2, 26)
  const period = Math.max(2.2, 4 - floor * 0.12)
  const duration = Math.min(1.5, 0.7 + floor * 0.06)
  for (let i = 0; i < 400 && traps.length < trapCount; i++) {
    const tx = 1 + Math.floor(rng() * (size - 2))
    const ty = 1 + Math.floor(rng() * (size - 2))
    if (tiles[ty * size + tx] !== 0) continue
    if (Math.hypot(tx + 0.5 - start.x, ty + 0.5 - start.y) < 5) continue
    if (Math.hypot(tx + 0.5 - exit.x, ty + 0.5 - exit.y) < 5) continue
    if (traps.some(t => Math.hypot(t.x - tx - 0.5, t.y - ty - 0.5) < 2)) continue
    traps.push({ x: tx + 0.5, y: ty + 0.5, period, duration, phase: rng() * period })
  }

  // Biome-flavored clutter; solid pieces double as platforms to jump onto.
  const biome = biomeIndex(floor)
  const SCATTER: string[][] = [
    ['Bricks', 'Skull', 'Pot1_Broken', 'Column_Round_Short', 'Candles_1', 'Crate', 'Crate_Wooden', 'Chest_Wood'],
    ['Pot2_Broken', 'Barrel', 'Skull', 'Pot1_Broken', 'Crate', 'Crate_Wooden'],
    ['Bush_1x1', 'Bush_Round', 'Grass', 'Bush_1x1', 'Grass', 'Crate'],
    ['Skull', 'Bricks', 'DeadTree_1', 'Column_Round_Short', 'Barrel', 'Chest_Wood'],
  ]
  const options = SCATTER[biome]!
  const props: PropSpec[] = []
  // Scale the clutter to the floor size but keep it sparse and well-spaced.
  const propCap = Math.min(26, Math.round(cells * cells * 0.18))
  for (let i = 0; i < 500 && props.length < propCap; i++) {
    const tx = 1 + Math.floor(rng() * (size - 2))
    const ty = 1 + Math.floor(rng() * (size - 2))
    if (tiles[ty * size + tx] !== 0) continue
    const px = tx + 0.5 + (rng() - 0.5) * 0.5
    const py = ty + 0.5 + (rng() - 0.5) * 0.5
    if (Math.hypot(px - start.x, py - start.y) < 4) continue
    if (Math.hypot(px - exit.x, py - exit.y) < 4) continue
    if (traps.some(t => Math.hypot(t.x - px, t.y - py) < 1.4)) continue
    if (props.some(p => Math.hypot(p.x - px, p.y - py) < 1.8)) continue
    const kind = options[Math.floor(rng() * options.length)]!
    props.push(makeProp(kind, px, py, rng() * Math.PI * 2, 0.7 + rng() * 0.45))
  }

  return { floor, seed, width: size, height: size, tiles, start, exit, traps, props, biome }
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
 * A display-only wall grid for the minimap/spectator/fog: the tile grid plus
 * every wall-height solid prop rasterized in (round kinds as discs, oriented
 * kinds as rotated rects). Deterministic and cheap — computed per floor on the
 * client, never read by the server. Lets free-placed architecture (the hub's
 * buildings, an authored floor's walls) actually show up on the map, which
 * reading raw `tiles` (mostly open) would not.
 */
const DISPLAY_WALL_TOP = 1.2
export function occupancyGrid(plan: FloorPlan): Uint8Array {
  const { width, height } = plan
  const grid = plan.tiles.slice()
  for (const prop of plan.props) {
    if (prop.top < DISPLAY_WALL_TOP) continue
    const minX = Math.max(0, Math.floor(prop.x - prop.r))
    const maxX = Math.min(width - 1, Math.ceil(prop.x + prop.r))
    const minY = Math.max(0, Math.floor(prop.y - prop.r))
    const maxY = Math.min(height - 1, Math.ceil(prop.y + prop.r))
    const boxed = prop.bx != null && prop.by != null
    const c = Math.cos(prop.rot)
    const s = Math.sin(prop.rot)
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const dx = tx + 0.5 - prop.x
        const dy = ty + 0.5 - prop.y
        if (boxed) {
          const lx = dx * c + dy * s
          const ly = -dx * s + dy * c
          if (Math.abs(lx) > prop.bx! || Math.abs(ly) > prop.by!) continue
        }
        else if (Math.hypot(dx, dy) > prop.r) {
          continue
        }
        grid[ty * width + tx] = 1
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
