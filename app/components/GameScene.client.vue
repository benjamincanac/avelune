<script setup lang="ts">
import { AgXToneMapping, PCFShadowMap } from 'three'
import { TresCanvas } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { UseGame } from '~/composables/useGame'

/**
 * Client-only wrapper: hosts the Tres renderer and owns all input.
 *
 * Movement keys go to two consumers — the server (via `game.setInput`, so
 * the authoritative simulation moves us) and the scene (via the `held`
 * object, for instant third-person prediction). The mouse-look heading is
 * client-owned: pointer lock captures the mouse, `view.yaw` turns the
 * camera immediately, and the composable flushes it to the server on a
 * fixed cadence.
 */

const props = defineProps<{ game: UseGame, editor?: boolean }>()

/** The hotbar's state. Input owns the keys and the wheel; `MazeScene` reads the
 *  armed slot when it aims and sends. */
const build = useBuild()

/** The full-screen world map. While it is up the game takes no input: no
 *  movement, no mouse-look, no tool. */
const map = useWorldMap()

/**
 * Fired when pointer lock is lost without us initiating it (Alt-cursor mode).
 * While locked the browser swallows the Escape keydown entirely, so this
 * transition IS the "player pressed Escape" signal — the page opens the game
 * menu on it. Focus loss (Alt-Tab) also drops the lock; the `hasFocus()` guard
 * below keeps that from counting.
 */
const emit = defineEmits<{ unlock: [] }>()

// GPU targets must be released before Tres disposes its WebGLRenderer.
let disposeScene: (() => void) | undefined

const held: MoveInput = { forward: false, back: false, left: false, right: false }

/**
 * Camera state shared with the scene. Mouse deltas drive yaw/pitch directly —
 * with pointer lock when available (real tabs), and from raw `movementX` on
 * plain mousemove otherwise (embeds that forbid pointer lock). Arrow keys
 * still turn as a keyboard fallback.
 */
const view = {
  yaw: -Math.PI / 2,
  pitch: 0.15,
  turnLeft: false,
  turnRight: false,
  /** One-shot action queues, consumed by the scene's prediction loop. */
  jumpQueued: false,
  dashQueued: false,
}

const root = ref<HTMLDivElement | null>(null)
const pointerLocked = ref(false)
/** Set once a lock request fails, so clicks act instead of retrying forever. */
let lockDenied = false

/**
 * Hold Alt to surface the OS cursor and freeze mouse-look, so the HUD buttons
 * become clickable; releasing Alt hands control back to the camera. We only
 * re-lock on release if Alt actually broke an existing pointer lock.
 */
const altHeld = ref(false)
let relockOnAltUp = false

// `event.code` is the *physical* key, so WASD works as ZQSD on AZERTY too.
const MOVE_KEYS: Record<string, keyof MoveInput> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
}
const TURN_KEYS: Record<string, 'turnLeft' | 'turnRight'> = {
  ArrowLeft: 'turnLeft',
  ArrowRight: 'turnRight',
}

const MOUSE_SENSITIVITY = 0.0031

