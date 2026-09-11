<script setup lang="ts">
import { GENDERS, characterForGender, randomColorIndex } from '#shared/utils/characters'
import type { Gender } from '#shared/utils/characters'
import type { Player } from '#shared/types/game'

/**
 * The entry gate: pick a body (male / female Developer) and a name, then enter.
 * The accent colour is rolled here, hidden: chat/nameplate identity only.
 * Submitting POSTs to /api/auth, which sets the signed identity cookie.
 */
const emit = defineEmits<{ done: [identity: Player] }>()

const toast = useToast()

const gender = ref<Gender>('Male')
const username = ref('')
const submitting = ref(false)

const input = useTemplateRef('input')

const canSubmit = computed(() => username.value.trim().length > 0)

async function submit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true
  try {
    const identity = await $fetch<Player & { authenticated: boolean }>('/api/auth', {
      method: 'POST',
      body: { username: username.value, character: characterForGender(gender.value), colorIndex: randomColorIndex() },
    })
    emit('done', identity)
  }
  catch {
    toast.add({ title: 'Could not enter the arena', description: 'Please try again.', color: 'error', icon: 'i-lucide-triangle-alert' })
    submitting.value = false
  }
}

onMounted(() => input.value?.inputRef?.focus())
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center overflow-hidden bg-[#05070d] text-white">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,#1a1a1f_0%,transparent_60%)]" />

    <div class="absolute left-6 top-5 z-10 flex items-center gap-2.5">
      <img
        src="/logo.svg"
        alt="Vercel Stadium"
        class="size-9 rounded-md"
      >
      <div class="flex flex-col leading-tight">
        <span class="text-sm font-semibold tracking-[0.2em] text-highlighted">VERCEL STADIUM</span>
        <span class="text-[11px] text-muted">Enter the arena</span>
      </div>
    </div>

    <div class="z-10 flex w-full max-w-xs flex-col gap-5 rounded-xl bg-black/50 p-5 ring ring-white/10 backdrop-blur">
      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Developer
        </p>
        <div class="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-1">
          <button
            v-for="g in GENDERS"
            :key="g"
            type="button"
            class="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition"
            :class="gender === g ? 'bg-white text-black' : 'text-muted hover:text-highlighted'"
            @click="gender = g"
          >
            <UIcon :name="g === 'Male' ? 'i-lucide-mars' : 'i-lucide-venus'" />
            {{ g }}
          </button>
        </div>
      </div>

      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Name
        </p>
        <UInput
          ref="input"
          v-model="username"
          placeholder="Your handle"
          :maxlength="20"
          color="neutral"
          size="lg"
          class="w-full"
          autofocus
          @keydown.enter.prevent="submit"
        />
      </div>

      <UButton
        label="Enter"
        color="neutral"
        size="lg"
        :loading="submitting"
        :disabled="!canSubmit"
        block
        @click="submit"
      />
    </div>
  </div>
</template>
