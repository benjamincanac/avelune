import type { ClientMessage, FloorRecord, MoveInput, Player, PlayerState, ServerMessage } from '#shared/types/game'
import { MAX_CHAT_LENGTH } from '#shared/types/game'
import type { FloorPlan } from '#shared/utils/maze'
import {
  BIOMES,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  EXIT_RADIUS,
  HUB_FLOOR,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  PORTAL_RADIUS,
  TRAP_MAX_Z,
  TRAP_RADIUS,
  biomeIndex,
  dateSeed,
  floorSpeed,
  generateFloor,
  isTrapActive,
  stepBody,
} from '#shared/utils/maze'
import { createIdentity } from './identity'

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
 * just a property of a player, and each floor's geometry is derived on
 * demand from (day seed, floor index). Scores and positions live in
 * instance memory; the tower itself is reproducible from the date, so the
 * world is effectively persistent while nothing is stored anywhere.
 */

/** Simulation rate: 20 ticks per second. */
const TICK_MS = 50
/** Fan out a state snapshot every N ticks (10 per second). */
const BROADCAST_EVERY = 2
/** Sweep stale sessions and check the date rollover every N ticks (5 seconds). */
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
  /** Position, heading, or floor changed since the last snapshot. */
  moved: boolean
  /** When the player entered their current floor (for clear times). */
  floorEnteredAt: number
  lastSeen: number
  send: (data: string) => void
  close: () => void
}

let daySeed = dateSeed()
const floorCache = new Map<number, FloorPlan>()
const sessions = new Map<string, Session>()
/** Best clear time per floor today. */
const records = new Map<number, FloorRecord>()

let loop: ReturnType<typeof setInterval> | undefined
let tickCount = 0

function getFloor(floor: number): FloorPlan {
  let plan = floorCache.get(floor)
  if (!plan) {
    plan = generateFloor(floor, daySeed)
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
}

/** Midnight UTC passed: a fresh tower, everyone back to the hub. */
function rolloverTower() {
  daySeed = dateSeed()
  floorCache.clear()
  records.clear()
  for (const session of sessions.values()) {
    Object.assign(session.player, spawnAt(HUB_FLOOR))
    session.player.best = 0
    session.floorEnteredAt = Date.now()
    session.moved = false
  }
  broadcast({ t: 'maze', seed: daySeed, players: [...sessions.values()].map(s => s.player) })
}

function tick() {
  tickCount++
  const dt = TICK_MS / 1000
  const now = Date.now()

  for (const session of sessions.values()) {
    const { player, input } = session
    const plan = getFloor(player.floor)

    const drive = (input.forward ? 1 : 0) - (input.back ? 1 : 0)
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0)
    let dx = 0
    let dy = 0
    if (drive !== 0 || strafe !== 0) {
      // Normalize so diagonals aren't faster; biomes and dashing modify speed.
      const len = Math.hypot(drive, strafe)
      const dash = now < session.dashUntil ? DASH_MULTIPLIER : 1
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
        const diedOn = player.floor
        player.deaths++
        Object.assign(player, spawnAt(HUB_FLOOR))
        session.vz = 0
        session.grounded = true
        session.floorEnteredAt = now
        broadcast({ t: 'death', id: player.id, floor: diedOn, cause })
        continue
      }
    }

    // Floor transitions: the hub's teleport circle, or a floor's exit portal.
    const trigger = player.floor === HUB_FLOOR ? PORTAL_RADIUS : EXIT_RADIUS
    if (Math.hypot(plan.exit.x - player.x, plan.exit.y - player.y) < trigger) {
      const cleared = player.floor
      const ms = now - session.floorEnteredAt
      Object.assign(player, spawnAt(cleared + 1))
      player.best = Math.max(player.best, player.floor)
      session.floorEnteredAt = now

      let record = false
      if (cleared !== HUB_FLOOR) {
        const current = records.get(cleared)
        if (!current || ms < current.ms) {
          records.set(cleared, { floor: cleared, name: player.name, ms })
          record = true
        }
      }
      broadcast({ t: 'clear', id: player.id, name: player.name, floor: cleared, ms, best: player.best, record })
    }
  }

  if (tickCount % BROADCAST_EVERY === 0) {
    const players: PlayerState[] = []
    for (const session of sessions.values()) {
      if (!session.moved) continue
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
      players.push(state)
    }
    if (players.length) broadcast({ t: 'state', players })
  }

  if (tickCount % SWEEP_EVERY === 0) {
    if (dateSeed() !== daySeed) rolloverTower()

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
 * Register a new socket. Spawns a character in the hub plaza, sends the
 * welcome frame with the world state, and announces the join.
 */
export function registerConnection(send: (data: string) => void, close: () => void): Connection {
  if (dateSeed() !== daySeed) rolloverTower()

  const player: Player = {
    ...createIdentity(),
    ...spawnAt(HUB_FLOOR),
    angle: -Math.PI / 2,
    best: 0,
    deaths: 0,
  }

  const session: Session = {
    player,
    input: { forward: false, back: false, left: false, right: false },
    vz: 0,
    grounded: true,
    dashUntil: 0,
    dashCooldownUntil: 0,
    moved: false,
    floorEnteredAt: Date.now(),
    lastSeen: Date.now(),
    send,
    close,
  }

  const others = [...sessions.values()].map(s => s.player)
  sessions.set(player.id, session)
  startLoop()

  send(JSON.stringify({
    t: 'welcome',
    self: player,
    players: others,
    seed: daySeed,
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
          break
        }
        case 'ping':
          send(JSON.stringify({ t: 'pong' } satisfies ServerMessage))
          break
      }
    },
    disconnect() {
      sessions.delete(player.id)
      stopLoop()
      broadcast({ t: 'leave', id: player.id })
    },
  }
}
