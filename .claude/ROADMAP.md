# Mugen — Roadmap

> Endless multiplayer dungeon-crawl tower. Nuxt + TresJS + Vercel WebSockets.
> This file is the source of truth for what's done and what's next — update it as work lands.

## Status: done ✓

- [x] Third-person camera (wall-aware boom), raw-delta mouse-look, pointer lock + fullscreen (`F`), drag-free steering everywhere
- [x] Authoritative 20 Hz server sim; client prediction via shared kinematics (`shared/utils/maze.ts` → `stepBody`)
- [x] Endless floors seeded by (UTC date, floor index); 4 biomes (Stone/Sunken/Verdant/Magma) w/ tinted materials, fog, speed modifiers
- [x] Timed traps per biome (spikes/geysers/vines/vents); death → hub reset; depth leaderboard + per-floor fastest clears
- [x] Hub plaza w/ rune teleport circle, colonnade, statues, camp props
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via server clock (`welcome.now`)
- [x] Quaternius Ultimate Modular Ruins pack as architecture: instanced floor slabs, arches, buttresses, exit gateways, torches (`scripts/convert_props.py`)
- [x] Animated characters (8 from Ultimate Animated Character Pack, `scripts/convert_characters.py`): Idle/Run/Jump/Roll driven by state, per-player assignment + accent tint
- [x] Jump (`Space`) & dash (`Shift`) — server-validated, predicted, dash flag synced; traps only kill below z=0.4 (jumpable)
- [x] Elevation: solid props (crates/barrels/chests/rubble) are walkable ledges, in the shared plan (authoritative)
- [x] Fog of war: explored-tile bitmaps per floor; round WoW-style minimap (top-right) + fogged tower map (`M`)
- [x] UI overhaul: chat bottom-left w/ floor-filtered history, compact HUD, no GitHub/Deploy buttons
- [x] Protocol test suite (`scripts/ws-test.mjs`)

## Next up (prioritized)

### 1. Ship it
- [ ] `git init`, create `benjamincanac/mugen` repo, push
- [ ] First Vercel deploy — **verify the WebSocket upgrade actually works in prod** (never tested; the whole architecture rests on it)
- [ ] Real `og.png` (current one is inherited from the old starter)
- [ ] Asset compression pass: `gltf-transform` (meshopt) over `public/models/**` — ~6 MB today, should halve

### 2. Audio (biggest missing sense)
- [ ] Footsteps (surface-aware: stone/water), jump/land, dash whoosh
- [ ] Trap warnings + activation sounds (audible timing = fairer dodges)
- [ ] Teleport/clear/death stingers; ambient loops per biome (wind, drips, jungle, magma rumble)
- [ ] Positional audio for other players (three.js `AudioListener`/`PositionalAudio`)

### 3. Death & clear polish
- [ ] Play `Death` clip + short corpse pause before hub respawn (server: delay respawn ~1.5s, client: play clip)
- [ ] `Victory` clip on floor clear before the drop
- [ ] Trap pre-fire telegraph (glow/particles ~0.4s before lethal) — currently binary

### 4. Party system (brief asked for "form groups")
- [ ] `party` messages: invite/accept/leave over the existing socket; party = shared color ring + markers on both maps regardless of fog
- [ ] Party chat channel (chat already carries floor; add `party` scope)
- [ ] Maybe: party members see each other through walls (outline shader)

### 5. Deeper biome mechanics (hazards beyond timed traps)
- [ ] Sunken: deep-water pools that drown after ~3s submerged (needs per-player timer server-side)
- [ ] Verdant: collapsing floor tiles (break after N crossings, respawn on rollover)
- [ ] Magma: lava pools as instant-death zones w/ visible pathing (place only on braid loops so floors stay solvable)
- [ ] Floor modifiers at depth milestones (darkness floors, no-minimap floors, speed floors)

### 6. Walls upgrade (last procedural holdout)
- The Ruins pack has NO straight wall panels (verified — 69 models, contact-sheet workflow in `scripts/preview_modules.py` pattern)
- Options: (a) Quaternius *Medieval Village MegaKit* wall modules (check Drive availability), (b) sculpt brick relief into instanced wall geometry in Blender, (c) keep cubes + normal-map from the canvas textures

### 7. Stretch (from the original brief)
- [ ] Proximity/party voice chat in the hub — WebRTC, signaling over the game socket (deliberately deferred)
- [ ] Persistent accounts: depth records surviving the daily rollover (needs a store — KV keyed by day)
- [ ] Multi-instance sharding once one function instance isn't enough
- [ ] Mobile/touch controls (virtual stick + look drag)
- [ ] Character outfits (Modular Character Outfits Fantasy — **itch.io-only behind Cloudflare**: needs a manual download dropped into the pipeline)

## Known issues / verify-me

- [ ] Mid-air `Jump` and `Roll` clip playback never visually verified (state logic tested; watch one jump/dash and tune crossfade/timescale if off)
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [ ] Magma floors keep the procedural emissive-crack ground (slabs would hide the glow) — revisit with an emissive slab variant
- [ ] Camera boom ignores prop heights (only wall grid) — can clip through tall props at close range

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `~/GitHub/benjamincanac/.claude/launch.json` (name `mmo`, autoPort; port 3000 is occupied by another process on this machine)
- Blender 5.1.2 at `/Applications/Blender.app/Contents/MacOS/Blender` — asset scripts run headless (`--background --python scripts/<x>.py -- <args>`)
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); newer packs (Universal*, outfits) are itch.io-only behind Cloudflare
- Protocol testing: two `WebSocket` clients from Node against `/api/ws` — assert `welcome/state/clear/death/chat` frames (`node scripts/ws-test.mjs ws://localhost:<port>/api/ws`)
- Shared-code invariant: **anything affecting gameplay position/collision/hazards must live in `shared/utils/maze.ts`** so server and prediction agree; client-only code renders it
