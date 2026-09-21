/**
 * What grows on a generated chunk.
 *
 * Pure and deterministic: the same seed and chunk coordinates always produce
 * the same trees, in the same places, with the same ids — so a chunk that is
 * regenerated after an instance recycles is the chunk players remember, and a
 * test can assert on it without a fixture.
 *
 * It is kept out of `generateChunk` on purpose. Terrain is the same on both
 * sides by construction; vegetation is *state* (players fell trees), so it is
 * seeded once by whoever owns the chunk — the server — and reaches clients as
 * placements inside a `chunk` frame like any other piece.
 *
 * The scatter is regional: every candidate point asks `biomeAt` what country it
 * stands in and grows what belongs there, so a pinewood's edge runs through a
 * chunk rather than around it. Meadow is the majority and the only thing near
 * the town, and its flavour is the one this file has always had — a meadow chunk
 * with no border in it generates exactly what it used to.
 */

import type { Biome } from './biome'
import { biomeAt } from './biome'
import { NATURE_KINDS } from './building'
import type { WorldPlacement } from './props'
import { isFlatTownGround, worldTerrainHeight } from './terrain'
import { CHUNK_SIZE, chunkCoord } from './world'

/** Candidate points per chunk, before slope, town and biome rejection. Every
 *  biome draws from these. */
const CANDIDATES = 26
/** Extra candidates appended for the biomes that need to be denser than a
 *  meadow. They come *after* the original 26 so candidate `n` keeps its
 *  position and its `wild:<cx>:<cy>:<n>` id, and the biomes that do not want
 *  them (`infill: false`) simply drop them. Their hash indices stay clear of
 *  the per-chunk copse salts below, so keep the total at or under 38. */
const INFILL = 12
/** Nothing takes root on a cliff face. */
const MAX_SLOPE = 0.9
/**
 * Terrain height the last tree gives up at, and the height above which nothing
 * grows at all. Altitude, not biome: a meadow that climbs a mountain's skirt
 * runs out of trees at the same height a pine wood does, and a candidate above
 * the treeline falls through to ground cover — which up here is almost all
 * boulders. Both sit under `SNOW_LINE` and `ROCK_LINE` in `world.ts` on purpose:
 * the trees stop before the turf does. Neither can change what an old chunk
 * grew: nothing reached these heights before the mountains did.
 */
export const TREELINE = 38
export const BARREN_LINE = 54

/** The common broadleaves of the meadow. */
const TREES = ['tree1', 'tree2', 'tree3', 'tree4', 'tree5'] as const
/** Conifers: the pinewood's canopy. */
const PINES = ['pine1', 'pine2', 'pine3'] as const
/** Autumn-red crooked trees: the grove's stands. */
const TWISTED = ['twisted1', 'twisted2', 'twisted3'] as const
/** Bare trunks: what is left standing on the heath. */
const DEAD = ['dead1', 'dead2', 'dead3'] as const
const UNDERGROWTH = ['bush1', 'bush2'] as const
const ROCKS = ['rock1', 'rock2', 'rock3'] as const

/** The tree families each biome is made of, exported so a renderer or a test
 *  can ask what should dominate where without restating the lists. */
export const BIOME_TREES: Record<Biome, readonly string[]> = {
  meadow: TREES,
  forest: TREES,
  pinewood: PINES,
  grove: TWISTED,
  heath: DEAD,
  mountain: PINES,
}

/** Every tree family the scatter can plant, for `isWildTree`. */
const ALL_TREES: ReadonlySet<string> = new Set([...TREES, ...PINES, ...TWISTED, ...DEAD])

/** Whether a kind is one of the generated tree families, whatever its biome. */
export function isWildTree(kind: string): boolean {
  return ALL_TREES.has(kind)
}

/**
 * How one biome scatters. The numbers are chances per candidate, so density is
 * `candidates × chance`: that is why a denser biome takes the infill candidates
 * instead of a bigger tree chance, which would only thicken the same points.
 */
interface Flavour {
  /** The dominant tree family. */
  trees: readonly string[]
  /** A minority family standing among them, and its share of the trees. Meadow
   *  has none, which is what keeps its output byte-identical to the old one. */
  mix?: readonly string[]
  mixShare: number
  /** Chance the chunk has a copse at all, its minimum radius and its spread.
   *  A chance of 0 means the biome is evenly wooded and reads `treeInOpen`
   *  everywhere. */
  copseChance: number
  copseRadius: number
  copseSpread: number
  /** Chance a candidate inside a copse is a tree, and outside it. */
  treeInCopse: number
  treeInOpen: number
  /** Chance a candidate that did not become a tree becomes ground cover at all.
   *  The rest is left open. */
  cover: number
  /** Of that ground cover, how much is undergrowth; the rest is rock. */
  bushShare: number
  /** Whether the biome uses the infill candidates. */
  infill: boolean
  /** Scale range of a piece: a lower bound plus a spread. */
  scale: number
  scaleSpread: number
}

