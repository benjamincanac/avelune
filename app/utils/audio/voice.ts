/**
 * Other players' voices, in the world rather than in your headphones.
 *
 * A remote voice is one source into one `PannerNode` placed at that player's
 * rendered rig every frame, into the engine's dedicated voice bus. That is the
 * whole graph: the same listener the footsteps and the weather use is already
 * pointed where the camera looks, so speech pans and fades with the view without
 * anything here knowing about the camera.
 *
 * The rolloff is linear and ends exactly at the distance the server drops a
 * pair, so a peer walking out of range fades to nothing and the connection
 * closing is inaudible. An inverse curve would still be audible at the drop
 * radius and the cut would be heard as a click.
 *
 * Nothing here is a transport. It takes a `MediaStream` or a plain `AudioNode`
 * and does not care which produced it.
 */
import { VOICE_DROP_RANGE } from '#shared/utils/voice'
import type { AudioPoint } from './engine'
import { voiceBus } from './engine'

/** Closer than this a voice is at full level, as if they were beside you. */
const VOICE_REF_DISTANCE = 2.5

/** Window the inbound meter measures over. Short enough to track a syllable. */
const METER_FFT = 512

export interface VoiceSink {
  /** Move the voice to where that player's rig is drawn. Called every frame. */
  setPosition: (point: AudioPoint) => void
  /** Inbound RMS, 0 to 1. This is what drives the talking indicator and the dev
   *  hook's `level`.
   *  Derived here rather than sent on the wire: it costs nothing and the client
   *  hearing the audio is the only one that can measure it honestly. */
  level: () => number
  dispose: () => void
}

/**
 * Build the sink for one peer.
 *
 * KNOWN CHROME BUG: a remote `MediaStream` routed only through Web Audio is
 * silent. The stream also has to be attached to an `<audio>` element for Chrome
 * to pull frames off it at all, and that element is muted so the graph stays the
 * only thing you hear. The element is not in the document; holding the reference
 * is enough.
 */
export function createVoiceSink(source: MediaStream | AudioNode): VoiceSink | null {
  const live = voiceBus()
  if (!live) return null
  const { ctx, bus } = live

  let sink: HTMLAudioElement | null = null
  let input: AudioNode
  if (source instanceof MediaStream) {
    try {
      sink = new Audio()
      sink.srcObject = source
      sink.muted = true
      sink.autoplay = true
      void sink.play().catch(() => {})
    }
    catch {
      // No element constructor here (a test environment). The graph below still
      // works everywhere that is not Chrome.
      sink = null
    }
    input = ctx.createMediaStreamSource(source)
  }
  else {
    input = source
  }

  const analyser = ctx.createAnalyser()
  analyser.fftSize = METER_FFT
  analyser.smoothingTimeConstant = 0.4
  const samples = new Float32Array(analyser.fftSize)

  const panner = ctx.createPanner()
  panner.panningModel = 'equalpower'
  // Linear, so the level is genuinely zero at the radius the server drops the
  // pair at. See the note at the top of the file.
  panner.distanceModel = 'linear'
  panner.refDistance = VOICE_REF_DISTANCE
  panner.maxDistance = VOICE_DROP_RANGE
  panner.rolloffFactor = 1

  input.connect(analyser)
  analyser.connect(panner)
  panner.connect(bus)

  let disposed = false
  return {
    setPosition(point) {
      if (disposed) return
      const t = ctx.currentTime
      panner.positionX.setTargetAtTime(point.x, t, 0.05)
      panner.positionY.setTargetAtTime(point.y, t, 0.05)
      panner.positionZ.setTargetAtTime(point.z, t, 0.05)
    },
    level() {
      if (disposed) return 0
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      return Math.sqrt(sum / samples.length)
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        input.disconnect()
        analyser.disconnect()
        panner.disconnect()
      }
      catch {
        // The context closed under us; there is nothing left to free.
      }
      if (sink) {
        sink.pause()
        sink.srcObject = null
        sink = null
      }
    },
  }
}

export interface LevelMeter {
  level: () => number
  dispose: () => void
}

/**
 * A meter on the local microphone, for the "you are transmitting" indicator.
 *
 * It reads the mic whether or not the track is enabled, which is what makes it
 * useful: push-to-talk enables the track, and this says whether anything is
 * actually going down it.
 */
export function createLevelMeter(stream: MediaStream): LevelMeter | null {
  const live = voiceBus()
  if (!live) return null
  const { ctx } = live
  const input = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = METER_FFT
  analyser.smoothingTimeConstant = 0.4
  const samples = new Float32Array(analyser.fftSize)
  input.connect(analyser)
  // Deliberately not connected onward: hearing your own voice back is the one
  // thing nobody wants.

  let disposed = false
  return {
    level() {
      if (disposed) return 0
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      return Math.sqrt(sum / samples.length)
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        input.disconnect()
        analyser.disconnect()
      }
      catch {
        // Context already gone.
      }
    },
  }
}
