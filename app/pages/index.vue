<script setup lang="ts">
import { BIOMES, HUB_FLOOR, biomeIndex } from '#shared/utils/maze'
import type { ClearEvent, DeathEvent } from '~/composables/useGame'

definePageMeta({
  colorMode: 'dark',
})

const game = useGame()
const toast = useToast()

const gameRoot = useTemplateRef('gameRoot')
const gameScene = useTemplateRef('gameScene')
const showMap = ref(false)
const deathFlash = ref(false)
const fullscreen = ref(false)

/**
 * Fullscreen keeps the cursor inside the window (no more edge-pinning while
 * turning), and grants pointer lock its best shot — we chain a lock attempt
 * onto the same user gesture.
 */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    }
    else {
      await gameRoot.value?.requestFullscreen()
      gameScene.value?.requestLock()
    }
  }
  catch {
    // Fullscreen unavailable (e.g. an embed without permission) — no-op.
  }
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement != null
}

function onKeyDown(event: KeyboardEvent) {
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
  if (typing) return
  if (event.code === 'KeyM' || event.code === 'Tab') {
    event.preventDefault()
    showMap.value = !showMap.value
  }
  else if (event.code === 'KeyF') {
    event.preventDefault()
    void toggleFullscreen()
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('keydown', onKeyDown)
})

// Floor timer, ticking once a second.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))

const floorTime = computed(() => {
  if (!game.floorEnteredAt.value) return null
  const seconds = Math.max(0, Math.floor((now.value - game.floorEnteredAt.value) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})

const floorLabel = computed(() => {
  const floor = game.selfFloor.value
  if (floor === HUB_FLOOR) return 'The Hub'
  return `Floor ${floor} — ${BIOMES[biomeIndex(floor)]!.name}`
})

const selfBest = computed(() => game.selfBest.value)

function formatMs(ms: number): string {
  const seconds = ms / 1000
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

watch(game.lastDeath, (death: DeathEvent | null) => {
  if (!death) return
  if (death.id === game.selfId.value) {
    deathFlash.value = true
    setTimeout(() => {
      deathFlash.value = false
    }, 900)
    toast.add({
      title: `You were ${death.cause}`,
      description: `Floor ${death.floor} claims another runner. Back to the hub — the tower resets for you.`,
      icon: 'i-lucide-skull',
      color: 'error',
    })
  }
})

watch(game.lastClear, (clear: ClearEvent | null) => {
  if (!clear) return
  const isSelf = clear.id === game.selfId.value
  if (isSelf && clear.floor === HUB_FLOOR) {
    toast.add({
      title: 'The circle takes you',
      description: 'Floor 1 — Stone Dungeon. Find the green portal. Mind the spikes.',
      icon: 'i-lucide-sparkles',
      color: 'info',
    })
    return
  }
  if (isSelf) {
    toast.add({
      title: `Floor ${clear.floor} cleared in ${formatMs(clear.ms)}`,
      description: clear.record
        ? '⚡ Fastest clear of the day!'
        : `Descending to floor ${clear.floor + 1} — ${BIOMES[biomeIndex(clear.floor + 1)]!.name}.`,
      icon: 'i-lucide-door-open',
      color: 'primary',
    })
  }
  else if (clear.record) {
    toast.add({
      title: `${clear.name} set a record`,
      description: `Floor ${clear.floor} in ${formatMs(clear.ms)}.`,
      icon: 'i-lucide-zap',
      color: 'warning',
    })
  }
})

const statusColor = computed(() => game.status.value === 'connected' ? 'bg-primary' : 'bg-warning')
</script>

<template>
  <div
    ref="gameRoot"
    class="relative h-screen overflow-hidden bg-[#05070d]"
  >
    <GameScene
      ref="gameScene"
      :game="game"
      class="absolute inset-0"
    />

    <!-- Death flash. -->
    <div
      class="pointer-events-none absolute inset-0 z-30 bg-red-900/60 transition-opacity duration-700"
      :class="deathFlash ? 'opacity-100' : 'opacity-0'"
    />

    <SpectatorView
      v-if="showMap"
      :game="game"
      @close="showMap = false"
    />

    <!-- Top-left: identity + run status. -->
    <header class="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2">
      <div class="pointer-events-auto flex items-center gap-2.5 rounded-lg bg-black/45 px-3 py-2 backdrop-blur">
        <span
          class="size-2 rounded-full"
          :class="statusColor"
        />
        <div class="flex flex-col leading-tight">
          <span class="text-sm font-semibold tracking-[0.2em] text-highlighted">MUGEN</span>
          <span class="text-[11px] text-muted">{{ game.count.value }} in the tower</span>
        </div>
      </div>

      <div class="pointer-events-auto flex w-fit flex-col gap-0.5 rounded-lg bg-black/45 px-3 py-2 backdrop-blur">
        <span class="text-sm font-medium text-highlighted">{{ floorLabel }}</span>
        <span class="text-xs text-muted">
          <span v-if="floorTime">⏱ {{ floorTime }}</span>
          <span v-if="selfBest > 0"> · deepest: F{{ selfBest }}</span>
          <span v-else> · step on the circle</span>
        </span>
      </div>
    </header>

    <!-- Top-right: minimap, actions, leaderboard. -->
    <aside class="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
      <MiniMap :game="game" />

      <div class="pointer-events-auto flex items-center gap-1">
        <UButton
          icon="i-lucide-map"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Tower map (M)"
          @click="showMap = !showMap;"
        />
        <UButton
          :icon="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'"
          @click="toggleFullscreen"
        />
      </div>

      <div
        v-if="game.leaderboard.value.length > 1"
        class="pointer-events-auto min-w-44 rounded-lg bg-black/45 p-2.5 backdrop-blur"
      >
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted">
          Deepest today
        </p>
        <ol class="flex flex-col gap-1">
          <li
            v-for="player in game.leaderboard.value"
            :key="player.id"
            class="flex items-center justify-between gap-3 text-xs"
          >
            <span class="flex items-center gap-1.5 truncate">
              <span
                class="size-1.5 shrink-0 rounded-full"
                :style="{ backgroundColor: player.color }"
              />
              <span
                class="truncate"
                :class="player.id === game.selfId.value ? 'text-primary font-medium' : 'text-toned'"
              >{{ player.name }}</span>
            </span>
            <span class="shrink-0 font-mono text-highlighted">F{{ player.best }}</span>
          </li>
        </ol>
      </div>
    </aside>

    <!-- Bottom-left: chat. -->
    <div class="pointer-events-none absolute bottom-4 left-4 z-10">
      <ChatPanel :game="game" />
    </div>

    <!-- Bottom-center: controls hint. -->
    <footer class="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 flex justify-center">
      <p class="text-[11px] text-muted/80">
        <UKbd value="W" /><UKbd value="A" /><UKbd value="S" /><UKbd value="D" /> move ·
        <UKbd value="Space" /> jump · <UKbd value="Shift" /> dash ·
        <UKbd value="F" /> fullscreen · <UKbd value="M" /> map
      </p>
    </footer>
  </div>
</template>
