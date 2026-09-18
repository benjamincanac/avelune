# Contributing

Thanks for your interest in Avelune!

## Development

```bash
pnpm install
pnpm dev
```

Local dev uses Nitro's native crossws server, so multiplayer works with no extra setup. Open the dev URL in two browsers to see two players. Without Upstash credentials the world is kept in memory.

Before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles (e.g. `feat(world): add a desert biome`).
- Keep changes focused.
- Update the README when setup steps or architecture change.

## Gameplay and secrets

- Do not commit `.env` or real Upstash credentials.
- Anything that affects player position, collision or edit validation lives in [`shared/utils/`](shared/utils/) so the server and client prediction run the same code.
- Keep the wire protocol in [`shared/types/game.ts`](shared/types/game.ts) as the single source of truth shared by client and server.

## Questions

Open a [question issue](https://github.com/benjamincanac/avelune/issues/new?template=question.yml) if you need help.
