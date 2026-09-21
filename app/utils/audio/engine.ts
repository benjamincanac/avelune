/**
 * The audio engine: one `AudioContext`, two buses and a voice budget.
 *
 * Every sound in Avelune is synthesized here and now. There are no audio files
 * in the repo and there should not be: a noise buffer through a filter with an
 * envelope is a footstep, costs nothing to download and carries no licence. A
 * sound is named (`play('footstep')`), so a sample can replace a node graph
 * later without touching a single call site.
 *
 * Like `critters.ts` this is a **client-side cosmetic**. Nothing here reaches
 * the wire, nothing enters `shared/` state, and no sound can move a player.
 * Two clients standing in the same meadow hear the same weather and the same
 * lightning, because both are derived from the server clock, and different
 * birds, because those are local decoration.
 *
 * Browsers refuse to start a context before a gesture, so nothing is created
 * until `unlockAudio()` is called from a real click or key. Every entry point
 * below is a no-op before that, which is what keeps the console free of
 * autoplay warnings.
 */

/** A point in world space. The scene already has these as three.js vectors,
 *  which satisfy this shape. */
export interface AudioPoint {
  x: number
  y: number
  z: number
}

export type AudioBus = 'world' | 'ui'

export interface PlayOptions {
  /** Linear gain, 1 being the sound's own natural level. */
  gain?: number
  /** Playback rate or pitch multiplier, depending on the sound. */
  rate?: number
  /** World position. Omitted means the sound plays flat on the bus, which is
   *  what the local player's own feet and the whole UI want. */
  position?: AudioPoint
  /** Which surface the feet are on, for `footstep`. */
  surface?: FootSurface
  /** How hard the sound landed, 0 to 1, for `land` and `splash`. */
  force?: number
}

/** The ground families a footstep can be on. Mapped from the shared `SURFACE`
 *  raster in `footsteps.ts`. */
export type FootSurface = 'grass' | 'dirt' | 'stone' | 'sand' | 'path' | 'water' | 'snow'

/** How many positioned or flat one-shots may sound at once. Thirty bots running
 *  past would otherwise be a hundred voices and a mush. */
const MAX_VOICES = 24

/** Beyond this the world is silent. Distance attenuation does most of the work,
 *  but a voice that is never going to be heard should not be built at all. */
export const AUDIBLE_RADIUS = 46

interface Engine {
  ctx: AudioContext
  master: GainNode
  world: GainNode
  ui: GainNode
  /** Other players' voices. Its own bus so speech can sit above or below the
   *  world without touching either of the other two. */
  voice: GainNode
  analyser: AnalyserNode
  noise: AudioBuffer
  samples: Float32Array<ArrayBuffer>
}

let engine: Engine | null = null
let failed = false
let volume = 0.7
let muted = false
let voiceVolume = 1
let voices = 0
const played: Record<string, number> = {}

/* -------------------------------------------------------------------------- */
/* The context                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create the context, or resume it if the browser parked it. Safe to call on
 * every gesture: the second call onward is a resume at most.
 */
export function unlockAudio(): void {
  if (failed || import.meta.server) return
  if (!engine) engine = build()
  if (!engine) return
  if (engine.ctx.state !== 'running') void engine.ctx.resume().catch(() => {})
}

function build(): Engine | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    failed = true
    return null
  }
  let ctx: AudioContext
  try {
    ctx = new Ctor({ latencyHint: 'interactive' })
  }
  catch {
    failed = true
    return null
  }

  // A limiter on the master, because stacked voices do add up: a dozen bots
  // landing on paving at once used to clip. Slow release so it never pumps.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -12
  limiter.knee.value = 12
  limiter.ratio.value = 6
  limiter.attack.value = 0.004
  limiter.release.value = 0.22

  const master = ctx.createGain()
  master.gain.value = muted ? 0 : volume

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6

  master.connect(limiter)
  limiter.connect(analyser)
  analyser.connect(ctx.destination)

  const world = ctx.createGain()
  world.gain.value = 1
  world.connect(master)

  // The interface sits under the world, not over it. Its job is confirmation,
  // not attention.
  const ui = ctx.createGain()
  ui.gain.value = 0.5
  ui.connect(master)

  // Speech carries further than the world does and a person deserves to be
  // heard over the wind, so it gets its own level rather than riding `world`.
  const voice = ctx.createGain()
  voice.gain.value = voiceVolume
  voice.connect(master)

  // Two seconds of white noise, shared by every voice that needs a hiss. One
  // buffer, read at different rates and through different filters, is most of
  // the sound design here.
  const length = Math.floor(ctx.sampleRate * 2)
  const noise = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1

  const listener = ctx.listener
  if (listener.forwardZ) {
    listener.forwardX.value = 0
    listener.forwardY.value = 0
    listener.forwardZ.value = -1
    listener.upX.value = 0
    listener.upY.value = 1
    listener.upZ.value = 0
  }

  return { ctx, master, world, ui, voice, analyser, noise, samples: new Float32Array(analyser.fftSize) }
}

/** The live engine, or null before the first gesture. */
export function audioEngine(): Engine | null {
  return engine
}

