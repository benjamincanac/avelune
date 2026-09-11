<script setup lang="ts">
import {
  AnimationMixer,
  Box3,
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { AnimationAction, AnimationClip, BufferGeometry } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { FloorPlan, HubPropPlacement } from '#shared/utils/maze'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  HUB_LAYOUT,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  isWalkable,
  surfaceHeight,
  stepBody,
} from '#shared/utils/maze'
import HUB_ORACLE from '#shared/data/courtyard-oracle.json'
import { isRampartCameraBlocked } from '#shared/utils/ramparts'
import { createCourtyardAssets } from '~/utils/courtyardAssets'
import { createCourtyardScene } from '~/utils/courtyardScene'
import type { FountainInteractor } from '~/utils/fountainWater'
import { createCourtyardSky } from '~/utils/courtyardSky'
import { COURTYARD_LANDSCAPE_NAMES } from '~/utils/courtyardLandscape'
import { createCourtyardRenderer } from '~/utils/courtyardRenderer'
import { createHubEditor } from '~/utils/hubEditor'
import type { HubEditor } from '~/utils/hubEditor'
import { characterFor, isCharacter, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'
import { disposeCharacterSkeleton, loadCharacterAsset } from '~/utils/characterModels'
import type { CharacterAsset } from '~/utils/characterModels'

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

/** The arena is hand-authored and constant, in play and in the editor alike —
 *  build its plan once and read it everywhere. */
const hubPlan = generateHub()

const waterActors: FountainInteractor[] = []
let courtyard: ReturnType<typeof createCourtyardScene> | null = null

/** Everything world-shaped lives here so a rebuild can swap it wholesale. */
const floorGroup = new Group()
scene.value.add(floorGroup)

// The Oracle NPC — a monster (Quaternius Ultimate Monsters) as the arena's
// ancient seer. Declared here (before the synchronous initial buildFloor) so
// buildFloor can reset it on a rebuild.
/** Where the Oracle stands, in tiles. Editable via the hub 'Oracle' marker: in
 *  the editor it follows the live (draggable) marker; in play it's the saved
 *  position from courtyard-oracle.json. */
function oraclePos(): { x: number, y: number } {
  if (props.editor && ed?.current.value.oracle) return ed.current.value.oracle
  const [x, y] = HUB_ORACLE as [number, number]
  return { x, y }
}
/** Within this many tiles the runner may consult it (drives the HUD prompt). */
const ORACLE_NEAR = 7
interface OracleRig {
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
 */
function tagShadows(root: Group) {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const mat = o.material
    const opaqueStd = mat instanceof MeshStandardMaterial && !mat.transparent
    o.castShadow = opaqueStd && !(o.geometry instanceof PlaneGeometry)
    o.receiveShadow = opaqueStd
  })
}

function clearFloor() {
  if (courtyard) {
    floorGroup.remove(courtyard.group)
    courtyard.dispose()
    courtyard = null
  }
  // Instance buffers and cloned materials belong to this floor; template
  // geometries are reused on the next build and stay alive until unmount.
  floorGroup.traverse((obj) => {
    if (!(obj instanceof InstancedMesh)) return
    obj.dispose()
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) material.dispose()
  })
  floorGroup.clear()
}

function buildFloor() {
  clearFloor()
  // floorGroup.clear() detached the Oracle; drop the ref so it gets rebuilt.
  oracleRig = null

  const plan = hubPlan

  courtyard = createCourtyardScene(ed?.placements.value ?? plan.props, propTemplates)
  floorGroup.add(courtyard.group)
  renderPlanProps(plan)
  tagShadows(floorGroup)
  // Re-sync the editor's own selectable clones (templates may have just
  // finished loading, so this runs after each build phase).
  editorCtl?.rebuild()
}

/**
 * Render a plan's props as instanced batches per kind, exactly where the server
 * simulates their footprints. In editor mode, hand-placed props (incl. the
 * baked structure) are skipped so the editor controller can clone them as
 * individually selectable objects instead of drawing them twice.
 */
function renderPlanProps(plan: FloorPlan) {
  const solids = new Map<string, Matrix4[]>()
  for (const p of plan.props) {
    if (props.editor && p.hand) continue
    const arr = solids.get(p.kind) ?? []
    arr.push(propMatrix(p))
    solids.set(p.kind, arr)
  }
  for (const [kind, mats] of solids) {
    const g = instantiateModule(kind, mats)
    if (g) floorGroup.add(g)
  }
}

