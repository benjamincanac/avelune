// Run with: pnpm test, or pnpm exec vitest run scripts/index-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { propsNear } from '../shared/utils/maze'
import {
  CELLS_PER_CHUNK,
  CELL_SIZE,
  CHUNK_SIZE,
  applyPlace,
  applyRemove,
  cellCoord,
  createWorld,
  decodeChunk,
  encodeChunk,
  installChunk,
  makePlacementId,
  propsInBox,
  removeChunk,
} from '../shared/utils/world'
import type { Chunk, World } from '../shared/utils/world'
import type { PropSpec, WorldPlacement } from '../shared/utils/props'

/** Open meadow, well clear of the protected town. */
const MEADOW = { cx: 6, cy: 6 }
const ORIGIN = { x: MEADOW.cx * CHUNK_SIZE, y: MEADOW.cy * CHUNK_SIZE }

function place(world: World, kind: string, x: number, y: number, rot = 0): WorldPlacement {
  const placement: WorldPlacement = { kind, x, y, rot, scale: 1, z: 0, id: makePlacementId('t'), owner: 'tester' }
  assert.ok(applyPlace(world, placement), `placed ${kind} at ${x},${y}`)
  return placement
}

/** Global cell coordinates of the cells of `chunk` that list this id. */
function cellsHolding(chunk: Chunk, id: string): string[] {
  const out: string[] = []
  for (let ly = 0; ly < CELLS_PER_CHUNK; ly++) {
    for (let lx = 0; lx < CELLS_PER_CHUNK; lx++) {
      if (chunk.cells[ly * CELLS_PER_CHUNK + lx]!.some(p => p.id === id)) {
        out.push(`${chunk.cx * CELLS_PER_CHUNK + lx},${chunk.cy * CELLS_PER_CHUNK + ly}`)
      }
    }
  }
  return out.sort()
}

/** Which cells a prop's indexed square covers, clipped to one chunk. */
function expectedCells(chunk: Chunk, prop: PropSpec): string[] {
  const out: string[] = []
  const ox = chunk.cx * CELLS_PER_CHUNK
  const oy = chunk.cy * CELLS_PER_CHUNK
  for (let cy = Math.max(cellCoord(prop.y - prop.r), oy); cy <= Math.min(cellCoord(prop.y + prop.r), oy + CELLS_PER_CHUNK - 1); cy++) {
    for (let cx = Math.max(cellCoord(prop.x - prop.r), ox); cx <= Math.min(cellCoord(prop.x + prop.r), ox + CELLS_PER_CHUNK - 1); cx++) {
      out.push(`${cx},${cy}`)
    }
  }
  return out.sort()
}

function specOf(chunk: Chunk, id: string): PropSpec {
  const spec = chunk.props.find(p => p.id === id)
  assert.ok(spec, 'the chunk holds the spec')
  return spec
}

test('a piece lands in every cell its footprint square touches, and no others', () => {
  const world = createWorld()
  const chunk = world.getChunk(MEADOW.cx, MEADOW.cy)!
  // A crate is small enough to sit inside a single cell...
  const crate = place(world, 'Kit_Crate', ORIGIN.x + 4, ORIGIN.y + 4)
  assert.deepEqual(cellsHolding(chunk, crate.id), expectedCells(chunk, specOf(chunk, crate.id)))
  assert.equal(cellsHolding(chunk, crate.id).length, 1, 'a crate mid-cell occupies one cell')

  // ...and a wall laid across a cell seam has to be in both.
  const wall = place(world, 'Kit_Wall', ORIGIN.x + CELL_SIZE, ORIGIN.y + 4)
  const cells = cellsHolding(chunk, wall.id)
  assert.deepEqual(cells, expectedCells(chunk, specOf(chunk, wall.id)))
  assert.equal(cells.length, 2, 'a wall on the seam occupies both cells')

  // The index is only an index: what it returns still has to answer the query.
  assert.ok([...propsNear(world, ORIGIN.x + CELL_SIZE, ORIGIN.y + 4)].some(p => p.id === wall.id))
  // And a cell the footprint never reaches does not list it.
  const far = world.getChunk(MEADOW.cx, MEADOW.cy)!.cells[CELLS_PER_CHUNK * CELLS_PER_CHUNK - 1]!
  assert.equal(far.some(p => p.id === wall.id), false, 'the far corner cell is clean')
  assert.equal([...propsNear(world, ORIGIN.x + CHUNK_SIZE - 2, ORIGIN.y + CHUNK_SIZE - 2)].length, 0)
})

