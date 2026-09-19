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
- [x] Streaming: `welcome.world`, `chunk`/`unchunk` for the 5×5 around each player, `terrain`/`place`/`remove` deltas, `state` filtered to 192 tiles (`server/utils/world.ts`, `app/composables/useWorld.ts`)
- [x] Terraform (raise/lower/flatten/paint, brush 1..3) and build (13-piece kit on a 2 unit grid, stacking, ramps, ownership, 500 piece budget) with every rule in `shared/utils/building.ts` and enforced server-side; pointer-locked crosshair targeting, hotbar, ghost preview
- [x] Elevation bands: non-town placements carry `z` as base elevation, walk under a raised floor, stand on it, climb `Kit_Stairs`
- [x] Build targeting: the crosshair ray takes the first thing it meets, terrain or piece, and builds against the face it entered. Wall, window, door, fence and gate panels snap to the nearest cell edge and take its heading, so `R` flips them rather than turning them. A build carries the aimed height, a hit past `EDIT_REACH` is walked back rather than refused, `Alt` aims with the cursor, and building uses a shoulder camera (`app/utils/buildTools.ts`, `shared/utils/building.ts`)
- [x] Persistence: Upstash Redis, one key per chunk, write-behind with CAS on `version`, drain on shutdown, in-memory store when unset; `scripts/world-admin.mjs`
- [x] Tests: `pnpm test` runs the world, rampart, moat, fountain, terrain, building, chunk-store, character, character-animation, index and icon-name suites; `ws-test.mjs` covers streaming, terraform, felling, refusals; `spawn-bots.mjs --dig` load test (30 bots, ~1 ms average tick)
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
- [x] Sprint (hold `Shift`, 1.6x through shared `speedMultiplier`, rides the `move` frame, `state.s` drives the remote sprint clip). Dash moved to `E` and right click
- [x] Jump (`Space`) & dash (`E`, right click) — server-validated, predicted, dash flag synced; dash-from-standstill launches forward
- [x] Elevation: solid props are walkable ledges in the shared authoritative plan; `SOLID_PROPS` distinguishes low vaultable clutter from tall unjumpable blockers
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via the server clock (`welcome.now`)
- [x] Square minimap (top-right), north-up, no fog, with the player's tile coordinates and the loaded chunk count beneath it
- [x] Protocol test suite (`scripts/ws-test.mjs`) — creates characters over `/api/auth`, then asserts `welcome`/`state`/`chat`/`pong`/`leave`/`kicked`
- [x] Bot load-testing script (`scripts/spawn-bots.mjs`)

### UI redesign (design handoff: "Avelune UI — 2a Broadcast")
- [x] One visual system across all seven screens: title, HUD, character creator, world map, game menu, chat and entry. Three type roles (Saira Condensed for structure, Archivo for prose, IBM Plex Mono for anything the server reports), one aqua accent, `.frost` panels, the corner notch on primary actions only, and the HUD rule that only what you click gets a panel. Interactive controls are Nuxt UI components styled through `ui`: the four button weights are `UButton` variants, the creator's choices are `URadioGroup`s. Tokens in `app/assets/css/main.css` and `app/app.config.ts`; the contract is in `.claude/agents/game-ui.md`
- [x] Live data is content, not debug output: a real measured round trip (`useGame.rtt`, from the heartbeat), a world feed (`useFeed`, seeded from `welcome.feed` and then worded from `join`/`terrain`/`place`/`remove`; the title screen reads the same server ring from `/api/status`), the roster, the day's peak and a nine-hour sparkline
- [x] Entry screen shows the handshake step by step from real state (socket, realm, `N / 25` chunks, `N / M` models, placement) and latches shut. The model step counts every GLB the scene loads through `useAssets`, parse included, so the overlay no longer lifts on bare ground. A failed load still settles and the wait is capped at 20 s once you are in, surfacing only a dropped socket after that
- [x] Protocol additions for it: `terrain` carries `by`/`mode`/`at` (a height has no owner the way a placement does), `welcome.world` carries `streamed`, `welcome.feed` carries the server's recent feed rows
- [ ] Oracle provenance chip (`READ N CHUNKS · M PLAYERS`): dropped rather than faked. The persona forbids numbers and nothing counts them (handoff open question 4)
- [ ] World-map plot hover tooltip (`PLOT 04 · TORVALD`, `18 PIECES · EDITED 14:01`): dropped, since per-plot piece counts and edit times aren't tracked
- [ ] Below ~1100px the handoff collapses the world feed to two rows and the roster to avatars only. The title screen stacks its clusters under `lg` instead
- [ ] Move the Escape menu and the kicked overlay onto `UModal` with `:portal="false"`: dialog semantics, without teleporting out of the fullscreen game root the way a default portal would
- [ ] Male and female read as the same size in the creator. The framing is faithful (posed head bone 1.604 against 1.522, so the male is 5.6% taller) but the female's Long hairstyle tops out near his scalp. The lever is the female rig's height or that hairstyle's volume, not the camera
- [ ] At phone width the creator's options panel covers the character. Low priority while `/play` needs a keyboard

