<script setup lang="ts">
/**
 * The arena needs a keyboard and a mouse: pointer lock, WASD, a hotbar on the
 * number row. A phone gets as far as a character and then cannot move, so say
 * so first. Shown by `pointer-coarse` alone, never from script, which is what
 * lets the prerendered title screen paint it without a hydration shift.
 * `wide` is the title screen's line; the default is the veil over `/play`.
 */
withDefaults(defineProps<{
  wide?: boolean
}>(), {
  wide: false,
})

const dismissed = ref(false)
</script>

<template>
  <p
    v-if="wide"
    class="telemetry hidden items-center gap-2.5 tracking-widest text-[#e5c66b] pointer-coarse:flex"
  >
    <UIcon
      name="i-lucide-keyboard"
      class="size-3"
    />
    Desktop only · needs a keyboard and a mouse
  </p>
  <div
    v-else-if="!dismissed"
    class="absolute inset-0 z-50 hidden select-none items-center justify-center bg-[#060e11]/90 p-6 pointer-coarse:flex"
  >
    <div class="frost-modal flex w-100 max-w-full flex-col items-center gap-5 rounded-[6px] border-t-2 border-[#d8b13a] p-8 text-center">
      <UIcon
        name="i-lucide-keyboard"
        class="size-7 text-[#d8b13a]"
      />
      <div class="flex flex-col gap-2">
        <h2 class="font-display text-lg font-bold uppercase leading-none tracking-[0.2em] text-highlighted">
          Desktop only for now
        </h2>
        <p class="text-[15px]/[1.5] text-muted text-pretty">
          Avelune needs a keyboard and a mouse to move, look around and build. Open it on a computer to play.
        </p>
      </div>
      <div class="flex w-full flex-col gap-2.5">
        <UButton
          block
          size="lg"
          to="/"
          label="Back to the title screen"
          class="notch-wide text-[15px]"
        />
        <UButton
          block
          size="lg"
          color="neutral"
          variant="outline"
          label="Continue anyway"
          class="text-[15px]"
          @click="dismissed = true"
        />
      </div>
    </div>
  </div>
</template>
