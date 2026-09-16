// Build plans for the load-test bots (`scripts/spawn-bots.mjs`).
//
// Everything here is pure: a plot index in, a list of edit ops out. The bot
// script owns the socket, the rate limit and the rejects; this module only
// knows the geometry of the build kit.
//
// Poses are chosen so the server accepts them unchanged. `snapPlacement` puts
// kit pieces on `BUILD_GRID` (2 tiles) at quarter turns, so every wall/floor/
// roof centre here is an even tile and every rotation a multiple of PI/2; the
// small pieces (`Kit_Crate`, `Kit_Torch`) snap to `BUILD_GRID_SMALL` (1) and so
// sit on integer tiles. Two grid neighbours share an edge exactly, which
// `overlappingPiece`'s epsilon lets through, so a wall run tiles without
// refusals.
//
// The vertical story is `resolveBuild`'s: a piece's `z` is `supportHeight`, the
// tallest surface under its footprint (centre plus the four AABB corners). That
// is why the second storey works without asking for a height — a wall placed on
// the pose of a wall below reads that wall's top and stacks on it.
//
// `Kit_WallDoor`, `Kit_Gate`, `Kit_Path` and `Kit_Torch` are absent from
// `SOLID_PROPS` on purpose (their openings stay walkable), so they neither
// block nor support. Nothing is ever stacked on the door pose for that reason:
// a piece there would read the terrain instead and land back on the ground,
// across the doorway.

import { SURFACE } from '../shared/utils/world.ts'

const H = Math.PI / 2

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
  return { op: 'build', kind: 'Kit_Deed', x: plot.x - 1, y: plot.y - 1, rot: 0 }
}

/** The plot's outer square, in tiles: the walls run on [x, x+4]. */
export function plotBounds(plot) {
  return { minX: plot.x - 2, maxX: plot.x + 6, minY: plot.y - 2, maxY: plot.y + 6 }
}

/** Where the bot stands while it builds — inside the ring, so every pose is
 *  well inside `EDIT_REACH` even when the server's idea of its position is a
 *  tile off ours. */
export function plotCentre(plot) {
  return { x: plot.x + 2, y: plot.y + 2 }
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
    for (const dy of [0, 2, 4]) {
      for (const dx of [0, 2, 4]) {
        ops.push({ op: 'terraform', mode: 'flatten', size: 3, x: plot.x + dx, y: plot.y + dy })
      }
    }
  }
  return ops
}

/** The eight ring poses of a 4×4 house, door pose first. `solid` marks the
 *  seven that carry weight; the door pose carries nothing. */
const RING = [
  { dx: 2, dy: 0, rot: 0, door: true },
  { dx: 0, dy: 0, rot: 0 },
  { dx: 4, dy: 0, rot: 0 },
  { dx: 0, dy: 4, rot: 0 },
  { dx: 2, dy: 4, rot: 0 },
  { dx: 4, dy: 4, rot: 0 },
  { dx: 0, dy: 2, rot: H },
  { dx: 4, dy: 2, rot: H },
]
const SOLID_RING = RING.filter(p => !p.door)
const CORNERS = new Set(['0,0', '4,0', '0,4', '4,4'])

const build = (plot, kind, dx, dy, rot = 0) => ({ op: 'build', kind, x: plot.x + dx, y: plot.y + dy, rot })

/**
 * A two-storey cottage: a walled ring with a door facing the road, a slab
 * inside, a deck of floors on top of the ground-floor walls, a second ring of
 * walls on that deck, and a roof over it. Then a torch by the door, crates
 * inside and a path slab pointing back at the road.
 */
export function housePlan(plot) {
  const ops = []
  // Ground floor. Windows on the far side, a door facing the town.
  for (const p of RING) {
    const kind = p.door
      ? 'Kit_WallDoor'
      : (p.dy === 4 && p.dx !== 2) || (p.dx === 0 && p.dy === 2) ? 'Kit_WallWindow' : 'Kit_Wall'
    ops.push(build(plot, kind, p.dx, p.dy, p.rot))
  }
  ops.push(build(plot, 'Kit_Floor', 2, 2))
  // The upper deck: each slab reads the wall below it as its support, so the
  // storey above lands at wall top + slab thickness.
  for (const p of SOLID_RING) ops.push(build(plot, 'Kit_Floor', p.dx, p.dy))
  // Second storey, on the deck. The door pose is skipped so the opening stays
  // open all the way up.
  for (const p of SOLID_RING) {
    ops.push(build(plot, p.dx === 2 ? 'Kit_WallWindow' : 'Kit_Wall', p.dx, p.dy, p.rot))
  }
  // Roof. Corner pieces on the corners, straight ones on the runs.
  for (const p of SOLID_RING) {
    ops.push(build(plot, CORNERS.has(`${p.dx},${p.dy}`) ? 'Kit_RoofCorner' : 'Kit_Roof', p.dx, p.dy, p.rot))
  }
  // Dressing. Torch and crates snap to the 1-tile grid, so odd tiles are theirs.
  ops.push(build(plot, 'Kit_Torch', 1, -1))
  ops.push(build(plot, 'Kit_Torch', 3, -1))
  ops.push(build(plot, 'Kit_Crate', 1, 1))
  ops.push(build(plot, 'Kit_Crate', 3, 3))
  ops.push(build(plot, 'Kit_Path', 2, -2))
  return ops
}

/** The other kind of bot: a fenced paddock with a gate, a couple of crates and
 *  a torch. Fences and gates are 1 tall and never stack, so this is one ring. */
export function fencePlan(plot) {
  const ops = []
  for (const p of RING) {
    ops.push(build(plot, p.door ? 'Kit_Gate' : 'Kit_Fence', p.dx, p.dy, p.rot))
  }
  ops.push(build(plot, 'Kit_Torch', 1, -1))
  ops.push(build(plot, 'Kit_Crate', 1, 1))
  ops.push(build(plot, 'Kit_Crate', 2, 1))
  ops.push(build(plot, 'Kit_Crate', 3, 3))
  ops.push(build(plot, 'Kit_Path', 2, -2))
  return ops
}

/** Paint the tile the bot is standing on as paving. Used while it walks the
 *  line back to the gate road, so the path is laid within reach by
 *  construction. */
export function paveOp(x, y) {
  return { op: 'terraform', mode: 'paint', size: 2, surface: SURFACE.path, x: Math.round(x), y: Math.round(y) }
}
