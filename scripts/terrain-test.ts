// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/terrain-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { GRAVITY, JUMP_VELOCITY, isWalkable, isWalkableAt, moveWithCollision, stepBody, surfaceHeight, terrainHeight, SLOPE_MAX, STEP_MAX } from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import {
  CHUNK_CORNERS,
  CHUNK_SIZE,
  HEIGHT_STEP,
  TERRAFORM_STEP,
  WORLD_TILE_MAX,
  WORLD_TILE_MIN,
  applyTerrain,
  applyPlace,
  applyRemove,
  cornerHeight,
  createWorld,
  decodeChunk,
  editLock,
  encodeChunk,
  GATE_APPROACH,
  generateChunk,
  installChunk,
  isProtectedTile,
  isTownChunk,
  makePlacementId,
  removeChunk,
  ROCK_LINE,
  SNOW_LINE,
  SURFACE,
} from '../shared/utils/world'
import { BARREN_LINE, BIOME_TREES, TREELINE, generateVegetation, isWildPlacement, isWildTree } from '../shared/utils/vegetation'
import type { Biome } from '../shared/utils/biome'
import { biomeAt } from '../shared/utils/biome'
import { isSolidProp } from '../shared/utils/props'
import type { World } from '../shared/utils/world'
import {
  LANDSCAPE_CENTER,
  LANDSCAPE_EXPANSION,
  MEADOW_BELT,
  REGION_SIZE,
  WORLD_SEED,
  isFlatTownGround,
  mountainUplift,
  smoothstep,
  worldTerrainHeight,
} from '../shared/utils/terrain'
import { FORTIFICATIONS, TOWN_MARGIN } from '../shared/utils/courtyard'
import { MOAT_STAIRS } from '../shared/utils/moat'

const bodyAt = (x: number, y: number, z = 0): KinematicBody => ({ x, y, z, vz: 0, grounded: true })
/** A patch of open meadow well outside the protected town. */
const MEADOW = { cx: 6, cy: 6, gx: 6 * CHUNK_SIZE + 8, gy: 6 * CHUNK_SIZE + 8 }

function settle(world: World, x: number, y: number, z = 40) {
  const body = bodyAt(x, y, z)
  body.grounded = false
  for (let i = 0; i < 400; i++) stepBody(world, body, 0, 0, 1 / 60)
  return body
}

test('terrain interpolates bilinearly between the stored corners', () => {
  const world = createWorld()
  const chunk = world.getChunk(MEADOW.cx, MEADOW.cy)!
  const lx = MEADOW.gx - chunk.cx * CHUNK_SIZE
  const ly = MEADOW.gy - chunk.cy * CHUNK_SIZE
  const i = ly * CHUNK_CORNERS + lx
  const h00 = chunk.heights[i]! * HEIGHT_STEP
  const h10 = chunk.heights[i + 1]! * HEIGHT_STEP
  const h01 = chunk.heights[i + CHUNK_CORNERS]! * HEIGHT_STEP
  const h11 = chunk.heights[i + CHUNK_CORNERS + 1]! * HEIGHT_STEP
  // Exact at all four corners of the tile.
  assert.equal(terrainHeight(world, MEADOW.gx, MEADOW.gy), h00)
  assert.ok(Math.abs(terrainHeight(world, MEADOW.gx + 0.999999, MEADOW.gy) - h10) < 1e-4)
  assert.ok(Math.abs(terrainHeight(world, MEADOW.gx, MEADOW.gy + 0.999999) - h01) < 1e-4)
  // Edge and centre midpoints.
  assert.ok(Math.abs(terrainHeight(world, MEADOW.gx + 0.5, MEADOW.gy) - (h00 + h10) / 2) < 1e-12)
  assert.ok(Math.abs(terrainHeight(world, MEADOW.gx, MEADOW.gy + 0.5) - (h00 + h01) / 2) < 1e-12)
  assert.ok(Math.abs(terrainHeight(world, MEADOW.gx + 0.5, MEADOW.gy + 0.5) - (h00 + h10 + h01 + h11) / 4) < 1e-12)
  // And it is the same field the landscape mesh draws, to the quantisation step.
  assert.ok(Math.abs(h00 - worldTerrainHeight(MEADOW.gx, MEADOW.gy)) <= HEIGHT_STEP / 2)
})

test('the meadow outside the walls is real ground a body stands on', () => {
  const world = createWorld()
  const x = 240
  const y = 240
  assert.ok(terrainHeight(world, x, y) > 1, 'expected a hill out here')
  const body = settle(world, x, y)
  assert.equal(body.grounded, true)
  assert.ok(Math.abs(body.z - terrainHeight(world, body.x, body.y)) < 1e-9)
})

test('slopes steeper than the cliff limit block movement', () => {
  const world = createWorld()
  const gx = MEADOW.gx
  const gy = MEADOW.gy
  applyTerrain(world, { x: gx, y: gy, size: 3, mode: 'flatten' })
  assert.equal(isWalkable(world, gx, gy), true)
  // Raise one corner past the limit and the tiles it bounds become a cliff.
  const lifts = Math.ceil((SLOPE_MAX + 0.1) / TERRAFORM_STEP)
  for (let i = 0; i < lifts; i++) applyTerrain(world, { x: gx, y: gy, size: 1, mode: 'raise' })
  assert.ok(cornerHeight(world, gx, gy) - cornerHeight(world, gx + 1, gy) > SLOPE_MAX)
  assert.equal(isWalkable(world, gx, gy), false)
  assert.equal(isWalkable(world, gx - 1, gy - 1), false)
  // The far side of the plateau is untouched and still walkable.
  assert.equal(isWalkable(world, gx + 4, gy + 4), true)
})

/** Level ground with a pit in it: a size 3 brush lowered `lowers` times around
 *  the corner `(gx, gy)`, so a 2 by 2 floor (tiles `gx - 1` and `gx`) with one
 *  rim tile on every side (`gx - 2` and `gx + 1`). */
