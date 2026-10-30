// The world's chunk store, from the outside.
//
// Run with jiti, because it loads the server's own store module rather than a
// second implementation of the same keys:
//
//   pnpm exec jiti scripts/world-admin.mjs export ./backup
//   pnpm exec jiti scripts/world-admin.mjs import ./backup
//   pnpm exec jiti scripts/world-admin.mjs wipe --from -2,-2 --to 3,3
//   pnpm exec jiti scripts/world-admin.mjs reset --yes
//   pnpm exec jiti scripts/world-admin.mjs clear --realm fra1 --dry-run
//   Every command acts on one realm: the current `AVELUNE_REALM` /
//   `VERCEL_REGION`, or `--realm fra1`.
//
// Credentials come from NUXT_UPSTASH_REDIS_REST_URL / _TOKEN, from the bare
// UPSTASH_ names a linked Vercel store sets, from `.env`, or from --url/--token.
// There is nothing to administer in the memory store — it lives and dies with a
// server process — so this refuses to run without Redis.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { CHUNK_CORNERS, CHUNK_SIZE, GATE_APPROACH, LEND_RADIUS, chunkCoord, decodeChunk, encodeChunk, generateChunk } from '../shared/utils/world.ts'
import { WORLD_SEED } from '../shared/utils/terrain.ts'
import { plotBounds, propBounds } from '../shared/utils/building.ts'
import { propFromPlacement } from '../shared/utils/props.ts'
import { DEED_KIND } from '../shared/utils/kit.ts'
// The store module reads the realm from the environment when it loads, so it
// is imported after `--realm` has been applied (see `main`).

/** Chunks read and written per round trip, matching the store's own pipeline
 *  batch so an import of a whole world is tens of requests, not thousands. */
const BATCH = 32

const ENV_NAMES = [
  ['UPSTASH_REDIS_REST_URL', 'NUXT_UPSTASH_REDIS_REST_URL'],
  ['UPSTASH_REDIS_REST_TOKEN', 'NUXT_UPSTASH_REDIS_REST_TOKEN'],
]

/** Take the credentials out of `.env` if the shell has none. Nuxt reads that
 *  file for you; a bare script does not. */
function loadDotEnv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at < 0 || line.trimStart().startsWith('#')) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (value && ENV_NAMES.some(names => names.includes(key)) && !process.env[key]) process.env[key] = value
  }
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[name] = true
    else {
      flags[name] = next
      i++
    }
  }
  return { flags, positional }
}

function parseCoord(value, label) {
  const parts = String(value ?? '').split(',')
  const cx = Number(parts[0])
  const cy = Number(parts[1])
  if (parts.length !== 2 || !Number.isInteger(cx) || !Number.isInteger(cy)) {
    throw new Error(`${label} must look like "cx,cy" (got ${JSON.stringify(value)})`)
  }
  return [cx, cy]
}

function parseTiles(value) {
  const parts = String(value).split(',').map(Number)
  if (parts.length !== 4 || !parts.every(Number.isInteger)) {
    throw new Error(`--tiles must look like "minX,minY,maxX,maxY" (got ${JSON.stringify(value)})`)
  }
  const [x0, y0, x1, y1] = parts
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
}

/**
 * Put a rectangle of tiles back the way generation made it, inside whatever
 * chunks the store holds around it: the corner heights and surface under the
 * tiles, and no player piece whose footprint or plot reaches in. Everything
 * else in those chunks stays, which is the difference from `wipe`.
 *
 * Budgets follow the pieces: each one removed is handed back to its owner with
 * the same `HINCRBY` the server drains with, so nobody loses part of their 500
 * to a cleanup.
 */
