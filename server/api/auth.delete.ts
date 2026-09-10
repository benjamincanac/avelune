import { defineEventHandler, deleteCookie } from 'h3'
import { COOKIE_NAME } from '../utils/session'

/** Clear the saved identity so the next page state is character creation. */
export default defineEventHandler((event) => {
  deleteCookie(event, COOKIE_NAME, { path: '/' })
  return { authenticated: false as const }
})
