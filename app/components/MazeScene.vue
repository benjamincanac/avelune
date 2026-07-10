<script setup lang="ts">
import {
  AdditiveBlending,
  AmbientLight,
  AnimationMixer,
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  LoopOnce,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  RingGeometry,
  ShaderMaterial,
  SkinnedMesh,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from 'three'
import type { AnimationAction, AnimationClip } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { FloorPlan, HubHouse, HubPropPlacement, PropSpec, Trap } from '#shared/utils/maze'
import {
  CELL_STRIDE,
  CELL_TILES,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  DEATH_DELAY,
  HUB_FLOOR,
  HUB_LAYOUT,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  TOWER_SEED,
  floorSpeed,
  generateFloor,
  isAuthoredFloor,
  isTrapActive,
  isWalkable,
  stepBody,
} from '#shared/utils/maze'
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
import HUB_STRUCTURE from '#shared/data/hub-structure.json'
import { createHubEditor } from '~/utils/hubEditor'
import type { HubEditor } from '~/utils/hubEditor'
import type { StonePalette } from '~/utils/textures'
import { makeBrickTexture, makeCobbleTexture, makeCrackTexture, makeGrassTexture } from '~/utils/textures'
import { characterFor, isCharacter, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { applyOutfitColor } from '~/utils/appearance'
import { buildPortal } from '~/utils/portal'
import type { Portal } from '~/utils/portal'

/**
 * Mugen's 3D world, built imperatively with three.js inside the Tres context.
 *
 * Tres provides the renderer, scene, camera, and render loop. Each floor's
 * walls go into a single InstancedMesh with procedural stone textures; the
 * sky, sun, fog, and rain are driven by a shared day/night + weather clock
 * derived from the server's time, so every player sees the same evening
 * storm roll in.
 *
 * World mapping: maze tile (x, y) → 3D (x, 0, y), 1 tile = 1 unit.
 *
 * The third-person camera follows a *predicted* self: your held keys are
 * integrated locally with the exact same `moveWithCollision` the server
 * runs, then blended toward the authoritative position. The mouse orbits
 * the camera around you (and is the movement basis the server integrates);
 * the character itself only pivots to face where it is actually moving, so
 * mouse-look while standing still just circles the camera without spinning
 * you on the spot. The camera boom shortens when a wall would block the view.
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

// Hub Oracle proximity/dialogue state, shared with GameScene and the HUD.
const oracle = useOracle()

const { scene, camera: cameraManager, renderer } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender } = useLoop()

// Dev-only hub prop editor: created in onMounted when `editor` is set (see the
// bottom of the file). Referenced by buildFloor (rebuild) and the render loop.
let editorCtl: HubEditor | null = null

/**
 * Interior wall + ceiling height. Tall enough that the third-person camera
 * clears it at a jump's apex (`local.z ≈ 0.9`) even while looking up, so it
 * never pops through the ceiling. A hard clamp in the render loop is the backstop.
 */
const WALL_HEIGHT = 3.8
/** How high the masonry panels rise; the wall is plain stone above them to the ceiling. */
const WALL_PANEL_TOP = 2.6
/** Full day/night cycle length. */
const DAY_MS = 15 * 60 * 1000

/* -------------------------------------------------------------------------- */
/* Biome looks                                                                */
/* -------------------------------------------------------------------------- */

interface BiomeLook {
  wall: StonePalette
  ground: StonePalette
  fog: string
  fogDensity: number
  trap: 'spikes' | 'geyser' | 'vines' | 'vent'
  water?: boolean
  lava?: boolean
}

const HUB_LOOK: BiomeLook = {
  // `wall` dresses the stone tower; `ground` is the meadow the plaza sits on.
  wall: { base: '#8a8378', dark: '#6f695f', mortar: '#4c4740', moss: '#5a7048', mossAmount: 0.16 },
  ground: { base: '#5f8440', dark: '#496a31', mortar: '#6d5c3d', moss: '#82a850', mossAmount: 0.5 },
  fog: '#3f4d34',
  fogDensity: 0.014,
  trap: 'spikes',
}

const BIOME_LOOKS: BiomeLook[] = [
  {
    wall: { base: '#6f6a61', dark: '#58544b', mortar: '#3d3a34', moss: '#57703f', mossAmount: 0.12 },
    ground: { base: '#56534b', dark: '#47443d', mortar: '#312f29', moss: '#57703f', mossAmount: 0.12 },
    fog: '#0b0e15',
    fogDensity: 0.05,
    trap: 'spikes',
  },
  {
    wall: { base: '#5d6b70', dark: '#48555c', mortar: '#2e383d', moss: '#3e6e62', mossAmount: 0.32 },
    ground: { base: '#4a585e', dark: '#3b474d', mortar: '#263034', moss: '#3e6e62', mossAmount: 0.3 },
    fog: '#0d2830',
    fogDensity: 0.07,
    trap: 'geyser',
    water: true,
  },
  {
    wall: { base: '#5f6851', dark: '#4a5340', mortar: '#33392c', moss: '#4c7a3d', mossAmount: 0.5 },
    ground: { base: '#48513c', dark: '#3a4230', mortar: '#272c21', moss: '#4c7a3d', mossAmount: 0.45 },
    fog: '#12281a',
    fogDensity: 0.082,
    trap: 'vines',
  },
  {
    wall: { base: '#4c423d', dark: '#3a322e', mortar: '#241e1b', moss: '#833c22', mossAmount: 0.18 },
    ground: { base: '#3c3431', dark: '#2e2724', mortar: '#1c1715', moss: '#833c22', mossAmount: 0.12 },
    fog: '#2a1008',
    fogDensity: 0.042,
    trap: 'vent',
    lava: true,
  },
]

function lookFor(plan: FloorPlan): BiomeLook {
  return plan.biome < 0 ? HUB_LOOK : BIOME_LOOKS[plan.biome]!
}

/* -------------------------------------------------------------------------- */
/* Static scene: lights, sky, rain                                            */
/* -------------------------------------------------------------------------- */

const fog = new FogExp2('#0b0e15', 0.04)
scene.value.fog = fog
scene.value.background = new Color('#05070d')

const ambient = new AmbientLight('#8899bb', 0.4)
scene.value.add(ambient)

/** Sky/ground fill for soft outdoor bounce light — lifts the hub, off in dungeons. */
const hemi = new HemisphereLight('#bcd4ff', '#5a6a3a', 0)
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
/* Floor geometry                                                             */
/* -------------------------------------------------------------------------- */

const planCache = new Map<string, FloorPlan>()

function getPlan(floor: number): FloorPlan {
  const daySeed = props.game.seed.value ?? TOWER_SEED
  const key = `${daySeed}:${floor}`
  let plan = planCache.get(key)
  if (!plan) {
    plan = generateFloor(floor, daySeed)
    planCache.set(key, plan)
  }
  return plan
}

let currentPlan = getPlan(HUB_FLOOR)

/** Procedural textures, cached per biome index (-1 = hub). */
const textureCache = new Map<number, { wall: CanvasTexture, ground: CanvasTexture, ceiling: CanvasTexture }>()

function texturesFor(plan: FloorPlan) {
  let entry = textureCache.get(plan.biome)
  if (!entry) {
    const look = lookFor(plan)
    entry = {
      wall: makeBrickTexture(9000 + plan.biome, look.wall),
      ground: plan.biome < 0
        ? makeGrassTexture(7000, look.ground)
        : makeCobbleTexture(7000 + plan.biome, look.ground),
      // Flagstone ceiling, in the wall's stone tones — distinct from the brick
      // walls but clearly the same masonry. Tiled (its repeat is set per floor).
      ceiling: makeCobbleTexture(6500 + plan.biome, look.wall),
    }
    entry.ground.wrapS = RepeatWrapping
    entry.ground.wrapT = RepeatWrapping
    entry.ceiling.wrapS = RepeatWrapping
    entry.ceiling.wrapT = RepeatWrapping
    textureCache.set(plan.biome, entry)
  }
  return entry
}

const crackTexture = import.meta.client ? makeCrackTexture(4242) : null
if (crackTexture) {
  crackTexture.wrapS = RepeatWrapping
  crackTexture.wrapT = RepeatWrapping
}

/** Everything floor-shaped lives here so floor changes can rebuild wholesale. */
const floorGroup = new Group()
scene.value.add(floorGroup)
const exitPortal = new Group()

/** The hub's swirling teleport gate, animated in the render loop (null off-hub). */
let hubPortal: Portal | null = null

// Hub Oracle NPC — a monster (Quaternius Ultimate Monsters) as the tower's
// ancient seer, standing just west of the portal. Declared here (before the
// synchronous initial buildFloor) so buildFloor can reset it on floor changes.
/** Where the Oracle stands, in tiles — on the plaza rim, SE of the hub portal (exit is 20,26). */
const ORACLE_TILE = { x: 24.2, y: 28.6 }
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

interface TrapVisual {
  trap: Trap
  hazard: Group
}
let trapVisuals: TrapVisual[] = []

function buildTrapMesh(kind: BiomeLook['trap']): Group {
  const group = new Group()
  if (kind === 'spikes' || kind === 'vines') {
    const isVine = kind === 'vines'
    const material = new MeshStandardMaterial({
      color: isVine ? '#3f7a2e' : '#8a8f99',
      roughness: isVine ? 0.8 : 0.4,
      metalness: isVine ? 0 : 0.6,
    })
    const geometry = new ConeGeometry(isVine ? 0.07 : 0.1, isVine ? 0.85 : 0.6, 6)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const radius = i === 0 ? 0 : 0.24
      const spike = new Mesh(geometry, material)
      spike.position.set(Math.cos(angle) * radius, (isVine ? 0.42 : 0.3), Math.sin(angle) * radius)
      if (isVine) spike.rotation.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5)
      group.add(spike)
    }
  }
  else if (kind === 'geyser') {
    const column = new Mesh(
      new CylinderGeometry(0.3, 0.2, 1.9, 12),
      new MeshBasicMaterial({ color: '#9fdcee', transparent: true, opacity: 0.55, depthWrite: false }),
    )
    column.position.y = 0.95
    group.add(column)
  }
  else {
    const column = new Mesh(
      new CylinderGeometry(0.27, 0.33, 1.4, 10),
      new MeshBasicMaterial({ color: '#ff8a2a', transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false }),
    )
    column.position.y = 0.7
    group.add(column)
  }
  return group
}

