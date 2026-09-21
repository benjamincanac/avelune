import type { Ref } from 'vue'

/**
 * How much of the scene's art has arrived.
 *
 * The scene loads its models on its own schedule and the entry overlay is a
 * different component tree, so this is the one place they meet: the scene
 * hands every load to `track`, and the overlay reads the two counts. A load
 * that fails still counts as settled, because a missing model is logged and
 * drawn around, and it must never be the thing that keeps a player out.
 *
 * Module state like `useWorld`, and only ever written from the client-only
 * scene, so there is nothing here for a server render to share.
 */
const total = ref(0)
const settled = ref(0)
/** Bumped by `reset`, so a load from a scene that has gone cannot count toward
 *  the next one. */
let generation = 0

export interface UseAssets {
  /** Loads handed to `track` so far. */
  total: Ref<number>
  /** How many of them have resolved or failed. */
  settled: Ref<number>
  /** Count a load. Returns the same promise, so call sites stay a one-liner. */
  track: <T>(load: Promise<T>) => Promise<T>
  /** A fresh scene starts its own count. */
  reset: () => void
}

export function useAssets(): UseAssets {
  return {
    total,
    settled,
    track(load) {
      const mine = generation
      total.value++
      const done = () => {
        if (mine === generation) settled.value++
      }
      load.then(done, done)
      return load
    },
    reset() {
      generation++
      total.value = 0
      settled.value = 0
    },
  }
}
