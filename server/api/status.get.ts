import { defineEventHandler } from 'h3'
import { chunkStore, REALM } from '../utils/chunkStore'
import { playerCount } from '../utils/game'

/**
 * `GET /api/status` — the landing gate's live line, before any socket exists.
 *
 * The gate is the site's index page and shows who is around and which realm
 * they are around in, so it needs the same three facts `welcome` carries
 * without opening a connection to get them. Polled every 10s while the gate is
 * up, so it stays cheap: the roster size, the realm id, and whether this
 * process has a store behind it.
 */
export default defineEventHandler(() => ({
  players: playerCount(),
  realm: REALM,
  persistent: chunkStore().kind !== 'memory',
}))