test('a piece straddling a chunk border is in the cells on both sides', () => {
  const world = createWorld()
  // Centred exactly on the west border, so its footprint square reaches into
  // the neighbour that does not own it.
  const wall = place(world, 'Kit_Wall', ORIGIN.x, ORIGIN.y + 4)
  const owner = world.getChunk(MEADOW.cx, MEADOW.cy)!
  const west = world.getChunk(MEADOW.cx - 1, MEADOW.cy)!
  assert.ok(cellsHolding(owner, wall.id).length > 0, 'the owner indexes it')
  assert.ok(cellsHolding(west, wall.id).length > 0, 'so does the neighbour it reaches into')
  assert.deepEqual(cellsHolding(west, wall.id), expectedCells(west, specOf(west, wall.id)))
  // Found from either side of the seam.
  assert.ok([...propsNear(world, ORIGIN.x + 0.4, ORIGIN.y + 4)].some(p => p.id === wall.id))
  assert.ok([...propsNear(world, ORIGIN.x - 0.4, ORIGIN.y + 4)].some(p => p.id === wall.id))
})

test('removing a piece drops it from every cell that held it', () => {
  const world = createWorld()
  const wall = place(world, 'Kit_Wall', ORIGIN.x, ORIGIN.y + 4)
  assert.ok(applyRemove(world, wall.id))
  for (const chunk of world.chunks.values()) {
    assert.deepEqual(cellsHolding(chunk, wall.id), [], `chunk ${chunk.cx},${chunk.cy} forgot it`)
    assert.equal(chunk.props.some(p => p.id === wall.id), false)
  }
  assert.equal([...propsNear(world, ORIGIN.x, ORIGIN.y + 4)].length, 0)
})

test('installChunk and removeChunk keep the neighbours\' cells right', () => {
  const server = createWorld()
  const wall = place(server, 'Kit_Wall', ORIGIN.x, ORIGIN.y + 4)
  const stream = (cx: number, cy: number) => decodeChunk(encodeChunk(server.getChunk(cx, cy)!))

  // A streaming client never generates: it only ever holds what arrived.
  for (const order of [[MEADOW.cx - 1, MEADOW.cx], [MEADOW.cx, MEADOW.cx - 1]]) {
    const client = createWorld({ generate: false, town: false })
    for (const cx of order) installChunk(client, stream(cx, MEADOW.cy))
    const owner = client.getChunk(MEADOW.cx, MEADOW.cy)!
    const west = client.getChunk(MEADOW.cx - 1, MEADOW.cy)!
    assert.ok(cellsHolding(owner, wall.id).length > 0, `owner cells, order ${order}`)
    assert.ok(cellsHolding(west, wall.id).length > 0, `borrowed cells, order ${order}`)
    // No cell may list it twice, whichever order the chunks landed in.
    for (const chunk of [owner, west]) {
      for (const cell of chunk.cells) {
        assert.ok(cell.filter(p => p.id === wall.id).length <= 1, `no duplicate, order ${order}`)
      }
    }
    // Re-installing the owner in place must not double it up either.
    installChunk(client, stream(MEADOW.cx, MEADOW.cy))
    assert.equal(west.props.filter(p => p.id === wall.id).length, 1, `still lent once, order ${order}`)
    assert.deepEqual(cellsHolding(west, wall.id), expectedCells(west, specOf(west, wall.id)))

    assert.equal(removeChunk(client, MEADOW.cx, MEADOW.cy), true)
    assert.deepEqual(cellsHolding(west, wall.id), [], `the loan is taken back, order ${order}`)
    assert.equal([...propsNear(client, ORIGIN.x - 0.4, ORIGIN.y + 4)].length, 0)
  }
})

