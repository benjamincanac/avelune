/**
 * Avelune's sound, in one place.
 *
 * The engine holds the context and the buses, `sounds` holds the named
 * one-shots, `ambience` holds the long-lived beds and `footsteps` holds the one
 * piece of logic worth a test. Everything is synthesized: there is not an audio
 * file in the repo, and adding one would be a new decision, not a small one.
 */
export type { AudioDebug, AudioPoint, Bed, FootSurface, PlayOptions } from './engine'
export {
  audioDebug,
  closeAudio,
  rememberListener,
  resumeAudio,
  setAudioListener,
  setAudioMuted,
  setAudioVolume,
  setWorldDucked,
  suspendAudio,
  unlockAudio,
} from './engine'
export type { SoundName } from './sounds'
export { play } from './sounds'
export type { Ambience, AmbienceState } from './ambience'
export { createAmbience } from './ambience'
export type { FootstepState } from './footsteps'
export { createFootstepState, footSurfaceAt, footSurfaceFor, stepFootsteps } from './footsteps'
