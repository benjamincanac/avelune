import { MAX_CLIP_BYTES } from '#shared/utils/voice'

/**
 * How much push-to-talk one identity may spend.
 *
 * Every clip costs money on a public demo, so the gates are tight. The socket
 * itself is the first one: a clip arrives on the connection of a player the
 * server already knows has voice on, which is what the old `POST /api/voice/say`
 * had to check by hand (and got wrong across instances). What is left is the
 * spending, and this is it.
 *
 * Per identity, in process. A limit that resets with the instance is the same
 * tradeoff the piece budget makes for the roster: good enough to stop a script,
 * and not worth a store round trip on a voice clip. Unlike the old route's copy,
 * this one is counted by the process holding the socket, so a player cannot
 * spread their clips across instances to get a fresh allowance.
 */

/** Clips per minute, per identity. A person speaks in sentences, not bursts. */
const CLIPS_PER_WINDOW = 6
const CLIP_WINDOW = 60_000
/** And a longer window on total audio, which is what the bill is actually in. */
const BYTES_PER_LONG_WINDOW = 6 * MAX_CLIP_BYTES
const LONG_WINDOW = 5 * 60_000

interface Usage {
  /** When each clip in the short window landed. */
  clips: number[]
  /** `[at, bytes]` for each clip in the long window. */
  bytes: [number, number][]
}

const usage = new Map<string, Usage>()

/**
 * Forget identities whose windows have run out.
 *
 * A map keyed by identity that is only ever added to is a slow leak on an
 * instance that stays warm for days, and a player who spoke once an hour ago is
 * indistinguishable from one who never has. Swept from `allowClip`, which is the
 * only thing that writes here and runs at most a handful of times a minute.
 */
function sweep(now: number): void {
  for (const [id, seen] of usage) {
    if (seen.clips.some(at => now - at < CLIP_WINDOW)) continue
    if (seen.bytes.some(([at]) => now - at < LONG_WINDOW)) continue
    usage.delete(id)
  }
}

/** Whether this identity may spend one clip of `size` bytes, and book it if so. */
export function allowClip(id: string, size: number, now: number): boolean {
  sweep(now)
  const seen = usage.get(id) ?? { clips: [], bytes: [] }
  usage.set(id, seen)
  seen.clips = seen.clips.filter(at => now - at < CLIP_WINDOW)
  seen.bytes = seen.bytes.filter(([at]) => now - at < LONG_WINDOW)
  if (seen.clips.length >= CLIPS_PER_WINDOW) return false
  const total = seen.bytes.reduce((sum, [, n]) => sum + n, 0)
  if (total + size > BYTES_PER_LONG_WINDOW) return false
  seen.clips.push(now)
  seen.bytes.push([now, size])
  return true
}

/** Drop everything a disconnecting identity had booked? No: a reconnect must
 *  not hand anyone a fresh allowance, which is the whole point of keying this
 *  by identity rather than by session. Exposed for the tests alone. */
export function resetClipUsage(): void {
  usage.clear()
}
