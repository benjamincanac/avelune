// Avelune character-creation recorder: the small sibling of `record.mjs`, for
// the one screen that recorder deliberately skips.
//
// `record.mjs` mints its character in a throwaway context so onboarding never
// reaches the take. That is right for a take of the world, and it means there
// is no footage of the creator at all: the turntable, the five outfits, the
// dossier that rewrites itself, the colourways, the beard, Randomize. This
// records exactly that and nothing else.
//
// It needs a dev server, but a plain one: no `AVELUNE_DEV_COMMANDS`, no bots,
// no `/tp`. Nothing here touches the world. It does need a real GPU, so it
// always launches headed, and it needs a **fresh context**, which is what puts
// `/play` on the gate rather than in the arena: the cookie is the whole of
// identity here, and a context that has never seen one has never onboarded.
//
// Usage:
//   NUXT_IGNORE_LOCK=1 pnpm dev --port 4380 &
//   MMO_URL=http://localhost:4380 MMO_OUT=/tmp/creator node .claude/skills/run-mmo/creator.mjs
//
// Env:
//   MMO_URL   base url of the dev server            (required in practice)
//   MMO_OUT   webm output directory                 (default /tmp/avelune-creator)
//   MMO_NAME  the name typed at the end             (default Rook)
//   MMO_HOLD  ms held on each choice                (default 1050)
//   MMO_PW    path to a Playwright install
//
// Cutting works the same way as `record.mjs`: the marks are milliseconds from
// `page.goto`, the video starts at context creation and so runs a little behind
// them, and `duration - end` gives that offset exactly.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const PW = process.env.MMO_PW || '/opt/homebrew/lib/node_modules/playwright'
const { chromium } = require(PW)

const URL_BASE = (process.env.MMO_URL || 'http://localhost:3000').replace(/\/$/, '')
const OUT_DIR = process.env.MMO_OUT || '/tmp/avelune-creator'
const NAME = process.env.MMO_NAME || 'Rook'
const HOLD = Number(process.env.MMO_HOLD || 1050)
const SIZE = { width: 1280, height: 720 }

mkdirSync(OUT_DIR, { recursive: true })

const errors = []
let t0 = Date.now()
const marks = []
const mark = (label) => {
  const at = Date.now() - t0
  marks.push({ label, at })
  console.log(`MARK  ${(at / 1000).toFixed(3)}s  ${label}`)
}

