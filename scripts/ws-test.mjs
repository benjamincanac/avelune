// Two-client protocol test against the Avelune server.
//
// The socket requires the signed identity cookie, so each client first creates
// a character over `POST /api/auth` and carries the cookie into the upgrade.
const WS_URL = process.argv[2] ?? 'ws://localhost:50889/api/ws'
const BASE = WS_URL.replace(/^ws/, 'http').replace(/\/api\/ws.*$/, '')
const characters = { A: 'Peasant_Male_SimpleParted', B: 'Ranger_Female_Long', C: 'Ranger_Female_Long' }

/** Create a character and return its `avelune_id` cookie. The route validates
 *  and falls back to the default character, so a bare name is enough here. */
async function auth(label) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `Test${label}`, character: characters[label] }),
  })
  if (!res.ok) throw new Error(`${label}: auth ${res.status}`)
  const jar = res.headers.getSetCookie?.() ?? []
  const cookie = jar.map(c => c.split(';')[0]).find(c => c.startsWith('avelune_id='))
  if (!cookie) throw new Error(`${label}: no avelune_id cookie`)
  const restored = await fetch(`${BASE}/api/auth`, { headers: { cookie } }).then(r => r.json())
  check(`${label} character survives cookie restore`, restored.character === characters[label])
  return cookie
}

function connect(label, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { cookie } })
    // `times` runs alongside `frames`: the streaming budget spreads a
    // neighbourhood over several ticks, so when a frame arrived is as much a
    // part of the contract as whether it did.
    const client = { ws, label, cookie, welcome: null, frames: [], times: [], t0: 0 }
    const timeout = setTimeout(() => reject(new Error(`${label}: no welcome`)), 5000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      client.frames.push(msg)
      client.times.push(performance.now())
      if (msg.t === 'welcome') {
        client.welcome = msg
        client.t0 = performance.now()
        clearTimeout(timeout)
        resolve(client)
      }
    })
    ws.addEventListener('error', e => reject(new Error(`${label}: ${e.message}`)))
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const send = (c, msg) => c.ws.send(JSON.stringify(msg))
const noMove = { forward: false, back: false, left: false, right: false }

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const a = await connect('A', await auth('A'))
const self = a.welcome.self
check(
  'A welcome',
  !!self && self.z === 0 && typeof a.welcome.now === 'number'
  && ['auto', 'clear', 'overcast', 'rain'].includes(a.welcome.weather)
  && ['auto', 'dawn', 'day', 'sunset', 'night'].includes(a.welcome.timeOfDay)
  && a.welcome.seed === undefined && a.welcome.records === undefined
  && Array.isArray(a.welcome.feed),
  `${self.name} @ (${self.x.toFixed(1)}, ${self.y.toFixed(1)}, z=${self.z})`,
)

check('welcome carries the owned-piece total', a.welcome.pieces === 0, `pieces=${a.welcome.pieces}`)
check('welcome names its realm', typeof a.welcome.world.realm === 'string' && a.welcome.world.realm.length > 0, `realm=${a.welcome.world.realm}`)
check('welcome says whether the world persists', typeof a.welcome.world.persistent === 'boolean', `persistent=${a.welcome.world.persistent}`)

check(
  'welcome describes the world',
  a.welcome.world?.chunkSize === 32
  && Number.isFinite(a.welcome.world?.seed)
  && a.welcome.world?.bounds?.minCx < 0 && a.welcome.world?.bounds?.maxCx > 0,
  JSON.stringify(a.welcome.world),
)

