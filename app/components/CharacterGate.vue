<script setup lang="ts">
import { GENDERS, HAIRSTYLES, OUTFITS, OUTFIT_COLORS, PLAYER_COLORS, characterName, isAllowedColorIndex, isOutfitColor, randomAppearance, randomColorIndex } from '#shared/utils/characters'
import type { Gender } from '#shared/utils/characters'
import type { Player } from '#shared/types/game'
import { DEED_LIMIT, EDIT_REACH, MAX_PIECES_PER_PLAYER } from '#shared/utils/building'
import { BUILD_PAGES } from '~/composables/useBuild'
import type { WorldEvent } from '~/composables/useFeed'

/**
 * The onboarding gate previews appearance changes before creating an identity.
 * Characters offer gender, outfit, hairstyle and texture colorway choices.
 *
 * Three zones on a dark stage: options left, dossier right, the commit stack
 * centred at the bottom. The character is the only thing at full brightness —
 * everything else is frost over a neutral radial, so a change of outfit reads
 * on the model rather than on the furniture.
 *
 * The accent color is NOT chosen here — it's rolled randomly at login (never
 * green/teal, reserved for system UI) and used only as a chat/nameplate
 * identity, never to dye the outfit.
 *
 * Submitting POSTs to /api/auth (which sets the signed identity cookie); on
 * success the page opens the socket and drops into the hub.
 */
const props = defineProps<{ initial?: Pick<Player, 'name' | 'color' | 'character' | 'outfitColor'> }>()
const emit = defineEmits<{ done: [identity: Player], cancel: [] }>()

const toast = useToast()
const feed = useFeed()

/** The server's own limit (`auth.post.ts`), mirrored so the counter is true. */
const MAX_NAME = 20

const initialParts = props.initial?.character?.split('_') ?? []
const initialGender = GENDERS.find(g => g === initialParts[1]) ?? 'Male'
const initialOutfitIndex = Math.max(0, OUTFITS.findIndex(o => o.id === initialParts[0]))
const initialColorIndex = PLAYER_COLORS.indexOf(props.initial?.color ?? '')
const gender = ref<Gender>(initialGender)
const outfitIndex = ref(initialOutfitIndex)
const hairIndex = ref(Math.max(0, HAIRSTYLES[initialGender].findIndex(h => h.id === initialParts[2])))
const outfitColor = ref(isOutfitColor(OUTFITS[initialOutfitIndex]!.id, props.initial?.outfitColor) ? props.initial!.outfitColor : 0)
const colorIndex = ref(isAllowedColorIndex(initialColorIndex) ? initialColorIndex : randomColorIndex()) // accent, hidden (chat only)
const username = ref(props.initial?.name ?? '')
const submitting = ref(false)
const input = useTemplateRef('input')

const currentOutfit = computed(() => OUTFITS[outfitIndex.value]!)
const hairstyles = computed(() => HAIRSTYLES[gender.value])
const colorways = computed(() => OUTFIT_COLORS[currentOutfit.value.id] ?? [])
const hairId = computed(() => hairstyles.value[hairIndex.value]?.id)
const hairName = computed(() => hairstyles.value[hairIndex.value]?.name ?? '')
const character = computed(() => characterName(currentOutfit.value.id, gender.value, hairId.value))
// A name is required to enter (Accept disabled, Enter ignored, until non-blank).
const canSubmit = computed(() => username.value.trim().length > 0)

/**
 * Every choice on this panel is a single-select, so each one is a real
 * `URadioGroup`: arrow-key navigation, a focus ring, and a radio the form and a
 * screen reader can both see. The look is the design's fused cells, applied
 * through `ui` rather than by hand-rolling buttons — which is what lost the
 * focus states in the first place.
 */
const genderItems = computed(() => GENDERS.map(g => ({ label: g, value: g })))
// `glyph`, not `icon`: with `indicator="hidden"` URadioGroup renders an item's
// `icon` itself, centred above the label, on top of the one the slot draws.
const outfitItems = computed(() => OUTFITS.map((outfit, value) => ({ label: outfit.name, glyph: outfit.icon, value })))
const hairItems = computed(() => hairstyles.value.map((hair, value) => ({ label: hair.name, value })))
const colorwayItems = computed(() => colorways.value.map((colorway, value) => ({ label: colorway.name, swatch: colorway.swatch, value })))

