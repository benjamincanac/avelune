// Avelune demo recorder: drive a headed Chromium session on the real GPU,
// record it to video, and print a mark for every beat so the take can be cut
// to length afterwards.
//
// This is the moving-picture sibling of `driver.mjs`. The driver exists to take
// one screenshot and report errors; this exists to produce a continuous take of
// the game being played, with the camera under absolute control rather than
// nudged by synthetic mouse deltas.
//
// It needs a **dev server** (`pnpm dev`), not a prod build, for two reasons:
// `window.__maze` is behind `import.meta.dev`, and `/tp` needs
// `AVELUNE_DEV_COMMANDS=1`. And it needs a real GPU, so it always launches
// headed — SwiftShader renders slowly enough to starve the socket, and a
// reconnect respawns the session in town mid-take.
//
// The builders are started by this script, not alongside it, because the take
// and the build share one clock — see the bot block below.
//
// Usage:
//   AVELUNE_DEV_COMMANDS=1 pnpm dev --port 4380
//   MMO_URL=http://localhost:4380 node .claude/skills/run-mmo/record.mjs
//
// Env:
//   MMO_URL      base url of the dev server                  (required in practice)
//   MMO_OUT      webm output directory                       (default /tmp/avelune-take)
//   MMO_NAME     character name shown on the nameplate       (default Rook)
//   MMO_TIME     /time argument                              (default day)
//   MMO_WEATHER  /weather argument                           (default clear)
//   MMO_PLOT_X/Y the bot plot the camera runs to             (default 70 150)
//   MMO_BOTS     how many building bots to spawn             (default 2, 0 for none)
//   MMO_BUILD_AT where the player raises their own hut        (default 84,148)
//   MMO_PACE     ms between a bot's edits                    (default 400)
//   MMO_ASK      the line addressed to the Oracle
//   MMO_ASK_SKY  the closing line, which turns the sky
//   MMO_CLEAN    "0": leave the dev chatter and the sandbox chip in frame
//   MMO_PW       path to a Playwright install
//
// The take is framed behind a black curtain: everything the recorder does to
// get set up (onboarding, model streaming, fixing the sun, teleporting to the
// mark) happens under an opaque overlay, which lifts on the first beat. So the
// webm opens on black and the cut point is the moment it clears, which is also
// what `MARK curtain` reports.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const PW = process.env.MMO_PW || '/opt/homebrew/lib/node_modules/playwright'
const { chromium } = require(PW)

const URL_BASE = (process.env.MMO_URL || 'http://localhost:3000').replace(/\/$/, '')
const OUT_DIR = process.env.MMO_OUT || '/tmp/avelune-take'
const NAME = process.env.MMO_NAME || 'Rook'
const TIME = process.env.MMO_TIME || 'day'
const WEATHER = process.env.MMO_WEATHER || 'clear'
const PLOT = { x: Number(process.env.MMO_PLOT_X || 70), y: Number(process.env.MMO_PLOT_Y || 150) }
/** The cell the player rings with their own walls. Even tiles, because an
 *  EDGE piece snaps to the nearest `BUILD_GRID` cell edge and a cell centre is
 *  an even tile — and east of x 77, which is where the second bot's claim
 *  stops. */
const BUILD_AT = (() => {
  const [x, y] = (process.env.MMO_BUILD_AT || '84,148').split(',').map(Number)
  return { x, y }
})()
const ASK = process.env.MMO_ASK || 'Oracle, who is building past the gate?'
// The second ask turns the sky. The Oracle's classifier reads weather and hour
// off one line, so a single sentence can do both, and the ease from clear noon
// to a wet dusk is the closing shot.
const ASK_SKY = process.env.MMO_ASK_SKY || 'Oracle, bring a storm and let it be dusk'
const SIZE = { width: 1280, height: 720 }

/** Headings, in `stepBody`'s frame: dx = cos(a), dy = sin(a). +y is south, so
 *  the gate road runs from -PI/2 (into town) to +PI/2 (out of it). */
const NORTH = -Math.PI / 2
const SOUTH = Math.PI / 2
const EAST = 0
const WEST = Math.PI

mkdirSync(OUT_DIR, { recursive: true })

const errors = []
const marks = []
let t0 = 0
const mark = (label) => {
  const at = Date.now() - t0
  marks.push({ label, at })
  console.log(`MARK  ${String(at / 1000).padStart(6)}s  ${label}`)
}

