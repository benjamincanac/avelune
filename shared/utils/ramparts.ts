/**
 * Raised rampart passages: the patrol gallery, its access stairs, its rails.
 *
 * All three are ordinary authored placements in `courtyard-structure.json`
 * (`Courtyard_Gallery` / `Courtyard_Stairs` / `Courtyard_Rail`), so the world
 * editor can move them like any other prop and physics follows the data. They
 * are the only kinds whose placement `z` is gameplay elevation rather than
 * render-only:
 *
 * - a gallery deck is walkable at `z`, with a `height`-thick slab hanging below
 *   it and no side collision, so the ground passages underneath stay open. Feet
 *   are supported only once they reach `z - STEP_MAX`;
 * - a stairs piece is a solid stepped ramp rising along its local +depth axis,
 *   from `z` at local `-depth/2` to `z + height` at local `+depth/2`, and
 *   carries a side rail along each long edge;
 * - a rail blocks the band `[z, z + height]` and nothing else.
 *
 * `generateHub` pre-filters them into `plan.ramparts` so the 20 Hz step never
 * rescans every prop. All geometry works in the piece's rotated frame,
 * inverting the Three.js Y rotation exactly like boxed prop collision in
 * `maze.ts`: `localX = dx*cos - dy*sin`, `localY = dx*sin + dy*cos`.
 *
 * Movement constants arrive as parameters (`radius`, `stepMax`) rather than
 * imports, so this module stays free of a runtime cycle with `maze.ts` — the
 * same arrangement `moat.ts` uses.
 */

import type { FloorPlan, PropSpec } from './maze'
import { COURTYARD_ASSETS } from './courtyard'

/** Kinds whose `z` is a gameplay surface, and whose collision is height-aware
 *  instead of the ground-based footprint every other solid kind uses. */
export const RAMPART_KINDS = ['Courtyard_Gallery', 'Courtyard_Stairs', 'Courtyard_Rail'] as const
export type RampartKind = typeof RAMPART_KINDS[number]
const RAMPART_KIND_SET: ReadonlySet<string> = new Set(RAMPART_KINDS)

export function isRampartKind(kind: string): kind is RampartKind {
  return RAMPART_KIND_SET.has(kind)
}

/** A placement resolved into world-space collision terms, once, at plan build. */
export interface RampartPiece {
  x: number
  y: number
  /** Deck surface, stair base, or rail bottom. */
  z: number
  /** Rotated footprint half-extents along the piece's local axes. */
  hx: number
  hy: number
  cos: number
  sin: number
  /** Slab thickness, stair rise, or rail height, after per-axis scale. */
  height: number
  /** Stairs only: tread count, plus the side rails running up both long edges. */
  steps: number
  railHeight: number
  railThickness: number
}

export interface RampartIndex {
  galleries: RampartPiece[]
  stairs: RampartPiece[]
  rails: RampartPiece[]
}

function toPiece(prop: PropSpec, height: number, steps = 0): RampartPiece {
  const [sx, sy] = prop.s3 ?? [prop.scale, prop.scale, prop.scale]
  const rail = COURTYARD_ASSETS.Courtyard_Rail
  return {
    x: prop.x,
    y: prop.y,
    z: prop.z ?? 0,
    // `makeProp` already scaled the footprint half-extents for this placement.
    hx: prop.bx ?? prop.r,
    hy: prop.by ?? prop.r,
    cos: Math.cos(prop.rot),
    sin: Math.sin(prop.rot),
    height: height * sy,
    steps,
    railHeight: rail.height * sy,
    railThickness: rail.depth * sx,
  }
}

/** Pre-filter the rampart placements out of a plan's props. Cheap enough to
 *  re-run whenever props are edited; `generateHub` calls it once. */
export function rampartIndex(props: PropSpec[]): RampartIndex {
  const index: RampartIndex = { galleries: [], stairs: [], rails: [] }
  for (const prop of props) {
    if (prop.kind === 'Courtyard_Gallery') index.galleries.push(toPiece(prop, COURTYARD_ASSETS.Courtyard_Gallery.height))
    else if (prop.kind === 'Courtyard_Stairs') index.stairs.push(toPiece(prop, COURTYARD_ASSETS.Courtyard_Stairs.height, COURTYARD_ASSETS.Courtyard_Stairs.steps))
    else if (prop.kind === 'Courtyard_Rail') index.rails.push(toPiece(prop, COURTYARD_ASSETS.Courtyard_Rail.height))
  }
  return index
}

