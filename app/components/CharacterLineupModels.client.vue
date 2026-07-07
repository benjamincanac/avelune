<script setup lang="ts">
import { AnimationMixer, Box3, Group, MathUtils, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three'
import type { AnimationClip } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import { outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'

/**
 * A static row of characters for the main menu — the tower's cast, standing
 * side by side and facing forward. Unlike the creation preview there is no
 * turntable and no drag: the figures only breathe (Idle_Loop, desynced) while a
 * fit-to-frame camera keeps the whole lineup centered at any aspect ratio.
 *
 * Each rig follows the same load → clone → Idle_Loop pipeline as the in-world
 * rigs; the chosen outfit colorway is applied per figure.
 */
const props = defineProps<{ characters: { character: string, outfitColor: number }[] }>()

// Shared across rebuilds so re-rendering the same roster never refetches a GLB.
const sceneCache = new Map<string, Group>()
let clips: AnimationClip[] = []
const loader = new GLTFLoader()

const group = shallowRef<Group | null>(null)
let mixers: AnimationMixer[] = []
let token = 0

// Even spacing along X; the fit camera frames whatever total width results.
const SPACING = 1.7

// The row's static bounds, measured once per (re)build. The camera distance is
// derived from these plus the live aspect each frame, so it reframes on resize.
const bounds = { center: new Vector3(), size: new Vector3() }
const box = new Box3()
const tmp = new Vector3()

async function rebuild() {
  const mine = ++token
  if (!clips.length) clips = (await loader.loadAsync('/models/characters/animations.glb')).animations
  // Load one at a time: these GLBs carry EXT_texture_webp textures, and three's
  // WebP support probe is per-parse — a cold batch of concurrent parses can race
  // it. Loading sequentially warms WebP on the first model, so the rest decode
  // reliably (a browser without WebP would fall back regardless).
  for (const { character } of props.characters) {
    if (sceneCache.has(character)) continue
    const scene = (await loader.loadAsync(`/models/characters/${character}.glb`)).scene
    if (mine !== token) return // a newer roster superseded this load
    if (!sceneCache.has(character)) sceneCache.set(character, scene)
  }
  if (mine !== token) return // a newer roster superseded this load

  const next = new Group()
  const n = props.characters.length
  const idle = clips.find(c => c.name === 'Idle_Loop')
  const built: AnimationMixer[] = []

  props.characters.forEach(({ character, outfitColor }, i) => {
    const template = sceneCache.get(character)
    if (!template) return
    const rig = SkeletonUtils.clone(template) as Group
    rig.traverse((obj) => {
      if (obj instanceof SkinnedMesh) obj.frustumCulled = false
    })
    applyOutfitColor(rig, outfitColorTexture(outfitOf(character), outfitColor))

    // Center each rig on its own origin, then slot it into the row.
    rig.updateMatrixWorld(true)
    box.setFromObject(rig).getCenter(tmp)
    rig.position.set(-tmp.x + (i - (n - 1) / 2) * SPACING, -tmp.y, -tmp.z)

    const mixer = new AnimationMixer(rig)
    if (idle) {
      const action = mixer.clipAction(idle)
      action.time = i * 0.6 // desync so the row doesn't breathe in lockstep
      action.play()
    }
    built.push(mixer)
    next.add(rig)
  })

  // Measure the assembled row before it starts animating, so the frame is stable.
  next.updateMatrixWorld(true)
  box.setFromObject(next)
  box.getCenter(bounds.center)
  box.getSize(bounds.size)

  mixers = built
  group.value = next
}

const { camera: cameraManager } = useTresContext()
const { onBeforeRender } = useLoop()

const FOV = 32
onBeforeRender(({ delta }) => {
  const cam = cameraManager.activeCamera.value
  if (cam instanceof PerspectiveCamera && bounds.size.x > 0) {
    const halfV = Math.tan(MathUtils.degToRad(FOV) / 2)
    const fitHeight = (bounds.size.y / 2) / halfV
    const fitWidth = (bounds.size.x / 2) / (halfV * cam.aspect)
    const dist = Math.max(fitHeight, fitWidth) * 1.14
    cam.fov = FOV
    cam.position.set(bounds.center.x, bounds.center.y + 0.12, bounds.center.z + dist)
    cam.lookAt(bounds.center.x, bounds.center.y, bounds.center.z)
    cam.updateProjectionMatrix()
  }
  for (const m of mixers) m.update(delta)
})

onMounted(rebuild)
watch(() => props.characters, rebuild, { deep: true })
</script>

<template>
  <primitive
    v-if="group"
    :object="group"
  />
</template>
