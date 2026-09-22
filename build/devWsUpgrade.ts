import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { defineNuxtModule } from 'nuxt/kit'

// Dev-only bridge for WebSocket upgrades. Nuxt runs Vite in middleware mode, so
// `server.httpServer` is null, while Nitro's Vite plugin does
// `server.httpServer.on('upgrade')` when `features.websocket` is on and crashes
// `nuxt dev`. The Nuxt CLI forwards upgrades from the real listener only when
// `nuxt.server.upgrade` exists, and the Vite-environment dev server has none.
// A stand-in emitter takes Nitro's listener and `nuxt.server.upgrade` replays
// the CLI's upgrades into it. Remove once Nuxt forwards upgrades itself.
//
// Imported by nuxt.config.ts instead of living in `modules/`: a local module path
// lands in `build.transpile` normalized to the project root, which puts the whole
// tree, `node_modules` included, in the ssr environment's `noExternal`.
export default defineNuxtModule({
  meta: { name: 'dev-ws-upgrade' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return

    const upgrades = new EventEmitter()

    nuxt.options.vite.plugins ||= []
    nuxt.options.vite.plugins.push({
      name: 'avelune:dev-ws-upgrade',
      configureServer: {
        order: 'pre',
        handler(server) {
          if (!server.httpServer) {
            Object.defineProperty(server, 'httpServer', { value: upgrades, configurable: true })
          }
        },
      },
    })

    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      upgrades.emit('upgrade', req, socket, head)
    }

    // The CLI looks for `upgrade` before the build assigns `nuxt.server`, so a
    // placeholder answers until then and the real server gets `upgrade` on assign.
    let current: unknown
    Object.defineProperty(nuxt, 'server', {
      configurable: true,
      get: () => current ?? { upgrade },
      set: (value) => {
        if (value && typeof value === 'object' && !('upgrade' in value)) {
          Object.assign(value, { upgrade })
        }
        current = value
      },
    })
  },
})
