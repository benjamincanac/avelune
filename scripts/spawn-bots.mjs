// Spawn wandering bot players against a running Tempest server (local or prod).
//
// Each bot mints a signed identity cookie via `POST /api/auth` (the same path
// the onboarding flow uses), then opens an authenticated WebSocket to
// `/api/ws` with that cookie on the upgrade — exactly like a real browser,
// so the server can't tell them apart from humans. Bots pick random walkable
// waypoints around their spawn, walk to them, jump/dash occasionally, and
// reconnect if the socket drops.
//
// Usage:
//   node scripts/spawn-bots.mjs [--url <base>] [--count N] [--radius R] [--chat]
//
// Examples:
//   node scripts/spawn-bots.mjs                       # 3 bots on prod
//   node scripts/spawn-bots.mjs --count 8             # 8 bots on prod
//   node scripts/spawn-bots.mjs --url http://localhost:50889 --count 5
//
// Ctrl-C for a clean shutdown (closes every socket).

import { GENDERS, HAIRSTYLES, OUTFITS, PLAYER_COLORS, outfitColorCount } from '../shared/utils/characters.ts'
import { generateHub, isWalkable } from '../shared/utils/maze.ts'

/* ------------------------------- args --------------------------------- */

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const BASE = String(flag('url', 'https://tempest-tower.vercel.app')).replace(/\/$/, '')
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws'
const COUNT = Math.max(1, Number(flag('count', 3)) || 3)
const RADIUS = Number(flag('radius', 5)) || 5 // wander radius around spawn (tiles)
const CHAT = flag('chat', false) === true

const rand = (min, max) => min + Math.random() * (max - min)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

// The arena is a fixed hand-authored map, identical on both sides — build its
// plan once and reuse it for every bot's waypoint validation.
const PLAN = generateHub()

/** A random walkable point within `r` tiles of (cx, cy), or null after N tries. */
function randomWaypoint(cx, cy, r) {
  for (let i = 0; i < 30; i++) {
    const a = rand(0, Math.PI * 2)
    const d = Math.sqrt(Math.random()) * r
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    if (isWalkable(PLAN, Math.floor(x), Math.floor(y))) return { x, y }
  }
  return null
}

/* --------------------------- bot appearance --------------------------- */

const NAMES = ['Grix', 'Vesper', 'Mott', 'Bramble', 'Cinder', 'Fenn', 'Halo', 'Juno', 'Kobb', 'Lark', 'Nix', 'Odar', 'Pell', 'Quill', 'Rue', 'Sable', 'Torv', 'Umber', 'Wisp', 'Yarn']
const CHAT_LINES = ['nice arena', 'over here', 'again?', 'this way', 'anyone seen the oracle', 'careful', 'follow me', 'hey']

function randomAppearance() {
  const gender = pick(GENDERS)
  const outfit = pick(OUTFITS).id
  const hair = pick(HAIRSTYLES[gender]).id
  return {
    username: `${pick(NAMES)}-bot`,
    character: `${outfit}_${gender}_${hair}`,
    colorIndex: PLAYER_COLORS.map((_, i) => i).filter(i => i !== 3 && i !== 4)[Math.floor(rand(0, 6))],
    outfitColor: Math.floor(Math.random() * outfitColorCount(outfit)),
  }
}

/* ------------------------------- bot ---------------------------------- */

const NO_MOVE = { forward: false, back: false, left: false, right: false }
/** How close to a waypoint counts as arrived (tiles). */
const ARRIVE = 0.7
/** ms between navigation decisions. */
const TICK = 400
let alive = 0

class Bot {
  constructor(n) {
    this.n = n
    this.cookie = null
    this.ws = null
    this.id = null
    this.pos = null // { x, y } from state frames
    this.prevPos = null // position at the previous tick (stuck detection)
    this.home = null // spawn anchor
    this.target = null // current waypoint
    this.stuck = 0
    this.angle = rand(0, Math.PI * 2)
    this.driving = false // is 'forward' currently held server-side?
    this.closed = false
    this.timers = []
  }

