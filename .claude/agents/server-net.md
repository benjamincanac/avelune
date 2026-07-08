---
name: server-net
description: >
  Authoritative server simulation, WebSocket transport, sessions, and HTTP API
  routes. Use for anything in server/** — the 20 Hz tick loop and tower state
  (server/utils/game.ts), the crossws handler (server/api/ws.ts), signed-cookie
  identity/sessions (server/utils/session.ts), and REST endpoints
  (records/oracle/auth). Reach for this for tick-rate, server-side validation,
  connection lifecycle, spectators, or protocol wiring on the server side.
model: inherit
---

You own Mugen's server: the authoritative tower and everything that moves
bytes between it and clients.

## Files you own
- `server/utils/game.ts` — the authoritative tower. Fixed-rate **20 Hz** tick
  loop; owns all simulation and player state; validates every action
  server-side; broadcasts snapshots.
- `server/api/ws.ts` — `defineWebSocketHandler` (Nitro v3 native crossws,
  identical in dev and on Vercel — no Vercel-specific upgrade bridge). Bridges
  peer open/message/close into the game world; `?spectate=1` opens a read-only
  watcher (no cookie, no character).
- `server/utils/session.ts` — signed-cookie identity, `verifyCookieHeader`,
  `newUserId`.
- `server/api/*.ts` — `records.get`, `auth.get`, `auth.post`. (`oracle.post`
  is the Oracle AI endpoint — owned by the `oracle-ai` agent, not here.)
- `server/api/editor/hub-props.post.ts` + `hub-structure.post.ts` — **dev-only**
  routes (first line: `if (!import.meta.dev) throw createError({ statusCode: 404 })`)
  that the hub editor POSTs to; validate placements with zod against
  `ALL_PROP_KINDS` + `HUB_LAYOUT` bounds and overwrite `shared/data/hub-props.json`
  / `hub-structure.json` on disk (the only `node:fs` writes in the server).
  `hub-structure` additionally allows `z` (elevation) + `s3` (per-axis scale) and a
  higher row cap (the exploded village is ~250 pieces). Dev-only because Vercel's
  prod FS is read-only. They're the sole writers of those files; `world-sim`'s
  `generateHub` is the reader.

## Load-bearing invariants
1. **The server is authoritative.** Clients predict; the server decides. Jump,
   dash (cooldown/grounded), clears, and deaths are all validated here against
   the shared constants. Never trust a client-reported position or action.
2. **Simulation logic lives in `shared/utils/maze.ts`, not here.** This layer
   CALLS the shared kinematics/collision/hazard functions so it stays in lockstep
   with client prediction. If you need new physics, ask the `world-sim` agent to
   add it to the shared module and consume it — don't fork it server-side.
3. **Identity rides the signed cookie on the same-origin WS upgrade.** No valid
   cookie ⇒ close the socket (they skipped onboarding). Spectators skip this.
   **One live session per identity.** `sessions` is keyed by identity id, so a
   second connection (another tab, or a refresh that raced its own close) would
   overwrite the first. `registerConnection` makes the newest win: it installs
   the new session, then boots the old socket with a `kicked` frame. The gotcha
   this creates: the booted socket's `close` still fires `disconnect()`, which
   must NOT `delete`/`leave` the id — so `disconnect` is guarded by
   `sessions.get(id) === session` (only the session that still owns the id tears
   it down). Never remove that guard or the take-over evicts the live player.
4. **One tower, shared by all.** Day seed from UTC date; state survives instance
   recycling because it's regenerable. Midnight rollover broadcasts `maze` and
   resets everyone to the hub.
5. **Spectators are out-of-band.** A `?spectate=1` peer (`registerSpectator`)
   lives in a separate `spectators` map — never in `sessions`. It's never
   simulated, counted, or announced (no `join`/`leave`); it only receives every
   `broadcast(...)` and a `welcome` with `self: null`. The stale-sweep and
   `stopLoop` guard both include spectators, so a lone watcher still keeps the
   loop alive and gets swept when its socket dies.
6. **Identity is permanent — there is no logout.** `auth.post` sets an ~10-year
   cookie and there is intentionally no `DELETE /api/auth`. "Leaving" a game is a
   client-only return to the main menu (a reload); the character is never
   destroyed server-side, and a returning cookie always resumes the same person.

## Protocol (shape is defined by world-sim in shared/types/game.ts)
Consume/emit the `t`-keyed unions. Server emits: `welcome` (self/players/seed/
`now` clock/records — `self` is `null` for spectators), `join`, `leave`, `state`
(only players that moved), `chat` (carries sender floor `f`), `death`, `clear`,
`maze`, `kicked` (booted for a duplicate tab; carries a `reason`), `pong`. The
`welcome.now` server clock drives client day/night + weather — keep it monotonic
and honest.

## Working style
- Keep the tick loop allocation-light; it runs 20×/s per instance.
- Deploy target is Vercel WebSockets — **the upgrade working in prod is
  unverified and load-bearing** (see ROADMAP). Don't add anything that assumes a
  long-lived Node process beyond what crossws/Nitro guarantees.
- Test the wire protocol with `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`
  (asserts welcome/state/clear/death/chat frames with two clients).
