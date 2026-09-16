import { chunkStore } from './chunkStore'

/**
 * How many pieces each identity owns, against `MAX_PIECES_PER_PLAYER`.
 *
 * The budget is a fact about a person, not about a session or an instance: a
 * reconnect must not hand anyone a fresh 500, and neither must a redeploy. So
 * the totals live in the store next to the chunks, in one small hash, and this
 * module is the live copy of it.
 *
 * Counting is not derivable from what is loaded. A builder's pieces sit in
 * chunks nobody has visited since the process started, so scanning memory would
 * under-count every returning player. The stored counter is the honest one.
 *
 * Writes are accumulated as signed deltas and drained on the same 5 second
 * timer as the chunks, with `HINCRBY` rather than a set, so an old instance
 * draining while a new one serves adds to the total instead of clobbering it.
 */

/** Every identity's total, as of the last store read plus everything since. */
const counts = new Map<string, number>()

/** What has happened since the last flush, per identity. */
const deltas = new Map<string, number>()

/** Tries at the boot read, and the backoff between them. Getting this wrong
 *  hands a returning builder a fresh 500, so it is worth a few retries. */
const LOAD_TRIES = 3
const LOAD_BACKOFF = [60, 240]

/** Pull the whole hash in at boot, before any socket can ask for a welcome.
 *  One round trip, one entry per identity that has ever placed a piece. */
export async function loadPieceCounts(): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < LOAD_TRIES; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, LOAD_BACKOFF[attempt - 1] ?? 240))
    try {
      const stored = await chunkStore().readPieces()
      for (const [id, count] of stored) {
        // Anything this process already counted happened after the read
        // started, so it is added on top rather than overwritten.
        counts.set(id, count + (counts.get(id) ?? 0))
      }
      return
    }
    catch (error) {
      last = error
    }
  }
  throw last
}

export function pieceCount(id: string): number {
  return counts.get(id) ?? 0
}

function move(id: string, delta: number) {
  counts.set(id, Math.max(0, (counts.get(id) ?? 0) + delta))
  deltas.set(id, (deltas.get(id) ?? 0) + delta)
}

/** One more piece owned by this identity. Returns their new total. */
export function addPiece(id: string): number {
  move(id, 1)
  return pieceCount(id)
}

/** One fewer. Ownerless pieces (the town, the generated scatter) count against
 *  nobody, so the caller only reaches here for an owned one. */
export function removePiece(id: string): number {
  if (!counts.get(id)) return 0
  move(id, -1)
  return pieceCount(id)
}

let flushing = false

/** Drain the pending deltas into the store. Returns how many identities moved.
 *  A failed write puts them back: a lost delta is a budget that drifts. */
export async function flushPieceCounts(): Promise<number> {
  if (flushing || !deltas.size) return 0
  flushing = true
  const batch = [...deltas]
  deltas.clear()
  try {
    await chunkStore().addPieces(batch)
    return batch.length
  }
  catch (error) {
    console.error('[world] piece count flush failed', error)
    for (const [id, delta] of batch) deltas.set(id, (deltas.get(id) ?? 0) + delta)
    return 0
  }
  finally {
    flushing = false
  }
}
