# Avelune, a 3D multiplayer world on Vercel

[![License: MIT](https://img.shields.io/github/license/benjamincanac/avelune?color=black)](https://github.com/benjamincanac/avelune/blob/main/LICENSE)
[![Nuxt](https://img.shields.io/badge/Nuxt-black?logo=nuxt&logoColor=00DC82)](https://nuxt.com)

A shared 3D world built with **[Nuxt](https://nuxt.com)** and **[TresJS](https://tresjs.org)** on [Vercel Functions WebSockets](https://vercel.com/docs/functions/websockets). Everyone lands in the same colorful walled fantasy town, and everything outside the walls is open land you can dig into, terraform and build on. It stays there after you leave. An AI Oracle standing by the gate answers when you speak to it, reading the live state of the world to do so.

The project demonstrates how to build a 3D MMO on Vercel: authoritative movement at a fixed tick, a chunked world streamed over one socket, persistent character identity, proximity voice on that same socket, and an AI NPC running inside the game loop.

Everything is simulated server-side and fanned out over the socket. No game engine backend, no WebRTC, and not a single audio file in the repo. The world, the textures and the sounds are code.

> [!NOTE]
> WebSockets in Vercel Functions are in [beta](https://vercel.com/docs/release-phases#beta).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbenjamincanac%2Favelune&env=NUXT_SESSION_PASSWORD,AI_GATEWAY_API_KEY,NUXT_PUBLIC_SITE_URL&envDescription=Cookie%20signing%20secret%2C%20an%20AI%20Gateway%20key%20for%20the%20Oracle%2C%20and%20an%20optional%20canonical%20URL&project-name=avelune&repository-name=avelune)

Link an Upstash Redis store from the Vercel marketplace to keep the world between deploys. Without one the server keeps it in memory and it resets with the process, which is what local dev and the tests run on.

## Run it

```bash
pnpm install
pnpm dev
```

Open the app in **two browser tabs**. Click to capture the pointer, then `WASD` to move, `Space` to jump, `Shift` to sprint, `E` to dash, `1`–`9` and `Tab` for the hotbar, click to use the armed tool, `[` `]` for brush size, `R` to rotate, `M` for the map, `F` for fullscreen, `T` to talk, `N` to mute, `Enter` to chat and `Esc` for the menu.

Copy `.env.example` to `.env` for the optional keys. The Oracle and voice transcription need an `AI_GATEWAY_API_KEY`. Without one the Oracle stays quiet and spoken lines never reach the chat, while live voice still works.

```bash
pnpm test          # shared physics, world, building, chunk store, characters, voice, audio
pnpm typecheck
node scripts/ws-test.mjs ws://localhost:<port>/api/ws    # the wire protocol, end to end
```

## The world

- **The town.** A walled town with a fountain plaza, market stalls, gardens, The Wayfarer inn and Moss & Mortar shop, ringed by a swimmable moat and a rampart gallery you can walk. It is hand-authored and protected: player edits stop at the bridge. Buildings are scenery, so combat, trading and interiors are not implemented.
- **The open land.** Everything past the walls is generated from the world seed as meadow, forest, pinewood, grove, heath or mountain, with real peaks, a rock line and snow above it. Trees and rocks can be felled and planted, the ground can be raised, lowered, flattened and painted, and a 13-piece kit builds on it. Plant a deed post and the 16-tile square around it is yours alone to edit.
- **The Oracle.** An ancient seer just inside South Gate. It listens to the chat and answers only when it decides a line was meant for it, in character, and it can look up who is around, what has been built and where before it does.
- **The sky.** A 15-minute day/night cycle and drifting weather (clear, overcast, rain), shared by everyone through the server clock. Ask the Oracle in chat to set it: clear, overcast or rain, and dawn, day, sunset or night, or ask it to let the sky be for the natural cycle again. The two are independent.

## How it works

Nitro v3 ships native [crossws](https://crossws.h3.dev) WebSocket support that works identically in dev and on Vercel, so a single `defineWebSocketHandler` ([`server/api/ws.ts`](server/api/ws.ts)) powers every environment. The 20 Hz loop, chunk streaming, chat, the Oracle and voice audio all ride that one socket.

### One world, chunked and streamed

The world is 32×32 chunks of 32 tiles, each holding a corner heightmap, a surface raster and its placements ([`shared/utils/world.ts`](shared/utils/world.ts)). The town is seeded from [`shared/data/courtyard-structure.json`](shared/data/courtyard-structure.json) at its authored coordinates; everything else is generated deterministically the first time somebody touches it and then owned by the store.

Clients get the 5×5 chunks around them as `chunk` and `unchunk` frames, then `terrain`, `place` and `remove` deltas as people edit, and `state` filtered to the players within 192 tiles. Only the server builds the world. Clients mirror every edit by calling the same shared `apply*` functions.

Chunks persist to Upstash Redis, one key each, written behind a CAS on the chunk version and drained on shutdown. Every key is scoped by **realm**, taken from `VERCEL_REGION`, so each deploy region keeps a world of its own instead of racing the others. The live deployment runs three: Frankfurt (`fra1`), Washington (`iad1`) and Singapore (`sin1`).

### Authoritative simulation, client-owned heading

Clients send held keys (forward, back, strafe), one-shot jump and dash actions, and their mouse-look heading. The 20 Hz loop in [`server/utils/game.ts`](server/utils/game.ts) runs the shared kinematics from [`shared/utils/maze.ts`](shared/utils/maze.ts): collision, gravity, slopes, jumping, sprinting, dashing with a cooldown, swimming in the moat, and climbing onto anything solid, since placed pieces are part of the authoritative plan. It broadcasts 10 Hz snapshots of the players that moved.

Positions are never accepted from clients. Heading is client-owned because mouse-look has to feel instant and there's nothing to gain by faking it.

### Third-person prediction

The camera follows a locally predicted self: held keys are integrated with the *same* shared `stepBody` the server runs, then blended toward the authoritative position ([`app/components/MazeScene.vue`](app/components/MazeScene.vue)). The reconcile is input-aware, so it corrects sideways drift and catches up when the server is ahead, but never drags you backward against your own input. That's what makes a laggy connection feel like walking rather than like hitting invisible walls. The camera boom shortens when a wall or a built piece would block the view.

### Terraforming and building

Every rule lives in [`shared/utils/building.ts`](shared/utils/building.ts) and runs on both sides, so the ghost preview under your crosshair is the server's answer before you ask. Terraform is raise, lower, flatten and paint with a brush of 1 to 3. Building snaps to a 2 unit grid: floors and roofs take a cell, walls, windows, doors, fences and gates take a cell edge and its heading, and pieces stack, so `R` flips a panel rather than turning it.

The server validates the lot: reach, the protected town footprint, deed ownership, stacking and support, a rate limit, and a 500-piece budget counted per identity rather than per session ([`server/utils/pieces.ts`](server/utils/pieces.ts)). A reconnect, a second tab or a redeploy never hands anyone a fresh allowance. A refusal comes back as a `reject` frame that says why.

### The Oracle

The Oracle runs in-process inside the game loop ([`server/utils/oracle.ts`](server/utils/oracle.ts)), not behind an HTTP route. Everyone shares one chat and mostly talks to each other, so every line first hits a cheap classifier that decides whether it was actually addressed to the Oracle. Only then does the in-character responder run, with an `arena_state` tool that reads the live world straight out of memory: who is around, how many pieces are standing, the busiest spot worded as a direction from the gate, the weather and the realm.

Running it in-process is the point: on serverless, a separate service would have to guess which instance holds the sockets. Here the tool call reads the same state the tick loop writes. Both calls go through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), the classifier on `typesafe-ai/jev` and the responder on `deepseek/deepseek-v4.1-flash`, with a busy flag and a cooldown so it can't be flooded. Arrivals are greeted from written lines with no model call, so walking through the gate costs nothing.

### Proximity voice, on the same socket

Voice is opt in and off by default, `T` to talk. Opus frames go up the same WebSocket as binary beside the JSON ones ([`shared/utils/voice.ts`](shared/utils/voice.ts)), so there is no peer connection and nobody ever learns anybody's address. The server owns who hears whom, from the authoritative positions: 24 tiles to connect, 30 to drop, at most six listeners, recomputed at 2 Hz. It relays a frame the moment it arrives rather than on the tick, so latency is not quantised to 50 ms. Playback is panned at the speaker's rendered rig and rolled off to silence at the drop radius.

A push-to-talk utterance is also recorded into a container and transcribed through the Gateway ([`server/utils/transcribe.ts`](server/utils/transcribe.ts)), then posted through the *same* function a typed line uses, which is why the Oracle reads speech with no change. Open mic is never transcribed, nothing is stored and no transcript is logged. Encoding uses WebCodecs, so voice is Chromium-only today and the menu says so rather than failing quietly.

### Identity without a login

New arrivals land on a gate ([`app/components/CharacterGate.vue`](app/components/CharacterGate.vue)) to pick a character in a live turntable preview: gender, outfit, hairstyle, beard, colorway and a name. `POST /api/auth` sanitizes the choice and sets an HMAC-signed, `HttpOnly` cookie ([`server/utils/session.ts`](server/utils/session.ts)). No passwords, no user table.

The cookie rides the same-origin WebSocket upgrade and [`server/api/ws.ts`](server/api/ws.ts) verifies it to build the player, so the frequent reconnects on Vercel restore the *same* character and returning visitors skip the gate entirely. It's tamper-evident: a mangled signature is treated as unauthenticated. Only one live session per identity is allowed, so a second tab takes over and the first one is told why. Your last position is remembered too ([`server/utils/positions.ts`](server/utils/positions.ts)), so you resume where you left off instead of at the gate.

### Art and sound from code (plus a CC0 model or two)

- **Textures.** Seamless plaster, stone, timber, terracotta and earth textures are drawn at runtime ([`app/utils/courtyardTextures.ts`](app/utils/courtyardTextures.ts), [`materialTextures.ts`](app/utils/materialTextures.ts)) and projected over the UV-less models.
- **Sound.** Everything is synthesized from raw Web Audio ([`app/utils/audio/`](app/utils/audio)), which is why there is not an audio file in the repo: footsteps with a timbre per surface, jumps, splashes, wind that rises with altitude and weather, rain, crickets, birdsong, thunder off the same hashed strike the sky flashes, the fountain and the moat, all of it positional for other players.
- **Sky.** Two layers of twinkling stars and a Milky Way on a celestial sphere, a moon with an eight-night phase cycle, a cloud march that thickens toward the horizon, GPU rain and lightning clusters hashed off the server clock so every client sees the same strike ([`app/utils/courtyardSky.ts`](app/utils/courtyardSky.ts)).
- **Characters.** Composed from Quaternius' CC0 *Universal* packs by [`scripts/convert_universal_characters.py`](scripts/convert_universal_characters.py): an outfit from *Modular Character Outfits*, a head from *Universal Base Characters* trimmed to the neck, and a shared clip set from *Universal Animation Library* 1 & 2. Because every body, outfit and animation shares one 65-bone universal skeleton, the clips ship once in `animations.glb` (skeleton only, no mesh) and bind to every character by bone name with no retargeting. The chosen colorway dyes just the outfit cloth at runtime.
- **Architecture.** Original Blender models in `public/models/courtyard` provide the buildings, fountain and vegetation, generated by `scripts/build_courtyard_*.py`. Dimensions in [`shared/utils/courtyard.ts`](shared/utils/courtyard.ts) and [`kit.ts`](shared/utils/kit.ts) define the collision footprints, so what you see and what you bump into come from one table. Wild vegetation and the ambient critters come from Quaternius nature and monster packs.

## Architecture

```
app/
├── pages/index.vue           # title screen: pitch, live world stats, Play
├── pages/play.vue            # game shell: HUD, chat, hotbar, map, Escape menu
├── composables/
│   ├── useGame.ts            # connection, reconnect, roster, chat, clock sync
│   ├── useWorld.ts           # streamed chunks and the mirrored edit deltas
│   ├── useBuild.ts           # hotbar, targeting, ghost preview
│   └── useVoice.ts           # opt-in proximity voice
└── components/
    ├── GameScene.client.vue  # Tres canvas, pointer lock, input
    ├── MazeScene.vue         # the 3D world: terrain, sky, players, Oracle
    └── CharacterGate.vue     # onboarding

shared/
├── types/game.ts             # the wire protocol
├── data/courtyard-*.json     # the authored town
└── utils/
    ├── world.ts              # chunks, generation, terrain and placement edits
    ├── maze.ts               # collision and shared kinematics
    ├── building.ts           # what an edit is allowed to do
    └── voice.ts              # the binary audio framing

server/
├── api/ws.ts                 # /api/ws — one crossws handler everywhere
└── utils/
    ├── game.ts               # authoritative 20 Hz tick loop
    ├── world.ts              # chunk streaming and edit validation
    ├── chunkStore.ts         # Upstash Redis, write-behind, in-memory fallback
    └── oracle.ts             # the Oracle's classifier + responder
```

## Reconnects

Connections close when a Vercel Function reaches its [max duration](https://vercel.com/docs/functions/limitations#max-duration). The client reconnects with exponential backoff, the signed cookie restores the same character and the chunks stream in again. A `ping`/`pong` heartbeat detects half-open sockets client-side, doubles as a keepalive server-side, and its round trip is the latency the HUD shows.

## Known limits

The roster, the chunk cache and the voice pairing all live in one function instance's memory. Redis keeps the stored world consistent across instances, but two players on different instances would not see or hear each other, so this runs on a single instance per realm today. Multi-instance sharding is open.

## License

[MIT](LICENSE)
