import type { Biome } from '#shared/utils/biome'
import { COURTYARD, FOUNTAIN, isInMoat } from '#shared/utils/courtyard'
import { courtyardLightning } from '~/utils/courtyardSky'
import type { AudioPoint, Bed } from './engine'
import { audioEngine, createBed } from './engine'
import { play } from './sounds'

/**
 * The beds under everything: wind, rain, the day and the night, and the water.
 *
 * These are long-lived voices. A bed is built once and its level ramped, never
 * rebuilt, because a bed torn down and recreated is an audible click every time
 * the weather nudges. Nothing here is built until the context exists, so the
 * whole module is inert before the first gesture.
 *
 * Everything is derived from state the scene already has. Weather and the sky
 * come off the server clock, so two players in the same storm hear the same
 * storm, and the thunder that follows a strike is the same strike both of them
 * saw. The birds are local decoration, like the critters.
 */

/** How much leaf rustle a region carries under the wind. */
const FOLIAGE: Record<Biome, number> = {
  meadow: 0.3,
  forest: 1,
  pinewood: 0.85,
  grove: 0.7,
  heath: 0.15,
  mountain: 0.05,
}

/** Wind is a ground breeze at sea level and a gale on the summits, which reach
 *  74 units. */
const WIND_ALTITUDE = 62

/** How long a strike's flash is worth waiting on before the roll arrives. The
 *  strike sits within a few hundred units, so this is honest at 343 per second
 *  and happens to be dramatic anyway. */
const SOUND_SPEED = 343

/** Sparse means sparse: a chirp every few seconds at most, and none in the
 *  rain. */
const BIRD_GAP = [3.5, 11] as const
const CRICKET_GAP = 0.9

export interface AmbienceState {
  /** 0 at midnight, 1 at noon. The sky's own figure. */
  dayness: number
  overcast: number
  rain: number
  /** Where the listener stands, in world space. */
  x: number
  y: number
  /** Ground height under the listener, for the wind. */
  altitude: number
  biome: Biome
  /** Server clock in milliseconds, for the lightning hash. */
  now: number
}

export interface Ambience {
  update: (dt: number, state: AmbienceState) => void
  dispose: () => void
}