const FLAVOURS: Record<Biome, Flavour> = {
  // Open meadow with stands of trees in it: the original scatter, unchanged.
  // About a third of a blanket density, which is what keeps it a meadow.
  meadow: {
    trees: TREES,
    mixShare: 0,
    copseChance: 0.55,
    copseRadius: 4,
    copseSpread: 5,
    treeInCopse: 0.78,
    treeInOpen: 0.05,
    cover: 0.45,
    bushShare: 0.55,
    infill: false,
    scale: 0.8,
    scaleSpread: 0.5,
  },
  // Closed broadleaf woodland: the meadow's own trees, but wall to wall. Denser
  // than the pinewood (it plants nearly every candidate it is given, infill
  // included) and thick with undergrowth, so it reads as woods you push through
  // rather than the conifer stands next door.
  forest: {
    trees: TREES,
    mix: TWISTED,
    mixShare: 0.08,
    copseChance: 0,
    copseRadius: 0,
    copseSpread: 0,
    treeInCopse: 0,
    treeInOpen: 0.84,
    cover: 0.6,
    bushShare: 0.82,
    infill: true,
    scale: 0.9,
    scaleSpread: 0.6,
  },
  // Closed pine wood: evenly dense rather than clustered, denser than a meadow
  // copse because it takes the infill candidates too, and nearly bare beneath.
  pinewood: {
    trees: PINES,
    mix: TREES,
    mixShare: 0.12,
    copseChance: 0,
    copseRadius: 0,
    copseSpread: 0,
    treeInCopse: 0,
    treeInOpen: 0.62,
    cover: 0.18,
    bushShare: 0.12,
    infill: true,
    scale: 0.85,
    scaleSpread: 0.55,
  },
  // Loose stands of crooked autumn trees over thick undergrowth. Always has its
  // stand, and a wider one than the meadow's.
  grove: {
    trees: TWISTED,
    mix: TREES,
    mixShare: 0.1,
    copseChance: 1,
    copseRadius: 6,
    copseSpread: 7,
    treeInCopse: 0.72,
    treeInOpen: 0.1,
    cover: 0.5,
    bushShare: 0.78,
    infill: true,
    scale: 0.8,
    scaleSpread: 0.5,
  },
  // Stony open heath: a few dead trunks, a lot of rock, next to no bush.
  heath: {
    trees: DEAD,
    mix: TWISTED,
    mixShare: 0.15,
    copseChance: 0,
    copseRadius: 0,
    copseSpread: 0,
    treeInCopse: 0,
    treeInOpen: 0.11,
    cover: 0.5,
    bushShare: 0.05,
    infill: false,
    scale: 0.75,
    scaleSpread: 0.45,
  },
  // A range: pines and boulders on the lower slopes, thinning as the ground
  // steepens (`MAX_SLOPE` throws candidates out on its own), no tree above the
  // treeline and nothing at all on the bare tops. Stunted, so the scale is low.
  mountain: {
    trees: PINES,
    mix: DEAD,
    mixShare: 0.18,
    copseChance: 0,
    copseRadius: 0,
    copseSpread: 0,
    treeInCopse: 0,
    treeInOpen: 0.42,
    cover: 0.72,
    bushShare: 0.06,
    infill: true,
    scale: 0.7,
    scaleSpread: 0.4,
  },
}

/** A four-input stable hash, so a chunk's scatter is a pure function of
 *  `(seed, cx, cy, n)`. Not `world.ts`'s `hash3`: this mixes in a third
 *  coordinate and one more avalanche round, which changes the output, so it
 *  stays its own sequence rather than being folded into the shared one. */
function hash(seed: number, a: number, b: number, c: number): number {
  let h = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B)
  h = Math.imul(h ^ a, 0xC2B2AE35)
  h = Math.imul(h ^ b, 0x27D4EB2F)
  h = Math.imul(h ^ c, 0x165667B1)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Local slope from the shared height field, in units per tile. The seed goes in
 *  because the field is biome-aware: a mountain's flank only exists for the seed
 *  that raised it. */
