import type { World } from '#shared/utils/world'
import { CHUNK_SIZE, SURFACE, chunkCoord, isProtectedTile } from '#shared/utils/world'
import type { FootSurface } from './engine'

/**
 * When a foot lands, and what it lands on.
 *
 * Pure on purpose: the cadence and the surface lookup are the only parts of the
 * audio layer worth a test, and neither of them needs an `AudioContext`. The
 * scene owns one `FootstepState` per rendered body and feeds it the distance
 * that body covered this frame.
 *
 * Cadence is distance-based, not a timer. A timer has to be told how fast the
 * legs are going and drifts out of phase with the animation the moment the
 * ground tilts; counting travelled distance puts a step down every stride
 * whatever the speed, which is also what keeps a dash from machine-gunning.
 */

/** How far a body walks or jogs between footfalls, in tiles. */
export const STRIDE_JOG = 1.25
/** A sprint covers more ground per step: cadence rises, but less than speed. */
export const STRIDE_SPRINT = 1.55
/** Below this speed the body is shuffling or being nudged by reconciliation,
 *  and neither should sound like walking. */
export const MIN_FOOT_SPEED = 0.7

export interface FootstepState {
  /** Distance covered since the last footfall. */
  travelled: number
  /** Whether the body was off the ground last frame, so a landing can be told
   *  from a step. */
  airborne: boolean
}

export function createFootstepState(): FootstepState {
  return { travelled: 0, airborne: false }
}

export interface FootstepInput {
  /** Horizontal distance covered this frame, in tiles. */
  distance: number
  /** Frame time in seconds. */
  dt: number
  grounded: boolean
  swimming: boolean
  sprinting: boolean
}

/**
 * Advance a body's stride. Returns true on the frame a foot lands.
 *
 * Airborne and swimming bodies bank nothing: the step that would have been due
 * mid-jump is dropped rather than fired on touchdown, where the landing sound
 * already is.
 */
export function stepFootsteps(state: FootstepState, input: FootstepInput): boolean {
  state.airborne = !input.grounded
  if (!input.grounded || input.swimming || input.dt <= 0) {
    state.travelled = 0
    return false
  }
  const speed = input.distance / input.dt
  if (speed < MIN_FOOT_SPEED) {
    state.travelled = 0
    return false
  }
  state.travelled += input.distance
  const stride = input.sprinting ? STRIDE_SPRINT : STRIDE_JOG
  if (state.travelled < stride) return false
  // One footfall a frame at most. A frame long enough to bank two steps is a
  // hitch, and a double tap would only make the hitch audible.
  state.travelled = 0
  return true
}

/**
 * The ground family under a point, read from the streamed surface raster.
 *
 * Read-only, like everything else the audio layer touches. A tile in a chunk we
 * do not hold, or inside the protected town footprint where the raster is a
 * placeholder, answers `path`: the town square is paving and the placeholder
 * says nothing useful.
 */
export function footSurfaceAt(world: World, x: number, y: number): FootSurface {
  const gx = Math.floor(x)
  const gy = Math.floor(y)
  if (isProtectedTile(gx, gy)) return 'path'
  const chunk = world.getChunk(chunkCoord(gx), chunkCoord(gy))
  if (!chunk) return 'grass'
  const lx = gx - chunk.cx * CHUNK_SIZE
  const ly = gy - chunk.cy * CHUNK_SIZE
  if (lx < 0 || ly < 0 || lx >= CHUNK_SIZE || ly >= CHUNK_SIZE) return 'grass'
  return footSurfaceFor(chunk.surface[ly * CHUNK_SIZE + lx])
}

/** Map a shared `SURFACE` value onto a sound family. */
export function footSurfaceFor(value: number | undefined): FootSurface {
  switch (value) {
    case SURFACE.dirt: return 'dirt'
    case SURFACE.stone: return 'stone'
    case SURFACE.sand: return 'sand'
    case SURFACE.path: return 'path'
    case SURFACE.water: return 'water'
    case SURFACE.snow: return 'snow'
    default: return 'grass'
  }
}
