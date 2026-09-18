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
//   map    enter the arena, press M, shoot the full-screen world map
//   gate   stop on /play's character-creation gate and shoot it at 1280x800 and 400x800
//   landing shoot the `/` landing page at 1280x800 and 400x800 (no game loaded)
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
//   MMO_STATS    non-empty: also report fps / mesh / triangle counts
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

const url = await detectUrl()
const errors = []
// MMO_HEADED=1 opens a real window on the real GPU: full frame rate, which
// anything timed (chat bubbles) needs.
const HEADED = process.env.MMO_HEADED === '1'
const browser = await chromium.launch({ headless: !HEADED, args: HEADED ? [] : GL_ARGS })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

console.log(`→ ${url}  (mode=${mode})`)
await page.goto(url + (mode === 'landing' ? '/' : '/play'), { waitUntil: 'networkidle', timeout: 60000 })
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
  // Slot 6 on the first hotbar page is Kit_Wall (five tools, then the kit).
  await page.keyboard.press('Digit6')
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
if (process.env.MMO_STATS) {
  const stats = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0
    const start = performance.now()
    const tick = () => {
      frames++
      if (performance.now() - start < 3000) requestAnimationFrame(tick)
      else {
        let meshes = 0
        let instanced = 0
        let tris = 0
        // eslint-disable-next-line no-undef
        const root = window.__maze?.camera?.value?.parent
        const scene = root && root.type === 'Scene' ? root : null
        scene?.traverse((o) => {
          if (o.isInstancedMesh) { instanced++; tris += (o.geometry?.index?.count ?? 0) / 3 * o.count }
          else if (o.isMesh) { meshes++; tris += (o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3 }
        })
        resolve({ fps: Math.round(frames / ((performance.now() - start) / 1000)), meshes, instanced, tris: Math.round(tris) })
      }
    }
    requestAnimationFrame(tick)
  }))
  console.log('STATS ', JSON.stringify(stats))
}
console.log('SCENE ', JSON.stringify(scene))
console.log('SHOT  ', OUT)
console.log('ERRORS', errors.length)
// Known-benign: a web-font .woff2 404, and "props.characters is not iterable" from
// the menu's CharacterLineup components (pre-existing, unrelated to the game scene).
for (const e of [...new Set(errors)].slice(0, 20)) console.log('  -', e)
await browser.close()
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

