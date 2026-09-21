<script setup lang="ts">
import {
  AnimationMixer,
  Box3,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { AnimationAction, BufferGeometry, Object3D,
  MeshStandardMaterial,
  PointLight } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createGltfResourcePool } from '~/utils/gltfResources'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { HubPropPlacement } from '#shared/utils/props'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  speedMultiplier,
  isWalkable,
  surfaceHeight,
  bodySurfaceHeight,
  getSwimmingContact,
  isPieceCameraBlocked,
  isRampartCameraBlocked,
  slideBody,
  stepBody,
} from '#shared/utils/maze'
import { TERRAFORM_STEP, createWorld, worldProps } from '#shared/utils/world'
import type { SurfaceType } from '#shared/utils/world'
import { EDITS_PER_SECOND } from '#shared/utils/building'
import { KIT_NAMES } from '#shared/utils/kit'
import HUB_ORACLE from '#shared/data/courtyard-oracle.json'
import { createTownMaterials } from '~/utils/townMaterials'
import { createCourtyardAssets } from '~/utils/courtyardAssets'
import { createCourtyardScene } from '~/utils/courtyardScene'
import type { FountainInteractor } from '~/utils/fountainWater'
import { courtyardWeather, createCourtyardSky } from '~/utils/courtyardSky'
import { NATURE_NAMES, setGrassDetail, setGrassPushers } from '~/utils/courtyardLandscape'
import { createCritters } from '~/utils/critters'
import { createHubEditor } from '~/utils/hubEditor'
import type { HubEditor } from '~/utils/hubEditor'
import { createBuildTools } from '~/utils/buildTools'
import { PITCH_MAX, PITCH_MAX_TOOL } from '~/composables/useBuild'
import { characterFor, isCharacter, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyBeard, createOutfitMaterialPool } from '~/utils/appearance'
import { applyCharacterRim, setCharacterRim } from '~/utils/characterRim'
import { disposeCharacterSkeleton, loadCharacterAsset } from '~/utils/characterModels'
import type { CharacterAsset } from '~/utils/characterModels'
import { animationBlendDuration, locomotionTransitionTime, updateDashAnimation } from '~/utils/characterAnimation'
import {
  closeAudio,
  createAmbience,
  createFootstepState,
  footSurfaceAt,
  play,
  rememberListener,
  setAudioListener,
  stepFootsteps,
} from '~/utils/audio'
import type { FootstepState } from '~/utils/audio'
import { biomeAt } from '#shared/utils/biome'
import WorldChunks from './scene/WorldChunks.vue'
import PostProcessing from './scene/PostProcessing.vue'
import OracleCharacter from './scene/OracleCharacter.vue'
import CharacterNameplate from './scene/CharacterNameplate.vue'
import { tagSceneShadows } from '~/utils/sceneObjects'

/**
 * Avelune's scene coordinator: declarative scene ownership, direct frame updates.
 *
 * Tres provides the renderer, scene, camera, and render loop. The courtyard
 * uses authored placements of custom buildings, furniture and trees, drawn as
 * instanced batches. The sky, sun, fog, and rain are driven by a day/night +
 * weather clock derived from the server's time, so every player sees the same
 * evening storm roll in.
 *
 * World mapping: arena tile (x, y) → 3D (x, 0, y), 1 tile = 1 unit.
 *
 * The third-person camera follows a *predicted* self: your held keys are
 * integrated locally with the exact same `stepBody` the server runs, then
 * blended toward the authoritative position. The mouse orbits the camera
 * around you (and is the movement basis the server integrates); the character
 * itself only pivots to face where it is actually moving, so mouse-look while
 * standing still just circles the camera without spinning you on the spot. The
 * camera boom shortens when a wall would block the view.
 */

interface ViewState {
  yaw: number
  pitch: number
  turnLeft: boolean
  turnRight: boolean
  /** One-shot action queues written by the input layer. */
  jumpQueued: boolean
  dashQueued: boolean
  /** Cursor-mode aim in NDC, while Alt frees the pointer. False the rest of the
   *  time, which means "aim down the crosshair". */
  cursorActive: boolean
  cursorX: number
  cursorY: number
}

const props = defineProps<{ game: UseGame, held: MoveInput, view: ViewState, editor?: boolean }>()
const emit = defineEmits<{ ready: [dispose: () => void] }>()

const { scene, camera: cameraManager, renderer } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender } = useLoop()
const postProcessing = shallowRef<InstanceType<typeof PostProcessing> | null>(null)
const worldChunks = shallowRef<InstanceType<typeof WorldChunks> | null>(null)
const oracleCharacter = shallowRef<InstanceType<typeof OracleCharacter> | null>(null)
const torchLight = shallowRef<PointLight | null>(null)

/**
 * What the player let the renderer spend. Applied from the render loop rather
 * than from the watcher: half of it needs the WebGL renderer, which Tres has
 * not necessarily built yet when the settings load.
 */
const graphics = useGraphics()
let graphicsDirty = true
watch(graphics.profile, () => {
  graphicsDirty = true
})

/** Scene quality changes touch shared uniforms and the sun. The postprocessing
 * and chunk components own the settings that change their own resources. */
function applyGraphics() {
  graphicsDirty = false
  const quality = graphics.profile.value
  atmosphere.setQuality(quality)
  setGrassDetail(quality.grassDensity, quality.grassRange)
}

// Dev-only world editor: created in onMounted when `editor` is set (see the
// bottom of the file). Referenced by buildFloor (rebuild) and the render loop.
let editorCtl: HubEditor | null = null
// The editor's shared state, when editing. Drives the controller's editable bounds.
let ed: ReturnType<typeof useEditor> | null = null

// The sky owns atmosphere, outdoor lighting, weather and water reflections.
const atmosphere = createCourtyardSky(scene.value)

/* -------------------------------------------------------------------------- */
/* Arena geometry                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The world.
 *
 * In play it is the *streamed* one: `useWorld` holds a world with
 * `generate: false` and no town, filled entirely by the server's `chunk` /
 * `terrain` / `place` / `remove` frames. Prediction, the camera boom, the
 * minimap and every batch below read it, so what we walk on is byte-for-byte
 * what the authority walks on and a chunk we have not been given is simply not
 * there — `terrainHeight` returns -Infinity and `isWalkable` blocks it, which
 * is what keeps a late load from dropping anyone through the floor.
 *
 * The dev editor is the exception: it authors the town against the seed, with
 * no socket at all, so it builds its own local world exactly as before.
 */
const stream = useWorld()
const build = useBuild()
const hubWorld = props.editor ? createWorld() : stream.world

const waterActors: FountainInteractor[] = []
const courtyard = shallowRef<ReturnType<typeof createCourtyardScene> | null>(null)

/** Wildlife owns its internal instances; Tres attaches its root. */
const floorGroup = new Group()
floorGroup.name = 'Ambient_Wildlife'

