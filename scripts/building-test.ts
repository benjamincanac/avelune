// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/building-test.ts
//
// Elevation semantics for everything that is not a hand-authored town piece:
// a placement's `z` is the base of its collision band, and the band is what
// decides whether a body walks under a piece, into it, or onto it.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { PLAYER_SPEED, hitsRaisedPiece, isPieceCameraBlocked, isRampartCameraBlocked, stepBody, surfaceHeight, terrainHeight } from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import { DEED_SIZE, checkDemolish, checkTerraform, deedAt, isEdgeKind, overlappingPiece, plotBounds, plotOwner, refusalText, resolveBuild, snapGridFor, snapPlacement, supportHeight } from '../shared/utils/building'
import { propFromPlacement } from '../shared/utils/props'
import { KIT_ASSETS } from '../shared/utils/kit'
import { generateVegetation, isWildTree } from '../shared/utils/vegetation'
import { CHUNK_SIZE, GATE_APPROACH, TERRAFORM_STEP, applyPlace, applyRemove, applyTerrain, createWorld } from '../shared/utils/world'
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
      const tree = generateVegetation(bare.seed, cx, cy).find(p => isWildTree(p.kind) && (p.z ?? 0) > 3)
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

  // The ground is all that is under the floor; the wall tops on its edges are
  // the ledge it hangs from.
  assert.equal(supportHeight(world, propFromPlacement({ ...floor, z: 0 })), 0)
  const hung = resolveBuild(world, { kind: floor.kind, x: floor.x, y: floor.y, rot: 0 }, { x: gx, y: gy }, { owner: 'builder', id: 'hung', pieces: 0 })
  assert.ok(hung.ok, `floor on walls refused: ${hung.ok === false && hung.reason}`)
  assert.equal(hung.placement.z, height)
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

test('kit stairs block the camera as a wedge, not as a box', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 8, 10)
  const rise = KIT_ASSETS.Kit_Stairs.height
  // A flight rising along +y: low treads at gy - 1, the top step at gy + 1.
  put(world, 'stairs', 'Kit_Stairs', gx, gy, 0, 0)
  const blocked = (y: number, elevation: number) => isRampartCameraBlocked(world, gx, y, elevation, 0.25) || isPieceCameraBlocked(world, gx, y, elevation, 0.25)

  // Someone near the top has their camera trailing over the low treads, at
  // about the height of their own head. That is well clear of the flight there.
  assert.equal(blocked(gy - 0.7, rise * 0.8), false, 'the low treads blocked a camera far above them')
  // Inside the flight it is still solid: under the top step, and down in a tread.
  assert.equal(blocked(gy + 0.7, rise * 0.3), true, 'the camera passed under the top step')
  assert.equal(blocked(gy - 0.7, 0.05), true, 'the camera passed through the bottom tread')
  // And clear above the whole thing.
  assert.equal(blocked(gy + 0.7, rise + 1), false)
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
/* Rooms: pieces against walls, storeys and roofs across them                 */
/* -------------------------------------------------------------------------- */

const who = (id: string) => ({ owner: 'builder', id, pieces: 0 })

test('stairs and floors fit against the walls of a room', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  const actor = { x: gx, y: gy }
  put(world, 'wall-n', 'Kit_Wall', gx, gy - 1, 0, 0)
  put(world, 'wall-w', 'Kit_Wall', gx - 1, gy, Math.PI / 2, 0)

  const stairs = resolveBuild(world, { kind: 'Kit_Stairs', x: gx, y: gy, rot: 0, h: 0 }, actor, who('s1'))
  assert.ok(stairs.ok, `stairs against the wall refused: ${stairs.ok === false && stairs.reason}`)
  assert.equal(stairs.placement.z, 0)

  const floor = resolveBuild(world, { kind: 'Kit_Floor', x: gx, y: gy, rot: 0, h: 0 }, actor, who('f1'))
  assert.ok(floor.ok, `floor inside the room refused: ${floor.ok === false && floor.reason}`)
  assert.equal(floor.placement.z, 0, 'aimed at the ground, the floor stays on it')

  // A tree is not a panel: the cell keeps its whole footprint against it.
  put(world, 'trunk', 'tree1', gx + 3.3, gy, 0, 0)
  const crowded = resolveBuild(world, { kind: 'Kit_Stairs', x: gx + 2, y: gy, rot: 0, h: 0 }, actor, who('s2'))
  assert.equal(crowded.ok, false)
})