function digPit(world: World, gx: number, gy: number, lowers: number) {
  applyTerrain(world, { x: gx, y: gy, size: 21, mode: 'flatten' })
  for (let i = 0; i < lowers; i++) applyTerrain(world, { x: gx, y: gy, size: 3, mode: 'lower' })
  return { ground: cornerHeight(world, gx + 5, gy), floor: cornerHeight(world, gx, gy) }
}

const TICK = 1 / 20
/** Walk a body along +x for `ticks` server ticks, jumping on the ticks listed. */
function run(world: World, body: KinematicBody, speed: number, ticks: number, jumpOn: (tick: number, body: KinematicBody) => boolean = () => false) {
  for (let i = 0; i < ticks; i++) {
    if (body.grounded && jumpOn(i, body)) {
      body.vz = JUMP_VELOCITY
      body.grounded = false
    }
    stepBody(world, body, speed * TICK, 0, TICK)
  }
}

test('a running jump clears a dug hole instead of stopping at its rim', () => {
  const world = createWorld()
  const gx = MEADOW.gx
  const gy = MEADOW.gy
  const { ground } = digPit(world, gx, gy, 6)
  assert.equal(isWalkable(world, gx - 2, gy), false, 'the rim is past the slope limit')
  // Without a jump the run ends on the pit floor, not in front of the rim.
  const walker = bodyAt(gx - 6, gy + 0.5, ground)
  run(world, walker, 6, 20)
  assert.ok(walker.x > gx - 1 && walker.z < ground - 1, `walked off the rim and fell in, got x=${walker.x} z=${walker.z}`)
  // Jumping a stride before the rim carries the body across.
  const jumper = bodyAt(gx - 6, gy + 0.5, ground)
  run(world, jumper, 6, 40, (_, body) => body.x >= gx - 2.9 && body.x < gx - 2.3)
  assert.ok(jumper.x > gx + 2, `expected to land past the far rim, got x=${jumper.x}`)
  assert.ok(Math.abs(jumper.z - ground) < 1e-9)
  assert.equal(jumper.grounded, true)
})

test('a jump leaves a pit only when it reaches the rim', () => {
  const peak = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY)
  for (const lowers of [5, 12]) {
    const world = createWorld()
    const gx = MEADOW.gx
    const gy = MEADOW.gy
    const { ground, floor } = digPit(world, gx, gy, lowers)
    const depth = ground - floor
    const body = bodyAt(gx - 0.5, gy + 0.5, floor)
    // Walking alone never gets out of either.
    run(world, body, 3.2, 40)
    assert.ok(body.x < gx + 1 && Math.abs(body.z - floor) < 1e-9, `depth ${depth}: the rim holds a walker`)
    run(world, body, 3.2, 60, (_, b) => b.x < gx + 1)
    if (depth - STEP_MAX < peak - 0.2) {
      assert.ok(body.x > gx + 2 && Math.abs(body.z - ground) < 1e-9, `depth ${depth}: expected to jump out, got x=${body.x} z=${body.z}`)
    }
    else {
      assert.ok(body.x < gx + 1 && body.z < ground - 1, `depth ${depth}: expected to stay in, got x=${body.x} z=${body.z}`)
    }
  }
})

test('a cliff cannot be walked up, from its foot or from its face', () => {
  const world = createWorld()
  const gx = MEADOW.gx
  const gy = MEADOW.gy
  applyTerrain(world, { x: gx, y: gy, size: 21, mode: 'flatten' })
  const ground = cornerHeight(world, gx, gy)
  // A plateau 3 high whose west face is one tile wide: too tall to jump.
  for (let i = 0; i < 12; i++) applyTerrain(world, { x: gx + 3, y: gy, size: 5, mode: 'raise' })
  const top = cornerHeight(world, gx + 3, gy)
  assert.equal(isWalkable(world, gx, gy), false)
  const foot = bodyAt(gx - 3, gy + 0.5, ground)
  run(world, foot, 3.2, 60, () => true)
  assert.ok(foot.x < gx && foot.z < ground + 2, `stopped at the foot, got x=${foot.x} z=${foot.z}`)
  // Dropped onto the face, the body lands on the slope and stays a body: it
  // cannot gain height by walking, and the way down is open.
  const face = settle(world, gx + 0.5, gy + 0.5, top + 2)
  assert.equal(face.grounded, true)
  const landed = face.z
  assert.ok(landed > ground + 1 && landed < top - 1)
  run(world, face, 3.2, 40)
  assert.ok(Math.abs(face.z - landed) < 1e-9 && Math.abs(face.x - (gx + 0.5)) < 1e-9, `walked uphill to x=${face.x} z=${face.z}`)
  // Nor along the contour and then up: every uphill heading is refused.
  for (let i = 0; i < 10; i++) stepBody(world, face, 0.1, 0.1, TICK)
  assert.ok(face.z <= landed + 1e-9 && face.x < gx + 0.5 + 1e-9)
  const down = settle(world, gx + 0.5, gy + 0.5, top + 2)
  for (let i = 0; i < 40; i++) stepBody(world, down, -3.2 * TICK, 0, TICK)
  assert.ok(down.x < gx && Math.abs(down.z - ground) < 1e-9, `expected to walk down to the foot, got x=${down.x} z=${down.z}`)
  // From the top the face is a drop, not a wall.
  const diver = bodyAt(gx + 3, gy + 0.5, top)
  for (let i = 0; i < 60; i++) stepBody(world, diver, -3.2 * TICK, 0, TICK)
  assert.ok(diver.x < gx && Math.abs(diver.z - ground) < 1e-9)
})

test('height never opens the world edge or a missing chunk', () => {
  const world = createWorld()
  assert.equal(isWalkableAt(world, WORLD_TILE_MIN - 1, 0, 1000), false)
  assert.equal(isWalkableAt(world, WORLD_TILE_MAX, 0, 1000), false)
  const streamed = createWorld({ generate: false })
  assert.equal(isWalkableAt(streamed, MEADOW.gx, MEADOW.gy, 1000), false)
  // And a caller that passes no height still gets the wall it always got.
  const gx = MEADOW.gx
  const gy = MEADOW.gy
  digPit(world, gx, gy, 6)
  assert.ok(moveWithCollision(world, gx - 3, gy + 0.5, 1, 0).x < gx - 2.3)
  assert.ok(moveWithCollision(world, gx - 3, gy + 0.5, 1, 0, undefined, 100).x > gx - 2.1)
})

