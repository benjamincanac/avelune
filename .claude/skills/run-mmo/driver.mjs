// Avelune run-driver: launch headless Chromium, create a character, drive the 3D game,
// screenshot, and report console/page errors. Avelune is a Nuxt + TresJS/three.js
// WebGL game — there is no server-rendered "page" to assert on; you must drive the
// live canvas. This is the harness the /run-mmo skill points at.
//
// Usage:  node .claude/skills/run-mmo/driver.mjs [arena|walk|chat|meadow|build|map|gate|landing]
//   arena  (default) enter the arena and screenshot it
//   walk   arena, then hold forward for a few seconds before shooting
//   meadow walk out of the south gate, turn back toward the hills, shoot
//   build  walk out of the gate, arm a kit wall, click to place it, shoot
//   target /tp to a flat meadow spot and shoot the build targeting: the shoulder
//          camera with a wall ghost, the ghost off a placed wall's side face and
//          off its top face, a hut ringed by four panels, a look straight down
//          at the player's own tile, and a painted drag
//   map    enter the arena, press M, shoot the full-screen world map
//   gate   stop on /play's character-creation gate and shoot it at 1280x800 and 400x800
//   landing shoot the `/` landing page at 1280x800 and 400x800 (no game loaded)
//   still  dev server only: open the world editor (`/play?editor=1`), seat its fly
//          camera at MMO_CAM and shoot the town with no player and no UI in frame
//
// Every mode but `landing` drives `/play` — `/` is the landing page and has no
// canvas on it.
//
// Env:
//   MMO_URL      explicit base url, skips port autodetect    (e.g. http://localhost:3001)
//   MMO_OUT      screenshot path                             (default /tmp/mmo-<mode>.png)
//   MMO_PW       path to a Playwright install                (default the Homebrew global)
//   MMO_TIME     /time argument to fix the sun before shooting
//   MMO_WEATHER  /weather argument, only with MMO_TIME
//   MMO_BACK     ms to hold S walking out of the gate        (meadow/build)
//   MMO_TURN     px of yaw for the about-turn                (~507 px per 90°)
//   MMO_SWIM_X/Y target tile in the moat (dev builds)       (swim)
//   MMO_STRAFE   ms of D before walking in (prod builds)     (swim)
//   MMO_HOLD     keep W held through the shot                 (swim)
//   MMO_PITCH    px of pitch per step, 8 steps (positive looks down)
//   MMO_TP_X/Y   where `target` teleports to                   (default 90 150)
//   MMO_HUT_X/Y  where `target` rings a cell with four panels  (default 110 150)
//   MMO_HUT_BACK tiles it stands off to shoot that hut         (default 7)
//   MMO_STATS    non-empty: fps, draw calls and triangles per frame, one row per
//                render pass (see perf.mjs). Works in every mode, `still` included,
//                which is the one with a camera you can put back where it was
//   MMO_DUMP     non-empty: triangles by scene group and what casts (dev server)
//   MMO_DPR      device pixel ratio for the page (default 1; 2 is a retina Mac)
//   MMO_GFX      graphics settings as the JSON the Escape menu stores, e.g.
//                '{"scale":1,"detail":"high","shadows":true,"occlusion":true,"bloom":true}'
//   MMO_CAM      "x,y,z,yaw,pitch" for `still`: editor tiles and degrees
//   MMO_SIZE     "WxH" viewport for `still`                   (default 2560x1440)
//   MMO_HUD      "0": hide every 2D overlay before the shot (clean scenery stills)
//
// Note: the page has TWO canvases (the world and the minimap), so every locator
// here is `.first()`. A bare `locator('canvas')` is a strict-mode violation and
// the `.catch()` around each click swallows it silently — clicks then never
// land, which matters now that a click also uses the armed hotbar tool.
//
// Playwright is NOT a project dependency here — it's installed globally and is CJS,
// so we require() it by absolute path rather than `import { chromium }`.
import { createRequire } from 'node:module'
import { dumpTriangles, installGpuCounters, measure, printDump, printStats } from './perf.mjs'

const require = createRequire(import.meta.url)
const PW = process.env.MMO_PW || '/opt/homebrew/lib/node_modules/playwright'
const { chromium } = require(PW)

const mode = (process.argv[2] || 'arena').toLowerCase()
const OUT = process.env.MMO_OUT || `/tmp/mmo-${mode}.png`

