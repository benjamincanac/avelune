<script setup lang="ts">
import { drawPlayerDot, drawSelfArrow, MAP_COLORS, mapProjection, paintChunkGrid, paintTownOutline, paintWorld } from '~/utils/mapDraw'
import type { UseGame } from '~/composables/useGame'

/**
 * The full-screen world map (`M`). Same painter as the minimap, a much bigger
 * window: every chunk the client is holding, north up, the player centred until
 * you drag somewhere else. Nothing is fogged and nothing is invented — the
 * faint chunk lattice is there so the streamed edge reads as "not loaded yet"
 * rather than "the world stops here".
 *
 * `GameScene` owns the key and the pointer lock; this component only draws and
 * asks to be closed.
 */

const props = defineProps<{ game: UseGame }>()
const emit = defineEmits<{ close: [] }>()

/** Pixels per tile. Three steps: the whole loaded neighbourhood, a district, a
 *  street. */
const ZOOM_LEVELS = [1.5, 3, 6]
const zoom = ref(1)
const scale = computed(() => ZOOM_LEVELS[zoom.value]!)

/** Drag offset from the player, in tiles. Reset every time the map opens. */
const pan = reactive({ x: 0, y: 0 })

const { world, chunkCount } = useWorld()
const wrapper = useTemplateRef('wrapper')
const canvas = useTemplateRef('canvas')

/** Canvas size in CSS pixels, tracked so the map fills whatever the window is. */
const size = reactive({ width: 0, height: 0 })
/** Tiles covered by the scale bar, and its length in pixels. */
const bar = reactive({ tiles: 0, px: 0 })
const centre = reactive({ x: 0, y: 0 })

function self() {
  const id = props.game.selfId.value
  return id ? props.game.players.get(id) : undefined
}

function draw() {
  const el = canvas.value
  if (!el || size.width === 0) return
  const ctx = el.getContext('2d')!
  const me = self()
  const centerX = (me?.rx ?? world.start.x) + pan.x
  const centerY = (me?.ry ?? world.start.y) + pan.y
  centre.x = Math.round(centerX)
  centre.y = Math.round(centerY)
  const paint = { world, scale: scale.value, centerX, centerY, width: size.width, height: size.height }
  const project = mapProjection(paint)

  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.fillStyle = MAP_COLORS.backdrop
  ctx.fillRect(0, 0, size.width, size.height)

  paintWorld(ctx, paint)
  paintChunkGrid(ctx, paint)
  paintTownOutline(ctx, paint)

  // Everyone else, named, then you as an arrow pointing where you look.
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  for (const player of props.game.players.values()) {
    if (player.id === props.game.selfId.value) continue
    const { x, y } = project(player.x, player.y)
    if (x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) continue
    drawPlayerDot(ctx, x, y, player.color)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillText(player.name, x, y - 7)
  }
  if (me) {
    const { x, y } = project(me.rx, me.ry)
    drawSelfArrow(ctx, x, y, me.ra, 8)
  }

  // Scale bar: the roundest tile count that stays near 120 px.
  const steps = [5, 10, 20, 50, 100, 200, 500, 1000]
  bar.tiles = steps.find(step => step * scale.value >= 120) ?? steps.at(-1)!
  bar.px = bar.tiles * scale.value
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const next = zoom.value + (event.deltaY > 0 ? -1 : 1)
  zoom.value = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, next))
  draw()
}

let dragging: number | null = null
let last = { x: 0, y: 0 }

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  dragging = event.pointerId
  last = { x: event.clientX, y: event.clientY }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (dragging !== event.pointerId) return
  pan.x -= (event.clientX - last.x) / scale.value
  pan.y -= (event.clientY - last.y) / scale.value
  last = { x: event.clientX, y: event.clientY }
  draw()
}

function onPointerUp(event: PointerEvent) {
  if (dragging !== event.pointerId) return
  dragging = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function recenter() {
  pan.x = 0
  pan.y = 0
  draw()
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

function resize() {
  const box = wrapper.value?.getBoundingClientRect()
  const el = canvas.value
  if (!box || !el) return
  const dpr = window.devicePixelRatio || 1
  size.width = Math.round(box.width)
  size.height = Math.round(box.height)
  el.width = Math.round(size.width * dpr)
  el.height = Math.round(size.height * dpr)
  draw()
}

let observer: ResizeObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
const stops: Array<() => void> = []

onMounted(() => {
  const { onChunk, onUnchunk, onTerrain, onProps } = useWorld()
  // Redraw the moment the world changes under us, plus a slow tick for the
  // players, who move every frame and would otherwise redraw the whole map.
  stops.push(onChunk(draw), onUnchunk(draw), onTerrain(draw), onProps(draw))
  timer = setInterval(draw, 250)
  observer = new ResizeObserver(resize)
  if (wrapper.value) observer.observe(wrapper.value)
  resize()
})

onBeforeUnmount(() => {
  for (const stop of stops) stop()
  clearInterval(timer)
  observer?.disconnect()
})
</script>

<template>
  <div class="absolute inset-0 z-40 flex select-none items-center justify-center bg-black/50 p-6">
    <div class="flex size-full max-w-6xl flex-col gap-3 rounded-xl bg-black/45 p-3 ring ring-white/10 backdrop-blur">
      <div class="flex items-center justify-between gap-4 px-1">
        <div class="flex items-baseline gap-3">
          <p class="text-[10px] font-medium uppercase tracking-widest text-muted">
            World map
          </p>
          <p class="text-[11px] text-dimmed">
            {{ centre.x }}, {{ centre.y }} · {{ chunkCount }} chunks loaded
          </p>
        </div>
        <div class="flex items-center gap-1.5">
          <UButton
            label="Centre on me"
            icon="i-lucide-locate-fixed"
            color="neutral"
            variant="soft"
            size="xs"
            @click="recenter"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Close the map"
            @click="emit('close')"
          />
        </div>
      </div>

      <div
        ref="wrapper"
        class="relative min-h-0 flex-1 overflow-hidden rounded-lg ring ring-white/10"
      >
        <canvas
          ref="canvas"
          :style="{ width: `${size.width}px`, height: `${size.height}px` }"
          class="block cursor-grab active:cursor-grabbing"
          role="img"
          aria-label="World map of the streamed chunks, the town and the players in it"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />

        <!-- Scale bar, bottom-left of the map itself. -->
        <div class="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1">
          <div
            class="h-1.5 border-x border-b border-white/70"
            :style="{ width: `${bar.px}px` }"
          />
          <span class="text-[10px] text-white/70">{{ bar.tiles }} tiles</span>
        </div>
      </div>

      <p class="px-1 text-center text-[11px] text-dimmed">
        Drag to pan · scroll to zoom · <UKbd value="M" /> or <UKbd value="Esc" /> to close
      </p>
    </div>
  </div>
</template>