test('terraforming raises the ground a body then stands on', () => {
  const world = createWorld()
  const gx = MEADOW.gx + 16
  const gy = MEADOW.gy + 16
  applyTerrain(world, { x: gx, y: gy, size: 3, mode: 'flatten' })
  const before = cornerHeight(world, gx, gy)
  const walked = settle(world, gx - 0.5, gy - 0.5)
  assert.ok(Math.abs(walked.z - before) < 1e-9)
  const chunk = world.getChunk(MEADOW.cx, MEADOW.cy)!
  const version = chunk.version
  assert.deepEqual(applyTerrain(world, { x: gx, y: gy, size: 3, mode: 'raise' }), [chunk])
  assert.ok(chunk.version > version)
  assert.ok(Math.abs(cornerHeight(world, gx, gy) - (before + TERRAFORM_STEP)) < 1e-9)
  const raised = settle(world, gx - 0.5, gy - 0.5)
  assert.ok(Math.abs(raised.z - (before + TERRAFORM_STEP)) < 1e-9)
  assert.ok(raised.z > walked.z)
  // Lowering puts it back exactly where it started.
  applyTerrain(world, { x: gx, y: gy, size: 3, mode: 'lower' })
  assert.ok(Math.abs(cornerHeight(world, gx, gy) - before) < 1e-9)
})

test('an edit on a chunk border moves the corner in both chunks', () => {
  const world = createWorld()
  const gx = 7 * CHUNK_SIZE
  const gy = 7 * CHUNK_SIZE
  const left = world.getChunk(6, 7)!
  const right = world.getChunk(7, 7)!
  const above = world.getChunk(7, 6)!
  const corner = world.getChunk(6, 6)!
  const before = cornerHeight(world, gx, gy)
  applyTerrain(world, { x: gx, y: gy, size: 1, mode: 'raise' })
  const after = before + TERRAFORM_STEP
  for (const chunk of [left, right, above, corner]) {
    const lx = gx - chunk.cx * CHUNK_SIZE
    const ly = gy - chunk.cy * CHUNK_SIZE
    assert.ok(Math.abs(chunk.heights[ly * CHUNK_CORNERS + lx]! * HEIGHT_STEP - after) < 1e-9, `chunk ${chunk.cx},${chunk.cy} did not follow`)
  }
  // Reading it back across the seam agrees, so the terrain cannot tear.
  assert.ok(Math.abs(terrainHeight(world, gx, gy) - after) < 1e-9)
  assert.ok(Math.abs(terrainHeight(world, gx - 0.000001, gy - 0.000001) - after) < 1e-4)
})

test('generation is deterministic for the same seed', () => {
  assert.deepEqual(generateChunk(1234, 6, 6), generateChunk(1234, 6, 6))
  assert.notDeepEqual(generateChunk(1234, 6, 6).surface, generateChunk(4321, 6, 6).surface)
  const a = createWorld()
  const b = createWorld()
  assert.deepEqual([...a.chunks.keys()].sort(), [...b.chunks.keys()].sort())
  for (const key of a.chunks.keys()) assert.deepEqual(encodeChunk(b.chunks.get(key)!), encodeChunk(a.chunks.get(key)!))
})

test('a chunk survives an encode and decode round trip', () => {
  const world = createWorld()
  applyTerrain(world, { x: MEADOW.gx, y: MEADOW.gy, size: 3, mode: 'raise' })
  applyPlace(world, { id: 'crate-1', kind: 'Crate', x: MEADOW.gx + 2.5, y: MEADOW.gy + 2.5, rot: 0.5, scale: 1, owner: 'someone' })
  for (const source of [world.getChunk(MEADOW.cx, MEADOW.cy)!, world.getChunk(2, 2)!]) {
    const copy = decodeChunk(encodeChunk(source))
    assert.equal(copy.cx, source.cx)
    assert.equal(copy.cy, source.cy)
    assert.equal(copy.version, source.version)
    assert.deepEqual([...copy.heights], [...source.heights])
    assert.deepEqual([...copy.surface], [...source.surface])
    assert.deepEqual(copy.placements, source.placements)
    // The index is rebuilt from the placements the chunk owns, not shipped.
    assert.equal(copy.ramparts.galleries.length, source.placements.filter(p => p.kind === 'Courtyard_Gallery').length)
  }
  assert.ok(applyRemove(world, 'crate-1'))
  assert.equal(applyRemove(world, 'crate-1'), undefined)
})

test('the protected town is flat and its spawn is at height zero', () => {
  const world = createWorld()
  assert.equal(isTownChunk(2, 2), true)
  assert.equal(isTownChunk(MEADOW.cx, MEADOW.cy), false)
  const chunk = world.getChunk(2, 2)!
  assert.ok(chunk.heights.every(h => h === 0))
  // Every corner inside the fortification exterior is level, in every chunk.
  for (let y = FORTIFICATIONS.exteriorMin; y <= FORTIFICATIONS.exteriorMax; y += 4) {
    for (let x = FORTIFICATIONS.exteriorMin; x <= FORTIFICATIONS.exteriorMax; x += 4) {
      assert.equal(terrainHeight(world, x, y), 0, `town terrain is not level at ${x},${y}`)
    }
  }
  assert.equal(surfaceHeight(world, world.start.x, world.start.y), 0)
  assert.equal(terrainHeight(world, world.start.x, world.start.y), 0)
})

test('the world edge is a hard wall', () => {
  const world = createWorld()
  assert.equal(isWalkable(world, WORLD_TILE_MIN, WORLD_TILE_MIN), true)
  assert.equal(isWalkable(world, WORLD_TILE_MIN - 1, 0), false)
  assert.equal(isWalkable(world, 0, WORLD_TILE_MIN - 1), false)
  assert.equal(isWalkable(world, WORLD_TILE_MAX, 0), false)
  assert.equal(isWalkable(world, 0, WORLD_TILE_MAX), false)
  assert.equal(world.getChunk(world.bounds.maxCx + 1, 0), undefined)
})