const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: OUT_DIR, size: SIZE },
})
const page = await ctx.newPage()
page.on('console', m => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

// The creator streams its own GLBs, a body and an outfit and a hairstyle per
// choice, so the same wait the take uses applies here: an outfit clicked before
// its mesh is cached pops in a frame late.
const pending = new Set()
let lastModelAt = Date.now()
page.on('request', (r) => {
  if (r.url().includes('/models/')) { pending.add(r.url()); lastModelAt = Date.now() }
})
for (const done of ['requestfinished', 'requestfailed']) {
  page.on(done, r => pending.delete(r.url()) && (lastModelAt = Date.now()))
}
const modelsQuiet = async (quietMs = 2500, limit = 60000) => {
  const until = Date.now() + limit
  while (Date.now() < until) {
    if (!pending.size && Date.now() - lastModelAt > quietMs) return true
    await page.waitForTimeout(400)
  }
  return false
}

await page.addInitScript(() => {
  const paint = () => {
    const el = document.createElement('div')
    el.id = 'demo-curtain'
    el.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483647;transition:opacity .5s linear'
    document.documentElement.append(el)
  }
  if (document.documentElement) paint()
  else document.addEventListener('DOMContentLoaded', paint)
})

t0 = Date.now()
await page.goto(`${URL_BASE}/play`, { waitUntil: 'networkidle', timeout: 60000 })

const nameField = page.getByPlaceholder(/name your character/i)
await nameField.first().waitFor({ timeout: 40000 })
console.log('MODELS', await modelsQuiet() ? 'quiet' : 'still loading')
// One more beat after the queue drains: the first outfit's mesh is bound and
// posed a frame or two after its request finishes.
await page.waitForTimeout(1200)

/**
 * Click a choice by its visible label.
 *
 * `URadioGroup` with `indicator="hidden"` hides the input and paints the card,
 * so the accessible radio is there but the thing under the pointer is the
 * label. Try the role first, it is the honest selector, and fall back to the
 * text, which is what actually takes the click when the input is `sr-only`.
 */
const choose = async (label) => {
  const radio = page.getByRole('radio', { name: label, exact: false })
  if (await radio.count()) {
    await radio.first().click({ force: true, timeout: 4000 }).catch(() => {})
    return 'role'
  }
  await page.getByText(label, { exact: true }).first().click({ timeout: 4000 }).catch(() => {})
  return 'text'
}

/** One of the colourway swatches, which carry `sr-only` names rather than text:
 *  reach them through the group its legend names. */
const swatch = async (index) => {
  const group = page.locator('fieldset', { hasText: /outfit colour/i }).last()
  const radios = group.getByRole('radio')
  const n = await radios.count().catch(() => 0)
  if (!n) return false
  await radios.nth(Math.min(index, n - 1)).click({ force: true, timeout: 4000 }).catch(() => {})
  return true
}

/**
 * Click something in the options panel that may be below its fold.
 *
 * The panel is `max-h-[calc(100dvh-8rem)] overflow-y-auto`, and at 720p the
 * colourways and Randomize sit under its fold. Two things follow.
 *
 * First, Playwright waits for a control to be actionable before it clicks, so
 * a button off the bottom of a scroller is not a fast failure: it is the full
 * default timeout, thirty seconds of the take spent on a stationary screen.
 * Cap the wait so a miss costs a beat rather than the take.
 *
 * Second, scrolling it into view is not enough on its own. `scrollIntoView`
 * brings the element into the panel, but a real pointer click still needs its
 * centre inside the viewport, and here it is not. So the pointer is the
 * preference, not the requirement: fall back to dispatching the click on the
 * element. Vue's handler does not care which one arrived, and what the take
 * needs is the character changing, not a mouse cursor travelling to a button
 * that is off screen anyway.
 */
const clickInPanel = async (locator) => {
  const el = locator.first()
  if (!await el.count().catch(() => 0)) return false
  await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  if (await el.click({ timeout: 2000 }).then(() => true).catch(() => false)) return 'pointer'
  return el.evaluate(node => node.click()).then(() => 'dispatched').catch(() => false)
}

/**
 * Drag the turntable, and bring it back.
 *
 * The preview is a transparent canvas over the backdrop and it spins on a
 * horizontal drag, so this is the one gesture in the creator that is not a
 * click. It is a round trip rather than a one-way turn because the turntable
 * has no spring: wherever the drag stops is where the character stays, and a
 * one-way drag leaves it facing away for every beat after it. Out far enough to
 * show the back of the outfit, then most of the way home.
 */
const spin = async (out = 300, back = 250, steps = 22) => {
  const at = { x: 640, y: 380 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(at.x + (out * i) / steps, at.y)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(280)
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(at.x + out - (back * i) / steps, at.y)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

/* --- the take -------------------------------------------------------------- */
await page.evaluate(() => {
  const el = document.getElementById('demo-curtain')
  if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 600) }
})
mark('curtain')
await page.waitForTimeout(900)

// The five outfits are the point of the screen, so they go first and they go
// one after another: each click swaps the mesh on the turntable and rewrites
// the dossier on the right with that class's name, blurb and what the world
// hands it.
for (const outfit of ['Knight', 'Wizard', 'Ranger']) {
  console.log('CHOOSE', outfit, await choose(outfit))
  await page.waitForTimeout(HOLD)
  mark(outfit.toLowerCase())
}

// A colourway dyes the outfit cloth at runtime, so the change lands on the
// model already standing there rather than swapping it for another.
if (await swatch(3)) {
  await page.waitForTimeout(HOLD - 100)
  mark('colourway')
}

await spin()
await page.waitForTimeout(400)
mark('spin')

console.log('CHOOSE', 'Female', await choose('Female'))
await page.waitForTimeout(HOLD)
mark('female')

console.log('RANDOMIZE', await clickInPanel(page.getByRole('button', { name: /randomize/i })))
await page.waitForTimeout(HOLD + 100)
mark('randomize')

// Typed a character at a time, not a word: it is four letters, and a name
// appearing letter by letter is the shot.
await nameField.first().click().catch(() => {})
await page.waitForTimeout(250)
for (const ch of NAME) {
  await page.keyboard.insertText(ch)
  await page.waitForTimeout(110)
}
await page.waitForTimeout(700)
mark('named')

await page.waitForTimeout(600)
mark('end')

// The webm is only flushed when the context closes, and the handle has to be
// taken before the page goes with it.
const handle = page.video()
await ctx.close()
const video = await handle?.path().catch(() => null)
await browser.close()

console.log('VIDEO ', video || `(look in ${OUT_DIR})`)
console.log('MARKS ', JSON.stringify(marks))
console.log('ERRORS', errors.length)
for (const e of [...new Set(errors)].slice(0, 12)) console.log('  -', e)
