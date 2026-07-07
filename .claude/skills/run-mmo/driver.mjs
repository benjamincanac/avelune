// Mugen run-driver: launch headless Chromium, onboard a runner, drive the 3D game,
// screenshot, and report console/page errors. Mugen is a Nuxt + TresJS/three.js
// WebGL game — there is no server-rendered "page" to assert on; you must drive the
// live canvas. This is the harness the /run-mmo skill points at.
//
// Usage:  node .claude/skills/run-mmo/driver.mjs [hub|floor]
//   hub    (default) enter the hub and screenshot it
//   floor  hub, then walk onto the portal to reach Floor 1 (Stone Dungeon) and shoot that
//
// Env:
//   MMO_URL  explicit base url, skips port autodetect        (e.g. http://localhost:3001)
//   MMO_OUT  screenshot path                                 (default /tmp/mmo-<mode>.png)
//   MMO_PW   path to a Playwright install                    (default the Homebrew global)
//
// Playwright is NOT a project dependency here — it's installed globally and is CJS,
// so we require() it by absolute path rather than `import { chromium }`.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW = process.env.MMO_PW || '/opt/homebrew/lib/node_modules/playwright'
const { chromium } = require(PW)

const mode = (process.argv[2] || 'hub').toLowerCase()
const OUT = process.env.MMO_OUT || `/tmp/mmo-${mode}.png`

// Software WebGL — headless Chromium has no GPU; without these the canvas is black.
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

async function detectUrl() {
  if (process.env.MMO_URL) return process.env.MMO_URL
  for (let p = 3000; p <= 3010; p++) {
    try {
      const res = await fetch(`http://localhost:${p}/`, { signal: AbortSignal.timeout(1500) })
      const html = await res.text()
      if (res.ok && /Mugen/i.test(html)) return `http://localhost:${p}`
    }
    catch { /* port closed — keep probing */ }
  }
  throw new Error('No Mugen dev server found on :3000-3010. Start one (see SKILL.md) or set MMO_URL.')
}

const url = await detectUrl()
const errors = []
const browser = await chromium.launch({ headless: true, args: GL_ARGS })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

console.log(`→ ${url}  (mode=${mode})`)
await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1200)

// Onboarding. A fresh browser has no character cookie, so the menu shows "Create
// your runner" (there is NO one-click Play). Create → fill the name → Enter (the
// button is disabled until the name is non-empty). A machine WITH a saved cookie
// shows an enter/play button instead, so try that first.
const click = async rx => {
  const b = page.getByRole('button', { name: rx })
  if (await b.count()) { await b.first().click().catch(() => {}); return true }
  return false
}
if (!(await click(/enter the tower|^play$|^enter$|climb/i))) {
  await click(/create/i)
  await page.waitForTimeout(700)
  await page.getByPlaceholder(/name your runner/i).fill('Probe').catch(() => {})
  await page.waitForTimeout(200)
  await click(/^enter$/i)
}

// WS connect + hub build + streamed models + a follow-up rebuild once deferred
// (decorative) props land.
await page.waitForTimeout(8000)

// Health check: confirm we actually reached the playing view (a sized canvas +
// HUD header). Some stale/other Mugen instances answer 200 but never connect the
// socket, leaving a 0x0 canvas and a black shot — fail loudly instead.
let live = false
for (let i = 0; i < 12; i++) {
  const ok = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return !!c && c.width > 0 && (document.querySelector('header')?.innerText || '').length > 0
  })
  if (ok) { live = true; break }
  await page.waitForTimeout(1000)
}
if (!live) {
  await page.screenshot({ path: OUT })
  console.error(`FAILED: never reached the game view at ${url} (canvas 0x0 / no HUD).`)
  console.error('  This target may be a stale instance — start a fresh server and pass MMO_URL (see SKILL.md).')
  await browser.close()
  process.exit(1)
}

if (mode === 'floor') {
  // Spawn faces the portal; hold forward to walk onto it → teleport to Floor 1.
  // Keys are global keydown listeners, but click the canvas first to focus it.
  await page.locator('canvas').click({ position: { x: 640, y: 400 } }).catch(() => {})
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(4500)
  await page.keyboard.up('KeyW')
  // Poll the HUD header until it leaves "The Hub".
  for (let i = 0; i < 12; i++) {
    const label = await page.evaluate(() => document.querySelector('header')?.innerText || '')
    if (/Floor\s+1/i.test(label)) break
    await page.waitForTimeout(1000)
  }
}

await page.screenshot({ path: OUT })
const scene = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  let gl = false
  try { gl = !!(c?.getContext('webgl2') || c?.getContext('webgl')) }
  catch { /* no context */ }
  return { canvas: !!c, w: c?.width, h: c?.height, gl, header: document.querySelector('header')?.innerText || '' }
})
console.log('SCENE ', JSON.stringify(scene))
console.log('SHOT  ', OUT)
console.log('ERRORS', errors.length)
// Known-benign: a web-font .woff2 404, and "props.characters is not iterable" from
// the menu's CharacterLineup components (pre-existing, unrelated to the game scene).
for (const e of [...new Set(errors)].slice(0, 20)) console.log('  -', e)
await browser.close()
