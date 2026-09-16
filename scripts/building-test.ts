// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/building-test.ts
//
// Elevation semantics for everything that is not a hand-authored town piece:
// a placement's `z` is the base of its collision band, and the band is what
// decides whether a body walks under a piece, into it, or onto it.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { PLAYER_SPEED, hitsRaisedPiece, stepBody, surfaceHeight, terrainHeight } from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import { DEED_SIZE, checkDemolish, checkTerraform, deedAt, overlappingPiece, plotBounds, plotOwner, refusalText, resolveBuild, snapGridFor, supportHeight } from '../shared/utils/building'
import { propFromPlacement } from '../shared/utils/props'
import { KIT_ASSETS } from '../shared/utils/kit'
import { generateVegetation } from '../shared/utils/vegetation'
import { CHUNK_SIZE, applyPlace, applyRemove, createWorld } from '../shared/utils/world'
import type { World } from '../shared/utils/world'
import { worldTerrainHeight } from '../shared/utils/terrain'
import { FORTIFICATIONS } from '../shared/utils/courtyard'
import { MOAT_STAIRS } from '../shared/utils/moat'

const dt = 1 / 20
const bodyAt = (x: number, y: number, z = 0): KinematicBody => ({ x, y, z, vz: 0, grounded: true })

function walk(world: World, body: KinematicBody, dx: number, dy: number, steps = 120) {
  for (let i = 0; i < steps; i++) stepBody(world, body, dx * PLAYER_SPEED * dt, dy * PLAYER_SPEED * dt, dt)
  return body
}

function settle(world: World, x: number, y: number, z: number) {
  const body = bodyAt(x, y, z)
  body.grounded = false
  for (let i = 0; i < 400; i++) stepBody(world, body, 0, 0, 1 / 60)
  return body
}

/** A whole chunk flattened to zero, so a test house stands on known ground. */
function levelChunk(world: World, cx: number, cy: number) {
  const chunk = world.getChunk(cx, cy)!
  chunk.heights.fill(0)
  chunk.version++
  return { x: cx * CHUNK_SIZE + 16, y: cy * CHUNK_SIZE + 16 }
}

/** Place a piece the way the server stores one: banded at an explicit `z`. */
function put(world: World, id: string, kind: string, x: number, y: number, rot: number, z: number) {
  applyPlace(world, { id, kind, x, y, rot, scale: 1, z, owner: 'builder' })
}

/* -------------------------------------------------------------------------- */
/* Wild vegetation                                                            */
/* -------------------------------------------------------------------------- */

test('a tree generated on a hill collides at the hill height', () => {
  const bare = createWorld()
  // The first generated tree standing on real relief, not on the flat approach.
  let found: { cx: number, cy: number, tree: { x: number, y: number, z?: number } } | undefined
  for (let cy = 5; cy <= 9 && !found; cy++) {
    for (let cx = 5; cx <= 9 && !found; cx++) {
      const tree = generateVegetation(bare.seed, cx, cy).find(p => p.kind.startsWith('tree') && (p.z ?? 0) > 3)
      if (tree) found = { cx, cy, tree }
    }
  }
  assert.ok(found, 'expected a generated tree on a hill somewhere in the foothills')
  const { cx, cy, tree } = found

  // Generation records the ground it grew on, to the stored precision.
  assert.ok(Math.abs(tree.z! - worldTerrainHeight(tree.x, tree.y)) <= 0.005)
  assert.ok(Math.abs(tree.z! - terrainHeight(bare, tree.x, tree.y)) < 0.1)

  const grown = createWorld()
  for (const placement of generateVegetation(grown.seed, cx, cy)) applyPlace(grown, placement)

  // Its band starts at the ground and rises with the trunk, so a body standing
  // on the hill is inside it — which is exactly what a ground-based `top` of 3
  // could not express once the ground was 3 units up.
  const feet = terrainHeight(grown, tree.x, tree.y)
  assert.equal(hitsRaisedPiece(grown, tree.x, tree.y, feet), true)
  assert.equal(hitsRaisedPiece(bare, tree.x, tree.y, feet), false)

  // And a body cannot walk into it, while the same walk on bare ground can.
  const from = { x: tree.x + 2, y: tree.y }
  const blocked = walk(grown, settle(grown, from.x, from.y, feet + 6), -1, 0, 40)
  const clear = walk(bare, settle(bare, from.x, from.y, feet + 6), -1, 0, 40)
  assert.ok(clear.x < tree.x, 'the control walk never reached the trunk')
  assert.ok(blocked.x > tree.x + 0.4, `walked into the trunk: ${blocked.x} vs ${tree.x}`)
})