/**
 * Tag the freshly built floor for shadows: opaque standard-material meshes cast
 * and receive; the flat ground plane only receives; glowing/transparent bits
 * (portals, beams, rune) do neither. Instanced meshes cast shadows too.
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
  exitPortal.clear()
  hubPortal = null
  // floorGroup.clear() detached the Oracle; drop the ref so the hub rebuilds it.
  oracleRig = null
  trapVisuals = []
  flames.length = 0

  const plan = currentPlan
  const look = lookFor(plan)
  const textures = texturesFor(plan)

  const isHub = plan.floor === HUB_FLOOR
  // Authored floors are hand-built from freely-placed wall/arch/column pieces
  // (like the hub), so the tile-derived dressing passes don't apply — the placed
  // pieces ARE the architecture. They still get ground/border/ceiling/traps/portal.
  const isAuthored = isAuthoredFloor(plan.floor)
  // Ground: pack floor slabs where possible; the Magma Halls keep the
  // procedural emissive-crack floor (the slabs would hide the glow), and the
  // hub is an open meadow (no dungeon slabs).
  const modularGround = !look.lava && !isHub && placeModularFloor(plan)
  const groundMaterial = new MeshStandardMaterial({ map: textures.ground, roughness: 1 })
  textures.ground.repeat.set(plan.width / 2, plan.height / 2)
  if (look.lava && crackTexture) {
    groundMaterial.emissive = new Color('#ff5a1a')
    groundMaterial.emissiveIntensity = 0.55
    groundMaterial.emissiveMap = crackTexture
    crackTexture.repeat.set(plan.width / 4, plan.height / 4)
  }
  const ground = new Mesh(new PlaneGeometry(plan.width, plan.height), groundMaterial)
  ground.rotation.x = -Math.PI / 2
  // Under the slabs it only peeks through seams; alone it is the floor.
  ground.position.set(plan.width / 2, modularGround ? -0.3 : 0, plan.height / 2)
  floorGroup.add(ground)

  // The hub is a bespoke village-in-nature scene: tower, portal, houses,
  // greenery — no dungeon walls, traps, torches, or scatter.
  if (isHub) {
    buildVillageHub(plan)
    tagShadows(floorGroup)
    // Re-sync the editor's own selectable clones (templates may have just
    // finished loading, so this runs after each build phase).
    editorCtl?.rebuild()
    return
  }

  // Shallow water covering the Sunken Depths.
  if (look.water) {
    const water = new Mesh(
      new PlaneGeometry(plan.width, plan.height),
      new MeshStandardMaterial({
        color: '#2e7d96',
        transparent: true,
        opacity: 0.42,
        roughness: 0.15,
        metalness: 0.1,
      }),
    )
    water.rotation.x = -Math.PI / 2
    water.position.set(plan.width / 2, 0.1, plan.height / 2)
    floorGroup.add(water)

    // A ruined plank bridge over the flooded centre room, on stone pilings —
    // room centres are always open, so it never clips a wall. Deferred module,
    // so it appears on the follow-up rebuild. Procedural-only: authored floors
    // place their own bridges via the editor.
    if (!isAuthored) {
      const cc = Math.floor(((plan.width - 1) / CELL_STRIDE) / 2)
      const rx = cc * CELL_STRIDE + 1 + CELL_TILES / 2
      const rz = cc * CELL_STRIDE + 1 + CELL_TILES / 2
      const tint = MODULE_TINTS[plan.biome + 1]!
      const bridge = instantiateModule('BridgeSection', [placementMatrix(rx, 0.22, rz, 0, 1)], tint)
      if (bridge) floorGroup.add(bridge)
      const pilings = instantiateModule('Column_BridgeSupport', [
        placementMatrix(rx - 1, 0, rz, 0, 0.5),
        placementMatrix(rx + 1, 0, rz, 0, 0.5),
      ], tint)
      if (pilings) floorGroup.add(pilings)
    }
  }

  // Walls: a stone core of instanced blocks, dressed on every corridor-facing
  // side with Ruins masonry panels + columns (`placeModularWalls`). The core is
  // darkened so the lit panels read as the finished interior surface.
  const wallTiles: Array<[number, number]> = []
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (plan.tiles[y * plan.width + x] === 1) wallTiles.push([x, y])
    }
  }
  const walls = new InstancedMesh(
    new BoxGeometry(1, WALL_HEIGHT, 1),
    new MeshStandardMaterial({ map: textures.wall, roughness: 0.95, color: new Color('#8a8a8a') }),
    wallTiles.length,
  )
  const matrix = new Matrix4()
  wallTiles.forEach(([x, y], i) => {
    walls.setMatrixAt(i, matrix.makeTranslation(x + 0.5, WALL_HEIGHT / 2, y + 0.5))
  })
  floorGroup.add(walls)

  // A stone ceiling caps the interior so floors read as rooms in a tower rather
  // than an open-air maze. There are no shadow maps, so it never darkens the
  // scene — light still pours in; windows keep the sky glimpsable at the edges.
  // Tiled flagstone texture, dimmed so it reads as shadowed masonry overhead.
  textures.ceiling.repeat.set(plan.width / 3, plan.height / 3)
  const ceiling = new Mesh(
    new PlaneGeometry(plan.width, plan.height),
    new MeshStandardMaterial({ map: textures.ceiling, color: new Color('#a8a8a8'), roughness: 1, side: DoubleSide }),
  )
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(plan.width / 2, WALL_HEIGHT, plan.height / 2)
  floorGroup.add(ceiling)

  // Hazards. A wooden trapdoor plate sits under each one as its mechanism, with
  // the dark opening and the timed hazard (spikes/geyser/…) rising through it.
  const trapdoors: Matrix4[] = []
  for (const trap of plan.traps) {
    const base = new Mesh(
      new CircleGeometry(0.42, 20),
      new MeshBasicMaterial({ color: '#0a0a0a', transparent: true, opacity: 0.55 }),
    )
    base.rotation.x = -Math.PI / 2
    base.position.set(trap.x, 0.03, trap.y)
    floorGroup.add(base)
    trapdoors.push(placementMatrix(trap.x, 0.012, trap.y, 0, 0.62))

    const hazard = buildTrapMesh(look.trap)
    hazard.position.set(trap.x, 0, trap.y)
    hazard.scale.y = 0.02
    floorGroup.add(hazard)
    trapVisuals.push({ trap, hazard })
  }
  const trapdoorGroup = instantiateModule('Trapdoor', trapdoors, MODULE_TINTS[plan.biome + 1]!)
  if (trapdoorGroup) floorGroup.add(trapdoorGroup)

  // Exit portal: torus + beacon you can spot over the walls.
  const ring = new Mesh(
    new TorusGeometry(0.6, 0.06, 12, 48),
    new MeshBasicMaterial({ color: '#00dc82' }),
  )
  ring.position.y = 1
  exitPortal.add(ring)

  const beacon = new Mesh(
    new CylinderGeometry(0.1, 0.1, 18, 8, 1, true),
    new MeshBasicMaterial({
      color: '#00dc82',
      transparent: true,
      opacity: 0.12,
      blending: AdditiveBlending,
      side: DoubleSide,
      depthWrite: false,
    }),
  )
  beacon.position.y = 9
  exitPortal.add(beacon)

  const glow = new PointLight('#00dc82', 6, 9)
  glow.position.y = 1
  exitPortal.add(glow)

  const pad = new Mesh(
    new RingGeometry(0.45, 0.7, 32),
    new MeshBasicMaterial({ color: '#00dc82', transparent: true, opacity: 0.5, side: DoubleSide }),
  )
  pad.rotation.x = -Math.PI / 2
  pad.position.y = 0.03
  exitPortal.add(pad)

  exitPortal.position.set(plan.exit.x, 0, plan.exit.y)
  floorGroup.add(exitPortal)

  const startRing = new Mesh(
    new RingGeometry(0.4, 0.55, 32),
    new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18, side: DoubleSide }),
  )
  startRing.rotation.x = -Math.PI / 2
  startRing.position.set(plan.start.x, 0.02, plan.start.y)
  floorGroup.add(startRing)

  if (isAuthored) {
    // The editor-placed pieces are the whole interior — no tile-derived dressing.
    renderPlanProps(plan)
  }
  else {
    placeModularWalls(plan)
    placeTorches(plan)
    placeProps(plan)
    placeArchitecture(plan)
    scatterInterior(plan)
    placeChandeliers(plan)
  }
  tagShadows(floorGroup)
  // Re-sync the editor's selectable clones after a rebuild (templates may have
  // just finished loading), same as the hub path.
  editorCtl?.rebuild()
}

/**
 * Pack floor slabs on a 2x2 grid, sunk so their tops sit at ~+0.01. Returns
 * false while the modules are still downloading (the plane covers meanwhile).
 */
