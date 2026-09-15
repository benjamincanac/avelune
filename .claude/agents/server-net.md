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
- `server/utils/session.ts` — signed-cookie identity, `verifyCookieHeader`,
  `newUserId`.
- `server/api/*.ts` — `auth.get`, `auth.post`. The Oracle has no HTTP route: it
  runs in-process from the game loop (`server/utils/oracle.ts`, owned by the
  `oracle-ai` agent).
- `server/api/editor/save.post.ts` + `server/utils/editorFiles.ts` — the
  **dev-only** save route (first line: `if (!import.meta.dev) throw createError({
  statusCode: 404 })`) the world editor POSTs its whole working doc to; validates
  placements with zod against `ALL_PROP_KINDS`, normalizes (rounded coords,
  wrapped rotations) so diffs stay small, and overwrites `hub-props.json`,
  `hub-structure.json` and `hub-oracle.json` on disk in one call (the only
  `node:fs` writes in the server; `editorFiles.ts` walks up from cwd to find
  `shared/data`). Dev-only because Vercel's prod FS is read-only. It's the sole
  writer of those files; `world-sim`'s `generateHub` is the reader.
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
4. **One arena, shared by all.** It's a module-level constant
   (`const PLAN = generateHub()`), built once at boot — nothing is persisted and
   nothing needs to be: the roster is the only state, so an instance recycling
   costs only the sockets it held.
5. **Identity is permanent — there is no logout.** `auth.post` sets an ~10-year
   cookie and there is intentionally no `DELETE /api/auth`. The character is
   never destroyed server-side, and a returning cookie always resumes the same
   person.

## Protocol (shape is defined by world-sim in shared/types/game.ts)
Consume/emit the `t`-keyed unions. Server emits: `welcome` (`self`/`players`/
`now` clock), `join`, `leave`, `state` (only players that moved, at 10 Hz),
`chat` (`{id, text}` — the Oracle broadcasts under the reserved `ORACLE_ID`),
`kicked` (booted for a duplicate tab; carries a `reason`), `pong`. The
`welcome.now` server clock drives client day/night + weather — keep it monotonic
and honest.

## Working style
- Keep the tick loop allocation-light; it runs 20×/s per instance.
- Deploy target is Vercel WebSockets — **the upgrade working in prod is
  unverified and load-bearing** (see ROADMAP). Don't add anything that assumes a
  long-lived Node process beyond what crossws/Nitro guarantees.
- Test the wire protocol with `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
  (two clients: it mints each a character over `POST /api/auth`, carries the
  cookie into the upgrade, then asserts welcome/state/chat/pong/leave/kicked).

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