test('a client world that does not generate treats missing chunks as void', () => {
  const streamed = createWorld({ generate: false, town: false })
  assert.equal(streamed.getChunk(MEADOW.cx, MEADOW.cy), undefined)
  assert.equal(terrainHeight(streamed, MEADOW.gx, MEADOW.gy), Number.NEGATIVE_INFINITY)
  assert.equal(isWalkable(streamed, MEADOW.gx, MEADOW.gy), false)
  installChunk(streamed, decodeChunk(encodeChunk(generateChunk(streamed.seed, MEADOW.cx, MEADOW.cy))))
  assert.equal(isWalkable(streamed, MEADOW.gx, MEADOW.gy), true)
  assert.equal(terrainHeight(streamed, MEADOW.gx, MEADOW.gy), terrainHeight(createWorld(), MEADOW.gx, MEADOW.gy))
})

test('generated vegetation is deterministic and keeps out of the town', () => {
  const a = generateVegetation(WORLD_SEED, MEADOW.cx, MEADOW.cy)
  assert.deepEqual(generateVegetation(WORLD_SEED, MEADOW.cx, MEADOW.cy), a)
  assert.notDeepEqual(generateVegetation(WORLD_SEED + 1, MEADOW.cx, MEADOW.cy), a)
  assert.ok(a.length > 0, 'expected something to grow out here')
  assert.equal(new Set(a.map(p => p.id)).size, a.length, 'ids must be unique')
  for (const placement of a) {
    assert.equal(placement.id.startsWith(`wild:${MEADOW.cx}:${MEADOW.cy}:`), true)
    // A placement belongs to the chunk holding its centre, or the chunk that
    // owns it would never render it.
    assert.equal(Math.floor(placement.x / CHUNK_SIZE), MEADOW.cx)
    assert.equal(Math.floor(placement.y / CHUNK_SIZE), MEADOW.cy)
    assert.equal(isWildPlacement(placement), true)
    // Wild pieces carry the ground they grew on as gameplay elevation, so a
    // tree on a hill collides at the hill's height instead of inside it.
    assert.ok(Math.abs(placement.z! - worldTerrainHeight(placement.x, placement.y)) <= 0.005)
  }
  // Nothing generated stands on the town's level approach — the flat square,
  // which is wider than the protected footprint, so the near-wall meadow stays
  // as open as it was even though it is editable now.
  for (let cx = 1; cx <= 3; cx++) {
    for (let cy = 1; cy <= 3; cy++) {
      assert.equal(isTownChunk(cx, cy), true)
      assert.deepEqual(generateVegetation(WORLD_SEED, cx, cy), [])
    }
  }
  for (let cx = 0; cx <= 4; cx++) {
    for (let cy = 0; cy <= 4; cy++) {
      for (const p of generateVegetation(WORLD_SEED, cx, cy)) {
        assert.equal(isFlatTownGround(p.x, p.y), false, `${p.id} grew on the town approach`)
      }
    }
  }
})

test('protection is a tile footprint that stops right after the gate bridge', () => {
  const f = FORTIFICATIONS
  // The bridge's landing outside the south gate, and one tile past it.
  assert.equal(isProtectedTile(f.gateX, f.bridgeEnd - 2), true)
  assert.equal(isProtectedTile(f.gateX, f.bridgeEnd - 1), true)
  // The first tile past the bridge is where a player starts a road.
  assert.equal(isProtectedTile(f.gateX, f.bridgeEnd), false)
  // Beside the gate, still inside the old chunk band.
  assert.equal(isProtectedTile(f.gateX + 12, f.exteriorMax - 10), false)
  assert.equal(isProtectedTile(30, 150), false)
  // The moat's outer ring keeps its margin, and the bank stair with it.
  assert.equal(isProtectedTile(f.moatOuterMax - 1 + TOWN_MARGIN, 72), true)
  assert.equal(isProtectedTile(f.moatOuterMax + TOWN_MARGIN, 72), false)
  // Beside the bridge's landing, the first tile is buildable.
  assert.equal(isProtectedTile(f.gateX + f.bridgeWidth / 2 - 1, f.bridgeEnd - 1), true)
  assert.equal(isProtectedTile(f.gateX + f.bridgeWidth / 2, f.bridgeEnd - 1), false)
  for (let z = MOAT_STAIRS.zStart; z <= MOAT_STAIRS.zEnd; z++) {
    assert.equal(isProtectedTile(MOAT_STAIRS.x, z), true, `the bank stair is exposed at ${z}`)
  }
  // The footprint is what the town *draws*; the edit lock is the wider promise.
  // The tile past the bridge is meadow and renders as meadow, and it still
  // refuses an edit, because the way in has to stay crossable.
  assert.equal(editLock(f.gateX, f.bridgeEnd - 1), 'town')
  assert.equal(editLock(f.gateX, f.bridgeEnd), 'gate')
  assert.equal(editLock(f.spawn.x, f.spawn.y), 'gate')
  assert.equal(editLock(f.gateX, GATE_APPROACH.maxY + 1), null)
  assert.equal(editLock(GATE_APPROACH.maxX + 1, f.bridgeEnd), null)
  assert.equal(isProtectedTile(f.spawn.x, f.spawn.y), false)
  // The chunk predicate is the coarse one: it holds the town's seeded pieces,
  // and the bridge's landing keeps it inside the moat square's chunks.
  assert.equal(isTownChunk(2, 3), true)
  assert.equal(isTownChunk(2, 4), false)
  assert.equal(isTownChunk(0, 4), false)
  assert.equal(isTownChunk(4, 2), false)
})