/* -------------------------------------------------------------------------- */
/* The build kit                                                              */
/* -------------------------------------------------------------------------- */

test('a wall placed on a slope blocks across its own band, not from zero', () => {
  const world = createWorld()
  // A point with real relief under it, outside the protected town.
  let spot = { x: 0, y: 0, h: 0 }
  for (let y = 240; y < 280 && spot.h < 3; y += 2) {
    for (let x = 240; x < 280 && spot.h < 3; x += 2) {
      const h = terrainHeight(world, x, y)
      if (h > 3) spot = { x, y, h }
    }
  }
  assert.ok(spot.h > 3, 'expected a hill out here')

  const built = resolveBuild(world, { kind: 'Kit_Wall', x: spot.x, y: spot.y, rot: 0 }, spot, { owner: 'builder', id: 'wall-slope', pieces: 0 })
  assert.ok(built.ok, `build refused: ${built.ok === false && built.reason}`)
  const z = built.placement.z!
  // It stands on the hillside, not at zero, and never below the ground it spans.
  assert.ok(z > 3, `wall sank to ${z} on ground at ${spot.h}`)
  assert.ok(z >= terrainHeight(world, built.placement.x, built.placement.y) - 1e-9)
  applyPlace(world, built.placement)

  const prop = propFromPlacement(built.placement)
  assert.equal(prop.base, z)
  assert.equal(prop.top, z + KIT_ASSETS.Kit_Wall.height)

  const { x, y } = built.placement
  // Feet on the hillside are inside the band; feet above the parapet are not.
  assert.equal(hitsRaisedPiece(world, x, y, z), true)
  assert.equal(hitsRaisedPiece(world, x, y, z + KIT_ASSETS.Kit_Wall.height), false)
  // Nor is a body far enough below it to pass underneath.
  assert.equal(hitsRaisedPiece(world, x, y, z - 4), false)
})

test('a floor stacked on walls is walked under and stood on', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 7, 7)
  const height = KIT_ASSETS.Kit_Wall.height

  // Two walls facing each other, a corridor open along +y between them.
  put(world, 'wall-w', 'Kit_Wall', gx - 1, gy, Math.PI / 2, 0)
  put(world, 'wall-e', 'Kit_Wall', gx + 1, gy, Math.PI / 2, 0)
  const floor = { id: 'floor', kind: 'Kit_Floor', x: gx, y: gy, rot: 0, scale: 1, owner: 'builder' }

  // The floor's support is the wall top, not the ground it spans.
  assert.equal(supportHeight(world, propFromPlacement({ ...floor, z: 0 })), height)
  put(world, floor.id, floor.kind, floor.x, floor.y, floor.rot, height)

  // Underneath: the corridor is still open, and the body stays on the ground.
  const under = walk(world, bodyAt(gx, gy - 3), 0, 1, 90)
  assert.ok(under.y > gy + 1, `stopped under the floor at y=${under.y}`)
  assert.ok(Math.abs(under.z) < 1e-6, `lifted to ${under.z} while walking underneath`)

  // Dropped from above: the slab catches the body at its top.
  const landed = settle(world, gx, gy, height + 4)
  assert.equal(landed.grounded, true)
  assert.ok(Math.abs(landed.z - (height + KIT_ASSETS.Kit_Floor.height)) < 1e-6, `landed at ${landed.z}`)
  assert.equal(surfaceHeight(world, gx, gy, landed.z), height + KIT_ASSETS.Kit_Floor.height)

  // And the walls still block a body standing on the ground between them.
  const penned = walk(world, bodyAt(gx, gy), 1, 0, 60)
  assert.ok(penned.x < gx + 0.9, `walked through the west wall to ${penned.x}`)
})

test('kit stairs carry a walking body up to the floor above', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 8, 8)
  const rise = KIT_ASSETS.Kit_Stairs.height

  // A flight rising along +y, with a landing slab at its top.
  put(world, 'stairs', 'Kit_Stairs', gx, gy, 0, 0)
  put(world, 'landing', 'Kit_Floor', gx, gy + 2, 0, rise)

  // Four tiles of walking: two up to the foot of the flight, two more to the
  // middle of the landing slab.
  const climber = walk(world, bodyAt(gx, gy - 2), 0, 1, 25)
  assert.ok(climber.y > gy + 1.5, `never made the landing, stopped at y=${climber.y}`)
  assert.ok(Math.abs(climber.z - (rise + KIT_ASSETS.Kit_Floor.height)) < 1e-6, `climbed to ${climber.z}, wanted ${rise + KIT_ASSETS.Kit_Floor.height}`)
  assert.equal(climber.grounded, true)
  // No jump was involved: the treads are each under the step limit.
  assert.ok(climber.vz === 0)

  // Halfway up, the body is on a tread rather than on the ground or the top.
  const midway = walk(world, bodyAt(gx, gy - 2), 0, 1, 8)
  assert.ok(midway.z > 0 && midway.z < rise, `midway height was ${midway.z}`)
})

