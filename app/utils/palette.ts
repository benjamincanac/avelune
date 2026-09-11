/**
 * The Vercel Stadium brand palette — the Rimuru slime blues that replace the old
 * emerald green (`#00dc82`). One source of truth for the accent color across
 * the 2D UI (via the Nuxt UI `primary` ramp in main.css), the 3D scene (the
 * arena's rune circle, minimap markers), and generated art (logo, OG image).
 */
export const PALETTE = {
  /** Primary accent — the slime blue. */
  slime: '#93B9E8',
  /** Deep steel blue — dark accents, gradient depth, markers. */
  deep: '#3A71A4',
  /** Light blue — glow halos, highlights. */
  light: '#CCE9F6',
  /** Near-white — surfaces / text highlights on the dark theme. */
  pale: '#F7FCFC',
} as const

/** `0x` number forms for three.js material/light colors. */
export const PALETTE_HEX = {
  slime: 0x93B9E8,
  deep: 0x3A71A4,
  light: 0xCCE9F6,
  pale: 0xF7FCFC,
} as const
