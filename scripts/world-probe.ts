// A chunk service in its own process, for scripts/chunk-store-test.ts.
//
// `server/utils/world.ts` is a module singleton — one WORLD, one dirty set, one
// store — so the only honest way to test that a world survives a restart is to
// restart it. The test spawns this against the same store: once to edit, once
// to read back, and once to lose a compare-and-set to a rival writer.
//
// Run with: pnpm exec jiti scripts/world-probe.ts <edit|read|conflict|town-edit|town-read> <cx> <cy>
import { CHUNK_SIZE, HEIGHT_STEP, TERRAFORM_STEP, applyPlace, applyRemove, applyTerrain, cornerHeight, isProtectedTile } from '../shared/utils/world'
import { worldTerrainHeight } from '../shared/utils/terrain'
import { WORLD, flushDirtyChunks, loadChunk, markChunkDirty } from '../server/utils/world'
import { addPiece, loadPieceCounts, pieceCount } from '../server/utils/pieces'
import { createChunkStore } from '../server/utils/chunkStore'

/** The identity whose build budget the restart test follows. */
const BUILDER = 'probe-builder'

const [command, cxArg, cyArg] = process.argv.slice(2)
const cx = Number(cxArg)
const cy = Number(cyArg)

// The budget is read from the store at boot, the way `server/plugins/world.ts`
// does it, so a restart sees what the previous process owned.
await loadPieceCounts()

const chunk = await loadChunk(cx, cy)
if (!chunk) throw new Error(`probe: chunk ${cx},${cy} did not load`)

const town = command.startsWith('town')
/**
 * A corner well inside the chunk, so an edit never leans on a neighbour — or,
 * for a town chunk, the far corner, which is the editable ground just outside
 * the protected footprint.
 */
const gx = town ? cx * CHUNK_SIZE + CHUNK_SIZE - 2 : cx * CHUNK_SIZE + 8
const gy = town ? cy * CHUNK_SIZE + CHUNK_SIZE - 2 : cy * CHUNK_SIZE + 8
if (town && isProtectedTile(gx, gy)) throw new Error(`probe: ${gx},${gy} is inside the protected footprint`)
/** The corner as generation left it, quantised the way a chunk stores it. */
const base = Math.round(worldTerrainHeight(gx, gy) / HEIGHT_STEP) * HEIGHT_STEP

let felled: string | undefined
let written = 0

function raise() {
  const changed = applyTerrain(WORLD, { x: gx, y: gy, size: 3, mode: 'raise', maxStep: TERRAFORM_STEP })
  if (!changed.length) throw new Error('probe: terraform changed nothing')
  for (const touched of changed) markChunkDirty(touched)
}

if (command === 'edit') {
  raise()
  // One owned piece, counted against this identity's budget the way `build`
  // does it in the game loop.
  const crate = { kind: 'Kit_Crate', x: gx + 2, y: gy + 2, rot: 0, scale: 1, z: 0, id: 'probe:crate', owner: BUILDER }
  const home = applyPlace(WORLD, crate)
  if (!home) throw new Error('probe: the crate landed nowhere')
  addPiece(BUILDER)
  markChunkDirty(home)
  const tree = chunk.placements[0]
  if (!tree) throw new Error(`probe: chunk ${cx},${cy} grew nothing to fell`)
  felled = tree.id
  const owner = applyRemove(WORLD, tree.id)
  if (!owner) throw new Error('probe: nothing was removed')
  markChunkDirty(owner)
  written = await flushDirtyChunks()
  if (!written) throw new Error('probe: flush wrote nothing')
}

if (command === 'town-edit') {
  raise()
  written = await flushDirtyChunks()
  if (!written) throw new Error('probe: the town chunk flush wrote nothing')
}

if (command === 'conflict') {
  raise()
  if (!(await flushDirtyChunks())) throw new Error('probe: first flush wrote nothing')

  // A rival instance writes the chunk out from under us: same key, next
  // version, every tree cleared so the difference is unmistakable.
  const rival = createChunkStore()
  const current = await rival.get(cx, cy)
  if (!current) throw new Error('probe: the chunk never reached the store')
  if (!(await rival.set({ ...current, v: current.v + 1, props: [] }, current.v))) {
    throw new Error('probe: the rival write was refused')
  }

  // Our next flush is now stale: it must lose, reload, and end up holding the
  // rival's chunk rather than overwriting it.
  raise()
  written = await flushDirtyChunks()
}

// One machine-readable line, last, so the test can ignore anything the server
// logs on its way up.
console.log(`PROBE ${JSON.stringify({
  ids: chunk.placements.map(p => p.id).sort(),
  town: chunk.placements.filter(p => p.id.startsWith('town:')).length,
  base,
  height: cornerHeight(WORLD, gx, gy),
  version: chunk.version,
  written,
  felled,
  pieces: pieceCount(BUILDER),
})}`)