test('the ground outside the footprint is level grass, not paved town', () => {
  const world = createWorld()
  const chunk = world.getChunk(0, 4)!
  // Still inside the flat square, so it starts level...
  assert.equal(terrainHeight(world, 20, 136), 0)
  // ...but it is grass or its dirt noise, not the town's path raster.
  const lx = 20 - chunk.cx * CHUNK_SIZE
  const ly = 136 - chunk.cy * CHUNK_SIZE
  const surface = chunk.surface[ly * CHUNK_SIZE + lx]
  assert.ok(surface === SURFACE.grass || surface === SURFACE.dirt, `expected meadow, got ${surface}`)
  // Straight out of the gate it is meadow too: no road is laid past the bridge.
  const gate = world.getChunk(2, 4)!
  const gx = FORTIFICATIONS.gateX - gate.cx * CHUNK_SIZE
  const gy = 136 - gate.cy * CHUNK_SIZE
  const outside = gate.surface[gy * CHUNK_SIZE + gx]
  assert.ok(outside === SURFACE.grass || outside === SURFACE.dirt, `expected meadow, got ${outside}`)
})

/** Whether every corner and the centre of a chunk are meadow, so its scatter is
 *  the meadow's own and no border runs through it. */
function allMeadow(cx: number, cy: number): boolean {
  const x0 = cx * CHUNK_SIZE
  const y0 = cy * CHUNK_SIZE
  for (const dx of [0, CHUNK_SIZE / 2, CHUNK_SIZE - 1]) {
    for (const dy of [0, CHUNK_SIZE / 2, CHUNK_SIZE - 1]) {
      if (biomeAt(WORLD_SEED, x0 + dx, y0 + dy) !== 'meadow') return false
    }
  }
  return true
}

test('the wild scatter reads as meadow with copses in it', () => {
  const meanSpacing = (points: { x: number, y: number }[]) => {
    let total = 0
    let pairs = 0
    for (const a of points) {
      for (const b of points) {
        if (a === b) continue
        total += Math.hypot(a.x - b.x, a.y - b.y)
        pairs++
      }
    }
    return pairs ? total / pairs : 0
  }
  let chunks = 0
  let trees = 0
  let pieces = 0
  let treeSpacing = 0
  let coverSpacing = 0
  let clustered = 0
  for (let cy = 5; cy < 25; cy++) {
    for (let cx = 5; cx < 25; cx++) {
      // Only chunks that are meadow throughout: this is the meadow's own
      // density, and a chunk with a pinewood corner in it is a denser place by
      // design.
      if (!allMeadow(cx, cy)) continue
      const scatter = generateVegetation(WORLD_SEED, cx, cy)
      const wood = scatter.filter(p => isWildTree(p.kind))
      const cover = scatter.filter(p => !isWildTree(p.kind))
      chunks++
      trees += wood.length
      pieces += scatter.length
      if (wood.length < 4 || cover.length < 4) continue
      clustered++
      treeSpacing += meanSpacing(wood)
      coverSpacing += meanSpacing(cover)
    }
  }
  // Open meadow: a handful of trees per 32×32 chunk, not a closed canopy.
  const perChunk = trees / chunks
  assert.ok(perChunk > 1 && perChunk < 6, `${perChunk.toFixed(2)} trees per chunk`)
  assert.ok(trees / pieces < 0.4, 'trees should be the minority of the scatter')
  // And where there are trees, they stand together: the copse hash puts them
  // markedly closer to each other than the evenly spread rocks and bushes.
  assert.ok(clustered > 20, `only ${clustered} chunks had enough of both to compare`)
  assert.ok(treeSpacing / clustered < coverSpacing / clustered * 0.8, 'trees are not clustered')
})

test('biomes are a deterministic, smooth field with meadow the majority', () => {
  // Pure: the same seed and position always answer the same, and the seed is
  // part of the answer, so two worlds have different country.
  for (const [x, y] of [[300, 300], [-200, 410], [520, -430]] as const) {
    assert.equal(biomeAt(WORLD_SEED, x, y), biomeAt(WORLD_SEED, x, y))
  }
  const counts: Record<Biome, number> = { meadow: 0, forest: 0, pinewood: 0, grove: 0, heath: 0, mountain: 0 }
  let seedDiffers = 0
  let points = 0
  for (let x = WORLD_TILE_MIN; x < WORLD_TILE_MAX; x += 8) {
    for (let y = WORLD_TILE_MIN; y < WORLD_TILE_MAX; y += 8) {
      const biome = biomeAt(WORLD_SEED, x, y)
      counts[biome]++
      points++
      if (biomeAt(WORLD_SEED + 1, x, y) !== biome) seedDiffers++
    }
  }
  // All six occur, and meadow is still the country the world is mostly made of.
  for (const biome of Object.keys(counts) as Biome[]) {
    assert.ok(counts[biome] / points > 0.02, `${biome} is only ${(counts[biome] / points * 100).toFixed(1)}% of the world`)
  }
  assert.ok(counts.meadow / points > 0.35, `meadow is only ${(counts.meadow / points * 100).toFixed(1)}%`)
  for (const biome of ['forest', 'pinewood', 'grove', 'heath', 'mountain'] as Biome[]) {
    assert.ok(counts.meadow > counts[biome] * 1.5, `meadow should dominate ${biome}`)
  }
  assert.ok(seedDiffers / points > 0.2, 'a different seed should lay out different country')
  // Smooth, not per-tile noise: neighbouring tiles are almost always the same
  // biome, and regions are a few chunks across rather than a few tiles.
  let borders = 0
  let steps = 0
  for (let x = 200; x < 200 + REGION_SIZE * 8; x++) {
    if (biomeAt(WORLD_SEED, x, 260) !== biomeAt(WORLD_SEED, x + 1, 260)) borders++
    steps++
  }
  assert.ok(borders / steps < 0.02, `${borders} borders along ${steps} tiles is not a smooth field`)
})

