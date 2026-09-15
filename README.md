# Avelune, a 3D multiplayer world on Vercel

[![License: MIT](https://img.shields.io/github/license/benjamincanac/avelune?color=black)](https://github.com/benjamincanac/avelune/blob/main/LICENSE)
[![Nuxt](https://img.shields.io/badge/Nuxt-black?logo=nuxt&logoColor=00DC82)](https://nuxt.com)

A shared 3D world built with **Nuxt** and **[TresJS](https://tresjs.org)** on [Vercel Functions WebSockets](https://vercel.com/docs/functions/websockets). Everyone shares a colorful walled fantasy town with a central fountain plaza, market stalls and gardens. An AI Oracle answers when you speak to it, reading the live state of the game to do so.

The project demonstrates how to build a 3D MMO on Vercel, starting with authoritative movement, shared world state, persistent character identity and an AI NPC inside the game loop.

Everything is simulated server-side and fanned out over the socket. No database or separate game engine backend. The world, the textures and the 3D models are code and bundled data.

> [!NOTE]
> WebSockets in Vercel Functions are in [beta](https://vercel.com/docs/release-phases#beta).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbenjamincanac%2Favelune&env=NUXT_PUBLIC_SITE_URL&envDescription=Optional%20canonical%20URL%20for%20SEO&project-name=avelune&repository-name=avelune)

## Run it

```bash
pnpm install
pnpm dev
```

Open the app in **two browser tabs**. Move the mouse to look around (click captures the pointer, `F` goes fullscreen), `WASD` to move and strafe, `Space` to jump, `Shift` to dash, `Enter` to chat, `Esc` for the menu.

The Oracle needs an `AI_GATEWAY_API_KEY`. Without one it just stays quiet.

## The world

- **The town.** A central fountain plaza surrounded by gardens, market stalls, The Wayfarer inn and Moss & Mortar shop. Buildings and stalls are scenery; combat, trading and interiors are not implemented. Architecture and furniture are editable placements with shared collision dimensions.
- **The Oracle.** An ancient seer just inside South Gate. It listens to the chat and answers only when it decides a line was meant for it, in character, and it can look up who is actually in town right now before it does.
- **The sky.** A full day/night cycle and drifting weather (clear, overcast, rain), shared by everyone through the server clock.

## How it works

Nitro v3 ships native [crossws](https://crossws.h3.dev) WebSocket support that works identically in dev and on Vercel, so a single `defineWebSocketHandler` ([`server/api/ws.ts`](server/api/ws.ts)) powers every environment.

### The world never goes over the wire

The town is hand-authored into [`shared/data/courtyard-structure.json`](shared/data/courtyard-structure.json) and built by `generateHub()` in [`shared/utils/maze.ts`](shared/utils/maze.ts): collision tiles, spawn, and every prop with its footprint. Server and client build the identical world from the identical data, the server for collision, the client for rendering and prediction. The socket only ever carries players.

### Authoritative simulation, client-owned heading

Clients send held keys (forward, back, strafe), one-shot jump and dash actions, and their mouse-look heading. The 20 Hz loop in [`server/utils/game.ts`](server/utils/game.ts) runs the shared kinematics: wall collision, gravity, jumping, dashing with a cooldown, and prop ledges you can climb, since solid props are part of the authoritative plan. It broadcasts 10 Hz snapshots of the players that moved.

Positions are never accepted from clients. Heading is client-owned because mouse-look has to feel instant and there's nothing to gain by faking it.

### Third-person prediction

The camera follows a locally predicted self: held keys are integrated with the *same* shared `stepBody` the server runs, then blended toward the authoritative position ([`app/components/MazeScene.vue`](app/components/MazeScene.vue)). The reconcile is input-aware, so it corrects sideways drift and catches up when the server is ahead, but never drags you backward against your own input. That's what makes a laggy connection feel like walking rather than like hitting invisible walls. The camera boom shortens when a wall would block the view.

### The Oracle

The Oracle runs in-process inside the game loop ([`server/utils/oracle.ts`](server/utils/oracle.ts)), not behind an HTTP route. Everyone shares one chat and mostly talks to each other, so every line first hits a cheap classifier that decides whether it was actually addressed to the Oracle. Only then does the in-character responder run, with an `arena_state` tool that reads the live roster straight out of memory.

Running it in-process is the point: on serverless, a separate service would have to guess which instance holds the sockets. Here the tool call reads the same map the tick loop writes. Both calls go through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) on `anthropic/claude-haiku-4.5`, with a busy flag and a cooldown so it can't be flooded.

### Onboarding & identity (no database)

New arrivals land on a gate ([`app/components/CharacterGate.vue`](app/components/CharacterGate.vue)) to pick a character in a live turntable preview, choose an outfit colorway, and type a name. `POST /api/auth` sanitizes the choice and sets an HMAC-signed, `HttpOnly` cookie holding `{ id, name, color, character, outfitColor }` ([`server/utils/session.ts`](server/utils/session.ts)). No passwords, no database.

The cookie rides the same-origin WebSocket upgrade and [`server/api/ws.ts`](server/api/ws.ts) verifies it to build the player, so the frequent reconnects on Vercel restore the *same* character and returning visitors skip the gate entirely. It's tamper-evident: a mangled signature is treated as unauthenticated. Only one live session per identity is allowed, so a second tab takes over and the first one is told why.

### Art from code (plus a CC0 ruin or two)

- **Textures.** Subtle plaster, stone and sand textures are drawn at runtime ([`app/utils/courtyardTextures.ts`](app/utils/courtyardTextures.ts)).
- **Characters.** Composed from Quaternius' CC0 *Universal* packs by [`scripts/convert_universal_characters.py`](scripts/convert_universal_characters.py): an outfit from *Modular Character Outfits – Fantasy*, a head from *Universal Base Characters* trimmed to the neck with a mix-and-match hairstyle, and a shared clip set from *Universal Animation Library* 1 & 2. Because every body, outfit and animation shares one 65-bone universal skeleton, the clips ship once in `animations.glb` (skeleton only, no mesh) and bind to every character by bone name with no retargeting. The chosen colorway dyes just the outfit cloth at runtime. Idle, run, jump and roll are driven by movement state, including for remote players.
- **Architecture.** Original Blender models in `public/models/courtyard` provide the buildings, fountain and vegetation. Their generators live in `scripts/build_courtyard_*.py`. Custom furniture and fallback templates in [`app/utils/courtyardAssets.ts`](app/utils/courtyardAssets.ts) merge geometry by material before instancing. Dimensions in [`shared/utils/courtyard.ts`](shared/utils/courtyard.ts) define the collision footprints. The world editor uses the same courtyard templates. Legacy environment kits and their thumbnails are no longer shipped. Sculpted terrain and animated grass are generated in `app/utils/courtyardLandscape.ts`; the render pipeline adds contact occlusion and restrained bloom.

## Architecture

```
app/
├── pages/index.vue           # entry flow + HUD: brand, minimap, chat, Escape menu
├── composables/useGame.ts    # connection, reconnect, roster, chat, clock sync
└── components/
    ├── GameScene.client.vue  # Tres canvas + pointer lock, WASD, mouse-look
    ├── MazeScene.vue         # 3D world: town, sky/weather, players, Oracle
    └── CharacterGate.vue     # onboarding

shared/
├── types/game.ts             # wire protocol
├── data/courtyard-structure.json # authored town buildings
└── utils/maze.ts             # town generation, collision, shared kinematics

server/
├── api/ws.ts                 # /api/ws — one crossws handler everywhere
└── utils/
    ├── game.ts               # authoritative 20 Hz tick loop
    └── oracle.ts             # the Oracle's classifier + responder
```

## Reconnects

Connections close when a Vercel Function reaches its [max duration](https://vercel.com/docs/functions/limitations#max-duration). The client reconnects with exponential backoff and the signed cookie restores the same character. A `ping`/`pong` heartbeat detects half-open sockets client-side and doubles as a keepalive server-side.

## License

[MIT](LICENSE)

### Weather

Type `/weather clear`, `/weather overcast`, or `/weather rain` in chat to change
the weather for everyone. `/weather auto` restores the natural cycle.

Type `/time dawn`, `/time day`, `/time sunset`, or `/time night` to set the time
of day for everyone. `/time auto` restores the natural cycle without changing weather.
