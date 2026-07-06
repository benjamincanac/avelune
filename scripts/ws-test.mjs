// Two-client protocol test against the Mugen server (v3: z, jump, dash).
const URL = process.argv[2] ?? 'ws://localhost:50889/api/ws'

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    const client = { ws, label, welcome: null, frames: [] }
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

const a = await connect('A')
const self = a.welcome.self
check('A welcome', self?.floor === 0 && self?.z === 0 && typeof a.welcome.now === 'number',
  `${self.name} @ (${self.x.toFixed(1)}, ${self.y.toFixed(1)}, z=${self.z})`)

const b = await connect('B')
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

// Walk into the teleport circle from wherever the dash left us.
const here = lastState()
const heading = Math.atan2(12 - here.y, 12 - here.x)
send(a, { t: 'move', ...noMove, forward: true, a: heading })
await sleep(Math.min(4200, (Math.hypot(12 - here.x, 12 - here.y) / 3.2) * 1000 + 900))
send(a, { t: 'move', ...noMove, a: heading })
await sleep(400)
const clearMsg = b.frames.find(f => f.t === 'clear' && f.id === self.id)
check('teleport circle fired a clear', !!clearMsg && clearMsg.floor === 0 && clearMsg.best === 1,
  clearMsg ? `best=${clearMsg.best}` : 'no clear frame')
check('A is on floor 1', lastState().f === 1, `f=${lastState().f}`)

// Chat carries the sender's floor.
send(a, { t: 'chat', text: 'depth calls' })
await sleep(300)
const chat = b.frames.find(f => f.t === 'chat' && f.id === self.id)
check('chat has floor', chat?.text === 'depth calls' && chat?.f === 1, `f=${chat?.f}`)

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

a.ws.close()
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
