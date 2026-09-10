import {
  Box3,
  BoxHelper,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  RingGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { Object3D, PerspectiveCamera, Scene } from 'three'
import { watch } from 'vue'
import type { Ref, WatchStopHandle } from 'vue'
import type { EditorPlacement, EditorSelection, EditorTool, MarkerKind } from '~/composables/useEditor'
import { PALETTE_HEX } from '~/utils/palette'

/**
 * The slice of `useEditor()` the controller reads/writes. Kept structural so
 * this three.js module doesn't depend on the composable's auto-import.
 */
interface EditorState {
  placements: Ref<EditorPlacement[]>
  selected: Ref<number | null>
  selection: Ref<EditorSelection>
  tool: Ref<EditorTool>
  paletteKind: Ref<string | null>
  dirty: Ref<boolean>
  /** The draggable markers (reactive; mutated in the 'marker' tool). */
  getMarkers: () => Partial<Record<MarkerKind, { x: number, y: number }>>
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
  editor: EditorState
  /** The arena's grid extent (tiles) — bounds placement + seeds the camera. */
  getSize: () => number
}

export interface HubEditor {
  /** Per-frame: integrate the fly camera and keep the selection box current. */
  update: (dt: number) => void
  /** Re-clone every placement (call once templates finish loading). */
  rebuild: () => void
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
  const { scene, getCamera, canvas, getTemplate, editor, getSize } = opts

  const editorGroup = new Group()
  editorGroup.name = 'hubEditor'
  scene.add(editorGroup)

  const box = new BoxHelper(editorGroup, PALETTE_HEX.slime)
  box.visible = false
  scene.add(box)

  // Flat ring gizmos for the point markers — the non-prop editable bits. Kept in
  // their own group so a placement rebuild or a scene `floorGroup.clear()` never
  // wipes them.
  const gizmoGroup = new Group()
  gizmoGroup.name = 'editorGizmos'
  scene.add(gizmoGroup)

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
  // Scratch objects for bounding-box picking (see pickIndex).
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
  // a placement or a point marker, depending on the active tool.
  type DragTarget
    = { kind: 'placement', index: number }
      | { kind: 'marker', which: MarkerKind }
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

  function refreshHighlight() {
    const i = editor.selected.value
    const obj = i != null ? clones[i] : null
    if (obj) {
      box.setFromObject(obj)
      box.visible = true
    }
    else {
      box.visible = false
    }
  }

  const flat = (mesh: Mesh) => {
    mesh.rotation.x = -Math.PI / 2
    return mesh
  }

  /** Redraw the point-marker rings. Cheap (a handful of meshes), so just rebuilt
   *  whenever a marker moves or the selection changes. */
  function renderGizmos() {
    gizmoGroup.clear()
    const sel = editor.selection.value
    const hex: Record<MarkerKind, string> = { oracle: '#7fd0ff' }
    for (const [which, pos] of Object.entries(editor.getMarkers()) as [MarkerKind, { x: number, y: number }][]) {
      const on = sel?.type === 'marker' && sel.which === which
      const ring = flat(new Mesh(
        new RingGeometry(0.4, 0.62, 28),
        new MeshBasicMaterial({ color: new Color(hex[which]), transparent: true, opacity: on ? 1 : 0.7, side: DoubleSide }),
      ))
      ring.position.set(pos.x, 0.07, pos.y)
      gizmoGroup.add(ring)
    }
  }

  /** The marker within `r` tiles of a ground point, or null (nearest wins). */
  function nearestMarker(g: { x: number, y: number }, r = 1.2): MarkerKind | null {
    let best: MarkerKind | null = null
    let bestD = r * r
    for (const [which, pos] of Object.entries(editor.getMarkers()) as [MarkerKind, { x: number, y: number }][]) {
      const d = (pos.x - g.x) ** 2 + (pos.y - g.y) ** 2
      if (d < bestD) {
        bestD = d
        best = which
      }
    }
    return best
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
    renderGizmos()
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
   * The placement index under the cursor, or null. Picks by each clone's world
   * bounding box (nearest box the ray enters) rather than triangle intersection:
   * many kit props (trees, wagons, columns, thin decor) have sparse geometry a
   * precise ray slips between, so only dense solids like barrels were selectable.
   * A box covers the whole silhouette, so every prop is clickable.
   */
  function pickIndex(): number | null {
    let best: number | null = null
    let bestDist = Infinity
    for (let i = 0; i < clones.length; i++) {
      const obj = clones[i]
      if (!obj) continue
      pickBox.setFromObject(obj)
      if (pickBox.isEmpty()) continue
      if (raycaster.ray.intersectBox(pickBox, pickPoint)) {
        const d = raycaster.ray.origin.distanceToSquared(pickPoint)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
    }
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
    const tool = editor.tool.value
    const g = groundHit()

    // Marker tool: grab the nearest marker ring.
    if (tool === 'marker') {
      if (!g) return
      const which = nearestMarker(g)
      editor.selection.value = which ? { type: 'marker', which } : null
      if (which) armDrag({ kind: 'marker', which }, e)
      return
    }

    // Select tool: stamp an armed palette kind, else pick a placement.
    const kind = editor.paletteKind.value
    if (kind) {
      if (!g) return
      editor.placements.value.push({ kind, x: g.x, y: g.y, rot: 0, scale: 1 })
      editor.selection.value = { type: 'placement', index: editor.placements.value.length - 1 }
      editor.commit()
      return
    }
    const pi = pickIndex()
    editor.selection.value = pi != null ? { type: 'placement', index: pi } : null
    if (pi != null) armDrag({ kind: 'placement', index: pi }, e)
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

    // Marker: drag on the ground plane, updating the data live.
    dragPlane.constant = 0
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return
    const cur = editor.getMarkers()[dragTarget.which]
    if (!cur) return
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
    renderGizmos()
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
    const cur = editor.getMarkers()[target.which]
    if (cur) {
      cur.x = round3(cur.x)
      cur.y = round3(cur.y)
      editor.commit()
    }
  }

  function onWheel(e: WheelEvent) {
    const i = editor.selected.value
    if (i == null) return
    e.preventDefault()
    const p = editor.placements.value[i]!
    if (e.shiftKey) {
      p.scale = clamp(e.deltaY < 0 ? p.scale * SCALE_STEP : p.scale / SCALE_STEP, SCALE_MIN, SCALE_MAX)
    }
    else {
      p.rot += (e.deltaY < 0 ? 1 : -1) * ROTATE_STEP * 0.5
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

    const i = editor.selected.value
    const p = i != null ? editor.placements.value[i] : null

    if (e.code === 'Escape') {
      if (editor.selection.value != null) editor.selection.value = null
      else editor.paletteKind.value = null
    }
    else if (e.code === 'Delete' || e.code === 'Backspace') {
      // Delete the selected placement (markers can't be removed).
      const sel = editor.selection.value
      if (sel?.type === 'placement') {
        editor.placements.value.splice(sel.index, 1)
        editor.selection.value = null
        editor.commit()
      }
    }
    else if (e.code === 'KeyR' && p) {
      p.rot += e.shiftKey ? -ROTATE_STEP : ROTATE_STEP
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
    else if (p && ARROWS.has(e.code)) {
      // Nudge the selected piece on the ground plane, camera-relative (matches
      // WASD fly — Up = away from the view). Shift for a coarser step.
      e.preventDefault()
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE
      const fwd = e.code === 'ArrowUp' ? 1 : e.code === 'ArrowDown' ? -1 : 0
      const side = e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : 0
      const dx = -Math.sin(yaw) * fwd + Math.cos(yaw) * side
      const dz = -Math.cos(yaw) * fwd - Math.sin(yaw) * side
      const lo = 0.5
      const hi = getSize() - 0.5
      p.x = clamp(p.x + dx * step, lo, hi)
      p.y = clamp(p.y + dz * step, lo, hi)
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
    watch(editor.selected, refreshHighlight),
    // Marker rings redraw on a selection change (a drag calls renderGizmos itself).
    watch(editor.selection, renderGizmos),
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
    camPos.y = clamp(camPos.y + rise * speed, 1, 60)

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
    scene.remove(gizmoGroup)
    editorGroup.clear()
    gizmoGroup.clear()
  }

  return { update, rebuild, dispose }
}
