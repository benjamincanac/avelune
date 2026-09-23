---
name: scene-3d
description: >
  TresJS / three.js rendering — the 3D game view and everything drawn in it.
  Use for the chunk-streamed scene and its camera boom, client prediction and
  reconciliation, sky/day-night cycle + weather, instanced architecture and
  terrain, character model playback, the Oracle rig, the map painter, the
  crosshair build tools, the procedural sound layer, and the dev world editor's
  3D side. Components: GameScene.client.vue (input + renderer host),
  MazeScene.vue (the scene, the camera, prediction), MiniMap.vue,
  CharacterPreview* model components. app/utils: courtyardSky, courtyardScene,
  courtyardAssets, courtyardTextures, courtyardLandscape, courtyardRenderer,
  terrainChunk, chunkProps, surfaceColors, materialTextures, townMaterials,
  foliage, shadows, graphics, cityMoat, fortifications, critters, the four
  fountain modules, buildTools, mapDraw, hubEditor, characterModels,
  characterAnimation, characterRim, appearance, palette, and audio/. Also what
  the Escape menu's Graphics tab drives, though game-ui owns that tab's markup.
model: inherit
---

You own everything Avelune draws in 3D. In play the world is **streamed**: the
scene renders `useWorld`'s chunks and predicts motion over them, and generates
nothing of its own. The dev editor is the exception — it builds its own local
world from the seed and the committed layout JSON, because it authors them.

## Files you own
- `app/components/GameScene.client.vue` — the client-only wrapper: it hosts the
  Tres renderer and owns all input (raw-delta mouse-look into `view.yaw`,
  pointer lock, the movement keys, the tool and map keys). It does not move the
  camera and does not simulate: `clipBoom` and `stepBody` are `MazeScene`'s, and
  fullscreen `F` is `play.vue`'s. Contract with
  `game-ui`: it emits `unlock` when pointer lock drops without us initiating it
  (not Alt-cursor mode, document still focused) — that transition IS the
  "player pressed Escape" signal, because the browser swallows the Escape
  keydown entirely while locked; `play.vue` opens the game menu on it. Gotcha:
  Chrome refuses re-lock for ~1.25s after an Escape-exit, so a failed
  `requestLock()` is normal — clicking the world recovers.
- `app/components/MazeScene.vue` — the town: the walled streets, moat and
  terrain surrounding the playable space, the
  per-chunk instanced batches built from each chunk's `placements`, the Oracle
  rig, and the sky/day-night + weather clock. It also owns the third-person
  camera (the polar boom, `clipBoom`, the shoulder offset), local prediction and
  reconciliation. It forwards the four chunk
  hooks (see **Chunk rendering**), and it is what
  aims and sends the hotbar's verbs (see **Crosshair targeting**).
- `app/components/scene/` owns rendering lifecycles: `WorldChunks` manages chunk
  batches and streaming subscriptions, `OracleCharacter` loads and animates the
  Oracle, `CharacterNameplate` owns its canvas texture, and `PostProcessing`
  owns the composer. Use shallow refs/collections for Three objects. Tres templates
  attach cameras, lights, rigs and batch roots; frame callbacks mutate transforms
  directly. Borrowed primitives use `:dispose="null"` and explicit owner cleanup.
  Signal topology changes after `nextTick` so shadow/GTAO scans see attached nodes.
- `scene/Players.vue` reconciles the plain network roster into keyed `Player.vue`
  components and owns their shared blob geometry/texture and outfit material pool
  (`app/utils/playerResources.ts`). Each `Player` owns its cloned skeleton, mixer,
  outfit lease, nameplate, contact-shadow material, chat bubble and body audio.
  `MazeScene` calls `Players.update(PlayerFrame)` after prediction/camera placement
  and before water/grass consume rendered coordinates; `Player` interpolates peers
  and updates transforms directly, without reactive per-frame state. Replacement
  roster objects and appearance changes remount a player. Dispose children before
  the shared pool and renderer; ignore asynchronous loads after unmount.
- `app/utils/courtyardSky.ts` owns the atmospheric dome, volumetric clouds,
  stars, Milky Way and moon, outdoor lights, fog, rain, lightning and sky
  environment. The sky dome draws after opaque geometry at far-plane depth,
  allowing covered pixels to reject the cloud raymarch. All animation follows the server clock, lightning included
  (`courtyardLightning` hashes strikes off `now`, so clients agree). The moon
  stays opposite the sun because the night key light and its shadows come from
  there; its phase is only a terminator drawn on the disc. Stars and the galaxy
  are added after the cloud march, veiled by its transmittance cubed, or bloom
  lifts them through the clouds. A sky-only 256px cube refreshes when the sun
  or the overcast has moved, at most every 2.5 seconds, for reflections on
  physical materials. The water surface uses a separate guarded planar
  reflection pass.
- `app/utils/courtyardAssets.ts` creates the custom town templates, merges geometry
  by material and registers them for both instancing and editor selection. Shared
  dimensions come from `shared/utils/courtyard.ts`.
- `app/utils/pavingGeometry.ts` owns the repeated stone's 44-triangle chamfered
  box. Keep its dimensions, level top, closed surface and outward winding. A
  subdivided rounded box costs 300 triangles per stone across thousands of
  instances, then repeats that cost in every scene/shadow pass.
