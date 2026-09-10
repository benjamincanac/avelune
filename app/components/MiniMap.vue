<script setup lang="ts">
import { generateHub, occupancyGrid } from '#shared/utils/maze'
import { COURTYARD } from '#shared/utils/courtyard'
import oracle from '#shared/data/courtyard-oracle.json'
import type { UseGame } from '~/composables/useGame'

/**
 * WoW-style round minimap: north-up, centered on you. The arena is one small
 * known map, so nothing is fogged.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 172
/** Half-extent of the window, in tiles. */
const RANGE = 22

const canvas = useTemplateRef('canvas')

/** The arena never changes — build the plan and its wall raster once. */
const plan = generateHub()
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
    x: SIZE / 2 + (wx - self.rx) * scale,
    y: SIZE / 2 + (wy - self.ry) * scale,
  })

  const minX = Math.max(0, Math.floor(self.x - RANGE))
  const maxX = Math.min(plan.width - 1, Math.ceil(self.x + RANGE))
  const minY = Math.max(0, Math.floor(self.y - RANGE))
  const maxY = Math.min(plan.height - 1, Math.ceil(self.y + RANGE))
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const wall = occ[ty * plan.width + tx] === 1
      ctx.fillStyle = wall ? '#666751' : '#b0a787'
      const { x, y } = toScreen(tx, ty)
      ctx.fillRect(x, y, scale + 0.5, scale + 0.5)
    }
  }

  const arena = toScreen(COURTYARD.arena.x, COURTYARD.arena.y)
  ctx.fillStyle = '#d4bb87'
  ctx.strokeStyle = '#eee0bb'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(arena.x, arena.y, COURTYARD.arena.radius * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  for (const prop of plan.props) {
    if (!['Courtyard_Tree', 'Courtyard_Fountain'].includes(prop.kind)) continue
    const point = toScreen(prop.x, prop.y)
    ctx.fillStyle = prop.kind === 'Courtyard_Tree' ? '#65815a' : '#73c5c5'
    ctx.beginPath()
    ctx.arc(point.x, point.y, (prop.kind === 'Courtyard_Tree' ? 1.8 * prop.scale : prop.r) * scale, 0, Math.PI * 2)
    ctx.fill()
  }
  const npc = toScreen(oracle[0]!, oracle[1]!)
  ctx.fillStyle = '#b9eaff'
  ctx.beginPath()
  ctx.moveTo(npc.x, npc.y - 3.5)
  ctx.lineTo(npc.x + 3, npc.y)
  ctx.lineTo(npc.x, npc.y + 3.5)
  ctx.lineTo(npc.x - 3, npc.y)
  ctx.closePath()
  ctx.fill()

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
    role="img"
    aria-label="Courtyard map showing the fountain plaza, Oracle and players"
    class="pointer-events-auto drop-shadow-lg"
  />
</template>
