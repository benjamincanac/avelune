<script setup lang="ts">
import { generateArena, occupancyGrid } from '#shared/utils/arena'
import type { UseGame } from '~/composables/useGame'

/**
 * WoW-style round minimap: north-up, centered on you. The arena is one small
 * known map, so nothing is fogged.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 172
/** Half-extent of the window, in tiles. */
const RANGE = 11

const canvas = useTemplateRef('canvas')

/** The arena never changes — build the plan and its wall raster once. */
const plan = generateArena()
/** Display wall grid: tiles plus rasterized solid props. */
const occ = occupancyGrid(plan)

function draw() {
  const el = canvas.value
  const selfId = props.game.selfId.value
  const self = selfId ? props.game.players.get(selfId) : undefined
  if (!el || !self) return
  const ctx = el.getContext('2d')!
  const scale = SIZE / (RANGE * 2)

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
      const wall = occ[ty * plan.width + tx] === 1
      ctx.fillStyle = wall ? '#4a5468' : '#232c3d'
      const { x, y } = toScreen(tx, ty)
      ctx.fillRect(x, y, scale + 0.5, scale + 0.5)
    }
  }

  // Everyone else, then you as an oriented arrow.
  for (const player of props.game.players.values()) {
    if (player.id === selfId) continue
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
  <canvas
    ref="canvas"
    :width="SIZE"
    :height="SIZE"
    class="pointer-events-auto drop-shadow-lg"
  />
</template>
