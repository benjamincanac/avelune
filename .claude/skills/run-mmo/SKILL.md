---
name: run-mmo
description: >
  Build, launch, and drive Mugen — the Nuxt + three.js multiplayer tower game.
  Use to run, start, or screenshot the app, or to verify a rendering / gameplay
  change in the real running game (the hub or a dungeon floor), not just tests.
---

# Run Mugen

Mugen is a Nuxt app (Nitro WebSocket backend) whose game view is a TresJS /
three.js **WebGL canvas** — there is no server-rendered page to assert on, so you
drive the live canvas with headless Chromium via **Playwright**. The harness is
[`driver.mjs`](driver.mjs): it onboards a runner, enters the hub, optionally walks
onto the portal to reach **Floor 1**, screenshots, and reports console/page errors.

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

**1. Start a dev server on a known port.** Plain `pnpm dev` **refuses when another
Nuxt dev server for this repo is already running** (it errors "Another Nuxt dev
server is already running"). Force a fresh one on an explicit port:
```bash
NUXT_IGNORE_LOCK=1 nohup pnpm dev --port 4321 > /tmp/mmo-dev.log 2>&1 &
until curl -sf -o /dev/null http://localhost:4321/; do sleep 1; done
```

**2. Drive it.** `hub` (default) enters and shoots the hub; `floor` also walks onto
the portal to reach Floor 1 (Stone Dungeon) — the only way to exercise the dungeon
floor/wall/trap dressing (the hub is the only floor that builds until you climb):
```bash
MMO_URL=http://localhost:4321 node .claude/skills/run-mmo/driver.mjs floor
```
It prints the HUD label + WebGL status and writes the screenshot to
`/tmp/mmo-<mode>.png`. **Open the screenshot and look at it** — a black frame, or
`SCENE …"w":0`, means it never entered the game (see Gotchas).

Verified output (floor mode):
```
SCENE  {"canvas":true,"w":1280,"h":800,"gl":true,"header":"MUGEN\n1 in the tower\nFloor 1 — Stone Dungeon\n…"}
SHOT   /tmp/mmo-floor.png
ERRORS 2
```

Env knobs: `MMO_URL` (skip port autodetect — recommended), `MMO_OUT` (screenshot
path), `MMO_PW` (Playwright install location).

## Run (human path)
Run the project's dev command (`pnpm dev`, or the `--port`/`NUXT_IGNORE_LOCK=1`
form above if a server is already up), open the printed URL → **Create your
runner** → type a name → **Enter** → WASD move, mouse look, Space jump, Shift dash;
walk onto the blue portal to climb. Useless headless — opens a real window and blocks.

## Gotchas
- **Autodetect is nondeterministic, and entry is timing-flaky.** Several ports can
  answer 200 with Mugen HTML at once (here `:3000` and `:3001`) and autodetect takes
  the first — not necessarily your dev server. Entry itself is timing-sensitive: I
  saw one run land on a `0×0` canvas with an empty HUD (WS not yet connected) that
  then succeeded on a plain re-run. So **start your own server and pass `MMO_URL`**,
  and if the driver reports `FAILED` / `w:0`, just run it again. The post-entry
  health check turns a failed entry into a non-zero exit instead of a black shot.
- **Onboarding is mandatory; there is no one-click Play for a fresh browser.** With
  no `mugen_id` cookie the menu shows only "Create your runner" → a **name field**
  → **Enter** (the Enter button stays disabled until the name is non-empty). The
  driver fills the name "Probe" automatically.
- **Only the hub builds until you climb.** `MazeScene` builds the floor the player
  is on; dungeon geometry (floor slabs, wall panels, arches, trapdoors, the Sunken
  bridge) only renders once you teleport. Use `floor` mode (hold `KeyW` onto the
  portal) to see it. Reaching floors 2+ needs clearing each floor's exit — not
  automated here.
- **Headless WebGL needs GPU flags.** Chromium has no GPU in this context; the
  driver launches with `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist` or the canvas is black.
- **Headless (SwiftShader) won't show *runtime-updated* `CanvasTexture`s.** Text
  drawn once at rig creation renders fine (nameplates), but anything redrawn on a
  canvas at render time with `texture.needsUpdate = true` — **chat/speech bubbles**
  especially — never appears in a headless shot even though the sprite is visible,
  scaled, and positioned. This is a SwiftShader re-upload limitation, not a bug in
  the scene. To eyeball a bubble/dynamic-texture change, run Playwright **headed**
  (`chromium.launch({ headless: false })`, no GL flags) so the real GPU handles the
  re-upload; drive chat with Enter → type → Enter.
- **Playwright is global and CJS.** `import { chromium } from 'playwright'` fails
  ("Named export not found") — the driver uses `createRequire` + the absolute path.
- **Movement keys need canvas focus but not pointer lock.** They're global keydown
  listeners; the driver clicks the canvas once, then `keyboard.down('KeyW')`.
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
- **`No Mugen dev server found on :3000-3010`** — nothing is serving; start one as
  above, or set `MMO_URL`.
- **`Cannot find module 'playwright'`** — set `MMO_PW` to your Playwright path, or
  `npm i -g playwright && npx playwright install chromium`.

## Note
Asset conversion (Blender → `public/models/**`) is a separate pipeline — see
[`.claude/agents/assets.md`](../../agents/assets.md), not this skill.
