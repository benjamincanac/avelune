// Spawn wandering bot players against a running Avelune server (local or prod).
//
// Each bot mints a signed identity cookie via `POST /api/auth` (the same path
// the onboarding flow uses), then opens an authenticated WebSocket to
// `/api/ws` with that cookie on the upgrade — exactly like a real browser,
// so the server can't tell them apart from humans. Bots pick random walkable
// waypoints around their spawn, walk to them, jump/dash occasionally, and
// reconnect if the socket drops.
//
// Usage (through jiti: this pulls in the shared modules, which use extensionless
// imports node cannot resolve on its own):
//   pnpm exec jiti scripts/spawn-bots.mjs [--url <base>] [--count N] [--radius R] [--chat] [--dig]
//
// Each bot keeps its own streamed `World`: it builds nothing locally, it just
// installs the `chunk` frames the server sends and reads walkability out of
// them, exactly as a browser does. `--dig` walks them out past the town's
// protected footprint and has them terraform the meadow, which is what puts the
// tick loop under an edit load.
//
// Examples:
//   pnpm exec jiti scripts/spawn-bots.mjs                     # 3 bots on prod
//   pnpm exec jiti scripts/spawn-bots.mjs --count 8           # 8 bots on prod
//   pnpm exec jiti scripts/spawn-bots.mjs --url http://localhost:50889 --count 5 --dig
//
// Ctrl-C for a clean shutdown (closes every socket).

import { GENDERS, HAIRSTYLES, OUTFITS, PLAYER_COLORS, outfitColorCount } from '../shared/utils/characters.ts'
import { isWalkable } from '../shared/utils/maze.ts'
import { applyPlace, applyRemove, chunkKey, createWorld, decodeChunk, installChunk, isProtectedTile, removeChunk } from '../shared/utils/world.ts'

/* ------------------------------- args --------------------------------- */

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const BASE = String(flag('url', 'https://avelune-online.vercel.app')).replace(/\/$/, '')
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws'
const COUNT = Math.max(1, Number(flag('count', 3)) || 3)
const RADIUS = Number(flag('radius', 5)) || 5 // wander radius around spawn (tiles)
const CHAT = flag('chat', false) === true
const DIG = flag('dig', false) === true
/** Where digging bots head for: the open meadow that starts as soon as the gate
 *  road ends. Protection is a tile footprint, so this is a few tiles past 140,
 *  not a chunk band away. */
const MEADOW_Y = 150
/** ms between terraform requests — well under the server's 8 per second. */
const DIG_EVERY = 1200

const rand = (min, max) => min + Math.random() * (max - min)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

/** A random walkable point within `r` tiles of (cx, cy) in the bot's own
 *  streamed world, or null after N tries. */
function randomWaypoint(world, cx, cy, r) {
  for (let i = 0; i < 30; i++) {
    const a = rand(0, Math.PI * 2)
    const d = Math.sqrt(Math.random()) * r
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    if (isWalkable(world, Math.floor(x), Math.floor(y))) return { x, y }
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
    // A real client never generates the world: it starts empty and is filled by
    // the `chunk` frames the server streams. Bots do the same, so their
    // walkability checks see exactly what a browser would.
    this.world = createWorld({ generate: false, town: false })
    this.trekking = DIG // heading for the meadow before it can dig
    this.edits = 0
    this.refused = 0
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
    const idCookie = jar.map(c => c.split(';')[0]).find(c => c.startsWith('avelune_id='))
    if (!idCookie) throw new Error('no avelune_id cookie')
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
      else if (m.t === 'chunk') installChunk(this.world, decodeChunk(m))
      else if (m.t === 'unchunk') removeChunk(this.world, m.cx, m.cy)
      else if (m.t === 'terrain') this.applyTerrainFrame(m)
      else if (m.t === 'place') {
        if (this.world.chunks.has(chunkKey(m.cx, m.cy))) applyPlace(this.world, m.piece)
      }
      else if (m.t === 'remove') applyRemove(this.world, m.id)
      else if (m.t === 'reject') this.refused++
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

  // A `terrain` delta names corner indices and their new quantised heights, so
  // applying one is a write straight into the chunk the client already holds.
  applyTerrainFrame(m) {
    const chunk = this.world.chunks.get(chunkKey(m.cx, m.cy))
    if (!chunk) return
    for (const [i, h] of m.edits) chunk.heights[i] = h
    for (const [i, v] of m.surface ?? []) chunk.surface[i] = v
    chunk.version = m.v
  }

  startBehavior() {
    if (this.started) return
    this.started = true
    this.timers.push(setInterval(() => this.wander(), TICK))
    if (DIG) this.timers.push(setInterval(() => this.dig(), DIG_EVERY))
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
    // Digging bots first walk clear of the town footprint, then settle down and
    // wander where the ground is theirs to move.
    if (this.trekking) {
      if (this.pos.y >= MEADOW_Y || (!isProtectedTile(this.pos.x, this.pos.y) && this.pos.y > 142)) {
        this.trekking = false
        this.home = { ...this.pos }
        this.target = null
      }
      else {
        this.drive(Math.atan2(MEADOW_Y - this.pos.y, (this.home?.x ?? this.pos.x) - this.pos.x), true)
        if (Math.random() < 0.15) this.send({ t: 'action', kind: 'jump' })
        this.trackStuck()
        return
      }
    }
    const anchor = this.home ?? this.pos

    if (!this.target || Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y) < ARRIVE) {
      this.target = randomWaypoint(this.world, anchor.x, anchor.y, RADIUS)
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

  // Move a corner of the ground near our feet. The server refuses anything
  // inside the walls, out of reach, or faster than its rate limit, so this is a
  // load test of the validation path as much as of the apply path.
  dig() {
    if (!this.pos || this.trekking) return
    const gx = Math.round(this.pos.x + rand(-3, 3))
    const gy = Math.round(this.pos.y + rand(-3, 3))
    if (isProtectedTile(gx, gy)) return
    this.edits++
    this.send({
      t: 'terraform',
      x: gx,
      y: gy,
      mode: pick(['raise', 'raise', 'lower', 'flatten']),
      size: pick([1, 1, 2, 3]),
    })
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

console.log(`Spawning ${COUNT} bot${COUNT > 1 ? 's' : ''} on ${BASE} (radius ${RADIUS}${CHAT ? ', chatty' : ''}${DIG ? ', digging' : ''})`)

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

setInterval(() => {
  const edits = bots.reduce((n, b) => n + b.edits, 0)
  const refused = bots.reduce((n, b) => n + b.refused, 0)
  const outside = bots.filter(b => b.started && !b.trekking).length
  console.log(`— ${alive}/${COUNT} bots connected${DIG ? `, ${outside} digging, ${edits} edits (${refused} refused)` : ''} —`)
}, 15_000)
