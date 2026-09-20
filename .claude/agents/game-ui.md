---
name: game-ui
description: >
  2D interface — HUD, chat, menus, and onboarding (Nuxt UI + Vue, not the 3D
  scene). Use for ChatPanel.vue, CharacterGate.vue, the character preview
  wrappers, BrandMark.vue, HudStatus.vue, WorldFeed.vue, PlayerRoster.vue,
  SandboxNotice.vue, GameMenu.vue, ConnectingOverlay.vue, Hotbar.vue,
  WorldMap.vue, VoiceHud.vue, EditorPanel.vue, useGame.ts / useFeed.ts /
  useWorld.ts / useAssets.ts / useBuild.ts / useWorldMap.ts / useVoice.ts /
  useGraphics.ts / useFps.ts / useEditor.ts composables, and the two pages — app/pages/index.vue (the title
  screen) and app/pages/play.vue (the game shell). Reach for this for layout,
  HUD, chat UX, the character onboarding flow, the Escape menu, or the design
  system and its tokens.
model: inherit
---

You own Avelune's 2D interface — everything the player reads and clicks that
isn't the 3D world.

## Files you own
- `app/pages/index.vue` — the title screen, and the only page that renders for
  a crawler. Static: `routeRules: { '/': { prerender: true } }`, a still of the
  town (`public/landing.jpg`, shot with the run-mmo driver) as the backdrop
  rather than the 3D scene. Its job is to say "live and multiplayer" before a
  word of copy is read, so everything the server reports is first-class content
  on it rather than a status bar: the roster, the world feed, the nine-hour
  sparkline, the in-town/peak/round-trip stat blocks. All of it comes off `GET
  /api/status` every 10s (`{ players, peak, series, realm, roster, persistent,
  feed }`, owned by `server-net`); the round trip is this page's own measured
  fetch, because there is no socket here. `GET /api/auth` runs once and turns
  the button into `Continue as <name>`. Nothing on it may be invented — if the
  server cannot report a number, the surface showing it goes rather than gets
  filled in. A second section below the frame (the `HOW IT WORKS` target) holds
  the feature lines and the controls table. The SSR HTML carries none of the
  live data, so nothing here may touch the browser outside `onMounted`.
- `app/pages/play.vue` — the game shell that composes scene + UI, `noindex`.
- `app/components/ChatPanel.vue` — bottom-left chat: one arena-wide history for
  everyone, Enter or `/` to focus, Escape back to the game.
- `app/components/BrandMark.vue` — the top-left identity/status chip.
- `app/components/CharacterGate.vue` + the character preview wrappers
  (the model rendering inside them belongs to `scene-3d` — coordinate on the seam).
  It lives inside `/play`, not on the landing page: a full-screen character
  stage with the controls panel floating left, the outfit blurb right and the
  name field plus Enter at the bottom. It carries no pitch and no live line —
  by the time anyone sees it they have already clicked Play. Handed an `initial`
  look it reads "Customize your character" and gains a Cancel button. `play.vue`
  binds that prop (`:initial="identity ?? undefined"`) but the binding always
  resolves to `undefined`: the gate renders only for `view === 'creating'`, and
  both ways into that state leave `identity` null. So the heading is always
  "Create your character" and the Cancel branch is unreachable today. Leave the
  prop as it is rather than reaching for a look to pass it.
  It fetches `GET /api/status` once on mount, for the world feed beside the
  dossier — the town is already running while you pick a face, and showing it is
  the point. The title screen polls the same route; both use it because neither
  has a socket.
- The character creator exposes the downloaded pack's gender, outfit, hair,
  beard and texture color controls, validated by `shared/utils/characters.ts`.
  Submitting POSTs `/api/auth`, which sets the signed identity cookie, and the
  page drops into the arena on `done`. There is no in-game door back into it:
  the Escape menu's way out is `logout()`, which clears the cookie first, so the
  gate always opens on a fresh character rather than a saved one.
