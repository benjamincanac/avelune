# Vercel Stadium — Roadmap

> A shared 3D stadium: walk around and chat, and ask the Oracle — an AI agent plugged
> into the docs of every Vercel framework and primitive — anything about Vercel.
> Nuxt + TresJS + Vercel WebSockets + AI SDK. It exists to demo the Vercel WebSocket
> upgrade under a real authoritative game loop, plus an AI agent living inside that loop.
> Renamed from Tempest (and before that Mugen) on 2026-09-11; the repo slug is still `tempest`.
> This file is the source of truth for what's done and what's next — update it as work lands.

## Status: done ✓

### Core loop & simulation
- [x] Authoritative 20 Hz server sim; client prediction via shared kinematics (`shared/utils/arena.ts` → `stepBody`), input-aware reconcile that never drags you backward against your own input
- [x] Third-person camera (wall-aware boom), raw-delta mouse-look, pointer lock + fullscreen (`F`)
- [x] Jump (`Space`) & dash (`Shift`) — server-validated, predicted, dash flag synced; dash-from-standstill launches forward
- [x] Elevation: solid props are walkable ledges in the shared authoritative plan; `SOLID_PROPS` distinguishes low vaultable clutter from tall unjumpable blockers
- [x] Day/night cycle (15 min) + weather (clear→overcast→rain), synced via the server clock (`welcome.now`)
- [x] Round WoW-style minimap (top-right), full arena, no fog
- [x] Protocol test suite (`scripts/ws-test.mjs`) — creates characters over `/api/auth`, then asserts `welcome`/`state`/`chat`/`pong`/`leave`/`kicked`
- [x] Bot load-testing script (`scripts/spawn-bots.mjs`)

### Identity, onboarding & app shell
- [x] **Signed-cookie identity** (`server/utils/session.ts`, HMAC-SHA256, ~10-year `stadium_id` cookie); `GET`/`POST`/`DELETE /api/auth`; WS upgrade gated on the cookie. **Log out** (Escape menu → `DELETE /api/auth` + reload) clears the cookie and the entry flow lands on the gate
- [x] **One look, two bodies** (`vercel-demo`): the old creator (outfits, hair, colorways, 3D preview) is gone. Everyone is the Developer — the Peasant rigs (male `Developer` / female `Developer_Female`, `shared/utils/characters.ts`) remixed at load time into a normal human (`app/utils/developerLook.ts`, once per template): flat black tee with short sleeves and bare forearms, jeans, white sneakers, a fitted baseball cap, ▲ on tee and cap; belt, buckle, shoulder pads, buttons and boot cuffs deleted as shells. No Blender involved (the source packs and Blender are gone from this machine); iterate in the dev look lab `/dev/look`. `outfitColor` left the protocol; unknown `character` ids (old cookies) render the male body
- [x] **Minimal gate** (`CharacterGate.vue`): `index.vue` probes `/api/auth` — a returning player drops straight into the arena; a visitor without a cookie picks Male/Female + a name (required) and `POST /api/auth` mints the identity. A bare POST (the protocol test) still falls back to a `dev-xxxx` handle
- [x] **In-game Escape menu** (WoW-style): controls reference + fullscreen + log out + return-to-game. While pointer-locked the Escape keydown is browser-swallowed, so `GameScene` emits `unlock` on unintentional pointer-lock loss and the page opens the menu on it
- [x] **Single session per identity**: `sessions` is keyed by identity id, so a second tab takes over — the newest socket wins and the old one gets a `kicked` frame (client stops reconnecting, shows an overlay with "play here instead"). `disconnect` is guarded by `sessions.get(id) === session` so the booted socket can't evict the live player
- [x] Chat: bottom-left, arena-wide history, floating bubbles over rigs, system announcements (`announce()`); `MAX_CHAT_LENGTH` 240 so real questions fit; the Oracle's cited URL is linkified

### AI showcase
- [x] **The Oracle, a Vercel docs agent** (2026-09-11) — in-process, run by the game loop (`server/utils/oracle.ts`): a cheap classifier (`anthropic/claude-haiku-4.5`) decides whether a chat line is for it (by name, or any Vercel/product question), then an AI SDK `ToolLoopAgent` (`anthropic/claude-sonnet-4.6`, ≤8 steps) answers from the docs and cites the URL. Tools (`server/utils/oracleDocs.ts`): the public docs MCP servers — Nuxt, Nuxt UI, Nuxt Content, Nuxt Image, Svelte, Docus, Comark — via `@ai-sdk/mcp` (lazy connect, kept open, tools prefixed per server), plus `search_docs`/`read_docs_page` over the `llms.txt` + `.md` endpoints of vercel.com, nextjs.org, turborepo.com, ai-sdk.dev (real search API), chat-sdk.dev, flags-sdk.dev, useworkflow.dev, v0.app; plus `arena_state` reading the live `snapshot()`. Vercel MCP (`mcp.vercel.com`) is OAuth-only, hence the sitemap route for platform docs. A new `oracle` frame (`{thinking}`) shows "consulting the docs…" in chat and a "…" bubble over the triangle during the 10–20 s lookup. Speaks in the shared chat (no separate dialog); body is vercel.com's hero triangle (`app/utils/oracle3d.ts`). Deliberately in-process, not eve — see `.claude/agents/oracle-ai.md`

