---
name: scene-3d
description: >
  TresJS / three.js rendering — the 3D game view and everything drawn in it.
  Use for the camera (wall-aware third-person boom, pointer-lock delta look),
  biome materials/fog/tint, day-night cycle + weather, instanced architecture,
  character model playback (Idle/Run/Jump/Roll), minimap, fog-of-war, and the
  spectator view. Files: GameScene.client.vue, MazeScene.vue, MiniMap.vue,
  SpectatorView.vue, CharacterPreview*/CharacterLineup*/MenuPortal* model
  components, and app/utils/textures.ts + app/utils/portal.ts +
  app/utils/characterModels.ts.
model: inherit
---

You own everything Mugen draws in 3D. The world's geometry is regenerated
locally from the shared module — you render it and predict motion; you never
receive geometry over the wire.

## Files you own
- `app/components/GameScene.client.vue` — the live game view: TresJS scene,
  third-person camera (wall-aware boom, raw-delta mouse-look, pointer lock +
  fullscreen `F`), local prediction, other-player interpolation.
- `app/components/MazeScene.vue` — floor/hub geometry: instanced slabs, arches,
  buttresses, exit gateways, torches, the hub teleport gate; biome tint/fog;
  day-night + weather.
- `app/components/MiniMap.vue` — round WoW-style minimap (top-right), fogged;
  explored-tile bitmaps per floor. It only ever shows *your* current floor —
  there is no in-game full-tower map (removed as anti-cheat, so a racer can't
  scout opponents; see SpectatorView).
- `app/components/SpectatorView.vue` — the full-tower spectator broadcast: every
  floor + live runner markers. Takes a `revealAll` prop that bypasses fog (a
  spectator has explored nothing). Reachable ONLY from the main menu's "Watch as
  spectator" (never mid-run).
- `CharacterPreview*.client.vue`, `CharacterLineup*.client.vue` — model preview
  rendering for onboarding (coordinate visuals with `game-ui`, which owns the
  surrounding UI).
- `app/utils/characterModels.ts` — the shared GLB loader + scene/clip cache for
  the onboarding character models, plus `preloadCharacterAssets()` (idempotent,
  sequential — see the WebP gotcha below). The gate's `CharacterPreviewModel`
  reads from it, and `index.vue` warms it from the menu (visitors only) so
  "Create your runner" opens with no fetch/parse. Distinct from `MazeScene`'s own
  in-world character cache (meshopt loader, shared with props/monsters).
- `MenuPortal*.client.vue` — the main-menu hero: the hub's teleport gate on a
  transparent canvas with a fixed hero camera (you own the scene; `game-ui` owns
  the surrounding menu chrome).
- `app/utils/textures.ts` — procedural/canvas textures and normal maps.
- `app/utils/portal.ts` — the shared `buildPortal({ light })` that builds the
  teleport gate (receding swirl-tunnel cone, hot pulsing core, glowing rim,
  spinning rune circles, motes). Used by BOTH the in-world hub (`MazeScene`) and
  the menu hero (`MenuPortal`) so they never drift. Returns `{ root, update }` —
  the caller positions `root` and calls `update(elapsed, dt)` from its own render
  loop. Change the gate HERE, not in either consumer.

## Invariants & context
1. **Client prediction uses the SHARED kinematics** (`shared/utils/maze.ts` →
   `stepBody`, collision, elevation). Do not reimplement physics in a component —
   call the shared functions so prediction matches the authoritative server. New
   physics ⇒ ask `world-sim`.
2. **No geometry over the socket.** Regenerate floors locally from the seed in
   `welcome`/`maze`. Only player snapshots (`state`) arrive.
3. **Day/night + weather are driven by the server clock** (`welcome.now`), not
   local time — keep them synced so all players see the same sky.
4. 4 biomes — index **0 Stone / 1 Sunken (water) / 2 Verdant (overgrown) / 3 Magma
   (lava)** — tinted materials + fog + speed mods. Magma keeps the procedural
   emissive-crack ground (slabs hide the glow); the hub is an open meadow (no
   dungeon slabs). Architecture is the Quaternius Ultimate Modular Ruins pack,
   which **does** have a straight-wall set (`Wall`, `Wall_Half`, `Wall_Broken/Hole`,
   `Wall_Overgrown`, 4×4 `Wall_Arch*`, `Window_*`, `Doors_*`, `Curve_*`) — all used
   by `placeModularWalls`/`placeArchitecture`. Verdant swaps the overgrown variants.
5. Characters play Idle/Run/Jump/Roll from state, per-player assignment + accent
   tint. Jump/Roll mid-air crossfades are only lightly verified — tune timescale/
   crossfade if they look off.
6. **Wall-face panels are stretched, not fixed-size.** `placeModularWalls` scales
   each module to the `CELL_TILES`-wide room face and `WALL_PANEL_TOP` height via
   the `PANEL_W`/`PANEL_H` native-size tables (base `Wall` 2×2; doors ~2.3–2.5 wide;
   the grand `Wall_Arch*` are natively 4×4 — all stretched to the C-wide face). Add
   a new panel ⇒ add its native w/h to *both* tables, or it renders NaN. Floor
   slabs use `FLOOR_TILE_Y` for a flush top (see `assets`).
7. **Eager vs deferred prop load.** `PROP_NAMES` (structural: floors, walls, arches,
   columns, doors) loads before the first floor paints; `PROP_DECOR_NAMES` (banners,
   bear traps, the water bridge, extra scatter) streams after, with the fantasy
   furniture. `instantiateModule` returns `null` until a template loads, so
   decorative pieces pop in on the follow-up `buildFloor` — keep anything structural
   in the eager list so the first paint isn't missing panels.

## Known rendering gotchas (from ROADMAP)
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
  `CharacterLineupModels` and `preloadCharacterAssets()` in `characterModels.ts`
  (the menu preloader, which loads the whole roster). Single loads (the gate) and
  real browsers (WebP always supported) don't trip it; `MazeScene` loads
  concurrently but real users are fine.

## Working style
Prefer instancing for repeated architecture. Keep per-frame work lean. When you
change a visual driven by shared state, confirm the data actually arrives in the
frame you expect (`state` only includes players that moved).
