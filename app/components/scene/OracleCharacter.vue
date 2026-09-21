<script setup lang="ts">
import { AnimationMixer, Box3, Euler, Mesh, SkinnedMesh, Texture, Vector3 } from 'three'
import type { BufferGeometry, Group, Material, PointLight } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { UseGame } from '~/composables/useGame'
import { applyCharacterRim } from '~/utils/characterRim'
import { disposeCharacterSkeleton } from '~/utils/characterModels'
import { play } from '~/utils/audio'
import CharacterNameplate from './CharacterNameplate.vue'

const props = defineProps<{
  game: UseGame
  local: { x: number, y: number }
  editor?: boolean
  getPose: () => { x: number, y: number, rot: number }
}>()
const emit = defineEmits<{ ready: [], removed: [] }>()

const HEIGHT = 2.2
const BUBBLE_HEIGHT = HEIGHT + 0.06 + 0.28 + 0.04
const group = shallowRef<Group | null>(null)
const model = shallowRef<Group | null>(null)
const glow = shallowRef<PointLight | null>(null)
const label = shallowRef<InstanceType<typeof CharacterNameplate> | null>(null)
const oracle = useOracle()
const assets = useAssets()
const { camera, renderer } = useTresContext()
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
const initialPose = props.getPose()
const initialPosition = new Vector3(initialPose.x, 0, initialPose.y)
const initialRotation = new Euler(0, initialPose.rot, 0)
const glowPosition = new Vector3(0, HEIGHT * 0.6, 0)
let template: Group | null = null
let mixer: AnimationMixer | null = null
let disposed = false
let loading = false
let retryAt = 0
let groundOffset = 0

// This GLB belongs solely to this component. The cloned skeleton is released
// separately, then each shared template resource is released exactly once.
function releaseTemplate(root: Group) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
    }
  })
  disposeCharacterSkeleton(root)
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  for (const texture of textures) texture.dispose()
}

async function load() {
  if (disposed || loading || model.value || Date.now() < retryAt) return
  loading = true
  try {
    const gltf = await assets.track(loader.loadAsync('/models/monsters/MushroomKing.glb'))
    if (disposed) {
      releaseTemplate(gltf.scene)
      return
    }
    template = gltf.scene
    const next = SkeletonUtils.clone(template) as Group
    next.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(next)
    const scale = HEIGHT / Math.max(0.001, bounds.max.y - bounds.min.y)
    next.scale.setScalar(scale)
    groundOffset = -bounds.min.y * scale
    if (group.value) group.value.position.y = groundOffset
    next.traverse((object) => {
      if (object instanceof SkinnedMesh) object.frustumCulled = false
      if (object instanceof Mesh) object.castShadow = true
    })
    applyCharacterRim(next)
    mixer = new AnimationMixer(next)
    const idle = gltf.animations.find(clip => clip.name === 'Idle') ?? gltf.animations[0]
    if (idle) mixer.clipAction(idle).play()
    model.value = next
    await nextTick()
    // Shadow registration and GTAO's scene cache need the mounted primitive.
    if (!disposed) emit('ready')
  }
  catch (error) {
    retryAt = Date.now() + 10000
    console.error('Oracle model could not load', error)
  }
  finally {
    loading = false
  }
}

// Speech remains DOM so it bypasses bloom/tone mapping. Its projection belongs
// to the character lifecycle; motion writes styles directly without a Vue
// render on every frame.
const bubble = document.createElement('div')
bubble.className = 'chat-bubble'
bubble.dataset.npc = ''
bubble.hidden = true
let bubbleLayer: HTMLDivElement | null = null
let bubbleText = ''
const anchor = new Vector3()

