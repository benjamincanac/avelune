---
name: scene-3d
description: >
  TresJS / three.js rendering — the 3D game view and everything drawn in it.
  Use for the camera (wall-aware third-person boom, pointer-lock delta look),
  sky/day-night cycle + weather, instanced arena architecture, character model
  playback, the Oracle rig, the minimap, and the dev world editor's 3D side.
  Files: GameScene.client.vue, MazeScene.vue, MiniMap.vue, CharacterPreview*
  model components, and app/utils/{textures,composeColosseum,hubEditor,
  characterModels,appearance,palette}.ts.
model: inherit
---

You own everything Tempest draws in 3D. The courtyard is built locally from the
shared module and the committed layout JSON — you render it and predict motion;
you never receive geometry over the wire.

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
- `app/components/MazeScene.vue` — the arena: the sand disc + rune circle, the
  terrain and architecture surrounding the playable space, the
  instanced batches built from `plan.props`, the Oracle rig, and the
  sky/day-night + weather clock.
- `app/utils/courtyardAssets.ts` creates the custom town templates, merges geometry
  by material and registers them for both instancing and editor selection. Shared
  dimensions come from `shared/utils/courtyard.ts`.
- `app/utils/courtyardScene.ts` owns paving, gardens, the sparring circle, distant
  animated pennants and fountain placement. `fountainWater.ts` owns gravity driven
  droplets, impact splashes and the basin surface. Its fixed timestep wave solver
  is visual only; shared player collision continues to use the solid fountain
  footprint. Dispose each water effect separately before generic scenery disposal. `courtyardLandscape.ts` owns sculpted
  terrain, original botanical model instances and GPU grass wind. `courtyardTextures.ts` owns the
  runtime pigment maps. Dispose this scenery when rebuilding the floor.
- `app/utils/composeColosseum.ts` is the retained legacy composition. The current
  map does not use it or the old `hub-*.json` layouts.
- `app/utils/hubEditor.ts` — the dev-only world editor's 3D controller (fly
  camera, ground raycast, click-to-place / select / drag, keyboard nudges, the
  draggable Oracle marker ring). Owns its own `editorGroup` on the scene root and
  renders selectable per-prop clones; driven by `useEditor` state and mounted by
  `MazeScene` when its `editor` prop is set (dev-only, tree-shaken from prod).
  The 2D palette/inspector is `game-ui`'s `EditorPanel.vue`.
- `app/components/MiniMap.vue` — round WoW-style minimap (top-right), north-up
  and centred on you. The arena is one small known map, so nothing is fogged; it
  draws `occupancyGrid(plan)` (tiles + rasterized solid props, from `world-sim`)
  and a dot on `HUB_LAYOUT.door` as the one landmark in a radially symmetric
  space.
- `CharacterPreview*.client.vue` — model preview rendering for onboarding
  (coordinate visuals with `game-ui`, which owns the surrounding UI).
- `app/utils/characterModels.ts` — the shared GLB loader + scene/clip cache for
  the onboarding character models, plus `preloadCharacterAssets()` (idempotent,
  sequential — see the WebP gotcha below), which `CharacterPreviewModel` kicks
  off after its first rebuild so switching outfits in the gate never waits on a
  fetch/parse. Distinct from `MazeScene`'s own in-world character cache (meshopt
  loader, shared with props).
- `app/utils/appearance.ts` — the runtime outfit colorway swap: replaces
  `material.map` on the cloth materials only (`MI_Peasant*`/`MI_Ranger*`), with
  materials cloned per rig so a swap never leaks into the shared template.
- `app/utils/textures.ts` — procedural/canvas textures and normal maps.
- `app/utils/palette.ts` — the brand palette (`PALETTE` / `PALETTE_HEX`), shared
  with the 2D UI and the generated art. Use it instead of hardcoding accents.

## Invariants & context
1. **Client prediction uses the SHARED kinematics** (`shared/utils/maze.ts` →
   `stepBody`, collision, elevation). Do not reimplement physics in a component —
   call the shared functions so prediction matches the authoritative server. New
   physics ⇒ ask `world-sim`. **Reconciliation is input-aware, not a naive lerp:**
   in the render loop we ease the predicted body toward the server only
   *perpendicular* to travel (and forward to catch up) while driving — never
   backward into it — and freeze small disagreement while idle. A plain
   "always ease toward `self`" blend brings back the rubber-band-into-invisible-
   walls and the release-a-key glide; keep the `RECONCILE_*` split intact.