/** Instance matrix for a placed piece, honoring elevation (`z`) and per-axis
 *  scale (`s3`). `PropSpec` is structurally a `HubPropPlacement` with collision
 *  fields, so both plan props and composed pieces go through here. */
function propMatrix(p: HubPropPlacement): Matrix4 {
  return p.s3
    ? placementMatrixScaled(p.x, p.z ?? 0, p.y, p.rot, p.s3[0], p.s3[1], p.s3[2])
    : placementMatrix(p.x, p.z ?? 0, p.y, p.rot, p.scale)
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
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop' } as const

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

const placementDummy = new Object3D()
function placementMatrix(x: number, y: number, z: number, rotY: number, scale: number): Matrix4 {
  placementDummy.position.set(x, y, z)
  placementDummy.rotation.set(0, rotY, 0)
  placementDummy.scale.setScalar(scale)
  placementDummy.updateMatrix()
  return placementDummy.matrix.clone()
}

/**
 * Like `placementMatrix` but with per-axis scale, so a kit piece can be
 * stretched on one axis without touching the others. Scale is applied in the
 * module's local frame before the Y-rotation, so widening never shears it.
 */
function placementMatrixScaled(x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number): Matrix4 {
  placementDummy.position.set(x, y, z)
  placementDummy.rotation.set(0, rotY, 0)
  placementDummy.scale.set(sx, sy, sz)
  placementDummy.updateMatrix()
  return placementDummy.matrix.clone()
}

/**
 * Instance a GLB module at many placements: one InstancedMesh per mesh part,
 * with the part's own transform baked into every instance matrix.
 */
function instantiateModule(name: string, placements: Matrix4[], tint = '#ffffff'): Group | null {
  const template = propTemplates.get(name)
  if (!template || !placements.length) return null
  template.updateMatrixWorld(true)
  const group = new Group()
  const composed = new Matrix4()
  template.traverse((obj) => {
    if (!(obj instanceof Mesh)) return
    const material = (obj.material as MeshStandardMaterial).clone()
    material.color.multiply(new Color(tint))
    const instanced = new InstancedMesh(obj.geometry, material, placements.length)
    placements.forEach((placement, index) => {
      composed.multiplyMatrices(placement, obj.matrixWorld)
      instanced.setMatrixAt(index, composed)
    })
    group.add(instanced)
  })
  return group
}

const propTemplates = createCourtyardAssets()
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

loadTemplates('courtyard', ['fountain', 'inn', 'shop', 'tower', ...COURTYARD_LANDSCAPE_NAMES]).then(() => {
  if (sceneDisposed) return
  for (const [kind, file] of [['Courtyard_Inn', 'inn'], ['Courtyard_Shop', 'shop'], ['Courtyard_Tower', 'tower'], ['Courtyard_Fountain', 'fountain'], ['Courtyard_Tree', 'tree']] as const) {
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
      const source = propTemplates.get('bush')
      if (!source) continue
      const bush = fitTemplate(source, 1, 0.55, 0.95)
      bush.position.set(x, 0.64, 0)
      planter.add(bush)
    }
    for (const x of [-1.1, -0.4, 0.4, 1.1]) {
      const source = propTemplates.get('flowers')
      if (!source) continue
      const flowers = fitTemplate(source, null, 0.55, null)
      flowers.position.set(x, 0.68, 0.2)
      planter.add(flowers)
    }
  }
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
  /** While non-zero, the one-shot dash lunge is playing. */
  dashAnimUntil: number
  bubble: Sprite
  bubbleCanvas: HTMLCanvasElement
  bubbleTexture: CanvasTexture
  bubbleText: string
  /** World-space bottom edge of the bubble; it grows upward from here. */
  bubbleBaseY: number
}

const playerGroup = new Group()
scene.value.add(playerGroup)
const rigs = new Map<string, Rig>()

function makeTextSprite(draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  draw(ctx, canvas)
  const texture = new CanvasTexture(canvas)
  // Text stays crisp without mipmap blur, and the bubble canvas grows to a
  // non-power-of-two height, so skip mipmaps entirely.
  texture.minFilter = LinearFilter
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  // Nameplate size (512×128 canvas at 4:1). Bubbles keep this only until their
  // first message, then rescale themselves to fit their wrapped text.
  sprite.scale.set(1.6, 0.4, 1)
  return { sprite, canvas, texture }
}

function drawName(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, name: string, color: string) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = '600 44px Geist, ui-sans-serif, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 10
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
  ctx.strokeText(name, 256, 64)
  ctx.fillStyle = color
  ctx.fillText(name, 256, 64)
}

