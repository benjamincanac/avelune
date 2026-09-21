/**
 * The second recording, the one that becomes a chat line.
 *
 * A push-to-talk utterance is captured twice: once as bare Opus frames for the
 * live audio, and once here into a container. That looks wasteful and is
 * deliberate. A transcription model wants a file, and the alternative is muxing
 * raw Opus packets into a WebM container on the server, which is a real amount of
 * code for something `MediaRecorder` does for free.
 *
 * Only push to talk is recorded. Open mic is never transcribed.
 */
import { MAX_CLIP_MS, MIN_CLIP_MS } from '#shared/utils/voice'

/** In order of preference. Opus in WebM is what Chromium writes natively. */
const TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

/** The container this browser will write, or null if it will not write any. */
export function clipMimeType(): string | null {
  if (import.meta.server || typeof MediaRecorder === 'undefined') return null
  for (const type of TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

export interface ClipRecorder {
  /** Start recording. A second call while already recording is ignored. */
  start: () => void
  /** Stop, and resolve with the clip, or null when there is nothing worth
   *  sending: too short to be a sentence, or empty. */
  stop: () => Promise<Blob | null>
  dispose: () => void
}

export function createClipRecorder(stream: MediaStream): ClipRecorder | null {
  const mimeType = clipMimeType()
  if (!mimeType) return null

  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let startedAt = 0
  /** Set when the hard cap stopped the recording rather than the player. */
  let capped: ReturnType<typeof setTimeout> | undefined
  /** The clip the cap produced, held until the key comes up and asks for it. */
  let cappedClip: Promise<Blob | null> | null = null

  function finish(): Promise<Blob | null> {
    const active = recorder
    if (!active || active.state === 'inactive') return Promise.resolve(null)
    const spoken = Date.now() - startedAt
    return new Promise((resolve) => {
      active.addEventListener('stop', () => {
        const parts = chunks
        chunks = []
        // A tap of the key is not an utterance, and an empty recording is not a
        // clip. Either way nothing is uploaded, so neither costs a model call.
        if (spoken < MIN_CLIP_MS || !parts.length) return resolve(null)
        const blob = new Blob(parts, { type: mimeType! })
        resolve(blob.size ? blob : null)
      }, { once: true })
      active.stop()
    })
  }

  return {
    start() {
      if (recorder && recorder.state !== 'inactive') return
      cappedClip = null
      chunks = []
      startedAt = Date.now()
      try {
        recorder = new MediaRecorder(stream, { mimeType })
      }
      catch {
        recorder = null
        return
      }
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data)
      })
      recorder.start()
      // The server caps this too, by bytes, but stopping here means a stuck key
      // does not upload a minute of a room. The first ten seconds are still the
      // line: they are kept for `stop`, not thrown away.
      capped = setTimeout(() => {
        cappedClip = finish()
      }, MAX_CLIP_MS)
    },
    async stop() {
      if (capped) clearTimeout(capped)
      capped = undefined
      const blob = await (cappedClip ?? finish())
      cappedClip = null
      recorder = null
      return blob
    },
    dispose() {
      if (capped) clearTimeout(capped)
      capped = undefined
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      }
      catch {
        // Already stopped.
      }
      recorder = null
      chunks = []
    },
  }
}
