<script setup lang="ts">
import { GENDERS, HAIRSTYLES, OUTFITS, OUTFIT_COLORS, PLAYER_COLORS, characterName, isAllowedColorIndex, isOutfitColor, randomAppearance, randomColorIndex } from '#shared/utils/characters'
import type { Gender } from '#shared/utils/characters'
import type { Player } from '#shared/types/game'

/**
 * The onboarding gate previews appearance changes before creating an identity.
 * Characters offer gender, outfit, hairstyle and texture colorway choices.
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
const character = computed(() => characterName(currentOutfit.value.id, gender.value, hairId.value))
// A name is required to enter (Accept disabled, Enter ignored, until non-blank).
const canSubmit = computed(() => username.value.trim().length > 0)

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
    toast.add({ title: props.initial ? 'Could not save your character' : 'Could not enter the arena', description: 'Please try again.', color: 'error', icon: 'i-lucide-triangle-alert' })
    submitting.value = false
  }
}

onMounted(() => input.value?.inputRef?.focus())
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-40 overflow-hidden bg-[#05070d] text-white">
    <!-- Per-outfit atmospheric backdrop, crossfading when the outfit changes. -->
    <Transition
      enter-active-class="transition-opacity duration-500"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-500"
      leave-to-class="opacity-0"
    >
      <div
        :key="currentOutfit.id"
        class="absolute inset-0"
        :style="{ background: currentOutfit.bg }"
      />
    </Transition>

    <!-- Big 3D character stage (transparent canvas over the backdrop). -->
    <CharacterPreview
      :character="character"
      :outfit-color="outfitColor"
      class="absolute inset-0"
    />
    <!-- Vignette for depth (transparent center keeps the character crisp). -->
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_42%,transparent_38%,#05070daa_92%)]" />

    <!-- Brand. -->
    <div class="absolute left-6 top-5 z-10 flex items-center gap-2.5">
      <img
        src="/logo.svg?v=wind"
        alt="Tempest"
        class="size-9 rounded-md"
      >
      <div class="flex flex-col leading-tight">
        <span class="text-sm font-semibold tracking-[0.2em] text-highlighted">TEMPEST</span>
        <span class="text-[11px] text-muted">{{ initial ? 'Customize your character' : 'Create your character' }}</span>
      </div>
    </div>

    <!-- Left: creation controls. -->
    <div class="absolute left-6 top-24 z-10 flex max-h-[calc(100vh-12rem)] w-80 flex-col gap-4 overflow-y-auto rounded-lg ring ring-white/5 bg-black/35 p-4 backdrop-blur">
      <!-- Gender -->
      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Gender
        </p>
        <div class="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-1">
          <button
            v-for="g in GENDERS"
            :key="g"
            type="button"
            class="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition"
            :class="gender === g ? 'bg-primary text-inverted' : 'text-muted hover:text-highlighted'"
            @click="gender = g"
          >
            <UIcon :name="g === 'Male' ? 'i-lucide-mars' : 'i-lucide-venus'" />
            {{ g }}
          </button>
        </div>
      </div>

      <!-- Outfit -->
      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Outfit
        </p>
        <div class="flex flex-col gap-1">
          <button
            v-for="(o, i) in OUTFITS"
            :key="o.id"
            type="button"
            class="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition"
            :class="outfitIndex === i
              ? 'border-primary/60 bg-primary/15 text-highlighted'
              : 'border-white/10 bg-black/30 text-toned hover:border-white/25'"
            @click="outfitIndex = i"
          >
            <UIcon
              :name="o.icon"
              class="size-5 shrink-0"
              :class="outfitIndex === i ? 'text-primary' : 'text-muted'"
            />
            <span class="text-sm font-medium">{{ o.name }}</span>
          </button>
        </div>
      </div>

      <!-- Hairstyle -->
      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Hair
        </p>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="(h, i) in hairstyles"
            :key="h.id"
            type="button"
            class="rounded-lg border px-3 py-1.5 text-sm font-medium transition"
            :class="hairIndex === i
              ? 'border-primary/60 bg-primary/15 text-highlighted'
              : 'border-white/10 bg-black/30 text-toned hover:border-white/25'"
            @click="hairIndex = i"
          >
            {{ h.name }}
          </button>
        </div>
      </div>

      <!-- Outfit color (texture-pack colorways) -->
      <div v-if="colorways.length > 1">
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Outfit color
        </p>
        <div class="flex items-center gap-2">
          <button
            v-for="(c, i) in colorways"
            :key="c.name"
            type="button"
            class="size-7 rounded-md ring-2 ring-offset-2 ring-offset-black/55 transition"
            :class="i === outfitColor ? 'ring-white' : 'ring-transparent hover:ring-white/40'"
            :style="{ backgroundColor: c.swatch }"
            :aria-label="c.name"
            :title="c.name"
            @click="outfitColor = i"
          />
        </div>
      </div>

      <UButton
        icon="i-lucide-dices"
        label="Randomize"
        color="neutral"
        variant="soft"
        block
        @click="randomize"
      />
    </div>

    <!-- Right: flavor. -->
    <aside class="absolute right-6 top-24 z-10 hidden w-72 flex-col gap-3 rounded-lg ring ring-white/5 bg-black/55 p-4 backdrop-blur lg:flex">
      <div class="flex items-center gap-2">
        <UIcon
          :name="currentOutfit.icon"
          class="size-5 text-primary"
        />
        <span class="text-base font-semibold text-highlighted">{{ currentOutfit.name }}</span>
      </div>
      <p class="text-sm leading-relaxed text-toned">
        {{ currentOutfit.blurb }}
      </p>
    </aside>

    <!-- Character caption. -->
    <div class="pointer-events-none absolute inset-x-0 bottom-29 z-10 flex justify-center">
      <p class="text-sm">
        <span class="font-semibold text-highlighted">{{ currentOutfit.name }}</span>
        <span class="text-muted"> · {{ gender }}</span>
      </p>
    </div>

    <!-- Bottom: name + enter. -->
    <div class="absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div class="flex flex-col w-full max-w-3xs items-center gap-2">
        <UInput
          ref="input"
          v-model="username"
          placeholder="Name your character"
          :maxlength="20"
          color="neutral"
          size="lg"
          class="flex-1 w-full"
          autofocus
          @keydown.enter.prevent="submit"
        />
        <div class="flex w-full gap-2">
          <UButton
            v-if="initial"
            label="Cancel"
            color="neutral"
            variant="soft"
            size="lg"
            :disabled="submitting"
            class="flex-1 justify-center"
            @click="emit('cancel')"
          />
          <UButton
            :label="initial ? 'Save' : 'Enter'"
            color="neutral"
            size="lg"
            :loading="submitting"
            :disabled="!canSubmit"
            class="flex-1 justify-center"
            @click="submit"
          />
        </div>
      </div>
    </div>
  </div>
</template>