test('an upper floor spreads across a room from its walls', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 17, 10)
  const actor = { x: gx + 2, y: gy }
  const wallH = KIT_ASSETS.Kit_Wall.height
  // A room three cells wide: walls on the west and east ends only.
  put(world, 'wall-w', 'Kit_Wall', gx - 1, gy, Math.PI / 2, 0)
  put(world, 'wall-e', 'Kit_Wall', gx + 5, gy, Math.PI / 2, 0)

  // Aimed near the top of the west wall, the first slab takes its top.
  const first = resolveBuild(world, { kind: 'Kit_Floor', x: gx, y: gy, rot: 0, h: wallH - 0.6 }, actor, who('f1'))
  assert.ok(first.ok, `first slab refused: ${first.ok === false && first.reason}`)
  assert.equal(first.placement.z, wallH)
  applyPlace(world, first.placement)

  // The middle cell has nothing under it but the room; it hangs level with
  // the slab whose side the player aimed at.
  const middle = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 2, y: gy, rot: 0, h: wallH + 0.1 }, actor, who('f2'))
  assert.ok(middle.ok, `middle slab refused: ${middle.ok === false && middle.reason}`)
  assert.equal(middle.placement.z, wallH)
  applyPlace(world, middle.placement)

  // Aimed at the ground under it, the same cell is a ground floor instead.
  const below = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 4, y: gy, rot: 0, h: 0 }, actor, who('f3'))
  assert.ok(below.ok)
  assert.equal(below.placement.z, 0)

  // A slab with nothing beside it does not float.
  const alone = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 2, y: gy + 6, rot: 0, h: wallH }, { x: gx + 2, y: gy + 4 }, who('f4'))
  assert.ok(alone.ok)
  assert.equal(alone.placement.z, 0)
})

test('a landing hangs at the top of the stairs', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 11)
  const rise = KIT_ASSETS.Kit_Stairs.height
  put(world, 'stairs', 'Kit_Stairs', gx, gy, 0, 0)
  const landing = resolveBuild(world, { kind: 'Kit_Floor', x: gx, y: gy + 2, rot: 0, h: rise - 0.5 }, { x: gx, y: gy }, who('f1'))
  assert.ok(landing.ok, `landing refused: ${landing.ok === false && landing.reason}`)
  assert.equal(landing.placement.z, rise)

  // Beside the low end or a side of the flight there is nothing to land on.
  for (const [x, y] of [[gx, gy - 2], [gx + 2, gy]] as const) {
    const off = resolveBuild(world, { kind: 'Kit_Floor', x, y, rot: 0, h: rise - 0.5 }, { x: gx, y: gy }, who('f2'))
    assert.ok(off.ok)
    assert.equal(off.placement.z, 0, `hung beside the stairs at ${x - gx},${y - gy}`)
  }

  // Turned a quarter, the flight climbs along +x and the landing follows it.
  put(world, 'turned', 'Kit_Stairs', gx + 6, gy, Math.PI / 2, 0)
  const turned = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 8, y: gy, rot: 0, h: rise - 0.5 }, { x: gx + 6, y: gy }, who('f3'))
  assert.ok(turned.ok)
  assert.equal(turned.placement.z, rise)
})

test('a wall stacks over a door', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  const actor = { x: gx, y: gy }
  const height = KIT_ASSETS.Kit_WallDoor.height
  put(world, 'door', 'Kit_WallDoor', gx, gy - 1, 0, 0)

  const over = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0, h: height }, actor, who('w1'))
  assert.ok(over.ok, `wall over the door refused: ${over.ok === false && over.reason}`)
  assert.equal(over.placement.z, height)

  // Aimed through the opening, the door itself refuses the wall, although it
  // has no collision: two panels never share an edge in the same band.
  const across = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0, h: 0 }, actor, who('w2'))
  assert.equal(across.ok, false)
  assert.equal(across.ok === false && across.reason, 'Kit_WallDoor is in the way')

  // Nor does a door go into a wall, or a gate into a fence.
  put(world, 'wall', 'Kit_Wall', gx + 2, gy - 1, 0, 0)
  put(world, 'fence', 'Kit_Fence', gx - 2, gy - 1, 0, 0)
  for (const [kind, x, blocker] of [['Kit_WallDoor', gx + 2, 'Kit_Wall'], ['Kit_Gate', gx - 2, 'Kit_Fence']] as const) {
    const into = resolveBuild(world, { kind, x, y: gy - 0.9, rot: 0, h: 0 }, actor, who('p'))
    assert.equal(into.ok === false && into.reason, `${blocker} is in the way`)
  }
})