function isTyping(): boolean {
  const tag = document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

function releaseAll() {
  held.forward = held.back = held.left = held.right = false
  view.turnLeft = view.turnRight = false
  props.game.setInput(held)
}

/** Fire a dash: tell the server and queue instant client-side prediction. */
function triggerDash() {
  props.game.sendAction('dash')
  view.dashQueued = true
}

/**
 * When the map last closed.
 *
 * Closing it re-takes the pointer lock, and when the key that closed it was
 * Escape the browser is still processing that same Escape: the lock is granted
 * and then dropped again a moment later. That drop is the tail of the map
 * interaction, not the player reaching for the menu, so the emit below ignores
 * one inside this window.
 */
let mapClosedAt = 0
const MAP_UNLOCK_GRACE = 600

/**
 * Open or close the world map. Opening drops the pointer lock (the map is a
 * cursor surface) and releases every held key so nobody walks on blind; closing
 * takes the lock back the way the Escape menu's resume does.
 */
function toggleMap() {
  if (map.open.value) {
    map.open.value = false
    mapClosedAt = Date.now()
    requestLock()
    return
  }
  map.open.value = true
  releaseAll()
  document.exitPointerLock?.()
}

function onKeyDown(event: KeyboardEvent) {
  // Editor mode owns keyboard/mouse (fly camera, placement) via its controller.
  if (props.editor) return
  if (isTyping()) return
  if (event.code === 'KeyM') {
    event.preventDefault()
    toggleMap()
    return
  }
  // The map is modal over the game: only `M` (above) and Escape (the page's
  // own handler) get through.
  if (map.open.value) return
  if (event.code === 'AltLeft' || event.code === 'AltRight') {
    // Prevent the OS menu-bar focus that a bare Alt tap triggers on some
    // platforms, then free the cursor for the HUD.
    event.preventDefault()
    if (!altHeld.value) {
      altHeld.value = true
      relockOnAltUp = pointerLocked.value
      document.exitPointerLock?.()
    }
    return
  }
  if (event.code === 'Space') {
    event.preventDefault()
    if (!event.repeat) {
      props.game.sendAction('jump')
      view.jumpQueued = true
    }
    return
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    if (!event.repeat) triggerDash()
    return
  }
  // Hotbar. Digits arm a slot, Tab turns the page, and the modifiers belong to
  // whichever tool is armed: Q cycles the paint surface, R turns the ghost a
  // quarter turn, and the brackets widen or narrow the terraform brush.
  if (event.code.startsWith('Digit')) {
    const index = Number(event.code.slice(5)) - 1
    if (index >= 0 && index < 9) {
      event.preventDefault()
      build.select(index)
      return
    }
  }
  if (event.code === 'Tab') {
    event.preventDefault()
    build.turnPage()
    return
  }
  if (event.code === 'KeyQ') {
    event.preventDefault()
    build.cycleSurface()
    return
  }
  if (event.code === 'KeyR') {
    event.preventDefault()
    build.rotate()
    return
  }
  if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
    event.preventDefault()
    build.nudgeSize(event.code === 'BracketLeft' ? -1 : 1)
    return
  }
  if (event.code === 'ArrowUp') {
    event.preventDefault()
    held.forward = true
    props.game.setInput(held)
    return
  }
  if (event.code === 'ArrowDown') {
    event.preventDefault()
    held.back = true
    props.game.setInput(held)
    return
  }
  const turn = TURN_KEYS[event.code]
  if (turn) {
    event.preventDefault()
    view[turn] = true
    return
  }
  const key = MOVE_KEYS[event.code]
  if (!key) return
  event.preventDefault()
  held[key] = true
  props.game.setInput(held)
}

function onKeyUp(event: KeyboardEvent) {
  if (props.editor || map.open.value) return
  if (event.code === 'AltLeft' || event.code === 'AltRight') {
    if (altHeld.value) {
      altHeld.value = false
      if (relockOnAltUp) requestLock()
      relockOnAltUp = false
    }
    return
  }
  if (event.code === 'ArrowUp') {
    held.forward = false
    props.game.setInput(held)
    return
  }
  if (event.code === 'ArrowDown') {
    held.back = false
    props.game.setInput(held)
    return
  }
  const turn = TURN_KEYS[event.code]
  if (turn) {
    view[turn] = false
    return
  }
  const key = MOVE_KEYS[event.code]
  if (!key) return
  held[key] = false
  props.game.setInput(held)
}

/**
 * Click the world to capture the mouse; Escape releases it (browser UI).
 * Pointer lock is unavailable in some embeds (e.g. iframes without the
 * `pointer-lock` permission) — there, cursor-position steering takes over.
 *
 * The same click also applies the armed hotbar tool. Queue it rather than act:
 * the scene aims from the camera *after* it has moved this frame, so it is the
 * one that knows where the crosshair actually points.
 */
function onClick(event: MouseEvent) {
  if (props.editor || map.open.value || altHeld.value || event.button !== 0) return
  // Only a click while already looking around fires the armed tool. The click
  // that captures the mouse is a lock request, not an edit.
  // Where pointer lock is unavailable or was refused (embeds, headless
  // browsers), cursor steering takes over and every click is an edit.
  const lockable = typeof HTMLElement !== 'undefined' && 'requestPointerLock' in HTMLElement.prototype
  if (pointerLocked.value || !lockable || lockDenied) {
    build.fire()
    return
  }
  try {
    const request = root.value?.querySelector('canvas')?.requestPointerLock() as Promise<void> | undefined
    request?.catch?.(() => {
      lockDenied = true
    })
  }
  catch {
    // Pointer lock not available here; cursor steering still works.
    lockDenied = true
  }
}

