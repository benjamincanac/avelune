import { defineEventHandler } from 'h3'
import { chunkStore, REALM } from '../utils/chunkStore'
import { playerStats, recentEvents } from '../utils/game'

/**
 * `GET /api/status` — the title screen's live surface, before any socket exists.
 *
 * The title screen shows who is around, how busy the world has been and what
 * has just happened in it, all of which `welcome` and the world frames carry
 * over the socket — but the page is prerendered and has no socket, so it asks
 * for the same facts here. Polled every 10s while the page is up, so everything
 * on it is already computed: the roster size, the peak and hourly series the
 * game loop keeps as players come and go, and the world feed's ring buffer.
 * Nothing scans a chunk.
 */
export default defineEventHandler(() => {
  const stats = playerStats()
  return {
    players: stats.players,
    peak: stats.peak,
    series: stats.series,
    realm: REALM,
    roster: stats.roster,
    persistent: chunkStore().kind !== 'memory',
    feed: recentEvents(),
  }
})