- `app/utils/courtyardScene.ts` owns paving, gardens, the sparring circle, distant
  animated pennants and fountain placement. `fountainWater.ts` owns gravity driven
  continuous ballistic jets, droplets, impact splashes and the basin surface.
  The eight spill outlets follow the lily bowl low points; `fountainFlow.ts`
  supplies discharge-conserving ballistic parcels and breakup timing. Match
  `FOUNTAIN_FLOW` lip dimensions to `build_courtyard_fountain.py`.
  Jet cross sections shrink with speed to preserve discharge. `fountainSimulation.ts`
  is the bounded circular shallow-water solver behind each bowl, fixed timestep at
  a CFL bound and visual only. Impacts sample the moving surface, transfer vertical momentum
  and generate foam transported by the surface flow. `fountainSurface.ts` uses
  disposable Reflector targets, water Fresnel and animated fine normals.
  Its full grid is clipped to each circular bowl in the shader. Exclude surfaces
  from GTAO overrides, hide other pools and sprites during reflection, and guard
  against recursive reflection renders. Its Reflector target is 512 for a bowl
  wider than a unit radius and 256 for the rest, and is disposed with the pool.
  Keep normals correct under nonuniform scale. `fountainCapture.ts` limits captures
  to 30 Hz nearby, 10 Hz beyond 12 units, then 400ms beyond 48 and 1500ms beyond
  96, including moving views: from outside the gate the pool is behind a wall but
  still passes the frustum test, and a capture is two more renders of the town.
  Camera identity, projection or pool transform changes force an immediate
  capture. Refraction stores the captured world-to-clip matrix alongside the
  image; sampling with the live camera matrix would make cached imagery slide as
  the camera moves. The refraction pass narrows the camera's far plane to just
  past the pool, which is safe because a perspective projection's x, y and w rows
  do not depend on `far` and the shader only samples `xy / w`. Put `far` back
  before `captured()`: the schedule remembers the projection it captured with,
  and a narrowed one never matches the live camera again, which reads as a
  capture every frame. Do not try the clamp on the reflection: Reflector replaces
  the projection's third and fourth rows with its oblique clip plane, which
  throws the far plane away, so it costs the same frame and buys nothing.
  Shared player collision uses the stepped basin and central pedestal from
  `FOUNTAIN` in `shared/utils/courtyard.ts`. Pass predicted self and interpolated
  remote feet through each fountain inverse transform for cosmetic wakes; water
  must never move players. Dispose each water effect separately before generic scenery disposal. `courtyardLandscape.ts`
  is now only the grass bank: one shared blade geometry and GPU wind material that
  both the chunk meadows and the town's garden beds instance from. Its wind is three
  layers (a directional sway, gusts gated by a drifting value-noise envelope over
  world xz, per-tuft turbulence), all phased off the instance origin in *world*
  space — `modelMatrix * instanceMatrix`, because chunk meshes sit at the chunk
  origin and their instances are chunk-local — and all scaled by height squared so
  roots stay planted. Displacement is computed in world units and folded back
  through the instance frame's transpose, so a push is the same size whatever the
  tuft's scale. A patch's `instanceColor` is data, not a tint: rank (index over
  count), and the `lush` and `straw` weights `meadowCover` in `terrainChunk.ts`
  reports for the ground under the tuft. The shader rebuilds the terrain's own
  pigment from them (`MEADOW_PALETTE`), so blades grow out of the ground's colour;
  change `groundColor` and the grass follows only if `meadowCover` still describes
  it. The vertex `color` attribute is data too: height along the blade and a
  per-blade shade. Density thins with distance by rank: a tuft shrinks away once
  the share kept at its distance drops under its rank, and `updateGrassLod` (called
  per mounted patch each frame) trims `mesh.count` to the share kept at the patch's
  nearest point, which is safe only because `chunkGrassBlades` emits tufts in hashed
  order. The share is scaled by the `grassDensity` and `grassRange` uniforms the
  graphics settings write (`setGrassDetail`), and `updateGrassLod` reads those same
  two objects: the count is trimmed in rank order and the shader shrinks by the same
  rank, so a CPU-side cut the shader did not make snaps tufts away at full size.
  Both streamed and garden patches run this LOD. Fully faded patches submit zero
  instances only when their padded world bounds are beyond the shader fade end;
  update parent transforms first and retain the padding for wind and body pushes.
  `DoubleSide` flips the upward normal on back faces, so the fragment hook
  flips it back. Bodies bend blades away through `setGrassPushers(actors, x, z)`:
  the uniform is module-level, not per bank, because the chunk meadows and the
  garden beds each build their own bank and both must react to the same bodies.
  `MazeScene` feeds it the rendered player positions it already assembles for the
  fountain wakes, nearest four; the push only fires when the feet are within
  `PUSH_CONTACT` of the blade's root, so a jump releases the grass. Blades dissolve
  between `GRASS_FADE_START` and `GRASS_FADE_END` (50→62 units from the camera,
  both scaled by `grassRange`) with a screen-door dither discard and a shrinking
  height, which must stay inside `MazeScene`'s detail ring or grass pops in instead
  of fading. That ring is a graphics setting now (`detailRadius`, one chunk on the
  low level), so the two move together and `scripts/graphics-test.ts` holds them. The patch
  bounding sphere is padded for that displacement, or edge patches cull while their
  blades are still on screen. Botanicals are the
  Quaternius Stylized Nature MegaKit under `public/models/nature/` (`NATURE_NAMES`,
  29 entries: `tree1..5`, `pine1..3`, `twisted1..3`, `dead1..3`, `bush1..2`, `fern`,
  `clover`, `plant`, `flowers1..2`, `mushroom1..2`, `pebble1..3`, `rock1..3`); outside
  the walls they are real chunk placements from `shared/utils/vegetation.ts`, not
  decoration. Their leaves are alpha-cut cards (`alphaMode MASK`): every batch that
  carries one is tagged `userData.foliage` and `courtyardRenderer` hides those during
  the GTAO normal pass, otherwise every card occludes as a solid quad.
  `townMaterials.decorate` skips any material that already has a `map`, so the kit's
  bark keeps its texture. Pass authored placements into `createCourtyardScene` so
  garden plants are excluded beneath rotated building footprints. `courtyardTextures.ts`
  owns the runtime pigment maps. Dispose this scenery when rebuilding the floor.
- `app/utils/composeColosseum.ts` and `app/utils/textures.ts` have no call sites
  left anywhere in `app/`, `shared/` or `server/`. The first is the legacy
  colosseum composition, which the current map does not use, nor the old
  `hub-*.json` layouts. The second is the old procedural canvas stone, replaced
  by `courtyardTextures.ts` and `materialTextures.ts`. Do not reach for either
  when adding a surface.
- `app/utils/hubEditor.ts` — the dev-only world editor's 3D controller (fly
  camera, ground raycast, click-to-place / select / drag, keyboard nudges). Owns
  its own `editorGroup` on the scene root and renders selectable per-prop clones;
  the Oracle rig itself (via a `getOracle` getter, since the scene builds it
  lazily) is picked, dragged and rotated the same way, writing `doc.oracle`
  `{x, y, rot}` live. Driven by `useEditor` state and mounted by `MazeScene`
  when its `editor` prop is set (dev-only, tree-shaken from prod).
  The 2D palette/inspector is `game-ui`'s `EditorPanel.vue`.
