import type { WorldEvent } from '#shared/types/game'
import { chunkStore, seenKey } from './chunkStore'
import type { SeenBucket, SkyField, SkyTurn } from './chunkStore'

/**
 * The live surface the title screen reads: who is in the realm, how many people
 * have been through today, the last nine hours of that, and the world feed.
 *
 * All of it used to be module state, which made it a fact about *a process*
 * rather than about the realm. That held while there was one instance. There is
 * not: a region runs as many as it needs, a socket pins its player to the one
 * that accepted the upgrade, and `GET /api/status` is a plain request that lands
 * wherever. The page would show the roster of whichever instance answered, and a
 * "peak today" that fell back to one whenever a colder instance did.
 *
 * So it lives in the store beside the chunks, scoped to the realm the same way.
 * Three shapes, because they answer three different questions:
 *
 * - **Presence** is a hash of the sessions every instance currently holds, each
 *   row refreshed on the 5 second flush. A row older than `PRESENCE_STALE` is
 *   from an instance that died without tidying up, so readers ignore it and
 *   drop it. This is where "in town now" and the roster come from.
 * - **Seen buckets** are sets of identity ids, one per day and one per hour.
 *   A set answers "how many people", which a counter cannot: it is immune to
 *   reconnects, to two instances counting at once and to the order they write
 *   in, and it only ever grows inside its window.
 * - **The feed** is a capped list, newest first, shared by every instance.
 *
 * Writes ride the same 5 second timer as the chunks and positions, in one
 * pipeline. Nothing here is on the tick's critical path.
 */

/** The feed surfaces show three rows; a few spare cover a burst of activity. */
export const FEED_LIMIT = 6
/** Same actor, same kind of act, inside this window: one row, not two. */
const FEED_COALESCE = 6_000
/** How many hours the title screen's sparkline covers. */
const SERIES_HOURS = 9
const HOUR = 3_600_000
/** The roster panel holds five rows before it scrolls; send six. */
const ROSTER_LIMIT = 6
/** A presence row not refreshed inside this is from an instance that is gone.
 *  Comfortably more than the 5 second flush, well under the 60 second stale
 *  session timeout, so a live player is never blinked out of the roster. */
const PRESENCE_STALE = 30_000
/** Hour buckets outlive the window the sparkline reads by an hour or so; the
 *  day bucket outlives the longest day any timezone can hand us. */
const HOUR_TTL = (SERIES_HOURS + 2) * 3600
const DAY_TTL = 36 * 3600
/** A name off the wire is capped at 20; the store is outside the trust boundary
 *  the same way the wire is, so what comes back is capped again. */
const MAX_NAME = 20

/** One live session, as any instance in the realm sees it. */
export interface RosterEntry {
  name: string
  /** Minutes in town rather than a ping: latency is measured by the client's
   *  own heartbeat, so the server has no honest per-player number to report. */
  minutes: number
}

export interface LiveStatus {
  /** Everyone with a live session in the realm, not just on this instance. */
  players: number
  /** How many distinct processes hold those sessions. One is the assumption the
   *  whole design rests on; anything above it means the realm has split. */
  instances: number
  /** Distinct identities that have entered the realm today. */
  today: number
  /** The same count for each of the last nine hours, oldest first. */
  series: number[]
  roster: RosterEntry[]
  feed: WorldEvent[]
}

/** What `flushLive` needs to know about a session. */
export interface LiveSession {
  id: string
  name: string
  joinedAt: number
}

/* -------------------------------------------------------------------------- */
/* Buckets                                                                    */
/* -------------------------------------------------------------------------- */

/** UTC, so every instance in the realm agrees on where the day ends however
 *  the platform has its clock set. */
function dayBucket(now: number): SeenBucket {
  return { key: seenKey(`d${new Date(now).toISOString().slice(0, 10)}`), ttl: DAY_TTL }
}

function hourBucket(hour: number): SeenBucket {
  return { key: seenKey(`h${hour}`), ttl: HOUR_TTL }
}

