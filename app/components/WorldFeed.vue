<script setup lang="ts">
import type { FeedEvent } from '~/composables/useFeed'

/**
 * What other people are doing to the world, as plain text on an edge wash.
 *
 * The HUD rule: in-world text never gets a panel. This is overlaid on the live
 * render and you can't click it, so it sits on a gradient anchored to the frame
 * edge with no blur — panels are reserved for things you interact with, and
 * each frosted layer is a separate composite pass over the canvas.
 *
 * Every actor is the accent, whoever they are. Chat keeps per-player colour;
 * the feed is one voice, and three rows of eight different colours reads as
 * confetti.
 */
withDefaults(defineProps<{
  events: FeedEvent[]
  /** How many rows the surface has room for. */
  rows?: number
}>(), {
  rows: 3,
})

/** Each row is dimmer than the one above it, so the newest reads first. */
const INK = ['text-default', 'text-toned', 'text-muted', 'text-muted']

function clock(at: number) {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div
    v-if="events.length"
    class="wash-right on-render flex flex-col gap-2 py-3.5 pl-17 pr-7 text-right"
  >
    <p class="label-section mb-1 text-toned">
      World feed
    </p>
    <p
      v-for="(event, index) in events.slice(0, rows)"
      :key="event.id"
      class="flex items-baseline justify-end gap-3 text-[13px]/[1.45]"
      :class="INK[index] ?? INK.at(-1)"
    >
      <ClientOnly>
        <time
          :datetime="new Date(event.at).toISOString()"
          class="shrink-0 font-mono text-[10px]/[1.45] font-medium tracking-[0.04em] text-muted"
        >{{ clock(event.at) }}</time>
      </ClientOnly>
      <span><b class="font-semibold text-primary">{{ event.name }}</b> {{ event.text }}</span>
    </p>
  </div>
</template>
