import { nativeFetch } from '../utils/nativeFetch'

/**
 * Keep outbound HTTP outbound.
 *
 * Nuxt's SSR entry assigns `globalThis.fetch = serverFetch` as a top-level side
 * effect the first time the Vue server bundle loads (lazily, on the first page
 * or error render), and that dispatcher routes EVERY url into this app's own
 * router — absolute external ones included ([nuxt/nuxt#35321]). Our own code
 * dodges it by importing `nativeFetch`, but third-party server code can't:
 * `@nuxt/icon`'s generated remote-collection loader calls a bare
 * `fetch('https://cdn.jsdelivr.net/npm/@iconify-json/<set>/icons.json')` and
 * gets our own response back, which crashes `@iconify/utils` on the missing
 * `icons` key (a 500 on `/api/_nuxt_icon/<set>.json`). It reproduces exactly on
 * render order: request icons before any page has rendered and they resolve;
 * render a page first and every icon request fails from then on.
 *
 * Rather than race that assignment, intercept it. Absolute http(s) urls go to
 * the real fetch; everything else keeps whatever Nuxt installed, because
 * resolving relative urls against the running app is the entire point of the
 * loopback. An absolute *same-origin* url now costs a real round-trip instead
 * of an in-process dispatch, which is correct, just slower — nothing here
 * fetches itself that way.
 */
export default defineNitroPlugin(() => {
  // Force the capture at boot, before any render can win the race.
  void nativeFetch

  let installed: typeof globalThis.fetch = nativeFetch

  const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return input.url
  }

  const dispatch: typeof globalThis.fetch = (input, init) =>
    /^https?:\/\//i.test(urlOf(input)) ? nativeFetch(input, init) : installed(input, init)

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => dispatch,
    set: (value: typeof globalThis.fetch) => {
      installed = value
    },
  })
})
