<script setup lang="ts">
import type { FloorPlan } from '#shared/utils/maze'
import { BIOMES, HUB_FLOOR, TOWER_SEED, biomeIndex, generateFloor, occupancyGrid } from '#shared/utils/maze'
import type { UseGame } from '~/composables/useGame'

/**
 * WoW-style round minimap: north-up, centered on you, and fogged — only
 * tiles you've walked near are drawn, so the maze stays a maze.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 172
/** Half-extent of the window, in tiles. */
const RANGE = 11

const canvas = useTemplateRef('canvas')

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

const floorLabel = computed(() => {
  const floor = props.game.selfFloor.value
  return floor === HUB_FLOOR ? 'The Hub' : `F${floor} · ${BIOMES[biomeIndex(floor)]!.name}`
})

function draw() {
  const el = canvas.value
  const selfId = props.game.selfId.value
  const self = selfId ? props.game.players.get(selfId) : undefined
  if (!el || !self) return
  const ctx = el.getContext('2d')!
  const scale = SIZE / (RANGE * 2)
  const floor = self.floor
  const plan = getPlan(floor)
  const occ = occCache.get(`${props.game.seed.value ?? TOWER_SEED}:${floor}`) ?? plan.tiles
  const explored = props.game.exploredFor(floor)

  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.save()
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2)
  ctx.clip()

  ctx.fillStyle = 'rgba(6, 9, 14, 0.85)'
  ctx.fillRect(0, 0, SIZE, SIZE)

  const toScreen = (wx: number, wy: number) => ({
    x: SIZE / 2 + (wx - self.x) * scale,
    y: SIZE / 2 + (wy - self.y) * scale,
  })

  const minX = Math.max(0, Math.floor(self.x - RANGE))
  const maxX = Math.min(plan.width - 1, Math.ceil(self.x + RANGE))
  const minY = Math.max(0, Math.floor(self.y - RANGE))
  const maxY = Math.min(plan.height - 1, Math.ceil(self.y + RANGE))
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (explored && !explored[ty * plan.width + tx]) continue
      const wall = occ[ty * plan.width + tx] === 1
      ctx.fillStyle = wall ? '#4a5468' : '#232c3d'
      const { x, y } = toScreen(tx, ty)
      ctx.fillRect(x, y, scale + 0.5, scale + 0.5)
    }
  }

  const isExplored = (wx: number, wy: number) =>
    !explored || explored[Math.floor(wy) * plan.width + Math.floor(wx)] === 1

  // The exit, only once discovered. Traps stay hidden.
  if (isExplored(plan.exit.x, plan.exit.y)) {
    const { x, y } = toScreen(plan.exit.x, plan.exit.y)
    ctx.fillStyle = floor === HUB_FLOOR ? '#8b7bff' : '#00dc82'
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  // Same-floor runners, then you as an oriented arrow.
  for (const player of props.game.players.values()) {
    if (player.floor !== floor || player.id === selfId) continue
    const { x, y } = toScreen(player.x, player.y)
    ctx.fillStyle = player.color
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  ctx.save()
  ctx.translate(SIZE / 2, SIZE / 2)
  ctx.rotate(self.ra + Math.PI / 2)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(0, -6)
  ctx.lineTo(4.5, 5)
  ctx.lineTo(-4.5, 5)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.restore()

  // Rim.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2)
  ctx.stroke()
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(draw, 120)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="pointer-events-auto flex flex-col items-center gap-1">
    <canvas
      ref="canvas"
      :width="SIZE"
      :height="SIZE"
      class="drop-shadow-lg"
    />
    <span class="rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-medium text-toned backdrop-blur">
      {{ floorLabel }}
    </span>
  </div>
</template>