### Identity, onboarding & app shell
- [x] Avelune branding, town wording in the UI, and metadata matching the current world. The identity cookie is `avelune_id`, so earlier characters re-onboard once.
- [x] **Signed-cookie identity** (`server/utils/session.ts`, HMAC-SHA256, ~10-year `avelune_id` cookie); `GET`/`POST /api/auth`; WS upgrade gated on the cookie. Character is **permanent — no logout**
- [x] **Character creator** (`CharacterGate`): gender × outfit (Peasant, Ranger, Knight, Noble, Wizard) × hairstyle × beard × outfit colorway, name, Randomise, live draggable 3D turntable on a fixed camera, so a taller character reads taller. Runtime cloth-only recolor (`app/utils/appearance.ts`)
- [x] **Title screen** (`app/pages/index.vue`, prerendered): the pitch and Play button beside a live roster, with the world feed, in-town/peak/round-trip counters and a nine-hour sparkline, all from `GET /api/status` (the round trip is the page's own measured fetch), then a How it works section with the controls. Play reads `Continue as <name>` when the auth probe finds a cookie. Lines that depend on the probe reserve their space, so hydration does not shift the layout. Backdrop is an aerial still shot from the world editor (`public/landing.jpg`, the run-mmo `still` mode), not the 3D scene
- [x] **Direct entry**: `/play` (`app/pages/play.vue`, `noindex`) probes `/api/auth` — a returning player drops straight into the arena, a new visitor lands on character creation
- [x] **In-game Escape menu** (WoW-style): controls reference + fullscreen + return-to-game (+ a dev-only world editor button). While pointer-locked the Escape keydown is browser-swallowed, so `GameScene` emits `unlock` on unintentional pointer-lock loss and the page opens the menu on it
- [x] **Single session per identity**: `sessions` is keyed by identity id, so a second tab takes over — the newest socket wins and the old one gets a `kicked` frame (client stops reconnecting, shows an overlay with "play here instead"). `disconnect` is guarded by `sessions.get(id) === session` so the booted socket can't evict the live player
- [x] Chat: bottom-left, arena-wide history that scrolls at a fixed height and only follows new lines when you are already at the bottom; bubbles over rigs are DOM overlays; system announcements (`announce()`)

### AI showcase
- [x] **Oracle AI NPC** — in-process, run by the game loop (`server/utils/oracle.ts`): a cheap classifier decides whether a chat line is addressed to it, then an in-character responder answers with an `arena_state` tool reading the live `snapshot()`. The classifier is a Jev evaluation model (`typesafe-ai/jev`) and the responder `deepseek/deepseek-v4.1-flash`, both via the Vercel AI Gateway. It speaks in the shared chat (no separate dialog); `MushroomKing.glb` body on the sand with a proximity hint. Deliberately in-process, not eve — see `memory/hub-oracle-ai-npc.md`
- [x] The Oracle turns to face whoever it is answering or greeting: its `chat` lines carry `to`, and the scene turns the NPC toward that player

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
- [x] Sky and weather pass (`app/utils/courtyardSky.ts`): two layers of coloured, twinkling stars and a Milky Way band on a celestial sphere that turns with the sun angle, a moon with maria and an eight-night phase cycle, a cloud march whose sample count grows toward the horizon, with towering heads, silver linings and a clear sky that holds only scattered puffs, GPU rain streaks wrapped around the camera, lightning clusters hashed off the server clock so every client sees the same strike (off under `prefers-reduced-motion`), and dawn mist.
- [x] Meadow grass rebuilt (`courtyardLandscape.ts`, `chunkGrassBlades`): upright clumps coloured from the ground's own pigment, about six tufts per tile following `meadowCover` (none on worn soil or scree), rank-based distance thinning with `updateGrassLod`, three-layer wind with rolling gusts, blades that bend away from players, dithered fade inside the detail ring.
- [x] Fountain overflow follows eight scalloped outlets, with gravity-driven narrowing, pressure variation and lower-stream droplet breakup.
- [x] Enlarged wadeable fountain with shared stepped collision and water drag, player entry splashes and wakes, and refracted basin views.
- [x] Fountain impacts displace water locally into volume-balanced ripples, transport and disperse foam, and launch splashes along the surface normal. Both bowls use circular reflective surfaces with Fresnel, fine animated normals and guarded 256px planar reflections. Surface waves remain cosmetic; wading uses shared authoritative kinematics.
- [x] Central enlarged fountain with gravity driven jets, splash droplets and fixed timestep wave simulation in both bowls. Surface waves stay visual; shared stepped basin collision supports wading.
- [x] Courtyard asset dimensions shared with collision, merged geometry and instanced placements, animated pennants and fountain ripples, readable night lighting, courtyard minimap landmarks.
- [x] **Colosseum arena** (`HUB_LAYOUT` 56×56 + `generateHub`): open sand disc with a rune circle, walled in by an unbroken stands ring — there is no exit, the arena is the whole world. Every visible piece is a hand-placed kit piece baked into `shared/data/hub-structure.json` and rendered instanced; only the sand and the ring are procedural
- [x] Downloaded Peasant/Ranger character models restored. Removed the experimental character and its generator, assets and customization code. Escape menu character editing supports Save and Cancel.
- [x] Biomes (`shared/utils/biome.ts`, `terrain.ts`, `vegetation.ts`): `biomeAt(seed, x, y)` labels the open land meadow, forest, pinewood, grove, heath or mountain from the same continuous fields the height uses, so borders are never cliffs. Mountains are real terrain up to about 74 units with a rock line at 34, a treeline at 38 and generated `SURFACE.snow` from about 50. The town and its 96 tile meadow belt are byte-identical to before. Vegetation samples the biome per candidate point: pines, autumn red twisted trees and dead trees joined the nature kit as `pine1-3`, `twisted1-3`, `dead1-3`, all fellable and plantable
- [x] Biome ground detail (`chunkScatter`, `chunkGrassBlades`): client only and deterministic per chunk. Flowers and clover in meadow, mushrooms, ferns and plants under the woods, pebbles on heath and mountain, grass density and dryness per biome, nothing on snow or bare stone
- [x] Ambient wildlife (`app/utils/critters.ts`, models from `convert_monsters.sh`): client side cosmetics, never on the wire and never authoritative. Bunnies, frogs and Mushnubs by biome, chickens and pigeons in town, ghosts on heath and mountain at night, one dragon orbiting the town. Deterministic per chunk, capped at 24 live, they flee players and are disposed with their chunk
- [x] Knight, Noble and Wizard outfits from the purchased CC0 source pack (`modular-character-outfits`), three colourways each, 18 roster GLBs in total. The Knight's closed helm is built without hair as one GLB per gender (`hairless` in `characters.ts`, the creator hides the hair picker), the Noble keeps a crown over the hair, the Wizard is bareheaded because the pack has no hat
- [x] Character roster: Universal-skeleton GLBs (M/F × 2 hairstyles per outfit, one per gender for the Knight) sharing one `animations.glb` clip library, WebP textures, runtime colorway swap. The preloader downloads every model at once and parses them in turn
- [x] Beard as its own choice, independent of the hairstyle: every male GLB of an outfit that leaves the face open ships a `Hair_Beard` node, and `applyBeard` sets its `visible` per rig clone. It rides the identity cookie and the `Player` frame as a boolean the server normalises, so females and the `hairless` Knight can never carry one
- [x] Asset pipeline: `convert_universal_characters.py` (WebP-crash byte-sanitizer), `rebuild_animations.py`, `convert_nature.sh`/`convert_kit.sh`/`convert_monsters.sh` (`gltf-transform optimize` → meshopt + WebP), `build_kit.py`, `build_courtyard_*.py`, `make_og.py`
- [x] **Dev-only in-game world editor** (Escape menu → "World editor", or `/?editor=1`; `import.meta.dev`-gated): fly camera + click-to-place / select / drag / rotate / scale / elevation, palette from `shared/utils/propCatalog.ts`. Pieces bake into `hub-structure.json`, free-standing clutter into `hub-props.json`, both appended to `plan.props` (`hand:true`) through `makeProp` so collision matches what you see. Tree-shaken from prod; save routes 404 in prod (read-only FS)
- [x] **Real `og.png`**, the landing hero at card size (`scripts/og.html`, headless Chrome)

### Ship
- [x] `git init`, `benjamincanac/avelune` repo created & pushed
- [x] First Vercel deploy

### Removed in the simplification (2026-09-10)
The project was cut back to its actual purpose (WebSockets + AI NPC demo). Gone: the
dungeon tower and its floors, procedural labyrinth generation, the dungeon's biomes
(unrelated to the open world biomes added since), timed traps,
deaths, floor clears, records/leaderboards, fog of war, spectator mode, the video main
menu, the great door (with `bigDoor.ts` and its wall notch), and the daily-seed
machinery. `shared/utils/maze.ts` is now just the arena plus the collision/kinematics
both sides share.

## Next up (prioritized)

### 1. Verify prod
- [x] **Verify the WebSocket upgrade in prod** — verified 2026-09-16 on `avelune-online.vercel.app` (`cdg1`): the full `ws-test.mjs` (124 checks: streaming, terraform, felling, building, budgets, takeover) passes against the live socket, and 15 walking bots held their connections for 45 s on one instance (every welcome counted the previous bots). Heavier load and the multi-instance question are still open
- [x] **Prod persistence** — verified 2026-09-18: `/api/status` reports `persistent: true` in the `fra1` realm after linking the store (the marketplace sets `KV_REST_API_*`, which the server now reads). The function moved from `cdg1` to `fra1`, so the Frankfurt world started empty
- [x] **Oracle works deployed**, confirmed in prod: prod Gateway calls were intermittently answered by the app's *own 404 page* — Nuxt nightly replaces `globalThis.fetch` with a router loopback once a warm instance renders any page/error ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)); fixed by pinning the Oracle's provider to the boot-captured `nativeFetch` (`server/utils/nativeFetch.ts` + plugin). Needs `AI_GATEWAY_API_KEY` on Vercel

### 2. Make the town worth standing in
- [x] **Audio** — `app/utils/audio/` synthesizes everything with raw Web Audio, so there is not an audio file in the repo: footsteps timed off travelled distance with a timbre per surface, jump, land scaled by fall speed, dash whoosh, water splash and swimming strokes, all of it for peers too at their rendered rig through a `PannerNode`. Beds for wind (rising with altitude and weather), rain, night crickets and day birdsong crossfaded on `dayness`, thunder derived from the same hashed strike the sky flashes, plus the fountain and the moat. Restrained UI ticks for arm, place, remove, refuse and the menu. The context is unlocked by the first click or key in the arena, `N` mutes, and the Escape menu carries a volume slider and a mute switch. Dev hook: `__maze.audio.debug()`. Not done: nothing for chat, emotes or a town crowd, and the Oracle gets one soft chord rather than a voice

- [x] **Proximity voice chat, over the game's own socket**. Opt in, off by default, `T` to talk (push to talk by default, open mic as a choice). No WebRTC and no third party: Opus goes up the same WebSocket as binary frames beside the JSON ones (`[u8 kind][u16 seq][opus]` up, `[u8 kind][u16 talker][u16 seq][opus]` down, `shared/utils/voice.ts`), so nobody ever learns anybody's address. The server owns who hears whom, at 24 tiles to connect, 30 to drop, at most 6 listeners, recomputed at 2 Hz over the voice-on players only, and it relays a frame on receipt rather than on the tick, so latency is not quantised to 50 ms. Encoding is WebCodecs `AudioEncoder`, mono 48 kHz in 20 ms frames at 28 kbps with FEC and DTX; playback is one `AudioDecoder` and jitter buffer per talker into a `PannerNode` on a new voice bus, positioned from the rendered rig and rolled off to silence exactly at the drop radius. Menu row with the mode, a voice level and a one-line state; a talking indicator on the HUD derived from arriving audio with no bit on the wire. Dev hook: `__maze.voice.debug()` / `setTalking()`
- [x] **Spoken lines reach the Oracle**. A push-to-talk utterance is recorded a second time into a container, uploaded to `POST /api/voice/say` on release and transcribed through the Vercel AI Gateway (`openai/gpt-4o-mini-transcribe`, falling back to `spacexai/grok-stt`; chosen by measurement on clips the browser really uploaded, where grok heard "Grok", Whisper heard "Dave" and Gemini heard "Michael" for "Oracle"), then posted through the *same* `sayChat` a typed line uses, so the Oracle's classifier needed no change. Marked `voice: true` on the frame for a small mic in the chat. Open mic is never transcribed. The mic track stays warm and only the encoder and the recorder are gated, since enabling it at the key press started the browser's gain control cold on the first word. Each clip carries the browser language as a hint. A clip whose loudest moment is under a floor is never sent, and a transcript in a script the speaker's language does not use is dropped, because a model handed near silence invents a sentence (a Japanese thank you and a Cyrillic non-word are the usual ones). The speaker gets their own spoken line echoed back, unlike a typed one. `AVELUNE_VOICE_DEBUG=1` keeps uploaded clips under `.data/voice-debug/` in dev only. Nothing is stored and no transcript is logged
- [ ] Emotes / a wave or cheer clip, so players can interact without typing

### 3. Give building a reason
- [ ] Gathering: felling wild trees and rocks drops wood and stone, kit pieces cost them
- [x] Resume at your last position instead of the gate every session (`server/utils/positions.ts`, one hash per realm), with a "Return to town" row in the Escape menu (`respawn` action, 30 s cooldown) for anyone stuck
- [ ] Spawn at your deed as an option
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
- [ ] Ocean and beaches as the edge of the world. The land drops below a sea level toward `WORLD_BOUNDS` on a continuous coast field, sand where the ground sits near that level. The real work is water as shared physics: `getSwimmingContact` is hard-wired to the moat today, so it needs a general sea-level rule, an answer for the far edge and for digging below the waterline. Lakes and rivers would follow from the same rule. Needs a world reset
- [ ] Multi-instance sharding once one function instance isn't enough (the roster and chunk cache are in-process memory today; Redis CAS keeps the store consistent but players on two instances would not see each other). crossws 0.4.12 has a Redis sync backplane, but Nitro builds its adapter as `wsAdapter({ resolve })` with no way to pass `sync`, and the backplane only fans out to peers, so server copies of a chunk still need their own server-to-server channel for edit deltas
- [ ] Multi-region realms as a server list: one project per region with its own hostname, and a realm picker with live counts on the landing page
- [ ] Reject unauthenticated sockets with a 401 in the `upgrade` hook instead of open-then-close (needs the crossws bump below)

## Known issues / verify-me

- [ ] **Voice needs WebCodecs**, so it is Chromium only today: `AudioEncoder`/`AudioDecoder` audio has not shipped in Firefox or Safari. The menu says "not supported in this browser" and the switch is disabled rather than failing quietly. A WASM Opus fallback would fix it and was deliberately left out of this pass
- [ ] **Voice latency is TCP latency.** A retransmit stalls the socket and then a burst lands at once, which the jitter buffer answers by skipping ahead to stay near real time rather than playing a backlog. It is audible as a clipped word, and it is the price of not using WebRTC. Nothing to do unless it proves bad in practice
- [ ] **Voice is single instance**, like the roster. Two players on different function instances are never paired, because the pairing reads in-process positions. Same blocker as the sharding item below
- [ ] **Transcription costs money per utterance**, so it is capped at 6 clips a minute and about 5 minutes of audio per 5 minutes per identity, in process. A busy public demo would want a real budget rather than a rate limit, and the per-identity counters reset with the instance
- [ ] **Voice has no moderation.** Anyone in range hears anyone else, there is no mute-this-player control and no report path. A per-player mute in the roster is the obvious next thing
- [ ] **Nitro 3.0.260903-beta cannot be adopted yet.** It needs a Nuxt 5 nightly >= 29814795, and those nightlies mount Nitro as a Vite environment whose dev hook calls `server.httpServer.on("upgrade")` while Nuxt runs Vite in middleware mode (`httpServer` is null): `nuxt dev` crashes, and Nuxt has no upgrade forwarding of its own. Prod builds were fine. Both pins stay on the June pair (reason in `pnpm-workspace.yaml`); worth an upstream issue since it blocks crossws 0.4.12
- [ ] **Nitro-beta dev server can die/crash-loop under the arena's GLB load burst** (dev worker exits silently or "Dev worker failed after 3 retries"); a prod build (`pnpm build` + `NUXT_SESSION_PASSWORD=… node .output/server/index.mjs`) serves the same session rock-solid — use it for headless verification (see the run-mmo skill)
- [ ] **The socket drops and reconnects mid-session**, emptying the streamed world until chunks land again (`useWorld.reset()`). Pre-existing — `driver.mjs map` reproduces it on the pre-redesign commit too, where it showed as a silent "0 chunks loaded" — but the redesign now says so out loud (the entry overlay's reconnect notice, the map's live pip going amber). Two flavours seen: a recycle after roughly three minutes, and a drop within seconds of the map-mode canvas click. Worth pinning down whether the close is Nitro/crossws, the platform, or something the click triggers
- [ ] **Verify in a real browser** that Escape from the world map closes it without opening the menu. With the pointer locked, re-taking the lock in the same keystroke bounces it, so `GameScene` ignores a lock release within 600ms of the map closing. Headless never acquires pointer lock, so this path was not exercised
- [ ] **Verify in a real browser** that arrow keys move the selection inside the creator's `URadioGroup`s. Click and focus work; arrows did not move it under headless SwiftShader
- [ ] **Fonts 404 in `pnpm dev`**: `@nuxt/fonts` resolves the three families but this Vite/Rolldown beta ignores its dev middleware (`nuxt-fonts-public-assets ... hooks will be ignored`). Production emits the files, so judge type in a prod build
- [ ] **World reset needed on any persisted realm** after the biome terrain change: chunks saved before it disagree in height with freshly generated neighbours wherever mountains or the heath roll apply, which tears at the seam. Town chunks are unaffected
- [ ] **Verify by eye**: ghosts at night on heath and mountain, and which way each critter species faces. The dragon on its orbit is confirmed. Headed passes confirmed critters spawn, walk, idle and stay off roofs, and the heading maths matches the Oracle's `MushroomKing` from the same pack, but no close-up was captured
- [ ] A runtime helmet toggle would let the Knight keep hairstyles. The `hooded` flag in `characters.ts` is not read by any runtime toggle today, though the beard now shows the mechanism works: a named mesh, `applyBeard`, and a boolean on the identity
- [ ] Mountain ranges end at the streamed radius (`TERRAIN_RADIUS` 7 chunks) instead of receding into fog, and terrain casts no shadow (`castShadow = false`, CSM `maxFar` 120), so peaks throw no shade into valleys
- [ ] **Ranger female with the Buns hairstyle**: the buns come out through the hood. The other Ranger combinations read fine, since the hood is open at the face and the hair sits under it. Options: build `Ranger_Female_Buns` with the bun meshes trimmed to the hood, or hide them at runtime the way `applyBeard` hides the beard
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [x] Camera boom samples solid prop heights as well as the wall grid to avoid clipping into courtyard buildings
- [x] ~~Character GLB WebP-support race crashes on cold concurrent loads~~ — mitigated: the convert script byte-sanitizes broken WebP refs; downloads overlap but parses take turns, so the WebP probe is warm before the second model (see `.claude/agents/scene-3d.md`)
- [x] ~~`scripts/ws-test.mjs` broken by the signed-cookie gate~~ — it now does the `/api/auth` handshake and replays the cookie on the upgrade

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `~/GitHub/benjamincanac/.claude/launch.json` (name `mmo`, autoPort; port 3000 is occupied by another process on this machine)
- Package manager is **pnpm**; `pnpm typecheck` / `pnpm lint`
- Oracle needs `AI_GATEWAY_API_KEY` locally **and on Vercel** (OIDC is request-scoped — absent in the WS/game-loop context); model ids are Gateway strings (`typesafe-ai/jev` for the classifier through `gateway.evaluation`, `deepseek/deepseek-v4.1-flash` for the responder); identity secret is `NUXT_SESSION_PASSWORD`
- Blender 5.1.2 at `/Applications/Blender.app/Contents/MacOS/Blender` — asset scripts run headless (`--background --python scripts/<x>.py -- <args>`); kit conversion uses `npx @gltf-transform/cli optimize`
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); the Universal characters are itch.io-only behind Cloudflare (manual download), and the outfits come from the purchased source pack `modular-character-outfits`; then run `convert_universal_characters.py` with `ONLY=` for a subset
- World persistence is Upstash Redis through the Vercel marketplace: `NUXT_UPSTASH_REDIS_REST_URL` and `NUXT_UPSTASH_REDIS_REST_TOKEN` (the bare `UPSTASH_REDIS_REST_*` names the Upstash integration sets, and the `KV_REST_API_URL` / `KV_REST_API_TOKEN` a marketplace store sets, are read too). Both unset means the in-memory store, which is what local dev and every test run on — the world simply resets with the process. Every key is scoped by realm (`AVELUNE_REALM`, else `VERCEL_REGION`, else `local`): one stored world per region. Chunks are administered with `pnpm exec jiti scripts/world-admin.mjs <export|import|wipe|reset> [--realm fra1]`
- Protocol testing: `node scripts/ws-test.mjs ws://localhost:<port>/api/ws` (its voice block needs `AVELUNE_DEV_COMMANDS=1`, for the `/tp` that walks a talker out of range)
- Voice transcription needs `AI_GATEWAY_API_KEY`, the same key the Oracle uses. Without it `POST /api/voice/say` answers `not configured` and live voice still works; only the chat line goes away
- Repo: `github.com/benjamincanac/avelune` (branch `main`)
- **Shared-code invariant:** anything affecting gameplay position/collision/elevation or edit validation must live in `shared/utils/` (`maze.ts`, `world.ts`, `building.ts`) so server and prediction agree; client-only code renders it
- Headless verification: `pnpm build` then `NUXT_SESSION_PASSWORD=x PORT=<port> node .output/server/index.mjs`; the run-mmo driver's modes are `arena`, `walk`, `chat`, `meadow`, `build`, `paint`, `swim`, `target`, `map`, `gate`, `landing` and the dev-only `still`. `target` and any `/tp` work need `AVELUNE_DEV_COMMANDS=1` and a real GPU (`MMO_HEADED=1`), headless SwiftShader hangs on long runs
- Domain subagents live in `.claude/agents/` (`world-sim`, `server-net`, `scene-3d`, `game-ui`, `oracle-ai`, `assets`); see `CLAUDE.md`