test('the build rules refuse a piece in the same band and allow one on top', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 9, 9)
  const actor = { x: gx, y: gy }
  const height = KIT_ASSETS.Kit_Wall.height

  const first = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'w1', pieces: 0 })
  assert.ok(first.ok)
  assert.equal(first.placement.z, 0)
  applyPlace(world, first.placement)

  // Stacked on the wall's top, the same footprint is fine: the bands only touch.
  const stacked = resolveBuild(world, { kind: 'Kit_Floor', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'f1', pieces: 1 })
  assert.ok(stacked.ok, `stacking refused: ${stacked.ok === false && stacked.reason}`)
  assert.equal(stacked.placement.z, height)
  applyPlace(world, stacked.placement)

  // A second storey of wall then rests on the floor, not back on the ground.
  const upper = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'w3', pieces: 2 })
  assert.ok(upper.ok, `second storey refused: ${upper.ok === false && upper.reason}`)
  assert.equal(upper.placement.z, height + KIT_ASSETS.Kit_Floor.height)

  // Neighbouring cells stay on the ground: a shared grid edge is not support.
  const beside = resolveBuild(world, { kind: 'Kit_Wall', x: gx + 2, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'w4', pieces: 3 })
  assert.ok(beside.ok, `neighbour refused: ${beside.ok === false && beside.reason}`)
  assert.equal(beside.placement.z, 0)

  // A trunk the slab would pass through is caught by the band, even though it
  // stands clear of every point the support sampler looks at.
  put(world, 'trunk', 'tree1', gx + 5.45, gy + 1.45, 0, 0)
  const through = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 4, y: gy, rot: 0 }, { x: gx + 4, y: gy }, { owner: 'builder', id: 'f2', pieces: 4 })
  assert.equal(through.ok, false)
  assert.match(through.ok === false ? through.reason : '', /tree1 is in the way/)
})

/* -------------------------------------------------------------------------- */
/* Snap grid                                                                  */
/* -------------------------------------------------------------------------- */

test('small pieces snap to their own grid so two crates sit side by side', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 10, 10)
  const actor = { x: gx, y: gy }
  assert.equal(snapGridFor('Kit_Crate'), 1)
  assert.equal(snapGridFor('Kit_Torch'), 1)
  assert.equal(snapGridFor('Kit_Wall'), 2)
  assert.equal(snapGridFor('tree1'), 0)

  const first = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'c1', pieces: 0 })
  assert.ok(first.ok)
  assert.equal(first.placement.x, gx)
  applyPlace(world, first.placement)

  // The neighbouring cell is one tile away, not two: the crates touch along
  // their shared edge, which is not an overlap.
  const beside = resolveBuild(world, { kind: 'Kit_Crate', x: gx + 1, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'c2', pieces: 1 })
  assert.ok(beside.ok, `the neighbouring crate was refused: ${beside.ok === false && beside.reason}`)
  assert.equal(beside.placement.x, gx + 1)
  assert.equal(beside.placement.z, 0)
  applyPlace(world, beside.placement)

  // A third one aimed at the first cell cannot share that band. Crates are
  // stackable, so it goes on top rather than being refused — and forced back
  // down to ground level it is exactly the overlap the old 2 tile grid caused.
  const third = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'c3', pieces: 2 })
  assert.ok(third.ok)
  assert.equal(third.placement.z, KIT_ASSETS.Kit_Crate.height)
  assert.equal(overlappingPiece(world, propFromPlacement({ ...third.placement, z: 0 }))?.id, 'c1')

  // ...and a 1-grid crate still fits beside a 2-grid wall, one clear tile over.
  const wall = resolveBuild(world, { kind: 'Kit_Wall', x: gx + 4, y: gy, rot: 0 }, { x: gx + 4, y: gy }, { owner: 'builder', id: 'w1', pieces: 2 })
  assert.ok(wall.ok)
  applyPlace(world, wall.placement)
  const crate = resolveBuild(world, { kind: 'Kit_Crate', x: gx + 6, y: gy, rot: 0 }, { x: gx + 5, y: gy }, { owner: 'builder', id: 'c4', pieces: 3 })
  assert.ok(crate.ok, `the crate beside the wall was refused: ${crate.ok === false && crate.reason}`)
  assert.equal(crate.placement.x, gx + 6)
})

