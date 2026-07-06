<script setup lang="ts">
import {
  AdditiveBlending,
  AmbientLight,
  AnimationMixer,
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
  InstancedMesh,
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
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
} from 'three'
import type { AnimationAction, AnimationClip } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { useLoop, useTresContext } from '@tresjs/core'
import type { MoveInput } from '#shared/types/game'
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { FloorPlan, Trap } from '#shared/utils/maze'
import {
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_MULTIPLIER,
  HUB_FLOOR,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  dateSeed,
  floorSpeed,
  generateFloor,
  isTrapActive,
  isWalkable,
  stepBody,
} from '#shared/utils/maze'
import type { StonePalette } from '~/utils/textures'
import { makeBrickTexture, makeCobbleTexture, makeCrackTexture, makeRuneCircleTexture } from '~/utils/textures'

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
 * runs, then blended toward the authoritative position. Heading is fully
 * client-owned (mouse-look), and the camera boom shortens when a wall would
 * block the view.
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

const { scene, camera: cameraManager } = useTresContext()
const camera = cameraManager.activeCamera
const { onBeforeRender } = useLoop()

const WALL_HEIGHT = 2.4
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
  wall: { base: '#716c62', dark: '#5a5549', mortar: '#403d37', moss: '#5a7048', mossAmount: 0.08 },
  ground: { base: '#5a564e', dark: '#4a473f', mortar: '#35322c', moss: '#5a7048', mossAmount: 0.1 },
  fog: '#0b0e15',
  fogDensity: 0.022,
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

/** One directional light serves as sun by day and moon by night. */
const sun = new DirectionalLight('#ffffff', 0.6)
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
/* Floor geometry                                                             */
/* -------------------------------------------------------------------------- */

const planCache = new Map<string, FloorPlan>()

function getPlan(floor: number): FloorPlan {
  const daySeed = props.game.seed.value ?? dateSeed()
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
const textureCache = new Map<number, { wall: CanvasTexture, ground: CanvasTexture }>()

function texturesFor(plan: FloorPlan) {
  let entry = textureCache.get(plan.biome)
  if (!entry) {
    const look = lookFor(plan)
    entry = {
      wall: makeBrickTexture(9000 + plan.biome, look.wall),
      ground: makeCobbleTexture(7000 + plan.biome, look.ground),
    }
    entry.ground.wrapS = RepeatWrapping
    entry.ground.wrapT = RepeatWrapping
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
const runeCircle = new Group()
const runeTexture = import.meta.client ? makeRuneCircleTexture(dateSeed()) : null

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

function buildFloor() {
  floorGroup.clear()
  exitPortal.clear()
  runeCircle.clear()
  trapVisuals = []
  flames.length = 0

  const plan = currentPlan
  const look = lookFor(plan)
  const textures = texturesFor(plan)

  // Ground: pack floor slabs where possible; the Magma Halls keep the
  // procedural emissive-crack floor (the slabs would hide the glow).
  const modularGround = !look.lava && placeModularFloor(plan)
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
  }

  // Walls: one instanced mesh of stone blocks.
  const wallTiles: Array<[number, number]> = []
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (plan.tiles[y * plan.width + x] === 1) wallTiles.push([x, y])
    }
  }
  const walls = new InstancedMesh(
    new BoxGeometry(1, WALL_HEIGHT, 1),
    new MeshStandardMaterial({ map: textures.wall, roughness: 0.95 }),
    wallTiles.length,
  )
  const matrix = new Matrix4()
  wallTiles.forEach(([x, y], i) => {
    walls.setMatrixAt(i, matrix.makeTranslation(x + 0.5, WALL_HEIGHT / 2, y + 0.5))
  })
  floorGroup.add(walls)

  // Hazards.
  for (const trap of plan.traps) {
    const base = new Mesh(
      new CircleGeometry(0.42, 20),
      new MeshBasicMaterial({ color: '#0a0a0a', transparent: true, opacity: 0.55 }),
    )
    base.rotation.x = -Math.PI / 2
    base.position.set(trap.x, 0.02, trap.y)
    floorGroup.add(base)

    const hazard = buildTrapMesh(look.trap)
    hazard.position.set(trap.x, 0, trap.y)
    hazard.scale.y = 0.02
    floorGroup.add(hazard)
    trapVisuals.push({ trap, hazard })
  }

  if (plan.floor === HUB_FLOOR) {
    buildRuneCircle(plan)
  }
  else {
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
  }

  placeTorches(plan)
  placeProps(plan)
  placeArchitecture(plan)
}

