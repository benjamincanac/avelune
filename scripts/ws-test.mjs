// Two-client protocol test against the Tempest server.
//
// The socket requires the signed identity cookie, so each client first creates
// a character over `POST /api/auth` and carries the cookie into the upgrade.
const WS_URL = process.argv[2] ?? 'ws://localhost:50889/api/ws'
const BASE = WS_URL.replace(/^ws/, 'http').replace(/\/api\/ws.*$/, '')
const characters = { A: 'Peasant_Male_SimpleParted', B: 'Ranger_Female_Long' }

/** Create a character and return its `tempest_id` cookie. The route validates
 *  and falls back to the default character, so a bare name is enough here. */
async function auth(label) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `Test${label}`, character: characters[label] }),
  })
  if (!res.ok) throw new Error(`${label}: auth ${res.status}`)
  const jar = res.headers.getSetCookie?.() ?? []
  const cookie = jar.map(c => c.split(';')[0]).find(c => c.startsWith('tempest_id='))
  if (!cookie) throw new Error(`${label}: no tempest_id cookie`)
  const restored = await fetch(`${BASE}/api/auth`, { headers: { cookie } }).then(r => r.json())
  check(`${label} character survives cookie restore`, restored.character === characters[label])
  return cookie
}

function connect(label, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { cookie } })
    const client = { ws, label, cookie, welcome: null, frames: [] }
    const timeout = setTimeout(() => reject(new Error(`${label}: no welcome`)), 5000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      client.frames.push(msg)
      if (msg.t === 'welcome') {
        client.welcome = msg
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
  && a.welcome.seed === undefined && a.welcome.records === undefined,
  `${self.name} @ (${self.x.toFixed(1)}, ${self.y.toFixed(1)}, z=${self.z})`,
)

check('self receives saved character', self.character === characters.A)
const b = await connect('B', await auth('B'))
check('welcome includes other player character', b.welcome.players.find(p => p.id === self.id)?.character === characters.A)
await sleep(100)
check('join includes new player character', a.frames.find(f => f.t === 'join' && f.player.id === b.welcome.self.id)?.player.character === characters.B)
const statesOf = (client, id, since = 0) =>
  client.frames.slice(since).filter(f => f.t === 'state').flatMap(f => f.players).filter(p => p.id === id)
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

// Chat reaches the other client, with no floor scoping left on the frame.
send(a, { t: 'chat', text: 'well met' })
await sleep(300)
const chat = b.frames.find(f => f.t === 'chat' && f.id === self.id)
check('chat reaches the arena', chat?.text === 'well met' && chat?.f === undefined)

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

a2.ws.close()
a.ws.close()
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
