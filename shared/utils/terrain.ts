/**
 * The shared terrain height field.
 *
 * This used to be a decorative fractal inside `app/utils/courtyardLandscape.ts`
 * with no collision behind it. It lives here now because the chunked world bakes
 * it into real corner heights players stand on, and the ground the client draws
 * is that same heightmap (`app/utils/terrainChunk.ts`) — so the visible ground
 * and the feet that walk it can never drift apart.
 *
 * Units are tiles. Nothing here reads the world: it is a pure function of
 * position, the seed and the town constants, which is what makes
 * `generateChunk` deterministic on both sides.
 *
 * The regional noise lives here rather than in `biome.ts` on purpose. Height has
 * to rise where a mountain range is, and a *label* is the wrong thing to blend
 * on: thresholding first and interpolating after puts a cliff on every border.
 * So the continuous fields are the primitive, `worldTerrainHeight` reads them
 * directly, and `biome.ts` thresholds the very same numbers into names. The two
 * can disagree about where a border is by a tile; they cannot disagree about the
 * shape of the ground.
 */

import { COURTYARD, FORTIFICATIONS } from './courtyard'

/** Default generation seed: the relief, the biomes, the surface variation and the
 *  wild scatter all read it, so a world with another seed has its ranges
 *  somewhere else. It is declared here because the height field is the lowest
 *  layer that needs it, and `createWorld` defaults to it. */
export const WORLD_SEED = 20260915

/** The meadow's relief is laid out around the town square's centre. */
export const LANDSCAPE_CENTER = (COURTYARD.min + COURTYARD.max) / 2
/** Half-width of the flat approach before the foothills start climbing. */
export const LANDSCAPE_EXPANSION = (FORTIFICATIONS.exteriorMax - FORTIFICATIONS.exteriorMin) / 2 - 20

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/* -------------------------------------------------------------------------- */
/* Regional noise                                                             */
/* -------------------------------------------------------------------------- */

/** Lattice spacing of the biome field, in tiles: three chunks, so a region is
 *  several chunks across and you walk into it rather than across it. */
export const REGION_SIZE = 96

/** Chebyshev distance from the town centre inside which the land is exactly what
 *  it has always been: plain meadow, and not one corner of relief added. The
 *  flat approach is 68 tiles wide from the centre; this adds a chunk of margin
 *  so the silhouette from the gate road is unchanged. */
export const MEADOW_BELT = 96

/** A stable lattice-corner value in [0, 1). Its own hash rather than
 *  `world.ts`'s `hash3`: it mixes a salt so fields with different salts are
 *  independent, and a second avalanche round so neighbouring corners do not
 *  band. */
function corner(seed: number, salt: number, gx: number, gy: number): number {
  let h = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B)
  h = Math.imul(h ^ salt, 0x27D4EB2F)
  h = Math.imul(h ^ gx, 0xC2B2AE35)
  h = Math.imul(h ^ gy, 0x165667B1)
  h ^= h >>> 15
  h = Math.imul(h, 0x2545F491)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/**
 * Smooth value noise in [0, 1): bilinear between lattice corners, eased so the
 * field has no visible grid to it.
 *
 * Its steepest slope is `1.5 / cell` per tile, which is the number every
 * amplitude below is budgeted against — the ground has to stay walkable
 * (`SLOPE_MAX`, 1.2 per tile) nearly everywhere, and an amplitude chosen by eye
 * is how you get a mountain nobody can climb.
 */
export function valueNoise(seed: number, salt: number, x: number, y: number, cell: number): number {
  const fx = x / cell
  const fy = y / cell
  const gx = Math.floor(fx)
  const gy = Math.floor(fy)
  const tx = smoothstep(0, 1, fx - gx)
  const ty = smoothstep(0, 1, fy - gy)
  const c00 = corner(seed, salt, gx, gy)
  const c10 = corner(seed, salt, gx + 1, gy)
  const c01 = corner(seed, salt, gx, gy + 1)
  const c11 = corner(seed, salt, gx + 1, gy + 1)
  return (c00 + (c10 - c00) * tx) * (1 - ty) + (c01 + (c11 - c01) * tx) * ty
}

/** Value noise folded about its midpoint: `1` along a crease line and falling
 *  away either side, which is what makes a range read as a ridge with two flanks
 *  instead of a lumpy blob. It doubles the slope of the octave it folds. */
