<script setup lang="ts">
/**
 * The lockup: the mark and the wordmark, nothing else.
 *
 * Every screen pairs it with something different — the HUD with a live count,
 * the creator with a step, the menu with `PAUSED` — so the line beside it
 * belongs to the caller, not here. Sizes are the design's three, and the
 * tracking opens up with the type: at 26px a tight wordmark reads as a word
 * rather than a mark.
 */
withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})

const SIZES = {
  sm: { mark: 'size-[22px]', type: 'text-[15px] tracking-[0.28em]', gap: 'gap-3' },
  md: { mark: 'size-[26px]', type: 'text-[21px] tracking-[0.32em]', gap: 'gap-3.5' },
  lg: { mark: 'size-[30px]', type: 'text-[26px] tracking-[0.34em]', gap: 'gap-4' },
} as const
</script>

<template>
  <div
    class="flex items-center"
    :class="SIZES[size].gap"
  >
    <img
      src="/logo.svg?v=aqua"
      alt="Avelune"
      class="rounded-[5px]"
      :class="SIZES[size].mark"
    >
    <span
      class="font-display font-bold leading-none text-highlighted"
      :class="SIZES[size].type"
    >AVELUNE</span>
  </div>
</template>
