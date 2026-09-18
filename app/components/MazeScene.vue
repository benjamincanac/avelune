<script setup lang="ts">
import {
  AnimationMixer,
  Box3,
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  SkinnedMesh,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { AnimationAction, AnimationClip, BufferGeometry,
  InstancedMesh } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { HubPropPlacement } from '#shared/utils/props'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  isWalkable,
  surfaceHeight,
  bodySurfaceHeight,
  getSwimmingContact,
  isPieceCameraBlocked,
  isRampartCameraBlocked,
  stepBody,
} from '#shared/utils/maze'
import { TERRAFORM_STEP, applyPlace, chunkCoord, chunkKey, cornerHeight, createWorld, isTownChunk, parseChunkKey, worldProps } from '#shared/utils/world'
import type { Chunk, SurfaceType } from '#shared/utils/world'
import { generateVegetation } from '#shared/utils/vegetation'
import { EDITS_PER_SECOND } from '#shared/utils/building'
import { KIT_NAMES } from '#shared/utils/kit'
import HUB_ORACLE from '#shared/data/courtyard-oracle.json'
import { createTownMaterials } from '~/utils/townMaterials'
import { createCourtyardAssets } from '~/utils/courtyardAssets'
import { createCourtyardScene } from '~/utils/courtyardScene'
import type { FountainInteractor } from '~/utils/fountainWater'
import { courtyardWeather, createCourtyardSky } from '~/utils/courtyardSky'
import { NATURE_NAMES, createGrassBank } from '~/utils/courtyardLandscape'
import { createTerrainMaterial, createTerrainMesh, updateTerrainMesh } from '~/utils/terrainChunk'
import type { HeightSampler } from '~/utils/terrainChunk'
import { chunkGrassBlades, createChunkProps, createPavingBank } from '~/utils/chunkProps'
import { createCourtyardRenderer } from '~/utils/courtyardRenderer'
import { createHubEditor } from '~/utils/hubEditor'
import type { HubEditor } from '~/utils/hubEditor'
import { createBuildTools } from '~/utils/buildTools'
import { characterFor, isCharacter, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'
import { applyCharacterRim, setCharacterRim } from '~/utils/characterRim'
import { disposeCharacterSkeleton, loadCharacterAsset } from '~/utils/characterModels'
import type { CharacterAsset } from '~/utils/characterModels'
import { animationBlendDuration, locomotionTransitionTime, updateDashAnimation } from '~/utils/characterAnimation'

/**
 * Avelune's 3D world, built imperatively with three.js inside the Tres context.
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
}

const props = defineProps<{ game: UseGame, held: MoveInput, view: ViewState, editor?: boolean }>()
const emit = defineEmits<{ ready: [dispose: () => void] }>()

// Hub Oracle proximity/dialogue state, shared with GameScene and the HUD.
const oracle = useOracle()

const { scene, camera: cameraManager, renderer } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender, render } = useLoop()
let pipeline: ReturnType<typeof createCourtyardRenderer> | null = null
render((notify) => {
  if (sceneDisposed) return
  const active = camera.value
  const gl = renderer.instance
  if (!active || !(gl instanceof WebGLRenderer)) return
  pipeline ??= createCourtyardRenderer(gl, scene.value, active)
  pipeline.render(active)
  notify()
})

// Dev-only world editor: created in onMounted when `editor` is set (see the
// bottom of the file). Referenced by buildFloor (rebuild) and the render loop.
let editorCtl: HubEditor | null = null
// The editor's shared state, when editing. Drives the controller's editable bounds.
let ed: ReturnType<typeof useEditor> | null = null

// The sky owns atmosphere, outdoor lighting, weather and water reflections.
const atmosphere = createCourtyardSky(scene.value)
const torchLight = new PointLight('#ffc98a', 0.6, 7, 1.7)
scene.value.add(torchLight)

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
let courtyard: ReturnType<typeof createCourtyardScene> | null = null

/** Everything world-shaped lives here so a rebuild can swap it wholesale. */
const floorGroup = new Group()
scene.value.add(floorGroup)

// The Oracle NPC — a monster (Quaternius Ultimate Monsters) as the arena's
// ancient seer. Declared here (before the synchronous initial buildFloor) so
// buildFloor can reset it on a rebuild.
/** Where the Oracle stands (tiles) and faces (yaw). In the editor it follows the
 *  working doc live (the rig is selectable/draggable there like a prop); in play
 *  it's the saved pose from courtyard-oracle.json. */
function oraclePos(): { x: number, y: number, rot: number } {
  if (props.editor && ed?.current.value.oracle) return ed.current.value.oracle
  return { x: HUB_ORACLE[0]!, y: HUB_ORACLE[1]!, rot: HUB_ORACLE[2]! }
}
/** Within this many tiles the player may consult it (drives the HUD prompt). */
const ORACLE_NEAR = 7
interface OracleRig {
  dispose: () => void
  group: Group
  mixer: AnimationMixer
  /** Speech bubble mirroring the players' — shows the Oracle's latest chat line. */
  bubble: Sprite
  bubbleCanvas: HTMLCanvasElement
  bubbleTexture: CanvasTexture
  bubbleText: string
  /** World-space bottom edge of the bubble; it grows upward from here. */
  bubbleBaseY: number
}
let oracleRig: OracleRig | null = null

/**
 * Tag the freshly built world for shadows: opaque standard-material meshes cast
 * and receive; the flat ground plane only receives; glowing/transparent bits
 * (rift, beams, runes) do neither. Instanced meshes cast shadows too.
 *
 * `userData.shadowTagged` opts a batch out: the landscape sets its own flags
 * (the ~200-instance distant treeline and the meadow grass deliberately cast
 * nothing) and a blanket pass would push all of that back into every cascade.
 */
function tagShadows(root: Group) {
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o.userData.shadowTagged) return
    const mat = o.material
    const opaqueStd = mat instanceof MeshStandardMaterial && !mat.transparent
    o.castShadow = opaqueStd && !(o.geometry instanceof PlaneGeometry)
    o.receiveShadow = opaqueStd
  })
}

