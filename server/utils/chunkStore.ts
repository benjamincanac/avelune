import { Redis } from '@upstash/redis'
import { normalizeRealm } from '#shared/utils/realm'
import type { EncodedChunk } from '#shared/utils/world'

/**
 * Where chunks live between visits.
 *
 * One key per chunk, `chunk:<cx>:<cy>`, holding the chunk exactly as it goes
 * over the wire (`EncodedChunk`) with its version in front. Two implementations
 * behind one interface: `MemoryChunkStore` for local dev and the tests, where a
 * restart is meant to lose the world, and `RedisChunkStore` for Upstash, where
 * it is not. Nothing else in the server knows which one it is talking to —
 * `server/utils/world.ts` is the only caller.
 *
 * Every write is a compare-and-set on the version the caller last saw. A single
 * instance never races itself, but a redeploy overlaps the old instance with the
 * new one for a few seconds and both hold the same chunks: CAS is what stops the
 * one that is shutting down from writing a stale chunk over a live edit. The
 * loser reloads instead of retrying, because the store is the authority the
 * moment two processes disagree.
 */

/** Stored record: the chunk's version, a newline, then the encoded chunk as
 *  JSON. The version is in front so the CAS script can read it with a string
 *  match instead of parsing 3 KB of JSON in Lua. */
export type StoredChunk = EncodedChunk

/** The version a caller believes the store holds. `null` means "no key yet",
 *  which only succeeds while the key is still absent. */
export type ExpectedVersion = number | null

export interface ChunkWrite {
  chunk: StoredChunk
  expectedVersion: ExpectedVersion
}

/**
 * One "who was here" bucket: a set of identity ids under `key`, kept `ttl`
 * seconds past the window it covers so a reader that is a little behind still
 * finds it. Counting a set is the only honest way to say how many *people* were
 * here, as opposed to how many were here at once — the same player reconnecting
 * four times is one id.
 */
export interface SeenBucket {
  key: string
  /** Seconds. */
  ttl: number
}

/**
 * Everything the live surface writes, in one round trip.
 *
 * Presence, the seen buckets and the feed are all small and all written on the
 * same 5 second timer, so they travel as one pipeline rather than three
 * requests: the title screen polls every 10 seconds and every instance flushes
 * every 5, and three times that is three times the bill for no extra truth.
 */
export interface LiveWrite {
  /** Presence rows to set, identity to encoded row. */
  presence: readonly (readonly [string, string])[]
  /** Rows to remove: players who left, plus rows an instance that vanished
   *  never cleaned up after itself. */
  drop: readonly string[]
  /** The buckets each of `seenIds` belongs in right now. */
  seen: readonly SeenBucket[]
  seenIds: readonly string[]
  /** Feed rows to push in front of the shared list, oldest first. */
  events: readonly string[]
  /** How many feed rows the list keeps. */
  feedLimit: number
  /** The forced sky, when this instance is the one that just turned it. `null`
   *  leaves whatever the realm already holds. */
  sky: string | null
}

export interface LiveRead {
  /** Identity to encoded row, stale entries included — only the reader knows
   *  what counts as stale. */
  presence: Map<string, string>
  /** One count per requested bucket, in the order they were asked for. */
  seen: number[]
  /** Feed rows, newest first. */
  events: string[]
  /** The realm's forced sky, or null if nobody has turned it. */
  sky: string | null
}