function placeModularFloor(plan: FloorPlan): boolean {
  if (!templatesReady) return false
  const tint = MODULE_TINTS[plan.biome + 1]!
  const isVerdant = plan.biome === 2
  // Base slab mix (weights sum to 1). Each slab's mesh top sits a different
  // amount above its origin, so the y offset (`0.01 - meshTop`, see FLOOR_TILE_Y)
  // lands every variant's top at ~+0.01 — otherwise adjacent slabs step.
  const variants: Array<[string, number]> = [
    ['Floor_Standard', 0.32],
    ['Floor_Squares', 0.24],
    ['Floor_Standard_Half', 0.14],
    ['Floor_Diamond', 0.15],
    ['Floor_SquareLarge', 0.15],
  ]
  const buckets = new Map<string, Matrix4[]>()
  for (let gy = 0; gy < plan.height - 1; gy += 2) {
    for (let gx = 0; gx < plan.width - 1; gx += 2) {
      // A rare slab is ruined — a hole tile whose gap reveals the sunk ground
      // plane as a shallow pit — or, in the Verdant maze, a tree burst through.
      const ruin = placementHash(plan.seed, gx, gy, 3)
      let name: string
      if (isVerdant && ruin < 0.05) name = 'Floor_Tree'
      else if (ruin < 0.06) name = placementHash(plan.seed, gx, gy, 4) < 0.5 ? 'Floor_Hole_Corner' : 'Floor_Hole_Straight'
      else {
        let roll = placementHash(plan.seed, gx, gy, 1)
        name = (variants.find(([, w]) => (roll -= w) <= 0) ?? variants[0]!)[0]
      }
      const rotation = Math.floor(placementHash(plan.seed, gx, gy, 2) * 4) * (Math.PI / 2)
      const matrices = buckets.get(name) ?? []
      matrices.push(placementMatrix(gx + 1, FLOOR_TILE_Y[name] ?? -0.02, gy + 1, rotation, 1))
      buckets.set(name, matrices)
    }
  }
  for (const [name, matrices] of buckets) {
    const group = instantiateModule(name, matrices, tint)
    if (group) floorGroup.add(group)
  }
  return true
}

/**
 * Structural dressing from the Ruins pack (labyrinth floors only): buttresses
 * along corridor walls, arches over passage mouths, and a gothic gateway at the
 * exit. The hub has its own dressing in `buildVillageHub`.
 */
function placeArchitecture(plan: FloorPlan) {
  if (!templatesReady) return
  const tint = MODULE_TINTS[plan.biome + 1]!
  const add = (group: Group | null) => {
    if (group) floorGroup.add(group)
  }

  // Buttresses against corridor walls.
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
  const supports: Record<string, Matrix4[]> = {
    Support_Center: [], Support_Left: [], Support_Right: [], Support_Tall: [],
  }
  const supportNames = Object.keys(supports)
  let buttressCount = 0
  for (let y = 1; y < plan.height - 1 && buttressCount < 30; y++) {
    for (let x = 1; x < plan.width - 1 && buttressCount < 30; x++) {
      if (plan.tiles[y * plan.width + x] !== 1) continue
      if (placementHash(plan.seed, x, y, 4) > 0.08) continue
      const open = DIRS.find(([dx, dy]) => isWalkable(plan, x + dx, y + dy))
      if (!open) continue
      const name = supportNames[Math.floor(placementHash(plan.seed, x, y, 5) * supportNames.length)]!
      supports[name]!.push(placementMatrix(
        x + 0.5 + open[0] * 0.69,
        0,
        y + 0.5 + open[1] * 0.69,
        Math.atan2(open[0], open[1]),
        0.58,
      ))
      buttressCount++
    }
  }
  for (const [name, matrices] of Object.entries(supports)) {
    add(instantiateModule(name, matrices, tint))
  }

  // Arches over some passage mouths between cells, scaled to the corridor width.
  // Four arch variants (plain/round-column × gothic/round), some hung with a
  // matching banner, keyed to world position so the choice is deterministic.
  const S = CELL_STRIDE
  const C = CELL_TILES
  const cells = (plan.width - 1) / S
  const archScale = (C + 0.4) / 3.09 // Arch modules are ~3.09 units wide natively.
  const archBuckets = new Map<string, Matrix4[]>()
  const flagBuckets = new Map<string, Matrix4[]>()
  const addArch = (x: number, z: number, rotY: number, salt: number) => {
    const r = placementHash(plan.seed, x, z, salt)
    const name = r < 0.3 ? 'Arch_Gothic' : r < 0.55 ? 'Arch_Round' : r < 0.8 ? 'Arch_Gothic_RoundColumn' : 'Arch_Round_RoundColumn'
    const arr = archBuckets.get(name) ?? []
    arr.push(placementMatrix(x, 0, z, rotY, archScale))
    archBuckets.set(name, arr)
    if (placementHash(plan.seed, x, z, salt + 1) < 0.35) {
      const flag = name.startsWith('Arch_Gothic') ? 'Flag_GothicArch' : 'Flag_RoundArch'
      const farr = flagBuckets.get(flag) ?? []
      farr.push(placementMatrix(x, 2.5, z, rotY, archScale))
      flagBuckets.set(flag, farr)
    }
  }
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      // Passage east of (cx, cy).
      if (cx < cells - 1 && plan.tiles[(cy * S + 1) * plan.width + cx * S + S] === 0
        && placementHash(plan.seed, cx, cy, 6) < 0.3) {
        addArch(cx * S + S + 0.5, cy * S + 1 + C / 2, Math.PI / 2, 50)
      }
      // Passage south of (cx, cy).
      if (cy < cells - 1 && plan.tiles[(cy * S + S) * plan.width + cx * S + 1] === 0
        && placementHash(plan.seed, cx, cy, 8) < 0.3) {
        addArch(cx * S + 1 + C / 2, cy * S + S + 0.5, 0, 52)
      }
    }
  }
  // The exit gets a grand gothic gateway around the portal.
  const exitArch = archBuckets.get('Arch_Gothic') ?? []
  exitArch.push(placementMatrix(plan.exit.x, 0, plan.exit.y, Math.PI / 2, archScale * 1.05))
  archBuckets.set('Arch_Gothic', exitArch)
  for (const [name, mats] of archBuckets) add(instantiateModule(name, mats, tint))
  for (const [name, mats] of flagBuckets) add(instantiateModule(name, mats, '#ffffff'))

  // Grand "way up" around the exit portal: a tall staircase at the back, low
  // steps on the other sides, a railing ringing the dais (open on the south
  // approach), and flanking banners — the teleport as the ascent to the next floor.
  const ex = plan.exit.x
  const ey = plan.exit.y
  add(instantiateModule('Stairs_2', [placementMatrix(ex, 0, ey - C * 0.45, 0, 0.6)], tint))
  add(instantiateModule('Stairs', ([[0, 1, Math.PI], [-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]] as const).map(
    ([dx, dz, rot]) => placementMatrix(ex + dx * (C * 0.45), 0, ey + dz * (C * 0.45), rot, 0.6)), tint))

  const rr = 1.6 // railing radius — just outside the stairs
  add(instantiateModule('Rail_Corner', ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(
    ([sx, sz]) => placementMatrix(ex + sx * rr, 0, ey + sz * rr, Math.atan2(sx, sz), 1)), tint))
  add(instantiateModule('Rail_Straight', ([[0, -1, Math.PI / 2], [-1, 0, 0], [1, 0, 0]] as const).map(
    ([sx, sz, rot]) => placementMatrix(ex + sx * rr, 0, ey + sz * rr, rot, 1)), tint))
  add(instantiateModule('Rail_Divider', ([-0.6, 0.6] as const).map(
    sx => placementMatrix(ex + sx, 0, ey + rr, 0, 1)), tint))

  add(instantiateModule('Banner_1', [
    placementMatrix(ex - C / 2, 1.8, ey, Math.PI / 2, 0.95),
    placementMatrix(ex + C / 2, 1.8, ey, -Math.PI / 2, 0.95),
  ], '#ffffff'))
  add(instantiateModule('Flag_Wall', [
    placementMatrix(ex - C / 2 + 0.12, 1.5, ey - 0.6, Math.PI / 2, 1),
    placementMatrix(ex + C / 2 - 0.12, 1.5, ey - 0.6, -Math.PI / 2, 1),
  ], '#ffffff'))
}

/**
 * Masonry skin for a labyrinth floor. Every maze cell is a `CELL_TILES`-wide
 * square room; each of its four faces is either an open passage or a wall.
 * Closed faces get a Ruins wall panel stretched to the corridor width
 * (occasionally a window/hole/broken variant), and a deterministic subset of
 * rooms are colonnaded with corner columns. The panels dress the darkened
 * box-wall core `buildFloor` already placed — collision is untouched (still
 * tile-based), this is pure finish.
 */
function placeModularWalls(plan: FloorPlan) {
  if (!templatesReady) return
  const tint = MODULE_TINTS[plan.biome + 1]!
  const S = CELL_STRIDE
  const C = CELL_TILES
  const cells = (plan.width - 1) / S
  const verdant = plan.biome === 2
  const cInset = 0.3 // column inset from the room walls
  const tile = (tx: number, ty: number) => plan.tiles[ty * plan.width + tx]
  const buckets = new Map<string, Matrix4[]>()
  const push = (kind: string, m: Matrix4) => {
    const arr = buckets.get(kind) ?? []
    arr.push(m)
    buckets.set(kind, arr)
  }
  // Stretch a face panel to the room-face width (X) and interior height (Y),
  // per the module's native size, so every variant lines up at `WALL_PANEL_TOP`.
  const panel = (kind: string, px: number, pz: number, rotY: number) =>
    push(kind, placementMatrixScaled(px, 0, pz, rotY, C / PANEL_W[kind]!, WALL_PANEL_TOP / PANEL_H[kind]!, 1))

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const bx = cx * S
      const by = cy * S
      const mid = 1 + C / 2 // room-centre offset from the cell origin
      // A few rooms are "grand halls" — their closed faces are monumental 4-wide
      // arch walls (the arch opening reveals the dark core behind as a niche).
      const grand = placementHash(plan.seed, cx, cy, 23) < 0.1
      // [openCheckX, openCheckY, panelX, panelZ, rotY so the panel face points into the room]
      const faces: Array<[number, number, number, number, number]> = [
        [bx + 1, by, bx + mid, by + 1, 0], // north
        [bx + 1, by + S, bx + mid, by + S, Math.PI], // south
        [bx, by + 1, bx + 1, by + mid, Math.PI / 2], // west
        [bx + S, by + 1, bx + S, by + mid, -Math.PI / 2], // east
      ]
      faces.forEach(([ox, oy, px, pz, rotY], f) => {
        if (tile(ox, oy) !== 1) return // open passage — no wall panel here
        const roll = placementHash(plan.seed, cx * 4 + f, cy, 21)
        let kind: string
        if (grand) {
          kind = verdant
            ? (roll < 0.5 ? 'Wall_ArchRound_Overgrown' : 'Wall_ArchRound_Overgrown_Broken')
            : (roll < 0.4 ? 'Wall_ArchRound' : roll < 0.7 ? 'Wall_ArchGothic' : 'Wall_ArchRound_Broken')
        }
        else if (roll < 0.06) {
          // A door set into the wall — a sealed side-chamber beyond.
          const d = placementHash(plan.seed, cx * 4 + f, cy, 24)
          kind = d < 0.3 ? 'Doors_GothicArch' : d < 0.6 ? 'Doors_RoundArch' : d < 0.8 ? 'Doors_GothicArch_Covered' : 'Doors_RoundArch_Covered'
        }
        else if (roll < 0.16) kind = verdant ? 'Window_Bars_Overgrown' : (placementHash(plan.seed, cx * 4 + f, cy, 25) < 0.5 ? 'Window_Open' : 'Window_Bars')
        else if (roll < 0.22) kind = 'Wall_Broken'
        else if (roll < 0.27) kind = 'Wall_Hole'
        else kind = verdant ? 'Wall_Overgrown' : 'Wall'
        panel(kind, px, pz, rotY)
      })

      // Colonnade a subset of rooms: a column tucked into each interior corner,
      // round or square per room for variety.
      if (placementHash(plan.seed, cx, cy, 22) < 0.26) {
        const colKind = placementHash(plan.seed, cx, cy, 26) < 0.5 ? 'Column_Round' : 'Column_Square'
        const lo = 1 + cInset
        const hi = 1 + C - cInset
        for (const [dx, dz] of [[lo, lo], [hi, lo], [lo, hi], [hi, hi]] as const) {
          push(colKind, placementMatrix(bx + dx, 0, by + dz, 0, WALL_HEIGHT / 4))
        }
      }
    }
  }
  const add = (g: Group | null) => {
    if (g) floorGroup.add(g)
  }
  for (const [name, mats] of buckets) add(instantiateModule(name, mats, tint))
}

