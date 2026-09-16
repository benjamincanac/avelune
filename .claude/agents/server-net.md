---
name: server-net
description: >
  Authoritative server simulation, WebSocket transport, sessions, and HTTP API
  routes. Use for anything in server/** — the 20 Hz tick loop and arena state
  (server/utils/game.ts), the crossws handler (server/api/ws.ts), signed-cookie
  identity/sessions (server/utils/session.ts), and REST endpoints (auth, the
  dev-only editor save). Reach for this for tick-rate, server-side validation,
  connection lifecycle, or protocol wiring on the server side.
model: inherit
---

You own Avelune's server: the authoritative arena and everything that moves
bytes between it and clients.

## Files you own
- `server/utils/game.ts` — the authoritative arena. Fixed-rate **20 Hz** tick
  loop; owns all simulation and player state; validates every action
  server-side; broadcasts snapshots. Also owns the chat→Oracle hop
  (`considerOracle` + the `snapshot()` the Oracle's tool reads); the Oracle's
  brain itself belongs to `oracle-ai`.
- `server/api/ws.ts` — `defineWebSocketHandler` (Nitro v3 native crossws,
  identical in dev and on Vercel — no Vercel-specific upgrade bridge). Bridges
  peer open/message/close into the game world.
- `server/utils/world.ts` — the chunk service: the one `WORLD`, the async
  `loadChunk`/`loadChunks` (read the store, else generate terrain and seed
  `generateVegetation` once), the dirty set with its `flushDirtyChunks`
  write-behind, the id→chunk placement index, and the streaming (`syncChunks`,
  `broadcastToChunk`, `terrainDeltas`). It never imports `game.ts`: sessions
  reach it through the structural `ChunkViewer` interface, and `releaseViewer`
  on disconnect stops an in-flight load from sending to a dead socket.
- `server/utils/chunkStore.ts` — where chunks live between visits, behind one
  interface: `MemoryChunkStore` (the default, so dev and the tests configure
  nothing) and `RedisChunkStore` (Upstash REST). One key per chunk,
  `chunk:<realm>:<cx>:<cy>` (realm = `AVELUNE_REALM` / `VERCEL_REGION` / `local`, one stored world per region; the `pieces` hash is `pieces:<realm>` too), holding `<version>\n<EncodedChunk as JSON>` — the version is
  in front so the CAS Lua reads it with a string match instead of parsing 3 KB.
  Credentials come from runtime config (`upstashRedisRestUrl`/`Token`, env
  `NUXT_UPSTASH_REDIS_REST_URL`/`_TOKEN`) and fall back to the bare
  `UPSTASH_REDIS_REST_URL`/`_TOKEN` the Vercel marketplace sets. The
  `useRuntimeConfig()` read is inside a try/catch on purpose: `world-admin`
  loads this same module through jiti, where that global does not exist.
- `server/plugins/world.ts` — boot and shutdown: prefetch the 5×5 spawn
  neighbourhood so the first player of a cold instance isn't standing on chunks
  that are still in flight, and drain the dirty set on Nitro's `close` hook and
  on `SIGTERM`/`SIGINT`/`beforeExit`. Those signal handlers own the exit, since
  registering one replaces Node's default.
- `server/utils/pieces.ts` — every identity's owned-piece total against
  `MAX_PIECES_PER_PLAYER`. The budget is a fact about a person, so it is neither
  per session nor per instance: the totals live in one Redis hash (`pieces`),
  are read in full at boot by `server/plugins/world.ts` before the first socket
  can ask for a welcome, and are written back as signed `HINCRBY` deltas on the
  same 5 s flush as the chunks. Counting cannot be derived from memory — a
  builder's pieces sit in chunks nobody has loaded — so the stored counter is
  the only honest one.
- `server/utils/session.ts` — signed-cookie identity, `verifyCookieHeader`,
  `newUserId`.
- `server/api/*.ts` — `auth.get`, `auth.post`. The Oracle has no HTTP route: it
  runs in-process from the game loop (`server/utils/oracle.ts`, owned by the
  `oracle-ai` agent).
- `server/api/editor/save.post.ts` + `server/utils/editorFiles.ts` — the
  **dev-only** save route (first line: `if (!import.meta.dev) throw createError({
  statusCode: 404 })`) the world editor POSTs its whole working doc to; validates
  placements with zod against `ALL_PROP_KINDS`, normalizes (rounded coords,
  wrapped rotations) so diffs stay small, and overwrites the `courtyard-*.json`
  town files on disk in one call (the only `node:fs` writes in the server;
  `editorFiles.ts` walks up from cwd to find `shared/data`). Dev-only because
  Vercel's prod FS is read-only. It's the sole writer of those files;
  `world-sim`'s `createWorld`/`seedTown` in `shared/utils/world.ts` is the
  reader. The old `hub-*.json` are deleted — don't reintroduce them.
- `server/utils/nativeFetch.ts` + `server/plugins/nativeFetch.ts` — the real
  `fetch` captured at boot. Nuxt-nightly's SSR entry replaces `globalThis.fetch`
  with a loopback into this app's own router once a process renders any page
  ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)), which routes
  even absolute external urls back into us. The plugin intercepts that
  assignment and sends absolute `http(s)` urls to the real fetch while relative
  ones keep the loopback — that's what covers third-party server code we can't
  edit (`@nuxt/icon`'s remote collection loader calls a bare `fetch`). Code we
  own should still import `nativeFetch` explicitly rather than lean on the
  guard. Symptom to recognise: a request that works cold and 500s after any
  page render.

## Load-bearing invariants
1. **The server is authoritative.** Clients predict; the server decides. Jump
   (grounded), dash (cooldown), headings and chat are all validated here against
   the shared constants. Never trust a client-reported position or action.
2. **Simulation logic lives in `shared/utils/maze.ts`, not here.** This layer
   CALLS the shared kinematics/collision functions so it stays in lockstep
   with client prediction. If you need new physics, ask the `world-sim` agent to
   add it to the shared module and consume it — don't fork it server-side.
3. **Identity rides the signed cookie on the same-origin WS upgrade.** No valid
   cookie ⇒ close the socket (they skipped onboarding).
   **One live session per identity.** `sessions` is keyed by identity id, so a
   second connection (another tab, or a refresh that raced its own close) would
   overwrite the first. `registerConnection` makes the newest win: it installs
   the new session, then boots the old socket with a `kicked` frame. The gotcha
   this creates: the booted socket's `close` still fires `disconnect()`, which
   must NOT `delete`/`leave` the id — so `disconnect` is guarded by
   `sessions.get(id) === session` (only the session that still owns the id tears
   it down). Never remove that guard or the take-over evicts the live player.
4. **One world, shared by all.** `WORLD` is a module-level constant built once
   at boot (`server/utils/world.ts`); the authored town is seeded into the town
   chunks and everything beyond is loaded on first touch. Town chunks are read
   from the store like any other — `prefetchSpawn` pulls them all in at boot,
   because `seedTown` put them in `WORLD.chunks` before the store was ever asked
   about them and physics would otherwise read authored ground a persisted edit
   is about to move.
   **`WORLD.generate` is false after boot.** The chunk service is the only thing
   allowed to make ground — it lifts the flag for exactly one `getChunk` call in
   `materialise` — so a chunk still in flight reads as *missing* (`terrainHeight`
   -Infinity, which physics already treats as a wall) rather than as generated
   terrain a persisted edit is about to move under a player's feet. Never flip
   it back on to "fix" a hole; load the chunk instead. The tick's half of the
   same rule: a session whose own chunk is not resident **skips `stepBody`
   entirely** — frozen body, `grounded` true, no gravity — and re-syncs once a
   second until the ground arrives, because a missing chunk under a player is a
   free fall, not a wall. A body that reaches `z < -50` anyway is respawned.
   **A store read that keeps failing leaves the chunk unloaded.** `loadChunk`
   retries three times with backoff and then installs *nothing*: no terrain, no
   vegetation, no `persisted` entry. Treating a failed read as "never persisted"
   is how you generate fresh ground over somebody's house and then write it
   back over them.
   **The chunk cache is pruned.** After each flush, a chunk no session holds and
   nothing has held for 60 s is dropped through the shared `removeChunk` along
   with its frame-cache entry, its `persisted` version and its placement-index
   ids. Never a dirty chunk, never a town chunk (`isTownChunk` — its authored
   pieces came from `seedTown`, not the store), never one whose load is in
   flight.
   **Interest management is per session.** Each session carries the chunk keys
   it holds; `syncChunks` sends the 5×5 around it and `unchunk`s past distance 4,
   on welcome and on every chunk-border crossing in the tick. An edit is
   broadcast only to the sessions holding the chunk it landed in, and `state`
   only names players within `STATE_RANGE` (192 tiles — the town exterior is 136
   a side, so a smaller range let two players inside the walls stop seeing each
   other move). `join`/`leave` stay global so chat and the Oracle keep the whole
   roster.
5. **Persistence is write-behind with a compare-and-set.** Every write carries
   the version the store held when we last read or wrote that chunk (`persisted`,
   where `null` means "no key yet"). A refused write is never retried: the store
   is right and we are not, so `reconcile` reloads the chunk, logs at error level
   with the key, and re-sends the whole `chunk` frame to the sessions holding it.
   That is what keeps a redeploy — old instance draining while the new one
   serves — from writing a stale chunk over a live edit. Chunks flush every 5 s
   from the tick, when the last player leaves, and on shutdown, capped at
   `FLUSH_LIMIT` per pass and pipelined. **Town chunks persist too**, because
   protection is a tile footprint now and the rest of their ground is editable.
   What does not persist is the authored town itself: the flush encodes with
   `encodeChunk(chunk, { omitTown: true })`, and `restore` puts the
   `town:<index>` pieces back in front of the stored placements before handing
   the chunk to `installChunk` — otherwise a restore would double every brick.
   `flushDirtyChunks` also drains the piece-count deltas and
   runs the cache eviction, so every caller of it — the tick, the last player
   leaving, shutdown — gets all three.
6. **Edit rules live in `shared/utils/building.ts`, and every one of them is
   enforced here.** `checkTerraform`, `resolveBuild` and `checkDemolish` are
   pure predicates the client runs for its ghost preview and the server runs to
   decide — reach (6 tiles), the protected tile footprint (`isProtectedTile`,
   which ends right after the gate road, not a chunk band later), placeable
   kinds, AABB overlap,
   support height, ownership and the 500-piece budget. The two limits that are
   *not* in those predicates are server-owned state: the 8-edits-per-second
   token bucket (`spendEdit`, shared by all three verbs, and a refusal still
   costs a token) and `maxStep: TERRAFORM_STEP` on every `applyTerrain` call, so
   no request — a flatten included — moves a corner more than one click. A
   refused edit answers `{ t: 'reject', reason }` to that socket alone.
7. **Identity is permanent — there is no logout.** `auth.post` sets an ~10-year
   cookie and there is intentionally no `DELETE /api/auth`. The character is
   never destroyed server-side, and a returning cookie always resumes the same
   person.

## Protocol (shape is defined by world-sim in shared/types/game.ts)
Consume/emit the `t`-keyed unions. Server emits: `welcome` (`self`/`players`/
`now` clock/`world` — `{chunkSize, bounds, seed, persistent}` (`persistent` is `chunkStore().kind !== 'memory'`), all a client needs to build
its empty `World` — plus `pieces`, this identity's owned-piece total across the
whole world, which `server/utils/pieces.ts` holds and the store survives a
redeploy with), `join`, `leave`, `state` (only players that moved, at 10 Hz,
filtered to `STATE_RANGE`), `chat` (`{id, text}` — the Oracle broadcasts under the
reserved `ORACLE_ID`), `chunk`/`unchunk` (a whole chunk as `encodeChunk` writes
it, `h`/`s` base64), `terrain` (`[cornerIndex, quantised height]` pairs into the
33×33 grid, plus `[tileIndex, value]` surface pairs), `place`/`remove` (with an
optional `pieces` — the actor's new owned total, on their copy of the frame
only; `announceEdit` broadcasts the plain frame with the author `except`ed and
sends them the annotated one directly), `reject`, `kicked` (booted for a duplicate tab; carries a `reason`), `pong`.
Clients send `terraform`/`build`/`demolish` alongside `move`/`action`/`chat`/
`ping`. The `welcome.now` server clock drives client day/night + weather — keep
it monotonic and honest.

Chunks go out before the first `state` can name anyone standing on them, and a
border corner is written into every chunk that stores it, so each of those
chunks gets its own `terrain` frame — drop one and a client's seam tears.

Restoring a chunk from the store goes through the shared `installChunk`, which
refills that exact `Chunk` object (the dirty set and the frame cache hold it)
and rebuckets long pieces into the neighbours already loaded. Don't
materialise-then-`applyPlace` by hand: that path bumped versions for what is
only an index rebuild.

## Working style
- Keep the tick loop allocation-light; it runs 20×/s per instance.
- Deploy target is Vercel WebSockets — **the upgrade working in prod is
  unverified and load-bearing** (see ROADMAP). Don't add anything that assumes a
  long-lived Node process beyond what crossws/Nitro guarantees.
- Test the wire protocol with `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
  (two clients: it mints each a character over `POST /api/auth`, carries the
  cookie into the upgrade, then asserts welcome/state/chat/pong/leave/kicked,
  the spawn chunk neighbourhood, a terraform round trip, the footprint edge —
  the gate road refused while the grass six tiles beside it is editable from
  spawn — and a felled tree).
- `pnpm test` includes `scripts/chunk-store-test.ts`: the store against
  `scripts/upstash-fake.mjs` (a stand-in for the Upstash REST endpoint) and,
  where `redis-server` is on PATH, against a real one through
  `scripts/redis-rest.mjs` (spawns `redis-server --save ''` and forwards the
  Upstash REST body verbatim as RESP — the only thing that proves the CAS Lua
  compiles; skipped, not failed, without it). The fake reimplements the CAS
  rather than interpreting it, so it now also checks the version pattern
  character for character: `\n` in the TypeScript template literal reaches Lua
  as a raw newline, which is an unfinished-string syntax error, and the fake
  used to pattern-match the JS source and pass it. Then the chunk service across
  a restart, two `scripts/world-probe.ts` processes over one store — terrain, a
  felled tree and the placing identity's piece count all come back, plus a town
  chunk whose editable corner persists while its `town:` piece count stays put.
  The service
  is a module singleton, so a restart can only be tested by actually restarting
  it.
- Administer a live world with `pnpm exec jiti scripts/world-admin.mjs`
  (`export`/`import` a directory of chunk JSON in pipelined batches,
  `wipe --from cx,cy --to cx,cy`, `reset --yes`). It loads the server's own store module rather than a second
  implementation of the same keys, and refuses to run without Redis.
- Load-test with `pnpm exec jiti scripts/spawn-bots.mjs --url http://localhost:<port>
  --count 30 --dig` — through jiti, because the bots now stream chunks into a
  real client-side `World` and the shared modules use extensionless imports node
  cannot resolve. `AVELUNE_TICK_LOG=1` on the server prints tick avg/max every
  5 seconds; 30 digging bots sit around 1 ms average.

## Retired character identities
`verifyToken` validates the stored character against the active roster. Unknown
models fall back to `DEFAULT_CHARACTER` with outfit color zero while preserving
id, name and accent. It returns only supported identity fields. Both HTTP
restoration and WebSocket upgrades use this normalization.

## Shared weather commands

`/weather clear|overcast|rain|auto` changes the shared server weather mode.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto` independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.
