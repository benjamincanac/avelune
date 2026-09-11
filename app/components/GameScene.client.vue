<script setup lang="ts">
import { ACESFilmicToneMapping, PCFSoftShadowMap } from 'three'
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

const props = defineProps<{ game: UseGame }>()

/**
 * Fired when pointer lock is lost without us initiating it (Alt-cursor mode).
 * While locked the browser swallows the Escape keydown entirely, so this
 * transition IS the "player pressed Escape" signal — the page opens the game
 * menu on it. Focus loss (Alt-Tab) also drops the lock; the `hasFocus()` guard
 * below keeps that from counting.
 */
const emit = defineEmits<{ unlock: [] }>()

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

function onKeyDown(event: KeyboardEvent) {
  if (isTyping()) return
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
 */
function onClick() {
  if (altHeld.value || pointerLocked.value) return
  try {
    const request = root.value?.querySelector('canvas')?.requestPointerLock() as Promise<void> | undefined
    request?.catch?.(() => {})
  }
  catch {
    // Pointer lock not available here; cursor steering still works.
  }
}

/** Right-click dashes; the context menu is suppressed below so it can. */
function onMouseDown(event: MouseEvent) {
  if (event.button !== 2 || isTyping()) return
  event.preventDefault()
  triggerDash()
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault()
}

function onPointerLockChange() {
  const locked = document.pointerLockElement != null
  const wasLocked = pointerLocked.value
  pointerLocked.value = locked
  if (wasLocked && !locked && !altHeld.value && document.hasFocus()) emit('unlock')
}

/** Exposed so the page can chain a lock attempt onto fullscreen toggles. */
function requestLock() {
  onClick()
}

function onMouseMove(event: MouseEvent) {
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
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('focusin', onFocusIn)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('focusin', onFocusIn)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

defineExpose({ pointerLocked, requestLock })
</script>

<template>
  <div
    ref="root"
    class="size-full select-none"
    :class="altHeld ? 'cursor-default' : 'cursor-none'"
    @click="onClick"
    @mousedown="onMouseDown"
    @contextmenu="onContextMenu"
  >
    <TresCanvas
      clear-color="#05070d"
      :dpr="[1, 2]"
      shadows
      :shadow-map-type="PCFSoftShadowMap"
      :tone-mapping="ACESFilmicToneMapping"
      :tone-mapping-exposure="1.05"
    >
      <ArenaScene
        :game="game"
        :held="held"
        :view="view"
      />
    </TresCanvas>
  </div>
</template>
