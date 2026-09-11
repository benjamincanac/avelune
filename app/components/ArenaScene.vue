<script setup lang="ts">
import {
  AdditiveBlending,
  AmbientLight,
  AnimationMixer,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  ShaderMaterial,
  SkinnedMesh,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import type { AnimationAction, AnimationClip } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { FloorPlan, HubPropPlacement } from '#shared/utils/arena'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  ARENA_LAYOUT,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  isWalkable,
  stepBody,
} from '#shared/utils/arena'
import {
  CASTLE_NAMES,
  CRYPT_NAMES,
  DUNGEON_NAMES,
  FANTASY_NAMES,
  NATURE_NAMES,
  PROP_DECOR_NAMES,
  PROP_NAMES,
  VILLAGE_NAMES,
} from '#shared/utils/propCatalog'
import ARENA_COACH from '#shared/data/arena-coach.json'

import type { StonePalette } from '~/utils/textures'
import { makeGrassTexture } from '~/utils/textures'
import { buildStadium, centerMarkTexture } from '~/utils/stadium'
import type { Stadium } from '~/utils/stadium'
import { buildLedFloor } from '~/utils/ledFloor'
import type { LedFloor } from '~/utils/ledFloor'
import { characterModel } from '#shared/utils/characters'
import { prepareDeveloper } from '~/utils/developerLook'
import { createCoachBody } from '~/utils/coach3d'
import type { CoachBody } from '~/utils/coach3d'
import { PALETTE } from '~/utils/palette'

/**
 * Vercel Stadium's 3D world, built imperatively with three.js inside the Tres context.
 *
 * Tres provides the renderer, scene, camera, and render loop. The arena is one
 * stadium: an LED tile floor (`app/utils/ledFloor.ts`) inside a procedural bowl
 * of tiers, crowd and LED brand bands (`app/utils/stadium.ts`), plus any
 * hand-placed kit props drawn as
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

const props = defineProps<{ game: UseGame, held: MoveInput, view: ViewState }>()

// Coach proximity/speech state, shared with GameScene and the HUD.
const coach = useCoach()

const { scene, camera: cameraManager } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender } = useLoop()

/** The stadium, once built; the render loop animates it. */
let stadium: Stadium | null = null
/** The LED floor, once built; the render loop lights it under the players. */
let ledFloor: LedFloor | null = null

/** Full day/night cycle length. */
const DAY_MS = 15 * 60 * 1000

/** The meadow the arena sits on, and the haze around it. */
const GROUND_PALETTE: StonePalette = { base: '#5f8440', dark: '#496a31', mortar: '#6d5c3d', moss: '#82a850', mossAmount: 0.5 }
const FOG_COLOR = '#3f4d34'
const FOG_DENSITY = 0.014

/* -------------------------------------------------------------------------- */
/* Static scene: lights, sky, rain                                            */
/* -------------------------------------------------------------------------- */

const fog = new FogExp2(FOG_COLOR, FOG_DENSITY)
scene.value.fog = fog
scene.value.background = new Color('#05070d')

const ambient = new AmbientLight('#8899bb', 0.4)
scene.value.add(ambient)

/** Sky/ground fill for soft outdoor bounce light. */
const hemi = new HemisphereLight('#bcd4ff', '#5a6a3a', 0.55)
scene.value.add(hemi)

/**
 * One directional light serves as sun by day and moon by night. It casts the
 * scene's shadows; the frustum follows the player (via `sun.target`) so a
 * modest map covers everything on screen.
 */
const sun = new DirectionalLight('#ffffff', 0.6)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.near = 1
sun.shadow.camera.far = 130
sun.shadow.camera.left = -34
sun.shadow.camera.right = 34
sun.shadow.camera.top = 34
sun.shadow.camera.bottom = -34
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 0.03
scene.value.add(sun, sun.target)

/** Warm torch light that follows your character. */
const torchLight = new PointLight('#ffc98a', 5, 11, 1.7)
scene.value.add(torchLight)