/* --- the builders ---------------------------------------------------------- */
// The bots are started by this script, and started first, because the take and
// the build share one clock. A house at the default pace goes up in about ten
// seconds — over long before a camera has walked out to it — so they are paced
// at `MMO_PACE` instead. And they are launched ahead of the onboarding pass so
// that by the time the Oracle is asked who is building, there is an answer: a
// bot needs its trek out and its levelling done before it places anything, and
// an Oracle that says the meadow lies untouched over footage of a house going
// up is worse than no Oracle at all. `MMO_BOTS=0` skips them.
const ROOT = new globalThis.URL('../../..', import.meta.url).pathname
const { spawn } = await import('node:child_process')
const swarms = []
/** Each swarm runs in its own process group: the bots are three processes deep
 *  (`pnpm` → `pnpm.mjs` → `jiti`) and `pnpm` does not pass a signal down, so
 *  signalling the child alone leaves jiti holding open sockets and this
 *  recorder hangs on an event loop that never drains. */
const swarm = (tag, args) => {
  const child = spawn('pnpm', ['exec', 'jiti', 'scripts/spawn-bots.mjs', '--url', URL_BASE, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.on('data', d => process.stdout.write(`  ${tag}| ` + d))
  child.stderr.on('data', d => process.stderr.write(`  ${tag}| ` + d))
  swarms.push(child)
  console.log('BOTS  ', tag, args.join(' '))
}

// Two builders, not more. A `Kit_Deed` claims the `DEED_SIZE` square around
// itself and bot `i` plants one at `(52 + i * 18 - 2, 148)`, so four of them
// leave no unclaimed ground within a sprint of the gate for the player to
// build on — and a refusal that names somebody else's plot is not the beat we
// are filming. Two claims reach x 77, which is what `MMO_BUILD_AT` sits east
// of.
const botCount = Number(process.env.MMO_BOTS ?? 2)
if (botCount > 0) swarm('build', ['--count', String(botCount), '--build', '--pace', String(Number(process.env.MMO_PACE || 400))])

// The townsfolk. `--cast` deals the five outfits and both genders round them
// in order rather than rolling each one, which is the only way five bots show
// five classes; `--home` walks them to the stretch of road the opening beat
// looks down, so the first shot has a crowd in it and the crowd is not all
// wearing the same tunic. Their home is up by the Oracle rather than on the
// camera's own mark: a wanderer that shares the player's tile walks through
// the boom and fills a third of the frame with a knee.
const folkCount = Number(process.env.MMO_FOLK ?? 5)
if (folkCount > 0) swarm('folk', ['--count', String(folkCount), '--cast', '--home', `${process.env.MMO_FOLK_AT || '72,106'}`, '--radius', '6'])

const browser = await chromium.launch({ headless: false })

/* --- pass 1: mint the character, so the take itself opens in the world ----- */
// Onboarding is mandatory and there is no way to skip it, but it does not
// belong in the video. Do it in a throwaway context and carry the signed
// `avelune_id` cookie over: the recorded context then loads straight into the
// arena. Closing this context also closes its socket, which matters — one live
// session per identity, so an open first tab would kick the second.
const warm = await browser.newContext({ viewport: SIZE })
const wp = await warm.newPage()
await wp.goto(`${URL_BASE}/play`, { waitUntil: 'networkidle', timeout: 60000 })
const nameField = wp.getByPlaceholder(/name your character/i)
await nameField.first().waitFor({ timeout: 30000 }).catch(() => {})
if (await nameField.count()) {
  await nameField.first().fill(NAME)
  await wp.waitForTimeout(300)
  await wp.getByRole('button', { name: /^enter( the world)?$/i }).first().click().catch(() => {})
}
await wp.waitForTimeout(6000)
const state = await warm.storageState()
await warm.close()
console.log('WARM   character ready')

/* --- pass 2: the recorded take -------------------------------------------- */
const ctx = await browser.newContext({
  viewport: SIZE,
  storageState: state,
  recordVideo: { dir: OUT_DIR, size: SIZE },
})
const page = await ctx.newPage()
page.on('console', m => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

// Model traffic, so the take can wait for the ~180 GLB requests rather than
// open on a town with no houses in it.
const pending = new Set()
let lastModelAt = Date.now()
page.on('request', (r) => {
  if (r.url().includes('/models/')) { pending.add(r.url()); lastModelAt = Date.now() }
})
for (const done of ['requestfinished', 'requestfailed']) {
  page.on(done, r => pending.delete(r.url()) && (lastModelAt = Date.now()))
}
const modelsQuiet = async (quietMs = 4000, limit = 120000) => {
  const until = Date.now() + limit
  while (Date.now() < until) {
    if (!pending.size && Date.now() - lastModelAt > quietMs) return true
    await page.waitForTimeout(500)
  }
  return false
}

// The curtain goes up before anything renders, so no frame of the setup is in
// the take. It is a style tag rather than an element so it survives the app's
// own DOM churn during entry.
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

// Entry: the socket, the town, then the streamed models.
let live = false
for (let i = 0; i < 40 && !live; i++) {
  live = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return !!c && c.width > 0 && !!window.__maze
  }).catch(() => false)
  if (!live) await page.waitForTimeout(1000)
}
if (!live) {
  console.error(`FAILED: never reached the game view at ${URL_BASE}. Is this a dev server (window.__maze is dev-only)?`)
  await ctx.close()
  await browser.close()
  process.exit(1)
}
console.log('MODELS', await modelsQuiet() ? 'quiet' : 'still loading')

/* --- the camera rig -------------------------------------------------------- */
// Everything below drives the game through its own dev hook rather than
// through the keyboard: `__maze.view` is the mouse-look state, `__maze.held`
// is the MoveInput the input layer writes, and `game.setLook` / `game.setInput`
// are the two calls that push either one at the server. That buys absolute
// headings (a synthetic `movementX` only ever gives a relative nudge) and a
// yaw that can be eased over a fixed duration, which is what a pan is.
const installRig = () => page.evaluate(() => {
  const m = window.__maze
  window.__demo = {
    pos: () => ({ x: m.local.x, y: m.local.y }),
    yaw: () => m.view.yaw,
    look(yaw, pitch) {
      m.view.yaw = yaw
      if (pitch != null) m.view.pitch = pitch
      m.game.setLook(yaw)
    },
    input(patch) {
      Object.assign(m.held, patch)
      m.game.setInput(m.held)
    },
    stop() {
      Object.assign(m.held, { forward: false, back: false, left: false, right: false, sprint: false })
      m.game.setInput(m.held)
    },
    say: text => m.game.sendChat(text),
    /** Run at (tx, ty), re-aiming every frame until it is within `within`
     *  tiles or `ms` is up. Homing rather than "face south and hold W",
     *  because a heading set once is only true until something disturbs it —
     *  a reconnect writes the server's angle straight back over `view.yaw`
     *  (MazeScene watches `selfId`), and a shoulder clipped on a gatepost
     *  walks the rest of the run off at an angle. Re-aiming every frame
     *  absorbs both, and keeps the turn off the poll rate. */
    driveTo(tx, ty, ms, sprint, within) {
      Object.assign(m.held, { forward: true, sprint: !!sprint })
      m.game.setInput(m.held)
      const start = performance.now()
      return new Promise((resolve) => {
        const tick = (now) => {
          m.view.yaw = Math.atan2(ty - m.local.y, tx - m.local.x)
          m.game.setLook(m.view.yaw)
          const near = Math.hypot(m.local.x - tx, m.local.y - ty) <= within
          if (!near && now - start < ms) return requestAnimationFrame(tick)
          Object.assign(m.held, { forward: false, sprint: false })
          m.game.setInput(m.held)
          resolve(near)
        }
        requestAnimationFrame(tick)
      })
    },
    /** Ease the heading to `to` over `ms`, on the frame clock, taking the short
     *  way round so a pan never unwinds the long side of the circle. */
    pan(to, ms, pitch) {
      const from = m.view.yaw
      const fromPitch = m.view.pitch
      let d = (to - from) % (Math.PI * 2)
      if (d > Math.PI) d -= Math.PI * 2
      if (d < -Math.PI) d += Math.PI * 2
      const dp = pitch == null ? 0 : pitch - fromPitch
      const start = performance.now()
      return new Promise((resolve) => {
        const tick = (now) => {
          const k = Math.min(1, (now - start) / ms)
          // Cosine ease: a pan that starts and stops hard reads as a glitch.
          const e = 0.5 - Math.cos(k * Math.PI) / 2
          m.view.yaw = from + d * e
          if (pitch != null) m.view.pitch = fromPitch + dp * e
          m.game.setLook(m.view.yaw)
          if (k < 1) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
    },
  }
})
await installRig()
/**
 * Run `fn` in the page against the rig, putting the rig back if it has gone.
 *
 * The rig is a `page.evaluate` rather than an init script because it closes
 * over `window.__maze`, which only exists once the game view is up — so a
 * reload takes it with the document. Nuxt's dev server reloads on its own
 * schedule (a dependency re-optimisation during setup is enough), and a take
 * that loses the rig dies on its next pan with `Cannot read properties of
 * undefined`. Reinstalling costs nothing and is always correct: the rig holds
 * no state, every call reads `__maze` fresh.
 */
const demo = async (fn, arg) => {
  try {
    return await page.evaluate(fn, arg)
  } catch (err) {
    if (!/__demo|Cannot read properties of undefined/.test(String(err))) throw err
    await installRig()
    return page.evaluate(fn, arg)
  }
}
const pos = () => demo(() => window.__demo.pos())
const look = (yaw, pitch) => demo(([y, p]) => window.__demo.look(y, p), [yaw, pitch ?? null])
const pan = (yaw, ms, pitch) => demo(([y, t, p]) => window.__demo.pan(y, t, p), [yaw, ms, pitch ?? null])
const input = patch => demo(p => window.__demo.input(p), patch)
const stop = () => demo(() => window.__demo.stop())

/**
 * Open the chat line, put `text` in it and send it.
 *
 * A word at a time through `insertText`, not `keyboard.type`. Per-key typing
 * is one CDP round trip per character against a main thread that is rendering
 * the game, which measured about 180 ms a character here — five seconds to ask
 * a short question, a sixth of the whole take spent watching letters appear.
 * A word every 70 ms still reads as someone typing and costs a fraction of it.
 */
const line = () => page.getByPlaceholder(/say something/i).first()
const type = async (text) => {
  // Enter focuses the chat input, but not instantly, and `insertText` goes to
  // whatever holds focus at the time — so a line typed too early goes nowhere
  // and the closing Enter sends an empty one. Wait for the input to actually
  // have focus, and read the value back before sending.
  await page.keyboard.press('Enter')
  // Focus is a tag check, not a placeholder check: the chat line is the only
  // text field on the page, and reading `placeholder` off `activeElement`
  // misses it often enough that the first question of a take spent five
  // seconds timing out and then clicking anyway. Short fuse, then the click.
  await page.waitForFunction(
    () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName),
    null,
    { timeout: 1200, polling: 60 },
  ).catch(async () => {
    await line().click().catch(() => {})
    await page.waitForTimeout(200)
  })
  await page.waitForTimeout(200)
  const words = text.split(' ')
  for (const [i, word] of words.entries()) {
    await page.keyboard.insertText(i === words.length - 1 ? word : word + ' ')
    await page.waitForTimeout(70)
  }
  if ((await line().inputValue().catch(() => '')) !== text) await line().fill(text).catch(() => {})
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
}
/** A command we do not want on camera: sent straight down the socket. */
const cmd = async (text) => {
  await demo(t => window.__demo.say(t), text)
  await page.waitForTimeout(900)
}
/**
 * Type a line at the Oracle and wait for it to answer.
 *
 * The wait is on the chat log rather than on the bubble over the Oracle's head.
 * A rig's bubble is one element made once and then hidden and reshown
 * (`makeBubble` in MazeScene), so `data-npc` matches a bubble that has not said
 * anything yet — and by the closing beat the Oracle is forty tiles behind us,
 * near enough `BUBBLE_MAX_DISTANCE` that whether it draws at all is a matter of
 * where we stopped. `chatLog` carries every reply wherever it was spoken, and
 * `npc` marks the Oracle's own.
 */
const npcLines = () => page.evaluate(() => window.__maze.game.chatLog.value.filter(m => m.npc).length).catch(() => 0)

/** Wait until the Oracle has held its tongue for `ms`. It answers one line at a
 *  time behind a four-second cooldown (`ORACLE_COOLDOWN`), and a greeting fired
 *  at a bot walking in spends that window — a question asked inside it is
 *  dropped, not queued. Three seconds rather than four, because the server
 *  defers a line that misses by up to `ORACLE_DEFER_GRACE`: past that mark it
 *  is answered either way, and the take has no second to spare standing
 *  still. */
const oracleQuiet = async (ms = 3100, limit = 12000) => {
  const until = Date.now() + limit
  while (Date.now() < until) {
    // Off the last NPC line's own timestamp, not off how long we have been
    // watching: an Oracle that last spoke a minute ago is quiet now, and this
    // runs immediately before every question.
    const gap = await page.evaluate(() => {
      const last = window.__maze.game.chatLog.value.filter(m => m.npc).at(-1)
      return last ? Date.now() - last.at : 1e9
    }).catch(() => 0)
    if (gap > ms) return true
    await page.waitForTimeout(250)
  }
  return false
}

const ask = async (line, label, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    await oracleQuiet()
    const before = await npcLines()
    await type(line)
    if (i === 0) await beat(`${label}-asked`)
    const replied = await page.waitForFunction(
      n => window.__maze.game.chatLog.value.filter(m => m.npc).length > n,
      before,
      { timeout: 6000, polling: 150 },
    ).then(() => true).catch(() => false)
    if (replied) {
      await beat(`${label}-replied`)
      return true
    }
  }
  await beat(`${label}-silent`)
  return false
}

const runTo = (x, y, ms, within = 2.5) => demo(
  ([tx, ty, t, w]) => window.__demo.driveTo(tx, ty, t, true, w),
  [x, y, ms, within],
)

/* --- the hotbar ------------------------------------------------------------ */
// Ported from `driver.mjs`: the bar is read back rather than counted on. Tab is
// a three-way cycle, so pressing it a fixed number of times is a no-op as often
// as not — and nothing resets the page between beats.
let armedSlot = null
const unarm = async () => {
  if (armedSlot == null) return
  await page.keyboard.press(`Digit${armedSlot}`)
  armedSlot = null
  await page.waitForTimeout(150)
}
const arm = async (pageIndex, slot) => {
  await unarm()
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(() => Number(document.body.innerText.match(/(\d)\/3\b/)?.[1] ?? 0)).catch(() => 0)
    if (at === pageIndex + 1) break
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
  }
  await page.keyboard.press(`Digit${slot}`)
  armedSlot = slot
  await page.waitForTimeout(300)
}
/** The bar's own counter, which is the server's count of our pieces. */
const pieces = () => page.evaluate(() => Number(document.body.innerText.match(/(\d+)\/500 pieces/i)?.[1] ?? -1)).catch(() => -1)
/** Click until the server actually books a piece. A click that only re-takes
 *  pointer lock places nothing, and which click that is depends on what the
 *  chat line did with focus a moment earlier. */
/**
 * Take the refusals off the screen.
 *
 * The aim search finds its pitch by being told no, and a no shows up twice: a
 * toast in the bottom-right corner and a line under the crosshair. They are
 * true things the game said, but they are answering this recorder's guesswork
 * rather than a player's aim, and a toast raised during the search sits in
 * frame for the rest of the beat.
 *
 * Hiding them by selector turned out to be the wrong tool. `addStyleTag`
 * rejects if it lands mid-navigation and the rule only covers whatever roles
 * the component library happens to render this version, which is how a take
 * came back with two of them stacked in the corner. Matching the text is
 * selector-free, so it cannot go stale.
 *
 * It hides rather than removes. An earlier pass lifted the node out of the
 * document and two takes in a row went black for their last twenty seconds,
 * still marking beats but rendering nothing. That was never traced to a
 * specific node, which is the point: `display: none` cannot orphan a ref, a
 * listener or a portal root, and it takes the toast off the screen just the
 * same.
 *
 * The one thing it must not eat is chat. The Oracle talks about the meadow
 * being busy and a plot belonging to somebody, so matches are kept only when
 * they sit right of the chat panel: the toast is bottom-right and the hint is
 * centred over the hotbar, while the log is hard against the left edge.
 */
const REFUSALS = /is in the way|belongs to|is protected|already claimed|out of reach|too steep/i
const sweepRefusals = () => page.evaluate(([source, chatEdge]) => {
  const re = new RegExp(source, 'i')
  let gone = 0
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue
    if (!re.test((el.textContent || '').trim())) continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.left < chatEdge) continue
    const root = el.closest('li') || el.closest('[role="status"], [role="alert"]') || el
    root.style.setProperty('display', 'none', 'important')
    gone++
  }
  return gone
}, [REFUSALS.source, 480]).catch(() => 0)

