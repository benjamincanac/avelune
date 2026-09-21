import type { FootSurface, PlayOptions, Voice } from './engine'
import { countPlayed, envelope, noiseBuffer, startVoice } from './engine'

/**
 * The named one-shots.
 *
 * Every sound is a handful of nodes built for the hit and thrown away after it.
 * They are deliberately small: a noise buffer through one filter with one
 * envelope is what a footstep actually sounds like, and the cheapest thing that
 * does is also the thing that survives thirty bots running past.
 *
 * Adding a sound means adding an entry to `SOUNDS`. Replacing a synthesized one
 * with a sample later means changing that entry and nothing else, which is the
 * whole reason call sites say `play('footstep')` instead of wiring nodes.
 */

export type SoundName
  = | 'footstep'
    | 'jump'
    | 'land'
    | 'dash'
    | 'splash'
    | 'swim'
    | 'thunder'
    | 'bird'
    | 'oracle'
    | 'critter'
    | 'arm'
    | 'place'
    | 'remove'
    | 'refuse'
    | 'menu'

/** Ground timbres. `freq` and `q` shape the grain, `decay` its length, and
 *  `thump` adds a low body for the surfaces that have one. */
interface FootTone {
  freq: number
  q: number
  decay: number
  gain: number
  /** Frequency of the low body under the grain, if any. */
  thump?: number
  /** Extra grains, spaced by `grainGap`, for a surface that crunches. */
  grains?: number
}

const FOOT: Record<FootSurface, FootTone> = {
  // Soft and brushy, no impact under it. It sits well under the hard surfaces:
  // a wide band around 2 kHz is where the ear is keenest, and grass is the
  // ground most of the world is made of, so at their level it was all you heard.
  grass: { freq: 1700, q: 0.5, decay: 0.1, gain: 0.2 },
  dirt: { freq: 760, q: 0.8, decay: 0.07, gain: 0.55, thump: 92 },
  // A hard tick: narrow, bright and over immediately.
  stone: { freq: 3300, q: 1.6, decay: 0.035, gain: 0.5, thump: 150 },
  path: { freq: 3000, q: 1.4, decay: 0.04, gain: 0.48, thump: 140 },
  sand: { freq: 3800, q: 0.45, decay: 0.13, gain: 0.26 },
  // Three grains a few milliseconds apart is what reads as a crunch.
  snow: { freq: 2700, q: 1.1, decay: 0.055, gain: 0.5, grains: 3 },
  // Shallow water: a wide wet slap with a tail.
  water: { freq: 1300, q: 0.5, decay: 0.2, gain: 0.5, thump: 180 },
}

const GRAIN_GAP = 0.022

/** A grain of the shared noise buffer, read from a random offset so two hits in
 *  a row never share a waveform. */
function noise(voice: Voice, rate: number, until: number, from = voice.t): AudioBufferSourceNode | null {
  const buffer = noiseBuffer()
  if (!buffer) return null
  const source = voice.ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.playbackRate.value = rate
  source.start(from, Math.random() * (buffer.duration - 0.2))
  source.stop(until)
  return source
}

/** A short sine body, for the thud under a step or a landing. */
function tone(voice: Voice, type: OscillatorType, from: number, to: number, peak: number, attack: number, decay: number, at = voice.t): void {
  const osc = voice.ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(from, at)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + attack + decay)
  const gain = voice.ctx.createGain()
  envelope(gain.gain, at, peak, attack, decay)
  osc.connect(gain)
  gain.connect(voice.input)
  osc.start(at)
  osc.stop(at + attack + decay + 0.05)
}

/* -------------------------------------------------------------------------- */
/* The sounds                                                                 */
/* -------------------------------------------------------------------------- */

