// Generate a real dungeon-labyrinth for Floor 1 and bake it into
// shared/data/floors.json. A recursive-backtracker maze is rendered as
// Dungeon_Wall_Modular panels (2 units wide) on a cell grid, with timed spike
// traps in the corridors, wall torches for light, and a couple of reward chests
// in dead ends. Deterministic (seeded) so the bake is reproducible.
//
//   node scripts/make_floor.mjs
//
// Collision comes from each wall panel's box footprint (SOLID_PROPS in
// shared/utils/maze.ts), so the server + client agree; the floor's border ring
// (planFromAuthored) closes the outer edge.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- Deterministic PRNG (mulberry32) ---
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a += 0x6D2B79F5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260711)
const pick = arr => arr[Math.floor(rand() * arr.length)]

// --- Maze parameters ---
const CELLS = 9 // maze is CELLS×CELLS cells
const PITCH = 4 // world units per cell → ~3.5-unit corridors
const OFF = 3 // margin from the floor edge
const SIZE = OFF * 2 + CELLS * PITCH + 1 // floor grid extent (43)
const round = n => Math.round(n * 100) / 100

// Dungeon_Wall_Modular is ~2.01 units tall, but the dungeon ceiling sits at
// WALL_HEIGHT (3.8) in MazeScene — so panels at scale 1 stop well short of it.
// Stretch every wall vertically (Y only, via s3) so it rises from the floor to
// just past the ceiling; sx/sz stay 1, so the collision footprint is unchanged
// (makeProp derives bx/by from sx/sz, top from sy). Keep CEIL in sync with
// WALL_HEIGHT in app/components/MazeScene.vue.
const CEIL = 3.8
const PANEL_H = 2.01
const WALL_SY = round((CEIL + 0.1) / PANEL_H)

// Wall presence on each cell's south (h) and east (v) edge; perimeter always walled.
const h = Array.from({ length: CELLS }, () => Array.from({ length: CELLS + 1 }, () => true)) // h[cx][cy] south edge of row cy
const v = Array.from({ length: CELLS + 1 }, () => Array.from({ length: CELLS }, () => true)) // v[cx][cy] east edge of col cx
const visited = Array.from({ length: CELLS }, () => Array.from({ length: CELLS }, () => false))

// --- Recursive backtracker ---
const stack = [[0, 0]]
visited[0][0] = true
while (stack.length) {
  const [cx, cy] = stack[stack.length - 1]
  const nbrs = [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']].filter(([dx, dy]) => {
    const nx = cx + dx
    const ny = cy + dy
    return nx >= 0 && ny >= 0 && nx < CELLS && ny < CELLS && !visited[nx][ny]
  })
  if (!nbrs.length) {
    stack.pop()
    continue
  }
  const [dx, dy] = pick(nbrs)
  const nx = cx + dx
  const ny = cy + dy
  // Remove the wall between (cx,cy) and (nx,ny).
  if (dx === 1) v[cx + 1][cy] = false
  else if (dx === -1) v[cx][cy] = false
  else if (dy === 1) h[cx][cy + 1] = false
  else h[cx][cy] = false
  visited[nx][ny] = true
  stack.push([nx, ny])
}

// --- Braiding: open ~18% of dead ends so it isn't a pure single-solution maze ---
for (let cx = 0; cx < CELLS; cx++) {
  for (let cy = 0; cy < CELLS; cy++) {
    const walls = []
    if (h[cx][cy]) walls.push('N')
    if (v[cx + 1][cy]) walls.push('E')
    if (h[cx][cy + 1]) walls.push('S')
    if (v[cx][cy]) walls.push('W')
    if (walls.length === 3 && rand() < 0.18) {
      // A dead end (3 walls) — knock one interior wall through.
      const opts = []
      if (h[cx][cy] && cy > 0) opts.push('N')
      if (v[cx + 1][cy] && cx < CELLS - 1) opts.push('E')
      if (h[cx][cy + 1] && cy < CELLS - 1) opts.push('S')
      if (v[cx][cy] && cx > 0) opts.push('W')
      const o = pick(opts)
      if (o === 'N') h[cx][cy] = false
      else if (o === 'S') h[cx][cy + 1] = false
      else if (o === 'E') v[cx + 1][cy] = false
      else if (o === 'W') v[cx][cy] = false
    }
  }
}