export interface ChunkStore {
  /** Which implementation this is, for boot logging and for `world-admin`. */
  readonly kind: 'memory' | 'redis'
  get: (cx: number, cy: number) => Promise<StoredChunk | null>
  /** One round trip for a whole neighbourhood. */
  getMany: (coords: readonly (readonly [number, number])[]) => Promise<(StoredChunk | null)[]>
  /** Compare-and-set. Resolves false when the store moved on. */
  set: (chunk: StoredChunk, expectedVersion: ExpectedVersion) => Promise<boolean>
  /** Write-behind batch, pipelined. Results are per write, in order. */
  flush: (writes: readonly ChunkWrite[]) => Promise<boolean[]>
  /** Every chunk coordinate in the store. Admin tooling only. */
  keys: () => Promise<[number, number][]>
  remove: (coords: readonly (readonly [number, number])[]) => Promise<number>
  /** Every identity's owned-piece total. Read once at boot; the map is small
   *  (one entry per player who has ever built) and the budget has to survive a
   *  redeploy, which an in-memory counter never would. */
  readPieces: () => Promise<Map<string, number>>
  /** Apply signed deltas to those totals. Deltas rather than absolutes so two
   *  instances draining at once add up instead of clobbering each other. */
  addPieces: (deltas: readonly (readonly [string, number])[]) => Promise<void>
  /** Where one identity last stood, as `positions.ts` encoded it, or null. */
  readPosition: (id: string) => Promise<string | null>
  /** Last writer wins: a position is only ever written by the instance that
   *  holds the player's socket. */
  writePositions: (entries: readonly (readonly [string, string])[]) => Promise<void>
  /** The whole live surface — presence, the seen counts and the feed — in one
   *  round trip, because the title screen has no socket and asks for all of it
   *  at once. */
  readLive: (seen: readonly string[], feedLimit: number) => Promise<LiveRead>
  /** ...and the write half, pipelined for the same reason. */
  writeLive: (write: LiveWrite) => Promise<void>
}

/** The realm this process serves: every key below is scoped to it, so each
 *  deployment region owns a world of its own. `AVELUNE_REALM` overrides the
 *  platform's region id (and is how `world-admin` picks a realm). */
export const REALM = normalizeRealm(process.env.AVELUNE_REALM ?? process.env.VERCEL_REGION)

/** The hash every identity's owned-piece total lives in, per realm. */
export const PIECES_KEY = `pieces:${REALM}`

/** The hash every identity's last position lives in, per realm. */
export const POSITIONS_KEY = `positions:${REALM}`

/** The hash every live session in the realm announces itself in, per realm. */
export const PRESENCE_KEY = `presence:${REALM}`

/** The realm's shared world feed: a capped list, newest at the head. */
export const FEED_KEY = `feed:${REALM}`

/** The realm's forced weather and hour. One small string, read on the same
 *  timer as everything else, because a sky is a fact about the world and not
 *  about the instance whose player asked the Oracle to turn it. */
export const SKY_KEY = `sky:${REALM}`

/** The set of identities seen inside one window. `bucket` is a day or an hour;
 *  the prefix keeps the two apart so an hour can never be read as a day. */
export function seenKey(bucket: string): string {
  return `seen:${REALM}:${bucket}`
}

/** Writes per pipelined request. A flush of a whole town's worth of edits is
 *  split into batches rather than sent as one 200-command pipeline. */
export const FLUSH_BATCH = 32

export function chunkStoreKey(cx: number, cy: number): string {
  return `chunk:${REALM}:${cx}:${cy}`
}

function parseChunkStoreKey(key: string): [number, number] | null {
  const parts = key.split(':')
  if (parts.length !== 4 || parts[0] !== 'chunk' || parts[1] !== REALM) return null
  const cx = Number(parts[2])
  const cy = Number(parts[3])
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return null
  return [cx, cy]
}

function encodeRecord(chunk: StoredChunk): string {
  return `${chunk.v}\n${JSON.stringify(chunk)}`
}

function decodeRecord(raw: unknown): StoredChunk | null {
  if (typeof raw !== 'string') return null
  const at = raw.indexOf('\n')
  if (at < 0) return null
  try {
    return JSON.parse(raw.slice(at + 1)) as StoredChunk
  }
  catch {
    return null
  }
}