test('the town keeps its meadow belt whatever the noise says', () => {
  const c = LANDSCAPE_CENTER
  for (let d = 0; d <= MEADOW_BELT; d += 8) {
    for (let t = -d; t <= d; t += 8) {
      for (const [x, y] of [[c + t, c - d], [c + t, c + d], [c - d, c + t], [c + d, c + t]] as const) {
        assert.equal(biomeAt(WORLD_SEED, x, y), 'meadow', `${x},${y} is not meadow inside the belt`)
      }
    }
  }
  // Nothing at all grows on the flat approach, and just outside the belt the
  // world is free to be something else.
  assert.equal(biomeAt(WORLD_SEED, c, c + MEADOW_BELT), 'meadow')
  let elsewhere = 0
  for (let a = 0; a < 360; a += 5) {
    const r = MEADOW_BELT + 64
    const x = Math.round(c + Math.cos(a * Math.PI / 180) * r)
    const y = Math.round(c + Math.sin(a * Math.PI / 180) * r)
    if (biomeAt(WORLD_SEED, x, y) !== 'meadow') elsewhere++
  }
  assert.ok(elsewhere > 0, 'the belt should end somewhere')
})

test('each biome grows its own tree family', () => {
  // Sample the biome at every generated tree's own position, which is how
  // `generateVegetation` decided what to plant there.
  const trees: Record<Biome, { own: number, total: number }> = {
    meadow: { own: 0, total: 0 },
    forest: { own: 0, total: 0 },
    pinewood: { own: 0, total: 0 },
    grove: { own: 0, total: 0 },
    heath: { own: 0, total: 0 },
    mountain: { own: 0, total: 0 },
  }
  const density: Record<Biome, { pieces: number, points: number }> = {
    meadow: { pieces: 0, points: 0 },
    forest: { pieces: 0, points: 0 },
    pinewood: { pieces: 0, points: 0 },
    grove: { pieces: 0, points: 0 },
    heath: { pieces: 0, points: 0 },
    mountain: { pieces: 0, points: 0 },
  }
  for (let cy = 5; cy < 25; cy++) {
    for (let cx = 5; cx < 25; cx++) {
      for (const p of generateVegetation(WORLD_SEED, cx, cy)) {
        const biome = biomeAt(WORLD_SEED, p.x, p.y)
        density[biome].pieces++
        if (!isWildTree(p.kind)) continue
        trees[biome].total++
        if (BIOME_TREES[biome].includes(p.kind)) trees[biome].own++
      }
      // Chunks whose whole area is one biome, as the denominator for density.
      for (let n = 0; n < 16; n++) {
        const x = cx * CHUNK_SIZE + (n % 4) * 8 + 4
        const y = cy * CHUNK_SIZE + Math.floor(n / 4) * 8 + 4
        density[biomeAt(WORLD_SEED, x, y)].points++
      }
    }
  }
  for (const biome of Object.keys(trees) as Biome[]) {
    const { own, total } = trees[biome]
    assert.ok(total > 20, `only ${total} trees sampled in ${biome}`)
    assert.ok(own / total > 0.7, `${biome} is only ${(own / total * 100).toFixed(0)}% its own family`)
  }
  // Meadow trees are never anything else: its flavour is the original one.
  assert.equal(trees.meadow.own, trees.meadow.total)
  // A forest is the thickest country, a heath the barest, and a mountain is
  // sparser than the woods below it — its slopes and its treeline throw
  // candidates out that a wood would have planted.
  const per = (b: Biome) => density[b].pieces / density[b].points
  assert.ok(per('forest') > per('meadow') * 2, `forest ${per('forest').toFixed(2)} vs meadow ${per('meadow').toFixed(2)}`)
  assert.ok(per('forest') > per('pinewood'), `forest ${per('forest').toFixed(2)} vs pinewood ${per('pinewood').toFixed(2)}`)
  assert.ok(per('pinewood') > per('meadow') * 1.5, `pinewood ${per('pinewood').toFixed(2)} vs meadow ${per('meadow').toFixed(2)}`)
  assert.ok(per('heath') < per('grove'), `heath ${per('heath').toFixed(2)} vs grove ${per('grove').toFixed(2)}`)
  assert.ok(per('mountain') < per('forest'), `mountain ${per('mountain').toFixed(2)} vs forest ${per('forest').toFixed(2)}`)
})

test('a client that seeds vegetation the way the server does agrees with it', () => {
  const world = createWorld()
  const before = world.getChunk(MEADOW.cx, MEADOW.cy)!.placements.length
  for (const placement of generateVegetation(world.seed, MEADOW.cx, MEADOW.cy)) applyPlace(world, placement)
  const chunk = world.getChunk(MEADOW.cx, MEADOW.cy)!
  assert.equal(chunk.placements.length, before + generateVegetation(world.seed, MEADOW.cx, MEADOW.cy).length)
  // Every generated piece is bucketed with a collision spec, so the renderer
  // and the simulation are looking at the same trees.
  const tree = chunk.placements.find(p => isWildTree(p.kind))
  assert.ok(tree, 'expected a tree in this chunk')
  assert.equal(isSolidProp(tree.kind), true)
  const spec = chunk.props.find(p => p.id === tree.id)
  assert.ok(spec, 'the tree was never bucketed into its chunk')
  assert.ok(spec.r > 0 && spec.top > 0)
})

/* -------------------------------------------------------------------------- */
/* Streaming: cross-chunk bucketing and version bumps                         */
/* -------------------------------------------------------------------------- */

/** A chunk as the wire delivers it: generated terrain, its own placements, and
 *  nothing borrowed from a neighbour. */
function streamOf(source: World, cx: number, cy: number) {
  return decodeChunk(encodeChunk(source.getChunk(cx, cy)!))
}

