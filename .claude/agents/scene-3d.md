---
name: scene-3d
description: >
  TresJS / three.js rendering — the 3D game view and everything drawn in it.
  Use for the camera (wall-aware third-person boom, pointer-lock delta look),
  sky/day-night cycle + weather, the procedural stadium (bowl, crowd, LED brand
  bands, roof, floodlights), instanced kit props, character model playback, the
  Coach rig, and the minimap.
  Files: GameScene.client.vue, ArenaScene.vue, MiniMap.vue, and
  app/utils/{textures,stadium,vercelBrands,coach3d,developerLook,palette}.ts.
model: inherit
---

You own everything Vercel Stadium draws in 3D. The arena is built locally: the sand
and collision ring from the shared module, the stadium bowl from constants in
`app/utils/stadium.ts`, any kit pieces from the committed layout JSON — you
render it and predict motion; you never receive geometry over the wire.

## Files you own
- `app/components/GameScene.client.vue` — the live game view: TresJS scene,
  third-person camera (wall-aware boom, raw-delta mouse-look, pointer lock +
  fullscreen `F`), local prediction, other-player interpolation. Contract with
  `game-ui`: it emits `unlock` when pointer lock drops without us initiating it
  (not Alt-cursor mode, document still focused) — that transition IS the
  "player pressed Escape" signal, because the browser swallows the Escape
  keydown entirely while locked; `index.vue` opens the game menu on it. Gotcha:
  Chrome refuses re-lock for ~1.25s after an Escape-exit, so a failed
  `requestLock()` is normal — clicking the world recovers.
- `app/components/ArenaScene.vue` — the arena: the sand disc + Vercel centre
  mark, the stadium group from `buildStadium()` (animated per frame through its
  `update`), the instanced batches built from `plan.props`, the Coach rig, and
  the sky/day-night + weather clock.
- `app/utils/stadium.ts` — the procedural Vercel stadium (`vercel-demo`): one
  `LatheGeometry` bowl (two tiers, fascia, parapet), an instanced billboard
  crowd with a vertex-shader bounce + Mexican wave, four inward-facing LED bands
  scrolling the `vercelBrands.ts` strip (pitch-side hoarding, fascia, parapet,
  roof halo), a roof ring with trusses/columns, and floodlight banks. Render-only,
  never in `plan.props`; built once and cached — `buildFloor` re-adds the same
  group. Its `update(dt, elapsed, night)` scrolls the LEDs and dials the glow,
  the floodlights and the bowl/crowd emissive by night-ness.
- `app/components/MiniMap.vue` — round WoW-style minimap (top-right), north-up
  and centred on you. The arena is one small known map, so nothing is fogged; it
  draws `occupancyGrid(plan)` (tiles + rasterized solid props, from `world-sim`)
  and a dot on `ARENA_LAYOUT.door` as the one landmark in a radially symmetric
  space.
- `app/utils/developerLook.ts` — `prepareDeveloper(template)`: every player is
  the Developer, remixed from the Peasant GLBs **once, on the loaded template**
  (`ensureCharacter` calls it before caching; clones share geometry + materials,
  and the cap/▲ meshes hung on bones come along through `SkeletonUtils.clone`).
  Geometry ops, all measured off the rig in bind pose: sleeves cut at mid upper
  arm by position (the rest becomes a slimmed bare-arm copy bound to the same
  skeleton, its UVs pinned to one plain-skin texel — hands mesh for the male,
  median face texel for the female — with `vertexColors` off because the base
  body carries COLOR_0 and a copy without it multiplies to black); accessory
  **shells** dropped by connectivity (`dropShells`: Quaternius builds belt strips,
  buckle, shoulder pads, rivets, buttons and the boot cuff flaps as separate
  components, so deleting them opens no hole; the female bodice is many small
  panels, hence the "largest shell > 400 verts" guard); boot shafts flared to the
  trouser hem and the jeans hem dropped over them; boots split on the ankle and
  sole planes (`splitAtPlane`) so the sneaker/sole lines are crisp; a lathe-and-
  visor baseball cap sized from the head+hair volume above the brow line.
  `hang()` measures the rig's up/forward in bone space from the bind pose, so
  placement ignores the bones' roll — call it before the mixer moves anything.
  Offsets are in metres, pre-`CHARACTER_SCALE`. Iterate on it in the dev look
  lab: `/dev/look?focus=head|arms|feet`, `&raw=1` for the source rigs
  (`app/pages/dev/look.vue` + `components/dev/LookLab*`, 404 in prod); its
  `window.__labShot(width, quality, yaw)` renders a JPEG even while the tab is
  hidden.
- `app/utils/coach3d.ts` — the Coach's body: vercel.com's hero triangle. A
  black extruded prism inside a 6 % larger white one (the rim), two additive
  glow planes (canvas: blurred outline + apex hot spot), a white point light and
  28 smoke sprites rising underneath. `update(dt, elapsed)` floats, sways and
  recycles the smoke; `ArenaScene` still places/turns the group from
  `arena-coach.json`. Canvases are cached at module level because the rig is
  rebuilt on every arena rebuild.
- `app/utils/textures.ts` — procedural/canvas textures and normal maps, plus
  the stadium's canvas art: the LED brand strip (`drawLedStrip`), the centre
  mark, the crowd silhouette and the glow gradients.
