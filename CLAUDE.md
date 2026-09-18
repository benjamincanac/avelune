# Avelune

Multiplayer fantasy world. **Nuxt** (nightly) + **TresJS** (three.js) on the client, **Nitro v3 native WebSockets** on the server, deployed to **Vercel**. It exists to demo two things: the Vercel WebSocket upgrade under a real 20 Hz authoritative game loop, and an AI NPC (the Oracle) that reads live game state. Everyone shares one persistent world: a hand-authored walled town at the centre, protected, and open land around it that players terraform and build on. The world is chunked and streamed; edits are validated by the server and persisted per chunk. The plan and its decisions are in [.claude/OPEN-WORLD.md](.claude/OPEN-WORLD.md).

Roadmap / status is [.claude/ROADMAP.md](.claude/ROADMAP.md) — the source of truth for what's done and next. Keep it current as work lands.

## Commands

- `pnpm dev` — dev server (port 3000 is occupied on this machine; use the preview harness / autoPort)
- `pnpm typecheck` — `nuxt typecheck` (vue-tsc)
- `pnpm lint` / `pnpm lint:fix` — ESLint
- `pnpm test` — vitest: shared physics, terrain, building, chunk-store and icon-name suites in `scripts/*-test.ts`
- `node scripts/ws-test.mjs ws://localhost:<port>/api/ws` — protocol test (two clients create characters over `/api/auth`, then assert `welcome`/`chunk`/`state`/`terrain`/`remove`/`chat`/`pong`/`leave`/`kicked` frames)
- `pnpm exec jiti scripts/spawn-bots.mjs --url http://localhost:<port> --count 30 --dig` — load test; `AVELUNE_TICK_LOG=1` on the server logs tick timings
- Blender is headless: `"/Applications/Blender.app/Contents/MacOS/Blender" --background --python scripts/<x>.py -- <args>`

Package manager is **pnpm**.

## Architecture invariants (load-bearing)

1. **Gameplay-affecting code lives in `shared/utils/`.** Anything touching player position, collision, elevation, or edit validation must go in the shared modules (`maze.ts` physics, `world.ts` chunks and mutations, `building.ts` edit rules) so the authoritative server (`server/utils/game.ts`) and client prediction call the *same* functions and never disagree. Never fork physics into a component or the WS handler. This is why a client-side physics engine (`@tresjs/rapier` and friends) does not fit: it could never be the authority.
2. **The server is authoritative.** It runs a fixed **20 Hz** tick loop and validates every action (grounded jumps, dash cooldowns, chat length, every terraform/build/demolish against the shared rules and a rate limit). Positions are never accepted from clients. Clients predict; the server decides.
3. **One world, chunked and streamed.** 32×32 chunks of 32 tiles hold a corner heightmap, a surface raster and placements. The town is hand-authored in `shared/data/courtyard-*.json`, seeded into the town chunks at its original coordinates; the protected footprint (`PROTECTED_FOOTPRINT`: moat ring plus the gate road) refuses player edits and building starts right after the road; everything else is generated deterministically on first touch and then owned by the persisted store (Upstash Redis, in-memory when unset). Store keys are scoped by **realm**, one world per deployment region (`VERCEL_REGION`, override `AVELUNE_REALM`, see `shared/utils/realm.ts`), so regions never race each other's chunks. Only the server builds the world; clients receive chunks and mirror every edit with the same shared `apply*` functions.
4. **Wire protocol** is the `t`-keyed discriminated unions in `shared/types/game.ts`. Client→server: `move`/`action`/`chat`/`ping`/`terraform`/`build`/`demolish`. Server→client: `welcome`/`join`/`leave`/`state`/`chat`/`kicked`/`pong`/`chunk`/`unchunk`/`terrain`/`place`/`remove`/`reject`. `welcome.now` is the server clock that drives day/night + weather; `welcome.world` describes the chunk grid. `state` is filtered to players within 192 tiles. Changing a frame's shape means updating both consumers.
5. **Identity** rides a signed cookie on the same-origin WS upgrade; no valid cookie ⇒ socket closed. One live session per identity: a second connection (another tab) takes over and the old socket gets a `kicked` frame.
6. **Browser-only code** (three.js, pointer lock) must be `.client.vue` / `<ClientOnly>` — never runs during SSR.

