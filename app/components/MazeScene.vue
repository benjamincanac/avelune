<script setup lang="ts">
import {
  Box3,
  Group,
  Mesh,
  PerspectiveCamera,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { BufferGeometry,
  MeshStandardMaterial,
  PointLight } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createGltfResourcePool } from '~/utils/gltfResources'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { UseGame } from '~/composables/useGame'
import type { HubPropPlacement } from '#shared/utils/props'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  speedMultiplier,
  isWalkable,
  surfaceHeight,
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
import { setCharacterRim } from '~/utils/characterRim'
import {
  closeAudio,
  createAmbience,
  play,
  rememberListener,
  setAudioListener,
} from '~/utils/audio'
import { biomeAt } from '#shared/utils/biome'
import WorldChunks from './scene/WorldChunks.vue'
import PostProcessing from './scene/PostProcessing.vue'
import OracleCharacter from './scene/OracleCharacter.vue'
import Players from './scene/Players.vue'
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
const players = shallowRef<InstanceType<typeof Players> | null>(null)
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

/** Track world asset loads for the entry overlay. */
const assets = useAssets()
assets.reset()

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

const voice = useVoice()

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

  players.value?.update({
    dt, now, selfId, local, held: props.held, selfDashing,
    selfVisible: Math.hypot(camX - local.x, camZ - local.y, camY - (local.z + PIVOT_HEIGHT)) > SELF_FADE_DISTANCE,
    audioEnabled: ambience !== null,
  })

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
  if (eye) {
    worldChunks.value?.updateGrass(eye.x, eye.z)
    courtyard.value?.updateGrass(eye.x, eye.z)
  }
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
  players.value?.dispose()
  clearFloor()
  worldChunks.value?.dispose()
  oracleCharacter.value?.dispose()
  if (townRebuild) clearTimeout(townRebuild)
  buildTools?.dispose()
  critters?.dispose()
  editorCtl?.dispose()
  editorCtl = null
  releaseTemplates([...propTemplates.values(), ...retiredTemplates])
  templateResources.dispose()
  propTemplates.clear()
  townMaterials.dispose()
  retiredTemplates.length = 0
  atmosphere.dispose()
  ambience?.dispose()
  // Leaving the arena takes the context with it. The next entry unlocks a fresh
  // one on its own first gesture.
  closeAudio()
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
  ;(window as any).__maze = { local, camera, scene, game: props.game, held: props.held, view: props.view, critters, audio: { ...useAudio(), play }, voice }
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
  <Players
    ref="players"
    :game="game"
    :world="hubWorld"
    @change="sceneChanged"
  />
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