const SOUNDS: Record<SoundName, (voice: Voice, options: PlayOptions) => number> = {
  /** A footfall. Timbre follows the ground, with a little pitch and level
   *  wobble each time so a run never sounds like one sample on repeat. */
  footstep(voice, options) {
    const tone_ = FOOT[options.surface ?? 'grass']
    const grains = tone_.grains ?? 1
    const wobble = 0.88 + Math.random() * 0.24
    const length = tone_.decay + GRAIN_GAP * (grains - 1) + 0.05
    const filter = voice.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = tone_.freq * wobble
    filter.Q.value = tone_.q
    const gain = voice.ctx.createGain()
    gain.gain.value = 0.0001
    for (let i = 0; i < grains; i++) {
      const at = voice.t + i * GRAIN_GAP
      const peak = tone_.gain * wobble * (i === 0 ? 1 : 0.55)
      if (i === 0) envelope(gain.gain, at, peak, 0.003, tone_.decay)
      else {
        gain.gain.setValueAtTime(Math.max(0.0002, peak), at + 0.002)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.002 + tone_.decay)
      }
    }
    const source = noise(voice, wobble, voice.t + length)
    source?.connect(filter)
    filter.connect(gain)
    gain.connect(voice.input)
    if (tone_.thump) tone(voice, 'sine', tone_.thump * wobble, tone_.thump * 0.7, tone_.gain * 0.5, 0.004, 0.06)
    return length
  },

  /** The push off the ground. A short rising body, barely any noise. */
  jump(voice) {
    tone(voice, 'sine', 150, 260, 0.22, 0.006, 0.12)
    const filter = voice.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1800
    filter.Q.value = 0.7
    const gain = voice.ctx.createGain()
    envelope(gain.gain, voice.t, 0.14, 0.004, 0.1)
    const source = noise(voice, 1, voice.t + 0.18)
    source?.connect(filter)
    filter.connect(gain)
    gain.connect(voice.input)
    return 0.2
  },

  /** Touchdown, scaled by how fast the body was falling. A drop off a rampart
   *  is a thud; stepping off a kerb is barely there. */
  land(voice, options) {
    const force = Math.min(1, Math.max(0.15, options.force ?? 0.5))
    const filter = voice.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 900 + force * 1400
    filter.Q.value = 0.9
    const gain = voice.ctx.createGain()
    envelope(gain.gain, voice.t, 0.4 * force, 0.003, 0.09 + force * 0.08)
    const source = noise(voice, 0.8, voice.t + 0.3)
    source?.connect(filter)
    filter.connect(gain)
    gain.connect(voice.input)
    tone(voice, 'sine', 78, 48, 0.5 * force, 0.004, 0.1 + force * 0.1)
    return 0.32
  },

  /** The dash whoosh: a band of noise swept up and back down. */
  dash(voice) {
    const filter = voice.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(420, voice.t)
    filter.frequency.exponentialRampToValueAtTime(2600, voice.t + 0.12)
    filter.frequency.exponentialRampToValueAtTime(380, voice.t + 0.34)
    filter.Q.value = 1.1
    const gain = voice.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, voice.t)
    gain.gain.linearRampToValueAtTime(0.34, voice.t + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, voice.t + 0.36)
    const source = noise(voice, 1.2, voice.t + 0.4)
    source?.connect(filter)
    filter.connect(gain)
    gain.connect(voice.input)
    return 0.4
  },

  /** Hitting water. Broad and wet, with a bright spray over it. */
  splash(voice, options) {
    const force = Math.min(1, Math.max(0.2, options.force ?? 0.6))
    const body = voice.ctx.createBiquadFilter()
    body.type = 'lowpass'
    body.frequency.setValueAtTime(2600, voice.t)
    body.frequency.exponentialRampToValueAtTime(600, voice.t + 0.4)
    const bodyGain = voice.ctx.createGain()
    envelope(bodyGain.gain, voice.t, 0.5 * force, 0.005, 0.34)
    const spray = voice.ctx.createBiquadFilter()
    spray.type = 'bandpass'
    spray.frequency.value = 4200
    spray.Q.value = 0.8
    const sprayGain = voice.ctx.createGain()
    envelope(sprayGain.gain, voice.t, 0.22 * force, 0.004, 0.2)
    const source = noise(voice, 1, voice.t + 0.5)
    source?.connect(body)
    source?.connect(spray)
    body.connect(bodyGain)
    spray.connect(sprayGain)
    bodyGain.connect(voice.input)
    sprayGain.connect(voice.input)
    return 0.5
  },

  /** A swimming stroke: the same water, softer and slower. */
  swim(voice) {
    const filter = voice.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(900, voice.t)
    filter.frequency.linearRampToValueAtTime(1800, voice.t + 0.22)
    filter.Q.value = 0.6
    const gain = voice.ctx.createGain()
    envelope(gain.gain, voice.t, 0.2, 0.03, 0.26)
    const source = noise(voice, 0.9, voice.t + 0.35)
    source?.connect(filter)
    filter.connect(gain)
    gain.connect(voice.input)
    return 0.35
  },

  /**
   * Thunder, in the three parts a real strike has. The scene passes `gain` for
   * distance and `rate` for how near the strike was, 0 to 1.
   *
   * A near strike opens with the crack: a few bright tearing bursts a few
   * hundredths of a second apart. Under it sits the boom, a falling sine that
   * is felt more than heard. Both fade with distance, because air eats the top
   * of the spectrum first, so a far strike is only the third part: the rumble,
   * low noise shaped by an uneven run of swells that die away, which is the
   * sound arriving from different lengths of the channel and off the hills. Two
   * decorrelated copies sit left and right so it fills the sky instead of
   * coming from a point, and a dark echo lengthens the tail.
   */
  thunder(voice, options) {
    const { ctx, t } = voice
    const near = Math.min(1, Math.max(0, options.rate ?? 0.5))
    // Distant thunder rolls for longer, and takes longer to arrive in full.
    const length = 4.5 + (1 - near) * 3
    const onset = (1 - near) * 0.35

    if (near > 0.45) {
      const bite = (near - 0.45) / 0.55
      let at = t
      const bursts = 3 + Math.floor(Math.random() * 4)
      for (let i = 0; i < bursts; i++) {
        const decay = 0.05 + Math.random() * 0.09
        const tear = ctx.createBiquadFilter()
        tear.type = 'highpass'
        tear.frequency.value = 1400 + Math.random() * 1600
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(bite * (i === 0 ? 0.85 : 0.3 + Math.random() * 0.35), at + 0.004)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
        const source = noise(voice, 1.4 + Math.random() * 0.8, at + decay + 0.02, at)
        source?.connect(tear)
        tear.connect(gain)
        gain.connect(voice.input)
        at += 0.03 + Math.random() * 0.11
      }
    }

    const boom = ctx.createOscillator()
    boom.type = 'sine'
    boom.frequency.setValueAtTime(82, t + onset)
    boom.frequency.exponentialRampToValueAtTime(32, t + onset + 1.5)
    const boomGain = ctx.createGain()
    boomGain.gain.setValueAtTime(0.0001, t + onset)
    boomGain.gain.exponentialRampToValueAtTime(0.12 + near * 0.6, t + onset + 0.03 + (1 - near) * 0.2)
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + onset + 1.7)
    boom.connect(boomGain)
    boomGain.connect(voice.input)
    boom.start(t + onset)
    boom.stop(t + onset + 1.8)

    // The run of swells, drawn once and played as the rumble's level. Each
    // swell rises fast and decays slowly, and later ones are smaller.
    const steps = 256
    const curve = new Float32Array(steps)
    const swells = 5 + Math.floor(Math.random() * 4)
    for (let k = 0; k < swells; k++) {
      const start = k === 0 ? 0 : Math.random() * length * 0.75
      const rise = 0.06 + (1 - near) * 0.25 + Math.random() * 0.15
      const fall = 0.6 + Math.random() * 0.9
      const size = (k === 0 ? 1 : 0.35 + Math.random() * 0.55) * (1 - start / length) ** 1.5
      for (let n = 0; n < steps; n++) {
        const age = (n / (steps - 1)) * length - start
        if (age < 0) continue
        curve[n]! += size * (age < rise ? age / rise : Math.exp(-(age - rise) / fall))
      }
    }
    let peak = 0
    for (let n = 0; n < steps; n++) peak = Math.max(peak, curve[n]!)
    for (let n = 0; n < steps; n++) {
      const left = 1 - n / (steps - 1)
      curve[n] = (curve[n]! / (peak || 1)) * 0.8 * Math.min(1, left / 0.15)
    }

    const echo = ctx.createDelay(1)
    echo.delayTime.value = 0.31
    const echoTone = ctx.createBiquadFilter()
    echoTone.type = 'lowpass'
    echoTone.frequency.value = 260
    const echoGain = ctx.createGain()
    echoGain.gain.value = 0.38
    echo.connect(echoTone)
    echoTone.connect(echoGain)
    echoGain.connect(echo)
    echoGain.connect(voice.input)

    for (const side of [-0.65, 0.65]) {
      const body = ctx.createBiquadFilter()
      body.type = 'lowpass'
      body.frequency.setValueAtTime(170 + near * 900, t + onset)
      body.frequency.exponentialRampToValueAtTime(60, t + onset + length)
      body.Q.value = 0.7
      const slope = ctx.createBiquadFilter()
      slope.type = 'lowpass'
      slope.frequency.value = 380 + near * 1300
      slope.Q.value = 0.5
      const level = ctx.createGain()
      // A curve may not share its span with any other event on the parameter,
      // so the level starts from its value instead of a scheduled zero.
      level.gain.value = 0
      level.gain.setValueCurveAtTime(curve, t + onset, length)
      const pan = ctx.createStereoPanner()
      pan.pan.value = side
      const source = noise(voice, 0.32 + Math.random() * 0.14, t + onset + length + 0.05, t + onset)
      source?.connect(body)
      body.connect(slope)
      slope.connect(level)
      level.connect(pan)
      pan.connect(voice.input)
      pan.connect(echo)
    }
    return onset + length + 1.6
  },

  /** Two or three notes of birdsong, high and quiet. */
  bird(voice) {
    const base = 2100 + Math.random() * 1400
    const notes = 2 + Math.floor(Math.random() * 2)
    for (let i = 0; i < notes; i++) {
      const at = voice.t + i * (0.08 + Math.random() * 0.07)
      const step = base * (1 + (Math.random() - 0.4) * 0.35)
      tone(voice, 'sine', step, step * 1.22, 0.1, 0.008, 0.05, at)
    }
    return 0.4
  },

  /** The Oracle speaking: a soft fifth with a slow bloom, no attack to it. */
  oracle(voice) {
    const root = 294
    for (const [ratio, level] of [[1, 0.1], [1.5, 0.07], [3, 0.03]] as const) {
      const osc = voice.ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = root * ratio
      const gain = voice.ctx.createGain()
      gain.gain.setValueAtTime(0.0001, voice.t)
      gain.gain.linearRampToValueAtTime(level, voice.t + 0.35)
      gain.gain.exponentialRampToValueAtTime(0.0001, voice.t + 1.6)
      osc.connect(gain)
      gain.connect(voice.input)
      osc.start(voice.t)
      osc.stop(voice.t + 1.7)
    }
    return 1.7
  },

  /** A critter noticing you. One short call, nothing more. */
  critter(voice, options) {
    const base = 520 * (options.rate ?? 1)
    tone(voice, 'triangle', base, base * 0.8, 0.12, 0.01, 0.09)
    tone(voice, 'triangle', base * 1.3, base * 1.1, 0.07, 0.01, 0.07, voice.t + 0.1)
    return 0.25
  },

  /** Arming a hotbar slot. The shortest thing in the mix. */
  arm(voice) {
    tone(voice, 'sine', 880, 880, 0.12, 0.002, 0.045)
    return 0.06
  },

  /** A piece placed or ground raised: a small affirmative tap. */
  place(voice) {
    tone(voice, 'triangle', 540, 700, 0.16, 0.003, 0.07)
    return 0.1
  },

  /** Something taken away: the same tap, downward. */
  remove(voice) {
    tone(voice, 'triangle', 420, 260, 0.16, 0.003, 0.09)
    return 0.12
  },

  /** Refused. Low and flat, and distinct from either of the two above. */
  refuse(voice) {
    tone(voice, 'sine', 150, 132, 0.2, 0.004, 0.1)
    tone(voice, 'sine', 132, 118, 0.14, 0.004, 0.12, voice.t + 0.09)
    return 0.22
  },

  /** The menu opening or closing. `rate` below 1 is the close. */
  menu(voice, options) {
    const up = (options.rate ?? 1) >= 1
    tone(voice, 'sine', up ? 330 : 440, up ? 440 : 300, 0.16, 0.006, 0.14)
    return 0.18
  },
}

/** Which sounds go to the interface bus rather than the world. */
const UI_SOUNDS = new Set<SoundName>(['arm', 'place', 'remove', 'refuse', 'menu'])

/**
 * Play a named sound. A no-op before the first gesture, when the voice budget
 * is spent, or when a positioned sound is too far away to hear.
 */
export function play(name: SoundName, options: PlayOptions = {}): void {
  const voice = startVoice(UI_SOUNDS.has(name) ? 'ui' : 'world', options)
  if (!voice) return
  countPlayed(name)
  const length = SOUNDS[name](voice, options)
  voice.end(voice.t + length)
}
