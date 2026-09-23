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
and every mode but `landing` drives that. Ten modes: `arena` (default) enters and shoots the spawn;
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
the sky through the chat commands before shooting), `MMO_STATS` / `MMO_DUMP` /
`MMO_DPR` / `MMO_GFX` (frame cost, see below), `MMO_HUD=0` (hide every 2D overlay, for a clean scenery still from a player's
camera), and for `meadow` / `build`: `MMO_BACK` (ms walking out of the
gate), `MMO_TURN` (px of yaw for the about-turn, ~507 px per 90°) and
`MMO_PITCH`. Framing out in the meadow is luck of the draw — the player can end
up wedged against a boulder or inside a tree, collapsing the camera boom onto
its own face. Vary `MMO_BACK` / `MMO_TURN` and shoot again.

**`room` mode** checks the build rules end to end, and needs a **dev server**
started with `AVELUNE_DEV_COMMANDS=1` (it builds through `window.__maze.game.sendBuild`,
so every piece carries an exact aim and height instead of a synthetic crosshair).
It teleports to `MMO_ROOM_X + 1, MMO_ROOM_Y` (default `110, 150`), raises a two
cell room with a door, a wall stacked over the door, a floor laid inside, stairs
pushed against the walls and an upper floor hung from the wall tops, then lays a
floor, a path, a crate, a fence, a gate and the two roof pieces on open meadow.
Each piece prints `BUILT` or `REFUSED`, and it writes `-room` (the house from the
front), `-cover` (the meadow pieces, with no grass through them) and `-kit` (the
roofs on the ground, a close look at the rebuilt kit) beside `MMO_OUT`. Headed by default, like `target`.
Restart the server between runs: the store is in memory, and a second run is
refused on every cell the first one filled.
```bash
AVELUNE_DEV_COMMANDS=1 NUXT_IGNORE_LOCK=1 pnpm dev --port 4390 &
MMO_URL=http://localhost:4390 MMO_OUT=/tmp/room.png node .claude/skills/run-mmo/driver.mjs room
```

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

## Measure a frame — [`perf.mjs`](perf.mjs)

`MMO_STATS=1` on any mode prints fps, draw calls and triangles per frame, and one
row per render pass: the WebGL2 draw calls are counted where they are issued and
attributed to the framebuffer bound at the time. `MMO_DUMP=1` adds the scene's
triangles by named group, what casts, and the heaviest meshes (dev server only,
it reads `window.__maze.scene`).

```bash
MMO_URL=http://localhost:4321 MMO_HEADED=1 MMO_STATS=1 MMO_DUMP=1 node .claude/skills/run-mmo/driver.mjs arena
MMO_URL=http://localhost:4321 MMO_HEADED=1 MMO_STATS=1 MMO_DPR=2 MMO_SIZE=1600x1000 \
  MMO_CAM="72,4,153,0,-2" node .claude/skills/run-mmo/driver.mjs still
```

- **Headed, always.** SwiftShader's numbers mean nothing.
- **`still` is the A/B mode.** Its camera goes back exactly where it was, so
  `git stash`, run, `git stash pop`, run is a fair comparison and the two shots
  can be diffed (`ffmpeg -i a.png -i b.png -filter_complex
  "blend=all_mode=difference,eq=contrast=12:brightness=0.12"`). Clouds and the
  fountain's ripple drift between runs; anything else that moves is the change.
  Known cameras: `72,4,153,0,-2` looks in through the gate, `72,5,84,0,-10`
  stands in the plaza.
- **But `still` is the editor's scene, not the game's.** The town is drawn as
  `hubEditor` clones that cast nothing, so anything about the town's own trees or
  buildings in the shadow pass has to be measured in `arena` / `meadow`.
- **Measure at the pixel count people play at.** `MMO_DPR=2` with a
  `MMO_SIZE` near a real window. At dpr 1 a frame here is bound by draw calls
  and triangles; at dpr 2 it was bound by pixels, and a run of draw-call cuts
  that read as +40 fps at dpr 1 showed nothing on a retina display until MSAA
  went. fps is also capped at the display's refresh rate, so near the cap trust
  the call and triangle counts, not the fps.
- **`MMO_GFX`** is the JSON the Escape menu stores under `avelune:graphics`, for
  turning one cost off at a time:
  `'{"scale":1,"detail":"high","shadows":true,"occlusion":false,"bloom":true}'`.
- **Run it twice and throw the first away.** A dev server that has just
  compiled, or just served another run, is still busy: the same camera read 38
  fps and then 72, 75 and 77. The call and triangle counts do not move, which is
  another reason to read those first.