/** Per-biome furniture: [0] keep, [1] flooded, [2] overgrown, [3] forge. */
const INTERIOR_WALL_ITEMS: string[][] = [
  ['Bookcase_2', 'Bookcase_Full', 'WeaponStand', 'Shelf_Simple', 'Cabinet'],
  ['Bookcase_Empty', 'Shelf_Simple', 'Cabinet'],
  [],
  ['WeaponStand', 'Shield_Wooden', 'Cabinet'],
]
const INTERIOR_FLOOR_ITEMS: string[][] = [
  ['Chest_Wood', 'Barrel', 'Crate_Wooden', 'CandleStick_Triple', 'Book_Stack_1', 'Cage_Small', 'BookStand', 'Chair_1', 'Stool', 'Candles_2', 'Statue_Stag', 'BearTrap_Open', 'BearTrap_Closed', 'Wall_Half', 'Curve_1', 'Curve_2'],
  ['Barrel', 'Pot1', 'Pot2', 'Pot3', 'Pot3_Broken', 'Vase_2', 'Rope_1', 'Crate_Wooden', 'Wall_Half', 'Curve_1', 'Curve_2'],
  ['Bush_1x1', 'Bush_Round', 'Bush_2x1', 'Bush_2x2', 'Bush_Large', 'Grass', 'DeadTree_1', 'DeadTree_2', 'DeadTree_3', 'Statue_Fox', 'Statue_Stag', 'Pot1_Broken', 'Pot3_Broken', 'Curve_1_Overgrown', 'Curve_2_Overgrown'],
  ['Anvil', 'Cauldron', 'Workbench', 'Barrel', 'Chest_Gold', 'Skull', 'CandleStick_Triple', 'Candles_2', 'BearTrap_Closed', 'Wall_Half', 'Curve_1', 'Curve_2'],
]
const INTERIOR_BANNERS = ['Banner_1', 'Banner_2', 'Flag_Wall2']

/**
 * Deterministic, non-colliding interior dressing keyed to the biome, mirroring
 * `scatterHub`. Sparse on purpose: only a fraction of rooms get dressed, and
 * each gets at most ONE piece — a wall piece (bookcase/rack/banner) flush to a
 * closed face, or a floor piece in a corner — never stacked, and always placed
 * clear of the shared `plan.props` scatter so nothing overlaps.
 */
function scatterInterior(plan: FloorPlan) {
  if (!templatesReady) return
  const S = CELL_STRIDE
  const C = CELL_TILES
  const cells = (plan.width - 1) / S
  const wallItems = INTERIOR_WALL_ITEMS[plan.biome] ?? []
  const floorItems = INTERIOR_FLOOR_ITEMS[plan.biome] ?? []
  const buckets = new Map<string, Matrix4[]>()
  const push = (kind: string, x: number, y: number, z: number, rotY: number, scale: number) => {
    const arr = buckets.get(kind) ?? []
    arr.push(placementMatrix(x, y, z, rotY, scale))
    buckets.set(kind, arr)
  }
  const hash = (cx: number, cy: number, salt: number) => placementHash(plan.seed, cx, cy, salt)
  const near = (x: number, z: number) =>
    Math.hypot(x - plan.start.x, z - plan.start.y) < 4 || Math.hypot(x - plan.exit.x, z - plan.exit.y) < 4
  // Keep dressing clear of the shared gameplay props so nothing sits stacked.
  const clash = (x: number, z: number) => plan.props.some(p => Math.hypot(p.x - x, p.y - z) < 1.3)

  const off = 0.35 // distance a wall piece sits in front of its wall
  const mid = 1 + C / 2 // room centre offset from the cell origin
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const bx = cx * S
      const by = cy * S
      if (near(bx + mid, by + mid)) continue
      if (hash(cx, cy, 40) > 0.22) continue // only ~1 in 5 rooms is dressed
      const tile = (tx: number, ty: number) => plan.tiles[ty * plan.width + tx]

      // One piece per room: prefer a wall piece against a closed face, else a
      // floor piece in a corner. Whichever is chosen is skipped if it would
      // land on a plan prop.
      const faces: Array<[number, number, number]> = []
      if (tile(bx + 1, by) === 1) faces.push([bx + mid, by + 1 + off, 0])
      if (tile(bx + 1, by + S) === 1) faces.push([bx + mid, by + S - off, Math.PI])
      if (tile(bx, by + 1) === 1) faces.push([bx + 1 + off, by + mid, Math.PI / 2])
      if (tile(bx + S, by + 1) === 1) faces.push([bx + S - off, by + mid, -Math.PI / 2])

      let placed = false
      if (faces.length && hash(cx, cy, 42) < 0.55) {
        const [fx, fz, rotY] = faces[Math.floor(hash(cx, cy, 41) * faces.length)]!
        if (!clash(fx, fz)) {
          if (hash(cx, cy, 43) < 0.3) {
            const banner = INTERIOR_BANNERS[Math.floor(hash(cx, cy, 44) * INTERIOR_BANNERS.length)]!
            push(banner, fx, 1.8, fz, rotY, 0.9)
            placed = true
          }
          else if (wallItems.length) {
            const item = wallItems[Math.floor(hash(cx, cy, 45) * wallItems.length)]!
            push(item, fx, 0, fz, rotY, 0.9)
            placed = true
          }
        }
      }
      if (!placed && floorItems.length) {
        const lo = 1.4
        const hi = 1 + C - 0.4
        const corners = [[bx + lo, by + lo], [bx + hi, by + lo], [bx + lo, by + hi], [bx + hi, by + hi]] as const
        const [ix, iz] = corners[Math.floor(hash(cx, cy, 46) * corners.length)]!
        if (!clash(ix, iz)) {
          const item = floorItems[Math.floor(hash(cx, cy, 47) * floorItems.length)]!
          push(item, ix, 0, iz, hash(cx, cy, 48) * Math.PI * 2, 0.8 + hash(cx, cy, 49) * 0.3)
        }
      }
    }
  }
  const add = (g: Group | null) => {
    if (g) floorGroup.add(g)
  }
  for (const [kind, mats] of buckets) add(instantiateModule(kind, mats, '#ffffff'))
}

/** A few chandeliers hung from the ceiling, each with a warm point light. */
function placeChandeliers(plan: FloorPlan) {
  if (!templatesReady) return
  const template = propTemplates.get('Chandelier')
  if (!template) return
  const S = CELL_STRIDE
  const mid = 1 + CELL_TILES / 2
  const cells = (plan.width - 1) / S
  const group = new Group()
  let count = 0
  for (let cy = 0; cy < cells && count < 6; cy++) {
    for (let cx = 0; cx < cells && count < 6; cx++) {
      if (placementHash(plan.seed, cx, cy, 30) > 0.06) continue
      const x = cx * S + mid
      const z = cy * S + mid
      if (Math.hypot(x - plan.start.x, z - plan.start.y) < 4) continue
      if (Math.hypot(x - plan.exit.x, z - plan.exit.y) < 4) continue
      const chandelier = template.clone(true)
      chandelier.position.set(x, WALL_HEIGHT + 0.02, z)
      chandelier.scale.setScalar(0.7)
      group.add(chandelier)
      const light = new PointLight('#ffca7a', 3.2, 7, 1.8)
      light.position.set(x, WALL_HEIGHT - 1.1, z)
      group.add(light)
      count++
    }
  }
  floorGroup.add(group)
}

/* -------------------------------------------------------------------------- */
/* Nature-village hub                                                         */
/* -------------------------------------------------------------------------- */

/** Rotation so a kit wall/window (front faces -Z) points outward along (ox, oz). */
function faceOut(ox: number, oz: number): number {
  return Math.atan2(-ox, -oz)
}

/**
 * Build the hub: a gigantic stone tower dead-centre on a cobbled plaza, the
 * pulsing portal before it, a main street running south to the village gate,
 * timber-framed houses fronting the plaza and street, a market corner, and
 * nature dressing. Solid clutter comes from `plan.props` (so it collides);
 * roads, house shells, and greenery are cosmetic — their collision is the
 * shared tile stamps in `generateHub`.
 */
