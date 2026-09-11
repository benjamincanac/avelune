<script setup lang="ts">
import { AnimationMixer, Box3, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three'
import type { Group } from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import { outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'
import { disposeCharacterSkeleton, loadCharacterAsset, preloadCharacterAssets } from '~/utils/characterModels'

/**
 * The selected character inside the preview canvas. Rendered as a Tres
 * <primitive>; the turntable spin, animation mixer, and framing camera are all
 * driven from Tres's render loop (useLoop) — the same load → clone → Idle_Loop
 * pipeline as the in-world rigs. The chosen outfit colorway is applied.
 */
const props = defineProps<{ character: string, outfitColor: number }>()

const model = shallowRef<Group | null>(null)
let mixer: AnimationMixer | null = null
let token = 0
let figureHeight = 1.8

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

  // Center on the origin so the fixed camera frames the whole figure.
  next.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(next)
  const center = bounds.getCenter(new Vector3())
  figureHeight = bounds.max.y - bounds.min.y
  next.position.set(-center.x, -center.y, -center.z)

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

const { camera: cameraManager } = useTresContext()
const { onBeforeRender } = useLoop()

// Turntable: auto-spins until the user grabs the character, then drag rotates it.
let yaw = 0
let dragging = false
let lastX = 0
let autoSpin = true
let cameraConfigured = false

function onPointerDown(e: PointerEvent) {
  // Only the character stage (the canvas) drags — not the control panels.
  if (!(e.target instanceof HTMLCanvasElement)) return
  dragging = true
  autoSpin = false
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
  const cam = cameraManager.activeCamera.value
  if (cam instanceof PerspectiveCamera) {
    cam.position.set(0, 0.15, figureHeight * 2.3)
    if (!cameraConfigured) {
      cam.fov = 34
      cam.updateProjectionMatrix()
      cameraConfigured = true
    }
    cam.lookAt(0, 0, 0)
  }
  if (autoSpin && !dragging) yaw += delta * 0.35
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
  <primitive
    v-if="model"
    :object="model"
  />
</template>