- A rate-limited pass (the fountain's captures) can be missing from the rows,
  which are the last frame's, and still be in the averages.

## Record a take — [`record.mjs`](record.mjs)

The driver takes one screenshot. `record.mjs` records a **continuous take of the
game being played**, for a demo clip. Six beats, about forty seconds: the town
with people in it, a question put to the Oracle that it answers off live state,
a sprint out of the south gate, a bot's house going up in the meadow, the player
raising a wall of their own in open ground and setting a torch beside it, and
the Oracle turning the weather and the hour over the lot. Playwright writes a
`.webm`, and the marks it prints are what the cut is made against.

```bash
AVELUNE_DEV_COMMANDS=1 AVELUNE_REALM=demo NUXT_IGNORE_LOCK=1 pnpm dev --port 4380 &
MMO_URL=http://localhost:4380 MMO_OUT=/tmp/take node .claude/skills/run-mmo/record.mjs
```

**Dev server, not a prod build** — `window.__maze` is behind `import.meta.dev`
and `/tp` needs `AVELUNE_DEV_COMMANDS=1`. **Restart it between takes**: with no
Upstash the store is in-memory, so a restart is what gives the bots empty meadow
to build on. It always launches **headed**, on the real GPU.

It starts its own bots: two builders paced at `MMO_PACE` (default 400 ms/edit,
via `spawn-bots --pace`) and five townsfolk (`--cast --home`) who wear the five
outfits between them. Both swarms are launched **before** the onboarding pass, so
by the time the Oracle is asked who is building, there is an answer. **Two
builders, not more**: each plants a `Kit_Deed` that claims the `DEED_SIZE` square
around it, and four of them leave no unclaimed ground within a sprint of the gate
for the player's own beat.

Env: `MMO_URL`, `MMO_OUT` (directory), `MMO_NAME`, `MMO_TIME`/`MMO_WEATHER` (the
sky the take *opens* on, read back and re-sent until it takes), `MMO_PLOT_X/Y`,
`MMO_BOTS`/`MMO_PACE`, `MMO_FOLK`/`MMO_FOLK_AT`, `MMO_ASK`, `MMO_ASK_SKY`,
`MMO_CLEAN=0`.

Cutting: the marks are milliseconds from `page.goto`, the video runs **~0.9 s
behind them** (it starts at context creation), and `MARK curtain` is the first
frame of the take. Duration minus the `end` mark gives the offset exactly.

```bash
ffmpeg -ss <curtain + offset> -i /tmp/take/page@*.webm -t 30 \
  -vf "fade=t=in:st=0:d=0.4,fade=t=out:st=29.4:d=0.6,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -movflags +faststart -an out.mp4
```

### Gotchas on top of the driver's
- **There is no audio.** Playwright's recorder captures video only, and the
  game's sound is synthesized in the page. A take with sound needs a screen
  recorder, not this.
- **The camera is driven through `window.__maze`, not the keyboard.**
  `view.yaw` + `game.setLook` for an absolute heading, `held` + `game.setInput`
  for movement. Pans, runs and orbits all re-aim **every frame from inside the
  page** — a heading set once from node is only true until something disturbs
  it, and a reconnect writes the server's angle straight back over `view.yaw`
  (MazeScene watches `selfId`). An early take ran the wrong way up the town for
  eighteen seconds on exactly that.
- **The rig is a `page.evaluate`, so a reload takes it with the document.** It
  closes over `window.__maze`, which only exists once the game view is up, so it
  cannot be an init script. `demo()` puts it back when it finds it gone, which
  is always safe: the rig holds no state and every call reads `__maze` fresh.
  Without that, a take dies on its next pan with `Cannot read properties of
  undefined`.
- **Don't record while the app is being edited.** Nuxt's dev server reloads on
  its own schedule and hot-applies module changes underneath a running take.
  Saving in `app/` mid-take cost two of them here: one lost the rig, the next
  came back with `uRimSun : redefinition` on every character material, an 18 s
  run south that takes 6 s on a quiet tree, and `built-0` with every placement
  refused. None of it looks like an editor problem from the log, so check
  `git status` and the file mtimes before blaming the beat.
- **The Oracle drops a question that lands inside its cooldown.** It answers one
  line at a time, four seconds apart, and it greets every bot that walks through
  the gate — so `oracleQuiet()` waits for a gap before each question and `ask()`
  retries. Three seconds is enough, not four: the server defers a line that
  misses by up to `ORACLE_DEFER_GRACE`.
- **A player build needs ground nobody has claimed, and the recorder finds it by
  being refused.** Claim bounds move with the bot count, so it tries, reads the
  refusal, steps six tiles east and tries again. Same for the pitch: a lower
  `view.pitch` aims *higher*, and which value puts the crosshair on the cell
  underfoot is settled by placing, not by arithmetic.
- **Don't build a ring around the camera and expect to see it.** Four panels on
  the edges of the cell you stand on is the cheapest real structure there is,
  one click a quarter turn and no aiming at all, but the boom collapses onto the
  player's face: two of the four frames are the inside of a panel and the take
  shows grass while the feed fills with pieces. The beat aims instead, from a
  spot it never leaves. The crosshair ray takes the first thing it meets and
  builds against the face it entered, which gives three useful aims: open ground
  ahead for a panel, a shallower look onto that panel's broad face for the
  storey above it, and a small swing for the next cell edge along.
- **Every number in that beat is found by being refused, including the pitch.**
  A lower `view.pitch` aims *higher*, and which value reaches open ground rather
  than the player's own boots depends on the terrain under it. Whether this is
  somebody's plot depends on where the bots planted their posts. Both are
  settled the same way, by placing and reading the piece counter, which only
  moves when the server books something.
- **Take the refusal off the screen the moment it is raised, and hide it
  rather than remove it.** The aim search finds its pitch by being told no, and
  every no parks a toast in the corner and a line under the crosshair. They are
  true things the game said, but they are answering the recorder's guesswork
  rather than a player's aim, and one raised during the search sits in frame
  for the rest of the beat. Two approaches failed first. A style rule missed
  them, because `addStyleTag` rejects if it lands mid-navigation and the rule
  only covers whatever roles the component library renders this version. Then
  matching the text and lifting the node out of the document worked on screen,
  and two takes in a row went black for their last twenty seconds, still
  marking every beat and rendering nothing. `placeOnce` now matches the text
  and sets `display: none`, which cannot orphan a ref, a listener or a portal
  root. It keeps clear of the chat log by ignoring anything left of the panel:
  the Oracle talks about plots belonging to people too.
- **No second storey.** Aiming at a placed panel's broad face to stack on it is
  the one aim that will not come good: too shallow and the ray flies over the
  wall, too steep and it resolves to the edge the panel already stands on and
  comes back "in the way". Searching for it cost twenty-four seconds of a
  forty-second take and left a blocked red ghost filling the frame for most of
  them. The run along the ground places first time, every time.
- **Wait on `chatLog`, never on the bubble.** A rig's `.chat-bubble` is one
  element made once and then hidden and reshown, so `data-npc` matches a bubble
  that has never said anything.
- **Type with `insertText`, a word at a time.** `keyboard.type` is a CDP round
  trip per character against a busy main thread — about 180 ms each, five
  seconds to ask a short question.
- **The setup happens behind a black curtain** and the chat log is wiped just
  before it lifts, so `/tp`, `/time` and `/weather` are not in frame. The
  sandbox chip is hidden too: it is true of this local server, not of the game.

## Record the creator — [`creator.mjs`](creator.mjs)

`record.mjs` mints its character in a throwaway context so onboarding never
reaches the take, which is right for a take of the world and leaves no footage
of the creator at all. `creator.mjs` records that screen and nothing else: the
five outfits, the dossier rewriting itself on the right, a colourway dyeing the
cloth on the model already standing there, a drag on the turntable, the gender
swap, Randomize, and the name typed a letter at a time.

```bash
NUXT_IGNORE_LOCK=1 pnpm dev --port 4380 &
MMO_URL=http://localhost:4380 MMO_OUT=/tmp/creator node .claude/skills/run-mmo/creator.mjs
```

It wants a **plain** dev server. No `AVELUNE_DEV_COMMANDS`, no bots, no `/tp`:
nothing here touches the world, so it does not care what is in it and does not
need restarting between runs. It does need a real GPU, so it launches headed
like the other two.

What puts `/play` on the gate rather than in the arena is simply that the
context is fresh. The cookie is the whole of identity, and a context that has
never seen one has never onboarded.

Env: `MMO_URL`, `MMO_OUT` (directory), `MMO_NAME`, `MMO_HOLD` (ms held on each
choice, default 1050), `MMO_PW`. Marks and cutting work exactly as they do for
`record.mjs`.

### Gotchas
- **The options panel is a scroller, and Randomize lives under its fold.** It
  is `max-h-[calc(100dvh-8rem)] overflow-y-auto`, so at 720p the colourways and
  the button sit below it. Two things go wrong there. A click on a control off
  the bottom of a scroller is not a fast failure, it is the full default
  timeout: thirty seconds of a stationary screen in the middle of the take, so
  the wait is capped. And scrolling it into view is still not enough, because a
  real pointer click wants the element's centre inside the viewport and it is
  not. The pointer is the preference, not the requirement: it falls back to
  dispatching the click on the element, which Vue handles the same way. What
  the take needs is the character changing, not a cursor travelling to a button
  that is off screen anyway.
- **The turntable has no spring, so a drag is a round trip.** Wherever the drag
  stops is where the character stays. A one-way turn leaves it facing away for
  every beat after it, which is how the first pass ended on the back of a
  Peasant. Drag out far enough to show the back of the outfit, then most of the
  way home.
- **A radio card's input is hidden, so the label takes the click.**
  `URadioGroup` with `indicator="hidden"` paints the card and leaves the input
  `sr-only`. The accessible radio is still there, which is why the role
  selector is tried first, but `force: true` is what makes it land.
- **The colourways have no text.** Their labels are `sr-only` swatch names, so
  they are reached through the `fieldset` its legend names rather than by text.

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
