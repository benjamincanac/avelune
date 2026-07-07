import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

/**
 * The hub Oracle's brain, run in-process by the game loop.
 *
 * Players share one floor chat and mostly talk to each other, so the Oracle
 * must not answer everything. Each hub line first goes to a cheap classifier
 * that decides whether it's actually addressed to the Oracle; only then does
 * the (pricier) in-character responder run, with a `tower_state` tool that
 * reads live game state. Both calls route through the Vercel AI Gateway
 * (`AI_GATEWAY_API_KEY` locally, OIDC on Vercel).
 */

// Both calls run on Claude Haiku 4.5 — Anthropic's low-latency tier — with
// reasoning turned down hard to keep a one-line chat reply snappy. The portable
// `reasoning` param (AI SDK v7) is what keeps it fast: `none` on the gate,
// `minimal` on the reply (bare-minimum, still enough for one tool call).
/** Cheap + fast — this runs on every hub message, so keep it small. */
const CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5'
/** The in-character reply — only runs when addressed. */
const RESPONDER_MODEL = 'anthropic/claude-haiku-4.5'

/** Chat replies must stay short; hard cap as a backstop to the prompt. */
const MAX_REPLY = 220

const PERSONA = `You are the Oracle, an ancient seer who has stood at the base of the endless tower called Mugen since before the first runner climbed it. Runners gather in the hub plaza before their ascent, and you speak to them there.

Voice:
- Cryptic but genuinely helpful. ONE or two short sentences — this is a live chat line, never a wall of text.
- Ominous, patient, a little amused by mortal haste; you have watched countless runners fall.
- Address runners by name when you know it. Never break character — you are not an AI or assistant, you are the Oracle. Never mention models, tools, or systems.
- Plain prose only. No markdown, no lists, no emoji.

Lore of the tower:
- Mugen is one tower every runner shares. It rebuilds itself at midnight (UTC): a new maze, every runner cast back to the hub.
- The glowing portal at the tower's base is the only way up. Floors deepen endlessly, cycling through four realms — Stone Dungeon, Sunken Depths, Verdant Maze, Magma Halls — each turn more punishing.
- Hazards are timed and merciless: spikes, geysers, snapping vines, magma vents. Death only casts a runner back to the hub, their deepest floor remembered. Runners dash to slip past a closing hazard.

When runners ask who climbs, who has gone deepest, how many walk the tower, or the day's records, consult the living tower with the means available to you and answer from what it shows you — as omens, not statistics. If you cannot know something, say the tower keeps that secret; never invent records, names, or floors.`

export interface HubMessage {
  name: string
  text: string
}

/** Live-state getter injected by the game loop (avoids a circular import). */
export type TowerState = () => unknown

function transcript(recent: HubMessage[]): string {
  return recent.map(m => `${m.name}: ${m.text}`).join('\n')
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
 * versus ordinary runner-to-runner chatter? Fails closed (silent) on error.
 */
async function isAddressed(recent: HubMessage[]): Promise<boolean> {
  try {
    const { text } = await generateText({
      model: CLASSIFIER_MODEL,
      reasoning: 'none',
      instructions: `You gate a chat NPC called "the Oracle" — an ancient seer standing in a game's hub, whom players can talk to. The players in that hub ALSO chat with each other. Given the recent chat, decide whether the LAST line is addressed to the Oracle.

It IS for the Oracle when the line is:
- addressed to it by name, or
- a question or remark clearly seeking the seer's knowledge, guidance, or lore about the tower, or
- a direct question aimed at a singular "you" — who the speaker is, what it is, its name, its purpose, what it knows — when no other player is being addressed. The Oracle is the only non-player presence in the hub, so a bare "who are you?", "what are you?", or "what is this place?" is meant for it.

It is NOT for the Oracle if it's clearly runner-to-runner talk: greetings between players, coordination, addressing another player by name, or idle banter. When a question could go either way but names or clearly targets another runner, answer NO; otherwise a genuine question with no other addressee is for the Oracle.

Reply with exactly "YES" or "NO" and nothing else.`,
      prompt: `Recent hub chat:\n${transcript(recent)}\n\nIs the LAST line addressed to the Oracle?`,
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
 * If the latest hub line is addressed to the Oracle, return its in-character
 * reply (with live tower data when relevant); otherwise return null. Never
 * throws — any failure resolves to null so the game loop just stays quiet.
 */
export async function oracleReply(recent: HubMessage[], getState: TowerState): Promise<string | null> {
  if (recent.length === 0) return null
  if (!(await isAddressed(recent))) return null
  try {
    const { text } = await generateText({
      model: RESPONDER_MODEL,
      reasoning: 'minimal',
      instructions: PERSONA,
      prompt: `The runners in the hub have been speaking:\n${transcript(recent)}\n\nThe last line is meant for you. Answer as the Oracle, in one or two short sentences.`,
      tools: {
        tower_state: tool({
          description: 'Read the living tower right now: how many runners are climbing, the deepest climbers (name and deepest floor), and today\'s fastest floor-clear records. Call this whenever a runner asks about who is climbing, who has gone deepest, the crowd in the tower, or the day\'s records.',
          inputSchema: z.object({}),
          execute: async () => getState(),
        }),
      },
      stopWhen: stepCountIs(4),
    })
    const reply = text.trim().replace(/\s+/g, ' ').slice(0, MAX_REPLY)
    return reply || null
  }
  catch (error) {
    console.log('[oracle] respond error', JSON.stringify(describeError(error)))
    return null
  }
}
