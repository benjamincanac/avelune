<script setup lang="ts">
import type { Player } from '#shared/types/game'

definePageMeta({
  colorMode: 'dark',
})

const game = useGame()
const coach = useCoach()

const gameRoot = useTemplateRef('gameRoot')
const gameScene = useTemplateRef('gameScene')
const showMenu = ref(false)
const fullscreen = ref(false)

type View = 'checking' | 'creating' | 'playing'

/**
 * Entry flow. `checking` covers the initial /api/auth probe: a returning player drops
 * straight into the arena, a visitor without a cookie lands on the gate (body + name).
 * The socket opens the moment we enter the arena; the identity cookie stays until "Log out".
 */
const view = ref<View>('checking')
const identity = ref<Pick<Player, 'name' | 'color' | 'character'> | null>(null)

onMounted(async () => {
  try {
    const me = await $fetch('/api/auth')
    if (me.authenticated) {
      identity.value = { name: me.name, color: me.color, character: me.character }
    }
  }
  catch {
    // A failed probe is treated as no cookie: the gate's own POST surfaces errors.
  }

  if (identity.value) play()
  else view.value = 'creating'
})

/** Enter the arena as the saved identity. */
function play() {
  view.value = 'playing'
  game.connect()
}

/** Identity just created at the gate: adopt it and drop into the arena. */
function onCreated(created: Player) {
  identity.value = created
  play()
}

/**
 * Log out, from the Escape menu: clear the identity cookie, then reload.
 * The reload closes the socket, so the server sees a plain leave.
 * The entry flow re-runs without a cookie and lands on the gate.
 */
async function logout() {
  try {
    await $fetch('/api/auth', { method: 'DELETE' })
  }
  catch {
    // Cookie still set — the reload just drops back into the arena as the same player.
  }
  window.location.reload()
}

/**
 * From the kicked overlay: reclaim the session in this tab. The reload re-runs
 * the entry flow, which drops back into the arena — booting whichever tab
 * currently holds the session (user-initiated, so no ping-pong).
 */
function playHere() {
  window.location.reload()
}

/**
 * The in-game Escape menu (WoW-style). While the pointer is locked the browser
 * swallows the Escape keydown entirely, so the "open" signal is the scene's
 * `unlock` emit (pointer lock lost without Alt); the keydown path below covers
 * every unlocked state, plus keyboard-locked fullscreen where Escape DOES reach
 * us while still locked.
 */
function openMenu() {
  showMenu.value = true
  // Free the OS cursor so the menu is clickable (no-op when already unlocked).
  document.exitPointerLock?.()
}

function resume() {
  showMenu.value = false
  // Chrome refuses re-lock for ~1.25s after an Escape-exit — if this one loses
  // that race, clicking the world (the scene's own handler) recovers.
  gameScene.value?.requestLock()
}

/**
 * The browser exits fullscreen on a tap of Escape and this can't be cancelled
 * with preventDefault — so hitting Escape to unfocus the chat or open the game
 * menu would also blow away fullscreen. The Keyboard Lock API routes Escape to
 * our own handlers instead (blur the chat, toggle the menu); *holding* Escape
 * still exits, so there's an escape hatch. Chromium-only, a no-op elsewhere.
 */
const keyboard = computed(() =>
  import.meta.client
    ? (navigator as Navigator & {
        keyboard?: { lock: (keys?: string[]) => Promise<void>, unlock: () => void }
      }).keyboard
    : undefined,
)

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
      try {
        await keyboard.value?.lock(['Escape'])
      }
      catch {
        // Keyboard Lock unsupported (non-Chromium) — Escape falls back to native.
      }
      // Not while the Escape menu is up — it needs the cursor.
      if (!showMenu.value) gameScene.value?.requestLock()
    }
  }
  catch {
    // Fullscreen unavailable (e.g. an embed without permission) — no-op.
  }
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement != null
  // The browser auto-releases the lock on exit; unlock defensively anyway.
  if (!fullscreen.value) keyboard.value?.unlock()
}

