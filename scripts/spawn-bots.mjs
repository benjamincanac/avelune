// Spawn wandering bot players against a running Avelune server (local only —
// never point these at production).
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
//   pnpm exec jiti scripts/spawn-bots.mjs [--url <base>] [--count N] [--radius R] [--chat] [--dig] [--build]
//
// Each bot keeps its own streamed `World`: it builds nothing locally, it just
// installs the `chunk` frames the server sends and mirrors every `terrain` /
// `place` / `remove` frame with the shared `apply*` functions, exactly as a
// browser does. That is load-bearing for `--build`: `resolveBuild` is run
// client-side to pick poses the server will accept, and it can only see another
// bot's wall if that bot's `place` frame went into this bot's world.
//
// `--dig` walks them out past the town's protected footprint and has them
// terraform the meadow. `--build` sends each bot to its own plot in the same
// meadow to flatten the ground and raise a two-storey cottage (or a fenced
// paddock) out of the build kit, then pave a path back to the gate road. The
// two compose: a building bot digs once it has finished and settled in.
//
// Edits are paced ~150 ms apart, just under the server's `EDITS_PER_SECOND`
// bucket, and a `reject` is attributed to the most recent edit — with one edit
// in flight at a time that is accurate enough for the summary, and no edit is
// ever retried at the same pose.
//
// Examples:
//   pnpm exec jiti scripts/spawn-bots.mjs --url http://localhost:3000 --count 8
//   pnpm exec jiti scripts/spawn-bots.mjs --url http://localhost:50889 --count 12 --build --dig
//
// Ctrl-C for a clean shutdown (closes every socket) and a final total.

import { GENDERS, HAIRSTYLES, OUTFITS, PLAYER_COLORS, outfitColorCount } from '../shared/utils/characters.ts'
import { isWalkable, terrainHeight } from '../shared/utils/maze.ts'
import { MAX_PIECES_PER_PLAYER, checkTerraform, resolveBuild } from '../shared/utils/building.ts'
import { applyPlace, applyRemove, chunkCoord, chunkKey, createWorld, decodeChunk, installChunk, isProtectedTile, removeChunk } from '../shared/utils/world.ts'
import { deedOp, fencePlan, housePlan, levelPlan, paveOp, plotBounds, plotCentre, plotFor } from './bot-build.mjs'

/* ------------------------------- args --------------------------------- */

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const BASE = String(flag('url', 'http://localhost:3000')).replace(/\/$/, '')
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws'
const COUNT = Math.max(1, Number(flag('count', 3)) || 3)
const RADIUS = Number(flag('radius', 5)) || 5 // wander radius around spawn (tiles)
const CHAT = flag('chat', false) === true
const DIG = flag('dig', false) === true
const BUILD = flag('build', false) === true
/** Where digging bots head for: the open meadow that starts as soon as the gate
 *  road ends. Protection is a tile footprint, so this is a few tiles past 140,
 *  not a chunk band away. */
const MEADOW_Y = 150
/** ms between terraform requests — well under the server's 8 per second. */
const DIG_EVERY = 1200
/** ms between build/terraform requests from the edit pump. `EDITS_PER_SECOND`
 *  is 8, so this leaves headroom for a settled bot's digging on top. */
const EDIT_EVERY = 150
/** The mouth of the gate road: where a paved path from a plot rejoins the town.
 *  y 140 is the first buildable tile, so paving stops a tile short of it. */
const ROAD = { x: 72, y: 142 }
/** Stop building this far short of the budget, so a rebuild always fits. */
const PIECE_HEADROOM = 8

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

/* ------------------------------ stats --------------------------------- */

