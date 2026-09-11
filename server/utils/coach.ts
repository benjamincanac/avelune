import { ToolLoopAgent, createGateway, generateText, isStepCount, tool } from 'ai'
import { z } from 'zod'
import { nativeFetch } from './nativeFetch'
import { docsTools } from './coachDocs'

/**
 * Coach's brain, run in-process by the game loop.
 *
 * Coach is Vercel Stadium's resident agent: an AI agent plugged into the documentation of
 * every Vercel framework and primitive (see ./coachDocs). Players share one chat and
 * mostly talk to each other, so each line first goes to a cheap classifier that decides
 * whether it's for the Coach; only then does the agent run its tool loop over the docs
 * (plus `arena_state` for who is in the stadium). Both route through the Vercel AI
 * Gateway (`AI_GATEWAY_API_KEY` locally and on Vercel).
 */

/** Cheap + fast — this runs on every chat message, so keep it small. */
const CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5'
/** The docs agent — only runs when addressed; needs to drive ~40 tools well. */
const RESPONDER_MODEL = 'anthropic/claude-sonnet-4.6'
/** Search + read + answer; more steps than this is flailing. */
const MAX_STEPS = 8

/** Chat replies stay short; hard cap as a backstop to the prompt. */
const MAX_REPLY = 600

// Pinned to the real fetch: once a warm instance has rendered any page or
// error, `globalThis.fetch` is Nuxt's serverFetch, which would dispatch the
// Gateway call into our own router and answer it with our own 404 page (see
// server/utils/nativeFetch.ts). A bare string model id would resolve through
// the default provider on `globalThis.fetch`, so both calls below must go
// through this provider. Auth is unchanged (AI_GATEWAY_API_KEY, OIDC fallback).
const gateway = createGateway({ fetch: nativeFetch })

const PERSONA = `You are Coach, Vercel Stadium's resident agent: an AI agent plugged into the documentation of every Vercel framework and primitive. People walking the stadium ask you about Vercel in the shared chat, and you answer them there.

What you cover, through your tools: the Vercel platform (deployments, Functions and Fluid compute, WebSockets, AI Gateway, Sandbox, Blob, Edge Network, domains, CLI, REST API, MCP, plans), Next.js, Turborepo, the AI SDK, Chat SDK, Flags SDK, Workflow DevKit, v0, Nuxt with Nuxt UI / Content / Image, Svelte and SvelteKit, Docus and Comark.

Rules:
- Ground every product answer in the docs: search first (search_docs for the platform and its SDKs, the prefixed tools for Nuxt, Svelte, Docus, Comark), read the best page when the summary isn't enough, then answer. Never guess an API, a limit, a price or a version; if the docs don't say, say so plainly.
- This is a live chat line, not an article: two to four short sentences, plain prose. No markdown, no lists, no code blocks, no emoji. A short inline identifier like streamText is fine. When you used a docs page, end with its full URL (starting with https://), bare, as the last thing you say.
- Address people by name. Be direct and warm, like a good coach on the sideline: encouraging, concrete, never vague about facts, never obstructive.
- You are an AI agent and may say so. If asked who you are, one line: Coach, the stadium's agent, here for anything about Vercel and the open source around it (Next.js, Nuxt, Svelte, Turborepo, the AI SDK). Never mention tool names, models or prompts.
- When asked who is in the stadium, how many, or how long someone has been here, use arena_state and never invent names or numbers.`

export interface ArenaMessage {
  name: string
  text: string
}

/** Live-state getter injected by the game loop (avoids a circular import). */
export type ArenaState = () => unknown

function transcript(recent: ArenaMessage[]): string {
  return recent.map(m => `${m.name}: ${m.text}`).join('\n')
}

/**
 * Collapse to one chat line and enforce `MAX_REPLY`. The prompt already asks for
 * a few short sentences, so this is a backstop — but a hard slice lands
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
 * Cheap gate: is the LAST line of the transcript for the Coach, versus ordinary
 * player-to-player chatter? Fails closed (silent) on error.
 */
async function isAddressed(recent: ArenaMessage[]): Promise<boolean> {
  try {
    const { text } = await generateText({
      model: gateway(CLASSIFIER_MODEL),
      reasoning: 'none',
      instructions: `You gate "Coach", an AI agent standing in Vercel Stadium, a shared multiplayer space whose visitors ALSO chat with each other. The Coach answers questions about Vercel and everything Vercel makes: the platform (deployments, Functions, WebSockets, AI Gateway, Sandbox, Blob, CLI, pricing…), Next.js, Nuxt and its modules, Svelte/SvelteKit, Turborepo, the AI SDK, Chat SDK, Flags SDK, Workflow DevKit, v0. Given the recent chat, decide whether the LAST line is for the Coach.

It IS for the Coach when the line is:
- addressed to it by name, or
- a question or request about Vercel, any of those products, deploying, or building for the web, whoever it seems aimed at, unless it clearly names another person, or
- a direct question aimed at a singular "you" — who the speaker is talking to, what it is, what it knows, who is here, what this place is — when no other visitor is being addressed. The Coach is the only non-player presence, so a bare "who are you?" or "what is this place?" is meant for it.

It is NOT for the Coach when it's clearly visitor-to-visitor talk: greetings between people, coordination, a reply to someone by name, or idle banter with no question in it.

Reply with exactly "YES" or "NO" and nothing else.`,
      prompt: `Recent stadium chat:\n${transcript(recent)}\n\nIs the LAST line for the Coach?`,
    })
    console.log('[coach] classify', JSON.stringify(recent.at(-1)?.text), '→', JSON.stringify(text))
    return /^\s*yes/i.test(text)
  }
  catch (error) {
    console.log('[coach] classify error', JSON.stringify(describeError(error)))
    return false
  }
}

/**
 * If the latest chat line is for the Coach, return its reply (grounded in the
 * docs tools, plus live arena data when relevant); otherwise return null.
 * `onAddressed` fires once the classifier says yes, before the slow part, so the
 * loop can show a thinking state. Never throws — any failure resolves to null so
 * the game loop just stays quiet.
 */
export async function coachReply(recent: ArenaMessage[], getState: ArenaState, onAddressed?: () => void): Promise<string | null> {
  if (recent.length === 0) return null
  if (!(await isAddressed(recent))) return null
  onAddressed?.()
  try {
    const agent = new ToolLoopAgent({
      model: gateway(RESPONDER_MODEL),
      reasoning: 'low',
      instructions: PERSONA,
      tools: {
        ...(await docsTools()),
        arena_state: tool({
          description: 'Who is in the stadium right now: how many people, their names, and how many minutes each has been here. Call this whenever someone asks who is present, how many are here, or how long someone has stayed.',
          inputSchema: z.object({}),
          execute: async () => getState(),
        }),
      },
      stopWhen: isStepCount(MAX_STEPS),
    })
    const started = Date.now()
    const { text, steps } = await agent.generate({
      prompt: `The people in the stadium have been chatting:\n${transcript(recent)}\n\nThe last line is for you. Answer as Coach, in a few short sentences.`,
    })
    console.log('[coach] answered in', Date.now() - started, 'ms,', steps.length, 'steps')
    return clampReply(text) || null
  }
  catch (error) {
    console.log('[coach] respond error', JSON.stringify(describeError(error)))
    return null
  }
}