/** GTAO's exclusion list is cached by the renderer; bump this whenever the
 *  scene gains or loses objects so it rescans. */
function bumpSceneVersion() {
  scene.value.userData.version = (scene.value.userData.version ?? 0) + 1
}

/* -------------------------------------------------------------------------- */
/* Chunk streaming                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Terrain reaches out to the camera's far plane so the hills still close the
 * horizon; the detailed pass — props, generated vegetation, grass — is a tight
 * ring around the player, because batching per chunk costs a draw call per kind
 * per chunk and a whole meadow of those would not fit in a frame.
 */
const TERRAIN_RADIUS = 7
const TERRAIN_DROP = 8
const DETAIL_RADIUS = 2
const DETAIL_DROP = 3

/** The authored town is a fixed 25 chunks and reads as one place: half of it
 *  fading out as you cross the square would be worse than the draw calls. It
 *  keeps its detail for as long as it is mounted at all. */
const alwaysDetailed = (cx: number, cy: number) => isTownChunk(cx, cy)
/** Detail level for a chunk, by its distance from the chunk we last synced on.
 *  Shared by the range follower and the streaming listeners so a chunk mounts
 *  at the same level whichever of them gets to it first. */
function detailFor(cx: number, cy: number): boolean {
  if (alwaysDetailed(cx, cy)) return true
  if (Number.isNaN(lastChunkCx)) return true
  return Math.max(Math.abs(cx - lastChunkCx), Math.abs(cy - lastChunkCy)) <= DETAIL_RADIUS
}
/** Milliseconds of a frame a border crossing may spend building chunks. The
 *  first sync ignores it: the whole view is filled at once, while the models are
 *  still streaming in, because a horizon that fades in over the first minute on
 *  a slow machine is far worse than one longer frame at load. */
const MOUNT_BUDGET_MS = 5

interface MountedChunk {
  group: Group
  terrain: Mesh
  props: Group | null
  grass: InstancedMesh | null
  /** Player-laid road. Not detail-gated: a road is architecture, and it has to
   *  still be there when you look back at it from the next hill. */
  paving: Mesh | null
  /** Whether this chunk currently draws its props and grass. */
  detail: boolean
}

const mounted = new Map<string, MountedChunk>()
const mountQueue: { cx: number, cy: number, detail: boolean, distance: number }[] = []
/** Chunks whose generated vegetation has been placed. Once, like the server. */
const seededChunks = new Set<string>()
let lastChunkCx = Number.NaN
let lastChunkCy = Number.NaN
let chunksPrimed = false

/** Corner heights read across chunk borders, so terrain normals do not crease
 *  along every seam. */
const sampleHeight: HeightSampler = (gx, gy) => cornerHeight(hubWorld, gx, gy)

/**
 * The chunk at (cx, cy), ready to draw. In play this is just a lookup: the
 * chunk either arrived or it did not, and an absent one is not drawn. The
 * editor's local world generates on touch instead, and seeds its wild
 * vegetation exactly once, the way the server's `loadChunk` does.
 */
function ensureChunkContent(cx: number, cy: number): Chunk | undefined {
  const chunk = hubWorld.getChunk(cx, cy)
  if (!chunk || !props.editor) return chunk
  const key = chunkKey(cx, cy)
  if (seededChunks.has(key)) return chunk
  seededChunks.add(key)
  for (const placement of generateVegetation(hubWorld.seed, cx, cy)) applyPlace(hubWorld, placement)
  return chunk
}

/** (Re)build the chunk's flagstones. Driven by the surface raster and the
 *  corner heights, so it belongs with the terrain refresh, not the props. */
function buildChunkPaving(entry: MountedChunk, chunk: Chunk) {
  if (entry.paving) {
    entry.group.remove(entry.paving)
    entry.paving.geometry.dispose()
    entry.paving = null
  }
  entry.paving = pavingBank.patch(chunk, sampleHeight)
  if (entry.paving) entry.group.add(entry.paving)
}

/** (Re)build the chunk's props and grass, or tear them down when it drops back
 *  to being distant terrain. */
function buildChunkDetail(entry: MountedChunk, chunk: Chunk) {
  if (entry.props) {
    entry.group.remove(entry.props)
    chunkProps.release(entry.props)
    entry.props = null
  }
  if (entry.grass) {
    entry.group.remove(entry.grass)
    entry.grass.dispose()
    entry.grass = null
  }
  if (!entry.detail) return
  entry.props = chunkProps.build(chunk)
  tagShadows(entry.props)
  entry.group.add(entry.props)
  entry.grass = grassBank.patch(chunkGrassBlades(chunk))
  if (entry.grass) entry.group.add(entry.grass)
}