/**
 * Pack floor slabs on a 2x2 grid, sunk so their tops sit at ~+0.01. Returns
 * false while the modules are still downloading (the plane covers meanwhile).
 */
function placeModularFloor(plan: FloorPlan): boolean {
  if (propTemplates.size < PROP_NAMES.length) return false
  const tint = MODULE_TINTS[plan.biome + 1]!
  // Variant name, sink offset (slab height), pick weight.
  const variants: Array<[string, number, number]> = [
    ['Floor_Standard', -0.28, 0.4],
    ['Floor_Squares', -0.11, 0.3],
    ['Floor_Diamond', -0.11, 0.15],
    ['Floor_SquareLarge', -0.1, 0.15],
  ]
  const buckets = new Map<string, Matrix4[]>()
  for (let gy = 0; gy < plan.height - 1; gy += 2) {
    for (let gx = 0; gx < plan.width - 1; gx += 2) {
      let roll = placementHash(plan.seed, gx, gy, 1)
      const variant = variants.find(([, , weight]) => (roll -= weight) <= 0) ?? variants[0]!
      const rotation = Math.floor(placementHash(plan.seed, gx, gy, 2) * 4) * (Math.PI / 2)
      const matrices = buckets.get(variant[0]) ?? []
      matrices.push(placementMatrix(gx + 1, variant[1], gy + 1, rotation, 1))
      buckets.set(variant[0], matrices)
    }
  }
  for (const [name, matrices] of buckets) {
    const group = instantiateModule(name, matrices, tint)
    if (group) floorGroup.add(group)
  }
  return true
}

/**
 * Structural dressing from the Ruins pack: buttresses along corridor walls,
 * arches over passage mouths, a gothic gateway at the exit — and in the hub,
 * a colonnade with broken rails around the teleport circle and ruined curved
 * walls in the corners.
 */
function placeArchitecture(plan: FloorPlan) {
  if (propTemplates.size < PROP_NAMES.length) return
  const tint = MODULE_TINTS[plan.biome + 1]!
  const add = (group: Group | null) => {
    if (group) floorGroup.add(group)
  }

  if (plan.floor === HUB_FLOOR) {
    const cx = plan.exit.x
    const cy = plan.exit.y

    const columns: Matrix4[] = []
    const rails: Matrix4[] = []
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
      columns.push(placementMatrix(cx + Math.cos(angle) * 5.4, 0, cy + Math.sin(angle) * 5.4, -angle, 0.6))
      // Two gaps so parties can walk in from the spawn side and out the far side.
      if (i === 1 || i === 6) continue
      rails.push(placementMatrix(cx + Math.cos(angle) * 3.7, 0, cy + Math.sin(angle) * 3.7, -angle, 1))
    }
    add(instantiateModule('Column_Round', columns, tint))
    add(instantiateModule('Rail_Straight', rails, tint))

    // Ruined curved walls sagging in the plaza corners.
    const curves1: Matrix4[] = []
    const curves2: Matrix4[] = []
    for (const [px, py] of [[4.2, 4.2], [19.8, 4.2], [4.2, 19.8], [19.8, 19.8]] as const) {
      const facing = Math.atan2(cx - px, cy - py)
      const target = placementHash(plan.seed, px * 10, py * 10, 3) < 0.5 ? curves1 : curves2
      target.push(placementMatrix(px, 0, py, facing, 1.15))
    }
    add(instantiateModule('Curve_1_Overgrown', curves1, tint))
    add(instantiateModule('Curve_2_Overgrown', curves2, tint))
    return
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

  // Arches over some passage mouths between cells.
  const cells = (plan.width - 1) / 3
  const gothic: Matrix4[] = []
  const round: Matrix4[] = []
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      // Passage east of (cx, cy).
      if (cx < cells - 1 && plan.tiles[(cy * 3 + 1) * plan.width + cx * 3 + 3] === 0
        && placementHash(plan.seed, cx, cy, 6) < 0.3) {
        const bucket = placementHash(plan.seed, cx, cy, 7) < 0.5 ? gothic : round
        bucket.push(placementMatrix(cx * 3 + 3.5, 0, cy * 3 + 2, Math.PI / 2, 0.78))
      }
      // Passage south of (cx, cy).
      if (cy < cells - 1 && plan.tiles[(cy * 3 + 3) * plan.width + cx * 3 + 1] === 0
        && placementHash(plan.seed, cx, cy, 8) < 0.3) {
        const bucket = placementHash(plan.seed, cx, cy, 9) < 0.5 ? gothic : round
        bucket.push(placementMatrix(cx * 3 + 2, 0, cy * 3 + 3.5, 0, 0.78))
      }
    }
  }
  // The exit gets a grand gothic gateway around the portal.
  gothic.push(placementMatrix(plan.exit.x, 0, plan.exit.y, Math.PI / 2, 0.8))
  add(instantiateModule('Arch_Gothic', gothic, tint))
  add(instantiateModule('Arch_Round', round, tint))
}