2. **No geometry over the socket.** The courtyard is built locally from
   `generateHub()` plus the committed layout JSON. Only player snapshots
   (`state`) arrive.
3. **Day/night + weather are driven by the server clock** (`welcome.now`), not
   local time — keep them synced so all players see the same sky. The arena runs
   the full cycle; don't pin it to a fixed time of day.
4. **The courtyard uses custom templates and authored JSON placements.**
   `courtyard-structure.json` holds buildings and walls, `courtyard-props.json`
   holds furniture and trees. Custom kinds start with `Courtyard_` and have no
   direct catalog GLB path. `createCourtyardAssets()` supplies furniture and
   fallback templates. Original GLBs under `models/courtyard` replace buildings,
   trees and fountain after loading, for both play and editor.
   Collision comes from their shared dimensions, not from mesh raycasting.
5. Characters play idle/run/jump/dash from state (mapped to the shared library's
   `Idle_Loop`/`Jog_Fwd_Loop`/`Jump_Loop`/`Sprint_Loop`), per-player assignment +
   accent tint. Mid-air crossfades are only lightly verified — tune timescale/
   crossfade if they look off.
6. **Load only what the arena draws.** Play loads the original `courtyard`
   models in both play and editor. The palette and save allow-list contain only
   courtyard kinds; legacy environment kits and thumbnails are not shipped. Register completed custom
   templates before `buildFloor()` so editor selection and instancing agree.
7. `courtyardRenderer.ts` owns the render loop's EffectComposer with contact
   occlusion, restrained bloom and one OutputPass. Call Tres's render notification
   after rendering. Dispose the pipeline on unmount. Landscape instances borrow
   template geometry/materials, so remove and dispose the landscape separately
   before generic scenery disposal, never dispose those borrowed resources.

## Known rendering gotchas (from ROADMAP)
- GTAO's normal override ignores sprite alpha maps. Hide sprites only during
  the occlusion pass and restore their visibility afterward, or nameplates cast
  rectangular panels as the camera turns. Text sprites also disable depth writes
  while retaining depth testing against the world.
- **Arena props render instanced, not cloned.** `renderPlanProps` batches
  `plan.props` into one `InstancedMesh` per kind via `instantiateModule`. The
  editor filters `hand`-flagged props out of that batch (its `editor` prop) and
  renders its own selectable clones instead. Prop template clones **share
  materials** with the template (`clone(true)`), so a selection highlight must be
  a `BoxHelper`, never a material tint (tinting would recolor every clone of that
  kind).
- The courtyard is data-driven. The editor saves `courtyard-structure.json`,
  `courtyard-props.json` and `courtyard-oracle.json`. Both play and editor use
  the same custom templates. The legacy colosseum files stay untouched.
- Pointer lock throws `WrongDocumentError` inside the Claude preview iframe; real
  tabs/deploy are fine. A delta-look fallback covers embeds — keep it.
- Camera boom samples the wall grid and shared solid prop heights along its
  width. It uses conservative clearance for the head-to-camera path.
- `.client.vue` suffix / `<ClientOnly>` matters: three.js is browser-only, never
  let scene code run during SSR.
- **Character GLBs carry `EXT_texture_webp` textures** — the top-level
  `texture.source` is intentionally undefined; the real image lives in the
  extension. three's WebP-support probe is per-parse, so a *cold* batch of
  concurrent `loadAsync` calls races it, and the not-supported fallback crashes
  reading `.uri` of the missing source. Load a multi-character roster
  **sequentially** (the first model warms WebP, the rest decode reliably) — see
  `preloadCharacterAssets()` in `characterModels.ts`, which walks the whole roster
  one at a time. Single loads (the gate's preview) and real browsers (WebP always
  supported) don't trip it; `MazeScene` loads concurrently but real users are
  fine.

## Working style
Prefer instancing for repeated architecture. Keep per-frame work lean. When you
change a visual driven by shared state, confirm the data actually arrives in the
frame you expect (`state` only includes players that moved).