const placeOnce = async (tries = 6) => {
  const before = await pieces()
  for (let i = 0; i < tries; i++) {
    await page.mouse.click(640, 360).catch(() => {})
    await page.waitForTimeout(320)
    if (await pieces() > before) {
      // A refusal from an earlier try in this same call would otherwise outlive
      // the success it led to.
      await sweepRefusals()
      return true
    }
  }
  await sweepRefusals()
  const hud = String(await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\n+/g, ' | ').slice(-300)
  console.error('PLACE FAILED  ' + hud)
  return false
}
/** Pointer lock is lost the moment the chat line opens, and the page reads an
 *  unexpected unlock as "the player pressed Escape" and puts the menu up. After
 *  a beat that clicked, close it before typing anything. */
const dismissMenu = async () => {
  await page.evaluate(() => document.exitPointerLock?.()).catch(() => {})
  await page.waitForTimeout(500)
  const back = page.getByRole('button', { name: /return to game|resume/i })
  if (await back.count()) await back.first().click().catch(() => {})
  await page.waitForTimeout(300)
}

/** Position, heading and sky, appended to a mark so a take that went wrong says
 *  where it went wrong rather than needing to be watched frame by frame. */
const report = async (label) => {
  const s = await page.evaluate(() => {
    const m = window.__maze
    return `${m.local.x.toFixed(0)},${m.local.y.toFixed(0)} yaw ${m.view.yaw.toFixed(2)} ${m.game.timeOfDay.value}/${m.game.weather.value}`
  }).catch(() => '?')
  console.log(`      ${label.padEnd(16)} ${s}`)
}

