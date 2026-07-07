import { defineEventHandler, getCookie, readBody, setCookie } from 'h3'
import { DEFAULT_CHARACTER, PLAYER_COLORS, isAllowedColorIndex, isCharacter, isOutfitColor, outfitOf, randomColorIndex } from '#shared/utils/characters'
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

/**
 * `POST /api/auth` — the onboarding submit. Takes the chosen username,
 * character, and color index; sanitizes them; mints (or reuses) a stable id;
 * and sets the signed HttpOnly identity cookie. The chosen values become the
 * player the WebSocket spawns.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ username?: string, character?: string, colorIndex?: number, outfitColor?: number }>(event)

  const name = cleanName(body?.username)
  const character = isCharacter(body?.character) ? body.character : DEFAULT_CHARACTER
  // Accents are random at login and must never be a reserved (green/teal)
  // system color — accept the client's roll only if it's allowed, else re-roll.
  const colorIndex = isAllowedColorIndex(body?.colorIndex) ? body!.colorIndex! : randomColorIndex()
  // Outfit colorway is validated against the chosen outfit's variants.
  const outfitColor = isOutfitColor(outfitOf(character), body?.outfitColor) ? body!.outfitColor! : 0

  // Keep the same id across re-submits (change of name/character) so the player
  // stays a stable person; mint a fresh one for a brand-new visitor.
  const existing = verifyToken(getCookie(event, COOKIE_NAME))
  const identity: Identity = {
    id: existing?.id ?? newUserId(),
    name,
    color: PLAYER_COLORS[colorIndex]!,
    character,
    outfitColor,
  }

  setCookie(event, COOKIE_NAME, signIdentity(identity), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Effectively permanent — the character is kept indefinitely (there is no
    // logout; the in-game "leave" only returns to the menu).
    maxAge: 60 * 60 * 24 * 365 * 10,
    secure: !import.meta.dev,
  })

  return { authenticated: true as const, ...identity }
})
