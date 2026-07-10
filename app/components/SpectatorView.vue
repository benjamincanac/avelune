<script setup lang="ts">
import type { FloorPlan } from '#shared/utils/maze'
import { BIOMES, HUB_FLOOR, TOWER_SEED, biomeIndex, generateFloor, occupancyGrid } from '#shared/utils/maze'
import type { GamePlayer, UseGame } from '~/composables/useGame'

/**
 * The tower map: a live spectator view of every active floor.
 *
 * Because floors are loaded deterministically from bundled authored data,
 * the client can draw a map of any floor without asking the server —
 * the only live data are the player markers already streaming in.
 */

const props = defineProps<{
  game: UseGame
  /** Reveal the whole tower (spectator broadcast), bypassing fog of war. */
  revealAll?: boolean
}>()

defineEmits<{ close: [] }>()

const SCALE = 3

interface FloorEntry {
  floor: number
  label: string
  players: GamePlayer[]
}

const version = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => version.value++, 200)
})
onBeforeUnmount(() => clearInterval(timer))

const floors = computed<FloorEntry[]>(() => {
  void version.value
  const byFloor = new Map<number, GamePlayer[]>()
  let deepest = 1
  for (const player of props.game.players.values()) {
    deepest = Math.max(deepest, player.floor, player.best)
    const list = byFloor.get(player.floor) ?? []
    list.push(player)
    byFloor.set(player.floor, list)
  }
  const entries: FloorEntry[] = []
  for (let floor = 0; floor <= deepest; floor++) {
    entries.push({
      floor,
      label: floor === HUB_FLOOR ? 'Hub' : `Floor ${floor} — ${BIOMES[biomeIndex(floor)]!.name}`,
      players: byFloor.get(floor) ?? [],
    })
  }
  return entries
})

const planCache = new Map<string, FloorPlan>()
/** Display wall grid (tiles + rasterized solid props), cached per floor. */
const occCache = new Map<string, Uint8Array>()
function getPlan(floor: number): FloorPlan {
  const seed = props.game.seed.value ?? TOWER_SEED
  const key = `${seed}:${floor}`
  let plan = planCache.get(key)
  if (!plan) {
    plan = generateFloor(floor, seed)
    planCache.set(key, plan)
    occCache.set(key, occupancyGrid(plan))
  }
  return plan
}
function getOcc(floor: number): Uint8Array {
  return occCache.get(`${props.game.seed.value ?? TOWER_SEED}:${floor}`) ?? getPlan(floor).tiles
}

/**
 * Draw one floor's map — fogged: only tiles *you* have explored are revealed,
 * so watching the map never hands you the route. Runners still ping as live
 * markers even in the dark, like a broadcast overlay.
 */
function drawFloor(canvas: HTMLCanvasElement | null, entry: FloorEntry) {
  if (!canvas) return
  const plan = getPlan(entry.floor)
  const occ = getOcc(entry.floor)
  canvas.width = plan.width * SCALE
  canvas.height = plan.height * SCALE
  const ctx = canvas.getContext('2d')!
  const explored = props.game.exploredFor(entry.floor)
  const isExplored = (x: number, y: number) =>
    props.revealAll || explored?.[Math.floor(y) * plan.width + Math.floor(x)] === 1

  ctx.fillStyle = '#0a0d13'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (!isExplored(x, y)) continue
      ctx.fillStyle = occ[y * plan.width + x] === 1 ? '#3a4457' : '#171d29'
      ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE)
    }
  }

  for (const trap of plan.traps) {
    if (!isExplored(trap.x, trap.y)) continue
    ctx.fillStyle = '#f43f5e'
    ctx.beginPath()
    ctx.arc(trap.x * SCALE, trap.y * SCALE, SCALE * 0.6, 0, Math.PI * 2)
    ctx.fill()
  }

  if (isExplored(plan.exit.x, plan.exit.y)) {
    ctx.fillStyle = entry.floor === HUB_FLOOR ? '#8b7bff' : '#00dc82'
    ctx.beginPath()
    ctx.arc(plan.exit.x * SCALE, plan.exit.y * SCALE, SCALE * 1.4, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const player of entry.players) {
    ctx.fillStyle = player.color
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(player.x * SCALE, player.y * SCALE, SCALE * 1.1, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

const deepest = computed(() => Math.max(1, ...floors.value.map((entry: FloorEntry) => entry.floor)))

/** Typed ref-callback factory so the template stays inference-friendly. */
function canvasRef(entry: FloorEntry) {
  return (el: unknown) => drawFloor(el as HTMLCanvasElement | null, entry)
}
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-20 flex flex-col overflow-hidden bg-black/80 backdrop-blur-sm">
    <div class="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-4">
      <div>
        <h2 class="text-lg font-semibold text-highlighted">
          Tower Map
        </h2>
        <p class="text-sm text-muted">
          Every floor, every runner, live. Deepest: floor {{ deepest }}.
        </p>
      </div>
      <UButton
        label="Leave"
        color="neutral"
        variant="soft"
        icon="i-lucide-log-out"
        @click="$emit('close')"
      />
    </div>

    <div class="flex flex-1 justify-end gap-6 overflow-y-auto p-6">
      <div class="flex flex-1 flex-wrap content-start items-start gap-6">
        <div
          v-for="entry in floors"
          :key="entry.floor"
          class="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/40 p-3"
        >
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium text-highlighted">{{ entry.label }}</span>
            <span class="text-xs text-muted">{{ entry.players.length }} <UIcon
              name="i-lucide-users"
              class="inline size-3"
            /></span>
          </div>
          <canvas
            :ref="canvasRef(entry)"
            class="rounded border border-white/5"
          />
          <div class="flex max-w-52 flex-wrap gap-1.5">
            <span
              v-for="player in entry.players"
              :key="player.id"
              class="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-toned"
            >
              <span
                class="size-1.5 rounded-full"
                :style="{ backgroundColor: player.color }"
              />
              {{ player.name }}
            </span>
          </div>
        </div>
      </div>

      <aside class="shrink-0">
        <RecordsBoard :records="game.records.value" />
      </aside>
    </div>
  </div>
</template>