/** One beat of the take: the timestamp the cut is made against, plus where the
 *  camera actually was when it happened. */
const beat = async (label) => {
  mark(label)
  await report(label)
}

/* --- setup, still behind the curtain --------------------------------------- */
// The sky is read back rather than assumed. `/time` and `/weather` are chat
// lines like any other, so they queue behind whatever else the socket is doing
// during entry, and a take that opens on the wrong hour cannot be fixed
// afterwards — the whole point of the closing beat is the change from this.
const sky = () => page.evaluate(() => {
  const g = window.__maze.game
  return { time: g.timeOfDay.value, weather: g.weather.value }
}).catch(() => ({}))
for (let i = 0; i < 6; i++) {
  const now = await sky()
  if (now.time === TIME && now.weather === WEATHER) break
  if (now.time !== TIME) await cmd(`/time ${TIME}`)
  if (now.weather !== WEATHER) await cmd(`/weather ${WEATHER}`)
}
console.log('SKY   ', JSON.stringify(await sky()))

// The mark: on the gate road, far enough south of where the Oracle stands
// (71.9, 105.0) that it reads over the player's shoulder rather than through
// their head. Five tiles of walk-in still leaves four between them.
const START = { x: 72, y: 116 }
for (let i = 0; i < 6; i++) {
  await cmd(`/tp ${START.x} ${START.y}`)
  await page.waitForTimeout(1200)
  const at = await pos()
  if (at && Math.hypot(at.x - START.x, at.y - START.y) < 3) break
}
// Open off the axis of the road, so the first move of the take is a sweep
// across the townsfolk rather than a static look straight up it.
await look(NORTH - 0.55, 0.02)
// Focus the world without arming anything: a click is what the page wants
// before it will take a keystroke, and nothing is armed so it cannot edit.
await page.mouse.click(640, 360).catch(() => {})
await page.waitForTimeout(2500)
// Take the Oracle's greeting behind the curtain. It greets anyone crossing the
// gate line, us included, and it answers one line at a time behind a
// four-second cooldown — but the greeting is queued against every bot's
// arrival too (`GREET_RETRY`), so ours can land twenty seconds after we walked
// in. Whenever that is, waiting for it here and then for the cooldown to lapse
// is what keeps the take's first question from being dropped on the floor, and
// costs the take nothing.
await page.waitForFunction(
  () => window.__maze.game.chatLog.value.some(m => m.npc),
  null,
  { timeout: 30000, polling: 300 },
).catch(() => {})
await oracleQuiet()