/** The nine hours the sparkline draws, oldest first. */
function seriesBuckets(now: number): SeenBucket[] {
  const hour = Math.floor(now / HOUR)
  return Array.from({ length: SERIES_HOURS }, (_, i) => hourBucket(hour - (SERIES_HOURS - 1 - i)))
}

/** The buckets a player who is here *right now* belongs in. */
function currentBuckets(now: number): SeenBucket[] {
  return [dayBucket(now), hourBucket(Math.floor(now / HOUR))]
}

/* -------------------------------------------------------------------------- */
/* Presence rows                                                              */
/* -------------------------------------------------------------------------- */

/**
 * This process, for as long as it lives.
 *
 * It is on every presence row for one reason: counting the distinct ids among
 * the live rows is the only way to see, from outside, whether a realm's sockets
 * are actually landing on one instance. That is the number the whole
 * single-instance-per-realm assumption rests on, and it was being assumed rather
 * than measured. `/api/status` reports it as `instances`.
 */
const INSTANCE = Math.random().toString(36).slice(2, 8)

/** `<joinedAt>,<lastSeen>,<instance>,<name>`. The name is last and unescaped,
 *  so nothing it contains can shift the fields in front of it. */
function encodePresence(joinedAt: number, lastSeen: number, name: string): string {
  return `${joinedAt},${lastSeen},${INSTANCE},${name}`
}

interface PresenceRow {
  joinedAt: number
  lastSeen: number
  instance: string
  name: string
}

function decodePresence(raw: string): PresenceRow | null {
  const parts = raw.split(',')
  if (parts.length < 4) return null
  const joinedAt = Number(parts[0])
  const lastSeen = Number(parts[1])
  const instance = (parts[2] ?? '').slice(0, 16)
  // The name may hold commas of its own, so it is whatever is left.
  const name = parts.slice(3).join(',').slice(0, MAX_NAME)
  if (!Number.isFinite(joinedAt) || !Number.isFinite(lastSeen) || !instance || !name) return null
  return { joinedAt, lastSeen, instance, name }
}

/* -------------------------------------------------------------------------- */
/* The feed                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rows this instance has recorded and not yet pushed, oldest last.
 *
 * Coalescing is why they wait. A row can still absorb the next act by the same
 * player for `FEED_COALESCE`, and rewriting the head of a shared list is not
 * something two instances can do at once without a script, so a row is held
 * until it is too old to change and pushed after that. It is never held from
 * *this* instance's readers: `recentEvents` returns the pending rows in front of
 * the shared ones, which is what `welcome` carries.
 */
const pending: WorldEvent[] = []

/** The shared feed as of the last flush, newest first. */
let shared: WorldEvent[] = []

export function recordEvent(name: string, kind: string, text: string) {
  const at = Date.now()
  const head = pending[pending.length - 1]
  if (head && head.name === name && head.kind === kind && at - head.at < FEED_COALESCE) {
    head.at = at
    head.text = text
    return
  }
  pending.push({ at, name, text, kind })
}

/** Newest first, for `welcome` and for anything on this instance that cannot
 *  wait for a round trip. */
export function recentEvents(): WorldEvent[] {
  if (!pending.length) return shared
  return [...pending].reverse().concat(shared).slice(0, FEED_LIMIT)
}

function decodeEvent(raw: string): WorldEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<WorldEvent>
    if (typeof value?.at !== 'number' || typeof value.name !== 'string') return null
    if (typeof value.text !== 'string' || typeof value.kind !== 'string') return null
    return { at: value.at, name: value.name.slice(0, MAX_NAME), text: value.text, kind: value.kind }
  }
  catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* The sky                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A forced sky is a fact about the world, not about the instance whose player
 * asked for it.
 *
 * `weather` and `timeOfDay` are module state in `game.ts` and always will be:
 * the tick reads them and the auto curve is a pure function of the clock, which
 * every instance agrees on for free. What does not come free is somebody asking
 * the Oracle for rain. That set one instance's variable and broadcast to one
 * instance's players, and everybody else kept their clear sky.
 *
 * So a turn is written here and read back on the same 5 second timer as
 * everything else, and an instance that sees a newer one than its own adopts
 * it and tells its players. Newest wins on the timestamp, and the store is what
 * enforces it (`skyKey` in `chunkStore.ts`): an instance can sit on a turn for
 * up to a flush, so arrival order is not turn order. Weather and time of day are
 * two separate fields for the same reason, since carrying both on every turn
 * would let a change of hour on one instance undo rain asked for on another.
 * The cost of the agreement is that a change takes a flush to cross, which for
 * weather is nothing.
 */

