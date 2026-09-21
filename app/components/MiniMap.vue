<script setup lang="ts">
import { drawPlayerDot, drawSelfArrow, MAP_COLORS, mapProjection, paintWorld } from '~/utils/mapDraw'
import type { UseGame } from '~/composables/useGame'

/**
 * Square minimap centered on the player, with nearby streets and landmarks, and
 * a mono bar underneath carrying the two numbers the server owns: where you are
 * and how much of the world you are holding.
 *
 * The drawing itself is `app/utils/mapDraw.ts`, shared with the full-screen
 * world map (`M`) so the two can never drift apart — this component only picks
 * the window: north-up, centred on you.
 */

const props = defineProps<{ game: UseGame }>()

const SIZE = 214
/** Half-extent of the window, in tiles. The world is open now, so this is a
 *  zoom level rather than a fraction of the town. */
const RANGE = 40

const canvas = useTemplateRef('canvas')

/** The same streamed world the scene walks on: the map can only show ground
 *  the server has actually given us, which is the point. */
const { world, chunkCount } = useWorld()

/** Where we are, for the bar. Rounded, because a tile is the unit anyone cares
 *  about and a float would flicker every frame. */
const at = reactive({ x: 0, y: 0 })

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

  at.x = Math.round(self.rx)
  at.y = Math.round(self.ry)

  ctx.clearRect(0, 0, SIZE, SIZE)
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
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(draw, 120)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <!-- The bitmap stays SIZE square and CSS scales it, so a narrow window gets a
       smaller map rather than one laid over the status bar. -->
  <div class="pointer-events-none w-32 md:w-53.5">
    <div class="relative overflow-hidden rounded-[6px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)]">
      <canvas
        ref="canvas"
        :width="SIZE"
        :height="SIZE"
        role="img"
        aria-label="Map of the streamed world around you, with the town, players and anything built nearby"
        class="block h-auto w-full"
      />
      <span class="telemetry absolute left-2.5 top-2.5 font-semibold tracking-[0.14em] text-highlighted [text-shadow:0_1px_3px_#000]">N</span>
    </div>
    <div class="frost telemetry on-render mt-1.5 flex items-center justify-between rounded-[6px] px-3 py-1.5 tracking-widest">
      <span class="text-highlighted">{{ at.x }}, {{ at.y }}</span>
      <span class="text-muted max-md:hidden">{{ chunkCount }} chunks</span>
    </div>
  </div>
</template>