function onKeyDown(event: KeyboardEvent) {
  // `target`, not `activeElement`: the chat blurs itself on this same Escape
  // keydown (also a window listener), so focus may already be gone by the time
  // the event reaches us — the target still names the input it came from.
  const target = event.target as HTMLElement | null
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
  if (typing) return
  if (event.code === 'KeyF') {
    event.preventDefault()
    void toggleFullscreen()
  }
  else if (event.code === 'Escape' && view.value === 'playing') {
    event.preventDefault()
    if (showMenu.value) resume()
    else openMenu()
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

const statusColor = computed(() => game.status.value === 'connected' ? 'bg-primary' : 'bg-warning')
</script>

<template>
  <div
    ref="gameRoot"
    class="relative h-screen overflow-hidden bg-[#05070d]"
  >
    <!-- The gate, for a visitor with no identity cookie yet. -->
    <CharacterGate
      v-if="view === 'creating'"
      @done="onCreated"
    />

    <template v-else-if="view === 'playing'">
      <GameScene
        ref="gameScene"
        :game="game"
        class="absolute inset-0"
        @unlock="showMenu = true"
      />

      <!-- Left column: identity + connection status on top, the chat filling the rest. -->
      <div class="pointer-events-none absolute inset-y-4 left-4 z-10 flex w-92 flex-col gap-2">
        <BrandMark
          :count="game.count.value"
          :dot-class="statusColor"
          size="size-8"
          class="pointer-events-auto self-start rounded-lg bg-black/45 px-3 py-2 backdrop-blur"
        />
        <ChatPanel
          :game="game"
          class="min-h-0 flex-1"
        />
      </div>

      <!-- Top-right: minimap. -->
      <aside class="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
        <MiniMap :game="game" />
      </aside>

      <!-- Coach: a discovery hint when near it. Coach answers questions
           about Vercel in the chat when addressed — no separate dialog. -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 translate-y-2"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0 translate-y-2"
      >
        <div
          v-if="coach.near.value"
          class="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center"
        >
          <span class="flex items-center gap-1.5 rounded-full bg-black/60 px-3.5 py-1.5 text-[13px] text-highlighted ring ring-white/10 backdrop-blur">
            Coach is listening — <span class="text-muted">ask about Vercel in chat</span>
          </span>
        </div>
      </Transition>

      <!-- Escape menu (WoW-style): dims the world, controls + session actions.
           Clicking the backdrop resumes too — the click doubles as the user
           gesture pointer lock wants. -->
      <Transition
        enter-active-class="transition duration-150 ease-out"
        enter-from-class="opacity-0"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showMenu"
          class="absolute inset-0 z-40 flex select-none items-center justify-center bg-black/50"
          @click.self="resume"
        >
          <div class="flex w-60 flex-col gap-4 rounded-xl bg-black/60 p-4 ring ring-white/10 backdrop-blur">
            <p class="text-center text-[10px] font-medium uppercase tracking-widest text-muted">
              Game menu
            </p>

            <div class="flex flex-col gap-1.5 text-[11px]">
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Move</span>
                <span class="flex items-center gap-0.5">
                  <UKbd value="W" /><UKbd value="A" /><UKbd value="S" /><UKbd value="D" />
                </span>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Jump</span>
                <UKbd value="Space" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Dash</span>
                <UKbd value="Shift" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Cursor</span>
                <UKbd value="Alt" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Fullscreen</span>
                <UKbd value="F" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-muted">Menu</span>
                <UKbd value="Esc" />
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <UButton
                :label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
                :icon="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
                color="neutral"
                variant="soft"
                block
                @click="toggleFullscreen"
              />
              <UButton
                label="Log out"
                icon="i-lucide-log-out"
                color="neutral"
                variant="soft"
                block
                @click="logout"
              />
              <UButton
                label="Return to game"
                color="neutral"
                block
                @click="resume"
              />
            </div>
          </div>
        </div>
      </Transition>

      <!-- Kicked: this identity opened the arena in another tab, and that newer
           socket took over. We don't reconnect (it would boot the new tab) — the
           player picks which window wins. -->
      <div
        v-if="game.kicked.value"
        class="absolute inset-0 z-50 flex select-none items-center justify-center bg-black/80 backdrop-blur"
      >
        <div class="flex w-80 flex-col gap-4 rounded-xl bg-black/60 p-6 text-center ring ring-white/10">
          <UIcon
            name="i-lucide-monitor-x"
            class="mx-auto size-8 text-warning"
          />
          <div class="flex flex-col gap-1">
            <p class="text-sm font-medium text-highlighted">
              Playing in another tab
            </p>
            <p class="text-xs text-muted">
              {{ game.kicked.value }}
            </p>
          </div>
          <UButton
            label="Play here instead"
            color="primary"
            block
            @click="playHere"
          />
        </div>
      </div>
    </template>
  </div>
</template>