/** Reject reasons, world-wide, so the summary can name the top few. */
const rejectReasons = new Map()
function noteReject(reason) {
  rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1)
}
function topReasons(n = 3) {
  return [...rejectReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(', ')
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
    // walkability checks — and, when building, their `resolveBuild` previews —
    // see exactly what a browser would.
    this.world = createWorld({ generate: false, town: false })
    this.edits = 0
    this.refused = 0

    // --- building ---
    this.plot = plotFor(n)
    this.fencer = BUILD && n % 3 === 2
    this.phase = BUILD ? 'trek' : DIG ? 'dig-trek' : 'settle'
    this.route = []
    this.plan = []
    this.planAt = 0
    this.pieces = 0 // owned pieces world-wide, from welcome/place/remove
    this.deeds = 0 // plots held world-wide, same source
    this.mine = new Map() // placement id -> the op that built it, for rebuilds
    this.placed = 0
    this.buildRefused = 0
    this.terraformSent = 0
    this.terraformRefused = 0
    this.demolished = 0
    this.lastEditKind = null // what the next `reject` most likely answers
    this.sentBuilds = [] // build ops awaiting their `place` frame, in order
    this.waits = 0 // pump ticks spent waiting on ground that isn't here yet
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
        this.pieces = m.pieces ?? 0
        this.deeds = m.deeds ?? 0
        alive++
        console.log(`[${this.name}#${this.n}] welcome — ${m.players.length} in world${BUILD ? `, plot ${this.plot.x},${this.plot.y}` : ''}`)
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
        // Mirror every placement, ours and everyone else's: `resolveBuild` reads
        // this world to decide where a piece fits, so a neighbour's wall has to
        // be in it or we would aim at an occupied cell and be refused.
        if (this.world.chunks.has(chunkKey(m.cx, m.cy))) applyPlace(this.world, m.piece)
        if (m.piece.owner === this.id) {
          this.placed++
          const op = this.sentBuilds.shift()
          // Remember the height the server actually gave it: a rebuild of this
          // exact piece has to land back in this exact slot, and the server's
          // `z` is the only number that says which one that was.
          if (op) this.mine.set(m.piece.id, { ...op, h: m.piece.z ?? 0 })
        }
        if (m.pieces != null) this.pieces = m.pieces
        if (m.deeds != null) this.deeds = m.deeds
      }
      else if (m.t === 'remove') {
        applyRemove(this.world, m.id)
        this.mine.delete(m.id)
        if (m.pieces != null) this.pieces = m.pieces
        if (m.deeds != null) this.deeds = m.deeds
      }
      else if (m.t === 'reject') {
        this.refused++
        noteReject(m.reason)
        if (this.lastEditKind === 'terraform') this.terraformRefused++
        else if (this.lastEditKind === 'build') this.buildRefused++
      }
      else if (m.t === 'kicked') {
        console.log(`[${this.name}#${this.n}] kicked: ${m.reason}`)
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
      console.log(`[${this.name}#${this.n}] socket closed (code ${e.code}) — reconnecting in 2s`)
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
    if (BUILD) {
      // Down the road first, then across the meadow: a straight line from spawn
      // would try to walk the moat.
      this.route = [{ x: ROAD.x, y: 143 }, plotCentre(this.plot)]
      // Claim the ground first, so everything after it is built on a plot
      // nobody else may touch — and so the load test exercises the claim rules.
      this.plan = [...levelPlan(this.plot), deedOp(this.plot), ...(this.fencer ? fencePlan(this.plot) : housePlan(this.plot))]
    }
    this.timers.push(setInterval(() => this.wander(), TICK))
    if (BUILD) this.timers.push(setInterval(() => this.editPump(), EDIT_EVERY))
    if (DIG) this.timers.push(setInterval(() => this.dig(), DIG_EVERY))
    // Keep-alive ping so idle proxies don't reap the socket.
    this.timers.push(setInterval(() => this.send({ t: 'ping' }), 10_000))
    if (CHAT) this.timers.push(setInterval(() => {
      if (Math.random() < 0.15) this.send({ t: 'chat', text: pick(CHAT_LINES) })
    }, 8_000))
  }

  /* ----------------------------- navigation --------------------------- */

  wander() {
    if (!this.pos) return
    if (this.phase === 'dig-trek') return this.digTrek()
    if (this.phase === 'trek') return this.followRoute('work')
    if (this.phase === 'work') {
      // Stand still while building: every pose is chosen against where the
      // server thinks we are, and walking would drift out of `EDIT_REACH`.
      this.drive(this.angle, false)
      return
    }
    if (this.phase === 'pave') return this.followRoute('settle')
    this.roam()
  }

  /** Walk the queued waypoints, then switch phase. */
  followRoute(next) {
    const wp = this.route[0]
    if (!wp) {
      this.enter(next)
      return
    }
    if (Math.hypot(wp.x - this.pos.x, wp.y - this.pos.y) < 1.2) {
      this.route.shift()
      if (!this.route.length) this.enter(next)
      return
    }
    this.drive(Math.atan2(wp.y - this.pos.y, wp.x - this.pos.x), true)
    this.trackStuck()
  }

  enter(phase) {
    this.phase = phase
    this.drive(this.angle, false)
    this.target = null
    if (phase === 'work') this.home = plotCentre(this.plot)
    if (phase === 'pave') this.route = [{ ...ROAD }]
    if (phase === 'settle') {
      this.home = plotCentre(this.plot)
      console.log(`[${this.name}#${this.n}] finished — ${this.placed} pieces placed, ${this.buildRefused} refused`)
    }
  }

  /** The `--dig`-without-`--build` walk out of town, unchanged. */
  digTrek() {
    if (this.pos.y >= MEADOW_Y || (!isProtectedTile(this.pos.x, this.pos.y) && this.pos.y > 142)) {
      this.phase = 'settle'
      this.home = { ...this.pos }
      this.target = null
      return
    }
    this.drive(Math.atan2(MEADOW_Y - this.pos.y, (this.home?.x ?? this.pos.x) - this.pos.x), true)
    if (Math.random() < 0.15) this.send({ t: 'action', kind: 'jump' })
    this.trackStuck()
  }

  // One navigation decision: head for the current waypoint, pick a new one once
  // we arrive (or after idling), and hop/dash now and then for signs of life.
  roam() {
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

  /* ------------------------------- editing ---------------------------- */

  /** One edit per pump tick, whatever the phase wants next. */
  editPump() {
    if (!this.pos || !this.id) return
    if (this.phase === 'work') {
      // Generated trees stand where the walls go, and both `checkTerraform` and
      // `resolveBuild` refuse around them — so clear them first. They are
      // unowned nature, which `canRemove` lets anyone take.
      const wild = this.blockingWild()
      if (wild) return this.demolish(wild.id)
      return this.nextPlanOp()
    }
    if (this.phase === 'pave') {
      if (this.pos.y <= 143) return
      const op = paveOp(this.pos.x, this.pos.y)
      // The first strides off the plot still have the house under the brush.
      if (!checkTerraform(this.world, op, this.actor()).ok) return
      return this.terraform(op)
    }
    if (this.phase === 'settle') {
      // Requeued rebuilds first, then the occasional teardown of our own work.
      if (this.planAt < this.plan.length) return this.nextPlanOp()
      if (Math.random() < 0.015) this.rebuildSomething()
    }
  }

  nextPlanOp() {
    const op = this.plan[this.planAt]
    if (!op) {
      if (this.phase === 'work') this.enter('pave')
      return
    }
    // Ground still in flight is not a refusal, it's a "not yet": the server
    // would answer 'that ground is not loaded' and we'd have burned a token.
    if (!this.world.chunks.has(chunkKey(chunkCoord(op.x), chunkCoord(op.y)))) return this.hold()
    if (op.op === 'terraform') {
      this.planAt++
      this.waits = 0
      return this.terraform(op)
    }
    if (this.pieces >= MAX_PIECES_PER_PLAYER - PIECE_HEADROOM) {
      this.planAt++
      return
    }
    // The aim height a player's crosshair would have carried: the storey this
    // op belongs to, measured off the ground under its own pose. A requeued
    // rebuild already knows the exact `z` its piece had and carries it as `h`.
    const request = { ...op, h: this.aimHeight(op) }
    // Run the same predicate the server will, against our streamed world — the
    // client ghost's job. A pose it already refuses is skipped rather than
    // retried, except when the answer is only about timing.
    const preview = resolveBuild(this.world, request, this.actor(), { owner: this.id, id: 'preview', pieces: this.pieces, deeds: this.deeds })
    if (!preview.ok) {
      if ((preview.reason === 'too far away' || preview.reason === 'that ground is not loaded') && this.hold()) return
      // The claim is the one op worth hearing about when it is skipped: a bot
      // that never plants its deed is a bot that never exercises the rules.
      if (op.kind === 'Kit_Deed') console.log(`[${this.name}#${this.n}] no claim — ${preview.reason}`)
      this.planAt++
      this.waits = 0
      return
    }
    this.planAt++
    this.waits = 0
    this.sentBuilds.push(op)
    this.lastEditKind = 'build'
    this.edits++
    this.send({ t: 'build', kind: op.kind, x: op.x, y: op.y, rot: op.rot, h: request.h })
  }

  /** The `h` a build op should carry: an explicit one (a rebuild remembers the
   *  height its piece stood at), otherwise the plan's storey `lift` over the
   *  ground under the pose. Undefined where the ground is not loaded, which
   *  leaves the server on its old highest-surface rule. */
  aimHeight(op) {
    if (op.h != null) return op.h
    if (op.lift == null) return undefined
    const ground = terrainHeight(this.world, op.x, op.y)
    return Number.isFinite(ground) ? ground + op.lift : undefined
  }

  /** Us, as the shared edit rules see us: where we stand and who we are. The
   *  id is what a plot is measured against — without it every claim, our own
   *  included, would refuse us. */
  actor() {
    return { x: this.pos.x, y: this.pos.y, id: this.id }
  }

  /** Stall the plan for a few pump ticks, then give up on this op. Returns
   *  whether the caller should keep waiting. */
  hold() {
    if (++this.waits < 40) return true
    this.waits = 0
    this.planAt++
    return false
  }

  terraform(op) {
    this.lastEditKind = 'terraform'
    this.terraformSent++
    this.edits++
    this.send({ t: 'terraform', x: op.x, y: op.y, mode: op.mode, size: op.size, ...(op.surface != null ? { surface: op.surface } : {}) })
  }

  demolish(id) {
    this.lastEditKind = 'demolish'
    this.edits++
    this.demolished++
    this.send({ t: 'demolish', id })
  }

  /** Tear one of our own pieces down and queue it to go straight back up. */
  rebuildSomething() {
    let best = null
    let bestD = Infinity
    for (const [id, op] of this.mine) {
      const d = Math.hypot(op.x - this.pos.x, op.y - this.pos.y)
      if (d < bestD) {
        bestD = d
        best = { id, op }
      }
    }
    if (!best || bestD > 4) return
    this.demolish(best.id)
    this.plan.push(best.op)
  }

  /** A generated nature piece standing inside our plot and within reach. */
  blockingWild() {
    const b = plotBounds(this.plot)
    for (let cy = chunkCoord(b.minY); cy <= chunkCoord(b.maxY); cy++) {
      for (let cx = chunkCoord(b.minX); cx <= chunkCoord(b.maxX); cx++) {
        const chunk = this.world.getChunk(cx, cy)
        if (!chunk) continue
        for (const prop of chunk.props) {
          if (!prop.id?.startsWith('wild:')) continue
          if (prop.x < b.minX || prop.x > b.maxX || prop.y < b.minY || prop.y > b.maxY) continue
          if (Math.hypot(prop.x - this.pos.x, prop.y - this.pos.y) > 5) continue
          return prop
        }
      }
    }
    return null
  }

  // Move a corner of the ground near our feet. The server refuses anything
  // inside the walls, out of reach, or faster than its rate limit, so this is a
  // load test of the validation path as much as of the apply path.
  dig() {
    if (!this.pos || this.phase !== 'settle') return
    for (let i = 0; i < 5; i++) {
      const op = {
        x: Math.round(this.pos.x + rand(-4, 4)),
        y: Math.round(this.pos.y + rand(-4, 4)),
        mode: pick(['raise', 'raise', 'lower', 'flatten']),
        size: pick([1, 1, 2, 3]),
      }
      if (isProtectedTile(op.x, op.y)) continue
      // A building bot digs in its own front garden, where most of the brushes
      // it might pick have a wall standing on them. Running the server's own
      // predicate first keeps it from spending its whole token bucket on
      // 'something is standing there'. One dig in seven skips the check, so the
      // server's refusal path stays under load too — that is half of what this
      // script is for.
      if (Math.random() > 0.15 && !checkTerraform(this.world, op, this.actor()).ok) continue
      return this.terraform(op)
    }
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
    // A route waypoint we cannot reach is worse than one we skip.
    if (this.route.length) this.route.shift()
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

if (/avelune-online\.vercel\.app/.test(BASE)) {
  console.error('Refusing to load-test production. Point --url at a local server.')
  process.exit(1)
}

const modes = [CHAT && 'chatty', DIG && 'digging', BUILD && 'building'].filter(Boolean)
console.log(`Spawning ${COUNT} bot${COUNT > 1 ? 's' : ''} on ${BASE} (radius ${RADIUS}${modes.length ? ', ' + modes.join(', ') : ''})`)

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

const total = key => bots.reduce((n, b) => n + b[key], 0)

function summary(label) {
  const parts = [`${alive}/${COUNT} bots connected`]
  if (BUILD) {
    const phases = bots.reduce((acc, b) => {
      acc[b.phase] = (acc[b.phase] ?? 0) + 1
      return acc
    }, {})
    parts.push(Object.entries(phases).map(([p, n]) => `${n} ${p}`).join('/'))
    parts.push(`${total('placed')} placed (${total('buildRefused')} refused)`)
    parts.push(`${total('demolished')} demolished`)
  }
  const sent = total('terraformSent')
  const refused = total('terraformRefused')
  if (sent) parts.push(`terraform ${sent - refused} ok / ${refused} refused`)
  const top = topReasons()
  if (top) parts.push(`rejects: ${top}`)
  console.log(`— ${label}${parts.join(', ')} —`)
}

setInterval(() => summary(''), 5_000)

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  summary('total: ')
  console.log(`Closing ${bots.length} bot socket${bots.length > 1 ? 's' : ''}…`)
  for (const b of bots) b.close()
  setTimeout(() => process.exit(0), 400)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
