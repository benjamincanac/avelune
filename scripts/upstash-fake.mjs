// A stand-in for the Upstash Redis REST endpoint, for scripts/chunk-store-test.ts.
//
// It speaks just enough of the protocol for `RedisChunkStore`: the single
// command endpoint, the `/pipeline` batch endpoint, bearer auth, the base64
// response encoding the client asks for by default, and the commands the store
// sends — the chunk half (GET, MGET, DEL, SCAN, PING and the one EVAL script),
// the hashes behind piece budgets, positions and presence, the sets behind the
// "who was here" buckets, the list behind the world feed, and the sorted sets
// that keep the newest turn of the sky whatever order the writes arrive in.
//
// Expiry is not simulated. Nothing in the store depends on a key going away on
// time, only on it going away eventually, and a test that waited ten hours to
// prove it would be no test at all.
//
// The script is not interpreted. It is matched against the store's compare-and-set
// source and its semantics are reimplemented here, so this proves the store's
// round trips and its CAS contract, not Redis's Lua. `scripts/redis-rest.mjs`
// runs the same script through a real `redis-server` whenever one is installed,
// which is the only thing that proves the Lua itself compiles.

import { createServer } from 'node:http'

const encode = (value) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  if (Array.isArray(value)) return value.map(encode)
  return value
}

/** The version a stored record carries, from its first line. */
function versionOf(record) {
  if (typeof record !== 'string') return null
  const at = record.indexOf('\n')
  if (at < 0) return null
  const v = Number(record.slice(0, at))
  return Number.isInteger(v) ? v : null
}

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

/**
 * The compare-and-set the store sends. Recognised by shape rather than by an
 * exact string so that a comment or a reflow in the Lua does not silently turn
 * every write into an error.
 *
 * The pattern literal is checked character for character, though, because that
 * is the one part of this script a JavaScript template literal can get wrong in
 * a way nothing else here would catch: `\n` in the TypeScript source reaches
 * Lua as a *raw newline*, which is a syntax error inside a single-quoted Lua
 * string, and real Redis refuses to compile the script at all. This fake would
 * happily go on matching it, so it refuses instead — the store has to send the
 * two characters backslash-n.
 */
const CAS_PATTERN = '^(-?%d+)\\n'

function isCasScript(script) {
  if (typeof script !== 'string') return false
  if (!script.includes('redis.call(\'GET\', KEYS[1])')) return false
  if (!script.includes('redis.call(\'SET\', KEYS[1], ARGV[1])')) return false
  const match = /string\.match\(current,\s*'([^']*)'\)/.exec(script)
  if (!match) return false
  if (match[1] !== CAS_PATTERN) {
    throw new Error(`fake upstash: the compare-and-set pattern is ${JSON.stringify(match[1])}, not ${JSON.stringify(CAS_PATTERN)} — real Redis would not compile this script`)
  }
  return true
}

/** A sorted set's members, lowest score first, ties by member as Redis does. */
function ranked(zset) {
  return [...zset].sort(([a, sa], [b, sb]) => sa - sb || (a < b ? -1 : a > b ? 1 : 0)).map(([member]) => member)
}

/** Redis rank arithmetic: negative indices count from the end, inclusive stop. */
function rankRange(length, start, stop) {
  const from = start < 0 ? Math.max(0, length + start) : start
  const to = stop < 0 ? length + stop : Math.min(stop, length - 1)
  return [from, to]
}

