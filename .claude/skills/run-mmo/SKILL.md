---
name: run-mmo
description: >
  Build, launch, and drive Avelune — the Nuxt + three.js multiplayer town.
  Use to run, start, or screenshot the app, or to verify a rendering / gameplay
  change in the real running game, not just tests.
---

# Run Avelune

Avelune is a Nuxt app (Nitro WebSocket backend) whose game view is a TresJS /
three.js **WebGL canvas** — there is no server-rendered page to assert on, so you
drive the live canvas with headless Chromium via **Playwright**. The harness is
[`driver.mjs`](driver.mjs): it creates a character, enters the town, optionally walks
forward for a few seconds, screenshots, and reports console/page errors.

Paths below are relative to the repo root. This was authored on **macOS**, not a
Linux container.

## Prerequisites
- Node ≥ 22 (here `node --version` → `v24.16.0`), pnpm (`pnpm --version` → `11.10.0`).
- **Playwright + its Chromium, installed globally** (it is *not* a project
  dependency) at `/opt/homebrew/lib/node_modules/playwright` (v1.61.1 here). The
  driver `require()`s it by absolute path — override with `MMO_PW`. If it is
  missing, install once: `npm i -g playwright && npx playwright install chromium`.

## Build
```bash
pnpm install
```
No compile step — Nuxt dev builds on demand. Sanity checks: `pnpm lint`, `pnpm typecheck`.

## Run (agent path) — drive the game