/** Where the Oracle stands (tiles) and faces (yaw). In the editor it follows the
 *  working doc live (the rig is selectable/draggable there like a prop); in play
 *  it's the saved pose from courtyard-oracle.json. */
function oraclePos(): { x: number, y: number, rot: number } {
  if (props.editor && ed?.current.value.oracle) return ed.current.value.oracle
  return { x: HUB_ORACLE[0]!, y: HUB_ORACLE[1]!, rot: HUB_ORACLE[2]! }
}
/** Scene caches observe topology changes only after Vue attaches primitives. */
let sceneChangeQueued = false
function bumpSceneVersion() {
  scene.value.userData.version = (scene.value.userData.version ?? 0) + 1
}
function sceneChanged() {
  if (sceneChangeQueued) return
  sceneChangeQueued = true
  void nextTick(() => {
    sceneChangeQueued = false
    if (sceneDisposed) return
    bumpSceneVersion()
  })
}

/* -------------------------------------------------------------------------- */
/* The town's own render                                                      */
/* -------------------------------------------------------------------------- */

/** The authored town, as the cosmetic scene wants it: everything the committed
 *  JSON placed, and nothing the world generated. */
function townPlacements(): HubPropPlacement[] {
  const out: HubPropPlacement[] = []
  for (const prop of worldProps(hubWorld)) if (prop.id?.startsWith('town:')) out.push(prop)
  return out
}

function clearFloor() {
  courtyard.value?.dispose()
  courtyard.value = null
}

/**
 * Rebuild the town's special render: the plaza, the moat, the fountains and
 * the gate. The world itself is not touched — it lives in chunk groups that
 * come and go with the player — so an editor change costs one scene, not the
 * whole world.
 */
function buildFloor() {
  clearFloor()

  courtyard.value = createCourtyardScene(ed?.placements.value ?? townPlacements(), propTemplates, townMaterials, foliageTime)
  tagSceneShadows(courtyard.value.group)
  // Patch new materials once Tres has attached the replacement group.
  sceneChanged()
  // Re-sync the editor's own selectable clones (templates may have just
  // finished loading, so this runs after each build phase).
  editorCtl?.rebuild()
}

/** The four hooks the `chunk` / `unchunk` / `terrain` / `place` and `remove`
 *  frames map onto, exposed for tests and for anything that wants to drive the
 *  scene without going through the socket. */
defineExpose({
  mountChunk: (cx: number, cy: number, detail = true) => worldChunks.value?.mountChunk(cx, cy, detail),
  unmountChunk: (cx: number, cy: number) => worldChunks.value?.unmountChunk(cx, cy),
  refreshChunkTerrain: (cx: number, cy: number) => worldChunks.value?.refreshChunkTerrain(cx, cy),
  refreshChunkProps: (cx: number, cy: number) => worldChunks.value?.refreshChunkProps(cx, cy),
})

/* -------------------------------------------------------------------------- */
/* The server's loaded set                                                    */
/* -------------------------------------------------------------------------- */

let townRebuild: ReturnType<typeof setTimeout> | undefined

function scheduleTownRebuild() {
  if (townRebuild) return
  townRebuild = setTimeout(() => {
    townRebuild = undefined
    if (!sceneDisposed) buildFloor()
  }, 300)
}

/* -------------------------------------------------------------------------- */
/* Blender-authored assets (see scripts/build_*.py and scripts/convert_*)     */
/* -------------------------------------------------------------------------- */

const gltfLoader = new GLTFLoader()
// Only courtyard/nature/kit templates enter this pool. Critters use the other
// loader and keep their existing per-species disposal ownership.
const templateLoader = new GLTFLoader()
const templateResources = createGltfResourcePool()
templateResources.register(templateLoader)
// The shipped GLBs are meshopt-compressed (scripts/convert_nature.sh,
// scripts/convert_kit.sh); the decoder is a no-op for uncompressed ones, so
// it's safe to always register.
gltfLoader.setMeshoptDecoder(MeshoptDecoder)
templateLoader.setMeshoptDecoder(MeshoptDecoder)

/**
 * The universal rig is authored at human scale (~1.8 m); this brings characters
 * to ~1.3 units so they read at arena scale rather than towering over the
 * kit pieces. Each player picks a character during onboarding (see
 * CharacterGate); it rides the snapshot.
 */
const CHARACTER_SCALE = 0.72

/** Movement states map to clips in the shared universal animation library. */
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop', sprint: 'Sprint_Loop', swim: 'Swim_Loop', tread: 'Swim_Idle' } as const

/** Every model load is counted here, so the entry overlay can wait for the art
 *  and not only for the socket. */
const assets = useAssets()
assets.reset()

const characterAssets = new Map<string, CharacterAsset>()
const characterLoading = new Set<string>()
const characterRetryAt = new Map<string, number>()

function ensureCharacter(name: string) {
  if (characterAssets.has(name) || characterLoading.has(name) || Date.now() < (characterRetryAt.get(name) ?? 0)) return
  characterLoading.add(name)
  assets.track(loadCharacterAsset(name)).then((asset) => {
    if (!sceneDisposed) characterAssets.set(name, asset)
  }).catch((error) => {
    characterRetryAt.set(name, Date.now() + 10000)
    console.error(`Character ${name} could not load`, error)
  }).finally(() => characterLoading.delete(name))
}

/** Drives the wind sway on every alpha-cut prop batch (see utils/foliage). */
const foliageTime = { value: 0 }
/** Shader clocks wrap here (seconds) to stay inside float32's useful range. */
const SHADER_CLOCK_WRAP = 3600

const townMaterials = createTownMaterials()
const propTemplates = createCourtyardAssets(townMaterials)
/** Ambient wildlife: purely cosmetic, deterministic per chunk, never on the
 *  wire. Off in the editor, where every extra pickable body is in the way. */
const critters = props.editor
  ? null
  : createCritters({
      parent: floorGroup,
      loader: gltfLoader,
      world: hubWorld,
      seed: hubWorld.seed,
      // A new rig needs the CSM patch and a GTAO rescan, exactly as the Oracle's does.
      onChange: sceneChanged,
    })
const retiredTemplates: Group[] = []
let sceneDisposed = false
function releaseTemplates(templates: Iterable<Group>) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<MeshStandardMaterial>()
  const textures = new Set<Texture>()
  for (const root of templates) {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material)
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
      }
    })
  }
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) if (!templateResources.ownsMaterial(material)) material.dispose()
  for (const texture of textures) if (!templateResources.ownsTexture(texture)) texture.dispose()
}

