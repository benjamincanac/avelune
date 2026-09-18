<script setup lang="ts">
import type { Player } from '#shared/types/game'

definePageMeta({
  colorMode: 'dark',
})

// The arena is a live canvas behind a cookie, not a document: keep it out of
// search results. `/` is the page crawlers should have.
useSeoMeta({
  robots: 'noindex, nofollow',
})

const game = useGame()
const world = useWorld()
const oracle = useOracle()
const feed = useFeed()

const gameRoot = useTemplateRef('gameRoot')
const gameScene = useTemplateRef('gameScene')
const showMenu = ref(false)
/** The full-screen world map. `GameScene` owns the `M` key and the pointer lock
 *  around it; the page renders it and routes Escape to it. */
const map = useWorldMap()
const fullscreen = ref(false)
/** Chat has the keyboard: the hotbar drops back so the capture is visible. */
const typing = ref(false)

type View = 'checking' | 'creating' | 'playing' | 'editing'

/**
 * Entry flow. The title screen is `/`, so by the time anyone is here they have
 * asked to play: `checking` covers the initial /api/auth probe, then a
 * returning player drops straight into the arena and a brand-new visitor lands
 * on character creation. The socket opens the moment we enter the arena; the
 * character cookie is permanent.
 */
const view = ref<View>('checking')
const identity = ref<Pick<Player, 'name' | 'color' | 'character' | 'outfitColor'> | null>(null)
const isDev = import.meta.dev

onMounted(async () => {
  // A save in the world editor rewrites the layout JSON, which triggers a full
  // dev reload; drop straight back into the editor so the round-trip is
  // seamless. `?editor=1` is the manual way in, from the Escape menu.
  if (import.meta.dev) {
    const reenter = sessionStorage.getItem(EDITOR_REENTER_KEY)
    if (reenter != null) {
      sessionStorage.removeItem(EDITOR_REENTER_KEY)
      edit()
      return
    }
    if (useRoute().query.editor != null) {
      edit()
      return
    }
  }

  try {
    const me = await $fetch('/api/auth')
    if (me.authenticated) {
      identity.value = { name: me.name, color: me.color, character: me.character, outfitColor: me.outfitColor }
    }
  }
  catch {
    // Treat a failed probe as a visitor with no character — they get creation.
  }

  if (identity.value) play()
  else view.value = 'creating'
})

/** Enter the arena as the saved character. */
function play() {
  view.value = 'playing'
  game.connect()
}

/** Character just created: adopt it and drop straight into the arena. */
function onCreated(created: Player) {
  identity.value = created
  play()
}

/**
 * Dev-only: enter the world editor. Renders the arena with a fly camera and no
 * socket (the same never-connected `game` the entry flow holds) — placements are
 * saved to a repo file, not sent over the wire.
 */
function edit() {
  if (!import.meta.dev) return
  view.value = 'editing'
}

