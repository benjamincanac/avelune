<script setup lang="ts">
import type { GameStatus } from '~/composables/useGame'

/**
 * Entering the world, shown step by step.
 *
 * The handshake is the thing this project exists to demonstrate, so it is not
 * hidden behind a spinner: the socket opening, the realm answering, terrain
 * streaming in, the models arriving and the player being placed are five real
 * milestones, and the bar is derived from how many have actually resolved plus
 * how much terrain and art has landed, never faked on a timer.
 *
 * Once you are in, it latches shut. Chunks stream in and out for the rest of
 * the session as you walk, and that is not a loading screen.
 *
 * It takes the three values it needs rather than the whole `UseGame`: handed the
 * composable, the object identity never changes, so a parent re-render passes
 * nothing new and this component can sit on a stale reading of a ref inside it.
 * Scalar props are what make it move.
 */
const props = defineProps<{
  /** The socket's own state. */
  status: GameStatus
  /** Round trip in ms; null until the first pong. */
  rtt: number | null
  /** Set once `welcome` names us — the last step waits on it. */
  selfId: string | null
}>()

const world = useWorld()
const assets = useAssets()

/** Latched the first time everything resolves: after that, only a dropped
 *  socket brings the overlay back, and it comes back as a notice, not a list. */
const entered = ref(false)

const open = computed(() => props.status === 'connected')
const named = computed(() => world.realm.value != null)
const streamed = computed(() => world.streamed.value ?? 0)
const chunks = computed(() => Math.min(world.chunkCount.value, streamed.value))

/**
 * Terrain has stopped arriving. A safety net, not the happy path: the streamed
 * set is a fixed size and normally fills, but this screen is the only thing
 * between a player and their world, so it must not be able to hang on a chunk
 * that never lands. Once the ground underfoot is there and nothing new has
 * arrived for a beat, we are in.
 */
const SETTLE = 3_000
/** The 3×3 a player stands in — below that there is genuinely nothing to walk on. */
const MINIMUM = 9
const settled = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | undefined

