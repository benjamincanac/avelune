<script setup lang="ts">
import { BIOMES, HUB_FLOOR, biomeIndex } from '#shared/utils/maze'
import type { FloorRecord, Player } from '#shared/types/game'
import type { ClearEvent, DeathEvent } from '~/composables/useGame'

definePageMeta({
  colorMode: 'dark',
})

const game = useGame()
const oracle = useOracle()

/** Set before a "play here" reload from the kicked overlay: on the next load
 *  the entry flow drops straight into the hub instead of the menu. */
const PLAY_REENTER_KEY = 'tempest:play-reenter'

const gameRoot = useTemplateRef('gameRoot')
const gameScene = useTemplateRef('gameScene')
const showMenu = ref(false)
const deathFlash = ref(false)
const fullscreen = ref(false)

type View = 'checking' | 'menu' | 'creating' | 'playing' | 'spectating' | 'editing'

/**
 * Entry flow. The first screen is always the main menu — never an auto-drop
 * into the game: `checking` covers the initial /api/auth probe, then we land on
 * `menu`. The socket opens only when the player enters the game or spectates.
 * Leaving any mode reloads back to the menu; the character cookie is permanent.
 */
const view = ref<View>('checking')
const identity = ref<Pick<Player, 'name' | 'color' | 'character' | 'outfitColor'> | null>(null)
const records = ref<FloorRecord[]>([])
/** Runners connected right now, shown on the menu; null until the first probe. */
const online = ref<number | null>(null)

onMounted(async () => {
  try {
    const me = await $fetch('/api/auth')
    if (me.authenticated) {
      identity.value = { name: me.name, color: me.color, character: me.character, outfitColor: me.outfitColor }
    }
  }
  catch {
    // Treat a failed probe as a visitor with no character — the menu handles it.
  }
  try {
    const data = await $fetch('/api/records')
    records.value = data.records
    online.value = data.online
  }
  catch {
    // No board is fine — the menu still works without it.
  }
  view.value = 'menu'

  // A save in the world editor rewrites the layout JSON, which triggers a full
  // dev reload; drop straight back into the editor on the same floor so the
  // round-trip is seamless. The stored value is the floor index that was active.
  if (import.meta.dev) {
    const reenter = sessionStorage.getItem(EDITOR_REENTER_KEY)
    if (reenter != null) {
      sessionStorage.removeItem(EDITOR_REENTER_KEY)
      useEditor().switchFloor(Number(reenter))
      edit()
      return
    }
  }

  // "Play here" from the kicked overlay reloads to take the session back; drop
  // straight into the hub (taking over from whichever tab still holds it).
  if (identity.value && sessionStorage.getItem(PLAY_REENTER_KEY)) {
    sessionStorage.removeItem(PLAY_REENTER_KEY)
    play()
    return
  }

  // Warm character models while the menu idles. A brand-new visitor will open
  // creation, so warm the whole roster ("Create your runner" opens instantly); a
  // returning player will click Enter → hub, so warm only their saved rig. Both
  // share the browser fetch cache with the in-world loader. Deferred so it never
  // janks the menu's first paint. Dynamically imported — the util pulls in
  // three.js, which must never enter the SSR module graph (invariant: three is
  // browser-only). `onMounted` is client-only, so this is safe.
  const me = identity.value
  const warm = () => void import('~/utils/characterModels').then(m =>
    me ? m.preloadCharacter(me.character, me.outfitColor) : m.preloadCharacterAssets(),
  )
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2000 })
  else setTimeout(warm, 400)
})

/** Enter the game as the saved character. */
function play() {
  view.value = 'playing'
  game.connect()
}

/** Go to character creation (brand-new visitor). */
function create() {
  view.value = 'creating'
}

/** Character just created: adopt it and drop straight into the hub. */
function onCreated(created: Player) {
  identity.value = created
  view.value = 'playing'
  game.connect()
}

/** Enter as a read-only spectator: open a watcher socket, show the tower map. */
function spectate() {
  view.value = 'spectating'
  game.connect(true)
}

/**
 * Dev-only: enter the hub prop editor. Renders the hub with a fly camera and no
 * socket (the same never-connected `game` the menu uses) — placements are saved
 * to a repo file, not sent over the wire.
 */
function edit() {
  if (!import.meta.dev) return
  view.value = 'editing'
}

/**
 * Leave the game or the spectator view — hard-reload back to the main menu. The
 * reload tears down the socket; the character cookie survives, so the menu
 * shows the saved character again.
 */
function leave() {
  window.location.reload()
}

/**
 * From the kicked overlay: reclaim the session in this tab. The reload re-runs
 * the entry flow, and the re-enter flag drops back into the hub — which boots
 * whichever tab currently holds the session (user-initiated, so no ping-pong).
 */
function playHere() {
  sessionStorage.setItem(PLAY_REENTER_KEY, '1')
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

// People idle on the menu — keep its tower count (and board) fresh with a
// cheap poll. In-game and spectator views get live data over the socket.
let menuPoll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  menuPoll = setInterval(async () => {
    if (view.value !== 'menu') return
    try {
      const data = await $fetch('/api/records')
      records.value = data.records
      online.value = data.online
    }
    catch {
      // Transient failure — keep showing the last known values.
    }
  }, 10_000)
})
onBeforeUnmount(() => clearInterval(menuPoll))

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
    game.announce(`You were ${death.cause} on floor ${death.floor}. Back to the hub — begin the climb again.`)
    return
  }
  // A nearby runner fell — announce it on your floor (chat is floor-scoped).
  if (death.floor === game.selfFloor.value) {
    const name = game.players.get(death.id)?.name ?? 'A runner'
    game.announce(`${name} was ${death.cause}.`)
  }
})

