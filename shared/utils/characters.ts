/**
 * The roster every layer agrees on: the character creator (client), the 3D
 * renderer (client), and the identity validator (server) all import from here.
 *
 * A character is chosen along five axes:
 *   - gender   (Male / Female)      → picks the base body
 *   - outfit   (the clothing family) → Peasant, Ranger, Knight, Noble, Wizard
 *   - hair     (per gender)         → baked into the GLB
 *   - beard    (males with a face)  → a named mesh in the GLB, toggled at runtime
 *   - color    (outfit colorway)    → runtime texture swap on the cloth material
 *
 * Gender + outfit + hair combinations resolve to a GLB basename under /models/characters
 * (built by scripts/convert_universal_characters.py); those share one universal
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
  /**
   * The outfit's own head piece covers the hair: the Ranger's hood, the
   * Knight's armet. The piece is its own named mesh in the GLB so something can
   * toggle it later, but nothing does yet, so today the flag only records which
   * outfits render the hairstyle pick invisible. The Ranger's hood is open at
   * the face and keeps the hair under it; the Knight's closed armet ships
   * without hair at all, because every style came through the metal. The
   * Noble's crown rides on top of the hair and the Wizard has no head piece in
   * the pack, so both are false.
   */
  hooded: boolean
  /**
   * The head piece encloses the skull, so the outfit ships one GLB per gender
   * with no hair in it (`<Outfit>_<Gender>`) and the creator offers no
   * hairstyle. Today that is the Knight's closed armet.
   */
  hairless?: boolean
}

export const OUTFITS: Outfit[] = [
  {
    id: 'Peasant',
    name: 'Peasant',
    icon: 'i-lucide-wheat',
    blurb: 'Rough tunic, worn boots, and no illusions of grandeur — just grit. The sand has seen finer folk than nobles.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(120,86,38,0.5), transparent 70%), linear-gradient(180deg, #33260f 0%, #1a1109 55%, #0b0705 100%)',
    hooded: false,
  },
  {
    id: 'Ranger',
    name: 'Ranger',
    icon: 'i-lucide-target',
    blurb: 'A hooded wanderer of the wilds, cloak drawn against the wind off the stands. Travels light and treads quiet across the sand.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(46,86,84,0.55), transparent 70%), linear-gradient(180deg, #16302f 0%, #0a1a1c 55%, #050d0f 100%)',
    hooded: true,
  },
  {
    id: 'Knight',
    name: 'Knight',
    icon: 'i-lucide-shield',
    blurb: 'Plate over a scarf, an armet down across the face, and a walk that announces itself. Built for standing in the way of things.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(84,102,124,0.5), transparent 70%), linear-gradient(180deg, #1c2733 0%, #10161d 55%, #070a0d 100%)',
    hooded: true,
    hairless: true,
  },
  {
    id: 'Noble',
    name: 'Noble',
    icon: 'i-lucide-crown',
    blurb: 'Silk and a gorget under a thin crown, cut for a house used to being recognised. The lion on the pauldron came with the title.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(128,52,58,0.5), transparent 70%), linear-gradient(180deg, #33161b 0%, #1c0d10 55%, #0b0506 100%)',
    hooded: false,
  },
  {
    id: 'Wizard',
    name: 'Wizard',
    icon: 'i-lucide-wand-sparkles',
    blurb: 'Long robes, a knotted belt, and nothing on the head but weather. Has more to say about the town\'s old stones than anyone asked for.',
    bg: 'radial-gradient(ellipse 90% 65% at 50% 18%, rgba(78,62,132,0.52), transparent 70%), linear-gradient(180deg, #221c3a 0%, #13101f 55%, #08070d 100%)',
    hooded: false,
  },
]

/* -------------------------------------------------------------------------- */
/* Hairstyles (baked into the GLB, one per outfit/gender combination)         */
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
/* Beard (a named mesh in the male GLBs, shown or hidden per player)          */
/* -------------------------------------------------------------------------- */

/**
 * The beard node name every male GLB with a face carries, straight from the
 * Quaternius pack. It ships visible, so every rig and preview sets `visible`
 * per instance after cloning the shared template. A colorway swap cannot touch
 * it: the beard wears a hair material, and `applyOutfitColor` only rewrites the
 * `MI_<Outfit>` cloth ones.
 */
