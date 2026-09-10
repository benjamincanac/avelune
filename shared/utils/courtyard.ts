/** Dimensions at scale 1, shared by the art templates and collision. */
export const COURTYARD_ASSETS = {
  Courtyard_Inn: { width: 8, depth: 5, height: 5.2 },
  Courtyard_Shop: { width: 6, depth: 4, height: 3.8 },
  Courtyard_Tower: { width: 4, depth: 4, height: 9 },
  Courtyard_Wall: { width: 4, depth: 0.8, height: 2.6 },
  Courtyard_Planter: { width: 3, depth: 1.4, height: 0.55 },
  Courtyard_Bench: { width: 2.4, depth: 0.8, height: 0.65 },
  Courtyard_Stall: { width: 3.2, depth: 1.8, height: 1.1 },
  Courtyard_Fountain: { radius: 1.9, height: 2.7 },
  Courtyard_Tree: { radius: 0.38, height: 6.5 },
  Courtyard_Lantern: { radius: 0.16, height: 3.5 },
} as const

export type CourtyardKind = keyof typeof COURTYARD_ASSETS
export const COURTYARD_NAMES = Object.keys(COURTYARD_ASSETS) as CourtyardKind[]

/** The plaza is framed by buildings, with gardens and paths inside its walls. */
export const COURTYARD = {
  min: 8,
  max: 48,
  arena: { x: 28, y: 30, radius: 7 },
  fountain: { x: 28, y: 19 },
}
