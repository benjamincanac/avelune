<script setup lang="ts">
import { MAX_CHAT_LENGTH } from '#shared/types/game'
import type { ChatMessage, UseGame } from '~/composables/useGame'

/**
 * Left-column chat, MMO style: a scrollback of messages from everyone in the
 * arena filling the height the parent gives it, with the input underneath.
 * Enter focuses it from anywhere; Escape hands control back to the game. The
 * Coach's docs answers end with a URL, so its lines are rendered with links.
 */

const props = defineProps<{ game: UseGame }>()
const coach = useCoach()

// Scheme optional: the model sometimes cites "vercel.com/docs/…" bare.
const URL_RE = /((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|dev|org|app|sh)\/[^\s]+)/i

/** Split a line into text and link parts; trailing punctuation stays text. */
function linkify(text: string): { text: string, href?: string }[] {
  return text.split(URL_RE).filter(Boolean).map((part) => {
    if (!URL_RE.test(part)) return { text: part }
    const trimmed = part.replace(/[.,;:)]+$/, '')
    return { text: trimmed, href: /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}` }
  })
}

const text = ref('')
const focused = ref(false)
const input = useTemplateRef('input')
const scrollback = useTemplateRef('scrollback')

const placeholder = computed(() => focused.value ? 'Press Esc to play…' : 'Press Enter to chat or ask Coach…')

const messages = computed<ChatMessage[]>(() => props.game.chatLog.value)

watch(messages, async () => {
  await nextTick()
  scrollback.value?.scrollTo({ top: scrollback.value.scrollHeight })
})

function submit() {
  props.game.sendChat(text.value)
  text.value = ''
  setTimeout(() => {
    input.value?.inputRef?.blur()
  }, 0)
}

function onKeyDown(event: KeyboardEvent) {
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
  if (event.key === 'Enter' && !typing) {
    event.preventDefault()
    input.value?.inputRef?.focus()
  }
  else if (event.key === 'Escape' && typing) {
    input.value?.inputRef?.blur()
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="pointer-events-auto flex w-full flex-col bg-black/35 overflow-hidden min-h-0 ring ring-white/5 divide-y divide-white/5 rounded-lg">
    <!-- `mt-auto` on the first line pins a short log to the bottom; a long one scrolls. -->
    <div
      ref="scrollback"
      class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2.5 text-[13px] leading-snug backdrop-blur-sm"
    >
      <div class="mt-auto" />
      <p
        v-for="message in messages"
        :key="`${message.id}-${message.at}`"
        class="wrap-break-word"
      >
        <template v-if="message.system">
          <span
            class="font-semibold text-primary"
          >System: </span>
          <span class="text-primary italic">{{ message.text }}</span>
        </template>
        <template v-else-if="message.npc">
          <span
            class="font-semibold"
            :style="{ color: message.color }"
          >{{ message.name }}: </span>
          <span
            class="italic"
            :style="{ color: message.color }"
          ><template
            v-for="(part, i) in linkify(message.text)"
            :key="i"
          ><a
            v-if="part.href"
            :href="part.href"
            target="_blank"
            rel="noopener"
            class="underline decoration-current/50 hover:decoration-current"
          >{{ part.text }}</a><template v-else>{{ part.text }}</template></template></span>
        </template>
        <template v-else>
          <span
            class="font-semibold"
            :style="{ color: message.color }"
          >{{ message.name }}: </span>
          <span class="text-default/90">{{ message.text }}</span>
        </template>
      </p>
      <p
        v-if="coach.thinking.value"
        class="animate-pulse text-xs italic text-muted"
      >
        Coach is checking the docs…
      </p>
    </div>

    <UInput
      ref="input"
      v-model="text"
      :placeholder="placeholder"
      :maxlength="MAX_CHAT_LENGTH"
      size="sm"
      variant="none"
      class="w-full"
      :ui="{ base: 'backdrop-blur-sm' }"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.enter.prevent="submit"
    />
  </div>
</template>
