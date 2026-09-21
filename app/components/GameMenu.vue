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
 *
 * The graphics tab is the same shape: every control writes straight through to
 * the renderer, and the frozen render behind the menu redraws as you change it,
 * so the cost of a setting is visible before you resume.
 */
import { play, setWorldDucked } from '~/utils/audio'
import type { GraphicsPreset } from '~/utils/graphics'

defineProps<{
  fullscreen: boolean
  /** The world editor is a dev-only door. */
  dev: boolean
}>()

/**
 * Tabs, so the menu stays one screen tall now that sound, voice and the quality
 * settings have joined the controls. All stay mounted: the mixer keeps its
 * state and the one-off voice notice is not re-created every time you look at
 * the keys.
 */
const TABS = [
  { label: 'Controls', value: 'controls', slot: 'controls' as const, icon: 'i-lucide-keyboard' },
  { label: 'Graphics', value: 'graphics', slot: 'graphics' as const, icon: 'i-lucide-monitor-cog' },
  { label: 'Audio', value: 'audio', slot: 'audio' as const, icon: 'i-lucide-volume-2' },
]
const tab = ref('controls')

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
    { label: 'Talk / mute mic', keys: ['T', 'N'] },
  ],
]

const audio = useAudio()
const voice = useVoice()
const graphics = useGraphics()

const PRESETS = [
  { label: 'Low', value: 'low' as const },
  { label: 'Medium', value: 'medium' as const },
  { label: 'High', value: 'high' as const },
]

/** A preset is a button that writes every control below it, so there is nothing
 *  to select once one of those has been touched: the group simply clears and
 *  the heading says Custom. */
const preset = computed({
  get: () => graphics.preset.value ?? undefined,
  set: (value: GraphicsPreset | undefined) => {
    if (value) graphics.apply(value)
  },
})

/** The slider works in whole percent, like the mixer's; the renderer works in a
 *  fraction of the display's own pixel ratio. */
const resolution = computed({
  get: () => Math.round(graphics.scale.value * 100),
  set: (value: number) => {
    graphics.scale.value = value / 100
  },
})

/** The slider works in whole percent; the engine works in 0 to 1. */
const level = computed({
  get: () => Math.round(audio.volume.value * 100),
  set: (value: number) => {
    audio.volume.value = value / 100
  },
})

const voiceLevel = computed({
  get: () => Math.round(voice.volume.value * 100),
  set: (value: number) => {
    voice.volume.value = value / 100
  },
})

const VOICE_MODES = [
  { label: 'Push to talk', value: 'ptt' as const },
  { label: 'Open mic', value: 'open' as const },
]

/**
 * One line for the whole feature, because there is nothing here worth two.
 *
 * The mic states come first: a player who has been refused the microphone needs
 * to read that and nothing else. Once it is live the useful number is how many
 * people are actually in range, since that is what tells them whether silence
 * means a fault or an empty meadow.
 */
const voiceState = computed(() => {
  if (voice.supported.value === false) return 'Not supported in this browser. Voice needs WebCodecs Opus'
  if (voice.mic.value === 'asking') return 'Asking for the microphone'
  if (voice.mic.value === 'blocked') return 'Microphone blocked. Allow it in the browser and try again'
  if (!voice.enabled.value) return 'Off'
  if (voice.micMuted.value) return 'On, microphone muted'
  if (voice.say.value === 'sending') return 'On, sending what you said to chat'
  if (voice.say.value === 'failed') return 'On, that line could not be posted to chat'
  const nearby = voice.peers.value.length
  if (!nearby) return 'On, nobody nearby'
  return nearby === 1 ? 'On, 1 nearby' : `On, ${nearby} nearby`
})

/** Muting has to reach the encoder in the same breath as the ref, so it is
 *  written through `useVoice` rather than modelled straight onto it. */
const micMuted = computed({
  get: () => voice.micMuted.value,
  set: (value: boolean) => {
    voice.setMicMuted(value)
  },
})

/** The switch writes through a handler rather than a model: opening the mic is
 *  async and can be refused, and `useVoice` is the thing that knows. */
