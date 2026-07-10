import type { ClientMessage, FloorRecord, MoveInput, Player, PlayerState, ServerMessage } from '#shared/types/game'
import { MAX_CHAT_LENGTH, ORACLE_ID, ORACLE_NAME } from '#shared/types/game'
import type { FloorPlan } from '#shared/utils/maze'
import {
  BIOMES,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  DEATH_DELAY,
  EXIT_RADIUS,
  HUB_FLOOR,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  PORTAL_RADIUS,
  TOWER_SEED,
  TRAP_MAX_Z,
  TRAP_RADIUS,
  biomeIndex,
  floorSpeed,
  generateFloor,
  isTrapActive,
  stepBody,
} from '#shared/utils/maze'
import type { Identity } from './session'
import { newUserId } from './session'
import type { HubMessage } from './oracle'
import { oracleReply } from './oracle'

/**
 * The authoritative tower.
 *
 * All simulation happens here, on the server, in a fixed-rate tick loop:
 * clients send *intent* (held movement keys plus their mouse-look heading)
 * and the server integrates positions, collisions, hazards, floor
 * transitions, and deaths, then fans out compact state snapshots to every
 * connection. Positions are never accepted from clients, so depth on the
 * leaderboard can't be faked.
 *
 * One shared instance hosts every player across every floor — floors are
 * just a property of a player, and each floor's geometry is loaded on demand
 * from bundled authored data (keyed by the constant TOWER_SEED). Scores and
 * positions live in instance memory; the world itself is fixed and eternal,
 * so it's effectively persistent while nothing is stored anywhere. (Records
 * and progress are all-time and in-memory — they reset only on redeploy.)
 */

/** Simulation rate: 20 ticks per second. */
const TICK_MS = 50
/** Fan out a state snapshot every N ticks (10 per second). */
const BROADCAST_EVERY = 2
/** Sweep stale sessions every N ticks (5 seconds). */
const SWEEP_EVERY = 100
/** Drop players whose client stopped heartbeating (e.g. their tab crashed). */
const STALE_TIMEOUT = 60_000

interface Session {
  player: Player
  input: MoveInput
  /** Vertical velocity (jumping/falling). */
  vz: number
  grounded: boolean
  dashUntil: number
  dashCooldownUntil: number
  /** When set, the player is dead and lying where they fell; respawns at this time. */
  dyingUntil: number
  /** Position, heading, or floor changed since the last snapshot. */
  moved: boolean
  /** When the player entered their current floor (for clear times). */
  floorEnteredAt: number
  lastSeen: number
  send: (data: string) => void
  close: () => void
}

/** A read-only watcher: receives every broadcast but is never simulated,
 * counted, or part of the roster. Lives outside `sessions` entirely. */
interface Spectator {
  lastSeen: number
  send: (data: string) => void
  close: () => void
}

const floorCache = new Map<number, FloorPlan>()
const sessions = new Map<string, Session>()
const spectators = new Map<string, Spectator>()
/** Best clear time per floor (all-time; in-memory, resets on redeploy). */
const records = new Map<number, FloorRecord>()
/** Deepest floor reached per player, keyed by their stable identity id.
 * Outlives a socket (a refresh drops the connection but not the climb) so the
 * hub door can resume you where you left off. */
const progress = new Map<string, number>()

let loop: ReturnType<typeof setInterval> | undefined
let tickCount = 0

function getFloor(floor: number): FloorPlan {
  let plan = floorCache.get(floor)
  if (!plan) {
    plan = generateFloor(floor, TOWER_SEED)
    floorCache.set(floor, plan)
  }
  return plan
}

/** Spawn position on a floor, jittered so simultaneous arrivals don't stack. */
function spawnAt(floor: number): { x: number, y: number, z: number, floor: number } {
  const plan = getFloor(floor)
  return {
    x: plan.start.x + (Math.random() - 0.5) * 0.8,
    y: plan.start.y + (Math.random() - 0.5) * 0.8,
    z: 0,
    floor,
  }
}

