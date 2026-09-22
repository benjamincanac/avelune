import { defineEventHandler } from 'h3'
import { chunkStore, REALM } from '../utils/chunkStore'
import { liveStatus } from '../utils/live'

/**
 * `GET /api/status` — the title screen's live surface, before any socket exists.
 *
 * The title screen shows who is around, how busy the world has been and what
 * has just happened in it, all of which `welcome` and the world frames carry
 * over the socket — but the page is prerendered and has no socket, so it asks
 * for the same facts here. Polled every 10s while the page is up.
 *
 * Every number comes out of the store rather than out of this process, and that
 * is the whole point: a region runs as many instances as it needs, the sockets
 * are pinned to whichever accepted their upgrade, and this request lands
 * wherever. Read from memory, the page would report the roster of whichever
 * instance happened to answer. Nothing scans a chunk either way.
 */
export default defineEventHandler(async () => {
  const live = await liveStatus()
  return {
    players: live.players,
    instances: live.instances,
    today: live.today,
    series: live.series,
    realm: REALM,
    roster: live.roster,
    persistent: chunkStore().kind !== 'memory',
    feed: live.feed,
  }
})
