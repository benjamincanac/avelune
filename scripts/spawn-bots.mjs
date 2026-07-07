// Spawn wandering bot players against a running Mugen server (local or prod).
//
// Each bot mints a signed identity cookie via `POST /api/auth` (the same path
// the onboarding flow uses), then opens an authenticated WebSocket to
// `/api/ws` with that cookie on the upgrade — exactly like a real browser,
// so the server can't tell them apart from humans. Bots wander the hub near
// their spawn (steering home when they drift, so they don't blunder into the
// dive portal), jump/dash occasionally, and reconnect if the socket drops.
//
// Usage:
//   node scripts/spawn-bots.mjs [--url <base>] [--count N] [--radius R] [--chat] [--dive]
//
// Examples:
//   node scripts/spawn-bots.mjs                       # 3 bots on prod
//   node scripts/spawn-bots.mjs --count 8             # 8 bots on prod
//   node scripts/spawn-bots.mjs --url http://localhost:50889 --count 5
//
// Ctrl-C for a clean shutdown (closes every socket).

import { GENDERS, HAIRSTYLES, OUTFITS, PLAYER_COLORS, outfitColorCount } from '../shared/utils/characters.ts'
import { HUB_FLOOR, HUB_LAYOUT, generateFloor, isWalkable } from '../shared/utils/maze.ts'

/* ------------------------------- args --------------------------------- */

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const BASE = String(flag('url', 'https://mugen-tower.vercel.app')).replace(/\/$/, '')
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws'
const COUNT = Math.max(1, Number(flag('count', 3)) || 3)
const RADIUS = Number(flag('radius', 5)) || 5 // wander radius around spawn (tiles)
const CHAT = flag('chat', false) === true
const DIVE = flag('dive', false) === true // let bots seek the exit instead of loitering

const rand = (min, max) => min + Math.random() * (max - min)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

/* --------------------- deterministic exit lookup ---------------------- */

// Floors are deterministic from (seed, floor); the hub is a fixed layout.
// Cache plans and routes so 12 bots don't recompute the same maze each one.
const planCache = new Map()
const pathCache = new Map()

function planFor(seed, floor) {
  const key = `${seed}:${floor}`
  let plan = planCache.get(key)
  if (!plan) { plan = generateFloor(floor, seed); planCache.set(key, plan) }
  return plan
}

// Breadth-first route over walkable tiles from the floor's start to its exit,
// returned as tile-center waypoints. Corridors are ≥1 tile wide, so 4-neighbour
// BFS on tile centres is enough to thread the labyrinth. null if unreachable.
function pathFor(seed, floor) {
  const key = `${seed}:${floor}`
  if (pathCache.has(key)) return pathCache.get(key)
  const plan = planFor(seed, floor)
  const W = plan.width, H = plan.height
  const startI = Math.floor(plan.start.y) * W + Math.floor(plan.start.x)
  const goalI = Math.floor(plan.exit.y) * W + Math.floor(plan.exit.x)
  const prev = new Int32Array(W * H).fill(-1)
  const seen = new Uint8Array(W * H)
  const queue = [startI]
  seen[startI] = 1
  let head = 0, found = false
  while (head < queue.length) {
    const cur = queue[head++]
    if (cur === goalI) { found = true; break }
    const cx = cur % W, cy = (cur - cx) / W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy
      const ni = ny * W + nx
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ni] || !isWalkable(plan, nx, ny)) continue
      seen[ni] = 1
      prev[ni] = cur
      queue.push(ni)
    }
  }
  let path = null
  if (found) {
    path = []
    for (let ci = goalI; ci !== -1; ci = prev[ci]) {
      path.push({ x: (ci % W) + 0.5, y: Math.floor(ci / W) + 0.5 })
      if (ci === startI) break
    }
    path.reverse()
  }
  pathCache.set(key, path)
  return path
}

/* --------------------------- bot appearance --------------------------- */

