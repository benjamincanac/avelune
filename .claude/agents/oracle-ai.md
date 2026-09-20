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
  `ORACLE_ID`, carrying `to`, the player it answers. There is no HTTP oracle
  endpoint and no private dialog.
- `app/composables/useOracle.ts` — shared `near` / `speech` state: proximity is
  written by `scene-3d`'s render loop (discovery hint), `speech` is
  `{ text, until, to }`, set by `useGame` on receipt so the scene can float a
  bubble over the NPC and turn the rig toward the player that line answers.

## Stack (already in place)
- **Vercel AI SDK v7** (`ai@^7`, with `@ai-sdk/gateway` transitively; nothing
  here uses the Vue bindings). Server uses `generateText` + `tool()` + `zod` +
  `stepCountIs` for the tool loop.
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
  in place: `server/utils/nativeFetch.ts` captures the real fetch at boot and
  `oracle.ts` pins its provider with `createGateway({ fetch: nativeFetch })`.
  `server/plugins/nativeFetch.ts` forces that capture eager, and also
  intercepts the assignment itself, sending every absolute `http(s)` url to the
  real fetch and keeping the loopback for relative ones. That guard is there for
  third-party server code we can't edit, and it is not a reason to skip the
  import. **Never pass a bare string model id to `generateText`**: that
  resolves through the default provider on `globalThis.fetch` and reintroduces
  the loopback, and route any new outbound HTTP through `nativeFetch` too. Model
  ids are gateway strings. The classifier is `typesafe-ai/jev`, an evaluation
  model called through `experimental_evaluate` + `gateway.evaluation()` (same
  string-id rule): four questions in one request, and the Oracle answers when
  `addressed` clears `ADDRESSED_THRESHOLD` (the other three are the sky,
  below). The probabilities are not calibrated across providers, so retune the
  threshold from the `[oracle] classify` logs on any swap. The responder is
  `deepseek/deepseek-v4.1-flash` with `reasoning: 'none'`: thinking tokens bill
  as output and one `arena_state` call does not need them. **It is picked on
  tool-call reliability and latency, and price is the last tiebreak** since the
  whole cheap tier lands under a dollar per thousand replies. It is the dearest
  of that tier and it stays anyway: four cheaper models were measured against
  the `[oracle] respond` logs and none beat it.
  `google/gemini-2.5-flash-lite` called the tool on about half the questions
  that needed it and once invented a `get_state` tool that does not exist.
  `openai/gpt-5-nano` never called it at all and fabricated the roster,
  answering "who's here?" with "you stand alone". `deepseek/deepseek-v4-flash`
  was too slow for a live chat line. `zai/glm-5.3-flash` was the only real
  contender, calling the tool on every live-state question and answering from
  the roster at half the cost, but it ran 2-4s on the tool path against about 1s
  here. **A cheap model does not decline to answer when it lacks the data, it
  invents** — and it reads beautifully while doing so, which is why a swap is
  judged on the tool firing every time and never on how the replies sound.
  Check `reasoning_options` before trusting a portable `reasoning` value: only
  a model with a `toggle` can honour `'none'`, and an effort-only model
  (gpt-5-nano's `minimal`, glm-5.3's `low`) silently keeps thinking. v4-flash's
  effort values are `high`/`xhigh` only, with no `none` to map to, so a toggle
  that fails to land leaves it thinking hard every time. v4.1-flash itself
  exposes no options at all. Price and capabilities come from the gateway's own
  `https://ai-gateway.vercel.sh/v1/models`, never from memory; `temperature` is
  moot because this file sets no `temperature`, `topP` or `seed`. If the cheap
  tier is worth revisiting, the lever is the prompt, not the model: Jev already
  classifies every line, so it could decide that live state is needed and the
  snapshot could be prefetched into the prompt, dropping the tool round trip and
  the judgement call along with it. Mind the mapping on Anthropic models:
  the portable `reasoning: 'minimal'` has no budget to map to on Haiku 4.5 and
  the gateway warns on every call, so pass an explicit
  `providerOptions.anthropic.thinking` budget there. If you swap
  to another provider/model, re-tune `reasoning` per call (e.g. Gemini 3.x
  thinks by default, which adds latency). Anthropic fast mode is *not* reachable
  here — first-party-API-only, and the Oracle routes through the Gateway.
