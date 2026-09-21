import { Box3, BoxHelper, Group, Plane, Raycaster, Vector2, Vector3 } from 'three'
import type { Object3D, PerspectiveCamera, Scene } from 'three'
import { watch } from 'vue'
import type { Ref, WatchStopHandle } from 'vue'
import type { EditorPlacement, EditorSelection, OraclePose } from '~/composables/useEditor'
import { PALETTE_HEX } from '~/utils/palette'

/**
 * The slice of `useEditor()` the controller reads/writes. Kept structural so
 * this three.js module doesn't depend on the composable's auto-import.
 */
interface EditorState {
  placements: Ref<EditorPlacement[]>
  selected: Ref<number | null>
  selection: Ref<EditorSelection>
  /** The Oracle's pose (reactive; the scene reads it every frame, so drags and
   *  rotations show live without any clone of our own). */
  oracle: Ref<OraclePose>
  paletteKind: Ref<string | null>
  dirty: Ref<boolean>
  /** Snapshot the doc as an undo step (also marks dirty). */
  commit: () => void
  undo: () => void
  redo: () => void
}

interface HubEditorOptions {
  scene: Scene
  getCamera: () => PerspectiveCamera | undefined
  canvas: HTMLCanvasElement
  getTemplate: (kind: string) => Group | undefined
  /** The Oracle rig's root in the scene, once its model has loaded. Picked by
   *  bounding box like a placement; the scene owns and positions it. */
  getOracle: () => Object3D | undefined
  editor: EditorState
  /** The arena's grid extent (tiles) — bounds placement + seeds the camera. */
  getSize: () => number
}

export interface HubEditor {
  /** Per-frame: integrate the fly camera and keep the selection box current. */
  update: (dt: number) => void
  /** Re-clone every placement (call once templates finish loading). */
  rebuild: () => void
  /** Put the fly camera at an exact pose (tiles, radians). The run-mmo driver
   *  frames the landing still with this rather than flying there by key. */
  seat: (x: number, y: number, z: number, yaw: number, pitch: number) => void
  /** Tear down: detach listeners, drop scene objects, stop watchers. */
  dispose: () => void
}

const FLY_SPEED = 8
const FLY_BOOST = 4
const LOOK_SENSITIVITY = 0.0025
const PITCH_LIMIT = 1.45
/** Editor fly-camera seed: a 3/4 overhead view aimed at the arena centre.
 *  `CAM_PITCH` is a fixed downward tilt; `CAM_H` sets the height as a fraction
 *  of the arena size (so the whole extent frames); `CAM_BACK` is the
 *  Z-offset-per-height that puts the look ray exactly on the centre — i.e.
 *  −cot(pitch). */
