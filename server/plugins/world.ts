import type { NitroApp } from 'nitro/types'
import { chunkStore } from '../utils/chunkStore'
import { loadPieceCounts } from '../utils/pieces'
import { flushDirtyChunks, prefetchSpawn } from '../utils/world'

/**
 * The world's boot and shutdown.
 *
 * Boot pulls the spawn neighbourhood out of the store before anyone can arrive
 * on it: the first player of a cold instance would otherwise stand on chunks
 * that are still in flight, which physics correctly treats as a wall.
 *
 * Shutdown is the other half of write-behind. Edits live in memory for up to
 * five seconds, so the process has to drain them before it goes: Nitro's
 * `close` hook covers a graceful shutdown, and the process signals cover
 * everything else. Vercel sends `SIGTERM` and gives a short grace period, so the
 * flush has to stay the cheap one it is — a handful of pipelined writes.
 *
 * Boot also pulls in every identity's owned-piece total, because the build
 * budget is a fact about a person and has to survive a redeploy. It is one
 * small hash and it is read before the first socket can ask for a welcome.
 */
export default defineNitroPlugin(async (nitroApp: NitroApp) => {
  const store = chunkStore()
  console.log(`[world] chunk store: ${store.kind}`)

  let draining: Promise<unknown> | undefined
  const drain = () => (draining ??= flushDirtyChunks()
    .catch((error: unknown) => {
      console.error('[world] shutdown flush failed', error)
    })
    .finally(() => {
      draining = undefined
    }))

  nitroApp.hooks?.hook('close', drain)

  // A signal listener replaces Node's default handler, so this one owns the
  // exit as well as the flush.
  const onSignal = () => {
    void drain().then(() => process.exit(0))
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  // The loop went empty on its own: drain, but let Node leave when it is done.
  process.once('beforeExit', () => void drain())

  await loadPieceCounts().catch((error: unknown) => {
    console.error('[world] piece counts failed to load', error)
  })

  await prefetchSpawn().catch((error: unknown) => {
    console.error('[world] spawn prefetch failed', error)
  })
})