function buildVillageHub(plan: FloorPlan) {
  const { tower } = HUB_LAYOUT

  // --- Procedural base (never editable): cobbled roads, the tower shaft, the
  // portal. Everything else (tower cap, houses, market, gate, statues) is kit
  // pieces that live in the editable, baked structure — see below.
  buildHubRoads()

  const TOWER_R = 3.6
  const TOWER_H = 24
  const towerTex = makeBrickTexture(9001, HUB_LOOK.wall)
  towerTex.wrapS = towerTex.wrapT = RepeatWrapping
  towerTex.repeat.set(8, 12)
  const shaft = new Mesh(
    new CylinderGeometry(TOWER_R * 0.9, TOWER_R, TOWER_H, 28, 1),
    new MeshStandardMaterial({ map: towerTex, roughness: 0.95 }),
  )
  shaft.position.set(tower.x, TOWER_H / 2, tower.y)
  floorGroup.add(shaft)

  // --- The vertical pulsing portal (the teleport) on the plaza south of the tower.
  buildHubPortal(plan.exit.x, plan.exit.y)

  // --- Editable village kit pieces. Once baked (hub-structure.json), each piece
  // is a `hand` prop in plan.props: rendered instanced here, or skipped so the
  // editor can clone it as a selectable object. Before the first bake the file is
  // empty, so fall back to rendering the procedural composition (non-selectable)
  // just so the village is visible to bake.
  // Normal play, pre-bake: show the procedural village (visual only, no
  // collision until baked). In editor mode the village comes from the working
  // copy (seeded on mount), so the controller's clones own it — skip here.
  if (!props.editor && !HUB_STRUCTURE.length) renderComposed(composeVillage(plan))

  // --- Solid clutter, hand props, and baked structure from the shared plan,
  // rendered exactly where the server simulates their footprints.
  renderPlanProps(plan)

  // --- Cosmetic greenery (walk-through).
  scatterHub(plan)
}

/**
 * Render a plan's props as instanced batches per kind, exactly where the server
 * simulates their footprints. In editor mode, hand-placed props (incl. baked
 * structure and authored-floor pieces) are skipped so the editor controller can
 * clone them as individually selectable objects instead of drawing them twice.
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
    const g = instantiateModule(kind, mats, '#ffffff')
    if (g) floorGroup.add(g)
  }
}

/** Instance matrix for a prop, honoring elevation (`z`) and per-axis scale (`s3`). */
function propMatrix(p: PropSpec): Matrix4 {
  return p.s3
    ? placementMatrixScaled(p.x, p.z ?? 0, p.y, p.rot, p.s3[0], p.s3[1], p.s3[2])
    : placementMatrix(p.x, p.z ?? 0, p.y, p.rot, p.scale)
}

/**
 * The procedural village composition as a flat list of kit-piece placements
 * (`{kind, x, y, z (elevation), rot, scale, s3?}`). This is the single source
 * the dev editor bakes into `hub-structure.json`; after baking, the pieces flow
 * through `plan.props` instead and this is only the pre-bake fallback + bake input.
 */
function composeVillage(plan: FloorPlan): HubPropPlacement[] {
  const pieces: HubPropPlacement[] = []
  // emit(kind, worldX, height, worldZ, rot, scale?, s3?) — arg order matches
  // placementMatrix so the house math below is copied verbatim; stored as a
  // placement (y = world Z, z = elevation).
  const emit = (kind: string, x: number, height: number, worldZ: number, rot: number, scale = 1, s3?: [number, number, number]) =>
    pieces.push({ kind, x, y: worldZ, z: height, rot, scale, s3 })

  const { tower } = HUB_LAYOUT
  const TOWER_R = 3.6
  const TOWER_H = 24
  const topR = TOWER_R * 0.9

  // Tower cap: conical kit roof, windows spiralling up the shaft, banners, door.
  emit('Roof_Tower_RoundTiles', tower.x, TOWER_H - 0.5, tower.y, 0, (topR * 2) / 5.65 * 1.2)
  for (let i = 0; i < 10; i++) {
    const a = i * 1.35
    const h = 4 + i * 1.9
    const r = (TOWER_R + (topR - TOWER_R) * (h / TOWER_H)) * (i % 2 === 0 ? 1.02 : 0.98)
    emit('Window_Wide_Round1', tower.x + Math.cos(a) * r, h, tower.y + Math.sin(a) * r, faceOut(Math.cos(a), Math.sin(a)))
  }
  for (const da of [-0.55, 0.55]) {
    const a = Math.PI / 2 + da
    const r = TOWER_R - 0.36 * (9 / TOWER_H)
    emit('Flag_Wall', tower.x + Math.cos(a) * r, 9, tower.y + Math.sin(a) * r, faceOut(Math.cos(a), Math.sin(a)), 1.4)
  }
  emit('Wall_UnevenBrick_Door_Round', tower.x, 0, tower.y + TOWER_R - 0.12, faceOut(0, 1))

  // Guardian statues flanking the portal approach.
  emit('Statue_Stag', 17.6, 0, 26.8, Math.PI / 2, 0.62)
  emit('Statue_Fox', 22.4, 0, 26.8, -Math.PI / 2, 0.72)

  // Houses, market stall, south gate.
  HUB_LAYOUT.houses.forEach((house, i) => composeHouse(house, plan.seed, i, emit))
  composeMarket(emit)
  composeGate(emit)
  return pieces
}

/** Render a composed piece list instanced (pre-bake fallback only). */
function renderComposed(pieces: HubPropPlacement[]) {
  const byKind = new Map<string, Matrix4[]>()
  for (const p of pieces) {
    const arr = byKind.get(p.kind) ?? []
    arr.push(p.s3
      ? placementMatrixScaled(p.x, p.z ?? 0, p.y, p.rot, p.s3[0], p.s3[1], p.s3[2])
      : placementMatrix(p.x, p.z ?? 0, p.y, p.rot, p.scale))
    byKind.set(p.kind, arr)
  }
  for (const [kind, mats] of byKind) {
    const g = instantiateModule(kind, mats, '#ffffff')
    if (g) floorGroup.add(g)
  }
}

type EmitPiece = (kind: string, x: number, height: number, worldZ: number, rot: number, scale?: number, s3?: [number, number, number]) => void

/** Grey village cobbles — distinct from the dungeon biomes' tinted stone. */
let roadTexture: CanvasTexture | null = null
function makeRoadMaterial(repeatX: number, repeatY: number): MeshStandardMaterial {
  roadTexture ??= makeCobbleTexture(7300, { base: '#84868f', dark: '#696c75', mortar: '#4e5057', moss: '#5a7048', mossAmount: 0.08 })
  const tex = roadTexture.clone()
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.repeat.set(repeatX, repeatY)
  return new MeshStandardMaterial({ map: tex, roughness: 1 })
}

/**
 * The cobbled ground network: a plaza disc around the tower, the main street
 * south to the gate, a short spur from every house door, and kit curb pieces
 * edging the plaza, street, and tower base. Purely cosmetic (flat, no collision);
 * the shared `generateHub` keeps its daily scatter off these same shapes.
 */
function buildHubRoads() {
  const { tower, plazaRadius, street, houses } = HUB_LAYOUT
  const flat = (mesh: Mesh, x: number, y: number, z: number, spin = 0) => {
    mesh.rotation.x = -Math.PI / 2
    mesh.rotation.z = spin
    mesh.position.set(x, y, z)
    floorGroup.add(mesh)
  }

  // Plaza disc + main street (the street tucks under the plaza rim).
  flat(new Mesh(new CircleGeometry(plazaRadius, 56), makeRoadMaterial(plazaRadius / 1.4, plazaRadius / 1.4)), tower.x, 0.04, tower.y)
  const streetTop = tower.y + plazaRadius - 1
  const streetLen = street.y1 - streetTop
  const streetW = street.halfW * 2 + 0.8
  flat(new Mesh(new PlaneGeometry(streetW, streetLen), makeRoadMaterial(streetW / 1.4, streetLen / 1.4)), street.x, 0.02, streetTop + streetLen / 2)

  // A path from every door, out until it meets the plaza or the street.
  for (const house of houses) {
    const [fx, fz] = FRONT_DIR[house.front]
    const door = doorWorld(house)
    let len = 1.2
    for (; len < 7; len += 0.25) {
      const px = door.x + fx * len
      const pz = door.z + fz * len
      if (Math.hypot(px - tower.x, pz - tower.y) < plazaRadius - 0.3) break
      if (Math.abs(px - street.x) < street.halfW && pz > streetTop) break
    }
    flat(
      new Mesh(new PlaneGeometry(1.5, len + 0.8), makeRoadMaterial(1.1, (len + 0.8) / 1.4)),
      door.x + fx * (len / 2 + 0.1), 0.03, door.z + fz * (len / 2 + 0.1),
      house.front % 2 === 1 ? Math.PI / 2 : 0,
    )
  }

  // Curbs: along the street, around the plaza rim, and ringing the tower base.
  const curbs: Matrix4[] = []
  for (let y = streetTop + 1.4; y < street.y1 - 0.6; y += 2.06) {
    curbs.push(placementMatrix(street.x - street.halfW - 0.5, 0, y, Math.PI / 2, 1))
    curbs.push(placementMatrix(street.x + street.halfW + 0.5, 0, y, -Math.PI / 2, 1))
  }
  const ring = (radius: number, skipStreetMouth: boolean) => {
    const count = Math.floor((Math.PI * 2 * radius) / 2.05)
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      if (skipStreetMouth && Math.abs(a - Math.PI / 2) < 0.26) continue
      curbs.push(placementMatrix(tower.x + Math.cos(a) * radius, 0, tower.y + Math.sin(a) * radius, -a - Math.PI / 2, 1))
    }
  }
  ring(plazaRadius + 0.3, true)
  ring(tower.radius + 0.6, false)
  const group = instantiateModule('Prop_ExteriorBorder_Straight1', curbs, '#ffffff')
  if (group) floorGroup.add(group)
}

/**
 * The market: a wooden canopy stall on the south-west plaza rim. The wagon,
 * crates, and barrels beside it come from the shared plan (they collide).
 */