/* -------------------------------------------------------------------------- */
/* Protected footprint                                                        */
/* -------------------------------------------------------------------------- */

test('building stops at the end of the gate road, not a chunk later', () => {
  const world = createWorld()
  const f = FORTIFICATIONS
  const onRoad = { x: f.gateX, y: f.exteriorMax - 2 }
  const past = { x: f.gateX, y: f.exteriorMax + 2 }

  const refused = resolveBuild(world, { kind: 'Kit_Crate', ...onRoad, rot: 0 }, onRoad, { owner: 'builder', id: 'r1', pieces: 0 })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.reason, 'the town is protected')

  const allowed = resolveBuild(world, { kind: 'Kit_Crate', ...past, rot: 0 }, past, { owner: 'builder', id: 'r2', pieces: 0 })
  assert.ok(allowed.ok, `a build past the road was refused: ${allowed.ok === false && allowed.reason}`)

  // Well inside the old protected chunk band, but clear of the footprint.
  const beside = { x: 30, y: 150 }
  const aside = resolveBuild(world, { kind: 'Kit_Crate', ...beside, rot: 0 }, beside, { owner: 'builder', id: 'r3', pieces: 0 })
  assert.ok(aside.ok, `a build beside the town was refused: ${aside.ok === false && aside.reason}`)

  // Terraform follows the same footprint, and the moat bank stair is inside it.
  assert.equal(checkTerraform(world, { x: MOAT_STAIRS.x, y: MOAT_STAIRS.zStart + 2, mode: 'raise', size: 1 }, { x: MOAT_STAIRS.x, y: MOAT_STAIRS.zStart + 2 }).ok, false)
  assert.equal(checkTerraform(world, { x: beside.x, y: beside.y, mode: 'raise', size: 1 }, beside).ok, true)
  // A brush straddling the edge of the road is refused for the corner inside it.
  const edge = { x: f.gateX + f.bridgeWidth / 2 + 1, y: f.exteriorMax - 2 }
  assert.equal(checkTerraform(world, { x: edge.x, y: edge.y, mode: 'raise', size: 1 }, edge).ok, true)
  assert.equal(checkTerraform(world, { x: edge.x - 1, y: edge.y, mode: 'raise', size: 3 }, edge).ok, false)
})

/* -------------------------------------------------------------------------- */
/* Deed plots                                                                 */
/* -------------------------------------------------------------------------- */

/** A levelled chunk well clear of the town, so nothing here is protected. */
function plotGround() {
  const world = createWorld()
  const centre = levelChunk(world, 8, 8)
  return { world, ...centre }
}

/** Plant a deed the way the server would, through the shared rules. */
function claim(world: World, owner: string, x: number, y: number, held = 0) {
  const verdict = resolveBuild(world, { kind: 'Kit_Deed', x, y, rot: 0 }, { x, y, id: owner }, { owner, id: `deed-${owner}`, pieces: 0, deeds: held })
  if (verdict.ok) applyPlace(world, verdict.placement)
  return verdict
}

test('a deed claims the square around it', () => {
  const { world, x, y } = plotGround()
  const planted = claim(world, 'ana', x, y)
  assert.ok(planted.ok, `the deed was refused: ${planted.ok === false && planted.reason}`)

  const plot = plotBounds(planted.placement)
  assert.equal(plot.maxX - plot.minX, DEED_SIZE)
  assert.equal(plot.maxY - plot.minY, DEED_SIZE)
  assert.equal(plotOwner(world, x, y), 'ana')
  assert.equal(deedAt(world, x, y)?.id, planted.placement.id)
  // The tile past the edge belongs to nobody.
  assert.equal(plotOwner(world, plot.maxX, y), undefined)
})

test('a deed cannot be planted over another player s plot', () => {
  const { world, x, y } = plotGround()
  assert.ok(claim(world, 'ana', x, y).ok)

  const overlapping = claim(world, 'bo', x + DEED_SIZE - 2, y)
  assert.equal(overlapping.ok, false)
  assert.equal(overlapping.ok === false && overlapping.claim, 'ana')
  // The server turns the owner id into a name; nobody else gets one.
  assert.equal(refusalText(overlapping as { reason: string, claim?: string }, () => 'Ana'), 'that plot belongs to Ana')
  assert.equal(refusalText(overlapping as { reason: string, claim?: string }), 'that plot is claimed')

  // One tile further and the plots only touch, which is allowed.
  const clear = claim(world, 'bo', x + DEED_SIZE, y)
  assert.ok(clear.ok, `two touching plots were refused: ${clear.ok === false && clear.reason}`)
})