export function createAmbience(): Ambience {
  let beds: {
    wind: Bed
    gust: Bed
    leaves: Bed
    rain: Bed
    patter: Bed
    crickets: Bed
    cricketLfo: OscillatorNode
    /** How far the cricket oscillator swings the bed. Ramped with the level, so
     *  the chirp scales with it instead of surviving the fade to silence. */
    cricketDepth: GainNode
    fountain: Bed
    moat: Bed
  } | null = null
  let birdIn = BIRD_GAP[0]
  /** The strike the last roll was scheduled for, identified by where it sat: the
   *  sky hashes a fresh position per cluster, so one flash rolls once however
   *  many frames it lasts. */
  let thunderFrom = Number.NaN
  const pending = new Set<number>()
  // A full-scene flash is kept out of reduced-motion sessions by the sky, and so
  // is the bang that goes with it.
  const calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /** The fountain and the moat are authored town geometry at fixed coordinates,
   *  so their beds can be positioned once and left there. */
  const fountainAt: AudioPoint = { x: COURTYARD.fountain.x, y: FOUNTAIN.waterHeight, z: COURTYARD.fountain.y }

  function ensure(): void {
    if (beds || !audioEngine()) return
    const wind = createBed({ type: 'lowpass', frequency: 420, q: 0.4, rate: 0.55 })
    const gust = createBed({ type: 'bandpass', frequency: 1150, q: 0.5, rate: 0.8 })
    const leaves = createBed({ type: 'bandpass', frequency: 2900, q: 0.6, rate: 1.1 })
    const rain = createBed({ type: 'bandpass', frequency: 3200, q: 0.35, rate: 1 })
    const patter = createBed({ type: 'lowpass', frequency: 620, q: 0.7, rate: 0.9 })
    const crickets = createBed({ type: 'bandpass', frequency: 4500, q: 14, rate: 1 })
    const fountain = createBed({ type: 'bandpass', frequency: 1500, q: 0.5, rate: 1, position: fountainAt, refDistance: 3.5, maxDistance: 30 })
    const moat = createBed({ type: 'bandpass', frequency: 700, q: 0.6, rate: 0.7 })
    if (!wind || !gust || !leaves || !rain || !patter || !crickets || !fountain || !moat) {
      for (const bed of [wind, gust, leaves, rain, patter, crickets, fountain, moat]) bed?.dispose()
      return
    }
    // Crickets chirp rather than hiss, so a slow oscillator swings the bed. Its
    // depth follows the level, which makes the swing `level * (1 + lfo)`: on at
    // night, and genuinely gone by day rather than swinging around silence.
    const ctx = crickets.gain.context
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.value = 1 / CRICKET_GAP * 2.4
    const depth = ctx.createGain()
    depth.gain.value = 0
    lfo.connect(depth)
    depth.connect(crickets.gain.gain)
    lfo.start()
    beds = { wind, gust, leaves, rain, patter, crickets, cricketLfo: lfo, cricketDepth: depth, fountain, moat }
  }

  /** How much moat is around the listener, sampled on a small cross. The channel
   *  is a ring at fixed coordinates, so this is the cheap way to ask. */
  function moatNearby(x: number, y: number): number {
    let hits = 0
    for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]] as const) {
      if (isInMoat(x + dx, y + dy)) hits++
    }
    return hits / 5
  }

  function update(dt: number, state: AmbienceState): void {
    ensure()
    if (!beds) return

    // Wind rises with the weather and with height. Mountain air is thinner and
    // brighter, so the gust layer climbs faster than the body.
    const height = Math.min(1, Math.max(0, state.altitude / WIND_ALTITUDE))
    const weather = state.overcast * 0.5 + state.rain * 0.5
    const strength = 0.25 + height * 0.55 + weather * 0.4
    // These sit low on purpose. A bed never stops, so a level that sounds right
    // for a second reads as hiss after a minute: calm weather at ground level is
    // barely there, and only height or a storm brings the wind forward.
    beds.wind.level(0.012 + strength * 0.045, 2)
    beds.gust.level(0.004 + strength * height * 0.03 + weather * 0.012, 2)
    beds.leaves.level(FOLIAGE[state.biome] * (0.006 + strength * 0.014) * (1 - state.rain * 0.4), 2)

    beds.rain.level(state.rain * 0.05, 1.5)
    beds.patter.level(state.rain * 0.035, 1.5)

    // Night takes the crickets and day takes the birds, crossfaded on the same
    // dayness the sky lights the world with.
    const night = Math.min(1, Math.max(0, 1 - state.dayness * 2.2))
    const cricket = night * 0.014 * (1 - state.rain)
    beds.crickets.level(cricket, 4)
    beds.cricketDepth.gain.setTargetAtTime(cricket, beds.crickets.gain.context.currentTime, 1.5)

    const day = Math.min(1, Math.max(0, state.dayness * 1.6 - 0.3)) * (1 - state.rain)
    if (day > 0.2) {
      birdIn -= dt * day
      if (birdIn <= 0) {
        birdIn = BIRD_GAP[0] + Math.random() * (BIRD_GAP[1] - BIRD_GAP[0])
        // Somewhere off to one side, so the songs have width instead of sitting
        // on the listener's nose.
        const angle = Math.random() * Math.PI * 2
        const range = 8 + Math.random() * 14
        play('bird', {
          gain: 0.5 + Math.random() * 0.5,
          position: { x: state.x + Math.cos(angle) * range, y: state.altitude + 4 + Math.random() * 5, z: state.y + Math.sin(angle) * range },
        })
      }
    }

    beds.fountain.level(0.06, 1)
    beds.moat.level(moatNearby(state.x, state.y) * 0.035, 1.5)

    // Thunder follows the flash, from the same hashed strike every client sees.
    if (!calm) {
      const strike = courtyardLightning(state.now, state.rain)
      if (strike.glow > 0.35) {
        const from = strike.x + strike.z
        if (from !== thunderFrom) {
          thunderFrom = from
          const distance = Math.hypot(strike.x, strike.z)
          const near = Math.min(1, Math.max(0, 1 - distance / 300))
          const timer = window.setTimeout(() => {
            pending.delete(timer)
            play('thunder', { gain: 0.25 + near * 0.5, rate: near })
          }, distance / SOUND_SPEED * 1000)
          pending.add(timer)
        }
      }
    }
  }

  function dispose(): void {
    for (const timer of pending) clearTimeout(timer)
    pending.clear()
    if (!beds) return
    try {
      beds.cricketLfo.stop()
      beds.cricketLfo.disconnect()
      beds.cricketDepth.disconnect()
    }
    catch {
      // The context closed first.
    }
    for (const bed of [beds.wind, beds.gust, beds.leaves, beds.rain, beds.patter, beds.crickets, beds.fountain, beds.moat]) bed.dispose()
    beds = null
  }

  return { update, dispose }
}