test('a refused piece still reports the height it would have stood at', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 17, 10)
  const wallH = KIT_ASSETS.Kit_Wall.height
  put(world, 'wall-w', 'Kit_Wall', gx - 1, gy, Math.PI / 2, 0)
  const deckTop = wallH + KIT_ASSETS.Kit_Floor.height
  put(world, 'deck', 'Kit_Floor', gx, gy, 0, wallH)
  put(world, 'crate', 'Kit_Crate', gx, gy, 0, deckTop)
  const blocked = resolveBuild(world, { kind: 'Kit_Floor', x: gx, y: gy, rot: 0, h: deckTop }, { x: gx, y: gy }, who('f1'))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok === false && blocked.z, deckTop)
})

test('a roof closes over the middle of a room', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 17, 11)
  const actor = { x: gx + 2, y: gy }
  const wallH = KIT_ASSETS.Kit_Wall.height
  put(world, 'wall-w', 'Kit_Wall', gx - 1, gy, Math.PI / 2, 0)
  put(world, 'roof-w', 'Kit_Roof', gx, gy, 0, wallH)

  // The ray meets the side of the roof beside the gap, anywhere up its slope.
  // Facing the same way, the two slopes run on side by side at one level.
  const gap = resolveBuild(world, { kind: 'Kit_Roof', x: gx + 2, y: gy, rot: 0, h: wallH + 0.9 }, actor, who('r1'))
  assert.ok(gap.ok, `roof over the gap refused: ${gap.ok === false && gap.reason}`)
  assert.equal(gap.placement.z, wallH)

  // A floor is not a roof's family: it does not hang off one.
  const floor = resolveBuild(world, { kind: 'Kit_Floor', x: gx + 2, y: gy, rot: 0, h: wallH + 0.5 }, actor, who('f1'))
  assert.ok(floor.ok)
  assert.equal(floor.placement.z, 0)
})

test('roofs meet where their slopes do', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 17, 11)
  const actor = { x: gx, y: gy }
  const wallH = KIT_ASSETS.Kit_Wall.height
  const rise = KIT_ASSETS.Kit_Roof.height
  // Its ridge on its +y edge, its eave on -y.
  put(world, 'roof', 'Kit_Roof', gx, gy, 0, wallH)
  const roof = (x: number, y: number, rot: number, kind = 'Kit_Roof') => resolveBuild(world, { kind, x, y, rot, h: wallH + 0.5 }, actor, who('r'))

  // Back to back, ridge to ridge: a gable, level.
  const gable = roof(gx, gy + 2, Math.PI)
  assert.ok(gable.ok && gable.placement.z === wallH, `gable: ${gable.ok ? gable.placement.z : gable.reason}`)
  // Eave to eave: a valley, level too.
  const valley = roof(gx, gy - 2, Math.PI)
  assert.ok(valley.ok && valley.placement.z === wallH, `valley: ${valley.ok ? valley.placement.z : valley.reason}`)
  // A ridge meeting this eave carries the slope on down, a whole rise lower.
  const down = roof(gx, gy - 2, 0)
  assert.ok(down.ok && down.placement.z === wallH - rise, `down the slope: ${down.ok ? down.placement.z : down.reason}`)

  // A hip climbing into the eave meets it at one corner only. On a wall that
  // holds it at the eave's level, it is refused rather than pushed through.
  put(world, 'front', 'Kit_Wall', gx, gy - 3, 0, 0)
  const hip = roof(gx, gy - 2, 0, 'Kit_RoofCorner')
  assert.equal(hip.ok === false && hip.reason, 'it does not meet the roof beside it')
  // Turned so its eaves face the eave beside it, the same corner fits.
  const turned = roof(gx, gy - 2, Math.PI, 'Kit_RoofCorner')
  assert.ok(turned.ok && turned.placement.z === wallH, `turned hip: ${turned.ok ? turned.placement.z : turned.reason}`)
})