/**
 * Phase 3 calls these four on a `chunk` / `unchunk` / `terrain` / `place` or
 * `remove` frame; here they are driven by the player's own position over the
 * locally generated world. `mountChunk` is idempotent and upgrades a chunk that
 * is already mounted at a lower detail.
 */
function mountChunk(cx: number, cy: number, detail = true): void {
  const key = chunkKey(cx, cy)
  const existing = mounted.get(key)
  if (existing) {
    if (existing.detail === detail) return
    existing.detail = detail
    refreshChunkProps(cx, cy)
    return
  }
  const chunk = ensureChunkContent(cx, cy)
  if (!chunk) return
  const group = new Group()
  group.name = `chunk ${key}`
  const entry: MountedChunk = { group, terrain: createTerrainMesh(chunk, terrainMaterial, sampleHeight), props: null, grass: null, paving: null, detail }
  group.add(entry.terrain)
  mounted.set(key, entry)
  buildChunkPaving(entry, chunk)
  buildChunkDetail(entry, chunk)
  floorGroup.add(group)
  bumpSceneVersion()
}

function unmountChunk(cx: number, cy: number): void {
  const key = chunkKey(cx, cy)
  const entry = mounted.get(key)
  if (!entry) return
  mounted.delete(key)
  floorGroup.remove(entry.group)
  if (entry.props) chunkProps.release(entry.props)
  entry.grass?.dispose()
  entry.paving?.geometry.dispose()
  // Terrain geometry is this chunk's alone; its material is shared.
  entry.terrain.geometry.dispose()
  entry.group.clear()
  bumpSceneVersion()
}

/** A `terrain` frame changed this chunk's corner heights or surface raster.
 *  Everything bedded on the ground goes with it: the flagstones a paint stroke
 *  just laid, and the grass and flowers that must not grow through them. */
function refreshChunkTerrain(cx: number, cy: number): void {
  const entry = mounted.get(chunkKey(cx, cy))
  const chunk = entry && hubWorld.getChunk(cx, cy)
  if (!entry || !chunk) return
  updateTerrainMesh(entry.terrain, chunk, sampleHeight)
  buildChunkPaving(entry, chunk)
  buildChunkDetail(entry, chunk)
  bumpSceneVersion()
}

/** A `place` or `remove` frame changed what stands on this chunk. */
function refreshChunkProps(cx: number, cy: number): void {
  const entry = mounted.get(chunkKey(cx, cy))
  const chunk = entry && hubWorld.getChunk(cx, cy)
  if (!entry || !chunk) return
  buildChunkDetail(entry, chunk)
  bumpSceneVersion()
}

/** Follow the player: mount what is in range, drop what is not. The work is
 *  budgeted per frame, so a border crossing spreads over a few frames. */
function syncChunks(x: number, y: number) {
  const cx0 = chunkCoord(x)
  const cy0 = chunkCoord(y)
  if (cx0 !== lastChunkCx || cy0 !== lastChunkCy) {
    lastChunkCx = cx0
    lastChunkCy = cy0
    for (const [key, entry] of [...mounted]) {
      const { cx, cy } = parseChunkKey(key)
      const distance = Math.max(Math.abs(cx - cx0), Math.abs(cy - cy0))
      if (distance > TERRAIN_DROP) unmountChunk(cx, cy)
      else if (distance > DETAIL_DROP && entry.detail && !alwaysDetailed(cx, cy)) {
        entry.detail = false
        refreshChunkProps(cx, cy)
      }
    }
    mountQueue.length = 0
    for (let cy = cy0 - TERRAIN_RADIUS; cy <= cy0 + TERRAIN_RADIUS; cy++) {
      for (let cx = cx0 - TERRAIN_RADIUS; cx <= cx0 + TERRAIN_RADIUS; cx++) {
        const distance = Math.max(Math.abs(cx - cx0), Math.abs(cy - cy0))
        const detail = detailFor(cx, cy)
        const entry = mounted.get(chunkKey(cx, cy))
        if (entry && entry.detail === detail) continue
        mountQueue.push({ cx, cy, detail, distance })
      }
    }
    mountQueue.sort((a, b) => a.distance - b.distance)
  }
  const deadline = chunksPrimed ? performance.now() + MOUNT_BUDGET_MS : Number.POSITIVE_INFINITY
  while (mountQueue.length) {
    const next = mountQueue.shift()!
    mountChunk(next.cx, next.cy, next.detail)
    if (performance.now() >= deadline) break
  }
  chunksPrimed = true
}

function clearChunks() {
  for (const key of [...mounted.keys()]) {
    const { cx, cy } = parseChunkKey(key)
    unmountChunk(cx, cy)
  }
  mountQueue.length = 0
  lastChunkCx = Number.NaN
  lastChunkCy = Number.NaN
  chunksPrimed = false
}

/** The templates behind every batch have been replaced (the GLBs landed), so
 *  every mounted chunk has to be rebuilt off the new ones. */
function rebuildChunks() {
  for (const entry of mounted.values()) {
    if (!entry.props) continue
    entry.group.remove(entry.props)
    chunkProps.release(entry.props)
    entry.props = null
  }
  chunkProps.reset()
  for (const [key, entry] of mounted) {
    const { cx, cy } = parseChunkKey(key)
    const chunk = hubWorld.getChunk(cx, cy)
    if (chunk) buildChunkDetail(entry, chunk)
  }
  bumpSceneVersion()
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
  if (oracleRig) {
    floorGroup.remove(oracleRig.group)
    oracleRig.dispose()
    oracleRig = null
  }
  if (courtyard) {
    floorGroup.remove(courtyard.group)
    courtyard.dispose()
    courtyard = null
  }
}