  async auth() {
    const appearance = randomAppearance()
    const res = await fetch(`${BASE}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(appearance),
    })
    if (!res.ok) throw new Error(`auth ${res.status}`)
    const jar = res.headers.getSetCookie?.() ?? []
    const idCookie = jar.map(c => c.split(';')[0]).find(c => c.startsWith('tempest_id='))
    if (!idCookie) throw new Error('no tempest_id cookie')
    this.cookie = idCookie
    this.name = appearance.username
  }

  connect() {
    const ws = new WebSocket(WS_URL, { headers: { cookie: this.cookie } })
    this.ws = ws

    ws.addEventListener('message', (e) => {
      let m
      try {
        m = JSON.parse(e.data)
      }
      catch { return }
      if (m.t === 'welcome' && m.self) {
        this.id = m.self.id
        this.pos = { x: m.self.x, y: m.self.y }
        this.home = { x: m.self.x, y: m.self.y }
        alive++
        console.log(`[${this.name}] welcome — ${m.players.length} in world`)
        this.startBehavior()
      }
      else if (m.t === 'state') {
        const me = m.players.find(p => p.id === this.id)
        if (me) this.pos = { x: me.x, y: me.y }
      }
      else if (m.t === 'kicked') {
        console.log(`[${this.name}] kicked: ${m.reason}`)
        this.close()
      }
    })

    ws.addEventListener('close', (e) => {
      this.stopTimers()
      if (this.started) {
        alive--
        this.started = false
      }
      if (this.closed) return
      console.log(`[${this.name}] socket closed (code ${e.code}) — reconnecting in 2s`)
      setTimeout(() => !this.closed && this.connect(), 2000)
    })
    ws.addEventListener('error', () => { /* close fires next */ })
  }

  startBehavior() {
    if (this.started) return
    this.started = true
    this.timers.push(setInterval(() => this.wander(), TICK))
    // Keep-alive ping so idle proxies don't reap the socket.
    this.timers.push(setInterval(() => this.send({ t: 'ping' }), 10_000))
    if (CHAT) this.timers.push(setInterval(() => {
      if (Math.random() < 0.15) this.send({ t: 'chat', text: pick(CHAT_LINES) })
    }, 8_000))
  }

  // One navigation decision: head for the current waypoint, pick a new one once
  // we arrive (or after idling), and hop/dash now and then for signs of life.
  wander() {
    if (!this.pos) return
    const anchor = this.home ?? this.pos

    if (!this.target || Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y) < ARRIVE) {
      this.target = randomWaypoint(anchor.x, anchor.y, RADIUS)
      // Pause on arrival every so often, so bots aren't all in constant motion.
      if (Math.random() < 0.25) {
        this.drive(this.angle, false)
        this.prevPos = { ...this.pos }
        return
      }
    }
    if (!this.target) return

    this.drive(Math.atan2(this.target.y - this.pos.y, this.target.x - this.pos.x), true)

    const r = Math.random()
    if (r < 0.06) this.send({ t: 'action', kind: 'jump' })
    else if (r < 0.1) this.send({ t: 'action', kind: 'dash' })

    this.trackStuck()
  }

  // Send a move only when the heading turned or the throttle toggled: the server
  // holds our intent between ticks, so re-sending identical frames is just noise.
  drive(angle, forward) {
    const turned = Math.abs(((angle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.05
    if (forward === this.driving && !turned) return
    this.angle = angle
    this.driving = forward
    this.send({ t: 'move', ...NO_MOVE, forward, a: angle })
  }

  // Barely moved since the last decision while trying to advance? We're wedged
  // on a wall or prop — drop the waypoint and hop to break free.
  trackStuck() {
    const moved = this.prevPos ? Math.hypot(this.pos.x - this.prevPos.x, this.pos.y - this.prevPos.y) : 1
    this.prevPos = { ...this.pos }
    if (moved > 0.05) {
      this.stuck = 0
      return
    }
    if (++this.stuck < 3) return
    this.send({ t: 'action', kind: 'jump' })
    this.target = null
    this.stuck = 0
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  stopTimers() {
    for (const t of this.timers) {
      clearInterval(t)
      clearTimeout(t)
    }
    this.timers = []
  }

  close() {
    this.closed = true
    this.stopTimers()
    try {
      this.ws?.close()
    }
    catch { /* ignore */ }
  }
}

/* ------------------------------- main --------------------------------- */

console.log(`Spawning ${COUNT} bot${COUNT > 1 ? 's' : ''} on ${BASE} (radius ${RADIUS}${CHAT ? ', chatty' : ''})`)

const bots = []
for (let i = 0; i < COUNT; i++) {
  const bot = new Bot(i)
  bots.push(bot)
  try {
    await bot.auth()
    bot.connect()
  }
  catch (err) {
    console.error(`[bot ${i}] failed to start: ${err.message}`)
  }
  await new Promise(r => setTimeout(r, 250)) // stagger auths + upgrades
}

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\nClosing ${bots.length} bot socket${bots.length > 1 ? 's' : ''}…`)
  for (const b of bots) b.close()
  setTimeout(() => process.exit(0), 400)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

setInterval(() => console.log(`— ${alive}/${COUNT} bots connected —`), 15_000)