test('a player may only hold DEED_LIMIT plots', () => {
  const { world, x, y } = plotGround()
  assert.ok(claim(world, 'ana', x, y).ok)
  const second = claim(world, 'ana', x + DEED_SIZE * 2, y, 1)
  assert.equal(second.ok, false)
  assert.equal(second.ok === false && second.reason, 'you already hold a plot')
})

test('only the plot owner may edit inside it', () => {
  const { world, x, y } = plotGround()
  assert.ok(claim(world, 'ana', x, y).ok)

  const inside = { x: x + 3, y: y + 3 }
  const terraform = { x: inside.x, y: inside.y, mode: 'raise' as const, size: 1 as const }

  assert.equal(checkTerraform(world, terraform, { ...inside, id: 'bo' }).ok, false)
  assert.deepEqual(checkTerraform(world, terraform, { ...inside, id: 'bo' }), { ok: false, reason: 'that plot is claimed', claim: 'ana' })
  assert.equal(checkTerraform(world, terraform, { ...inside, id: 'ana' }).ok, true)

  const strangerBuild = resolveBuild(world, { kind: 'Kit_Crate', ...inside, rot: 0 }, { ...inside, id: 'bo' }, { owner: 'bo', id: 'b1', pieces: 0 })
  assert.equal(strangerBuild.ok, false)
  assert.equal(strangerBuild.ok === false && strangerBuild.claim, 'ana')

  const ownBuild = resolveBuild(world, { kind: 'Kit_Crate', ...inside, rot: 0 }, { ...inside, id: 'ana' }, { owner: 'ana', id: 'a1', pieces: 1 })
  assert.ok(ownBuild.ok, `the owner s own build was refused: ${ownBuild.ok === false && ownBuild.reason}`)
  applyPlace(world, ownBuild.placement)

  // ...and the same rule outside the plot, where nothing has changed.
  const outside = { x: x + DEED_SIZE, y }
  assert.equal(checkTerraform(world, { x: outside.x, y: outside.y, mode: 'raise', size: 1 }, { ...outside, id: 'bo' }).ok, true)
})

test('wild vegetation inside a plot is the owner s to clear', () => {
  const { world, x, y } = plotGround()
  assert.ok(claim(world, 'ana', x, y).ok)

  // A generated tree carries no owner, so anyone may fell it — until it stands
  // inside somebody s claim.
  const tree = { id: 'wild:8:8:3', kind: 'tree1', x: x + 2, y: y + 2, rot: 0, scale: 1, z: 0 }
  applyPlace(world, tree)

  const stranger = checkDemolish(world, tree, { x: tree.x, y: tree.y, id: 'bo' }, 'bo')
  assert.equal(stranger.ok, false)
  assert.equal(stranger.ok === false && stranger.claim, 'ana')
  assert.equal(checkDemolish(world, tree, { x: tree.x, y: tree.y, id: 'ana' }, 'ana').ok, true)

  // The same tree a plot away is anyone s.
  const wild = { ...tree, id: 'wild:8:8:4', x: x + DEED_SIZE + 2 }
  applyPlace(world, wild)
  assert.equal(checkDemolish(world, wild, { x: wild.x, y: wild.y, id: 'bo' }, 'bo').ok, true)
})

test('pulling the deed releases the plot and leaves the pieces', () => {
  const { world, x, y } = plotGround()
  const planted = claim(world, 'ana', x, y)
  assert.ok(planted.ok)

  const inside = { x: x + 3, y: y + 3 }
  const crate = resolveBuild(world, { kind: 'Kit_Crate', ...inside, rot: 0 }, { ...inside, id: 'ana' }, { owner: 'ana', id: 'a1', pieces: 1 })
  assert.ok(crate.ok)
  applyPlace(world, crate.placement)

  assert.equal(checkDemolish(world, planted.placement, { x, y, id: 'ana' }, 'ana').ok, true)
  applyRemove(world, planted.placement.id)

  assert.equal(plotOwner(world, x, y), undefined)
  // The crate stayed where it was, and is still only Ana s to remove.
  const chunk = world.getChunk(8, 8)!
  assert.ok(chunk.placements.some(p => p.id === 'a1'))
  assert.equal(chunk.deeds.length, 0)

  // ...and a stranger can build here again.
  const bo = { x: x + 6, y: y + 6 }
  const after = resolveBuild(world, { kind: 'Kit_Crate', ...bo, rot: 0 }, { ...bo, id: 'bo' }, { owner: 'bo', id: 'b2', pieces: 0 })
  assert.ok(after.ok, `a build on the released plot was refused: ${after.ok === false && after.reason}`)
})