export function setAudioVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value))
  applyLevel()
}

export function setAudioMuted(value: boolean): void {
  muted = value
  applyLevel()
}

/**
 * The voice bus level, 0 to 2. Above 1 on purpose: a quiet talker on a windy
 * hill needs to be able to come up over the world, and the master limiter is
 * already there to catch the sum.
 */
export function setVoiceVolume(value: number): void {
  voiceVolume = Math.max(0, Math.min(2, value))
  if (!engine) return
  engine.voice.gain.setTargetAtTime(voiceVolume, engine.ctx.currentTime, 0.04)
}

/** The bus remote voices hang off, or null before the first gesture. */
export function voiceBus(): { ctx: AudioContext, bus: GainNode } | null {
  return engine ? { ctx: engine.ctx, bus: engine.voice } : null
}

function applyLevel(): void {
  if (!engine) return
  const target = muted ? 0 : volume
  const gain = engine.master.gain
  const t = engine.ctx.currentTime
  gain.cancelScheduledValues(t)
  gain.setTargetAtTime(target, t, 0.04)
}

/**
 * Pull the world down under the interface. The Escape menu uses this rather
 * than suspending the context, because the menu's own slider has to be audible
 * while you drag it.
 */
export function setWorldDucked(ducked: boolean): void {
  if (!engine) return
  engine.world.gain.setTargetAtTime(ducked ? 0.25 : 1, engine.ctx.currentTime, 0.08)
}

/** Park the context. Used when the tab is hidden. */
export function suspendAudio(): void {
  if (engine && engine.ctx.state === 'running') void engine.ctx.suspend().catch(() => {})
}

/** Resume a parked context without creating one. */
export function resumeAudio(): void {
  if (engine && engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {})
}

/** Tear the whole thing down. The scene calls this from its cleanup. */
export function closeAudio(): void {
  const live = engine
  engine = null
  voices = 0
  if (!live) return
  try {
    live.master.disconnect()
    live.world.disconnect()
    live.ui.disconnect()
    live.voice.disconnect()
  }
  catch {
    // Already gone. Closing is the only thing that matters.
  }
  void live.ctx.close().catch(() => {})
}

/* -------------------------------------------------------------------------- */
/* The listener                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Point the listener where the camera looks. Called once a frame from the
 * render loop, after the camera has moved, so panning agrees with the view.
 */
export function setAudioListener(position: AudioPoint, forward: AudioPoint, up: AudioPoint): void {
  const live = engine
  if (!live || live.ctx.state !== 'running') return
  const listener = live.ctx.listener
  const t = live.ctx.currentTime
  if (listener.positionX) {
    // A short ramp rather than a set: a camera that snaps would click.
    listener.positionX.setTargetAtTime(position.x, t, 0.02)
    listener.positionY.setTargetAtTime(position.y, t, 0.02)
    listener.positionZ.setTargetAtTime(position.z, t, 0.02)
    listener.forwardX.setTargetAtTime(forward.x, t, 0.02)
    listener.forwardY.setTargetAtTime(forward.y, t, 0.02)
    listener.forwardZ.setTargetAtTime(forward.z, t, 0.02)
    listener.upX.setTargetAtTime(up.x, t, 0.02)
    listener.upY.setTargetAtTime(up.y, t, 0.02)
    listener.upZ.setTargetAtTime(up.z, t, 0.02)
    return
  }
  // Safari still only has the deprecated pair.
  const legacy = listener as AudioListener & {
    setPosition?: (x: number, y: number, z: number) => void
    setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void
  }
  legacy.setPosition?.(position.x, position.y, position.z)
  legacy.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z)
}

/** Where the listener was put last frame, so a sound can cull itself before it
 *  builds a graph nobody would hear. */
const listenerAt = { x: 0, y: 0, z: 0 }

export function rememberListener(position: AudioPoint): void {
  listenerAt.x = position.x
  listenerAt.y = position.y
  listenerAt.z = position.z
}

