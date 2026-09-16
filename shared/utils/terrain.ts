/**
 * The shared terrain height field.
 *
 * This used to be a decorative fractal inside `app/utils/courtyardLandscape.ts`
 * with no collision behind it. It lives here now because the chunked world
 * bakes it into real corner heights players stand on, and the landscape mesh
 * still draws from the *same* function — so the visible ground and the feet
 * that walk it can never drift apart.
 *
 * Units are tiles. Nothing here reads the world: it is a pure function of
 * position plus the town constants, which is what makes `generateChunk`
 * deterministic on both sides.
 */

import { COURTYARD, FORTIFICATIONS } from './courtyard'

/** The meadow's relief is laid out around the town square's centre. */
export const LANDSCAPE_CENTER = (COURTYARD.min + COURTYARD.max) / 2
/** Half-width of the flat approach before the foothills start climbing. */
export const LANDSCAPE_EXPANSION = (FORTIFICATIONS.exteriorMax - FORTIFICATIONS.exteriorMin) / 2 - 20

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Low meadow foothills opening onto asymmetric eroded ridges. Several scales of
 * relief keep silhouettes articulated while the town remains dominant.
 *
 * Flat (a constant -0.06) for roughly 75 tiles around the town centre, so the
 * whole authored square and its approach read as level ground.
 */
export function landscapeHeight(x: number, z: number): number {
  const dx = x - LANDSCAPE_CENTER
  const dz = z - LANDSCAPE_CENTER
  const distance = Math.max(0, Math.max(Math.abs(dx), Math.abs(dz)) - LANDSCAPE_EXPANSION)
  const ramp = smoothstep(27, 66, distance)
  const angle = Math.atan2(dz, dx)
  const ridge = 10 + 5 * Math.sin(angle * 3 + 0.6) + 4 * Math.sin(angle * 7 - 1.3)
  const folds = Math.sin(dx * 0.071 + Math.sin(dz * 0.039) * 2.1) * 4
    + Math.sin(dz * 0.095 - dx * 0.027) * 3
  const erosion = 1 - Math.abs(Math.sin(dx * 0.088 + dz * 0.052 + Math.sin(dz * 0.08)))
  const summit = Math.exp(-(((distance - 108) / 47) ** 2))
  const farRidge = smoothstep(107, 155, distance) * (1 - smoothstep(185, 220, distance))
    * (9 + 7 * Math.pow(0.5 + 0.5 * Math.sin(angle * 9 + 0.4), 2))
  return -0.06 + ramp * (3 + (ridge + folds + erosion * erosion * 5) * summit + farRidge)
}

/**
 * The authored square — everything inside the fortification exterior, moat and
 * bridge included — is dead level at 0, exactly as the flat `FloorPlan` was.
 * The moat bed and the fountain basin are height-aware *surfaces* layered on
 * top of it by `maze.ts`, not terrain.
 *
 * Bounds are inclusive so the boundary corner reads 0 from both sides, and
 * `landscapeHeight` is already -0.06 there, so the seam is invisible.
 */
export function isFlatTownGround(x: number, y: number): boolean {
  const f = FORTIFICATIONS
  return x >= f.exteriorMin && x <= f.exteriorMax && y >= f.exteriorMin && y <= f.exteriorMax
}

/** Terrain height at a world position, before any prop or water surface. */
export function worldTerrainHeight(x: number, y: number): number {
  return isFlatTownGround(x, y) ? 0 : landscapeHeight(x, y)
}
