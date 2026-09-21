<script setup lang="ts">
import { AgXToneMapping, PCFShadowMap } from 'three'
import { TresCanvas } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { UseGame } from '~/composables/useGame'
import { PITCH_MAX, PITCH_MAX_TOOL, PITCH_MIN } from '~/composables/useBuild'

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

/** The mixer. Browsers refuse an `AudioContext` before a gesture, so the first
 *  key or click in here is what starts it. */
const audio = useAudio()

/** Proximity voice. This component owns only the push-to-talk key; the mic, the
 *  peers and the mixing are `useVoice`'s. */
const voice = useVoice()

/** The quality settings. The canvas owns the two the renderer itself is built
 *  from — the pixel ratio and whether it draws shadow maps at all — and
 *  `MazeScene` owns everything inside the scene. */
const graphics = useGraphics()

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

const held: MoveInput = { forward: false, back: false, left: false, right: false, sprint: false }

/**
 * Camera state shared with the scene. Mouse deltas drive yaw/pitch directly.
 *
 * Under pointer lock that is the whole story: the cursor is gone and the
 * deltas never run out. Without it — an embed or a browser that refuses the
 * lock — the same deltas steer, but the OS cursor is still a real point that
 * stops at the window edge and takes the deltas with it, so `edgePan` below
 * keeps turning while it sits there. Arrow keys turn as a keyboard fallback.
 */
const view = {
  yaw: -Math.PI / 2,
  /** Radians below the horizon (see `PITCH_*` in `useBuild`). */
  pitch: 0.2,
  turnLeft: false,
  turnRight: false,
  /** One-shot action queues, consumed by the scene's prediction loop. */
  jumpQueued: false,
  dashQueued: false,
  /**
   * Cursor-mode aim, in normalized device coordinates.
   *
   * While Alt frees the cursor the crosshair is not where you are pointing, so
   * the scene aims the build ray through this instead of down the camera's own
   * forward axis. `cursorActive` is false the rest of the time, which is the
   * signal to go back to the screen centre.
   */
  cursorActive: false,
  cursorX: 0,
  cursorY: 0,
}

const root = ref<HTMLDivElement | null>(null)
const pointerLocked = ref(false)
/** Whether this browser has pointer lock at all. */
const LOCKABLE = typeof HTMLElement !== 'undefined' && 'requestPointerLock' in HTMLElement.prototype
/** Set once a lock request fails, so clicks act instead of retrying forever. */
const lockDenied = ref(false)
/**
 * Whether the mouse steers right now.
 *
 * Locked, it always does. Unlocked it only does where the lock is not coming —
 * before the first click in a normal tab the cursor is still the player's, and
 * steering with it would both hide the fact that a click is what starts mouse
 * look and strand them the moment the hidden cursor reached the window edge.
 */
const steering = computed(() => pointerLocked.value || !LOCKABLE || lockDenied.value)
/** Lock requests made since the last one that was actually granted. */
let lockAttempts = 0
/** How long a request has to be granted before we count it unanswered. */
const LOCK_GRACE = 700

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

/**
 * Edge pan, for the no-pointer-lock fallback.
 *
 * With the cursor pressed against the window edge every further `movementX` is
 * zero, so the camera simply stops — you have turned as far as the window is
 * wide. Inside this margin of the canvas edge we keep turning on our own, at a
 * rate that ramps from nothing at the inner edge of the band to `EDGE_PAN_RATE`
 * radians a second in the corner, which is what carries the turn past the wall.
 * Under pointer lock the band is never entered: there is no cursor to put in it.
 */
const EDGE_PAN_MARGIN = 96
const EDGE_PAN_RATE = 2.4
let edgePanX = 0
let edgePanY = 0
let edgePanRaf = 0
let edgePanAt = 0

/** Radians below the horizon, clamped. An armed tool unlocks the steep range so
 *  the crosshair can reach your own feet; the scene eases it back on disarm. */
function clampPitch(next: number): number {
  const floor = build.active.value ? PITCH_MAX_TOOL : PITCH_MAX
  return Math.min(floor, Math.max(PITCH_MIN, next))
}

/** How far into the edge band `value` sits, as 0 at the band's inner edge and
 *  ±1 hard against the side. */
function edgeRamp(value: number, size: number): number {
  if (size <= EDGE_PAN_MARGIN * 2) return 0
  if (value < EDGE_PAN_MARGIN) return -(1 - Math.max(0, value) / EDGE_PAN_MARGIN)
  if (value > size - EDGE_PAN_MARGIN) return 1 - Math.max(0, size - value) / EDGE_PAN_MARGIN
  return 0
}

/**
 * Push to talk.
 *
 * `T` for talk, and one of the few letters this game had left: W A S D, Space,
 * Shift, E, Alt, 1-9, Tab, Q, R, V, the brackets, the arrows, M, N, F, Enter and
 * Escape were all taken. The Escape menu's controls list has to name it too.
 */