function ridgeNoise(seed: number, salt: number, x: number, y: number, cell: number): number {
  return 1 - Math.abs(2 * valueNoise(seed, salt, x, y, cell) - 1)
}

/** How far the field is stretched away from its mean before it is read. Summing
 *  interpolated octaves piles the raw value up around 0.5, which would make the
 *  outer shares (heath especially) vanishingly rare; this restores their spread
 *  and costs only flatter plateaus at the extremes. */
const CONTRAST = 2.6

/** One biome field: the slow lattice plus a half-scale octave, so region edges
 *  wander instead of reading as squares. Stays in [0, 1]. Salts pick out
 *  independent fields; `biome.ts` thresholds them and nothing else may. */
export function regionField(seed: number, salt: number, x: number, y: number): number {
  const raw = valueNoise(seed, salt, x, y, REGION_SIZE) * 0.68
    + valueNoise(seed, salt ^ 0x5BF03635, x, y, REGION_SIZE / 2) * 0.32
  return Math.min(1, Math.max(0, 0.5 + (raw - 0.5) * CONTRAST))
}

/* -------------------------------------------------------------------------- */
/* Mountains                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Lattices of the massif field, in tiles. Far coarser than a biome region:
 * a range has to run for several chunks, and the coarser the lattice the gentler
 * the flank it can rise on for a given height.
 */
const MASSIF_LATTICE = 768
const MASSIF_DETAIL_LATTICE = 384
/** Domain warp: the massif is sampled at an offset that itself wanders, so the
 *  ranges bend instead of radiating from lattice corners. Its own slope
 *  multiplies the field's, so the amplitude stays well under the lattice. */
const MASSIF_WARP = 64
const MASSIF_WARP_LATTICE = 320

/** Below this the massif field is flat country; above it, ground starts to
 *  lift. Everything between here and 1 is foothill, which is the only reason
 *  ranges have skirts instead of walls. */
const MASSIF_ONSET = 0.68

/** Chebyshev span over which the mountains are allowed to appear at all, past
 *  `MEADOW_BELT`. Wide on purpose: this ramp carries the full mountain
 *  amplitude, so a short one would be a cliff ringing the town. */
const MOUNTAIN_GUARD_SPAN = 224

/** Height of a range's core above the country it stands in. */
export const MOUNTAIN_HEIGHT = 56
/** Ridge detail, scaled by the uplift so it fades out with the range. */
const MOUNTAIN_RIDGE = 9
const MOUNTAIN_RIDGE_LATTICE = 80
/**
 * Crags: short-lattice creases weighted by the *square* of the uplift, so the
 * skirts stay smooth walkable foothills and only the high ground breaks up. This
 * is the one term steep enough to put faces past `SLOPE_MAX`, which is what
 * makes a range something you find a route up rather than a ramp. It cannot trap
 * anybody: a tile too steep to walk is refused at any height, jump included, so
 * a body can never get to the far side of one and be stuck.
 */
const MOUNTAIN_CRAG = 9
const MOUNTAIN_CRAG_LATTICE = 22

/** Extra roll on the open heath, and the lattice it rolls on. Small: the heath
 *  is meant to read as rougher grazing, not as a second mountain. */
const HEATH_ROLL = 3
const HEATH_ROLL_LATTICE = 72
/** Belt ramp for the heath's roll. Shorter than the mountains' because it
 *  carries a twentieth of the amplitude. */
const HEATH_GUARD_SPAN = 48

/** Chebyshev distance from the town centre, the measure the meadow belt uses. */
function townDistance(x: number, y: number): number {
  return Math.max(Math.abs(x - LANDSCAPE_CENTER), Math.abs(y - LANDSCAPE_CENTER))
}

/** The massif field in [0, 1]: two ridged octaves, domain-warped. */
function massifField(seed: number, x: number, y: number): number {
  const wx = x + (valueNoise(seed, 0x4A1, x, y, MASSIF_WARP_LATTICE) - 0.5) * MASSIF_WARP
  const wy = y + (valueNoise(seed, 0x4A2, x, y, MASSIF_WARP_LATTICE) - 0.5) * MASSIF_WARP
  return ridgeNoise(seed, 0x4B1, wx, wy, MASSIF_LATTICE) * 0.72
    + ridgeNoise(seed, 0x4B2, wx, wy, MASSIF_DETAIL_LATTICE) * 0.28
}