// Wipe the setup out of the chat panel. `/tp`, `/time` and `/weather` are
// dev-only plumbing and their replies would otherwise sit in frame for the
// whole take. `MMO_CLEAN=0` leaves them, and leaves the sandbox chip up: it is
// honest about an in-memory store, but it is a fact about this local server
// rather than about the game, so it has no business in a take of the game.
if (process.env.MMO_CLEAN !== '0') {
  await page.evaluate(() => {
    window.__maze.game.chatLog.value = []
    for (const el of document.querySelectorAll('p')) {
      if (/resets on restart/i.test(el.textContent || '')) el.style.display = 'none'
    }
  })
  await page.waitForTimeout(400)
}

/* --- the take -------------------------------------------------------------- */
await page.evaluate(() => {
  const el = document.getElementById('demo-curtain')
  if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 600) }
})
await beat('curtain')
await page.waitForTimeout(900)

// Wait out the Oracle's cooldown under the opening move rather than after it.
// A bot walking in through the gate gets greeted, and a greeting holds the
// Oracle for `ORACLE_COOLDOWN` — but the sweep and the walk-in take about as
// long as that, so spending them at the same time costs the take nothing.
const quiet = oracleQuiet()

// Beat 1 — the town. Sweep off the side of the avenue onto the road the
// townsfolk are milling on, so the opening shot is people before it is
// architecture: the five of them wear the five outfits between them.
await pan(NORTH, 1700, 0.02)
await beat('townsfolk')
await page.waitForTimeout(400)