check('self receives saved character', self.character === characters.A)
const b = await connect('B', await auth('B'))
check('welcome includes other player character', b.welcome.players.find(p => p.id === self.id)?.character === characters.A)
await sleep(100)
check('join includes new player character', a.frames.find(f => f.t === 'join' && f.player.id === b.welcome.self.id)?.player.character === characters.B)
// The ground a player stands on arrives before anyone can be standing on it:
// the 3×3 around the spawn chunk is on the wire before the first `state`
// frame. The ring beyond it is scenery, drained a few chunks per tick so that
// no single tick pays for a whole neighbourhood — it only has to land soon.
await sleep(900)
const spawnChunk = { cx: Math.floor(self.x / 32), cy: Math.floor(self.y / 32) }
const chunkAt = new Map()
a.frames.forEach((f, i) => f.t === 'chunk' && chunkAt.set(`${f.cx},${f.cy}`, i))
let missing = 0
let lastInner = -1
let lastArrival = 0
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    const at = chunkAt.get(`${spawnChunk.cx + dx},${spawnChunk.cy + dy}`)
    if (at === undefined) {
      missing++
      continue
    }
    lastArrival = Math.max(lastArrival, a.times[at] - a.t0)
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) lastInner = Math.max(lastInner, at)
  }
}
const firstState = a.frames.findIndex(f => f.t === 'state')
check('spawn neighbourhood streams on welcome', missing === 0, `${25 - missing}/25 chunks`)
check('the chunks underfoot arrive before the first state', firstState === -1 || lastInner < firstState, `3×3 ≤ ${lastInner}, state ${firstState}`)
check('the rest of the neighbourhood follows within a second', lastArrival < 1000, `5×5 complete after ${lastArrival.toFixed(0)}ms`)
const sample = a.frames.find(f => f.t === 'chunk')
check(
  'chunk frames carry encoded terrain',
  typeof sample?.h === 'string' && sample.h.length > 2000 && typeof sample.s === 'string' && Array.isArray(sample.props),
  `h=${sample?.h?.length}b64 s=${sample?.s?.length}b64 props=${sample?.props?.length}`,
)
const town = a.frames.filter(f => f.t === 'chunk').reduce((n, f) => n + f.props.length, 0)
check('the authored town streams as placements', town > 100, `${town} pieces across the spawn neighbourhood`)

const statesOf = (client, id, since = 0) =>
  client.frames.slice(since).filter(f => f.t === 'state').flatMap(f => f.players).filter(p => p.id === id)
// Long enough for a dash burst to end before the next measurement.
const DASH_SETTLE = 300
const lastState = () => statesOf(b, self.id).at(-1) ?? self

// Jump: z rises past half a tile, then returns to the ground.
let mark = b.frames.length
send(a, { t: 'action', kind: 'jump' })
await sleep(500)
const peak = Math.max(...statesOf(b, self.id, mark).map(s => s.z), 0)
await sleep(700)
const settled = lastState()
check('jump arcs and lands', peak > 0.5 && settled.z === 0, `peak z=${peak.toFixed(2)}, settled z=${settled.z}`)

// Dash: same held keys cover much more ground for the burst.
mark = b.frames.length
const p0 = lastState()
send(a, { t: 'move', ...noMove, forward: true, a: 0 })
await sleep(350)
send(a, { t: 'move', ...noMove, a: 0 })
await sleep(250)
const p1 = lastState()
const plain = Math.hypot(p1.x - p0.x, p1.y - p0.y)

send(a, { t: 'action', kind: 'dash' })
send(a, { t: 'move', ...noMove, forward: true, a: 0 })
await sleep(350)
send(a, { t: 'move', ...noMove, a: 0 })
await sleep(250)
const p2 = lastState()
const dashed = Math.hypot(p2.x - p1.x, p2.y - p1.y)
check('dash outruns walking', dashed > plain * 1.3, `plain=${plain.toFixed(2)} dashed=${dashed.toFixed(2)}`)
const dashFlag = statesOf(b, self.id, mark).some(s => s.d === true)
check('dash flagged in snapshots', dashFlag)

// Sprint: the same held key with `sprint` covers more ground, and says so.
await sleep(DASH_SETTLE)
mark = b.frames.length
const p3 = lastState()
send(a, { t: 'move', ...noMove, forward: true, sprint: true, a: 0 })
await sleep(350)
send(a, { t: 'move', ...noMove, a: 0 })
await sleep(250)
const p4 = lastState()
const sprinted = Math.hypot(p4.x - p3.x, p4.y - p3.y)
check('sprint outruns walking', sprinted > plain * 1.3, `plain=${plain.toFixed(2)} sprinted=${sprinted.toFixed(2)}`)
check('sprint flagged in snapshots', statesOf(b, self.id, mark).some(s => s.s === true))

