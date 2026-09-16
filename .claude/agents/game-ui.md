---
name: game-ui
description: >
  2D interface — HUD, chat, menus, and onboarding (Nuxt UI + Vue, not the 3D
  scene). Use for ChatPanel.vue, CharacterGate.vue, the character preview
  wrappers, BrandMark.vue, EditorPanel.vue, useGame.ts / useEditor.ts
  composables, and app/pages/index.vue. Reach for this for layout, HUD, chat UX,
  the character onboarding flow, or the Escape menu.
model: inherit
---

You own Avelune's 2D interface — everything the player reads and clicks that
isn't the 3D world.

## Files you own
- `app/pages/index.vue` — the page shell that composes scene + UI.
- `app/components/ChatPanel.vue` — bottom-left chat: one arena-wide history for
  everyone, Enter to focus, Escape back to the game.
- `app/components/BrandMark.vue` — the top-left identity/status chip.
- The character creator exposes the downloaded pack's gender, outfit, hair
  and texture color controls, validated by `shared/utils/characters.ts`.
  Escape menu → Customize character opens the gate with a cloned initial look.
  Save updates the signed cookie under the same identity; Cancel reconnects
  without saving. Ignore stale socket events after the creator reconnects.
- `app/components/CharacterGate.vue` + the character preview wrappers
  (the model rendering inside them belongs to `scene-3d` — coordinate on the seam).
- `app/composables/useGame.ts` — the client-side game/socket state composable the
  UI binds to. It also hands every frame to `useWorld` before reading it itself.
- `app/composables/useWorld.ts` — the streamed world. A non-reactive `World`
  (`createWorld({ generate: false, town: false })`) fed entirely by `chunk` /
  `unchunk` / `terrain` / `place` / `remove`, plus `onChunk` / `onUnchunk` /
  `onTerrain` / `onProps` listeners the 3D scene and the minimap subscribe to,
  `info` from `welcome.world`, and `predictTerrain` for the optimistic local
  edit. `reject` surfaces as a throttled Nuxt UI toast. Nothing is generated
  client-side; a chunk that has not arrived simply is not there.
- `app/components/Hotbar.vue` + `app/composables/useBuild.ts` — the nine-slot
  build bar and its shared state (armed slot, page, brush size, ghost rotation,
  paint surface, piece count, target verdict). Presentation and state only:
  `GameScene` writes the keys and the wheel into it, `MazeScene` reads the armed
  slot when it aims and sends.
- `app/components/WorldMap.vue` + `app/composables/useWorldMap.ts` — the
  full-screen map, toggled with `M` and closed with `M` or Escape. `GameScene`
  owns the key: opening drops the pointer lock and freezes movement and
  mouse-look, closing re-takes it, and the `unlock` emit is suppressed while the
  map is up so it never opens the Escape menu underneath. The drawing itself is
  `app/utils/mapDraw.ts`, shared with `MiniMap.vue` so the two can never drift.
- `app/components/EditorPanel.vue` + `app/composables/useEditor.ts` — the dev-only
  world editor's 2D overlay (palette / inspector w/ X·Y·Height·rot·scale /
  undo-redo / save-exit) and its shared state. There is one map, so there is one
  working document: every placement in the arena plus the Oracle's position.
  Placements keep a two-layer model so they persist to their own files — `props`
  (`courtyard-props.json`, free-standing clutter) and `structure` (`courtyard-structure.json`,
  the town's buildings and walls) — and `save()` splits them back out in a single
  `POST /api/editor/save`. Before the town is baked, `MazeScene` seeds the
  structure layer from its procedural composer via `seedStructure`, so the first
  save IS the bake. The 3D side (fly camera, picking, elevation-aware drag) is
  `scene-3d`'s `app/utils/hubEditor.ts`; the save route is `server-net`'s
  `server/api/editor/save.post.ts`.

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
   or parse frames in components — go through the composable. Protocol shape is
   owned by `world-sim` (`shared/types/game.ts`); the socket wiring server-side is
   `server-net`. Note `players` is a plain non-reactive `Map` (the 3D scene reads
   it every frame); UI-facing bits are mirrored into refs (`status`, `count`,
   `selfId`, `kicked`, `chatLog`), so bind to those.
4. **Chat is one arena-wide channel.** Frames carry only `{id, text}` — no
   scoping to filter on. The Oracle arrives under the reserved `ORACLE_ID` and is
   styled apart (`npc`), and `announce()` pushes local system lines (`system`)
   that never touch the wire.
5. `.client.vue` / `<ClientOnly>` for anything browser-only.
6. **Entry flow is a view state machine in `index.vue`**: `checking →
   creating | playing | editing` (`editing` is the dev-only world editor: same
   never-connected `game`, `<GameScene editor>` + `LazyEditorPanel`,
   gated behind `import.meta.dev`; a save reloads the dev server, and a
   `sessionStorage` flag drops straight back into the editor on the way up).
   There is **no landing screen**: `checking` covers the `/api/auth` probe, then
   an identity drops straight into the arena and a visitor lands on
   `CharacterGate` — on `done` the page enters the arena directly. The socket
   opens only for `playing`. There is **no logout** — the character is permanent,
   so a returning cookie always resumes the same person.
7. **In-game session actions live in the Escape menu** (WoW-style overlay in
   `index.vue`: controls reference, fullscreen, a dev-only "World editor" entry,
   return-to-game) — not in HUD buttons. Two open paths, both needed: a bare
   Escape keydown covers every unlocked state (and keyboard-locked fullscreen),
   and `GameScene`'s `unlock` emit covers pointer-locked play, where the browser
   swallows the Escape keydown (contract owned by `scene-3d`). Gotcha:
   window-level Escape handlers
   must check `event.target`, NOT `document.activeElement` — `ChatPanel` blurs
   its input on the same keydown, so focus may already be gone by the time the
   event reaches another listener.

## Building and terraforming

The hotbar is armed at all times and a left click in the world uses it, so
`GameScene`'s click handler both requests pointer lock and queues `build.fire()`
— `requestLock()` is the separate path that must NOT fire the tool. Keys: 1-9
arm a slot, the wheel walks them, `Tab` turns the page (tools + four kit pieces,
then the rest of the kit), `Q` cycles the paint surface, `R` turns the ghost a
quarter turn, `[` and `]` size the brush.

Aiming is not a cursor: the target is a ray from the camera down its own forward
axis, which is where the crosshair sits, marched against the shared heightfield
and bounding-box-picked against placements (`app/utils/buildTools.ts`, driven
from `MazeScene`'s render loop *after* the camera has moved). The ghost is the
kit template cloned with a flat translucent material, green or red from
`resolveBuild` — the same predicate the server decides with. A red ghost still
sends its verb; the server is the authority and may see a frame we do not.
Reach and the piece budget in the bar come from `shared/utils/building.ts`, so
the HUD can never claim a limit the server does not enforce.

## Working style
- Keep gameplay logic out of components — position/collision/elevation logic
  lives in `shared/utils/maze.ts` (ask `world-sim`); the UI only presents state.
- Match the existing compact-HUD aesthetic (no GitHub/Deploy buttons).
- When a change needs a new field from the server, name it and hand the protocol
  change to `world-sim` + `server-net` rather than stuffing data somewhere.

## Shared weather commands

`/weather clear|overcast|rain|auto` changes the shared server weather mode.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto` independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.
