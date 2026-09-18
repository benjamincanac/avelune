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

You own everything Avelune draws in 3D. In play the world is **streamed**: the
scene renders `useWorld`'s chunks and predicts motion over them, and generates
nothing of its own. The dev editor is the exception — it builds its own local
world from the seed and the committed layout JSON, because it authors them.

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
- `app/components/MazeScene.vue` — the town: the walled streets, moat and
  terrain surrounding the playable space, the
  per-chunk instanced batches built from each chunk's `placements`, the Oracle
  rig, and the sky/day-night + weather clock. It holds the chunk groups and the
  four hooks the streaming layer drives (see **Chunk rendering**), and it is what
  aims and sends the hotbar's verbs (see **Crosshair targeting**).
- `app/utils/courtyardSky.ts` owns the atmospheric dome, volumetric clouds,
  outdoor lights, fog, rain and sky environment. All animation follows the
  server clock. A sky-only 64px cube refreshes every eight seconds for material
  reflections for physical materials. The water surface uses a separate guarded
  planar reflection pass.
- `app/utils/courtyardAssets.ts` creates the custom town templates, merges geometry
  by material and registers them for both instancing and editor selection. Shared
  dimensions come from `shared/utils/courtyard.ts`.
- `app/utils/courtyardScene.ts` owns paving, gardens, the sparring circle, distant
  animated pennants and fountain placement. `fountainWater.ts` owns gravity driven
  continuous ballistic jets, droplets, impact splashes and the basin surface.
  The eight spill outlets follow the lily bowl low points; `fountainFlow.ts`
  supplies discharge-conserving ballistic parcels and breakup timing. Match
  `FOUNTAIN_FLOW` lip dimensions to `build_courtyard_fountain.py`.
  Jet cross sections shrink with speed to preserve discharge. Its fixed timestep wave solver
  is visual only. Impacts sample the moving surface, transfer vertical momentum
  and generate foam transported by the surface flow. `fountainSurface.ts` uses
  disposable 256px Reflector targets, water Fresnel and animated fine normals.
  Its full grid is clipped to each circular bowl in the shader. Exclude surfaces
  from GTAO overrides, hide other pools and sprites during reflection, and guard
  against recursive reflection renders. Keep normals correct under nonuniform scale.
  Shared player collision uses the stepped basin and central pedestal from
  `FOUNTAIN` in `shared/utils/courtyard.ts`. Pass predicted self and interpolated
  remote feet through each fountain inverse transform for cosmetic wakes; water
  must never move players. Dispose each water effect separately before generic scenery disposal. `courtyardLandscape.ts`
  is now only the grass bank: one shared blade geometry and GPU wind material that
  both the chunk meadows and the town's garden beds instance from. Botanicals are the
  Quaternius Stylized Nature MegaKit under `public/models/nature/` (`NATURE_NAMES`:
  `tree1..5`, `bush1..2`, `fern`, `clover`, `plant`, `flowers1..2`, `rock1..3`); outside
  the walls they are real chunk placements from `shared/utils/vegetation.ts`, not
  decoration. Their leaves are alpha-cut cards (`alphaMode MASK`): every batch that
  carries one is tagged `userData.foliage` and `courtyardRenderer` hides those during
  the GTAO normal pass, otherwise every card occludes as a solid quad.
  `townMaterials.decorate` skips any material that already has a `map`, so the kit's
  bark keeps its texture. Pass authored placements into `createCourtyardScene` so
  garden plants are excluded beneath rotated building footprints. `courtyardTextures.ts`
  owns the runtime pigment maps. Dispose this scenery when rebuilding the floor.
- `app/utils/composeColosseum.ts` is the retained legacy composition. The current
  map does not use it or the old `hub-*.json` layouts.