/** The library's card focus is a 25%-opacity outline plus a 1px border colour,
 *  which disappears against a frosted panel — these cells state it outright. */
const FOCUS = 'has-focus-visible:outline-solid has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary'
/** Square, fused by a 1px gap over the panel, and never rounded by the library
 *  default. The two checked treatments below differ only in weight: a solid
 *  accent fill for the top-level choice, an accent wash for the sub-choices. */
const CELL = `flex-1 rounded-none border-transparent p-0 bg-white/8 transition-colors duration-120 ease-out hover:bg-white/12 ${FOCUS}`
const CELL_SOLID = {
  fieldset: 'flex-nowrap gap-px',
  item: `${CELL} has-data-[state=checked]:border-transparent has-data-[state=checked]:bg-primary`,
  wrapper: 'w-full',
  label: 'w-full',
}
const CELL_WASH = {
  fieldset: 'flex-nowrap gap-px',
  item: `${CELL} has-data-[state=checked]:border-primary/45 has-data-[state=checked]:bg-primary/12`,
  wrapper: 'w-full',
  label: 'w-full',
}
const SWATCH = {
  fieldset: 'flex-nowrap gap-2',
  item: `rounded-[4px] border-transparent p-0 has-data-[state=checked]:border-transparent ${FOCUS}`,
  wrapper: 'w-full',
  label: 'w-full',
}

/** What the server hands every new character, straight from the shared rules. */
const dossier = computed(() => [
  { label: 'Carry', value: `${MAX_PIECES_PER_PLAYER} pieces` },
  { label: 'Reach', value: `${EDIT_REACH} tiles` },
  { label: 'Plots', value: `${DEED_LIMIT}` },
  { label: 'Tools', value: (BUILD_PAGES[0]?.slots ?? []).slice(0, 3).map(slot => slot.label).join(' · '), accent: true },
])

// Keep sub-selections valid as gender/outfit change.
watch([gender, outfitIndex], () => {
  if (hairIndex.value >= hairstyles.value.length) hairIndex.value = 0
  if (outfitColor.value >= colorways.value.length) outfitColor.value = 0
})

function randomize() {
  const a = randomAppearance()
  gender.value = a.gender
  outfitIndex.value = Math.max(0, OUTFITS.findIndex(o => o.id === a.outfit))
  hairIndex.value = Math.max(0, HAIRSTYLES[a.gender].findIndex(h => h.id === a.hairId))
  outfitColor.value = a.outfitColor
  if (!props.initial) colorIndex.value = randomColorIndex()
}

async function submit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true
  try {
    const identity = await $fetch<Player & { authenticated: boolean }>('/api/auth', {
      method: 'POST',
      body: {
        username: username.value,
        character: character.value,
        colorIndex: colorIndex.value,
        outfitColor: outfitColor.value,
      },
    })
    emit('done', identity)
  }
  catch {
    toast.add({ title: props.initial ? 'Could not save your character' : 'Could not enter the town', description: 'Please try again.', color: 'error', icon: 'i-lucide-triangle-alert' })
    submitting.value = false
  }
}

