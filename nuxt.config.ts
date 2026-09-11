// Site metadata, single source of truth for SEO. Previously in app.config.ts +
// useSiteSeo(), but every value here is static, so it lives in the build-time
// head config instead of a runtime composable.
const site = {
  name: 'Avelune',
  title: 'Avelune, a shared fantasy village on Vercel WebSockets',
  description:
    'Explore a shared fantasy village, meet other travellers, and talk to the Oracle. Built with Nuxt, TresJS, and an authoritative multiplayer game loop over Vercel WebSockets.',
  tagline: 'Nuxt × Vercel WebSockets',
  repo: 'https://github.com/benjamincanac/avelune',
  deployUrl:
    'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbenjamincanac%2Favelune&env=NUXT_PUBLIC_SITE_URL&envDescription=Optional%20canonical%20URL%20for%20SEO&project-name=avelune&repository-name=avelune',
  ogImage: '/og.png',
  twitter: '@vercel',
}

// Canonical origin. Set NUXT_PUBLIC_SITE_URL in the deploy environment; the
// fallback is only used for local/preview builds — change it to the real domain.
const siteUrl = (process.env.NUXT_PUBLIC_SITE_URL || 'https://tempest-tower.vercel.app').replace(/\/$/, '')
const canonical = `${siteUrl}/`
const ogImage = `${siteUrl}${site.ogImage}`

export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@tresjs/nuxt'],

  devtools: { enabled: false },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
      title: site.title,
      meta: [
        { name: 'theme-color', content: '#93B9E8' },
        { name: 'color-scheme', content: 'light dark' },
        { name: 'robots', content: 'index, follow' },
        { name: 'description', content: site.description },
        { name: 'author', content: 'Vercel Labs' },
        {
          name: 'keywords',
          content: 'Nuxt, Vercel, WebSockets, realtime, multiplayer, game, MMO, Nitro, demo',
        },
        { property: 'og:title', content: site.title },
        { property: 'og:description', content: site.description },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: canonical },
        { property: 'og:site_name', content: site.name },
        { property: 'og:image', content: ogImage },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: site.title },
        { name: 'twitter:description', content: site.description },
        { name: 'twitter:image', content: ogImage },
        { name: 'twitter:site', content: site.twitter },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg?v=wind' },
        { rel: 'canonical', href: canonical },
      ],
      script: [
        {
          type: 'application/ld+json',
          innerHTML: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            'name': site.name,
            'description': site.description,
            'url': siteUrl,
            'image': ogImage,
            'applicationCategory': 'DeveloperApplication',
            'operatingSystem': 'Any',
            'offers': {
              '@type': 'Offer',
              'price': '0',
              'priceCurrency': 'USD',
            },
            'isPartOf': {
              '@type': 'SoftwareSourceCode',
              'codeRepository': site.repo,
              'programmingLanguage': 'TypeScript',
            },
          }),
        },
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // Secret for signing the identity cookie (see server/utils/session.ts).
    // Set NUXT_SESSION_PASSWORD in production; a dev fallback is used if empty.
    sessionPassword: '',
  },

  experimental: {
    // Nuxt 5 turns off Nitro's v2-style auto-imports by default, which drops the
    // `#imports` virtual that prebuilt server code in node_modules (e.g.
    // @nuxt/icon's API route) still imports from. Re-enable it so those modules
    // resolve under the Nitro v3 builder.
    nitroAutoImports: true,
  },

  compatibilityDate: 'latest',

  // Nitro v3 has native crossws WebSocket support that works in local dev and on
  // Vercel — the Vercel preset bridges Vercel's runtime socket upgrade into
  // crossws via `crossws/adapters/vercel`, so a single handler powers every
  // environment. (Requires Nitro >= 3.0.260610-beta.)
  nitro: {
    experimental: {
      websocket: true,
    },
  },

  // The Nitro v3 beta's rolldown build mishandles @nuxt/icon's local server
  // bundle: the dynamic `import('@iconify-json/*/icons.json', { with: { type:
  // 'json' } })` is chunked but the call site keeps the bare specifier, which
  // crashes on Vercel (no node_modules in /var/task) with ERR_MODULE_NOT_FOUND.
  // 'remote' swaps those imports for CDN fetches, so nothing resolves locally.
  icon: {
    serverBundle: 'remote',
  },
})
