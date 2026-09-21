import { NoTranscriptGeneratedError, createGateway, transcribe } from 'ai'
import { nativeFetch } from './nativeFetch'

/**
 * Speech to text for push-to-talk lines.
 *
 * A player holding the talk key is recorded a second time, into a container, and
 * that clip comes here on release. What comes back is a chat line like any other,
 * which is the whole design: the Oracle's classifier reads a spoken sentence with
 * no idea it was spoken.
 *
 * Only push-to-talk is transcribed. Open mic is not, and never will be: a model
 * call per utterance on an always-on microphone is both a bill and a way to fill
 * the chat with half-heard room noise.
 */

/**
 * Chosen by measurement, on clips the browser really uploaded. With speech
 * starting right after the key press, this was the only family that got the
 * sentence right every time, and it was also the quickest, at about 0.7 to 1.9 s.
 * `spacexai/grok-stt` heard "Grok, what time", `openai/whisper-1` heard "what
 * time is Dave", `google/gemini-3.5-transcribe` heard "Michael", and
 * `fish-audio/transcribe-1` cannot decode WebM at all. It does not train on what
 * it is given. It has no zero data retention on the Gateway, which the model
 * below does, and that is the trade made here for being understood.
 */
const MODEL = 'openai/gpt-4o-mini-transcribe'
/** Used only when the model above refuses the request. A different provider on
 *  purpose, so one outage does not take speech to chat down with it. */
const FALLBACK_MODEL = 'spacexai/grok-stt'

/** A clip is a sentence. Anything slower than this is a failure, not a wait. */
const TIMEOUT_MS = 12_000

// Pinned to the real fetch for the same reason the Oracle's provider is: once a
// warm instance has rendered any page, `globalThis.fetch` is Nuxt's loopback and
// would answer a Gateway call with our own 404 page (see ./nativeFetch.ts). A
// bare string model id would resolve through that poisoned default, so the model
// has to come off this provider.
const gateway = createGateway({ fetch: nativeFetch })

/** Whether the feature can work at all. Without a key the toggle says so rather
 *  than failing on every clip. */
export function transcriptionConfigured(): boolean {
  return !!process.env.AI_GATEWAY_API_KEY || !!process.env.VERCEL_OIDC_TOKEN
}

/**
 * Transcribe one clip, or return null.
 *
 * Null covers every failure the same way on purpose: the caller's answer to a
 * refused clip and to a model outage is identical, and a player does not need to
 * know which it was. Nothing here logs the transcript. The chat log is the only
 * place a player's words belong.
 */
export async function transcribeClip(audio: Uint8Array, mediaType: string, language?: string): Promise<string | null> {
  for (const id of [MODEL, FALLBACK_MODEL]) {
    try {
      const result = await transcribe({
        model: gateway.transcription(id),
        audio,
        // The container is not always sniffable from the bytes, and the recorder
        // already knows what it wrote.
        providerOptions: {
          gateway: { mediaType },
          // The player's browser language, as a hint. It reaches OpenAI's models
          // through the Gateway (a wrong one makes Whisper translate), and the
          // others take no such option.
          ...(language && id.startsWith('openai/') ? { openai: { language } } : {}),
        },
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return result.text
    }
    catch (error) {
      // Not a failure: this is how a model says the clip held no speech. The key
      // was held over silence. Falling through to the next model would pay for a
      // second call, and Whisper answers silence with an invented "you".
      if (NoTranscriptGeneratedError.isInstance(error)) return ''
      console.error(`[voice] transcribe failed on ${id}:`, error instanceof Error ? error.message : error)
    }
  }
  return null
}