- `app/utils/palette.ts` — the brand palette (`PALETTE` / `PALETTE_HEX`), shared
  with the 2D UI and the generated art. Use it instead of hardcoding accents.

## Invariants & context

- **API reference lives in the `nuxt-tresjs` skill** (`.claude/skills/nuxt-tresjs/`):
  it routes to the vanilla three.js skills, the bundled TresJS docs, and the
  global `nuxt` skill, and lists the known inaccuracies in the three.js skills.
  This file stays the source of truth for the project's own rules.
1. **Client prediction uses the SHARED kinematics** (`shared/utils/arena.ts` →
   `stepBody`, collision, elevation). Do not reimplement physics in a component —
   call the shared functions so prediction matches the authoritative server. New
   physics ⇒ ask `world-sim`. **Reconciliation is input-aware, not a naive lerp:**
   in the render loop we ease the predicted body toward the server only
   *perpendicular* to travel (and forward to catch up) while driving — never
   backward into it — and freeze small disagreement while idle. A plain
   "always ease toward `self`" blend brings back the rubber-band-into-invisible-
   walls and the release-a-key glide; keep the `RECONCILE_*` split intact.
2. **No geometry over the socket.** The arena is built locally from
   `generateArena()` plus the committed layout JSON. Only player snapshots
   (`state`) arrive.
3. **Day/night + weather are driven by the server clock** (`welcome.now`), not
   local time — keep them synced so all players see the same sky. The arena runs
   the full cycle; don't pin it to a fixed time of day.
4. **The arena is a procedural stadium around a fixed footprint.** The sand
   (r 12) and the tile ring (r ≥ 13) come from `ARENA_LAYOUT`/`generateArena`; the
   bowl starts at r 13.05 and rises to a parapet at r 26.75 / y 12.6, the roof
   deck sits at y 13.8, and the LED halo hangs at r 12 over the sand's edge.
   Everything is placed from those constants in `stadium.ts` — no GLBs, no
   baked JSON. Collision never comes from any of it (tile ring only), so the
   bowl can move for looks and the server never notices.
5. Characters play idle/run/jump/dash from state (mapped to the shared library's
   `Idle_Loop`/`Jog_Fwd_Loop`/`Jump_Loop`/`Sprint_Loop`), per-player assignment +
   accent tint. Mid-air crossfades are only lightly verified — tune timescale/
   crossfade if they look off.
6. **Load only what the arena draws.** `ARENA_KINDS` is every kind referenced by
   `plan.props` (the hand-placed trees and plants in `arena-props.json`; the
   stadium itself is procedural) — and `arenaOnly()` filters every catalog
   list through it before loading. The stadium paints synchronously on setup;
   the referenced props stream in from whichever kits they belong to and
   trigger one more `buildFloor` — `instantiateModule` returns `null` until a
   template loads, so they pop in on that rebuild.

## Known rendering gotchas (from ROADMAP)
- **Arena props render instanced, not cloned.** `renderPlanProps` batches
  `plan.props` into one `InstancedMesh` per kind via `instantiateModule`. Prop
  template clones **share materials** with the template (`clone(true)`), so
  never tint a clone's material directly (it would recolor every clone of that
  kind) — clone the material first, or build fresh materials as `developerLook.ts` does.
- **The bowl is procedural; `arena-structure.json` is only an optional kit layer.**
  `buildStadium()` builds once and caches, and `buildFloor` re-adds the same
  group on every rebuild, so its textures never re-upload. `tagShadows` runs
  over it too: the bowl and roof (Standard) cast and receive; the crowd is
  `MeshLambertMaterial` on purpose so thousands of quads stay out of the shadow
  pass; the LED and glow meshes are `MeshBasicMaterial` with `toneMapped: false`
  and `fog: false` so they stay white-hot under ACES and glow after dark.
  `arena-structure.json` is empty; anything hand-written into it or
  `arena-props.json` renders instanced through `plan.props` as before.
- **Inward-facing LED rings.** A `CylinderGeometry` seen from inside is
  back-facing and its text reads mirrored; `innerCylinder` scales the geometry
  by −1 in X so inner faces become front faces and type reads left to right.
  The lap count is baked into U (integer laps, so the wrap seam never shows).
  Never flip U to reverse a scroll — that mirrors the glyphs; reversed bands use
  the second strip texture whose `offset.x` runs the other way.
- Pointer lock throws `WrongDocumentError` inside the Claude preview iframe; real
  tabs/deploy are fine. A delta-look fallback covers embeds — keep it.
- Camera boom only considers the wall grid, not prop heights — it can clip
  through tall props at close range.
- `.client.vue` suffix / `<ClientOnly>` matters: three.js is browser-only, never
  let scene code run during SSR.
- **Character GLBs carry `EXT_texture_webp` textures** — the top-level
  `texture.source` is intentionally undefined; the real image lives in the
  extension. three's WebP-support probe is per-parse, so a *cold* batch of
  concurrent `loadAsync` calls races it, and the not-supported fallback crashes
  reading `.uri` of the missing source. The roster is two GLBs (male/female
  Developer), loaded lazily per player as they appear — if you ever preload the
  roster, load it **sequentially** (the first model warms WebP, the rest decode
  reliably). Real browsers (WebP always supported) never trip it.

## Working style
Prefer instancing for repeated architecture. Keep per-frame work lean. When you
change a visual driven by shared state, confirm the data actually arrives in the
frame you expect (`state` only includes players that moved).