/* Chat-bubble geometry. The canvas stays a fixed 512px wide; its height grows
 * with the wrapped line count and the sprite is rescaled to match (see
 * BUBBLE_TEXELS_PER_UNIT), so text keeps a constant, crisp size instead of
 * being squished onto a single line. */
const BUBBLE_CANVAS_WIDTH = 512
const BUBBLE_FONT = '40px Geist, ui-sans-serif, sans-serif'
const BUBBLE_LINE_HEIGHT = 52
const BUBBLE_PAD_X = 28
const BUBBLE_PAD_Y = 22
const BUBBLE_MAX_TEXT_WIDTH = BUBBLE_CANVAS_WIDTH - BUBBLE_PAD_X * 2
const BUBBLE_MAX_LINES = 6
/** Canvas px per world unit — keeps texel density constant as the box grows.
 *  Higher = smaller bubble in the world (text stays crisp, just physically
 *  smaller than the nameplate). */
const BUBBLE_TEXELS_PER_UNIT = 460
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

  const boxWidth = Math.min(textWidth + BUBBLE_PAD_X * 2, BUBBLE_CANVAS_WIDTH)
  const boxHeight = Math.max(lines.length, 1) * BUBBLE_LINE_HEIGHT + BUBBLE_PAD_Y * 2

  // Resizing the canvas clears it and resets the 2D context, so re-set state.
  canvas.height = boxHeight
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = BUBBLE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.beginPath()
  ctx.roundRect((canvas.width - boxWidth) / 2, 0, boxWidth, boxHeight, 24)
  ctx.fill()

  ctx.fillStyle = '#111827'
  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, BUBBLE_PAD_Y + BUBBLE_LINE_HEIGHT * (i + 0.5))
  })
  return boxHeight
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
  applyOutfitColor(model, outfitColorTexture(outfitOf(characterName), player.outfitColor ?? 0))
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

  const name = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, player.name, player.color))
  name.sprite.position.y = headHeight + 0.22
  group.add(name.sprite)

  // The bubble is centered on its sprite, so its default 0.4-tall box sits with
  // its bottom edge 0.2 below the center — anchor growth from that bottom.
  const bubbleBaseY = headHeight + 0.32
  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.y = bubbleBaseY + bubble.sprite.scale.y / 2
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  playerGroup.add(group)
  return {
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      disposeCharacterSkeleton(model)
      name.texture.dispose()
      name.sprite.material.dispose()
      bubble.texture.dispose()
      bubble.sprite.material.dispose()
    },
    group,
    mixer,
    actions,
    current: CLIP.idle,
    dashAnimUntil: 0,
    bubble: bubble.sprite,
    bubbleCanvas: bubble.canvas,
    bubbleTexture: bubble.texture,
    bubbleText: '',
    bubbleBaseY,
  }
}

/** Crossfade a rig to a clip (falls back to Idle if the clip is missing). */
function setAnimation(rig: Rig, name: string, timeScale = 1) {
  const target = rig.actions[name] ? name : CLIP.idle
  const action = rig.actions[target]
  if (!action) return
  if (rig.current !== target) {
    const previous = rig.actions[rig.current]
    previous?.fadeOut(0.15)
    action.reset().fadeIn(0.15).play()
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
  x: hubPlan.start.x,
  y: hubPlan.start.y,
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
 * How far the camera can sit behind the player before a wall blocks it. Marches
 * from the head toward the ideal camera spot, sampling the camera's *width*
 * (centre plus both flanks) at each step so it can't slip through a wall corner
 * and briefly expose the void behind it. Returns the last clear distance.
 */
function clipBoom(hx: number, hy: number, dirX: number, dirZ: number, maxDist: number, height: number): number {
  const px = -dirZ // unit perpendicular to the boom, for width sampling
  const pz = dirX
  const blocked = (x: number, z: number) => !isWalkable(hubPlan, Math.floor(x), Math.floor(z))
    || surfaceHeight(hubPlan, x, z) > height - CAM_RADIUS
    || isRampartCameraBlocked(x, z, height, CAM_RADIUS)
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

/** Scaled height — taller than the ~1.3-unit runners, so the Oracle looms. */
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
  group.add(model)
  const op = oraclePos()
  group.position.set(op.x, -raw.min.y * scale, op.y)
  // Face toward the arena centre, watching runners. (Flip by Math.PI if the
  // source model turns out to face the other way.)
  group.rotation.y = Math.atan2(HUB_LAYOUT.center.x - op.x, HUB_LAYOUT.center.y - op.y)

  const mixer = new AnimationMixer(model)
  const idle = oracleClips.find(clip => clip.name === 'Idle') ?? oracleClips[0]
  if (idle) mixer.clipAction(idle).play()

  // A floating name and a cool arcane glow so it reads as the Oracle.
  const label = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, 'The Oracle', '#bfe6ff'))
  label.sprite.position.set(0, ORACLE_HEIGHT + 0.3, 0)
  group.add(label.sprite)
  const glow = new PointLight('#7fd0ff', 5, 7, 1.6)
  glow.position.set(0, ORACLE_HEIGHT * 0.6, 0)
  group.add(glow)

  // Speech bubble (hidden until the Oracle speaks in chat), like the players'.
  const bubbleBaseY = ORACLE_HEIGHT + 0.42
  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.set(0, bubbleBaseY + bubble.sprite.scale.y / 2, 0)
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  floorGroup.add(group)
  return { group, mixer, bubble: bubble.sprite, bubbleCanvas: bubble.canvas, bubbleTexture: bubble.texture, bubbleText: '', bubbleBaseY }
}

