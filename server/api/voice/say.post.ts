import { defineEventHandler, getCookie, getHeader, setResponseStatus } from 'h3'
import { MAX_CLIP_BYTES, isUsableTranscript, matchesSpokenScript, tidyTranscript } from '#shared/utils/voice'
import { COOKIE_NAME, verifyToken } from '../../utils/session'
import { hasLiveVoice, speakForIdentity } from '../../utils/game'
import { transcribeClip, transcriptionConfigured } from '../../utils/transcribe'

/**
 * `POST /api/voice/say`: one push-to-talk clip becomes one chat line.
 *
 * The clip is a separate recording from the live audio frames, deliberately: the
 * frames are bare Opus packets and a transcription model wants a container, so
 * the client records twice rather than making the server mux. The body is the
 * container bytes and nothing else.
 *
 * Nothing is stored here. The audio is held for the length of one model call and
 * then dropped, and the transcript is never logged. It goes in the chat, which is
 * the only place a player's words belong. The clip does leave the deployment for
 * that call, to a model that has no zero data retention on the Gateway (see
 * `../../utils/transcribe.ts`), which is why the menu's notice says so before
 * anybody speaks rather than promising the audio never goes anywhere.
 *
 * Every call costs money on a public demo, so the gates are tight: the signed
 * cookie, a live session with voice on, a byte cap, and a per-identity allowance
 * on both clip count and total audio.
 */

/** Clips per minute, per identity. A person speaks in sentences, not bursts. */
const CLIPS_PER_WINDOW = 6
const CLIP_WINDOW = 60_000
/** And a longer window on total audio, which is what the bill is actually in. */
const BYTES_PER_LONG_WINDOW = 6 * MAX_CLIP_BYTES
const LONG_WINDOW = 5 * 60_000

/** Containers the recorder is allowed to have produced. */
const ALLOWED_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']

interface Usage {
  /** When each clip in the short window landed. */
  clips: number[]
  /** `[at, bytes]` for each clip in the long window. */
  bytes: [number, number][]
}

/** Per identity, in process. A limit that resets with the instance is the same
 *  tradeoff the piece budget makes for the roster: good enough to stop a script,
 *  and not worth a store round trip on a voice clip. */
const usage = new Map<string, Usage>()

/**
 * Forget identities whose windows have run out.
 *
 * A map keyed by identity that is only ever added to is a slow leak on an
 * instance that stays warm for days, and a player who spoke once an hour ago is
 * indistinguishable from one who never has. Swept from `allow`, which is the
 * only thing that writes here and runs at most a handful of times a minute.
 */
function sweep(now: number): void {
  for (const [id, seen] of usage) {
    if (seen.clips.some(at => now - at < CLIP_WINDOW)) continue
    if (seen.bytes.some(([at]) => now - at < LONG_WINDOW)) continue
    usage.delete(id)
  }
}

function allow(id: string, size: number, now: number): boolean {
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

/**
 * Read the body, or give up the moment it goes past the cap.
 *
 * `arrayBuffer()` buffers whatever was sent and hands it over whole, so a size
 * check after it has already held the bytes in memory. A clip is a quarter of a
 * megabyte; this stops at that and cancels the stream, so an unbounded upload
 * costs the instance one chunk rather than all of them.
 */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  const stream = req.body
  // No stream to read: nothing was sent, which the caller reads as an empty clip.
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > cap) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.length
  }
  return body
}

export default defineEventHandler(async (event) => {
  const identity = verifyToken(getCookie(event, COOKIE_NAME))
  if (!identity) {
    setResponseStatus(event, 401)
    return { ok: false as const, reason: 'no character' }
  }
  if (!transcriptionConfigured()) {
    setResponseStatus(event, 503)
    return { ok: false as const, reason: 'not configured' }
  }
  // A clip can only have come from somebody holding the key in the arena, so a
  // caller with no live voice session is not one.
  if (!hasLiveVoice(identity.id)) {
    setResponseStatus(event, 409)
    return { ok: false as const, reason: 'not in the world' }
  }

  const type = (getHeader(event, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED_TYPES.includes(type)) {
    setResponseStatus(event, 415)
    return { ok: false as const, reason: 'unsupported audio' }
  }

  // The declared length first, so an obviously oversized body is refused without
  // reading a byte of it.
  const declared = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_CLIP_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false as const, reason: 'clip too long' }
  }

  const body = await readCapped(event.req, MAX_CLIP_BYTES)
  // Past the cap with nothing declared, which is what a chunked upload looks
  // like. The read stopped there rather than buffering the rest.
  if (!body) {
    setResponseStatus(event, 413)
    return { ok: false as const, reason: 'clip too long' }
  }
  if (!body.length) {
    setResponseStatus(event, 400)
    return { ok: false as const, reason: 'empty clip' }
  }
  if (!allow(identity.id, body.length, Date.now())) {
    setResponseStatus(event, 429)
    return { ok: false as const, reason: 'too many clips' }
  }

  // Dev only, and only when asked for: keep the clip so a bad transcript can be
  // replayed against other models. Never in a build, and never by default, since
  // this is somebody's voice on disk.
  if (import.meta.dev && process.env.AVELUNE_VOICE_DEBUG) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir('.data/voice-debug', { recursive: true })
    await writeFile(`.data/voice-debug/${Date.now()}.${type.split('/')[1] ?? 'bin'}`, body)
  }

  // A two letter code or nothing. It goes into a provider option, so it is
  // checked here rather than trusted.
  const hinted = (getHeader(event, 'x-voice-language') ?? '').trim().toLowerCase()
  const language = /^[a-z]{2}$/.test(hinted) ? hinted : undefined

  const raw = await transcribeClip(body, type, language)
  if (raw == null) {
    setResponseStatus(event, 502)
    return { ok: false as const, reason: 'could not transcribe' }
  }
  const text = tidyTranscript(raw)
  // Silence comes back as an empty string or as one of a handful of things these
  // models reliably hallucinate. Posting one would put words in a player's mouth.
  if (!isUsableTranscript(text) || !matchesSpokenScript(text, language)) return { ok: true as const, text: '' }
  // The same function typed chat uses: trim, cap, rate limit, broadcast, and the
  // Oracle's ear. It refuses if the player has been talking too fast.
  if (!speakForIdentity(identity.id, text)) return { ok: false as const, reason: 'slow down' }
  return { ok: true as const, text }
})
