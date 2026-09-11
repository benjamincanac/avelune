import { defineEventHandler, getCookie } from 'h3'
import { COOKIE_NAME, verifyToken } from '../utils/session'

/**
 * `GET /api/auth` — report the current signed-cookie identity so the client can
 * decide whether to show the gate or drop straight into the arena.
 */
export default defineEventHandler((event) => {
  const identity = verifyToken(getCookie(event, COOKIE_NAME))
  if (!identity) return { authenticated: false as const }
  return { authenticated: true as const, ...identity }
})
