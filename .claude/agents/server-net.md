---
name: server-net
description: >
  Authoritative server simulation, WebSocket transport, sessions, and HTTP API
  routes. Use for anything in server/** — the 20 Hz tick loop and arena state
  (server/utils/game.ts), the crossws handler (server/api/ws.ts), signed-cookie
  identity/sessions (server/utils/session.ts), and REST endpoints (auth). Reach
  for this for tick-rate, server-side validation, connection lifecycle, or
  protocol wiring on the server side.
model: inherit
---

You own Vercel Stadium's server: the authoritative arena and everything that moves
bytes between it and clients.

## Files you own
- `server/utils/game.ts` — the authoritative arena. Fixed-rate **20 Hz** tick
  loop; owns all simulation and player state; validates every action
  server-side; broadcasts snapshots. Also owns the chat→Coach hop
  (`considerCoach` + the `snapshot()` the Coach's tool reads, and the `coach`
  thinking frames around a slow docs answer); the Coach's brain itself belongs
  to `coach-ai`.
- `server/api/ws.ts` — `defineWebSocketHandler` (Nitro v3 native crossws,
  identical in dev and on Vercel — no Vercel-specific upgrade bridge). Bridges
  peer open/message/close into the game world.
- `server/utils/session.ts` — signed-cookie identity, `verifyCookieHeader`,
  `newUserId`.
- `server/api/*.ts` — `auth.get`, `auth.post`, `auth.delete` (log out: clears the
  cookie, so the next load lands on the gate). The Coach has no HTTP route: it
  runs in-process from the game loop (`server/utils/coach.ts`, owned by the
  `coach-ai` agent).
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
- `server/plugins/devSourceMap.ts` — dev-only shim for the Nitro beta's error
  handler. The dev bundle inlines Nitro's vendored `source-map`, whose
  `read-wasm.js` joins `__dirname` to find `mappings.wasm`; ESM has none, so
  every rendered error (a 404 was enough) logged `__dirname is not defined`
  while the handler source-mapped the stack. The plugin sets a global
  `__dirname` to the vendored `source-map/lib` (resolved from `nitro`'s main).
  No-op in prod and when the layout changes; delete once Nitro shims CJS
  globals in its dev bundle. `/favicon.ico` also redirects to the SVG via
  `routeRules` so that probe never renders a 404 page.

## Load-bearing invariants
1. **The server is authoritative.** Clients predict; the server decides. Jump
   (grounded), dash (cooldown), headings and chat are all validated here against
   the shared constants. Never trust a client-reported position or action.
2. **Simulation logic lives in `shared/utils/arena.ts`, not here.** This layer
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
   (`const PLAN = generateArena()`), built once at boot — nothing is persisted and
   nothing needs to be: the roster is the only state, so an instance recycling
   costs only the sockets it held.
5. **Identity lives only in the cookie.** `auth.post` sets an ~10-year cookie and
   `auth.delete` (Log out) clears it with the same `path`, nothing else — there is
   no server-side record to destroy, so a returning cookie resumes the same person
   and a cleared one gets a fresh id on the next `POST`.

## Protocol (shape is defined by world-sim in shared/types/game.ts)
Consume/emit the `t`-keyed unions. Server emits: `welcome` (`self`/`players`/
`now` clock), `join`, `leave`, `state` (only players that moved, at 10 Hz),
`chat` (`{id, text}` — the Coach broadcasts under the reserved `COACH_ID`),
`kicked` (booted for a duplicate tab; carries a `reason`), `pong`, `coach`
(`{thinking}` — on once the classifier accepts a line, off when the reply lands). The
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
