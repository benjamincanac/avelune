export default defineAppConfig({
  site: {
    name: 'Mugen',
    title: 'Mugen — endless multiplayer tower on Vercel WebSockets',
    description:
      'An endless multiplayer tower on the Vercel Functions WebSocket beta. Spawn in the hub, step into the teleport circle, and descend through biome floors — stone, sunken, verdant, magma — dodging hazards for depth on the daily leaderboard. Authoritative Nitro game loop, TresJS rendering, one WebSocket per runner.',
    tagline: 'Nuxt × Vercel WebSockets',
    repo: 'https://github.com/benjamincanac/mugen',
    deployUrl:
      'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbenjamincanac%2Fmugen&env=NUXT_PUBLIC_SITE_URL&envDescription=Optional%20canonical%20URL%20for%20SEO&project-name=mugen&repository-name=mugen',
    ogImage: '/og.png',
    twitter: '@vercel',
  },
  ui: {
    colors: {
      primary: 'green',
      neutral: 'neutral',
    },
    button: {
      slots: {
        base: 'active:translate-y-px transition-transform duration-200',
      },
    },
  },
})