async function clearTiles(store, box, dryRun) {
  // Tiles are inclusive, so the ground they cover runs to `max + 1`, and so do
  // the corners under them.
  const inCorner = (gx, gy) => gx >= box.minX && gx <= box.maxX + 1 && gy >= box.minY && gy <= box.maxY + 1
  const inTile = (x, y) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
  const overlaps = b => b.maxX > box.minX && b.minX < box.maxX + 1 && b.maxY > box.minY && b.minY < box.maxY + 1

  // A long piece can reach this far out of the chunk that owns it, so its owner
  // has to be read too.
  const coords = []
  for (let cy = chunkCoord(box.minY) - LEND_RADIUS; cy <= chunkCoord(box.maxY + 1) + LEND_RADIUS; cy++) {
    for (let cx = chunkCoord(box.minX) - LEND_RADIUS; cx <= chunkCoord(box.maxX + 1) + LEND_RADIUS; cx++) coords.push([cx, cy])
  }
  const stored = await store.getMany(coords)

  const writes = []
  const removals = []
  for (const saved of stored) {
    if (!saved) continue
    const chunk = decodeChunk(saved)
    const pristine = generateChunk(WORLD_SEED, chunk.cx, chunk.cy)
    const ox = chunk.cx * CHUNK_SIZE
    const oy = chunk.cy * CHUNK_SIZE
    let corners = 0
    for (let ly = 0; ly < CHUNK_CORNERS; ly++) {
      for (let lx = 0; lx < CHUNK_CORNERS; lx++) {
        const i = ly * CHUNK_CORNERS + lx
        if (!inCorner(ox + lx, oy + ly) || chunk.heights[i] === pristine.heights[i]) continue
        chunk.heights[i] = pristine.heights[i]
        corners++
      }
    }
    let tiles = 0
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx
        if (!inTile(ox + lx, oy + ly) || chunk.surface[i] === pristine.surface[i]) continue
        chunk.surface[i] = pristine.surface[i]
        tiles++
      }
    }
    const removed = chunk.placements.filter(p => p.owner && (
      inTile(Math.floor(p.x), Math.floor(p.y))
      || overlaps(propBounds(propFromPlacement(p)))
      || (p.kind === DEED_KIND && overlaps(plotBounds(p)))
    ))
    if (!corners && !tiles && !removed.length) continue
    chunk.placements = chunk.placements.filter(p => !removed.includes(p))
    chunk.version = saved.v + 1
    writes.push({ chunk: encodeChunk(chunk), expectedVersion: saved.v })
    removals.push(removed)
    const pieces = removed.map(p => `${p.kind} (${p.owner})`).join(', ')
    console.log(`  chunk ${chunk.cx},${chunk.cy}: ${corners} corner${corners === 1 ? '' : 's'}, ${tiles} tile${tiles === 1 ? '' : 's'}, ${removed.length} piece${removed.length === 1 ? '' : 's'}${pieces ? `: ${pieces}` : ''}`)
  }

  if (!writes.length) {
    console.log('nothing to clear: the store already matches generation there')
    return
  }
  if (dryRun) {
    console.log(`dry run: would rewrite ${writes.length} chunk${writes.length === 1 ? '' : 's'}`)
    return
  }
  const results = await store.flush(writes)
  // A refused chunk was written by a live server between the read and now, so
  // its pieces are still standing and nobody is owed anything for them.
  const refunds = new Map()
  const refund = field => refunds.set(field, (refunds.get(field) ?? 0) - 1)
  for (const [i, ok] of results.entries()) {
    if (!ok) continue
    for (const p of removals[i]) {
      refund(p.owner)
      if (p.kind === DEED_KIND) refund(`deed:${p.owner}`)
    }
  }
  const refused = results.filter(ok => !ok).length
  const deltas = [...refunds]
  if (deltas.length) await store.addPieces(deltas)
  console.log(`cleared ${writes.length - refused} chunk${writes.length - refused === 1 ? '' : 's'}${refused ? `, ${refused} refused (a server wrote it mid-clear, run again)` : ''}`)
  console.log('a running server keeps its own copy until the chunk reloads: redeploy so every instance reads the store again')
}

