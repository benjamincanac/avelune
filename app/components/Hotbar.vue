<script setup lang="ts">
import { isEdgeKind } from '#shared/utils/building'
import { BUILD_PAGES, SURFACE_NAMES, useBuild } from '~/composables/useBuild'

/**
 * The build bar: the current page's slots along the bottom edge, WoW/Minecraft
 * style, under an accent chip naming what is armed.
 *
 * It is presentation only. Keys (1..9, the wheel, Tab, Q, R, `[`/`]`) are read
 * by `GameScene`, which owns input, and the click itself is aimed and sent by
 * `MazeScene`, which owns the world and the socket — the bar just shows what is
 * armed and what the server's own limits are.
 *
 */

withDefaults(defineProps<{
  /** Chat has focus, so the bar is not taking keys. */
  dimmed?: boolean
}>(), {
  dimmed: false,
})

const build = useBuild()

const slots = computed(() => BUILD_PAGES[build.page.value]?.slots ?? [])
const page = computed(() => BUILD_PAGES[build.page.value])
const isTerraform = computed(() => build.active.value != null && !build.active.value.kind && build.active.value.id !== 'demolish')
// A panel takes its heading from the edge it snaps to, so `R` only flips which
// way it faces — a degree readout would be a lie.
const isPanel = computed(() => !!build.active.value?.kind && isEdgeKind(build.active.value.kind))
</script>

<template>
  <div class="pointer-events-none flex flex-col items-center gap-2.5">
    <!-- What is armed. When the crosshair refuses a target, the same chip says
         why instead — one place to look, not two. -->
    <!-- No transition on this one: a refusal has to read the instant the
         crosshair crosses onto protected ground, not fade in behind it. -->
    <p
      v-if="build.active.value"
      class="rounded-[4px] px-3.5 py-1.5 font-display text-xs font-bold uppercase leading-none tracking-[0.2em]"
      :class="build.targetHint.value && !build.targetOk.value
        ? 'bg-[#e07a5f] text-[#2a0d06]'
        : 'bg-primary text-avelune-950'"
    >
      {{ build.targetHint.value && !build.targetOk.value ? build.targetHint.value : build.active.value.label }}
    </p>

    <!-- The bar is a panel, because it is the one thing down here you click —
         the same rule that gives chat one and denies the world feed one. -->
    <div
      class="frost pointer-events-auto flex gap-1.25 rounded-[6px] p-2 transition-opacity duration-150 ease-out"
      :class="dimmed ? 'opacity-45' : ''"
    >
      <button
        v-for="(slot, index) in slots"
        :key="slot.id"
        type="button"
        class="relative flex size-16 items-center justify-center rounded-[5px] transition-colors duration-120 ease-out"
        :class="index === build.slot.value
          ? 'bg-primary text-avelune-950'
          : 'bg-white/10 text-toned shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] hover:bg-white/16'"
        :title="slot.label"
        @click="build.select(index)"
      >
        <UIcon
          :name="slot.icon"
          class="size-6"
        />
        <span
          class="absolute left-1.5 top-1 font-mono text-[9px] font-semibold leading-none"
          :class="index === build.slot.value ? 'text-avelune-950/70' : 'text-muted'"
        >{{ index + 1 }}</span>
      </button>
    </div>

    <!-- Everything the server is enforcing, in the font the server speaks in. -->
    <div class="telemetry on-render flex flex-wrap items-center justify-center gap-x-4.5 gap-y-1.5 text-muted">
      <span><span class="text-highlighted">Tab</span> {{ page?.label }} {{ build.page.value + 1 }}/{{ BUILD_PAGES.length }}</span>
      <span v-if="isTerraform"><span class="text-highlighted">[ ]</span> Brush {{ build.size.value }}</span>
      <span v-if="build.active.value?.id === 'paint'"><span class="text-highlighted">Q</span> {{ SURFACE_NAMES[build.surface.value] }}</span>
      <span v-if="build.active.value?.kind"><span class="text-highlighted">R</span> {{ isPanel ? 'Flip' : `${Math.round(build.rot.value / (Math.PI / 2)) % 4 * 90}°` }}</span>
      <span>Reach {{ build.reach }}</span>
      <span>{{ build.pieces.value }}/{{ build.budget }} pieces</span>
      <span>{{ build.deeds.value }}/{{ build.plots }} plots</span>
    </div>

    <!-- The controls that have no state to show, so they have no home in the
         line above: how to see past your own shoulder, how to lay a run of
         tiles, and how to aim with the cursor instead of the crosshair. -->
    <div class="telemetry on-render flex flex-wrap items-center justify-center gap-x-4.5 gap-y-1.5 text-muted">
      <span><span class="text-highlighted">V</span> Shoulder</span>
      <span>Hold to repeat</span>
      <span><span class="text-highlighted">Alt</span> Cursor</span>
    </div>
  </div>
</template>