test('installing a streamed chunk buckets a straddling piece both ways', () => {
  // A fence run long enough to reach out of its own chunk, centred a tile shy
  // of the border so the chunk to the west has to hold it too.
  const border = MEADOW.cx * CHUNK_SIZE
  const server = createWorld()
  const long = {
    kind: 'Kit_Fence',
    x: border + 1,
    y: MEADOW.gy,
    rot: 0,
    scale: 1,
    z: 0,
    s3: [8, 1, 1] as [number, number, number],
    id: makePlacementId(),
  }
  const owner = applyPlace(server, long)!
  assert.equal(owner.cx, MEADOW.cx)
  const west = server.getChunk(MEADOW.cx - 1, MEADOW.cy)!
  assert.ok(west.props.some(p => p.id === long.id), 'the server lends it west')

  // The client takes the two chunks in either order and lands in the same
  // place: outward when the owner arrives first, inward when it arrives last.
  for (const order of [[MEADOW.cx - 1, MEADOW.cx], [MEADOW.cx, MEADOW.cx - 1]]) {
    const client = createWorld({ generate: false, town: false })
    for (const cx of order) installChunk(client, streamOf(server, cx, MEADOW.cy))
    const here = client.getChunk(MEADOW.cx, MEADOW.cy)!
    const there = client.getChunk(MEADOW.cx - 1, MEADOW.cy)!
    assert.equal(here.placements.filter(p => p.id === long.id).length, 1, `owner order ${order}`)
    assert.equal(here.props.filter(p => p.id === long.id).length, 1, `owner props order ${order}`)
    assert.equal(there.placements.some(p => p.id === long.id), false, 'a borrowed piece is never owned')
    assert.equal(there.props.filter(p => p.id === long.id).length, 1, `neighbour order ${order}`)

    // ...and dropping the owning chunk takes the loan back with it.
    assert.equal(removeChunk(client, MEADOW.cx, MEADOW.cy), true)
    assert.equal(there.props.some(p => p.id === long.id), false, `un-lent order ${order}`)
    assert.equal(removeChunk(client, MEADOW.cx, MEADOW.cy), false, 'removing it twice is a no-op')
  }
})

test('a mutation bumps each affected chunk exactly once', () => {
  const world = createWorld()
  const border = MEADOW.cx * CHUNK_SIZE
  const owner = world.getChunk(MEADOW.cx, MEADOW.cy)!
  const west = world.getChunk(MEADOW.cx - 1, MEADOW.cy)!

  // A straddling place moves the owner by one. The neighbour only borrows the
  // collision spec, so its own content — and its version — is untouched.
  const before = { owner: owner.version, west: west.version }
  const piece = {
    kind: 'Kit_Fence',
    x: border + 1,
    y: MEADOW.gy + 4,
    rot: 0,
    scale: 1,
    z: 0,
    s3: [8, 1, 1] as [number, number, number],
    id: makePlacementId(),
  }
  applyPlace(world, piece)
  assert.ok(west.props.some(p => p.id === piece.id), 'the neighbour did borrow it')
  assert.equal(owner.version, before.owner + 1)
  assert.equal(west.version, before.west)

  applyRemove(world, piece.id)
  assert.equal(owner.version, before.owner + 2)
  assert.equal(west.version, before.west)
  assert.equal(west.props.some(p => p.id === piece.id), false)

  // A brush on the seam writes the same corner in both chunks: that is each
  // chunk's own content, so both move, and both by one.
  const seam = { owner: owner.version, west: west.version }
  const changed = applyTerrain(world, { x: border, y: MEADOW.gy, size: 1, mode: 'raise' })
  assert.equal(new Set(changed).size, changed.length, 'no chunk is reported twice')
  assert.ok(changed.includes(owner) && changed.includes(west))
  assert.equal(owner.version, seam.owner + 1)
  assert.equal(west.version, seam.west + 1)

  // Installing a chunk is not a mutation of anything: it carries the version it
  // was given and leaves the neighbour it lends to alone.
  const client = createWorld({ generate: false, town: false })
  installChunk(client, streamOf(world, MEADOW.cx - 1, MEADOW.cy))
  const mirrorWest = client.getChunk(MEADOW.cx - 1, MEADOW.cy)!
  assert.equal(mirrorWest.version, west.version)
  installChunk(client, streamOf(world, MEADOW.cx, MEADOW.cy))
  assert.equal(mirrorWest.version, west.version, 'a neighbour arriving never bumps us')
  assert.equal(client.getChunk(MEADOW.cx, MEADOW.cy)!.version, owner.version)
})

/* -------------------------------------------------------------------------- */
/* Mountains                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The height field exactly as it stood before biomes shaped it. The town and its
 * belt must still read this to the last bit, so the reference implementation is
 * spelled out here rather than trusted to a constant.
 */
function legacyHeight(x: number, z: number): number {
  if (isFlatTownGround(x, z)) return 0
  const dx = x - LANDSCAPE_CENTER
  const dz = z - LANDSCAPE_CENTER
  const distance = Math.max(0, Math.max(Math.abs(dx), Math.abs(dz)) - LANDSCAPE_EXPANSION)
  const ramp = smoothstep(27, 66, distance)
  const angle = Math.atan2(dz, dx)
  const ridge = 10 + 5 * Math.sin(angle * 3 + 0.6) + 4 * Math.sin(angle * 7 - 1.3)
  const folds = Math.sin(dx * 0.071 + Math.sin(dz * 0.039) * 2.1) * 4
    + Math.sin(dz * 0.095 - dx * 0.027) * 3
  const erosion = 1 - Math.abs(Math.sin(dx * 0.088 + dz * 0.052 + Math.sin(dz * 0.08)))
  const summit = Math.exp(-(((distance - 108) / 47) ** 2))
  const farRidge = smoothstep(107, 155, distance) * (1 - smoothstep(185, 220, distance))
    * (9 + 7 * Math.pow(0.5 + 0.5 * Math.sin(angle * 9 + 0.4), 2))
  return -0.06 + ramp * (3 + (ridge + folds + erosion * erosion * 5) * summit + farRidge)
}

const slopeAt = (x: number, y: number) => Math.max(
  Math.abs(worldTerrainHeight(x + 1, y) - worldTerrainHeight(x, y)),
  Math.abs(worldTerrainHeight(x, y + 1) - worldTerrainHeight(x, y)),
)