// Beat 2 — the Oracle, up the road. Walk the last few tiles in rather than
// standing still, then ask, and hold on the answer.
await input({ forward: true })
await page.waitForTimeout(1600)
await stop()
await beat('oracle-approach')
await quiet
await ask(ASK, 'oracle')
await page.waitForTimeout(1500)

// Beat 3 — turn and run the gate road south, out of town and into the meadow.
await pan(SOUTH, 1100, 0.04)
await beat('turn')
// Pull up well short of the house's near wall. The room covers [plot-1,
// plot+3] on both axes and stands two storeys plus a roof, so eight tiles off
// the near edge — plus whatever the camera boom adds behind — is what it takes
// to keep the ridge inside the frame.
await runTo(PLOT.x + 1, PLOT.y - 8, 18000, 1.5)
await beat('gate-cleared')

// Beat 4 — pull up short of the plot and pan onto the house going up.
await stop()
await page.waitForTimeout(500)
const at = await pos()
const centre = { x: PLOT.x + 1, y: PLOT.y + 1 }
await pan(Math.atan2(centre.y - (at?.y ?? 0), centre.x - (at?.x ?? 0)), 1200, -0.05)
await beat('framed')
await page.waitForTimeout(400)
// Beat 5 — build one, framed. Run east onto ground nobody has claimed, then
// raise a two-storey facade with a doorway in it, standing back the whole time
// so the camera watches every piece land.
//
// The obvious way to ring a cell is to stand on its centre and turn a quarter
// between clicks: an EDGE piece snaps to the nearest cell edge and takes its
// heading, so four clicks close a room with no aiming at all. That is four
// pieces the piece counter reports and the camera never sees — a body inside a
// ring of walls collapses the boom onto its own face, and two of the four
// frames are the inside of a panel. So this aims instead. The crosshair ray
// takes the first thing it meets and builds against the face it entered, which
// gives three useful aims from one spot:
//
//   base            open ground a cell or two ahead  → a panel on that edge
//   base - STOREY   the panel's broad face           → the storey above it
//   base, yaw ± RUN the next cell edge along         → the panel beside it
//
// None of those three numbers is knowable from here: how steep a look reaches
// open ground depends on the terrain under it, and whether this ground is
// somebody's plot depends on where the bots planted their posts. Both are
// resolved the same way, by trying and reading the server's own answer — the
// piece counter only moves when a placement is booked.
// `placeOnce` sweeps a refusal off the screen the moment it raises one, so
// nothing below has to remember to.
await runTo(BUILD_AT.x, BUILD_AT.y, 9000, 0.9)
await arm(1, 1)

