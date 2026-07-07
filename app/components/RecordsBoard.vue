<script setup lang="ts">
import type { FloorRecord } from '#shared/types/game'

/**
 * The "Fastest clears today" board — today's best clear time per floor. Shared
 * across the login gate, the in-game HUD, and the spectator view so all three
 * present records identically. Purely presentational: the caller supplies the
 * records (from `useGame().records` in-game, or `GET /api/records` on the gate).
 */
defineProps<{ records: FloorRecord[] }>()

function formatMs(ms: number): string {
  const seconds = ms / 1000
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}
</script>

<template>
  <div class="rounded-lg bg-black/35 p-4 backdrop-blur-sm ring ring-white/5">
    <p class="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">
      <UIcon
        name="i-lucide-timer"
        class="size-3 text-[#ffd166]"
      />
      Fastest clears today
    </p>
    <p
      v-if="!records.length"
      class="text-xs text-muted"
    >
      No floors cleared yet. Be the first.
    </p>
    <ol
      v-else
      class="flex max-h-52 flex-col gap-1 overflow-y-auto"
    >
      <li
        v-for="record in records"
        :key="record.floor"
        class="flex items-center gap-2 text-xs"
      >
        <span class="shrink-0 text-toned">Floor {{ record.floor }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ record.name }}</span>
        <span class="shrink-0 font-mono text-highlighted">{{ formatMs(record.ms) }}</span>
      </li>
    </ol>
  </div>
</template>
