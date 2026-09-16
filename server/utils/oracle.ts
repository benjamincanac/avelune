import { createGateway, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { nativeFetch } from './nativeFetch'

/**
 * The Oracle's brain, run in-process by the game loop.
 *
 * Players share one chat and mostly talk to each other, so the Oracle must not
 * answer everything. Each line first goes to a cheap classifier that decides
 * whether it's actually addressed to the Oracle; only then does the (pricier)
 * in-character responder run, with an `arena_state` tool that reads live game
 * state. The Oracle also greets arrivals (`oracleGreeting`), which skips the
 * classifier — the arrival itself is the prompt — and runs the same responder.
 * All calls route through the Vercel AI Gateway (`AI_GATEWAY_API_KEY` locally,
 * OIDC on Vercel).
 */

// Both calls run on Claude Haiku 4.5 — Anthropic's low-latency tier — with
// reasoning turned down hard to keep a one-line chat reply snappy. The portable
// `reasoning` param (AI SDK v7) is what keeps it fast: `none` on the gate,
// `minimal` on the reply (bare-minimum, still enough for one tool call).
/** Cheap + fast — this runs on every chat message, so keep it small. */
const CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5'
/** The in-character reply — only runs when addressed. */
const RESPONDER_MODEL = 'anthropic/claude-haiku-4.5'

/** Chat replies must stay short; hard cap as a backstop to the prompt. */
const MAX_REPLY = 220

// Pinned to the real fetch: once a warm instance has rendered any page or
// error, `globalThis.fetch` is Nuxt's serverFetch, which would dispatch the
// Gateway call into our own router and answer it with our own 404 page (see
// server/utils/nativeFetch.ts). A bare string model id would resolve through
// the default provider on `globalThis.fetch`, so both calls below must go
// through this provider. Auth is unchanged (AI_GATEWAY_API_KEY, OIDC fallback).
const gateway = createGateway({ fetch: nativeFetch })

const PERSONA = `You are the Oracle, an ancient seer who has watched over Avelune since before its first stone was laid. You stand just inside South Gate, beside the main avenue, where travellers gather to talk.

Voice:
- Cryptic but genuinely helpful. ONE or two short sentences. This is a live chat line, never a wall of text.
- Warm, patient, a little amused by mortal haste; you find small wonders in flowers, fountain water and passing company.
- Address people by name when you know it. Never break character. You are not an AI or assistant, you are the Oracle. Never mention models, tools, or systems.
- Plain prose only. No markdown, no lists, no emoji.

Lore of Avelune:
- Avelune is a colorful fantasy town that everyone shares. A fountain stands at the center of its stone plaza, surrounded by gardens and market stalls.
- The Wayfarer is the inn, Moss & Mortar is the shop, and a bell tower watches over High Court. Their doors are closed; travellers gather outside. Do not offer rooms, goods, quests or entry to buildings.
- A bridge crosses the surrounding moat to South Gate, built into the rampart. Travellers arrive outside and can explore the outer meadow. South Gate opens onto the main avenue to Fountain Square. Market Lane lies west, Willow Gardens east, and High Court north.
- The fountain plaza is a meeting place. Travellers can walk, run, leap, dash and chat, but cannot fight, trade or undertake quests. Never invent these activities or claim they are available.
- The sky turns through day and night and the rain falls when it will. Travellers cross the courtyard for the joy of it, and there is always room for another story beside the fountain.

The land beyond the walls:
- Outside the ramparts the land is open and unfinished, and travellers shape it. They raise and lower the ground, lay down grass, dirt, stone, sand and path, and set down pieces of stone and timber to build with. Trees and rocks out there can be cleared away. This is the one making they can do, and you may encourage it.
- Avelune itself is protected ground. Inside the walls nothing can be dug, raised or built; the town stands as it was laid. Say so plainly if someone means to build in the plaza, and point them outside the gate instead.
- Works out there belong to whoever raised them, and only they may take their own pieces down again.

When people ask who is here, how many walk the courtyard, how long someone has lingered, what is new, who has been building, or what the sky is doing, consult the living town with the means available to you and answer from what it shows you as omens, not statistics. Name the builders whose hands have been busiest and speak of their works by where they stand and which way they lie, never as a tally. If you cannot know something, say the stones keep that secret; never invent names or numbers.

The shape of an answer, so you hear the voice:
- Asked what is new: "Kestrel has been busy past the gate, stone on stone to the south-east, and the meadow is losing its quiet."
- Asked about the sky: "Grey water is gathering above us, and the lanterns will be earning their keep before long."`

export interface HubMessage {
  name: string
  text: string
}

/** Live-state getter injected by the game loop (avoids a circular import). */
export type ArenaStateReader = () => unknown

function transcript(recent: HubMessage[]): string {
  return recent.map(m => `${m.name}: ${m.text}`).join('\n')
}

/**
 * Collapse to one chat line and enforce `MAX_REPLY`. The prompt already asks for
 * one or two short sentences, so this is a backstop — but a hard slice lands
 * mid-word, which reads as a broken NPC rather than a terse one. Prefer cutting
 * at the last sentence end, then the last space, and only then mid-word.
 */
function clampReply(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  if (line.length <= MAX_REPLY) return line
  const cut = line.slice(0, MAX_REPLY)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (sentence > MAX_REPLY * 0.5) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_REPLY * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`
}

/**
 * Pull the load-bearing bits out of an AI-SDK / gateway error for logging.
 * The gateway wraps the real HTTP failure in `.cause` (an `APICallError`) whose
 * `url` / `responseBody` / `responseHeaders` reveal *who* actually answered —
 * the gateway itself, Vercel's edge, or an interceptor. That's the smoking gun.
 */
function describeError(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: string
    message?: string
    statusCode?: number
    validationError?: unknown
    cause?: {
      name?: string
      message?: string
      statusCode?: number
      url?: string
      responseBody?: string
      responseHeaders?: Record<string, string>
    }
  }
  const c = e.cause
  return {
    name: e.name,
    message: e.message,
    status: e.statusCode,
    causeName: c?.name,
    causeMessage: c?.message,
    causeStatus: c?.statusCode,
    url: c?.url,
    body: c?.responseBody?.slice?.(0, 300),
    headers: c?.responseHeaders,
    validationError: e.validationError ? String(e.validationError).slice(0, 200) : undefined,
  }
}

/**
 * Cheap gate: is the LAST line of the transcript addressed to the Oracle,
 * versus ordinary player-to-player chatter? Fails closed (silent) on error.
 */
async function isAddressed(recent: HubMessage[]): Promise<boolean> {
  try {
    const { text } = await generateText({
      model: gateway(CLASSIFIER_MODEL),
      reasoning: 'none',
      instructions: `You gate a chat NPC called "the Oracle", an ancient seer standing just inside a game's fortified town gate, whom players can talk to. The players in that courtyard ALSO chat with each other. Given the recent chat, decide whether the LAST line is addressed to the Oracle.

It IS for the Oracle when the line is:
- addressed to it by name, or
- a question or remark clearly seeking the seer's knowledge, guidance, or lore about the courtyard, or
- a direct question aimed at a singular "you", asking who the speaker is, what it is, its name, its purpose, or what it knows, when no other player is being addressed. The Oracle is the only non-player presence in the courtyard, so a bare "who are you?", "what are you?", or "what is this place?" is meant for it.

It is NOT for the Oracle if it's clearly player-to-player talk: greetings between players, coordination, addressing another player by name, or idle banter. When a question could go either way but names or clearly targets another player, answer NO; otherwise a genuine question with no other addressee is for the Oracle.

Reply with exactly "YES" or "NO" and nothing else.`,
      prompt: `Recent courtyard chat:\n${transcript(recent)}\n\nIs the LAST line addressed to the Oracle?`,
    })
    console.log('[oracle] classify', JSON.stringify(recent.at(-1)?.text), '→', JSON.stringify(text))
    return /^\s*yes/i.test(text)
  }
  catch (error) {
    console.log('[oracle] classify error', JSON.stringify(describeError(error)))
    return false
  }
}

/**
 * The in-character responder: persona + the live-state tool, one chat line out.
 * Shared by every way the Oracle speaks (answering a question, greeting an
 * arrival). Never throws — any failure resolves to null.
 */
async function respond(prompt: string, getState: ArenaStateReader): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: gateway(RESPONDER_MODEL),
      reasoning: 'minimal',
      instructions: PERSONA,
      prompt,
      tools: {
        arena_state: tool({
          description: 'Read the living town right now: the realm it belongs to, the weather and the hour of its sky, how many people are gathered with their names and how many minutes each has been here, and what has been built in the land outside the walls — how many pieces stand, how many builders raised them, the busiest builders with their totals, how much stands beside you, and where the densest work lies. Call this whenever someone asks who is present, how many are here, how long someone has stayed, what the weather or the hour is, what is new, what has been built, or who has been building.',
          inputSchema: z.object({}),
          execute: async () => getState(),
        }),
      },
      stopWhen: stepCountIs(4),
    })
    return clampReply(text) || null
  }
  catch (error) {
    console.log('[oracle] respond error', JSON.stringify(describeError(error)))
    return null
  }
}

/**
 * If the latest chat line is addressed to the Oracle, return its in-character
 * reply (with live arena data when relevant); otherwise return null. Never
 * throws — any failure resolves to null so the game loop just stays quiet.
 */
export async function oracleReply(recent: HubMessage[], getState: ArenaStateReader): Promise<string | null> {
  if (recent.length === 0) return null
  if (!(await isAddressed(recent))) return null
  return respond(`The travellers in the courtyard have been speaking:\n${transcript(recent)}\n\nThe last line is meant for you. Answer as the Oracle, in one or two short sentences.`, getState)
}

/**
 * Welcome a traveller who just walked in, by name. Unlike a reply this skips
 * the classifier (nobody said anything — the arrival itself is the prompt) and
 * always produces a line: if the model is unreachable the Oracle still speaks,
 * from a fixed in-character fallback, so an arrival is never met with silence.
 * The game loop decides *whether* to greet; this only decides what is said.
 */
export async function oracleGreeting(name: string, getState: ArenaStateReader): Promise<string> {
  const line = await respond(`A traveller named ${name} has just crossed the bridge and stepped through South Gate, arriving in Avelune.

Greet ${name} by name, in one or two short sentences. Look at the living town first and let what you find there colour the welcome — whether they arrive alone or into company, and who has been lingering. Do not list names or numbers back to them: speak of it as an omen. Do not ask them a question they must answer, and do not promise them anything the town cannot give.`, getState)
  return line ?? `Welcome to Avelune, ${name}. The stones have been waiting a long while for your step.`
}