- `app/utils/mapDraw.ts` is the map painter, and the only place a map is drawn.
  Ground colour comes from each chunk's surface raster and walls from
  `occupancyGrid(chunk)` (from `world-sim`), one chunk at a time over the window
  the caller passes. That window is a zoom level, chosen by the caller and
  unrelated to `COURTYARD`. Inside the protected *footprint* (`isProtectedTile`) the raster is
  a uniform `path` placeholder, so the town square and the meadow around it are
  coloured from the town constants instead; outside it, the rest of a town chunk
  included, the raster is real and shows what players have painted. Nothing is
  fogged. `paintWorld` is the ground, with `paintChunkGrid`, `paintTownOutline`,
  `paintPlots`, `drawPlayerDot` and `drawSelfArrow` layered over it.
- `app/components/MiniMap.vue` — square 214px minimap (top-right), north-up
  and centred on you, with a mono bar beneath it carrying your tile coordinates
  and the loaded chunk count. It only picks the window (`SIZE`, `RANGE`) and
  redraws on an interval; `mapDraw` does the drawing, which is what keeps it from
  drifting apart from `game-ui`'s full-screen `WorldMap.vue` (`M`, state in
  `useWorldMap`, key and pointer lock in `GameScene`), the other caller of the
  same painter.
- `CharacterPreview*.client.vue` — model preview rendering for onboarding
  (coordinate visuals with `game-ui`, which owns the surrounding UI). Framing is
  `CENTRE` (0.66) and `DISTANCE` (4.9) in `CharacterPreviewModel`, in world units
  and deliberately *not* scaled to each figure's own height: backing the camera
  off in proportion makes a taller character render smaller, which is exactly
  backwards. A fixed frame is what lets the male peasant's 1.84 read as taller
  than the female's 1.78. `CENTRE` is the height the camera looks at, with the
  eye 0.15 above it at `DISTANCE` out, so the figure is read from very slightly
  above, under two degrees down. `CENTRE` is what puts the feet
  72% down the frame, which is what clears the summary line and the name field
  stacked below. The floor is a textured disc in
  the scene at y = 0 (`floorTexture()` in `CharacterPreviewModel`), not CSS in
  the gate: only a disc in perspective wraps both boots, a flat rule across the
  stage cut through whichever foot stood nearer the camera.
- `app/utils/gltfResources.ts` pools embedded GLB textures by image bytes plus
  sampler, transform and color-space state. The world template loader also pools
  equivalent raw materials before shader decoration. Character assets pool textures
  only, for the lifetime of their module cache. World template pools are scene-owned:
  `releaseTemplates` skips pooled materials/textures, and the pool disposes each once.
  Keep critter and Oracle loaders separate unless their cleanup adopts this ownership.
  Late loads after teardown retain caller ownership. Shader hooks, names used for
  decoration, and differing texture settings must stay distinct.
- `app/utils/characterModels.ts` owns the serialized GLB loader and shared
  scene/clip cache for both onboarding and the live game. `CharacterAsset`
  carries a scene template and the universal animation library's clips.
  `preloadCharacterAssets()` warms the default model first, then the remaining
  roster and outfit textures. Only the **parse** is serialized: downloads are
  plain `fetch`es that run ahead of it, three at a time for the preloader, and
  the clip library is always requested before the model. Starting the whole
  cast at once filled the browser's six connections per host, `animations.glb`
  queued behind 18 models and no rig could show until it landed. The clip URL
  carries `?v=CLIPS_VERSION`: bump it whenever the clip set changes, Nitro dev
  sends no `Cache-Control` and the browser keeps the old file for hours.
  Every rig uses `SkeletonUtils.clone`; dispose its
  skeleton's GPU bone textures when replacing or removing the rig, but retain
  the cached template geometry and materials.