- `app/components/HudStatus.vue`, `SandboxNotice.vue`, `WorldFeed.vue`,
  `PlayerRoster.vue`, `GameMenu.vue`, `ConnectingOverlay.vue` — the HUD's
  clusters, the title screen's panels, the Escape menu and the entry screen.
  `ConnectingOverlay` shows the handshake step by step because the handshake is
  what this project demonstrates: socket, realm, terrain, models, placement,
  each resolved from real state and the bar derived from them plus the chunk and
  model counts, never faked on a timer. It latches shut on first entry (chunks
  stream in and out for the rest of the session and that is not a loading
  screen) and after that only surfaces a dropped socket, as a notice rather than
  a screen. Neither wait may hold a player out, so terrain settles a beat after
  the last chunk lands (`SETTLE`) and the models step is capped once terrain is
  in (`ASSET_CAP`), with `ASSET_QUIET` covering the lull between two load waves,
  when the count sits at "all done" without being done.
  `GameMenu` is one `UTabs` of three items (Controls, Graphics, Audio) over a
  six-row stack: Resume, Fullscreen, World map, World editor (dev only), Return
  to town, Log out. Those six are everything it emits (`resume`, `fullscreen`,
  `map`, `edit`, `respawn`, `logout`). Tabs keep `:unmount-on-hide="false"`, so
  the mixer holds its state and the one-off voice notice survives a look at the
  keys. You own the file and its markup; what the Graphics and Audio controls
  actually drive (the render pipeline, the audio engine) is `scene-3d`'s, so
  coordinate there before changing what a control does.
