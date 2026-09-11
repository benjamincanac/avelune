import { defineEventHandler, deleteCookie } from 'h3'
import { COOKIE_NAME } from '../utils/session'

/**
 * `DELETE /api/auth` — log out by clearing the identity cookie.
 * Same `path` as the set, or the browser keeps the old cookie.
 * The next `/` load lands on character creation and `POST /api/auth` mints a fresh id.
 */
export default defineEventHandler((event) => {
  deleteCookie(event, COOKIE_NAME, { path: '/' })
  return { authenticated: false as const }
})
