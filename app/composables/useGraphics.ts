import type { Ref } from 'vue'
import { GRAPHICS_DETAIL, GRAPHICS_PRESETS } from '~/utils/graphics'
import type { GraphicsDetail, GraphicsPreset, GraphicsProfile, GraphicsSettings } from '~/utils/graphics'

/**
 * What the renderer is allowed to spend, remembered between sessions.
 *
 * Module state like `useAudio`: the Escape menu writes it, the canvas reads the
 * two settings the renderer itself is built from, and `MazeScene` reads the
 * rest. None of the three owns the others.
 *
 * What is stored is the flat set of controls, never the preset that wrote them.
 * A preset is a button, which is why touching a switch afterwards shows as
 * Custom rather than pretending the preset still holds — and why a saved
 * setting cannot silently change meaning when a preset is retuned later.
 */

const KEY = 'avelune:graphics'

const scale = ref(GRAPHICS_PRESETS.high.scale)
const detail = ref<GraphicsDetail>(GRAPHICS_PRESETS.high.detail)
const shadows = ref(GRAPHICS_PRESETS.high.shadows)
const occlusion = ref(GRAPHICS_PRESETS.high.occlusion)
const bloom = ref(GRAPHICS_PRESETS.high.bloom)

/** The display's own ratio, watched: dragging the window to a second monitor
 *  changes it, and the canvas has to follow or the world renders at the wrong
 *  scale for the rest of the session. */
const systemRatio = ref(1)
function watchSystemRatio(): void {
  systemRatio.value = window.devicePixelRatio || 1
  // A `resolution` query only fires once, on the way out of its own value, so
  // the next one is built from where we just landed.
  window.matchMedia(`(resolution: ${systemRatio.value}dppx)`).addEventListener('change', watchSystemRatio, { once: true })
}

let loaded = false

/** Read the saved settings. Storage can throw in a private window, and a
 *  session that cannot remember the quality is not a session that should fail. */
function load(): void {
  if (loaded || import.meta.server) return
  loaded = true
  watchSystemRatio()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<GraphicsSettings>
    if (typeof saved.scale === 'number') scale.value = Math.min(1, Math.max(0.5, saved.scale))
    if (saved.detail && saved.detail in GRAPHICS_DETAIL) detail.value = saved.detail
    if (typeof saved.shadows === 'boolean') shadows.value = saved.shadows
    if (typeof saved.occlusion === 'boolean') occlusion.value = saved.occlusion
    if (typeof saved.bloom === 'boolean') bloom.value = saved.bloom
  }
  catch {
    // No storage, or something else wrote nonsense under our key. Defaults it is.
  }
  finally {
    // Attached after the read, so loading what was saved is not itself a write.
    // Detached, because `load()` runs from whichever component reached the
    // module first: bound to that scope the watcher would die with the scene on
    // logout, and `loaded` would keep the next session from ever re-attaching.
    effectScope(true).run(() => watch([scale, detail, shadows, occlusion, bloom], save))
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ scale: scale.value, detail: detail.value, shadows: shadows.value, occlusion: occlusion.value, bloom: bloom.value } satisfies GraphicsSettings))
  }
  catch {
    // Storage refused. The quality still applies for this session.
  }
}

/** Which preset the controls currently spell, or null for a set of their own. */
const preset = computed<GraphicsPreset | null>(() => {
  for (const [name, values] of Object.entries(GRAPHICS_PRESETS) as [GraphicsPreset, GraphicsSettings][]) {
    if (values.scale === scale.value && values.detail === detail.value && values.shadows === shadows.value
      && values.occlusion === occlusion.value && values.bloom === bloom.value) return name
  }
  return null
})

const profile = computed<GraphicsProfile>(() => ({
  // Capped at 2 the way the canvas always was: past that the cost keeps
  // climbing and nothing on screen gets sharper.
  pixelRatio: Math.min(systemRatio.value, 2) * scale.value,
  occlusion: occlusion.value,
  bloom: bloom.value,
  shadows: shadows.value,
  ...GRAPHICS_DETAIL[detail.value],
}))

export interface UseGraphics {
  /** Fraction of the display's pixel ratio to render at, 0.5 to 1. */
  scale: Ref<number>
  detail: Ref<GraphicsDetail>
  shadows: Ref<boolean>
  occlusion: Ref<boolean>
  bloom: Ref<boolean>
  /** The preset the controls spell, or null when they spell none of them. */
  preset: Ref<GraphicsPreset | null>
  /** Everything the canvas and the scene read. */
  profile: Ref<GraphicsProfile>
  /** Write every control from a preset. */
  apply: (name: GraphicsPreset) => void
}

export function useGraphics(): UseGraphics {
  load()
  return {
    scale,
    detail,
    shadows,
    occlusion,
    bloom,
    preset,
    profile,
    apply(name: GraphicsPreset) {
      const values = GRAPHICS_PRESETS[name]
      scale.value = values.scale
      detail.value = values.detail
      shadows.value = values.shadows
      occlusion.value = values.occlusion
      bloom.value = values.bloom
    },
  }
}
