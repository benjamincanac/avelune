<script setup lang="ts">
import { drawPlayerDot, drawSelfArrow, MAP_COLORS, mapProjection, paintChunkGrid, paintPlots, paintTownOutline, paintWorld } from '~/utils/mapDraw'
import type { UseGame } from '~/composables/useGame'

/**
 * The full-screen world map (`M`). Same painter as the minimap, a much bigger
 * window: every chunk the client is holding, north up, the player centred until
 * you drag somewhere else. Nothing is fogged and nothing is invented — the
 * faint chunk lattice is there so the streamed edge reads as "not loaded yet"
 * rather than "the world stops here".
 *
 * Full-bleed, chrome only at the edges: veils fade the terrain under the top
 * and bottom clusters and the middle two-thirds stay nearly clear, because the
 * map is the content here and the panels are not.
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

/** The map is a live surface too: every indicator on screen moves off the
 *  accent together when the socket stops being open, rather than this one
 *  claiming the world is live while the roster behind it says otherwise. */
const live = computed(() => props.game.status.value === 'connected')

const LEGEND = [
  { label: 'Town', color: MAP_COLORS.street },
  { label: 'Wilds', color: MAP_COLORS.garden },
  { label: 'Water', color: MAP_COLORS.water },
  { label: 'Plots', color: null },
]

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
  paintPlots(ctx, paint, id => props.game.players.get(id)?.color)

  // Everyone else, named, then you as an arrow pointing where you look.
  ctx.font = '11px Archivo, ui-sans-serif, system-ui, sans-serif'
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
    // A ring around the marker, so you can find yourself after panning away —
    // it follows the player rather than sitting at the viewport centre.
    ctx.strokeStyle = 'rgba(111, 240, 218, 0.3)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 65, 0, Math.PI * 2)
    ctx.stroke()
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
  <div
    ref="wrapper"
    class="absolute inset-0 z-40 select-none overflow-hidden bg-stage"
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

    <!-- Veils, so the chrome reads without a panel behind it. Never blurred:
         the map underneath is the content. -->
    <div class="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgb(6_14_17/0.82)_0%,rgb(6_14_17/0.1)_16%,rgb(6_14_17/0.1)_82%,rgb(6_14_17/0.86)_100%)]" />

    <div class="on-render pointer-events-none absolute left-9 top-7.5 flex flex-wrap items-center gap-4.5">
      <h2 class="font-display text-[26px] font-extrabold uppercase leading-none tracking-[0.2em] text-highlighted">
        World map
      </h2>
      <span class="h-4.5 w-px bg-white/24" />
      <span class="telemetry text-[11px] tracking-[0.14em] text-default">{{ centre.x }}, {{ centre.y }}</span>
      <span class="telemetry text-[11px] tracking-[0.14em] text-muted">{{ chunkCount }} chunks loaded</span>
      <span
        class="telemetry flex items-center gap-2 text-[11px] tracking-[0.14em]"
        :class="live ? 'text-primary' : 'text-warning'"
      >
        <span
          class="size-1.5"
          :class="live ? 'bg-primary' : 'bg-warning'"
        />
        {{ live ? 'Live' : 'Reconnecting' }}
      </span>
    </div>

    <div class="absolute right-9 top-6.5 flex items-stretch gap-2">
      <UButton
        size="xs"
        icon="i-lucide-locate-fixed"
        label="Centre on me"
        class="notch-btn"
        @click="recenter"
      />
      <UButton
        color="neutral"
        variant="subtle"
        icon="i-lucide-x"
        aria-label="Close the map"
        class="frost w-10.5 justify-center rounded-[6px] bg-transparent ring-0 hover:bg-white/10"
        :ui="{ leadingIcon: 'size-4' }"
        @click="emit('close')"
      />
    </div>

    <div class="on-render pointer-events-none absolute bottom-8 left-9 flex flex-col gap-2.5">
      <p class="label-section text-muted">
        Legend
      </p>
      <div class="fused bg-white/12">
        <div
          v-for="item in LEGEND"
          :key="item.label"
          class="telemetry flex items-center gap-2.5 whitespace-nowrap bg-stage/50 px-3.5 py-2.5 text-toned backdrop-blur-[22px]"
        >
          <span
            class="size-2.5"
            :class="item.color ? '' : 'shadow-[inset_0_0_0_2px_var(--ui-primary)]'"
            :style="item.color ? { backgroundColor: item.color } : undefined"
          />
          {{ item.label }}
        </div>
      </div>
    </div>

    <div class="on-render pointer-events-none absolute bottom-8 right-9 flex flex-col items-end gap-2.5">
      <div class="flex items-center gap-2.5">
        <span
          class="h-px bg-white shadow-[0_-4px_0_-3px_#fff,0_4px_0_-3px_#fff]"
          :style="{ width: `${bar.px}px` }"
        />
        <span class="telemetry tracking-[0.14em] text-highlighted">{{ bar.tiles }} tiles</span>
      </div>
      <div class="telemetry flex items-center gap-3.5 whitespace-nowrap text-muted">
        <span>Drag to pan</span>
        <span>Scroll to zoom</span>
        <span class="flex items-center gap-1.5"><UKbd value="M" /> / <UKbd value="Esc" /> close</span>
      </div>
    </div>
  </div>
</template>
