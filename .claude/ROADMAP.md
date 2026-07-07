# Mugen — Roadmap

> Endless multiplayer dungeon-crawl tower. Nuxt + TresJS + Vercel WebSockets.
> This file is the source of truth for what's done and what's next — update it as work lands.

## Status: done ✓

### Core loop & simulation
- [x] Authoritative 20 Hz server sim; client prediction via shared kinematics (`shared/utils/maze.ts` → `stepBody`)
- [x] Third-person camera (wall-aware boom), raw-delta mouse-look, pointer lock + fullscreen (`F`), drag-free steering everywhere
- [x] Endless floors seeded by (UTC date, floor index); 4 biomes (Stone/Sunken/Verdant/Magma) w/ tinted materials, fog, speed modifiers
- [x] **3-tile-wide** corridors/rooms (`CELL_TILES`/`CELL_STRIDE`, exported so the wall renderer shares the grid)
- [x] Timed traps per biome (spikes/geysers/vines/vents); depth leaderboard + per-floor fastest clears
- [x] Jump (`Space`) & dash (`Shift`) — server-validated, predicted, dash flag synced; dash-from-standstill launches forward; traps only kill below `TRAP_MAX_Z` (jumpable)
- [x] Elevation: solid props are walkable ledges in the shared authoritative plan; `SOLID_PROPS` distinguishes low vaultable clutter (crates/chests/wagon) from tall unjumpable blockers (trees/boulders)
- [x] Death → deferred corpse pause on the death floor (`DEATH_DELAY` 1.2s, `dyingUntil`, `dead` flag) → `Death` clip → hub reset *(was §3)*
- [x] Fog of war: explored-tile bitmaps per floor; round WoW-style minimap (top-right) + fogged tower map. Traps are hidden on the minimap (fairness)
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via server clock (`welcome.now`)
- [x] Protocol test suite (`scripts/ws-test.mjs`)

### Identity, onboarding & app shell
- [x] **Signed-cookie identity** (`server/utils/session.ts`, HMAC-SHA256, ~10-year `mugen_id` cookie) replacing per-connection random identity; `GET`/`POST /api/auth`; WS upgrade gated on the cookie. Character is **permanent — no logout**
- [x] **Character creator** (`CharacterGate`): gender × outfit (Peasant/Ranger) × hairstyle × outfit colorway, runner name, Randomize, live draggable 3D turntable bust. Runtime cloth-only recolor (`app/utils/appearance.ts`)
- [x] **Main-menu app shell** (`index.vue` state machine: `checking → menu → creating → playing → spectating`). Socket opens on demand, not on load. Returning player sees name + Enter; new visitor creates a runner; everyone can spectate. `MainMenu` + 3D `CharacterLineup` backdrop
- [x] **Spectator mode**: `?spectate=1` read-only socket (`registerSpectator`, no cookie, never simulated/counted), full-tower reveal-all map
- [x] Records over HTTP (`GET /api/records`) so the menu shows the board pre-socket; shared `RecordsBoard` used in menu / HUD / spectator
- [x] In-day progress persistence: `progress` map (deepest floor per identity) survives a refresh; hub portal resumes you at `max(1, best)` *(NB: in-memory, cleared at rollover — see §7)*
- [x] Per-day tower shared by all; midnight-UTC rollover (`maze` frame) → new tower, everyone back to hub

### AI showcase
- [x] **Hub Oracle AI NPC** — in-process AI SDK route (`POST /api/oracle`, `streamText` + `tower_state` tool reading live `snapshot()`), `anthropic/claude-sonnet-5` via Vercel AI Gateway, in-character persona. Client dialog (`OracleDialog` + `useOracle` + `useChat`), `MushroomKing.glb` body beside the portal, walk up + press `E`. (Deliberately in-process, not eve — see `memory/hub-oracle-ai-npc.md`)

### World, art & assets
- [x] **Village-in-nature hub redesign** (`buildVillageHub`): procedural brick tower, timber-frame houses, meadow, tree/rock scatter — hub clutter is **real shared collision**; vertical "rift" portal (`makePortalTexture`)
- [x] **Modular masonry walls** (`placeModularWalls`): real Ruins wall/door/window panels dress room faces (Verdant swaps overgrown variants); box-wall core still drives collision *(resolves the old §6 "no straight wall panels" holdout — via both Ruins `Wall*` modules and the Village MegaKit)*
- [x] Enclosed interior: walls to `WALL_HEIGHT`, tiled flagstone ceiling, hung chandeliers; grand exit-portal dais (stairs + railings + flags); plank bridge over flooded rooms; trapdoor plates under traps; fantasy-prop interior scatter
- [x] Character roster rebuilt: 8 Universal-skeleton Peasant/Ranger (M/F × 2 hairstyles) sharing one `animations.glb` clip library (Idle/Run/Jump/Roll + dashes), WebP textures, runtime colorway swap. Old 8 named GLBs removed
- [x] Asset pipeline: `convert_universal_characters.py` (Universal base + Modular Fantasy Outfits + Animation Library; WebP-crash byte-sanitizer), `rebuild_animations.py`, `convert_props.py` (~50 new Ruins modules), `convert_fantasy.sh`/`convert_kits.sh` (`gltf-transform optimize` → meshopt + WebP), `make_og.py`
- [x] New packs: `village/` (Medieval Village), `fantasy/` (Fantasy Props), `nature/` (Stylized Nature), `monsters/` (MushroomKing). Meshopt decode registered at runtime
- [x] **Asset compression pass** (meshopt + WebP) on the new kits — *(was §1; not yet applied retroactively to the pre-existing `props/` GLBs)*
- [x] **Real `og.png`** rendered from game assets (`make_og.py`) — *(was §1)*
- [x] Chat: bottom-left, floor-filtered history, **system announcements** (`announce()`, replaced all toasts)

