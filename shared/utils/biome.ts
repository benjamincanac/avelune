/**
 * Where one kind of country ends and the next begins.
 *
 * A biome is a pure function of the world seed and a world tile position, like
 * the height field: no chunk grid, no world state, no server. That is what lets
 * `generateVegetation` sample it per candidate point — so a border runs through
 * a chunk instead of around it — and what lets the client call the same function
 * for cosmetics (ground scatter, ambient critters) without asking the server
 * anything. The seed it needs is `welcome.world.seed`, the same number the
 * server hands `generateVegetation`.
 *
 * This module is only the *labels*. The continuous fields underneath live in
 * `terrain.ts`, because the ground has to rise where a range is and a label is
 * the wrong thing to interpolate: threshold first and you get a cliff on every
 * border. So `biomeAt` reads exactly the numbers `worldTerrainHeight` reads.
 *
 * Regions are a few chunks across; a mountain range is far larger than that, and
 * decides its own label from the uplift rather than from the region fields.
 * Meadow wins the largest share of the world and always wins near the town, so
 * the approach to the walls stays the open ground it has always been.
 */

import {
  FOREST_SHARE,
  GROVE_SHARE,
  LANDSCAPE_CENTER,
  MEADOW_BELT,
  MEADOW_SHARE,
  MOUNTAIN_BIOME,
  PINEWOOD_SHARE,
  mountainUplift,
  regionField,
} from './terrain'

export type Biome = 'meadow' | 'forest' | 'pinewood' | 'grove' | 'heath' | 'mountain'

/**
 * The country at a world tile. Cheap enough to call once per vegetation
 * candidate, per cosmetic scatter point, or per critter spawn.
 */
export function biomeAt(seed: number, x: number, y: number): Biome {
  // The town keeps its meadow belt whatever the noise says, so the approach to
  // the walls looks the way players already know it. `mountainUplift` holds to
  // the same belt, so the ground in here is untouched too.
  if (Math.max(Math.abs(x - LANDSCAPE_CENTER), Math.abs(y - LANDSCAPE_CENTER)) <= MEADOW_BELT) return 'meadow'
  // A range outranks the region fields: the ground is already 20 or 40 units up
  // here, so what grows on it is decided by the mountain, not by the country it
  // happens to be crossing. Below the threshold the foothills keep their
  // neighbour's label, which is what lets a wood climb into a range.
  if (mountainUplift(seed, x, y) >= MOUNTAIN_BIOME) return 'mountain'
  if (regionField(seed, 0x1F1, x, y) < MEADOW_SHARE) return 'meadow'
  const pick = regionField(seed, 0x2E2, x, y)
  if (pick < PINEWOOD_SHARE) return 'pinewood'
  if (pick < FOREST_SHARE) return 'forest'
  if (pick < GROVE_SHARE) return 'grove'
  return 'heath'
}