// Chat reaches the other client, with no floor scoping left on the frame.
send(a, { t: 'chat', text: 'well met' })
await sleep(300)
const chat = b.frames.find(f => f.t === 'chat' && f.id === self.id)
check('chat reaches the arena', chat?.text === 'well met' && chat?.f === undefined)

/* -------------------------------------------------------------------------- */
/* World editing                                                              */
/* -------------------------------------------------------------------------- */

const positionOf = client => statesOf(client, client.welcome.self.id).at(-1) ?? client.welcome.self
/** A corner height as the client holds it, from the chunk frame it was sent. */
function cornerFrom(client, cx, cy, index) {
  const frame = client.frames.findLast(f => f.t === 'chunk' && f.cx === cx && f.cy === cy)
  if (!frame) return null
  const bytes = Buffer.from(frame.h, 'base64')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(index * 2, true)
}

// The town is protected: an edit inside the walls is refused, and refused only
// to the player who asked for it.
let bMark = b.frames.length
send(a, { t: 'terraform', x: Math.round(self.x), y: Math.round(self.y), mode: 'raise', size: 1 })
await sleep(200)
const refusal = a.frames.findLast(f => f.t === 'reject')
check('terraform inside the walls is refused', refusal?.reason === 'the town is protected', refusal?.reason)
check('a refusal stays private', !b.frames.slice(bMark).some(f => f.t === 'reject' || f.t === 'terrain'))

// Protection is a tile footprint now, not a chunk band: a brush reaching the
// gate bridge's landing is refused, and the grass beside spawn — six tiles
// away, still inside the chunks that used to be off limits — is editable
// without walking anywhere.
const onRoad = positionOf(a)
send(a, { t: 'terraform', x: Math.round(onRoad.x), y: Math.round(onRoad.y) - 6, mode: 'raise', size: 3 })
await sleep(200)
const roadRefusal = a.frames.findLast(f => f.t === 'reject')
check('the gate bridge is protected', roadRefusal?.reason === 'the town is protected', roadRefusal?.reason)
let beside = null
for (const dx of [-6, 6, -5, 5]) {
  const aMark = a.frames.length
  send(a, { t: 'terraform', x: Math.round(onRoad.x) + dx, y: Math.round(onRoad.y), mode: 'raise', size: 1 })
  await sleep(250)
  beside = a.frames.slice(aMark).find(f => f.t === 'terrain')
  if (beside) break
}
check('the grass beside the road is editable from spawn', !!beside, beside ? undefined : a.frames.findLast(f => f.t === 'reject')?.reason)

// Walk A out into the open meadow. The road ends at 140 and everything past it
// is buildable now, but the nearest wild piece is further out — A ends up
// wedged against the first one, which is the one it fells below.
async function walkOut(client) {
  const deadline = Date.now() + 30_000
  let previous = positionOf(client)
  while (Date.now() < deadline) {
    const here = positionOf(client)
    if (here.y >= 163.5) break
    send(client, { t: 'move', ...noMove, forward: true, a: Math.PI / 2 })
    if (Math.hypot(here.x - previous.x, here.y - previous.y) < 0.05) send(client, { t: 'action', kind: 'jump' })
    previous = here
    await sleep(250)
  }
  send(client, { t: 'move', ...noMove, a: Math.PI / 2 })
  return positionOf(client)
}
const outside = await walkOut(a)
check('A reaches open ground outside the walls', outside.y >= 163.5, `(${outside.x.toFixed(1)}, ${outside.y.toFixed(1)})`)

