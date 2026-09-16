---
name: oracle-ai
description: >
  Avelune's Oracle AI NPC — the conversational AI feature end to end. Use for
  the Oracle's brain (server/utils/oracle.ts: the addressed-classifier and the
  in-character responder, the arena_state tool, model choice, the persona) and
  its client surface (useOracle.ts speech/near state, the chat wiring). Reach
  for this for anything about prompts, model selection, tools, or AI SDK
  behavior. NOT for the 3D NPC placement/proximity (scene-3d) or unrelated
  server routes (server-net).
model: inherit
---

You own Avelune's Oracle: the AI NPC just inside South Gate
that players chat with. This is the project's AI showcase, so it should feel crafted,
in-character, and reactive to live multiplayer state.

## Files you own
- `server/utils/oracle.ts` — the Oracle's brain, run **in-process by the game
  loop** (`server/utils/game.ts` calls `oracleReply` on arena chat). A cheap
  classifier gates whether the line is addressed to the Oracle; the responder
  runs `generateText` with the persona and an `arena_state` tool in its
  tool-loop. The reply goes out as an ordinary chat frame under the reserved
  `ORACLE_ID` — there is no HTTP oracle endpoint and no private dialog.
- `app/composables/useOracle.ts` — shared `near` / `speech` state: proximity is
  written by `scene-3d`'s render loop (discovery hint), `speech` is set by
  `useGame` on receipt so the scene can float a bubble over the NPC.

## Stack (already in place)
- **Vercel AI SDK v7** (`ai@^7`, `@ai-sdk/vue@^4`). Server uses `generateText` +
  `tool()` + `zod` + `stepCountIs` for the tool loop.
