/**
 * Prop placements and their collision footprints.
 *
 * Split out of `maze.ts` so `world.ts` (which buckets placements into chunks)
 * and `maze.ts` (which queries them) can both depend on it without a runtime
 * import cycle — the same arrangement `ramparts.ts` and `moat.ts` use.
 *
 * `top`/`height`/`r`/`bx`/`by` are never stored in the committed JSON: they are
 * always derived here through `makeProp`, so server collision and client
 * rendering stay in lockstep.
 *
 * Elevation has two contracts, and `propFromPlacement` picks between them. A
 * hand-authored town piece keeps the original one: `z` is render-only and
 * collision is ground-based. Everything else — the build kit, generated
 * vegetation, anything a player placed — reads `z` as the base of a collision
 * band `[base, base + height]`, which is what lets a tree collide at the height
 * of the hill it grew on and a floor slab be walked under.
 */

import { COURTYARD_ASSETS } from './courtyard'
import { isRampartKind } from './ramparts'

/** A placed prop. `top > 0` means players can stand on it. */
export interface PropSpec {
  kind: string
  x: number
  y: number
  rot: number
  scale: number
  /** Absolute world height of its walkable top surface. For a ground-based
   *  town piece that is just `height`; for an elevated piece it is
   *  `base + height`. 0 means decorative, walk-through. */
  top: number
  /** Thickness of the piece's own vertical band, before elevation. Always the
   *  scaled `SOLID_PROPS` height, whatever `base` is. */
  height: number
  /** Absolute world height of the bottom of the collision band, when the
   *  placement's `z` is gameplay elevation (kit pieces, wild vegetation,
   *  anything a player placed). Absent for the hand-authored town, whose `z`
   *  stays render-only and whose collision stays ground-based. */
  base?: number
  /** Footprint radius. For boxed kinds this is the broad-phase bounding radius
   *  (hypot of the box half-extents); for round kinds it's the collision disc. */
  r: number
  /** Oriented-box footprint half-extents `[localX, localY]` (tile-plane), for
   *  wall/panel pieces a circle can't fit. When set, collision is a rotated-rect
   *  test inside the `r` broad-phase; absent means the circular `r` is the shape. */
  bx?: number
  by?: number
  /** Hand-placed via the dev editor (a `town:` placement) — lets the editor
   *  isolate and re-render just the props it owns, and marks the piece as
   *  ground-based, with a render-only `z`. */
  hand?: boolean
  /** 3D elevation. Render-only for the hand-authored town (except the rampart
   *  kinds); gameplay elevation for everything else, where it is mirrored into
   *  `base` and folded into `top`. */
  z?: number
  /** Per-axis scale `[x, y, z]`. Overrides uniform `scale` for rendering,
   *  collision footprints, and top height. */
  s3?: [number, number, number]
  /** World-unique placement id (`town:<index>` for the authored town). */
  id?: string
  /** Player id that owns this piece; absent for generated and town pieces. */
  owner?: string
  /**
   * Scratch slot for `propsInBox`'s per-query dedupe stamp. Not content: it is
   * written by queries, never persisted, sent or compared.
   */
  mark?: number
}

/**
 * A hand-placed prop as stored in `shared/data/courtyard-props.json` (gameplay props)
 * or `shared/data/courtyard-structure.json` (baked town pieces), written by the dev
 * editor. `top`/`r` are never stored — they're always derived through `makeProp`
 * so server collision and client rendering stay in lockstep. For these authored
 * pieces `z` stays render-only elevation (except for the rampart kinds); `s3`
 * scales both the visible mesh and its collision dimensions.
 */
export interface HubPropPlacement {
  kind: string
  x: number
  y: number
  rot: number
  scale: number
  z?: number
  s3?: [number, number, number]
}

/** A placement once it lives in the world: same record plus identity, so it can
 *  be streamed, persisted and removed by id. Unless its id is a `town:` one,
 *  its `z` is gameplay elevation: the base of the piece's collision band. */
export interface WorldPlacement extends HubPropPlacement {
  /** Unique in the world. Town pieces get `town:<index>`. */
  id: string
  /** Player id; absent for generated and town pieces. */
  owner?: string
}

/**
 * Per-kind collision at scale 1. `top` is the walkable surface height: a tall
 * `top` (above jump height) makes a prop an unjumpable blocker; a low one is a
 * ledge you can hop onto. Round kinds give just `r` (a collision disc). Wall/
 * panel kinds a circle can't fit give `box: [localX, localY]` half-extents — an
 * oriented rectangle in the tile plane; `r` is then derived as its bounding
 * radius. `top`/`r`/`box` scale with the placement (per-axis when `s3` is set).
 */
