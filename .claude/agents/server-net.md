---
name: server-net
description: >
  Authoritative server simulation, WebSocket transport, sessions, and HTTP API
  routes. Use for anything in server/** — the 20 Hz tick loop and arena state
  (server/utils/game.ts), the crossws handler (server/api/ws.ts), signed-cookie
  identity/sessions (server/utils/session.ts), and REST endpoints (auth, the
  title screen's status, the push-to-talk transcription route, the dev-only
  editor save). Reach for this for tick-rate, server-side validation,
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
  the per-session `drainChunkQueue`, `broadcastToChunk`, `terrainDeltas`). It never imports `game.ts`: sessions
  reach it through the structural `ChunkViewer` interface, and `releaseViewer`
  on disconnect stops an in-flight load from sending to a dead socket.
- `server/utils/chunkStore.ts` — where chunks live between visits, behind one
  interface: `MemoryChunkStore` (the default, so dev and the tests configure
  nothing) and `RedisChunkStore` (Upstash REST). One key per chunk,
  `chunk:<realm>:<cx>:<cy>` (realm = `AVELUNE_REALM` / `VERCEL_REGION` / `local`, one stored world per region; the `pieces` hash is `pieces:<realm>` too), holding `<version>\n<EncodedChunk as JSON>` — the version is
  in front so the CAS Lua reads it with a string match instead of parsing 3 KB.
  Credentials come from runtime config (`upstashRedisRestUrl`/`Token`, env
  `NUXT_UPSTASH_REDIS_REST_URL`/`_TOKEN`) and fall back through the bare
  `UPSTASH_REDIS_REST_URL`/`_TOKEN` to `KV_REST_API_URL`/`_TOKEN`, which is the
  pair the Vercel marketplace actually sets. The `useRuntimeConfig()` read is
  inside a try/catch on purpose: `world-admin` loads this same module through
  jiti, where that global does not exist.
- `server/plugins/world.ts` — boot and shutdown: prefetch the 5×5 spawn
  neighbourhood so the first player of a cold instance isn't standing on chunks
  that are still in flight, and drain the dirty set on Nitro's `close` hook and
  on `SIGTERM`/`SIGINT`/`beforeExit`. Those signal handlers own the exit, since
  registering one replaces Node's default.
- `server/utils/pieces.ts` — every identity's owned-piece total against
  `MAX_PIECES_PER_PLAYER`. The budget is a fact about a person, so it is neither
  per session nor per instance: the totals live in one Redis hash
  (`pieces:<realm>`), are read in full at boot by `server/plugins/world.ts`
  before the first socket can ask for a welcome, and are written back as signed
  `HINCRBY` deltas on the same 5 s flush as the chunks. Counting cannot be
  derived from memory — a builder's pieces sit in chunks nobody has loaded — so
  the stored counter is the only honest one. Deed plots ride the same hash under
  a `deed:<id>` field (`deedCount`/`addDeed`/`removeDeed`), for exactly the same
  reason: `DEED_LIMIT` is a fact about a person, and a plot of theirs can sit in
  a chunk nobody has visited. A deed is an ordinary piece as well, so placing
  one moves both.
- `server/utils/positions.ts` — where each identity last stood, in one Redis
  hash (`positions:<realm>`), so a reload or a new login resumes there instead
  of at the gate. The tick notes every session on the 5 s flush and the dirty
  entries ride `flushDirtyChunks`; `disconnect()` notes the body again and calls
  `flushPositions()` itself, so a socket closing does not wait for a tick.
  Nothing is read at boot: `server/api/ws.ts` awaits `loadPosition` in `open`
  before calling `registerConnection`, which is why `open` is async and tracks
  `opening` peers, so a close that lands during the read registers nothing. A
  take-over resumes from the live session's body instead of the saved one. The
  `respawn` action is the way back to the gate, on a 30 s cooldown keyed by
  identity so a reconnect does not reset it.
- `server/utils/session.ts` — signed-cookie identity, `verifyCookieHeader`,
  `newUserId`.
- **Proximity voice lives in `server/utils/game.ts` too, and the server owns it.**
  The rules are `shared/utils/voice.ts` (`selectVoicePairs`: 24 tiles to connect,
  30 to drop, at most 6 listeners, symmetric by construction so the two halves can
  never disagree); the tick runs the pass every `VOICE_PAIR_EVERY` ticks (2 Hz)
  over the voice-on players and nobody else, so a silent town and every
  `spawn-bots.mjs` bot pay nothing. Audio is a **binary** frame relayed the moment
  it arrives, deliberately not on the tick: 20 Hz would quantise a 20 ms frame's
  latency by up to 50 ms. `relayVoiceFrame` is the only path where one player's
  bytes reach another's socket, so the gates are hard and every refusal is silent:
  voice on, a payload inside `MAX_VOICE_PAYLOAD`, its own token bucket, and the
  listeners the pairing already named. Never echo to the sender. `clearVoice` runs
  on a take-over *and* on disconnect, so no listener is left holding a dead
  talker id. Media never leaves this process for anywhere but a listener's socket.
- `server/utils/transcribe.ts` + `handleVoiceClip` in `game.ts` — a push-to-talk
  clip becomes one chat line. The clip is a second recording in a container (the
  live frames are bare Opus, and muxing them here would be real code for nothing),
  arriving as a `kind=2` binary frame on the sender's own socket and transcribed
  through the Gateway on the boot-captured `nativeFetch` for the same reason the
  Oracle is. Nothing is looked up: the session is the one the bytes came in on,
  so `session.voice` *is* the gate, and the per-identity allowance in
  `server/utils/clips.ts` is spent by the process that holds the socket. Every
  field of the frame is checked in `decodeClipUp` (container by index, language
  as two ASCII letters or nothing, body under `MAX_CLIP_BYTES`) because all of it
  came off the wire. The transcript goes straight into `sayChat`, the same
  function a typed line uses, which is why the Oracle's classifier reads speech
  with no change at all, and the client gets a `said` frame carrying the `seq` it
  stamped on the clip. The transcript is never logged and the clip is dropped
  after the model call, with one exception: `AVELUNE_VOICE_DEBUG` in dev keeps
  the clips under `.data/voice-debug/`, so a bad transcript can be replayed
  against other models. Never in a build, and never by default, since that is
  somebody's voice on disk.
- `server/api/*.ts` — `auth.get`, `auth.post`, `auth.delete`, `status.get`. The
  Oracle has no HTTP route: it runs in-process from the game loop
  (`server/utils/oracle.ts`, owned by the `oracle-ai` agent).
- **A route may never need the caller's own session.** A socket is pinned to the
  instance that accepted its upgrade; a plain request lands wherever. There used
  to be a `POST /api/voice/say` that looked the caller up in `sessions`, and it
  answered `409 not in the world` to players standing in it whenever it missed.
  Anything that needs the session goes on the socket. Push-to-talk clips now do:
  a `kind=2` binary frame handled in `game.ts` beside the audio relay, answered
  with a `said` frame carrying the client's `seq`, spending the per-identity
  allowance in `server/utils/clips.ts` (counted by the process holding the
  socket, so nobody can spread clips across instances for a fresh one).
- `GET /api/status` is the title screen's only source, because that page is
  prerendered and has no socket. It answers `{ players, today, series, realm,
  roster, persistent, feed }`, and **every one of those comes out of the store,
  not out of this process** (`server/utils/live.ts`). A region runs as many
  instances as it needs, a socket pins its player to whichever accepted the
  upgrade, and this request is a plain `GET` that lands wherever — so module
  state here reports the roster of whichever instance answered, and a "peak
  today" that dropped to 1 whenever a colder one served the page. Three shapes,
  scoped by realm beside the chunks:
  - **Presence** (`presence:<realm>`, a hash) — one row per session each
    instance holds, `joinedAt,lastSeen,name`, rewritten on the same 5 s flush as
    the chunks. A row not refreshed within 30 s is from an instance that died;
    readers ignore it and drop it. `players` and `roster` are the union.
  - **Seen buckets** (`seen:<realm>:d<date>`, `seen:<realm>:h<hour>`, sets of
    identity ids, TTL'd) — `today` and the nine-hour series. A *set*, because
    the question is how many people, which a counter cannot answer: it is immune
    to reconnects, to two instances writing at once and to the order they write
    in, and inside its window it only ever grows.
  - **The sky** (`sky:<realm>`, `at,weather,timeOfDay`) — a *forced* weather or
    hour. Auto agrees for free, since `skyNow` is a pure function of the clock,
    but somebody asking the Oracle for rain used to set one instance's module
    variable and rain on one instance's players. `publishSky` writes it, the
    flush reads it back, and a strictly newer turn is adopted and broadcast
    through `onRemoteSky`. Last writer wins on the timestamp; a turn takes a
    flush to cross, which for weather is nothing.
  - **The feed** (`feed:<realm>`, a capped list) — six rows, worded exactly as
    the in-game feed words them so the two surfaces can't drift. A row still
    inside its 6 s coalesce window is held on the instance that recorded it
    rather than pushed, since rewriting the head of a shared list would need a
    script; `recentEvents()` returns the pending rows in front of the shared
    ones, so `welcome` is never missing what just happened here.

  Nothing on this route scans a chunk, and the whole read is one pipeline
  (`ChunkStore.readLive`), as is the whole write (`writeLive`). The roster
  carries minutes in town rather than a ping, because latency is measured by
  each client's own heartbeat and the server has no honest per-player number to
  report. It also answers `instances`, the number of distinct processes holding
  the realm's sockets, taken from a stamp on every presence row. **One is the
  assumption the whole design rests on**; above one, the realm has split and
  players on different instances cannot see each other, because the sim is not
  shared and deliberately is not (ROADMAP §1). That number exists so the
  assumption is measured rather than assumed.
- `server/api/editor/save.post.ts` + `server/utils/editorFiles.ts` — the
  **dev-only** save route (first line: `if (!import.meta.dev) throw createError({
  statusCode: 404 })`) the world editor POSTs its whole working doc to; validates
  placements with zod against `ALL_PROP_KINDS`, normalizes (rounded coords,
  wrapped rotations) so diffs stay small, and overwrites the `courtyard-*.json`
  town files on disk in one call (the only `node:fs` writes in the server apart
  from the dev clip dump above; `editorFiles.ts` walks up from cwd to find
  `shared/data`). Dev-only because Vercel's prod FS is read-only. It's the sole
  writer of those files; `world-sim`'s `createWorld`/`seedTown` in
  `shared/utils/world.ts` is the reader. The old `hub-*.json` are deleted —
  don't reintroduce them.
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
   cookie ⇒ close the socket (they skipped onboarding). The upgrade is gated on
   the origin too (`sameOriginUpgrade`, beside the cookie in `session.ts`): a
   handshake whose `Origin` is not this deployment's host is closed before the
   cookie is read. The cookie is `SameSite=Lax` and a browser would not send it
   cross-site anyway, so this is the second lock, and it is worth having because
   a socket opened on somebody's behalf carries the microphones around them.
   A handshake with **no** `Origin` passes: that is not a page, so it cannot be
   holding a victim's cookie, and it is how `ws-test.mjs` and the bots connect.
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
   **Interest management is per session, and the stream is budgeted.** Each
   session carries the chunk keys it holds and a `pending` queue of the ones it
   is still owed. `syncChunks` runs on welcome and on every chunk-border
   crossing in the tick, and `unchunk`s past distance 4. It sends the 3×3
   inline, because a player has to stand on loaded ground, and queues the outer
   ring in ring order for `drainChunkQueue`, which the tick hands every session
   `CHUNKS_PER_TICK` chunks from before it steps their body. The store read
   still covers the whole 5×5 in the one `MGET` `syncChunks` issues, so the ring
   is resident by the time the queue reaches it; only the encode and the send
   are rationed. Once a second the drain re-asks for queued chunks that are
   still missing, which is how a neighbourhood recovers from a failed read. An
   edit is
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
   `flushDirtyChunks` also drains the piece-count deltas and the noted
   positions, and runs the cache eviction, so every caller of it — the tick, the
   last player leaving, shutdown — gets all four.
6. **Edit rules live in `shared/utils/building.ts`, and every one of them is
   enforced here.** `checkTerraform`, `resolveBuild` and `checkDemolish` are
   pure predicates the client runs for its ghost preview and the server runs to
   decide — reach (6 tiles), the protected tile footprint (`isProtectedTile`,
   which ends right after the gate bridge, not a chunk band later), placeable
   kinds, AABB overlap,
   support height, ownership and the 500-piece budget. The `build` frame's
   optional `h` — the world height the client's aim ray hit — is passed
   straight into `resolveBuild` as the request's aim height: it only narrows
   which real surface may support the piece (so a wall replaced under an upper
   storey goes back in its slot instead of onto the roof), the server still
   derives `z` itself, and a missing or nonsense `h` falls back to the old
   highest-surface rule. The two limits that are
   *not* in those predicates are server-owned state: the 8-edits-per-second
   token bucket (`spendEdit`, shared by all three verbs, and a refusal still
   costs a token) and `maxStep: TERRAFORM_STEP` on every `applyTerrain` call, so
   no request — a flatten included — moves a corner more than one click. A
   refused edit answers `{ t: 'reject', reason }` to that socket alone. A
   refusal that carries a `claim` goes through `refuseEdit`, which is the one
   place the owner's *id* becomes a name: the shared rules run on clients too,
   so they only ever say `that plot is claimed`, and the roster lookup here
   turns it into `that plot belongs to <name>`. An owner who is not online
   stays anonymous — never name them from anywhere stale.
7. **The character is permanent, the session is not.** `auth.post` sets an ~10-year
   cookie. `DELETE /api/auth` (`auth.delete`) only clears that cookie, so the
   next page state is character creation. The character is never destroyed
   server-side, and a returning cookie always resumes the same person.

## Protocol (shape is defined by world-sim in shared/types/game.ts)
Consume/emit the `t`-keyed unions. Server emits: `welcome` (`self`/`players`/
`now` clock/`world` — `{chunkSize, bounds, seed, realm, persistent, streamed}` (`persistent` is `chunkStore().kind !== 'memory'`, `streamed` the `STREAMED_CHUNKS` the entry screen counts a welcome's chunks against), all a client needs to build
its empty `World` — plus `pieces`, this identity's owned-piece total across the
whole world, and `deeds`, how many plots they hold, both of which
`server/utils/pieces.ts` holds and the store survives a redeploy with, and `feed`, the world feed's ring buffer that `/api/status` also serves), `join`, `leave`, `state` (only players that moved, at 10 Hz,
filtered to `STATE_RANGE`), `chat` (`{id, text}`, plus `to` on the Oracle's lines
and `voice: true` on a line a clip was transcribed into; the Oracle broadcasts
under the reserved `ORACLE_ID`), `chunk`/`unchunk` (a whole chunk as `encodeChunk`
writes it, `h`/`s` base64), `terrain` (`[cornerIndex, quantised height]` pairs
into the 33×33 grid, plus `[tileIndex, value]` surface pairs, plus `by`/`mode`/
`at` when a player's brush moved the ground, since a height carries no owner the
way a placement does and the *client's* feed is built from these frames rather
than from a feed frame of its own; the server's feed already has the name, from
`recordEvent`), `place`/`remove` (with an optional `pieces`/`deeds` — the
actor's new totals, on their copy of the frame only; `announceEdit` broadcasts
the plain frame with the author `except`ed and sends them the annotated one
directly), `reject`, `weather`/`time`/`system` (the shared sky and command
feedback, below), `kicked` (booted for a duplicate tab; carries a `reason`),
`pong`.
Clients send `terraform`/`build`/`demolish`/`voice` alongside `move`/`action`/`chat`/
`ping`. `voice-peers` names the listeners a talker currently has, each with the
numeric `talker` id their audio frames carry; audio itself is a binary frame
(`shared/utils/voice.ts`), told apart from JSON by its first byte in
`server/api/ws.ts` since every JSON frame starts with `{`. The `welcome.now` server clock drives client day/night + weather — keep
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
- Deploy target is Vercel WebSockets. **The upgrade is verified in prod and
  load-bearing** (2026-09-16; the ROADMAP has what was and wasn't covered).
  Don't add anything that assumes a long-lived Node process beyond what
  crossws/Nitro guarantees.
- Test the wire protocol with `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
  (two clients: it mints each a character over `POST /api/auth`, carries the
  cookie into the upgrade, then asserts welcome/state/chat/pong/leave/kicked,
  the spawn chunk neighbourhood, a terraform round trip, the footprint edge —
  the gate bridge refused while the grass six tiles beside spawn is editable from
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
  --count 30 --dig` — through jiti, because the bots stream chunks into a real
  client-side `World` and the shared modules use extensionless imports node
  cannot resolve. That world is kept in step from `chunk`/`terrain`/`place`/
  `remove` with the same shared `apply*` calls a browser makes, which is what
  lets a bot run `checkTerraform`/`resolveBuild` itself and only send poses the
  server will accept. `--build` (composable with `--dig`, plans in
  `scripts/bot-build.mjs`) gives each bot a plot in the meadow south of the
  gate, where it clears the wild vegetation, flattens the ground, raises a
  two-storey kit cottage or a fenced paddock, paves a path back to the road,
  then settles in to wander, dig and occasionally rebuild a piece. The plots sit
  on an 18-tile lattice because a claim is 16 tiles across: any closer and two
  bots would be refused each other's ground, and the load test would measure the
  refusal path instead of the build path. A summary prints every 5 s and again at
  Ctrl-C. `AVELUNE_TICK_LOG=1` on the server prints tick avg/max every 5 seconds:
  30 digging bots sit around 1 ms average, 12 building ones around 3 ms. What
  that budget actually goes on is `stepBody`: with 12 bots standing in ~350 kit
  pieces, every tick over 6 ms measured is physics, and streaming a welcome never
  showed up in one. A welcome's chunk encoding is around 30 µs per chunk (17 µs
  of heights and surface base64, 10 µs of placement JSON at ~33 pieces), so the
  whole 5×5 is under a millisecond. If a join ever does cost a tick, suspect
  collision before you suspect `syncChunks`.

## Retired character identities
`verifyToken` validates the stored character against the active roster. Unknown
models fall back to `DEFAULT_CHARACTER` with outfit color zero while preserving
id, name and accent. It returns only supported identity fields. Both HTTP
restoration and WebSocket upgrades use this normalization.

## Shared weather commands

Players change the shared sky by asking the Oracle: `oracleHears` reads the
request in its classifier pass and calls `setWeather` / `setTimeOfDay` in
`server/utils/game.ts`, and its reply is the announcement.
`/weather clear|overcast|rain|auto` is the same switch as a dev-only chat
command (`DEV_COMMANDS`: `import.meta.dev` or `AVELUNE_DEV_COMMANDS=1`), kept so
a harness can fix the sky without a model call.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/tp <x> <y>` is dev-only as well: it moves the caller's own body to a tile, snapping `z`
to `bodySurfaceHeight` and forcing a chunk sync first so there is ground to read
(a destination whose chunks are still in flight parks the body above them and
lets it settle as they land). Non-finite or out-of-world coordinates are
refused to the caller alone. It is live only when `import.meta.dev` or
`AVELUNE_DEV_COMMANDS=1` is set, which is how a verification harness drives a
production build to a known spot; without the flag all three are ordinary chat
lines. It exists so a rendering or building change can be shot from the same
place every run rather than walked to.

`/time dawn|day|sunset|night|auto`, dev-only too, independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.