// Software WebGL — headless Chromium has no GPU; without these the canvas is black.
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

async function detectUrl() {
  if (process.env.MMO_URL) return process.env.MMO_URL
  for (let p = 3000; p <= 3010; p++) {
    try {
      const res = await fetch(`http://localhost:${p}/`, { signal: AbortSignal.timeout(1500) })
      const html = await res.text()
      if (res.ok && /Avelune/i.test(html)) return `http://localhost:${p}`
    }
    catch { /* port closed — keep probing */ }
  }
  throw new Error('No Avelune dev server found on :3000-3010. Start one (see SKILL.md) or set MMO_URL.')
}

/** Playwright's `evaluate` has no deadline of its own, and a SwiftShader frame
 *  that runs long enough leaves it hanging for good — so every read the driver
 *  makes of the live page is raced against a timeout. */
const ask = (fn, fallback = null, ms = 15000) => Promise.race([
  page.evaluate(fn).catch(() => fallback),
  new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
])

const url = await detectUrl()
const errors = []
// MMO_HEADED=1 opens a real window on the real GPU: full frame rate, which
// anything timed (chat bubbles) needs. `target` takes it by default: SwiftShader
// renders a frame slowly enough to starve the WebSocket, the server closes a
// socket that misses its heartbeat, and the reconnect respawns the session in
// town — several times a minute, which a mode that teleports, aims and clicks
// cannot survive. MMO_HEADED=0 forces headless anyway.
const HEADED = process.env.MMO_HEADED === '1' || ((mode === 'target' || mode === 'room') && process.env.MMO_HEADED !== '0')
const browser = await chromium.launch({ headless: !HEADED, args: HEADED ? [] : GL_ARGS })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.MMO_DPR || 1) })
if (process.env.MMO_GFX) {
  await page.addInitScript((settings) => {
    try {
      localStorage.setItem('avelune:graphics', settings)
    }
    catch {}
  }, process.env.MMO_GFX)
}
if (process.env.MMO_STATS) await installGpuCounters(page)
async function report() {
  if (process.env.MMO_STATS) printStats(await measure(page))
  if (process.env.MMO_DUMP) printDump(await dumpTriangles(page))
}
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

// Model traffic, so a mode that needs a settled main thread can wait for the
// ~180 GLB requests to drain rather than guess at a timeout.
const pendingModels = new Set()
let lastModelAt = Date.now()
page.on('request', (r) => {
  if (r.url().includes('/models/')) { pendingModels.add(r.url()); lastModelAt = Date.now() }
})
for (const done of ['requestfinished', 'requestfailed']) {
  page.on(done, (r) => {
    if (pendingModels.delete(r.url())) lastModelAt = Date.now()
  })
}
const modelsQuiet = async (quietMs = 4000, limit = 90000) => {
  const until = Date.now() + limit
  while (Date.now() < until) {
    if (!pendingModels.size && Date.now() - lastModelAt > quietMs) return true
    await page.waitForTimeout(500)
  }
  return false
}

console.log(`→ ${url}  (mode=${mode})`)
await page.goto(url + (mode === 'landing' ? '/' : mode === 'still' ? '/play?editor=1' : '/play'), { waitUntil: mode === 'still' ? 'domcontentloaded' : 'networkidle', timeout: 60000 })
await page.waitForTimeout(1200)

if (mode === 'landing' || mode === 'gate') {
  // Two page shots, no arena to health-check: `landing` is the static index,
  // `gate` is /play's character creation (a fresh context has no character
  // cookie, so the load stops there — leave the name empty).
  if (mode === 'gate') await page.getByPlaceholder(/name your character/i).first().waitFor({ timeout: 30000 })
  else await page.getByRole('link', { name: /play|continue as/i }).first().waitFor({ timeout: 30000 })
  // The 3D bust streams its GLB and the live line polls /api/status once.
  await page.waitForTimeout(mode === 'gate' ? 6000 : 2500)
  const narrow = OUT.replace(/\.png$/, '-400.png')
  await page.screenshot({ path: OUT, timeout: 180000, animations: 'disabled' })
  await page.setViewportSize({ width: 400, height: 800 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: narrow, timeout: 180000, animations: 'disabled', fullPage: true })
  console.log('SHOT  ', OUT)
  console.log('SHOT  ', narrow)
  console.log('ERRORS', errors.length)
  for (const e of [...new Set(errors)].slice(0, 20)) console.log('  -', e)
  await browser.close()
  process.exit(0)
}

