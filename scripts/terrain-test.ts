// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/terrain-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { isWalkable, stepBody, surfaceHeight, terrainHeight, SLOPE_MAX } from '../shared/utils/maze'
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
  encodeChunk,
  generateChunk,
  installChunk,
  isProtectedTile,
  isTownChunk,
  makePlacementId,
  removeChunk,
  SURFACE,
  WORLD_SEED,
} from '../shared/utils/world'
import { generateVegetation, isWildPlacement } from '../shared/utils/vegetation'
import { isSolidProp } from '../shared/utils/props'
import type { World } from '../shared/utils/world'
import { isFlatTownGround, worldTerrainHeight } from '../shared/utils/terrain'
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

test('protection is a tile footprint that stops right after the gate road', () => {
  const f = FORTIFICATIONS
  // The road out of the south gate, and one tile past its end.
  assert.equal(isProtectedTile(f.gateX, f.exteriorMax - 2), true)
  assert.equal(isProtectedTile(f.gateX, f.exteriorMax - 1), true)
  // The first tile past the visible road is where a player continues it.
  assert.equal(isProtectedTile(f.gateX, f.exteriorMax), false)
  // Beside the road, still inside the old chunk band.
  assert.equal(isProtectedTile(f.gateX + 12, f.exteriorMax - 10), false)
  assert.equal(isProtectedTile(30, 150), false)
  // The moat's outer ring keeps its margin, and the bank stair with it.
  assert.equal(isProtectedTile(f.moatOuterMax - 1 + TOWN_MARGIN, 72), true)
  assert.equal(isProtectedTile(f.moatOuterMax + TOWN_MARGIN, 72), false)
  // Beside the road, the first tile is buildable.
  assert.equal(isProtectedTile(f.gateX + f.bridgeWidth / 2 - 1, f.exteriorMax - 5), true)
  assert.equal(isProtectedTile(f.gateX + f.bridgeWidth / 2, f.exteriorMax - 5), false)
  for (let z = MOAT_STAIRS.zStart; z <= MOAT_STAIRS.zEnd; z++) {
    assert.equal(isProtectedTile(MOAT_STAIRS.x, z), true, `the bank stair is exposed at ${z}`)
  }
  // The chunk predicate is the coarse one: it holds the town's seeded pieces,
  // and the road pushes it one chunk south of the moat square.
  assert.equal(isTownChunk(2, 4), true)
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
  const road = world.getChunk(2, 4)!
  const rx = FORTIFICATIONS.gateX - road.cx * CHUNK_SIZE
  const ry = 136 - road.cy * CHUNK_SIZE
  assert.equal(road.surface[ry * CHUNK_SIZE + rx], SURFACE.path)
})

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
  for (let cy = 5; cy < 15; cy++) {
    for (let cx = 5; cx < 15; cx++) {
      const scatter = generateVegetation(WORLD_SEED, cx, cy)
      const wood = scatter.filter(p => p.kind.startsWith('tree'))
      const cover = scatter.filter(p => !p.kind.startsWith('tree'))
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

test('a client that seeds vegetation the way the server does agrees with it', () => {
  const world = createWorld()
  const before = world.getChunk(MEADOW.cx, MEADOW.cy)!.placements.length
  for (const placement of generateVegetation(world.seed, MEADOW.cx, MEADOW.cy)) applyPlace(world, placement)
  const chunk = world.getChunk(MEADOW.cx, MEADOW.cy)!
  assert.equal(chunk.placements.length, before + generateVegetation(world.seed, MEADOW.cx, MEADOW.cy).length)
  // Every generated piece is bucketed with a collision spec, so the renderer
  // and the simulation are looking at the same trees.
  const tree = chunk.placements.find(p => p.kind.startsWith('tree'))
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