/**
 * Rebuild the town's special render: the plaza, the moat, the fountains and
 * the gate. The world itself is not touched — it lives in chunk groups that
 * come and go with the player — so an editor change costs one scene, not the
 * whole world.
 */
function buildFloor() {
  clearFloor()

  courtyard = createCourtyardScene(ed?.placements.value ?? townPlacements(), propTemplates, townMaterials)
  floorGroup.add(courtyard.group)
  tagShadows(courtyard.group)
  // Materials that miss the CSM injection read the three cascade lights as
  // three separate suns until the periodic sweep catches them.
  atmosphere.setupShadows()
  bumpSceneVersion()
  // Re-sync the editor's own selectable clones (templates may have just
  // finished loading, so this runs after each build phase).
  editorCtl?.rebuild()
}

/** The four hooks the `chunk` / `unchunk` / `terrain` / `place` and `remove`
 *  frames map onto, exposed for tests and for anything that wants to drive the
 *  scene without going through the socket. */
defineExpose({ mountChunk, unmountChunk, refreshChunkTerrain, refreshChunkProps })

/* -------------------------------------------------------------------------- */
/* The server's loaded set                                                    */
/* -------------------------------------------------------------------------- */

/**
 * In play the server decides what we hold: `useWorld` has already installed the
 * chunk by the time we hear about it, so these four only move geometry. The
 * range follower still runs alongside them and still chooses the detail level
 * by distance — it simply cannot mount a chunk that has not arrived, because
 * `getChunk` returns undefined for one and `mountChunk` bails.
 */
const unsubscribe: (() => void)[] = []
/** Protected chunks we have seen. The town's cosmetic scene is built from the
 *  placements they carry, so it is rebuilt as they land — once per burst, not
 *  once per chunk. */
const townChunks = new Set<string>()
let townRebuild: ReturnType<typeof setTimeout> | undefined

function scheduleTownRebuild() {
  if (townRebuild) return
  townRebuild = setTimeout(() => {
    townRebuild = undefined
    if (!sceneDisposed) buildFloor()
  }, 300)
}

if (!props.editor) {
  unsubscribe.push(
    stream.onChunk((cx, cy) => {
      // A chunk that was already mounted has been *replaced* (a resync), so its
      // geometry has to be rebuilt; a fresh mount already built it.
      const remount = mounted.has(chunkKey(cx, cy))
      mountChunk(cx, cy, detailFor(cx, cy))
      if (remount) {
        refreshChunkTerrain(cx, cy)
        refreshChunkProps(cx, cy)
      }
      // A long piece reaches into its neighbours' batches; they have just
      // adopted it, so redraw them too.
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) if (nx !== cx || ny !== cy) refreshChunkProps(nx, ny)
      }
      const key = chunkKey(cx, cy)
      if (isTownChunk(cx, cy) && !townChunks.has(key)) {
        townChunks.add(key)
        scheduleTownRebuild()
      }
    }),
    stream.onUnchunk(unmountChunk),
    stream.onTerrain(refreshChunkTerrain),
    stream.onProps(refreshChunkProps),
  )
}

/* -------------------------------------------------------------------------- */
/* Blender-authored assets (see scripts/make_assets.py)                       */
/* -------------------------------------------------------------------------- */

const gltfLoader = new GLTFLoader()
// The nature/village kits are meshopt-compressed (scripts/convert_kits.sh); the
// decoder is a no-op for the plain PNG GLBs, so it's safe to always register.
gltfLoader.setMeshoptDecoder(MeshoptDecoder)

/**
 * The universal rig is authored at human scale (~1.8 m); this brings characters
 * to ~1.3 units so they read at arena scale rather than towering over the
 * kit pieces. Each player picks a character during onboarding (see
 * CharacterGate); it rides the snapshot.
 */
const CHARACTER_SCALE = 0.72

/** Movement states map to clips in the shared universal animation library. */
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop', swim: 'Swim_Loop', tread: 'Swim_Idle' } as const

const characterAssets = new Map<string, CharacterAsset>()
const characterLoading = new Set<string>()
const characterRetryAt = new Map<string, number>()

