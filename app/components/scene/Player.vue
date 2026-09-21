<script setup lang="ts">
import { AnimationMixer, Box3, Mesh, MeshBasicMaterial, SkinnedMesh, Vector3 } from 'three'
import type { AnimationAction, Group, Object3D } from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useTresContext } from '@tresjs/core'
import type { GamePlayer } from '~/composables/useGame'
import type { World } from '#shared/utils/world'
import { bodySurfaceHeight, getSwimmingContact } from '#shared/utils/maze'
import { characterFor, isCharacter, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyBeard } from '~/utils/appearance'
import { applyCharacterRim } from '~/utils/characterRim'
import { disposeCharacterSkeleton, loadCharacterAsset } from '~/utils/characterModels'
import { animationBlendDuration, locomotionTransitionTime, updateDashAnimation } from '~/utils/characterAnimation'
import { createFootstepState, footSurfaceAt, play, stepFootsteps } from '~/utils/audio'
import type { FootstepState } from '~/utils/audio'
import { BLOB_RADIUS, BLOB_OPACITY } from '~/utils/playerResources'
import type { PlayerResources } from '~/utils/playerResources'
import type { PlayerFrame } from '~/utils/playerFrame'
import CharacterNameplate from './CharacterNameplate.vue'

const props = defineProps<{ player: GamePlayer, world: World, resources: PlayerResources }>()
const emit = defineEmits<{ change: [] }>()
const { camera, renderer } = useTresContext()
const group = shallowRef<Group | null>(null)
const blob = shallowRef<Mesh | null>(null)
const nameplate = shallowRef<InstanceType<typeof CharacterNameplate> | null>(null)
const assets = useAssets()
const CHARACTER_SCALE = 0.72
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop', sprint: 'Sprint_Loop', swim: 'Swim_Loop', tread: 'Swim_Idle' } as const
const blobMaterial = new MeshBasicMaterial({ map: props.resources.blobTexture, color: '#1b1a16', transparent: true, opacity: BLOB_OPACITY, depthWrite: false, toneMapped: false, fog: true })
const blobScale = new Vector3(BLOB_RADIUS * 2, 1, BLOB_RADIUS * 2)
// A contact decal has no surface for GTAO's opaque normal override.
const blobUserData = { gtaoExclude: true }
let disposed = false
let loading = false
let retryAt = 0
let outfitLease: ReturnType<typeof props.resources.outfits.apply> | undefined
interface Rig {
  model: Object3D
  headHeight: number
  mixer: AnimationMixer
  actions: Record<string, AnimationAction>
  current: string
  /** Last observed dash state, so stale remote snapshots never retrigger it. */
  wasDashing: boolean
  dashAnimUntil: number
}

const rig = shallowRef<Rig | null>(null)
async function load() {
  if (disposed || loading || rig.value || Date.now() < retryAt) return
  loading = true
  const player = props.player
  const characterName = isCharacter(player.character) ? player.character : characterFor(player.id)
  try {
    const asset = await assets.track(loadCharacterAsset(characterName))
    // Cached templates belong to the shared loader even when this player left.
    if (disposed) return
    // SkeletonUtils.clone keeps the armature bindings intact across copies.
    const model = SkeletonUtils.clone(asset.scene)
    // The GLB faces +z; the rig's forward is +x (the group is rotated by -heading).
    model.rotation.y = Math.PI / 2
    model.scale.setScalar(CHARACTER_SCALE)
    // Swap in the chosen outfit colorway (designed texture variant, not a dye).
    // The accent color is a chat/nameplate identity only.
    outfitLease = props.resources.outfits.apply(model, outfitColorTexture(outfitOf(characterName), player.outfitColor ?? 0))
    // The beard ships visible in the GLB, so every rig states its own answer.
    applyBeard(model, player.beard === true)
    // After the outfit swap: cloning a material drops its shader hooks, so the
    // rim has to be installed on whatever materials the rig ends up with.
    applyCharacterRim(model)
    // Skinned meshes must keep rendering when bones move them outside their
    // original bounds.
    model.traverse((obj) => {
      if (obj instanceof SkinnedMesh) obj.frustumCulled = false
      if (obj instanceof Mesh) obj.castShadow = true
    })

    // Float the labels just above whatever this character's scaled height is.
    model.updateMatrixWorld(true)
    const headHeight = new Box3().setFromObject(model).max.y

    // Clip tracks bind only to the skeleton they were authored for.
    const mixer = new AnimationMixer(model)
    const actions: Record<string, AnimationAction> = {}
    for (const clip of asset.clips) {
      actions[clip.name] = mixer.clipAction(clip)
    }
    actions[CLIP.idle]?.play()

    rig.value = { model, headHeight, mixer, actions, current: CLIP.idle, wasDashing: false, dashAnimUntil: 0 }
    await nextTick()
    if (!disposed) emit('change')
  }
  catch (error) {
    retryAt = Date.now() + 10000
    console.error(`Character ${characterName} could not load`, error)
  }
  finally { loading = false }
}
/** Crossfade a rig to a clip (falls back to Idle if the clip is missing). */
function setAnimation(rig: Rig, name: string, timeScale = 1) {
  const target = rig.actions[name] ? name : CLIP.idle
  const action = rig.actions[target]
  if (!action) return
  if (rig.current !== target) {
    const previous = rig.actions[rig.current]
    const blend = animationBlendDuration(rig.current, target)
    previous?.fadeOut(blend)
    const startTime = previous
      ? locomotionTransitionTime(rig.current, target, previous.time, previous.getClip().duration, action.getClip().duration)
      : 0
    action.reset().fadeIn(blend).play()
    action.time = startTime
    rig.current = target
  }
  action.timeScale = timeScale
}

