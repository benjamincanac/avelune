/**
 * The rules of editing the world: what may be placed, where, how high it sits,
 * and what may be dug or removed.
 *
 * Every predicate here is pure and reads only the `World` it is handed, so the
 * authoritative server runs exactly the same test as the client's ghost
 * preview. The server is still the only thing that mutates anything: the client
 * uses these to colour a preview green or red, the server uses them to decide.
 *
 * Numbers that bound a player's editing (reach, rate, budget) live here too, so
 * the HUD can show the same limits the server enforces.
 */

import { surfaceHeight, terrainHeight } from './maze'
import { elevateProp, isSolidProp, propFromPlacement, propHalfExtents } from './props'
import type { PropSpec, WorldPlacement } from './props'
import { ALL_PROP_KINDS } from './propCatalog'
import { DEED_KIND, KIT_ASSETS } from './kit'
import type { KitKind } from './kit'
import {
  WORLD_TILE_MAX,
  WORLD_TILE_MIN,
  deedsInBox,
  isProtectedBox,
  isProtectedTile,
  propsInBox,
} from './world'
import type { SurfaceType, TerraformMode, World } from './world'

/** How far from a player an edit may land, in tiles. */
export const EDIT_REACH = 6
/** Edits a player may apply per second, shared by terraform, build and demolish. */
export const EDITS_PER_SECOND = 8
/** Pieces one player may own in the world at a time. */
export const MAX_PIECES_PER_PLAYER = 500
/** How many tiles across the plot a deed post claims is, centred on the deed's
 *  own tile. A constant so it can grow without touching a rule. */
export const DEED_SIZE = 16
/** Plots one player may hold at a time. */
export const DEED_LIMIT = 1
/** Build kit pieces snap to this grid, in tiles. */
export const BUILD_GRID = 2
/** ...except the small props. A crate is 1×1 and a torch 0.4, so the 2 tile
 *  grid put the next cell two tiles away and a crate aimed beside another
 *  landed back on the same cell, where it was refused as overlapping. */
export const BUILD_GRID_SMALL = 1
/** ...and to quarter turns. */
export const BUILD_ROT_STEP = Math.PI / 2

/**
 * Edge pieces: the kit's flat panels.
 *
 * Everything else in the kit occupies a whole grid cell and snaps to its
 * centre. A panel does not: it is the *boundary* of a cell, so it snaps to the
 * nearest cell edge and takes its heading from that edge. That is the whole
 * difference between a wall running through the middle of a floor slab and a
 * wall closing one side of a room, and it is why floors, walls and roofs now
 * share edges without anyone aiming carefully.
 *
 * Because the edge picks the heading, `R` no longer turns these: it flips which
 * way the panel faces (adds a half turn).
 */
const EDGE_KINDS: ReadonlySet<string> = new Set(['Kit_Wall', 'Kit_WallWindow', 'Kit_WallDoor', 'Kit_Fence', 'Kit_Gate'])

/** Whether a kind snaps to a cell edge rather than a cell centre. */
export function isEdgeKind(kind: string): boolean {
  return EDGE_KINDS.has(kind)
}

/**
 * The removable nature kit: what generation scatters outside the town and what
 * players may plant back. These are the `public/models/nature/**` basenames, so
 * a placement's `kind` names its model on both sides.
 */
export const NATURE_KINDS: ReadonlySet<string> = new Set([
  'tree1', 'tree2', 'tree3', 'tree4', 'tree5',
  // The regional families: conifers, autumn-red crooked trees, bare trunks.
  // `shared/utils/vegetation.ts` decides which biome grows which, but any of
  // them can be felled and replanted anywhere `tree1` can.
  'pine1', 'pine2', 'pine3',
  'twisted1', 'twisted2', 'twisted3',
  'dead1', 'dead2', 'dead3',
  'bush1', 'bush2',
  'rock1', 'rock2', 'rock3',
])

/**
 * The player build kit (`shared/utils/kit.ts`, GLBs under `public/models/kit`).
 * Its pieces are catalogued like any other prop, and the catalog is the gate: a
 * `Kit_` kind missing from `ALL_PROP_KINDS` cannot be placed.
 */
const KIT_PREFIX = 'Kit_'
export function isKitKind(kind: string): boolean {
  return kind.startsWith(KIT_PREFIX) && ALL_PROP_KINDS.has(kind)
}