interface SolidProp { top: number, r: number, box?: [number, number] }
const SOLID_PROPS: Record<string, SolidProp> = {
  // Rampart pieces (gallery/stairs/rail) keep a footprint box for the rampart
  // helpers but a `top` of 0, so the ground-based collision below ignores them:
  // their surfaces are height-aware and owned by `ramparts.ts`.
  ...Object.fromEntries(Object.entries(COURTYARD_ASSETS).map(([kind, asset]) => [kind,
    'radius' in asset
      ? { top: asset.height, r: asset.radius }
      : { top: isRampartKind(kind) ? 0 : asset.height, r: Math.hypot(asset.width / 2, asset.depth / 2), box: [asset.width / 2, asset.depth / 2] },
  ])),
  // Radii track each model's real footprint (measured), so collision hugs the
  // visible mesh instead of a fat invisible ring around it. `Bricks` is left
  // out on purpose: its mesh is a long, tall, thin wall (~1.8×0.55×1.6) that no
  // single circle can fit — a circle wide enough to cover the broad faces reads
  // as an invisible wall, and a full-height one would wall off gaps — so it
  // stays decorative clutter you can walk through.
  Crate: { top: 0.8, r: 0.42 },
  Barrel: { top: 1.05, r: 0.42 },
  Chest: { top: 0.88, r: 0.55 },
  // Fantasy-kit furniture that doubles as a low platform to hop onto.
  Crate_Wooden: { top: 1.1, r: 0.45 },
  Chest_Wood: { top: 0.68, r: 0.55 },
  // Nature/town obstacles: trees and boulders block like walls; the
  // crate/wagon are lower so they read as clutter you can vault with a jump.
  CommonTree_1: { top: 3, r: 0.6 },
  CommonTree_2: { top: 3, r: 0.6 },
  CommonTree_3: { top: 3, r: 0.6 },
  Pine_1: { top: 3, r: 0.6 },
  Pine_2: { top: 3, r: 0.6 },
  Rock_Medium_1: { top: 1.8, r: 0.9 },
  Rock_Medium_2: { top: 1.8, r: 0.85 },
  Rock_Medium_3: { top: 1.8, r: 0.95 },
  // The generated nature kit (public/models/nature): what `generateVegetation`
  // scatters outside the walls and players can fell. Trees block like walls;
  // boulders are low enough to hop onto. Bushes and flowers are left out on
  // purpose — they stay walk-through decoration you can still clear away.
  tree1: { top: 3, r: 0.6 },
  tree2: { top: 3, r: 0.6 },
  tree3: { top: 3, r: 0.6 },
  tree4: { top: 3, r: 0.6 },
  tree5: { top: 3, r: 0.6 },
  // Regional trees, from trunk radii measured on the converted GLBs. The
  // twisted and dead trees are scaled down at conversion (convert_nature.sh) so
  // every tree is comparable at placement scale 1; these are the scaled trunks.
  pine1: { top: 3, r: 0.35 },
  pine2: { top: 3, r: 0.5 },
  pine3: { top: 3, r: 0.5 },
  twisted1: { top: 3, r: 0.6 },
  twisted2: { top: 3, r: 0.55 },
  twisted3: { top: 3, r: 0.55 },
  dead1: { top: 3, r: 0.5 },
  dead2: { top: 3, r: 0.55 },
  dead3: { top: 3, r: 0.5 },
  rock1: { top: 1.3, r: 0.75 },
  rock2: { top: 1.3, r: 0.7 },
  rock3: { top: 1.3, r: 0.8 },
  Prop_Crate: { top: 0.9, r: 0.55 },
  Prop_Wagon: { top: 1.2, r: 1.05 },
  // The player build kit (`shared/utils/kit.ts`). Walls and fences are oriented
  // boxes along local X so panels chain into tight walls; the door panel is
  // left OUT so its opening stays walkable (its jambs are thin enough to
  // ignore). Floors and crates are stackable platforms. `Kit_Stairs` keeps a
  // real height here for the build rules and the minimap, but its walkable
  // surface is the stepped ramp in `ramparts.ts`, so `maze.ts` skips its box.
  // The path slab and torch are decorative.
  Kit_Wall: { top: 2.5, r: 1.1, box: [1, 0.15] },
  Kit_WallWindow: { top: 2.5, r: 1.1, box: [1, 0.15] },
  Kit_Floor: { top: 0.2, r: 1.5, box: [1, 1] },
  Kit_Roof: { top: 1.2, r: 1.5, box: [1, 1] },
  Kit_RoofCorner: { top: 1.2, r: 1.5, box: [1, 1] },
  Kit_Stairs: { top: 2.5, r: 1.5, box: [1, 1] },
  Kit_Fence: { top: 1, r: 1.1, box: [1, 0.08] },
  Kit_Crate: { top: 1, r: 0.75, box: [0.5, 0.5] },
  // The claim post. A thin disc rather than a box: it is a 0.4 signpost, and a
  // player should walk around it, not through it. Nothing stacks on it — its
  // `top` is the full post height, well past a step, so it reads as a blocker
  // and never as a ledge.
  Kit_Deed: { top: 1.4, r: 0.2 },
  // Ground-level town building pieces (baked into courtyard-structure.json). Tall
  // `top` (unjumpable) so house walls block; ~1-tile radius so a chain of 2-unit
  // wall panels reads as a solid perimeter. The door frame + gate arch are left
  // OUT so their openings stay walkable. Upper-floor/roof kinds are never listed
  // (cosmetic: an authored piece's z is render-only, so ground collision would
  // put a first-floor slab across the street).
  Wall_UnevenBrick_Straight: { top: 3.4, r: 1 },
  Wall_UnevenBrick_Window_Wide_Round: { top: 3.4, r: 1 },
  Corner_Exterior_Brick: { top: 3.4, r: 0.7 },
  Prop_Support: { top: 3.4, r: 0.35 },
  Prop_WoodenFence_Single: { top: 1.1, r: 1 },
  // Dungeon/crypt wall + column pieces. Oriented boxes so a chain of panels
  // forms a tight wall instead of a scalloped line of discs; `box` half-extents
  // are [localX, localY] from the convert DIMS (W/2 × D/2). A high `top` makes
  // them unjumpable blockers. Arches/doorways/entrances stay OUT so their
  // openings remain walkable. Dungeon walls run along local X (2.0 wide × 0.44
  // thick); crypt walls run along local Y (0.68 thick × 2.04 long) — note the
  // transposed extents.
  Dungeon_Wall_Modular: { top: 3, r: 1, box: [1, 0.22] }, // 2.00 × 0.44 × 2.01
  Dungeon_Decorative_Wall: { top: 3, r: 1, box: [0.87, 0.22] }, // 1.74 × 0.44 × 1.52
  Dungeon_Column: { top: 4, r: 0.65 }, // 1.30 × 1.30 × 4.07
  Dungeon_Column2: { top: 4, r: 0.65 },
  Crypt_ModularStoneWall: { top: 3, r: 1, box: [0.34, 1.02] }, // 0.68 × 2.04 × 2.04
  Crypt_ModularStoneWall_top: { top: 3, r: 1, box: [0.35, 1.99] }, // 0.70 × 3.98 × 2.26
  Crypt_WallRocks: { top: 3, r: 1, box: [0.1, 1.02] }, // 0.15 × 2.05 × 2.04
  Crypt_Column: { top: 4.9, r: 1 }, // 2.00 × 2.00 × 4.92
}