onMounted(async () => {
  input.value?.inputRef?.focus()
  // The world is already running while you pick a face; show it. One probe, no
  // poll — this screen is measured in seconds, not minutes.
  try {
    const status = await $fetch<{ feed: WorldEvent[] }>('/api/status')
    feed.adopt(status.feed)
  }
  catch {
    // The feed is a nicety here; without it the aside simply doesn't render.
  }
})
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-40 overflow-hidden bg-stage text-white">
    <!-- The stage. One neutral radial, so the character is the only thing at
         full brightness and an outfit change reads on the model. -->
    <div class="absolute inset-0 bg-[radial-gradient(66%_62%_at_50%_40%,#16222b_0%,#0c1216_48%,#070d0f_100%)]" />
    <!-- The ground under the feet. Placed as a fraction of the stage rather than
         a fixed offset from the bottom: the camera frames the figure by its own
         height, so the boots land at the same 72% whatever the window is. -->
    <div class="absolute left-1/2 top-[72%] h-px w-105 -translate-x-1/2 -translate-y-1/2 bg-[linear-gradient(90deg,rgb(111_240_218/0),rgb(111_240_218/0.5),rgb(111_240_218/0))]" />
    <div class="absolute left-1/2 top-[72%] h-15 w-110 -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-[radial-gradient(50%_50%,rgb(111_240_218/0.16),rgb(111_240_218/0))]" />

    <!-- Big 3D character stage (transparent canvas over the backdrop). -->
    <CharacterPreview
      :character="character"
      :outfit-color="outfitColor"
      class="absolute inset-0"
    />

    <!-- Brand + what this screen is. -->
    <div class="absolute left-9 top-8 z-10 flex items-center gap-3.5">
      <BrandMark size="sm" />
      <span class="h-4 w-px bg-white/18" />
      <span class="telemetry tracking-[0.18em] text-dimmed">{{ initial ? 'Customize your character' : 'Create your character' }}</span>
    </div>

    <!-- Left: creation controls. -->
    <div class="frost absolute left-9 top-24 z-10 flex max-h-[calc(100dvh-14rem)] w-79.5 flex-col gap-5.5 overflow-y-auto rounded-[6px] p-5.5">
      <URadioGroup
        v-model="gender"
        legend="Gender"
        :items="genderItems"
        variant="card"
        orientation="horizontal"
        indicator="hidden"
        :ui="{ ...CELL_SOLID, legend: 'label-section mb-2.25 text-label' }"
      >
        <template #label="{ item, modelValue }">
          <span
            class="block w-full py-3 text-center font-display text-sm uppercase leading-none tracking-[0.16em]"
            :class="modelValue === item.value ? 'font-bold text-avelune-950' : 'font-semibold text-muted'"
          >{{ item.label }}</span>
        </template>
      </URadioGroup>

      <!-- No notch on these rows: it is reserved for actions, and here it read
           as noise. -->
      <URadioGroup
        v-model="outfitIndex"
        legend="Outfit"
        :items="outfitItems"
        variant="card"
        orientation="vertical"
        indicator="hidden"
        :ui="{ ...CELL_WASH, legend: 'label-section mb-2.25 text-label' }"
      >
        <template #label="{ item, modelValue }">
          <span class="flex w-full items-center gap-3.25 px-3.5 py-3.25 text-left">
            <UIcon
              :name="item.glyph"
              class="size-4.25 shrink-0"
              :class="modelValue === item.value ? 'text-primary' : 'text-dimmed'"
            />
            <span
              class="flex-1 text-base leading-none"
              :class="modelValue === item.value ? 'font-semibold text-highlighted' : 'font-medium text-toned'"
            >{{ item.label }}</span>
            <span
              v-if="modelValue === item.value"
              class="telemetry text-primary"
            >Active</span>
          </span>
        </template>
      </URadioGroup>

      <URadioGroup
        v-model="hairIndex"
        legend="Hair"
        :items="hairItems"
        variant="card"
        orientation="horizontal"
        indicator="hidden"
        :ui="{ ...CELL_WASH, legend: 'label-section mb-2.25 text-label' }"
      >
        <template #label="{ item, modelValue }">
          <span
            class="block w-full py-2.75 text-center font-display text-[13px] uppercase leading-none tracking-[0.14em]"
            :class="modelValue === item.value ? 'font-bold text-primary' : 'font-semibold text-muted'"
          >{{ item.label }}</span>
        </template>
      </URadioGroup>

      <URadioGroup
        v-if="colorways.length > 1"
        v-model="outfitColor"
        legend="Outfit colour"
        :items="colorwayItems"
        variant="card"
        orientation="horizontal"
        indicator="hidden"
        :ui="{ ...SWATCH, legend: 'label-section mb-2.25 text-label' }"
      >
        <template #label="{ item, modelValue }">
          <span
            class="block size-9.5 rounded-[4px] transition-shadow duration-120 ease-out"
            :class="modelValue === item.value
              ? 'shadow-[0_0_0_2px_var(--ui-primary)]'
              : 'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] hover:shadow-[0_0_0_2px_rgb(255_255_255/0.4)]'"
            :style="{ backgroundColor: item.swatch }"
          />
          <span class="sr-only">{{ item.label }}</span>
        </template>
      </URadioGroup>

      <UButton
        block
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-lucide-dices"
        label="Randomise"
        @click="randomize"
      />
    </div>

    <!-- Right: what you are choosing, and what the world hands you for it. -->
    <aside class="absolute right-9 top-24 z-10 hidden w-81 flex-col lg:flex">
      <div class="frost rounded-[6px] border-t-2 border-primary p-5.5">
        <div class="flex items-center gap-3">
          <span class="flex size-8.5 items-center justify-center rounded-[4px] bg-primary/14 text-primary">
            <UIcon
              :name="currentOutfit.icon"
              class="size-4"
            />
          </span>
          <h2 class="font-display text-[22px] font-bold uppercase leading-none tracking-widest text-highlighted">
            {{ currentOutfit.name }}
          </h2>
        </div>
        <p class="mt-4 text-base/normal text-muted text-pretty">
          {{ currentOutfit.blurb }}
        </p>
        <dl class="fused mt-5 flex-col bg-white/8">
          <div
            v-for="row in dossier"
            :key="row.label"
            class="telemetry flex items-center justify-between gap-4 bg-white/6 px-3 py-2.5"
          >
            <dt class="shrink-0 text-label">
              {{ row.label }}
            </dt>
            <dd
              class="truncate"
              :class="row.accent ? 'text-primary' : 'text-highlighted'"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- The town is already running while you pick a face. -->
      <WorldFeed
        :events="feed.events.value"
        :rows="2"
        class="-mr-9 mt-5"
      />
    </aside>

    <!-- Bottom: what you picked, what you are called, and the way in. -->
    <div class="absolute inset-x-0 bottom-8.5 z-10 flex justify-center px-6">
      <div class="flex w-110 max-w-full flex-col items-center gap-2.5">
        <p class="telemetry flex items-center gap-3 whitespace-nowrap tracking-[0.18em] text-dimmed">
          <span class="text-highlighted">{{ currentOutfit.name }}</span>
          <span class="text-faint">·</span>
          <span>{{ gender }}</span>
          <template v-if="hairName">
            <span class="text-faint">·</span>
            <span>{{ hairName }}</span>
          </template>
        </p>

        <!-- The frame belongs to the input's own root, and the label and counter
             to its leading/trailing slots. Wrapping it in a div instead leaves a
             field whose padding looks clickable and isn't. -->
        <UInput
          ref="input"
          v-model="username"
          placeholder="Name your character"
          :maxlength="MAX_NAME"
          variant="none"
          autofocus
          :ui="{
            root: 'frost w-full rounded-[6px] px-5 py-4 shadow-[inset_0_0_0_1px_rgb(111_240_218/0.34)]',
            base: 'h-auto rounded-none py-0 pe-14 ps-15 text-lg leading-none text-highlighted caret-primary placeholder:text-label',
            leading: 'ps-5',
            trailing: 'pe-5',
          }"
          @keydown.enter.prevent="submit"
        >
          <template #leading>
            <span class="telemetry tracking-[0.16em] text-primary">Name</span>
          </template>
          <template #trailing>
            <span class="font-mono text-[10px] font-semibold leading-none text-faint">{{ username.length }} / {{ MAX_NAME }}</span>
          </template>
        </UInput>

        <div class="flex w-full gap-2">
          <UButton
            v-if="initial"
            color="neutral"
            variant="subtle"
            size="lg"
            label="Cancel"
            :disabled="submitting"
            class="flex-1 justify-center py-4.5 text-sm"
            @click="emit('cancel')"
          />
          <UButton
            size="lg"
            trailing-icon="i-lucide-play"
            :label="initial ? 'Save character' : 'Enter the world'"
            :loading="submitting"
            :disabled="!canSubmit"
            class="notch-wide flex-1 justify-center py-4.5 text-[17px] tracking-[0.2em] disabled:opacity-55"
            @click="submit"
          />
        </div>
      </div>
    </div>
  </div>
</template>
