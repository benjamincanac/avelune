<script setup lang="ts">
/**
 * Who is talking, and whether you are.
 *
 * Read-only, so it follows the HUD rule and sits as plain text on the edge wash
 * rather than in a panel: there is nothing here to click. It renders nothing at
 * all while voice is off, which is the normal state.
 *
 * The talking indicator needs no bit on the wire. Audio arriving from a player is
 * the signal, and its level is measured on this client's own voice bus.
 */
export interface VoiceRow {
  id: string
  name: string
  /** Their inbound level has been over the speech threshold recently. */
  speaking: boolean
}

defineProps<{
  /** Off means render nothing. */
  enabled: boolean
  /** The mic is muted. Outranks every other state here: nothing is going out,
   *  whatever the mode would otherwise be doing. */
  muted: boolean
  /** The local mic is open: the key is held, or open mic is on. */
  open: boolean
  /** Speech is being picked up, so the indicator brightens. */
  talking: boolean
  /** The open mic has carried nothing at all for a while. */
  silent: boolean
  /** What became of the last spoken line, for the transcription state. */
  say: 'idle' | 'sending' | 'failed' | 'quiet'
  /** The local mic level while it is open, 0 to 1 of a loud voice. */
  level: number
  /** Why the talk key did nothing just now, or null. Shown even with voice off. */
  hint: 'off' | 'muted' | 'unsupported' | 'blocked' | 'asking' | null
  /** Say that voice exists: somebody is in range and this player has never
   *  turned it on. The page decides when, and only ever once. */
  nudge?: boolean
  rows: VoiceRow[]
}>()

const HINTS = {
  off: 'Voice is off. Turn it on in the menu, Audio tab',
  muted: 'Your microphone is muted. N to unmute',
  unsupported: 'This browser cannot do voice',
  blocked: 'The microphone is blocked for this site',
  asking: 'Waiting for the microphone',
} as const
</script>

<template>
  <div
    v-if="enabled || hint || nudge"
    class="wash-right on-render flex flex-col items-end gap-1.5 py-3.5 pl-17 pr-7"
  >
    <span
      v-if="hint"
      class="telemetry flex items-center gap-2 whitespace-nowrap text-warning"
    >
      <UIcon
        name="i-lucide-mic-off"
        class="size-3"
      />
      {{ HINTS[hint] }}
    </span>
    <!-- Nothing is wrong: voice is off, which is normal, and this says once
         that it is there at all. -->
    <span
      v-else-if="nudge"
      class="telemetry flex items-center gap-2 whitespace-nowrap text-muted"
    >
      <UIcon
        name="i-lucide-mic"
        class="size-3"
      />
      Voice chat: Escape, Audio tab
    </span>
    <span
      v-else-if="enabled"
      class="telemetry flex items-center gap-2 whitespace-nowrap"
      :class="muted || silent ? 'text-warning' : open ? (talking ? 'text-primary' : 'text-primary/70') : 'text-muted'"
    >
      <UIcon
        :name="open && !silent ? 'i-lucide-mic' : 'i-lucide-mic-off'"
        class="size-3"
      />
      {{ muted ? 'Muted' : silent ? 'No sound from the microphone' : open ? 'Transmitting' : 'Voice on' }}
    </span>
    <!-- What the mic is picking up, while it is open. If this stays flat while
         you speak, the wrong input is selected or it is turned down. -->
    <UProgress
      v-if="open"
      :model-value="Math.min(100, Math.round(level * 500))"
      size="2xs"
      class="w-28"
      :ui="{ indicator: 'transition-[width] duration-100 ease-out' }"
    />
    <!-- The clip is with the server. Quiet, because the line either turns up in
         the chat a moment later or it does not. -->
    <span
      v-if="say !== 'idle'"
      class="telemetry flex items-center gap-2 whitespace-nowrap"
      :class="say === 'sending' ? 'text-dimmed' : 'text-warning'"
    >
      <UIcon
        :name="say === 'sending' ? 'i-lucide-message-square-dashed' : say === 'quiet' ? 'i-lucide-mic-off' : 'i-lucide-message-square-x'"
        class="size-3"
      />
      {{ say === 'sending' ? 'Writing it down' : say === 'quiet' ? 'Heard nothing. Check the microphone' : 'Not posted to chat' }}
    </span>
    <span
      v-for="row in rows"
      :key="row.id"
      class="flex items-center gap-2 whitespace-nowrap text-[14px] leading-none"
      :class="row.speaking ? 'text-default' : 'text-muted'"
    >
      <UIcon
        name="i-lucide-audio-lines"
        class="size-3.5"
        :class="row.speaking ? 'text-primary' : 'text-dimmed'"
      />
      {{ row.name }}
    </span>
  </div>
</template>