**1. Start a server on a known port.** Plain `pnpm dev` **refuses when another
Nuxt dev server for this repo is already running** (it errors "Another Nuxt dev
server is already running"). Force a fresh one on an explicit port:
```bash
NUXT_IGNORE_LOCK=1 nohup pnpm dev --port 4321 > /tmp/mmo-dev.log 2>&1 &
until curl -sf -o /dev/null http://localhost:4321/; do sleep 1; done
```
**The beta Nitro dev worker is flaky under the game's ~180-GLB load burst** — it
can exit silently or crash-loop ("Dev worker failed after 3 retries"), killing
model requests and the WS mid-session. If the dev server keeps dying, verify
against a **prod build** instead — same app, rock-solid static serving:
```bash
pnpm build
NUXT_SESSION_PASSWORD=verify-secret-0123456789abcdef nohup node .output/server/index.mjs > /tmp/mmo-prod.log 2>&1 &   # listens on :3000
```

**2. Drive it.** The game lives at **`/play`** (`/` is the static landing page),
and every mode but `landing` drives that. Nine modes: `arena` (default) enters and shoots the spawn;
`chat` says a short line, then a long one addressed to the Oracle, and shoots
each bubble (`-short` beside `MMO_OUT`, then `MMO_OUT` with the long line and the Oracle's reply);
`walk` also holds `W` for a few seconds first; `meadow` walks out of the south
gate and turns back so the shot shows streamed terrain; `build` walks out, arms
a kit wall from the hotbar and clicks twice so the second piece stacks on the
first; `target` teleports to a fixed meadow tile and shoots the build targeting
in five frames (see below); `map` presses `M` after arrival and shoots the full-screen world map; `gate`
stops on `/play`'s character-creation gate and shoots it at 1280x800 and again at
400x800 (`/tmp/mmo-gate.png` and `/tmp/mmo-gate-400.png`) without entering a
name; `landing` does the same two shots for `/` (`/tmp/mmo-landing.png` and
`/tmp/mmo-landing-400.png`), which loads no game at all:
```bash
MMO_URL=http://localhost:4321 node .claude/skills/run-mmo/driver.mjs walk
MMO_URL=http://localhost:4321 MMO_TIME=day node .claude/skills/run-mmo/driver.mjs build
MMO_URL=http://localhost:4321 node .claude/skills/run-mmo/driver.mjs landing
```
**`target` mode** is the deterministic one, and it needs two things: a server
started with `AVELUNE_DEV_COMMANDS=1` so the dev-only `/tp <x> <y>` chat command
is live, and a **real GPU** — it launches headed by default, because SwiftShader
renders slowly enough to starve the socket and a reconnect respawns the session
in town mid-run. `MMO_HEADED=0` forces it headless anyway; `MMO_HEADED=1` runs
any other mode headed. It
waits for the model queue to drain, fixes the sun, teleports to a known meadow
tile and writes five shots beside `MMO_OUT`: `-ghost` (the shoulder camera with
a kit wall's ghost on open ground), `-stack` (aimed at a placed wall's broad
face: the ghost climbs to the storey above on the same edge), `-run` (aimed at
its end face: the ghost continues the wall along that edge), `-hut` (four panels
ringing one cell, with a doorway), `-feet` (the steep look an armed tool unlocks,
with the brush on the player's own tile) and `-paint` (a run of paving laid by
holding the button and walking). Knobs: `MMO_TP_X`/`MMO_TP_Y`, `MMO_HUT_X`/`MMO_HUT_Y`,
`MMO_PAINT_X`/`MMO_PAINT_Y`, `MMO_PITCH`, `MMO_HUT_PITCH`.

```bash
AVELUNE_DEV_COMMANDS=1 NUXT_SESSION_PASSWORD=verify-secret-0123456789abcdef PORT=4399 node .output/server/index.mjs &
MMO_URL=http://localhost:4399 node .claude/skills/run-mmo/driver.mjs target
```

It prints the HUD label + WebGL status and writes the screenshot to
`/tmp/mmo-<mode>.png`. **Open the screenshot and look at it** — a black frame, or
`SCENE …"w":0`, means it never entered the game (see Gotchas).

Verified output (walk mode):
```
SCENE  {"canvas":true,"w":1280,"h":800,"gl":true,"header":"AVELUNE\n1 in town\n…"}
SHOT   /tmp/mmo-walk.png
ERRORS 2
```

Env knobs: `MMO_URL` (skip port autodetect — recommended), `MMO_OUT` (screenshot
path), `MMO_PW` (Playwright install location), `MMO_TIME` / `MMO_WEATHER` (fix
the sky through the chat commands before shooting), `MMO_STATS` (fps / mesh /
triangle counts), `MMO_HUD=0` (hide every 2D overlay, for a clean scenery still from a player's
camera), and for `meadow` / `build`: `MMO_BACK` (ms walking out of the
gate), `MMO_TURN` (px of yaw for the about-turn, ~507 px per 90°) and
`MMO_PITCH`. Framing out in the meadow is luck of the draw — the player can end
up wedged against a boulder or inside a tree, collapsing the camera boom onto
its own face. Vary `MMO_BACK` / `MMO_TURN` and shoot again.

**`still` mode** shoots the town with nobody in it, and it is how
`public/landing.jpg`, the landing page's backdrop, is reshot. It opens the dev
world editor (`/play?editor=1`, so it needs `pnpm dev`, not a prod build), which
builds the town from the seed with no socket: no player, no nameplate, no
reconnect to race. It waits for the model queue, fixes the sun on the game's own
refs (`MMO_TIME`, default `day`; `MMO_WEATHER`, default `clear`), seats the
editor's fly camera through the dev hook `window.__editor.seat`, hides
everything but the canvas and shoots at `MMO_SIZE` (default `2560x1440`).
`MMO_CAM` is `x,y,z,yaw,pitch` in editor tiles and degrees: the town spans
0..144 on x and z, the gate faces +z at x 72, y is height, yaw 0 looks toward
-z and turns left as it grows, negative pitch looks down.
```bash
MMO_URL=http://localhost:4321 MMO_CAM="114,30,158,40,-24" MMO_OUT=/tmp/still.png node .claude/skills/run-mmo/driver.mjs still
sips -Z 1920 -s format jpeg -s formatOptions 75 /tmp/still.png --out public/landing.jpg
```
Frame it at `MMO_SIZE=1280x720` first, a full-size SwiftShader frame takes
minutes. The landing page darkens the left third, so keep the subject in the
right two thirds.

## Run (human path)
Run the project's dev command (`pnpm dev`, or the `--port`/`NUXT_IGNORE_LOCK=1`
form above if a server is already up), open the printed URL → **Play** → **Create your
character** → type a name → **Enter** → WASD move, mouse look, Space jump, Shift dash. Useless headless — opens a real window and blocks.

## Gotchas
- **Autodetect is nondeterministic, and entry is timing-flaky.** Several ports can
  answer 200 with Avelune HTML at once (here `:3000` and `:3001`) and autodetect takes
  the first — not necessarily your dev server. Entry itself is timing-sensitive: I
  saw one run land on a `0×0` canvas with an empty HUD (WS not yet connected) that
  then succeeded on a plain re-run. So **start your own server and pass `MMO_URL`**,
  and if the driver reports `FAILED` / `w:0`, just run it again. The post-entry
  health check turns a failed entry into a non-zero exit instead of a black shot.
- **Onboarding is mandatory; there is no one-click Play for a fresh browser.** With
  no `avelune_id` cookie the gate shows "Create your character" → a **name field**
  → **Enter the world** (the button stays disabled until the name is non-empty).
  The driver fills the name "Probe" automatically.
- **Headless WebGL needs GPU flags.** Chromium has no GPU in this context; the
  driver launches with `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist` or the canvas is black.
- **Chat bubbles outlive nothing under SwiftShader.** They are DOM elements
  (`.chat-bubble`) that last 4 s, and a headless screenshot takes far longer than
  that. `chat` mode waits for each bubble by its text, pins a static clone of it,
  then shoots, and prints `BUBBLE <label> <text>` (`null` means it never showed).
- **Playwright is global and CJS.** `import { chromium } from 'playwright'` fails
  ("Named export not found") — the driver uses `createRequire` + the absolute path.
- **Movement keys need canvas focus but not pointer lock.** They're global keydown
  listeners; the driver clicks the canvas once, then `keyboard.down('KeyW')`.
- **There are TWO canvases** — the world and the minimap — so `locator('canvas')`
  is a strict-mode violation and every click in the driver uses `.first()`. The
  `.catch(() => {})` around each click swallows that error silently, so a bare
  locator means clicks never land. That went unnoticed while clicks were only
  used for focus; it matters now that a click also applies the armed hotbar tool.
- **A click in the world uses the hotbar tool.** The first click of a real
  session is spent requesting pointer lock *and* firing, so an armed shovel will
  dig the moment the driver clicks to focus. Arm the slot you want (`Digit1`..
  `Digit9`) before clicking, or expect a stray edit.
- **Screenshot only after the model queue drains.** Under SwiftShader the main
  thread starves the network callbacks, so the ~180 GLB requests complete at just
  ~5/s — the world rebuilds with kit models only once its batch resolves, and an
  early shot shows bare procedural geometry (ground and terrain but no houses or
  props). Track `page.on('request'/'requestfinished')` for `/models/` URLs and wait
  until the set is empty and quiet for ~4 s (typ. 7–15 s total) before shooting.
- **Camera yaw headless: dispatch synthetic `mousemove` on the canvas.** The look
  handler reads `event.movementX`, but real `page.mouse.move()` deltas are zero-sum
  across the viewport (you can't turn past ~180° and sweep-backs cancel), and when
  not pointer-locked events are ignored unless the target is inside the world root.
  Reliable: `canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: dx,
  bubbles: true }))` — ~507 px per 90° (`MOUSE_SENSITIVITY` 0.0031 rad/px); split
  large deltas into ~10 events. Same idea with `movementY` for pitch.
- **The headless socket reconnects, and a reconnect respawns you in town.** The
  main thread starves the WebSocket long enough to miss a heartbeat — while the
  ~180 GLB requests drain, and again on every screenshot, which under SwiftShader
  blocks for tens of seconds. That is why `target` runs headed. The server closes the socket and the client opens a
  fresh session at the spawn point, thirty tiles from wherever the run was
  working, and clicks in between are eaten silently. So `target` mode waits for
  the model queue before it starts, reads its teleports back (`tpTo` resends
  `/tp` until the minimap's coordinate bar agrees, and prints `TP FAILED` if it
  never does), and calls `settle` after every screenshot to wait out the
  reconnect banner and put the player back. `placeOnce` clicks until the piece
  counter actually moves rather than trusting one click.
- **Benign console noise (ignore):** a web-font `.woff2` 404, and
  `props.characters is not iterable` from the menu's `CharacterLineup` components
  (pre-existing, unrelated to the game scene). The driver dedupes and prints these.

## Troubleshooting
- **`FAILED: never reached the game view` / `SCENE …"w":0`** — entry didn't
  complete (often a transient WS/timing race). **Re-run it first.** If it persists,
  you targeted the wrong/stale server: start a fresh one
  (`NUXT_IGNORE_LOCK=1 pnpm dev --port <p>`) and pass `MMO_URL=http://localhost:<p>`.
- **`Another Nuxt dev server is already running`** — expected when the repo already
  has a dev server up. Use `NUXT_IGNORE_LOCK=1` + an explicit `--port`, or target
  the existing one via `MMO_URL`.
- **`No Avelune dev server found on :3000-3010`** — nothing is serving; start one as
  above, or set `MMO_URL`.
- **`Cannot find module 'playwright'`** — set `MMO_PW` to your Playwright path, or
  `npm i -g playwright && npx playwright install chromium`.

## Note
Asset conversion (Blender → `public/models/**`) is a separate pipeline — see
[`.claude/agents/assets.md`](../../agents/assets.md), not this skill.
