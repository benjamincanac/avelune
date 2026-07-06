<script setup lang="ts">
import type { ChatMessage, UseGame } from '~/composables/useGame'

/**
 * Bottom-left chat, MMO style: a scrollback of recent messages from runners
 * on *your* floor, with the input underneath. Enter focuses it from anywhere;
 * Escape hands control back to the game.
 */

const props = defineProps<{ game: UseGame }>()

const text = ref('')
const input = useTemplateRef('input')
const scrollback = useTemplateRef('scrollback')

const messages = computed<ChatMessage[]>(() =>
  props.game.chatLog.value
    .filter((message: ChatMessage) => message.floor === props.game.selfFloor.value)
    .slice(-9),
)

watch(messages, async () => {
  await nextTick()
  scrollback.value?.scrollTo({ top: scrollback.value.scrollHeight })
})

function submit() {
  props.game.sendChat(text.value)
  text.value = ''
  input.value?.inputRef?.blur()
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
  <div class="pointer-events-auto flex w-80 flex-col gap-1.5">
    <div
      ref="scrollback"
      class="flex max-h-44 flex-col justify-end gap-1 overflow-y-auto rounded-lg bg-black/35 p-2 text-[13px] leading-snug backdrop-blur-sm"
      :class="messages.length ? '' : 'opacity-0'"
    >
      <p
        v-for="message in messages"
        :key="`${message.id}-${message.at}`"
        class="break-words"
      >
        <span
          class="font-semibold"
          :style="{ color: message.color }"
        >{{ message.name }}:</span>
        <span class="text-default/90"> {{ message.text }}</span>
      </p>
    </div>
    <UInput
      ref="input"
      v-model="text"
      placeholder="Press Enter to chat…"
      :maxlength="120"
      size="sm"
      class="w-full"
      :ui="{ base: 'bg-black/45 backdrop-blur border-white/10' }"
      @keydown.enter.prevent="submit"
    />
  </div>
</template>
