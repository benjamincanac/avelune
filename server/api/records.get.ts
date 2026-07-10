import { defineEventHandler } from 'h3'
import { currentOnline, currentRecords } from '../utils/game'

/**
 * `GET /api/records` — the fastest clears plus the live runner count, for
 * the main menu which shows both before opening a socket. In-game/spectator
 * clients get this data live over the WebSocket instead.
 */
export default defineEventHandler(() => {
  return { records: currentRecords(), online: currentOnline() }
})