- `app/utils/hubEditor.ts` — the dev-only world editor's 3D controller (fly
  camera, ground raycast, click-to-place / select / drag, keyboard nudges). Owns
  its own `editorGroup` on the scene root and renders selectable per-prop clones;
  the Oracle rig itself (via a `getOracle` getter, since the scene builds it
  lazily) is picked, dragged and rotated the same way, writing `doc.oracle`
  `{x, y, rot}` live. Driven by `useEditor` state and mounted by `MazeScene`
  when its `editor` prop is set (dev-only, tree-shaken from prod).
  The 2D palette/inspector is `game-ui`'s `EditorPanel.vue`.
- `app/components/MiniMap.vue` — square 214px minimap (top-right), north-up
  and centred on you, with a mono bar beneath it carrying your tile coordinates
  and the loaded chunk count. Nothing is fogged; ground colour comes from each chunk's
  surface raster and walls from `occupancyGrid(chunk)` (from `world-sim`), one
  chunk at a time over a fixed tile range that is no longer derived from
  `COURTYARD`. Inside the protected *footprint* (`isProtectedTile`) the raster is
  a uniform `path` placeholder, so the town square and the meadow around it are
  coloured from the town constants instead; outside it, the rest of a town chunk
  included, the raster is real and shows what players have painted.
- `CharacterPreview*.client.vue` — model preview rendering for onboarding
  (coordinate visuals with `game-ui`, which owns the surrounding UI). Framing is
  `LIFT` and `DISTANCE` in `CharacterPreviewModel`, both in units of the figure's
  own height so every character frames the same. `LIFT` pans the eye *and* the
  target down by the same amount — a pan, not a tilt, because tilting
  foreshortens a character the design wants read straight on — and it exists so
  the boots clear the name field stacked below. The gate's ground rule and glow
  are positioned at the matching fraction of the stage (72%) rather than a fixed
  offset from the bottom, or they detach from the feet as the window resizes.
- `app/utils/characterModels.ts` owns the serialized GLB loader and shared
  scene/clip cache for both onboarding and the live game. `CharacterAsset`
  carries a scene template and the universal animation library's clips.
  `preloadCharacterAssets()` warms the default model first, then the remaining
  roster and outfit textures. Every rig uses `SkeletonUtils.clone`; dispose its
  skeleton's GPU bone textures when replacing or removing the rig, but retain
  the cached template geometry and materials.
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
7. `courtyardRenderer.ts` owns the render loop's EffectComposer with contact
   occlusion, restrained bloom and one OutputPass. Call Tres's render notification
   after rendering. Tres tears down its separate Vue tree after disposing the
   renderer, so `MazeScene` emits its idempotent cleanup callback to `GameScene`.
   The host calls it in `onBeforeUnmount`, while GPU resource tables still exist.
   Child-only cleanup can crash when disposing the sky cube target. Chunk and
   garden instances borrow template geometry and cached materials, so dispose only
   their instance buffers; `createCourtyardScene` keeps its borrowing meshes in a
   `planting` group it removes before the generic scenery sweep, and never disposes
   those borrowed resources.

## Known rendering gotchas (from ROADMAP)
- GTAO's normal override ignores sprite alpha maps. Hide sprites only during
  the occlusion pass and restore their visibility afterward, or nameplates cast
  rectangular panels as the camera turns. Exclude the `courtyard-atmosphere`
  dome too, since it has no world surface for the normal pass. Text sprites also disable depth writes
  while retaining depth testing against the world.
- **Chat bubbles are DOM, not sprites.** `MazeScene.vue` projects each speaker's
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
the CSM sweep (`sky.setupShadows()`, called after every build and rig) patches
the clone as a material of its own. Clear the `userData.foliageShader` /
`userData.characterRim` guards on any clone, or the hooks they mark never
reinstall. Every town material hook chains the previous one.

Shader clocks are `uniform float`: epoch seconds quantise to 128 s steps, so
`MazeScene` wraps the server clock before it reaches a uniform (grass, foliage,
moat) and passes absolute seconds only to the fountain's particle simulation.

`MazeScene.tagShadows` skips `userData.shadowTagged`, which terrain and grass set
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