### Ship
- [x] `git init`, `benjamincanac/mugen` repo created & pushed *(was §1)*

## Next up (prioritized)

### 1. Ship it — verify prod
- [ ] **First Vercel deploy — verify the WebSocket upgrade actually works in prod** (never tested; the whole architecture rests on it). No `vercel.json` yet
- [ ] Verify the Oracle works deployed: `AI_GATEWAY_API_KEY` / OIDC configured and `anthropic/claude-sonnet-5` resolves on the Gateway — it's a no-op otherwise
- [ ] Retroactive compression pass over the pre-existing `public/models/props/**` GLBs (the new kits are already meshopt+WebP)

### 2. Audio (biggest missing sense — nothing implemented yet)
- [ ] Footsteps (surface-aware: stone/water), jump/land, dash whoosh
- [ ] Trap warnings + activation sounds (audible timing = fairer dodges)
- [ ] Teleport/clear/death stingers; ambient loops per biome (wind, drips, jungle, magma rumble)
- [ ] Positional audio for other players (three.js `AudioListener`/`PositionalAudio`)

### 3. Death & clear polish (death pause done ✓)
- [ ] `Victory` clip on floor clear before the drop
- [ ] Trap pre-fire telegraph (glow/particles ~0.4s before lethal) — currently binary

### 4. Party system (brief asked for "form groups") — not started
- [ ] `party` messages: invite/accept/leave over the existing socket; party = shared color ring + markers on both maps regardless of fog
- [ ] Party chat channel (chat already carries floor; add `party` scope)
- [ ] Maybe: party members see each other through walls (outline shader)

### 5. Deeper biome mechanics (hazards beyond timed traps) — not started
- [ ] Sunken: deep-water pools that drown after ~3s submerged (needs per-player timer server-side)
- [ ] Verdant: collapsing floor tiles (break after N crossings, respawn on rollover)
- [ ] Magma: lava pools as instant-death zones w/ visible pathing (place only on braid loops so floors stay solvable)
- [ ] Floor modifiers at depth milestones (darkness floors, no-minimap floors, speed floors)
- [ ] Monsters: `monsters/` pack is imported but only used for the (non-hostile) Oracle — no combat/enemy AI yet

### 6. Stretch (from the original brief)
- [ ] Proximity/party voice chat in the hub — WebRTC, signaling over the game socket (deliberately deferred)
- [ ] **Persistent accounts: depth records surviving the daily rollover** (needs a store — KV keyed by day). *Partial today:* identity persists via the signed cookie and in-day depth survives a refresh, but the `progress` map is in-memory and cleared at rollover — nothing survives midnight yet
- [ ] Multi-instance sharding once one function instance isn't enough
- [ ] Mobile/touch controls (virtual stick + look drag)
- [ ] AI "Tower speaks" announcer — server-side, broadcasts shared events to chat (deferred; see `memory/ai-announcer-tower-voice.md`)

## Known issues / verify-me

- [ ] **Vercel WS upgrade unverified in prod** — load-bearing; see §1
- [ ] **Oracle is a no-op without a working Gateway key / model id** — verify on deploy (§1)
- [ ] Ranger's **hairstyle selector has no visible effect** — the hood is always baked on and covers it; the intended "hooded ⇒ no hairstyle choice" isn't enforced in the gate UI, and the aspirational runtime `hood` toggle is unimplemented (no `Player.hood` field / control)
- [ ] Mid-air `Jump`/`Roll` clip playback never visually verified (state logic tested; watch one jump/dash and tune crossfade/timescale if off)
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [ ] Magma floors keep the procedural emissive-crack ground (slabs would hide the glow) — revisit with an emissive slab variant
- [ ] Camera boom ignores prop heights (only wall grid) — can clip through tall props at close range
- [x] ~~Character GLB WebP-support race crashes on cold concurrent loads~~ — mitigated: convert script byte-sanitizes broken WebP refs; load a roster sequentially to warm WebP first (see `.claude/agents/scene-3d.md`)

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `~/GitHub/benjamincanac/.claude/launch.json` (name `mmo`, autoPort; port 3000 is occupied by another process on this machine)
- Package manager is **pnpm**; `pnpm typecheck` / `pnpm lint`
- Oracle needs `AI_GATEWAY_API_KEY` locally (OIDC on Vercel); model id is a Gateway string (`anthropic/claude-sonnet-5`, swappable to `anthropic/claude-haiku-4.5`); identity secret is `NUXT_SESSION_PASSWORD`
- Blender 5.1.2 at `/Applications/Blender.app/Contents/MacOS/Blender` — asset scripts run headless (`--background --python scripts/<x>.py -- <args>`); kit conversion uses `npx @gltf-transform/cli optimize`
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); the Universal characters + Modular Fantasy Outfits are itch.io-only behind Cloudflare (manual download, then run `convert_universal_characters.py`)
- Protocol testing: two `WebSocket` clients from Node against `/api/ws` — assert `welcome/state/clear/death/chat` frames (`node scripts/ws-test.mjs ws://localhost:<port>/api/ws`)
- Repo: `github.com/benjamincanac/mugen` (branch `main`)
- **Shared-code invariant:** anything affecting gameplay position/collision/hazards must live in `shared/utils/maze.ts` so server and prediction agree; client-only code renders it
- Domain subagents live in `.claude/agents/` (`world-sim`, `server-net`, `scene-3d`, `game-ui`, `oracle-ai`, `assets`); see `CLAUDE.md`
