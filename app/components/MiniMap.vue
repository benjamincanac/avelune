<script setup lang="ts">
import { generateHub, occupancyGrid } from '#shared/utils/maze'
import { COURTYARD, isInMoat, isOnGateBridge, TOWN_GARDENS, TOWN_STREETS } from '#shared/utils/courtyard'
import { RAMPART_STAIRS } from '#shared/utils/ramparts'
import oracle from '#shared/data/courtyard-oracle.json'
import type { UseGame } from '~/composables/useGame'

/**
 * Round minimap centered on the player, with nearby streets and landmarks.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 172
/** Half-extent of the window, in tiles. */
const RANGE = Math.max(22, (COURTYARD.max - COURTYARD.min) * 0.32)

const canvas = useTemplateRef('canvas')

/** Build the bundled town plan and its wall raster once. */
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
      const bridge = isOnGateBridge(tx + 0.5, ty + 0.5)
      const moat = isInMoat(tx + 0.5, ty + 0.5)
      const exterior = tx < COURTYARD.min || tx >= COURTYARD.max || ty < COURTYARD.min || ty >= COURTYARD.max
      ctx.fillStyle = bridge ? '#d6c5a3' : moat ? '#369b98' : wall ? '#666751' : exterior ? '#779661' : '#b0a787'
      const { x, y } = toScreen(tx, ty)
      ctx.fillRect(x, y, scale + 0.5, scale + 0.5)
    }
  }

  for (const street of TOWN_STREETS) {
    const start = toScreen(street.x1, street.z1)
    const end = toScreen(street.x2, street.z2)
    ctx.strokeStyle = '#d6c5a3'
    ctx.lineWidth = street.width * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
  }
  for (const garden of TOWN_GARDENS) {
    const point = toScreen(garden.x, garden.z)
    ctx.fillStyle = '#779661'
    ctx.beginPath()
    ctx.ellipse(point.x, point.y, garden.rx * scale, garden.rz * scale, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  // Preserve solid footprints where a road passes beside a building.
  ctx.fillStyle = '#666751'
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (occ[ty * plan.width + tx] !== 1 || isInMoat(tx + 0.5, ty + 0.5)) continue
      const point = toScreen(tx, ty)
      ctx.fillRect(point.x, point.y, scale + 0.5, scale + 0.5)
    }
  }

  for (const stair of RAMPART_STAIRS) {
    const start = toScreen(stair.x - stair.width / 2, stair.zStart)
    const length = (stair.zEnd - stair.zStart) * scale
    ctx.fillStyle = '#ded5be'
    ctx.fillRect(start.x, start.y, stair.width * scale, length)
    ctx.fillStyle = '#82847e'
    for (let i = 1; i < 9; i++) ctx.fillRect(start.x, start.y + length * i / 9, stair.width * scale, 1)
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
    aria-label="Town map showing streets, gardens, the fountain square, Oracle and players"
    class="pointer-events-auto drop-shadow-lg"
  />
</template>