const NAMES = ['Grix', 'Vesper', 'Mott', 'Bramble', 'Cinder', 'Fenn', 'Halo', 'Juno', 'Kobb', 'Lark', 'Nix', 'Odar', 'Pell', 'Quill', 'Rue', 'Sable', 'Torv', 'Umber', 'Wisp', 'Yarn']
const CHAT_LINES = ['deeper', 'watch the floor', 'nearly had it', 'again?', 'this way', 'run', 'careful', 'follow me']

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
    this.seed = null
    this.floor = 0
    this.path = null // BFS waypoints for the current floor
    this.pathFloor = -1
    this.wp = 0 // index of the next waypoint
    this.stuck = 0
    this.angle = rand(0, Math.PI * 2)
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
    const mugen = jar.map(c => c.split(';')[0]).find(c => c.startsWith('mugen_id='))
    if (!mugen) throw new Error('no mugen_id cookie')
    this.cookie = mugen
    this.name = appearance.username
  }

  connect() {
    const ws = new WebSocket(WS_URL, { headers: { cookie: this.cookie } })
    this.ws = ws

    ws.addEventListener('message', (e) => {
      let m
      try { m = JSON.parse(e.data) }
      catch { return }
      if (m.t === 'welcome' && m.self) {
        this.id = m.self.id
        this.seed = m.seed
        this.floor = m.self.floor
        this.pos = { x: m.self.x, y: m.self.y }
        this.home = { x: m.self.x, y: m.self.y }
        alive++
        console.log(`[${this.name}] welcome — floor ${m.self.floor}, ${m.players.length} in world, seed ${m.seed}`)
        this.startBehavior()
      }
      else if (m.t === 'state') {
        const me = m.players.find(p => p.id === this.id)
        if (me) { this.pos = { x: me.x, y: me.y }; this.floor = me.f }
      }
      else if (m.t === 'death' && m.id === this.id) {
        console.log(`[${this.name}] died: ${m.cause} — respawned in hub`)
        this.floor = 0
      }
      else if (m.t === 'clear' && m.id === this.id) {
        console.log(`[${this.name}] cleared floor ${m.floor} → ${m.to}`)
        this.floor = m.to
        this.home = null // re-anchor on the next state frame
      }
      else if (m.t === 'maze') {
        this.seed = m.seed
        this.floor = 0
        this.home = null
      }
    })

    ws.addEventListener('close', (e) => {
      this.stopTimers()
      if (this.started) { alive--; this.started = false }
      if (this.closed) return
      console.log(`[${this.name}] socket closed (code ${e.code}) — reconnecting in 2s`)
      setTimeout(() => !this.closed && this.connect(), 2000)
    })
    ws.addEventListener('error', () => { /* close fires next */ })
  }

  startBehavior() {
    if (this.started) return
    this.started = true
    // Wander tick: choose a heading and hold forward for a beat.
    this.timers.push(setInterval(() => this.wander(), 900))
    // Keep-alive ping so idle proxies don't reap the socket.
    this.timers.push(setInterval(() => this.send({ t: 'ping' }), 10_000))
    if (CHAT) this.timers.push(setInterval(() => { if (Math.random() < 0.15) this.send({ t: 'chat', text: pick(CHAT_LINES) }) }, 8_000))
  }

  wander() {
    if (!this.pos) return

    if (DIVE) this.steerToExit()
    else this.loiter()

    // Walk for most of the tick, then coast to a stop.
    this.send({ t: 'move', ...NO_MOVE, forward: true, a: this.angle })
    this.timers.push(setTimeout(() => this.send({ t: 'move', ...NO_MOVE, a: this.angle }), rand(500, 750)))
    this.prevPos = { ...this.pos }
  }

  // Head for the floor's exit portal. The hub has a clear spawn→portal lane, so
  // there we make straight for it. On the labyrinth floors we follow a BFS route
  // (tile-center waypoints), advancing as we reach each, and break out of the
  // occasional wall-wedge with a hop + heading nudge.
  steerToExit() {
    if (this.floor === HUB_FLOOR) {
      this.angle = Math.atan2(HUB_LAYOUT.exit.y - this.pos.y, HUB_LAYOUT.exit.x - this.pos.x)
      if (Math.random() < 0.3) this.send({ t: 'action', kind: 'dash' })
      return
    }

    // (Re)load the route whenever we land on a new floor.
    if (this.pathFloor !== this.floor) {
      this.path = pathFor(this.seed, this.floor)
      this.pathFloor = this.floor
      this.wp = 0
    }

    const path = this.path
    if (!path) { // unreachable route — fall back to straight-line + jitter
      const exit = planFor(this.seed, this.floor).exit
      this.angle = this.stuck >= 2 ? rand(0, Math.PI * 2) : Math.atan2(exit.y - this.pos.y, exit.x - this.pos.x)
      this.bumpStuck(0.15, true)
      return
    }

    // Advance past every waypoint we're already on top of.
    while (this.wp < path.length - 1 && Math.hypot(path[this.wp].x - this.pos.x, path[this.wp].y - this.pos.y) < 0.9) this.wp++
    const target = path[this.wp]

    this.bumpStuck(0.1, false)
    if (this.stuck >= 3) {
      this.send({ t: 'action', kind: 'jump' })
      this.angle = Math.atan2(target.y - this.pos.y, target.x - this.pos.x) + rand(-1, 1)
      if (this.stuck > 6) this.stuck = 0
    }
    else {
      this.angle = Math.atan2(target.y - this.pos.y, target.x - this.pos.x)
      if (Math.random() < 0.2) this.send({ t: 'action', kind: 'dash' })
    }
  }

  // Track how long we've barely moved; optionally hop when wedged.
  bumpStuck(threshold, hopWhenStuck) {
    const moved = this.prevPos ? Math.hypot(this.pos.x - this.prevPos.x, this.pos.y - this.prevPos.y) : 1
    if (moved < threshold) this.stuck++
    else this.stuck = 0
    if (hopWhenStuck && this.stuck >= 2) {
      this.send({ t: 'action', kind: 'jump' })
      if (this.stuck > 5) this.stuck = 0
    }
  }

  // Mill around near spawn without drifting into the dive portal.
  loiter() {
    if (this.home) {
      const dx = this.home.x - this.pos.x
      const dy = this.home.y - this.pos.y
      if (Math.hypot(dx, dy) > RADIUS) this.angle = Math.atan2(dy, dx)
      else if (Math.random() < 0.6) this.angle = rand(0, Math.PI * 2)
    }
    else if (Math.random() < 0.6) {
      this.angle = rand(0, Math.PI * 2)
    }
    const r = Math.random()
    if (r < 0.1) this.send({ t: 'action', kind: 'jump' })
    else if (r < 0.18) this.send({ t: 'action', kind: 'dash' })
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  stopTimers() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t) }
    this.timers = []
  }

  close() {
    this.closed = true
    this.stopTimers()
    try { this.ws?.close() }
    catch { /* ignore */ }
  }
}

/* ------------------------------- main --------------------------------- */

console.log(`Spawning ${COUNT} bot${COUNT > 1 ? 's' : ''} on ${BASE} (radius ${RADIUS}${DIVE ? ', diving' : ''}${CHAT ? ', chatty' : ''})`)

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
