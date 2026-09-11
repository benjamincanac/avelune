# Avelune Roadmap

> A 3D MMO on Vercel, starting with a shared fantasy courtyard and an AI Oracle NPC.
> Nuxt + TresJS + Vercel WebSockets. It exists to demo the Vercel WebSocket upgrade
> under a real authoritative game loop, plus an AI NPC reading live game state.
> This file is the source of truth for what's done and what's next — update it as work lands.

## Status: done ✓

### Core loop & simulation
- [x] Shared `/time dawn|day|sunset|night|auto` command, independent of weather and synchronized on join.
- [x] Shared `/weather clear|overcast|rain|auto` chat command, synchronized for connected players and new arrivals.
- [x] Authoritative 20 Hz server sim; client prediction via shared kinematics (`shared/utils/maze.ts` → `stepBody`), input-aware reconcile that never drags you backward against your own input
- [x] Third-person camera (wall-aware boom), raw-delta mouse-look, pointer lock + fullscreen (`F`)
- [x] Jump (`Space`) & dash (`Shift`) — server-validated, predicted, dash flag synced; dash-from-standstill launches forward
- [x] Elevation: solid props are walkable ledges in the shared authoritative plan; `SOLID_PROPS` distinguishes low vaultable clutter from tall unjumpable blockers
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via the server clock (`welcome.now`)
- [x] Round WoW-style minimap (top-right), full arena, no fog
- [x] Protocol test suite (`scripts/ws-test.mjs`) — creates characters over `/api/auth`, then asserts `welcome`/`state`/`chat`/`pong`/`leave`/`kicked`
- [x] Bot load-testing script (`scripts/spawn-bots.mjs`)

### Identity, onboarding & app shell
- [x] Avelune branding, village wording in the UI, and metadata matching the current world. Existing deployment URLs and identity cookies are preserved.
- [x] **Signed-cookie identity** (`server/utils/session.ts`, HMAC-SHA256, ~10-year `tempest_id` cookie); `GET`/`POST /api/auth`; WS upgrade gated on the cookie. Character is **permanent — no logout**
- [x] **Character creator** (`CharacterGate`): gender × outfit (Peasant/Ranger) × hairstyle × outfit colorway, name, Randomize, live draggable 3D turntable bust. Runtime cloth-only recolor (`app/utils/appearance.ts`)
- [x] **Direct entry**: no landing screen. `index.vue` probes `/api/auth` — a returning player drops straight into the arena, a new visitor lands on character creation
- [x] **In-game Escape menu** (WoW-style): controls reference + fullscreen + return-to-game (+ a dev-only world editor button). While pointer-locked the Escape keydown is browser-swallowed, so `GameScene` emits `unlock` on unintentional pointer-lock loss and the page opens the menu on it
- [x] **Single session per identity**: `sessions` is keyed by identity id, so a second tab takes over — the newest socket wins and the old one gets a `kicked` frame (client stops reconnecting, shows an overlay with "play here instead"). `disconnect` is guarded by `sessions.get(id) === session` so the booted socket can't evict the live player
- [x] Chat: bottom-left, arena-wide history, floating bubbles over rigs, system announcements (`announce()`)

### AI showcase
- [x] **Oracle AI NPC** — in-process, run by the game loop (`server/utils/oracle.ts`): a cheap classifier decides whether a chat line is addressed to it, then an in-character responder answers with an `arena_state` tool reading the live `snapshot()`. `anthropic/claude-haiku-4.5` via the Vercel AI Gateway. It speaks in the shared chat (no separate dialog); `MushroomKing.glb` body on the sand with a proximity hint. Deliberately in-process, not eve — see `memory/hub-oracle-ai-npc.md`

