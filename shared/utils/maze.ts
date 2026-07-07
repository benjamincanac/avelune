/**
 * Mugen's world: a hub plaza and an endless tower of labyrinth floors,
 * all generated deterministically.
 *
 * Both the server (collision, hazards, win detection) and the client
 * (rendering, prediction, spectator maps) build the exact same floors
 * locally, so no geometry ever travels over the WebSocket — only players.
 *
 * The day seed is derived from the current UTC date: the tower is the same
 * world for every player and every function instance all day, survives
 * instance recycling, and becomes a brand-new tower at midnight UTC. Each
 * floor's layout is seeded by (day seed, floor index), so any client can
 * regenerate any floor on demand.
 */

/** How far players move, in tiles per second (biome modifiers apply). */
export const PLAYER_SPEED = 3.2
/** Collision radius of a player, in tiles (corridors are 2 tiles wide). */
export const PLAYER_RADIUS = 0.3

/** Floor 0 is the hub plaza; floors 1.. are the labyrinth. */
export const HUB_FLOOR = 0
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
  /** Footprint radius for the walkable surface. */
  r: number
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
 * Per-kind walkable surface: [top height at scale 1, footprint radius at scale 1].
 * A tall `top` (above jump height) makes a prop an unjumpable blocker; a low one
 * is a ledge you can hop onto. `r` is the circular collision footprint.
 */
const SOLID_PROPS: Record<string, [number, number]> = {
  Crate: [0.8, 0.5],
  Barrel: [1.05, 0.42],
  Chest: [0.88, 0.55],
  Bricks: [0.5, 0.75],
  // Fantasy-kit furniture that doubles as a low platform to hop onto.
  Crate_Wooden: [1.1, 0.55],
  Chest_Wood: [0.68, 0.55],
  // Hub nature/village obstacles: trees and boulders block like walls; the
  // crate/wagon are lower so they read as clutter you can vault with a jump.
  CommonTree_1: [3, 0.6],
  CommonTree_2: [3, 0.6],
  CommonTree_3: [3, 0.6],
  Pine_1: [3, 0.6],
  Pine_2: [3, 0.6],
  Rock_Medium_1: [1.8, 0.9],
  Rock_Medium_2: [1.8, 0.85],
  Rock_Medium_3: [1.8, 0.95],
  Prop_Crate: [0.9, 0.55],
  Prop_Wagon: [1.2, 1.05],
}

function makeProp(kind: string, x: number, y: number, rot: number, scale: number): PropSpec {
  const solid = SOLID_PROPS[kind]
  return {
    kind,
    x,
    y,
    rot,
    scale,
    top: solid ? solid[0] * scale : 0,
    r: solid ? solid[1] * scale : 0,
  }
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

/** Today's day seed, as a YYYYMMDD number in UTC. */
export function dateSeed(date: Date = new Date()): number {
  return Number(date.toISOString().slice(0, 10).replaceAll('-', ''))
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

/** A house footprint, as an inclusive tile rectangle. */
export interface HubHouse {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The nature-village hub layout, shared so `generateHub` (which fills the
 * collision tiles) and the client renderer (which places the tower, houses,
 * and portal meshes) never drift apart. World coords in tiles (1 tile = 1 unit).
 *
 * The plaza is an open grassy square: a gigantic solid tower at the back, a
 * few houses framing the sides, the spawn at the south edge, and the vertical
 * teleport portal at the tower's south base. All collision lives in the tiles.
 */
export const HUB_LAYOUT = {
  size: 32,
  /** Solid disc of wall tiles; players can't enter — the portal is the way up. */
  tower: { x: 16, y: 10, radius: 3.5 },
  /** Vertical portal + teleport trigger, just south of the tower base. */
  exit: { x: 16, y: 15 },
  /** Spawn, at the south edge of the plaza. */
  start: { x: 16, y: 27 },
  houses: [
    { x0: 4, y0: 7, x1: 7, y1: 10 },
    { x0: 24, y0: 7, x1: 27, y1: 10 },
    { x0: 4, y0: 21, x1: 7, y1: 24 },
    { x0: 24, y0: 21, x1: 27, y1: 24 },
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

  // A few houses framing the plaza — each a solid rectangular footprint.
  for (const h of houses) {
    for (let y = h.y0; y <= h.y1; y++) {
      for (let x = h.x0; x <= h.x1; x++) tiles[y * size + x] = 1
    }
  }

  // Solid clutter: trees, boulders, and crates the player actually bumps into.
  // These live in the shared plan (so the server simulates their collision the
  // same way the client predicts it); small greenery stays client-side cosmetic.
  const props: PropSpec[] = []
  const rng = createRng((daySeed ^ 0x5f3a29c1) >>> 0)
  const onOpenTile = (x: number, y: number) => tiles[Math.floor(y) * size + Math.floor(x)] === 0
  // Keep the spawn→portal lane down the middle clear.
  const inLane = (x: number, y: number) => x > 13 && x < 19 && y > HUB_LAYOUT.exit.y - 2
  const clear = (x: number, y: number, dist: number) => props.every(p => Math.hypot(p.x - x, p.y - y) >= dist)
  const scatter = (kinds: string[], count: number, sMin: number, sMax: number, minDist: number) => {
    for (let placed = 0, tries = 0; placed < count && tries < count * 60; tries++) {
      const x = 2.5 + rng() * (size - 5)
      const y = 2.5 + rng() * (size - 5)
      if (!onOpenTile(x, y) || inLane(x, y) || !clear(x, y, minDist)) continue
      props.push(makeProp(kinds[Math.floor(rng() * kinds.length)]!, x, y, rng() * Math.PI * 2, sMin + rng() * (sMax - sMin)))
      placed++
    }
  }
  scatter(['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'Pine_1', 'Pine_2'], 12, 0.6, 0.95, 3)
  scatter(['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'], 8, 0.6, 1, 2.4)
  // A little market corner near the front-right house.
  props.push(makeProp('Prop_Wagon', 11, 21.5, 0.5, 1))
  props.push(makeProp('Prop_Crate', 20.4, 20, 0.3, 1))
  props.push(makeProp('Prop_Crate', 21, 20.7, 1.1, 0.85))

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

/**
 * Generate one labyrinth floor: a recursive-backtracker maze with
 * `CELL_TILES`-wide corridors (cells are square tile blocks separated by 1-tile
 * walls), a few dead ends opened into loops, and timed hazards scaled to depth.
 */
export function generateFloor(floor: number, daySeed: number): FloorPlan {
  if (floor === HUB_FLOOR) return generateHub(daySeed)

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
    if (Math.hypot(prop.x - x, prop.y - y) <= prop.r) top = prop.top
  }
  return top
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
