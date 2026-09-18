import type { ClientMessage, MoveInput, Player, PlayerState, ServerMessage, TimeOfDayMode, WeatherMode, WorldEvent } from '#shared/types/game'
import { MAX_CHAT_LENGTH, ORACLE_ID, ORACLE_NAME } from '#shared/types/game'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  bodySurfaceHeight,
  stepBody,
} from '#shared/utils/maze'
import { CHUNK_SIZE, TERRAFORM_STEP, TERRAFORM_VERBS, WORLD_TILE_MAX, WORLD_TILE_MIN, applyPlace, applyRemove, applyTerrain, chunkCoord, makePlacementId } from '#shared/utils/world'
import type { Chunk, SurfaceType } from '#shared/utils/world'
import { DEED_KIND, kitLabel } from '#shared/utils/kit'
import { EDITS_PER_SECOND, checkDemolish, checkTerraform, isKitKind, refusalText, resolveBuild } from '#shared/utils/building'
import {
  WORLD,
  broadcastToChunk,
  drainChunkQueue,
  findPlacement,
  flushDirtyChunks,
  forgetPlacement,
  indexPlacement,
  markChunkDirty,
  releaseViewer,
  residentChunk,
  STREAMED_CHUNKS,
  syncChunks,
  terrainDeltas,
} from './world'
import { addDeed, addPiece, deedCount, pieceCount, removeDeed, removePiece } from './pieces'
import { REALM, chunkStore } from './chunkStore'
import type { Identity } from './session'
import { FORTIFICATIONS } from '#shared/utils/courtyard'
import { realmName } from '#shared/utils/realm'
import HUB_ORACLE from '#shared/data/courtyard-oracle.json'
import type { HubMessage } from './oracle'
import { oracleGreeting, oracleReply } from './oracle'

/**
 * The authoritative arena.
 *
 * All simulation happens here, on the server, in a fixed-rate tick loop:
 * clients send *intent* (held movement keys plus their mouse-look heading) and
 * the server integrates positions and collisions, then fans out compact state
 * snapshots to every connection. Positions are never accepted from clients.
 *
 * One shared instance hosts every player in the one world. The authored town is
 * bundled, but the world around it is chunked, mutable and streamed: each
 * session holds the 5×5 chunks it stands in (`./world`), and every terraform,
 * build and demolish request is validated here against the shared rules in
 * `shared/utils/building.ts` before it touches a chunk.
 */

/** Simulation rate: 20 ticks per second. */
const TICK_MS = 50
/** Fan out a state snapshot every N ticks (10 per second). */
const BROADCAST_EVERY = 2
/** Sweep stale sessions every N ticks (5 seconds). */
const SWEEP_EVERY = 100
/** Drop players whose client stopped heartbeating (e.g. their tab crashed). */
const STALE_TIMEOUT = 60_000
/** Write dirty chunks back to the store every N ticks (5 seconds). */
const FLUSH_EVERY = 100
/** A session hears about players within this many tiles, and no further. Well
 *  past draw distance, so nobody pops in before their character is on screen —
 *  and wide enough to span the town's diagonal (the exterior is 136 tiles a
 *  side), so two players inside the walls never stop seeing each other move. */
const STATE_RANGE = 192
/** A body below this has fallen out of the world. Nothing should reach it, but
 *  a hole is a worse failure than a teleport, so it is caught and respawned. */
const VOID_FLOOR = -50
/** While a player's chunk is still in flight, look for it again this often. */
const RESYNC_EVERY = 20

interface Session {
  player: Player
  input: MoveInput
  /** Vertical velocity (jumping/falling). */
  vz: number
  grounded: boolean
  dashUntil: number
  dashCooldownUntil: number
  /** Position or heading changed since the last snapshot. */
  moved: boolean
  joinedAt: number
  lastSeen: number
  /** Chunk keys this socket holds, the ones still owed to it, and the chunk it
   *  last synced around. */
  chunks: Set<string>
  pending: Set<string>
  chunkCx: number
  chunkCy: number
  /** Edit budget: a token bucket refilled at `EDITS_PER_SECOND`. */
  editTokens: number
  editAt: number
  send: (data: string) => void
  close: () => void
}

const sessions = new Map<string, Session>()

let loop: ReturnType<typeof setInterval> | undefined
let tickCount = 0
let weather: WeatherMode = 'auto'
let timeOfDay: TimeOfDayMode = 'auto'

/**
 * Turn the shared sky. Players ask the Oracle for this (`oracleReply` calls
 * these on its classifier's verdict, and its reply is the announcement); the
 * dev commands below reach them too, so a harness can fix the sky without a
 * model.
 */
function setWeather(mode: WeatherMode) {
  weather = mode
  broadcast({ t: 'weather', mode })
}

function setTimeOfDay(mode: TimeOfDayMode) {
  timeOfDay = mode
  broadcast({ t: 'time', mode })
}