// Load one dir's models into the shared template map. Resilient: a single
// model that 404s or fails to parse is logged and skipped rather than
// rejecting the whole batch — otherwise one flaky request would leave the
// world stuck on its bare placeholders forever.
async function loadTemplates(dir: string, names: readonly string[]) {
  await Promise.all(names.map(async (name) => {
    try {
      const gltf = await assets.track(templateLoader.loadAsync(`/models/${dir}/${name}.glb`))
      if (sceneDisposed) {
        releaseTemplates([gltf.scene])
        return
      }
      townMaterials.decorate(gltf.scene)
      propTemplates.set(name, gltf.scene)
    }
    catch (err) {
      console.warn(`[models] failed to load ${dir}/${name}.glb`, err)
    }
  }))
}

/** Normalize detailed assets without baking their quantized vertex attributes. */
function fitTemplate(source: Group, width: number | null, height: number, depth: number | null) {
  source.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(source, true)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const offset = new Group()
  offset.position.set(-center.x, -bounds.min.y, -center.z)
  offset.add(source.clone(true))
  const fitted = new Group()
  fitted.scale.set(width ? width / size.x : height / size.y, height / size.y, depth ? depth / size.z : height / size.y)
  fitted.add(offset)
  return fitted
}

Promise.all([
  loadTemplates('courtyard', ['fountain', 'inn', 'shop', 'tower']),
  loadTemplates('nature', NATURE_NAMES),
  // The player build kit goes into the same template map: a placed piece is an
  // ordinary chunk placement, so it batches through `chunkProps` like anything
  // else, and the hotbar's ghost clones the same template.
  loadTemplates('kit', KIT_NAMES),
]).then(() => {
  if (sceneDisposed) return
  for (const [kind, file] of [['Courtyard_Inn', 'inn'], ['Courtyard_Shop', 'shop'], ['Courtyard_Tower', 'tower'], ['Courtyard_Fountain', 'fountain'], ['Courtyard_Tree', 'tree1']] as const) {
    const template = propTemplates.get(file)
    if (template) {
      const previous = propTemplates.get(kind)
      if (previous) retiredTemplates.push(previous)
      propTemplates.set(kind, template)
    }
  }
  const planter = propTemplates.get('Courtyard_Planter')
  if (planter) {
    for (const x of [-0.9, 0, 0.9]) {
      const source = propTemplates.get('bush1')
      if (!source) continue
      const bush = fitTemplate(source, 1, 0.55, 0.95)
      bush.position.set(x, 0.64, 0)
      planter.add(bush)
    }
    for (const x of [-1.1, -0.4, 0.4, 1.1]) {
      const source = propTemplates.get('flowers1')
      if (!source) continue
      const flowers = fitTemplate(source, null, 0.55, null)
      flowers.position.set(x, 0.68, 0.2)
      planter.add(flowers)
    }
  }
  worldChunks.value?.rebuild()
  buildFloor()
})

/* -------------------------------------------------------------------------- */
/* Players                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
  dispose: () => void
  group: Group
  model: Object3D
  player: GamePlayer
  headHeight: number
  mixer: AnimationMixer
  actions: Record<string, AnimationAction>
  current: string
  /** Last observed dash state, so stale remote snapshots never retrigger it. */
  wasDashing: boolean
  dashAnimUntil: number
  bubble: HTMLDivElement
  bubbleText: string
  /** Height above the rig's origin that the bubble's tail points at. */
  bubbleBaseY: number
  /** Ground decal under the feet; fades out as the character leaves the floor. */
  blob: Mesh<PlaneGeometry, MeshBasicMaterial>
}

const rigs = shallowReactive(new Map<string, Rig>())
const outfitMaterialPool = createOutfitMaterialPool()
const nameplates = new Map<string, InstanceType<typeof CharacterNameplate>>()
function setNameplate(id: string, instance: unknown) {
  if (instance) nameplates.set(id, instance as InstanceType<typeof CharacterNameplate>)
  else nameplates.delete(id)
}

/* Blob contact shadow. The sun's cascade is soft enough that feet can read as
 * hovering, especially under the trees where the cast shadow washes out. A tiny
 * ground-hugging gradient quad puts them back on the floor. Geometry and
 * texture are shared; only the material is per-rig, so each can fade on its own
 * as the character leaves the ground. */
const BLOB_RADIUS = 0.34
const BLOB_OPACITY = 0.35
const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
let blobTexture: CanvasTexture | null = null