- Arena chat arrives over the WS from cookie-verified identities; the speaker's
  name comes from the signed identity, never from the message body. A spoken
  line arrives the same way. `server/utils/transcribe.ts` transcribes a
  push-to-talk clip on `openai/gpt-4o-mini-transcribe`, with a 12s timeout and
  its own `createGateway({ fetch: nativeFetch })` for the loopback reason
  above. Its fallback is `spacexai/grok-stt`, a different provider on purpose,
  so one outage does not take speech to chat down with it. The transcript then
  enters through `speakForIdentity` and `sayChat` in `game.ts`, the same
  function a typed line uses, which is why the classifier reads a spoken
  sentence with no idea it was spoken. The one difference is on the wire: a
  spoken frame carries `voice: true` and is echoed back to its author, who has
  nothing on screen until the transcript exists.
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
- **The Oracle turns the shared sky, and Jev decides it, not the responder.**
  The one classifier request asks four questions of the last line: `addressed`
  (boolean), `turn` (boolean: does it want the sky changed or released at all),
  and `weather` / `time` (choice: a mode, `auto`, or `keep`). `oracleReply`
  applies a mode through the `SkyControl` injected by `game.ts` when the line is
  addressed and both `turn` and the chosen mode clear `SKY_THRESHOLD`, then
  tells the responder in the prompt exactly what was done and what the sky is
  now. The responder has **no sky tools**. Root-caused live: given
  `set_weather` / `set_time` it would claim a change without calling them
  ("sunny", "let the sky be"), answer "it is already clear" in the rain off its
  own earlier lines in the transcript, and turn the wrong thing ("stop the
  rain" set rain). Keep `turn`: asked alone, the choice questions read "is it
  night yet?" as a request for night. Adding or rewording a question shifts the
  other scores a little, so rerun a labelled probe after touching any of them.
  This replaced the public `/weather` and `/time` chat commands, which are
  dev-only now.
- **Facts about live state come only from the `arena_state` tool** — never invent
  names or numbers. If it can't know, "the stones keep that secret."
- Answer live state as omens, not statistics.

## Cross-agent seams
- The 3D NPC placement + proximity check (in `MazeScene.vue`'s render loop
  against the local predicted body, not the interpolated `rx/ry` the other
  players use) belongs to `scene-3d`; you consume the `near` state it writes,
  and it consumes the `speech` bubble `useGame` sets from the chat frame, `to`
  included.
- The game loop calls `oracleReply(recent, getState, sky)` and broadcasts the
  result as a chat frame — keep that seam: `oracle.ts` stays free of WS/protocol
  details (`server-net` owns frame handling), and never throws into the loop
  (fail closed to silence). Anti-flood gating lives in the loop, not here: one
  reply in flight, then an `ORACLE_COOLDOWN` of 4s. A line that misses the
  cooldown by up to `ORACLE_DEFER_GRACE`, 1s, waits it out instead of being
  dropped, because losing a question by 60ms reads as the Oracle ignoring you.
  Only one line defers at a time; anything else during the wait is dropped, and
  the defer and the drop are both logged.
- Arrivals are greeted too, **from written lines, with no model call**:
  `oracleGreeting(name, scene)` picks one to suit the company (`others`) and a
  notable sky (rain, else dawn/sunset/night), on a coin flip between the two.
  This is deliberate: a greeting fires for every arrival and ran outside the
  busy lock, so a bot run or reconnecting tabs fanned out into one responder
  call each and that is where the gateway spend went. Do not put a model back
  behind it; vary the pools instead. It is not pure: each pool is dealt from a
  module-level shuffled bag, so a run of arrivals never hears the same welcome
  twice in a row and the same arguments give a different line each call. The
  loop speaks it the tick the player crosses the South Gate line
  (`FORTIFICATIONS.gateZ`). Its gating is the loop's: once per
  *identity* per 30 minutes, claimed at the gate (a reload, a tab take-over or
  walking back through must stay silent), and at delivery waiting on a busy
  Oracle for at most 20s before being abandoned — it never queues indefinitely,
  and an abandoned greeting releases its 30-minute slot. Greeting and reply
  share the same `oracleBusy` / cooldown pair, so neither talks over the other.

## Working style
Iterate the persona and tool schema together; when you change the model or add a
tool, note the cost/latency tradeoff. Verify a real in-character reply in the
live arena chat (not just types) before calling a change done.