/** The hub's teleport circle: rotating runes, counter-ring, beam, and glow. */
function buildRuneCircle(plan: FloorPlan) {
  if (!runeTexture) return
  const material = new MeshBasicMaterial({
    map: runeTexture,
    color: '#8b7bff',
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  })
  const outer = new Mesh(new PlaneGeometry(4.6, 4.6), material)
  outer.rotation.x = -Math.PI / 2
  outer.position.y = 0.04
  runeCircle.add(outer)

  const inner = new Mesh(new PlaneGeometry(2.6, 2.6), material.clone())
  inner.rotation.x = -Math.PI / 2
  inner.position.y = 0.07
  runeCircle.add(inner)

  const beam = new Mesh(
    new CylinderGeometry(1.7, 1.9, 9, 32, 1, true),
    new MeshBasicMaterial({
      color: '#8b7bff',
      transparent: true,
      opacity: 0.07,
      blending: AdditiveBlending,
      side: DoubleSide,
      depthWrite: false,
    }),
  )
  beam.position.y = 4.5
  runeCircle.add(beam)

  const glow = new PointLight('#8b7bff', 8, 12)
  glow.position.y = 1.4
  runeCircle.add(glow)

  runeCircle.position.set(plan.exit.x, 0, plan.exit.y)
  floorGroup.add(runeCircle)
}

/* -------------------------------------------------------------------------- */
/* Blender-authored assets (see scripts/make_assets.py)                       */
/* -------------------------------------------------------------------------- */

const gltfLoader = new GLTFLoader()

/**
 * Animated characters from Quaternius' CC0 Ultimate Animated Character Pack
 * (converted by scripts/convert_characters.py, with Idle/Run/Jump/Roll clips).
 * Each player is deterministically assigned one from their id.
 */
const CHARACTERS = [
  'Knight_Male', 'Knight_Golden_Female', 'Elf', 'Witch',
  'Wizard', 'Viking_Male', 'Goblin_Female', 'Ninja_Male',
]

interface CharacterTemplate {
  scene: Group
  clips: AnimationClip[]
}

const characterTemplates = new Map<string, CharacterTemplate>()
const characterLoading = new Set<string>()

function characterFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return CHARACTERS[hash % CHARACTERS.length]!
}

function ensureCharacter(name: string) {
  if (characterTemplates.has(name) || characterLoading.has(name)) return
  characterLoading.add(name)
  gltfLoader.loadAsync(`/models/characters/${name}.glb`).then((gltf) => {
    characterTemplates.set(name, { scene: gltf.scene, clips: gltf.animations })
  })
}