// --- Emit wall panels along every remaining wall edge (perimeter included) ---
const placements = []
const wall = (x, y, rot) => placements.push({ kind: 'Dungeon_Wall_Modular', x: round(x), y: round(y), rot, scale: 1, s3: [1, WALL_SY, 1] })
// Two 2-wide panels fill each PITCH(4)-unit edge.
const panelOffsets = [1, 3]

// Horizontal edges (run along X): rows cy = 0..CELLS (top & bottom are perimeter).
for (let cy = 0; cy <= CELLS; cy++) {
  for (let cx = 0; cx < CELLS; cx++) {
    if (!h[cx][cy]) continue
    const y = OFF + cy * PITCH
    for (const o of panelOffsets) wall(OFF + cx * PITCH + o, y, 0)
  }
}
// Vertical edges (run along Y): cols cx = 0..CELLS (left & right are perimeter).
for (let cx = 0; cx <= CELLS; cx++) {
  for (let cy = 0; cy < CELLS; cy++) {
    if (!v[cx][cy]) continue
    const x = OFF + cx * PITCH
    for (const o of panelOffsets) wall(x, OFF + cy * PITCH + o, Math.PI / 2)
  }
}

// --- Cell centres (for traps, decor, start/exit) ---
const cellCenter = (cx, cy) => ({ x: OFF + cx * PITCH + PITCH / 2, y: OFF + cy * PITCH + PITCH / 2 })
const start = cellCenter(0, 0)
const exit = cellCenter(CELLS - 1, CELLS - 1)

// --- Torches: on some wall panels, for atmosphere/light ---
const torchEvery = 6
placements.filter(p => p.kind === 'Dungeon_Wall_Modular').forEach((p, i) => {
  if (i % torchEvery === 0) placements.push({ kind: 'Dungeon_Torch', x: p.x, y: p.y, rot: p.rot, scale: 1 })
})

// --- Reward chests in a few dead-end cells ---
let chests = 0
for (let cx = 0; cx < CELLS && chests < 3; cx++) {
  for (let cy = 0; cy < CELLS && chests < 3; cy++) {
    const w = (h[cx][cy] ? 1 : 0) + (v[cx + 1][cy] ? 1 : 0) + (h[cx][cy + 1] ? 1 : 0) + (v[cx][cy] ? 1 : 0)
    const isEnd = w === 3 && !(cx === 0 && cy === 0) && !(cx === CELLS - 1 && cy === CELLS - 1)
    if (isEnd && rand() < 0.5) {
      const c = cellCenter(cx, cy)
      placements.push({ kind: pick(['Dungeon_Chest', 'Dungeon_Chest_Gold']), x: round(c.x), y: round(c.y), rot: rand() * 6.28, scale: 1 })
      chests++
    }
  }
}

// --- Timed spike traps in corridor cells, away from start/exit ---
const traps = []
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < PITCH * 1.5
for (let tries = 0; tries < 400 && traps.length < 14; tries++) {
  const cx = Math.floor(rand() * CELLS)
  const cy = Math.floor(rand() * CELLS)
  const c = cellCenter(cx, cy)
  if (near(c, start) || near(c, exit)) continue
  if (traps.some(t => Math.hypot(t.x - c.x, t.y - c.y) < PITCH)) continue
  traps.push({
    x: round(c.x),
    y: round(c.y),
    period: round(2.6 + rand() * 1.4),
    duration: round(0.9 + rand() * 0.5),
    phase: round(rand() * 3),
  })
}

const floor1 = {
  version: 1,
  floor: 1,
  size: SIZE,
  biome: 0,
  start: { x: round(start.x), y: round(start.y) },
  exit: { x: round(exit.x), y: round(exit.y) },
  traps,
  placements,
}

writeFileSync(join(ROOT, 'shared/data/floors.json'), `${JSON.stringify([floor1], null, 2)}\n`)
console.log(`floor 1: ${SIZE}×${SIZE}, ${placements.length} placements (${placements.filter(p => p.kind === 'Dungeon_Wall_Modular').length} walls), ${traps.length} traps, ${chests} chests`)
