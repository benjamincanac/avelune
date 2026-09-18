# Avelune Roadmap

> A 3D MMO on Vercel: a shared fantasy town at the centre of a persistent world
> players terraform and build in, plus an AI Oracle NPC.
> Nuxt + TresJS + Vercel WebSockets. It exists to demo the Vercel WebSocket upgrade
> under a real authoritative game loop, plus an AI NPC reading live game state.
> This file is the source of truth for what's done and what's next — update it as work lands.

## Status: done ✓

### Open world (plan: `.claude/OPEN-WORLD.md`)
- [x] Chunked `World` (32×32 chunks of 32 tiles, 1024² world, corner heightmap + surface raster + placements) replaces the flat 144² plan; physics reads the 3×3 chunk neighbourhood, slope rule for cliffs, world edge is a wall (`shared/utils/world.ts`, `maze.ts`, `terrain.ts`)
- [x] The town is a protected region at its old coordinates: flat, seeded from the committed JSON, refuses edits; the dev editor is unchanged
- [x] Terrain chunk meshes, per-chunk instanced props, deterministic meadow-with-copses vegetation as removable wild props (`app/utils/terrainChunk.ts`, `chunkProps.ts`, `shared/utils/vegetation.ts`)
- [x] Streaming: `welcome.world`, `chunk`/`unchunk` for the 5×5 around each player, `terrain`/`place`/`remove` deltas, `state` filtered to 96 tiles (`server/utils/world.ts`, `app/composables/useWorld.ts`)
- [x] Terraform (raise/lower/flatten/paint, brush 1..3) and build (12-piece kit on a 2 unit grid, stacking, ramps, ownership, 500 piece budget) with every rule in `shared/utils/building.ts` and enforced server-side; pointer-locked crosshair targeting, hotbar, ghost preview
- [x] Elevation bands: non-town placements carry `z` as base elevation, walk under a raised floor, stand on it, climb `Kit_Stairs`
- [x] Persistence: Upstash Redis, one key per chunk, write-behind with CAS on `version`, drain on shutdown, in-memory store when unset; `scripts/world-admin.mjs`
- [x] Tests: `pnpm test` runs world, rampart, terrain, building and chunk-store suites; `ws-test.mjs` covers streaming, terraform, felling, refusals; `spawn-bots.mjs --dig` load test (30 bots, ~1 ms average tick)
- [x] Deed plots: a `Kit_Deed` post claims a 16-tile square (`DEED_SIZE`, one per player) where only the owner terraforms, builds or clears wild growth; plot outlines on the ground and on the full map, refusals that name the owner
- [x] Oracle sees the built world: `arena_state` carries pieces standing, top builders, the busiest spot worded as a direction from the gate, weather, time of day and the realm
- [x] Building bots: `spawn-bots.mjs --build` claims a plot, levels it, raises a two-storey hut or a fence paddock on cells and edges, paves back to the road, and runs the shared `resolveBuild` before sending, so zero refused builds is the pass mark. Refuses to target the prod host
- [x] Per-chunk collision cells (8 tiles): `propsNear` and the build checks read only the cells a query covers. 12 bots among 377 pieces went from 4.7 ms to 1.4 ms average tick
- [x] Realms: every store key is scoped by `AVELUNE_REALM` / `VERCEL_REGION`, one stored world per deploy region, named in the HUD and on the landing page (`shared/utils/realm.ts`)