/**
 * Whether the dev-only chat commands are live.
 *
 * `/weather` and `/time` fix the sky and `/tp` moves a body without the sim's
 * consent, which is exactly what makes a rendering or building change
 * verifiable from a script — and exactly what has no business in a public
 * build. `nuxt dev` turns it on; a production build a verification harness
 * drives asks for it by name.
 */
const DEV_COMMANDS = import.meta.dev || process.env.AVELUNE_DEV_COMMANDS === '1'

/** How high above the ground a teleport parks a body whose destination chunk is
 *  still in flight from the store: the tick freezes it until the chunk lands,
 *  then it falls the last little way onto real ground. */
const TELEPORT_HOVER = 40

/** Spawn position, jittered so simultaneous arrivals don't stack. */
function spawnAt(): { x: number, y: number, z: number } {
  return {
    x: WORLD.start.x + (Math.random() - 0.5) * 0.8,
    y: WORLD.start.y + (Math.random() - 0.5) * 0.8,
    z: 0,
  }
}

function broadcast(msg: ServerMessage, exceptId?: string) {
  const data = JSON.stringify(msg)
  for (const [id, session] of sessions) {
    if (id === exceptId) continue
    session.send(data)
  }
}

function tick() {
  tickCount++
  const dt = TICK_MS / 1000
  const now = Date.now()

  for (const session of sessions.values()) {
    const { player, input } = session

    // Whatever else happens this tick, this session gets the next few chunks
    // it is owed, a handful at a time, so no one tick pays for a whole
    // neighbourhood.
    // Once a second the drain also re-asks the store for anything still
    // missing, which is how a failed read recovers.
    drainChunkQueue(session, tickCount % RESYNC_EVERY === 0)

    let drive = (input.forward ? 1 : 0) - (input.back ? 1 : 0)
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0)
    const dashing = now < session.dashUntil
    // A dash from a standstill still launches you forward (facing direction),
    // rather than burning the dash in place with no input to accelerate.
    if (dashing && drive === 0 && strafe === 0) drive = 1
    let dx = 0
    let dy = 0
    if (drive !== 0 || strafe !== 0) {
      // Normalize so diagonals aren't faster; dashing modifies speed.
      const len = Math.hypot(drive, strafe)
      const dash = dashing ? DASH_MULTIPLIER : 1
      const speed = PLAYER_SPEED * dash * dt / len
      const cos = Math.cos(player.angle)
      const sin = Math.sin(player.angle)
      dx = (cos * drive - sin * strafe) * speed
      dy = (sin * drive + cos * strafe) * speed
    }

    const before = { x: player.x, y: player.y, z: player.z }
    // The ground under this player may still be in flight from the store. A
    // missing chunk has no terrain height at all, so stepping the body would
    // drop it through the world and keep dropping it: freeze instead, and ask
    // for the chunk again every second until it arrives.
    if (!residentChunk(chunkCoord(player.x), chunkCoord(player.y))) {
      session.vz = 0
      session.grounded = true
      if (tickCount % RESYNC_EVERY === 0) syncChunks(session, player.x, player.y, true)
      continue
    }
    const body = { x: player.x, y: player.y, z: player.z, vz: session.vz, grounded: session.grounded }
    stepBody(WORLD, body, dx, dy, dt)
    player.x = body.x
    player.y = body.y
    player.z = body.z
    session.vz = body.vz
    session.grounded = body.grounded
    // Belt and braces: whatever let a body through the floor, it comes back.
    if (player.z < VOID_FLOOR) {
      const spawn = spawnAt()
      player.x = spawn.x
      player.y = spawn.y
      player.z = spawn.z
      session.vz = 0
      session.grounded = true
      session.moved = true
      console.error(`[game] ${player.id} fell out of the world; respawned`)
      syncChunks(session, player.x, player.y, true)
    }
    if (before.x !== player.x || before.y !== player.y || before.z !== player.z) {
      session.moved = true
    }
    // Crossing a chunk border pulls the next ring in and drops the far one.
    if (chunkCoord(player.x) !== session.chunkCx || chunkCoord(player.y) !== session.chunkCy) {
      syncChunks(session, player.x, player.y)
    }
    // The Oracle waits just inside South Gate: the greeting is for the moment
    // a traveller steps through it, not for the spawn bank across the moat.
    if (before.y >= GATE_LINE && player.y < GATE_LINE) deliverGreeting(session)
  }

  if (tickCount % BROADCAST_EVERY === 0) broadcastState(now)

  if (tickCount % SWEEP_EVERY === 0) {
    const min = Date.now() - STALE_TIMEOUT
    for (const session of sessions.values()) {
      // Close the socket; its close handler runs the normal disconnect path.
      if (session.lastSeen < min) session.close()
    }
  }

  // Write-behind: the flush is async and self-guarding, so the tick hands it
  // the roster (a CAS conflict has to re-send the chunk) and moves on.
  if (tickCount % FLUSH_EVERY === 0) void flushDirtyChunks(sessions.values())
}

/**
 * Fan out the players that moved, to the sessions near enough to care.
 *
 * The common case — a town's worth of players in sight of each other — pays for
 * one JSON string and one pass: if everybody, movers and watchers alike, fits
 * inside a box no wider than `STATE_RANGE`, then no pair of them is out of
 * range and the same frame serves all. Only a world with players spread further
 * apart than that falls back to filtering per session.
 */