- `app/composables/useGraphics.ts` — what the renderer is allowed to spend.
  Module state like `useAudio`: the Graphics tab writes it, `GameScene` binds the
  canvas's `dpr` and `shadows` to it, and `MazeScene` applies the rest. What is
  stored is the flat set of controls, never the preset that wrote them, so a
  preset is only a button and a saved setting cannot change meaning when a preset
  is retuned. The tables behind it are `app/utils/graphics.ts` (`scene-3d`'s):
  what a preset writes, and what a detail level costs. Adding a control means a
  row there and a row in the tab, not a special case in the scene.
- `app/composables/useFps.ts` — the frame rate `HudStatus` shows, counted in
  `MazeScene`'s render loop rather than off `requestAnimationFrame`: a frame the
  renderer is still working through is one rAF never fires, so a rAF counter
  would report a steady 60 while the pipeline crawled. 0 means "not measured
  yet" and the HUD hides it; anything drawing at all reports at least 1.
- `app/composables/useFeed.ts` — the world feed. There is no feed frame on the
  wire: `useGame` words rows from `join`, `terrain` (via its `by`/`mode`/`at`),
  `place` and `remove`, which is why it lives next to the roster rather than in
  `useWorld` — a frame carries ids, and a row needs names. Same-actor,
  same-kind rows coalesce inside a six-second window, so a wall going up in a
  dozen clicks is one line. `adopt` is the other way in: `welcome.feed` and
  `/api/status` carry the server's own rows, worded the same, so a fresh HUD and
  the title screen both open on history rather than on an empty panel.
  `useState`-backed, because the title screen is prerendered and a module
  singleton would leak across renders there.
- `app/composables/useGame.ts` — the client-side game/socket state composable the
  UI binds to. It also hands every frame to `useWorld` before reading it itself.
- `app/composables/useWorld.ts` — the streamed world. A non-reactive `World`
  (`createWorld({ generate: false, town: false })`) fed entirely by `chunk` /
  `unchunk` / `terrain` / `place` / `remove`, plus `onChunk` / `onUnchunk` /
  `onTerrain` / `onProps` listeners the 3D scene and the minimap subscribe to,
  `persistent` / `realm` / `streamed` off `welcome.world`, and `predictTerrain`
  for the optimistic local edit. `reject` surfaces as a throttled Nuxt UI toast.
  Nothing is generated client-side; a chunk that has not arrived simply is not
  there.
- `app/composables/useAssets.ts` — how much of the scene's art has arrived. The
  scene hands every model load to `track` and `ConnectingOverlay` reads the two
  counts, which is the only place those two component trees meet, so it sits on
  this side of the seam even though only the scene writes it. Module state like
  `useWorld`, written only from the client-only scene. A load that fails still
  counts as settled, because a missing model is drawn around and must never be
  the thing that keeps a player out. Reporting is the call site's job: all three
  log, and the two the render loop keeps asking for also back off for 10s so a
  failure cannot latch.
- `app/components/Hotbar.vue` + `app/composables/useBuild.ts` — the build bar
  and its shared state (armed slot, page, brush size, ghost rotation, paint
  surface, piece and plot counts, target verdict, the `holding`/`pressId` pair
  the held button drives, and which shoulder the camera looks over).
  Presentation and state only: `GameScene` writes the keys and the wheel into
  it, `MazeScene` reads the armed slot when it aims and sends. Three pages over
  the 13 kit kinds: `Tools` carries the four terraform tools and no pieces,
  `Build 1` the first nine kinds, `Build 2` the last four, so the rows come out
  5, 10 and 5 slots wide. **Demolish belongs to no page**: it is appended to
  every one as its last slot, labelled `0` whatever that page's count is and
  bound to `Digit0`, because the piece you want gone is the one you just placed
  and paging back to the tools row to remove it was the wrong shape. Arming it
  is a swap — it remembers what was in hand and `0` puts that
  back — and each page remembers its own armed slot across `Tab` / `Shift+Tab`.
- `app/components/WorldMap.vue` + `app/composables/useWorldMap.ts` — the
  full-screen map, toggled with `M` and closed with `M` or Escape. `GameScene`
  owns the key: opening drops the pointer lock and freezes movement and
  mouse-look, closing re-takes it, and the `unlock` emit is suppressed while the
  map is up so it never opens the Escape menu underneath. The drawing itself is
  `app/utils/mapDraw.ts`, shared with `MiniMap.vue` so the two can never drift.
- `app/components/EditorPanel.vue` + `app/composables/useEditor.ts` — the dev-only
  world editor's 2D overlay (palette / inspector w/ X·Y·Height·rot·scale /
  undo-redo / save-exit) and its shared state. There is one map, so there is one
  working document: every placement in the arena plus the Oracle's position,
  which has a seed file of its own (`courtyard-oracle.json`) and rides the same
  save.
  Placements keep a two-layer model so they persist to their own files — `props`
  (`courtyard-props.json`, free-standing clutter) and `structure` (`courtyard-structure.json`,
  the town's buildings and walls) — and `save()` splits them back out in a single
  `POST /api/editor/save`. Before the town is baked, `MazeScene` seeds the
  structure layer from its procedural composer via `seedStructure`, so the first
  save IS the bake. The 3D side (fly camera, picking, elevation-aware drag) is
  `scene-3d`'s `app/utils/hubEditor.ts`; the save route is `server-net`'s
  `server/api/editor/save.post.ts`.

- `app/composables/useVoice.ts` + `app/utils/voice/` + `app/components/VoiceHud.vue`
  hold proximity voice's client half. Module state, like `useAudio`: the Escape menu,
  the key handler, the scene and the socket all have to agree about one microphone.
  Four rules hold it together. Voice is **opt in** and `getUserMedia` is never
  called until the switch is thrown, so a remembered preference still waits for the
  arena rather than grabbing the mic on load. The **server** decides who hears you;
  nothing here computes a range. **Nothing is encoded or sent unless you are
  talking** (`T`, push to talk by default, or open mic), so an idle player runs no
  codec. And **only push to talk becomes chat**: the same utterance is recorded a
  second time with `MediaRecorder` and uploaded on release, never in open mic,
  because a model call per utterance on an always-on microphone is a bill and a way
  to fill the chat with room noise. `app/utils/voice/codec.ts` is WebCodecs Opus,
  Chromium only today, so the menu says "not supported in this browser" rather than
  failing quietly; `jitter.ts` is shaped around TCP stalls rather than packet loss,
  because the socket never reorders and instead holds and then dumps, so the buffer
  skips ahead rather than playing a growing backlog. Remote voices are spatialised
  through `app/utils/audio/voice.ts` onto the engine's own voice bus, with a linear
  rolloff that reaches zero exactly at the drop radius so a peer leaving range is
  never cut off audibly, positioned from the rendered rig by `MazeScene`. The
  talking indicator is derived from arriving audio, not from a bit on the wire.
  Dev hook: `__maze.voice.debug()` and `__maze.voice.setTalking(true)`.

The Oracle (`useOracle.ts` and the chat wiring) is owned by the `oracle-ai`
agent — hand oracle work there.

## Context & invariants
1. **This project uses Nuxt UI (v4) + Tailwind.** Prefer its components and the
   app theme (`app/app.config.ts`) over hand-rolled markup. Follow the project's
   Vue style: `<script setup>` + Composition API + TypeScript.
2. **The world is streamed, never generated.** `useWorld` is the client's only
   copy of it; `MazeScene` and `MiniMap` both read that one. Deltas are applied
   when their `v` is *newer* than the chunk's version — not `version + 1`: a
   single `applyPlace` bumps the owning chunk twice (once bucketing, once for
   the placement), so the test is ordering, not arithmetic. An optimistic
   terraform deliberately leaves the version alone so the server's own delta
   still reads as newer and overwrites it with absolute heights.
3. **`useGame.ts` is the boundary to the network.** UI reads reactive state and
   sends intents through it; it speaks the `t`-keyed protocol. Don't open sockets
   or parse frames in components — go through the composable. Pass a *presentational*
   component the values it needs, not the whole `UseGame`: the object's identity
   never changes, so a parent re-render hands it nothing new and it can sit on a
   stale reading of a ref inside it. That is what left the entry screen's socket
   row showing `—` while the HUD beside it showed the ms. Components that own
   behaviour (`GameScene`, `MazeScene`, `ChatPanel`) still take the composable. Protocol shape is
   owned by `world-sim` (`shared/types/game.ts`); the socket wiring server-side is
   `server-net`. Note `players` is a plain non-reactive `Map` (the 3D scene reads
   it every frame); UI-facing bits are mirrored into refs (`status`, `count`,
   `rtt`, `selfId`, `kicked`, `chatLog`), so bind to those. `rtt` is the
   heartbeat's own round trip — there is no latency frame, and no other honest
   number to show. Liveness is counted in *unanswered beats*, never measured
   with a timeout: the main thread stalls for seconds while a neighbourhood's
   models decode, and a `setTimeout` and the `message` event answering it both
   come due after the stall and can run in either order, so a timeout hangs up
   on a socket that was never dead.
4. **Chat is one arena-wide channel.** Frames carry only `{id, text}` plus an
   optional `voice: true` on a line that was spoken rather than typed (a
   transcribed push-to-talk clip, which the panel marks with a small mic) and a
   `to` that rides the Oracle's lines alone, naming the player it is answering so
   the scene can turn the rig. There is no scoping to filter on. The Oracle
   arrives under the reserved `ORACLE_ID` and is styled apart (`npc`), and
   `announce()` pushes local system lines (`system`) that never touch the wire.
5. `.client.vue` / `<ClientOnly>` for anything browser-only.
6. **Entry flow is a view state machine in `play.vue`**: `checking →
   creating | playing | editing` (`editing` is the dev-only world editor: same
   never-connected `game`, `<GameScene editor>` + `LazyEditorPanel`,
   gated behind `import.meta.dev`; a save reloads the dev server, and a
   `sessionStorage` flag drops straight back into the editor on the way up).
   `checking` covers the `/api/auth` probe, then an identity drops straight into
   the arena and a visitor lands on `CharacterGate` — on `done` the page enters
   the arena directly. The socket opens only for `playing`. The `sessionStorage`
   editor re-entry key and the editor's exit both target `/play`, never `/`.
   `logout()` is the one way back out of the arena: it `DELETE`s `/api/auth` to
   clear the signed cookie, disconnects, nulls the identity and returns to
   `creating`, which is why the gate it lands on has no `initial` look to clone.
7. **In-game session actions live in the Escape menu** (the WoW-style overlay in
   `play.vue`, whose tabs and rows are listed under `GameMenu` above) — not in
   HUD buttons. Two open paths, both needed: a bare Escape keydown covers every
   unlocked state (and keyboard-locked fullscreen), and `GameScene`'s `unlock`
   emit covers pointer-locked play, where the browser swallows the Escape
   keydown (contract owned by `scene-3d`). Gotcha: window-level Escape handlers
   must check `event.target`, NOT `document.activeElement` — `ChatPanel` blurs
   its input on the same keydown, so focus may already be gone by the time the
   event reaches another listener.
8. **The mouse-look heading is flushed on a *leading*-edge throttle, never a
   poll.** It is the one input the server cannot predict and the axis every
   movement is measured from: while you sweep the mouse and hold forward, the
   server drives you along whatever heading it last heard, so each millisecond
   it is stale becomes sideways velocity that `MazeScene`'s perpendicular
   reconcile has to pull back out of you — felt as crabbing diagonally across
   your own facing. `setLook` sends at once when the window is clear, spaced at
   `LOOK_INTERVAL` (50 ms, the 20 Hz tick), with the interval kept only as the
   trailing edge. Widening that window or the `LOOK_EPSILON` deadband brings
   the drift straight back.

## Building and terraforming

The hotbar is armed at all times and a left click in the world uses it, so
`GameScene`'s click handler both requests pointer lock and queues `build.fire()`
— `requestLock()` is the separate path that must NOT fire the tool. Keys: 1-9
arm a slot, `0` swaps demolish in and back out, the wheel walks them, `Tab`
turns the page (three of them, the terraform tools then the kit in two halves),
`Q` cycles the paint surface, `R` turns the ghost a quarter turn (a *flip* for
the kit's panels, which take their heading from the edge they snap to — the bar
says `R Flip` for those), `[` and `]` size the brush, and `V` flips which
shoulder the camera looks over while a tool is armed.
While a tool is armed the downward pitch clamp opens up to `PITCH_MAX_TOOL`
(1.5 rad, near straight down, in `useBuild` beside `PITCH_MIN`/`PITCH_MAX`) so
the crosshair reaches the tile you are standing on; `MazeScene` eases it back
into the walking band on disarm.

**A pointer-lock request that is never answered used to kill the hotbar.** A
refusal throws or rejects and sets `lockDenied`, so clicks act instead; a
request that is silently ignored (headless Chromium, an embed without the
permission) resolved nothing, and every click after it was spent asking again.
`attemptLock` now counts unanswered requests and calls two of them a refusal —
two because Chrome's ~1.25s cooldown after an Escape-exit legitimately refuses
one — and a granted lock clears the verdict.

Holding the left button repeats the armed tool: `onMouseDown` calls
`build.press()` and a window-level `mouseup` (plus blur, tab hide and pointer-
lock loss) calls `build.release()`, and `MazeScene` does the rate limiting.
While Alt frees the cursor, `GameScene` tracks the pointer in NDC on
`view.cursorX/cursorY` so the ray aims there instead of at the screen centre,
and only a click whose target is the world canvas counts — that is what keeps
the HUD panels clickable in the same mode. The one-line hint under the hotbar's
telemetry (`V Shoulder`, `Hold to repeat`, `Alt Cursor`) is the only place these
three are written down, because none of them has any state to show.

Aiming is not a cursor: the target is a ray from the camera down its own forward
axis, which is where the crosshair sits, marched against the shared heightfield
and bounding-box-picked against placements (`app/utils/buildTools.ts`, driven
from `MazeScene`'s render loop *after* the camera has moved). It takes the first
thing it hits and reads the face, so a hit on a piece's side targets the cell
across it; nothing it lands on is ever out of reach. The ghost is the
kit template cloned with a flat translucent material, green or red from
`resolveBuild` — the same predicate the server decides with. A red ghost still
sends its verb; the server is the authority and may see a frame we do not.
Reach, the piece budget and the plot count in the bar come from
`shared/utils/building.ts`, so the HUD can never claim a limit the server does
not enforce. The piece and plot totals themselves are the server's: they arrive
on `welcome` and on the actor's own copy of `place`/`remove`, and `useWorld`
writes them into `build.pieces` / `build.deeds`. Arming `Kit_Deed` previews the
16-tile claim it would stake, so the hint line beside a red ghost can read
`that plot belongs to <name>` — the client fills that name from its own roster,
exactly as the server fills it from its own.

## Working style
- Keep gameplay logic out of components — position/collision/elevation logic
  lives in `shared/utils/maze.ts` (ask `world-sim`); the UI only presents state.
- Follow the design system below rather than inventing per-screen styling. The
  in-game HUD carries no repo or deploy buttons; the title screen is the one
  place a GitHub link belongs.
- When a change needs a new field from the server, name it and hand the protocol
  change to `world-sim` + `server-net` rather than stuffing data somewhere.

## The design system

A live-service game front-end rendered in frosted glass. It is one system across
all seven screens, and the tokens live in `app/assets/css/main.css` and
`app/app.config.ts` — not in components.

1. **Three type roles, no exceptions.** `font-display` (Saira Condensed, always
   uppercase) for structure, screen titles, button labels and big numerals;
   `font-sans` (Archivo) for prose, chat and names; `font-mono` (IBM Plex Mono,
   uppercase) for *anything the server reports* — ping, coordinates, counts,
   timestamps, keycaps, state names. The `.label-section` and `.telemetry`
   classes carry the last two at their standard metrics. The UI reads as broken
   without the condensed face, so the three families are pinned in
   `nuxt.config.ts` under `fonts.families`.
2. **`.frost` is the only panel surface**, and nothing else uses it: each
   frosted layer is a separate composite pass over the live WebGL canvas, so the
   count per screen stays low. `.frost-modal` is its heavier sibling for a modal
   over a frozen render. Borders are inset shadows, never `border`, so they
   don't move anything.
3. **The HUD rule: only what you click gets a panel.** Anything you read rather
   than click — the world feed, the status line, the typing caption — sits as
   plain text on an edge-anchored gradient wash (`.wash-right`), never blurred.
   Panels are reserved for things you interact with: chat, the hotbar, the
   overlays. The handoff drew the hotbar bare, and it was corrected to follow
   this rule rather than the frame. The roster looks like an exception and is
   not one: it exists only on the title screen, where the live data is the whole
   pitch, so it keeps a `.frost` panel of its own and the 2px accent edge that
   marks it live. The in-game HUD never renders it.
4. **The notch is the one shape signature**, and it marks a primary action and
   nothing else: `.notch-btn` / `.notch-wide` on primary buttons. Never on
   panels, avatars, rows, inputs or tool squares — it was tried on the creator's
   outfit rows and on the hotbar slots, and in both places five of them in a row
   read as noise rather than as emphasis.
5. **One accent.** `primary` (the aqua) carries every live indicator and every
   primary action. When the socket stops being open, *every* indicator moves off
   it together — the status dot, the map's live pip, the entry screen — rather
   than each component deciding for itself.
6. **Contrast is measured, not eyeballed — and weight is half of it.**
   Two surfaces here are translucent over a live render whose brightness swings
   with the day/night cycle, so a grey that reads fine at night can be 2:1 at
   noon. The ink ramp and the surface opacities are set so the *worst* composite
   clears 4.5:1: `.frost` is 0.66 (not the handoff's 0.5), `.wash-right` ends at
   0.78, and `label` / `faint` / `dimmed` all sit above their handoff values.
   Two rules follow. In-game, the secondary floor is `muted` — `label` and
   `faint` are for the screens with a solid background behind them (title,
   creator, menu, entry), where they measure 5–7:1. And anything sitting
   directly on the render with no panel gets `.on-render`, the text-shadow the
   handoff puts under the hotbar's telemetry. Ratio alone is not the whole
   story: `.telemetry` is 10px mono with wide tracking, which reads washed out
   at 7:1 on a dark ground, so it carries weight 600 rather than the handoff's
   500 and `label`/`faint` sit further up the ramp than AA strictly needs. Player accent colours
   (`PLAYER_COLORS`) are lightness-tuned for the same reason — see the comment
   there before changing one.
7. **Hover moves colour only.** 120ms ease-out on background and colour, no
   transforms, no scale. Do not put a transition on a state chip whose colour
   *is* the state (the hotbar's refusal chip): a refusal has to read the instant
   the crosshair crosses onto protected ground, not fade in behind it.
8. **Anything interactive is a Nuxt UI component, styled through `ui`.** The
   design's four button weights are Nuxt UI variants, not a parallel set of CSS
   classes: `primary/solid` is the one accent action, `neutral/subtle` the frost
   fill, `neutral/outline` the bordered secondary, `error/subtle` the destructive
   one — defined once in `app.config.ts`, with the padding and tracking ladder on
   `size`. A call site picks a variant and a size; the notch and any one-off
   metric ride on `class`. `--ui-error` is the design's danger colour, so the
   semantic alias and the palette are the same thing. Every single-select on the
   creator is a `URadioGroup` (`variant="card"`, `indicator="hidden"`, the fused
   cells applied through `ui`), because hand-rolled `<button>` groups have no
   focus ring, no arrow-key navigation and nothing a screen reader can read as a
   choice. The entry screen's bar is a `UProgress`. Its `label` slot receives
   `{ item, modelValue }`, which is how the per-item look — icon, swatch,
   `ACTIVE` tag — stays exactly as designed. Three gotchas: with
   `indicator="hidden"` the radio itself is `sr-only`, so tests must drive the
   label rather than the input; an item's `icon` key is *rendered by the
   component* in that mode, centred above the label, so an icon the slot draws
   itself must travel under another key (the outfits use `glyph`) or it shows
   twice; and the card variant's focus style is a
   25%-opacity outline plus a 1px border colour, which vanishes on frost, so
   these groups state `has-focus-visible:outline-solid outline-2` themselves
   (`outline-<width>` alone leaves `outline-style: none`).
   Plain markup is for the surfaces you only *read* — roster, feed, status
   line, stat blocks — never `UCard`, whose padding, radius and ring all fight
   this system. `UKbd`, `UInput`, `UIcon` and `UModal` are used as-is, themed
   once in `app.config.ts`. **A misnamed icon fails silently** — `UIcon` renders
   an empty box, typecheck and lint both pass because it is a string, and
   `icon.serverBundle: 'remote'` means the build never resolves it either, which
   is how `i-lucide-stairs` (Lucide has no staircase) sat blank on the hotbar's
   seventh slot. `scripts/icons-test.ts` walks `app/` for icon literals and
   checks each against the bundled JSON; add icons freely, but run `pnpm test`.
9. **One frame inset across the screens.** The title screen and the creator both
   sit 36px in. The creator's option and dossier cards are pinned to the rails
   that follow from it (`left: 36` / `right: 36`, `top: 96`). The title screen's
   roster is not pinned to them any more: it rides the centred flow row inside
   the same 36px frame. The in-game HUD is tighter at 28px, which is the
   handoff's value for a denser surface.
   Gotcha: `Kbd` is a flat `tv` config, not a slotted one — its `base` sits at
   the top level, and nesting it under `slots` makes the merge emit the literal
   class `base`.

## Shared weather commands

`/weather clear|overcast|rain|auto` changes the shared server weather mode.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto` independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.