// Raising a corner out here reaches both clients, because B still holds the
// chunk: it is two chunks south of the one B is standing in.
const editChunk = { cx: Math.floor(outside.x / 32), cy: Math.floor(outside.y / 32) }
let applied = null
for (const [dx, dy] of [[0, 1], [1, 1], [-1, 1], [0, 2], [2, 1], [-2, 2]]) {
  const gx = Math.round(outside.x) + dx
  const gy = Math.round(outside.y) + dy
  const index = (gy - editChunk.cy * 32) * 33 + (gx - editChunk.cx * 32)
  const before = cornerFrom(a, editChunk.cx, editChunk.cy, index)
  const aMark = a.frames.length
  bMark = b.frames.length
  send(a, { t: 'terraform', x: gx, y: gy, mode: 'raise', size: 1 })
  await sleep(250)
  const mine = a.frames.slice(aMark).find(f => f.t === 'terrain')
  if (!mine) continue
  applied = { gx, gy, index, before, mine, theirs: b.frames.slice(bMark).find(f => f.t === 'terrain' && f.cx === editChunk.cx && f.cy === editChunk.cy) }
  break
}
check('a terraform outside the walls is applied', !!applied, applied ? `(${applied.gx}, ${applied.gy})` : 'every candidate corner was refused')
if (applied) {
  const raised = applied.mine.edits.find(([i]) => i === applied.index)
  // Heights ride the wire quantised in 0.05 units, so one 0.25 click is five.
  check('the delta raises the requested corner by one step', raised?.[1] === applied.before + 5, `${applied.before} → ${raised?.[1]}`)
  check('the delta names its chunk and version', applied.mine.cx === editChunk.cx && applied.mine.cy === editChunk.cy && Number.isFinite(applied.mine.v))
  check('B receives the same delta for the chunk it holds', JSON.stringify(applied.theirs) === JSON.stringify(applied.mine), JSON.stringify(applied.theirs?.edits))
}

// Clearing a generated wild piece (tree, rock or bush): it belongs to nobody,
// so anyone standing next to it may remove it, and everyone holding the chunk
// sees it go. The meadow is sparse, so take whichever wild piece is nearest.
const held = new Map()
for (const frame of a.frames) {
  if (frame.t === 'chunk') held.set(`${frame.cx},${frame.cy}`, frame)
  if (frame.t === 'unchunk') held.delete(`${frame.cx},${frame.cy}`)
}
const trees = [...held.values()]
  .flatMap(f => f.props.map(p => ({ ...p, cx: f.cx, cy: f.cy })))
  .filter(p => p.id.startsWith('wild:') && !p.owner)
  .map(p => ({ ...p, d: Math.hypot(p.x - outside.x, p.y - outside.y) }))
  .sort((p, q) => p.d - q.d)
const tree = trees[0]
check('generated wild pieces stand in the streamed meadow', !!tree && tree.d < 6, tree ? `${tree.kind} ${tree.id} at ${tree.d.toFixed(2)} tiles` : 'none within reach')
if (tree) {
  bMark = b.frames.length
  const aMark = a.frames.length
  send(a, { t: 'demolish', id: tree.id })
  await sleep(250)
  const mine = a.frames.slice(aMark).find(f => f.t === 'remove')
  const theirs = b.frames.slice(bMark).find(f => f.t === 'remove')
  check('the wild piece is removed for the feller', mine?.id === tree.id && mine?.cx === tree.cx && mine?.cy === tree.cy, JSON.stringify(mine))
  check('the other client sees the same removal', theirs?.id === tree.id && theirs?.v === mine?.v)
  // A wild tree belongs to nobody, so felling it spends none of A's budget.
  check('felling a wild piece leaves the owned total alone', mine?.pieces === 0, `pieces=${mine?.pieces}`)
  check('the other client is told nothing about A\'s total', theirs?.pieces === undefined)
  const aMark2 = a.frames.length
  send(a, { t: 'demolish', id: tree.id })
  await sleep(200)
  check('removing it twice is refused', a.frames.slice(aMark2).find(f => f.t === 'reject')?.reason === 'nothing to remove')
  const aMark3 = a.frames.length
  send(a, { t: 'demolish', id: 'town:0' })
  await sleep(200)
  check('town pieces cannot be demolished', a.frames.slice(aMark3).find(f => f.t === 'reject')?.reason === 'the town is protected')
}