/* -------------------------------------------------------------------------- */
/* Aim height                                                                 */
/* -------------------------------------------------------------------------- */

/** A one-cell room with a deck over it: ground slab, a wall on its south edge,
 *  and a second slab at the top of that wall. */
function twoStoreys(world: World, gx: number, gy: number) {
  const floorH = KIT_ASSETS.Kit_Floor.height
  const wallH = KIT_ASSETS.Kit_Wall.height
  put(world, 'ground-slab', 'Kit_Floor', gx, gy, 0, 0)
  put(world, 'ground-wall', 'Kit_Wall', gx, gy - 1, 0, floorH)
  put(world, 'deck', 'Kit_Floor', gx, gy, 0, floorH + wallH)
  // Rounded the way `supportHeight` rounds, so 0.2 + 2.5 + 0.2 compares equal.
  return { floorH, wallH, deckTop: Math.round((floorH + wallH + floorH) * 100) / 100 }
}

test('the aim height chooses which storey a piece lands on', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 10, 10)
  const actor = { x: gx, y: gy }
  const { floorH, deckTop } = twoStoreys(world, gx, gy)

  // Aimed at the ground floor, a crate stays on the ground floor even though
  // there is a deck over its head.
  const downstairs = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0, h: floorH }, actor, { owner: 'builder', id: 'c1', pieces: 0 })
  assert.ok(downstairs.ok, `downstairs refused: ${downstairs.ok === false && downstairs.reason}`)
  assert.equal(downstairs.placement.z, floorH)

  // Aimed at the deck, the same pose puts it upstairs.
  const upstairs = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0, h: deckTop }, actor, { owner: 'builder', id: 'c2', pieces: 0 })
  assert.ok(upstairs.ok, `upstairs refused: ${upstairs.ok === false && upstairs.reason}`)
  assert.equal(upstairs.placement.z, deckTop)

  // No aim height at all is the old rule: the tallest surface under the
  // footprint wins, which is what sent everything to the roof.
  const blind = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0 }, actor, { owner: 'builder', id: 'c3', pieces: 0 })
  assert.ok(blind.ok)
  assert.equal(blind.placement.z, deckTop)
})

test('a ground-floor wall pulled out can be put back in its slot', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 11, 10)
  const actor = { x: gx, y: gy }
  const { floorH, deckTop } = twoStoreys(world, gx, gy)
  applyRemove(world, 'ground-wall')

  // The slot is empty, but the deck still hangs over the far end of the panel.
  const blind = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0 }, actor, { owner: 'builder', id: 'w-blind', pieces: 0 })
  assert.ok(blind.ok)
  assert.equal(blind.placement.z, deckTop, 'without an aim height the wall climbs onto the deck')

  const back = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0, h: floorH }, actor, { owner: 'builder', id: 'w-back', pieces: 0 })
  assert.ok(back.ok, `rebuild refused: ${back.ok === false && back.reason}`)
  assert.equal(back.placement.z, floorH)
  // And it fits exactly: the wall's top meets the deck's underside.
  assert.equal(back.placement.z + KIT_ASSETS.Kit_Wall.height, floorH + KIT_ASSETS.Kit_Wall.height)
})

