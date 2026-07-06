export function useSiteSeo() {
  const appConfig = useAppConfig()
  const runtimeConfig = useRuntimeConfig()
  const requestUrl = useRequestURL()

  const site = appConfig.site
  const origin = runtimeConfig.public.siteUrl || requestUrl.origin
  const url = (path = '/') => new URL(path, origin).href

  const title = site.title
  const description = site.description
  const canonical = url()
  const ogImage = url(site.ogImage)

  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogType: 'website',
    ogUrl: canonical,
    ogSiteName: site.name,
    ogImage,
    twitterCard: 'summary_large_image',
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: ogImage,
    twitterSite: site.twitter,
  })

  useHead({
    link: [{ rel: 'canonical', href: canonical }],
    meta: [
      { name: 'author', content: 'Vercel Labs' },
      {
        name: 'keywords',
        content: 'Nuxt, Vercel, WebSockets, realtime, multiplayer, game, MMO, Nitro, demo',
      },
    ],
    script: [
      {
        type: 'application/ld+json',
        innerHTML: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          'name': site.name,
          'description': site.description,
          'url': origin,
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
  })

  return { title, description, canonical }
}
