<script setup lang="ts">
import type { ChatMessage, UseGame } from '~/composables/useGame'

/**
 * Bottom-left chat, MMO style: a scrollback of recent messages from everyone in
 * the arena, with the input underneath. Enter or `/` focuses it from anywhere;
 * Escape hands control back to the game.
 */

const props = defineProps<{ game: UseGame }>()

const text = ref('')
const focused = ref(false)
const input = useTemplateRef('input')
const scrollback = useTemplateRef('scrollback')

const placeholder = computed(() => focused.value ? 'Press Esc to play…' : 'Press Enter to chat…')

const messages = computed<ChatMessage[]>(() => props.game.chatLog.value.slice(-9))

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
  <div class="pointer-events-auto flex w-92 flex-col bg-black/35 overflow-hidden min-h-0 ring ring-white/5 divide-y divide-white/5 rounded-lg">
    <div
      ref="scrollback"
      class="flex max-h-44 flex-col justify-end gap-1 overflow-y-auto p-2.5 text-[13px] leading-snug backdrop-blur-sm"
      :class="messages.length ? '' : 'opacity-0'"
    >
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
          >{{ message.text }}</span>
        </template>
        <template v-else>
          <span
            class="font-semibold"
            :style="{ color: message.color }"
          >{{ message.name }}: </span>
          <span class="text-default/90">{{ message.text }}</span>
        </template>
      </p>
    </div>

    <UInput
      ref="input"
      v-model="text"
      :placeholder="placeholder"
      :maxlength="120"
      size="sm"
      variant="none"
      class="w-full"
      :ui="{ base: 'backdrop-blur-sm placeholder:text-default/90' }"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.enter.prevent="submit"
    />
  </div>
</template>