const flames: Array<{ mesh: Mesh, base: number, offset: number }> = []
const flameGeometry = new OctahedronGeometry(0.07, 1)
const flameMaterial = new MeshBasicMaterial({ color: '#ffb545' })

/**
 * Quaternius "Ultimate Modular Ruins" props (CC0), converted from .blend to
 * GLB by scripts/convert_props.py. The hub gets a fixed arrangement; floors
 * get deterministic biome-flavored scatter.
 */
const PROP_NAMES = [
  'Statue_Fox', 'Statue_Stag', 'Cart', 'Crate', 'Barrel', 'Chest', 'Flag_Wall',
  'Bricks', 'Skull', 'Pot1_Broken', 'Pot2_Broken', 'Column_Round_Short',
  'Bush_1x1', 'Bush_Round', 'Grass', 'DeadTree_1', 'Candles_1',
  // Structural modules
  'Floor_Standard', 'Floor_Squares', 'Floor_Diamond', 'Floor_SquareLarge',
  'Arch_Gothic', 'Arch_Round', 'Column_Round', 'Column_Square',
  'Support_Center', 'Support_Left', 'Support_Right', 'Support_Tall',
  'Rail_Straight', 'Curve_1_Overgrown', 'Curve_2_Overgrown', 'Torch',
] as const

/** Subtle per-biome tint multiplied into structural module materials. */
const MODULE_TINTS = ['#ffffff', '#ffffff', '#a8ccd6', '#b4d8a4', '#d89b82']

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

// When the full set has arrived, rebuild so the plane/cube placeholders are
// replaced by pack architecture in one pass.
Promise.all(PROP_NAMES.map(async (name) => {
  const gltf = await gltfLoader.loadAsync(`/models/props/${name}.glb`)
  propTemplates.set(name, gltf.scene)
})).then(() => buildFloor())

/**
 * Props come straight from the plan now (`plan.props`, generated in shared
 * code) — placement must be shared because solid props are walkable surfaces
 * the server simulates too.
 */
function placeProps(plan: FloorPlan) {
  if (propTemplates.size < PROP_NAMES.length) return
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

/** Wall torches scattered deterministically along the corridors. */
function placeTorches(plan: FloorPlan) {
  const torchTemplate = propTemplates.get('Torch')
  if (!torchTemplate) return
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
      // The pack torch has no flame of its own; give it a flickering one.
      const torch = torchTemplate.clone(true)
      torch.position.set(x + 0.5 + wall[0] * 0.38, 0, y + 0.5 + wall[1] * 0.38)
      torch.rotation.y = Math.atan2(wall[0], wall[1]) + Math.PI
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
  bubble: Sprite
  bubbleCanvas: HTMLCanvasElement
  bubbleTexture: CanvasTexture
  bubbleText: string
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
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true }))
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

function drawBubble(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, text: string) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = '40px Geist, ui-sans-serif, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const width = Math.min(ctx.measureText(text).width + 48, 500)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.beginPath()
  ctx.roundRect(256 - width / 2, 24, width, 80, 24)
  ctx.fill()
  ctx.fillStyle = '#111827'
  ctx.fillText(text, 256, 64, 452)
}

