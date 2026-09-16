import type { Ref } from 'vue'

/**
 * Whether the full-screen world map is up.
 *
 * Shared state rather than a prop because three places need it: `GameScene`
 * owns the `M` key and freezes movement and mouse-look while it is open,
 * `index.vue` renders the overlay and routes Escape to it, and the map itself
 * closes on its own button. Nothing here touches the DOM — the pointer lock is
 * `GameScene`'s, and it releases and re-takes it around the toggle.
 */
export interface UseWorldMap {
  open: Ref<boolean>
}

const open = ref(false)

export function useWorldMap(): UseWorldMap {
  return { open }
}
