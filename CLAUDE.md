# Vercel Stadium

A shared 3D stadium. **Nuxt** (nightly) + **TresJS** (three.js) on the client, **Nitro v3 native WebSockets** on the server, deployed to **Vercel**. It exists to demo two things: the Vercel WebSocket upgrade under a real 20 Hz authoritative game loop, and the Coach — an AI agent plugged into the documentation (MCP servers + llms.txt/Markdown) of every Vercel framework and primitive, answering product questions in the shared chat and reading live game state. Everyone shares one arena, walks around, and chats. The arena is bundled data, so no geometry ever travels over the wire — only players.

Roadmap / status is [.claude/ROADMAP.md](.claude/ROADMAP.md) — the source of truth for what's done and next. Keep it current as work lands.

## Commands

- `pnpm dev` — dev server (port 3000 is occupied on this machine; use the preview harness / autoPort)
- `pnpm typecheck` — `nuxt typecheck` (vue-tsc)
- `pnpm lint` / `pnpm lint:fix` — ESLint
- `node scripts/ws-test.mjs ws://localhost:<port>/api/ws` — protocol test (two clients create characters over `/api/auth`, then assert `welcome`/`state`/`chat`/`pong`/`leave`/`kicked` frames)
- Blender is headless: `"/Applications/Blender.app/Contents/MacOS/Blender" --background --python scripts/<x>.py -- <args>`

Package manager is **pnpm**.

## Architecture invariants (load-bearing)

1. **Gameplay-affecting code lives in `shared/utils/arena.ts`.** Anything touching player position, collision, or elevation must go in the shared module so the authoritative server (`server/utils/game.ts`) and client prediction call the *same* functions and never disagree. Never fork physics into a component or the WS handler. This is why a client-side physics engine (`@tresjs/rapier` and friends) does not fit: it could never be the authority.
2. **The server is authoritative.** It runs a fixed **20 Hz** tick loop and validates every action (grounded jumps, dash cooldowns, chat length). Positions are never accepted from clients. Clients predict; the server decides.
3. **One arena, bundled.** The playable footprint (sand disc + solid tile ring) is `generateArena()` in `shared/utils/arena.ts`; the stadium bowl around it is procedural three.js in `app/utils/stadium.ts`, built from the same constants by every client; any hand-placed kit piece rides `shared/data/arena-structure.json` / `arena-props.json`. Nothing about the arena travels over the socket, only players. It is a constant: no seeds, no per-floor generation, no reset.
4. **Wire protocol** is the `t`-keyed discriminated unions in `shared/types/game.ts`. Client→server: `move`/`action`/`chat`/`ping`. Server→client: `welcome`/`join`/`leave`/`state`/`chat`/`kicked`/`pong`/`coach` (thinking on/off). `welcome.now` is the server clock that drives day/night + weather. Changing a frame's shape means updating both consumers.
5. **Identity** rides a signed cookie on the same-origin WS upgrade; no valid cookie ⇒ socket closed. One live session per identity: a second connection (another tab) takes over and the old socket gets a `kicked` frame.
6. **Browser-only code** (three.js, pointer lock) must be `.client.vue` / `<ClientOnly>` — never runs during SSR.

## Subagents

Work is divided into focused subagents in [.claude/agents/](.claude/agents/). Each owns a slice and runs in its own context — route work to the matching one (invoke by name or describe the task).

| Agent | Owns |
| --- | --- |
| `world-sim` | `shared/**` — arena generation, `stepBody` kinematics, collision, and the protocol types. The server↔client invariant. |
| `server-net` | `server/**` — the 20 Hz authoritative sim, crossws WS handler, sessions, and non-AI HTTP routes. |
| `scene-3d` | TresJS rendering — camera, materials, day/night + weather, instanced architecture, character animation, minimap. |
| `game-ui` | 2D interface — HUD, chat, Escape menu, the entry flow, `useGame`. |
| `coach-ai` | The Coach end to end — `server/utils/coach.ts` (in-process classifier + docs agent with `arena_state`), `server/utils/coachDocs.ts` (MCP roster + llms.txt/Markdown docs tools), `useCoach`, prompts/models/tools. |
| `assets` | Blender/glTF pipeline — `scripts/*`, `public/models/**`, compression. |

