<script setup lang="ts">
import { AnimationMixer, Box3, CanvasTexture, PerspectiveCamera, SRGBColorSpace, SkinnedMesh, Vector3 } from 'three'
import type { Group } from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import { outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'
import { disposeCharacterSkeleton, loadCharacterAsset, preloadCharacterAssets } from '~/utils/characterModels'

/**
 * The selected character inside the preview canvas. Rendered as a Tres
 * <primitive>; the drag turntable, animation mixer, and framing camera are all
 * driven from Tres's render loop (useLoop) — the same load → clone → Idle_Loop
 * pipeline as the in-world rigs. The chosen outfit colorway is applied.
 */
const props = defineProps<{ character: string, outfitColor: number, autoSpin?: boolean }>()

const model = shallowRef<Group | null>(null)
let mixer: AnimationMixer | null = null
let token = 0

async function rebuild() {
  const mine = ++token
  // Cache lives in ~/utils/characterModels, shared with the menu's preloader —
  // so a warmed asset makes this resolve synchronously with no fetch/parse.
  const character = props.character
  const outfitColor = props.outfitColor
  const { scene: template, clips } = await loadCharacterAsset(character)
  if (mine !== token) return // a newer selection superseded this load

  const next = SkeletonUtils.clone(template) as Group
  next.traverse((obj) => {
    if (obj instanceof SkinnedMesh) obj.frustumCulled = false
  })
  applyOutfitColor(next, outfitColorTexture(outfitOf(character), outfitColor))

  // Stand the figure on the origin rather than centring it on it. Characters
  // are not all the same height (1.78–1.84), so centring put every pair of
  // boots at a different depth in frame; standing them on a shared floor means
  // the floor disc sits under the boots whoever is there.
  next.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(next)
  const center = bounds.getCenter(new Vector3())
  next.position.set(-center.x, -bounds.min.y, -center.z)

  if (model.value) {
    mixer?.stopAllAction()
    mixer?.uncacheRoot(model.value)
    disposeCharacterSkeleton(model.value)
  }
  mixer = new AnimationMixer(next)
  const idle = clips.find(c => c.name === 'Idle_Loop')
  if (idle) mixer.clipAction(idle).play()

  model.value = next
}

/**
 * The floor under the boots. It is a disc in the scene rather than a glow in
 * the page, so it takes the camera's perspective: the ellipse wraps both feet
 * whatever depth they stand at, where a flat line could only meet one of them.
 * A dark core reads as the contact shadow, the accent wash and rim as the stage.
 */
const FLOOR_RADIUS = 1.15
function floorTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const half = size / 2
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half)
  glow.addColorStop(0, 'rgb(111 240 218 / 0.5)')
  glow.addColorStop(0.6, 'rgb(111 240 218 / 0.2)')
  glow.addColorStop(1, 'rgb(111 240 218 / 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)
  const shadow = ctx.createRadialGradient(half, half, 0, half, half, half * 0.5)
  shadow.addColorStop(0, 'rgb(0 0 0 / 0.75)')
  shadow.addColorStop(0.55, 'rgb(0 0 0 / 0.45)')
  shadow.addColorStop(1, 'rgb(0 0 0 / 0)')
  ctx.fillStyle = shadow
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgb(111 240 218 / 0.75)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(half, half, half * 0.8, 0, Math.PI * 2)
  ctx.stroke()
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
const floor = floorTexture()

const { camera: cameraManager } = useTresContext()
const { onBeforeRender } = useLoop()

/**
 * Framing, in world units and the same for every character.
 *
 * Deliberately *not* scaled to each figure's own height: backing the camera off
 * in proportion makes a taller character render smaller, which is exactly
 * backwards — the male peasant measures 1.84 against the female's 1.78 and came
 * out ~3% smaller on screen. A fixed frame lets that difference read as height.
 *
 * `CENTRE` is the world height the camera looks at, chosen so the feet (now at
 * y = 0) land 72% down the frame: the bottom of the gate is not free, the
 * summary line and the name field stack there. `DISTANCE` leaves the tallest character about
 * a seventh of the frame in air above the head.
 */
const CENTRE = 0.66
const DISTANCE = 4.9

// Turntable: drag rotates the character. With `autoSpin` it also turns on its
// own until the user grabs it.
let yaw = 0
let dragging = false
let lastX = 0
let grabbed = false
let cameraConfigured = false

function onPointerDown(e: PointerEvent) {
  // Only the character stage (the canvas) drags — not the control panels.
  if (!(e.target instanceof HTMLCanvasElement)) return
  dragging = true
  grabbed = true
  lastX = e.clientX
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  yaw += (e.clientX - lastX) * 0.01
  lastX = e.clientX
}
function onPointerUp() {
  dragging = false
}

onBeforeRender(({ delta }) => {
  // Frame the (origin-centered) figure from slightly above, looking at its mid.
  // Both the eye and the target drop by the same amount, so this is a pan and
  // not a tilt — tilting would foreshorten the character the design wants read
  // straight on.
  const cam = cameraManager.activeCamera.value
  if (cam instanceof PerspectiveCamera) {
    cam.position.set(0, CENTRE + 0.15, DISTANCE)
    if (!cameraConfigured) {
      cam.fov = 34
      cam.updateProjectionMatrix()
      cameraConfigured = true
    }
    cam.lookAt(0, CENTRE, 0)
  }
  if (props.autoSpin && !grabbed) yaw += delta * 0.35
  if (model.value) model.value.rotation.y = yaw
  mixer?.update(delta)
})

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  // Load the current selection first, then warm the rest in the background (a
  // no-op if the menu already warmed the shared cache).
  rebuild().then(preloadCharacterAssets).catch(error => console.error('Character preview could not load', error))
})
onBeforeUnmount(() => {
  token++
  mixer?.stopAllAction()
  floor.dispose()
  if (model.value) {
    mixer?.uncacheRoot(model.value)
    disposeCharacterSkeleton(model.value)
  }
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})
watch(() => [props.character, props.outfitColor], () => {
  rebuild().catch(error => console.error('Character preview could not load', error))
})
</script>

<template>
  <!-- Just under y = 0 so the soles never z-fight it. -->
  <TresMesh
    :rotation-x="-Math.PI / 2"
    :position-y="-0.002"
  >
    <TresCircleGeometry :args="[FLOOR_RADIUS, 64]" />
    <TresMeshBasicMaterial
      :map="floor"
      :transparent="true"
      :depth-write="false"
      :tone-mapped="false"
    />
  </TresMesh>
  <primitive
    v-if="model"
    :object="model"
  />
</template>