test('a piece that will not fit under what is above it is refused', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 12, 10)
  const actor = { x: gx, y: gy }
  // A slab hung low over the cell, and a panel hung low on its edge — both
  // lower than a wall is tall. A wall may run past a slab's edge, since the
  // cell gives that strip up to panels, but not under another panel.
  put(world, 'low-deck', 'Kit_Floor', gx, gy, 0, 1.5)
  put(world, 'low-lintel', 'Kit_Wall', gx, gy - 1, 0, 1.5)

  const squeezed = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0, h: 0 }, actor, { owner: 'builder', id: 'w1', pieces: 0 })
  assert.equal(squeezed.ok, false)
  assert.equal(squeezed.ok === false && squeezed.reason, 'no room there')

  // A crate is short enough to fit under the same slab.
  const crate = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0, h: 0 }, actor, { owner: 'builder', id: 'c1', pieces: 0 })
  assert.ok(crate.ok, `crate refused: ${crate.ok === false && crate.reason}`)
  assert.equal(crate.placement.z, 0)

  // And a wall exactly as tall as the gap still fits: touching is clearance.
  const world2 = createWorld()
  const spot = levelChunk(world2, 13, 10)
  put(world2, 'deck', 'Kit_Floor', spot.x, spot.y, 0, KIT_ASSETS.Kit_Wall.height)
  const snug = resolveBuild(world2, { kind: 'Kit_Wall', x: spot.x, y: spot.y - 0.9, rot: 0, h: 0 }, spot, { owner: 'builder', id: 'w2', pieces: 0 })
  assert.ok(snug.ok, `snug wall refused: ${snug.ok === false && snug.reason}`)
  assert.equal(snug.placement.z, 0)
})

test('a nonsense aim height is ignored or clamped, never trusted', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 14, 10)
  const actor = { x: gx, y: gy }
  const { deckTop } = twoStoreys(world, gx, gy)

  for (const h of [Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
    const verdict = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0, h }, actor, { owner: 'builder', id: 'c1', pieces: 0 })
    assert.ok(verdict.ok, `h=${h} refused: ${verdict.ok === false && verdict.reason}`)
    assert.equal(verdict.placement.z, deckTop, `h=${h} should read as no hint at all`)
  }

  // Clamped downward it selects nothing above the terrain, which is a verdict
  // rather than a crash: the ground slab is then in the way.
  const sunk = resolveBuild(world, { kind: 'Kit_Crate', x: gx, y: gy, rot: 0, h: -1e9 }, actor, { owner: 'builder', id: 'c2', pieces: 0 })
  assert.ok(!sunk.ok || sunk.placement.z <= 0, `h=-1e9 placed at ${sunk.ok && sunk.placement.z}`)
})

/* -------------------------------------------------------------------------- */
/* Edge snapping                                                              */
/* -------------------------------------------------------------------------- */

/** Rotations come back rounded to two decimals, so compare the same way. */
const rot2 = (n: number) => Math.round(n * 100) / 100

test('a panel snaps to the nearest cell edge and takes its heading from it', () => {
  // Cell (0, 0) of the 2-tile grid spans [-1, 1] on both axes: its four edges
  // are the midpoints of its sides. One aim per quadrant, each closer to one
  // side than to the other.
  assert.equal(isEdgeKind('Kit_Wall'), true)
  assert.equal(isEdgeKind('Kit_Floor'), false)

  const cases = [
    { x: 0.6, y: -0.9, edge: { x: 0, y: -1 }, rot: 0 },
    { x: -0.6, y: 0.9, edge: { x: 0, y: 1 }, rot: 0 },
    { x: 0.9, y: 0.6, edge: { x: 1, y: 0 }, rot: Math.PI / 2 },
    { x: -0.9, y: -0.6, edge: { x: -1, y: 0 }, rot: Math.PI / 2 },
  ]
  for (const c of cases) {
    const pose = snapPlacement('Kit_Wall', c.x, c.y, 0)
    assert.deepEqual({ x: pose.x, y: pose.y }, c.edge, `aim ${c.x},${c.y}`)
    assert.equal(pose.rot, rot2(c.rot), `heading for ${c.x},${c.y}`)
    // `R` no longer picks the heading — the edge does — so a quarter turn is a
    // flip of the same panel, not a different edge.
    const flipped = snapPlacement('Kit_Wall', c.x, c.y, Math.PI / 2)
    assert.deepEqual({ x: flipped.x, y: flipped.y }, c.edge)
    assert.equal(flipped.rot, rot2((c.rot + Math.PI) % (Math.PI * 2)))
  }

  // Cell pieces are unchanged: they still land on the centre of the cell.
  const slab = snapPlacement('Kit_Floor', 0.6, -0.9, 0)
  assert.deepEqual({ x: slab.x, y: slab.y }, { x: 0, y: 0 })
})

