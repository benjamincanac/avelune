/**
 * Opus in and out of the browser, through WebCodecs.
 *
 * The browser already ships an Opus encoder and decoder; `AudioEncoder` and
 * `AudioDecoder` are how you reach them without shipping a WASM build. That is
 * the whole reason voice costs nothing to download here, the same reason there is
 * not an audio file in the repo.
 *
 * It is also the reason voice is not available everywhere. WebCodecs audio is
 * Chromium only today, so support is feature-detected and the menu says so
 * plainly rather than failing quietly. There is deliberately no WASM fallback in
 * this pass.
 *
 * Nothing is encoded unless the player is talking. The encoder exists while the
 * mic is open, and the reader that feeds it stops the moment the key comes up, so
 * an idle player runs no codec at all.
 */
import { VOICE_BITRATE, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from '#shared/utils/voice'
import { createJitter, jitterMs, pullJitter, pushJitter } from './jitter'
import type { JitterBuffer } from './jitter'

/** WebCodecs and the capture path, neither of which is in the DOM lib yet. */
interface AudioEncoderCtor {
  new (init: { output: (chunk: EncodedAudioChunkLike) => void, error: (e: unknown) => void }): AudioEncoderLike
  isConfigSupported: (config: AudioCodecConfig) => Promise<{ supported?: boolean }>
}
interface AudioDecoderCtor {
  new (init: { output: (data: AudioDataLike) => void, error: (e: unknown) => void }): AudioDecoderLike
  isConfigSupported: (config: AudioCodecConfig) => Promise<{ supported?: boolean }>
}
interface AudioCodecConfig {
  codec: string
  sampleRate: number
  numberOfChannels: number
  bitrate?: number
  opus?: { frameDuration?: number, useinbandfec?: boolean, usedtx?: boolean }
}
interface AudioEncoderLike {
  state: string
  configure: (config: AudioCodecConfig) => void
  encode: (data: AudioDataLike) => void
  close: () => void
}
interface AudioDecoderLike {
  state: string
  configure: (config: AudioCodecConfig) => void
  decode: (chunk: EncodedAudioChunkLike) => void
  close: () => void
}
interface EncodedAudioChunkLike {
  byteLength: number
  copyTo: (target: Uint8Array) => void
}
interface EncodedAudioChunkCtor {
  new (init: { type: 'key' | 'delta', timestamp: number, duration?: number, data: Uint8Array | ArrayBuffer }): EncodedAudioChunkLike
}
interface AudioDataLike {
  numberOfFrames: number
  numberOfChannels: number
  sampleRate: number
  copyTo: (target: Float32Array<ArrayBuffer>, options: { planeIndex: number, format?: string }) => void
  close: () => void
}
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<AudioDataLike> }
}

interface CodecGlobals {
  AudioEncoder?: AudioEncoderCtor
  AudioDecoder?: AudioDecoderCtor
  EncodedAudioChunk?: EncodedAudioChunkCtor
  MediaStreamTrackProcessor?: TrackProcessorCtor
}

function globals(): CodecGlobals {
  return (import.meta.client ? window : {}) as unknown as CodecGlobals
}

const CONFIG: AudioCodecConfig = {
  codec: 'opus',
  sampleRate: VOICE_SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: VOICE_BITRATE,
  opus: {
    frameDuration: VOICE_FRAME_MS * 1000,
    // In-band forward error correction and discontinuous transmission, where the
    // browser offers them: the first costs a few bytes and survives a dropped
    // frame, the second sends almost nothing through a silence.
    useinbandfec: true,
    usedtx: true,
  },
}

/**
 * Whether this browser can carry voice at all.
 *
 * Asks the encoder itself rather than sniffing a user agent, and the answer is
 * cached because the menu reads it on every render. `MediaStreamTrackProcessor`
 * is checked too: an encoder with no way to feed it is no use.
 */
let supported: boolean | null = null
export async function voiceSupported(): Promise<boolean> {
  if (supported != null) return supported
  const { AudioEncoder, AudioDecoder, EncodedAudioChunk, MediaStreamTrackProcessor } = globals()
  if (!AudioEncoder || !AudioDecoder || !EncodedAudioChunk || !MediaStreamTrackProcessor) {
    supported = false
    return false
  }
  try {
    const [encode, decode] = await Promise.all([
      AudioEncoder.isConfigSupported(CONFIG),
      AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 }),
    ])
    supported = encode.supported !== false && decode.supported !== false
  }
  catch {
    supported = false
  }
  return supported
}

