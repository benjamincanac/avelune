/**
 * TEMPORARY diagnostic — delete once the prod Oracle 404 is understood.
 *
 * The prod Oracle's gateway fetch to the ABSOLUTE url
 * `https://ai-gateway.vercel.sh/v4/ai/language-model` comes back as this app's
 * own Nuxt 404 page — i.e. the request is looping back in-process instead of
 * leaving the deployment. These raw `fetch` probes isolate the scope:
 *   - external control (example.com): does ANY outbound fetch escape?
 *   - the gateway host itself: does `*.vercel.sh` specifically loop back?
 *
 * Hit it in prod:  /api/oracle-debug?key=<ORACLE_DEBUG_KEY or "diag">
 */
export default defineEventHandler(async (event) => {
  if (getQuery(event).key !== (process.env.ORACLE_DEBUG_KEY || 'diag')) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }

  async function probe(url: string, headers?: Record<string, string>) {
    try {
      const res = await fetch(url, { headers })
      const body = await res.text()
      return {
        status: res.status,
        poweredBy: res.headers.get('x-powered-by'),
        server: res.headers.get('server'),
        vercelId: res.headers.get('x-vercel-id'),
        contentType: res.headers.get('content-type'),
        bodyHead: body.slice(0, 120),
      }
    }
    catch (error) {
      return { error: (error as Error).message, name: (error as Error).name }
    }
  }

  const key = process.env.AI_GATEWAY_API_KEY
  return {
    env: {
      hasApiKey: !!key,
      hasOidc: !!process.env.VERCEL_OIDC_TOKEN,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      region: process.env.VERCEL_REGION ?? null,
      vercelUrl: process.env.VERCEL_URL ?? null,
    },
    // Control: a totally unrelated external host.
    external: await probe('https://example.com'),
    // The gateway host, unauthenticated — a real gateway answers with JSON
    // (401/200), NOT a Nuxt 404. A Nuxt page here proves the loopback.
    gatewayModels: await probe('https://ai-gateway.vercel.sh/v1/models', key ? { authorization: `Bearer ${key}` } : undefined),
  }
})
