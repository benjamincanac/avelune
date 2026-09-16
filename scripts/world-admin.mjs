// The world's chunk store, from the outside.
//
// Run with jiti, because it loads the server's own store module rather than a
// second implementation of the same keys:
//
//   pnpm exec jiti scripts/world-admin.mjs export ./backup
//   pnpm exec jiti scripts/world-admin.mjs import ./backup
//   pnpm exec jiti scripts/world-admin.mjs wipe --from -2,-2 --to 3,3
//   pnpm exec jiti scripts/world-admin.mjs reset --yes
//   Every command acts on one realm: the current `AVELUNE_REALM` /
//   `VERCEL_REGION`, or `--realm fra1`.
//
// Credentials come from NUXT_UPSTASH_REDIS_REST_URL / _TOKEN, from the bare
// UPSTASH_ names a linked Vercel store sets, from `.env`, or from --url/--token.
// There is nothing to administer in the memory store — it lives and dies with a
// server process — so this refuses to run without Redis.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

const USAGE = `world-admin — the chunk store, from the outside

  export <dir>                  write every stored chunk to <dir> as JSON
  import <dir>                  write those files back into the store
  wipe --from cx,cy --to cx,cy  delete the chunks in a rectangle (inclusive)
  reset --yes                   delete every chunk key in the store

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

  const { REALM, createChunkStore } = await import('../server/utils/chunkStore.ts')
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

    default:
      console.log(USAGE)
      throw new Error(`unknown command "${command}"`)
  }
}

main().catch((error) => {
  console.error(`world-admin: ${error.message}`)
  process.exitCode = 1
})
