// Build plans for the load-test bots (`scripts/spawn-bots.mjs`).
//
// Everything here is pure: a plot index in, a list of edit ops out. The bot
// script owns the socket, the rate limit and the rejects; this module only
// knows the geometry of the build kit.
//
// Poses are chosen so the server accepts them unchanged. `snapPlacement` puts
// CELL pieces (floors, roofs, stairs, paths, crates) on the centre of a
// `BUILD_GRID` cell — an even tile for the 2-unit grid, any integer for the
// 1-unit one — and EDGE pieces (walls, fences, gates) on the nearest cell edge,
// which is a half-grid line: one coordinate even, the other odd. A panel's
// rotation comes from its edge, so the `rot` passed here only flips which way
// it faces. Two grid neighbours share an edge exactly, which
// `overlappingPiece`'s epsilon lets through, so a wall run tiles without
// refusals.
//
// The vertical story is `resolveBuild`'s: a piece's `z` is `supportHeight`, the
// tallest surface under its footprint (centre plus the four AABB corners),
// bounded by the aim height the request carries. Every build op here names the
// storey it belongs to as `lift`, its intended `z` above the levelled ground,
// and the bot turns that into the request's `h`. Without it a piece rebuilt
// after a demolish reads the roof over its own slot and climbs; with it a torn
// down ground-floor wall goes back where it was.
//
// `Kit_WallDoor`, `Kit_Gate`, `Kit_Path` and `Kit_Torch` are absent from
// `SOLID_PROPS` on purpose (their openings stay walkable), so they neither
// block nor support. Nothing is ever stacked on the door pose for that reason:
// a piece there would read the terrain instead and land back on the ground,
// across the doorway.

import { SURFACE } from '../shared/utils/world.ts'

/**
 * Where bot `i` builds. An 18-tile lattice in the meadow south of the gate.
 *
 * Both numbers are set by the deed rather than by the house. The pitch is 18
 * because a claim is `DEED_SIZE` (16) tiles across, and two bots any closer
 * would be refused each other's ground — the load test would then measure the
 * refusal path instead of the build path. The first row is at y 150 because the
 * claim reaches seven tiles back from the post, and the protected footprint
 * ends with the road's last tile at y 139.
 */
export function plotFor(i) {
  const col = i % 6
  const row = Math.floor(i / 6)
  return { x: 52 + col * 18, y: 150 + row * 18 }
}

/**
 * The claim post, planted a tile off the plot's near corner.
 *
 * Off the corner rather than in the middle because a deed is solid: inside the
 * ring it would stand where the floor slab goes. It is still inside
 * `plotBounds`, so `blockingWild` clears the ground for it, and within reach of
 * `plotCentre`, where the bot stands to build.
 *
 * It goes in after the levelling and before the first wall: `pieceOverBrush`
 * refuses a terraform under any piece, so a post planted first would refuse
 * every flatten that follows it.
 */
export function deedOp(plot) {
  return { op: 'build', kind: 'Kit_Deed', x: plot.x - 2, y: plot.y - 2, rot: 0, lift: 0 }
}

/**
 * The plot's outer square, in tiles.
 *
 * The house is a 2×2 block of grid cells centred on `plot` and `plot + 2`, so
 * its slabs cover [x-1, x+3] and its walls sit on those edges. The square below
 * adds a tile of margin all round, plus the path cell that reaches back toward
 * the road.
 */
export function plotBounds(plot) {
  return { minX: plot.x - 3, maxX: plot.x + 5, minY: plot.y - 5, maxY: plot.y + 5 }
}

/** Where the bot stands while it builds — in the middle of the room, so every
 *  pose is well inside `EDIT_REACH` even when the server's idea of its position
 *  is a tile off ours. */
export function plotCentre(plot) {
  return { x: plot.x + 1, y: plot.y + 1 }
}

/**
 * Flatten the plot before anything is placed. `applyTerrain` moves a corner by
 * one `TERRAFORM_STEP` per request even for a flatten (the server passes
 * `maxStep`), so this converges rather than levelling in one call — hence the
 * rounds. A brush of 3 centred on each even tile covers every corner the walls
 * will stand on.
 */
export function levelPlan(plot, rounds = 3) {
  const ops = []
  for (let r = 0; r < rounds; r++) {
    for (const dy of [-2, 1, 4]) {
      for (const dx of [-2, 1, 4]) {
        ops.push({ op: 'terraform', mode: 'flatten', size: 3, x: plot.x + dx, y: plot.y + dy })
      }
    }
  }
  return ops
}

/**
 * The room: four grid cells, and the eight edges around them.
 *
 * The cells are the floor and the roof; the edges are the walls. A cell centre
 * is `plot + (0 or 2)` on each axis, so the room covers [x-1, x+3] and its
 * perimeter edges are the half-grid lines on either side of it. The door takes
 * the first south edge, which faces the road.
 */
const CELLS = [
  { dx: 0, dy: 0 },
  { dx: 2, dy: 0 },
  { dx: 0, dy: 2 },
  { dx: 2, dy: 2 },
]