/** Rain: a box of points recycled around the camera. */
const RAIN_COUNT = 1000
const rainGeometry = new BufferGeometry()
{
  const positions = new Float32Array(RAIN_COUNT * 3)
  for (let i = 0; i < RAIN_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 24
    positions[i * 3 + 1] = Math.random() * 14
    positions[i * 3 + 2] = (Math.random() - 0.5) * 24
  }
  rainGeometry.setAttribute('position', new BufferAttribute(positions, 3))
}
const rainMaterial = new PointsMaterial({
  color: '#a8c0dd',
  size: 0.035,
  transparent: true,
  opacity: 0,
  depthWrite: false,
})
const rain = new Points(rainGeometry, rainMaterial)
rain.visible = false
scene.value.add(rain)

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Shared sky state: same clock for every client via the server time offset. */
function computeSky(now: number) {
  const t = (now / DAY_MS) % 1
  const sunAngle = t * Math.PI * 2 - Math.PI / 2
  const sunHeight = Math.sin(sunAngle)
  const seconds = now / 1000
  let overcast = clamp01(0.5 + 0.45 * Math.sin(seconds / 197) + 0.3 * Math.sin(seconds / 71 + 2.1))
  let rainAmount = clamp01((overcast - 0.68) / 0.32)
  let dayness = clamp01(sunHeight * 2 + 0.15)

  if (import.meta.dev) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const override = (window as any).__envOverride
    if (override) {
      dayness = override.dayness ?? dayness
      overcast = override.overcast ?? overcast
      rainAmount = override.rain ?? rainAmount
    }
  }
  return { sunAngle, sunHeight, dayness, overcast, rain: rainAmount }
}

const skyDay = new Color('#7d99bd')
const skyDusk = new Color('#8a5a40')
const skyNight = new Color('#05070d')
const skyColor = new Color()
const fogColor = new Color()

/* -------------------------------------------------------------------------- */
/* Sky: gradient dome + drifting clouds + sun glow                            */
/* -------------------------------------------------------------------------- */

