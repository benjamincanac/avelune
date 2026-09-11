/**
 * The roster every layer agrees on: the gate (client), the identity route (server) and
 * the 3D renderer (client). There is one look, the Developer, in two bodies: the Quaternius
 * Peasant male and female rigs, both dressed at runtime in Vercel black
 * (`app/utils/developerLook.ts`). `character` on the wire is the roster id.
 */

export const GENDERS = ['Male', 'Female'] as const
export type Gender = typeof GENDERS[number]

export interface Character {
  id: string
  gender: Gender
  /** GLB basename under /models/characters; both ride the universal rig and shared clips. */
  model: string
}

// 'Developer' keeps its pre-gate id so existing cookies still resolve to the male body.
export const CHARACTERS: Character[] = [
  { id: 'Developer', gender: 'Male', model: 'Peasant_Male_Buzzed' },
  { id: 'Developer_Female', gender: 'Female', model: 'Peasant_Female_Long' },
]

export const CHARACTER_NAMES: string[] = CHARACTERS.map(c => c.id)
export const DEFAULT_CHARACTER: string = CHARACTERS[0]!.id

export function isCharacter(name: unknown): name is string {
  return typeof name === 'string' && CHARACTER_NAMES.includes(name)
}

/** The roster id for a gender pick in the gate. */
export function characterForGender(gender: Gender): string {
  return CHARACTERS.find(c => c.gender === gender)!.id
}

/** The model a character renders with. Unknown ids (old cookies) get the default body. */
export function characterModel(character: string): string {
  return (CHARACTERS.find(c => c.id === character) ?? CHARACTERS[0]!).model
}

/* -------------------------------------------------------------------------- */
/* Accent color (chat / nameplate identity only — never dyes the outfit)      */
/* -------------------------------------------------------------------------- */

export const PLAYER_COLORS: string[] = [
  'hsl(6, 85%, 60%)', // red
  'hsl(28, 90%, 56%)', // orange
  'hsl(45, 90%, 55%)', // gold
  'hsl(140, 55%, 50%)', // green
  'hsl(172, 68%, 44%)', // teal
  'hsl(205, 85%, 58%)', // blue
  'hsl(255, 68%, 67%)', // indigo
  'hsl(318, 70%, 62%)', // magenta
]
export const DEFAULT_COLOR_INDEX = 5 // blue

/**
 * Green + teal are reserved for the system (chat announcements, the connected
 * status dot, the app's primary). Accents are randomized at login and must
 * never land on those, so a player can't be mistaken for system UI.
 */
const RESERVED_COLOR_INDICES = new Set([3, 4])

export function isAllowedColorIndex(i: unknown): i is number {
  return Number.isInteger(i) && (i as number) >= 0 && (i as number) < PLAYER_COLORS.length && !RESERVED_COLOR_INDICES.has(i as number)
}

export function randomColorIndex(): number {
  const pool = PLAYER_COLORS.map((_, i) => i).filter(i => !RESERVED_COLOR_INDICES.has(i))
  return pool[Math.floor(Math.random() * pool.length)]!
}