### Core loop & simulation
- [x] Shared time of day (`dawn|day|sunset|night|auto`), independent of weather and synchronized on join. Players ask the Oracle for it; `/time` is a dev-only command.
- [x] Shared weather (`clear|overcast|rain|auto`), synchronized for connected players and new arrivals. Players ask the Oracle for it; `/weather` is a dev-only command.
- [x] Authoritative 20 Hz server sim; client prediction via shared kinematics (`shared/utils/maze.ts` → `stepBody`), input-aware reconcile that never drags you backward against your own input
- [x] Third-person camera (wall-aware boom), raw-delta mouse-look, pointer lock + fullscreen (`F`)
- [x] Jumpable rampart parapets: players can vault from the gallery into town or onto the outer berm, while walking still respects the rails.
- [x] Dash animation blends promptly and follows the shared burst duration, without stale remote sprint replay. Remote run/idle uses support height on stairs and ramparts.
- [x] Jump (`Space`) & dash (`Shift`) — server-validated, predicted, dash flag synced; dash-from-standstill launches forward
- [x] Elevation: solid props are walkable ledges in the shared authoritative plan; `SOLID_PROPS` distinguishes low vaultable clutter from tall unjumpable blockers
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via the server clock (`welcome.now`)
- [x] Round WoW-style minimap (top-right), full arena, no fog
- [x] Protocol test suite (`scripts/ws-test.mjs`) — creates characters over `/api/auth`, then asserts `welcome`/`state`/`chat`/`pong`/`leave`/`kicked`
- [x] Bot load-testing script (`scripts/spawn-bots.mjs`)