/** Leave the editor: a clean load of `/play` drops back into the arena. */
function exitEditor() {
  window.location.href = '/play'
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

// The two overlays are exclusive: `M` works from the menu too, and opening the
// map from anywhere puts the menu away.
watch(() => map.open.value, (open) => {
  if (open) showMenu.value = false
})

/** From the Escape menu: swap the menu for the map. Both are cursor surfaces,
 *  so there is no lock to take here — closing the map re-takes it. */
function openMap() {
  showMenu.value = false
  map.open.value = true
}

function resume() {
  showMenu.value = false
  // Chrome refuses re-lock for ~1.25s after an Escape-exit — if this one loses
  // that race, clicking the world (the scene's own handler) recovers.
  gameScene.value?.requestLock()
}

/** Leave the arena and clear the saved identity before showing the gate again. */
async function logout() {
  try {
    await $fetch('/api/auth', { method: 'DELETE' })
  }
  catch {
    return
  }
  game.disconnect()
  identity.value = null
  showMenu.value = false
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  keyboard.value?.unlock()
  view.value = 'creating'
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
  const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
  if (isTyping) return
  if (event.code === 'KeyF') {
    event.preventDefault()
    void toggleFullscreen()
  }
  else if (event.code === 'Escape' && view.value === 'playing') {
    event.preventDefault()
    // The map is the topmost surface: Escape closes it and hands the mouse back
    // to the camera, rather than stacking the menu on top of it.
    if (map.open.value) gameScene.value?.toggleMap()
    else if (showMenu.value) resume()
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

const live = computed(() => game.status.value === 'connected')
const realm = computed(() => world.realm.value ? realmName(world.realm.value) : null)
</script>

<template>
  <div
    ref="gameRoot"
    class="relative h-screen overflow-hidden bg-stage"
  >
    <!-- Character creation, for a visitor with no character cookie yet. -->
    <CharacterGate
      v-if="view === 'creating'"
      :initial="identity ?? undefined"
      @done="onCreated"
      @cancel="play"
    />

    <template v-else-if="view === 'playing'">
      <GameScene
        ref="gameScene"
        :game="game"
        class="absolute inset-0"
        @unlock="showMenu = true"
      />

      <!-- Veils, top and bottom, so the corner clusters read over whatever the
           camera happens to be pointing at. Never blurred — the render is the
           content and each frosted layer costs a composite pass. -->
      <div class="pointer-events-none absolute inset-x-0 top-0 z-10 h-42.5 bg-[linear-gradient(180deg,rgb(6_14_17/0.72),rgb(6_14_17/0))]" />
      <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-57.5 bg-[linear-gradient(0deg,rgb(6_14_17/0.82),rgb(6_14_17/0))]" />

      <!-- Top left: who is here, where, and how far away the server is. -->
      <header class="pointer-events-none absolute left-7 top-6 z-10 flex flex-col items-start gap-2">
        <HudStatus
          :count="game.count.value"
          :realm="realm"
          :rtt="game.rtt.value"
          :live="live"
          class="pointer-events-auto"
        />
        <!-- The server has no store: say so before anyone builds a house. -->
        <SandboxNotice v-if="world.persistent.value === false" />
      </header>

      <!-- Top right: the minimap, then the feed below it on the edge wash. -->
      <aside class="pointer-events-none absolute right-7 top-6 z-10 flex flex-col items-end">
        <MiniMap :game="game" />
      </aside>
      <WorldFeed
        :events="feed.events.value"
        class="pointer-events-none absolute right-0 top-71.5 z-10 w-97"
      />

      <!-- Centre: the crosshair the build ray is cast through. -->
      <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <span class="size-1.5 rounded-full bg-white/80 ring-1 ring-black/50" />
      </div>

      <!-- Bottom left: chat. The one thing down here you can click, so the one
           thing down here with a panel. -->
      <div class="pointer-events-none absolute bottom-6.5 left-7 z-10">
        <ChatPanel
          :game="game"
          @focus="typing = true"
          @blur="typing = false"
        />
      </div>

      <!-- Bottom centre: the build bar. -->
      <div class="pointer-events-none absolute inset-x-0 bottom-6.5 z-10 flex justify-center">
        <Hotbar :dimmed="typing" />
      </div>

      <!-- Bottom right: why the world stopped answering the movement keys. -->
      <Transition
        enter-active-class="transition-opacity duration-150 ease-out"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <p
          v-if="typing"
          class="wash-right label-section on-render pointer-events-none absolute bottom-31 right-0 z-10 whitespace-nowrap py-3.5 pl-17 pr-7 text-default"
        >
          Movement held while typing
        </p>
      </Transition>

      <!-- Oracle: a discovery hint when near it. The Oracle answers in the
           chat when addressed — no separate dialog. -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 translate-y-2"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0 translate-y-2"
      >
        <div
          v-if="oracle.near.value && !typing"
          class="pointer-events-none absolute inset-x-0 bottom-46 z-20 flex justify-center"
        >
          <span class="frost telemetry flex items-center gap-2.5 rounded-[4px] px-3.5 py-2 text-toned">
            <UIcon
              name="i-lucide-sparkles"
              class="size-3 text-primary"
            />
            Ask the Oracle in chat. It knows the town and turns the sky.
          </span>
        </div>
      </Transition>

      <!-- Full-screen world map (M). Modal over the game: the scene freezes
           its input while it is up. -->
      <WorldMap
        v-if="map.open.value"
        :game="game"
        @close="gameScene?.toggleMap()"
      />

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
          class="absolute inset-0 z-40 flex select-none items-center justify-center bg-[#060e11]/72 p-6"
          @click.self="resume"
        >
          <GameMenu
            :fullscreen="fullscreen"
            :dev="isDev"
            @resume="resume"
            @fullscreen="toggleFullscreen"
            @map="openMap"
            @edit="edit"
            @logout="logout"
          />
        </div>
      </Transition>

      <!-- Entering the world, step by step — and, after that, the only socket
           state we can actually detect: a drop we are retrying. -->
      <ConnectingOverlay
        :status="game.status.value"
        :rtt="game.rtt.value"
        :self-id="game.selfId.value"
      />

      <!-- Kicked: this identity opened the arena in another tab, and that newer
           socket took over. We don't reconnect (it would boot the new tab) — the
           player picks which window wins. -->
      <div
        v-if="game.kicked.value"
        class="absolute inset-0 z-50 flex select-none items-center justify-center bg-[#060e11]/90 p-6"
      >
        <div class="frost-modal flex w-100 flex-col items-center gap-5 rounded-[6px] border-t-2 border-[#d8b13a] p-8 text-center">
          <UIcon
            name="i-lucide-monitor-x"
            class="size-7 text-[#d8b13a]"
          />
          <div class="flex flex-col gap-2">
            <h2 class="font-display text-lg font-bold uppercase leading-none tracking-[0.2em] text-highlighted">
              Playing in another tab
            </h2>
            <p class="text-[15px]/[1.5] text-muted text-pretty">
              {{ game.kicked.value }}
            </p>
          </div>
          <UButton
            block
            size="lg"
            label="Play here instead"
            class="notch-wide text-[15px]"
            @click="playHere"
          />
        </div>
      </div>
    </template>

    <!-- Dev-only world editor: the arena with a fly camera + placement tools. -->
    <template v-else-if="view === 'editing'">
      <GameScene
        :game="game"
        editor
        class="absolute inset-0"
      />
      <LazyEditorPanel @exit="exitEditor" />
    </template>
  </div>
</template>