function broadcast(msg: ServerMessage, exceptId?: string) {
  const data = JSON.stringify(msg)
  for (const [id, session] of sessions) {
    if (id === exceptId) continue
    session.send(data)
  }
  // Spectators receive every frame (join/leave/state/chat/death/clear).
  for (const spectator of spectators.values()) spectator.send(data)
}

function tick() {
  tickCount++
  const dt = TICK_MS / 1000
  const now = Date.now()

  for (const session of sessions.values()) {
    const { player, input } = session
    const plan = getFloor(player.floor)

    // A dying player lies where they fell — no input, movement, hazards or
    // exits — until the death delay elapses, then respawns in the hub.
    if (session.dyingUntil) {
      if (now >= session.dyingUntil) {
        session.dyingUntil = 0
        Object.assign(player, spawnAt(HUB_FLOOR))
        session.vz = 0
        session.grounded = true
        session.floorEnteredAt = now
        session.moved = true
      }
      continue
    }

    let drive = (input.forward ? 1 : 0) - (input.back ? 1 : 0)
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0)
    const dashing = now < session.dashUntil
    // A dash from a standstill still launches you forward (facing direction),
    // rather than burning the dash in place with no input to accelerate.
    if (dashing && drive === 0 && strafe === 0) drive = 1
    let dx = 0
    let dy = 0
    if (drive !== 0 || strafe !== 0) {
      // Normalize so diagonals aren't faster; biomes and dashing modify speed.
      const len = Math.hypot(drive, strafe)
      const dash = dashing ? DASH_MULTIPLIER : 1
      const speed = PLAYER_SPEED * floorSpeed(player.floor) * dash * dt / len
      const cos = Math.cos(player.angle)
      const sin = Math.sin(player.angle)
      dx = (cos * drive - sin * strafe) * speed
      dy = (sin * drive + cos * strafe) * speed
    }

    const before = { x: player.x, y: player.y, z: player.z }
    const body = { x: player.x, y: player.y, z: player.z, vz: session.vz, grounded: session.grounded }
    stepBody(plan, body, dx, dy, dt)
    player.x = body.x
    player.y = body.y
    player.z = body.z
    session.vz = body.vz
    session.grounded = body.grounded
    if (before.x !== player.x || before.y !== player.y || before.z !== player.z) {
      session.moved = true
    }

    // Hazards: an active trap kills unless you're airborne enough to clear it.
    if (player.floor !== HUB_FLOOR && player.z < TRAP_MAX_Z) {
      const trap = plan.traps.find(t =>
        Math.hypot(t.x - player.x, t.y - player.y) < TRAP_RADIUS && isTrapActive(t, now),
      )
      if (trap) {
        const cause = BIOMES[biomeIndex(player.floor)]!.cause
        player.deaths++
        // Fall dead on the spot; the hub respawn is deferred (see top of loop)
        // so the death clip can play. `moved` pushes the death pose out at once.
        session.dyingUntil = now + DEATH_DELAY * 1000
        session.vz = 0
        session.grounded = true
        session.moved = true
        broadcast({ t: 'death', id: player.id, floor: player.floor, cause })
        continue
      }
    }

    // Floor transitions: the hub's teleport circle, or a floor's exit portal.
    const trigger = player.floor === HUB_FLOOR ? PORTAL_RADIUS : EXIT_RADIUS
    if (Math.hypot(plan.exit.x - player.x, plan.exit.y - player.y) < trigger) {
      const cleared = player.floor
      const ms = now - session.floorEnteredAt
      // From the hub, the portal resumes you at your deepest floor today (or
      // floor 1 if you've yet to climb); a floor's exit drops to the next one.
      const dest = cleared === HUB_FLOOR ? Math.max(HUB_FLOOR + 1, player.best) : cleared + 1
      Object.assign(player, spawnAt(dest))
      player.best = Math.max(player.best, player.floor)
      progress.set(player.id, player.best)
      session.floorEnteredAt = now

      let record = false
      if (cleared !== HUB_FLOOR) {
        const current = records.get(cleared)
        if (!current || ms < current.ms) {
          records.set(cleared, { floor: cleared, name: player.name, ms })
          record = true
        }
      }
      broadcast({ t: 'clear', id: player.id, name: player.name, floor: cleared, to: player.floor, ms, best: player.best, record })
    }
  }

  if (tickCount % BROADCAST_EVERY === 0) {
    const players: PlayerState[] = []
    for (const session of sessions.values()) {
      // Dying players sit still, so `moved` is false — include them anyway so
      // the death flag (and the frozen pose) keeps reaching clients.
      const dying = session.dyingUntil > now
      if (!session.moved && !dying) continue
      session.moved = false
      const { id, x, y, z, angle, floor } = session.player
      const state: PlayerState = {
        id,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        z: Math.round(z * 100) / 100,
        a: Math.round(angle * 1000) / 1000,
        f: floor,
      }
      if (now < session.dashUntil) state.d = true
      if (dying) state.dead = true
      players.push(state)
    }
    if (players.length) broadcast({ t: 'state', players })
  }

  if (tickCount % SWEEP_EVERY === 0) {
    const min = Date.now() - STALE_TIMEOUT
    for (const session of sessions.values()) {
      // Close the socket; its close handler runs the normal disconnect path.
      if (session.lastSeen < min) session.close()
    }
    for (const spectator of spectators.values()) {
      if (spectator.lastSeen < min) spectator.close()
    }
  }
}