function run(data, hashes, sets, lists, zsets, command) {
  const [name, ...args] = command
  switch (String(name).toLowerCase()) {
    case 'hgetall': {
      // RESP2: one flat field/value array, which is what the store parses.
      const hash = hashes.get(args[0])
      if (!hash) return []
      return [...hash].flatMap(([field, value]) => [field, String(value)])
    }
    case 'hincrby': {
      const hash = hashes.get(args[0]) ?? new Map()
      hashes.set(args[0], hash)
      const next = Number(hash.get(args[1]) ?? 0) + Number(args[2])
      if (next === 0) hash.delete(args[1])
      else hash.set(args[1], next)
      return next
    }
    case 'hget':
      return hashes.get(args[0])?.get(args[1]) ?? null
    case 'hdel': {
      const hash = hashes.get(args[0])
      if (!hash) return 0
      let removed = 0
      for (const field of args.slice(1)) {
        if (hash.delete(field)) removed++
      }
      return removed
    }
    case 'sadd': {
      const set = sets.get(args[0]) ?? new Set()
      sets.set(args[0], set)
      let added = 0
      for (const member of args.slice(1)) {
        if (!set.has(String(member))) {
          set.add(String(member))
          added++
        }
      }
      return added
    }
    case 'scard':
      return sets.get(args[0])?.size ?? 0
    case 'expire':
      // Accepted and ignored; see the note at the top.
      return (sets.has(args[0]) || lists.has(args[0]) || hashes.has(args[0]) || data.has(args[0])) ? 1 : 0
    case 'lpush': {
      const list = lists.get(args[0]) ?? []
      lists.set(args[0], list)
      // Redis pushes each value in turn, so the last argument ends up first.
      for (const value of args.slice(1)) list.unshift(String(value))
      return list.length
    }
    case 'ltrim': {
      const list = lists.get(args[0]) ?? []
      lists.set(args[0], list.slice(Number(args[1]), Number(args[2]) + 1))
      return 'OK'
    }
    case 'zadd': {
      const zset = zsets.get(args[0]) ?? new Map()
      zsets.set(args[0], zset)
      let added = 0
      for (let i = 1; i + 1 < args.length; i += 2) {
        if (!zset.has(String(args[i + 1]))) added++
        zset.set(String(args[i + 1]), Number(args[i]))
      }
      return added
    }
    case 'zremrangebyrank': {
      const zset = zsets.get(args[0])
      if (!zset) return 0
      const order = ranked(zset)
      const [from, to] = rankRange(order.length, Number(args[1]), Number(args[2]))
      let removed = 0
      for (let i = from; i <= to; i++) {
        zset.delete(order[i])
        removed++
      }
      return removed
    }
    case 'zrange': {
      const zset = zsets.get(args[0])
      if (!zset) return []
      const order = ranked(zset)
      const [from, to] = rankRange(order.length, Number(args[1]), Number(args[2]))
      return from > to ? [] : order.slice(from, to + 1)
    }
    case 'lrange': {
      const list = lists.get(args[0]) ?? []
      const stop = Number(args[2])
      return list.slice(Number(args[1]), stop < 0 ? undefined : stop + 1)
    }
    case 'hset': {
      const hash = hashes.get(args[0]) ?? new Map()
      hashes.set(args[0], hash)
      for (let i = 1; i + 1 < args.length; i += 2) hash.set(args[i], String(args[i + 1]))
      return (args.length - 1) / 2
    }
    case 'ping':
      return 'PONG'
    case 'get':
      return data.get(args[0]) ?? null
    case 'mget':
      return args.map(key => data.get(key) ?? null)
    case 'set':
      data.set(args[0], args[1])
      return 'OK'
    case 'del': {
      let removed = 0
      for (const key of args) {
        if (data.delete(key)) removed++
      }
      return removed
    }
    case 'scan': {
      // One shot: every key, cursor straight back to 0. The store's loop copes
      // with that and a fake has no business paginating.
      let match = null
      for (let i = 1; i < args.length; i++) {
        if (String(args[i]).toLowerCase() === 'match') match = globToRegExp(String(args[i + 1]))
      }
      return ['0', [...data.keys()].filter(key => !match || match.test(key))]
    }
    case 'eval': {
      const [script, count, ...rest] = args
      if (!isCasScript(script)) throw new Error('fake upstash: unknown script')
      const keys = rest.slice(0, Number(count))
      const argv = rest.slice(Number(count))
      const key = keys[0]
      const current = data.get(key)
      const expected = argv[1] === '' ? null : Number(argv[1])
      if (current === undefined) {
        if (expected !== null) return 0
        data.set(key, argv[0])
        return 1
      }
      if (versionOf(current) !== expected) return 0
      data.set(key, argv[0])
      return 1
    }
    default:
      throw new Error(`fake upstash: unsupported command ${String(name)}`)
  }
}

/**
 * Start the endpoint. Resolves to `{ url, token, data, close }`, where `data` is
 * the backing map so a test can look at what actually landed.
 */
export async function startUpstashFake({ token = 'fake-token', port = 0 } = {}) {
  const data = new Map()
  const hashes = new Map()
  const sets = new Map()
  const lists = new Map()
  const zsets = new Map()
  let requests = 0

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
      let commands
      try {
        commands = JSON.parse(body || 'null')
      }
      catch {
        return reply(400, { error: 'bad json' })
      }
      requests++
      const base64 = String(req.headers['upstash-encoding'] ?? '') === 'base64'
      const one = (command) => {
        try {
          const result = run(data, hashes, sets, lists, zsets, command)
          return { result: base64 ? encode(result) : result }
        }
        catch (error) {
          return { error: String(error?.message ?? error) }
        }
      }
      if (req.url?.endsWith('/pipeline')) return reply(200, (commands ?? []).map(one))
      reply(200, one(commands ?? []))
    })
  })

  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    data,
    hashes,
    sets,
    lists,
    zsets,
    /** HTTP round trips served so far, so a test can assert on batching. */
    get requests() {
      return requests
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
