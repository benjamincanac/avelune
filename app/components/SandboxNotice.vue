<script setup lang="ts">
/**
 * The world resets when the server restarts. Say so before anyone builds a
 * house — in warn, never in the accent, which is reserved for what is live and
 * working. `wide` is the title screen's line; the default is the HUD chip.
 */
withDefaults(defineProps<{
  wide?: boolean
}>(), {
  wide: false,
})
</script>

<template>
  <p
    v-if="wide"
    class="telemetry flex items-center gap-2.5 tracking-widest text-[#e5c66b]"
  >
    <UIcon
      name="i-lucide-triangle-alert"
      class="size-3"
    />
    Sandbox — world resets when the server restarts
  </p>
  <p
    v-else
    class="telemetry flex items-center gap-2 border-l-[3px] border-[#d8b13a] bg-[#d8b13a]/14 px-3.5 py-1.5 text-[#e5c66b]"
  >
    <UIcon
      name="i-lucide-triangle-alert"
      class="size-3"
    />
    Sandbox · resets on restart
  </p>
</template>