### World, art & assets
- [x] Denser village with 14 buildings, connected side streets, varied roof heights, terracotta tiles, timber façades, ivy, blue banners and flowering planters. Overhead garlands attach to authored tree trunks with visible rope ties. Shared-physics connectivity tests cover streets and building frontages.
- [x] Colorful fantasy courtyard: custom buildings, tiled roofs, shuttered windows, fountain, market stalls, gardens, trees and a central sparring circle. Authored `courtyard-*.json` layouts replace the active colosseum layout; the original `hub-*.json` files are retained.
- [x] Original sculpted environment models generated in Blender, curved roofs, carved fountain, botanical assets, layered terrain, grass wind, contact occlusion and restrained bloom. Unused downloaded environment models and their editor thumbnails have been removed.
- [x] Village outskirts: irregular woodland clusters, layered shrubs and wildflowers, denser meadow grass, and lightweight trees on distant hills. Decorative vegetation stays outside the playable boundary.
- [x] Anime fantasy art pass: steeper slate roofs, dormers, exposed gable timber, pointed leaf canopies, denser wind-driven meadows and radial limestone paving. Atmospheric sky with volumetric cloud shading, sun/moon/stars and sky reflections follows the shared clock. Rebuilt architecture and nature assets use Meshopt compression.
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
- [ ] **Verify the WebSocket upgrade under load in prod** — load-bearing; the whole architecture rests on it
- [ ] Verify the Oracle works deployed: prod Gateway calls were intermittently answered by the app's *own 404 page* — Nuxt nightly replaces `globalThis.fetch` with a router loopback once a warm instance renders any page/error ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)); fixed by pinning the Oracle's provider to the boot-captured `nativeFetch` (`server/utils/nativeFetch.ts` + plugin). Redeploy, then ask "who are you?" in chat (needs `AI_GATEWAY_API_KEY`)
- [ ] Retroactive compression pass over the pre-existing `public/models/props/**` GLBs (the newer kits are already meshopt+WebP)

### 2. Make the village worth standing in
- [ ] Audio — nothing is implemented yet: footsteps, jump/land, dash whoosh, ambient wind/crowd, positional audio for other players (three.js `AudioListener`/`PositionalAudio`)
- [ ] Emotes / a wave or cheer clip, so players can interact without typing
- [ ] Mobile/touch controls (virtual stick + look drag)

### 3. Oracle depth
- [ ] Give the Oracle more to see: time of day and weather in `arena_state`, so it can remark on the sky
- [ ] AI announcer voice for shared events (joins, milestones) — deferred; see `memory/ai-announcer-tower-voice.md`

### 4. Stretch
- [ ] Proximity voice chat — WebRTC, signaling over the game socket
- [ ] Multi-instance sharding once one function instance isn't enough (the roster is in-process memory today)

## Known issues / verify-me

- [ ] **Nitro-beta dev server can die/crash-loop under the arena's GLB load burst** (dev worker exits silently or "Dev worker failed after 3 retries"); a prod build (`pnpm build` + `NUXT_SESSION_PASSWORD=… node .output/server/index.mjs`) serves the same session rock-solid — use it for headless verification (see the run-mmo skill)
- [ ] Ranger's **hairstyle selector has no visible effect** — the hood is always baked on and covers it; the intended "hooded ⇒ no hairstyle choice" isn't enforced in the gate UI
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [x] Camera boom samples solid prop heights as well as the wall grid to avoid clipping into courtyard buildings
- [x] ~~Character GLB WebP-support race crashes on cold concurrent loads~~ — mitigated: the convert script byte-sanitizes broken WebP refs; load a roster sequentially to warm WebP first (see `.claude/agents/scene-3d.md`)
- [x] ~~`scripts/ws-test.mjs` broken by the signed-cookie gate~~ — it now does the `/api/auth` handshake and replays the cookie on the upgrade

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `~/GitHub/benjamincanac/.claude/launch.json` (name `mmo`, autoPort; port 3000 is occupied by another process on this machine)
- Package manager is **pnpm**; `pnpm typecheck` / `pnpm lint`
- Oracle needs `AI_GATEWAY_API_KEY` locally **and on Vercel** (OIDC is request-scoped — absent in the WS/game-loop context); model id is a Gateway string (`anthropic/claude-haiku-4.5` for both classifier and responder); identity secret is `NUXT_SESSION_PASSWORD`
- Blender 5.1.2 at `/Applications/Blender.app/Contents/MacOS/Blender` — asset scripts run headless (`--background --python scripts/<x>.py -- <args>`); kit conversion uses `npx @gltf-transform/cli optimize`
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); the Universal characters + Modular Fantasy Outfits are itch.io-only behind Cloudflare (manual download, then run `convert_universal_characters.py`)
- Protocol testing: `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
- Repo: `github.com/benjamincanac/avelune` (branch `main`)
- **Shared-code invariant:** anything affecting gameplay position/collision must live in `shared/utils/maze.ts` so server and prediction agree; client-only code renders it
- Domain subagents live in `.claude/agents/` (`world-sim`, `server-net`, `scene-3d`, `game-ui`, `oracle-ai`, `assets`); see `CLAUDE.md`