### World, art & assets
- [x] **Stadium arena** (`ARENA_LAYOUT` 56×56 + `generateArena`): open sand disc with the Vercel centre mark, walled in by an unbroken tile ring — there is no exit, the arena is the whole world. The bowl around it (tiers, crowd, LED bands, roof, floodlights) is procedural in `app/utils/stadium.ts`; `shared/data/arena-structure.json` is an optional hand-edited kit-piece layer (empty)
- [x] Character GLBs: 8 Universal-skeleton Peasant/Ranger bodies converted (M/F × 2 hairstyles) sharing one `animations.glb` clip library (Idle/Run/Jump/Roll), WebP textures; only the two Developer bodies are used
- [x] Asset pipeline: `convert_universal_characters.py` (WebP-crash byte-sanitizer), `rebuild_animations.py`, `convert_props.py`, `convert_fantasy.sh`/`convert_kits.sh` (`gltf-transform optimize` → meshopt + WebP), `make_og.py`
- [x] ~~Dev-only in-game world editor~~ **removed 2026-09-10** (`useEditor`, `hubEditor`, `EditorPanel`, `/api/editor/save`, `public/thumbnails` + `make_thumbnails.py`, `PROP_CATALOG`/`ALL_PROP_KINDS`). The arena JSON (`arena-props.json`, `arena-structure.json`, `arena-oracle.json`) is edited by hand. Side effect: `arenaOnly()` now filters *every* kit catalog, so referenced nature-kit kinds load in play (they previously only loaded inside the editor)
- [x] **Real `og.png`** rendered from game assets (`make_og.py`)

### Ship
- [x] `git init`, `benjamincanac/tempest` repo created & pushed
- [x] First Vercel deploy

### Vercel demo (branch `vercel-demo`)
- [x] **Vercel stadium** — the medieval kit colosseum (481 baked Ruins/Castle pieces) is replaced by a procedural stadium on the same footprint (`app/utils/stadium.ts`): one `LatheGeometry` bowl (lower tier, LED fascia, upper tier, LED parapet), ~4k instanced spectator billboards with a shader bounce + Mexican wave, four inward-facing LED bands scrolling the 18-brand strip (`vercelBrands.ts`: 13 primitives with the ▲, 5 frameworks as white cells), a roof ring with trusses/columns, an LED halo over the sand, and floodlights that come on at night. Glow is faked with additive bands, no post-processing. Render-only; `arena-structure.json` emptied, no kit GLB loads in play. Still to tune by eye: band heights, crowd palette, glow strength
- [x] **Real brand marks on the LED strip** — Next.js, Nuxt, SvelteKit (Svelte flame), Turborepo and v0 draw their Simple Icons paths (CC0, inlined in `vercelBrands.ts`, brand colours on the white cells) next to the wordmark; the platform primitives keep the ▲; eve has no published mark yet
- [x] **LED dance floor** — the sand is a black 1-tile grid of panels that light up white under every runner (footprint-based, fading trail, idle sparks); the halo reuses the Oracle rim-light recipe (`app/utils/ledFloor.ts`, wired in `ArenaScene.vue`).
- [x] **Oracle = the vercel.com triangle**, same 2.2-unit height as the old monster, floating and swaying over a bed of smoke
- [x] **Rename to Vercel Stadium** (2026-09-11): `maze.ts`→`arena.ts`, `MazeScene`→`ArenaScene`, `hub-*.json`→`arena-*.json`, `generateHub`→`generateArena`, cookie `tempest_id`→`stadium_id` (everyone re-onboards once), palette tokens `stadium-*`, ▲ logo/favicon, site metadata; deleted the old game's leftovers (`models/monsters`, `character.glb`, `portal_gate.glb`, `torch.glb`, `make_portal.py`, `make_assets.py`, the broken `run-mmo` skill)
- [ ] `scripts/make_og.py` + `public/og.png` still render the medieval door + statues as the OG hero — rebuild from the stadium (and drop `make_door.py` / `colosseum_door.glb` once done)
- [ ] Carry the swag beyond the arena: HUD/gate/palette in Vercel black & white (the `stadium-*` scale is still the old slime blue)
- [ ] The kit GLBs under `public/models/{props,fantasy,dungeon,crypt,castle,nature,village}` (~24 MB) and `propCatalog.ts` load nothing in play (both arena JSON layers are empty) — delete them or place something

### Removed in the simplification (2026-09-10)
The project was cut back to its actual purpose (WebSockets + AI NPC demo). Gone: the
dungeon tower and its floors, procedural labyrinth generation, biomes, timed traps,
deaths, floor clears, records/leaderboards, fog of war, spectator mode, the video main
menu, the great door (with `bigDoor.ts` and its wall notch), and the daily-seed
machinery. `shared/utils/arena.ts` is now just the arena plus the collision/kinematics
both sides share. Later the same day (`vercel-demo`) the Ruins/Castle kit colosseum went
too — `composeColosseum.ts` and the baked `arena-structure.json` pieces — replaced by the
procedural Vercel stadium.