test('four panels around a floor cell are accepted, and they enclose it', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 11, 11)
  const actor = { x: gx, y: gy }
  let pieces = 0
  const place = (kind: string, x: number, y: number) => {
    const verdict = resolveBuild(world, { kind, x, y, rot: 0 }, actor, { owner: 'builder', id: `p${pieces}`, pieces })
    assert.ok(verdict.ok, `${kind} at ${x},${y} refused: ${verdict.ok === false && verdict.reason}`)
    applyPlace(world, verdict.placement)
    pieces++
    return verdict.placement
  }

  // The slab goes down first: the walls then read its top as their support, the
  // way they do for a player who floors a room before closing it.
  const slab = place('Kit_Floor', gx, gy)
  assert.equal(slab.z, 0)
  const deck = KIT_ASSETS.Kit_Floor.height

  // One panel per side, aimed from just inside the cell. The corners are where
  // the old rules refused: perpendicular panels share exactly half a wall's
  // depth there, which the overlap test now treats as a join.
  const south = place('Kit_Wall', gx, gy - 0.9)
  const north = place('Kit_Wall', gx, gy + 0.9)
  const west = place('Kit_Wall', gx - 0.9, gy)
  const east = place('Kit_Wall', gx + 0.9, gy)
  assert.deepEqual([south.x, south.y], [gx, gy - 1])
  assert.deepEqual([north.x, north.y], [gx, gy + 1])
  assert.deepEqual([west.x, west.y], [gx - 1, gy])
  assert.deepEqual([east.x, east.y], [gx + 1, gy])
  for (const wall of [south, north, west, east]) assert.equal(wall.z, deck, 'a panel rests on the slab it closes')

  // Sealed: a body standing on the slab cannot leave in any direction, corners
  // included. The overlap inset gave up a strip at each end of every panel, and
  // its perpendicular neighbour covers exactly that strip.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) {
    const penned = walk(world, bodyAt(gx, gy, deck), dx, dy, 90)
    assert.ok(Math.abs(penned.x - gx) < 1 && Math.abs(penned.y - gy) < 1, `escaped toward ${dx},${dy} to ${penned.x},${penned.y}`)
  }

  // A second storey on the same four edges: each panel reads the one below it.
  const upperDeck = place('Kit_Floor', gx, gy)
  assert.equal(upperDeck.z, deck + KIT_ASSETS.Kit_Wall.height)
  for (const [ax, ay] of [[gx, gy - 0.9], [gx, gy + 0.9], [gx - 0.9, gy], [gx + 0.9, gy]] as const) {
    const upper = place('Kit_Wall', ax, ay)
    assert.ok(Math.abs(upper.z! - (upperDeck.z! + KIT_ASSETS.Kit_Floor.height)) < 1e-6, `second storey landed at ${upper.z}`)
  }

  // Swap the south panel for a doorway and the room has a way out. The door is
  // not a solid prop, so it neither blocks nor holds anything up.
  applyRemove(world, south.id!)
  const door = resolveBuild(world, { kind: 'Kit_WallDoor', x: gx, y: gy - 0.9, rot: 0 }, actor, { owner: 'builder', id: 'door', pieces })
  assert.ok(door.ok, `doorway refused: ${door.ok === false && door.reason}`)
  assert.deepEqual([door.placement.x, door.placement.y], [gx, gy - 1])
  applyPlace(world, door.placement)
  const out = walk(world, bodyAt(gx, gy, deck), 0, -1, 90)
  assert.ok(out.y < gy - 1.5, `the doorway did not let the body out; stopped at ${out.y}`)
})