function broadcastState(now: number) {
  const moved: { state: PlayerState, x: number, y: number }[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const session of sessions.values()) {
    const { id, x, y, z, angle } = session.player
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (!session.moved) continue
    session.moved = false
    const state: PlayerState = {
      id,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      a: Math.round(angle * 1000) / 1000,
    }
    if (now < session.dashUntil) state.d = true
    moved.push({ state, x, y })
  }
  if (!moved.length) return

  if (Math.hypot(maxX - minX, maxY - minY) <= STATE_RANGE) {
    broadcast({ t: 'state', players: moved.map(m => m.state) })
    return
  }

  const range2 = STATE_RANGE * STATE_RANGE
  for (const session of sessions.values()) {
    const { x, y } = session.player
    const players: PlayerState[] = []
    for (const m of moved) {
      const dx = m.x - x
      const dy = m.y - y
      if (dx * dx + dy * dy <= range2) players.push(m.state)
    }
    if (players.length) session.send(JSON.stringify({ t: 'state', players } satisfies ServerMessage))
  }
}

/** `AVELUNE_TICK_LOG=1` reports what the 20 Hz budget is actually costing,
 *  every 5 seconds. Off in production: it reads the clock twice per tick. */
const TICK_LOG = !!process.env.AVELUNE_TICK_LOG
let tickTotal = 0
let tickMax = 0

function timedTick() {
  const started = performance.now()
  tick()
  const ms = performance.now() - started
  tickTotal += ms
  if (ms > tickMax) tickMax = ms
  if (tickCount % SWEEP_EVERY === 0) {
    console.log(`[game] tick avg ${(tickTotal / SWEEP_EVERY).toFixed(2)}ms max ${tickMax.toFixed(2)}ms — ${sessions.size} players`)
    tickTotal = 0
    tickMax = 0
  }
}

function startLoop() {
  loop ??= setInterval(TICK_LOG ? timedTick : tick, TICK_MS)
}

function stopLoop() {
  if (loop && sessions.size === 0) {
    clearInterval(loop)
    loop = undefined
    // The tick was the only thing draining the dirty set. An empty town can sit
    // idle for hours, so the last player's edits go out with them.
    void flushDirtyChunks()
  }
}

/** Wrap an untrusted heading into [-PI, PI], or reject it. */
function toHeading(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  let a = value % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a < -Math.PI) a += Math.PI * 2
  return a
}

/* -------------------------------------------------------------------------- */
/* World edits                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One edit against the player's budget: a bucket of `EDITS_PER_SECOND` tokens
 * refilled continuously, shared by terraform, build and demolish. A held mouse
 * button spends at the refill rate; a script cannot spend faster.
 *
 * A refused request still costs a token. Validating one is not free, and an
 * invalid flood has to be as bounded as a valid one.
 */
function spendEdit(session: Session): boolean {
  const now = Date.now()
  session.editTokens = Math.min(EDITS_PER_SECOND, session.editTokens + (now - session.editAt) / 1000 * EDITS_PER_SECOND)
  session.editAt = now
  if (session.editTokens < 1) return false
  session.editTokens -= 1
  return true
}

/** Tell one player why their edit did not happen. Nobody else hears it. */
function refuse(session: Session, reason: string) {
  session.send(JSON.stringify({ t: 'reject', reason } satisfies ServerMessage))
}

/**
 * The same, for a refusal that may name a plot. The shared rules only know the
 * owner's id — they run on a client too — so the roster is consulted here and
 * the line becomes "that plot belongs to <name>". An owner who is not online
 * stays anonymous rather than being named from somewhere stale.
 */
function refuseEdit(session: Session, verdict: { reason: string, claim?: string }) {
  refuse(session, refusalText(verdict, id => sessions.get(id)?.player.name))
}

/**
 * Broadcast a `place` or `remove` to everyone holding the chunk, and hand the
 * player who asked for it the same frame with their owned-piece total on it.
 *
 * Only they get `pieces`: it is a fact about one identity, and nobody else's
 * HUD has a use for it. The author is sent to directly rather than filtered
 * back in, because their own edit must reach them whether or not the streaming
 * set happens to agree that they hold the chunk.
 */
function announceEdit(session: Session, chunk: Chunk, frame: Extract<ServerMessage, { t: 'place' | 'remove' }>) {
  broadcastToChunk(sessions.values(), chunk.cx, chunk.cy, frame, session)
  const id = session.player.id
  session.send(JSON.stringify({ ...frame, pieces: pieceCount(id), deeds: deedCount(id) } satisfies ServerMessage))
}

export interface Connection {
  player: Player
  handleMessage: (raw: string) => void
  disconnect: () => void
}

/* -------------------------------------------------------------------------- */
/* The Oracle's view of the world                                             */
/* -------------------------------------------------------------------------- */

