import { defineEventHandler, getCookie, readBody, setCookie } from 'h3'
import { DEFAULT_CHARACTER, PLAYER_COLORS, isAllowedColorIndex, isCharacter, randomColorIndex } from '#shared/utils/characters'
import { COOKIE_NAME, newUserId, signIdentity, verifyToken } from '../utils/session'
import type { Identity } from '../utils/session'

const MAX_NAME = 20

/** Drop control characters, collapse whitespace, and cap the length. */
function cleanName(input: unknown): string {
  if (typeof input !== 'string') return ''
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)!
    if (code >= 32 && code !== 127) out += ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/** Every player is a developer; a visitor who arrives without a name gets a handle. */
function randomName(): string {
  return `dev-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * `POST /api/auth` — mint (or refresh) an identity and set the signed HttpOnly cookie.
 * The gate sends `username` + `character` (the gender pick); `colorIndex` is an optional
 * accent roll. Every field falls back, so a bare POST still mints a Developer. Re-submits
 * keep the same id (and the current name/body/colour unless a new one is sent), so a
 * player stays one stable person.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ username?: string, character?: string, colorIndex?: number } | null>(event).catch(() => null)
  const existing = verifyToken(getCookie(event, COOKIE_NAME))

  const name = cleanName(body?.username) || existing?.name || randomName()
  const character = isCharacter(body?.character) ? body!.character! : existing?.character ?? DEFAULT_CHARACTER
  // Accents must never be a reserved (green/teal) system color — accept the
  // client's roll only if it's allowed, else keep the current one or re-roll.
  const color = isAllowedColorIndex(body?.colorIndex)
    ? PLAYER_COLORS[body!.colorIndex!]!
    : existing?.color ?? PLAYER_COLORS[randomColorIndex()]!

  const identity: Identity = {
    id: existing?.id ?? newUserId(),
    name,
    color,
    character,
  }

  setCookie(event, COOKIE_NAME, signIdentity(identity), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Effectively permanent — kept until `DELETE /api/auth` (Log out) clears it.
    maxAge: 60 * 60 * 24 * 365 * 10,
    secure: !import.meta.dev,
  })

  return { authenticated: true as const, ...identity }
})