/** Whether a player may place this kind at all. Everything else — the authored
 *  town's architecture included — is off the palette. */
export function isPlaceableKind(kind: string): boolean {
  return isKitKind(kind) || NATURE_KINDS.has(kind)
}

/** Whether a piece may be taken away by this player: their own, or an unowned
 *  piece of the nature kit (a generated tree anyone may clear). */
export function canRemove(placement: WorldPlacement, playerId: string): boolean {
  if (placement.owner) return placement.owner === playerId
  return NATURE_KINDS.has(placement.kind)
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const round2 = (n: number) => Math.round(n * 100) / 100
const TWO_PI = Math.PI * 2
const wrapRot = (rot: number) => ((rot % TWO_PI) + TWO_PI) % TWO_PI

/**
 * Snap a requested pose. Kit pieces land on their own grid (`snapGridFor`) at
 * quarter turns so walls meet; nature pieces are free-standing and only get
 * their numbers rounded, which keeps the wire and the persisted chunk small.
 */
export function snapPlacement(kind: string, x: number, y: number, rot: number): { x: number, y: number, rot: number } {
  const grid = snapGridFor(kind)
  if (!grid) return { x: round2(x), y: round2(y), rot: round2(wrapRot(rot)) }
  if (isEdgeKind(kind)) return snapToEdge(grid, x, y, rot)
  return {
    // `|| 0`: `Math.round(-0.45) * 2` is -0, and a pose whose zero has a sign
    // is not the pose the other side computed.
    x: Math.round(x / grid) * grid || 0,
    y: Math.round(y / grid) * grid || 0,
    rot: round2(wrapRot(Math.round(rot / BUILD_ROT_STEP) * BUILD_ROT_STEP)),
  }
}

/**
 * Snap a panel to the nearest cell edge, and align it to that edge.
 *
 * Cells are centred on multiples of `grid`, so a cell spans one `grid` either
 * side of its centre and its edges are the half-grid lines. There are only two
 * candidates worth testing — the edge of the cell under the aim that runs along
 * X, and the one that runs along Y — and "nearest" is the distance to each
 * edge's own line, because the other axis is already its midpoint.
 *
 * This must be run from the RAW aim, not from an already-snapped pose: the
 * flip below is read out of `rot`, and a pose's own heading would be read back
 * as a different flip. Client and server both feed it the raw request.
 */
function snapToEdge(grid: number, x: number, y: number, rot: number): { x: number, y: number, rot: number } {
  const half = grid / 2
  const alongX = { x: Math.round(x / grid) * grid, y: Math.round((y - half) / grid) * grid + half }
  const alongY = { x: Math.round((x - half) / grid) * grid + half, y: Math.round(y / grid) * grid }
  const runsAlongX = Math.abs(y - alongX.y) <= Math.abs(x - alongY.x)
  const edge = runsAlongX ? alongX : alongY
  // A panel's model runs along its local X, so an edge along world X is rot 0.
  // Every other quarter turn asked for is a flip, which is what keeps `R` a
  // one-press toggle now that it no longer chooses the heading.
  const flip = Math.abs(Math.round(rot / BUILD_ROT_STEP)) % 2 === 1 ? Math.PI : 0
  return {
    // `|| 0` because `Math.round(-0.3) * 2` is -0, and a pose that differs from
    // the server's only in the sign of a zero is a pose that differs.
    x: round2(edge.x) || 0,
    y: round2(edge.y) || 0,
    rot: round2(wrapRot((runsAlongX ? 0 : BUILD_ROT_STEP) + flip)),
  }
}

/**
 * The grid a kind snaps to, in tiles, or 0 for the free-standing nature kit.
 *
 * Per piece, not per kit: a piece whose footprint fits in a single tile gets the
 * 1 tile grid so two of them can sit side by side, everything else stays on the
 * 2 tile grid so walls meet. The client ghost calls this too, or it would
 * preview a pose the server does not store.
 */
export function snapGridFor(kind: string): number {
  if (!isKitKind(kind)) return 0
  const asset = KIT_ASSETS[kind as KitKind]
  if (asset && Math.max(asset.width, asset.depth) <= BUILD_GRID_SMALL) return BUILD_GRID_SMALL
  return BUILD_GRID
}

/** World-space AABB of a footprint. */
export function propBounds(prop: PropSpec): { minX: number, maxX: number, minY: number, maxY: number } {
  const { ax, ay } = propHalfExtents(prop)
  return { minX: prop.x - ax, maxX: prop.x + ax, minY: prop.y - ay, maxY: prop.y + ay }
}

/** The vertical band a piece occupies: its elevation and its walkable top.
 *  `base` is set once a placement's `z` is gameplay elevation; the authored
 *  town keeps a render-only `z`, which still reads as a band here so two
 *  authored pieces at different storeys never count as overlapping. */
function propSpan(prop: PropSpec): { lo: number, hi: number } {
  const lo = prop.base ?? prop.z ?? 0
  return { lo, hi: lo + Math.max(prop.height, 0.1) }
}

const OVERLAP_EPSILON = 0.02

/**
 * How far a panel's *overlap* footprint is pulled in at each end: half the
 * depth of the deepest edge piece (`Kit_Wall` is 0.3 thick).
 *
 * Two panels on the perpendicular edges of the same cell meet at that cell's
 * corner and share exactly that much volume. A corner is a join, not a
 * collision, so the overlap test insets each panel along its own run by that
 * amount and the two stop touching. A single inset for every panel rather than
 * each one's own half-depth, so a wall and a fence agree about where their
 * corner is.
 *
 * Only this test is inset. `propBounds` and the physical collision boxes in
 * `props.ts` stay exact, so four panels around a cell still seal it: the
 * perpendicular neighbour covers precisely the strip the inset gave up.
 */
const EDGE_CORNER_INSET = 0.15

/** The footprint `overlappingPiece` reasons about: exact, except that a panel
 *  gives up a corner's worth at each end of its run. */
function overlapBounds(prop: PropSpec): { minX: number, maxX: number, minY: number, maxY: number } {
  const b = propBounds(prop)
  if (!isEdgeKind(prop.kind)) return b
  // The run is the panel's local X, so world X at rot 0 or PI.
  if (Math.abs(Math.cos(prop.rot)) > 0.5) {
    return { ...b, minX: b.minX + EDGE_CORNER_INSET, maxX: b.maxX - EDGE_CORNER_INSET }
  }
  return { ...b, minY: b.minY + EDGE_CORNER_INSET, maxY: b.maxY - EDGE_CORNER_INSET }
}

/**
 * The first solid piece a candidate would intersect, or null. Boxes are tested
 * as AABBs — deliberately a shade conservative for rotated pieces, because a
 * build that is refused reads better than two walls fused into each other.
 *
 * The vertical band matters as much as the footprint: a piece resting exactly
 * on another's top shares no volume with it, which is what makes stacking work.
 */
export function overlappingPiece(world: World, candidate: PropSpec): PropSpec | null {
  if (!isSolidProp(candidate.kind)) return null
  const a = overlapBounds(candidate)
  const av = propSpan(candidate)
  const query = propBounds(candidate)
  // The cell index over the candidate's own AABB: every piece whose footprint
  // could touch it is in there, and the exact tests below throw the rest away.
  for (const prop of propsInBox(world, query.minX, query.minY, query.maxX, query.maxY)) {
    if (prop.id === candidate.id || !isSolidProp(prop.kind)) continue
    const b = overlapBounds(prop)
    if (a.minX >= b.maxX - OVERLAP_EPSILON || a.maxX <= b.minX + OVERLAP_EPSILON) continue
    if (a.minY >= b.maxY - OVERLAP_EPSILON || a.maxY <= b.minY + OVERLAP_EPSILON) continue
    const bv = propSpan(prop)
    if (av.lo >= bv.hi - OVERLAP_EPSILON || av.hi <= bv.lo + OVERLAP_EPSILON) continue
    return prop
  }
  return null
}

/**
 * How far above the aimed point a support may still be chosen, in tiles.
 *
 * The client hands the server the world height of the ray hit, and that hint
 * only ever narrows the choice: a surface higher than the aim plus this slack
 * is not what the player was looking at. The slack absorbs the difference
 * between the point the ray met and the surface the piece will actually rest
 * on — a slab's lip, a tile of relief under a levelled plot.
 */
export const AIM_SLACK = 0.3

/** Aim heights outside this band are nonsense (a stray NaN, a client sending
 *  1e9) and are clamped rather than trusted: `supportHeight` reads it as a
 *  ceiling, and an absurd one would simply restore the old behaviour. */
const AIM_LIMIT = 4096

/** The aim hint as the rules will use it: `undefined` where there is none or it
 *  is not a finite number, clamped otherwise. */
function cleanAim(h: number | undefined): number | undefined {
  if (h == null || !Number.isFinite(h)) return undefined
  return Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT, h))
}