The world is drawn chunk by chunk, not as one floor. `MazeScene` keeps a
`Map<chunkKey, MountedChunk>` of `{ group, terrain, props, grass, detail }` and
exposes the four hooks the `chunk` / `unchunk` / `terrain` / `place` and
`remove` frames map onto, via `defineExpose`:

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
dropped at 3 and 8, at most three chunks built per frame. Its terrain radius is
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
All chunks share one material, so there is one program and one CSM registration.
Terrain receives shadows and casts none (`userData.shadowTagged`), and is *not*
excluded from GTAO.

The protected town renders its terrain too, sunk `TOWN_CLEARANCE` below zero so
every plaza plane in `courtyardScene` — the lowest sits at -0.025 — stays on top
of it instead of z-fighting. **Protection is a tile footprint, not a chunk**:
`isProtectedTile(x, y)` is the moat ring plus the gate bridge's landing, and
`isTownChunk(cx, cy)` is only "this chunk overlaps it", used for seeding and for
keeping the town permanently detailed. Every rendering special case is keyed to
the tile, so a town chunk's outer tiles are ordinary meadow that grows grass,
takes its raster's tint and paints its real colour on the map. The clearance ramp
walks outward from each tile until the footprint ends rather than insetting a
square, so it follows whatever shape the footprint has. Moat and moat-stair tiles
are punched out of the index: that channel is real geometry in `cityMoat` and a
flat lid would seal the water off.

`app/utils/chunkProps.ts` also owns `createPavingBank`: the `path` surface is
real flagstones, not a tint. One `InstancedMesh` per chunk of the town's own
`RoundedBoxGeometry(0.983, 0.045, 0.983, 2, 0.014)` slab on the town's `stone`
material (same `makeCourtyardSurface('stone')` map and `materials.apply` recipe
as `courtyardScene`), one instance per `path` tile outside the protected
footprint, sitting at the tile's mean corner height and tilted to the plane
through its four corners — an unflattened tile gets a tilted slab. The underside
is buried a centimetre because that plane and the bilinear ground only coincide
on a flat tile. It depends on heights *and* the raster, so `refreshChunkTerrain`
rebuilds the slabs and the chunk's detail (grass, flowers) alongside the mesh,
not `refreshChunkProps`; it is not detail-gated, because a road has to still be
there from the next hill. The ground under it keeps a dark `mortar` tint so the
joints read, and `isGrassTile` already refuses a non-grass raster, which is what
keeps blades and flowers off the slabs.

`app/utils/chunkProps.ts` owns `instantiateModule` and builds one
`InstancedMesh` per kind *per chunk*, which costs more draw calls than one batch
for the world and is the price of rebuilding a chunk without touching its
neighbours. Batch materials are cached across chunks by source material, since a
clone per chunk would be a program and a CSM patch per chunk; `reset()` drops the
cache when the GLB templates replace the placeholders, and every mounted chunk is
rebuilt after it. Every placement carries its own `z` — render-only elevation
for the authored town, the terrain it grew on for wild vegetation, the support
height the server resolved for a kit piece — so nothing is bedded or offset here.

`buildFloor()` now only rebuilds the town's cosmetic scene, so an editor change
costs one `createCourtyardScene`, not the world. In editor mode the chunk batches
skip placements whose id starts with `town:`; `hubEditor` draws those as
selectable clones.

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
slips between). It runs from the render loop *after* the camera has moved, or it
aims a frame behind the view.

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
raises the ceiling from `PITCH_MAX` to `PITCH_MAX_TOOL` (~80°, both in
`useBuild`) — `GameScene` clamps the input, `MazeScene` eases the view back up
when the tool is put away. Steep pitch also shortens the boom by `STEEP_CLOSE`,
or the camera would hang four tiles overhead and the tile under the crosshair
would be a postage stamp; that is also what brings the camera inside
`SELF_FADE_DISTANCE`, where `fadeSelf` dissolves the local character so you can
see your own tile. Fading rather than hiding, because the rig's materials are
per-clone (`appearance.ts`) and nothing else shares them. The ray itself never
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