function createRig(player: GamePlayer): Rig | null {
  const characterName = characterFor(player.id)
  const template = characterTemplates.get(characterName)
  if (!template) {
    // Kick off the download; the rig appears once it lands.
    ensureCharacter(characterName)
    return null
  }

  const group = new Group()

  // SkeletonUtils.clone keeps the armature bindings intact across copies.
  const model = SkeletonUtils.clone(template.scene)
  // The GLB faces +z; the rig's forward is +x (the group is rotated by -heading).
  model.rotation.y = Math.PI / 2
  model.scale.setScalar(0.5)
  // Tint the accent material (plumes, sashes) in the player's color when the
  // character has one; skinned meshes must keep rendering when bones move
  // them outside their original bounds.
  let tinted: MeshStandardMaterial | undefined
  model.traverse((obj) => {
    if (obj instanceof SkinnedMesh) obj.frustumCulled = false
    if (obj instanceof Mesh && (obj.material as MeshStandardMaterial)?.name === 'Red') {
      tinted ??= (obj.material as MeshStandardMaterial).clone()
      obj.material = tinted
    }
  })
  tinted?.color.set(player.color)
  group.add(model)

  const mixer = new AnimationMixer(model)
  const actions: Record<string, AnimationAction> = {}
  for (const clip of template.clips) {
    actions[clip.name] = mixer.clipAction(clip)
  }
  actions.Idle?.play()

  const name = makeTextSprite((ctx, canvas) => drawName(ctx, canvas, player.name, player.color))
  name.sprite.position.y = 2.05
  group.add(name.sprite)

  const bubble = makeTextSprite(ctx => ctx.clearRect(0, 0, 512, 128))
  bubble.sprite.position.y = 2.4
  bubble.sprite.visible = false
  group.add(bubble.sprite)

  playerGroup.add(group)
  return {
    group,
    mixer,
    actions,
    current: 'Idle',
    bubble: bubble.sprite,
    bubbleCanvas: bubble.canvas,
    bubbleTexture: bubble.texture,
    bubbleText: '',
  }
}

/** Crossfade a rig to a clip (falls back to Idle if the clip is missing). */
function setAnimation(rig: Rig, name: string, timeScale = 1) {
  const target = rig.actions[name] ? name : 'Idle'
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
    // eslint-disable-next-line vue/no-mutating-props
    props.view.yaw = self.angle
  }
})

// Floor changes (teleport circle, exits, deaths) and the midnight rollover
// rebuild the world around us.
watch([() => props.game.selfFloor.value, () => props.game.seed.value], () => {
  currentPlan = getPlan(props.game.selfFloor.value)
  buildFloor()
  const self = props.game.selfId.value ? props.game.players.get(props.game.selfId.value) : undefined
  if (self) {
    local.x = self.x
    local.y = self.y
    local.z = self.z
    local.vz = 0
  }
})

buildFloor()