- `app/utils/appearance.ts` — the runtime outfit colorway swap: replaces
  `material.map` on the cloth materials only (`MI_(Peasant|Ranger|Knight|Noble|
  Wizard)`, matched on the prefix so the importer's `.001` suffix still hits),
  with scene-owned, reference-counted variants keyed by source material and
  outfit URL. Rigs release leases; the last user disposes the variant while the
  texture cache keeps its map. Onboarding previews still own isolated clones.
  It also clears the clone's `userData.characterRim` guard, so the rim hook
  reinstalls on the clone.
- `app/utils/characterAnimation.ts` — the clip blend timings: `animationBlendDuration`
  and `locomotionTransitionTime`, which is where the sprint/jog footfall phase is
  preserved (see **Sprint gait transitions**).
- `app/utils/characterRim.ts` — the character rim light hook (`setCharacterRim`
  moves the key direction per frame, `applyCharacterRim` patches a rig's
  materials), guarded by `userData.characterRim`.
- `app/utils/foliage.ts` — `applyFoliage`, the leaf-card wind hook, guarded by
  `userData.foliageShader`.
- `app/utils/shadows.ts` — `createCascadedShadows`, the CSM the sky drives. Every
  "CSM registration" and "cascade update" warning in this file is about this
  module's `csm.shaders` map. `setQuality(mapSize, maxFar)` is the graphics
  settings' way in: dropping a light's `shadow.map` makes three reallocate it at
  the new size, and a new `maxFar` has to `updateFrustums`. Turning shadows *off*
  is not here and must not touch `castShadow`: it is `renderer.shadowMap.enabled`
  (the canvas's `shadows` prop), which leaves `NUM_DIR_LIGHT_SHADOWS` positive so
  CSM's patched light loop falls into its no-shadowmap branch and still lights the
  town. Clearing `castShadow` instead would drop that branch and leave the world
  lit by ambient alone. `createCasterRange` is the one thing here that does write
  `castShadow`, per object and never as an off switch: a caster stops casting
  past thirty times its own radius (floored at 20 units), which is where its
  shadow is a couple of texels on a cascade covering the whole town. It only ever
  switches off what `tagSceneShadows` already switched on, so the batches that
  deliberately cast nothing stay off, and it rebuilds its list on
  `scene.userData.version`. That counter is load bearing for two things now:
  anything that adds or drops a caster has to bump it, or the new mesh is never
  ranged and the old one is held alive by the list.
- `app/utils/graphics.ts` — the quality tables: what each preset writes and what
  each detail level costs. Plain data, no Vue, so the test suite can import it.
  `useGraphics` (game-ui's) owns what the player picked; this owns what a pick
  means.
- `app/utils/surfaceColors.ts` — `SURFACE_COLORS`, indexed by `SURFACE` for the
  map, and `TERRAIN_TINTS`, the blend targets `terrainChunk`'s `surfaceTint`
  lerps toward. The tints are keyed by pigment name, not by surface, so one
  tint can serve several surfaces: a new `SURFACE` value needs a
  `SURFACE_COLORS` slot and a `surfaceTint` case, and only a new tint target
  needs an entry here. Grass appears in neither table as a tint because it is
  the untinted base colour, and `mortar` is a target nothing currently reads,
  since `surfaceTint` leaves a `path` tile alone.
- `app/utils/palette.ts` — the brand palette (`PALETTE` / `PALETTE_HEX`), shared
  with the 2D UI and the generated art. Use it instead of hardcoding accents.
- `app/utils/audio/` and `app/composables/useAudio.ts` — the whole sound layer
  (engine, named one-shots, ambient beds, footstep cadence) and the player's
  volume and mute, persisted in `localStorage`. You own the engine and what the
  mixer does; `GameMenu.vue` is `game-ui`'s file and it owns the markup the
  sliders sit in, so a new control is a change on both sides of that seam.
  The engine carries a third bus beside `world` and `ui`: `voice`, for other
  players' speech, with its own level so a person can be heard over the wind. The
  voice graph itself (`app/utils/audio/voice.ts`), `app/utils/voice/` (the Opus
  codec, the jitter buffer, the clip recorder) and the rest of proximity voice
  belong to `game-ui`; this slice's `scene/Player.vue` frame update puts each
  talker's panner at their rendered rig, at mouth height. It
  follows the *rendered* body, not the authoritative one, for the same reason the
  footsteps do: the body you can see has to be the body you hear.
- `app/composables/useAssets.ts` is `game-ui`'s, because the loading gate is what
  reads the counts. Scene code is the only thing that writes it: hand every model
  load to `track`, and a failed load still has to settle, or a missing GLB keeps a
  player out of the world.

## Invariants & context
1. **Client prediction uses the SHARED kinematics** (`shared/utils/maze.ts` →
   `stepBody`, collision, elevation). Do not reimplement physics in a component —
   call the shared functions so prediction matches the authoritative server. New
   physics ⇒ ask `world-sim`. **Reconciliation is input-aware, not a naive lerp:**
   in the render loop we ease the predicted body toward the server only
   *perpendicular* to travel (and forward to catch up) while driving — never
   backward into it — and freeze small disagreement while idle. A plain
   "always ease toward `self`" blend brings back the rubber-band-into-invisible-
   walls and the release-a-key glide; keep the `RECONCILE_*` split intact. The
   nudges are applied with the shared `slideBody`, never added to `local.x/y`
   raw: the line to the server's position can cut a building's corner, and a
   centre inside a footprint is snapped onto the roof by the next `stepBody`.
2. **The world arrives over the socket; nothing is generated here.** Chunks,
   their heights, their surface raster and their placements all come as frames
   and land in `game-ui`'s `useWorld`. `MazeScene` and `MiniMap` read that one
   world — never their own `createWorld()`, except in editor mode.
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
7. `courtyardRenderer.ts` builds the render loop's EffectComposer with contact
   occlusion, restrained bloom and one OutputPass. It takes a `RenderQuality` at
   build time. `PostProcessing.vue` rebuilds it when occlusion or bloom change
   (there is no MSAA on the target, SMAA ends the chain); resolution and shadow changes preserve the composer and its targets.
   Call Tres's render notification
   after rendering. Tres tears down its separate Vue tree after disposing the
   renderer, so `MazeScene` emits its idempotent cleanup callback to `GameScene`.
   The host calls it in `onBeforeUnmount`, while GPU resource tables still exist.
   Child-only cleanup can crash when disposing the sky cube target. Chunk and
   garden instances borrow template geometry and cached materials, so dispose only
   their instance buffers; `createCourtyardScene` keeps its borrowing meshes in a
   `planting` group it removes before the generic scenery sweep, and never disposes
   those borrowed resources.
   Courtyard disposal hides and empties its root before Vue replaces it, and is
   idempotent. Leaving disposed children drawable during HMR can re-upload their
   resources or render stale shader uniforms; Vue still owns root detachment.

## Known rendering gotchas (from ROADMAP)
- CSM uses two cascades. Material scans follow `scene.userData.version`, updated
  after attachments, instead of a periodic scene traversal. Quality changes update
  both light map sizes and `csm.shadowMapSize` (used for texel snapping).
  Disposed materials unregister from CSM's strong shader map immediately. On
  teardown, restore shader hooks and their original rim/foliage guards together: retaining a
  hook while deleting its guard injects duplicate uniforms on the next mount.
- GTAO's normal override ignores sprite alpha maps. Hide sprites only during
  the occlusion pass and restore their visibility afterward, or nameplates cast
  rectangular panels as the camera turns. Exclude the `courtyard-atmosphere`
  dome too, since it has no world surface for the normal pass. Text sprites also disable depth writes
  while retaining depth testing against the world.
- Leaf cards never cast. An alpha-tested depth material costs a tiled GPU its
  hidden-surface removal, and taking the cards out of the cascades was worth ten
  frames a second in the town, far more than their triangle share.
  `createCanopyShadow` in `foliage.ts` gives each foliage batch an 80 triangle
  ellipsoid that shares its instance matrices, writes neither colour nor depth,
  and casts through the plain depth material. It is `gtaoExclude` because the
  occlusion pass overrides materials and would draw it solid. Any new alpha-cut
  batch has to set `castShadow = false` with `shadowTagged`, or `tagSceneShadows`
  puts the cards back in every cascade.
- GTAO's normal pass is ranged like the shadow casters: a leaf mesh further than
  thirty times its own radius (floored at 20 units) is hidden for that pass
  only, through the same hide and restore as the exclusion list. `ranged.ts`
  holds the measuring both passes share. Both are ranged from the player, which
  `courtyardSky` publishes as `scene.userData.rangeFocus`, never from the lens:
  the boom orbits a player who is standing still, and measured from the camera
  every mesh near its boundary came and went as the view swung round.
  `RANGE_SLACK` keeps a mesh that is in range a little past the line for the
  same reason. A hidden mesh also drops out of the
  pass's depth, so keep the rule to things whose contact shading is a pixel or
  two at that range, and check a change to the numbers with a frame diff.
- **Chat bubbles are DOM, not sprites.** `scene/Player.vue` projects each speaker's
  head anchor in the frame loop and moves a `.chat-bubble` element (styled in
  `main.css`) inside a layer appended next to the canvas. Do not put them back on
  a `CanvasTexture`: three allocates texture storage once, so a canvas resized for
  a longer message never re-uploads and the bubble keeps showing the previous
  line. Nameplates stay sprites because their canvas never changes size.
- **Props render instanced, not cloned.** `app/utils/chunkProps.ts` batches each
  chunk's placements into one `InstancedMesh` per kind per chunk via
  `instantiateModule`. The
  editor filters `hand`-flagged props out of that batch (its `editor` prop) and
  renders its own selectable clones instead. Prop template clones **share
  materials** with the template (`clone(true)`), so a selection highlight must be
  a `BoxHelper`, never a material tint (tinting would recolor every clone of that
  kind).
- The courtyard is data-driven. The editor saves `courtyard-structure.json`,
  `courtyard-props.json` and `courtyard-oracle.json`. Both play and editor use
  the same custom templates. The legacy colosseum `hub-*.json` files are deleted.
- Pointer lock throws `WrongDocumentError` inside the Claude preview iframe; real
  tabs/deploy are fine. A delta-look fallback covers embeds — keep it, and keep
  it **gated on `steering`**: the raw-delta path is the embed fallback only.
  Steering an unlocked cursor in a normal tab looks like working mouse-look
  right up to the window edge, where the deltas stop and the camera sticks, and
  it hides the fact that a click is what starts mouse-look at all. So nothing
  steers before the lock in a lockable browser, the OS cursor stays visible
  until then, and where the lock really is refused an edge band keeps the turn
  going once the cursor runs out of window. The lock is asked for with
  `unadjustedMovement: true`, retried plain on rejection — Chrome rejects that
  option rather than ignoring it, and a rejection there is not a refusal.
- Camera boom samples the wall grid and shared solid prop heights along its
  width. It uses conservative clearance for the head-to-camera path.
- The camera's pivot does not sit on the feet. `stepBody` snaps a grounded body
  onto each tread, so a grounded change in height no taller than `STEP_MAX` is
  taken out of the pivot (`stepTrail` in `MazeScene`) and paid back over a few
  frames. Jumps, falls and teleports are followed exactly, so do not smooth
  `local.z` wholesale to fix a jolt: a jump stops reading as one.
- `clipBoom` tests each sample at the height the sight line has there, from the
  pivot up to the seat. One flat height for the whole run jammed the camera on
  stairs: going down, the treads behind pass a flat line within a tread or two.
  A steep tile is not a wall to the boom the way `isWalkable` has it, only
  ground to clear; the world's edge and an unloaded chunk still stop it. The
  boom is kept as a share of the seat's reach (`boomClear`), because the reach
  shortens as pitch steepens and a shorter boom is not a blocked one, and it
  holds for `BOOM_HOLD` before easing out so a run of treads does not pump it.
- When bare terrain blocks the boom the camera rises instead of closing in
  (`pitchFloor`): at the bottom of a dug pit every seat behind the player is
  inside the pit's wall. It is a floor under the player's pitch, never an amount
  added to it: added, the two stacked, and a player tilting down into a pit was
  carried on up to the overhead seat, which closes the boom in on purpose.
  Ground only. The label comes from the blocked sample,
  flanks included, and only ever on a block `surfaceHeight` found: the moat is
  carved out of terrain that still reads as level, so `terrainHeight` alone
  would wall the channel off. Walls and roofs still pull the boom in.
- `.client.vue` suffix / `<ClientOnly>` matters: three.js is browser-only, never
  let scene code run during SSR.
- **Character GLBs carry `EXT_texture_webp` textures** — the top-level
  `texture.source` is intentionally undefined; the real image lives in the
  extension. three's WebP-support probe is per-parse, so a *cold* batch of
  concurrent `loadAsync` calls races it, and the not-supported fallback crashes
  reading `.uri` of the missing source. Load a multi-character roster
  **sequentially** (the first model warms WebP, the rest decode reliably) — see
  `preloadCharacterAssets()` in `characterModels.ts`, which walks the whole roster
  one at a time. Both the live scene and preview use the same serialized loader,
  including requests that arrive while background preloading is running.

## Working style
Prefer instancing for repeated architecture. Keep per-frame work lean. When you
change a visual driven by shared state, confirm the data actually arrives in the
frame you expect (`state` only includes players that moved).

## Shared weather commands

`/weather clear|overcast|rain|auto` changes the shared server weather mode.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto` independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.

## Expanded town layout

`COURTYARD` bounds and `TOWN_STREETS`, `TOWN_GARDENS`, `TOWN_DISTRICTS` are
shared authored data in `shared/utils/courtyard.ts`. Ground, plant exclusion,
outer terrain and minimap must follow these values, never the old 40-unit square.

## Fortified city boundary

`FORTIFICATIONS` in `shared/utils/courtyard.ts` defines the wall, moat, bridge and
walkable exterior. `COURTYARD` remains the inner city bounds. Moat tiles are traversable with a submerged floor from `shared/utils/moat.ts`;
bridge support depends on foot height so the channel remains open underneath.
The outer-bank stair is the route back to ground level. Narrow bridge rails
use shared prop collision and movement substeps. Rendering must cut the terrain at the exact moat bounds
and keep decorative trunks and relief outside the exterior bounds.

The patrol gallery is authored, not generated. `Courtyard_Gallery`,
`Courtyard_Stairs` and `Courtyard_Rail` are world-sized templates built in
`app/utils/fortifications.ts` beside `Courtyard_Rampart`, so they instance
through the normal prop path in play and become selectable clones the editor
moves like any other prop. Their local frames follow the shared dimensions: the
gallery slab hangs below its origin so the placement `z` is the walking surface,
the rail box rises from its origin so the placement `z` is its bottom, and the
stairs are centred on their ground footprint and climb toward local +z. Elevated
galleries preserve ground underpasses; shared movement selects surfaces by foot
height, and every stair tread must match the shared step count.

`townMaterials.ts` owns a texture bank per mounted world and projects the maps
from `materialTextures.ts` in world space, including instanced GLBs without UVs.
Apply it to environment materials only. Do not replace foliage, glass, water or
character shaders. The bank survives floor rebuilds and is disposed after scene
and template cleanup. Shader color samples use sRGB textures; normals and
roughness remain linear.
Three material cloning copies `userData` and `defines` but drops
`onBeforeCompile` / `customProgramCacheKey`. Never copy the source's hooks onto
an instance tint clone: a CSM-patched hook re-registers the clone's shader under
the source material in `csm.shaders` and the source stops getting cascade
updates. Re-install instead — `townMaterials.reapply` reads the
`userData.townMaterial` recipe `apply` leaves behind, `applyFoliage` re-runs, and
the CSM scan (triggered by the scene version after each build and rig attachment) patches
the clone as a material of its own. Clear the `userData.foliageShader` /
`userData.characterRim` guards on any clone, or the hooks they mark never
reinstall. Every town material hook chains the previous one.

Shader clocks are `uniform float`: epoch seconds quantise to 128 s steps, so
`MazeScene` wraps the server clock before it reaches a uniform (grass, foliage,
moat) and passes absolute seconds only to the fountain's particle simulation.

`tagSceneShadows` skips `userData.shadowTagged`, which terrain and grass set
wherever their own cast/receive flags are deliberate. `scene.userData.version` is
bumped on every floor rebuild, chunk mount or unmount, and rig change;
`courtyardRenderer` caches its GTAO exclusion list against it instead of
traversing each frame.

Swimming clips are the library's `Swim_Fwd_Loop` / `Swim_Idle_Loop`, exported
by `scripts/rebuild_animations.py` into the shared `animations.glb` as
`Swim_Loop` / `Swim_Idle` with a baked pelvis lift so the body rides the waterline.
Select Swim_Loop/Swim_Idle from shared `getSwimmingContact`, before dash and
airborne clips. Moat wake rings are cosmetic and excluded from GTAO.

## Sprint gait transitions

`Sprint_Loop` and `Jog_Fwd_Loop` come straight from the animation library and
share normalized footfall phase; preserve that phase in both directions when
blending, and play the sprint at 1x. Resetting it on every dash changes the
supporting leg abruptly.

## Chunk rendering

The world is drawn chunk by chunk. `WorldChunks.vue` keeps a shallow reactive
`Map<chunkKey, MountedChunk>` of `{ group, terrain, props, grass, paving, detail }`;
its template attaches each chunk root. Internal procedural batches remain raw.
It owns the streaming subscriptions and exposes the four hooks the `chunk` /
`unchunk` / `terrain` / `place` and `remove` frames map onto. `MazeScene` forwards
these hooks via `defineExpose`:

```ts
mountChunk(cx, cy, detail = true)   // idempotent; upgrades a mounted chunk's detail
unmountChunk(cx, cy)
refreshChunkTerrain(cx, cy)         // heights or surface changed
refreshChunkProps(cx, cy)           // placements changed
```

In play, `game-ui`'s `useWorld` drives them: `onChunk` mounts (or rebuilds, if
the chunk was replaced by a resync), `onUnchunk` unmounts, `onTerrain` and
`onProps` refresh. A placement can straddle a border, so a `place` or `remove`
refreshes the 3×3 around its chunk, not just its owner. The range follower still
runs alongside, but only to pick the *detail level* by distance — terrain out to
7 chunks (the camera's far plane), props, vegetation and grass in a ring of 2,
dropped at 3 and 8. What it builds per frame is capped by time, not by count:
`MOUNT_BUDGET_MS` is 5 ms of a frame, and the first sync ignores it and fills the
whole view at once, because a horizon that fades in over the first minute on a
slow machine is worse than one long frame at load. Its terrain radius is
wider than the server's 5×5 loaded set on purpose: a chunk it asks for that has
not arrived simply is not mounted, and `terrainHeight` reads `-Infinity` there so
nobody can stand on it. The protected town is always detailed while mounted —
half of it fading out mid-square would read worse than the draw calls.

The town's cosmetic scene (`createCourtyardScene`) is built from the `town:`
placements the town chunks carry, so in play it is rebuilt, debounced, as
those chunks stream in — the whole town is 25 chunks and the spawn's 5×5 does not
cover all of them.

`app/utils/terrainChunk.ts` builds one `Mesh` per chunk from its 33×33 corner
heights, vertices local to the chunk with the mesh at the chunk origin. Normals
are analytic, sampled one corner *past* each edge through the caller's
`HeightSampler` (`cornerHeight` on the world) — per-chunk `computeVertexNormals`
creases every seam. Vertex colour is the meadow's own pigment (moisture, dryness,
the gate approach's wear, scree on steep faces, distance cooling) tinted by the
surface raster, except on protected footprint tiles where the raster says nothing.
Every `SURFACE` value needs a `surfaceTint` case or it renders as untinted grass;
snow's tint is a cool off-white and not white, because the terrain is lit and then
bloomed, and an albedo near 1 clips the summits to a flat sheet at noon. Ground
cover gates on the **surface kind**, never the biome: `isGrassTile` is what keeps
blades, flowers and the cosmetic scatter off flagstones, bare stone and snow alike,
so a generated surface needs no separate exclusion. Each `Record<Biome, …>` table
(`BIOME_SWARD`, `UNDERSTORY`, critters' `RESIDENTS`) must name every biome.
All chunks share one material, so there is one program and one CSM registration.
Terrain receives shadows and casts none (`userData.shadowTagged`), and is *not*
excluded from GTAO.

The protected town renders its terrain too, sunk `TOWN_CLEARANCE` below zero so
every plaza plane in `courtyardScene` — the lowest sits at -0.015 — stays on top
of it instead of z-fighting. **Protection is a tile footprint, not a chunk**:
`isProtectedTile(x, y)` walks three rects, the moat's outer square plus
`TOWN_MARGIN`, the outer-bank stair with that margin on x only and its raw
`zStart`/`zEnd` along the flight, and exactly the tiles
under the gate bridge's landing, and
`isTownChunk(cx, cy)` is only "this chunk overlaps it", used for seeding and for
keeping the town permanently detailed. Every rendering special case is keyed to
the tile, so a town chunk's outer tiles are ordinary meadow that grows grass,
takes its raster's tint and paints its real colour on the map. The clearance ramp
walks outward from each tile until the footprint ends rather than insetting a
square, so it follows whatever shape the footprint has. Moat and moat-stair tiles
are punched out of the index: that channel is real geometry in `cityMoat` and a
flat lid would seal the water off.

`app/utils/chunkProps.ts` also owns `createPavingBank`: the `path` surface is
real road, not a tint. One `Mesh` per chunk, a `BufferGeometry` indexed straight
into the chunk's own 33×33 corner grid, two triangles per `path` tile outside the
protected footprint, every corner lifted `ROAD_LIFT` (0.02) above the terrain's
own height. It follows the ground exactly rather than approximating it, so there
is no per-tile slab to tilt and nothing to bury: the road shares the terrain's
vertices. Normals are central differences through the caller's
`HeightSampler`, so a corner on a chunk border is lit from the neighbour's
heights too, and uvs are world tile coordinates times `ROAD_UV_SCALE` (1/8), so
the stone runs continuous across the seam. The material is `createPaleStone`
(from `courtyardScene`) over a `makeCourtyardSurface('stone')` map, cached once
for the bank. The `RoundedBoxGeometry(0.983, 0.045, 0.983, 2, 0.014)` slab bank
is a different thing: that one is the authored town's own paving inside
`courtyardScene`, instanced, and it is not what a player's road is made of.
The road depends on heights *and* the raster, so `refreshChunkTerrain`
rebuilds it and the chunk's detail (grass, flowers) alongside the mesh,
not `refreshChunkProps`; it is not detail-gated, because a road has to still be
there from the next hill. It receives shadows and casts none
(`userData.shadowTagged`, deliberate so the blanket tagging leaves it alone), and
`isGrassTile` already refuses a non-grass raster, which is what keeps blades and
flowers off it.

`app/utils/chunkProps.ts` owns `instantiateModule` and builds one
`InstancedMesh` per kind *per chunk*, which costs more draw calls than one batch
for the world and is the price of rebuilding a chunk without touching its
neighbours. `TownMaterials.batch` owns variants shared by chunks and authored
gardens, keyed by source material and foliage clock. `MazeScene` passes the same
clock to both. A chunk release or garden rebuild frees instance buffers only;
the world bank disposes variants at scene teardown. Replacing GLB templates
rebuilds mounted batches against the new source identities. Every placement carries its own `z` — render-only elevation
for the authored town, the terrain it grew on for wild vegetation, the support
height the server resolved for a kit piece — so nothing is bedded or offset here.

`buildFloor()` now only rebuilds the town's cosmetic scene, so an editor change
costs one `createCourtyardScene`, not the world. In editor mode the chunk batches
skip placements whose id starts with `town:`; `hubEditor` draws those as
selectable clones.

**Ground scatter follows `biomeAt`, not the chunk.** `chunkScatter` in
`chunkProps.ts` samples `biomeAt(seed, x, z)` per point — the same shared
function `generateVegetation` uses — so a region border runs through a chunk
exactly as the server's trees do: flower drifts in meadow, fungus and low green
cover under pinewood and grove, pebbles on heath. `chunkGrassBlades` reads it too,
thinning and drying the sward per biome through the `lush`/`straw` weights the
blade shader already has. Both are cosmetic, deterministic per chunk and never on
the wire. `NATURE_NAMES` in `courtyardLandscape.ts` is the gate: a tree family the
server plants but this list omits arrives as a placement with no template and
renders as nothing. The per-instance tint is split by family — a warm/cool wobble
for green foliage (`tree`/`bush`/`pine`), brightness only for the autumn-red
`twisted` and the bare `dead` trunks, which greening would only muddy.

**Ambient critters are client-only cosmetics.** `app/utils/critters.ts` spawns
wildlife deterministically per chunk from `(seed, cx, cy)` and the biome at the
spawn point, mounted and unmounted with the chunk's detail level and capped at
`MAX_LIVE`. There is no NPC on the server and this must not create one: nothing
reaches the wire, nothing enters `shared/` state, and a critter can never move,
block or collide with a player. Two players do not see the same bunny in the same
place, and that is accepted. It reads the shared helpers (`surfaceHeight`,
`isWalkable`, `getSwimmingContact`, `hitsSolidPiece`) **read-only**, so a critter
stands on the same terraformed ground as a player, stays out of the water and
keeps its width out of walls. Flyers lift over low clutter (`FLY_OVER`) and treat
anything taller as a wall, they do not take a roof as their ground mid-flight. Off in editor mode.

**Sound is client-only, procedural and never on the wire.** `app/utils/audio/`
owns one engine (a single `AudioContext`, a world bus and a UI bus, a limiter on
the master, a shared noise buffer and a hard voice cap) and every sound is
synthesized: there are no audio files in the repo and adding one is a new
decision. Call sites only ever say `play('footstep', { surface, gain, position })`,
so a graph can become a sample without touching them. Like the critters it is
derived from what the frame already renders and reads shared helpers read-only,
so nothing enters `shared/` state and no sound can move a player. Browsers refuse
a context before a gesture: `useAudio().unlock()` is called from the first click
or key in the arena and every entry point is a no-op until then, which is what
keeps autoplay warnings out of the console. Beds are long-lived voices with
ramped parameters, never rebuilt, because a rebuilt bed clicks. Weather, the
day/night crossfade and thunder come off the server clock (`courtyardWeather`,
`courtyardLightning`), so two players hear the same storm; birds and critter
calls are local decoration and need not agree. The listener is set from the
camera after it has moved, in the same place the boom is resolved. Audio is off
in editor mode, and `disposeScene` closes the context.

The camera boom's obstruction test is three things ORed: the wall grid and
`surfaceHeight` for ground-based geometry, `isRampartCameraBlocked` for the
gallery, and `isPieceCameraBlocked` for elevated kit and wild pieces. The last
two exist because a raised piece's collision band starts at its `base`, which a
ground-height sample never sees — drop either and the boom slides through a
player's first floor.

## Crosshair targeting and the build ghost

`app/utils/buildTools.ts` is the play-mode counterpart to `hubEditor`: no cursor,
no fly camera. The target is a ray from the camera down its own forward axis —
where the crosshair sits — marched against the shared heightfield in tile space
rather than raycast against the terrain meshes, so the highlight can never
disagree with the ground physics reads. Placements are picked by world bounding
box, as `hubEditor` does and for the same reason (sparse geometry a triangle ray
slips between). A kit piece's box is its model's (`KIT_ASSETS`), not its
collision (`pickBounds`): the door has no collision, so it was a 0.8 stub the ray
flew over, and a top face reports the model's height, not `prop.top`, which is 0
for the door. It runs from the render loop *after* the camera has moved, or it
aims a frame behind the view. `scripts/build-aim-test.ts` drives the real tools
with a posed camera.

**The ray takes the first thing it meets, and remembers which face.** Terrain and
piece boxes are both tested and the nearest wins; `faceNormal` reads the entered
face off the box. With a kit piece armed, a hit on a top face targets the same
cell (the shared rules stack it, and on a panel the across-axis coordinate is
taken from the panel so a storey lands on the same edge line), and a hit on a
side face targets the neighbour across that face — half a cell out for a cell
piece, a whisker out for a panel, which lands it on the shared edge. Aiming at a
floor's side therefore puts a wall on that edge, and aiming at a wall's end
continues the run. The ghost is posed from `resolveBuild`'s own placement, not
from the local snap, so its height is the storey the server would give it.

The target also carries `h`, the world height of the hit, and `applyTool` sends
it with the `build` frame: terrain gives its own height, a top face gives that
piece's `top` (the face rule in one number — stack on what you clicked), and
any other face gives the height of the hit point itself, so aiming at the lower
half of an upstairs wall's neighbour resolves to the storey under it rather
than to the roof above. The ghost passes the same `h` to `resolveBuild`, so the
preview already stands where the server will put the piece.

**Nothing under the crosshair is ever out of reach.** A hit past `EDIT_REACH` is
walked back down the ray (bisected, since distance from the actor grows along
it) to the farthest point still in range, less `REACH_SLACK` for the rounding
and snapping that follow; a kit pose that still lands long is pulled in a cell
at a time. Red is therefore a real refusal — protected, claimed, occupied — and
always carries its reason.

**Raw aim on the wire.** `snapPlacement`'s edge snap reads the flip out of the
rotation, so a pose fed back through it snaps somewhere else. `BuildTarget`
carries `rawX`/`rawY` alongside the posed `x`/`y`, and `MazeScene.applyTool`
sends the raw pair; the server snaps, exactly as the ghost did.

**Cursor mode.** While Alt frees the pointer, `GameScene` writes it into
`view.cursorX/cursorY` (NDC) and `MazeScene` hands buildTools a `getPointer`,
so the ray is unprojected through the cursor instead of the screen centre. Only
a click whose target is the world canvas fires the tool, so the HUD stays
clickable.

**Shoulder camera.** Arming a tool eases the boom out to one side
(`SHOULDER_SIDE`), up a little and in a little; disarming eases it back, and `V`
(`build.shoulder`) flips the side. Centred, the crosshair passes through the
character and lands on ground its own back hides. The clipped thing is the
offset seat: the boom direction is `normalize(camera - head)` and `clipBoom`
runs along that, so a shoulder pressed to a wall still comes in. The look target
carries the same lateral offset, or the view axis would toe in at the player's
own ear.

**The boom is a polar orbit, and `view.pitch` is radians below the horizon.** It
used to be an ad-hoc pair (camera up by `pitch * 1.8`, target down by
`pitch * 1.2`) which topped out around 28° at full extension, so the tiles
around the player's own feet could not be aimed at. It now orbits a pivot at
`PIVOT_HEIGHT` and the crosshair looks down at exactly `pitch`. An armed tool
raises the ceiling from `PITCH_MAX` (0.55 rad, ~32°) to `PITCH_MAX_TOOL`
(1.5 rad, ~86°, both in
`useBuild`) — `GameScene` clamps the input, `MazeScene` eases the view back up
when the tool is put away. Steep pitch also shortens the boom by `STEEP_CLOSE`,
or the camera would hang four tiles overhead and the tile under the crosshair
would be a postage stamp; that is also what brings the camera inside
`SELF_FADE_DISTANCE`, where `hideSelfWhenClose` hides the local rig so you can
see your own tile. Use object visibility: materials are shared with other
characters, so changing opacity would fade those characters too. The ray itself never
needed the character excluded — players are not placements, so `propsNear` has
never returned one.

**Hold to repeat.** `build.press()` / `build.release()` mark the left button
down and `MazeScene` re-applies the armed tool every `1000 / EDITS_PER_SECOND`
ms. Raise, lower and flatten repeat on one spot (a step per interval);
everything else needs a new target, tracked as `lastEditKey` and cleared on each
press, so a click on the same tile twice is two edits while a drag across it is
one.

The brush highlight is a small quad whose vertices are re-fitted to the terrain
each frame, so it lies on a slope instead of cutting through it; the demolish
highlight is a `Box3Helper`. The ghost is the armed kit template `clone(true)`
with every material replaced by one shared flat translucent material — the
template's own materials are never touched, and a tint can never leak into other
clones of that kind. Green or red comes from `resolveBuild`, the predicate the
server decides with; the click is sent either way, because the server is the
authority. `MazeScene` loads the kit into the same template map as the nature
kit (`loadTemplates('kit', KIT_NAMES)`), so a placed piece batches through
`chunkProps` like any other placement.

Deed plots are drawn here too. Every claim in the loaded chunks gets a faint
ground-conformed `LineLoop` in its owner's colour (`MazeScene` passes the roster
in as `owner`; a claim it cannot name draws neutral), rebuilt only when the set
of deeds or the ground under them changes — walking past a plot must not cost a
geometry rebuild a frame. The armed `Kit_Deed` adds a bright depth-test-off loop
at the plot the ghost would stake, which is the only way to judge a sixteen-tile
square from inside it. `mapDraw.paintPlots` is the same claim on the full map,
as an outlined square: outlined, because a filled one would bury the ground
colour the rest of the map is made of.