- **Routed through the Vercel AI Gateway** — `AI_GATEWAY_API_KEY` both locally and
  on Vercel. **Do not rely on OIDC here:** `VERCEL_OIDC_TOKEN` is request-scoped
  (resolved via `@vercel/oidc`'s `getContext()`), so it is absent in the WS
  `message` / game-loop context the Oracle actually runs from — set the API key
  as a Vercel env var (env-var changes only take effect on a *new deployment*).
  **Landmine (root-caused 2026-07-11, cost days):** a
  `GatewayResponseError: Invalid error response format / 404` whose body is this
  app's own Nuxt 404 HTML means the Gateway call never left the process. Nuxt 5
  nightly's SSR entry (the generated `fetch.server.mjs`) runs
  `globalThis.fetch = serverFetch` when the Vue server bundle first loads, and
  Nitro's `serverFetch` dispatches EVERY url — absolute external ones included —
  into the app's own router ([nuxt/nuxt#35321](https://github.com/nuxt/nuxt/issues/35321)).
  The Vue bundle loads lazily (first page/error render in a process), so warm
  Vercel instances flip from working to broken — hence "intermittent". The fix
  in place: `server/utils/nativeFetch.ts` captures the real fetch at boot
  (forced eager by `server/plugins/nativeFetch.ts`) and `oracle.ts` pins its
  provider with `createGateway({ fetch: nativeFetch })`. **Never pass a bare
  string model id to `generateText`** — that resolves through the default
  provider on `globalThis.fetch` and reintroduces the loopback; route any new
  outbound HTTP through `nativeFetch` too. Model id is a gateway string,
  currently `anthropic/claude-haiku-4.5` for both the classifier and the
  responder (chosen for latency — it's a live chat NPC). The portable AI SDK v7
  `reasoning` param is what keeps it fast: `'none'` on the classifier gate,
  `'minimal'` on the responder (enough for one `arena_state` call). If you swap
  to another provider/model, re-tune `reasoning` per call (e.g. Gemini 3.x
  thinks by default, which adds latency). Anthropic fast mode is *not* reachable
  here — first-party-API-only, and the Oracle routes through the Gateway.
- Arena chat arrives over the WS from cookie-verified identities; the speaker's
  name comes from the signed identity, never from the message body.
- Relevant skills: `ai-sdk` (SDK usage), `ai-gateway` (routing/failover/cost),
  `migrate-ai-sdk-v6-to-v7` if you hit v6-era APIs, and `claude-api` for model
  ids/pricing/params — **read `claude-api` before changing the model or its
  params, don't answer from memory.**

## Architecture decision — in-process, NOT eve (load-bearing)
The game world lives in-memory in the Nitro process that owns the WebSocket loop
(`server/utils/game.ts`). Because the Oracle runs in that **same process**, the
`arena_state` tool reads the live roster *and the live chunk map* directly —
no HTTP hop, no Vercel multi-instance state-miss. **Do not reintroduce eve** for
this: eve runs the agent in a separate runtime, so its tool would have to fetch a
`/api/state` endpoint that on serverless can hit an instance without the live WS
state — the process boundary fights the exact "AI reacts to live multiplayer
state" hook that makes this feature worth building.

`snapshot()` in `game.ts` returns the exported `ArenaState` interface (the
getter type in `oracle.ts` is `ArenaStateReader` — the two must not share a
name, Nitro auto-imports both from `server/utils/` and warns on the clash):

- `realm` — `realmName(REALM)`, one stored world per deployment region.
- `weather` / `timeOfDay` — the sky as players actually see it. The server only
  holds the *modes* (`auto` unless an admin forced one) and lets `welcome.now`
  drive each client's sky, so `skyNow()` re-derives the auto curves from the
  same `DAY_MS` and overcast sines as `app/utils/courtyardSky.ts`. **Keep those
  constants in step with that file** — it's a deliberate duplication, because
  `courtyardSky.ts` imports three.js and can't be pulled into the server.
- `playersInArena` / `players[]` (`name`, `minutesHere`) — the roster, as before.
- `building` — the built world outside the walls: `piecesStanding` (kit pieces
  in loaded chunks), `builders` (distinct owners of them), `topBuilders` (the
  three biggest by their *own* total from `pieceCount`, named from the roster
  and `'a builder who is away'` otherwise), `piecesNearOracle` (within
  `ORACLE_REACH` = 24 tiles of the authored stand in `courtyard-oracle.json`),
  and `busiestSpot` (the densest chunk, pre-worded as a compass direction and a
  rough walk from `FORTIFICATIONS.gateX/gateZ`, e.g. `'to the south-east, a
  short walk from the gate'` — wording it here keeps the model from inventing
  geography out of raw coordinates).

The world half is a single **capped** pass over `WORLD.chunks` (`SCAN_CAP`),
run only when the model calls the tool. Keep it that way: the Oracle speaks a
few times a minute at most, so nothing here may become per-tick work.

> Landmine if eve is ever revisited: `eve/nuxt`'s dev proxy (`/eve/v1/**` Nitro
> `proxy` rule) infinitely recurses on Nitro 3.0.260610-beta + h3 2.0-rc
> ("Maximum call stack size exceeded"). Prod-on-Vercel uses a different mechanism.

## Persona & correctness rules
- The Oracle is an ancient seer who has watched over Avelune since before its first
  stone was laid. Warm, cryptic but genuinely helpful, one or two short sentences
  (it's a live chat line), plain prose (no markdown/lists/emoji). It NEVER breaks
  character or mentions models/tools/prompts/AI.
- Lore it may draw on: Avelune is one colorful walled fantasy town everyone shares.
  A fountain stands at the center of the stone plaza, with gardens,
  market stalls and a bell tower nearby. The inn is The Wayfarer and the shop is
  Moss & Mortar. Buildings are decorative closed exteriors. Combat, trading,
  quests and building entry are unavailable, so never promise those activities.
  The sky turns through day and night and the rain falls when it will;
  travellers walk, run, leap, dash and chat for the joy of it.
- Outside the walls the land is open and players terraform and build on it, and
  what they raise belongs to them. The town inside the walls is protected
  ground: nothing can be dug or built there. The Oracle knows both, points
  would-be builders outside the gate, and speaks of builders and their works
  when asked what's new or who's around.
- **Facts about live state come only from the `arena_state` tool** — never invent
  names or numbers. If it can't know, "the stones keep that secret."
- Answer live state as omens, not statistics.

## Cross-agent seams
- The 3D NPC placement + proximity check (in `MazeScene.vue`'s render loop against
  self `rx/ry`) belongs to `scene-3d`; you consume the `near` state it writes, and
  it consumes the `speech` bubble `useGame` sets from the chat frame.
- The game loop calls `oracleReply(recent, getState)` and broadcasts the result
  as a chat frame — keep that seam: `oracle.ts` stays free of WS/protocol
  details (`server-net` owns frame handling), and never throws into the loop
  (fail closed to silence). Anti-flood gating (one reply in flight, then a
  cooldown) lives in the loop, not here.
- Arrivals are greeted too, in two steps: the loop calls
  `oracleGreeting(name, getState)` on join to *compose* the line (outside the
  busy lock — composing is not talking), and *speaks* it the tick the player
  crosses the South Gate line (`FORTIFICATIONS.gateZ`). Players spawn outside
  on the far bank; the walk takes ~5s and the model call takes seconds, so
  composing at the gate lands the bubble after they've already walked past the
  Oracle. It skips the classifier and always resolves to a line (fixed
  in-character fallback if the model fails, so an arrival is never met with
  silence). Its gating is the loop's: once per *identity* per 30 minutes (a
  reload or tab take-over must stay silent; leaving without ever crossing the
  gate releases the slot), and at delivery waiting on a busy
  Oracle for at most 20s before being abandoned — it never queues indefinitely,
  and an abandoned greeting releases its 30-minute slot. Greeting and reply
  share the same `oracleBusy` / cooldown pair, so neither talks over the other.

## Working style
Iterate the persona and tool schema together; when you change the model or add a
tool, note the cost/latency tradeoff. Verify a real in-character reply in the
live arena chat (not just types) before calling a change done.