function blobShadowTexture() {
  if (blobTexture) return blobTexture
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
  gradient.addColorStop(0.45, 'rgba(0, 0, 0, 0.72)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  blobTexture = new CanvasTexture(canvas)
  blobTexture.colorSpace = SRGBColorSpace
  return blobTexture
}

function makeBlobShadow() {
  const material = new MeshBasicMaterial({
    map: blobShadowTexture(),
    color: '#1b1a16',
    transparent: true,
    opacity: BLOB_OPACITY,
    depthWrite: false,
    toneMapped: false,
    fog: true,
  })
  const mesh = new Mesh(blobGeometry, material)
  mesh.scale.set(BLOB_RADIUS * 2, 1, BLOB_RADIUS * 2)
  mesh.renderOrder = 1
  // GTAO's normal override draws every mesh opaque. This decal has no surface
  // of its own and would occlude as a solid disc, so the renderer skips it.
  mesh.userData.gtaoExclude = true
  return mesh
}

/* Chat bubbles are DOM, not sprites: a canvas texture went through the post
 * pipeline and lost its glass, and three allocates texture storage once, so a
 * bubble whose canvas grew for a longer message kept showing the previous one.
 * Each bubble is a `.chat-bubble` element (main.css) in a layer over the canvas,
 * moved every frame to its speaker's projected position. */
let bubbleLayer: HTMLDivElement | null = null
const bubbleAnchor = new Vector3()
/** Bubbles hold their size up close, shrink with distance and drop out here. */
const BUBBLE_FULL_SIZE_DISTANCE = 9
const BUBBLE_MIN_SCALE = 0.6
const BUBBLE_MAX_DISTANCE = 56
const BUBBLE_FADE_MS = 300

function makeBubble(npc = false) {
  const el = document.createElement('div')
  el.className = 'chat-bubble'
  if (npc) el.dataset.npc = ''
  el.hidden = true
  return el
}

/** Show `message` over a rig while it lasts, pinned above `bubbleBaseY`. */
function updateBubble(rig: Pick<Rig, 'group' | 'bubble' | 'bubbleText' | 'bubbleBaseY'>, message: { text: string, until: number } | null | undefined, now: number) {
  const el = rig.bubble
  if (!message || message.until <= now) {
    if (rig.bubbleText) {
      rig.bubbleText = ''
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

  bubbleAnchor.copy(rig.group.position)
  bubbleAnchor.y += rig.bubbleBaseY
  const distance = bubbleAnchor.distanceTo(camera.value.position)
  camera.value.updateMatrixWorld()
  bubbleAnchor.project(camera.value)
  // NDC z leaves [-1, 1] behind the camera and past the far plane.
  if (distance > BUBBLE_MAX_DISTANCE || Math.abs(bubbleAnchor.z) > 1) {
    el.hidden = true
    return
  }

  if (rig.bubbleText !== message.text) {
    rig.bubbleText = message.text
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

function createRig(player: GamePlayer): Rig | null {
  // The player's chosen character rides the server snapshot; fall back to a
  // deterministic hash if it's somehow missing or unknown.
  const characterName = isCharacter(player.character) ? player.character : characterFor(player.id)
  const asset = characterAssets.get(characterName)
  if (!asset) {
    // The shared loader resolves only once the compatible model and clips land.
    ensureCharacter(characterName)
    return null
  }

  const group = new Group()

  // SkeletonUtils.clone keeps the armature bindings intact across copies.
  const model = SkeletonUtils.clone(asset.scene)
  // The GLB faces +z; the rig's forward is +x (the group is rotated by -heading).
  model.rotation.y = Math.PI / 2
  model.scale.setScalar(CHARACTER_SCALE)
  // Swap in the chosen outfit colorway (designed texture variant, not a dye).
  // The accent color is a chat/nameplate identity only.
  const outfitMaterials = outfitMaterialPool.apply(model, outfitColorTexture(outfitOf(characterName), player.outfitColor ?? 0))
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

  const bubbleBaseY = headHeight + 0.06 + 0.28 + 0.04
  const bubble = makeBubble()
  const blob = makeBlobShadow()
  group.name = `Player_${player.id}`
  sceneChanged()
  return {
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      disposeCharacterSkeleton(model)
      nameplates.get(player.id)?.dispose()
      bubble.remove()
      blob.material.dispose()
      // Other rigs wearing this variant keep their shared material alive.
      outfitMaterials.release()
    },
    group,
    model,
    player,
    headHeight,
    mixer,
    actions,
    current: CLIP.idle,
    wasDashing: false,
    dashAnimUntil: 0,
    bubble,
    bubbleText: '',
    bubbleBaseY,
    blob,
  }
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

/* -------------------------------------------------------------------------- */
/* Third-person prediction + camera                                           */
/* -------------------------------------------------------------------------- */

const local = {
  x: hubWorld.start.x,
  y: hubWorld.start.y,
  z: 0,
  vz: 0,
  grounded: true,
  dashUntil: 0,
  dashCooldownUntil: 0,
  /** Rendered heading: eases toward the travel direction, held while idle. */
  facing: -Math.PI / 2,
}

// A fresh identity (connect or reconnect) starts wherever the server put us.
// `view` is a deliberately shared mutable object (input writes it, we read
// and occasionally reset it) — not reactive state, hence the lint opt-outs.
watch(() => props.game.selfId.value, (id: string | null) => {
  const self = id ? props.game.players.get(id) : undefined
  if (self) {
    local.x = self.x
    local.y = self.y
    local.z = self.z
    local.vz = 0
    local.facing = self.angle
    // eslint-disable-next-line vue/no-mutating-props
    props.view.yaw = self.angle
  }
})

buildFloor()

/** Longest the third-person boom extends behind the player, in tiles. */
const MAX_BOOM = 3.6
/** Camera's collision half-width, so the boom samples its footprint, not a hairline. */
const CAM_RADIUS = 0.32
/** Smoothed boom distance: snaps in past walls, eases back out (see the render loop). */
let boomDist = MAX_BOOM

/**
 * The over-the-shoulder offset a tool is aimed from.
 *
 * Centred behind the player the crosshair passes straight through the
 * character, so the tile it lands on is the one half hidden by their own back.
 * Arming a tool eases the camera out to one side and in a little, which gives
 * the ray a clear line to the ground ahead; disarming eases it back. `V` flips
 * the side (`build.shoulder`), for the times the wall you are building is on
 * the right.
 */
const SHOULDER_SIDE = 0.9
const SHOULDER_LIFT = 0.25
const SHOULDER_CLOSE = 0.9
/** How fast the offset eases in and out, per second. */
const SHOULDER_RATE = 6
let shoulderMix = 0
/** Eye height the boom orbits around. */
const PIVOT_HEIGHT = 1.5
/** Closer than this the local character is between the camera and the tile the
 *  crosshair is on, so it is taken out of the shot. */
const SELF_FADE_DISTANCE = 1.2
/** How much of the boom the steepest look gives up. Enough that the camera ends
 *  up inside `SELF_FADE_DISTANCE`, which is what takes the character out of an
 *  overhead shot, and near enough straight above that the crosshair lands on the
 *  tile the boots are on rather than the next one along. */
const STEEP_CLOSE = 0.65
/** Where the camera ended up this frame, for the self-rig fade. */
let camX = 0
let camY = 0
let camZ = 0

/**
 * How far the camera can sit behind the player before a wall blocks it. Marches
 * from the head toward the ideal camera spot, sampling the camera's *width*
 * (centre plus both flanks) at each step so it can't slip through a wall corner
 * and briefly expose the void behind it. Returns the last clear distance.
 */
function clipBoom(hx: number, hy: number, dirX: number, dirZ: number, maxDist: number, height: number): number {
  const px = -dirZ // unit perpendicular to the boom, for width sampling
  const pz = dirX
  const blocked = (x: number, z: number) => !isWalkable(hubWorld, Math.floor(x), Math.floor(z))
    || surfaceHeight(hubWorld, x, z, height - CAM_RADIUS) > height - CAM_RADIUS
    || isRampartCameraBlocked(hubWorld, x, z, height, CAM_RADIUS)
    // Raised kit pieces block the boom the same way a gallery does: their
    // collision band starts at `base`, so a ground-height test misses them.
    || isPieceCameraBlocked(hubWorld, x, z, height, CAM_RADIUS)
  for (let d = 0.3; d < maxDist; d += 0.08) {
    const sx = hx + dirX * d
    const sz = hy + dirZ * d
    if (blocked(sx, sz)
      || blocked(sx + px * CAM_RADIUS, sz + pz * CAM_RADIUS)
      || blocked(sx - px * CAM_RADIUS, sz - pz * CAM_RADIUS)) {
      return Math.max(0.4, d - 0.3)
    }
  }
  return maxDist
}

/* -------------------------------------------------------------------------- */
/* Crosshair tools                                                            */
/* -------------------------------------------------------------------------- */

/** Terraform and build targeting. Editor mode has its own controller, so this
 *  only exists in play. */
const buildTools = props.editor
  ? null
  : createBuildTools({
      scene: scene.value,
      world: hubWorld,
      templates: propTemplates,
      getCamera: () => (camera.value instanceof PerspectiveCamera ? camera.value : undefined),
      getPointer: () => (props.view.cursorActive ? { x: props.view.cursorX, y: props.view.cursorY } : null),
      build,
      owner: id => props.game.players.get(id),
    })

/** Client-side echo of the server's edit budget, so a held mouse button can't
 *  outrun it and collect a stream of `slow down` toasts. */
const EDIT_INTERVAL = 1000 / EDITS_PER_SECOND
let nextEditAt = 0

/**
 * The last target an edit was sent at.
 *
 * Holding the button repeats the armed tool, and for everything but the shovels
 * a repeat on the same target is nothing but a wasted edit (and, for a build, a
 * guaranteed refusal). A press clears it, so clicking the same tile twice is
 * still two edits.
 */
let lastEditKey = ''
let lastPressId = 0

function targetKey(target: NonNullable<ReturnType<NonNullable<typeof buildTools>['update']>>): string {
  return `${target.mode}:${target.x},${target.y},${target.rot ?? ''},${target.id ?? ''}`
}

/** Send the armed tool's verb at the current target. Terrain is applied locally
 *  first and reconciled by the server's own delta, whose heights are absolute
 *  and overwrite whatever we guessed. */
function applyTool(target: ReturnType<NonNullable<typeof buildTools>['update']>) {
  const slot = build.active.value
  if (!target || !slot) return
  // Raise, lower and flatten move the ground one step per call, so holding them
  // on one spot is the point. Everything else needs a new target.
  const repeatable = !slot.kind && slot.id !== 'demolish' && slot.id !== 'paint'
  const key = targetKey(target)
  if (!repeatable && key === lastEditKey) return
  const now = Date.now()
  if (now < nextEditAt) return
  nextEditAt = now + EDIT_INTERVAL
  lastEditKey = key
  if (slot.id === 'demolish') {
    if (target.id) props.game.sendDemolish(target.id)
    // The server is the authority, so the click goes either way. The sound
    // reports what the ghost already showed.
    play(target.ok && target.id ? 'remove' : 'refuse')
    return
  }
  if (slot.kind) {
    // The RAW aim, not the pose: `snapPlacement`'s edge snap reads the flip out
    // of the rotation, so a pose sent back through it would land elsewhere. The
    // server snaps, exactly as the ghost did.
    props.game.sendBuild(slot.kind, target.rawX, target.rawY, build.rot.value, target.h)
    play(target.ok ? 'place' : 'refuse')
    return
  }
  const mode = slot.id as 'raise' | 'lower' | 'flatten' | 'paint'
  const size = build.size.value
  const surface = build.surface.value
  props.game.sendTerraform(target.x, target.y, mode, size, mode === 'paint' ? surface : undefined)
  play(!target.ok ? 'refuse' : mode === 'lower' ? 'remove' : 'place')
  if (target.ok) {
    stream.predictTerrain({ x: target.x, y: target.y, mode, size, surface: surface as SurfaceType, maxStep: TERRAFORM_STEP })
  }
}

/* -------------------------------------------------------------------------- */
/* Sound                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Audio is a client-side cosmetic, like the critters: every sound is derived
 * from what this frame already renders, nothing is sent or received, and no
 * sound can move a player. It is off in the editor, which has no player to
 * follow and no weather worth listening to.
 *
 * The engine is created by the first user gesture (`GameScene` calls
 * `useAudio().unlock()`), so everything below is a no-op until then.
 */
const ambience = props.editor ? null : createAmbience()
/** Beds move slowly; four updates a second is plenty and keeps a dozen
 *  parameter ramps off the frame. */
const AMBIENCE_INTERVAL = 0.25
let ambienceIn = 0
const audioForward = new Vector3()
const AUDIO_UP = new Vector3(0, 1, 0)

/** Per-body sound state, keyed by player id. Kept beside the rigs rather than
 *  on them, because it is derived from the *rendered* body and a rig can be
 *  rebuilt under it. */
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
const bodySounds = new Map<string, BodySound>()

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
function soundBody(id: string, isSelf: boolean, x: number, y: number, z: number, dt: number, state: { airborne: boolean, dashing: boolean, sprinting: boolean, swimming: boolean }): void {
  let body = bodySounds.get(id)
  if (!body) {
    body = { foot: createFootstepState(), x, y, z, airborne: state.airborne, fall: 0, dashing: state.dashing, swimming: state.swimming, stroke: 0 }
    bodySounds.set(id, body)
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
      surface: footSurfaceAt(hubWorld, x, y),
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

// Arming a hotbar slot ticks once. The hotbar itself is `game-ui`'s, but the
// sound belongs with the rest of the mix.
if (!props.editor) {
  watch(() => build.active.value?.id, (id) => {
    if (id) play('arm')
  })
}

/** Arrow keys turn as a no-mouse fallback. */
const ARROW_TURN_SPEED = 2.6

/** How fast the character pivots to face its travel direction. */
const CHARACTER_TURN_RATE = 16

/* Client-side reconciliation of our predicted body toward server authority.
 * Prediction and the server run the *same* shared `stepBody`, so they only ever
 * drift by network lag: the server is a fraction of an RTT behind our inputs.
 * A naive "always ease toward the server" blend turns that lag into two felt
 * artifacts — a forward glide when you release a key (the in-flight "stop"
 * lets the server overshoot, which the blend then eases you into) and a
 * rubber-band stick in tight corridors (the server, on its slightly-stale
 * heading, clamps against a wall your prediction slid past, and the blend drags
 * you back into it). So the reconcile is input-aware, below. */
/** Beyond this error (tiles) we hard-snap — a teleport or a big lag spike. */
const RECONCILE_SNAP = 3
/** Convergence rate for the smooth corrections (higher = snappier). */
const RECONCILE_RATE = 8
/** While idle, ignore server disagreement under this (tiles) so releasing a
 *  key doesn't glide into the server's stop-overshoot. Self-heals on the next
 *  move via along-track catch-up; the server stays authoritative regardless. */
const RECONCILE_IDLE_FREEZE = 0.4

/**
 * Take the local character out of the shot when the camera closes on it.
 *
 * Aiming at your own feet swings the boom in over your head, and your own back
 * is then the only thing under the crosshair. Hidden outright rather than faded:
 * materials are shared by characters with the same appearance, so changing
 * their opacity would fade other players too. Visibility belongs to the rig.
 *
 * The ray never needed this. Players are not placements, so `propsNear` has
 * never returned one and the pick has always looked straight through them; this
 * is only so the tile is visible.
 */
function hideSelfWhenClose(group: Object3D, distance: number) {
  const visible = distance > SELF_FADE_DISTANCE
  if (group.visible !== visible) group.visible = visible
}

onBeforeRender(({ delta }) => {
  if (sceneDisposed) return
  if (graphicsDirty) applyGraphics()
  worldChunks.value?.sync(local.x, local.y)
  const dt = Math.min(delta, 0.1)
  const now = Date.now()
  const serverNow = props.game.serverNow()
  const selfId = props.game.selfId.value
  const self = selfId ? props.game.players.get(selfId) : undefined

  // Keyboard-turn fallback (mouse-look writes view.yaw directly).
  const arrowTurn = (props.view.turnRight ? 1 : 0) - (props.view.turnLeft ? 1 : 0)
  if (arrowTurn !== 0) {
    // eslint-disable-next-line vue/no-mutating-props
    props.view.yaw += arrowTurn * ARROW_TURN_SPEED * dt
    props.game.setLook(props.view.yaw)
  }

  // Predict our own movement locally (same kinematics as the server —
  // walls, ledges, gravity, jump, dash), then blend toward authority.
  let selfDashing = false
  if (self) {
    // Consume one-shot action queues from the input layer.
    if (props.view.jumpQueued) {
      // eslint-disable-next-line vue/no-mutating-props
      props.view.jumpQueued = false
      if (local.grounded) {
        local.vz = JUMP_VELOCITY
        local.grounded = false
      }
    }
    if (props.view.dashQueued) {
      // eslint-disable-next-line vue/no-mutating-props
      props.view.dashQueued = false
      if (now >= local.dashCooldownUntil) {
        local.dashUntil = now + DASH_DURATION * 1000
        local.dashCooldownUntil = now + DASH_COOLDOWN * 1000
      }
    }
    selfDashing = now < local.dashUntil

    let drive = (props.held.forward ? 1 : 0) - (props.held.back ? 1 : 0)
    const strafe = (props.held.right ? 1 : 0) - (props.held.left ? 1 : 0)
    // A dash from a standstill still launches you forward (camera-relative),
    // rather than rolling on the spot with no input to accelerate.
    if (selfDashing && drive === 0 && strafe === 0) drive = 1
    let dx = 0
    let dy = 0
    if (drive !== 0 || strafe !== 0) {
      const len = Math.hypot(drive, strafe)
      const speed = PLAYER_SPEED * speedMultiplier(selfDashing, props.held.sprint) * dt / len
      const cos = Math.cos(props.view.yaw)
      const sin = Math.sin(props.view.yaw)
      dx = (cos * drive - sin * strafe) * speed
      dy = (sin * drive + cos * strafe) * speed
      // Pivot to face the way we're actually moving (camera-relative), so a
      // free-orbit mouse-look never spins us on the spot while standing still.
      local.facing += angleDelta(Math.atan2(dy, dx), local.facing) * (1 - Math.exp(-dt * CHARACTER_TURN_RATE))
    }
    stepBody(hubWorld, local, dx, dy, dt)

    const ex = self.x - local.x
    const ey = self.y - local.y
    const k = 1 - Math.exp(-dt * RECONCILE_RATE)
    if (Math.hypot(ex, ey) > RECONCILE_SNAP) {
      // Gross desync (teleport, big lag spike): jump to authority.
      local.x = self.x
      local.y = self.y
      local.z = self.z
    }
    else if (drive !== 0 || strafe !== 0) {
      // Driving: split the error into components along our travel direction
      // and perpendicular to it. Always correct the perpendicular part (that
      // smooths out heading-lag side drift), but only correct along-track
      // when the server is *ahead* (catch up) — never drag us backward
      // against our own input, which is the "stuck on an invisible wall"
      // feel. This lets the prediction lead the lagging server, not fight it.
      const len = Math.hypot(dx, dy) || 1
      const tx = dx / len
      const ty = dy / len
      const along = ex * tx + ey * ty
      const ahead = Math.max(0, along)
      // Through the shared collision, never a raw add: the straight line to the
      // server's position can cross a building's corner, and a body whose centre
      // lands inside a footprint is lifted onto the roof by the next step.
      slideBody(hubWorld, local, (ex - along * tx + ahead * tx) * k, (ey - along * ty + ahead * ty) * k)
    }
    else if (Math.hypot(ex, ey) > RECONCILE_IDLE_FREEZE) {
      // Idle: only chase real disagreement; small stop-overshoot is left be.
      slideBody(hubWorld, local, ex * k, ey * k)
    }
  }

  // Editor mode owns the camera (free fly) — drive it and keep the sun/shadow
  // target centered on where we're looking; skip the third-person follow-cam.
  if (editorCtl) {
    editorCtl.update(dt)
    if (camera.value) {
      local.x = camera.value.position.x
      local.y = camera.value.position.z
    }
  }
  // Third-person camera: behind the shoulder, pulled in by walls.
  else if (camera.value) {
    const yaw = props.view.yaw
    // The steep range belongs to the hotbar. Putting the tool away eases the
    // view back into the walking band rather than snapping it.
    const ceiling = build.active.value ? PITCH_MAX_TOOL : PITCH_MAX
    if (props.view.pitch > ceiling) {
      // eslint-disable-next-line vue/no-mutating-props
      props.view.pitch += (ceiling - props.view.pitch) * (1 - Math.exp(-dt * 6))
    }
    const pitch = props.view.pitch
    const headX = local.x
    const headZ = local.y
    shoulderMix += ((build.active.value ? 1 : 0) - shoulderMix) * (1 - Math.exp(-dt * SHOULDER_RATE))
    const lift = SHOULDER_LIFT * shoulderMix
    // The boom is a true polar orbit around a pivot at eye height, so `pitch`
    // is the angle the crosshair actually looks down at. The old ad-hoc
    // camera-up / target-down pair only reached about 28° at full extension,
    // which is why the tiles around your own feet were unaimable.
    const pivotY = local.z + PIVOT_HEIGHT + lift
    const cosP = Math.cos(pitch)
    const sinP = Math.sin(pitch)
    // The ideal seat: back along the view axis, out along the camera's own
    // right (`cross(forward, up)` for a forward of `(cos yaw, 0, sin yaw)`),
    // and up by however far the pitch has swung it over the player.
    // Steep pitch pulls the boom in as well as up: left at full extension the
    // camera would sit four tiles over your head, and the tile under the
    // crosshair would be a postage stamp. In close it is a proper overhead
    // view — and close enough for the fade below to take the character out of
    // the shot.
    const steep = Math.max(0, Math.min(1, (pitch - PITCH_MAX) / (PITCH_MAX_TOOL - PITCH_MAX)))
    const back = (MAX_BOOM - SHOULDER_CLOSE * shoulderMix) * (1 - STEEP_CLOSE * steep)
    // The shoulder fades out as the view tips down: looking at your own boots
    // there is no character left to see past, and an off-centre overhead camera
    // puts the crosshair a tile to the side of the one you are standing on.
    const side = SHOULDER_SIDE * build.shoulder.value * shoulderMix * (1 - steep)
    const offX = -Math.cos(yaw) * back * cosP - Math.sin(yaw) * side
    const offZ = -Math.sin(yaw) * back * cosP + Math.cos(yaw) * side
    const offY = back * sinP
    const reach = Math.hypot(offX, offZ)
    // Boom collision: snap IN immediately when a wall intrudes (so the camera
    // never lags behind it and flashes the void), but ease back OUT smoothly so
    // it zooms rather than popping once the wall is clear. The offset seat is
    // what gets clipped, not the centred one, so a shoulder pressed to a wall
    // still comes in. Looking near-straight down the horizontal run collapses
    // to nothing and there is no wall to clip against, so the test is skipped.
    const targetBoom = reach > 0.05
      ? clipBoom(headX, headZ, offX / reach, offZ / reach, reach, Math.min(pivotY + offY, local.z + 1))
      : reach
    boomDist = targetBoom < boomDist
      ? targetBoom
      : boomDist + (targetBoom - boomDist) * (1 - Math.exp(-dt * 9))
    const scale = reach > 0.05 ? Math.min(1, boomDist / reach) : 1
    camX = headX + offX * scale
    camY = pivotY + offY * scale
    camZ = headZ + offZ * scale
    camera.value.position.set(camX, camY, camZ)
    // The look target carries the same lateral offset, so the view axis stays
    // parallel to the heading: a shoulder camera that looked back at the head
    // would point the crosshair at the player's own ear.
    const lookSide = side * scale
    camera.value.lookAt(
      headX + Math.cos(yaw) * 1.2 * cosP - Math.sin(yaw) * lookSide,
      pivotY - 1.2 * sinP,
      headZ + Math.sin(yaw) * 1.2 * cosP + Math.cos(yaw) * lookSide,
    )
    torchLight.value?.position.set(headX, local.z + 1.7, headZ)
  }

  // The ears go where the camera went, after it moved: a frame-old transform
  // would pan the world against the view. Every positioned sound below this is
  // placed against the listener remembered here.
  if (ambience && camera.value) {
    camera.value.getWorldDirection(audioForward)
    rememberListener(camera.value.position)
    setAudioListener(camera.value.position, audioForward, AUDIO_UP)
  }

  // Aim after the camera has moved: the crosshair ray is the camera's own
  // forward axis, so a frame-old transform would aim a frame behind the view.
  if (buildTools) {
    buildTools.setVisible(self != null)
    const target = self ? buildTools.update(local, selfId) : null
    // A fresh press forgets the last target, so a second click on the same tile
    // is a second edit while a held button across it stays one.
    if (build.pressId.value !== lastPressId) {
      lastPressId = build.pressId.value
      lastEditKey = ''
    }
    const clicked = build.fireQueued.value
    build.fireQueued.value = false
    if (clicked || build.holding.value) applyTool(target)
  }

  if (camera.value && renderer.instance instanceof WebGLRenderer) {
    atmosphere.update(serverNow, dt, camera.value, renderer.instance, local.x, local.y, props.game.weather.value, props.game.timeOfDay.value)
  }

  // Keep the character rim aligned with the day's key light. `courtyardWeather`
  // is the same pure clock the sky reads, so the two can never drift apart.
  const rimSky = courtyardWeather(serverNow, props.game.weather.value, props.game.timeOfDay.value)
  setCharacterRim(
    Math.cos(rimSky.sunAngle),
    rimSky.sunHeight,
    Math.cos(rimSky.sunAngle) * 0.38,
    Math.max(0, rimSky.sunHeight) * (1 - rimSky.overcast * 0.5),
  )

  // Wind, rain, thunder and the day/night beds, off the same clock the sky runs
  // on. Levels ramp over seconds, so this does not want a frame.
  if (ambience) {
    ambienceIn -= dt
    if (ambienceIn <= 0) {
      const elapsed = AMBIENCE_INTERVAL - ambienceIn
      ambienceIn = AMBIENCE_INTERVAL
      ambience.update(elapsed, {
        dayness: rimSky.dayness,
        overcast: rimSky.overcast,
        rain: rimSky.rain,
        x: local.x,
        y: local.y,
        altitude: local.z,
        biome: biomeAt(hubWorld.seed, local.x, local.y),
        now: serverNow,
      })
    }
  }

  // Reconcile player rigs with the roster.
  for (const [id, rig] of rigs) {
    if (!props.game.players.has(id)) {
      rig.group.visible = false
      rig.dispose()
      rigs.delete(id)
      bodySounds.delete(id)
      sceneChanged()
    }
  }
  for (const [id, player] of props.game.players) {
    let rig = rigs.get(id)
    if (!rig) {
      const created = createRig(player)
      if (!created) continue
      rig = created
      rigs.set(id, rig)
    }

    const isSelf = id === selfId
    let moving = false
    let airborne = false
    let dashing = false
    let sprinting = false
    if (isSelf) {
      // Your own rig follows the *predicted* body; it faces its travel
      // direction, not the free-orbit camera (which mouse-look drives).
      player.rx = local.x
      player.ry = local.y
      player.rz = local.z
      player.ra = local.facing
      moving = props.held.forward || props.held.back || props.held.left || props.held.right
      airborne = !local.grounded
      dashing = selfDashing
      sprinting = props.held.sprint
      hideSelfWhenClose(rig.group, Math.hypot(camX - local.x, camZ - local.y, camY - (local.z + PIVOT_HEIGHT)))
    }
    else {
      // The lag vector (authoritative minus rendered) points where they're
      // headed, so we face travel direction — matching self, and never
      // snapping to a peer's free-orbit camera yaw.
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
      airborne = player.z > bodySurfaceHeight(hubWorld, player.x, player.y, player.z) + 0.12
      // The server can omit a stationary final snapshot. Once interpolation
      // settles, release its dash edge so the next burst can start normally.
      dashing = player.dashing === true && moving
      sprinting = player.sprinting === true
    }

    rig.group.position.set(player.rx, player.rz, player.ry)
    rig.group.rotation.y = -player.ra

    // Contact shadow: pin the decal to the support surface under the rendered
    // feet, then spread and fade it as the character rises off it.
    const groundY = bodySurfaceHeight(hubWorld, player.rx, player.ry, player.rz)
    const groundGap = Math.max(0, player.rz - groundY)
    const blobFade = Math.max(0, 1 - groundGap / 1.6)
    rig.blob.visible = blobFade > 0.02
    if (rig.blob.visible) {
      rig.blob.position.y = groundY - player.rz + 0.02
      rig.blob.material.opacity = BLOB_OPACITY * blobFade
      const spread = BLOB_RADIUS * 2 * (1 + groundGap * 0.3)
      rig.blob.scale.set(spread, 1, spread)
    }

    // The sprint follows the actual burst, with a fast blend that becomes
    // visible before movement ends. A stale remote dash flag cannot relatch it.
    const dashAnimating = updateDashAnimation(rig, dashing, now)
    const swimming = getSwimmingContact(hubWorld, isSelf ? local : { x: player.x, y: player.y, z: player.z })
    if (swimming) setAnimation(rig, moving ? CLIP.swim : CLIP.tread)
    else if (dashAnimating) setAnimation(rig, CLIP.dash)
    else if (airborne) setAnimation(rig, CLIP.jump, 1.1)
    else if (moving && sprinting) setAnimation(rig, CLIP.sprint)
    else if (moving) setAnimation(rig, CLIP.run, 1.15)
    else setAnimation(rig, CLIP.idle)
    rig.mixer.update(dt)

    // The same states the clips are picked from drive the sound, so a footfall
    // and the leg that made it can never disagree.
    if (ambience) {
      soundBody(id, isSelf, player.rx, player.ry, player.rz, dt, {
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

    updateBubble(rig, player.bubble, now)
  }

  waterActors.length = props.game.players.size
  let waterActorIndex = 0
  for (const [id, player] of props.game.players) {
    const actor = waterActors[waterActorIndex] ??= { id, x: 0, z: 0, feetY: 0 }
    actor.id = id
    actor.x = id === selfId ? local.x : player.rx
    actor.z = id === selfId ? local.y : player.ry
    actor.feetY = id === selfId ? local.z : player.rz
    waterActorIndex++
  }
  // The same rendered bodies bend the grass. Both banks (chunk meadows and the
  // town's garden beds) share one uniform, so this one call covers them.
  setGrassPushers(waterActors, local.x, local.y)
  // The same rendered bodies are what the wildlife runs from.
  critters?.update(dt, now, waterActors, camera.value?.position, rimSky.dayness)
  // Distant patches draw only the tufts that can still be standing there.
  const eye = camera.value?.position
  if (eye) worldChunks.value?.updateGrass(eye.x, eye.z)
  // Shader clocks are `uniform float`: at epoch scale (~1.79e9) a float32's ULP
  // is 128 s, so wind and ripples would sit perfectly still. Wrap what reaches
  // a uniform; the fountain keeps absolute seconds because its particle sim
  // integrates frame deltas and resets when time jumps backwards.
  const worldSeconds = serverNow / 1000
  const shaderSeconds = worldSeconds % SHADER_CLOCK_WRAP
  foliageTime.value = shaderSeconds
  courtyard.value?.update(worldSeconds, shaderSeconds, waterActors)
})

// Remove everything we added to the shared scene (also keeps HMR honest —
// a stale setup's lights and geometry would otherwise stack up on reload).
// Dev-only: spin up the hub prop editor once the render context exists. Guarded
// by `import.meta.dev` so the whole controller (Raycaster, fly cam, listeners)
// dead-code-eliminates from the production bundle.
if (import.meta.dev) {
  onMounted(() => {
    if (!props.editor) return
    const canvas = renderer.instance?.domElement
    if (!canvas || !scene.value) return
    ed = useEditor()
    buildFloor()
    editorCtl = createHubEditor({
      scene: scene.value,
      getCamera: () => (camera.value instanceof PerspectiveCamera ? camera.value : undefined),
      canvas,
      getTemplate: kind => propTemplates.get(kind),
      // The rig is (re)built lazily by the render loop, so hand over a getter.
      getOracle: () => oracleCharacter.value?.getGroup(),
      editor: ed,
      getSize: () => ed!.current.value.size,
    })
    editorCtl.rebuild()
    // Rebuild the scene on any structural change (seed / undo / redo). The
    // controller re-clones its placements off its own deep watch.
    watch(() => ed!.structureVersion.value, buildFloor)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__editor = { ...ed, seat: editorCtl.seat }
  })
}

// Tres unmounts its custom Vue tree after disposing the host WebGLRenderer.
// Let the host release GPU targets first, while Three's resource tables exist.
// The fallback handles a scene-only HMR replacement in an otherwise live canvas.
function disposeScene() {
  if (sceneDisposed) return
  sceneDisposed = true
  postProcessing.value?.dispose()
  for (const rig of rigs.values()) rig.dispose()
  rigs.clear()
  outfitMaterialPool.dispose()
  nameplates.clear()
  clearFloor()
  worldChunks.value?.dispose()
  oracleCharacter.value?.dispose()
  if (townRebuild) clearTimeout(townRebuild)
  buildTools?.dispose()
  critters?.dispose()
  editorCtl?.dispose()
  editorCtl = null
  blobGeometry.dispose()
  blobTexture?.dispose()
  blobTexture = null
  releaseTemplates([...propTemplates.values(), ...retiredTemplates])
  templateResources.dispose()
  propTemplates.clear()
  townMaterials.dispose()
  retiredTemplates.length = 0
  atmosphere.dispose()
  ambience?.dispose()
  bodySounds.clear()
  // Leaving the arena takes the context with it. The next entry unlocks a fresh
  // one on its own first gesture.
  closeAudio()
  bubbleLayer?.remove()
  bubbleLayer = null
  floorGroup.clear()
}
onMounted(() => emit('ready', disposeScene))
onBeforeUnmount(disposeScene)

if (import.meta.dev) {
  // `audio.debug()` is how a headed run checks the mix without listening: the
  // context state, the voice count, a per-sound tally and the master RMS.
  // `voice.debug()` is the same for proximity voice: the mic state, whether we
  // are transmitting, and each peer's frame counts, buffer and inbound level.
  // `voice.setTalking(true)` stands in for holding the key, which is unreliable
  // to synthesise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__maze = { local, camera, game: props.game, held: props.held, view: props.view, critters, audio: { ...useAudio(), play }, voice }
}
</script>

<template>
  <PostProcessing
    ref="postProcessing"
    :quality="graphics.profile.value"
  />
  <TresPerspectiveCamera
    :fov="62"
    :near="0.05"
    :far="260"
  />
  <TresPointLight
    ref="torchLight"
    name="Player_Torch"
    color="#ffc98a"
    :intensity="0.6"
    :distance="7"
    :decay="1.7"
  />
  <WorldChunks
    ref="worldChunks"
    :world="hubWorld"
    :templates="propTemplates"
    :materials="townMaterials"
    :foliage-time="foliageTime"
    :quality="graphics.profile.value"
    :critters="critters"
    :editor="editor"
    @change="sceneChanged"
    @town-change="scheduleTownRebuild"
  />
  <primitive
    :object="floorGroup"
    :dispose="null"
  />
  <primitive
    v-if="courtyard"
    :object="courtyard.group"
    :dispose="null"
  />
  <TresGroup
    name="Players"
    :dispose="null"
  >
    <primitive
      v-for="[id, rig] in rigs"
      :key="id"
      :object="rig.group"
      :dispose="null"
    >
      <primitive
        :object="rig.model"
        :dispose="null"
      />
      <primitive
        :object="rig.blob"
        :dispose="null"
      />
      <CharacterNameplate
        :ref="value => setNameplate(id, value)"
        :name="rig.player.name"
        :color="rig.player.color"
        :height="rig.headHeight"
      />
    </primitive>
  </TresGroup>
  <OracleCharacter
    ref="oracleCharacter"
    :game="game"
    :local="local"
    :editor="editor"
    :get-pose="oraclePos"
    @ready="sceneChanged"
    @removed="sceneChanged"
  />
</template>
