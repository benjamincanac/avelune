/**
 * One talker's jitter buffer.
 *
 * Voice rides the game's WebSocket, which is TCP, so frames never arrive out of
 * order and never arrive corrupt. What TCP does instead is stall: a retransmit
 * holds the whole stream, and then a second's worth of audio lands at once. That
 * is the case this buffer is shaped around, rather than the packet loss a UDP one
 * would be built for.
 *
 * So there are two jobs. A small delay ahead of playback absorbs ordinary
 * scheduling jitter, and a hard ceiling on the backlog throws audio away rather
 * than playing further and further behind: after a stall the right thing is to
 * skip to the present, because a conversation two seconds late is not a
 * conversation. A gap the sender simply never filled (they stopped talking, or a
 * frame was dropped by the rate limit) is concealed once and then given up on.
 *
 * Pure, and tested in `scripts/voice-test.ts`. It holds payloads and knows
 * nothing about decoding them.
 */
import { VOICE_FRAME_MS, voiceSeqDelta } from '#shared/utils/voice'

/** Start here: three frames is 60 ms, which covers a normal hiccup without
 *  making the conversation feel remote. */
export const JITTER_TARGET_MS = 60
/** Never hold more than this. Past it the buffer skips to the newest frame. */
export const JITTER_MAX_MS = 400

export interface JitterBuffer {
  /** Frames waiting to play, keyed by sequence number. */
  held: Map<number, Uint8Array>
  /** The next sequence number to play, or null before the first pull. */
  next: number | null
  /** How many frames to have in hand before playback starts. */
  target: number
  /** Beyond this many held frames the buffer jumps forward. */
  ceiling: number
  /** Frames accepted. */
  received: number
  /** Gaps given up on and concealed. */
  lost: number
  /** Frames that arrived after their slot had already played, or were thrown away
   *  skipping a backlog. */
  late: number
}

export function createJitter(targetMs = JITTER_TARGET_MS, maxMs = JITTER_MAX_MS): JitterBuffer {
  return {
    held: new Map(),
    next: null,
    target: Math.max(1, Math.round(targetMs / VOICE_FRAME_MS)),
    ceiling: Math.max(2, Math.round(maxMs / VOICE_FRAME_MS)),
    received: 0,
    lost: 0,
    late: 0,
  }
}

export type JitterPush = 'held' | 'late' | 'duplicate'

/** Take one arriving frame. */
export function pushJitter(buffer: JitterBuffer, seq: number, payload: Uint8Array): JitterPush {
  if (buffer.next != null && voiceSeqDelta(buffer.next, seq) < 0) {
    buffer.late++
    return 'late'
  }
  if (buffer.held.has(seq)) return 'duplicate'
  buffer.held.set(seq, payload)
  buffer.received++
  return 'held'
}

/** What one pull produced. */
export interface JitterPull {
  /** The frame to decode, or null to conceal a gap. */
  payload: Uint8Array | null
  seq: number
}

/**
 * Take the next frame to play, or null when there is nothing to play yet.
 *
 * Null is the idle answer as well as the wait answer, and the caller treats both
 * the same: play nothing this slot. Silence between utterances is not a fault.
 */
export function pullJitter(buffer: JitterBuffer): JitterPull | null {
  if (!buffer.held.size) {
    // Nothing in hand. Forget where we were, so the next utterance starts with a
    // fresh delay rather than trying to fill the silence it left behind.
    if (buffer.next != null && buffer.held.size === 0) buffer.next = null
    return null
  }

  // Fill up before starting, so the first syllable is not immediately starved.
  if (buffer.next == null) {
    if (buffer.held.size < buffer.target) return null
    buffer.next = oldest(buffer)
  }

  // A backlog means a stall just cleared. Skip to the newest few frames rather
  // than playing minutes of catch-up at real speed.
  if (buffer.held.size > buffer.ceiling) {
    const keepFrom = newest(buffer) - buffer.target + 1
    for (const seq of [...buffer.held.keys()]) {
      if (voiceSeqDelta(keepFrom, seq) < 0) {
        buffer.held.delete(seq)
        buffer.late++
      }
    }
    buffer.next = oldest(buffer)
  }

  const seq = buffer.next
  const payload = buffer.held.get(seq)
  if (payload) {
    buffer.held.delete(seq)
    buffer.next = (seq + 1) % 0x10000
    return { payload, seq }
  }

  // A hole. Wait one slot for it unless there is already a queue behind it, in
  // which case it is not coming.
  if (buffer.held.size < buffer.target) return null
  buffer.lost++
  buffer.next = (seq + 1) % 0x10000
  return { payload: null, seq }
}

/** How much audio is waiting, in milliseconds. What `voice.debug()` reports. */
export function jitterMs(buffer: JitterBuffer): number {
  return buffer.held.size * VOICE_FRAME_MS
}

function oldest(buffer: JitterBuffer): number {
  let best: number | null = null
  for (const seq of buffer.held.keys()) {
    if (best == null || voiceSeqDelta(best, seq) < 0) best = seq
  }
  return best!
}

function newest(buffer: JitterBuffer): number {
  let best: number | null = null
  for (const seq of buffer.held.keys()) {
    if (best == null || voiceSeqDelta(best, seq) > 0) best = seq
  }
  return best!
}
