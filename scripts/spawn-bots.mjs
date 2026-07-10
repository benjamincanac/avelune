// Spawn wandering bot players against a running Tempest server (local or prod).
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
import { DASH_COOLDOWN, HUB_FLOOR, HUB_LAYOUT, PLAYER_RADIUS, PLAYER_SPEED, TRAP_RADIUS, floorSpeed, generateFloor, isTrapActive, isWalkable } from '../shared/utils/maze.ts'

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
const DIVE = flag('dive', false) === true // dive for the exit (routes the maze, times traps) instead of loitering

const rand = (min, max) => min + Math.random() * (max - min)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

const DIVE_TICK = 160 // ms between navigation decisions when diving (~6×/s, tight enough to time traps)
const TRAP_LOOKAHEAD = 1.4 // tiles ahead we scan the travel ray for timed hazards

// Shortest signed angle from b to a, wrapped to [-PI, PI].
const angleDelta = (a, b) => {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/* --------------------- deterministic exit lookup ---------------------- */

// Floors are deterministic from (seed, floor); the hub is a fixed layout.
// Cache plans and routes so 12 bots don't recompute the same maze each one.
const planCache = new Map()
const pathCache = new Map()

function planFor(seed, floor) {
  const key = `${seed}:${floor}`
  let plan = planCache.get(key)
  if (!plan) {
    plan = generateFloor(floor, seed)
    planCache.set(key, plan)
  }
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
    if (cur === goalI) {
      found = true
      break
    }
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
    this.lastA = null // last heading we actually sent (drive() throttle)
    this.driving = false // is 'forward' currently held server-side?
    this.clockOffset = 0 // serverNow − Date.now(), read from the welcome frame
    this.dashReadyAt = 0 // client-side dash-cooldown estimate, so dashes aren't wasted
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
        this.seed = m.seed
        this.floor = m.self.floor
        this.pos = { x: m.self.x, y: m.self.y }
        this.home = { x: m.self.x, y: m.self.y }
        this.clockOffset = m.now - Date.now() // sync to the authoritative clock for trap timing
        alive++
        console.log(`[${this.name}] welcome — floor ${m.self.floor}, ${m.players.length} in world, seed ${m.seed}`)
        this.startBehavior()
      }
      else if (m.t === 'state') {
        const me = m.players.find(p => p.id === this.id)
        if (me) {
          this.pos = { x: me.x, y: me.y }
          this.floor = me.f
        }
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
    // Diving bots re-plan several times a second (smooth steering + trap timing);
    // loiterers just need a lazy wander beat near their spawn.
    if (DIVE) this.timers.push(setInterval(() => this.dive(), DIVE_TICK))
    else this.timers.push(setInterval(() => this.wander(), 900))
    // Keep-alive ping so idle proxies don't reap the socket.
    this.timers.push(setInterval(() => this.send({ t: 'ping' }), 10_000))
    if (CHAT) this.timers.push(setInterval(() => {
      if (Math.random() < 0.15) this.send({ t: 'chat', text: pick(CHAT_LINES) })
    }, 8_000))
  }

  wander() {
    if (!this.pos) return

    this.loiter()

    // Walk for most of the tick, then coast to a stop.
    this.send({ t: 'move', ...NO_MOVE, forward: true, a: this.angle })
    this.timers.push(setTimeout(() => this.send({ t: 'move', ...NO_MOVE, a: this.angle }), rand(500, 750)))
    this.prevPos = { ...this.pos }
  }

  /* --------------------------- diving (smart) --------------------------- */

  plan() { return planFor(this.seed, this.floor) }
  serverNow() { return Date.now() + this.clockOffset }

  // One navigation decision, run ~6×/s: steer along the BFS route toward the
  // exit, cross timed traps deliberately (wait out the lethal window, or hop the
  // last stretch when we're too close to stop), and dash the open straights.
  dive() {
    if (!this.pos) return

    // Straight lane from the hub spawn to the dive portal — just make for it.
    if (this.floor === HUB_FLOOR) {
      this.drive(Math.atan2(HUB_LAYOUT.exit.y - this.pos.y, HUB_LAYOUT.exit.x - this.pos.x), true)
      if (Math.random() < 0.25) this.tryDash()
      return
    }

    // (Re)load the route whenever we drop onto a new floor.
    if (this.pathFloor !== this.floor) {
      this.path = pathFor(this.seed, this.floor)
      this.pathFloor = this.floor
      this.wp = 0
      this.stuck = 0
    }

    const path = this.path
    if (!path) { // no route (shouldn't happen) — straight-line at the exit, jitter if wedged
      const exit = this.plan().exit
      this.drive(Math.atan2(exit.y - this.pos.y, exit.x - this.pos.x) + (this.stuck >= 2 ? rand(-1.2, 1.2) : 0), true)
      this.trackStuck()
      return
    }

    this.advanceWaypoints(path)
    const target = path[this.wp]
    const heading = Math.atan2(target.y - this.pos.y, target.x - this.pos.x)

    const hazard = this.trapAhead(heading)
    if (hazard === 'wait') { // hold short of a live trap and let its cycle pass
      this.drive(this.angle, false)
      this.stuck = 0
      this.prevPos = { ...this.pos }
      return
    }

    this.drive(heading, true)
    if (hazard === 'clear') { // too close to stop — fly the last stretch over it
      this.send({ t: 'action', kind: 'jump' })
      this.tryDash()
    }
    else if (Math.hypot(target.x - this.pos.x, target.y - this.pos.y) > 2 && this.losClear(this.pos.x, this.pos.y, target.x, target.y)) {
      if (Math.random() < 0.3) this.tryDash() // open straightaway — sprint it
    }

    this.trackStuck()
  }

  // Send a move only when the heading turned or the throttle toggled: the server
  // holds our intent between ticks, so re-sending identical frames is just noise.
  drive(angle, forward) {
    const turned = this.lastA === null || Math.abs(angleDelta(angle, this.lastA)) > 0.05
    if (forward === this.driving && !turned) return
    this.angle = angle
    this.lastA = angle
    this.driving = forward
    this.send({ t: 'move', ...NO_MOVE, forward, a: angle })
  }

  // Dash on a client-side cooldown mirror so we don't burn frames the server
  // will reject anyway (it enforces DASH_COOLDOWN authoritatively).
  tryDash() {
    if (this.serverNow() < this.dashReadyAt) return
    this.dashReadyAt = this.serverNow() + DASH_COOLDOWN * 1000
    this.send({ t: 'action', kind: 'dash' })
  }

  // Skip waypoints we've reached, then string-pull: jump ahead to the furthest
  // upcoming waypoint we have a clear line to, cutting corners in the roomy
  // 3-wide corridors instead of stair-stepping between tile centres.
  advanceWaypoints(path) {
    while (this.wp < path.length - 1 && Math.hypot(path[this.wp].x - this.pos.x, path[this.wp].y - this.pos.y) < 0.9) this.wp++
    for (let k = Math.min(this.wp + 4, path.length - 1); k > this.wp; k--) {
      if (this.losClear(this.pos.x, this.pos.y, path[k].x, path[k].y)) {
        this.wp = k
        break
      }
    }
  }

  // Is the straight segment a→b wall-free for a body of PLAYER_RADIUS? Samples
  // the centre line plus both radius-offset edges every ~⅓ tile.
  losClear(ax, ay, bx, by) {
    const dist = Math.hypot(bx - ax, by - ay)
    if (dist === 0) return true
    const nx = -(by - ay) / dist * PLAYER_RADIUS
    const ny = (bx - ax) / dist * PLAYER_RADIUS
    const steps = Math.ceil(dist / 0.34)
    const plan = this.plan()
    for (let i = 0; i <= steps; i++) {
      const s = i / steps
      const x = ax + (bx - ax) * s
      const y = ay + (by - ay) * s
      if (!isWalkable(plan, Math.floor(x + nx), Math.floor(y + ny))) return false
      if (!isWalkable(plan, Math.floor(x - nx), Math.floor(y - ny))) return false
    }
    return true
  }

  // Decide how to handle the nearest timed trap sitting on our travel ray:
  // 'go' (no trap, or it'll be safe as we cross), 'wait' (lethal soon — hold
  // short until the cycle passes), or 'clear' (< ~0.85 tiles, too close to stop
  // — hop it, since a jump keeps us airborne long enough to clear the disc).
  trapAhead(heading) {
    const traps = this.plan().traps
    if (!traps.length) return 'go'
    const dirx = Math.cos(heading)
    const diry = Math.sin(heading)
    const speed = PLAYER_SPEED * floorSpeed(this.floor)
    let nearest = null
    let nearestAlong = Infinity
    for (const t of traps) {
      const rx = t.x - this.pos.x
      const ry = t.y - this.pos.y
      const along = rx * dirx + ry * diry
      if (along < -0.3 || along > TRAP_LOOKAHEAD) continue // behind us, or beyond our horizon
      if (Math.abs(rx * diry - ry * dirx) > TRAP_RADIUS + PLAYER_RADIUS) continue // we'd miss its disc
      if (along < nearestAlong) {
        nearestAlong = along
        nearest = t
      }
    }
    if (!nearest) return 'go'

    // When do we enter its kill disc, and for how long? Widen the window with a
    // margin to swallow clock drift against the authoritative server.
    const along = Math.max(0, nearestAlong)
    const etaMs = along / speed * 1000
    const crossMs = 2 * TRAP_RADIUS / speed * 1000
    const from = this.serverNow() + etaMs - 90
    const to = this.serverNow() + etaMs + crossMs + 90
    let lethal = false
    for (let ms = from; ms <= to; ms += 60) {
      if (isTrapActive(nearest, ms)) {
        lethal = true
        break
      }
    }
    if (!lethal) return 'go'
    return along < 0.85 ? 'clear' : 'wait'
  }

  // Barely moved since the last decision while trying to advance? We're wedged
  // on a wall or prop — nudge the heading and hop to break free.
  trackStuck() {
    const moved = this.prevPos ? Math.hypot(this.pos.x - this.prevPos.x, this.pos.y - this.prevPos.y) : 1
    this.prevPos = { ...this.pos }
    if (moved > 0.05) {
      this.stuck = 0
      return
    }
    if (++this.stuck < 3) return
    this.send({ t: 'action', kind: 'jump' })
    this.drive(this.angle + rand(-1.2, 1.2), true)
    if (this.stuck > 6) this.stuck = 0
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