if (mode === 'still') {
  // The editor builds the town from the seed with no socket, so there is no
  // player, no nameplate and no reconnect to race: wait for the models, fix the
  // sun on the never-connected game's own refs, seat the camera, shoot.
  const [w, h] = (process.env.MMO_SIZE || '2560x1440').split('x').map(Number)
  await page.setViewportSize({ width: w, height: h })
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await ask(() => !!window.__editor?.seat && !!window.__maze, false)
    if (!ready) await page.waitForTimeout(1000)
  }
  if (!ready) {
    console.error(`FAILED: the editor never mounted at ${url} — it is dev-only, so this needs \`pnpm dev\`, not a prod build.`)
    await browser.close()
    process.exit(1)
  }
  console.log('MODELS', await modelsQuiet(6000, 240000) ? 'quiet' : 'still loading')
  const [x, y, z, yaw, pitch] = (process.env.MMO_CAM || '72,14,150,0,-8').split(',').map(Number)
  await page.evaluate(({ x, y, z, yaw, pitch, time, weather }) => {
    const rad = Math.PI / 180
    window.__editor.seat(x, y, z, yaw * rad, pitch * rad)
    window.__maze.game.timeOfDay.value = time
    window.__maze.game.weather.value = weather
  }, { x, y, z, yaw, pitch, time: process.env.MMO_TIME || 'day', weather: process.env.MMO_WEATHER || 'clear' })
  // A stylesheet rather than a sweep of the DOM: the editor panel is lazy and
  // can mount after a one-off hide has already run.
  await page.addStyleTag({ content: 'body *:not(canvas):not(:has(canvas)) { visibility: hidden !important }' })
  // The sky eases to a new sun angle rather than jumping.
  await page.waitForTimeout(6000)
  await page.screenshot({ path: OUT, timeout: 300000, animations: 'disabled' })
  await report()
  console.log('SHOT  ', OUT)
  console.log('ERRORS', errors.length)
  for (const e of [...new Set(errors)].slice(0, 20)) console.log('  -', e)
  await browser.close()
  process.exit(0)
}

// Onboarding. `/play` has no menu of its own: a fresh browser (no character
// cookie) lands straight on character creation, so fill the name and Enter (the button
// is disabled until the name is non-empty). A browser WITH a saved cookie is
// already in the arena and the name field never appears.
const click = async (rx) => {
  const b = page.getByRole('button', { name: rx })
  if (await b.count()) {
    await b.first().click().catch(() => {})
    return true
  }
  return false
}
const nameField = page.getByPlaceholder(/name your character/i)
if (await nameField.count()) {
  await nameField.fill('Probe').catch(() => {})
  await page.waitForTimeout(200)
  await click(/^enter( the world)?$/i)
}

// WS connect + hub build + streamed models + a follow-up rebuild once deferred
// (decorative) props land.
await page.waitForTimeout(8000)

// Health check: confirm we actually reached the playing view (a sized canvas +
// HUD header). Some stale/other Avelune instances answer 200 but never connect the
// socket, leaving a 0x0 canvas and a black shot — fail loudly instead.
let live = false
for (let i = 0; i < 12; i++) {
  const ok = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return !!c && c.width > 0 && (document.querySelector('header')?.innerText || '').length > 0
  })
  if (ok) {
    live = true
    break
  }
  await page.waitForTimeout(1000)
}
if (!live) {
  await page.screenshot({ path: OUT, timeout: 180000, animations: 'disabled' })
  console.error(`FAILED: never reached the game view at ${url} (canvas 0x0 / no HUD).`)
  console.error('  This target may be a stale instance — start a fresh server and pass MMO_URL (see SKILL.md).')
  await browser.close()
  process.exit(1)
}