watch(chunks, (count) => {
  clearTimeout(settleTimer)
  settled.value = false
  if (count < MINIMUM) return
  settleTimer = setTimeout(() => {
    settled.value = true
  }, SETTLE)
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(settleTimer))

const terrain = computed(() => streamed.value > 0 && (chunks.value >= streamed.value || settled.value))

/**
 * The scene's models: buildings, the nature and build kits, the characters in
 * view and the Oracle. Without this step the overlay lifted on bare ground and
 * the town popped in over the next few seconds.
 *
 * The same safety net as the terrain: a load that fails still settles, and if
 * the scene never reports at all (no WebGL, a stalled request) the wait is
 * capped once the terrain is in, so this screen cannot hold a player out.
 */
const ASSET_CAP = 20_000
const assetsCapped = ref(false)
let assetTimer: ReturnType<typeof setTimeout> | undefined

watch(terrain, (done) => {
  clearTimeout(assetTimer)
  if (!done) return
  assetTimer = setTimeout(() => {
    assetsCapped.value = true
  }, ASSET_CAP)
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(assetTimer))

const modelsLoaded = computed(() => Math.min(assets.settled.value, assets.total.value))

/**
 * Loads are requested in waves: the kits at once, your own character only when
 * the first `state` frame names you, the Oracle when its rig is first built.
 * The count can therefore sit at "all done" between two waves, so it has to
 * stay there for a beat before it counts.
 */
const ASSET_QUIET = 800
const modelsQuiet = ref(false)
let quietTimer: ReturnType<typeof setTimeout> | undefined

watch([assets.total, assets.settled], ([all, done]) => {
  clearTimeout(quietTimer)
  modelsQuiet.value = false
  if (!all || done < all) return
  quietTimer = setTimeout(() => {
    modelsQuiet.value = true
  }, ASSET_QUIET)
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(quietTimer))

const models = computed(() => modelsQuiet.value || assetsCapped.value)
const placed = computed(() => terrain.value && models.value && props.selfId != null)

const steps = computed(() => [
  {
    label: 'Socket open',
    done: open.value,
    active: !open.value,
    value: props.rtt == null ? '—' : `${props.rtt} ms`,
  },
  {
    label: 'Realm resolved',
    done: named.value,
    active: open.value && !named.value,
    value: world.realm.value ? `${realmName(world.realm.value)} · ${world.realm.value.toUpperCase()}` : '—',
  },
  {
    label: 'Streaming terrain',
    done: terrain.value,
    active: named.value && !terrain.value,
    value: streamed.value ? `${chunks.value} / ${streamed.value} chunks` : '—',
  },
  {
    label: 'Loading models',
    done: models.value,
    active: !models.value && assets.total.value > 0,
    value: assets.total.value ? `${modelsLoaded.value} / ${assets.total.value} models` : '—',
  },
  {
    label: 'Placing you in the world',
    done: placed.value,
    active: terrain.value && models.value && !placed.value,
    value: placed.value ? 'Ready' : '—',
  },
])

/** Resolved steps, plus however far through the streaming one we are — so the
 *  bar moves with the chunks rather than on its own clock. */
const progress = computed(() => {
  const resolved = steps.value.filter(step => step.done).length
  const ground = terrain.value || !streamed.value ? 0 : chunks.value / streamed.value
  const art = models.value || !assets.total.value ? 0 : modelsLoaded.value / assets.total.value
  return Math.round(((resolved + ground + art) / steps.value.length) * 100)
})

watchEffect(() => {
  if (placed.value) entered.value = true
})

/** Before the first entry, the step list. After it, only a dropped socket. */
const phase = computed(() => {
  if (!entered.value) return 'entering'
  return props.status === 'connected' ? 'none' : 'reconnecting'
})
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-300 ease-in"
    leave-to-class="opacity-0"
  >
    <div
      v-if="phase === 'entering'"
      key="entering"
      class="absolute inset-0 z-50 flex select-none items-center justify-center bg-[#060e11]/90 px-6"
    >
      <div class="flex w-140 max-w-full flex-col items-center">
        <BrandMark size="lg" />

        <UProgress
          :model-value="progress"
          size="xs"
          class="mt-11 w-full"
          :ui="{ indicator: 'transition-[width] duration-300 ease-out' }"
        />

        <div class="telemetry mt-4.5 flex w-full items-center justify-between text-[11px] tracking-[0.16em]">
          <span class="text-primary">Entering the world</span>
          <span class="text-dimmed">{{ progress }}%</span>
        </div>

        <ol class="fused mt-8.5 w-full flex-col bg-white/8">
          <li
            v-for="step in steps"
            :key="step.label"
            class="telemetry flex items-center gap-3.5 px-4 py-3.25 text-[11px]"
            :class="step.active ? 'bg-primary/8 shadow-[inset_0_0_0_1px_rgb(111_240_218/0.24)]' : 'bg-white/6'"
          >
            <UIcon
              :name="step.done ? 'i-lucide-check' : step.active ? 'i-lucide-loader-circle' : 'i-lucide-circle'"
              class="size-3 shrink-0"
              :class="[step.done || step.active ? 'text-primary' : 'text-faint', step.active ? 'animate-spin' : '']"
            />
            <span
              class="flex-1"
              :class="step.active ? 'text-highlighted' : step.done ? 'text-toned' : 'text-label'"
            >{{ step.label }}</span>
            <span :class="step.active ? 'text-primary' : step.done ? 'text-highlighted' : 'text-faint'">{{ step.value }}</span>
          </li>
        </ol>

        <p class="mt-7 max-w-105 text-center text-base/normal text-dimmed text-pretty">
          Everything you build is held by the server, not your browser.<template v-if="world.persistent.value === false">
            The world resets when the server restarts.
          </template>
        </p>
      </div>
    </div>

    <!-- After the first entry, a dropped socket is a notice, not a screen: the
         world is still on screen behind it and your plot is safe on the server. -->
    <div
      v-else-if="phase === 'reconnecting'"
      key="reconnecting"
      class="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center pt-24"
    >
      <div class="frost flex items-center gap-3.5 rounded-[6px] border-t-2 border-[#d8b13a] px-5 py-3.5">
        <UIcon
          name="i-lucide-loader-circle"
          class="size-3.5 animate-spin text-[#d8b13a]"
        />
        <span class="telemetry tracking-[0.14em] text-[#e5c66b]">Reconnecting</span>
        <span class="text-[15px] leading-none text-toned">Connection dropped — your plot is safe on the server.</span>
      </div>
    </div>
  </Transition>
</template>