function composeMarket(emit: EmitPiece) {
  const { market } = HUB_LAYOUT
  for (const [sx, sz] of [[-1.1, -0.8], [1.1, -0.8], [-1.1, 0.8], [1.1, 0.8]] as const) {
    emit('Prop_Support', market.x + sx, 0, market.y + sz, 0)
  }
  emit('Roof_Wooden_2x1', market.x, 2.05, market.y, 0, 1, [1.4, 1, 1.9])
}

/**
 * The village gate: a scaled arch spanning the street's south end with brick
 * posts, and a wooden fence line running out to the border tree line on both
 * sides. Cosmetic — the real boundary is the border wall ring behind the trees.
 */
function composeGate(emit: EmitPiece) {
  const { gate, street, size } = HUB_LAYOUT
  emit('Wall_Arch', gate.x, 0, gate.y, 0, 1, [(street.halfW * 2 + 1) / 2, 1.15, 1])
  for (const s of [-1, 1]) emit('Corner_Exterior_Brick', gate.x + s * (street.halfW + 0.5), 0, gate.y, 0, 1.15)
  for (let x = 2.4; x < size - 2; x += 2.06) {
    if (Math.abs(x - gate.x) < street.halfW + 1.4) continue
    emit('Prop_WoodenFence_Single', x, 0, gate.y, 0)
  }
}

/**
 * A ruined stone rune-gate framing a Solo-Leveling-style energy rift: a
 * receding swirl tunnel, a hot pulsing core, a glowing rim, rune circles
 * spinning over the dais, and motes drawn up into it. Geometry + animation live
 * in the shared `buildPortal` so the main-menu hero (MenuPortal) renders the
 * exact same gate; here we just drop it at the exit tile. The ground trigger
 * just south teleports you up the tower.
 */
function buildHubPortal(ex: number, ey: number) {
  hubPortal = buildPortal({ light: true })
  hubPortal.root.position.set(ex, 0, ey)
  floorGroup.add(hubPortal.root)
}

/** Wall panel height (kit walls are 2.0 wide × 3.12 tall). */
const STOREY = 3.12
/** How far the timbered upper floor overhangs the stone ground floor. */
const JETTY = 0.3
/** Outward direction per house `front` (0=N 1=E 2=S 3=W). */
const FRONT_DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
/** Height of the Roof_Front_BrickN gable-end triangles, by span. */
const GABLE_RISE: Record<number, number> = { 4: 2.94, 6: 4.38 }

/** World position of a house's ground-floor door (centre panel of the front). */
function doorWorld(house: HubHouse): { x: number, z: number } {
  const x0 = house.x0
  const z0 = house.y0
  const x1 = house.x1 + 1
  const z1 = house.y1 + 1
  const [fx, fz] = FRONT_DIR[house.front]
  const n = (house.front % 2 === 0 ? x1 - x0 : z1 - z0) / 2
  const doorAt = (n - 1) >> 1
  const along = (house.front % 2 === 0 ? x0 : z0) + 1 + doorAt * 2
  return house.front % 2 === 0
    ? { x: along, z: fz > 0 ? z1 : z0 }
    : { x: fx > 0 ? x1 : x0, z: along }
}

/**
 * Assemble a two-storey timber-framed house from kit modules: an uneven-stone
 * ground floor with the door + wide windows on its `front` side, a jettied
 * plaster/timber upper floor with shuttered windows, a footprint-matched gable
 * roof (`Roof_RoundTiles_WxD`, ridge along the front axis so the brick gable
 * ends face front and back), a balcony over the door, a chimney, and trailing
 * vines. Deterministic per (seed, salt) so every client agrees.
 */
function composeHouse(house: HubHouse, seed: number, salt: number, emit: EmitPiece) {
  const x0 = house.x0
  const z0 = house.y0
  const x1 = house.x1 + 1
  const z1 = house.y1 + 1
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const w = x1 - x0
  const d = z1 - z0
  const [fx, fz] = FRONT_DIR[house.front]

  const push = (kind: string, x: number, y: number, z: number, rotY: number) => emit(kind, x, y, z, rotY)
  // Offset a point by (lx, lz) in the local frame of a wall rotated rotY.
  const local = (x: number, z: number, rotY: number, lx: number, lz: number) =>
    [x + lx * Math.cos(rotY) + lz * Math.sin(rotY), z - lx * Math.sin(rotY) + lz * Math.cos(rotY)] as const

  // Four sides, each with 2-unit panel centres along it.
  for (let face = 0; face < 4; face++) {
    const [ox, oz] = FRONT_DIR[face as 0 | 1 | 2 | 3]
    const isFront = face === house.front
    const rotY = faceOut(ox, oz)
    const n = (face % 2 === 0 ? w : d) / 2
    const doorAt = isFront ? (n - 1) >> 1 : -1
    for (let j = 0; j < n; j++) {
      const along = (face % 2 === 0 ? x0 : z0) + 1 + j * 2
      const px = face % 2 === 0 ? along : (ox > 0 ? x1 : x0)
      const pz = face % 2 === 0 ? (oz > 0 ? z1 : z0) : along
      // Ground floor: uneven stone; the front gets the door + wide windows,
      // the other sides the odd window in otherwise solid masonry.
      let g = 'Wall_UnevenBrick_Straight'
      if (isFront) g = j === doorAt ? 'Wall_UnevenBrick_Door_Round' : 'Wall_UnevenBrick_Window_Wide_Round'
      else if (placementHash(seed, px * 13 + salt, pz * 7, 11) < 0.25) g = 'Wall_UnevenBrick_Window_Wide_Round'
      push(g, px, 0, pz, rotY)
      if (isFront && j === doorAt) {
        // Hang the door leaf in the doorway (the wall module is just the frame).
        const [dxp, dzp] = local(px, pz, rotY, -0.52, 0.04)
        push('Door_1_Round', dxp, 0, dzp, rotY)
      }
      // Upper floor: jettied timber frame with shuttered windows — the front
      // gets them everywhere, sides/back by deterministic chance.
      const windowed = isFront || placementHash(seed, px * 7 + salt, pz * 13, 12) < 0.5
      const ux = px + ox * JETTY
      const uz = pz + oz * JETTY
      push(windowed ? 'Wall_Plaster_Window_Wide_Round' : 'Wall_Plaster_WoodGrid', ux, STOREY, uz, rotY)
      if (windowed) push('WindowShutters_Wide_Round_Open', ux, STOREY, uz, rotY)
    }
  }

  // Corners: stone posts on the ground floor, wood on the jettied upper floor.
  for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) {
    push('Corner_Exterior_Brick', px, 0, pz, 0)
    push('Corner_Exterior_Wood', px + Math.sign(px - cx) * JETTY, STOREY, pz + Math.sign(pz - cz) * JETTY, 0)
  }

  // Gable roof matched to the footprint: ridge along the front axis, so the
  // brick gable triangles close the front and back faces. Native roofs span
  // their gable across X — rotate when the ridge runs along world X instead.
  const ridgeAlongX = house.front % 2 === 1
  const gableSpan = ridgeAlongX ? d : w
  const ridgeLen = ridgeAlongX ? w : d
  push(`Roof_RoundTiles_${gableSpan}x${ridgeLen}`, cx, 2 * STOREY + 0.15, cz, ridgeAlongX ? Math.PI / 2 : 0)
  const gx = ridgeAlongX ? w / 2 + JETTY : 0
  const gz = ridgeAlongX ? 0 : d / 2 + JETTY
  push(`Roof_Front_Brick${gableSpan}`, cx + gx, 2 * STOREY, cz + gz, faceOut(Math.sign(gx), Math.sign(gz)))
  push(`Roof_Front_Brick${gableSpan}`, cx - gx, 2 * STOREY, cz - gz, faceOut(-Math.sign(gx), -Math.sign(gz)))

  // Balcony over the door (its rail projects +Z, so face +Z outward), on most
  // houses; a chimney by the ridge; vines trailing down a flank.
  const door = doorWorld(house)
  if (placementHash(seed, salt, 5, 21) < 0.7) {
    push('Balcony_Simple_Straight', door.x + fx * JETTY, STOREY, door.z + fz * JETTY, Math.atan2(fx, fz))
  }
  const rise = GABLE_RISE[gableSpan] ?? 3
  const rdx = ridgeAlongX ? 1 : 0
  const rdz = ridgeAlongX ? 0 : 1
  const chimneySide = placementHash(seed, salt, 7, 22) < 0.5 ? -1 : 1
  push('Prop_Chimney2', cx + rdx * chimneySide * ridgeLen * 0.22, 2 * STOREY + rise * 0.45, cz + rdz * chimneySide * ridgeLen * 0.22, 0)
  const vineFace = ((house.front + (placementHash(seed, salt, 9, 23) < 0.5 ? 1 : 3)) % 4) as 0 | 1 | 2 | 3
  const [vx, vz] = FRONT_DIR[vineFace]
  const vine = ['Prop_Vine1', 'Prop_Vine2', 'Prop_Vine4'][(placementHash(seed, salt, 11, 24) * 3) | 0]!
  push(vine, cx + vx * (Math.abs(vx) * w / 2 + Math.abs(vz) * d / 2), 1.6, cz + vz * (Math.abs(vx) * w / 2 + Math.abs(vz) * d / 2), faceOut(vx, vz))
}

/**
 * Cosmetic-only scatter (walk-through): a dense tree line over the border wall
 * tiles (those collide as walls), and low ground cover across the meadow —
 * kept off the cobbled plaza, street, and market so the village core stays
 * tidy. Solid trees/boulders/market goods come from `plan.props`.
 */
