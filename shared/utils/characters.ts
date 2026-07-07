/**
 * The roster every layer agrees on: the character creator (client), the 3D
 * renderer (client), and the identity validator (server) all import from here.
 *
 * A character is chosen along four axes:
 *   - gender   (Male / Female)      → picks the base body
 *   - outfit   (Peasant / Ranger)   → the clothing family
 *   - hair     (per gender)         → baked into the GLB (Ranger is hooded → none)
 *   - color    (outfit colorway)    → runtime texture swap on the cloth material
 *
 * gender + outfit + hair resolve to a GLB basename under /models/characters
 * (built by scripts/convert_universal_characters.py); all share one universal
 * skeleton, so the shared `animations.glb` drives every one. The colorways come
 * from the texture pack (not arbitrary dye). The separate accent `color` is a
 * chat/nameplate identity only.
 */

export const GENDERS = ['Male', 'Female'] as const
export type Gender = typeof GENDERS[number]

/* -------------------------------------------------------------------------- */
/* Outfits (the "class" pick) + per-outfit gate backdrop                      */
/* -------------------------------------------------------------------------- */

export interface Outfit {
  id: string
  name: string
  /** Lucide icon for the picker tile. */
  icon: string
  blurb: string
  /** CSS background shown behind the character in the gate. */
  bg: string
  /** Hooded outfits hide hair, so they offer no hairstyle choice. */
  hooded: boolean
}

export const OUTFITS: Outfit[] = [
  {
    id: 'Peasant',
    name: 'Peasant',
    icon: 'i-lucide-wheat',
    blurb: 'Rough tunic, worn boots, and no illusions of grandeur — just grit. The tower has swallowed finer folk than nobles.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(120,86,38,0.5), transparent 70%), linear-gradient(180deg, #33260f 0%, #1a1109 55%, #0b0705 100%)',
    hooded: false,
  },
  {
    id: 'Ranger',
    name: 'Ranger',
    icon: 'i-lucide-target',
    blurb: 'A hooded wanderer of the wilds, cloak drawn against the tower’s chill. Travels light and treads quiet through the labyrinth.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(46,86,84,0.55), transparent 70%), linear-gradient(180deg, #16302f 0%, #0a1a1c 55%, #050d0f 100%)',
    hooded: true,
  },
]

/* -------------------------------------------------------------------------- */
/* Hairstyles (baked into the GLB) — only for non-hooded outfits              */
/* -------------------------------------------------------------------------- */

export interface Hairstyle {
  /** GLB-name suffix + Quaternius mesh id. */
  id: string
  name: string
}

export const HAIRSTYLES: Record<Gender, Hairstyle[]> = {
  // The pack's only long style is a female mesh that leaves a bald crown on the
  // male head, so males get the short styles; females keep the long ones.
  Male: [
    { id: 'SimpleParted', name: 'Parted' },
    { id: 'Buzzed', name: 'Buzzed' },
  ],
  Female: [
    { id: 'Long', name: 'Long' },
    { id: 'Buns', name: 'Buns' },
  ],
}

/* -------------------------------------------------------------------------- */
/* Outfit colorways (from the texture pack; index 0 is the baked default)     */
/* -------------------------------------------------------------------------- */

export interface OutfitColor {
  name: string
  /** Swatch shown in the picker (approx. of the texture's cloth color). */
  swatch: string
  /** Alt texture basename to swap in at runtime, or null for the baked default. */
  texture: string | null
}

export const OUTFIT_COLOR_DIR = '/models/characters/textures'

export const OUTFIT_COLORS: Record<string, OutfitColor[]> = {
  Peasant: [
    { name: 'Homespun', swatch: '#8a6d4b', texture: null },
    { name: 'Olive', swatch: '#565a3e', texture: 'T_Peasant_2' },
  ],
  Ranger: [
    { name: 'Umber', swatch: '#5a4832', texture: 'T_Ranger_3' },
    { name: 'Forest', swatch: '#4a6e42', texture: null },
  ],
}

/* -------------------------------------------------------------------------- */
/* Names, roster, validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every character carries a hairstyle. Hooded outfits (Ranger) are baked WITH
 * both the hood and the hair; the hood is shown/hidden at runtime via the
 * separate `hood` flag, so "hood + hair" and "hair only" come from one model.
 */
export function characterName(outfit: string, gender: string, hairId?: string): string {
  const hair = hairId ?? HAIRSTYLES[gender as Gender]?.[0]?.id
  return `${outfit}_${gender}_${hair}`
}

export const CHARACTER_NAMES: string[] = OUTFITS.flatMap(o =>
  GENDERS.flatMap(g => HAIRSTYLES[g].map(h => `${o.id}_${g}_${h.id}`)),
)
export const DEFAULT_CHARACTER: string = CHARACTER_NAMES[0]!

export function isCharacter(name: unknown): name is string {
  return typeof name === 'string' && CHARACTER_NAMES.includes(name)
}

/** The outfit id a character belongs to (its GLB-name prefix). */
export function outfitOf(character: string): string {
  return character.split('_')[0]!
}

export function outfitColorCount(outfit: string): number {
  return OUTFIT_COLORS[outfit]?.length ?? 1
}

export function isOutfitColor(outfit: string, i: unknown): i is number {
  return Number.isInteger(i) && (i as number) >= 0 && (i as number) < outfitColorCount(outfit)
}

/** Resolve a colorway index to an alt-texture URL, or null for the baked default. */
export function outfitColorTexture(outfit: string, index: number): string | null {
  const tex = OUTFIT_COLORS[outfit]?.[index]?.texture
  return tex ? `${OUTFIT_COLOR_DIR}/${tex}.png` : null
}

/** Deterministic fallback so a player with no chosen character still renders. */
export function characterFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return CHARACTER_NAMES[hash % CHARACTER_NAMES.length]!
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

/* -------------------------------------------------------------------------- */
/* Display names + randomizers                                                */
/* -------------------------------------------------------------------------- */

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

/** A fully random look for the gate's Randomize button. */
export function randomAppearance(): { gender: Gender, outfit: string, hairId: string, outfitColor: number } {
  const gender = pick(GENDERS)
  const outfit = pick(OUTFITS).id
  return {
    gender,
    outfit,
    hairId: pick(HAIRSTYLES[gender]).id,
    outfitColor: Math.floor(Math.random() * outfitColorCount(outfit)),
  }
}