/** What the detection last decided, without asking again. Null before the first
 *  `voiceSupported()`. */
export function voiceSupportedSync(): boolean | null {
  return supported
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

export interface VoiceCapture {
  /** Start or stop encoding. Stopping drops the reader, so an idle player runs
   *  no codec and sends no bytes. */
  setTalking: (on: boolean) => void
  dispose: () => void
}

/**
 * Read the microphone and hand out Opus packets.
 *
 * `MediaStreamTrackProcessor` gives the mic as a stream of `AudioData`, which is
 * exactly what `AudioEncoder` eats, so there is no worklet and no manual
 * resampling in the path. The track is already mono at the context's rate because
 * `getUserMedia` was asked for that.
 */
export function createVoiceCapture(stream: MediaStream, onPacket: (payload: Uint8Array) => void): VoiceCapture | null {
  const { AudioEncoder, MediaStreamTrackProcessor } = globals()
  const track = stream.getAudioTracks()[0]
  if (!AudioEncoder || !MediaStreamTrackProcessor || !track) return null

  let encoder: AudioEncoderLike | null = null
  try {
    encoder = new AudioEncoder({
      output(chunk) {
        const payload = new Uint8Array(chunk.byteLength)
        chunk.copyTo(payload)
        onPacket(payload)
      },
      error(error) {
        console.error('[voice] encoder', error)
      },
    })
    encoder.configure(CONFIG)
  }
  catch (error) {
    console.error('[voice] encoder unavailable', error)
    encoder?.close()
    return null
  }

  let reader: ReadableStreamDefaultReader<AudioDataLike> | null = null
  let talking = false
  let disposed = false

  async function pump() {
    const processor = new MediaStreamTrackProcessor!({ track: track! })
    reader = processor.readable.getReader()
    const current = reader
    try {
      while (!disposed && talking) {
        const { done, value } = await current.read()
        if (done || !value) break
        // The check is repeated inside the loop on purpose: a key release during
        // an await must not encode one more frame.
        if (talking && encoder?.state === 'configured') encoder.encode(value)
        value.close()
      }
    }
    catch {
      // The track ended, or the reader was cancelled by the release below.
    }
    finally {
      if (reader === current) reader = null
      void current.cancel().catch(() => {})
    }
  }

  return {
    setTalking(on) {
      if (disposed || on === talking) return
      talking = on
      if (on) void pump()
      else void reader?.cancel().catch(() => {})
    },
    dispose() {
      if (disposed) return
      disposed = true
      talking = false
      void reader?.cancel().catch(() => {})
      try {
        encoder?.close()
      }
      catch {
        // Already closed.
      }
      encoder = null
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                   */
/* -------------------------------------------------------------------------- */

export interface VoicePlayback {
  /** Take one arriving frame. */
  push: (seq: number, payload: Uint8Array) => void
  /** The node to hang on the voice bus. */
  output: AudioNode
  /** For `voice.debug()`. */
  stats: () => { framesIn: number, lost: number, late: number, bufferMs: number }
  dispose: () => void
}

/**
 * Decode one talker into a node.
 *
 * Decoded frames are scheduled as back-to-back `AudioBufferSourceNode`s on a
 * playhead this keeps, which is sample accurate as long as the playhead stays
 * ahead of the context clock. When it falls behind, because the tab was throttled
 * or a stall just cleared, it is reset ahead rather than allowed to schedule in the
 * past, where the browser would fire everything at once.
 *
 * A concealed gap replays the previous frame at reduced level, which is what
 * every Opus implementation does with a lost packet: it sounds like a rough edge
 * rather than a click. Two gaps in a row go silent instead, because a repeated
 * syllable is worse than a pause.
 */
export function createVoicePlayback(ctx: AudioContext): VoicePlayback | null {
  const { AudioDecoder, EncodedAudioChunk } = globals()
  const output = ctx.createGain()
  output.gain.value = 1
  if (!AudioDecoder || !EncodedAudioChunk) return null

  const buffer: JitterBuffer = createJitter()
  let playAt = 0
  let timestamp = 0
  /** The last decoded frame, for concealment. */
  let last: Float32Array<ArrayBuffer> | null = null
  let concealed = 0
  let disposed = false
  /** Frames handed to the decoder that have not come back yet. They are audio
   *  already on its way to the playhead, so the pull loop counts them. */
  let inFlight = 0
  /** When the decoder last answered, so a frame it swallowed cannot hold the
   *  count up and starve the loop. */
  let answeredAt = 0

  let decoder: AudioDecoderLike | null = null
  try {
    decoder = new AudioDecoder({
      output(data) {
        inFlight = Math.max(0, inFlight - 1)
        answeredAt = ctx.currentTime
        schedule(data)
        data.close()
      },
      error(error) {
        console.error('[voice] decoder', error)
      },
    })
    decoder.configure({ codec: 'opus', sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 })
  }
  catch (error) {
    console.error('[voice] decoder unavailable', error)
    decoder?.close()
    return null
  }

  function play(samples: Float32Array<ArrayBuffer>, rate: number) {
    const audio = ctx.createBuffer(1, samples.length, rate)
    audio.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    source.buffer = audio
    source.connect(output)
    // Scheduling in the past makes the browser play everything it has at once, so
    // the playhead is nudged forward instead. One frame of slack is enough for
    // normal drift; a bigger gap means the tab was asleep.
    const now = ctx.currentTime
    if (playAt < now + VOICE_FRAME_MS / 2000) playAt = now + VOICE_FRAME_MS / 1000
    source.start(playAt)
    playAt += audio.duration
  }

  function schedule(data: AudioDataLike) {
    const samples = new Float32Array(data.numberOfFrames)
    try {
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
    }
    catch {
      return
    }
    last = samples
    concealed = 0
    play(samples, data.sampleRate)
  }

  function conceal() {
    if (!last || concealed >= 1) {
      // Second gap running: let it be quiet.
      concealed++
      playAt += VOICE_FRAME_MS / 1000
      return
    }
    concealed++
    const faded = new Float32Array(last.length)
    for (let i = 0; i < faded.length; i++) faded[i] = last[i]! * 0.5
    play(faded, VOICE_SAMPLE_RATE)
  }

  /** How far ahead of the context clock playback is kept scheduled. */
  const LEAD = 0.1
  /** How often the loop looks. Well under `LEAD`, so a late tick costs nothing. */
  const PULL_INTERVAL = 10
  /** The most frames one look may take, so a long sleep cannot flood the decoder. */
  const PULL_BURST = 12

  /** Seconds of audio scheduled or decoding beyond the context clock. */
  function lead(): number {
    return Math.max(0, playAt - ctx.currentTime) + inFlight * (VOICE_FRAME_MS / 1000)
  }

  /**
   * The pull loop, paced by the audio clock rather than by counting ticks.
   *
   * A timer that takes one frame per 20 ms tick plays slower than real time: every
   * tick lands a little late, a busy render frame delays several, and an interval
   * never catches up. Frames then arrive faster than they leave, the backlog
   * climbs to the ceiling, and the buffer throws a third of a second away, over
   * and over. So each look takes however many frames it needs to keep `LEAD` of
   * audio ahead of `ctx.currentTime`, which is the only clock playback runs on.
   */
  const timer = setInterval(() => {
    if (disposed) return
    if (inFlight && ctx.currentTime - answeredAt > 0.5) inFlight = 0
    for (let taken = 0; taken < PULL_BURST && lead() < LEAD; taken++) {
      const pull = pullJitter(buffer)
      if (!pull) return
      if (!pull.payload) {
        conceal()
        continue
      }
      if (decoder?.state !== 'configured') return
      try {
        decoder.decode(new EncodedAudioChunk!({
          type: 'key',
          timestamp,
          duration: VOICE_FRAME_MS * 1000,
          data: pull.payload,
        }))
        if (!inFlight) answeredAt = ctx.currentTime
        inFlight++
        timestamp += VOICE_FRAME_MS * 1000
      }
      catch {
        // A malformed payload. The next frame is unaffected.
      }
    }
  }, PULL_INTERVAL)

  return {
    push(seq, payload) {
      if (!disposed) pushJitter(buffer, seq, payload)
    },
    output,
    stats: () => ({
      framesIn: buffer.received,
      lost: buffer.lost,
      late: buffer.late,
      bufferMs: jitterMs(buffer),
    }),
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      buffer.held.clear()
      try {
        decoder?.close()
      }
      catch {
        // Already closed.
      }
      decoder = null
      last = null
      try {
        output.disconnect()
      }
      catch {
        // Context gone.
      }
    },
  }
}
