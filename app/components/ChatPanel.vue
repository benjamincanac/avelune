<script setup lang="ts">
import { MAX_CHAT_LENGTH } from '#shared/types/game'
import type { ChatMessage, UseGame } from '~/composables/useGame'

/**
 * Bottom-left chat, MMO style: a scrollback of recent messages from everyone in
 * the arena, with the input underneath. Enter or `/` focuses it from anywhere;
 * Escape hands control back to the game.
 *
 * It is a panel rather than plain text on the render, because it is the one
 * thing down there you can click — the HUD rule reserves frost for exactly
 * that. Focusing widens it, tints the input row with the accent and holds
 * movement, which the caller mirrors by dimming the hotbar.
 */

const props = defineProps<{ game: UseGame }>()
const emit = defineEmits<{ focus: [], blur: [] }>()

const text = ref('')
const focused = ref(false)
const input = useTemplateRef('input')
const scrollback = useTemplateRef('scrollback')

/** The whole log, always: the scrollback caps the height and scrolls the rest,
 *  so focusing the input never resizes the panel. */
const messages = computed<ChatMessage[]>(() => props.game.chatLog.value)

// A new line follows the bottom only if you were already there, so reading
// back through the log is not yanked down by the next message.
watch(messages, async () => {
  const el = scrollback.value
  const pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24
  await nextTick()
  if (pinned) scrollback.value?.scrollTo({ top: scrollback.value.scrollHeight })
})

watch(focused, (value) => {
  if (value) emit('focus')
  else emit('blur')
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
  if ((event.key === 'Enter' || event.key === '/') && !typing) {
    // preventDefault keeps the keystroke out of the freshly focused input; the
    // slash is re-added through the model so it starts a command like Discord.
    event.preventDefault()
    if (event.key === '/') text.value = '/'
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
  <div class="frost pointer-events-auto flex w-105 min-h-0 flex-col overflow-hidden rounded-[6px]">
    <div
      ref="scrollback"
      class="flex max-h-56 flex-col gap-1.5 overflow-y-auto overscroll-contain px-4 py-3"
      :class="messages.length ? '' : 'hidden'"
    >
      <p
        v-for="message in messages"
        :key="`${message.id}-${message.at}`"
        class="wrap-break-word text-pretty text-sm"
        :class="message.system || message.npc ? 'text-muted' : 'text-default'"
      >
        <b
          class="font-semibold"
          :style="{ color: message.system ? 'var(--ui-primary)' : message.color }"
        >{{ message.system ? 'System' : message.name }}</b>
        {{ message.text }}
      </p>
    </div>

    <!-- The row is the input's own root, so the whole strip takes the click and
         the keycap rides its leading slot. -->
    <UInput
      ref="input"
      v-model="text"
      placeholder="say something…"
      :maxlength="MAX_CHAT_LENGTH"
      variant="none"
      :ui="{
        root: ['w-full border-t border-white/10 px-4.5 py-3 transition-colors duration-120 ease-out', focused ? 'bg-primary/6' : ''],
        base: 'h-auto rounded-none py-0 ps-14 text-[15px] leading-none text-default caret-primary placeholder:text-muted',
        leading: 'ps-4',
      }"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.enter.prevent="submit"
    >
      <!-- The cap advertises the key that is live: Enter gets you in, Esc gets
           you back to the game. -->
      <template #leading>
        <UKbd
          :value="focused ? 'Esc' : 'Enter'"
          class="w-11 text-center"
        />
      </template>
    </UInput>
  </div>
</template>