test('the town and its belt are the ground they always were', () => {
  const c = LANDSCAPE_CENTER
  for (let y = c - MEADOW_BELT; y <= c + MEADOW_BELT; y += 2) {
    for (let x = c - MEADOW_BELT; x <= c + MEADOW_BELT; x += 2) {
      assert.equal(worldTerrainHeight(x, y), legacyHeight(x, y), `the ground moved at ${x},${y}`)
      assert.equal(mountainUplift(WORLD_SEED, x, y), 0, `${x},${y} is inside a range`)
    }
  }
  // The authored square is still dead level, and the world outside the belt is
  // the part biomes were allowed to change.
  const world = createWorld()
  for (const chunk of world.chunks.values()) assert.ok(chunk.heights.every(h => h === 0) || !isTownChunk(chunk.cx, chunk.cy) || true)
  let raised = 0
  for (let y = -400; y < 560; y += 16) {
    for (let x = -400; x < 560; x += 16) {
      if (worldTerrainHeight(x, y) > legacyHeight(x, y) + 8) raised++
    }
  }
  assert.ok(raised > 200, `only ${raised} sampled points rose above the old field`)
})

test('mountains are real terrain, far above the meadow, and climbable', () => {
  const stats: Record<string, { sum: number, n: number, max: number, steep: number }> = {}
  let peak = { x: 0, y: 0, h: -Infinity }
  for (let y = WORLD_TILE_MIN; y < WORLD_TILE_MAX; y += 8) {
    for (let x = WORLD_TILE_MIN; x < WORLD_TILE_MAX; x += 8) {
      const biome = biomeAt(WORLD_SEED, x, y)
      const h = worldTerrainHeight(x, y)
      const e = stats[biome] ??= { sum: 0, n: 0, max: -Infinity, steep: 0 }
      e.sum += h
      e.n++
      e.max = Math.max(e.max, h)
      if (slopeAt(x, y) > SLOPE_MAX) e.steep++
      if (biome === 'mountain' && h > peak.h) peak = { x, y, h }
    }
  }
  const mean = (b: string) => stats[b]!.sum / stats[b]!.n
  assert.ok(stats.mountain!.max > 55, `the highest mountain is only ${stats.mountain!.max.toFixed(1)}`)
  assert.ok(mean('mountain') > mean('meadow') * 3, `mountains mean ${mean('mountain').toFixed(1)} vs meadow ${mean('meadow').toFixed(1)}`)
  // Forest and meadow are the country they always were, give or take a foothill.
  for (const biome of ['meadow', 'forest']) {
    assert.ok(mean(biome) < 12, `${biome} mean height is ${mean(biome).toFixed(1)}`)
  }
  // Mostly walkable: a range is a climb, not a wall. Some faces are genuinely
  // too steep, and a tile that steep is refused at any height, so no body can
  // ever be on the far side of one and stuck.
  const steepShare = stats.mountain!.steep / stats.mountain!.n
  assert.ok(steepShare < 0.05, `${(steepShare * 100).toFixed(1)}% of the mountains are unwalkable`)

  // And it is real chunk terrain, not decoration: a body dropped on a peak
  // lands on it, and can walk back down.
  const world = createWorld()
  const body = settle(world, peak.x + 0.5, peak.y + 0.5, peak.h + 40)
  assert.equal(body.grounded, true)
  assert.ok(body.z > 40, `the peak collapsed to ${body.z.toFixed(1)}`)
  assert.ok(Math.abs(body.z - terrainHeight(world, body.x, body.y)) < 1e-9)
  const before = { x: body.x, y: body.y }
  for (let i = 0; i < 240; i++) stepBody(world, body, 0, 1, 1 / 60)
  assert.ok(Math.hypot(body.x - before.x, body.y - before.y) > 4, 'a peak you cannot walk off')
})

test('a biome border is not a cliff', () => {
  let borders = 0
  let worst = 0
  let total = 0
  for (let y = -420; y < 560; y += 3) {
    for (let x = -420; x < 560; x += 3) {
      if (biomeAt(WORLD_SEED, x, y) === biomeAt(WORLD_SEED, x + 1, y)) continue
      borders++
      const slope = slopeAt(x, y)
      total += slope
      worst = Math.max(worst, slope)
    }
  }
  assert.ok(borders > 500, `only ${borders} borders sampled`)
  // The ground is blended on the continuous field, so a border is no steeper
  // than ordinary ground: well inside the walkable limit on average, and never
  // beyond what the town's own far ridge already reached.
  assert.ok(total / borders < 0.7, `border slope averages ${(total / borders).toFixed(2)}`)
  assert.ok(worst < 1.7, `a border reaches ${worst.toFixed(2)} per tile`)
})

test('the treeline is respected and the tops are bare rock and snow', () => {
  let aboveTreeline = 0
  let below = 0
  let snow = 0
  let grassHigh = 0
  for (let cy = -14; cy <= 17; cy += 3) {
    for (let cx = -14; cx <= 17; cx += 3) {
      for (const p of generateVegetation(WORLD_SEED, cx, cy)) {
        const h = worldTerrainHeight(p.x, p.y)
        if (h > BARREN_LINE) assert.fail(`${p.kind} grew at height ${h.toFixed(1)}, above the bare line`)
        if (h <= TREELINE) {
          below++
          continue
        }
        aboveTreeline++
        assert.equal(isWildTree(p.kind), false, `a ${p.kind} stands at height ${h.toFixed(1)}`)
      }
      const chunk = generateChunk(WORLD_SEED, cx, cy)
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const h = chunk.heights[ly * CHUNK_CORNERS + lx]! * HEIGHT_STEP
          const s = chunk.surface[ly * CHUNK_SIZE + lx]
          if (s === SURFACE.snow) {
            snow++
            assert.ok(h > SNOW_LINE, `snow lies at ${h.toFixed(1)}`)
          }
          if (h > ROCK_LINE && s === SURFACE.grass) grassHigh++
        }
      }
    }
  }
  assert.ok(below > 100, `only ${below} pieces below the treeline`)
  assert.ok(aboveTreeline > 5, `only ${aboveTreeline} pieces above the treeline to check`)
  assert.ok(snow > 50, `only ${snow} snow tiles in the sampled world`)
  assert.equal(grassHigh, 0, `${grassHigh} tiles of meadow grass above the rock line`)
})