function ensureCharacter(name: string) {
  if (characterAssets.has(name) || characterLoading.has(name) || Date.now() < (characterRetryAt.get(name) ?? 0)) return
  characterLoading.add(name)
  loadCharacterAsset(name).then((asset) => {
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
/** Shared by every terrain chunk: one material, one program, one CSM patch. */
const terrainMaterial = createTerrainMaterial(townMaterials)
/** Shared blade geometry for every chunk's meadow and the town's garden beds. */
const grassBank = createGrassBank(foliageTime)
const pavingBank = createPavingBank(townMaterials)
const chunkProps = createChunkProps({ templates: propTemplates, materials: townMaterials, foliageTime, editor: props.editor })
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
  for (const material of materials) material.dispose()
  for (const texture of textures) texture.dispose()
}

// Load one dir's models into the shared template map. Resilient: a single
// model that 404s or fails to parse is logged and skipped rather than
// rejecting the whole batch — otherwise one flaky request would leave the
// world stuck on its bare placeholders forever.
async function loadTemplates(dir: string, names: readonly string[]) {
  await Promise.all(names.map(async (name) => {
    try {
      const gltf = await gltfLoader.loadAsync(`/models/${dir}/${name}.glb`)
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
  rebuildChunks()
  buildFloor()
})

/* -------------------------------------------------------------------------- */
/* Players                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
  dispose: () => void
  group: Group
  mixer: AnimationMixer
  actions: Record<string, AnimationAction>
  current: string
  /** Last observed dash state, so stale remote snapshots never retrigger it. */
  wasDashing: boolean
  dashAnimUntil: number
  bubble: Sprite
  bubbleCanvas: HTMLCanvasElement
  bubbleTexture: CanvasTexture
  bubbleText: string
  /** World-space bottom edge of the bubble; it grows upward from here. */
  bubbleBaseY: number
  /** Ground decal under the feet; fades out as the character leaves the floor. */
  blob: Mesh<PlaneGeometry, MeshBasicMaterial>
}

const playerGroup = new Group()
scene.value.add(playerGroup)
const rigs = new Map<string, Rig>()

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

/** Nameplate sprite: a 4:1 canvas at 2× the old resolution, drawn into a world
 *  box ~30% smaller. Crispness comes from the texel density, not from the size. */
const NAME_SPRITE = { width: 1024, height: 256, scaleX: 1.12, scaleY: 0.28 }
/** Gap between the top of the head and the bottom of the nameplate. */
const NAME_GAP = 0.06

function makeTextSprite(
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void,
  options: { width: number, height: number, scaleX: number, scaleY: number } = { width: 512, height: 128, scaleX: 1.6, scaleY: 0.4 },
) {
  const canvas = document.createElement('canvas')
  canvas.width = options.width
  canvas.height = options.height
  const ctx = canvas.getContext('2d')!
  draw(ctx, canvas)
  const texture = new CanvasTexture(canvas)
  // Text stays crisp without mipmap blur, and the bubble canvas grows to a
  // non-power-of-two height, so skip mipmaps entirely.
  texture.minFilter = LinearFilter
  // The canvas holds sRGB pixels. Left unmarked they are read as linear and
  // re-encoded on output, which lifts the near-black bubble fill to grey.
  texture.colorSpace = SRGBColorSpace
  // Names and bubbles are UI, not lit geometry: keep them out of the ACES
  // curve and the fog so they read the same at noon and at midnight.
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false }))
  // Bubbles keep the default box only until their first message, then rescale
  // themselves to fit their wrapped text.
  sprite.scale.set(options.scaleX, options.scaleY, 1)
  return { sprite, canvas, texture }
}

function drawName(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, name: string, color: string) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  // Metrics ride the canvas height so the plate looks identical at any
  // resolution. The stroke stays thin enough not to fatten the letterforms.
  ctx.font = `600 ${Math.round(canvas.height * 0.34)}px Archivo, ui-sans-serif, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = Math.max(2, Math.round(canvas.height * 0.055))
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.62)'
  ctx.strokeText(name, canvas.width / 2, canvas.height / 2)
  ctx.fillStyle = color
  ctx.fillText(name, canvas.width / 2, canvas.height / 2)
}

/* Chat-bubble geometry. The canvas stays a fixed 512px wide; its height grows
 * with the wrapped line count and the sprite is rescaled to match (see
 * BUBBLE_TEXELS_PER_UNIT), so text keeps a constant, crisp size instead of
 * being squished onto a single line. */
const BUBBLE_CANVAS_WIDTH = 512
const BUBBLE_FONT = '500 36px Archivo, ui-sans-serif, sans-serif'
const BUBBLE_LINE_HEIGHT = 46
const BUBBLE_PAD_X = 26
const BUBBLE_PAD_Y = 18
const BUBBLE_RADIUS = 22
/** The little pointer under the box, aimed at the speaker. */
const BUBBLE_TAIL_W = 26
const BUBBLE_TAIL_H = 14
const BUBBLE_MAX_TEXT_WIDTH = BUBBLE_CANVAS_WIDTH - BUBBLE_PAD_X * 2
const BUBBLE_MAX_LINES = 6
/** Canvas px per world unit — keeps texel density constant as the box grows.
 *  Higher = smaller bubble in the world (text stays crisp, just physically
 *  smaller than the nameplate). */
const BUBBLE_TEXELS_PER_UNIT = 500
const BUBBLE_WIDTH_UNITS = BUBBLE_CANVAS_WIDTH / BUBBLE_TEXELS_PER_UNIT

/** Greedily wrap `text` into lines no wider than `maxWidth`, hard-breaking any
 *  single word that overflows on its own. `ctx.font` must already be set. */
function wrapBubbleLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = []
  let line = ''
  const flush = () => {
    if (line) lines.push(line)
  }
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    // The word won't fit on the current line: start a new one with it, then
    // hard-break the word itself if it's still too wide on its own.
    flush()
    line = word
    while (ctx.measureText(line).width > maxWidth && line.length > 1) {
      let cut = line.length - 1
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  flush()
  return lines
}

/** Draw a rounded speech bubble, wrapping long messages across lines. Returns
 *  the canvas height so the caller can rescale the sprite to keep text crisp. */
function drawBubble(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, text: string) {
  ctx.font = BUBBLE_FONT
  let lines = wrapBubbleLines(ctx, text, BUBBLE_MAX_TEXT_WIDTH)
  if (lines.length > BUBBLE_MAX_LINES) {
    lines = lines.slice(0, BUBBLE_MAX_LINES)
    lines[BUBBLE_MAX_LINES - 1] = `${lines[BUBBLE_MAX_LINES - 1]!.slice(0, -1).trimEnd()}…`
  }
  let textWidth = 0
  for (const line of lines) textWidth = Math.max(textWidth, ctx.measureText(line).width)

  // Leave a 2px gutter so the ring stroke isn't clipped at the canvas edge.
  const boxWidth = Math.min(textWidth + BUBBLE_PAD_X * 2, BUBBLE_CANVAS_WIDTH - 4)
  const boxHeight = Math.max(lines.length, 1) * BUBBLE_LINE_HEIGHT + BUBBLE_PAD_Y * 2
  const totalHeight = boxHeight + BUBBLE_TAIL_H + 2

  // Resizing the canvas clears it and resets the 2D context, so re-set state.
  canvas.height = totalHeight
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = BUBBLE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // One path for the rounded box plus its tail, so the ring outlines both. The
  // look mirrors the HUD's glass panels (black/35 + a faint white ring).
  const cx = canvas.width / 2
  const left = cx - boxWidth / 2
  const right = cx + boxWidth / 2
  const top = 2
  const bottom = top + boxHeight
  const r = BUBBLE_RADIUS
  ctx.beginPath()
  ctx.moveTo(left + r, top)
  ctx.arcTo(right, top, right, bottom, r)
  ctx.arcTo(right, bottom, left, bottom, r)
  ctx.lineTo(cx + BUBBLE_TAIL_W / 2, bottom)
  ctx.lineTo(cx, bottom + BUBBLE_TAIL_H)
  ctx.lineTo(cx - BUBBLE_TAIL_W / 2, bottom)
  ctx.arcTo(left, bottom, left, top, r)
  ctx.arcTo(left, top, right, top, r)
  ctx.closePath()
  ctx.fillStyle = 'rgba(10, 12, 18, 0.9)'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.stroke()

  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)'
  lines.forEach((line, i) => {
    ctx.fillText(line, cx, top + BUBBLE_PAD_Y + BUBBLE_LINE_HEIGHT * (i + 0.5))
  })
  return totalHeight
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
  const outfitMaterials = applyOutfitColor(model, outfitColorTexture(outfitOf(characterName), player.outfitColor ?? 0))
  // After the outfit swap: cloning a material drops its shader hooks, so the
  // rim has to be installed on whatever materials the rig ends up with.
  applyCharacterRim(model)
  // Skinned meshes must keep rendering when bones move them outside their
  // original bounds.
  model.traverse((obj) => {
    if (obj instanceof SkinnedMesh) obj.frustumCulled = false
    if (obj instanceof Mesh) obj.castShadow = true
  })
  group.add(model)

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

  const name = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, player.name, player.color), NAME_SPRITE)
  name.sprite.position.y = headHeight + NAME_GAP + NAME_SPRITE.scaleY / 2
  group.add(name.sprite)

  // Bubbles are centered on their sprite and grow upward from this bottom edge,
  // which sits just clear of the top of the nameplate.
  const bubbleBaseY = headHeight + NAME_GAP + NAME_SPRITE.scaleY + 0.04
  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.y = bubbleBaseY + bubble.sprite.scale.y / 2
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  const blob = makeBlobShadow()
  group.add(blob)

  playerGroup.add(group)
  atmosphere.setupShadows()
  bumpSceneVersion()
  return {
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      disposeCharacterSkeleton(model)
      name.texture.dispose()
      name.sprite.material.dispose()
      bubble.texture.dispose()
      bubble.sprite.material.dispose()
      blob.material.dispose()
      // The outfit swap clones the cloth materials per rig; the shared texture
      // and the template's own materials stay.
      for (const material of outfitMaterials) material.dispose()
    },
    group,
    mixer,
    actions,
    current: CLIP.idle,
    wasDashing: false,
    dashAnimUntil: 0,
    bubble: bubble.sprite,
    bubbleCanvas: bubble.canvas,
    bubbleTexture: bubble.texture,
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
syncChunks(local.x, local.y)

/** Longest the third-person boom extends behind the player, in tiles. */
const MAX_BOOM = 3.6
/** Camera's collision half-width, so the boom samples its footprint, not a hairline. */
const CAM_RADIUS = 0.32
/** Smoothed boom distance: snaps in past walls, eases back out (see the render loop). */
let boomDist = MAX_BOOM

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

// The active camera may register after setup, so configure it lazily.
let cameraConfigured = false
function configureCamera() {
  if (cameraConfigured || !(camera.value instanceof PerspectiveCamera)) return
  camera.value.fov = 62
  camera.value.near = 0.05
  camera.value.far = 260
  camera.value.updateProjectionMatrix()
  cameraConfigured = true
}
configureCamera()

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
      build,
      owner: id => props.game.players.get(id),
    })

/** Client-side echo of the server's edit budget, so a held mouse button can't
 *  outrun it and collect a stream of `slow down` toasts. */
const EDIT_INTERVAL = 1000 / EDITS_PER_SECOND
let nextEditAt = 0

/** Send the armed tool's verb at the current target. Terrain is applied locally
 *  first and reconciled by the server's own delta, whose heights are absolute
 *  and overwrite whatever we guessed. */
function applyTool(target: ReturnType<NonNullable<typeof buildTools>['update']>) {
  const slot = build.active.value
  if (!target || !slot) return
  const now = Date.now()
  if (now < nextEditAt) return
  nextEditAt = now + EDIT_INTERVAL
  if (slot.id === 'demolish') {
    if (target.id) props.game.sendDemolish(target.id)
    return
  }
  if (slot.kind) {
    props.game.sendBuild(slot.kind, target.x, target.y, build.rot.value)
    return
  }
  const mode = slot.id as 'raise' | 'lower' | 'flatten' | 'paint'
  const size = build.size.value
  const surface = build.surface.value
  props.game.sendTerraform(target.x, target.y, mode, size, mode === 'paint' ? surface : undefined)
  if (target.ok) {
    stream.predictTerrain({ x: target.x, y: target.y, mode, size, surface: surface as SurfaceType, maxStep: TERRAFORM_STEP })
  }
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

/* -------------------------------------------------------------------------- */
/* Hub Oracle: the ancient seer by the arena wall. Unlike the player           */
/* characters (shared universal skeleton + shared clips), this monster carries */
/* its own rig and animation clips inside its GLB, so it gets its own mixer.   */
/* -------------------------------------------------------------------------- */

let oracleTemplate: Group | null = null
let oracleClips: AnimationClip[] = []
let oracleLoading = false

function ensureOracle() {
  if (oracleTemplate || oracleLoading) return
  oracleLoading = true
  gltfLoader.loadAsync('/models/monsters/MushroomKing.glb').then((gltf) => {
    oracleTemplate = gltf.scene
    oracleClips = gltf.animations
  })
}

/** Scaled height — taller than the ~1.3-unit players, so the Oracle looms. */
const ORACLE_HEIGHT = 2.2

function createOracleRig(): OracleRig | null {
  if (!oracleTemplate) {
    ensureOracle()
    return null
  }
  const group = new Group()

  const model = SkeletonUtils.clone(oracleTemplate)
  // The source model isn't in game units; normalize it to a fixed height and
  // sit its lowest point on the ground regardless of the pivot.
  model.updateMatrixWorld(true)
  const raw = new Box3().setFromObject(model)
  const scale = ORACLE_HEIGHT / Math.max(0.001, raw.max.y - raw.min.y)
  model.scale.setScalar(scale)
  model.traverse((obj) => {
    if (obj instanceof SkinnedMesh) obj.frustumCulled = false
    if (obj instanceof Mesh) obj.castShadow = true
  })
  applyCharacterRim(model)
  group.add(model)
  const op = oraclePos()
  group.position.set(op.x, -raw.min.y * scale, op.y)
  group.rotation.y = op.rot

  const mixer = new AnimationMixer(model)
  const idle = oracleClips.find(clip => clip.name === 'Idle') ?? oracleClips[0]
  if (idle) mixer.clipAction(idle).play()

  // A floating name and a cool arcane glow so it reads as the Oracle.
  const label = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, 'The Oracle', '#bfe6ff'), NAME_SPRITE)
  label.sprite.position.set(0, ORACLE_HEIGHT + NAME_GAP + NAME_SPRITE.scaleY / 2, 0)
  group.add(label.sprite)
  const glow = new PointLight('#7fd0ff', 5, 7, 1.6)
  glow.position.set(0, ORACLE_HEIGHT * 0.6, 0)
  group.add(glow)

  // Speech bubble (hidden until the Oracle speaks in chat), like the players'.
  const bubbleBaseY = ORACLE_HEIGHT + NAME_GAP + NAME_SPRITE.scaleY + 0.04
  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.set(0, bubbleBaseY + bubble.sprite.scale.y / 2, 0)
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  floorGroup.add(group)
  atmosphere.setupShadows()
  bumpSceneVersion()
  return {
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      // Geometry and materials belong to the shared template; only this clone's
      // bone texture, its labels and its light are ours to release.
      disposeCharacterSkeleton(model)
      label.texture.dispose()
      label.sprite.material.dispose()
      bubble.texture.dispose()
      bubble.sprite.material.dispose()
      glow.dispose()
    },
    group, mixer, bubble: bubble.sprite, bubbleCanvas: bubble.canvas, bubbleTexture: bubble.texture, bubbleText: '', bubbleBaseY,
  }
}

onBeforeRender(({ delta }) => {
  if (sceneDisposed) return
  configureCamera()
  // Stream the world around the predicted self. Phase 3 replaces this with the
  // server's loaded set; the hooks it calls are the same four.
  syncChunks(local.x, local.y)
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
      const dash = selfDashing ? DASH_MULTIPLIER : 1
      const speed = PLAYER_SPEED * dash * dt / len
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
      local.x += (ex - along * tx) * k
      local.y += (ey - along * ty) * k
      if (along > 0) {
        local.x += along * tx * k
        local.y += along * ty * k
      }
    }
    else if (Math.hypot(ex, ey) > RECONCILE_IDLE_FREEZE) {
      // Idle: only chase real disagreement; small stop-overshoot is left be.
      local.x += ex * k
      local.y += ey * k
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
    const pitch = props.view.pitch
    const headX = local.x
    const headZ = local.y
    // Boom collision: snap IN immediately when a wall intrudes (so the camera
    // never lags behind it and flashes the void), but ease back OUT smoothly so
    // it zooms rather than popping once the wall is clear.
    const camHeight = Math.max(local.z + 0.35, local.z + 1.5 + pitch * 1.8)
    const targetBoom = clipBoom(headX, headZ, -Math.cos(yaw), -Math.sin(yaw), MAX_BOOM, Math.min(camHeight, local.z + 1))
    boomDist = targetBoom < boomDist
      ? targetBoom
      : boomDist + (targetBoom - boomDist) * (1 - Math.exp(-dt * 9))
    camera.value.position.set(
      headX - Math.cos(yaw) * boomDist,
      camHeight,
      headZ - Math.sin(yaw) * boomDist,
    )
    camera.value.lookAt(
      headX + Math.cos(yaw) * 1.2,
      local.z + 1 - pitch * 1.2,
      headZ + Math.sin(yaw) * 1.2,
    )
    torchLight.position.set(headX, local.z + 1.7, headZ)
  }

  // Aim after the camera has moved: the crosshair ray is the camera's own
  // forward axis, so a frame-old transform would aim a frame behind the view.
  if (buildTools) {
    buildTools.setVisible(self != null)
    const target = self ? buildTools.update(local, selfId) : null
    if (build.fireQueued.value) {
      build.fireQueued.value = false
      applyTool(target)
    }
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

  // Reconcile player rigs with the roster.
  for (const [id, rig] of rigs) {
    if (!props.game.players.has(id)) {
      playerGroup.remove(rig.group)
      rig.dispose()
      rigs.delete(id)
      bumpSceneVersion()
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
    else if (moving) setAnimation(rig, CLIP.run, 1.15)
    else setAnimation(rig, CLIP.idle)
    rig.mixer.update(dt)

    // Chat bubble: redraw when the text changes, fade out at the end.
    if (player.bubble && player.bubble.until > now) {
      if (rig.bubbleText !== player.bubble.text) {
        rig.bubbleText = player.bubble.text
        const height = drawBubble(rig.bubbleCanvas.getContext('2d')!, rig.bubbleCanvas, player.bubble.text)
        rig.bubbleTexture.needsUpdate = true
        rig.bubble.scale.set(BUBBLE_WIDTH_UNITS, height / BUBBLE_TEXELS_PER_UNIT, 1)
        rig.bubble.position.y = rig.bubbleBaseY + rig.bubble.scale.y / 2
      }
      rig.bubble.visible = true
      rig.bubble.material.opacity = Math.min(1, (player.bubble.until - now) / 300)
    }
    else {
      rig.bubble.visible = false
      rig.bubbleText = ''
    }
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
  // Shader clocks are `uniform float`: at epoch scale (~1.79e9) a float32's ULP
  // is 128 s, so wind and ripples would sit perfectly still. Wrap what reaches
  // a uniform; the fountain keeps absolute seconds because its particle sim
  // integrates frame deltas and resets when time jumps backwards.
  const worldSeconds = serverNow / 1000
  const shaderSeconds = worldSeconds % SHADER_CLOCK_WRAP
  foliageTime.value = shaderSeconds
  courtyard?.update(worldSeconds, shaderSeconds, waterActors)

  // Hub Oracle: spawn it once its model lands, run its idle animation, float a
  // bubble when it speaks in chat, and track proximity (drives the HUD hint).
  oracleRig ??= createOracleRig()
  const op = oraclePos()
  if (oracleRig) {
    oracleRig.mixer.update(dt)
    // Follow the authored pose (live while dragging/rotating in the editor;
    // constant in play).
    oracleRig.group.position.x = op.x
    oracleRig.group.position.z = op.y
    oracleRig.group.rotation.y = op.rot
    const speech = oracle.speech.value
    if (speech && speech.until > now) {
      if (oracleRig.bubbleText !== speech.text) {
        oracleRig.bubbleText = speech.text
        const height = drawBubble(oracleRig.bubbleCanvas.getContext('2d')!, oracleRig.bubbleCanvas, speech.text)
        oracleRig.bubbleTexture.needsUpdate = true
        oracleRig.bubble.scale.set(BUBBLE_WIDTH_UNITS, height / BUBBLE_TEXELS_PER_UNIT, 1)
        oracleRig.bubble.position.y = oracleRig.bubbleBaseY + oracleRig.bubble.scale.y / 2
      }
      oracleRig.bubble.visible = true
      oracleRig.bubble.material.opacity = Math.min(1, (speech.until - now) / 300)
    }
    else {
      oracleRig.bubble.visible = false
      oracleRig.bubbleText = ''
    }
  }
  oracle.near.value = self ? Math.hypot(local.x - op.x, local.y - op.y) < ORACLE_NEAR : false
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
      getOracle: () => oracleRig?.group,
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
  pipeline?.dispose()
  for (const rig of rigs.values()) rig.dispose()
  rigs.clear()
  clearFloor()
  clearChunks()
  for (const off of unsubscribe) off()
  unsubscribe.length = 0
  if (townRebuild) clearTimeout(townRebuild)
  buildTools?.dispose()
  chunkProps.dispose()
  grassBank.dispose()
  pavingBank.dispose()
  terrainMaterial.dispose()
  editorCtl?.dispose()
  editorCtl = null
  blobGeometry.dispose()
  blobTexture?.dispose()
  blobTexture = null
  releaseTemplates([...propTemplates.values(), ...retiredTemplates, ...(oracleTemplate ? [oracleTemplate] : [])])
  oracleTemplate = null
  propTemplates.clear()
  townMaterials.dispose()
  retiredTemplates.length = 0
  atmosphere.dispose()
  scene.value.remove(torchLight, floorGroup, playerGroup)
}
onMounted(() => emit('ready', disposeScene))
onBeforeUnmount(disposeScene)

if (import.meta.dev) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__maze = { local, camera, game: props.game, held: props.held, view: props.view }
}
</script>

<template>
  <TresGroup />
</template>