watch(game.lastClear, (clear: ClearEvent | null) => {
  if (!clear) return
  const isSelf = clear.id === game.selfId.value
  if (isSelf && clear.floor === HUB_FLOOR) {
    game.announce(
      clear.to > HUB_FLOOR + 1
        ? `The door returns you to Floor ${clear.to}, ${BIOMES[biomeIndex(clear.to)]!.name} — right where you left off.`
        : 'The door takes you — Floor 1, Stone Dungeon. Find the way down, and mind the spikes.',
    )
    return
  }
  if (isSelf) {
    game.announce(
      clear.record
        ? `Floor ${clear.floor} cleared in ${formatMs(clear.ms)} — ⚡ fastest clear of the day!`
        : `Floor ${clear.floor} cleared in ${formatMs(clear.ms)}. Descending to floor ${clear.to} — ${BIOMES[biomeIndex(clear.to)]!.name}.`,
    )
  }
  else if (clear.record) {
    game.announce(`${clear.name} set a record — Floor ${clear.floor} in ${formatMs(clear.ms)}.`)
  }
})

const statusColor = computed(() => game.status.value === 'connected' ? 'bg-primary' : 'bg-warning')
</script>

<template>
  <div
    ref="gameRoot"
    class="relative h-screen overflow-hidden bg-[#05070d]"
  >
    <!-- Landing screen: saved character + Enter, or Create; leaderboard + spectate. -->
    <MainMenu
      v-if="view === 'menu'"
      :identity="identity"
      :records="records"
      :online="online"
      @play="play"
      @create="create"
      @spectate="spectate"
      @edit="edit"
    />

    <!-- Character creation, reached from the menu by a brand-new visitor. -->
    <CharacterGate
      v-else-if="view === 'creating'"
      @done="onCreated"
      @back="view = 'menu'"
    />

    <!-- Spectator: a read-only, fully-revealed broadcast of the whole tower. -->
    <SpectatorView
      v-else-if="view === 'spectating'"
      :game="game"
      reveal-all
      @close="leave"
    />

    <template v-else-if="view === 'playing'">
      <GameScene
        ref="gameScene"
        :game="game"
        class="absolute inset-0"
        @unlock="showMenu = true"
      />

      <!-- Death flash. -->
      <div
        class="pointer-events-none absolute inset-0 z-30 bg-red-900/60 transition-opacity duration-700"
        :class="deathFlash ? 'opacity-100' : 'opacity-0'"
      />

      <!-- Top-left: identity + run status. -->
      <header class="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2">
        <BrandMark
          :count="game.count.value"
          :dot-class="statusColor"
          size="size-8"
          class="pointer-events-auto rounded-lg bg-black/45 px-3 py-2 backdrop-blur"
        />

        <div class="pointer-events-auto flex w-fit flex-col gap-0.5 rounded-lg bg-black/45 px-3 py-2 backdrop-blur">
          <span class="text-sm font-medium text-highlighted">{{ floorLabel }}</span>
          <span class="text-xs text-muted">
            <span v-if="floorTime">⏱ {{ floorTime }}</span>
            <span v-if="selfBest > 0"> · deepest: F{{ selfBest }}</span>
            <span v-else> · step through the door</span>
          </span>
        </div>
      </header>

      <!-- Top-right: minimap, leaderboard. -->
      <aside class="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
        <MiniMap :game="game" />

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

        <RecordsBoard
          v-if="game.records.value.length"
          :records="game.records.value"
          class="pointer-events-auto min-w-44"
        />
      </aside>

      <!-- Bottom-left: chat. -->
      <div class="pointer-events-none absolute bottom-4 left-4 z-10">
        <ChatPanel :game="game" />
      </div>

      <!-- Hub Oracle: a discovery hint when near it. The Oracle answers in the
           floor chat when addressed — no separate dialog. -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 translate-y-2"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0 translate-y-2"
      >
        <div
          v-if="oracle.near.value"
          class="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center"
        >
          <span class="flex items-center gap-1.5 rounded-full bg-black/60 px-3.5 py-1.5 text-[13px] text-highlighted ring ring-white/10 backdrop-blur">
            The Oracle listens — <span class="text-muted">speak to it in chat</span>
          </span>
        </div>
      </Transition>

      <!-- Bottom-center: controls hint. -->
      <footer class="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 flex justify-center" />

      <!-- Escape menu (WoW-style): dims the world, session actions + controls.
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
                label="Leave to main menu"
                icon="i-lucide-door-open"
                color="neutral"
                variant="soft"
                block
                @click="leave"
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

      <!-- Kicked: this identity opened the tower in another tab, and that newer
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
          <div class="flex flex-col gap-1.5">
            <UButton
              label="Play here instead"
              color="primary"
              block
              @click="playHere"
            />
            <UButton
              label="Back to main menu"
              color="neutral"
              variant="soft"
              block
              @click="leave"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- Dev-only hub prop editor: the hub with a fly camera + placement tools. -->
    <template v-else-if="view === 'editing'">
      <GameScene
        :game="game"
        editor
        class="absolute inset-0"
      />
      <LazyEditorPanel @exit="leave" />
    </template>
  </div>
</template>
