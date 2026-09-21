import type { Ref } from 'vue'

/**
 * How many frames the scene actually drew, for the HUD's status module.
 *
 * Counted in `MazeScene`'s render loop rather than off `requestAnimationFrame`,
 * because those two stop agreeing exactly when the number matters: a frame the
 * renderer is still working through is one rAF never fires, and a rAF-based
 * counter would report a steady 60 while the pipeline crawled.
 *
 * Module state, so the HUD can read it without the scene handing it up through
 * the page. It is averaged over a window rather than taken per frame: a single
 * frame's time swings far too much to read.
 */

const WINDOW_MS = 500

const fps = ref(0)
let frames = 0
let since = 0

/** One drawn frame. Called from the render loop, so it has to stay this cheap. */
export function tickFps(): void {
  frames++
  const now = performance.now()
  if (!since) {
    since = now
    return
  }
  const elapsed = now - since
  if (elapsed < WINDOW_MS) return
  // Floored at 1, because 0 is what the HUD reads as "nothing measured yet" and
  // a scene drawing a frame every two seconds is exactly when the number is
  // worth showing.
  fps.value = Math.max(1, Math.round(frames / elapsed * 1000))
  frames = 0
  since = now
}

/** The scene has gone: the next one starts its own average rather than
 *  carrying the last one's. */
export function resetFps(): void {
  fps.value = 0
  frames = 0
  since = 0
}

export function useFps(): { fps: Ref<number> } {
  return { fps }
}