/** Pull the camera in when a wall sits between it and the player's head. */
function clipBoom(hx: number, hy: number, dirX: number, dirZ: number, maxDist: number): number {
  for (let d = 0.35; d < maxDist; d += 0.12) {
    const sx = hx + dirX * d
    const sz = hy + dirZ * d
    if (!isWalkable(currentPlan, Math.floor(sx), Math.floor(sz))) {
      return Math.max(0.35, d - 0.25)
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

    const drive = (props.held.forward ? 1 : 0) - (props.held.back ? 1 : 0)
    const strafe = (props.held.right ? 1 : 0) - (props.held.left ? 1 : 0)
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
    }
    stepBody(currentPlan, local, dx, dy, dt)

    if (self.floor === currentPlan.floor) {
      if (Math.hypot(self.x - local.x, self.y - local.y) > 3) {
        local.x = self.x
        local.y = self.y
        local.z = self.z
      }
      else {
        const correction = 1 - Math.exp(-dt * 2)
        local.x += (self.x - local.x) * correction
        local.y += (self.y - local.y) * correction
      }
    }
  }

  // Third-person camera: behind the shoulder, pulled in by walls.
  if (camera.value) {
    const yaw = props.view.yaw
    const pitch = props.view.pitch
    const headX = local.x
    const headZ = local.y
    const boom = clipBoom(headX, headZ, -Math.cos(yaw), -Math.sin(yaw), 2.6)
    const camHeight = local.z + 1.5 + pitch * 1.8
    camera.value.position.set(
      headX - Math.cos(yaw) * boom,
      Math.max(local.z + 0.35, camHeight),
      headZ - Math.sin(yaw) * boom,
    )
    camera.value.lookAt(
      headX + Math.cos(yaw) * 1.2,
      local.z + 1 - pitch * 1.2,
      headZ + Math.sin(yaw) * 1.2,
    )
    torchLight.position.set(headX, local.z + 1.7, headZ)
  }

  // Sky, weather, fog — shared clock, biome-tinted.
  {
    const sky = computeSky(serverNow)
    const look = lookFor(currentPlan)

    skyColor.copy(skyNight).lerp(skyDay, sky.dayness)
    const duskiness = clamp01(1 - Math.abs(sky.sunHeight) * 4) * sky.dayness
    skyColor.lerp(skyDusk, duskiness * 0.5)
    skyColor.lerp(new Color('#3f464e'), sky.overcast * 0.55 * sky.dayness)
    ;(scene.value.background as Color).copy(skyColor)

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

    ambient.intensity = 0.22 + sky.dayness * 0.45 * (1 - sky.overcast * 0.5)

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
      // Your own rig follows the *predicted* body and mouse heading.
      player.rx = local.x
      player.ry = local.y
      player.rz = local.z
      player.ra = props.view.yaw
      moving = props.held.forward || props.held.back || props.held.left || props.held.right
      airborne = !local.grounded
      dashing = selfDashing
    }
    else {
      const distance = Math.hypot(player.x - player.rx, player.y - player.ry)
      if (distance > 5) {
        player.rx = player.x
        player.ry = player.y
        player.rz = player.z
        player.ra = player.angle
      }
      else {
        const ease = 1 - Math.exp(-dt * 12)
        player.rx += (player.x - player.rx) * ease
        player.ry += (player.y - player.ry) * ease
        player.rz += (player.z - player.rz) * Math.min(1, dt * 16)
        player.ra += angleDelta(player.angle, player.ra) * ease
      }
      moving = distance > 0.05
      airborne = player.z > 0.12 || player.rz > 0.12
      dashing = player.dashing === true
    }

    rig.group.position.set(player.rx, player.rz, player.ry)
    rig.group.rotation.y = -player.ra

    // Animation state: dash > airborne > run > idle.
    if (dashing) setAnimation(rig, 'Roll', 1.6)
    else if (airborne) setAnimation(rig, 'Jump', 1.1)
    else if (moving) setAnimation(rig, 'Run', 1.15)
    else setAnimation(rig, 'Idle')
    rig.mixer.update(dt)

    // Chat bubble: redraw when the text changes, fade out at the end.
    if (player.bubble && player.bubble.until > now) {
      if (rig.bubbleText !== player.bubble.text) {
        rig.bubbleText = player.bubble.text
        drawBubble(rig.bubbleCanvas.getContext('2d')!, rig.bubbleCanvas, player.bubble.text)
        rig.bubbleTexture.needsUpdate = true
      }
      rig.bubble.visible = true
      rig.bubble.material.opacity = Math.min(1, (player.bubble.until - now) / 300)
    }
    else {
      rig.bubble.visible = false
      rig.bubbleText = ''
    }
  }

  // Ambient animation: portal spin, rune circle rotation, torch flicker.
  const ring = exitPortal.children[0]
  if (ring) ring.rotation.y = elapsed * 0.8
  const outerRunes = runeCircle.children[0]
  const innerRunes = runeCircle.children[1]
  if (outerRunes) outerRunes.rotation.z = elapsed * 0.25
  if (innerRunes) innerRunes.rotation.z = -elapsed * 0.45
  for (const flame of flames) {
    flame.mesh.scale.y = flame.base * (1 + Math.sin(elapsed * 11 + flame.offset) * 0.12)
    const wobble = 1 + Math.sin(elapsed * 17 + flame.offset) * 0.08
    flame.mesh.scale.x = wobble
    flame.mesh.scale.z = wobble
  }
})

// Remove everything we added to the shared scene (also keeps HMR honest —
// a stale setup's lights and geometry would otherwise stack up on reload).
onUnmounted(() => {
  scene.value.remove(ambient, sun, sun.target, torchLight, rain, floorGroup, playerGroup)
})

if (import.meta.dev) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__maze = { local, camera, game: props.game, held: props.held, view: props.view }
}
</script>

<template>
  <TresGroup />
</template>