/** Where the Oracle stands, in tiles — the authored pose the scene reads too. */
const ORACLE_STAND = { x: HUB_ORACLE[0]!, y: HUB_ORACLE[1]! }
/** A work counts as "beside the Oracle" within this many tiles of its stand. */
const ORACLE_REACH = 24
/**
 * Hard cap on the placement walk. Loaded chunks are already bounded (5×5 per
 * session), but the scan runs inline on a tool call from the tick loop's
 * thread, so it must never become unbounded work as the world grows.
 */
const SCAN_CAP = 30_000
/** Only the three biggest builders are named; a longer list reads as a ledger. */
const TOP_BUILDERS = 3

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const

/** Compass word for an offset in the tile plane, where +y runs south. */
function compass(dx: number, dy: number): string {
  if (!dx && !dy) return 'right at the gate'
  const step = Math.round(Math.atan2(dx, -dy) / (Math.PI / 4))
  return COMPASS[((step % 8) + 8) % 8]!
}

/** Distance in words: the Oracle speaks in walks, never in tile counts. */
function howFar(tiles: number): string {
  if (tiles < 20) return 'within sight of the gate'
  if (tiles < 60) return 'a short walk from the gate'
  if (tiles < 150) return 'a good walk from the gate'
  return 'far out beyond the gate'
}

/**
 * Day/night and weather as the sky actually shows them.
 *
 * The server never renders, so it holds only the *modes* (`auto` unless an
 * admin forced one) and lets `welcome.now` drive every client's sky. This
 * mirrors the auto curves in `app/utils/courtyardSky.ts` (`DAY_MS`, the
 * overcast sines) so the Oracle describes the same sky the traveller is
 * standing under. Keep the constants in step with that file.
 */
const DAY_MS = 15 * 60_000
function skyNow(now: number): { timeOfDay: string, weather: string } {
  let hour: string
  if (timeOfDay !== 'auto') {
    hour = timeOfDay === 'day' ? 'daylight' : timeOfDay
  }
  else {
    const sunAngle = (now / DAY_MS % 1) * Math.PI * 2 - Math.PI / 2
    const height = Math.sin(sunAngle)
    const rising = Math.cos(sunAngle) > 0
    hour = height < -0.08 ? 'night' : height < 0.25 ? (rising ? 'dawn' : 'sunset') : 'daylight'
  }

  let sky: string
  if (weather !== 'auto') {
    sky = weather
  }
  else {
    const seconds = now / 1000
    const overcast = Math.min(1, Math.max(0, 0.22 + 0.42 * Math.sin(seconds / 197) + 0.22 * Math.sin(seconds / 71 + 2.1)))
    sky = overcast > 0.68 ? 'rain' : overcast > 0.5 ? 'overcast' : overcast > 0.28 ? 'cloudy' : 'clear'
  }
  return { timeOfDay: hour, weather: sky }
}

/** What the Oracle can see of the built world, from one pass over the chunks. */
export interface ArenaState {
  /** Which world this is — one stored realm per deployment region. */
  realm: string
  /** 'clear' | 'cloudy' | 'overcast' | 'rain'. */
  weather: string
  /** 'dawn' | 'daylight' | 'sunset' | 'night'. */
  timeOfDay: string
  playersInArena: number
  players: { name: string, minutesHere: number }[]
  /** Only the built world outside the walls — the town itself is not counted. */
  building: {
    /** Kit pieces standing in the chunks currently loaded. */
    piecesStanding: number
    /** How many distinct builders own them. */
    builders: number
    /** Biggest builders by their own total, named when they are in the roster. */
    topBuilders: { name: string, here: boolean, pieces: number }[]
    /** Pieces standing within `ORACLE_REACH` tiles of where the Oracle stands. */
    piecesNearOracle: number
    /** The densest chunk, already worded as a direction and a walk. */
    busiestSpot?: { pieces: number, where: string }
  }
}

/**
 * A read-only snapshot of the living arena, for the Oracle's `arena_state`
 * tool. Because this runs in the same process as the authoritative game loop,
 * it reads the real in-memory roster and the real chunk map directly — no HTTP
 * hop, and always the true state (unlike a separate service, which on
 * serverless could miss the instance holding the sockets).
 *
 * The world half is computed here, on demand, in a single capped pass over the
 * loaded chunks. Nothing about it is maintained per tick: the Oracle speaks a
 * few times a minute at most, so paying once per tool call is far cheaper than
 * keeping counters warm 20 times a second.
 */
/* -------------------------------------------------------------------------- */
/* The live surface: peak, history and the world feed                          */
/* -------------------------------------------------------------------------- */

/** The feed surfaces show three rows; a few spare cover a burst of activity. */
const FEED_LIMIT = 6
const FEED_COALESCE = 6_000

const worldFeed: WorldEvent[] = []

function recordEvent(name: string, kind: string, text: string) {
  const at = Date.now()
  const head = worldFeed[0]
  if (head && head.name === name && head.kind === kind && at - head.at < FEED_COALESCE) {
    head.at = at
    head.text = text
    return
  }
  worldFeed.unshift({ at, name, text, kind })
  if (worldFeed.length > FEED_LIMIT) worldFeed.length = FEED_LIMIT
}