function startLoop() {
  loop ??= setInterval(tick, TICK_MS)
}

function stopLoop() {
  if (loop && sessions.size === 0 && spectators.size === 0) {
    clearInterval(loop)
    loop = undefined
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

export interface Connection {
  /** The spawned character, or undefined for a read-only spectator. */
  player?: Player
  handleMessage: (raw: string) => void
  disconnect: () => void
}

/**
 * The fastest clear per floor, sorted by floor. Read by `GET /api/records`
 * so the login gate can show the board before any socket is open; in-game and
 * spectator clients get the same data live in their `welcome` frame.
 */
export function currentRecords(): FloorRecord[] {
  return [...records.values()].sort((a, b) => a.floor - b.floor)
}

/**
 * How many runners are connected right now (spectators excluded — they never
 * enter `sessions`). Read by `GET /api/records` so the main menu can show the
 * tower's population before any socket is open.
 */
export function currentOnline(): number {
  return sessions.size
}

/**
 * A read-only snapshot of the living tower, for the hub Oracle's `tower_state`
 * tool. Because this runs in the same process as the authoritative game loop,
 * it reads the real in-memory roster and records directly — no HTTP hop, and
 * always the true state (unlike a separate service, which on serverless could
 * miss the instance holding the sockets).
 */
export function snapshot() {
  const players = [...sessions.values()].map(s => s.player)
  return {
    runnersInTower: players.length,
    deepest: players
      .filter(p => p.best > 0)
      .sort((a, b) => b.best - a.best || a.deaths - b.deaths)
      .slice(0, 5)
      .map(p => ({ name: p.name, deepestFloor: p.best, onFloor: p.floor, deaths: p.deaths })),
    records: [...records.values()]
      .sort((a, b) => a.floor - b.floor)
      .map(r => ({ floor: r.floor, holder: r.name, timeMs: r.ms })),
  }
}

/* -------------------------------------------------------------------------- */
/* Hub Oracle: listens to the shared plaza chat and answers only when a        */
/* message is actually addressed to it (the classifier in ./oracle decides).   */
/* -------------------------------------------------------------------------- */

/** Recent hub chat as context for the Oracle (runners' lines and its own). */
const hubChat: HubMessage[] = []
const HUB_CHAT_CONTEXT = 12
/** One reply in flight at a time, plus a cooldown after each — anti-flood. */
let oracleBusy = false
let oracleQuietUntil = 0
const ORACLE_COOLDOWN = 4000

function considerOracle(name: string, text: string) {
  hubChat.push({ name, text })
  if (hubChat.length > HUB_CHAT_CONTEXT) hubChat.shift()
  console.log('[oracle] consider', name, JSON.stringify(text), { busy: oracleBusy, cooling: Date.now() < oracleQuietUntil })
  // Don't even classify while replying or cooling down: the classifier gates
  // *what* it answers, these gate *how often* — together they prevent floods.
  if (oracleBusy || Date.now() < oracleQuietUntil) return
  oracleBusy = true
  oracleReply([...hubChat], snapshot)
    .then((reply) => {
      console.log('[oracle] reply', JSON.stringify(reply))
      if (!reply) return
      oracleQuietUntil = Date.now() + ORACLE_COOLDOWN
      hubChat.push({ name: ORACLE_NAME, text: reply })
      if (hubChat.length > HUB_CHAT_CONTEXT) hubChat.shift()
      broadcast({ t: 'chat', id: ORACLE_ID, text: reply, f: HUB_FLOOR })
    })
    .catch(() => {})
    .finally(() => {
      oracleBusy = false
    })
}

/**
 * Register a new socket. Spawns the authenticated identity's character in the
 * hub plaza, sends the welcome frame with the world state, and announces the
 * join. Identity (id/name/color/character) comes from the signed cookie the
 * WS handler verified — see server/utils/session.ts.
 */
export function registerConnection(identity: Identity, send: (data: string) => void, close: () => void): Connection {
  const player: Player = {
    ...identity,
    ...spawnAt(HUB_FLOOR),
    angle: -Math.PI / 2,
    // Restore your deepest floor so a refresh keeps your rank, and the hub
    // door sends you back down to where you left off rather than to floor 1.
    best: progress.get(identity.id) ?? 0,
    deaths: 0,
  }

  const session: Session = {
    player,
    input: { forward: false, back: false, left: false, right: false },
    vz: 0,
    grounded: true,
    dashUntil: 0,
    dashCooldownUntil: 0,
    dyingUntil: 0,
    moved: false,
    floorEnteredAt: Date.now(),
    lastSeen: Date.now(),
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
    existing.send(JSON.stringify({ t: 'kicked', reason: 'You opened the tower in another tab. This window has been disconnected.' } satisfies ServerMessage))
    existing.close()
  }

  send(JSON.stringify({
    t: 'welcome',
    self: player,
    players: others,
    seed: TOWER_SEED,
    now: Date.now(),
    records: [...records.values()],
  } satisfies ServerMessage))
  broadcast({ t: 'join', player }, player.id)

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

      if (msg.t === 'chat') console.log('[game] chat msg from', player.name, 'floor', player.floor, JSON.stringify((msg as { text?: string }).text))

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
          broadcast({ t: 'chat', id: player.id, text, f: player.floor }, player.id)
          // The hub Oracle overhears the plaza and answers only when addressed.
          if (player.floor === HUB_FLOOR) considerOracle(player.name, text)
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
      }
      stopLoop()
    },
  }
}

/**
 * Register a read-only spectator. Unlike a player, a spectator spawns no
 * character: it never enters `sessions`, isn't simulated, counted, or
 * broadcast as a join/leave. It just receives the current world state (via a
 * self-less `welcome`) and every subsequent broadcast. No identity cookie is
 * required — spectating is anonymous.
 */
export function registerSpectator(send: (data: string) => void, close: () => void): Connection {
  const id = newUserId()
  spectators.set(id, { lastSeen: Date.now(), send, close })
  startLoop()

  send(JSON.stringify({
    t: 'welcome',
    self: null,
    players: [...sessions.values()].map(s => s.player),
    seed: TOWER_SEED,
    now: Date.now(),
    records: [...records.values()],
  } satisfies ServerMessage))

  return {
    handleMessage(raw) {
      const spectator = spectators.get(id)
      if (!spectator) return
      spectator.lastSeen = Date.now()
      // Read-only: the only frame a spectator sends is a heartbeat ping.
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw) as ClientMessage
      }
      catch {
        return
      }
      if (msg.t === 'ping') send(JSON.stringify({ t: 'pong' } satisfies ServerMessage))
    },
    disconnect() {
      spectators.delete(id)
      stopLoop()
    },
  }
}
