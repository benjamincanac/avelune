import { generateText } from 'ai'

/**
 * TEMPORARY diagnostic — delete once the prod Oracle 404 is understood.
 *
 * Runs the exact classifier gateway call the hub Oracle makes, but from a
 * normal HTTP request context instead of the WS `message` event the game loop
 * uses. Comparing the two isolates whether the prod 404 is caused by the call
 * firing outside a request context (OIDC / Vercel fetch instrumentation).
 *
 * Hit it in prod:  /api/oracle-debug?key=<ORACLE_DEBUG_KEY>
 */
export default defineEventHandler(async (event) => {
  if (getQuery(event).key !== (process.env.ORACLE_DEBUG_KEY || 'diag')) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }

  const out: Record<string, unknown> = {
    hasApiKey: !!process.env.AI_GATEWAY_API_KEY,
    hasOidc: !!process.env.VERCEL_OIDC_TOKEN,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    region: process.env.VERCEL_REGION ?? null,
    fetchIsNative: /native code/.test(Function.prototype.toString.call(globalThis.fetch)),
  }

  try {
    const { text } = await generateText({
      model: 'anthropic/claude-haiku-4.5',
      reasoning: 'none',
      instructions: 'Reply with exactly YES or NO.',
      prompt: 'Is the sky blue?',
    })
    out.ok = text
  }
  catch (error) {
    const e = error as {
      name?: string
      message?: string
      statusCode?: number
      cause?: { name?: string, message?: string, statusCode?: number, url?: string, responseBody?: string, responseHeaders?: Record<string, string> }
    }
    out.err = {
      name: e.name,
      message: e.message,
      status: e.statusCode,
      causeName: e.cause?.name,
      causeMessage: e.cause?.message,
      causeStatus: e.cause?.statusCode,
      url: e.cause?.url,
      body: e.cause?.responseBody?.slice?.(0, 300),
      headers: e.cause?.responseHeaders,
    }
  }

  return out
})