// Building a kit piece out here is the one thing that moves the owned total,
// and only for the player who placed it.
let built = null
for (const [dx, dy] of [[0, 2], [2, 0], [-2, 0], [0, 4], [2, 2], [-2, 2], [4, 0], [-4, 0]]) {
  const aMark = a.frames.length
  bMark = b.frames.length
  send(a, { t: 'build', kind: 'Kit_Crate', x: outside.x + dx, y: outside.y + dy, rot: 0 })
  await sleep(250)
  const mine = a.frames.slice(aMark).find(f => f.t === 'place')
  if (!mine) continue
  built = { mine, theirs: b.frames.slice(bMark).find(f => f.t === 'place') }
  break
}
check('a kit piece is placed outside the walls', !!built, built ? `${built.mine.piece.kind} ${built.mine.piece.id}` : 'every candidate spot was refused')
if (built) {
  check('the placed piece belongs to its builder', built.mine.piece.owner === self.id, built.mine.piece.owner)
  check('the place frame carries the new owned total', built.mine.pieces === 1, `pieces=${built.mine.pieces}`)
  check('the other client sees the piece without a total', built.theirs?.piece?.id === built.mine.piece.id && built.theirs.pieces === undefined)
  const aMark = a.frames.length
  send(a, { t: 'demolish', id: built.mine.piece.id })
  await sleep(250)
  const gone = a.frames.slice(aMark).find(f => f.t === 'remove')
  check('removing your own piece gives the budget back', gone?.id === built.mine.piece.id && gone?.pieces === 0, `pieces=${gone?.pieces}`)

  // The aim height on the wire: the same pose three times, and `h` alone
  // decides whether a crate stacks or is refused for the slot being taken.
  const pose = { kind: 'Kit_Crate', x: built.mine.piece.x, y: built.mine.piece.y, rot: 0 }
  const place = async (frame) => {
    const mark = a.frames.length
    send(a, frame)
    await sleep(250)
    return a.frames.slice(mark).find(f => f.t === 'place' || f.t === 'reject')
  }
  const lower = await place({ t: 'build', ...pose })
  const upper = lower?.t === 'place' ? await place({ t: 'build', ...pose, h: lower.piece.z + 1 }) : null
  check('a build aimed a storey up stacks on the piece below', upper?.t === 'place' && upper.piece.z === lower.piece.z + 1, upper?.t === 'place' ? `z=${upper.piece.z}` : upper?.reason)
  const again = lower?.t === 'place' ? await place({ t: 'build', ...pose, h: lower.piece.z }) : null
  check('a build aimed back at the taken slot is refused', again?.t === 'reject', again?.t === 'place' ? `z=${again.piece.z}` : again?.reason)
  for (const frame of [lower, upper]) {
    if (frame?.t === 'place') {
      send(a, { t: 'demolish', id: frame.piece.id })
      await sleep(150)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Deed plots                                                                 */
/* -------------------------------------------------------------------------- */

// A claim is only worth anything where somebody else can reach it, so B walks
// out of the gate onto the same patch of meadow before A plants anything.
const bOutside = await walkOut(b)
check('B reaches the meadow beside A', bOutside.y >= 163.5, `(${bOutside.x.toFixed(1)}, ${bOutside.y.toFixed(1)})`)

const aOutside = positionOf(a)
let deed = null
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]]) {
  const aMark = a.frames.length
  send(a, { t: 'build', kind: 'Kit_Deed', x: Math.round(aOutside.x) + dx, y: Math.round(aOutside.y) + dy, rot: 0 })
  await sleep(250)
  const mine = a.frames.slice(aMark).find(f => f.t === 'place')
  if (mine) {
    deed = mine
    break
  }
}
check('A plants a deed outside the walls', !!deed, deed ? `${deed.piece.id} at (${deed.piece.x}, ${deed.piece.y})` : a.frames.findLast(f => f.t === 'reject')?.reason)

