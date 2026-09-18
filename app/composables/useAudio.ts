import type { Ref } from 'vue'
import { audioDebug, resumeAudio, setAudioMuted, setAudioVolume, suspendAudio, unlockAudio } from '~/utils/audio'
import type { AudioDebug } from '~/utils/audio'

/**
 * The mixer the player controls: one level and one mute, remembered between
 * sessions.
 *
 * Module state like `useWorld` and `useAssets`, because the Escape menu, the
 * scene and the key handler all have to agree and none of them owns the others.
 * The engine itself is not created here: browsers refuse a context before a
 * gesture, so the scene calls `unlock()` on the first click or key and every
 * setter below is a harmless no-op until then.
 */

const KEY = 'avelune:audio'

const volume = ref(0.7)
const muted = ref(false)
let loaded = false

/** Read the saved mixer. Storage can throw in a private window, and a session
 *  that cannot remember the level is not a session that should fail. */
function load(): void {
  if (loaded || import.meta.server) return
  loaded = true
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as { volume?: number, muted?: boolean }
      if (typeof saved.volume === 'number') volume.value = Math.min(1, Math.max(0, saved.volume))
      if (typeof saved.muted === 'boolean') muted.value = saved.muted
    }
  }
  catch {
    // No storage, or something else wrote nonsense under our key. Defaults it is.
  }
  setAudioVolume(volume.value)
  setAudioMuted(muted.value)
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume: volume.value, muted: muted.value }))
  }
  catch {
    // Storage refused. The level still applies for this session.
  }
}

export interface UseAudio {
  /** Master level, 0 to 1. */
  volume: Ref<number>
  muted: Ref<boolean>
  /** Create or resume the context. Call it from a real user gesture. */
  unlock: () => void
  /** Park and restore the context, for a hidden tab. */
  suspend: () => void
  resume: () => void
  toggleMute: () => void
  /** Dev-only telemetry, behind `window.__maze.audio`. */
  debug: () => AudioDebug
}

export function useAudio(): UseAudio {
  load()
  return {
    volume,
    muted,
    unlock() {
      unlockAudio()
      setAudioVolume(volume.value)
      setAudioMuted(muted.value)
    },
    suspend: suspendAudio,
    resume: resumeAudio,
    toggleMute() {
      muted.value = !muted.value
    },
    debug: audioDebug,
  }
}

if (import.meta.client) {
  watch(volume, (value) => {
    setAudioVolume(value)
    save()
  })
  watch(muted, (value) => {
    setAudioMuted(value)
    save()
  })
}
