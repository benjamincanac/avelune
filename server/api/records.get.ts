import { defineEventHandler } from 'h3'
import { currentRecords } from '../utils/game'

/**
 * `GET /api/records` — today's fastest clears, for the login gate which shows
 * the board before opening a socket. In-game/spectator clients get this data
 * live over the WebSocket instead.
 */
export default defineEventHandler(() => {
  return { records: currentRecords() }
})
