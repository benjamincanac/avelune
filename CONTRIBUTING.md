# Contributing

Thanks for your interest in this starter!

## Development

```bash
pnpm install
pnpm dev
```

Local dev uses Nitro's native crossws server, so the realtime demo works with no extra setup — open `http://localhost:3000` in two tabs. Cross-instance Redis is only exercised in production.

Before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles (e.g. `feat: add typing indicators`).
- Keep changes focused. This is a minimal template: prefer small, copy-paste-friendly diffs.
- Update the README when setup steps or architecture change.

## Realtime and secrets

- Do not commit `.env` or a real `REDIS_URL`.
- Keep the wire protocol in [`shared/types/realtime.ts`](shared/types/realtime.ts) as the single source of truth shared by client and server.

## Questions

Open a [question issue](https://github.com/vercel-labs/nuxt-websockets-starter/issues/new?template=question.yml) or a GitHub Discussion if you need help adapting the template.
