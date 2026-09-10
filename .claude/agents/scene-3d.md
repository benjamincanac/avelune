---
name: scene-3d
description: >
  TresJS / three.js rendering — the 3D game view and everything drawn in it.
  Use for the camera (wall-aware third-person boom, pointer-lock delta look),
  sky/day-night cycle + weather, instanced arena architecture, character model
  playback, the Oracle rig, the minimap, and the dev world editor's 3D side.
  Files: GameScene.client.vue, MazeScene.vue, MiniMap.vue, CharacterPreview*
  model components, and app/utils/{textures,composeColosseum,stadium,
  vercelBrands,hubEditor,characterModels,appearance,palette}.ts.
model: inherit
---

You own everything Tempest draws in 3D. The arena is built locally from the
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
  backdrop shell that keeps raw sky out of the gaps between kit pieces, the
  instanced batches built from `plan.props`, the Oracle rig, and the
  sky/day-night + weather clock.
- `app/utils/composeColosseum.ts` — the procedural colosseum composition as a
  flat list of `HubPropPlacement`s (ground arcade of arches + columns, the raked
  stone seating rings, the arched upper wall + flags, the statues flanking the
  door). It is both the pre-bake visual fallback and the seed the dev editor
  bakes into `hub-structure.json`; after baking, pieces flow through
  `plan.props` instead and this is only the bake input.
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
- `app/utils/textures.ts` — procedural/canvas textures and normal maps, plus
  the canvas-drawn Vercel sponsor boards and centre mark.
- `app/utils/stadium.ts` — the Vercel stadium dressing (`vercel-demo`): the LED
  sponsor ribbon on the parapet wall and the upper-facade banners, cycling
  `app/utils/vercelBrands.ts`. Render-only — never in `plan.props`; board
  textures are cached across arena rebuilds and redrawn once Geist loads.
- `app/utils/palette.ts` — the brand palette (`PALETTE` / `PALETTE_HEX`), shared
  with the 2D UI and the generated art. Use it instead of hardcoding accents.

## Invariants & context

- **API reference lives in the `nuxt-tresjs` skill** (`.claude/skills/nuxt-tresjs/`):
  it routes to the vanilla three.js skills, the bundled TresJS docs, and the
  global `nuxt` skill, and lists the known inaccuracies in the three.js skills.
  This file stays the source of truth for the project's own rules.
1. **Client prediction uses the SHARED kinematics** (`shared/utils/maze.ts` →
   `stepBody`, collision, elevation). Do not reimplement physics in a component —
   call the shared functions so prediction matches the authoritative server. New
   physics ⇒ ask `world-sim`. **Reconciliation is input-aware, not a naive lerp:**
   in the render loop we ease the predicted body toward the server only
   *perpendicular* to travel (and forward to catch up) while driving — never
   backward into it — and freeze small disagreement while idle. A plain
   "always ease toward `self`" blend brings back the rubber-band-into-invisible-
   walls and the release-a-key glide; keep the `RECONCILE_*` split intact.
2. **No geometry over the socket.** The arena is built locally from
   `generateHub()` plus the committed layout JSON. Only player snapshots
   (`state`) arrive.
3. **Day/night + weather are driven by the server clock** (`welcome.now`), not
   local time — keep them synced so all players see the same sky. The arena runs
   the full cycle; don't pin it to a fixed time of day.
4. **The arena is the Ruins + Castle kits, composed as rings.** Ground arcade of
   `Arch_Round` + `Column_Round` (torches and alternating `Flag_Wall` between),
   a continuous rake of stepped seating slabs rising up-and-back *behind* the
   arcade, an arched upper wall, and statues flanking the door. Rotation is
   "front (+Z) faces the arena centre". Collision never comes from any of this —
   it's the tile ring in `world-sim`'s `generateHub`, so a piece moved for looks
   changes nothing the server simulates.
5. Characters play idle/run/jump/dash from state (mapped to the shared library's
   `Idle_Loop`/`Jog_Fwd_Loop`/`Jump_Loop`/`Sprint_Loop`), per-player assignment +
   accent tint. Mid-air crossfades are only lightly verified — tune timescale/
   crossfade if they look off.
6. **Load only what the arena draws.** `ARENA_KINDS` is every kind referenced by
   `plan.props` plus `composeColosseum()`, and `arenaOnly()` filters each catalog
   list through it, so play never waits on the ~200 kit models the arena doesn't
   use. In editor mode (`EDITING`) that filter is bypassed and every catalog
   loads, because the whole palette must be placeable. Wave 1 (`PROP_NAMES`)
   paints the arena; wave 2 (`PROP_DECOR_NAMES`, `CASTLE_NAMES`, and in the
   editor the rest) triggers a second `buildFloor` — `instantiateModule` returns
   `null` until a template loads, so late pieces pop in on that rebuild.

## Known rendering gotchas (from ROADMAP)
- **Arena props render instanced, not cloned.** `renderPlanProps` batches
  `plan.props` into one `InstancedMesh` per kind via `instantiateModule`. The
  editor filters `hand`-flagged props out of that batch (its `editor` prop) and
  renders its own selectable clones instead. Prop template clones **share
  materials** with the template (`clone(true)`), so a selection highlight must be
  a `BoxHelper`, never a material tint (tinting would recolor every clone of that
  kind).
- **The colosseum is data-driven, not procedural at render.** `composeColosseum`
  (pure `{kind,x,y,z,rot,scale,s3?}` pieces via an `emit` collector) is the single
  source the editor bakes into `hub-structure.json`. Once baked, those pieces flow
  through `plan.props` and render via the instanced solids loop (`propMatrix`
  honors `z` elevation + `s3` per-axis scale); `composeColosseum` is then only the
  bake input. Pre-bake, `renderComposed(composeColosseum())` is the normal-play
  fallback (visual only, no collision). Editor mode never uses that fallback —
  `MazeScene`'s `onMounted` seeds the editable structure layer from
  `composeColosseum` so the controller's clones own the arena. Only the sand, the
  rune circle and the backdrop shell stay procedural always.
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
