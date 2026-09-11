import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Player } from '#shared/types/game'

/**
 * Signed-cookie identity — no database.
 *
 * The player's chosen `{ id, name, color, character }` is serialized and
 * HMAC-signed into an HttpOnly cookie by `POST /api/auth`. It is verified in
 * two places: HTTP routes (via the h3 event) and the WebSocket `open` handler
 * (which only has the raw upgrade `Cookie` header). Signing is synchronous
 * (node:crypto) so the WS handler needs no `await`.
 *
 * The signature makes the cookie tamper-evident: a client can read nothing
 * (HttpOnly) and can't forge a different id/name without the server secret.
 */

// The signed cookie IS each player's identity. Renamed with the Vercel Stadium rebrand;
// existing `mugen_id` cookies no longer match, so players re-onboard once.
export const COOKIE_NAME = 'stadium_id'

export type Identity = Pick<Player, 'id' | 'name' | 'color' | 'character'>

let warnedNoSecret = false

function secret(): string {
  const configured = useRuntimeConfig().sessionPassword
  if (configured) return configured
  // Local dev convenience: a fixed fallback so cookies still verify without
  // env setup. Never rely on this in production — set NUXT_SESSION_PASSWORD.
  if (!warnedNoSecret) {
    console.warn('[auth] NUXT_SESSION_PASSWORD is unset — using an insecure dev secret')
    warnedNoSecret = true
  }
  return 'stadium-dev-insecure-secret'
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/** Serialize + sign an identity into the cookie value `payload.signature`. */
export function signIdentity(identity: Identity): string {
  const payload = Buffer.from(JSON.stringify(identity)).toString('base64url')
  return `${payload}.${sign(payload)}`
}

/** Verify a `payload.signature` token and return the identity, or null. */
export function verifyToken(token: string | undefined | null): Identity | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(payload))
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Identity
    if (obj && typeof obj.id === 'string' && typeof obj.name === 'string'
      && typeof obj.color === 'string' && typeof obj.character === 'string') {
      return obj
    }
  }
  catch {
    // Malformed payload — treat as unauthenticated.
  }
  return null
}

/** Parse a raw `Cookie` request header and verify our session cookie. Used by
 * the WebSocket `open` handler, which has no h3 event to call getCookie on. */
export function verifyCookieHeader(header: string | null | undefined): Identity | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue
    return verifyToken(decodeURIComponent(part.slice(eq + 1).trim()))
  }
  return null
}

export function newUserId(): string {
  return randomUUID()
}