export function distanceToListener(position: AudioPoint): number {
  const dx = position.x - listenerAt.x
  const dy = position.y - listenerAt.y
  const dz = position.z - listenerAt.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/* -------------------------------------------------------------------------- */
/* Voices                                                                     */
/* -------------------------------------------------------------------------- */

export interface Voice {
  ctx: AudioContext
  /** Connect the tail of the graph here. */
  input: GainNode
  /** Context time this voice starts at. */
  t: number
  /** Release the voice at this context time. Call it exactly once. */
  end: (at: number) => void
}

/**
 * Claim a voice. Returns null when the context is not running, the budget is
 * spent, or the sound is positioned too far away to matter.
 */
export function startVoice(bus: AudioBus, options: PlayOptions = {}): Voice | null {
  const live = engine
  if (!live || live.ctx.state !== 'running') return null
  if (voices >= MAX_VOICES) return null
  const position = options.position
  if (position && distanceToListener(position) > AUDIBLE_RADIUS) return null

  const ctx = live.ctx
  const input = ctx.createGain()
  input.gain.value = options.gain ?? 1

  let tail: AudioNode = input
  if (position) {
    const panner = ctx.createPanner()
    // Equal power rather than HRTF: thirty bots is thirty convolutions with
    // HRTF, and the extra realism is inaudible over a wind bed anyway.
    panner.panningModel = 'equalpower'
    panner.distanceModel = 'inverse'
    panner.refDistance = 2.5
    panner.maxDistance = AUDIBLE_RADIUS
    panner.rolloffFactor = 1.1
    panner.positionX.value = position.x
    panner.positionY.value = position.y
    panner.positionZ.value = position.z
    input.connect(panner)
    tail = panner
  }
  tail.connect(bus === 'ui' ? live.ui : live.world)

  voices++
  let ended = false
  return {
    ctx,
    input,
    t: ctx.currentTime,
    end(at: number) {
      if (ended) return
      ended = true
      const wait = Math.max(0, at - ctx.currentTime) * 1000 + 60
      window.setTimeout(() => {
        voices = Math.max(0, voices - 1)
        try {
          input.disconnect()
          if (tail !== input) tail.disconnect()
        }
        catch {
          // The context went away under us. Nothing left to free.
        }
      }, wait)
    },
  }
}

/** The two seconds of noise every hiss in the game is read out of. One buffer,
 *  played at different rates through different filters, is most of the sound
 *  design here. */
export function noiseBuffer(): AudioBuffer | null {
  return engine?.noise ?? null
}

/** A percussive envelope: silence, a fast rise, an exponential tail. */
export function envelope(param: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  param.cancelScheduledValues(t)
  param.setValueAtTime(0.0001, t)
  param.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack)
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay)
}

/* -------------------------------------------------------------------------- */
/* Beds                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A continuous voice. Built once and left running for the session, with its
 * gain and filter ramped instead of being rebuilt, because a bed that is torn
 * down and recreated is an audible click every time the weather nudges.
 */
export interface Bed {
  gain: GainNode
  filter: BiquadFilterNode
  source: AudioBufferSourceNode
  panner: PannerNode | null
  /** Ease the bed's level. */
  level: (value: number, seconds?: number) => void
  dispose: () => void
}

export interface BedOptions {
  type?: BiquadFilterType
  frequency?: number
  q?: number
  rate?: number
  position?: AudioPoint
  /** Rolloff for a positioned bed, which usually wants a tighter one than a
   *  one-shot so the fountain does not follow you across the square. */
  refDistance?: number
  maxDistance?: number
}

export function createBed(options: BedOptions = {}): Bed | null {
  const live = engine
  if (!live) return null
  const ctx = live.ctx
  const source = live.ctx.createBufferSource()
  source.buffer = live.noise
  source.loop = true
  source.playbackRate.value = options.rate ?? 1

  const filter = ctx.createBiquadFilter()
  filter.type = options.type ?? 'bandpass'
  filter.frequency.value = options.frequency ?? 500
  filter.Q.value = options.q ?? 0.7

  const gain = ctx.createGain()
  gain.gain.value = 0

  source.connect(filter)
  filter.connect(gain)

  let panner: PannerNode | null = null
  if (options.position) {
    panner = ctx.createPanner()
    panner.panningModel = 'equalpower'
    panner.distanceModel = 'inverse'
    panner.refDistance = options.refDistance ?? 4
    panner.maxDistance = options.maxDistance ?? AUDIBLE_RADIUS
    panner.rolloffFactor = 1.4
    panner.positionX.value = options.position.x
    panner.positionY.value = options.position.y
    panner.positionZ.value = options.position.z
    gain.connect(panner)
    panner.connect(live.world)
  }
  else {
    gain.connect(live.world)
  }

  try {
    source.start(ctx.currentTime + Math.random() * 0.4)
  }
  catch {
    return null
  }

  return {
    gain,
    filter,
    source,
    panner,
    level(value, seconds = 0.8) {
      gain.gain.setTargetAtTime(Math.max(0, value), ctx.currentTime, Math.max(0.02, seconds / 3))
    },
    dispose() {
      try {
        source.stop()
        source.disconnect()
        filter.disconnect()
        gain.disconnect()
        panner?.disconnect()
      }
      catch {
        // The context closed first.
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Debug                                                                      */
/* -------------------------------------------------------------------------- */

export function countPlayed(name: string): void {
  played[name] = (played[name] ?? 0) + 1
}

export interface AudioDebug {
  state: AudioContextState | 'none'
  volume: number
  muted: boolean
  voices: number
  played: Record<string, number>
  rms: number
}

/**
 * The dev hook behind `window.__maze.audio.debug()`. `rms` is measured on the
 * master after the limiter, so a headed run can assert that walking makes
 * sound and that muting really silences it rather than only hiding a slider.
 */
export function audioDebug(): AudioDebug {
  const live = engine
  if (!live) {
    return { state: 'none', volume, muted, voices, played: { ...played }, rms: 0 }
  }
  live.analyser.getFloatTimeDomainData(live.samples)
  let sum = 0
  for (const sample of live.samples) sum += sample * sample
  return {
    state: live.ctx.state,
    volume,
    muted,
    voices,
    played: { ...played },
    rms: Math.sqrt(sum / live.samples.length),
  }
}