function slopeAt(seed: number, x: number, y: number): number {
  const h = worldTerrainHeight(x, y, seed)
  return Math.max(
    Math.abs(worldTerrainHeight(x + 1, y, seed) - h),
    Math.abs(worldTerrainHeight(x, y + 1, seed) - h),
  )
}

/**
 * The nature kit standing on one generated chunk. Ids are `wild:<cx>:<cy>:<n>`
 * so removing a tree and regenerating the chunk cannot resurrect it under a new
 * name, and a persisted chunk can record which ones are gone.
 */
export function generateVegetation(seed: number, cx: number, cy: number): WorldPlacement[] {
  const out: WorldPlacement[] = []
  // One copse per chunk at most, at a hashed centre: trees cluster inside it and
  // are rare outside, so a clustering biome reads as stands of trees rather than
  // an evenly sprinkled forest. The centre is shared by every biome the chunk
  // touches; each reads its own odds and radius off it.
  const copse = hash(seed, cx, cy, 0x10D)
  const copseX = (cx * CHUNK_SIZE) + hash(seed, cx, cy, 0x10E) * CHUNK_SIZE
  const copseY = (cy * CHUNK_SIZE) + hash(seed, cx, cy, 0x10F) * CHUNK_SIZE
  const copseSpread = hash(seed, cx, cy, 0x110)
  for (let n = 0; n < CANDIDATES + INFILL; n++) {
    const x = (cx * CHUNK_SIZE) + hash(seed, cx, cy, n * 7 + 1) * CHUNK_SIZE
    const y = (cy * CHUNK_SIZE) + hash(seed, cx, cy, n * 7 + 2) * CHUNK_SIZE
    // A placement belongs to the chunk holding its centre; rounding must not
    // push it over the border into a neighbour that will never see it.
    const px = Math.round(x * 100) / 100
    const py = Math.round(y * 100) / 100
    if (chunkCoord(px) !== cx || chunkCoord(py) !== cy) continue
    // Nothing grows on the town's level approach. That is the flat square, not
    // the protected footprint: the meadow right outside the walls is editable
    // now, but it stays the open ground it has always been.
    if (isFlatTownGround(px, py)) continue
    if (slopeAt(seed, px, py) > MAX_SLOPE) continue
    const height = worldTerrainHeight(px, py, seed)
    // The biome is sampled at the point, not at the chunk, so a border cuts
    // across a chunk and a tree never changes species on a chunk line.
    const flavour = FLAVOURS[biomeAt(seed, px, py)]
    if (n >= CANDIDATES && !flavour.infill) continue
    // The bare tops carry nothing at all, and above the treeline a candidate
    // that would have been a tree falls through to ground cover. It keeps its
    // number and its id either way, so a chunk's ids never shift.
    if (height > BARREN_LINE) continue
    const aboveTreeline = height > TREELINE
    const roll = hash(seed, cx, cy, n * 7 + 3)
    const inCopse = copse < flavour.copseChance
      && Math.hypot(px - copseX, py - copseY) <= flavour.copseRadius + copseSpread * flavour.copseSpread
    const pick = hash(seed, cx, cy, n * 7 + 4)
    let kind: string
    if (!aboveTreeline && roll < (inCopse ? flavour.treeInCopse : flavour.treeInOpen)) {
      const family = flavour.mix && hash(seed, cx, cy, 0x2000 + n) < flavour.mixShare ? flavour.mix : flavour.trees
      kind = family[Math.floor(pick * family.length)]!
    }
    else {
      if (pick >= flavour.cover) continue
      const family = pick / flavour.cover < flavour.bushShare ? UNDERGROWTH : ROCKS
      kind = family[Math.floor(hash(seed, cx, cy, n * 7 + 7) * family.length)]!
    }
    out.push({
      id: `wild:${cx}:${cy}:${n}`,
      kind,
      x: px,
      y: py,
      // A wild piece's `z` is gameplay elevation: it stands on the hill and
      // collides at the hill's height, instead of sinking into it.
      z: Math.round(height * 100) / 100,
      rot: Math.round(hash(seed, cx, cy, n * 7 + 5) * Math.PI * 2 * 100) / 100,
      scale: Math.round((flavour.scale + hash(seed, cx, cy, n * 7 + 6) * flavour.scaleSpread) * 100) / 100,
    })
  }
  return out
}

/** Whether a piece came from generation rather than a player or the town. */
export function isWildPlacement(placement: { id: string, kind: string, owner?: string }): boolean {
  return !placement.owner && placement.id.startsWith('wild:') && NATURE_KINDS.has(placement.kind)
}
