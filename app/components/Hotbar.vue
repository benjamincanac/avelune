<script setup lang="ts">
import { BUILD_PAGES, SURFACE_NAMES, useBuild } from '~/composables/useBuild'

/**
 * The build bar: nine slots along the bottom edge, WoW/Minecraft style.
 *
 * It is presentation only. Keys (1..9, the wheel, Tab, Q, R, `[`/`]`) are read
 * by `GameScene`, which owns input, and the click itself is aimed and sent by
 * `MazeScene`, which owns the world and the socket — the bar just shows what is
 * armed and what the server's own limits are.
 */

const build = useBuild()

const slots = computed(() => BUILD_PAGES[build.page.value]?.slots ?? [])
const isTerraform = computed(() => build.active.value != null && !build.active.value.kind && build.active.value.id !== 'demolish')
</script>

<template>
  <div class="pointer-events-none flex flex-col items-center gap-1.5">
    <!-- What the crosshair is on, and why it is refused. -->
    <p
      v-if="build.targetHint.value"
      class="rounded-full px-2.5 py-0.5 text-[11px] backdrop-blur"
      :class="build.targetOk.value ? 'bg-black/45 text-highlighted' : 'bg-error/20 text-error'"
    >
      {{ build.targetHint.value }}
    </p>

    <div class="pointer-events-auto flex items-center gap-1 rounded-xl bg-black/45 p-1.5 ring ring-white/10 backdrop-blur">
      <button
        v-for="(slot, index) in slots"
        :key="slot.id"
        type="button"
        class="relative flex size-11 flex-col items-center justify-center rounded-lg ring transition-colors"
        :class="index === build.slot.value ? 'bg-primary/20 ring-primary/60' : 'bg-white/5 ring-white/10 hover:bg-white/10'"
        :title="slot.label"
        @click="build.select(index)"
      >
        <UIcon
          :name="slot.icon"
          class="size-5"
          :class="index === build.slot.value ? 'text-primary' : 'text-muted'"
        />
        <span class="absolute left-1 top-0.5 text-[9px] leading-none text-dimmed">{{ index + 1 }}</span>
      </button>
    </div>

    <div class="flex items-center gap-2.5 rounded-full bg-black/45 px-2.5 py-0.5 text-[10px] text-muted backdrop-blur">
      <span class="text-highlighted">{{ build.active.value?.label ?? 'No tool' }}</span>
      <template v-if="isTerraform">
        <span class="flex items-center gap-1">
          <UKbd value="[" /><UKbd value="]" /> brush {{ build.size.value }}×{{ build.size.value }}
        </span>
      </template>
      <span
        v-if="build.active.value?.id === 'paint'"
        class="flex items-center gap-1"
      >
        <UKbd value="Q" /> {{ SURFACE_NAMES[build.surface.value] }}
      </span>
      <span
        v-if="build.active.value?.kind"
        class="flex items-center gap-1"
      >
        <UKbd value="R" /> {{ Math.round(build.rot.value / (Math.PI / 2)) % 4 * 90 }}°
      </span>
      <span class="flex items-center gap-1">
        <UKbd value="Tab" /> {{ BUILD_PAGES[build.page.value]?.label }} ({{ build.page.value + 1 }}/{{ BUILD_PAGES.length }})
      </span>
      <span>reach {{ build.reach }}</span>
      <span>{{ build.pieces.value }}/{{ build.budget }} pieces</span>
    </div>
  </div>
</template>