/** How far to swing to reach the next cell edge along the same line. Small
 *  enough that three of them still read as one wall rather than as an arc. */
const RUN = 0.44
// A lower `view.pitch` aims higher, so the shallow looks are the small ones.
// These are shallow on purpose: the steep ones put the piece under the
// player's own feet, which is the framing this beat exists to avoid.
const PITCHES = [0.46, 0.36, 0.56, 0.28]

const spot = { ...BUILD_AT }
const heading = SOUTH
let base = PITCHES[0]
let raised = 0
for (let attempt = 0; attempt < 4 && !raised; attempt++) {
  for (const pitch of PITCHES) {
    await look(heading, pitch)
    await page.waitForTimeout(260)
    if (await placeOnce(2)) { raised = 1; base = pitch; break }
  }
  if (raised) break
  // Not our ground, or nothing the ray could build against. Step east and ask
  // again rather than working the claim bounds out from here: a claim is the
  // `DEED_SIZE` square around a post, the posts move with the bot count, and a
  // refusal is the server's own answer.
  spot.x += 6
  await runTo(spot.x, spot.y, 5000, 0.9)
}
await beat(`build-first-${raised}`)

/** Aim, hold long enough for the ghost to be read as a ghost, and place. */
const raise = async (yaw, pitch) => {
  await pan(yaw, 340, pitch)
  await page.waitForTimeout(240)
  if (await placeOnce(3)) { raised++; return true }
  return false
}
if (raised) {
  // Along the edge line, twice, so the wall runs across the frame.
  await raise(heading + RUN, base)
  await raise(heading + RUN * 2, base)
  // And a doorway on the near end, which is the piece that makes the rest read
  // as a building rather than as a fence.
  await arm(1, 3)
  await raise(heading - RUN, base)
}
//
// No second storey. Aiming at a placed panel's broad face to stack on it is
// the one aim that would not come good: too shallow and the ray flies over the
// wall, too steep and it resolves to the edge the panel already stands on and
// comes back "in the way". Searching for it cost twenty-four seconds of a
// forty-second take and left a blocked red ghost filling the frame for most of
// them, which is worse footage than the wall it was trying to improve. The run
// along the ground places first time, every time, so the beat is a run.
await beat(`built-${raised}`)
await unarm()
await sweepRefusals()