const CAM_PITCH = -0.9
const CAM_H = 0.62
const CAM_BACK = -Math.cos(CAM_PITCH) / Math.sin(CAM_PITCH)
const ROTATE_STEP = Math.PI / 12
const SCALE_STEP = 1.1
const SCALE_MIN = 0.2
const SCALE_MAX = 3
/** Arrow-key nudge distance (tiles); Shift for a coarser step. */
const NUDGE = 0.25
const NUDGE_COARSE = 1
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
/** Pointer travel (px²) before a select-click becomes a drag. */
const DRAG_THRESHOLD_SQ = 16
const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'])

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Whether the keyboard focus is in a text field (don't hijack those keys). */
function isTyping(): boolean {
  const el = document.activeElement
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
}

/**
 * Drives the dev prop editor inside the live hub scene: a free-fly camera,
 * click-to-place / select / drag on the ground, and keyboard nudges — all
 * operating on `editor.placements` (the working copy of the arena's JSON). The
 * clones live in a dedicated group on the scene root so the rendered arena (a
 * separate InstancedMesh pass) is present but unselectable, and so a scene
 * `floorGroup.clear()` never wipes them.
 */
export function createHubEditor(opts: HubEditorOptions): HubEditor {
  const { scene, getCamera, canvas, getTemplate, getOracle, editor, getSize } = opts

  const editorGroup = new Group()
  editorGroup.name = 'hubEditor'
  scene.add(editorGroup)

  const box = new BoxHelper(editorGroup, PALETTE_HEX.slime)
  box.visible = false
  scene.add(box)

  // One clone per placement, index-aligned with editor.placements (null when a
  // template hasn't loaded yet — keeps indices stable).
  let clones: (Object3D | null)[] = []

  const raycaster = new Raycaster()
  const ndc = new Vector2()
  const groundPlane = new Plane(new Vector3(0, 1, 0), 0)
  // A horizontal plane repositioned to the dragged prop's current height, so
  // elevated pieces (roofs, upper walls) slide at their level instead of dropping.
  const dragPlane = new Plane(new Vector3(0, 1, 0), 0)
  const hit = new Vector3()
  // Scratch objects for bounding-box picking (see pick).
  const pickBox = new Box3()
  const pickPoint = new Vector3()

  // Fly-camera pose (owned here — does not touch the shared gameplay `view`),
  // seeded as a 3/4 overhead view aimed at the current floor's centre.
  const camPos = new Vector3()
  let yaw = 0
  let pitch = CAM_PITCH
  seatCamera()
  const held = new Set<string>()
  let boost = false

  let looking = false
  // Drag is armed on mousedown-over-a-target but only *activates* once the pointer
  // moves past a threshold, so a plain click selects without moving anything. On
  // activation we record a grab offset (target pos − ground hit) so it tracks the
  // cursor by delta instead of teleporting its origin onto the ray. The target is
  // a placement clone or the Oracle rig, whichever the click landed on.
  type DragTarget
    = { kind: 'placement', index: number }
      | { kind: 'oracle' }
  let dragTarget: DragTarget | null = null
  let dragging = false
  let dragStartX = 0
  let dragStartY = 0
  let grabX = 0
  let grabY = 0

  function armDrag(target: DragTarget, e: MouseEvent) {
    dragTarget = target
    dragging = false
    dragStartX = e.clientX
    dragStartY = e.clientY
  }

  function applyTransform(obj: Object3D, p: EditorPlacement) {
    obj.position.set(p.x, p.z ?? 0, p.y)
    obj.rotation.set(0, p.rot, 0)
    if (p.s3) obj.scale.set(p.s3[0], p.s3[1], p.s3[2])
    else obj.scale.setScalar(p.scale)
  }

  /** The scene object behind the current selection (a clone, or the Oracle rig). */
  function selectedObject(): Object3D | null {
    const sel = editor.selection.value
    if (sel?.type === 'placement') return clones[sel.index] ?? null
    if (sel?.type === 'oracle') return getOracle() ?? null
    return null
  }

  function refreshHighlight() {
    const obj = selectedObject()
    if (obj) {
      box.setFromObject(obj)
      box.visible = true
    }
    else {
      box.visible = false
    }
  }

  /** The transform the rotate/nudge keys act on: a placement or the Oracle.
   *  Both carry `x`/`y`/`rot`; only placements also scale, elevate and delete. */
  function selectedXform(): { x: number, y: number, rot: number } | null {
    const sel = editor.selection.value
    if (sel?.type === 'placement') return editor.placements.value[sel.index] ?? null
    if (sel?.type === 'oracle') return editor.oracle.value
    return null
  }

  function rebuild() {
    editorGroup.clear()
    clones = []
    const list = editor.placements.value
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!
      const template = getTemplate(p.kind)
      if (!template) {
        clones.push(null)
        continue
      }
      const obj = template.clone(true)
      obj.userData.index = i
      obj.userData.kind = p.kind
      applyTransform(obj, p)
      editorGroup.add(obj)
      clones.push(obj)
    }
    refreshHighlight()
  }

  /** Sync clones to placements: transform-only when the structure matches, else
   *  a full rebuild (add/remove/kind change). */
  function reconcile() {
    const list = editor.placements.value
    if (list.length !== clones.length) return rebuild()
    for (let i = 0; i < list.length; i++) {
      if (clones[i] && clones[i]!.userData.kind !== list[i]!.kind) return rebuild()
    }
    for (let i = 0; i < list.length; i++) {
      if (clones[i]) applyTransform(clones[i]!, list[i]!)
    }
    refreshHighlight()
  }

  // --- Picking helpers ---

  function setRay(e: MouseEvent): boolean {
    const camera = getCamera()
    if (!camera) return false
    const rect = canvas.getBoundingClientRect()
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(ndc, camera)
    return true
  }

  /** Ground hit clamped to the playable interior, or null if the ray misses. */
  function groundHit(): { x: number, y: number } | null {
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null
    const lo = 0.5
    const hi = getSize() - 0.5
    return { x: clamp(hit.x, lo, hi), y: clamp(hit.z, lo, hi) }
  }

  /**
   * What's under the cursor, or null: a placement clone or the Oracle rig. Picks
   * by each object's world bounding box (nearest box the ray enters) rather than
   * triangle intersection: many kit props (trees, wagons, columns, thin decor)
   * have sparse geometry a precise ray slips between, so only dense solids like
   * barrels were selectable. A box covers the whole silhouette, so every prop is
   * clickable.
   */
  function pick(): DragTarget | null {
    let best: DragTarget | null = null
    let bestDist = Infinity
    const test = (obj: Object3D, target: DragTarget) => {
      pickBox.setFromObject(obj)
      if (pickBox.isEmpty() || !raycaster.ray.intersectBox(pickBox, pickPoint)) return
      const d = raycaster.ray.origin.distanceToSquared(pickPoint)
      if (d < bestDist) {
        bestDist = d
        best = target
      }
    }
    for (let i = 0; i < clones.length; i++) {
      const obj = clones[i]
      if (obj) test(obj, { kind: 'placement', index: i })
    }
    const oracle = getOracle()
    if (oracle) test(oracle, { kind: 'oracle' })
    return best
  }

  // --- Mouse ---

  const round3 = (n: number) => Math.round(n * 1000) / 1000

  function onMouseDown(e: MouseEvent) {
    if (e.button === 2) {
      looking = true
      return
    }
    if (e.button !== 0 || !setRay(e)) return

    // Stamp an armed palette kind, else pick whatever the click landed on.
    const kind = editor.paletteKind.value
    if (kind) {
      const g = groundHit()
      if (!g) return
      editor.placements.value.push({ kind, x: g.x, y: g.y, rot: 0, scale: 1 })
      editor.selection.value = { type: 'placement', index: editor.placements.value.length - 1 }
      editor.commit()
      return
    }
    const target = pick()
    editor.selection.value = target?.kind === 'placement'
      ? { type: 'placement', index: target.index }
      : target?.kind === 'oracle' ? { type: 'oracle' } : null
    if (target) armDrag(target, e)
  }

  function onMouseMove(e: MouseEvent) {
    if (looking) {
      yaw -= e.movementX * LOOK_SENSITIVITY
      pitch = clamp(pitch - e.movementY * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT)
      return
    }
    if (!dragTarget || !setRay(e)) return
    const lo = 0.5
    const hi = getSize() - 0.5

    if (dragTarget.kind === 'placement') {
      const p = editor.placements.value[dragTarget.index]
      const obj = clones[dragTarget.index]
      if (!p || !obj) return
      // Drag at the piece's current height so roofs/upper walls keep elevation.
      const elev = p.z ?? 0
      dragPlane.constant = -elev
      if (!raycaster.ray.intersectPlane(dragPlane, hit)) return
      if (!dragging) {
        const dx = e.clientX - dragStartX
        const dy = e.clientY - dragStartY
        if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return
        dragging = true
        grabX = p.x - hit.x
        grabY = p.y - hit.z
      }
      obj.position.set(clamp(hit.x + grabX, lo, hi), elev, clamp(hit.z + grabY, lo, hi))
      box.update()
      return
    }

    // Oracle: drag on the ground plane, writing the pose live (the scene moves
    // the rig off it every frame; the undo step lands on mouseup).
    dragPlane.constant = 0
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return
    const cur = editor.oracle.value
    if (!dragging) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return
      dragging = true
      grabX = cur.x - hit.x
      grabY = cur.y - hit.z
    }
    cur.x = clamp(hit.x + grabX, lo, hi)
    cur.y = clamp(hit.z + grabY, lo, hi)
  }

  function onMouseUp(e: MouseEvent) {
    if (e.button === 2) {
      looking = false
      return
    }
    const target = dragTarget
    const wasDragging = dragging
    dragTarget = null
    dragging = false
    if (!wasDragging || !target) return
    if (target.kind === 'placement') {
      const p = editor.placements.value[target.index]
      const obj = clones[target.index]
      if (p && obj) {
        p.x = round3(obj.position.x)
        p.y = round3(obj.position.z)
        editor.commit()
      }
      return
    }
    const cur = editor.oracle.value
    cur.x = round3(cur.x)
    cur.y = round3(cur.y)
    editor.commit()
  }

  function onWheel(e: WheelEvent) {
    const xf = selectedXform()
    if (!xf) return
    e.preventDefault()
    const i = editor.selected.value
    const p = i != null ? editor.placements.value[i] : null
    if (e.shiftKey) {
      // Scale is a placement-only affordance; the Oracle keeps its fixed height.
      if (!p) return
      p.scale = clamp(e.deltaY < 0 ? p.scale * SCALE_STEP : p.scale / SCALE_STEP, SCALE_MIN, SCALE_MAX)
    }
    else {
      xf.rot += (e.deltaY < 0 ? 1 : -1) * ROTATE_STEP * 0.5
    }
    editor.commit()
  }

  // --- Keyboard ---

  function onKeyDown(e: KeyboardEvent) {
    if (isTyping()) return
    // Undo / redo (Cmd/Ctrl+Z, Shift for redo; Ctrl+Y also redoes).
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) editor.redo()
      else editor.undo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') {
      e.preventDefault()
      editor.redo()
      return
    }
    if (MOVE_CODES.has(e.code)) {
      held.add(e.code)
      boost = e.shiftKey
      if (e.code === 'Space') e.preventDefault()
      return
    }

    // `xf` is anything with a pose (placement or Oracle); `p` only a placement.
    const xf = selectedXform()
    const i = editor.selected.value
    const p = i != null ? editor.placements.value[i] : null

    if (e.code === 'Escape') {
      if (editor.selection.value != null) editor.selection.value = null
      else editor.paletteKind.value = null
    }
    else if (e.code === 'Delete' || e.code === 'Backspace') {
      // Delete the selected placement (the Oracle can't be removed).
      const sel = editor.selection.value
      if (sel?.type === 'placement') {
        editor.placements.value.splice(sel.index, 1)
        editor.selection.value = null
        editor.commit()
      }
    }
    else if (e.code === 'KeyR' && xf) {
      xf.rot += e.shiftKey ? -ROTATE_STEP : ROTATE_STEP
      editor.commit()
    }
    else if (e.code === 'BracketLeft' && p) {
      p.scale = clamp(p.scale / SCALE_STEP, SCALE_MIN, SCALE_MAX)
      editor.commit()
    }
    else if (e.code === 'BracketRight' && p) {
      p.scale = clamp(p.scale * SCALE_STEP, SCALE_MIN, SCALE_MAX)
      editor.commit()
    }
    else if (e.code === 'KeyD' && (e.metaKey || e.ctrlKey) && p) {
      e.preventDefault()
      editor.placements.value.push({ ...p, x: p.x + 1 })
      editor.selected.value = editor.placements.value.length - 1
      editor.commit()
    }
    else if (p && (e.code === 'PageUp' || e.code === 'PageDown')) {
      // Raise / lower the piece's elevation. Shift for a coarser step.
      e.preventDefault()
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE
      p.z = Math.max(0, (p.z ?? 0) + (e.code === 'PageUp' ? step : -step))
      editor.commit()
    }
    else if (xf && ARROWS.has(e.code)) {
      // Nudge the selection on the ground plane, camera-relative (matches
      // WASD fly — Up = away from the view). Shift for a coarser step.
      e.preventDefault()
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE
      const fwd = e.code === 'ArrowUp' ? 1 : e.code === 'ArrowDown' ? -1 : 0
      const side = e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : 0
      const dx = -Math.sin(yaw) * fwd + Math.cos(yaw) * side
      const dz = -Math.cos(yaw) * fwd - Math.sin(yaw) * side
      const lo = 0.5
      const hi = getSize() - 0.5
      xf.x = clamp(xf.x + dx * step, lo, hi)
      xf.y = clamp(xf.y + dz * step, lo, hi)
      editor.commit()
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    held.delete(e.code)
    boost = e.shiftKey
  }

  /** A lost window focus would otherwise leave keys "stuck" down. */
  function onBlur() {
    held.clear()
    looking = false
    dragging = false
    dragTarget = null
  }

  function onContextMenu(e: Event) {
    e.preventDefault()
  }

  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  const stops: WatchStopHandle[] = [
    watch(editor.placements, reconcile, { deep: true }),
    watch(editor.selection, refreshHighlight),
  ]

  function update(dt: number) {
    const camera = getCamera()
    if (!camera) return

    // Yaw-relative horizontal move + world-vertical on Space/E / Q.
    const speed = FLY_SPEED * (boost ? FLY_BOOST : 1) * dt
    const fwd = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0)
    const strafe = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0)
    const rise = (held.has('Space') || held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0)
    if (fwd || strafe) {
      const fx = -Math.sin(yaw)
      const fz = -Math.cos(yaw)
      camPos.x += (fx * fwd + Math.cos(yaw) * strafe) * speed
      camPos.z += (fz * fwd - Math.sin(yaw) * strafe) * speed
    }
    // The ceiling has to clear the tallest ground there is, not the town's:
    // ranges reach 74 units now, and a 60-unit cap left the fly camera stuck
    // inside a mountain with no way to rise over it.
    camPos.y = clamp(camPos.y + rise * speed, 1, 140)

    camera.position.copy(camPos)
    camera.rotation.order = 'YXZ'
    camera.rotation.set(pitch, yaw, 0)

    if (box.visible) box.update()
  }

  /** Seat the fly camera as a 3/4 overhead view aimed at the arena centre,
   *  height scaled to the arena size so the whole extent frames in the 70° FOV. */
  function seatCamera() {
    const s = getSize()
    const h = s * CAM_H
    camPos.set(s / 2, h, s / 2 + h * CAM_BACK)
    yaw = 0
    pitch = CAM_PITCH
  }

  function seat(x: number, y: number, z: number, toYaw: number, toPitch: number) {
    camPos.set(x, y, z)
    yaw = toYaw
    pitch = clamp(toPitch, -PITCH_LIMIT, PITCH_LIMIT)
  }

  function dispose() {
    canvas.removeEventListener('mousedown', onMouseDown)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    for (const stop of stops) stop()
    scene.remove(editorGroup)
    scene.remove(box)
    editorGroup.clear()
  }

  return { update, rebuild, seat, dispose }
}
