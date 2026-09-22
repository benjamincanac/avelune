import { WORLD_TILE_MAX, WORLD_TILE_MIN } from '#shared/utils/world'
import { chunkStore } from './chunkStore'
import { flushGate } from './flushGate'

/**
 * Where each identity last stood, so a reload or a new login resumes there
 * instead of at the gate.
 *
 * Same shape as `pieces.ts`: the store holds one small hash per realm and this
 * module is the live copy. The sim notes every session on the flush timer and
 * again on disconnect, and the dirty entries ride `flushDirtyChunks` out, so a
 * redeploy loses five seconds of walking at most.
 *
 * Unlike the piece totals, nothing is read at boot. A position only matters to
 * the one player arriving, so it is one `HGET` on connect, and only when this
 * process has not seen them since it started.
 */

export interface SavedPosition {
  x: number
  y: number
  z: number
  angle: number
}

/** Every identity this process has seen, as last noted. */
const known = new Map<string, SavedPosition>()

/** Identities whose entry the store has not caught up with. */
const dirty = new Set<string>()

function encode(at: SavedPosition): string {
  return [at.x, at.y, at.z, at.angle].map(n => n.toFixed(2)).join(',')
}

/** The store is outside the trust boundary the same way the wire is: anything
 *  that is not four finite numbers inside the world is no position at all. */
function decode(raw: string | null): SavedPosition | null {
  if (!raw) return null
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null
  const [x, y, z, angle] = parts as [number, number, number, number]
  if (x < WORLD_TILE_MIN || y < WORLD_TILE_MIN || x >= WORLD_TILE_MAX || y >= WORLD_TILE_MAX) return null
  return { x, y, z, angle }
}

/** Where this identity resumes, or null for the gate. A store that is down is
 *  the gate too: a failed read must never keep anyone out of the world. */
export async function loadPosition(id: string): Promise<SavedPosition | null> {
  const seen = known.get(id)
  if (seen) return seen
  try {
    return decode(await chunkStore().readPosition(id))
  }
  catch (error) {
    console.error('[world] position read failed', error)
    return null
  }
}

/** Record where a player stands. Cheap enough to call for every session on the
 *  flush timer: an idle player compares equal and costs no write. */
export function notePosition(id: string, at: SavedPosition) {
  const last = known.get(id)
  if (last && last.x === at.x && last.y === at.y && last.z === at.z && last.angle === at.angle) return
  known.set(id, { x: at.x, y: at.y, z: at.z, angle: at.angle })
  dirty.add(id)
}

/** Drain the dirty entries into the store. A failed write marks them dirty
 *  again; the next one carries whatever is newest by then. A call that lands
 *  mid-flush waits for it and runs once more (see `flushGate.ts`). */
export const flushPositions = flushGate(drainPositions, () => dirty.size > 0)

async function drainPositions(): Promise<number> {
  const ids = [...dirty]
  dirty.clear()
  try {
    await chunkStore().writePositions(ids.map(id => [id, encode(known.get(id)!)] as const))
    return ids.length
  }
  catch (error) {
    console.error('[world] position flush failed', error)
    for (const id of ids) dirty.add(id)
    return 0
  }
}