/** Shortest signed angular distance, so headings never spin the long way. */
function angleDelta(to: number, from: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

/* Chat bubbles are DOM, not sprites: a canvas texture went through the post
 * pipeline and lost its glass, and three allocates texture storage once, so a
 * bubble whose canvas grew for a longer message kept showing the previous one.
 * Each bubble is a `.chat-bubble` element (main.css) in a layer over the canvas,
 * moved every frame to its speaker's projected position. */
let bubbleLayer: HTMLDivElement | null = null
const bubble = makeBubble()
let bubbleText = ''
const bubbleAnchor = new Vector3()
/** Bubbles hold their size up close, shrink with distance and drop out here. */
const BUBBLE_FULL_SIZE_DISTANCE = 9
const BUBBLE_MIN_SCALE = 0.6
const BUBBLE_MAX_DISTANCE = 56
const BUBBLE_FADE_MS = 300

function makeBubble() {
  const el = document.createElement('div')
  el.className = 'chat-bubble'
  el.hidden = true
  return el
}

/** Show `message` above the nameplate while it lasts. */
function updateBubble(message: { text: string, until: number } | null | undefined, now: number) {
  const el = bubble
  if (!group.value || !rig.value) return
  if (!message || message.until <= now) {
    if (bubbleText) {
      bubbleText = ''
      el.hidden = true
    }
    return
  }
  const canvas = renderer.instance?.domElement
  if (!canvas?.parentElement) return
  if (!bubbleLayer) {
    bubbleLayer = document.createElement('div')
    bubbleLayer.className = 'chat-bubble-layer'
    canvas.parentElement.append(bubbleLayer)
  }
  if (el.parentElement !== bubbleLayer) bubbleLayer.append(el)

  bubbleAnchor.copy(group.value.position)
  bubbleAnchor.y += rig.value.headHeight + 0.06 + 0.28 + 0.04
  const distance = bubbleAnchor.distanceTo(camera.activeCamera.value.position)
  camera.activeCamera.value.updateMatrixWorld()
  bubbleAnchor.project(camera.activeCamera.value)
  // NDC z leaves [-1, 1] behind the camera and past the far plane.
  if (distance > BUBBLE_MAX_DISTANCE || Math.abs(bubbleAnchor.z) > 1) {
    el.hidden = true
    return
  }

  if (bubbleText !== message.text) {
    bubbleText = message.text
    el.textContent = message.text
    // Restart the pop-in for a new line on a bubble that is already showing.
    el.style.animation = 'none'
    void el.offsetWidth
    el.style.animation = ''
  }
  const x = (bubbleAnchor.x + 1) / 2 * canvas.clientWidth
  const y = (1 - bubbleAnchor.y) / 2 * canvas.clientHeight
  const scale = Math.max(BUBBLE_MIN_SCALE, Math.min(1, BUBBLE_FULL_SIZE_DISTANCE / distance))
  el.hidden = false
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`
  el.style.opacity = String(Math.min(1, (message.until - now) / BUBBLE_FADE_MS))
}

interface BodySound {
  foot: FootstepState
  x: number
  y: number
  z: number
  airborne: boolean
  /** Fastest descent seen during this fall, for the landing's weight. */
  fall: number
  dashing: boolean
  swimming: boolean
  /** Distance since the last swimming stroke. */
  stroke: number
}
let bodySound: BodySound | undefined

/** Proximity voice. The scene's only part in it is putting each peer's panner
 *  where that peer is drawn, once a frame. */
const voice = useVoice()
/** Roughly where a mouth is above the feet, so a voice does not come out of the
 *  ground. */
const VOICE_MOUTH_HEIGHT = 1.6

/** A fall this fast lands at full weight. Terminal velocity off a rampart. */
const LAND_FORCE_SPEED = 9
/** How far a swimmer travels between strokes, in tiles. */
const STROKE_STRIDE = 1.3

/**
 * Sound one rendered body: its footfalls, its jump and landing, its dash and
 * whatever it does in the water. Self plays flat so it sits in the middle of
 * the mix; everyone else is positioned at their rig and attenuated by the
 * panner, which is also what culls the far half of a busy town.
 */
function soundBody(isSelf: boolean, x: number, y: number, z: number, dt: number, state: { airborne: boolean, dashing: boolean, sprinting: boolean, swimming: boolean }): void {
  let body = bodySound
  if (!body) {
    body = { foot: createFootstepState(), x, y, z, airborne: state.airborne, fall: 0, dashing: state.dashing, swimming: state.swimming, stroke: 0 }
    bodySound = body
    return
  }
  const distance = Math.hypot(x - body.x, y - body.y)
  const descent = dt > 0 ? (body.z - z) / dt : 0
  const at = isSelf ? undefined : { x, y: z + 0.9, z: y }

  if (state.airborne) body.fall = Math.max(body.fall, descent)
  if (!body.airborne && state.airborne) play('jump', { gain: isSelf ? 0.7 : 0.55, position: at })
  else if (body.airborne && !state.airborne) {
    const force = Math.min(1, body.fall / LAND_FORCE_SPEED)
    // A hop off a kerb is not a landing. Anything with real drop behind it is.
    if (force > 0.12) play('land', { gain: isSelf ? 0.8 : 0.6, force, position: at })
    body.fall = 0
  }

  if (!body.dashing && state.dashing) play('dash', { gain: isSelf ? 0.7 : 0.5, position: at })

  if (!body.swimming && state.swimming) {
    play('splash', { gain: isSelf ? 0.9 : 0.7, force: Math.min(1, 0.4 + body.fall / LAND_FORCE_SPEED), position: at })
    body.stroke = 0
  }
  if (state.swimming) {
    body.stroke += distance
    if (body.stroke >= STROKE_STRIDE) {
      body.stroke = 0
      play('swim', { gain: isSelf ? 0.7 : 0.5, position: at })
    }
  }
  else if (stepFootsteps(body.foot, { distance, dt, grounded: !state.airborne, swimming: false, sprinting: state.sprinting })) {
    play('footstep', {
      gain: isSelf ? 0.6 : 0.45,
      surface: footSurfaceAt(props.world, x, y),
      position: at,
    })
  }

  body.x = x
  body.y = y
  body.z = z
  body.airborne = state.airborne
  body.dashing = state.dashing
  body.swimming = state.swimming
}

/** Called after MazeScene predicts self and places the camera, before water/grass. */
function update(frame: PlayerFrame) {
  if (disposed) return
  if (!rig.value) {
    void load()
    return
  }
  if (!group.value || !blob.value) return
  const current = rig.value
  const player = props.player
  const id = player.id
  const { dt, now, selfId, local, held, selfDashing } = frame
  const isSelf = id === selfId
  let moving = false
  let airborne = false
  let dashing = false
  let sprinting = false
  if (isSelf) {
    // Your own rig follows the predicted body and faces its travel direction.
    player.rx = local.x
    player.ry = local.y
    player.rz = local.z
    player.ra = local.facing
    moving = held.forward || held.back || held.left || held.right
    airborne = !local.grounded
    dashing = selfDashing
    sprinting = held.sprint
    group.value.visible = frame.selfVisible
  }
  else {
    // The lag vector points along travel, independently of the peer's camera yaw.
    const toX = player.x - player.rx
    const toY = player.y - player.ry
    const distance = Math.hypot(toX, toY)
    if (distance > 5) {
      player.rx = player.x
      player.ry = player.y
      player.rz = player.z
      player.ra = player.angle
    }
    else {
      const ease = 1 - Math.exp(-dt * 12)
      player.rx += toX * ease
      player.ry += toY * ease
      player.rz += (player.z - player.rz) * Math.min(1, dt * 16)
      // Hold the last heading while stationary (tiny corrections don't count).
      if (distance > 0.04) player.ra += angleDelta(Math.atan2(toY, toX), player.ra) * ease
    }
    moving = distance > 0.05
    // World elevation includes stairs and ramparts. Only height above the
    // authoritative support surface means airborne; rendered height lags on steps.
    airborne = player.z > bodySurfaceHeight(props.world, player.x, player.y, player.z) + 0.12
    // The server can omit a stationary final snapshot. Once interpolation
    // settles, release its dash edge so the next burst can start normally.
    dashing = player.dashing === true && moving
    sprinting = player.sprinting === true
  }

  group.value.position.set(player.rx, player.rz, player.ry)
  group.value.rotation.y = -player.ra

  // Contact shadow: pin the decal to the support surface under the rendered
  // feet, then spread and fade it as the character rises off it.
  const groundY = bodySurfaceHeight(props.world, player.rx, player.ry, player.rz)
  const groundGap = Math.max(0, player.rz - groundY)
  const blobFade = Math.max(0, 1 - groundGap / 1.6)
  blob.value!.visible = blobFade > 0.02
  if (blob.value!.visible) {
    blob.value!.position.y = groundY - player.rz + 0.02
    blobMaterial.opacity = BLOB_OPACITY * blobFade
    const spread = BLOB_RADIUS * 2 * (1 + groundGap * 0.3)
    blob.value!.scale.set(spread, 1, spread)
  }

  // The sprint follows the actual burst, with a fast blend that becomes
  // visible before movement ends. A stale remote dash flag cannot relatch it.
  const dashAnimating = updateDashAnimation(current, dashing, now)
  const swimming = getSwimmingContact(props.world, isSelf ? local : { x: player.x, y: player.y, z: player.z })
  if (swimming) setAnimation(current, moving ? CLIP.swim : CLIP.tread)
  else if (dashAnimating) setAnimation(current, CLIP.dash)
  else if (airborne) setAnimation(current, CLIP.jump, 1.1)
  else if (moving && sprinting) setAnimation(current, CLIP.sprint)
  else if (moving) setAnimation(current, CLIP.run, 1.15)
  else setAnimation(current, CLIP.idle)
  current.mixer.update(dt)

  // The same states the clips are picked from drive the sound, so a footfall
  // and the leg that made it can never disagree.
  if (frame.audioEnabled) {
    soundBody(isSelf, player.rx, player.ry, player.rz, dt, {
      airborne,
      dashing: dashAnimating,
      sprinting,
      swimming: swimming != null,
    })
  }

  // A voice comes out of a mouth, so the panner follows the *rendered* rig at
  // head height rather than the authoritative position — the same body you can
  // see is the one you hear. A player nobody is paired with has no sink and
  // this is a map miss.
  if (!isSelf) voice.positionPeer(id, { x: player.rx, y: player.rz + VOICE_MOUTH_HEIGHT, z: player.ry })

  updateBubble(player.bubble, now)
}
function dispose() {
  if (disposed) return
  disposed = true
  if (group.value) group.value.visible = false
  const current = rig.value
  if (current) {
    current.mixer.stopAllAction()
    current.mixer.uncacheRoot(current.model)
    disposeCharacterSkeleton(current.model)
  }
  nameplate.value?.dispose()
  outfitLease?.release()
  blobMaterial.dispose()
  bubble.remove()
  bubbleLayer?.remove()
  bodySound = undefined
}
onBeforeUnmount(dispose)
onUnmounted(() => emit('change'))
defineExpose({ update, dispose })
</script>

<template>
  <TresGroup
    v-if="rig"
    ref="group"
    :name="`Player_${player.id}`"
    :dispose="null"
  >
    <primitive
      :object="rig.model"
      :dispose="null"
    />
    <TresMesh
      ref="blob"
      :geometry="resources.blobGeometry"
      :material="blobMaterial"
      :scale="blobScale"
      :render-order="1"
      :user-data="blobUserData"
      :dispose="null"
    />
    <CharacterNameplate
      ref="nameplate"
      :name="player.name"
      :color="player.color"
      :height="rig.headHeight"
    />
  </TresGroup>
</template>