const PUSH_TO_TALK = 'KeyT'

function isTyping(): boolean {
  const tag = document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

function releaseAll() {
  held.forward = held.back = held.left = held.right = held.sprint = false
  view.turnLeft = view.turnRight = false
  props.game.setInput(held)
}

/** Fire a dash: tell the server and queue instant client-side prediction. */
function triggerDash() {
  props.game.sendAction('dash')
  view.dashQueued = true
}

/**
 * When the lock last moved for a reason that isn't the player reaching for the
 * menu: we asked for it back (the map or the menu closing, a fullscreen toggle
 * we ran ourselves), and the drop that followed rode the same keypress.
 *
 * When the key behind the request was Escape the browser is still processing
 * that same Escape, so the lock is granted and then dropped again a moment
 * later. That tail is what the emit below ignores — and only that: the window
 * shrinks to `BOUNCE_GRACE` once the grant lands, because the bounce arrives
 * within a frame of it. Anything later is a real Escape and opens the menu.
 *
 * Nothing here is armed by a fullscreen exit we did not run: on a browser
 * without Keyboard Lock that exit IS the player's Escape, and it has to reach
 * the menu.
 */
let unlockGraceAt = 0
let unlockGrace = 0
const REQUEST_GRACE = 600
const BOUNCE_GRACE = 150

function holdUnlock(ms = REQUEST_GRACE) {
  unlockGraceAt = Date.now()
  unlockGrace = ms
}

/**
 * Open or close the world map. Opening drops the pointer lock (the map is a
 * cursor surface) and releases every held key so nobody walks on blind; closing
 * takes the lock back the way the Escape menu's resume does.
 */
function toggleMap() {
  if (map.open.value) {
    map.open.value = false
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
  // Any key in the world counts as the gesture the audio context waits for.
  audio.unlock()
  // Mute the microphone, not the game: `N` is the one that has to work while
  // the map is up and while the talk key is held, so it sits above both.
  if (event.code === 'KeyN') {
    event.preventDefault()
    voice.toggleMicMute()
    return
  }
  if (event.code === 'KeyM') {
    event.preventDefault()
    toggleMap()
    return
  }
  // Push to talk. Held, so `repeat` is not a second press, and a no-op unless
  // the player turned voice on — the mic is never opened from a keystroke.
  if (event.code === PUSH_TO_TALK) {
    event.preventDefault()
    if (!event.repeat) voice.setTalking(true)
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
    held.sprint = true
    props.game.setInput(held)
    return
  }
  if (event.code === 'KeyE') {
    event.preventDefault()
    if (!event.repeat) triggerDash()
    return
  }
  // Hotbar. Digits arm a slot, 0 swaps demolish in and back out, Tab turns the
  // page (Shift+Tab back), and the modifiers belong to whichever tool is armed:
  // Q cycles the paint surface, R turns the ghost a quarter turn, and the
  // brackets widen or narrow the terraform brush.
  if (event.code === 'Digit0') {
    event.preventDefault()
    build.toggleDemolish()
    return
  }
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
    build.turnPage(event.shiftKey ? -1 : 1)
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
  if (event.code === 'KeyV') {
    event.preventDefault()
    build.flipShoulder()
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
  // Before every guard below: whatever else has happened since the press — the
  // map opening, the chat taking focus — letting go of the key must shut the mic.
  if (event.code === PUSH_TO_TALK) {
    voice.setTalking(false)
    if (props.editor || map.open.value) return
    event.preventDefault()
    return
  }
  if (props.editor || map.open.value) return
  if (event.code === 'AltLeft' || event.code === 'AltRight') {
    if (altHeld.value) {
      altHeld.value = false
      view.cursorActive = false
      build.release()
      if (relockOnAltUp) requestLock()
      relockOnAltUp = false
    }
    return
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    held.sprint = false
    props.game.setInput(held)
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
  if (props.editor || map.open.value || event.button !== 0) return
  audio.unlock()
  // Cursor mode: the HUD is live under the pointer, so only a click that lands
  // on the world canvas is a tool click.
  if (altHeld.value) {
    if (onWorldCanvas(event)) build.fire()
    return
  }
  // Only a click while already looking around fires the armed tool. The click
  // that captures the mouse is a lock request, not an edit.
  // Where pointer lock is unavailable or was refused (embeds, headless
  // browsers), cursor steering takes over and every click is an edit.
  if (canEdit()) {
    build.fire()
    // Keep asking while we act. Once the lock is written off, nothing else
    // would ever request it again, and a browser that refused only temporarily
    // (Chrome bars a re-lock for ~1.25s after an Escape-exit) would be stuck
    // steering by raw deltas for the rest of the session.
    if (!pointerLocked.value) attemptLock()
    return
  }
  attemptLock()
}

/**
 * Ask for the pointer lock, and notice when nothing answers.
 *
 * A refused request throws or rejects, and that path has always been covered.
 * A request that is simply *ignored* — headless Chromium, an embed without the
 * permission — resolves nothing at all, and every click after it is spent
 * asking again while the hotbar never fires. So an unanswered request counts
 * against us, and two of them is a refusal. Two rather than one because
 * Chrome refuses a re-lock for ~1.25s after an Escape-exit, and that one is
 * temporary. A lock that is finally granted clears the verdict.
 */
function attemptLock() {
  lockAttempts++
  const canvas = root.value?.querySelector('canvas')
  try {
    // `unadjustedMovement` asks for raw device deltas, skipping the OS pointer
    // acceleration curve that makes a slow drag and a fast flick turn by
    // different amounts per inch. Browsers that don't know the option ignore
    // it; Chrome rejects the promise when it can't honour it, and that is a
    // plain lock request's job to retry, not a refusal.
    const request = canvas?.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined
    request?.catch?.(() => {
      if (pointerLocked.value) return
      try {
        const plain = canvas?.requestPointerLock() as Promise<void> | undefined
        plain?.catch?.(() => {
          lockDenied.value = true
        })
      }
      catch {
        lockDenied.value = true
      }
    })
  }
  catch {
    // Pointer lock not available here; cursor steering still works.
    lockDenied.value = true
  }
  window.setTimeout(() => {
    if (!pointerLocked.value && lockAttempts >= 2) lockDenied.value = true
  }, LOCK_GRACE)
}

/** Whether this pointer event landed on the world canvas rather than on a HUD
 *  panel floating over it. Only the world's own canvas is inside `root`. */
function onWorldCanvas(event: MouseEvent): boolean {
  return event.target instanceof HTMLCanvasElement && !!root.value?.contains(event.target)
}

/** Whether a left button press is an edit rather than the click that captures
 *  the mouse. */
function canEdit(): boolean {
  return steering.value
}

/** The wheel walks the hotbar, as it does in every game that has one. */
function onWheel(event: WheelEvent) {
  if (props.editor || map.open.value || isTyping()) return
  event.preventDefault()
  build.cycleSlot(event.deltaY > 0 ? 1 : -1)
}

/**
 * Right-click dashes; the context menu is suppressed below so it can.
 *
 * The left button starts a drag: the scene repeats the armed tool as the target
 * moves under it, at the server's own edit rate. The click handler above still
 * fires the first edit, so a click too quick to span a frame is not swallowed —
 * the scene drops the duplicate by target.
 */
function onMouseDown(event: MouseEvent) {
  if (props.editor || map.open.value || isTyping()) return
  if (event.button === 2) {
    event.preventDefault()
    triggerDash()
    return
  }
  if (event.button !== 0) return
  if (altHeld.value) {
    if (onWorldCanvas(event)) build.press()
    return
  }
  if (canEdit()) build.press()
}

function onMouseUp() {
  build.release()
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault()
}

function onPointerLockError() {
  lockDenied.value = true
}

function onPointerLockChange() {
  const locked = document.pointerLockElement != null
  const wasLocked = pointerLocked.value
  pointerLocked.value = locked
  if (locked) {
    lockDenied.value = false
    lockAttempts = 0
    edgePanX = edgePanY = 0
  }
  // Losing the mouse loses the drag with it.
  if (wasLocked && !locked) build.release()
  // The grant landed, so the only drop still owed to that request is the bounce
  // riding its keypress. Re-stamp short rather than leaving the full window up,
  // or an Escape pressed right after resuming would be swallowed.
  if (locked && unlockGrace) holdUnlock(BOUNCE_GRACE)
  // Opening the map releases the lock on purpose, and a lock we asked for can
  // bounce — neither is the player reaching for the menu.
  if (map.open.value || Date.now() - unlockGraceAt < unlockGrace) return
  if (wasLocked && !locked && !altHeld.value && document.hasFocus()) emit('unlock')
}

/** Exposed so the page can chain a lock attempt onto fullscreen toggles. This
 *  is a lock request, not a click — it must not fire the armed tool. */
function requestLock() {
  // `document` rather than the mirror: this is chained onto a fullscreen exit,
  // and `pointerlockchange` is not guaranteed to have landed yet. Reading the
  // stale `true` would skip the relock and leave a free cursor.
  if (props.editor || map.open.value || altHeld.value || document.pointerLockElement) return
  // A lock we asked for ourselves can be undone by the same keypress that asked
  // for it; don't read that drop as a menu request.
  holdUnlock()
  attemptLock()
}

function onMouseMove(event: MouseEvent) {
  if (props.editor || map.open.value) return
  // Alt frees the cursor for the HUD — don't steer while it's held. The build
  // ray follows the pointer instead, so track it in normalized coordinates.
  if (altHeld.value) {
    const canvas = root.value?.querySelector('canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    view.cursorX = ((event.clientX - rect.left) / rect.width) * 2 - 1
    view.cursorY = -((event.clientY - rect.top) / rect.height) * 2 + 1
    view.cursorActive = Math.abs(view.cursorX) <= 1 && Math.abs(view.cursorY) <= 1
    return
  }
  // A cursor the player can still see and click with is theirs, not the
  // camera's: in a normal tab nothing steers until the click that locks it.
  if (!steering.value) return
  // Same raw-delta look in both modes; without pointer lock, only while the
  // pointer is over the world so the HUD stays usable, and the edge band keeps
  // the turn alive once the cursor runs out of window.
  if (!pointerLocked.value) {
    const canvas = root.value?.querySelector('canvas')
    const overWorld = event.target instanceof Node && root.value?.contains(event.target)
    if (!overWorld || !canvas) {
      edgePanX = edgePanY = 0
      return
    }
    const rect = canvas.getBoundingClientRect()
    edgePanX = edgeRamp(event.clientX - rect.left, rect.width)
    edgePanY = edgeRamp(event.clientY - rect.top, rect.height)
  }
  view.yaw += event.movementX * MOUSE_SENSITIVITY
  view.pitch = clampPitch(view.pitch + event.movementY * 0.0022)
  props.game.setLook(view.yaw)
}

/**
 * Turn on while the cursor rests in the edge band (fallback steering only).
 *
 * Driven off its own frame clock rather than the mouse, because the whole point
 * is the frames where the mouse reports nothing at all.
 */
function onEdgePanFrame(now: number) {
  edgePanRaf = requestAnimationFrame(onEdgePanFrame)
  const dt = edgePanAt ? Math.min(0.05, (now - edgePanAt) / 1000) : 0
  edgePanAt = now
  if (!dt || pointerLocked.value || !steering.value) return
  if (props.editor || map.open.value || altHeld.value) return
  if (!edgePanX && !edgePanY) return
  view.yaw += edgePanX * EDGE_PAN_RATE * dt
  view.pitch = clampPitch(view.pitch + edgePanY * EDGE_PAN_RATE * 0.45 * dt)
  props.game.setLook(view.yaw)
}

/** The cursor left the window altogether (browser chrome, another screen).
 *  Pressing into the edge is a turn; stepping off it is not. */
function onMouseOut(event: MouseEvent) {
  if (!event.relatedTarget) edgePanX = edgePanY = 0
}

/** Stop moving when the chat input steals focus or the tab is hidden. */
function onFocusIn() {
  // Typing swallows the keyup that would have released push to talk, so the mic
  // shuts here rather than staying open into whatever gets typed.
  if (isTyping()) {
    releaseAll()
    voice.setTalking(false)
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    build.release()
    releaseAll()
    // A hidden tab must not keep transmitting: the keyup for a held key never
    // arrives once focus is gone.
    voice.setTalking(false)
    // A world nobody is looking at does not need to be heard either.
    audio.suspend()
  }
  else {
    audio.resume()
  }
}

/**
 * Alt+Tab and friends can swallow the Alt keyup — reset here so mouse-look
 * isn't left frozen, and stop any held movement.
 */
function onWindowBlur() {
  edgePanX = edgePanY = 0
  altHeld.value = false
  relockOnAltUp = false
  view.cursorActive = false
  build.release()
  releaseAll()
  // Same reason as a hidden tab: Alt-Tab swallows the keyup.
  voice.setTalking(false)
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('pointerlockerror', onPointerLockError)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseout', onMouseOut)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('focusin', onFocusIn)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
  edgePanRaf = requestAnimationFrame(onEdgePanFrame)
})

onBeforeUnmount(() => {
  // The map is shared state; leaving the arena must not leave it up.
  map.open.value = false
  build.release()
  voice.setTalking(false)
  disposeScene?.()
  disposeScene = undefined
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('pointerlockerror', onPointerLockError)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseout', onMouseOut)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('focusin', onFocusIn)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  cancelAnimationFrame(edgePanRaf)
})

defineExpose({ pointerLocked, requestLock, holdUnlock, toggleMap })
</script>

<template>
  <div
    ref="root"
    class="relative size-full select-none"
    :class="!steering || editor || altHeld || map.open.value ? 'cursor-default' : 'cursor-none'"
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

      `shadows` is the graphics setting and not a constant: turning it off
      leaves the cascades' `castShadow` alone, so CSM's patched light loop still
      lights the town from a sun it can no longer sample. Tres recompiles the
      materials when it flips, which is what that switch costs.
    -->
    <TresCanvas
      clear-color="#05070d"
      :dpr="graphics.profile.value.pixelRatio"
      :shadows="graphics.profile.value.shadows"
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