if (deed) {
  check('the place frame carries the new plot total', deed.deeds === 1, `deeds=${deed.deeds}`)
  check('a deed counts against the piece budget like any piece', deed.pieces === 1, `pieces=${deed.pieces}`)

  // The plot the server now holds, derived exactly as `plotBounds` does.
  const tx = Math.floor(deed.piece.x)
  const ty = Math.floor(deed.piece.y)
  const plot = { minX: tx - 7, maxX: tx + 9, minY: ty - 7, maxY: ty + 9 }
  const inPlot = (x, y) => x >= plot.minX && x < plot.maxX && y >= plot.minY && y < plot.maxY
  /** Grid poses inside A's plot that `who` can still reach. */
  const spots = (who) => {
    const here = positionOf(who)
    const out = []
    for (let dy = -4; dy <= 4; dy += 2) {
      for (let dx = -4; dx <= 4; dx += 2) {
        const x = Math.round((here.x + dx) / 2) * 2
        const y = Math.round((here.y + dy) / 2) * 2
        if (!inPlot(x, y) || Math.hypot(x - here.x, y - here.y) > 5) continue
        if (!out.some(p => p.x === x && p.y === y)) out.push({ x, y })
      }
    }
    return out
  }

  // B builds inside the claim: refused, and refused by name.
  let denied = null
  let strayed = null
  for (const spot of spots(b)) {
    const bMark = b.frames.length
    send(b, { t: 'build', kind: 'Kit_Crate', x: spot.x, y: spot.y, rot: 0 })
    await sleep(250)
    const placed = b.frames.slice(bMark).find(f => f.t === 'place')
    if (placed) {
      strayed = placed
      break
    }
    const reason = b.frames.slice(bMark).findLast(f => f.t === 'reject')?.reason
    if (reason?.startsWith('that plot')) {
      denied = { spot, reason }
      break
    }
  }
  check('B cannot build inside A\'s plot', !strayed && !!denied, strayed ? `B placed ${strayed.piece.id}` : denied?.reason ?? 'no candidate spot was reachable')
  check('the refusal names the plot owner', denied?.reason === 'that plot belongs to TestA', denied?.reason)
  if (strayed) {
    send(b, { t: 'demolish', id: strayed.piece.id })
    await sleep(250)
  }

  // A builds on their own doorstep: allowed.
  let own = null
  for (const spot of spots(a)) {
    const aMark = a.frames.length
    send(a, { t: 'build', kind: 'Kit_Crate', x: spot.x, y: spot.y, rot: 0 })
    await sleep(250)
    const mine = a.frames.slice(aMark).find(f => f.t === 'place')
    if (mine) {
      own = mine
      break
    }
  }
  check('A builds inside their own plot', !!own, own ? own.piece.id : a.frames.findLast(f => f.t === 'reject')?.reason)

  // Pulling the deed releases the claim. Nothing inside it moves.
  const aMark = a.frames.length
  send(a, { t: 'demolish', id: deed.piece.id })
  await sleep(250)
  const released = a.frames.slice(aMark).find(f => f.t === 'remove' && f.id === deed.piece.id)
  check('A releases the plot by pulling the deed', !!released, JSON.stringify(released))
  check('releasing the plot gives the claim back', released?.deeds === 0, `deeds=${released?.deeds}`)

  if (denied) {
    const bMark = b.frames.length
    send(b, { t: 'build', kind: 'Kit_Crate', x: denied.spot.x, y: denied.spot.y, rot: 0 })
    await sleep(250)
    const now = b.frames.slice(bMark).find(f => f.t === 'place')
    check('B can build there once the plot is released', !!now, now ? now.piece.id : b.frames.slice(bMark).findLast(f => f.t === 'reject')?.reason)
    if (now) {
      send(b, { t: 'demolish', id: now.piece.id })
      await sleep(250)
    }
  }
  if (own) {
    send(a, { t: 'demolish', id: own.piece.id })
    await sleep(250)
  }
  const leftover = a.frames.findLast(f => f.t === 'remove' && f.pieces !== undefined)
  check('the meadow is left as it was found', leftover?.pieces === 0, `A owns ${leftover?.pieces} pieces`)
}