/** The wheel walks the hotbar, as it does in every game that has one. */
function onWheel(event: WheelEvent) {
  if (props.editor || map.open.value || isTyping()) return
  event.preventDefault()
  build.cycleSlot(event.deltaY > 0 ? 1 : -1)
}

/** Right-click dashes; the context menu is suppressed below so it can. */
function onMouseDown(event: MouseEvent) {
  if (props.editor || map.open.value || event.button !== 2 || isTyping()) return
  event.preventDefault()
  triggerDash()
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault()
}

function onPointerLockError() {
  lockDenied = true
}

function onPointerLockChange() {
  const locked = document.pointerLockElement != null
  const wasLocked = pointerLocked.value
  pointerLocked.value = locked
  // Opening the map releases the lock on purpose, and closing it with Escape
  // can bounce one — neither is the player reaching for the menu.
  if (map.open.value || Date.now() - mapClosedAt < MAP_UNLOCK_GRACE) return
  if (wasLocked && !locked && !altHeld.value && document.hasFocus()) emit('unlock')
}

/** Exposed so the page can chain a lock attempt onto fullscreen toggles. This
 *  is a lock request, not a click — it must not fire the armed tool. */
function requestLock() {
  if (props.editor || map.open.value || altHeld.value || pointerLocked.value) return
  try {
    const request = root.value?.querySelector('canvas')?.requestPointerLock() as Promise<void> | undefined
    request?.catch?.(() => {})
  }
  catch {
    // Pointer lock not available here; cursor steering still works.
  }
}

function onMouseMove(event: MouseEvent) {
  if (props.editor || map.open.value) return
  // Alt frees the cursor for the HUD — don't steer while it's held.
  if (altHeld.value) return
  // Same raw-delta look in both modes; without pointer lock, only while the
  // pointer is over the world so the HUD stays usable.
  if (!pointerLocked.value) {
    const overWorld = event.target instanceof Node && root.value?.contains(event.target)
    if (!overWorld) return
  }
  view.yaw += event.movementX * MOUSE_SENSITIVITY
  view.pitch = Math.min(0.7, Math.max(-0.4, view.pitch + event.movementY * 0.0022))
  props.game.setLook(view.yaw)
}

/** Stop moving when the chat input steals focus or the tab is hidden. */
function onFocusIn() {
  if (isTyping()) releaseAll()
}

function onVisibilityChange() {
  if (document.hidden) releaseAll()
}

/**
 * Alt+Tab and friends can swallow the Alt keyup — reset here so mouse-look
 * isn't left frozen, and stop any held movement.
 */
function onWindowBlur() {
  altHeld.value = false
  relockOnAltUp = false
  releaseAll()
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('pointerlockerror', onPointerLockError)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('focusin', onFocusIn)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  // The map is shared state; leaving the arena must not leave it up.
  map.open.value = false
  disposeScene?.()
  disposeScene = undefined
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('pointerlockerror', onPointerLockError)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('focusin', onFocusIn)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

defineExpose({ pointerLocked, requestLock, toggleMap })
</script>

<template>
  <div
    ref="root"
    class="relative size-full select-none"
    :class="editor || altHeld || map.open.value ? 'cursor-default' : 'cursor-none'"
    @click="onClick"
    @wheel="onWheel"
    @mousedown="onMouseDown"
    @contextmenu="onContextMenu"
  >
    <!--
      Cascaded shadow maps (app/utils/shadows.ts) own the sun, so the shadow
      type stays PCF: PCFSoft is downgraded to PCF by three anyway, and CSM
      blends its own cascade edges. Tone mapping happens once, in the pipeline's
      OutputPass, which reads these renderer settings.
    -->
    <TresCanvas
      clear-color="#05070d"
      :dpr="[1, 2]"
      shadows
      :shadow-map-type="PCFShadowMap"
      :tone-mapping="AgXToneMapping"
      :tone-mapping-exposure="1.25"
    >
      <MazeScene
        :game="game"
        :held="held"
        :view="view"
        :editor="editor"
        @ready="disposeScene = $event"
      />
    </TresCanvas>
  </div>
</template>