const USAGE = `world-admin — the chunk store, from the outside

  export <dir>                  write every stored chunk to <dir> as JSON
  import <dir>                  write those files back into the store
  wipe --from cx,cy --to cx,cy  delete the chunks in a rectangle (inclusive)
  reset --yes                   delete every chunk key in the store
  clear [--tiles x0,y0,x1,y1]   restore those tiles to generated ground and remove
                                the player pieces on them, keeping the rest of each
                                chunk (default: the gate approach). --dry-run to preview

  --url, --token                Upstash REST credentials, if not in the environment`

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const [command, target] = positional
  if (!command || flags.help) {
    console.log(USAGE)
    process.exitCode = command ? 0 : 1
    return
  }

  loadDotEnv()
  if (flags.url) process.env.UPSTASH_REDIS_REST_URL = String(flags.url)
  if (flags.token) process.env.UPSTASH_REDIS_REST_TOKEN = String(flags.token)
  if (flags.realm) process.env.AVELUNE_REALM = String(flags.realm)

  // The server code imports `#shared`, an alias only Nuxt and vitest know, so
  // it goes through a jiti that is told where it points.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const jiti = createJiti(import.meta.url, { alias: { '#shared': join(root, 'shared') } })
  const { REALM, createChunkStore } = await jiti.import('../server/utils/chunkStore.ts')
  console.log(`realm: ${REALM}`)
  const store = createChunkStore()
  if (store.kind !== 'redis') {
    throw new Error('no Upstash credentials: set NUXT_UPSTASH_REDIS_REST_URL and NUXT_UPSTASH_REDIS_REST_TOKEN, or pass --url and --token')
  }

  switch (command) {
    case 'export': {
      if (!target) throw new Error('export needs a directory')
      const dir = resolve(process.cwd(), target)
      mkdirSync(dir, { recursive: true })
      const coords = await store.keys()
      const chunks = await store.getMany(coords)
      let written = 0
      for (const chunk of chunks) {
        if (!chunk) continue
        writeFileSync(join(dir, `chunk.${chunk.cx}.${chunk.cy}.json`), `${JSON.stringify(chunk)}\n`)
        written++
      }
      console.log(`exported ${written} chunk${written === 1 ? '' : 's'} to ${dir}`)
      break
    }

    case 'import': {
      if (!target) throw new Error('import needs a directory')
      const dir = resolve(process.cwd(), target)
      const files = readdirSync(dir).filter(name => name.startsWith('chunk.') && name.endsWith('.json'))
      const chunks = files.map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
      let written = 0
      let refused = 0
      // A batch at a time, not a round trip per chunk: `getMany` reads what the
      // store holds right now and `flush` pipelines the compare-and-sets, so a
      // thousand-chunk backup is tens of requests rather than two thousand.
      for (let at = 0; at < chunks.length; at += BATCH) {
        const batch = chunks.slice(at, at + BATCH)
        const current = await store.getMany(batch.map(chunk => [chunk.cx, chunk.cy]))
        // Overwrite whatever is there: the compare-and-set is against the
        // version the store holds right now, not the one in the file.
        const results = await store.flush(batch.map((chunk, i) => ({
          chunk,
          expectedVersion: current[i] ? current[i].v : null,
        })))
        for (const ok of results) {
          if (ok) written++
          else refused++
        }
      }
      console.log(`imported ${written} chunk${written === 1 ? '' : 's'} from ${dir}${refused ? `, ${refused} refused (the store changed mid-import)` : ''}`)
      break
    }

    case 'wipe': {
      const [fromCx, fromCy] = parseCoord(flags.from, '--from')
      const [toCx, toCy] = parseCoord(flags.to, '--to')
      const coords = []
      for (let cy = Math.min(fromCy, toCy); cy <= Math.max(fromCy, toCy); cy++) {
        for (let cx = Math.min(fromCx, toCx); cx <= Math.max(fromCx, toCx); cx++) coords.push([cx, cy])
      }
      const removed = await store.remove(coords)
      console.log(`wiped ${removed} stored chunk${removed === 1 ? '' : 's'} of ${coords.length} in range; they will generate again on first touch`)
      break
    }

    case 'reset': {
      if (!flags.yes) throw new Error('reset deletes the whole world. Pass --yes if you mean it.')
      const coords = await store.keys()
      const removed = await store.remove(coords)
      console.log(`reset: deleted ${removed} chunk${removed === 1 ? '' : 's'}`)
      break
    }

    case 'clear': {
      const box = flags.tiles ? parseTiles(flags.tiles) : GATE_APPROACH
      console.log(`clearing tiles ${box.minX},${box.minY} to ${box.maxX},${box.maxY}`)
      await clearTiles(store, box, Boolean(flags['dry-run']))
      break
    }

    default:
      console.log(USAGE)
      throw new Error(`unknown command "${command}"`)
  }
}

main().catch((error) => {
  console.error(`world-admin: ${error.message}`)
  process.exitCode = 1
})
