<script setup lang="ts">
import { drawPlayerDot, drawSelfArrow, MAP_COLORS, mapProjection, paintWorld } from '~/utils/mapDraw'
import type { UseGame } from '~/composables/useGame'

/**
 * Round minimap centered on the player, with nearby streets and landmarks.
 *
 * The drawing itself is `app/utils/mapDraw.ts`, shared with the full-screen
 * world map (`M`) so the two can never drift apart — this component only picks
 * the window: a circle, north-up, centred on you.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 172
/** Half-extent of the window, in tiles. The world is open now, so this is a
 *  zoom level rather than a fraction of the town. */
const RANGE = 34

const canvas = useTemplateRef('canvas')

/** The same streamed world the scene walks on: the map can only show ground
 *  the server has actually given us, which is the point. */
const { world } = useWorld()

function draw() {
  const el = canvas.value
  const selfId = props.game.selfId.value
  const self = selfId ? props.game.players.get(selfId) : undefined
  if (!el || !self) return
  const ctx = el.getContext('2d')!
  const paint = {
    world,
    scale: SIZE / (RANGE * 2),
    centerX: self.rx,
    centerY: self.ry,
    width: SIZE,
    height: SIZE,
  }
  const project = mapProjection(paint)

  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.save()
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2)
  ctx.clip()

  ctx.fillStyle = MAP_COLORS.backdrop
  ctx.fillRect(0, 0, SIZE, SIZE)

  paintWorld(ctx, paint)

  // Everyone else, then you as an oriented arrow.
  for (const player of props.game.players.values()) {
    if (player.id === selfId) continue
    const { x, y } = project(player.x, player.y)
    drawPlayerDot(ctx, x, y, player.color)
  }
  drawSelfArrow(ctx, SIZE / 2, SIZE / 2, self.ra)

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