function scatterHub(plan: FloorPlan) {
  const size = plan.width
  const { tower, plazaRadius, street, market } = HUB_LAYOUT
  const buckets = new Map<string, Matrix4[]>()
  const push = (kind: string, x: number, z: number, rotY: number, scale: number) => {
    const arr = buckets.get(kind) ?? []
    arr.push(placementMatrix(x, 0, z, rotY, scale))
    buckets.set(kind, arr)
  }
  const hash = (x: number, y: number, salt: number) => placementHash(plan.seed, x, y, salt)
  const TREES = ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'Pine_1', 'Pine_2']
  const COVER = ['Bush_Common', 'Bush_Common_Flowers', 'Grass_Common_Tall', 'Grass_Wispy_Tall', 'Fern_1', 'Clover_1', 'Flower_3_Group', 'Plant_1', 'Mushroom_Common']
  const COVER_SCALE: Record<string, number> = { Fern_1: 0.35, Flower_3_Group: 0.8, Clover_1: 1, Mushroom_Common: 1, Plant_1: 1, Grass_Common_Tall: 1, Grass_Wispy_Tall: 1, Bush_Common: 0.9, Bush_Common_Flowers: 0.9 }
  const onRoad = (x: number, z: number) =>
    Math.hypot(x - tower.x, z - tower.y) < plazaRadius + 0.6
    || (Math.abs(x - street.x) < street.halfW + 1 && z > tower.y + plazaRadius - 2)
    || Math.hypot(x - market.x, z - market.y) < 3.5

  // Tree line over the border tiles (backed by the wall ring, so it collides).
  for (let i = 0; i < size; i++) {
    for (const [x, z] of [[i, 0], [i, size - 1], [0, i], [size - 1, i]] as const) {
      if (hash(x, z, 1) > 0.7) continue
      const kind = TREES[(hash(x, z, 2) * TREES.length) | 0]!
      const jx = x + 0.5 + (hash(x, z, 3) - 0.5) * 0.8
      const jz = z + 0.5 + (hash(x, z, 4) - 0.5) * 0.8
      push(kind, jx, jz, hash(x, z, 5) * Math.PI * 2, 0.5 + hash(x, z, 6) * 0.4)
    }
  }

  // Ground cover on open tiles, keeping the cobbles clean.
  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      if (plan.tiles[z * size + x]) continue
      if (onRoad(x + 0.5, z + 0.5)) continue
      if (hash(x, z, 13) > 0.28) continue
      const kind = COVER[(hash(x, z, 14) * COVER.length) | 0]!
      const px = x + 0.3 + hash(x, z, 15) * 0.4
      const pz = z + 0.3 + hash(x, z, 16) * 0.4
      push(kind, px, pz, hash(x, z, 17) * Math.PI * 2, (COVER_SCALE[kind] ?? 1) * (0.8 + hash(x, z, 18) * 0.5))
    }
  }

  const add = (g: Group | null) => {
    if (g) floorGroup.add(g)
  }
  for (const [kind, mats] of buckets) add(instantiateModule(kind, mats, '#ffffff'))
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
 * to ~1.3 units so they sit well under the 2.4-unit walls and read as
 * dungeon-scale rather than towering over the corridors. Each player picks a
 * character during onboarding (see CharacterGate); it rides the snapshot.
 */
const CHARACTER_SCALE = 0.72

/**
 * Movement states → clip names in the shared library (Quaternius Universal
 * Animation Library 1 & 2). Since every character shares the universal
 * skeleton, one set of clips drives them all with no retargeting.
 */
const CLIP = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', dash: 'Sprint_Loop', death: 'Death01' } as const

const characterTemplates = new Map<string, Group>()
const characterLoading = new Set<string>()

/** Clips ship in one shared GLB (skeleton + animations, no mesh), loaded once. */
let sharedClips: AnimationClip[] = []
let clipsLoading = false