## Subagents

Work is divided into focused subagents in [.claude/agents/](.claude/agents/). Each owns a slice and runs in its own context — route work to the matching one (invoke by name or describe the task).

| Agent | Owns |
| --- | --- |
| `world-sim` | `shared/**` — town generation, `stepBody` kinematics, collision, and the protocol types. The server↔client invariant. |
| `server-net` | `server/**` — the 20 Hz authoritative sim, crossws WS handler, sessions, and non-AI HTTP routes. |
| `scene-3d` | TresJS rendering — camera, materials, day/night + weather, instanced architecture, character animation, minimap. |
| `game-ui` | 2D interface — the landing page (`/`), HUD, chat, Escape menu, character onboarding, `useGame`. |
| `oracle-ai` | The Oracle AI NPC end to end — `server/utils/oracle.ts` (in-process classifier + responder with the `arena_state` tool), `useOracle`, prompts/model/tools. |
| `assets` | Blender/glTF pipeline — `scripts/*`, `public/models/**`, compression. |

Ownership seams to respect: physics belongs to `world-sim` (not `server-net`/`scene-3d`); the Oracle's AI is `oracle-ai` (not `server-net`/`game-ui`); the Oracle's 3D placement/proximity is `scene-3d`. The dev world editor (`app/composables/useEditor.ts`, `app/utils/hubEditor.ts`, `EditorPanel.vue`, `server/api/editor/save.post.ts`) authors the town JSON — `scene-3d` owns it.

**Keep agent definitions current.** When a change alters a slice's durable contract — an ownership boundary, a load-bearing invariant, or a hard-won gotcha (e.g. the WebP-probe race, the shared-kinematics rule) — amend the matching `.claude/agents/*.md` in the same change so the next run starts from the truth. Keep *status/progress* out of agent files (that's the ROADMAP's job), and amend the specific fact rather than rewriting hand-tuned prose. A change that only adds a feature without shifting a contract needs no agent-file edit.

## Stack notes

- **Nuxt UI v4** + Tailwind for 2D UI; theme in `app/app.config.ts`. Prefer its components. Vue style: `<script setup>` + Composition API + TypeScript.
- **AI SDK v7** (`ai@^7`, `@ai-sdk/vue@^4`) for the Oracle, routed through the **Vercel AI Gateway** (`AI_GATEWAY_API_KEY` local, OIDC on Vercel). Built in-process, deliberately **not** eve (see the `oracle-ai` agent for why + the eve/Nitro proxy landmine).
- Nitro is a **beta** (`3.0.260610-beta`, pinned via the `pnpm-workspace.yaml` override; the note there says why 260903 and the matching Nuxt nightlies break `nuxt dev`) with h3 2.0-rc — some ecosystem integrations recurse/break on it; verify rather than assume. Known instance: its rolldown build chunks `@nuxt/icon`'s `@iconify-json/*` JSON dynamic imports but leaves the bare specifiers in place, crashing on Vercel (`ERR_MODULE_NOT_FOUND`) — hence `icon.serverBundle: 'remote'` in `nuxt.config.ts`.
- **The `globalThis.fetch` loopback is the nastiest one.** Nuxt-nightly's SSR entry assigns `globalThis.fetch = serverFetch` when the Vue server bundle first loads (lazily, on the first page or error render), and that dispatcher routes *every* url into the app's own router — absolute external ones included ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)). It is **render-ordered**, so it looks intermittent: the same request succeeds cold and fails after any page has rendered. `server/plugins/nativeFetch.ts` intercepts the assignment and routes absolute `http(s)` urls to the boot-captured real fetch (`server/utils/nativeFetch.ts`), keeping the loopback for relative urls. That covers third-party server code we can't edit — `@nuxt/icon`'s generated remote-collection loader calls a bare `fetch(...)` to jsDelivr and was 500ing on `/api/_nuxt_icon/<set>.json`. Our own code should still import `nativeFetch` directly rather than rely on the guard.
- The Vercel WebSocket upgrade in prod is **unverified and load-bearing** — the whole architecture rests on it (ROADMAP §1).