const voiceOn = computed({
  get: () => voice.enabled.value,
  set: (value: boolean) => {
    void voice.setEnabled(value)
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

    <UTabs
      v-model="tab"
      :items="TABS"
      variant="link"
      size="sm"
      :unmount-on-hide="false"
      :ui="{
        root: 'gap-0 px-7 pt-3',
        list: 'border-white/12',
        trigger: 'label-section px-0 pb-3 pt-2 me-7 text-label data-[state=active]:text-primary',
        leadingIcon: 'size-3.5',
        indicator: 'bg-primary',
        // As tall as the tallest tab (audio), so switching does not resize the
        // menu. Measured, so it moves when a control is added to one of them.
        content: 'min-h-59 pt-[18px]',
      }"
    >
      <template #controls>
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
      </template>

      <template #graphics>
        <div class="flex items-center gap-5">
          <p class="label-section text-label">
            Quality
          </p>
          <span
            v-if="!graphics.preset.value"
            class="telemetry text-dimmed"
          >Custom</span>
          <URadioGroup
            v-model="preset"
            :items="PRESETS"
            orientation="horizontal"
            variant="card"
            indicator="hidden"
            size="xs"
            class="ml-auto"
            :ui="{ fieldset: 'gap-0', item: 'rounded-none first:rounded-l-[4px] last:rounded-r-[4px] -ml-px first:ml-0', label: 'telemetry text-toned' }"
          />
        </div>

        <p class="label-section pb-3 pt-[22px] text-label">
          Resolution
        </p>
        <div class="flex items-center gap-5">
          <USlider
            v-model="resolution"
            :min="50"
            :max="100"
            :step="5"
            size="sm"
            class="flex-1"
          />
          <span class="telemetry w-8 text-right text-label">{{ resolution }}</span>
        </div>

        <div class="flex items-center gap-5 pt-[22px]">
          <p class="label-section text-label">
            World detail
          </p>
          <URadioGroup
            v-model="graphics.detail.value"
            :items="PRESETS"
            orientation="horizontal"
            variant="card"
            indicator="hidden"
            size="xs"
            class="ml-auto"
            :ui="{ fieldset: 'gap-0', item: 'rounded-none first:rounded-l-[4px] last:rounded-r-[4px] -ml-px first:ml-0', label: 'telemetry text-toned' }"
          />
        </div>

        <div class="flex items-center justify-between gap-5 pt-[18px]">
          <USwitch
            v-model="graphics.shadows.value"
            label="Shadows"
            size="sm"
            :ui="{ label: 'text-[15px] leading-none text-toned' }"
          />
          <USwitch
            v-model="graphics.occlusion.value"
            label="Ambient occlusion"
            size="sm"
            :ui="{ label: 'text-[15px] leading-none text-toned' }"
          />
          <USwitch
            v-model="graphics.bloom.value"
            label="Bloom"
            size="sm"
            :ui="{ label: 'text-[15px] leading-none text-toned' }"
          />
        </div>
        <p class="telemetry pt-3.5 text-label">
          Resolution first, then ambient occlusion
        </p>
      </template>

      <template #audio>
        <p class="label-section pb-3 text-label">
          World
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

        <p class="label-section pb-3 pt-[22px] text-label">
          Voice
        </p>
        <div class="flex flex-col gap-3.5">
          <div class="flex items-center gap-5">
            <USwitch
              v-model="voiceOn"
              label="Proximity voice"
              size="sm"
              :disabled="voice.supported.value === false"
              :ui="{ label: 'text-[15px] leading-none text-toned' }"
            />
            <URadioGroup
              v-model="voice.mode.value"
              :items="VOICE_MODES"
              orientation="horizontal"
              variant="card"
              indicator="hidden"
              size="xs"
              class="ml-auto"
              :ui="{ fieldset: 'gap-0', item: 'rounded-none first:rounded-l-[4px] last:rounded-r-[4px] -ml-px first:ml-0', label: 'telemetry text-toned' }"
            />
          </div>
          <div class="flex items-center gap-5">
            <USlider
              v-model="voiceLevel"
              :min="0"
              :max="100"
              :disabled="!voice.enabled.value"
              size="sm"
              class="flex-1"
            />
            <span class="telemetry w-8 text-right text-label">{{ voiceLevel }}</span>
            <UKbd value="T" />
          </div>
          <!-- The mute is about the microphone and not the mixer above it, so it
             lives here rather than under World. It survives a reload, which is
             why it is shown even with voice off. -->
          <div class="flex items-center gap-5">
            <USwitch
              v-model="micMuted"
              label="Mute microphone"
              size="sm"
              :ui="{ label: 'text-[15px] leading-none text-toned' }"
            />
            <UKbd
              value="N"
              class="ml-auto"
            />
          </div>
          <div class="flex items-center justify-between gap-5">
            <p class="telemetry text-label">
              {{ voiceState }}
            </p>
            <!-- Only push to talk is ever transcribed, so the toggle goes away in
               open mic rather than sitting there doing nothing. Hidden rather
               than removed: it is the tallest thing in this row, and taking it
               out of the flow resized the menu under the mode switch. -->
            <USwitch
              v-model="voice.speechToChat.value"
              label="Post what I say to chat"
              size="sm"
              :class="{ invisible: voice.mode.value !== 'ptt' }"
              :ui="{ label: 'text-[13px] leading-none text-muted' }"
            />
          </div>
          <!-- Shown once, the first time anyone turns voice on. Not a warning,
             just the two facts a player deserves before they speak. -->
          <div
            v-if="voice.enabled.value && !voice.noticeSeen.value"
            class="flex flex-col items-start gap-3 border-t border-white/10 pt-3.5"
          >
            <p class="text-[13px]/[1.55] text-muted text-pretty">
              Voice only reaches players standing near you in the world, and it stops when they walk away.
              Audio goes to the server and straight back out to them, and nothing is stored.
              While Post what I say to chat is on, each thing you say while holding T is also sent to a speech to text provider to be written into the chat.
            </p>
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              label="Got it"
              @click="voice.noticeSeen.value = true"
            />
          </div>
        </div>
      </template>
    </UTabs>

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
