<script setup lang="ts">
import { useLoop, useTresContext } from '@tresjs/core'
import {
  AmbientLight,
  AnimationMixer,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  SkinnedMesh,
} from 'three'
import type { AnimationClip } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { CHARACTERS } from '#shared/utils/characters'
import { prepareDeveloper } from '~/utils/developerLook'

/** Imperative turntable scene for the look lab (dev only). */
const props = defineProps<{ raw: boolean, focus: string }>()

/** Camera presets: where to look and from how far. */
const FOCUS: Record<string, { y: number, dist: number }> = {
  full: { y: 0.95, dist: 4.2 },
  head: { y: 1.62, dist: 1.3 },
  arms: { y: 1.25, dist: 1.8 },
  feet: { y: 0.25, dist: 1.6 },
}

const { scene, camera: cameraManager, renderer } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender } = useLoop()

const root = new Group()
const ambient = new AmbientLight('#8899bb', 0.35)
const hemi = new HemisphereLight('#bcd4ff', '#5a6a3a', 0.5)
const sun = new DirectionalLight('#fff2dd', 2.2)
sun.position.set(3, 5, 4)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
const floor = new Mesh(new PlaneGeometry(6, 6), new MeshStandardMaterial({ color: '#3a3d43', roughness: 1 }))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.value.add(root, ambient, hemi, sun, floor)
// Debug hooks: the rig root, and a forced render to a JPEG data URL (works while the tab is hidden).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).__lab = root
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).__labShot = (width = 640, quality = 0.8, yaw = 0) => {
  const gl = renderer.instance
  const cam = camera.value
  if (!gl || !cam) return null
  // A hidden tab never runs the loop, so set the camera up here and pose the turntable directly.
  configureCamera()
  root.rotation.y = yaw
  gl.render(scene.value, cam)
  const src = gl.domElement
  const out = document.createElement('canvas')
  out.width = width
  out.height = Math.round((width * src.height) / src.width)
  out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', quality)
}

const loader = new GLTFLoader()
const mixers: AnimationMixer[] = []
let clips: AnimationClip[] = []

// Every body side by side, idling; dressed unless the page asked for the raw rigs.
loader.loadAsync('/models/characters/animations.glb').then((gltf) => {
  clips = gltf.animations
  CHARACTERS.forEach((character, i) => {
    loader.loadAsync(`/models/characters/${character.model}.glb`).then((model) => {
      if (!props.raw) prepareDeveloper(model.scene)
      const rig = SkeletonUtils.clone(model.scene)
      rig.traverse((obj) => {
        if (obj instanceof SkinnedMesh) obj.frustumCulled = false
        if (obj instanceof Mesh) obj.castShadow = true
      })
      rig.position.x = (i - (CHARACTERS.length - 1) / 2) * 1.1
      root.add(rig)
      const mixer = new AnimationMixer(rig)
      const idle = clips.find(c => c.name === 'Idle_Loop')
      if (idle) mixer.clipAction(idle).play()
      mixers.push(mixer)
    })
  })
})

let configured = false
function configureCamera() {
  const cam = camera.value
  if (!(cam instanceof PerspectiveCamera) || configured) return
  configured = true
  const focus = FOCUS[props.focus] ?? FOCUS.full!
  cam.fov = 32
  cam.near = 0.05
  cam.far = 50
  cam.position.set(0, focus.y + focus.dist * 0.12, focus.dist)
  cam.lookAt(0, focus.y, 0)
  cam.updateProjectionMatrix()
}

onBeforeRender(({ delta, elapsed }) => {
  configureCamera()
  root.rotation.y = elapsed * 0.35
  const dt = Math.min(delta, 0.1)
  for (const mixer of mixers) mixer.update(dt)
})

onUnmounted(() => {
  scene.value.remove(root, ambient, hemi, sun, floor)
})
</script>

<template>
  <TresGroup />
</template>
