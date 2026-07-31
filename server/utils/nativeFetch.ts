/**
 * The runtime's real `fetch`, captured before Nuxt can replace it.
 *
 * Nuxt's SSR entry (the generated `fetch.server.mjs`) runs
 * `globalThis.fetch = serverFetch` as a top-level side effect when the Vue
 * server bundle first loads, and Nitro's `serverFetch` dispatches EVERY url —
 * absolute external ones included — into this app's own router. The Vue
 * bundle loads lazily (first page or error render in a process), so a warm
 * Vercel instance silently flips from real outbound HTTP to loopback: an AI
 * Gateway call then comes back as this app's own 404 page.
 *
 * Anything doing real outbound HTTP from the server must use this captured
 * reference. `server/plugins/nativeFetch.ts` forces the capture at Nitro
 * boot, before any render can win the race.
 */
export const nativeFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