function updateBubble(now: number) {
  const speech = oracle.speech.value
  const activeCamera = camera.activeCamera.value
  const canvas = renderer.instance?.domElement
  if (!speech || speech.until <= now || !group.value || !activeCamera || !canvas?.parentElement) {
    bubble.hidden = true
    bubbleText = ''
    return
  }
  if (!bubbleLayer) {
    bubbleLayer = document.createElement('div')
    bubbleLayer.className = 'chat-bubble-layer'
    bubbleLayer.append(bubble)
    canvas.parentElement.append(bubbleLayer)
  }
  group.value.getWorldPosition(anchor)
  anchor.y += BUBBLE_HEIGHT
  const distance = anchor.distanceTo(activeCamera.position)
  activeCamera.updateMatrixWorld()
  anchor.project(activeCamera)
  if (distance > 56 || Math.abs(anchor.z) > 1) {
    bubble.hidden = true
    return
  }
  if (bubbleText !== speech.text) {
    bubbleText = speech.text
    bubble.textContent = speech.text
    bubble.style.animation = 'none'
    void bubble.offsetWidth
    bubble.style.animation = ''
  }
  const x = (anchor.x + 1) / 2 * canvas.clientWidth
  const y = (1 - anchor.y) / 2 * canvas.clientHeight
  const scale = Math.max(0.6, Math.min(1, 9 / distance))
  bubble.hidden = false
  bubble.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`
  bubble.style.opacity = String(Math.min(1, (speech.until - now) / 300))
}

watch(() => oracle.speech.value?.until, (until) => {
  if (!until || props.editor || disposed) return
  const pose = props.getPose()
  play('oracle', { gain: 0.8, position: { x: pose.x, y: HEIGHT, z: pose.y } })
})

// Run after MazeScene's prediction and camera update, so the look target and
// projected speech use this frame's rendered positions.
const { off: stopAnimation } = useLoop().onBeforeRender(({ delta }) => {
  if (disposed) return
  const now = Date.now()
  if (!model.value && !loading && now >= retryAt) void load()
  const pose = props.getPose()
  const selfId = props.game.selfId.value
  const self = selfId ? props.game.players.get(selfId) : undefined
  oracle.near.value = !!self && Math.hypot(props.local.x - pose.x, props.local.y - pose.y) < 7
  const root = group.value
  if (!root || !model.value) return
  const dt = Math.min(delta, 0.05)
  mixer?.update(dt)
  root.position.set(pose.x, groundOffset, pose.y)
  let yaw = pose.rot
  const speech = oracle.speech.value
  if (speech?.to && speech.until > now && !props.editor) {
    const other = speech.to === selfId ? undefined : props.game.players.get(speech.to)
    const tx = (other ? other.rx : props.local.x) - pose.x
    const ty = (other ? other.ry : props.local.y) - pose.y
    if ((other || speech.to === selfId) && Math.hypot(tx, ty) > 0.5) yaw = Math.atan2(tx, ty)
  }
  const difference = Math.atan2(Math.sin(yaw - root.rotation.y), Math.cos(yaw - root.rotation.y))
  root.rotation.y = props.editor ? yaw : root.rotation.y + difference * Math.min(1, dt * 4)
  updateBubble(now)
}, 10)

function dispose() {
  if (disposed) return
  disposed = true
  stopAnimation()
  oracle.near.value = false
  mixer?.stopAllAction()
  if (model.value) {
    mixer?.uncacheRoot(model.value)
    disposeCharacterSkeleton(model.value)
  }
  label.value?.dispose()
  glow.value?.dispose()
  bubbleLayer?.remove()
  if (template) releaseTemplate(template)
  template = null
  emit('removed')
}
defineExpose({ dispose, getGroup: () => model.value ? group.value ?? undefined : undefined })
onBeforeUnmount(dispose)
</script>

<template>
  <TresGroup
    ref="group"
    name="Oracle"
    :position="initialPosition"
    :rotation="initialRotation"
    :dispose="null"
  >
    <template v-if="model">
      <primitive
        :object="model"
        :dispose="false"
      />
      <CharacterNameplate
        ref="label"
        name="The Oracle"
        color="#bfe6ff"
        :height="HEIGHT"
      />
      <TresPointLight
        ref="glow"
        color="#7fd0ff"
        :intensity="5"
        :distance="7"
        :decay="1.6"
        :position="glowPosition"
      />
    </template>
  </TresGroup>
</template>
