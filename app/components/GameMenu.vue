<script setup lang="ts">
/**
 * The Escape menu: pause, check the controls, jump to the map or the editor,
 * leave. A modal over the frozen render — it does not pause the server, and the
 * status module stays visible behind it saying so.
 *
 * Return is the only accent on the screen. Everything below it is the same
 * frost weight, in the order you are likely to want them, and logging out gets
 * its own destructive treatment: as a bare ghost row it disappeared.
 */
defineProps<{
  fullscreen: boolean
  /** The world editor is a dev-only door. */
  dev: boolean
}>()

const emit = defineEmits<{
  resume: []
  fullscreen: []
  map: []
  edit: []
  logout: []
}>()

const CONTROLS = [
  [
    { label: 'Move', keys: ['W', 'A', 'S', 'D'] },
    { label: 'Jump', keys: ['Space'] },
    { label: 'Dash', keys: ['Shift'] },
    { label: 'Cursor', keys: ['Alt'] },
  ],
  [
    { label: 'Hotbar', keys: ['1–9', 'Tab'] },
    { label: 'Use tool', keys: ['Click'] },
    { label: 'Brush / rotate', keys: ['[ ]', 'R'] },
    { label: 'Map / fullscreen', keys: ['M', 'F'] },
  ],
]
</script>

<template>
  <div class="frost-modal w-130 rounded-[6px]">
    <header class="flex items-center justify-between border-b border-white/12 px-7 py-[22px]">
      <h2 class="font-display text-[22px] font-extrabold uppercase leading-none tracking-[0.22em] text-highlighted">
        Game menu
      </h2>
      <span class="telemetry tracking-[0.14em] text-label">Esc to close</span>
    </header>

    <div class="px-7 pb-1.5 pt-[22px]">
      <p class="label-section pb-3 text-label">
        Controls
      </p>
      <div class="flex gap-9">
        <template
          v-for="(column, index) in CONTROLS"
          :key="index"
        >
          <span
            v-if="index"
            class="w-px bg-white/10"
          />
          <dl class="flex flex-1 flex-col">
            <div
              v-for="row in column"
              :key="row.label"
              class="flex items-center justify-between gap-4 border-b border-white/7 py-2.25 last:border-0"
            >
              <dt class="text-[15px] leading-none text-toned">
                {{ row.label }}
              </dt>
              <dd class="flex gap-1">
                <UKbd
                  v-for="key in row.keys"
                  :key="key"
                  :value="key"
                />
              </dd>
            </div>
          </dl>
        </template>
      </div>
    </div>

    <div class="flex flex-col gap-px px-7 pb-6.5 pt-[22px]">
      <UButton
        block
        size="lg"
        icon="i-lucide-play"
        label="Return to game"
        :ui="{ base: 'justify-start' }"
        @click="emit('resume')"
      />
      <UButton
        block
        color="neutral"
        variant="subtle"
        :icon="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
        :label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
        :ui="{ base: 'justify-start', leadingIcon: 'text-dimmed', label: 'flex-1 text-left' }"
        @click="emit('fullscreen')"
      >
        <template #trailing>
          <span class="telemetry text-label">F</span>
        </template>
      </UButton>
      <UButton
        block
        color="neutral"
        variant="subtle"
        icon="i-lucide-map"
        label="World map"
        :ui="{ base: 'justify-start', leadingIcon: 'text-dimmed', label: 'flex-1 text-left' }"
        @click="emit('map')"
      >
        <template #trailing>
          <span class="telemetry text-label">M</span>
        </template>
      </UButton>
      <UButton
        v-if="dev"
        block
        color="neutral"
        variant="subtle"
        icon="i-lucide-pencil-ruler"
        label="World editor"
        :ui="{ base: 'justify-start', leadingIcon: 'text-dimmed', label: 'flex-1 text-left' }"
        @click="emit('edit')"
      />
      <UButton
        block
        color="error"
        variant="subtle"
        icon="i-lucide-log-out"
        label="Log out"
        class="mt-3.5"
        :ui="{ base: 'justify-start', label: 'flex-1 text-left' }"
        @click="emit('logout')"
      >
        <template #trailing>
          <span class="telemetry text-[#e0a18f]">Ends session</span>
        </template>
      </UButton>
    </div>
  </div>
</template>