const EDGES = [
  { dx: 0, dy: -1, door: true },
  { dx: 2, dy: -1 },
  { dx: 0, dy: 3 },
  { dx: 2, dy: 3 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: 2 },
  { dx: 3, dy: 0 },
  { dx: 3, dy: 2 },
]
const SOLID_EDGES = EDGES.filter(p => !p.door)
/** The two cells a roof corner sits on: the ones with two outside walls that
 *  meet. Every cell of a 2×2 room is a corner, so this picks the diagonal. */
const ROOF_CORNERS = new Set(['0,0', '2,2'])

/** Storey heights, in the kit's own units: a slab on the ground, walls on the
 *  slab, the next slab on those walls, and so on. */
const FLOOR = 0.2
const WALL = 2.5
/** `z` of the ground floor's walls, of the upper deck, of its walls, of the
 *  roof — each one above the levelled ground the plot was flattened to. */
export const LIFT = {
  ground: 0,
  groundWall: FLOOR,
  upperFloor: FLOOR + WALL,
  upperWall: FLOOR + WALL + FLOOR,
  roof: FLOOR + WALL + FLOOR + WALL,
}

const build = (plot, kind, dx, dy, rot = 0, lift = 0) => ({ op: 'build', kind, x: plot.x + dx, y: plot.y + dy, rot, lift })

/**
 * A two-storey cottage: a floor of slabs, a ring of walls closing its edges
 * with a door facing the road, a second deck on top of those walls, a second
 * ring of walls on it, and a roof over the lot. Then a torch by the door,
 * crates inside and a path slab pointing back at the road.
 *
 * Order matters. The slabs go down first so the walls read their tops as
 * support and stand ON the floor rather than lifting it; a wall placed first
 * would put the slab a storey up.
 */
export function housePlan(plot) {
  const ops = []
  for (const c of CELLS) ops.push(build(plot, 'Kit_Floor', c.dx, c.dy, 0, LIFT.ground))
  // Ground floor. Windows on the far side, a door facing the town.
  for (const p of EDGES) {
    const kind = p.door
      ? 'Kit_WallDoor'
      : p.dy === 3 || (p.dx === -1 && p.dy === 0) ? 'Kit_WallWindow' : 'Kit_Wall'
    ops.push(build(plot, kind, p.dx, p.dy, 0, LIFT.groundWall))
  }
  // Crates sit on the ground floor's slab, and say so: the aim height is what
  // keeps them downstairs once there is a deck over their heads.
  ops.push(build(plot, 'Kit_Crate', 0, 1, 0, LIFT.groundWall))
  ops.push(build(plot, 'Kit_Crate', 2, 2, 0, LIFT.groundWall))
  // The upper deck: each slab reads the walls below it as its support, so the
  // storey above lands at wall top + slab thickness.
  for (const c of CELLS) ops.push(build(plot, 'Kit_Floor', c.dx, c.dy, 0, LIFT.upperFloor))
  // Second storey, on the deck. The door pose is skipped so the opening stays
  // open all the way up.
  for (const p of SOLID_EDGES) {
    ops.push(build(plot, p.dx === 2 && p.dy === -1 ? 'Kit_WallWindow' : 'Kit_Wall', p.dx, p.dy, 0, LIFT.upperWall))
  }
  // Roof. Corner pieces on the diagonal, straight ones on the rest.
  for (const c of CELLS) {
    ops.push(build(plot, ROOF_CORNERS.has(`${c.dx},${c.dy}`) ? 'Kit_RoofCorner' : 'Kit_Roof', c.dx, c.dy, 0, LIFT.roof))
  }
  // Dressing. The torches snap to the 1-tile grid, so any integer tile is
  // theirs.
  ops.push(build(plot, 'Kit_Torch', -1, -2, 0, LIFT.ground))
  ops.push(build(plot, 'Kit_Torch', 1, -2, 0, LIFT.ground))
  ops.push(build(plot, 'Kit_Path', 0, -2, 0, LIFT.ground))
  return ops
}

/** The other kind of bot: a fenced paddock with a gate, a couple of crates and
 *  a torch. Fences and gates are 1 tall and never stack, so this is one ring —
 *  and with no floor under it, straight on the ground. */
export function fencePlan(plot) {
  const ops = []
  for (const p of EDGES) {
    ops.push(build(plot, p.door ? 'Kit_Gate' : 'Kit_Fence', p.dx, p.dy))
  }
  ops.push(build(plot, 'Kit_Torch', -1, -2))
  ops.push(build(plot, 'Kit_Crate', 0, 1))
  ops.push(build(plot, 'Kit_Crate', 1, 1))
  ops.push(build(plot, 'Kit_Crate', 2, 2))
  ops.push(build(plot, 'Kit_Path', 0, -2))
  return ops
}

export function paveOp(x, y) {
  return { op: 'terraform', mode: 'paint', size: 2, surface: SURFACE.path, x: Math.round(x), y: Math.round(y) }
}