// Stand off and look back at the whole of it. The mark is taken from where the
// player actually ended up rather than from `BUILD_AT`: the aim search may have
// walked east a claim or two, and a stand-off measured from the wrong spot
// frames the meadow beside the wall instead of the wall.
const built = await pos() ?? spot
const face = { x: built.x + Math.cos(heading) * 2.5, y: built.y + Math.sin(heading) * 2.5 }
const backOff = { x: face.x - Math.cos(heading) * 11 + 2, y: face.y - Math.sin(heading) * 11 + 2 }
await look(heading + Math.PI, 0.05)
await runTo(backOff.x, backOff.y, 7000, 1.2)
const from = await pos() ?? backOff
await pan(Math.atan2(face.y - from.y, face.x - from.x), 900, 0.10)
await beat('stood-back')

// And one piece placed where the camera can see it land, lit for the dusk that
// follows. The stand-off pitch framed the wall, which is not necessarily a
// pitch that can take a torch, so this gets the same treatment as the wall: try
// a few and let the piece counter say which one worked.
await arm(2, 1)
await page.waitForTimeout(300)
let torch = false
for (const pitch of [0.1, 0.28, 0.45, 0.02]) {
  await look(await demo(() => window.__demo.yaw()), pitch)
  await page.waitForTimeout(220)
  if (await placeOnce(2)) { torch = true; break }
}
await beat(torch ? 'torch' : 'torch-refused')
await unarm()
await page.waitForTimeout(700)

// Beat 6 — the sky. The same NPC that just read the build log turns the
// weather and the hour off one sentence, and the ease from clear noon to a wet
// dusk plays out over a hut that was not there a minute ago. The hold is long
// because the sun swings to its new angle rather than cutting to it.
//
// Let go of pointer lock first: placing pieces took it, the chat line drops it
// again the moment it opens, and the page reads an unexpected drop as Escape
// and puts the menu up over the shot.
await dismissMenu()
await ask(ASK_SKY, 'sky')
await page.waitForTimeout(3800)

await beat('end')
// The webm is only flushed when the context closes, and the handle has to be
// taken before the page goes with it.
const handle = page.video()
await ctx.close()
const video = await handle?.path().catch(() => null)
await browser.close()
for (const child of swarms) {
  if (!child.pid) continue
  try { process.kill(-child.pid, 'SIGINT') }
  catch { /* already gone */ }
  child.unref()
}

console.log('VIDEO ', video || `(look in ${OUT_DIR})`)
console.log('MARKS ', JSON.stringify(marks))
console.log('ERRORS', errors.length)
for (const e of [...new Set(errors)].slice(0, 12)) console.log('  -', e)