/** Rotated-footprint containment, inflated by `pad` on both local axes. */
function inside(p: RampartPiece, x: number, y: number, padX = 0, padY = padX) {
  const dx = x - p.x
  const dy = y - p.y
  return Math.abs(dx * p.cos - dy * p.sin) <= p.hx + padX
    && Math.abs(dx * p.sin + dy * p.cos) <= p.hy + padY
}

/** Distance along the piece's local +depth axis, from its centre. */
function localDepth(p: RampartPiece, x: number, y: number) {
  return (x - p.x) * p.sin + (y - p.y) * p.cos
}

/** Distance along the piece's local width axis, from its centre. */
function localWidth(p: RampartPiece, x: number, y: number) {
  return (x - p.x) * p.cos - (y - p.y) * p.sin
}

/**
 * Deck height of the gallery supporting `feet` at this point, or null. A deck
 * only supports feet that have reached it — below that the body passes
 * underneath, which is what keeps the ground gate passages open.
 */
export function galleryDeckHeight(index: RampartIndex, x: number, y: number, feet: number, stepMax: number): number | null {
  let deck: number | null = null
  for (const g of index.galleries) {
    if (feet < g.z - stepMax || (deck !== null && g.z <= deck)) continue
    if (inside(g, x, y)) deck = g.z
  }
  return deck
}

/** Tread height of the stair flight under this point, or null. */
export function rampartStairHeight(index: RampartIndex, x: number, y: number): number | null {
  for (const s of index.stairs) {
    if (!inside(s, x, y)) continue
    const progress = (localDepth(s, x, y) + s.hy) / (2 * s.hy)
    return s.z + Math.ceil(progress * s.steps) * s.height / s.steps
  }
  return null
}

/** Rails and stair balustrades block a body only while its feet are in the
 *  segment's own height band, so you can jump over them. */
export function hitsRampartRail(index: RampartIndex, x: number, y: number, feet: number, radius: number, stepMax: number): boolean {
  for (const r of index.rails) {
    if (feet < r.z - stepMax || feet >= r.z + r.height) continue
    const dx = x - r.x
    const dy = y - r.y
    if (Math.abs(dx * r.cos - dy * r.sin) < r.hx + radius
      && Math.abs(dx * r.sin + dy * r.cos) < r.hy + radius) return true
  }
  for (const s of index.stairs) {
    const depth = localDepth(s, x, y)
    if (Math.abs(depth) > s.hy) continue
    // Side rails follow the continuous slope, not the discrete treads.
    const top = s.z + (depth + s.hy) / (2 * s.hy) * s.height
    if (feet < top - stepMax || feet >= top + s.railHeight) continue
    if (Math.abs(Math.abs(localWidth(s, x, y)) - s.hx) < radius + s.railThickness / 2) return true
  }
  return false
}

/** Whether movement from here needs the finer substepping: narrow treads and
 *  thin parapets must not be skipped over by a dash-sized displacement. */
export function nearRamparts(index: RampartIndex, x: number, y: number, reach: number): boolean {
  for (const g of index.galleries) {
    if (inside(g, x, y)) return true
  }
  for (const s of index.stairs) {
    if (Math.abs(localWidth(s, x, y)) < s.hx + reach && Math.abs(localDepth(s, x, y)) <= s.hy + 1) return true
  }
  return false
}

/** Finite raised solids for camera obstruction, without closing the passage
 *  below: each piece blocks only across its own vertical extent. */
export function isRampartCameraBlocked(plan: FloorPlan, x: number, z: number, elevation: number, radius: number): boolean {
  const index = plan.ramparts
  for (const g of index.galleries) {
    if (elevation + radius < g.z - g.height || elevation - radius > g.z) continue
    for (const dx of [-radius, 0, radius]) {
      for (const dz of [-radius, 0, radius]) {
        if (inside(g, x + dx, z + dz)) return true
      }
    }
  }
  for (const r of index.rails) {
    if (elevation + radius < r.z || elevation - radius > r.z + r.height) continue
    if (inside(r, x, z, radius)) return true
  }
  for (const s of index.stairs) {
    const depth = localDepth(s, x, z)
    if (Math.abs(depth) > s.hy + radius) continue
    const top = s.z + Math.max(0, Math.min(1, (depth + s.hy) / (2 * s.hy))) * s.height
    if (elevation + radius < top || elevation - radius > top + s.railHeight) continue
    if (Math.abs(Math.abs(localWidth(s, x, z)) - s.hx) <= s.railThickness / 2 + radius) return true
  }
  return false
}
