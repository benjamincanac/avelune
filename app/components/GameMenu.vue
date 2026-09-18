<script setup lang="ts">
/**
 * The Escape menu: pause, check the controls, jump to the map or the editor,
 * get back to town when stuck, leave. A modal over the frozen render — it does
 * not pause the server, and the status module stays visible behind it saying so.
 *
 * Resume is the only accent on the screen. Everything below it is the same
 * frost weight, in the order you are likely to want them, and logging out gets
 * its own destructive treatment: as a bare ghost row it disappeared.
 *
 * It is also where the mixer lives. The world ducks under the menu rather than
 * stopping, so dragging the slider is audible while you drag it.
 */
import { play, setWorldDucked } from '~/utils/audio'

defineProps<{
  fullscreen: boolean
  /** The world editor is a dev-only door. */
  dev: boolean
}>()

const emit = defineEmits<{
  resume: []
  fullscreen: []
  map: []
  respawn: []
  edit: []
  logout: []
}>()

const CONTROLS = [
  [
    { label: 'Move', keys: ['W', 'A', 'S', 'D'] },
    { label: 'Jump', keys: ['Space'] },
    { label: 'Sprint / dash', keys: ['Shift', 'E'] },
    { label: 'Cursor', keys: ['Alt'] },
  ],
  [
    { label: 'Hotbar', keys: ['1–9', 'Tab'] },
    { label: 'Use tool', keys: ['Click'] },
    { label: 'Brush / rotate', keys: ['[ ]', 'R'] },
    { label: 'Map / fullscreen', keys: ['M', 'F'] },
    { label: 'Mute', keys: ['N'] },
  ],
]

const audio = useAudio()

/** The slider works in whole percent; the engine works in 0 to 1. */
const level = computed({
  get: () => Math.round(audio.volume.value * 100),
  set: (value: number) => {
    audio.volume.value = value / 100
  },
})

onMounted(() => {
  // By the time anyone is in here they have clicked their way into the arena,
  // so the document is activated and this is never an autoplay attempt.
  audio.unlock()
  setWorldDucked(true)
  play('menu')
})
onBeforeUnmount(() => {
  setWorldDucked(false)
  play('menu', { rate: 0.5 })
})
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

    <div class="px-7 pt-[22px]">
      <p class="label-section pb-3 text-label">
        Sound
      </p>
      <div class="flex items-center gap-5">
        <USlider
          v-model="level"
          :min="0"
          :max="100"
          :disabled="audio.muted.value"
          size="sm"
          class="flex-1"
        />
        <span class="telemetry w-8 text-right text-label">{{ level }}</span>
        <USwitch
          v-model="audio.muted.value"
          label="Mute"
          size="sm"
          :ui="{ label: 'text-[15px] leading-none text-toned' }"
        />
      </div>
    </div>

    <div class="flex flex-col gap-0.5 px-7 pb-6.5 pt-[22px]">
      <UButton
        block
        size="lg"
        icon="i-lucide-play"
        label="Resume"
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
        color="neutral"
        variant="subtle"
        icon="i-lucide-door-open"
        label="Return to town"
        :ui="{ base: 'justify-start', leadingIcon: 'text-dimmed', label: 'flex-1 text-left' }"
        @click="emit('respawn')"
      >
        <template #trailing>
          <span class="telemetry text-label">If stuck</span>
        </template>
      </UButton>
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