/**
 * The piece hanging over the band this one would occupy, or null.
 *
 * Once a support has been chosen by what the player aimed at, "is the band
 * free" is no longer the whole question: the band also has to fit under
 * whatever is already above it. A crate under a ceiling two and a half up fits;
 * a wall of the same height under a floor slab hung lower does not, and saying
 * so is friendlier than silently putting the wall on the roof.
 *
 * Only pieces whose bottom is strictly *above* the candidate's counts — a piece
 * starting at the same height is an ordinary obstruction and `overlappingPiece`
 * names it.
 */
function ceilingOver(world: World, candidate: PropSpec): PropSpec | null {
  if (!isSolidProp(candidate.kind)) return null
  const a = overlapBounds(candidate)
  const av = propSpan(candidate)
  const query = propBounds(candidate)
  for (const prop of propsInBox(world, query.minX, query.minY, query.maxX, query.maxY)) {
    if (prop.id === candidate.id || !isSolidProp(prop.kind)) continue
    const bv = propSpan(prop)
    // Level with us or below: not a ceiling.
    if (bv.lo <= av.lo + OVERLAP_EPSILON) continue
    // Clears the top of the band. Touching exactly is clearance, which is what
    // lets a 2.5 wall stand under a floor laid at 2.5.
    if (bv.lo >= av.hi - OVERLAP_EPSILON) continue
    const b = overlapBounds(prop)
    if (a.minX >= b.maxX - OVERLAP_EPSILON || a.maxX <= b.minX + OVERLAP_EPSILON) continue
    if (a.minY >= b.maxY - OVERLAP_EPSILON || a.maxY <= b.minY + OVERLAP_EPSILON) continue
    return prop
  }
  return null
}

