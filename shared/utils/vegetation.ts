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
 */

import { NATURE_KINDS } from './building'
import type { WorldPlacement } from './props'
import { isFlatTownGround, worldTerrainHeight } from './terrain'
import { CHUNK_SIZE, chunkCoord } from './world'

/** Candidate points per chunk, before slope and town rejection. */
const CANDIDATES = 26
/** Nothing takes root on a cliff face. */
const MAX_SLOPE = 0.9
/** Chance a chunk has a copse at all. The rest is open meadow. */
const COPSE_CHANCE = 0.55
/** Copse radius, in tiles: a lower bound plus a per-chunk spread. */
const COPSE_RADIUS = 4
const COPSE_SPREAD = 5
/** Chance a candidate inside a copse is a tree, and outside it. Together with
 *  the copse odds this is about a third of the old blanket density, which is
 *  what turns woodland into meadow with stands of trees in it. */
const TREE_IN_COPSE = 0.78
const TREE_IN_OPEN = 0.05
/** Chance a candidate that did not become a tree becomes ground cover at all.
 *  The rest of the meadow is left open. */
const GROUND_COVER = 0.45
/** Of that ground cover, how much is undergrowth; the rest is rock. Both are
 *  spread evenly, copse or not. */
const BUSH_SHARE = 0.55

const TREES = ['tree1', 'tree2', 'tree3', 'tree4', 'tree5'] as const
const UNDERGROWTH = ['bush1', 'bush2'] as const
const ROCKS = ['rock1', 'rock2', 'rock3'] as const

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

/** Local slope from the shared height field, in units per tile. */
function slopeAt(x: number, y: number): number {
  const h = worldTerrainHeight(x, y)
  return Math.max(Math.abs(worldTerrainHeight(x + 1, y) - h), Math.abs(worldTerrainHeight(x, y + 1) - h))
}

/**
 * The nature kit standing on one generated chunk. Ids are `wild:<cx>:<cy>:<n>`
 * so removing a tree and regenerating the chunk cannot resurrect it under a new
 * name, and a persisted chunk can record which ones are gone.
 */
export function generateVegetation(seed: number, cx: number, cy: number): WorldPlacement[] {
  const out: WorldPlacement[] = []
  // One copse per chunk at most, at a hashed centre: trees cluster inside it and
  // are rare outside, so the meadow reads as stands of trees rather than an
  // evenly sprinkled forest.
  const hasCopse = hash(seed, cx, cy, 0x10D) < COPSE_CHANCE
  const copseX = (cx * CHUNK_SIZE) + hash(seed, cx, cy, 0x10E) * CHUNK_SIZE
  const copseY = (cy * CHUNK_SIZE) + hash(seed, cx, cy, 0x10F) * CHUNK_SIZE
  const copseR = COPSE_RADIUS + hash(seed, cx, cy, 0x110) * COPSE_SPREAD
  for (let n = 0; n < CANDIDATES; n++) {
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
    if (slopeAt(px, py) > MAX_SLOPE) continue
    const roll = hash(seed, cx, cy, n * 7 + 3)
    const inCopse = hasCopse && Math.hypot(px - copseX, py - copseY) <= copseR
    const pick = hash(seed, cx, cy, n * 7 + 4)
    let kind: string
    if (roll < (inCopse ? TREE_IN_COPSE : TREE_IN_OPEN)) {
      kind = TREES[Math.floor(pick * TREES.length)]!
    }
    else {
      if (pick >= GROUND_COVER) continue
      const family = pick / GROUND_COVER < BUSH_SHARE ? UNDERGROWTH : ROCKS
      kind = family[Math.floor(hash(seed, cx, cy, n * 7 + 7) * family.length)]!
    }
    out.push({
      id: `wild:${cx}:${cy}:${n}`,
      kind,
      x: px,
      y: py,
      // A wild piece's `z` is gameplay elevation: it stands on the hill and
      // collides at the hill's height, instead of sinking into it.
      z: Math.round(worldTerrainHeight(px, py) * 100) / 100,
      rot: Math.round(hash(seed, cx, cy, n * 7 + 5) * Math.PI * 2 * 100) / 100,
      scale: Math.round((0.8 + hash(seed, cx, cy, n * 7 + 6) * 0.5) * 100) / 100,
    })
  }
  return out
}

/** Whether a piece came from generation rather than a player or the town. */
export function isWildPlacement(placement: { id: string, kind: string, owner?: string }): boolean {
  return !placement.owner && placement.id.startsWith('wild:') && NATURE_KINDS.has(placement.kind)
}
