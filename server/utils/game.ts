import type { ClientMessage, MoveInput, Player, PlayerState, ServerMessage } from '#shared/types/game'
import { MAX_CHAT_LENGTH, COACH_ID, COACH_NAME } from '#shared/types/game'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  generateArena,
  stepBody,
} from '#shared/utils/arena'
import type { Identity } from './session'
import type { ArenaMessage } from './coach'
import { coachReply } from './coach'

/**
 * The authoritative arena.
 *
 * All simulation happens here, on the server, in a fixed-rate tick loop:
 * clients send *intent* (held movement keys plus their mouse-look heading) and
 * the server integrates positions and collisions, then fans out compact state
 * snapshots to every connection. Positions are never accepted from clients.
 *
 * One shared instance hosts every player in the one arena. Its geometry is
 * hand-authored and bundled, so no world data ever travels over the wire —
 * only players. Nothing is persisted: the roster lives in instance memory and
 * the arena itself is a constant.
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
  /** Position or heading changed since the last snapshot. */
  moved: boolean
  joinedAt: number
  lastSeen: number
  send: (data: string) => void
  close: () => void
}

/** The one arena. Hand-authored and constant, so it's built once at boot. */
const PLAN = generateArena()

const sessions = new Map<string, Session>()

let loop: ReturnType<typeof setInterval> | undefined
let tickCount = 0

/** Spawn position, jittered so simultaneous arrivals don't stack. */
function spawnAt(): { x: number, y: number, z: number } {
  return {
    x: PLAN.start.x + (Math.random() - 0.5) * 0.8,
    y: PLAN.start.y + (Math.random() - 0.5) * 0.8,
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
    const body = { x: player.x, y: player.y, z: player.z, vz: session.vz, grounded: session.grounded }
    stepBody(PLAN, body, dx, dy, dt)
    player.x = body.x
    player.y = body.y
    player.z = body.z
    session.vz = body.vz
    session.grounded = body.grounded
    if (before.x !== player.x || before.y !== player.y || before.z !== player.z) {
      session.moved = true
    }
  }

  if (tickCount % BROADCAST_EVERY === 0) {
    const players: PlayerState[] = []
    for (const session of sessions.values()) {
      if (!session.moved) continue
      session.moved = false
      const { id, x, y, z, angle } = session.player
      const state: PlayerState = {
        id,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        z: Math.round(z * 100) / 100,
        a: Math.round(angle * 1000) / 1000,
      }
      if (now < session.dashUntil) state.d = true
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
  }
}

function startLoop() {
  loop ??= setInterval(tick, TICK_MS)
}

function stopLoop() {
  if (loop && sessions.size === 0) {
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
  player: Player
  handleMessage: (raw: string) => void
  disconnect: () => void
}

/**
 * A read-only snapshot of the living stadium, for the Coach's `arena_state`
 * tool. Because this runs in the same process as the authoritative game loop,
 * it reads the real in-memory roster directly — no HTTP hop, and always the
 * true state (unlike a separate service, which on serverless could miss the
 * instance holding the sockets).
 */
export function snapshot() {
  const now = Date.now()
  return {
    playersInArena: sessions.size,
    players: [...sessions.values()].map(s => ({
      name: s.player.name,
      minutesHere: Math.floor((now - s.joinedAt) / 60_000),
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Coach: listens to the arena chat and answers only when a message is        */
/* actually addressed to it (the classifier in ./coach decides). While it     */
/* consults the docs, everyone sees an `coach` thinking frame.                */
/* -------------------------------------------------------------------------- */

/** Recent arena chat as context for the Coach (players' lines and its own). */
const arenaChat: ArenaMessage[] = []
const ARENA_CHAT_CONTEXT = 12
/** One reply in flight at a time, plus a cooldown after each — anti-flood. */
let coachBusy = false
let coachQuietUntil = 0
const COACH_COOLDOWN = 4000

function considerCoach(name: string, text: string) {
  arenaChat.push({ name, text })
  if (arenaChat.length > ARENA_CHAT_CONTEXT) arenaChat.shift()
  // Don't even classify while replying or cooling down: the classifier gates
  // *what* it answers, these gate *how often* — together they prevent floods.
  if (coachBusy || Date.now() < coachQuietUntil) return
  coachBusy = true
  let thinking = false
  coachReply([...arenaChat], snapshot, () => {
    thinking = true
    broadcast({ t: 'coach', thinking: true })
  })
    .then((reply) => {
      if (!reply) return
      coachQuietUntil = Date.now() + COACH_COOLDOWN
      arenaChat.push({ name: COACH_NAME, text: reply })
      if (arenaChat.length > ARENA_CHAT_CONTEXT) arenaChat.shift()
      broadcast({ t: 'chat', id: COACH_ID, text: reply })
    })
    .catch(() => {})
    .finally(() => {
      coachBusy = false
      if (thinking) broadcast({ t: 'coach', thinking: false })
    })
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
          broadcast({ t: 'chat', id: player.id, text }, player.id)
          // The Coach overhears the arena and answers only when addressed.
          considerCoach(player.name, text)
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