/**
 * Gameplay elevation for a piece: the highest surface under its footprint —
 * the terrain, or the top of whatever it is stacked on. Sampled at the centre
 * and the four AABB corners, which is enough for grid-sized pieces and cannot
 * be gamed by nudging a corner over a hole.
 *
 * `aim` is the world height the player's ray hit, and it bounds the answer: the
 * highest surface that a body standing at `aim + AIM_SLACK` could step onto.
 * Without it the highest surface anywhere under the footprint wins, which is
 * what put a replaced ground-floor wall on the roof and a crate upstairs.
 */
export function supportHeight(world: World, prop: PropSpec, aim?: number): number {
  const feet = aim == null ? Infinity : aim + AIM_SLACK
  // `overlapBounds`, not `propBounds`: a panel's ends are given up to its
  // perpendicular neighbours at the cell corners, and a corner must not hold a
  // piece up any more than it collides with one. Without that the second wall
  // of a room reads the first wall's top through the corner they share and
  // flies to the storey above.
  const b = overlapBounds(prop)
  // Inset by the overlap epsilon: two grid neighbours share an edge exactly, and
  // a corner sampled on it would read the neighbour's top and float the piece.
  const minX = b.minX + OVERLAP_EPSILON
  const maxX = b.maxX - OVERLAP_EPSILON
  const minY = b.minY + OVERLAP_EPSILON
  const maxY = b.maxY - OVERLAP_EPSILON
  let top = surfaceHeight(world, prop.x, prop.y, feet)
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]] as const) {
    const h = surfaceHeight(world, x, y, feet)
    if (h > top) top = h
  }
  return Number.isFinite(top) ? Math.round(top * 100) / 100 : Number.NEGATIVE_INFINITY
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deed plots.
 *
 * A `Kit_Deed` post claims the `DEED_SIZE`-tile square around it. Inside that
 * square only its owner may terraform, build or demolish — generated
 * vegetation included, so nobody clears your garden. Outside every plot the
 * rules are exactly what they were.
 *
 * The plot is derived from the post, never stored: pull the deed and the claim
 * is gone, and whatever was built inside stays where it is. That is also why
 * these live here rather than in the protocol — a client that holds the chunk
 * holds the claim.
 */