export function makeProp(kind: string, x: number, y: number, rot: number, scale: number, s3?: [number, number, number]): PropSpec {
  const solid = SOLID_PROPS[kind]
  if (!solid) return { kind, x, y, rot, scale, top: 0, height: 0, r: 0 }
  const [sx, sy, sz] = s3 ?? [scale, scale, scale]
  const height = solid.top * sy
  const spec: PropSpec = {
    kind,
    x,
    y,
    rot,
    scale,
    top: height,
    height,
    r: solid.r * Math.max(sx, sz),
  }
  if (solid.box) {
    spec.bx = solid.box[0] * sx
    spec.by = solid.box[1] * sz
    // Bounding radius must cover the rotated rect's far corner for broad-phase.
    spec.r = Math.hypot(spec.bx, spec.by)
  }
  return spec
}

/** Whether a placement is one of the hand-authored town pieces seeded from the
 *  committed JSON. Those keep the original contract: `z` is render-only and
 *  collision is ground-based. Everything else — the build kit, generated
 *  vegetation, anything a player placed — reads `z` as gameplay elevation. */
export function isTownPlacement(p: { id?: string }): boolean {
  return p.id?.startsWith('town:') ?? false
}

/**
 * Resolve a stored placement into its collision spec, carrying identity.
 *
 * `hand` decides the elevation contract, and defaults to the town test above:
 * a hand-authored piece keeps a ground-based band (`base` absent, `top` equal
 * to the scaled height), while anything else gets `base = z` and an absolute
 * `top = z + height`, which is what lets a floor be walked under and a tree on
 * a hill collide at the hill's height.
 */
export function propFromPlacement(p: WorldPlacement, hand = isTownPlacement(p)): PropSpec {
  const spec = makeProp(p.kind, p.x, p.y, p.rot, p.scale, p.s3)
  spec.id = p.id
  if (hand) spec.hand = true
  if (p.z != null) spec.z = p.z
  if (p.s3) spec.s3 = p.s3
  if (p.owner) spec.owner = p.owner
  if (!hand) elevateProp(spec, p.z ?? 0)
  return spec
}

/** Put a resolved spec's collision band at an absolute elevation. Keeps `z`,
 *  `base` and `top` in lockstep, so nothing has to recompute them by hand. */
export function elevateProp(prop: PropSpec, z: number): PropSpec {
  prop.z = z
  prop.base = z
  prop.top = z + prop.height
  return prop
}

/** Whether a prop kind collides (blocks/ledges) vs. renders purely decorative. */
export function isSolidProp(kind: string): boolean {
  return kind in SOLID_PROPS
}

/** World-space AABB half-extents of a placement's footprint. Exact for circles
 *  and axis-aligned boxes, a slight over-estimate for rotated ones — which is
 *  what chunk bucketing and the minimap raster want. */
export function propHalfExtents(prop: PropSpec): { ax: number, ay: number } {
  if (prop.bx != null && prop.by != null) {
    const c = Math.abs(Math.cos(prop.rot))
    const s = Math.abs(Math.sin(prop.rot))
    return { ax: prop.bx * c + prop.by * s, ay: prop.bx * s + prop.by * c }
  }
  return { ax: prop.r, ay: prop.r }
}