if (process.env.MMO_TIME) {
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type(`/time ${process.env.MMO_TIME}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  if (process.env.MMO_WEATHER) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    await page.keyboard.type(`/weather ${process.env.MMO_WEATHER}`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
  }
}

// Chat is how the dev-only server commands are reached: Enter opens the line,
// Enter again sends it. `/tp`, `/time` and `/weather` need AVELUNE_DEV_COMMANDS=1
// on a prod build.
const say = async (text) => {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
}

// Yaw/pitch by synthetic movementX/Y on the canvas: real mouse moves are
// zero-sum across the viewport and are ignored when not pointer-locked.
const look = async (total, key, steps = 12) => {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(([d, k]) => {
      document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { [k]: d, bubbles: true }))
    }, [total / steps, key])
    await page.waitForTimeout(60)
  }
}
const shoot = async (suffix) => {
  const path = OUT.replace(/\.png$/, `-${suffix}.png`)
  await page.screenshot({ path, timeout: 300000, animations: 'disabled' })
  console.log('SHOT  ', path)
}
/** Arm a hotbar slot. Page 0 is the tools, 1 and 2 are the kit. */
let armedSlot = null
const arm = async (pageIndex, slot) => {
  await unarm()
  // Tab is a three-cycle, so pressing it a fixed number of times is a no-op as
  // often as not. Read the page off the bar's own "N/3" and stop on the wanted
  // one — a reconnect does not reset the hotbar, so the starting page is
  // whatever the last frame left armed.
  for (let i = 0; i < 4; i++) {
    const at = await ask(() => Number(document.body.innerText.match(/(\d)\/3\b/)?.[1] ?? 0), 0)
    if (at === pageIndex + 1) break
    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)
  }
  await page.keyboard.press(`Digit${slot}`)
  armedSlot = slot
  await page.waitForTimeout(400)
}
/** The same digit again disarms; nothing must be armed while we click the
 *  canvas purely to take focus back off the chat line. */
const unarm = async () => {
  if (armedSlot == null) return
  await page.keyboard.press(`Digit${armedSlot}`)
  armedSlot = null
  await page.waitForTimeout(200)
}
/** Hand focus back to the world after a chat command, with nothing armed so the
 *  click cannot edit. The first click of a session is spent on pointer lock. */
const refocus = async () => {
  await unarm()
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.waitForTimeout(600)
}
/** The bar's own piece counter, which is the server's count. */
const pieces = () => ask(() => Number(document.body.innerText.match(/(\d+)\/500 pieces/i)?.[1] ?? -1), -1)
/** Click until the server actually books a piece. A click that only re-takes
 *  pointer lock places nothing, and which click that is depends on what the
 *  chat line did with focus a moment earlier. */
const placeOnce = async () => {
  const before = await pieces()
  for (let i = 0; i < 5; i++) {
    await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
    await page.waitForTimeout(900)
    if (await pieces() > before) return true
  }
  // A dropped socket eats clicks silently; give it one full recovery and retry.
  await settle()
  for (let i = 0; i < 3; i++) {
    await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
    await page.waitForTimeout(900)
    if (await pieces() > before) return true
  }
  console.error('PLACE FAILED  nothing was booked after 8 clicks')
  // The bar's chip carries the refusal, and a `reject` frame lands as a toast:
  // whichever it is, it is in the page text.
  console.error('  HUD  ' + String(await ask(() => document.body.innerText, '')).replace(/\n+/g, ' | ').slice(-400))
  return false
}

/** The tile the minimap's bar says we are on, or null while it is not up. */
const tileAt = async () => ask(() => {
  const m = document.body.innerText.match(/\n(-?\d+), (-?\d+)\n/)
  return m ? [Number(m[1]), Number(m[2])] : null
})

/** The tile `target` mode means to be standing on, so a reconnect can be undone. */
let home = null

/**
 * Wait for the socket, and put the player back where the shot needs them.
 *
 * A SwiftShader screenshot blocks the main thread long enough to miss the
 * heartbeat, so the server closes the socket and the client opens a fresh
 * session — in town, thirty tiles from wherever the run was working. Every
 * frame of `target` therefore starts by waiting for the connection banner to
 * clear and re-teleporting if the reconnect moved us.
 */
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    const down = await ask(() => /reconnecting|connection dropped/i.test(document.body.innerText), true)
    if (!down) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(800)
  if (!home) return
  const at = await tileAt()
  if (at && Math.abs(at[0] - home[0]) <= 2 && Math.abs(at[1] - home[1]) <= 2) return
  await refocus()
  await tpTo(home[0], home[1])
}

/**
 * Teleport, and confirm it took.
 *
 * Headless Chromium starves the socket while the GLB queue drains, and a
 * missed heartbeat reconnects it — which respawns the session in town, wiping
 * the teleport a second or two after the server confirms it. So this reads the
 * minimap's own coordinate bar back and resends until it agrees.
 */
const tpTo = async (x, y) => {
  home = [x, y]
  for (let attempt = 0; attempt < 6; attempt++) {
    await say(`/tp ${x} ${y}`)
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(700)
      const at = await tileAt()
      if (at && Math.abs(at[0] - x) <= 2 && Math.abs(at[1] - y) <= 2) {
        await page.waitForTimeout(1500)
        return true
      }
    }
  }
  console.error(`TP FAILED  ${x} ${y}`)
  return false
}

if (mode === 'target') {
  // Deterministic ground: teleport to a known meadow tile rather than walking
  // there, so every shot below frames the same place on every run. Wait for the
  // model queue first — a teleport issued into that burst is usually undone by
  // the reconnect it causes.
  await modelsQuiet()
  await refocus()
  await say(`/time ${process.env.MMO_TIME || 'day'}`)
  await tpTo(Number(process.env.MMO_TP_X || 90), Number(process.env.MMO_TP_Y || 150))

  // 1. The shoulder camera, with a wall ghost on open ground. Arming is what
  //    swings the camera off centre, so this is the shot that shows both.
  await settle()
  await refocus()
  await arm(1, 1)
  await look(Number(process.env.MMO_PITCH || 150), 'movementY', 8)
  await page.waitForTimeout(1200)
  await settle()
  await shoot('ghost')

  // 2. Place it, then raise the view onto the panel's broad face: the ghost
  //    should climb to the storey above on the SAME edge, which is how a second
  //    floor goes up.
  await settle()
  await arm(1, 1)
  await placeOnce()
  await look(-90, 'movementY', 6)
  await page.waitForTimeout(1200)
  await shoot('stack')

  // 3. Drop back onto the panel's end face: the ghost continues the run along
  //    the same edge line instead of climbing onto it.
  await settle()
  await arm(1, 1)
  await look(220, 'movementY', 8)
  await page.waitForTimeout(1200)
  await shoot('run')

  // 4. A hut: standing on a cell centre, four clicks a quarter turn apart ring
  //    that one cell — the whole point of edge snapping. The last one is a
  //    doorway, so the room has a way out.
  await settle()
  await tpTo(Number(process.env.MMO_HUT_X || 110), Number(process.env.MMO_HUT_Y || 150))
  await refocus()
  await arm(1, 1)
  await look(Number(process.env.MMO_HUT_PITCH || 300), 'movementY', 8)
  await page.waitForTimeout(600)
  for (let i = 0; i < 4; i++) {
    await settle()
    await arm(1, i === 3 ? 3 : 1)
    await placeOnce()
    await look(507, 'movementX', 8)
    await page.waitForTimeout(400)
  }
  // Stand off and look back, so the shot shows a closed room and its doorway.
  // Walking out is not an option: four panels around one cell is a room, and
  // the whole point is that a body inside cannot leave except by the door.
  await unarm()
  await settle()
  await tpTo(Number(process.env.MMO_HUT_X || 110), Number(process.env.MMO_HUT_Y || 150) + Number(process.env.MMO_HUT_BACK || 7))
  await refocus()
  await look(-Number(process.env.MMO_HUT_PITCH || 300) + 90, 'movementY', 8)
  await page.waitForTimeout(1500)
  await shoot('hut')

  // 5. Straight down at your own boots: the steep pitch an armed tool unlocks,
  //    the boom pulled in over your head, and the character faded out of the
  //    way so the tile under the crosshair is the one you are standing on.
  await settle()
  // Half a tile in, so the tile under the crosshair is unambiguously the one
  // the boots are on rather than the seam between two.
  await tpTo(Number(process.env.MMO_PAINT_X || 130) + 0.5, Number(process.env.MMO_PAINT_Y || 150) + 0.5)
  await refocus()
  await arm(0, 4)
  await look(700, 'movementY', 14)
  await page.waitForTimeout(1500)
  await shoot('feet')

  // 6. Paint, dragged: hold the button and walk, and the tool repeats on every
  //    new tile without a click each.
  await settle()
  await arm(0, 4)
  await look(-180, 'movementY', 8)
  await page.waitForTimeout(600)
  await page.mouse.move(640, 400)
  await page.mouse.down()
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(2600)
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(600)
  await page.mouse.up()
  // Turn around so the run of paving is in front of the camera, not under it.
  await look(1014, 'movementX', 10)
  await page.waitForTimeout(1500)
  await shoot('paint')
}

if (mode === 'room') {
  // Dev server only: builds through `window.__maze.game.sendBuild`, so every
  // piece goes to the server with an exact aim and height and nothing depends
  // on where a synthetic mouse move left the crosshair. A two-cell room with a
  // wall stacked over its door, a floor laid inside it, stairs pushed against
  // its walls and an upper floor hung from the wall tops, then a floor, a path
  // and a crate on open meadow so the shot shows the grass stopping at them.
  await modelsQuiet()
  await refocus()
  await say(`/time ${process.env.MMO_TIME || 'day'}`)
  const X = Number(process.env.MMO_ROOM_X || 110)
  const Y = Number(process.env.MMO_ROOM_Y || 150)
  await tpTo(X + 1, Y)
  // Aims are heights above the ground the player stands on, not absolute: the
  // meadow is not flat everywhere, and an upper floor aimed at 2.3 on a rise
  // would read the storey below it.
  const ground = await ask(() => window.__maze.local.z ?? 0, 0)
  const Q = Math.PI / 2
  const ops = [
    ['Kit_WallDoor', X, Y + 3, 0, 0],
    ['Kit_WallWindow', X + 2, Y + 3, 0, 0],
    ['Kit_Wall', X, Y + 5, 0, 0],
    ['Kit_Wall', X + 2, Y + 5, 0, 0],
    ['Kit_Wall', X - 1, Y + 4, Q, 0],
    ['Kit_Wall', X + 3, Y + 4, Q, 0],
    ['Kit_Floor', X, Y + 4, 0, 0],
    ['Kit_Stairs', X + 2, Y + 4, 3 * Q, 0],
    ['Kit_Wall', X, Y + 3, 0, 2.5],
    ['Kit_Floor', X, Y + 4, 0, 2.3],
    ['Kit_Floor', X - 4, Y, 0, 0],
    ['Kit_Path', X - 4, Y - 2, 0, 0],
    ['Kit_Crate', X - 2, Y - 2, 0, 0],
    ['Kit_Fence', X - 4, Y + 3, 0, 0],
    ['Kit_Gate', X - 2, Y + 3, 0, 0],
    ['Kit_Roof', X + 6, Y, 0, 0],
    ['Kit_RoofCorner', X + 6, Y + 2, 0, 0],
  ]
  for (const [kind, x, y, rot, h] of ops) {
    await settle()
    const before = await pieces()
    await page.evaluate(([k, px, py, r, ph]) => window.__maze.game.sendBuild(k, px, py, r, ph), [kind, x, y, rot, ground + h])
    let booked = false
    for (let i = 0; i < 10 && !booked; i++) {
      await page.waitForTimeout(300)
      booked = await pieces() > before
    }
    console.log(booked ? 'BUILT ' : 'REFUSED', kind, x - X, y - Y, 'h', h)
  }
  const pose = (yaw, pitch) => page.evaluate(([yw, pt]) => {
    const m = window.__maze
    m.view.yaw = yw
    m.view.pitch = pt
    m.game.setLook(yw)
  }, [yaw, pitch])
  await pose(Math.PI / 2, Number(process.env.MMO_PITCH || 0.3))
  await page.waitForTimeout(1500)
  await shoot('room')
  await pose(Math.PI, Number(process.env.MMO_PITCH || 0.3) + 0.25)
  await page.waitForTimeout(1500)
  await shoot('cover')
  await pose(0, Number(process.env.MMO_PITCH || 0.3) + 0.15)
  await page.waitForTimeout(1500)
  await shoot('kit')
}

if (mode === 'build') {
  // Out of the south gate far enough to clear the protected town, turn around
  // so the crosshair lands on open meadow a couple of tiles ahead, arm a kit
  // wall and click twice with a sidestep between.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(Number(process.env.MMO_BACK || 17000))
  await page.keyboard.up('KeyS')
  await page.waitForTimeout(800)
  const look = async (total, key) => {
    for (let i = 0; i < 12; i++) {
      await page.evaluate(([d, k]) => {
        document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { [k]: d, bubbles: true }))
      }, [total / 12, key])
      await page.waitForTimeout(60)
    }
  }
  await look(Number(process.env.MMO_TURN || 1014), 'movementX')
  await page.waitForTimeout(400)
  await look(Number(process.env.MMO_PITCH || 120), 'movementY')
  await page.waitForTimeout(600)
  // The kit lives on the second hotbar page: Tab turns to it, and Kit_Wall is
  // its first slot. (The first page is the terraform tools, with demolish on 0.)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  await page.keyboard.press('Digit1')
  await page.waitForTimeout(500)
  // Two clicks without moving: the second wall stacks on the first, which is
  // the thing worth seeing. Stay still afterwards so both stay in frame.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.waitForTimeout(2000)
}

if (mode === 'paint') {
  // Back out of the gate a few tiles past the end of the road, turn around to
  // face it, arm Paint and lay a run of tiles walking back toward the road, so
  // the seams between painted tiles and the join with the authored road are
  // both in frame.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(Number(process.env.MMO_BACK || 6000))
  await page.keyboard.up('KeyS')
  await page.waitForTimeout(800)
  const look = async (total, key) => {
    for (let i = 0; i < 12; i++) {
      await page.evaluate(([d, k]) => {
        document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { [k]: d, bubbles: true }))
      }, [total / 12, key])
      await page.waitForTimeout(60)
    }
  }
  await look(Number(process.env.MMO_TURN || 1014), 'movementX')
  await page.waitForTimeout(400)
  await look(Number(process.env.MMO_PITCH || 160), 'movementY')
  await page.waitForTimeout(600)
  // Tools page, slot 4 is Paint (defaults to paving).
  await page.keyboard.press('Digit4')
  await page.waitForTimeout(500)
  for (let i = 0; i < Number(process.env.MMO_TILES || 6); i++) {
    await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
    await page.waitForTimeout(400)
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(320)
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(500)
  }
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(1200)
  await page.keyboard.up('KeyS')
  await page.waitForTimeout(2500)
}

if (mode === 'meadow') {
  // Walk out of the gate into the meadow, then turn around to face the hills.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(Number(process.env.MMO_BACK || 6000))
  await page.keyboard.up('KeyS')
  await page.waitForTimeout(600)
  const dx = Number(process.env.MMO_TURN || 1014)
  for (let i = 0; i < 12; i++) {
    await page.evaluate((d) => {
      document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { movementX: d, bubbles: true }))
    }, dx / 12)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(600)
  // Pitch the camera up so the shot shows the horizon, not the boot the boom
  // collapsed onto.
  for (let i = 0; i < 8; i++) {
    await page.evaluate((d) => {
      document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { movementY: d, bubbles: true }))
    }, Number(process.env.MMO_PITCH || -20))
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(1500)
}

if (mode === 'chat') {
  // Two lines of different lengths: the second has to replace the first in the
  // bubble, not trail it. Bubbles are DOM and live 4 s, far less than a
  // SwiftShader screenshot takes, so each one is waited for by its text and
  // then pinned as a static clone the scene's frame loop no longer touches.
  await modelsQuiet()
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.waitForTimeout(600)
  const pin = async (want, label) => {
    const found = await page.waitForFunction(({ text, npc }) => {
      const el = [...document.querySelectorAll('.chat-bubble:not([hidden]):not([data-pinned])')]
        .find(el => npc ? 'npc' in el.dataset : el.textContent === text)
      if (!el) return false
      const copy = el.cloneNode(true)
      copy.dataset.pinned = ''
      copy.style.opacity = '1'
      copy.style.animation = 'none'
      el.parentElement.append(copy)
      return el.textContent
    }, want, { timeout: 30000, polling: 100 }).then(h => h.jsonValue()).catch(e => `ERR ${e.message.slice(0, 120)}`)
    console.log('BUBBLE', label, JSON.stringify(found))
  }
  const unpin = () => page.evaluate(() => document.querySelectorAll('.chat-bubble[data-pinned]').forEach(el => el.remove()))
  const long = 'Oracle, how many of us are in town right now and what should I build first?'
  await say('hey')
  await pin({ text: 'hey' }, 'short')
  await page.screenshot({ path: OUT.replace(/\.png$/, '-short.png'), timeout: 300000 })
  await unpin()
  await say(long)
  await pin({ text: long }, 'long')
  // The Oracle answers a few seconds later, over its own head.
  await pin({ npc: true }, 'oracle')
}

if (mode === 'map') {
  // Click to focus (Digit1 first so the click's tool fire is a harmless raise
  // we never trigger — the click requests pointer lock instead), then M.
  await page.keyboard.press('Digit1')
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.waitForTimeout(600)
  await page.keyboard.press('KeyM')
  await page.waitForTimeout(1500)
}

if (mode === 'swim') {
  // Steer into the moat ring by feedback: read the predicted body from
  // window.__maze.local, aim at a point in the water beside the bridge
  // (x 80, y 118: moat z 115..121, bridge |x-72| < 4) and hold whichever of
  // W/A/S/D closes the larger axis. MMO_HOLD keeps W held through the shot so
  // the stroke clip plays instead of treading water.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  const pos = () => page.evaluate(() => ({ x: window.__maze?.local?.x, y: window.__maze?.local?.y, z: window.__maze?.local?.z, a: window.__maze?.view?.yaw }))
  const target = { x: Number(process.env.MMO_SWIM_X || 80), y: Number(process.env.MMO_SWIM_Y || 118) }
  let held = null
  const probe = await pos()
  if (probe.x === undefined) {
    // window.__maze is dev-only. In a prod build fall back to timed keys from
    // the spawn (72,129 facing -y): strafe right past the bridge, walk in.
    await page.keyboard.down('KeyD')
    await page.waitForTimeout(Number(process.env.MMO_STRAFE || 2400))
    await page.keyboard.up('KeyD')
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(Number(process.env.MMO_BACK || 3600))
    await page.keyboard.up('KeyW')
  }
  for (let i = 0; probe.x !== undefined && i < 60; i++) {
    const p = await pos()
    const dx = target.x - p.x
    const dy = target.y - p.y
    if (Math.hypot(dx, dy) < 1) break
    // yaw -PI/2 faces -y: W moves -y, D moves +x (see server/utils/game.ts).
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'KeyD' : 'KeyA') : (dy > 0 ? 'KeyS' : 'KeyW')
    if (key !== held) {
      if (held) await page.keyboard.up(held)
      await page.keyboard.down(key)
      held = key
    }
    await page.waitForTimeout(250)
  }
  if (held) await page.keyboard.up(held)
  console.log('POS   ', JSON.stringify(await pos()))
  if (process.env.MMO_HOLD) await page.keyboard.down('KeyW')
  for (let i = 0; i < 8; i++) {
    await page.evaluate((d) => {
      document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', { movementY: d, bubbles: true }))
    }, Number(process.env.MMO_PITCH || 25))
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(1500)
  console.log('POS   ', JSON.stringify(await pos()))
}

if (mode === 'walk') {
  // Walk across the sand, to prove movement + collision are live. Keys are
  // global keydown listeners, but click the canvas to focus.
  await page.locator('canvas').first().click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(4000)
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(600)
}

// The health check reads the HUD, so it runs before MMO_HUD can hide it.
const scene = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  let gl = false
  try {
    gl = !!(c?.getContext('webgl2') || c?.getContext('webgl'))
  }
  catch { /* no context */ }
  return { canvas: !!c, w: c?.width, h: c?.height, gl, header: document.querySelector('header')?.innerText || '' }
})
if (process.env.MMO_HUD === '0') {
  // A clean scenery still (the landing page's backdrop is one): every 2D
  // overlay sits on a z-index layer above the canvas, so hiding those layers
  // leaves the world and nothing else.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('header, aside, [class*="z-10"], [class*="z-20"], [class*="z-30"], [class*="z-40"]')) el.style.display = 'none'
  })
  await page.waitForTimeout(500)
}
await page.screenshot({ path: OUT, timeout: 300000, animations: 'disabled' })
await report()
console.log('SCENE ', JSON.stringify(scene))
console.log('SHOT  ', OUT)
console.log('ERRORS', errors.length)
// Known-benign: a web-font .woff2 404, and "props.characters is not iterable" from
// the menu's CharacterLineup components (pre-existing, unrelated to the game scene).
for (const e of [...new Set(errors)].slice(0, 20)) console.log('  -', e)
await browser.close()
