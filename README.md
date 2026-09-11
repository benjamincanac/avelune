# Vercel Stadium — a multiplayer arena on Vercel WebSockets, with an AI Oracle

[![License: MIT](https://img.shields.io/github/license/benjamincanac/tempest?color=black)](https://github.com/benjamincanac/tempest/blob/main/LICENSE)
[![Nuxt](https://img.shields.io/badge/Nuxt-black?logo=nuxt&logoColor=00DC82)](https://nuxt.com)

A shared 3D stadium built with **Nuxt** and **[TresJS](https://tresjs.org)** on [Vercel Functions WebSockets](https://vercel.com/docs/functions/websockets). Everyone spawns on the same LED floor, walks around under a moving sky, and talks in a shared chat. The Oracle stands in the arena: an AI agent plugged into the documentation of every Vercel framework and primitive, so you can ask it anything about Vercel and get an answer grounded in the docs, right there in the chat.

It's a demo of two things: a real authoritative game loop running inside a Vercel Function with one WebSocket per player, and an AI agent wired directly into that loop.

Everything is simulated server-side and fanned out over the socket. No database, no game engine backend. The stadium, the textures and the crowd are code.

> [!NOTE]
> WebSockets in Vercel Functions are in [beta](https://vercel.com/docs/release-phases#beta).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbenjamincanac%2Ftempest&env=NUXT_PUBLIC_SITE_URL&envDescription=Optional%20canonical%20URL%20for%20SEO&project-name=vercel-stadium&repository-name=vercel-stadium)

## Run it

```bash
pnpm install
pnpm dev
```

Open the app in **two browser tabs**. Pick a body and a name, then: move the mouse to look around (click captures the pointer, `F` goes fullscreen), `WASD` to move and strafe, `Space` to jump, `Shift` to dash, `Enter` to chat, `Esc` for the menu.

The Oracle needs an `AI_GATEWAY_API_KEY`. Without one it just stays quiet.

## The stadium

- **The arena.** One stadium, shared by everyone. A black LED floor that lights up under your feet, ringed by tiered stands, a crowd, and LED bands scrolling the Vercel frameworks and primitives. There is no way out; the arena is the whole world.
- **The Oracle.** The vercel.com triangle, floating over smoke by the wall. It listens to the chat and answers when a line is for it — by name, or any question about Vercel, Next.js, Nuxt, Svelte, Turborepo, the AI SDK, and the rest — after looking the answer up in the docs. It can also tell you who is in the stadium right now.
- **The sky.** A full day/night cycle and drifting weather (clear, overcast, rain), shared by everyone through the server clock.

## How it works

Nitro v3 ships native [crossws](https://crossws.h3.dev) WebSocket support that works identically in dev and on Vercel, so a single `defineWebSocketHandler` ([`server/api/ws.ts`](server/api/ws.ts)) powers every environment.

### The world never goes over the wire

The arena footprint is `generateArena()` in [`shared/utils/arena.ts`](shared/utils/arena.ts): collision tiles, spawn, and any hand-placed prop from [`shared/data/arena-structure.json`](shared/data/arena-structure.json). Server and client build the identical world from the identical data, the server for collision, the client for rendering and prediction. The bowl around it is procedural three.js. The socket only ever carries players.

### Authoritative simulation, client-owned heading

Clients send held keys (forward, back, strafe), one-shot jump and dash actions, and their mouse-look heading. The 20 Hz loop in [`server/utils/game.ts`](server/utils/game.ts) runs the shared kinematics: wall collision, gravity, jumping, dashing with a cooldown, and prop ledges you can climb. It broadcasts 10 Hz snapshots of the players that moved.

Positions are never accepted from clients. Heading is client-owned because mouse-look has to feel instant and there's nothing to gain by faking it.

### Third-person prediction

The camera follows a locally predicted self: held keys are integrated with the *same* shared `stepBody` the server runs, then blended toward the authoritative position ([`app/components/ArenaScene.vue`](app/components/ArenaScene.vue)). The reconcile is input-aware, so it corrects sideways drift and catches up when the server is ahead, but never drags you backward against your own input. The camera boom shortens when a wall would block the view.

### The Oracle

The Oracle runs in-process inside the game loop ([`server/utils/oracle.ts`](server/utils/oracle.ts)), not behind an HTTP route. Everyone shares one chat and mostly talks to each other, so every line first hits a cheap classifier that decides whether it was for the Oracle. Only then does the agent run: an AI SDK `ToolLoopAgent` that searches the docs, reads the best page, and answers in a few sentences with the URL it used. While it works, everyone sees it thinking.

Its tools come from two places ([`server/utils/oracleDocs.ts`](server/utils/oracleDocs.ts)):

- **Documentation MCP servers**, connected with `@ai-sdk/mcp` and kept open: Nuxt, Nuxt UI, Nuxt Content, Nuxt Image, Svelte, Docus and Comark. Each server's tools are prefixed with its name so they never collide.
- **`search_docs` / `read_docs_page`** for the Vercel properties without a public MCP: vercel.com, nextjs.org, turborepo.com, ai-sdk.dev, chat-sdk.dev, flags-sdk.dev, useworkflow.dev and v0.app, through their public `llms.txt` indexes and Markdown page endpoints. (Vercel's own MCP is OAuth-only, so the platform docs go through vercel.com's Markdown sitemap.)

Plus `arena_state`, which reads the live roster straight out of memory. Running it in-process is the point: on serverless, a separate service would have to guess which instance holds the sockets. Here the tool call reads the same map the tick loop writes. Everything goes through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway): Claude Haiku 4.5 for the classifier, Claude Sonnet 4.6 for the agent, with a busy flag and a cooldown so it can't be flooded.

### Onboarding & identity (no database)

Character creation is two choices: a body (male or female Developer, both in a Vercel black tee and cap) and a name. `POST /api/auth` rolls an accent colour and sets an HMAC-signed, `HttpOnly` cookie holding `{ id, name, color, character }` ([`server/utils/session.ts`](server/utils/session.ts)). No passwords, no database.

The cookie rides the same-origin WebSocket upgrade and [`server/api/ws.ts`](server/api/ws.ts) verifies it to build the player, so the frequent reconnects on Vercel restore the *same* identity and returning visitors keep their handle. It's tamper-evident: a mangled signature is treated as unauthenticated. Only one live session per identity is allowed, so a second tab takes over and the first one is told why.

### Art from code

- **Textures.** The stadium's LED brand strips, centre mark, crowd silhouettes and glows are drawn onto canvases at runtime ([`app/utils/textures.ts`](app/utils/textures.ts)).
- **Characters.** Composed from Quaternius' CC0 *Universal* packs by [`scripts/convert_universal_characters.py`](scripts/convert_universal_characters.py), sharing one 65-bone skeleton so the clips ship once in `animations.glb` and bind to every body by bone name. The Developer look is applied at runtime ([`app/utils/developerLook.ts`](app/utils/developerLook.ts)): the cloth is tinted Vercel black and a cap and ▲ hang off the head and chest bones. Idle, run, jump and roll are driven by movement state, including for remote players.
- **Architecture.** The stadium bowl, crowd, LED bands, roof and floodlights are procedural three.js ([`app/utils/stadium.ts`](app/utils/stadium.ts)) — no model loads for the arena. The LED floor is [`app/utils/ledFloor.ts`](app/utils/ledFloor.ts); the Oracle's body is [`app/utils/oracle3d.ts`](app/utils/oracle3d.ts).

## Architecture

```
app/
├── pages/index.vue           # entry flow + HUD: brand, minimap, chat, Escape menu
├── composables/useGame.ts    # connection, reconnect, roster, chat, clock sync
├── composables/useOracle.ts  # Oracle near / speech / thinking state
└── components/
    ├── CharacterGate.vue     # body + name, sets the identity cookie
    ├── ChatPanel.vue         # shared chat, Oracle links + thinking indicator
    ├── GameScene.client.vue  # Tres canvas + pointer lock, WASD, mouse-look
    └── ArenaScene.vue        # 3D world: stadium, sky/weather, players, Oracle

shared/
├── types/game.ts             # wire protocol
├── data/arena-*.json         # hand-placed pieces (empty) + the Oracle's mark
└── utils/arena.ts            # arena generation, collision, shared kinematics

server/
├── api/ws.ts                 # /api/ws — one crossws handler everywhere
└── utils/
    ├── game.ts               # authoritative 20 Hz tick loop
    ├── oracle.ts             # the Oracle: classifier + docs agent
    └── oracleDocs.ts         # MCP roster + llms.txt / Markdown docs tools
```

## Reconnects

Connections close when a Vercel Function reaches its [max duration](https://vercel.com/docs/functions/limitations#max-duration). The client reconnects with exponential backoff and the signed cookie restores the same character. A `ping`/`pong` heartbeat detects half-open sockets client-side and doubles as a keepalive server-side.

## License

[MIT](LICENSE)
