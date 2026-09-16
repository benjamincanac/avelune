import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The shared-physics, terrain, building and chunk-store suites. They import
 * the same `shared/` and `server/` modules the game runs, so the Nuxt aliases
 * those modules use are mapped here.
 */
export default defineConfig({
  test: {
    include: ['scripts/*-test.ts'],
    environment: 'node',
    // The town connectivity flood fill and the chunk-store restart tests each
    // take several seconds by design.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
})
