/**
 * The Vercel brands dressing the stadium — its "sponsors". Primitives are the
 * platform's products; frameworks are what ships on it. Render-only data.
 */

export interface BrandLogo {
  /** SVG path data in a 24×24 viewBox (Simple Icons, CC0). */
  path: string
  /** Brand colour; defaults to the cell's foreground. */
  color?: string
}

export interface Brand {
  label: string
  /** Primitives carry the ▲ mark; frameworks are set apart as light cells. */
  kind: 'primitive' | 'framework'
  /** The brand's own mark, drawn instead of the ▲. */
  logo?: BrandLogo
  /** False when the logo already is the wordmark. */
  wordmark?: boolean
}

const LOGOS = {
  nextjs: {
    path: 'M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z',
  },
  nuxt: {
    path: 'M13.4642 19.8295h8.9218c.2834 0 .5618-.0723.8072-.2098a1.5899 1.5899 0 0 0 .5908-.5732 1.5293 1.5293 0 0 0 .216-.783 1.529 1.529 0 0 0-.2167-.7828L17.7916 7.4142a1.5904 1.5904 0 0 0-.5907-.573 1.6524 1.6524 0 0 0-.807-.2099c-.2833 0-.5616.0724-.807.2098a1.5904 1.5904 0 0 0-.5907.5731L13.4642 9.99l-2.9954-5.0366a1.5913 1.5913 0 0 0-.591-.573 1.6533 1.6533 0 0 0-.8071-.2098c-.2834 0-.5617.0723-.8072.2097a1.5913 1.5913 0 0 0-.591.573L.2168 17.4808A1.5292 1.5292 0 0 0 0 18.2635c-.0001.2749.0744.545.216.783a1.59 1.59 0 0 0 .5908.5732c.2454.1375.5238.2098.8072.2098h5.6003c2.219 0 3.8554-.9454 4.9813-2.7899l2.7337-4.5922L16.3935 9.99l4.3944 7.382h-5.8586ZM7.123 17.3694l-3.9083-.0009 5.8586-9.8421 2.9232 4.921-1.9572 3.2892c-.7478 1.1967-1.5972 1.6328-2.9163 1.6328z',
    color: '#00DC82',
  },
  svelte: {
    path: 'M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z',
    color: '#FF3E00',
  },
  turborepo: {
    path: 'M11.9906 4.1957c-4.2998 0-7.7981 3.501-7.7981 7.8043s3.4983 7.8043 7.7981 7.8043c4.2999 0 7.7982-3.501 7.7982-7.8043s-3.4983-7.8043-7.7982-7.8043m0 11.843c-2.229 0-4.0356-1.8079-4.0356-4.0387s1.8065-4.0387 4.0356-4.0387S16.0262 9.7692 16.0262 12s-1.8065 4.0388-4.0356 4.0388m.6534-13.1249V0C18.9726.3386 24 5.5822 24 12s-5.0274 11.66-11.356 12v-2.9139c4.7167-.3372 8.4516-4.2814 8.4516-9.0861s-3.735-8.749-8.4516-9.0861M5.113 17.9586c-1.2502-1.4446-2.0562-3.2845-2.2-5.3046H0c.151 2.8266 1.2808 5.3917 3.051 7.3668l2.0606-2.0622zM11.3372 24v-2.9139c-2.02-.1439-3.8584-.949-5.3019-2.2018l-2.0606 2.0623c1.975 1.773 4.538 2.9022 7.361 3.0534z',
    color: '#EF4444',
  },
  v0: {
    path: 'M14.066 6.028v2.22h5.729q.075-.001.148.005l-5.853 5.752a2 2 0 0 1-.024-.309V8.247h-2.353v5.45c0 2.322 1.935 4.222 4.258 4.222h5.675v-2.22h-5.675q-.03 0-.059-.003l5.729-5.629q.006.082.006.166v5.465H24v-5.465a4.204 4.204 0 0 0-4.205-4.205zM0 8.245l8.28 9.266c.839.94 2.396.346 2.396-.914V8.245H8.19v5.44l-4.86-5.44Z',
  },
} satisfies Record<string, BrandLogo>

export const PRIMITIVES: Brand[] = [
  { label: 'AI SDK', kind: 'primitive' },
  { label: 'AI Gateway', kind: 'primitive' },
  { label: 'Workflow SDK', kind: 'primitive' },
  { label: 'Queues', kind: 'primitive' },
  { label: 'Sandbox', kind: 'primitive' },
  { label: 'Connect', kind: 'primitive' },
  { label: 'Chat SDK', kind: 'primitive' },
  { label: 'Passport', kind: 'primitive' },
  { label: 'Fluid Compute', kind: 'primitive' },
  { label: 'Observability', kind: 'primitive' },
  { label: 'v0', kind: 'primitive', logo: LOGOS.v0, wordmark: false },
  { label: 'Domains', kind: 'primitive' },
  { label: 'Vercel Agent', kind: 'primitive' },
]

/** eve has no published mark yet, so it stays a wordmark. */
export const FRAMEWORKS: Brand[] = [
  { label: 'eve', kind: 'framework' },
  { label: 'Next.js', kind: 'framework', logo: LOGOS.nextjs },
  { label: 'Nuxt', kind: 'framework', logo: LOGOS.nuxt },
  { label: 'SvelteKit', kind: 'framework', logo: LOGOS.svelte },
  { label: 'Turborepo', kind: 'framework', logo: LOGOS.turborepo },
]

/** Where the five frameworks land in the ring, spread so the cells alternate. */
const FRAMEWORK_SLOTS = new Set([2, 6, 9, 13, 16])

/** The 18 brands in ring order — the sequence every LED band repeats. */
export const BRAND_RING: Brand[] = (() => {
  const ring: Brand[] = []
  let primitive = 0
  let framework = 0
  for (let i = 0; i < PRIMITIVES.length + FRAMEWORKS.length; i++) {
    ring.push(FRAMEWORK_SLOTS.has(i) ? FRAMEWORKS[framework++]! : PRIMITIVES[primitive++]!)
  }
  return ring
})()