function ensureCharacter(name: string) {
  if (characterTemplates.has(name) || characterLoading.has(name)) return
  characterLoading.add(name)
  gltfLoader.loadAsync(`/models/characters/${name}.glb`).then((gltf) => {
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

const flames: Array<{ mesh: Mesh, base: number, offset: number }> = []
const flameGeometry = new OctahedronGeometry(0.07, 1)
const flameMaterial = new MeshBasicMaterial({ color: '#ffb545' })

// Prop template name lists (PROP_NAMES, PROP_DECOR_NAMES, NATURE_NAMES,
// VILLAGE_NAMES, FANTASY_NAMES) live in #shared/utils/propCatalog so the dev
// editor can share them; imported at the top of this file.

/** Subtle per-biome tint multiplied into structural module materials. */
const MODULE_TINTS = ['#ffffff', '#ffffff', '#a8ccd6', '#b4d8a4', '#d89b82']

/**
 * Floor-slab y offset = `0.01 - meshTop` (measured per tile) so every variant's
 * top surface lands flush at ~+0.01 above the sunk ground plane.
 */
const FLOOR_TILE_Y: Record<string, number> = {
  Floor_Standard: -0.023, Floor_Squares: -0.024, Floor_Standard_Half: -0.024,
  Floor_Diamond: -0.006, Floor_SquareLarge: -0.017,
  Floor_Hole_Corner: -0.051, Floor_Hole_Straight: -0.051, Floor_Tree: -0.055,
}

/**
 * Native width/height (metres) of each wall-face module, so a panel can be
 * stretched to the `CELL_TILES`-wide room face and `WALL_PANEL_TOP` height
 * regardless of its source size. The plain 2×2 `Wall` is the baseline; doors are
 * ~2.3–2.5 wide and the grand arch walls are 4×4.
 */
const PANEL_W: Record<string, number> = {
  Wall: 2, Wall_Overgrown: 2, Wall_Hole: 2, Wall_Broken: 2,
  Window_Open: 2, Window_Bars: 2, Window_Bars_Overgrown: 2,
  Doors_GothicArch: 2.31, Doors_RoundArch: 2.31,
  Doors_GothicArch_Covered: 2.52, Doors_RoundArch_Covered: 2.52,
  Wall_ArchRound: 4, Wall_ArchGothic: 4, Wall_ArchRound_Broken: 4,
  Wall_ArchRound_Overgrown: 4, Wall_ArchRound_Overgrown_Broken: 4,
}
const PANEL_H: Record<string, number> = {
  Wall: 2, Wall_Overgrown: 2, Wall_Hole: 2, Wall_Broken: 1.95,
  Window_Open: 2, Window_Bars: 2, Window_Bars_Overgrown: 2,
  Doors_GothicArch: 3.21, Doors_RoundArch: 2.97,
  Doors_GothicArch_Covered: 3.21, Doors_RoundArch_Covered: 2.97,
  Wall_ArchRound: 4, Wall_ArchGothic: 4, Wall_ArchRound_Broken: 4,
  Wall_ArchRound_Overgrown: 4, Wall_ArchRound_Overgrown_Broken: 4,
}

/** Deterministic hash for placement decisions, salted per use. */
function placementHash(seed: number, x: number, y: number, salt: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + salt * 69621, (seed ^ 0x85EBCA6B) | 1)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
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
 * Like `placementMatrix` but with per-axis scale, so a 2 m wall panel can be
 * stretched to the corridor width (local X) and interior height (local Y)
 * without touching its depth. Scale is applied in the module's local frame
 * before the Y-rotation, so widening never shears the geometry.
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
function instantiateModule(name: string, placements: Matrix4[], tint: string): Group | null {
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
let propGroup: Group | null = null

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

/** Flipped once every kit template has loaded, so the placement passes (which
 *  depend on many modules) run only against a complete set, not a partial one. */
let templatesReady = false

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

// The hub and labyrinth structure only need props/nature/village, so build the
// world as soon as those arrive — the fantasy dressing streams in after and
// triggers a second rebuild. This keeps the hub from sitting empty while ~30
// floor-only models it never uses finish downloading.
Promise.all([
  loadTemplates('props', PROP_NAMES),
  loadTemplates('nature', NATURE_NAMES),
  loadTemplates('village', VILLAGE_NAMES),
]).then(() => {
  templatesReady = true
  buildFloor()
  return Promise.all([
    loadTemplates('props', PROP_DECOR_NAMES),
    loadTemplates('fantasy', FANTASY_NAMES),
    loadTemplates('dungeon', DUNGEON_NAMES),
    loadTemplates('castle', CASTLE_NAMES),
    loadTemplates('crypt', CRYPT_NAMES),
  ])
}).then(() => buildFloor())

/**
 * Props come straight from the plan now (`plan.props`, generated in shared
 * code) — placement must be shared because solid props are walkable surfaces
 * the server simulates too.
 */
function placeProps(plan: FloorPlan) {
  if (!templatesReady) return
  if (propGroup) floorGroup.remove(propGroup)
  propGroup = new Group()

  for (const spec of plan.props) {
    const template = propTemplates.get(spec.kind)
    if (!template) continue
    const prop = template.clone(true)
    prop.position.set(spec.x, 0, spec.y)
    prop.rotation.y = spec.rot
    prop.scale.setScalar(spec.scale)
    propGroup.add(prop)
  }

  floorGroup.add(propGroup)
}

/**
 * Wall lighting scattered deterministically along the corridors: standing pack
 * torches with a flickering flame, mixed with wall-mounted caged lanterns for
 * variety. Both cling to whichever adjacent tile is a wall.
 */
function placeTorches(plan: FloorPlan) {
  const torchTemplate = propTemplates.get('Torch')
  if (!torchTemplate) return
  const lanternTemplate = propTemplates.get('Lantern_Wall')
  const seededRandom = (x: number, y: number) => {
    const h = Math.imul(x * 374761393 + y * 668265263, plan.seed | 1)
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296
  }
  const group = new Group()
  let count = 0
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
  for (let y = 1; y < plan.height - 1 && count < 34; y++) {
    for (let x = 1; x < plan.width - 1 && count < 34; x++) {
      if (plan.tiles[y * plan.width + x] !== 0) continue
      if (seededRandom(x, y) > (plan.floor === HUB_FLOOR ? 0.045 : 0.06)) continue
      const wall = DIRS.find(([dx, dy]) => !isWalkable(plan, x + dx, y + dy))
      if (!wall) continue
      const rotY = Math.atan2(wall[0], wall[1]) + Math.PI
      // A caged lantern mounted mid-wall (no flame) — pure fitting variety.
      if (lanternTemplate && plan.floor !== HUB_FLOOR && seededRandom(x * 2 + 1, y) < 0.4) {
        const lantern = lanternTemplate.clone(true)
        lantern.position.set(x + 0.5 + wall[0] * 0.42, 0.95, y + 0.5 + wall[1] * 0.42)
        lantern.rotation.y = rotY
        lantern.scale.setScalar(0.9)
        group.add(lantern)
        count++
        continue
      }
      // The pack torch has no flame of its own; give it a flickering one.
      const torch = torchTemplate.clone(true)
      torch.position.set(x + 0.5 + wall[0] * 0.38, 0, y + 0.5 + wall[1] * 0.38)
      torch.rotation.y = rotY
      torch.scale.setScalar(1.2)
      const flame = new Mesh(flameGeometry, flameMaterial)
      flame.position.y = 1.12
      flame.scale.set(1, 1.8, 1)
      torch.add(flame)
      flames.push({ mesh: flame, base: 1.8, offset: x * 7 + y })
      group.add(torch)
      count++
    }
  }
  floorGroup.add(group)
}

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
  // The player's chosen character rides the server snapshot; fall back to a
  // deterministic hash if it's somehow missing or unknown.
  const characterName = isCharacter(player.character) ? player.character : characterFor(player.id)
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
  // Swap in the chosen outfit colorway (designed texture variant, not a dye).
  // The accent color is a chat/leaderboard/nameplate identity only.
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

  // The shared clips bind to the clone by bone name (every character uses the
  // universal skeleton), so one library animates all of them.
  const mixer = new AnimationMixer(model)
  const actions: Record<string, AnimationAction> = {}
  for (const clip of sharedClips) {
    actions[clip.name] = mixer.clipAction(clip)
  }
  // Death is a one-shot: collapse once and hold the fallen pose (rather than
  // looping) until the hub respawn clears it.
  const death = actions[CLIP.death]
  if (death) {
    death.setLoop(LoopOnce, 1)
    death.clampWhenFinished = true
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
  x: currentPlan.start.x,
  y: currentPlan.start.y,
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

// Floor changes (teleport circle, exits, deaths) and the midnight rollover
// rebuild the world around us.
watch([() => props.game.selfFloor.value, () => props.game.seed.value], () => {
  currentPlan = getPlan(props.game.selfFloor.value)
  buildFloor()
  boomDist = MAX_BOOM // fresh floor — don't ease the boom from a stale distance
  const self = props.game.selfId.value ? props.game.players.get(props.game.selfId.value) : undefined
  if (self) {
    local.x = self.x
    local.y = self.y
    local.z = self.z
    local.vz = 0
    local.facing = self.angle
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
  const blocked = (x: number, z: number) => !isWalkable(currentPlan, Math.floor(x), Math.floor(z))
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
/* Hub Oracle: the ancient seer by the portal. Unlike the player characters    */
/* (shared universal skeleton + shared clips), this monster carries its own    */
/* rig and animation clips inside its GLB, so it gets its own mixer.           */
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
  group.position.set(ORACLE_TILE.x, -raw.min.y * scale, ORACLE_TILE.y)
  // Face south toward the plaza, watching runners come up from the spawn. (Flip
  // by Math.PI if the source model turns out to face the other way.)
  group.rotation.y = Math.atan2(HUB_LAYOUT.exit.x - ORACLE_TILE.x, HUB_LAYOUT.start.y - ORACLE_TILE.y)

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

    // A dying player is frozen where they fell — ignore input until respawn.
    const selfDying = self.dying === true
    let drive = selfDying ? 0 : (props.held.forward ? 1 : 0) - (props.held.back ? 1 : 0)
    const strafe = selfDying ? 0 : (props.held.right ? 1 : 0) - (props.held.left ? 1 : 0)
    // A dash from a standstill still launches you forward (camera-relative),
    // rather than rolling on the spot with no input to accelerate.
    if (selfDashing && !selfDying && drive === 0 && strafe === 0) drive = 1
    let dx = 0
    let dy = 0
    if (drive !== 0 || strafe !== 0) {
      const len = Math.hypot(drive, strafe)
      const dash = selfDashing ? DASH_MULTIPLIER : 1
      const speed = PLAYER_SPEED * floorSpeed(currentPlan.floor) * dash * dt / len
      const cos = Math.cos(props.view.yaw)
      const sin = Math.sin(props.view.yaw)
      dx = (cos * drive - sin * strafe) * speed
      dy = (sin * drive + cos * strafe) * speed
      // Pivot to face the way we're actually moving (camera-relative), so a
      // free-orbit mouse-look never spins us on the spot while standing still.
      local.facing += angleDelta(Math.atan2(dy, dx), local.facing) * (1 - Math.exp(-dt * CHARACTER_TURN_RATE))
    }
    stepBody(currentPlan, local, dx, dy, dt)

    if (self.floor === currentPlan.floor) {
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
    const targetBoom = clipBoom(headX, headZ, -Math.cos(yaw), -Math.sin(yaw), MAX_BOOM)
    boomDist = targetBoom < boomDist
      ? targetBoom
      : boomDist + (targetBoom - boomDist) * (1 - Math.exp(-dt * 9))
    let camHeight = Math.max(local.z + 0.35, local.z + 1.5 + pitch * 1.8)
    // Keep the camera just under the interior ceiling so it never pops through
    // it at a jump's apex (the hub is open to the sky, so it isn't capped).
    if (currentPlan.floor !== HUB_FLOOR) camHeight = Math.min(camHeight, WALL_HEIGHT - 0.25)
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

  // Sky, weather, fog — shared clock, biome-tinted. The hub is pinned to a
  // bright, calm midday so the village reads clearly (no dusk/storm murk).
  {
    const sky = currentPlan.floor === HUB_FLOOR
      ? { sunAngle: 1, sunHeight: 0.9, dayness: 1, overcast: 0, rain: 0 }
      : computeSky(serverNow)
    const look = lookFor(currentPlan)

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

    fogColor.set(look.fog)
    fogColor.lerp(skyColor, 0.25)
    fogColor.multiplyScalar(0.35 + 0.65 * sky.dayness)
    fog.color.copy(fogColor)
    fog.density = look.fogDensity * (1 + sky.rain * 0.5 + sky.overcast * 0.15)

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

    // Lower ambient outdoors so the sun's shadows actually read; the hemisphere
    // fill (hub only) softens them without flattening. Dungeons keep flat ambient.
    const outdoor = currentPlan.floor === HUB_FLOOR
    ambient.intensity = (outdoor ? 0.12 : 0.22) + sky.dayness * (outdoor ? 0.28 : 0.45) * (1 - sky.overcast * 0.5)
    hemi.intensity = outdoor ? 0.55 : 0

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
  }

  // Hazards: rise when lethal (same clock the server kills with).
  for (const { trap, hazard } of trapVisuals) {
    const target = isTrapActive(trap, serverNow) ? 1 : 0.02
    hazard.scale.y += (target - hazard.scale.y) * Math.min(1, dt * 14)
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

    // Only players on your floor are visible (the spectator map shows the rest).
    rig.group.visible = player.floor === currentPlan.floor
    if (!rig.group.visible) continue

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

    const dying = player.dying === true

    // The dash plays the sprint loop. Its speed burst only lasts DASH_DURATION,
    // so on the dash's rising edge we latch a slightly longer window and hold
    // the sprint for it, letting it read as a burst before run/idle resume.
    // START is the sprint's rate at the burst; it eases linearly to END across
    // the window so the sprint decelerates into run/idle instead of cutting off.
    const DASH_ANIM_START_RATE = 1.5
    const DASH_ANIM_END_RATE = 1.0
    const DASH_ANIM_WINDOW = 0.5
    if (dashing && now >= rig.dashAnimUntil) rig.dashAnimUntil = now + DASH_ANIM_WINDOW * 1000

    // Animation state: death > dash > airborne > run > idle. Sustain the sprint
    // past the burst only while actually moving; a standstill dash stops
    // translating when the burst ends, so we drop to idle then, not churn.
    if (dying) {
      // Scale the death clip to play through fully within the respawn delay.
      const clip = rig.actions[CLIP.death]?.getClip()
      setAnimation(rig, CLIP.death, clip ? clip.duration / DEATH_DELAY : 2)
    }
    else if (now < rig.dashAnimUntil && (dashing || moving)) {
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

  // Hub Oracle: spawn it once its model lands, run its idle animation, float a
  // bubble when it speaks in chat, and track proximity (drives the hub hint).
  if (currentPlan.floor === HUB_FLOOR) {
    oracleRig ??= createOracleRig()
    if (oracleRig) {
      oracleRig.mixer.update(dt)
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
    const dist = self ? Math.hypot(local.x - ORACLE_TILE.x, local.y - ORACLE_TILE.y) : Infinity
    oracle.near.value = dist < ORACLE_NEAR
  }
  else if (oracle.near.value) {
    oracle.near.value = false
  }

  // Ambient animation: exit-portal spin, hub gate swirl, torch flicker.
  const ring = exitPortal.children[0]
  if (ring) ring.rotation.y = elapsed * 0.8
  hubPortal?.update(elapsed, dt)
  for (const flame of flames) {
    flame.mesh.scale.y = flame.base * (1 + Math.sin(elapsed * 11 + flame.offset) * 0.12)
    const wobble = 1 + Math.sin(elapsed * 17 + flame.offset) * 0.08
    flame.mesh.scale.x = wobble
    flame.mesh.scale.z = wobble
  }
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
    const ed = useEditor()
    // Before the village is baked, seed the editable structure layer from the
    // procedural composition so every kit piece is immediately selectable and
    // the first save writes hub-structure.json (the bake).
    if (!HUB_STRUCTURE.length) ed.seedStructure(composeVillage(currentPlan))
    editorCtl = createHubEditor({
      scene: scene.value,
      getCamera: () => (camera.value instanceof PerspectiveCamera ? camera.value : undefined),
      canvas,
      getTemplate: kind => propTemplates.get(kind),
      editor: ed,
    })
    editorCtl.rebuild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__editor = ed
  })
}

onUnmounted(() => {
  editorCtl?.dispose()
  editorCtl = null
  scene.value.remove(ambient, hemi, sun, sun.target, torchLight, rain, skyDome, cloudDome, sunGlow, floorGroup, playerGroup)
})

if (import.meta.dev) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__maze = { local, camera, game: props.game, held: props.held, view: props.view }
}
</script>

<template>
  <TresGroup />
</template>