function recordVersion(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const at = raw.indexOf('\n')
  if (at < 0) return null
  const v = Number(raw.slice(0, at))
  return Number.isInteger(v) ? v : null
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The store when there is no Redis: a map in this process. The default, so
 * `pnpm dev`, `scripts/ws-test.mjs` and the bots need no environment at all —
 * and so a missing env var degrades to "the world resets on restart" instead of
 * taking the server down.
 */
export class MemoryChunkStore implements ChunkStore {
  readonly kind = 'memory'
  private readonly records = new Map<string, string>()
  private readonly pieces = new Map<string, number>()
  private readonly positions = new Map<string, string>()
  private readonly presence = new Map<string, string>()
  private readonly seen = new Map<string, Set<string>>()
  private readonly feed: string[] = []
  private sky: string | null = null

  async get(cx: number, cy: number): Promise<StoredChunk | null> {
    return decodeRecord(this.records.get(chunkStoreKey(cx, cy)))
  }

  async getMany(coords: readonly (readonly [number, number])[]): Promise<(StoredChunk | null)[]> {
    return coords.map(([cx, cy]) => decodeRecord(this.records.get(chunkStoreKey(cx, cy))))
  }

  async set(chunk: StoredChunk, expectedVersion: ExpectedVersion): Promise<boolean> {
    const key = chunkStoreKey(chunk.cx, chunk.cy)
    const current = this.records.get(key)
    const version = current === undefined ? null : recordVersion(current)
    if (version !== expectedVersion) return false
    this.records.set(key, encodeRecord(chunk))
    return true
  }

  async flush(writes: readonly ChunkWrite[]): Promise<boolean[]> {
    const out: boolean[] = []
    for (const write of writes) out.push(await this.set(write.chunk, write.expectedVersion))
    return out
  }

  async keys(): Promise<[number, number][]> {
    const out: [number, number][] = []
    for (const key of this.records.keys()) {
      const parsed = parseChunkStoreKey(key)
      if (parsed) out.push(parsed)
    }
    return out
  }

  async remove(coords: readonly (readonly [number, number])[]): Promise<number> {
    let removed = 0
    for (const [cx, cy] of coords) {
      if (this.records.delete(chunkStoreKey(cx, cy))) removed++
    }
    return removed
  }

  async readPieces(): Promise<Map<string, number>> {
    return new Map(this.pieces)
  }

  async addPieces(deltas: readonly (readonly [string, number])[]): Promise<void> {
    for (const [id, delta] of deltas) {
      const next = (this.pieces.get(id) ?? 0) + delta
      if (next > 0) this.pieces.set(id, next)
      else this.pieces.delete(id)
    }
  }

  async readPosition(id: string): Promise<string | null> {
    return this.positions.get(id) ?? null
  }

  async writePositions(entries: readonly (readonly [string, string])[]): Promise<void> {
    for (const [id, value] of entries) this.positions.set(id, value)
  }

  async readLive(seen: readonly string[], feedLimit: number): Promise<LiveRead> {
    return {
      presence: new Map(this.presence),
      seen: seen.map(key => this.seen.get(key)?.size ?? 0),
      events: this.feed.slice(0, feedLimit),
      sky: this.sky,
    }
  }

  async writeLive(write: LiveWrite): Promise<void> {
    for (const [id, value] of write.presence) this.presence.set(id, value)
    for (const id of write.drop) this.presence.delete(id)
    if (write.seenIds.length) {
      for (const bucket of write.seen) {
        const set = this.seen.get(bucket.key) ?? new Set<string>()
        this.seen.set(bucket.key, set)
        for (const id of write.seenIds) set.add(id)
      }
    }
    // No expiry here: a process that dies takes the whole map with it, which is
    // exactly what local dev wants. A dev server left up for days holds one
    // small set per hour, which is a few hundred bytes.
    for (const event of write.events) this.feed.unshift(event)
    if (this.feed.length > write.feedLimit) this.feed.length = write.feedLimit
    if (write.sky !== null) this.sky = write.sky
  }
}

/* -------------------------------------------------------------------------- */
/* Upstash                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compare-and-set, server side, in one round trip.
 *
 * `ARGV[2]` is the version the caller expects to find, or an empty string for
 * "this key should not exist yet". The stored value starts with its own version
 * followed by a newline, so the check is a pattern match on the first line and
 * never decodes the payload.
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  if ARGV[2] == '' then
    redis.call('SET', KEYS[1], ARGV[1])
    return 1
  end
  return 0
end
local version = string.match(current, '^(-?%d+)\\n')
if version ~= nil and version == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`

function casArgs(write: ChunkWrite): [string[], string[]] {
  return [
    [chunkStoreKey(write.chunk.cx, write.chunk.cy)],
    [encodeRecord(write.chunk), write.expectedVersion === null ? '' : String(write.expectedVersion)],
  ]
}

const truthy = (result: unknown) => result === 1 || result === '1' || result === true

/**
 * Upstash Redis over its REST API.
 *
 * `automaticDeserialization` is off: records are our own `version\nJSON` form,
 * and letting the client guess at JSON on the way back only risks it succeeding
 * on something that was never meant to be parsed.
 *
 * The client calls the global `fetch`, which `server/plugins/nativeFetch.ts`
 * keeps pointed at the real one for absolute urls — without that guard a page
 * render would silently route these calls back into this app's own router.
 */
export class RedisChunkStore implements ChunkStore {
  readonly kind = 'redis'
  private readonly redis: Redis

  constructor(url: string, token: string) {
    // The client's own retry loop is kept short because `server/utils/world.ts`
    // has one of its own around every read. Left at the default of five, a
    // store that is down would hold a chunk load — and the boot prefetch — for
    // the better part of a minute.
    this.redis = new Redis({ url, token, automaticDeserialization: false, retry: { retries: 2, backoff: attempt => attempt * 100 } })
  }

  async get(cx: number, cy: number): Promise<StoredChunk | null> {
    return decodeRecord(await this.redis.get<string>(chunkStoreKey(cx, cy)))
  }

  async getMany(coords: readonly (readonly [number, number])[]): Promise<(StoredChunk | null)[]> {
    if (!coords.length) return []
    const out: (StoredChunk | null)[] = []
    for (let at = 0; at < coords.length; at += FLUSH_BATCH) {
      const slice = coords.slice(at, at + FLUSH_BATCH)
      const raw = await this.redis.mget<unknown[]>(...slice.map(([cx, cy]) => chunkStoreKey(cx, cy)))
      for (let i = 0; i < slice.length; i++) out.push(decodeRecord(raw?.[i]))
    }
    return out
  }

  async set(chunk: StoredChunk, expectedVersion: ExpectedVersion): Promise<boolean> {
    const [keys, args] = casArgs({ chunk, expectedVersion })
    return truthy(await this.redis.eval(CAS_SCRIPT, keys, args))
  }

  async flush(writes: readonly ChunkWrite[]): Promise<boolean[]> {
    const out: boolean[] = []
    for (let at = 0; at < writes.length; at += FLUSH_BATCH) {
      const batch = writes.slice(at, at + FLUSH_BATCH)
      const pipeline = this.redis.pipeline()
      for (const write of batch) {
        const [keys, args] = casArgs(write)
        pipeline.eval(CAS_SCRIPT, keys, args)
      }
      const results = await pipeline.exec<unknown[]>()
      for (let i = 0; i < batch.length; i++) out.push(truthy(results?.[i]))
    }
    return out
  }

  async keys(): Promise<[number, number][]> {
    const out: [number, number][] = []
    let cursor = '0'
    do {
      const [next, batch] = await this.redis.scan(cursor, { match: `chunk:${REALM}:*`, count: 500 })
      cursor = String(next)
      for (const key of batch) {
        const parsed = parseChunkStoreKey(String(key))
        if (parsed) out.push(parsed)
      }
    } while (cursor !== '0')
    return out
  }

  async remove(coords: readonly (readonly [number, number])[]): Promise<number> {
    let removed = 0
    for (let at = 0; at < coords.length; at += FLUSH_BATCH) {
      const batch = coords.slice(at, at + FLUSH_BATCH)
      removed += await this.redis.del(...batch.map(([cx, cy]) => chunkStoreKey(cx, cy)))
    }
    return removed
  }

  /** `automaticDeserialization` is off, so `HGETALL` comes back as the flat
   *  field/value array Redis actually sends rather than as an object. */
  async readPieces(): Promise<Map<string, number>> {
    const raw = await this.redis.hgetall(PIECES_KEY) as unknown
    const out = new Map<string, number>()
    if (!Array.isArray(raw)) return out
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const count = Number(raw[i + 1])
      if (Number.isFinite(count) && count > 0) out.set(String(raw[i]), count)
    }
    return out
  }

  async addPieces(deltas: readonly (readonly [string, number])[]): Promise<void> {
    for (let at = 0; at < deltas.length; at += FLUSH_BATCH) {
      const batch = deltas.slice(at, at + FLUSH_BATCH)
      const pipeline = this.redis.pipeline()
      for (const [id, delta] of batch) pipeline.hincrby(PIECES_KEY, id, delta)
      await pipeline.exec()
    }
  }

  async readPosition(id: string): Promise<string | null> {
    const raw = await this.redis.hget<string>(POSITIONS_KEY, id)
    return typeof raw === 'string' ? raw : null
  }

  async writePositions(entries: readonly (readonly [string, string])[]): Promise<void> {
    for (let at = 0; at < entries.length; at += FLUSH_BATCH) {
      await this.redis.hset(POSITIONS_KEY, Object.fromEntries(entries.slice(at, at + FLUSH_BATCH)))
    }
  }

  /** One pipeline: the presence hash, one `SCARD` per bucket asked for, and the
   *  head of the feed list. `automaticDeserialization` is off, so `HGETALL`
   *  arrives as the flat field/value array Redis actually sends. */
  async readLive(seen: readonly string[], feedLimit: number): Promise<LiveRead> {
    const pipeline = this.redis.pipeline()
    pipeline.hgetall(PRESENCE_KEY)
    for (const key of seen) pipeline.scard(key)
    pipeline.lrange(FEED_KEY, 0, feedLimit - 1)
    pipeline.get(SKY_KEY)
    const results = await pipeline.exec<unknown[]>()

    const presence = new Map<string, string>()
    const raw = results?.[0]
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) presence.set(String(raw[i]), String(raw[i + 1]))
    }
    const events = results?.[seen.length + 1]
    const sky = results?.[seen.length + 2]
    return {
      presence,
      seen: seen.map((_, i) => {
        const count = Number(results?.[i + 1])
        return Number.isFinite(count) ? count : 0
      }),
      events: Array.isArray(events) ? events.map(String) : [],
      sky: typeof sky === 'string' ? sky : null,
    }
  }

  /** The write half, in one pipeline for the same reason. `LPUSH` takes the
   *  rows oldest first, which is what leaves the newest at the head. */
  async writeLive(write: LiveWrite): Promise<void> {
    const pipeline = this.redis.pipeline()
    let sending = false
    if (write.presence.length) {
      pipeline.hset(PRESENCE_KEY, Object.fromEntries(write.presence))
      sending = true
    }
    if (write.drop.length) {
      pipeline.hdel(PRESENCE_KEY, ...write.drop)
      sending = true
    }
    const [firstSeen, ...restSeen] = write.seenIds
    if (firstSeen !== undefined) {
      for (const bucket of write.seen) {
        pipeline.sadd(bucket.key, firstSeen, ...restSeen)
        // Pushed out on every write rather than set once: a bucket that is still
        // being written to has not finished, whatever its key says.
        pipeline.expire(bucket.key, bucket.ttl)
        sending = true
      }
    }
    if (write.events.length) {
      pipeline.lpush(FEED_KEY, ...write.events)
      pipeline.ltrim(FEED_KEY, 0, write.feedLimit - 1)
      sending = true
    }
    if (write.sky !== null) {
      pipeline.set(SKY_KEY, write.sky)
      sending = true
    }
    if (!sending) return
    await pipeline.exec()
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Runtime config first, then the environment.
 *
 * `useRuntimeConfig` only exists inside Nitro; `scripts/world-admin.mjs` loads
 * this module through jiti, where the reference throws and the env names are all
 * there is. The bare `UPSTASH_*` and `KV_REST_API_*` names are accepted alongside
 * the `NUXT_` prefixed ones: the Upstash console integration sets the former, a
 * store created from the Vercel marketplace sets the latter.
 */
function setting(key: 'upstashRedisRestUrl' | 'upstashRedisRestToken', ...envNames: string[]): string {
  try {
    const config = useRuntimeConfig() as unknown as Record<string, unknown>
    const value = config?.[key]
    if (typeof value === 'string' && value) return value
  }
  catch {
    // Not inside Nitro (world-admin through jiti): the environment it is.
  }
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  return ''
}

export function chunkStoreCredentials(): { url: string, token: string } {
  return {
    url: setting('upstashRedisRestUrl', 'NUXT_UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'),
    token: setting('upstashRedisRestToken', 'NUXT_UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'),
  }
}

/** A store from the environment: Upstash when both credentials are set, memory
 *  otherwise. Local dev and the tests configure nothing and get memory. */
export function createChunkStore(): ChunkStore {
  const { url, token } = chunkStoreCredentials()
  if (url && token) return new RedisChunkStore(url, token)
  return new MemoryChunkStore()
}

let store: ChunkStore | undefined

/** The process-wide store. Built on first touch so importing this module never
 *  reaches for credentials that a test is about to set. */
export function chunkStore(): ChunkStore {
  store ??= createChunkStore()
  return store
}