// Anything but a tool the server knows is refused outright.
const badMark = a.frames.length
send(a, { t: 'terraform', x: outside.x, y: outside.y, mode: 'nuke', size: 9 })
send(a, { t: 'build', kind: 'Courtyard_Tower', x: outside.x, y: outside.y, rot: 0 })
await sleep(250)
const refusals = a.frames.slice(badMark).filter(f => f.t === 'reject').map(f => f.reason)
check('an unknown tool and an unbuildable kind are both refused', refusals.length === 2, refusals.join(' / '))

// Weather commands are server-owned, shared, and never enter public chat.
for (const mode of ['clear', 'overcast', 'rain']) {
  const aMark = a.frames.length
  const bMark = b.frames.length
  send(a, { t: 'chat', text: `/weather ${mode}` })
  await sleep(150)
  for (const [client, since] of [[a, aMark], [b, bMark]]) {
    const frames = client.frames.slice(since)
    check(`${client.label} receives ${mode} weather`, frames.some(f => f.t === 'weather' && f.mode === mode))
    check(`${client.label} receives weather confirmation`, frames.some(f => f.t === 'system' && f.text === `Weather changed to ${mode}.`))
    check(`${client.label} receives no command chat`, !frames.some(f => f.t === 'chat' && f.text.startsWith('/weather')))
  }
}
for (const text of ['/weather', '/weather snow', '/weather clear extra']) {
  const aMark = a.frames.length
  const bMark = b.frames.length
  send(a, { t: 'chat', text })
  await sleep(150)
  const ownFrames = a.frames.slice(aMark)
  const otherFrames = b.frames.slice(bMark)
  check(`${text} gives private usage`, ownFrames.some(f => f.t === 'system' && f.text.startsWith('Usage: /weather')))
  check(`${text} does not mutate weather`, ![...ownFrames, ...otherFrames].some(f => f.t === 'weather'))
  check(`${text} stays private`, !otherFrames.some(f => f.t === 'system' || (f.t === 'chat' && f.text.startsWith('/weather'))))
}

// Daylight overrides broadcast independently of the weather override.
for (const mode of ['dawn', 'day', 'sunset', 'night']) {
  const aMark = a.frames.length
  const bMark = b.frames.length
  send(a, { t: 'chat', text: `/time ${mode}` })
  await sleep(150)
  for (const [client, since] of [[a, aMark], [b, bMark]]) {
    const frames = client.frames.slice(since)
    check(`${client.label} receives ${mode} time`, frames.some(f => f.t === 'time' && f.mode === mode))
    check(`${client.label} receives time confirmation`, frames.some(f => f.t === 'system' && f.text === `Time of day changed to ${mode}.`))
    check(`${client.label} receives no time command chat`, !frames.some(f => f.t === 'chat' && f.text.startsWith('/time')))
    check(`${client.label} time command leaves weather unchanged`, !frames.some(f => f.t === 'weather'))
  }
}
for (const text of ['/time', '/time noon', '/time day extra']) {
  const aMark = a.frames.length
  const bMark = b.frames.length
  send(a, { t: 'chat', text })
  await sleep(150)
  const ownFrames = a.frames.slice(aMark)
  const otherFrames = b.frames.slice(bMark)
  check(`${text} gives private usage`, ownFrames.some(f => f.t === 'system' && f.text.startsWith('Usage: /time')))
  check(`${text} does not mutate environment`, ![...ownFrames, ...otherFrames].some(f => f.t === 'time' || f.t === 'weather'))
  check(`${text} stays private`, !otherFrames.some(f => f.t === 'system' || (f.t === 'chat' && f.text.startsWith('/time'))))
}

// Heartbeat + garbage tolerance.
send(b, { t: 'ping' })
b.ws.send('not json')
send(b, { t: 'action', kind: 'teleport-to-exit' })
send(b, { t: 'move', forward: 'nope', a: 'east' })
await sleep(300)
check('B got pong and survives garbage', b.frames.some(f => f.t === 'pong') && b.ws.readyState === WebSocket.OPEN)