test('a second panel in the same band on the same edge is an overlap', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 12, 12)
  const actor = { x: gx, y: gy }

  const first = resolveBuild(world, { kind: 'Kit_Wall', x: gx, y: gy - 0.9, rot: 0 }, actor, { owner: 'builder', id: 'w1', pieces: 0 })
  assert.ok(first.ok)
  applyPlace(world, first.placement)

  // Aimed at the same edge from the ground, a panel stacks — walls are
  // stackable, and that is how a second storey is built. It is the same edge in
  // the same BAND that has nowhere to go.
  const again = resolveBuild(world, { kind: 'Kit_Wall', x: gx + 0.2, y: gy - 0.95, rot: 0 }, actor, { owner: 'builder', id: 'w2', pieces: 1 })
  assert.ok(again.ok)
  assert.deepEqual([again.placement.x, again.placement.y], [gx, gy - 1])
  assert.equal(again.placement.z, KIT_ASSETS.Kit_Wall.height)
  assert.equal(overlappingPiece(world, propFromPlacement({ ...again.placement, z: 0 }))?.id, 'w1')

  // ...while the next edge along the same line is clear, because the inset only
  // gives up a corner and two panels end to end never reach into each other.
  const next = resolveBuild(world, { kind: 'Kit_Wall', x: gx + 2, y: gy - 0.9, rot: 0 }, { x: gx + 2, y: gy }, { owner: 'builder', id: 'w3', pieces: 2 })
  assert.ok(next.ok, `the next panel along was refused: ${next.ok === false && next.reason}`)
  assert.deepEqual([next.placement.x, next.placement.y], [gx + 2, gy - 1])
  assert.equal(next.placement.z, 0)
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

test('building stops at the end of the gate bridge, not a chunk later', () => {
  const world = createWorld()
  const f = FORTIFICATIONS
  const onRoad = { x: f.gateX, y: f.bridgeEnd - 1 }
  // Past the bridge *and* clear of the approach the bridge lands on.
  const past = { x: GATE_APPROACH.maxX + 2, y: f.bridgeEnd + 3 }

  const refused = resolveBuild(world, { kind: 'Kit_Crate', ...onRoad, rot: 0 }, onRoad, { owner: 'builder', id: 'r1', pieces: 0 })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.reason, 'the town is protected')

  const allowed = resolveBuild(world, { kind: 'Kit_Crate', ...past, rot: 0 }, past, { owner: 'builder', id: 'r2', pieces: 0 })
  assert.ok(allowed.ok, `a build beside the approach was refused: ${allowed.ok === false && allowed.reason}`)

  // Well inside the old protected chunk band, but clear of the footprint.
  const beside = { x: 30, y: 150 }
  const aside = resolveBuild(world, { kind: 'Kit_Crate', ...beside, rot: 0 }, beside, { owner: 'builder', id: 'r3', pieces: 0 })
  assert.ok(aside.ok, `a build beside the town was refused: ${aside.ok === false && aside.reason}`)

  // Terraform follows the same footprint, and the moat bank stair is inside it.
  assert.equal(checkTerraform(world, { x: MOAT_STAIRS.x, y: MOAT_STAIRS.zStart + 2, mode: 'raise', size: 1 }, { x: MOAT_STAIRS.x, y: MOAT_STAIRS.zStart + 2 }).ok, false)
  assert.equal(checkTerraform(world, { x: beside.x, y: beside.y, mode: 'raise', size: 1 }, beside).ok, true)
  // A brush straddling the edge of the landing is refused for the corner inside it.
  const edge = { x: f.gateX + f.bridgeWidth / 2 + 1, y: f.bridgeEnd - 1 }
  assert.equal(checkTerraform(world, { x: edge.x, y: edge.y, mode: 'raise', size: 1 }, edge).ok, true)
  assert.equal(checkTerraform(world, { x: edge.x - 1, y: edge.y, mode: 'raise', size: 3 }, edge).ok, false)
})

