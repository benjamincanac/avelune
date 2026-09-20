<script setup lang="ts">
/**
 * The HUD's top-left status module: who is here, where "here" is, and how far
 * away the server is. One of the few frosted panels on the game screen, and the
 * one every live indicator hangs off — the dot, the count and the latency all
 * switch to `warn` together the moment the socket stops being open, rather than
 * each guessing separately.
 */
const props = defineProps<{
  /** Players in town, self included. */
  count: number
  /** The realm's display name; null until `welcome` lands. */
  realm: string | null
  /** Round trip in ms; null until the first pong. */
  rtt: number | null
  /** Whether the socket is open. Drives every accent on the module. */
  live: boolean
}>()

const { fps } = useFps()

const telemetry = computed(() => {
  const parts = [props.realm?.toUpperCase() ?? '—']
  if (props.rtt != null) parts.push(`${props.rtt}MS`)
  if (fps.value) parts.push(`${fps.value}FPS`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="frost flex items-center overflow-hidden rounded-[6px]">
    <span
      class="w-1 self-stretch transition-colors duration-[120ms] ease-out"
      :class="live ? 'bg-primary' : 'bg-warning'"
    />
    <div class="flex items-center gap-4 px-5 py-2.75">
      <span class="font-display text-[15px] font-bold leading-none tracking-[0.26em] text-highlighted">AVELUNE</span>
      <span class="h-4 w-px bg-white/15" />
      <span class="telemetry flex items-center gap-[7px] whitespace-nowrap text-toned">
        <span
          class="size-1.5"
          :class="live ? 'bg-primary' : 'bg-warning'"
        />
        {{ count }} in town
      </span>
      <span class="telemetry whitespace-nowrap text-muted">{{ telemetry }}</span>
    </div>
  </div>
</template>
