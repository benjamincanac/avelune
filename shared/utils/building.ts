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
import { KIT_ASSETS } from './kit'
import type { KitKind } from './kit'
import {
  WORLD_TILE_MAX,
  WORLD_TILE_MIN,
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
/** Build kit pieces snap to this grid, in tiles. */
export const BUILD_GRID = 2
/** ...except the small props. A crate is 1×1 and a torch 0.4, so the 2 tile
 *  grid put the next cell two tiles away and a crate aimed beside another
 *  landed back on the same cell, where it was refused as overlapping. */
export const BUILD_GRID_SMALL = 1
/** ...and to quarter turns. */
export const BUILD_ROT_STEP = Math.PI / 2

/**
 * The removable nature kit: what generation scatters outside the town and what
 * players may plant back. These are the `public/models/nature/**` basenames, so
 * a placement's `kind` names its model on both sides.
 */
export const NATURE_KINDS: ReadonlySet<string> = new Set([
  'tree1', 'tree2', 'tree3', 'tree4', 'tree5',
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
  return {
    x: Math.round(x / grid) * grid,
    y: Math.round(y / grid) * grid,
    rot: round2(wrapRot(Math.round(rot / BUILD_ROT_STEP) * BUILD_ROT_STEP)),
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
 * The first solid piece a candidate would intersect, or null. Boxes are tested
 * as AABBs — deliberately a shade conservative for rotated pieces, because a
 * build that is refused reads better than two walls fused into each other.
 *
 * The vertical band matters as much as the footprint: a piece resting exactly
 * on another's top shares no volume with it, which is what makes stacking work.
 */
export function overlappingPiece(world: World, candidate: PropSpec): PropSpec | null {
  if (!isSolidProp(candidate.kind)) return null
  const a = propBounds(candidate)
  const av = propSpan(candidate)
  // The cell index over the candidate's own AABB: every piece whose footprint
  // could touch it is in there, and the exact tests below throw the rest away.
  for (const prop of propsInBox(world, a.minX, a.minY, a.maxX, a.maxY)) {
    if (prop.id === candidate.id || !isSolidProp(prop.kind)) continue
    const b = propBounds(prop)
    if (a.minX >= b.maxX - OVERLAP_EPSILON || a.maxX <= b.minX + OVERLAP_EPSILON) continue
    if (a.minY >= b.maxY - OVERLAP_EPSILON || a.maxY <= b.minY + OVERLAP_EPSILON) continue
    const bv = propSpan(prop)
    if (av.lo >= bv.hi - OVERLAP_EPSILON || av.hi <= bv.lo + OVERLAP_EPSILON) continue
    return prop
  }
  return null
}

/**
 * Gameplay elevation for a piece: the highest surface under its footprint —
 * the terrain, or the top of whatever it is stacked on. Sampled at the centre
 * and the four AABB corners, which is enough for grid-sized pieces and cannot
 * be gamed by nudging a corner over a hole.
 */
export function supportHeight(world: World, prop: PropSpec): number {
  const b = propBounds(prop)
  // Inset by the overlap epsilon: two grid neighbours share an edge exactly, and
  // a corner sampled on it would read the neighbour's top and float the piece.
  const minX = b.minX + OVERLAP_EPSILON
  const maxX = b.maxX - OVERLAP_EPSILON
  const minY = b.minY + OVERLAP_EPSILON
  const maxY = b.maxY - OVERLAP_EPSILON
  let top = surfaceHeight(world, prop.x, prop.y)
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]] as const) {
    const h = surfaceHeight(world, x, y)
    if (h > top) top = h
  }
  return Number.isFinite(top) ? Math.round(top * 100) / 100 : Number.NEGATIVE_INFINITY
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

export type EditVerdict = { ok: true } | { ok: false, reason: string }

const REFUSE = (reason: string): EditVerdict => ({ ok: false, reason })
const ALLOW: EditVerdict = { ok: true }

function inWorld(x: number, y: number): boolean {
  return x >= WORLD_TILE_MIN && y >= WORLD_TILE_MIN && x < WORLD_TILE_MAX && y < WORLD_TILE_MAX
}

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
export function checkTerraform(world: World, request: TerraformRequest, actor: { x: number, y: number }): EditVerdict {
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
  return ALLOW
}

export interface BuildRequest {
  kind: string
  x: number
  y: number
  rot: number
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
  actor: { x: number, y: number },
  context: { owner: string, id: string, pieces: number },
): { ok: true, placement: WorldPlacement } | { ok: false, reason: string } {
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
  const support = supportHeight(world, prop)
  if (!Number.isFinite(support)) return { ok: false, reason: 'that ground is not loaded' }
  placement.z = support
  // Keep the resolved spec's band in step with the elevation we just chose, or
  // the overlap test below would still be reasoning about ground level.
  elevateProp(prop, support)
  const blocker = overlappingPiece(world, prop)
  if (blocker) return { ok: false, reason: `${blocker.kind} is in the way` }
  return { ok: true, placement }
}

/** Whether this player may take that piece away, and reach it. */
export function checkDemolish(placement: WorldPlacement, actor: { x: number, y: number }, playerId: string): EditVerdict {
  if (isProtectedTile(placement.x, placement.y)) return REFUSE('the town is protected')
  if (!withinReach(actor, placement.x, placement.y)) return REFUSE('too far away')
  if (!canRemove(placement, playerId)) return REFUSE('that is not yours')
  return ALLOW
}