test('the ground in front of the gate cannot be built on, dug out or claimed', () => {
  const world = createWorld()
  const f = FORTIFICATIONS
  // Straight off the end of the bridge, where one wall would shut the town.
  const mouth = { x: f.gateX, y: f.bridgeEnd + 1 }
  const built = resolveBuild(world, { kind: 'Kit_Wall', ...mouth, rot: 0 }, mouth, { owner: 'builder', id: 'g1', pieces: 0 })
  assert.equal(built.ok, false)
  assert.equal(built.ok === false && built.reason, 'the way into town must stay clear')
  // And a trench in front of it is the same block by other means.
  assert.equal(checkTerraform(world, { ...mouth, mode: 'lower', size: 1 }, mouth).ok, false)
  // The spawn stands inside the strip, so nobody can dig out the tile players
  // arrive on, and the flare is wider than the deck.
  assert.equal(checkTerraform(world, { ...f.spawn, mode: 'lower', size: 1 }, f.spawn).ok, false)
  const flank = { x: f.gateX + f.bridgeWidth / 2 + 2, y: f.bridgeEnd + 2 }
  assert.equal(resolveBuild(world, { kind: 'Kit_Wall', ...flank, rot: 0 }, flank, { owner: 'builder', id: 'g2', pieces: 0 }).ok, false)
  // A deed would fence the road just as well, so a plot overlapping it is out.
  const deed = { x: GATE_APPROACH.maxX - 1, y: GATE_APPROACH.maxY - 1 }
  const claimed = resolveBuild(world, { kind: 'Kit_Deed', ...deed, rot: 0 }, deed, { owner: 'builder', id: 'g3', pieces: 0, deeds: 0 })
  assert.equal(claimed.ok, false)
  assert.equal(claimed.ok === false && claimed.reason, 'the way into town must stay clear')
  // Clearing it is still allowed: a piece standing here is in the way.
  const stray = { x: mouth.x, y: mouth.y, z: 0, kind: 'Kit_Wall', scale: 1, id: 'g4', owner: 'builder' }
  assert.equal(checkDemolish(world, stray, mouth, 'builder').ok, true)
  // Two tiles past the strip the meadow is a player's again.
  const clear = { x: f.gateX, y: GATE_APPROACH.maxY + 2 }
  assert.ok(resolveBuild(world, { kind: 'Kit_Wall', ...clear, rot: 0 }, clear, { owner: 'builder', id: 'g5', pieces: 0 }).ok)
  assert.equal(checkTerraform(world, { ...clear, mode: 'lower', size: 1 }, clear).ok, true)
})

test('a flatten needs a brush wider than the corner it levels to', () => {
  const world = createWorld()
  const at = { x: 30, y: 150 }
  // Size 1 is the crosshair corner alone, levelled to itself: `applyTerrain`
  // would move nothing and the click would vanish without a word.
  const refused = checkTerraform(world, { ...at, mode: 'flatten', size: 1 }, at)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.reason, 'widen the brush to level ground')
  assert.deepEqual(applyTerrain(world, { ...at, mode: 'flatten', size: 1, maxStep: TERRAFORM_STEP }), [])
  assert.equal(checkTerraform(world, { ...at, mode: 'flatten', size: 2 }, at).ok, true)
  // The narrowest allowed brush does move ground, which is what makes it the floor.
  assert.ok(applyTerrain(world, { ...at, mode: 'flatten', size: 2, maxStep: TERRAFORM_STEP }).length > 0)
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

test('a build is only protected inside its owner s plot', () => {
  const { world, x, y } = plotGround()
  assert.ok(claim(world, 'ana', x, y).ok)

  const inside = { x: x + 3, y: y + 3 }
  const kept = resolveBuild(world, { kind: 'Kit_Crate', ...inside, rot: 0 }, { ...inside, id: 'ana' }, { owner: 'ana', id: 'a1', pieces: 1 })
  assert.ok(kept.ok)
  applyPlace(world, kept.placement)
  const refused = checkDemolish(world, kept.placement, { ...inside, id: 'bo' }, 'bo')
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.claim, 'ana')

  const outside = { x: x + DEED_SIZE + 2, y }
  const loose = resolveBuild(world, { kind: 'Kit_Crate', ...outside, rot: 0 }, { ...outside, id: 'ana' }, { owner: 'ana', id: 'a2', pieces: 2 })
  assert.ok(loose.ok)
  applyPlace(world, loose.placement)
  assert.equal(checkDemolish(world, loose.placement, { ...outside, id: 'bo' }, 'bo').ok, true)
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
  // The crate stayed where it was, and with the claim gone it is anyone s to
  // knock down.
  const chunk = world.getChunk(8, 8)!
  assert.ok(chunk.placements.some(p => p.id === 'a1'))
  assert.equal(chunk.deeds.length, 0)
  assert.equal(checkDemolish(world, crate.placement, { ...inside, id: 'bo' }, 'bo').ok, true)

  // ...and a stranger can build here again.
  const bo = { x: x + 6, y: y + 6 }
  const after = resolveBuild(world, { kind: 'Kit_Crate', ...bo, rot: 0 }, { ...bo, id: 'bo' }, { owner: 'bo', id: 'b2', pieces: 0 })
  assert.ok(after.ok, `a build on the released plot was refused: ${after.ok === false && after.reason}`)
})