export const BEARD_MESH = 'Hair_Beard'

/**
 * Only males carry a beard mesh, and only when the outfit leaves the face open.
 * The Knight is `hairless`, so its closed armet ships without hair or beard.
 */
export function canBeard(outfit: string, gender: string): boolean {
  return gender === 'Male' && !isHairless(outfit)
}

/** The gender a character name encodes (its middle segment). */
export function genderOf(character: string): string {
  return character.split('_')[1] ?? ''
}

/**
 * Normalise a beard flag against the character it belongs to. The server runs
 * this on every value a client sends, so a female or Knight can never carry one.
 */
export function isBearded(character: string, beard: unknown): boolean {
  return beard === true && canBeard(outfitOf(character), genderOf(character))
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
  Knight: [
    { name: 'Steel', swatch: '#9fa8ab', texture: null },
    { name: 'Gilded', swatch: '#a8801f', texture: 'T_Knight_2' },
    { name: 'Bluesteel', swatch: '#6b7a86', texture: 'T_Knight_3' },
  ],
  Noble: [
    { name: 'Crimson', swatch: '#7d2f36', texture: null },
    { name: 'Sapphire', swatch: '#2c4a72', texture: 'T_Noble_2' },
    { name: 'Verdant', swatch: '#3c6b39', texture: 'T_Noble_3' },
  ],
  Wizard: [
    { name: 'Midnight', swatch: '#243a63', texture: null },
    { name: 'Amethyst', swatch: '#5b2c6b', texture: 'T_Wizard_2' },
    { name: 'Ember', swatch: '#8d1f22', texture: 'T_Wizard_3' },
  ],
}

/* -------------------------------------------------------------------------- */
/* Names, roster, validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every character carries a hairstyle, including the outfits whose head piece
 * hides it: those GLBs hold the hood or armet and the hair as separate named
 * meshes, so the pick survives in the name and one model covers both states.
 */
/** Whether an outfit ships without hair variants (see `Outfit.hairless`). */
export function isHairless(outfit: string): boolean {
  return !!OUTFITS.find(o => o.id === outfit)?.hairless
}

export function characterName(outfit: string, gender: string, hairId?: string): string {
  if (isHairless(outfit)) return `${outfit}_${gender}`
  const hair = hairId ?? HAIRSTYLES[gender as Gender]?.[0]?.id
  return `${outfit}_${gender}_${hair}`
}

export const CHARACTER_NAMES: string[] = OUTFITS.flatMap(o =>
  GENDERS.flatMap(g => o.hairless ? [`${o.id}_${g}`] : HAIRSTYLES[g].map(h => `${o.id}_${g}_${h.id}`)),
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

/**
 * Hue is the identity; lightness is set by where these have to be legible. A
 * name is drawn on a frosted chat panel and on a nameplate over the bare world,
 * so the worst case is a sunlit wall behind it — at the authored lightnesses
 * red and indigo landed at 2.5:1 there. Each is lifted (never darkened, which
 * would lose the hue against a dark UI) to the first lightness that clears
 * 4:1 on that surface; gold already did.
 *
 * The identity cookie stores the resolved colour *string*, not an index, so
 * anyone already holding an old value keeps it until they next save a
 * character, at which point the accent is re-rolled. Nothing is live yet, so
 * that is cheaper than carrying a migration.
 */
export const PLAYER_COLORS: string[] = [
  'hsl(6, 85%, 76%)', // red
  'hsl(28, 90%, 63%)', // orange
  'hsl(45, 90%, 55%)', // gold
  'hsl(140, 55%, 52%)', // green
  'hsl(172, 68%, 46%)', // teal
  'hsl(205, 85%, 67%)', // blue
  'hsl(255, 68%, 79%)', // indigo
  'hsl(318, 70%, 75%)', // magenta
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
export function randomAppearance(): { gender: Gender, outfit: string, hairId: string, outfitColor: number, beard: boolean } {
  const gender = pick(GENDERS)
  const outfit = pick(OUTFITS).id
  return {
    gender,
    outfit,
    hairId: pick(HAIRSTYLES[gender]).id,
    outfitColor: Math.floor(Math.random() * outfitColorCount(outfit)),
    beard: canBeard(outfit, gender) && Math.random() < 0.5,
  }
}
