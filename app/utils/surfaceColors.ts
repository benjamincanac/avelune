/**
 * Every surface-to-colour mapping in one place, so the two renderers that read
 * a `SURFACE` value keep their palettes next to each other instead of drifting
 * apart in separate files: `terrainChunk.ts`'s per-vertex tint (blended into
 * the meadow's own procedural pigment) and `mapDraw.ts`'s flat minimap/world
 * map swatches. The two are tuned for different jobs, lit 3D shading versus a
 * legible top-down icon, so this only co-locates them rather than deriving one
 * from the other.
 */

/** Flat ground colour for the minimap/world map, one per `SURFACE` value:
 *  grass, dirt, stone, sand, path, water, snow. Snow is not white here: on a
 *  parchment-pale map a white swatch is the background, so the summits read as
 *  a cold blue-grey against the rock's warm one. */
export const SURFACE_COLORS = ['#779661', '#8a7b5c', '#8d8d84', '#c9b98b', '#b0a787', '#369b98', '#d5dde6']

/** The 3D terrain's tint targets, blended into the procedural ground colour by
 *  `terrainChunk.ts`'s `surfaceTint`. Grass has no entry: it is the untinted
 *  base colour, not a tint. */
export const TERRAIN_TINTS = {
  soil: '#8a6e4c',
  rock: '#9b9483',
  sand: '#cfbd92',
  /** Not paving: `path` tiles carry real flagstones on top, so the ground under
   *  them only has to read as the mortar showing through the joints. */
  mortar: '#6b6559',
  wet: '#46695f',
  /** Snowfields. Deliberately not white: the terrain material is lit and then
   *  passed through bloom, so an albedo near 1 clips to a flat glowing sheet at
   *  noon and loses every contour the range has. A cool off-white keeps the
   *  shading readable in daylight and still reads as snow under the moon, where
   *  the blue cast is what separates it from bare rock. */
  snow: '#d2dae1',
} as const