/** `<at>,<mode>`. */
function encodeTurn(at: number, mode: string): string {
  return `${at},${mode}`
}

function decodeTurn(raw: string | null): { at: number, mode: string } | null {
  if (!raw) return null
  const comma = raw.indexOf(',')
  const at = Number(raw.slice(0, comma))
  const mode = raw.slice(comma + 1)
  if (comma < 0 || !Number.isFinite(at) || !mode) return null
  return { at, mode }
}

const SKY_FIELDS: readonly SkyField[] = ['weather', 'time']

/** When each half of the sky this instance is showing was decided. */
const skyAt: Record<SkyField, number> = { weather: 0, time: 0 }
/** Turns this instance owes the realm, one per field, until a flush carries them. */
const skyPending: Record<SkyField, SkyTurn | null> = { weather: null, time: null }
/** What `game.ts` wants done when another instance turned the sky. */
let adoptSky: ((field: SkyField, mode: string) => void) | undefined

/** `game.ts` registers what to do with a turn it did not make: set the module
 *  state and broadcast, exactly as a local `/weather` would. */
export function onRemoteSky(handler: (field: SkyField, mode: string) => void) {
  adoptSky = handler
}

/** This instance just turned one half of the sky. Publish it on the next flush. */
export function publishSky(field: SkyField, mode: string) {
  const at = Date.now()
  skyAt[field] = at
  skyPending[field] = { field, at, value: encodeTurn(at, mode) }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** Identities whose presence row this instance owes the store a delete for. */
const leaving = new Set<string>()

/** This instance's own view, so a store that is down still says something
 *  rather than emptying the title screen. */
let localRoster: LiveSession[] = []

/** A player just arrived. Their row and their id go out immediately rather than
 *  on the next timer, so the title screen shows them within a poll. Feed rows
 *  still inside their window stay put: the tick is running, and draining them
 *  here would split every in-progress row in the town on every arrival. */
export function noteJoin(session: LiveSession, roster: Iterable<LiveSession>) {
  leaving.delete(session.id)
  void flushLive(roster)
}

/** ...and left. The row has to go now. Only the last player on this instance
 *  drains the feed too, because the tick stops with them and nothing else will
 *  ever push what is left. */
export function noteLeave(id: string, roster: Iterable<LiveSession>) {
  leaving.add(id)
  const sessions = [...roster]
  void flushLive(sessions, sessions.length === 0)
}

/**
 * Flushes run one at a time, in the order they were asked for, rather than the
 * newest one winning: a join and the leave that follows it are two writes to
 * the same presence field, and if the second were dropped because the first was
 * still in flight the row would be a ghost in the roster until it went stale.
 * A leave is exactly the case with nothing behind it, because the tick stops
 * with the last player on this instance.
 */
let chain: Promise<void> = Promise.resolve()

/**
 * Push this instance's share of the live surface, and take the shared feed back.
 *
 * `drainAll` sends even the feed rows that are still inside their coalesce
 * window, for the last leave on this instance, for the same reason. A failed
 * write puts everything back: a dropped `leave` is a ghost too.
 */
export function flushLive(roster: Iterable<LiveSession>, drainAll = false): Promise<void> {
  const sessions = [...roster]
  localRoster = sessions
  chain = chain.then(() => write(sessions, drainAll))
  return chain
}

async function write(sessions: readonly LiveSession[], drainAll: boolean): Promise<void> {
  const now = Date.now()
  const settled = drainAll ? pending.length : pending.findIndex(event => now - event.at < FEED_COALESCE)
  const events = pending.splice(0, settled < 0 ? pending.length : settled)
  const drop = [...leaving]
  leaving.clear()
  const sky = SKY_FIELDS.flatMap(field => skyPending[field] ?? [])
  for (const field of SKY_FIELDS) skyPending[field] = null

  try {
    await chunkStore().writeLive({
      // A row is rewritten every flush whether or not anything about it changed:
      // its `lastSeen` is the whole point, and an untouched row goes stale.
      presence: sessions.map(s => [s.id, encodePresence(s.joinedAt, now, s.name)] as const),
      drop,
      seen: currentBuckets(now),
      seenIds: sessions.map(s => s.id),
      events: events.map(event => JSON.stringify(event)),
      feedLimit: FEED_LIMIT,
      sky,
    })
  }
  catch (error) {
    console.error('[world] live flush failed', error)
    pending.unshift(...events)
    for (const id of drop) leaving.add(id)
    // A newer turn made while this one was in flight supersedes it.
    for (const turn of sky) skyPending[turn.field] ??= turn
    return
  }

  // Take the shared list back on every flush, not only when this instance had
  // a row of its own to push: `welcome.feed` is built from it, and a quiet
  // instance is exactly the one whose copy would otherwise be oldest. The sky
  // rides back on the same read.
  //
  // Its own `try`, deliberately. The write has landed by now, so a failed read
  // must not put anything back: the next flush would push the same feed rows a
  // second time. It just leaves the shared copy as it was until next time.
  let read
  try {
    read = await chunkStore().readLive([], FEED_LIMIT, false)
  }
  catch (error) {
    console.error('[world] live read-back failed', error)
    return
  }
  shared = read.events.map(decodeEvent).filter((event): event is WorldEvent => !!event)
  for (const field of SKY_FIELDS) {
    const turned = decodeTurn(read.sky[field])
    // Strictly newer, so this instance never re-adopts the turn it just wrote.
    if (turned && turned.at > skyAt[field]) {
      skyAt[field] = turned.at
      adoptSky?.(field, turned.mode)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** What this instance alone can say, for when the store is unreachable. */
function fallback(now: number): LiveStatus {
  return {
    players: localRoster.length,
    instances: localRoster.length ? 1 : 0,
    today: localRoster.length,
    series: Array.from({ length: SERIES_HOURS }, () => 0),
    roster: rosterFrom(localRoster.map(s => ({ joinedAt: s.joinedAt, lastSeen: now, instance: INSTANCE, name: s.name })), now),
    feed: recentEvents(),
  }
}

function rosterFrom(rows: readonly PresenceRow[], now: number): RosterEntry[] {
  return [...rows]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(0, ROSTER_LIMIT)
    .map(row => ({ name: row.name, minutes: Math.max(0, Math.floor((now - row.joinedAt) / 60_000)) }))
}

/**
 * Everything the title screen asks for, in one round trip.
 *
 * Rows from an instance that vanished are ignored and, since this is the only
 * place that reads the hash, dropped here too — best effort, on a second write
 * that nothing waits for. It can lose a race with a take-over (the same
 * identity reconnecting on another instance), which costs that player one poll:
 * their new instance writes the row again within five seconds.
 */
export async function liveStatus(): Promise<LiveStatus> {
  const now = Date.now()
  const buckets = [dayBucket(now), ...seriesBuckets(now)]
  let read
  try {
    read = await chunkStore().readLive(buckets.map(bucket => bucket.key), FEED_LIMIT)
  }
  catch (error) {
    console.error('[world] live read failed', error)
    return fallback(now)
  }

  const live: PresenceRow[] = []
  const stale: string[] = []
  for (const [id, raw] of read.presence) {
    const row = decodePresence(raw)
    if (!row || now - row.lastSeen > PRESENCE_STALE) stale.push(id)
    else live.push(row)
  }
  if (stale.length) {
    void chunkStore()
      .writeLive({ presence: [], drop: stale, seen: [], seenIds: [], events: [], feedLimit: FEED_LIMIT, sky: [] })
      .catch(() => {})
  }

  return {
    players: live.length,
    instances: new Set(live.map(row => row.instance)).size,
    today: read.seen[0] ?? 0,
    series: read.seen.slice(1),
    roster: rosterFrom(live, now),
    feed: read.events.map(decodeEvent).filter((event): event is WorldEvent => !!event),
  }
}