/** Newest first, for the landing page — which has no socket to watch. */
export function recentEvents(): WorldEvent[] {
  return worldFeed
}

/**
 * Roster history, kept only well enough to say something true on the title
 * screen: the highest count seen today, and the highest in each of the last
 * nine hours. Both are process-local — nothing is persisted, because the peak
 * of a world that resets with the process is a fact about the process.
 */
const SERIES_HOURS = 9
const HOUR = 3_600_000

const series: number[] = Array.from({ length: SERIES_HOURS }, () => 0)
let seriesHour = -1
let peakDay = ''
let peak = 0

/**
 * Bring the window up to now: roll the hourly buckets forward, zero-filling any
 * hour nobody was here for, and clear the peak when the day turns.
 *
 * Called on every read as well as on every join, because a world with one
 * long-lived session has no churn to drive it — it would otherwise serve
 * yesterday's peak under a "today" label and an eleven-hour-old bucket under
 * "last 9h".
 */
function rollWindow(now: number) {
  const hour = Math.floor(now / HOUR)
  if (seriesHour < 0) {
    seriesHour = hour
  }
  else if (hour > seriesHour) {
    const shift = Math.min(hour - seriesHour, SERIES_HOURS)
    series.splice(0, shift)
    while (series.length < SERIES_HOURS) series.push(0)
    seriesHour = hour
  }
  const day = new Date(now).toISOString().slice(0, 10)
  if (day !== peakDay) {
    peakDay = day
    peak = 0
  }
}

function notePlayers(n: number) {
  rollWindow(Date.now())
  if (n > peak) peak = n
  const last = SERIES_HOURS - 1
  if (n > series[last]!) series[last] = n
}

/** A roster row for the title screen, which has no socket to ask. Minutes in
 *  town rather than a ping: latency is measured by the client's own heartbeat,
 *  so the server has no honest per-player number to report. */
export interface RosterEntry {
  name: string
  minutes: number
}

/** The panel holds five rows before it starts scrolling; send six. */
const ROSTER_LIMIT = 6