export interface PlotBounds {
  /** Half-open in tiles: `minX <= tile < maxX`, so two plots exactly
   *  `DEED_SIZE` apart touch without overlapping. */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The square a deed at this position claims, with its own tile at the centre. */
export function plotBounds(deed: { x: number, y: number }): PlotBounds {
  const half = DEED_SIZE / 2
  const tx = Math.floor(deed.x)
  const ty = Math.floor(deed.y)
  return { minX: tx - half + 1, minY: ty - half + 1, maxX: tx + half + 1, maxY: ty + half + 1 }
}

function boxesOverlap(a: PlotBounds, b: PlotBounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

/**
 * Every claim whose plot overlaps this world-space box. The query widens the
 * box by a whole plot before asking `deedsInBox`, because a deed up to
 * `DEED_SIZE` tiles away can still reach into it.
 */
export function* plotsOverlapping(world: World, box: PlotBounds): Generator<WorldPlacement> {
  for (const deed of deedsInBox(world, box.minX - DEED_SIZE, box.minY - DEED_SIZE, box.maxX + DEED_SIZE, box.maxY + DEED_SIZE)) {
    if (boxesOverlap(box, plotBounds(deed))) yield deed
  }
}

/** The deed whose plot covers this point, if any. */
export function deedAt(world: World, x: number, y: number): WorldPlacement | undefined {
  for (const deed of plotsOverlapping(world, { minX: x, minY: y, maxX: x, maxY: y })) return deed
  return undefined
}

/** Who owns the ground under this point, or undefined where nobody has claimed
 *  it. An unowned deed cannot exist — only a player places one — but the type
 *  says `owner?`, so this narrows it. */
export function plotOwner(world: World, x: number, y: number): string | undefined {
  return deedAt(world, x, y)?.owner
}

/** The first claim over this box that belongs to someone else — what every edit
 *  rule below is actually asking. */
export function foreignClaim(world: World, box: PlotBounds, playerId: string | undefined): WorldPlacement | undefined {
  for (const deed of plotsOverlapping(world, box)) {
    if (deed.owner && deed.owner !== playerId) return deed
  }
  return undefined
}

/** Plots this player holds among the chunks this world has loaded. The server
 *  holds the honest total (a plot sits in a chunk nobody is standing in); the
 *  client uses this to colour a ghost. */
export function countDeeds(world: World, owner: string): number {
  let count = 0
  for (const chunk of world.chunks.values()) {
    for (const deed of chunk.deeds) if (deed.owner === owner) count++
  }
  return count
}

/** The generic refusal, used wherever the owner's name is not to hand. */
export const PLOT_REFUSAL = 'that plot is claimed'

/** The refusal for somebody else's plot. Callers holding a roster pass the
 *  owner's name; everyone else gets the generic line. */
export function plotRefusal(name?: string): string {
  return name ? `that plot belongs to ${name}` : PLOT_REFUSAL
}

/**
 * The line to show a player for a refusal. Identical to `verdict.reason` unless
 * the refusal was a claim, in which case `names` gets a chance to turn the
 * owner's id into the name they are known by. The server does this from its
 * roster; the client does it from the players it has been told about.
 */
export function refusalText(verdict: { reason: string, claim?: string }, names?: (id: string) => string | undefined): string {
  if (!verdict.claim) return verdict.reason
  return plotRefusal(names?.(verdict.claim))
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

/** `claim` is the player id whose plot refused the edit; `refusalText` turns it
 *  into a name where one is known. */
export type EditVerdict = { ok: true } | { ok: false, reason: string, claim?: string }

const REFUSE = (reason: string): EditVerdict => ({ ok: false, reason })
const REFUSE_CLAIM = (deed: WorldPlacement): EditVerdict => ({ ok: false, reason: PLOT_REFUSAL, claim: deed.owner })

/** What `resolveBuild` returns: the exact placement the server would store, or
 *  the refusal, with `claim` carried the same way `EditVerdict` carries it. */
export type BuildVerdict
  = | { ok: true, placement: WorldPlacement }
    | { ok: false, reason: string, claim?: string }
const ALLOW: EditVerdict = { ok: true }

function inWorld(x: number, y: number): boolean {
  return x >= WORLD_TILE_MIN && y >= WORLD_TILE_MIN && x < WORLD_TILE_MAX && y < WORLD_TILE_MAX
}

/** Who is editing. The position is what reach is measured from; the id is what
 *  a claim is measured against. An actor with no id owns no plot, so every
 *  claim refuses them. */
export interface EditActor { x: number, y: number, id?: string }

function withinReach(from: { x: number, y: number }, x: number, y: number): boolean {
  return Math.hypot(x - from.x, y - from.y) <= EDIT_REACH
}

/** Corner range a brush of `size` centred on (gx, gy) writes to. */
export function brushExtent(gx: number, gy: number, size: 1 | 2 | 3) {
  const half = Math.floor(size / 2)
  return { minX: gx - half, maxX: gx + (size - half - 1), minY: gy - half, maxY: gy + (size - half - 1) }
}

/** Whether a placed piece stands over the brush — you cannot dig the ground out
 *  from under a building. Any placement counts, generated trees included. */
export function pieceOverBrush(world: World, gx: number, gy: number, size: 1 | 2 | 3): PropSpec | null {
  const e = brushExtent(gx, gy, size)
  for (const prop of propsInBox(world, e.minX, e.minY, e.maxX + 1, e.maxY + 1)) {
    const b = propBounds(prop)
    if (b.maxX <= e.minX || b.minX >= e.maxX + 1 || b.maxY <= e.minY || b.minY >= e.maxY + 1) continue
    return prop
  }
  return null
}

export interface TerraformRequest {
  x: number
  y: number
  mode: TerraformMode
  size: 1 | 2 | 3
  surface?: SurfaceType
}

/**
 * Everything that has to be true before terrain moves. The step itself is not
 * checked here — it is not requested: `applyTerrain` moves a corner by exactly
 * `TERRAFORM_STEP`, and the server passes `maxStep` so even a flatten cannot
 * travel further in one operation.
 */
export function checkTerraform(world: World, request: TerraformRequest, actor: EditActor): EditVerdict {
  const { x, y, mode, size } = request
  if (!Number.isFinite(x) || !Number.isFinite(y)) return REFUSE('bad coordinates')
  if (mode !== 'raise' && mode !== 'lower' && mode !== 'flatten' && mode !== 'paint') return REFUSE('unknown tool')
  if (size !== 1 && size !== 2 && size !== 3) return REFUSE('brush must be 1 to 3')
  if (mode === 'paint' && (request.surface == null || !Number.isInteger(request.surface) || request.surface < 0 || request.surface > 5)) {
    return REFUSE('unknown surface')
  }
  const gx = Math.round(x)
  const gy = Math.round(y)
  if (!withinReach(actor, gx, gy)) return REFUSE('too far away')
  const e = brushExtent(gx, gy, size)
  for (let cy = e.minY; cy <= e.maxY; cy++) {
    for (let cx = e.minX; cx <= e.maxX; cx++) {
      if (!inWorld(cx, cy)) return REFUSE('outside the world')
      if (isProtectedTile(cx, cy)) return REFUSE('the town is protected')
      if (!Number.isFinite(terrainHeight(world, cx, cy))) return REFUSE('that ground is not loaded')
    }
  }
  if (pieceOverBrush(world, gx, gy, size)) return REFUSE('something is standing there')
  // A corner moves the four tiles around it, so the claim test covers a tile
  // more than the corner range on each side. One tile of slack, in the
  // direction that protects the plot.
  const claim = foreignClaim(world, { minX: e.minX - 1, minY: e.minY - 1, maxX: e.maxX + 1, maxY: e.maxY + 1 }, actor.id)
  if (claim) return REFUSE_CLAIM(claim)
  return ALLOW
}

/**
 * Whether a deed may be planted here — the rule that is only about claims.
 *
 * A plot has to be clear of everything that would make it a land grab: another
 * player's plot, the protected town, or a piece somebody else built. Your own
 * pieces are fine, which is what lets you fence a house first and deed it
 * after.
 */
export function checkDeedPlacement(world: World, deed: { x: number, y: number }, owner: string, held: number): EditVerdict {
  if (held >= DEED_LIMIT) {
    return REFUSE(DEED_LIMIT === 1 ? 'you already hold a plot' : `you already hold ${DEED_LIMIT} plots`)
  }
  const plot = plotBounds(deed)
  if (isProtectedBox(plot.minX, plot.minY, plot.maxX, plot.maxY)) return REFUSE('the town is protected')
  const neighbour = foreignClaim(world, plot, owner)
  if (neighbour) return REFUSE_CLAIM(neighbour)
  // `propsInBox` answers by index cell, which is eight tiles wide: a neighbour's
  // wall a few tiles outside the plot comes back with everything genuinely
  // inside it. The footprint test is what makes the answer exact.
  for (const prop of propsInBox(world, plot.minX, plot.minY, plot.maxX - 1, plot.maxY - 1)) {
    if (!prop.owner || prop.owner === owner) continue
    if (boxesOverlap(plot, propBounds(prop))) return REFUSE('someone else has built here')
  }
  return ALLOW
}

export interface BuildRequest {
  kind: string
  x: number
  y: number
  rot: number
  /** The world height the player's ray hit, when the client knows it. A hint,
   *  not a position: the server still derives `z` from real surfaces, and this
   *  only says which of them the player was looking at. Absent, the highest
   *  surface under the footprint wins, exactly as before. */
  h?: number
}

/**
 * Resolve a build request into the exact placement the server would store, or
 * the reason it refuses. The client runs this to colour its ghost; the server
 * runs it to decide, then broadcasts what comes back — the two can't disagree
 * about where a piece ends up because neither computes the pose on its own.
 */
export function resolveBuild(
  world: World,
  request: BuildRequest,
  actor: EditActor,
  context: { owner: string, id: string, pieces: number, deeds?: number },
): BuildVerdict {
  const { kind, x, y, rot } = request
  if (typeof kind !== 'string' || !isPlaceableKind(kind)) return { ok: false, reason: 'that piece is not in your kit' }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rot)) return { ok: false, reason: 'bad coordinates' }
  if (context.pieces >= MAX_PIECES_PER_PLAYER) return { ok: false, reason: `you have reached ${MAX_PIECES_PER_PLAYER} pieces` }
  const pose = snapPlacement(kind, x, y, rot)
  if (!withinReach(actor, pose.x, pose.y)) return { ok: false, reason: 'too far away' }
  if (!inWorld(pose.x, pose.y)) return { ok: false, reason: 'outside the world' }
  if (isProtectedTile(pose.x, pose.y)) return { ok: false, reason: 'the town is protected' }
  const placement: WorldPlacement = { ...pose, kind, scale: 1, id: context.id, owner: context.owner }
  const prop = propFromPlacement(placement)
  const footprint = propBounds(prop)
  const claim = foreignClaim(world, footprint, context.owner)
  if (claim) return { ok: false, reason: PLOT_REFUSAL, claim: claim.owner }
  if (kind === DEED_KIND) {
    // The count is the server's to supply: a plot of yours can sit in a chunk
    // nobody is standing in. A client that does not pass one falls back to what
    // it can see, which is enough to colour a ghost.
    const held = context.deeds ?? countDeeds(world, context.owner)
    const verdict = checkDeedPlacement(world, pose, context.owner, held)
    if (!verdict.ok) return verdict
  }
  const support = supportHeight(world, prop, cleanAim(request.h))
  if (!Number.isFinite(support)) return { ok: false, reason: 'that ground is not loaded' }
  placement.z = support
  // Keep the resolved spec's band in step with the elevation we just chose, or
  // the overlap test below would still be reasoning about ground level.
  elevateProp(prop, support)
  if (ceilingOver(world, prop)) return { ok: false, reason: 'no room there' }
  const blocker = overlappingPiece(world, prop)
  if (blocker) return { ok: false, reason: `${blocker.kind} is in the way` }
  return { ok: true, placement }
}

/** Whether this player may take that piece away, and reach it. Inside a plot
 *  only its owner may clear anything, a generated tree included — otherwise a
 *  stranger could log your garden without touching a thing you built. */
export function checkDemolish(world: World, placement: WorldPlacement, actor: EditActor, playerId: string): EditVerdict {
  if (isProtectedTile(placement.x, placement.y)) return REFUSE('the town is protected')
  if (!withinReach(actor, placement.x, placement.y)) return REFUSE('too far away')
  if (!canRemove(placement, playerId)) return REFUSE('that is not yours')
  const deed = deedAt(world, placement.x, placement.y)
  if (deed?.owner && deed.owner !== playerId) return REFUSE_CLAIM(deed)
  return ALLOW
}