## Next up (prioritized)

### 1. Verify prod
- [ ] **Verify the WebSocket upgrade under load in prod** — load-bearing; the whole architecture rests on it
- [ ] Verify the Oracle works deployed: prod Gateway calls were intermittently answered by the app's *own 404 page* — Nuxt nightly replaces `globalThis.fetch` with a router loopback once a warm instance renders any page/error ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)); fixed by pinning the Oracle's provider to the boot-captured `nativeFetch` (`server/utils/nativeFetch.ts` + plugin). Redeploy, then ask "who are you?" in chat (needs `AI_GATEWAY_API_KEY`)
- [ ] Retroactive compression pass over the pre-existing `public/models/props/**` GLBs (the newer kits are already meshopt+WebP)

### 2. Make the arena worth standing in
- [ ] Audio — nothing is implemented yet: footsteps, jump/land, dash whoosh, ambient wind/crowd, positional audio for other players (three.js `AudioListener`/`PositionalAudio`)
- [ ] Emotes / a wave or cheer clip, so players can interact without typing
- [ ] Mobile/touch controls (virtual stick + look drag)

### 3. Oracle depth
- [ ] Give the Oracle more to see: time of day and weather in `arena_state`, so it can remark on the sky
- [ ] Vercel MCP behind a server-side credential (if one becomes available) instead of the sitemap route; Turborepo/Next.js MCPs if they ship public endpoints
- [ ] Stream the answer into the bubble instead of waiting for the whole reply (agent `stream()` → chunked `chat` frames)
- [ ] AI announcer voice for shared events (joins, milestones) — deferred; see `memory/ai-announcer-tower-voice.md`

### 4. Stretch
- [ ] Proximity voice chat — WebRTC, signaling over the game socket
- [ ] Multi-instance sharding once one function instance isn't enough (the roster is in-process memory today)

## Known issues / verify-me

- [ ] **Nitro-beta dev server can die/crash-loop under the arena's GLB load burst** (dev worker exits silently or "Dev worker failed after 3 retries"); a prod build (`pnpm build` + `NUXT_SESSION_PASSWORD=… node .output/server/index.mjs`) serves the same session rock-solid — use it for headless verification
- [ ] Editing a server file while `scripts/ws-test.mjs` runs reloads Nitro mid-test and fails 7/8 checks — rerun on a settled server
- [ ] Pointer lock impossible in the Claude preview iframe (`WrongDocumentError`) — real tabs/deploy are fine; delta-look fallback covers embeds
- [ ] Without pointer lock the OS cursor can pin at screen edges mid-turn (fullscreen `F` mitigates)
- [ ] Camera boom ignores prop heights (only the wall grid) — can clip through tall props at close range
- [x] ~~Character GLB WebP-support race crashes on cold concurrent loads~~ — mitigated: the convert script byte-sanitizes broken WebP refs; load a roster sequentially to warm WebP first (see `.claude/agents/scene-3d.md`)
- [x] ~~`scripts/ws-test.mjs` broken by the signed-cookie gate~~ — it now does the `/api/auth` handshake and replays the cookie on the upgrade

## Environment notes (for a cold start)

- Dev server: `pnpm dev` — or the preview harness via `.claude/launch.json` (name `vercel-stadium`, autoPort; port 3000 is occupied by another process on this machine)
- Package manager is **pnpm**; `pnpm typecheck` / `pnpm lint`
- Oracle needs `AI_GATEWAY_API_KEY` locally **and on Vercel** (OIDC is request-scoped — absent in the WS/game-loop context); model ids are Gateway strings (`anthropic/claude-haiku-4.5` classifier, `anthropic/claude-sonnet-4.6` agent); identity secret is `NUXT_SESSION_PASSWORD`. The docs MCPs need no credentials; expect two "Unsupported protocol version" 400 log lines per server on connect (version negotiation), then "mcp connected"
- Blender 5.1.2 was at `/Applications/Blender.app/Contents/MacOS/Blender` — **not installed as of 2026-09-11**, and the Quaternius source packs are gone from `~/Downloads`, so the `.py` asset scripts can't run until both are restored; the Developer look is therefore a runtime remix of the shipped GLBs, not a re-export. Kit conversion uses `npx @gltf-transform/cli optimize`
- Quaternius packs download from Google Drive folders linked on quaternius.com pack pages (`gdown --folder`); the Universal characters + Modular Fantasy Outfits are itch.io-only behind Cloudflare (manual download, then run `convert_universal_characters.py`)
- Protocol testing: `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
- Repo: `github.com/benjamincanac/tempest` (branch `main`)
- **Shared-code invariant:** anything affecting gameplay position/collision must live in `shared/utils/arena.ts` so server and prediction agree; client-only code renders it
- Domain subagents live in `.claude/agents/` (`world-sim`, `server-net`, `scene-3d`, `game-ui`, `oracle-ai`, `assets`); see `CLAUDE.md`