b.ws.close()
await sleep(300)
check('A got leave for B', a.frames.some(f => f.t === 'leave' && f.id === b.welcome.self.id))

// One live session per identity: reconnecting with A's cookie boots the first.
// Last, because it closes A's socket.
const a2 = await connect('A2', a.cookie)
await sleep(300)
check('second tab kicks the first', a.frames.some(f => f.t === 'kicked'))
check('late connection inherits weather after invalid commands', a2.welcome.weather === 'rain')
check('late connection inherits time after invalid commands', a2.welcome.timeOfDay === 'night')
send(a2, { t: 'chat', text: '/weather auto' })
await sleep(150)
check('auto restores the synchronized cycle', a2.frames.some(f => f.t === 'weather' && f.mode === 'auto'))
check('auto restoration is confirmed', a2.frames.some(f => f.t === 'system' && f.text === 'Automatic weather restored.'))
const b2 = await connect('B2', b.cookie)
check('late connection inherits auto', b2.welcome.weather === 'auto')
check('weather reset preserves night', b2.welcome.timeOfDay === 'night')
const timeResetMark = b2.frames.length
send(a2, { t: 'chat', text: '/time auto' })
await sleep(150)
for (const client of [a2, b2]) {
  check(`${client.label} receives time cycle restoration`, client.frames.some(f => f.t === 'time' && f.mode === 'auto'))
  check(`${client.label} receives time restoration confirmation`, client.frames.some(f => f.t === 'system' && f.text === 'Automatic day/night cycle restored.'))
}
check('time reset does not broadcast weather', !b2.frames.slice(timeResetMark).some(f => f.t === 'weather'))
const a3 = await connect('A3', a.cookie)
check('late connection inherits automatic time', a3.welcome.timeOfDay === 'auto')
check('time reset preserves automatic weather', a3.welcome.weather === 'auto')
a3.ws.close()
b2.ws.close()

// A reconnect resumes where the body stood; `respawn` is the way back to the
// gate, on a cooldown.
const c = await connect('C', await auth('C'))
const gate = c.welcome.self
send(c, { t: 'move', ...noMove, forward: true, a: Math.PI / 2 })
await sleep(1500)
send(c, { t: 'move', ...noMove, a: Math.PI / 2 })
await sleep(300)
const walked = c.frames.filter(f => f.t === 'state').flatMap(f => f.players).filter(p => p.id === gate.id).at(-1)
check('C walked away from the gate', !!walked && Math.hypot(walked.x - gate.x, walked.y - gate.y) > 3, walked ? `to ${walked.x.toFixed(1)}, ${walked.y.toFixed(1)}` : 'no state')
c.ws.close()
await sleep(300)
const c2 = await connect('C2', c.cookie)
const back = c2.welcome.self
check('a reconnect resumes where the body stood', !!walked && Math.hypot(back.x - walked.x, back.y - walked.y) < 0.5, `at ${back.x.toFixed(1)}, ${back.y.toFixed(1)}`)
check('and keeps its heading', Math.abs(back.angle - Math.PI / 2) < 0.01, `angle=${back.angle}`)
send(c2, { t: 'action', kind: 'respawn' })
await sleep(300)
const home = c2.frames.filter(f => f.t === 'state').flatMap(f => f.players).filter(p => p.id === gate.id).at(-1)
check('respawn returns to the gate', !!home && Math.hypot(home.x - gate.x, home.y - gate.y) < 1.5, home ? `at ${home.x.toFixed(1)}, ${home.y.toFixed(1)}` : 'no state')
check('respawn is confirmed', c2.frames.some(f => f.t === 'system' && f.text === 'Returned to town.'))
send(c2, { t: 'action', kind: 'respawn' })
await sleep(150)
check('a second respawn waits out the cooldown', c2.frames.some(f => f.t === 'system' && f.text.startsWith('You can return to town again in')))
c2.ws.close()

a2.ws.close()
a.ws.close()
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
