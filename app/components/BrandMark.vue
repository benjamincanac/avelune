<script setup lang="ts">
/**
 * The TEMPEST wordmark with the live "N in the tower" line and its status dot —
 * shared by the main menu (atmospheric, over the portal) and the in-game HUD
 * (inside a card). This is purely presentational: the caller supplies the count
 * and the dot colour (connection status in-game, population liveness on the
 * menu) and frames/positions it via the root `class`.
 */
withDefaults(defineProps<{
  /** Runners in the tower; null hides the line until the first probe resolves. */
  count: number | null
  /** Tailwind `bg-*` utility for the status dot. */
  dotClass?: string
  /** Logo edge size (Tailwind `size-*` utility). */
  size?: string
}>(), {
  dotClass: 'bg-primary',
  size: 'size-9',
})
</script>

<template>
  <div class="flex items-center gap-2.5">
    <img
      src="/logo.svg"
      alt="Tempest"
      class="rounded-md"
      :class="size"
    >
    <div class="flex flex-col leading-tight">
      <span class="text-sm font-semibold tracking-[0.2em] text-highlighted">TEMPEST</span>
      <span
        v-if="count !== null"
        class="flex items-center gap-1 text-[11px] text-muted"
      >
        <span
          class="size-1.5 rounded-full"
          :class="dotClass"
        />
        {{ count }} in the tower
      </span>
    </div>
  </div>
</template>