/**
 * How mountainous a point is, from 0 (flat country) to 1 (the core of a range).
 *
 * The single continuous quantity both the height field and the biome label read:
 * height multiplies by it, `biomeAt` calls a point a mountain once it passes
 * `MOUNTAIN_BIOME`. That ordering is deliberate — the foothills below the label
 * threshold belong to whatever biome surrounds them, so a pine wood climbs into
 * the range instead of stopping dead at its edge.
 */
export function mountainUplift(seed: number, x: number, y: number): number {
  const guard = smoothstep(MEADOW_BELT, MEADOW_BELT + MOUNTAIN_GUARD_SPAN, townDistance(x, y))
  if (guard <= 0) return 0
  return guard * clamp01((massifField(seed, x, y) - MASSIF_ONSET) / (1 - MASSIF_ONSET))
}

/**
 * How much of the heath's extra roll applies here. A wide, gentle blend on the
 * same two fields `biomeAt` thresholds: a narrow one would put a step in the
 * ground exactly where the label changes, which is the thing this module is
 * arranged to avoid. Held to the same belt as the mountains, because the belt
 * means the ground near town is untouched and not merely un-mountainous.
 */
function heathRoll(seed: number, x: number, y: number): number {
  const guard = smoothstep(MEADOW_BELT, MEADOW_BELT + HEATH_GUARD_SPAN, townDistance(x, y))
  if (guard <= 0) return 0
  const open = clamp01((regionField(seed, 0x1F1, x, y) - MEADOW_SHARE + 0.22) / 0.44)
  const stony = clamp01((regionField(seed, 0x2E2, x, y) - GROVE_SHARE + 0.22) / 0.44)
  return guard * open * stony
}

/** Biome-driven relief on top of the town's own landscape, in height units. */
function biomeRelief(seed: number, x: number, y: number): number {
  let h = 0
  const uplift = mountainUplift(seed, x, y)
  if (uplift > 0) {
    h += uplift * (MOUNTAIN_HEIGHT + MOUNTAIN_RIDGE * ridgeNoise(seed, 0x4C1, x, y, MOUNTAIN_RIDGE_LATTICE))
      + uplift * uplift * MOUNTAIN_CRAG * ridgeNoise(seed, 0x4C2, x, y, MOUNTAIN_CRAG_LATTICE)
  }
  const heath = heathRoll(seed, x, y)
  if (heath > 0) {
    h += heath * HEATH_ROLL * (valueNoise(seed, 0x4D1, x, y, HEATH_ROLL_LATTICE) - 0.5) * 2
  }
  return h
}

/* -------------------------------------------------------------------------- */
/* The height field                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Low meadow foothills opening onto asymmetric eroded ridges. Several scales of
 * relief keep silhouettes articulated while the town remains dominant.
 *
 * Flat (a constant -0.06) for roughly 75 tiles around the town centre, so the
 * whole authored square and its approach read as level ground.
 */
export function landscapeHeight(x: number, z: number, seed: number = WORLD_SEED): number {
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
  const base = -0.06 + ramp * (3 + (ridge + folds + erosion * erosion * 5) * summit + farRidge)
  return base + biomeRelief(seed, x, z)
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
export function worldTerrainHeight(x: number, y: number, seed: number = WORLD_SEED): number {
  return isFlatTownGround(x, y) ? 0 : landscapeHeight(x, y, seed)
}

/* -------------------------------------------------------------------------- */
/* Biome thresholds                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where the biome labels cut the fields above. They live here, next to the
 * fields, because the relief blends have to line up with them — `biome.ts`
 * re-exports the ones a caller has any business reading.
 */

/** Below this the region is plain meadow. Above it the second field picks one of
 *  the characterful biomes, in these cumulative shares. */
export const MEADOW_SHARE = 0.52
export const PINEWOOD_SHARE = 0.3
export const FOREST_SHARE = 0.58
export const GROVE_SHARE = 0.8

/** Uplift past which a point is called a mountain rather than the foothill of
 *  whatever surrounds it. */
export const MOUNTAIN_BIOME = 0.38
