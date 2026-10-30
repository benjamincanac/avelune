/**
 * What each quality setting costs the renderer, as plain tables.
 *
 * Separate from `useGraphics` because these are facts about the scene, not
 * state: the composable owns what the player picked, this owns what a pick
 * means. It also keeps them importable without Vue, which is how
 * `scripts/graphics-test.ts` holds the detail levels against the meadow's own
 * fade distances.
 */

export type GraphicsPreset = 'low' | 'medium' | 'high'
/** How much of the world is drawn in detail: the meadow, the vegetation ring,
 *  the rain, and how far and how finely the sun casts. */
export type GraphicsDetail = 'low' | 'medium' | 'high'

/** Everything the canvas and the scene read. Derived, never stored. */
export interface GraphicsProfile {
  /** Device pixels per CSS pixel. The single biggest cost on an old GPU. */
  pixelRatio: number
  /** Ground-truth ambient occlusion. Expensive: a whole extra scene pass. */
  occlusion: boolean
  bloom: boolean
  shadows: boolean
  shadowMapSize: number
  /** How far the sun's cascades reach, in world units. */
  shadowDistance: number
  /** Chunks around the player that draw their props and grass, and the ring
   *  they drop it again at. */
  detailRadius: number
  detailDrop: number
  /** Share of the meadow's tufts kept, and a multiplier on every distance it
   *  thins and fades over. */
  grassDensity: number
  grassRange: number
  /** Share of the rain's streaks drawn. */
  rain: number
}

/** What the scene draws at each detail level. `grassRange` has to keep the
 *  meadow's fade inside `detailRadius` chunks; `scripts/graphics-test.ts` holds
 *  that. */
export const GRAPHICS_DETAIL: Record<GraphicsDetail, Omit<GraphicsProfile, 'pixelRatio' | 'occlusion' | 'bloom' | 'shadows'>> = {
  low: { shadowMapSize: 1024, shadowDistance: 70, detailRadius: 1, detailDrop: 2, grassDensity: 0.3, grassRange: 0.5, rain: 0.35 },
  medium: { shadowMapSize: 1024, shadowDistance: 100, detailRadius: 2, detailDrop: 3, grassDensity: 0.65, grassRange: 0.8, rain: 0.7 },
  high: { shadowMapSize: 2048, shadowDistance: 120, detailRadius: 2, detailDrop: 3, grassDensity: 1, grassRange: 1, rain: 1 },
}

/** The controls the Escape menu shows, and all that is ever stored. */
export interface GraphicsSettings {
  /** Fraction of the display's own pixel ratio to render at. */
  scale: number
  detail: GraphicsDetail
  shadows: boolean
  occlusion: boolean
  bloom: boolean
}

/** A preset is a set of those controls, nothing more: picking one writes them
 *  all, and touching one afterwards is simply a different set. */
export const GRAPHICS_PRESETS: Record<GraphicsPreset, GraphicsSettings> = {
  low: { scale: 0.6, detail: 'low', shadows: false, occlusion: false, bloom: false },
  medium: { scale: 0.85, detail: 'medium', shadows: true, occlusion: false, bloom: true },
  high: { scale: 1, detail: 'high', shadows: true, occlusion: true, bloom: true },
}