onBeforeRender(({ delta }) => {
  if (sceneDisposed) return
  configureCamera()
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
    stepBody(hubPlan, local, dx, dy, dt)

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

  if (camera.value && renderer.instance instanceof WebGLRenderer) {
    atmosphere.update(serverNow, dt, camera.value, renderer.instance, local.x, local.y, props.game.weather.value, props.game.timeOfDay.value)
  }

  // Reconcile player rigs with the roster.
  for (const [id, rig] of rigs) {
    if (!props.game.players.has(id)) {
      playerGroup.remove(rig.group)
      rig.dispose()
      rigs.delete(id)
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
      airborne = player.z > 0.12 || player.rz > 0.12
      dashing = player.dashing === true
    }

    rig.group.position.set(player.rx, player.rz, player.ry)
    rig.group.rotation.y = -player.ra

    // The dash plays the sprint loop. Its speed burst only lasts DASH_DURATION,
    // so on the dash's rising edge we latch a slightly longer window and hold
    // the sprint for it, letting it read as a burst before run/idle resume.
    // START is the sprint's rate at the burst; it eases linearly to END across
    // the window so the sprint decelerates into run/idle instead of cutting off.
    const DASH_ANIM_START_RATE = 1.5
    const DASH_ANIM_END_RATE = 1.0
    const DASH_ANIM_WINDOW = 0.5
    if (dashing && now >= rig.dashAnimUntil) rig.dashAnimUntil = now + DASH_ANIM_WINDOW * 1000

    // Animation state: dash > airborne > run > idle. Sustain the sprint past
    // the burst only while actually moving; a standstill dash stops
    // translating when the burst ends, so we drop to idle then, not churn.
    if (now < rig.dashAnimUntil && (dashing || moving)) {
      // remain: 1 at the start of the window, 0 at its end — a linear ramp.
      const remain = (rig.dashAnimUntil - now) / (DASH_ANIM_WINDOW * 1000)
      setAnimation(rig, CLIP.dash, DASH_ANIM_END_RATE + (DASH_ANIM_START_RATE - DASH_ANIM_END_RATE) * remain)
    }
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
  courtyard?.update(serverNow / 1000, waterActors)

  // Hub Oracle: spawn it once its model lands, run its idle animation, float a
  // bubble when it speaks in chat, and track proximity (drives the HUD hint).
  oracleRig ??= createOracleRig()
  const op = oraclePos()
  if (oracleRig) {
    oracleRig.mixer.update(dt)
    // Follow the editable Oracle marker (live while dragging in the editor;
    // constant in play). Keep it facing the arena centre.
    oracleRig.group.position.x = op.x
    oracleRig.group.position.z = op.y
    oracleRig.group.rotation.y = Math.atan2(HUB_LAYOUT.center.x - op.x, HUB_LAYOUT.center.y - op.y)
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
      editor: ed,
      getSize: () => ed!.current.value.size,
    })
    editorCtl.rebuild()
    // Rebuild the scene on any structural change (seed / undo / redo). The
    // controller re-clones its placements off its own deep watch.
    watch(() => ed!.structureVersion.value, buildFloor)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__editor = ed
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
  editorCtl?.dispose()
  editorCtl = null
  releaseTemplates([...propTemplates.values(), ...retiredTemplates])
  propTemplates.clear()
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