Ownership seams to respect: physics belongs to `world-sim` (not `server-net`/`scene-3d`); the Coach's AI is `coach-ai` (not `server-net`/`game-ui`); the Coach's 3D placement/proximity is `scene-3d`. There is no in-game editor: the arena JSON under `shared/data/` is edited by hand.

**Keep agent definitions current.** When a change alters a slice's durable contract — an ownership boundary, a load-bearing invariant, or a hard-won gotcha (e.g. the WebP-probe race, the shared-kinematics rule) — amend the matching `.claude/agents/*.md` in the same change so the next run starts from the truth. Keep *status/progress* out of agent files (that's the ROADMAP's job), and amend the specific fact rather than rewriting hand-tuned prose. A change that only adds a feature without shifting a contract needs no agent-file edit.

## Stack notes

- **Nuxt UI v4** + Tailwind for 2D UI; theme in `app/app.config.ts`. Prefer its components. Vue style: `<script setup>` + Composition API + TypeScript.
- **AI SDK v7** (`ai@^7`, `@ai-sdk/mcp@^2`, `@ai-sdk/vue@^4`) for the Coach: a `ToolLoopAgent` whose tools come from public docs MCP servers (`createMCPClient`, prefixed per server) plus llms.txt/Markdown fetchers for the Vercel sites without one (Vercel MCP itself is OAuth-only). Routed through the **Vercel AI Gateway** (`AI_GATEWAY_API_KEY` local and on Vercel). Built in-process, deliberately **not** eve (see the `coach-ai` agent for why + the eve/Nitro proxy landmine).
- Nitro is a **beta** (`3.0.260903-beta`) with h3 2.0-rc — some ecosystem integrations recurse/break on it; verify rather than assume. Known instance: its rolldown build chunks `@nuxt/icon`'s `@iconify-json/*` JSON dynamic imports but leaves the bare specifiers in place, crashing on Vercel (`ERR_MODULE_NOT_FOUND`) — hence `icon.serverBundle: 'remote'` in `nuxt.config.ts`.
- **Dev-only `__dirname` shim** (`server/plugins/devSourceMap.ts`): the Nitro beta inlines its vendored `source-map` into the ESM dev bundle, whose `read-wasm.js` still joins `__dirname` to find `mappings.wasm` — so every rendered error (a 404 is enough) used to log `__dirname is not defined` while the dev error handler source-mapped the stack. The plugin points a global `__dirname` at the vendored `source-map/lib`; drop it once the dev bundle shims CommonJS globals itself. `/favicon.ico` redirects to the SVG in `routeRules` so the probe doesn't render a 404 page at all.
- **The `globalThis.fetch` loopback is the nastiest one.** Nuxt-nightly's SSR entry assigns `globalThis.fetch = serverFetch` when the Vue server bundle first loads (lazily, on the first page or error render), and that dispatcher routes *every* url into the app's own router — absolute external ones included ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)). It is **render-ordered**, so it looks intermittent: the same request succeeds cold and fails after any page has rendered. `server/plugins/nativeFetch.ts` intercepts the assignment and routes absolute `http(s)` urls to the boot-captured real fetch (`server/utils/nativeFetch.ts`), keeping the loopback for relative urls. That covers third-party server code we can't edit — `@nuxt/icon`'s generated remote-collection loader calls a bare `fetch(...)` to jsDelivr and was 500ing on `/api/_nuxt_icon/<set>.json`. Our own code should still import `nativeFetch` directly rather than rely on the guard.
- The Vercel WebSocket upgrade in prod is **unverified and load-bearing** — the whole architecture rests on it (ROADMAP §1).