### UI redesign (design handoff: "Avelune UI — 2a Broadcast")
- [x] One visual system across all seven screens — title, HUD, character creator, world map, game menu, chat, entry. Three type roles (Saira Condensed for structure, Archivo for prose, IBM Plex Mono for anything the server reports), one aqua accent, `.frost` panels, the corner notch on primary actions and the armed hotbar slot only, and the HUD rule that in-world text gets an edge wash rather than a panel. Tokens in `app/assets/css/main.css` + `app/app.config.ts`; the contract is in `.claude/agents/game-ui.md`
- [x] Live data is content, not debug output: a real measured round trip (`useGame.rtt`, from the heartbeat), a world feed (`useFeed`, worded from `join`/`terrain`/`place`/`remove` in-game and from the server's own ring on the title screen), the roster, the day's peak and a nine-hour sparkline
- [x] Entry screen shows the handshake step by step from real state — socket, realm, `N / 25` chunks, placement — and latches shut once you are in, surfacing only a dropped socket after that
- [x] Protocol additions for it: `terrain` carries `by`/`mode`/`at` (a height has no owner the way a placement does), `welcome.world` carries `streamed`
- [ ] Oracle provenance chip (`READ N CHUNKS · M PLAYERS`) — dropped, not faked: the persona forbids numbers and nothing counts them (handoff open question 4)
- [ ] World-map plot hover tooltip (`PLOT 04 · TORVALD`, `18 PIECES · EDITED 14:01`) — dropped: per-plot piece counts and edit times aren't tracked

### Identity, onboarding & app shell
- [x] Avelune branding, town wording in the UI, and metadata matching the current world. The identity cookie is `avelune_id`, so earlier characters re-onboard once.
- [x] **Signed-cookie identity** (`server/utils/session.ts`, HMAC-SHA256, ~10-year `avelune_id` cookie); `GET`/`POST /api/auth`; WS upgrade gated on the cookie. Character is **permanent — no logout**
- [x] **Character creator** (`CharacterGate`): gender × outfit (Peasant/Ranger) × hairstyle × outfit colorway, name, Randomize, live draggable 3D turntable bust. Runtime cloth-only recolor (`app/utils/appearance.ts`)
- [x] **Landing page** (`app/pages/index.vue`, prerendered): wordmark, pitch, the three feature lines, a live `N in town · <realm>` line from `GET /api/status`, controls, GitHub, and a Play button to `/play` that reads `Continue as <name>` when the auth probe finds a cookie. Backdrop is a still of the town (`public/landing.jpg`), not the 3D scene
- [x] **Direct entry**: `/play` (`app/pages/play.vue`, `noindex`) probes `/api/auth` — a returning player drops straight into the arena, a new visitor lands on character creation
- [x] **In-game Escape menu** (WoW-style): controls reference + fullscreen + return-to-game (+ a dev-only world editor button). While pointer-locked the Escape keydown is browser-swallowed, so `GameScene` emits `unlock` on unintentional pointer-lock loss and the page opens the menu on it
- [x] **Single session per identity**: `sessions` is keyed by identity id, so a second tab takes over — the newest socket wins and the old one gets a `kicked` frame (client stops reconnecting, shows an overlay with "play here instead"). `disconnect` is guarded by `sessions.get(id) === session` so the booted socket can't evict the live player
- [x] Chat: bottom-left, arena-wide history, floating bubbles over rigs, system announcements (`announce()`)

### AI showcase
- [x] **Oracle AI NPC** — in-process, run by the game loop (`server/utils/oracle.ts`): a cheap classifier decides whether a chat line is addressed to it, then an in-character responder answers with an `arena_state` tool reading the live `snapshot()`. `anthropic/claude-haiku-4.5` via the Vercel AI Gateway. It speaks in the shared chat (no separate dialog); `MushroomKing.glb` body on the sand with a proximity hint. Deliberately in-process, not eve — see `memory/hub-oracle-ai-npc.md`

### World, art & assets
- [x] Rebuilt sprint with forward lean, opposing arm drive and a faster stride. Jog and sprint preserve footfall phase through dash transitions.
- [x] Shared moat swimming with damped buoyancy, a capped swim speed and automatic shallow-water walking. Original Blender breaststroke and tread loops use the existing universal skeleton; continuous arm paths, articulated shoulders and chest, timed breathing, and a delayed frog kick lead into each glide. Surface rings follow swimmers.
- [x] Traversable moat with a submerged floor, water drag, bridge underpasses and an exit staircase through the outer bank.
- [x] Material-specific seamless color, normal and roughness textures for limestone, plaster, timber, terracotta and earth. World projection covers the existing UV-less models, with stone courses on bridge and gallery paving.
- [x] Clear fountain plaza corners, with building footprints kept beyond the stone border and its walking margin.
- [x] Street-facing residential blocks with clear main avenues and side alleys. Two stone staircases reach a continuous inner rampart gallery, with shared stair elevations, rail collision and underpasses.
- [x] Fortified city with connected ramparts and bastions, an open South Gate, an arched bridge across a moat, and a walkable outer meadow. Players spawn outside; the Oracle stands just inside the gate. Shared collision covers walls, moat and bridge rails.
- [x] Expanded town to 80×80 playable units, with South Gate, Fountain Square, Market Lane, Willow Gardens and High Court. Streets, garden beds and landscape boundaries derive from shared town data.
- [x] Denser village with 14 buildings, connected side streets, varied roof heights, terracotta tiles, timber façades, ivy, blue banners and flowering planters. Overhead garlands attach to authored tree trunks with visible rope ties. Shared-physics connectivity tests cover streets and building frontages.
- [x] Colorful fantasy courtyard: custom buildings, tiled roofs, shuttered windows, fountain, market stalls, gardens, trees and a central sparring circle. Authored `courtyard-*.json` layouts replace the active colosseum layout; the original `hub-*.json` files are retained.
- [x] Original sculpted environment models generated in Blender, curved roofs, carved fountain, botanical assets, layered terrain, grass wind, contact occlusion and restrained bloom. Unused downloaded environment models and their editor thumbnails have been removed.
- [x] Village outskirts: irregular woodland clusters, layered shrubs and wildflowers, denser meadow grass, and lightweight trees on distant hills. Decorative vegetation stays outside the playable boundary.
- [x] Rampart gallery, stairs and rails are authored placements (`Courtyard_Gallery` / `Courtyard_Stairs` / `Courtyard_Rail`, baked by `scripts/bake-ramparts.ts`) with shared elevated collision, so the editor can move them like any prop. The deck sits flush on the curtain wall.
- [x] Botanicals swapped to the Quaternius Stylized Nature MegaKit (five tree variants, bushes, ferns, clover, flowers, rocks) at roughly 8x fewer triangles per tree; alpha-cut foliage is excluded from GTAO. Meadow grass reworked into shorter, denser, lighter tufts.
- [x] Anime fantasy art pass: steeper slate roofs, dormers, exposed gable timber, pointed leaf canopies, denser wind-driven meadows and radial limestone paving. Atmospheric sky with volumetric cloud shading, sun/moon/stars and sky reflections follows the shared clock. Rebuilt architecture and nature assets use Meshopt compression.
- [x] Fountain overflow follows eight scalloped outlets, with gravity-driven narrowing, pressure variation and lower-stream droplet breakup.
- [x] Enlarged wadeable fountain with shared stepped collision and water drag, player entry splashes and wakes, and refracted basin views.
- [x] Fountain impacts displace water locally into volume-balanced ripples, transport and disperse foam, and launch splashes along the surface normal. Both bowls use circular reflective surfaces with Fresnel, fine animated normals and guarded 256px planar reflections. Surface waves remain cosmetic; wading uses shared authoritative kinematics.
- [x] Central enlarged fountain with gravity driven jets, splash droplets and fixed timestep wave simulation in both bowls. Surface waves stay visual; shared stepped basin collision supports wading.
- [x] Courtyard asset dimensions shared with collision, merged geometry and instanced placements, animated pennants and fountain ripples, readable night lighting, courtyard minimap landmarks.
- [x] **Colosseum arena** (`HUB_LAYOUT` 56×56 + `generateHub`): open sand disc with a rune circle, walled in by an unbroken stands ring — there is no exit, the arena is the whole world. Every visible piece is a hand-placed kit piece baked into `shared/data/hub-structure.json` and rendered instanced; only the sand and the ring are procedural
- [x] Downloaded Peasant/Ranger character models restored. Removed the experimental character and its generator, assets and customization code. Escape menu character editing supports Save and Cancel.
- [x] Character roster: 8 Universal-skeleton Peasant/Ranger (M/F × 2 hairstyles) sharing one `animations.glb` clip library (Idle/Run/Jump/Roll), WebP textures, runtime colorway swap
- [x] Asset pipeline: `convert_universal_characters.py` (WebP-crash byte-sanitizer), `rebuild_animations.py`, `convert_props.py`, `convert_fantasy.sh`/`convert_kits.sh` (`gltf-transform optimize` → meshopt + WebP), `make_og.py`
- [x] **Dev-only in-game world editor** (Escape menu → "World editor", or `/?editor=1`; `import.meta.dev`-gated): fly camera + click-to-place / select / drag / rotate / scale / elevation, palette from `shared/utils/propCatalog.ts`. Pieces bake into `hub-structure.json`, free-standing clutter into `hub-props.json`, both appended to `plan.props` (`hand:true`) through `makeProp` so collision matches what you see. Tree-shaken from prod; save routes 404 in prod (read-only FS)
- [x] **Real `og.png`** rendered from game assets (`make_og.py`)

### Ship
- [x] `git init`, `benjamincanac/avelune` repo created & pushed
- [x] First Vercel deploy

### Removed in the simplification (2026-09-10)
The project was cut back to its actual purpose (WebSockets + AI NPC demo). Gone: the
dungeon tower and its floors, procedural labyrinth generation, biomes, timed traps,
deaths, floor clears, records/leaderboards, fog of war, spectator mode, the video main
menu, the great door (with `bigDoor.ts` and its wall notch), and the daily-seed
machinery. `shared/utils/maze.ts` is now just the arena plus the collision/kinematics
both sides share.

## Next up (prioritized)

### 1. Verify prod
- [x] **Verify the WebSocket upgrade in prod** — verified 2026-09-16 on `avelune-online.vercel.app` (`cdg1`): the full `ws-test.mjs` (124 checks: streaming, terraform, felling, building, budgets, takeover) passes against the live socket, and 15 walking bots held their connections for 45 s on one instance (every welcome counted the previous bots). Heavier load and the multi-instance question are still open
- [x] **Prod persistence** — verified 2026-09-18: `/api/status` reports `persistent: true` in the `fra1` realm after linking the store (the marketplace sets `KV_REST_API_*`, which the server now reads). The function moved from `cdg1` to `fra1`, so the Frankfurt world started empty
- [ ] Verify the Oracle works deployed: prod Gateway calls were intermittently answered by the app's *own 404 page* — Nuxt nightly replaces `globalThis.fetch` with a router loopback once a warm instance renders any page/error ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)); fixed by pinning the Oracle's provider to the boot-captured `nativeFetch` (`server/utils/nativeFetch.ts` + plugin). Redeploy, then ask "who are you?" in chat (needs `AI_GATEWAY_API_KEY`)
- [ ] Retroactive compression pass over the pre-existing `public/models/props/**` GLBs (the newer kits are already meshopt+WebP)

### 2. Make the town worth standing in
- [ ] Audio — nothing is implemented yet: footsteps, jump/land, dash whoosh, ambient wind/crowd, positional audio for other players (three.js `AudioListener`/`PositionalAudio`)
- [ ] Emotes / a wave or cheer clip, so players can interact without typing
- [ ] Mobile/touch controls (virtual stick + look drag)

### 3. Give building a reason
- [ ] Gathering: felling wild trees and rocks drops wood and stone, kit pieces cost them
- [ ] Spawn at your deed (or last position) instead of the gate every session
- [ ] Doors that open, torches that light (a small pool of point lights near the camera)
- [ ] Plot decay: release a deed after its owner has been away for some weeks
- [ ] Nothing stops a player walling themselves in on their own tile (`resolveBuild` never consults player positions)
- [ ] Client patches instances on `place`/`remove` instead of rebuilding every batch and the grass of that chunk
- [ ] Compact binary placements in `chunk` frames for built-up areas (they travel as JSON today)
- [ ] Bot huts pick odd roof rotations (the plan's geometry, not the rules)

### 4. Oracle depth
- [x] **Greets arrivals by name** — written in-character lines picked to suit the company and the sky (`oracleGreeting`, no model call, so arrivals cost nothing), spoken the tick the player crosses the South Gate line. Once per identity per 30 min, never over a reply in flight, abandoned after 20s of a busy Oracle
- [x] Give the Oracle more to see: time of day, weather and the built world are in `arena_state`
- [ ] AI announcer voice for shared events (joins, milestones) — deferred; see `memory/ai-announcer-tower-voice.md`

### 5. Stretch
- [ ] Proximity voice chat — WebRTC, signaling over the game socket
- [ ] Multi-instance sharding once one function instance isn't enough (the roster and chunk cache are in-process memory today; Redis CAS keeps the store consistent but players on two instances would not see each other). crossws 0.4.12 has a Redis sync backplane, but Nitro builds its adapter as `wsAdapter({ resolve })` with no way to pass `sync`, and the backplane only fans out to peers, so server copies of a chunk still need their own server-to-server channel for edit deltas
- [ ] Multi-region realms as a server list: one project per region with its own hostname, and a realm picker with live counts on the landing page
- [ ] Reject unauthenticated sockets with a 401 in the `upgrade` hook instead of open-then-close (needs the crossws bump below)

## Known issues / verify-me

- [ ] **Nitro-beta dev server can die/crash-loop under the arena's GLB load burst** (dev worker exits silently or "Dev worker failed after 3 retries"); a prod build (`pnpm build` + `NUXT_SESSION_PASSWORD=… node .output/server/index.mjs`) serves the same session rock-solid — use it for headless verification (see the run-mmo skill)
- [ ] **The socket drops and reconnects mid-session**, emptying the streamed world until chunks land again (`useWorld.reset()`). Pre-existing — `driver.mjs map` reproduces it on the pre-redesign commit too, where it showed as a silent "0 chunks loaded" — but the redesign now says so out loud (the entry overlay's reconnect notice, the map's live pip going amber). Two flavours seen: a recycle after roughly three minutes, and a drop within seconds of the map-mode canvas click. Worth pinning down whether the close is Nitro/crossws, the platform, or something the click triggers
- [ ] Ranger's **hairstyle selector has no visible effect** — the hood is always baked on and covers it; the intended "hooded ⇒ no hairstyle choice" isn't enforced in the gate UI
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [x] Camera boom samples solid prop heights as well as the wall grid to avoid clipping into courtyard buildings
- [ ] **Nitro 3.0.260903-beta cannot be adopted yet.** It needs a Nuxt 5 nightly >= 29814795, and those nightlies mount Nitro as a Vite environment whose dev hook calls `server.httpServer.on("upgrade")` while Nuxt runs Vite in middleware mode (`httpServer` is null): `nuxt dev` crashes, and Nuxt has no upgrade forwarding of its own. Prod builds were fine. Both pins stay on the June pair (reason in `pnpm-workspace.yaml`); worth an upstream issue since it blocks crossws 0.4.12

- [x] ~~Character GLB WebP-support race crashes on cold concurrent loads~~ — mitigated: the convert script byte-sanitizes broken WebP refs; load a roster sequentially to warm WebP first (see `.claude/agents/scene-3d.md`)
- [x] ~~`scripts/ws-test.mjs` broken by the signed-cookie gate~~ — it now does the `/api/auth` handshake and replays the cookie on the upgrade

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `~/GitHub/benjamincanac/.claude/launch.json` (name `mmo`, autoPort; port 3000 is occupied by another process on this machine)
- Package manager is **pnpm**; `pnpm typecheck` / `pnpm lint`
- Oracle needs `AI_GATEWAY_API_KEY` locally **and on Vercel** (OIDC is request-scoped — absent in the WS/game-loop context); model id is a Gateway string (`anthropic/claude-haiku-4.5` for both classifier and responder); identity secret is `NUXT_SESSION_PASSWORD`
- Blender 5.1.2 at `/Applications/Blender.app/Contents/MacOS/Blender` — asset scripts run headless (`--background --python scripts/<x>.py -- <args>`); kit conversion uses `npx @gltf-transform/cli optimize`
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); the Universal characters + Modular Fantasy Outfits are itch.io-only behind Cloudflare (manual download, then run `convert_universal_characters.py`)
- World persistence is Upstash Redis through the Vercel marketplace: `NUXT_UPSTASH_REDIS_REST_URL` and `NUXT_UPSTASH_REDIS_REST_TOKEN` (the bare `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` a linked store sets are read too). Both unset means the in-memory store, which is what local dev and every test run on — the world simply resets with the process. Every key is scoped by realm (`AVELUNE_REALM`, else `VERCEL_REGION`, else `local`): one stored world per region. Chunks are administered with `pnpm exec jiti scripts/world-admin.mjs <export|import|wipe|reset> [--realm fra1]`
- Protocol testing: `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
- Repo: `github.com/benjamincanac/avelune` (branch `main`)
- **Shared-code invariant:** anything affecting gameplay position/collision/elevation or edit validation must live in `shared/utils/` (`maze.ts`, `world.ts`, `building.ts`) so server and prediction agree; client-only code renders it
- Headless verification: `pnpm build` then `NUXT_SESSION_PASSWORD=x PORT=<port> node .output/server/index.mjs`; the run-mmo driver has `arena`, `walk`, `meadow` and `build` modes
- Domain subagents live in `.claude/agents/` (`world-sim`, `server-net`, `scene-3d`, `game-ui`, `oracle-ai`, `assets`); see `CLAUDE.md`