/** Everything the title screen's stat blocks, sparkline and roster need. */
export function playerStats(): { players: number, peak: number, series: number[], roster: RosterEntry[] } {
  const now = Date.now()
  // Reading is also the only thing that happens in a quiet world, so it has to
  // both roll the window and fold the live roster into the current hour.
  rollWindow(now)
  notePlayers(sessions.size)
  return {
    players: sessions.size,
    peak,
    series: [...series],
    roster: [...sessions.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .slice(0, ROSTER_LIMIT)
      .map(session => ({ name: session.player.name, minutes: Math.floor((now - session.joinedAt) / 60_000) })),
  }
}

export function snapshot(): ArenaState {
  const now = Date.now()

  let piecesStanding = 0
  let piecesNearOracle = 0
  let scanned = 0
  const owners = new Set<string>()
  let busiest: { pieces: number, cx: number, cy: number } | undefined

  for (const chunk of WORLD.chunks.values()) {
    if (scanned >= SCAN_CAP) break
    let inChunk = 0
    for (const piece of chunk.placements) {
      if (++scanned >= SCAN_CAP) break
      if (!isKitKind(piece.kind)) continue
      inChunk++
      if (piece.owner) owners.add(piece.owner)
      const dx = piece.x - ORACLE_STAND.x
      const dy = piece.y - ORACLE_STAND.y
      if (dx * dx + dy * dy <= ORACLE_REACH * ORACLE_REACH) piecesNearOracle++
    }
    piecesStanding += inChunk
    if (inChunk && (!busiest || inChunk > busiest.pieces)) busiest = { pieces: inChunk, cx: chunk.cx, cy: chunk.cy }
  }

  // Rank by each builder's *own* total, which the piece budget already tracks
  // across restarts — counting only what happens to be loaded would rank a
  // builder by who is standing near their work rather than by what they built.
  const here = new Map([...sessions.values()].map(s => [s.player.id, s.player.name]))
  // Someone whose work sits in chunks nobody is standing in still built it, so
  // the present roster joins the owners seen in the scan as a candidate.
  const candidates = new Set([...owners, ...here.keys()])
  const topBuilders = [...candidates]
    .map(id => ({ name: here.get(id) ?? 'a builder who is away', here: here.has(id), pieces: pieceCount(id) }))
    .filter(b => b.pieces > 0)
    .sort((a, b) => b.pieces - a.pieces)
    .slice(0, TOP_BUILDERS)

  let busiestSpot: ArenaState['building']['busiestSpot']
  if (busiest) {
    const cx = busiest.cx * CHUNK_SIZE + CHUNK_SIZE / 2
    const cy = busiest.cy * CHUNK_SIZE + CHUNK_SIZE / 2
    const dx = cx - FORTIFICATIONS.gateX
    const dy = cy - FORTIFICATIONS.gateZ
    busiestSpot = { pieces: busiest.pieces, where: `to the ${compass(dx, dy)}, ${howFar(Math.hypot(dx, dy))}` }
  }

  return {
    realm: realmName(REALM),
    ...skyNow(now),
    playersInArena: sessions.size,
    players: [...sessions.values()].map(s => ({
      name: s.player.name,
      minutesHere: Math.floor((now - s.joinedAt) / 60_000),
    })),
    building: {
      piecesStanding,
      builders: owners.size,
      topBuilders,
      piecesNearOracle,
      busiestSpot,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Oracle: listens to the arena chat and answers only when a message is        */
/* actually addressed to it (the classifier in ./oracle decides).              */
/* -------------------------------------------------------------------------- */

/** Recent arena chat as context for the Oracle (players' lines and its own). */
const hubChat: HubMessage[] = []
const HUB_CHAT_CONTEXT = 12
/** One reply in flight at a time, plus a cooldown after each — anti-flood. */
let oracleBusy = false
let oracleQuietUntil = 0
const ORACLE_COOLDOWN = 4000

/**
 * Say an Oracle line: remember it as context for later replies, start the
 * cooldown, and put it on the wire as an ordinary chat frame from ORACLE_ID.
 */
function speak(reply: string) {
  oracleQuietUntil = Date.now() + ORACLE_COOLDOWN
  hubChat.push({ name: ORACLE_NAME, text: reply })
  if (hubChat.length > HUB_CHAT_CONTEXT) hubChat.shift()
  broadcast({ t: 'chat', id: ORACLE_ID, text: reply })
}

function considerOracle(name: string, text: string) {
  hubChat.push({ name, text })
  if (hubChat.length > HUB_CHAT_CONTEXT) hubChat.shift()
  // Don't even classify while replying or cooling down: the classifier gates
  // *what* it answers, these gate *how often* — together they prevent floods.
  if (oracleBusy || Date.now() < oracleQuietUntil) return
  oracleBusy = true
  oracleReply([...hubChat], snapshot, { now: () => skyNow(Date.now()), setWeather, setTime: setTimeOfDay })
    .then((reply) => {
      if (reply) speak(reply)
    })
    .catch(() => {})
    .finally(() => {
      oracleBusy = false
    })
}

/** Greet an identity at most this often, so a reload doesn't re-greet. */
const GREET_INTERVAL = 30 * 60_000
/**
 * The gate threshold in tile space (player `y` is world z). The walls have no
 * other opening, so crossing this line southward-to-northward is entering town.
 */
const GATE_LINE = FORTIFICATIONS.gateZ
/** A greeting waits this long for a busy Oracle, then gives up rather than queue. */
const GREET_WINDOW = 20_000
/** How long to wait before looking again at a busy Oracle. */
const GREET_RETRY = 1500
/** When each identity was last greeted (identity id, not socket). */
const greetedAt = new Map<string, number>()

/**
 * Greet a traveller as they step through South Gate.
 *
 * The line is written, not generated (`oracleGreeting` picks one to suit the
 * company and the sky), so an arrival costs no model call however many arrive
 * at once. Gated once per identity per `GREET_INTERVAL`, so walking back and
 * forth through the gate, a refresh or a tab take-over stays silent.
 *
 * Never talks over a reply in flight or a cooldown: it waits, looking again
 * every `GREET_RETRY`, and gives up once `GREET_WINDOW` has passed — a party
 * arriving together is worth a short wait, a busy chat is not, and a greeting
 * never queues indefinitely. Giving up, or the traveller leaving first,
 * releases the slot so the next visit is greeted.
 */
function deliverGreeting(session: Session) {
  const { id, name } = session.player
  const now = Date.now()
  for (const [key, at] of greetedAt) {
    if (now - at > GREET_INTERVAL) greetedAt.delete(key)
  }
  if (greetedAt.has(id)) return
  greetedAt.set(id, now)
  const deadline = now + GREET_WINDOW

  const attempt = (delay: number) => {
    const timer = setTimeout(() => {
      // Gone again, or the Oracle stayed busy too long: drop it, don't queue.
      if (sessions.get(id) !== session) return void greetedAt.delete(id)
      if (oracleBusy || Date.now() < oracleQuietUntil) {
        if (Date.now() > deadline) return void greetedAt.delete(id)
        // Wait out whatever the Oracle is saying, then look again.
        return attempt(Math.max(oracleQuietUntil - Date.now() + 200, GREET_RETRY))
      }
      speak(oracleGreeting(name, { others: sessions.size - 1, ...skyNow(Date.now()) }))
    }, delay)
    // Never hold the process open just for a pending greeting.
    ;(timer as { unref?: () => void }).unref?.()
  }

  attempt(0)
}

/**
 * Register a new socket. Spawns the authenticated identity's character in the
 * arena, sends the welcome frame with the world state, and announces the join.
 * Identity (id/name/color/character) comes from the signed cookie the WS
 * handler verified — see server/utils/session.ts.
 */
export function registerConnection(identity: Identity, send: (data: string) => void, close: () => void): Connection {
  const player: Player = {
    ...identity,
    ...spawnAt(),
    angle: -Math.PI / 2,
  }

  const session: Session = {
    player,
    input: { forward: false, back: false, left: false, right: false },
    vz: 0,
    grounded: true,
    dashUntil: 0,
    dashCooldownUntil: 0,
    moved: false,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    chunks: new Set(),
    pending: new Set(),
    chunkCx: Number.NaN,
    chunkCy: Number.NaN,
    editTokens: EDITS_PER_SECOND,
    editAt: Date.now(),
    send,
    close,
  }

  // Single live session per identity: if this player already has a socket open
  // (a second tab, or a refresh that raced its own close), the newest one wins.
  // Install the new session first, then boot the old socket with a `kicked`
  // notice so its tab stops instead of reconnecting into a take-over war.
  // `others` excludes this id so the booted session isn't duplicated into the
  // newcomer's initial roster.
  const existing = sessions.get(player.id)
  const others = [...sessions.values()].map(s => s.player).filter(p => p.id !== player.id)
  sessions.set(player.id, session)
  startLoop()
  if (existing) {
    existing.send(JSON.stringify({ t: 'kicked', reason: 'You opened the arena in another tab. This window has been disconnected.' } satisfies ServerMessage))
    existing.close()
  }

  send(JSON.stringify({
    t: 'welcome',
    self: player,
    players: others,
    now: Date.now(),
    weather,
    timeOfDay,
    world: { chunkSize: WORLD.chunkSize, bounds: WORLD.bounds, seed: WORLD.seed, realm: REALM, persistent: chunkStore().kind !== 'memory', streamed: STREAMED_CHUNKS },
    // The budget readout is the server's to fill: this identity's pieces are
    // spread over the whole world, and the client only ever holds 25 chunks.
    pieces: pieceCount(player.id),
    deeds: deedCount(player.id),
    feed: worldFeed,
  } satisfies ServerMessage))
  // The ground before anything standing on it: the spawn neighbourhood goes out
  // on the same tick as the welcome, so no `state` can ever name a player on a
  // chunk the client has not been given.
  syncChunks(session, player.x, player.y, true)
  broadcast({ t: 'join', player }, player.id)
  recordEvent(player.name, 'join', 'entered the town')
  notePlayers(sessions.size)

  return {
    player,
    handleMessage(raw) {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw) as ClientMessage
      }
      catch {
        return
      }

      session.lastSeen = Date.now()

      // The wire is untrusted: validate every field before acting on it.
      switch (msg.t) {
        case 'move': {
          session.input = { forward: !!msg.forward, back: !!msg.back, left: !!msg.left, right: !!msg.right }
          const heading = toHeading(msg.a)
          if (heading !== null && heading !== player.angle) {
            player.angle = heading
            session.moved = true
          }
          break
        }
        case 'action': {
          if (msg.kind === 'jump' && session.grounded) {
            session.vz = JUMP_VELOCITY
            session.grounded = false
            session.moved = true
          }
          else if (msg.kind === 'dash' && Date.now() >= session.dashCooldownUntil) {
            session.dashUntil = Date.now() + DASH_DURATION * 1000
            session.dashCooldownUntil = Date.now() + DASH_COOLDOWN * 1000
          }
          break
        }
        case 'chat': {
          if (typeof msg.text !== 'string') return
          const text = msg.text.trim().slice(0, MAX_CHAT_LENGTH)
          if (!text) return
          const [command, mode, ...extra] = text.toLowerCase().split(/\s+/)
          if (DEV_COMMANDS && command === '/tp') {
            const tx = Number(mode)
            const ty = Number(extra[0])
            if (extra.length !== 1 || !Number.isFinite(tx) || !Number.isFinite(ty)) {
              send(JSON.stringify({ t: 'system', text: 'Usage: /tp <x> <y>' } satisfies ServerMessage))
              return
            }
            if (tx < WORLD_TILE_MIN || ty < WORLD_TILE_MIN || tx >= WORLD_TILE_MAX || ty >= WORLD_TILE_MAX) {
              send(JSON.stringify({ t: 'system', text: 'That is outside the world.' } satisfies ServerMessage))
              return
            }
            player.x = tx
            player.y = ty
            session.vz = 0
            session.grounded = true
            session.moved = true
            // Pull the destination's chunks before reading the ground: without
            // them the height is -Infinity and the body has nothing to stand on.
            syncChunks(session, player.x, player.y, true)
            const floor = bodySurfaceHeight(WORLD, tx, ty, TELEPORT_HOVER)
            player.z = Number.isFinite(floor) ? floor : TELEPORT_HOVER
            send(JSON.stringify({ t: 'system', text: `Moved to ${Math.round(tx)}, ${Math.round(ty)}.` } satisfies ServerMessage))
            return
          }
          if (DEV_COMMANDS && command === '/weather') {
            if (extra.length || (mode !== 'auto' && mode !== 'clear' && mode !== 'overcast' && mode !== 'rain')) {
              send(JSON.stringify({ t: 'system', text: 'Usage: /weather clear | overcast | rain | auto' } satisfies ServerMessage))
              return
            }
            setWeather(mode)
            broadcast({ t: 'system', text: mode === 'auto' ? 'Automatic weather restored.' : `Weather changed to ${mode}.` })
            return
          }
          if (DEV_COMMANDS && command === '/time') {
            if (extra.length || (mode !== 'auto' && mode !== 'dawn' && mode !== 'day' && mode !== 'sunset' && mode !== 'night')) {
              send(JSON.stringify({ t: 'system', text: 'Usage: /time dawn | day | sunset | night | auto' } satisfies ServerMessage))
              return
            }
            setTimeOfDay(mode)
            broadcast({ t: 'system', text: mode === 'auto' ? 'Automatic day/night cycle restored.' : `Time of day changed to ${mode}.` })
            return
          }
          broadcast({ t: 'chat', id: player.id, text }, player.id)
          // The Oracle overhears the arena and answers only when addressed.
          considerOracle(player.name, text)
          break
        }
        case 'terraform': {
          if (!spendEdit(session)) return refuse(session, 'slow down')
          const request = { x: msg.x, y: msg.y, mode: msg.mode, size: msg.size, surface: msg.surface as SurfaceType | undefined }
          const verdict = checkTerraform(WORLD, request, player)
          if (!verdict.ok) return refuseEdit(session, verdict)
          const changed = applyTerrain(WORLD, { ...request, maxStep: TERRAFORM_STEP })
          if (!changed.length) return
          for (const chunk of changed) markChunkDirty(chunk)
          // A brush on a chunk border writes the same corner in up to four
          // chunks, and each of them is somebody's seam — send every one.
          for (const frame of terrainDeltas(request, changed)) {
            broadcastToChunk(sessions.values(), frame.cx, frame.cy, { ...frame, by: player.id, mode: request.mode, at: [Math.round(request.x), Math.round(request.y)] })
          }
          recordEvent(player.name, `terrain:${request.mode}`, `${TERRAFORM_VERBS[request.mode]} at ${Math.round(request.x)}, ${Math.round(request.y)}`)
          break
        }
        case 'build': {
          if (!spendEdit(session)) return refuse(session, 'slow down')
          const owned = pieceCount(player.id)
          const resolved = resolveBuild(
            WORLD,
            { kind: msg.kind, x: msg.x, y: msg.y, rot: msg.rot, h: msg.h },
            player,
            { owner: player.id, id: makePlacementId(), pieces: owned, deeds: deedCount(player.id) },
          )
          if (!resolved.ok) return refuseEdit(session, resolved)
          const chunk = applyPlace(WORLD, resolved.placement)
          if (!chunk) return refuse(session, 'outside the world')
          addPiece(player.id)
          if (resolved.placement.kind === DEED_KIND) addDeed(player.id)
          indexPlacement(resolved.placement)
          markChunkDirty(chunk)
          announceEdit(session, chunk, { t: 'place', cx: chunk.cx, cy: chunk.cy, v: chunk.version, piece: resolved.placement })
          recordEvent(
            player.name,
            `build:${resolved.placement.kind}`,
            resolved.placement.kind === DEED_KIND ? 'claimed a plot' : `placed a ${kitLabel(resolved.placement.kind).toLowerCase()}`,
          )
          break
        }
        case 'demolish': {
          if (typeof msg.id !== 'string') return
          if (!spendEdit(session)) return refuse(session, 'slow down')
          const placement = findPlacement(msg.id)
          if (!placement) return refuse(session, 'nothing to remove')
          const verdict = checkDemolish(WORLD, placement, player, player.id)
          if (!verdict.ok) return refuseEdit(session, verdict)
          const chunk = applyRemove(WORLD, placement.id)
          if (!chunk) return refuse(session, 'nothing to remove')
          forgetPlacement(placement.id)
          if (placement.owner) removePiece(placement.owner)
          // Pulling your own deed releases the plot. Whatever stood inside it
          // stays exactly where it is: the claim was the post, not the ground.
          if (placement.owner && placement.kind === DEED_KIND) removeDeed(placement.owner)
          markChunkDirty(chunk)
          announceEdit(session, chunk, { t: 'remove', cx: chunk.cx, cy: chunk.cy, v: chunk.version, id: placement.id })
          recordEvent(
            player.name,
            `clear:${placement.kind}`,
            placement.kind === DEED_KIND ? 'released a plot' : `cleared a ${kitLabel(placement.kind).toLowerCase()}`,
          )
          break
        }
        case 'ping':
          send(JSON.stringify({ t: 'pong' } satisfies ServerMessage))
          break
      }
    },
    disconnect() {
      // Only tear down the roster entry if this exact session still owns the id.
      // A newer tab may have taken over (see the take-over above), in which case
      // the booted socket's close lands here too — but the delete + leave belong
      // to the session that replaced it, not this one.
      if (sessions.get(player.id) === session) {
        sessions.delete(player.id)
        broadcast({ t: 'leave', id: player.id })
        notePlayers(sessions.size)
      }
      releaseViewer(session)
      stopLoop()
    },
  }
}
