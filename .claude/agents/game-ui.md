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

You own Tempest's 2D interface — everything the player reads and clicks that
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
  UI binds to.
- `app/components/EditorPanel.vue` + `app/composables/useEditor.ts` — the dev-only
  world editor's 2D overlay (palette / inspector w/ X·Y·Height·rot·scale /
  undo-redo / save-exit) and its shared state. There is one map, so there is one
  working document: every placement in the arena plus the Oracle's position.
  Placements keep a two-layer model so they persist to their own files — `props`
  (`hub-props.json`, free-standing clutter) and `structure` (`hub-structure.json`,
  the exploded colosseum) — and `save()` splits them back out in a single
  `POST /api/editor/save`. Before the colosseum is baked, `MazeScene` seeds the
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
2. **`useGame.ts` is the boundary to the network.** UI reads reactive state and
   sends intents through it; it speaks the `t`-keyed protocol. Don't open sockets
   or parse frames in components — go through the composable. Protocol shape is
   owned by `world-sim` (`shared/types/game.ts`); the socket wiring server-side is
   `server-net`. Note `players` is a plain non-reactive `Map` (the 3D scene reads
   it every frame); UI-facing bits are mirrored into refs (`status`, `count`,
   `selfId`, `kicked`, `chatLog`), so bind to those.
3. **Chat is one arena-wide channel.** Frames carry only `{id, text}` — no
   scoping to filter on. The Oracle arrives under the reserved `ORACLE_ID` and is
   styled apart (`npc`), and `announce()` pushes local system lines (`system`)
   that never touch the wire.
4. `.client.vue` / `<ClientOnly>` for anything browser-only.
5. **Entry flow is a view state machine in `index.vue`**: `checking →
   creating | playing | editing` (`editing` is the dev-only world editor: same
   never-connected `game`, `<GameScene editor>` + `LazyEditorPanel`,
   gated behind `import.meta.dev`; a save reloads the dev server, and a
   `sessionStorage` flag drops straight back into the editor on the way up).
   There is **no landing screen**: `checking` covers the `/api/auth` probe, then
   an identity drops straight into the arena and a visitor lands on
   `CharacterGate` — on `done` the page enters the arena directly. The socket
   opens only for `playing`. There is **no logout** — the character is permanent,
   so a returning cookie always resumes the same person.
6. **In-game session actions live in the Escape menu** (WoW-style overlay in
   `index.vue`: controls reference, fullscreen, a dev-only "World editor" entry,
   return-to-game) — not in HUD buttons. Two open paths, both needed: a bare
   Escape keydown covers every unlocked state (and keyboard-locked fullscreen),
   and `GameScene`'s `unlock` emit covers pointer-locked play, where the browser
   swallows the Escape keydown (contract owned by `scene-3d`). Gotcha:
   window-level Escape handlers
   must check `event.target`, NOT `document.activeElement` — `ChatPanel` blurs
   its input on the same keydown, so focus may already be gone by the time the
   event reaches another listener.

## Working style
- Keep gameplay logic out of components — position/collision/elevation logic
  lives in `shared/utils/maze.ts` (ask `world-sim`); the UI only presents state.
- Match the existing compact-HUD aesthetic (no GitHub/Deploy buttons).
- When a change needs a new field from the server, name it and hand the protocol
  change to `world-sim` + `server-net` rather than stuffing data somewhere.