/** Deterministic PRNG, so a failure here is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) + 0x6D2B79F5) >>> 0
    return a / 4294967296
  }
}

test('propsNear matches a brute-force scan of the 3×3 neighbourhood', () => {
  const world = createWorld()
  const random = rng(4242)
  const kinds = ['Kit_Wall', 'Kit_Floor', 'Kit_Crate', 'Kit_Fence', 'Kit_Torch', 'tree1', 'rock2']
  for (let i = 0; i < 400; i++) {
    place(
      world,
      kinds[Math.floor(random() * kinds.length)]!,
      ORIGIN.x + Math.round(random() * CHUNK_SIZE * 100) / 100,
      ORIGIN.y + Math.round(random() * CHUNK_SIZE * 100) / 100,
      random() * Math.PI * 2,
    )
  }
  // Touch the whole neighbourhood up front: the index reads fewer chunks than
  // the brute force does, and a chunk generated mid-comparison would make the
  // two disagree about nothing but lazy loading.
  for (let cy = MEADOW.cy - 2; cy <= MEADOW.cy + 2; cy++) {
    for (let cx = MEADOW.cx - 2; cx <= MEADOW.cx + 2; cx++) world.getChunk(cx, cy)
  }

  const brute = (x: number, y: number, r: number) => {
    const hits = new Set<PropSpec>()
    for (let cy = Math.floor(y / CHUNK_SIZE) - 1; cy <= Math.floor(y / CHUNK_SIZE) + 1; cy++) {
      for (let cx = Math.floor(x / CHUNK_SIZE) - 1; cx <= Math.floor(x / CHUNK_SIZE) + 1; cx++) {
        const chunk = world.getChunk(cx, cy)
        if (!chunk) continue
        for (const prop of chunk.props) {
          if (Math.hypot(x - prop.x, y - prop.y) <= prop.r + r) hits.add(prop)
        }
      }
    }
    return hits
  }

  let found = 0
  for (let i = 0; i < 2000; i++) {
    const x = ORIGIN.x - 2 + random() * (CHUNK_SIZE + 4)
    const y = ORIGIN.y - 2 + random() * (CHUNK_SIZE + 4)
    const r = random() < 0.5 ? 0 : random() * 2
    const indexed = [...propsNear(world, x, y, r)]
    assert.equal(new Set(indexed).size, indexed.length, `no duplicates at ${x},${y} r=${r}`)
    const expected = brute(x, y, r)
    assert.equal(indexed.length, expected.size, `hit count at ${x},${y} r=${r}`)
    for (const prop of indexed) assert.ok(expected.has(prop), `unexpected ${prop.kind} at ${x},${y} r=${r}`)
    found += indexed.length
  }
  // A comparison that agreed on nothing would prove nothing.
  assert.ok(found > 2000, `the queries actually hit pieces (${found})`)
})

test('propsInBox finds everything whose footprint square meets the box', () => {
  const world = createWorld()
  const ids = [
    place(world, 'Kit_Wall', ORIGIN.x + 2, ORIGIN.y + 2).id,
    place(world, 'Kit_Crate', ORIGIN.x + 19, ORIGIN.y + 19).id,
    place(world, 'Kit_Floor', ORIGIN.x + 2, ORIGIN.y + 20).id,
  ]
  const box = [...propsInBox(world, ORIGIN.x, ORIGIN.y, ORIGIN.x + 4, ORIGIN.y + 4)].map(p => p.id)
  assert.deepEqual(box, [ids[0]], 'only the piece inside the box')
  const wide = new Set([...propsInBox(world, ORIGIN.x, ORIGIN.y, ORIGIN.x + CHUNK_SIZE, ORIGIN.y + CHUNK_SIZE)].map(p => p.id))
  for (const id of ids) assert.ok(wide.has(id), 'a chunk-wide box finds all three')
})
