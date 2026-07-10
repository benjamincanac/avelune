<script setup lang="ts">
import type { FloorRecord, Player } from '#shared/types/game'

/**
 * The main menu — the landing screen shown before anything else and on every
 * refresh. A returning player (identity from the signed cookie) sees their
 * saved character and an Enter button; a brand-new visitor sees a Create
 * button. Today's leaderboard and the spectator entry live here, not in
 * character creation. The character is permanent — there is no logout.
 */
defineProps<{
  /** The saved character, or null for a visitor who hasn't created one yet. */
  identity: Pick<Player, 'name' | 'color' | 'character' | 'outfitColor'> | null
  records: FloorRecord[]
  /** Runners connected right now, or null while the probe is in flight. */
  online: number | null
}>()

const emit = defineEmits<{ play: [], create: [], spectate: [], edit: [] }>()

// The prop editor is a dev-only tool (its save route only exists in dev).
const isDev = import.meta.dev

// A cool atmospheric backdrop in the brand's slime blue.
const backdrop = 'radial-gradient(ellipse 80% 60% at 50% 40%, rgba(147,185,232,0.26), transparent 68%), linear-gradient(180deg, #0a1024 0%, #070b16 55%, #05070d 100%)'
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-40 overflow-hidden bg-[#05070d] text-white">
    <!-- Fixed atmospheric backdrop. -->
    <div
      class="absolute inset-0"
      :style="{ background: backdrop }"
    />

    <!-- Vignette for depth. -->
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_42%,transparent_38%,#05070daa_92%)]" />

    <!-- Brand + live population (dot lit while anyone's climbing). -->
    <BrandMark
      :count="online"
      :dot-class="online && online > 0 ? 'bg-primary' : 'bg-neutral-600'"
      class="absolute left-6 top-5 z-10"
    />

    <!-- Right: today's fastest clears. -->
    <aside class="absolute right-6 top-6 z-10 hidden w-72 flex-col gap-12 lg:flex items-end">
      <div class="flex items-center gap-2">
        <UButton
          v-if="isDev"
          label="Editor"
          color="neutral"
          icon="i-lucide-puzzle"
          @click="emit('edit')"
        />
        <UButton
          label="Watch as spectator"
          color="neutral"
          variant="soft"
          icon="i-lucide-eye"
          @click="emit('spectate')"
        />
      </div>

      <RecordsBoard
        :records="records"
        class="mt-px"
      />
    </aside>

    <!-- Bottom: play / create + spectate. -->
    <div class="absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div class="flex w-full max-w-3xs flex-col items-center gap-2">
        <template v-if="identity">
          <p class="text-sm text-muted">
            Welcome back
          </p>
          <p class="mb-1 text-lg font-semibold text-highlighted">
            {{ identity.name }}
          </p>
          <UButton
            label="Enter"
            color="neutral"
            size="lg"
            block
            @click="emit('play')"
          />
        </template>
        <UButton
          v-else
          label="Create your runner"
          color="neutral"
          size="lg"
          block
          @click="emit('create')"
        />
      </div>
    </div>
  </div>
</template>