/** Soft cloud puffs on a transparent canvas, wrapped around the cloud dome. */
function makeCloudCanvas(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const ctx = canvas.getContext('2d')!
  // Puffs sit in the lower band of the texture so they map near the horizon —
  // the only part of the sky this third-person ground camera actually shows.
  for (let i = 0; i < 30; i++) {
    const cx = Math.random() * 1024
    const cy = 250 + Math.random() * 210
    const puffs = 6 + Math.floor(Math.random() * 7)
    for (let j = 0; j < puffs; j++) {
      const x = cx + (Math.random() - 0.5) * 230
      const y = cy + (Math.random() - 0.5) * 90
      const r = 55 + Math.random() * 110
      const a = 0.12 + Math.random() * 0.18
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255,255,255,${a})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  return tex
}

/** Warm radial falloff for the sun glow sprite. */
function makeGlowCanvas(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,246,220,0.95)')
  g.addColorStop(0.3, 'rgba(255,226,170,0.4)')
  g.addColorStop(1, 'rgba(255,226,170,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new CanvasTexture(canvas)
}

// Gradient skydome: a camera-following sphere that ignores fog, so the horizon
// stays crisp behind the fogged geometry. Colors are set from the clock.
const skyTop = new Color()
const skyHorizon = new Color()
const horizonPale = new Color('#e6eef7')
const skyUniforms = {
  topColor: { value: new Color('#3a6ea5') },
  horizonColor: { value: new Color('#bcd3ee') },
  offset: { value: 0.04 },
  exponent: { value: 0.75 },
}
const skyDome = new Mesh(
  new SphereGeometry(80, 32, 16),
  new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 topColor; uniform vec3 horizonColor;
      uniform float offset; uniform float exponent;
      void main() {
        float h = max(vDir.y + offset, 0.0);
        float f = pow(min(h / (1.0 + offset), 1.0), exponent);
        gl_FragColor = vec4(mix(horizonColor, topColor, f), 1.0);
      }`,
  }),
)
skyDome.renderOrder = -3
scene.value.add(skyDome)

const cloudMaterial = new MeshBasicMaterial({
  map: makeCloudCanvas(),
  transparent: true,
  depthWrite: false,
  depthTest: false,
  fog: false,
})
const cloudDome = new Mesh(new SphereGeometry(78, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.66), cloudMaterial)
cloudDome.renderOrder = -2
scene.value.add(cloudDome)

const sunGlowMaterial = new SpriteMaterial({
  map: makeGlowCanvas(),
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: AdditiveBlending,
  fog: false,
})
const sunGlow = new Sprite(sunGlowMaterial)
sunGlow.scale.setScalar(30)
sunGlow.renderOrder = -1
scene.value.add(sunGlow)
const sunDir = new Vector3()

/* -------------------------------------------------------------------------- */
/* Arena geometry                                                             */
/* -------------------------------------------------------------------------- */

/** The arena is constant — build its plan once and read it everywhere. */
const hubPlan = generateArena()

/** Procedural grass under and around the arena, built once. */
let groundTexture: CanvasTexture | null = null
function ensureGroundTexture(): CanvasTexture {
  if (!groundTexture) {
    groundTexture = makeGrassTexture(7000, GROUND_PALETTE)
    groundTexture.wrapS = RepeatWrapping
    groundTexture.wrapT = RepeatWrapping
  }
  return groundTexture
}

/** Everything world-shaped lives here so a rebuild can swap it wholesale. */
const floorGroup = new Group()
scene.value.add(floorGroup)

// The Coach NPC — vercel.com's hero triangle floating over a bed of smoke
// (`app/utils/coach3d.ts`). Declared here (before the synchronous initial
// buildFloor) so buildFloor can reset it on a rebuild.
/** Where the Coach stands, in tiles (arena-coach.json). */
function coachPos(): { x: number, y: number } {
  const [x, y] = ARENA_COACH as [number, number]
  return { x, y }
}
/** Within this many tiles the runner may consult it (drives the HUD prompt). */
const COACH_NEAR = 7
interface CoachRig {
  group: Group
  body: CoachBody
  /** Speech bubble mirroring the players' — shows the Coach's latest chat line. */
  bubble: Sprite
  bubbleCanvas: HTMLCanvasElement
  bubbleTexture: CanvasTexture
  bubbleText: string
  /** World-space bottom edge of the bubble; it grows upward from here. */
  bubbleBaseY: number
}
let coachRig: CoachRig | null = null

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

function buildFloor() {
  floorGroup.clear()
  // floorGroup.clear() detached the Coach; drop the ref so it gets rebuilt.
  coachRig = null

  const plan = hubPlan

  // The meadow the stadium stands on — the sand disc covers its middle.
  const ground = ensureGroundTexture()
  ground.repeat.set(plan.width / 2, plan.height / 2)
  const meadow = new Mesh(
    new PlaneGeometry(plan.width, plan.height),
    new MeshStandardMaterial({ map: ground, roughness: 1 }),
  )
  meadow.rotation.x = -Math.PI / 2
  meadow.position.set(plan.width / 2, 0, plan.height / 2)
  floorGroup.add(meadow)

  buildArena(plan)
  tagShadows(floorGroup)
}

/* -------------------------------------------------------------------------- */
/* Stadium arena                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the arena: the LED floor with its centre mark, the stadium bowl around it,
 * and any hand-placed kit piece from `plan.props`. Collision comes from the
 * shared tile stamps in `generateArena`, not from anything drawn here.
 */
function buildArena(plan: FloorPlan) {
  const { center, arenaRadius } = ARENA_LAYOUT

  // --- The LED floor (never editable): black tiles that light up white underfoot.
  ledFloor = buildLedFloor()
  floorGroup.add(ledFloor.group)

  // The centre mark — the Vercel ▲ in glowing slime blue, inlaid in the floor.
  const mark = new Mesh(
    new CircleGeometry(arenaRadius * 0.7, 64),
    new MeshBasicMaterial({ map: centerMarkTexture(), color: new Color(PALETTE.slime), transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
  )
  mark.rotation.x = -Math.PI / 2
  mark.position.set(center.x, 0.05, center.y)
  floorGroup.add(mark)

  // --- The stadium bowl, crowd and brand lights: render-only, cached across rebuilds.
  stadium = buildStadium()
  floorGroup.add(stadium.group)

  // --- Hand-placed pieces from the shared plan, rendered exactly where the
  // server simulates their footprints.
  renderPlanProps(plan)
}

/**
 * Render a plan's props as instanced batches per kind, exactly where the server
 * simulates their footprints.
 */
function renderPlanProps(plan: FloorPlan) {
  const solids = new Map<string, Matrix4[]>()
  for (const p of plan.props) {
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

/**
 * Movement states → clip names in the shared library (Quaternius Universal
 * Animation Library 1 & 2). Since every character shares the universal
 * skeleton, one set of clips drives them all with no retargeting.
 */
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop' } as const

const characterTemplates = new Map<string, Group>()
const characterLoading = new Set<string>()

/** Clips ship in one shared GLB (skeleton + animations, no mesh), loaded once. */
let sharedClips: AnimationClip[] = []
let clipsLoading = false

function ensureCharacter(name: string) {
  if (characterTemplates.has(name) || characterLoading.has(name)) return
  characterLoading.add(name)
  gltfLoader.loadAsync(`/models/characters/${name}.glb`).then((gltf) => {
    // Dress the template once (tee, jeans, sneakers, cap); every clone shares the result.
    prepareDeveloper(gltf.scene)
    characterTemplates.set(name, gltf.scene)
  })
}

function ensureClips() {
  if (sharedClips.length || clipsLoading) return
  clipsLoading = true
  gltfLoader.loadAsync('/models/characters/animations.glb').then((gltf) => {
    sharedClips = gltf.animations
  })
}

// Prop template name lists live in #shared/utils/propCatalog; imported at the top of this file.

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

const propTemplates = new Map<string, Group>()

/**
 * The bush models reference a leaf texture that didn't survive the
 * .blend → GLB conversion, so their `Texture_Leaves` material arrives
 * untextured and pure white. Paint it foliage green so bushes read as
 * greenery instead of white blobs.
 */
const LEAF_GREEN = new Color('#4f6f3a')
function fixupPropMaterials(root: Group) {
  root.traverse((obj) => {
    if (obj instanceof Mesh && (obj.material as MeshStandardMaterial)?.name === 'Texture_Leaves') {
      (obj.material as MeshStandardMaterial).color.copy(LEAF_GREEN)
    }
  })
}

// Load one dir's models into the shared template map. Resilient: a single
// model that 404s or fails to parse is logged and skipped rather than
// rejecting the whole batch — otherwise one flaky request would leave the
// world stuck on its bare placeholders forever.
async function loadTemplates(dir: string, names: readonly string[]) {
  await Promise.all(names.map(async (name) => {
    try {
      const gltf = await gltfLoader.loadAsync(`/models/${dir}/${name}.glb`)
      fixupPropMaterials(gltf.scene)
      propTemplates.set(name, gltf.scene)
    }
    catch (err) {
      console.warn(`[models] failed to load ${dir}/${name}.glb`, err)
    }
  }))
}

/**
 * Every kind the arena actually draws: the hand-placed props in `plan.props`.
 * We download only these, so the arena never waits on the ~200 kit models it
 * doesn't reference. The stadium itself is procedural, no GLBs.
 */
const ARENA_KINDS = new Set<string>(hubPlan.props.map(p => p.kind))
function arenaOnly(names: readonly string[]): readonly string[] {
  return names.filter(name => ARENA_KINDS.has(name))
}

// The stadium paints at once; the hand-placed props stream in from whichever
// kits the plan references and trigger one rebuild, so they pop in together.
buildFloor()
Promise.all([
  loadTemplates('props', arenaOnly(PROP_NAMES)),
  loadTemplates('props', arenaOnly(PROP_DECOR_NAMES)),
  loadTemplates('castle', arenaOnly(CASTLE_NAMES)),
  loadTemplates('nature', arenaOnly(NATURE_NAMES)),
  loadTemplates('village', arenaOnly(VILLAGE_NAMES)),
  loadTemplates('fantasy', arenaOnly(FANTASY_NAMES)),
  loadTemplates('dungeon', arenaOnly(DUNGEON_NAMES)),
  loadTemplates('crypt', arenaOnly(CRYPT_NAMES)),
]).then(() => buildFloor())

/* -------------------------------------------------------------------------- */
/* Players                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
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
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true }))
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
  // Every player is the Developer: the male or female Peasant rig, dressed once on its template.
  const characterName = characterModel(player.character)
  const templateScene = characterTemplates.get(characterName)
  if (!templateScene || !sharedClips.length) {
    // Kick off the downloads; the rig appears once model and clips both land.
    ensureCharacter(characterName)
    ensureClips()
    return null
  }

  const group = new Group()

  // SkeletonUtils.clone keeps the armature bindings intact across copies.
  const model = SkeletonUtils.clone(templateScene)
  // The GLB faces +z; the rig's forward is +x (the group is rotated by -heading).
  model.rotation.y = Math.PI / 2
  model.scale.setScalar(CHARACTER_SCALE)
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

  // The shared clips bind to the clone by bone name (every character uses the
  // universal skeleton), so one library animates all of them.
  const mixer = new AnimationMixer(model)
  const actions: Record<string, AnimationAction> = {}
  for (const clip of sharedClips) {
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
const MAX_BOOM = 2.6
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
function clipBoom(hx: number, hy: number, dirX: number, dirZ: number, maxDist: number): number {
  const px = -dirZ // unit perpendicular to the boom, for width sampling
  const pz = dirX
  const blocked = (x: number, z: number) => !isWalkable(hubPlan, Math.floor(x), Math.floor(z))
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
  camera.value.fov = 70
  camera.value.near = 0.05
  camera.value.far = 90
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
/* The Coach: vercel.com's hero triangle floating by the arena wall over a    */
/* bed of smoke. Nothing to load — it's built from primitives in coach3d.ts.  */
/* -------------------------------------------------------------------------- */

/** Overall height (top of the triangle at rest) — taller than the ~1.3-unit runners, so it looms. */
const COACH_HEIGHT = 2.2

function createCoachRig(): CoachRig | null {
  const group = new Group()

  const body = createCoachBody(COACH_HEIGHT)
  group.add(body.group)
  const op = coachPos()
  group.position.set(op.x, 0, op.y)
  // Face the arena centre: the prism's front is +Z.
  group.rotation.y = Math.atan2(ARENA_LAYOUT.center.x - op.x, ARENA_LAYOUT.center.y - op.y)

  // A floating name so it reads as Coach.
  const label = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, 'Coach', '#f5f7ff'))
  label.sprite.position.set(0, COACH_HEIGHT + 0.3, 0)
  group.add(label.sprite)

  // Speech bubble (hidden until the Coach speaks in chat), like the players'.
  const bubbleBaseY = COACH_HEIGHT + 0.42
  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.set(0, bubbleBaseY + bubble.sprite.scale.y / 2, 0)
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  floorGroup.add(group)
  return { group, body, bubble: bubble.sprite, bubbleCanvas: bubble.canvas, bubbleTexture: bubble.texture, bubbleText: '', bubbleBaseY }
}

onBeforeRender(({ delta, elapsed }) => {
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

  // Third-person camera: behind the shoulder, pulled in by walls.
  if (camera.value) {
    const yaw = props.view.yaw
    const pitch = props.view.pitch
    const headX = local.x
    const headZ = local.y
    // Boom collision: snap IN immediately when a wall intrudes (so the camera
    // never lags behind it and flashes the void), but ease back OUT smoothly so
    // it zooms rather than popping once the wall is clear.
    const targetBoom = clipBoom(headX, headZ, -Math.cos(yaw), -Math.sin(yaw), MAX_BOOM)
    boomDist = targetBoom < boomDist
      ? targetBoom
      : boomDist + (targetBoom - boomDist) * (1 - Math.exp(-dt * 9))
    const camHeight = Math.max(local.z + 0.35, local.z + 1.5 + pitch * 1.8)
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

  // Sky, weather, fog — the arena is outdoors, so it runs the full shared
  // day/night + weather cycle off the server clock.
  {
    const sky = computeSky(serverNow)

    skyColor.copy(skyNight).lerp(skyDay, sky.dayness)
    const duskiness = clamp01(1 - Math.abs(sky.sunHeight) * 4) * sky.dayness
    skyColor.lerp(skyDusk, duskiness * 0.5)
    skyColor.lerp(new Color('#3f464e'), sky.overcast * 0.55 * sky.dayness)
    ;(scene.value.background as Color).copy(skyColor)

    // Gradient dome: deeper zenith, paler (and dusk-warm) horizon, from the clock.
    skyTop.copy(skyColor).multiplyScalar(0.82)
    skyHorizon.copy(skyColor).lerp(horizonPale, 0.5 * sky.dayness).lerp(skyDusk, duskiness * 0.35)
    skyUniforms.topColor.value.copy(skyTop)
    skyUniforms.horizonColor.value.copy(skyHorizon)
    const cam = camera.value
    if (cam) {
      skyDome.position.copy(cam.position)
      cloudDome.position.copy(cam.position)
    }
    // Clouds drift slowly, brighten by day, grey out under overcast, fade at night.
    cloudDome.rotation.y = elapsed * 0.005
    cloudMaterial.opacity = clamp01(0.15 + sky.dayness * 0.7) * (1 - sky.overcast * 0.35)
    cloudMaterial.color.copy(skyColor).lerp(new Color('#ffffff'), 0.65).lerp(new Color('#98a1ac'), sky.overcast * 0.55)

    fogColor.set(FOG_COLOR)
    fogColor.lerp(skyColor, 0.25)
    fogColor.multiplyScalar(0.35 + 0.65 * sky.dayness)
    fog.color.copy(fogColor)
    fog.density = FOG_DENSITY * (1 + sky.rain * 0.5 + sky.overcast * 0.15)

    const daylight = Math.max(sky.sunHeight, 0)
    sun.intensity = daylight > 0
      ? daylight * 0.9 * (1 - sky.overcast * 0.75)
      : 0.08
    sun.color.set(daylight > 0 ? (daylight < 0.3 ? '#ffb877' : '#fff2dd') : '#7788bb')
    sun.position.set(
      local.x + Math.cos(sky.sunAngle) * 40,
      Math.max(Math.abs(sky.sunHeight), 0.08) * 40,
      local.y + 18,
    )
    sun.target.position.set(local.x, 0, local.y)

    // Sun glow sprite: sit it on the dome along the sun direction, fade by daylight.
    if (cam) {
      sunDir.set(sun.position.x - local.x, sun.position.y, sun.position.z - local.y).normalize()
      sunGlow.position.copy(cam.position).addScaledVector(sunDir, 72)
    }
    sunGlow.visible = daylight > 0.02
    sunGlowMaterial.opacity = daylight * 0.85 * (1 - sky.overcast * 0.6)

    // Ambient stays low outdoors so the sun's shadows actually read; the
    // hemisphere fill softens them without flattening.
    ambient.intensity = 0.12 + sky.dayness * 0.28 * (1 - sky.overcast * 0.5)

    rainMaterial.opacity = sky.rain * 0.7
    rain.visible = sky.rain > 0.02
    if (rain.visible) {
      rain.position.set(local.x, 0, local.y)
      const positions = rainGeometry.attributes.position as BufferAttribute
      for (let i = 0; i < RAIN_COUNT; i++) {
        let y = positions.getY(i) - 21 * dt
        if (y < 0) y += 14
        positions.setY(i, y)
      }
      positions.needsUpdate = true
    }

    // The stadium's LEDs, crowd and floodlights follow the same clock.
    stadium?.update(dt, elapsed, 1 - sky.dayness)
  }

  // Reconcile player rigs with the roster.
  for (const [id, rig] of rigs) {
    if (!props.game.players.has(id)) {
      playerGroup.remove(rig.group)
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
    // A foot on a panel lights it; a jump lifts it off.
    if (!airborne) ledFloor?.stamp(player.rx, player.ry)

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

  // Fade the floor after this frame's stamps, then upload it.
  ledFloor?.update(dt)

  // The Coach: build it on first sight, float it over its smoke, show a bubble
  // when it speaks in chat (or "…" while it thinks), and track proximity.
  coachRig ??= createCoachRig()
  const op = coachPos()
  if (coachRig) {
    coachRig.body.update(dt, elapsed)
    // Keep it on its mark, facing the arena centre.
    coachRig.group.position.x = op.x
    coachRig.group.position.z = op.y
    coachRig.group.rotation.y = Math.atan2(ARENA_LAYOUT.center.x - op.x, ARENA_LAYOUT.center.y - op.y)
    const speech = coach.speech.value
    const speaking = speech != null && speech.until > now
    const line = speaking ? speech.text : coach.thinking.value ? '…' : ''
    if (line) {
      if (coachRig.bubbleText !== line) {
        coachRig.bubbleText = line
        const height = drawBubble(coachRig.bubbleCanvas.getContext('2d')!, coachRig.bubbleCanvas, line)
        coachRig.bubbleTexture.needsUpdate = true
        coachRig.bubble.scale.set(BUBBLE_WIDTH_UNITS, height / BUBBLE_TEXELS_PER_UNIT, 1)
        coachRig.bubble.position.y = coachRig.bubbleBaseY + coachRig.bubble.scale.y / 2
      }
      coachRig.bubble.visible = true
      coachRig.bubble.material.opacity = speaking ? Math.min(1, (speech.until - now) / 300) : 1
    }
    else {
      coachRig.bubble.visible = false
      coachRig.bubbleText = ''
    }
  }
  coach.near.value = self ? Math.hypot(local.x - op.x, local.y - op.y) < COACH_NEAR : false
})

// Remove everything we added to the shared scene (also keeps HMR honest —
// a stale setup's lights and geometry would otherwise stack up on reload).
onUnmounted(() => {
  scene.value.remove(ambient, hemi, sun, sun.target, torchLight, rain, skyDome, cloudDome, sunGlow, floorGroup, playerGroup)
})

if (import.meta.dev) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__arena = { local, camera, game: props.game, held: props.held, view: props.view }
}
</script>

<template>
  <TresGroup />
</template>
