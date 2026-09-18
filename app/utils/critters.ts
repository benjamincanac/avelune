import { AnimationMixer, Box3, Group, Mesh, SkinnedMesh, Texture, Vector3 } from 'three'
import type { AnimationAction, AnimationClip, Object3D } from 'three'
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { getSwimmingContact, isWalkable, surfaceHeight, terrainHeight } from '#shared/utils/maze'
import type { World } from '#shared/utils/world'
import { CHUNK_SIZE, chunkKey, isTownChunk } from '#shared/utils/world'
import { COURTYARD } from '#shared/utils/courtyard'
import { LANDSCAPE_CENTER, worldTerrainHeight } from '#shared/utils/terrain'
import { biomeAt } from '#shared/utils/biome'
import type { Biome } from '#shared/utils/biome'
import { applyCharacterRim } from './characterRim'
import { disposeCharacterSkeleton } from './characterModels'

/**
 * Ambient wildlife.
 *
 * Every critter here is a **client-side cosmetic**. The server has no notion of
 * an NPC: nothing in this file reaches the wire, nothing enters `shared/` state
 * and nothing can move, block or collide with a player. Two players standing in
 * the same meadow do not see the same bunny in the same place, and that is
 * accepted — the alternative is a second authoritative actor set, which the
 * 20 Hz tick does not have and should not grow one for decoration.
 *
 * It does not conflict with the shared-kinematics invariant because it never
 * simulates a player. It *reads* the shared helpers — `surfaceHeight`,
 * `isWalkable`, `getSwimmingContact` — so a critter stands on the same, possibly
 * terraformed, ground that player rendering does, and stays out of the moat and
 * off the sides of buildings.
 *
 * Placement is deterministic per chunk from `(seed, cx, cy)` and the biome at
 * the spawn point, so a chunk keeps its cast for as long as this session holds
 * it, and a chunk's critters are disposed with the chunk.
 */

/* -------------------------------------------------------------------------- */
/* The cast                                                                   */
/* -------------------------------------------------------------------------- */

interface Species {
  /** Basename under `public/models/monsters/`. */
  file: string
  /** Target height in world units; the GLB is normalised to it by bounding box. */
  height: number
  idle: string
  walk?: string
  /** Flight or a bolt away from a player. Falls back to `walk`. */
  run?: string
  /** Radians added to the heading. The packs do not agree on a forward axis, so
   *  this is per species and set by eye: 0 means the model faces +z. */
  yaw: number
  /** Cruise and flee speed, units per second. */
  speed: number
  fleeSpeed: number
  /** Flyers ignore the ground and hold this far above it. */
  hover?: number
  /** Only out after dark (`dayness` below `NIGHT_DAYNESS`). */
  nocturnal?: boolean
}

const SPECIES = {
  Chicken: { file: 'Chicken', height: 0.45, idle: 'Idle', walk: 'Walk', run: 'Jump', yaw: 0, speed: 0.8, fleeSpeed: 2.2 },
  Bunny: { file: 'Bunny', height: 0.5, idle: 'Idle', walk: 'Walk', run: 'Run', yaw: 0, speed: 1, fleeSpeed: 3.4 },
  Frog: { file: 'Frog', height: 0.35, idle: 'Idle', walk: 'Walk', run: 'Jump', yaw: 0, speed: 0.7, fleeSpeed: 2.4 },
  Mushnub: { file: 'Mushnub', height: 0.6, idle: 'Idle', walk: 'Walk', run: 'Jump', yaw: 0, speed: 0.6, fleeSpeed: 1.6 },
  Pigeon: { file: 'Pigeon', height: 0.3, idle: 'Flying_Idle', walk: 'Flying_Idle', run: 'Fast_Flying', yaw: 0, speed: 0.9, fleeSpeed: 5.5, hover: 0.5 },
  Ghost: { file: 'Ghost', height: 1.2, idle: 'Flying_Idle', walk: 'Flying_Idle', run: 'Fast_Flying', yaw: 0, speed: 0.5, fleeSpeed: 1.8, hover: 0.9, nocturnal: true },
  Dragon: { file: 'Dragon', height: 6, idle: 'Flying_Idle', walk: 'Fast_Flying', run: 'Fast_Flying', yaw: 0, speed: 9, fleeSpeed: 9, hover: 0 },
} as const satisfies Record<string, Species>

type SpeciesName = keyof typeof SPECIES

/** Who lives where, and how many a chunk may hold. The wooded biomes get the
 *  mushroom folk; the heath and the high country get a ghost, which only comes
 *  out at night. The list only says *who*, never how many: how often a chunk
 *  hatches anybody at all is the roll in `plan`, which is where the mountains
 *  are thinned. */
const RESIDENTS: Record<Biome, readonly SpeciesName[]> = {
  meadow: ['Bunny', 'Bunny', 'Frog'],
  forest: ['Mushnub', 'Bunny', 'Frog'],
  pinewood: ['Mushnub', 'Mushnub', 'Bunny'],
  grove: ['Mushnub', 'Bunny', 'Bunny'],
  heath: ['Ghost'],
  mountain: ['Ghost'],
}

/** Inside the walls it is poultry and pigeons, nothing wild. */
const TOWNSFOLK: readonly SpeciesName[] = ['Chicken', 'Chicken', 'Pigeon', 'Pigeon']

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

/** Hard cap on live critters. Each is a skinned clone with its own mixer, which
 *  is the expensive part: the geometry is shared with its template. */
const MAX_LIVE = 24
/** Candidate spawns per chunk, thinned by biome and by ground. */
const PER_CHUNK = 3
/** Beyond this from the camera a critter is hidden and its mixer left alone. */
const CULL_DISTANCE = 110
/** Beyond this it animates every other frame. The Dragon is exempt: at altitude
 *  it is always far away and its wingbeat is the whole point. */
const LOD_DISTANCE = 45
/** A player this close sends a critter running. */
const FLEE_RADIUS = 4
/** How far a critter strays from where it was spawned. */
const HOME_RADIUS = 7
/** Below this `dayness` the nocturnal cast is out. */
const NIGHT_DAYNESS = 0.3
/** Turn rate, radians per second. */
const TURN_RATE = 6

/** The Dragon's slow wide orbit around the town: far enough out and high enough
 *  up to read as scale rather than as something you could reach. */
const DRAGON_RADIUS = 210
const DRAGON_HEIGHT = 86
const DRAGON_PERIOD = 240
/** How far it clears whatever is under it, when the ground is higher than the
 *  cruise altitude. On the default seed the orbit's tallest ground is 51 units,
 *  so this never fires there; another seed can put a 74-unit summit on the
 *  circle, and a dragon through a peak is worse than one flying a little high. */
const DRAGON_CLEARANCE = 30

/* -------------------------------------------------------------------------- */

/** A rendered body a critter runs from: the same shape the grass pushers and
 *  the fountain wakes already take. */
export interface CritterActor {
  x: number
  z: number
  feetY: number
}

interface Template {
  scene: Group
  clips: AnimationClip[]
}

type Behaviour = 'idle' | 'wander' | 'flee'

interface Critter {
  name: SpeciesName
  spec: Species
  group: Group
  model: Object3D
  mixer: AnimationMixer
  actions: Map<string, AnimationAction>
  clip: string
  behaviour: Behaviour
  until: number
  homeX: number
  homeY: number
  x: number
  y: number
  z: number
  targetX: number
  targetY: number
  heading: number
  /** Accumulated dt for the halved distant update rate. */
  carry: number
  skip: boolean
}

interface Spawn {
  name: SpeciesName
  x: number
  y: number
}

interface Resident {
  critters: Critter[]
  /** Spawns whose species GLB has not landed yet. */
  pending: Spawn[]
}

/** Stable hash per chunk and index, its own sequence so a critter's position is
 *  not tied to whatever else hashes the same chunk. */
function hash(seed: number, cx: number, cy: number, n: number): number {
  let h = Math.imul(seed ^ 0x6F4A7C15, 0x85EBCA6B)
  h = Math.imul(h ^ cx, 0xC2B2AE35)
  h = Math.imul(h ^ cy, 0x27D4EB2F)
  h = Math.imul(h ^ n, 0x165667B1)
  h ^= h >>> 15
  h = Math.imul(h, 0x2545F491)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

export interface CrittersOptions {
  /** Where the rigs are parented. Cleared wholesale on dispose. */
  parent: Group
  /** The same meshopt-registered loader the templates use. */
  loader: GLTFLoader
  /** Read-only: ground height, walkability and water. Never written. */
  world: World
  seed: number
  /** Bumped whenever the scene gains or loses objects, for the GTAO cache. */
  onChange?: () => void
}

export function createCritters(options: CrittersOptions) {
  const { parent, loader, world, seed } = options
  const templates = new Map<SpeciesName, Template>()
  const loading = new Set<SpeciesName>()
  const failed = new Set<SpeciesName>()
  const residents = new Map<string, Resident>()
  let dragon: Critter | null = null
  let live = 0
  let disposed = false
  const bounds = new Box3()
  const size = new Vector3()

  function ensureTemplate(name: SpeciesName) {
    if (templates.has(name) || loading.has(name) || failed.has(name)) return
    loading.add(name)
    loader.loadAsync(`/models/monsters/${SPECIES[name].file}.glb`).then((gltf) => {
      loading.delete(name)
      if (disposed) return
      // Critters are lit like the characters, not like the town: no pigment
      // projection, just the shared rim so they read against the sky.
      applyCharacterRim(gltf.scene)
      templates.set(name, { scene: gltf.scene, clips: gltf.animations })
    }).catch((error) => {
      loading.delete(name)
      failed.add(name)
      console.warn(`[critters] ${name} could not load`, error)
    })
  }

  /**
   * The ground a critter may stand on here, or null for nowhere it belongs:
   * an unmounted chunk (`surfaceHeight` reads -Infinity there), a wall, water,
   * or — for a walker taking a step — a rise it would have to climb. `from` is
   * the height it is stepping off; null means "no step, just tell me the
   * ground", which is what a spawn asks.
   *
   * All three tests are the shared read-only helpers, so a critter stands on the
   * same terraformed ground player rendering puts a player on.
   */
  function standable(x: number, y: number, from: number | null, flying: boolean): number | null {
    // A flyer is allowed over roofs and walls; a walker is not.
    if (!flying && !isWalkable(world, Math.floor(x), Math.floor(y))) return null
    const h = surfaceHeight(world, x, y, from === null || flying ? Number.POSITIVE_INFINITY : from + 0.6)
    if (!Number.isFinite(h)) return null
    if (!flying && from !== null && Math.abs(h - from) > 0.7) return null
    // A spawn asks with no step to compare against, so the highest surface wins
    // and a walker would hatch on a roof or a wall top. Walkers start on the
    // ground; a flyer may perch up there.
    if (!flying && from === null && h - terrainHeight(world, x, y) > 0.7) return null
    if (getSwimmingContact(world, { x, y, z: h })) return null
    return h
  }

  function build(spawn: Spawn, now: number): Critter | null {
    const template = templates.get(spawn.name)
    if (!template) return null
    const spec = SPECIES[spawn.name] as Species
    const model = SkeletonUtils.clone(template.scene)
    model.updateMatrixWorld(true)
    bounds.setFromObject(model)
    bounds.getSize(size)
    const scale = spec.height / Math.max(0.001, size.y)
    model.scale.setScalar(scale)
    model.traverse((obj) => {
      // A skinned bounding box is the rest pose's; culling on it pops limbs.
      if (obj instanceof SkinnedMesh) obj.frustumCulled = false
      if (obj instanceof Mesh) {
        obj.castShadow = true
        obj.receiveShadow = false
        // The blanket shadow sweep would otherwise flip these back.
        obj.userData.shadowTagged = true
      }
    })
    // Sit the model's lowest point on the group's origin, whatever its pivot.
    model.position.y = -bounds.min.y * scale
    const group = new Group()
    group.add(model)
    const mixer = new AnimationMixer(model)
    const actions = new Map<string, AnimationAction>()
    for (const clip of template.clips) actions.set(clip.name, mixer.clipAction(clip))
    const ground = spawn.name === 'Dragon' ? DRAGON_HEIGHT : (standable(spawn.x, spawn.y, null, !!spec.hover) ?? 0)
    const critter: Critter = {
      name: spawn.name,
      spec,
      group,
      model,
      mixer,
      actions,
      clip: '',
      behaviour: 'idle',
      until: now + hash(seed, spawn.x | 0, spawn.y | 0, 7) * 3000,
      homeX: spawn.x,
      homeY: spawn.y,
      x: spawn.x,
      y: spawn.y,
      z: ground + (spec.hover ?? 0),
      targetX: spawn.x,
      targetY: spawn.y,
      heading: hash(seed, spawn.x | 0, spawn.y | 0, 9) * Math.PI * 2,
      carry: 0,
      skip: false,
    }
    play(critter, spec.idle, 0)
    parent.add(group)
    live++
    options.onChange?.()
    return critter
  }

  function play(critter: Critter, clip: string, fade = 0.25) {
    if (critter.clip === clip) return
    const next = critter.actions.get(clip)
    if (!next) return
    const previous = critter.actions.get(critter.clip)
    next.reset().setEffectiveWeight(1).play()
    if (previous && fade > 0) previous.crossFadeTo(next, fade, false)
    else if (previous) previous.stop()
    critter.clip = clip
  }

  function destroy(critter: Critter) {
    parent.remove(critter.group)
    critter.mixer.stopAllAction()
    critter.mixer.uncacheRoot(critter.model)
    // Geometry and materials belong to the shared template; this clone's bone
    // texture is the only GPU resource it owns.
    disposeCharacterSkeleton(critter.model)
    critter.group.clear()
    live--
  }

  /** The cast a chunk would hold, before the templates or the budget have a say. */
  function plan(cx: number, cy: number): Spawn[] {
    const out: Spawn[] = []
    const town = isTownChunk(cx, cy)
    for (let n = 0; n < PER_CHUNK; n++) {
      const x = (cx * CHUNK_SIZE) + hash(seed, cx, cy, n * 6 + 1) * CHUNK_SIZE
      const y = (cy * CHUNK_SIZE) + hash(seed, cx, cy, n * 6 + 2) * CHUNK_SIZE
      // Inside the walls it is the town's own cast; the outer tiles of a town
      // chunk are ordinary country and get their biome's.
      const inside = town && x > COURTYARD.min && x < COURTYARD.max && y > COURTYARD.min && y < COURTYARD.max
      const biome = inside ? undefined : biomeAt(seed, x, y)
      const roster = biome ? RESIDENTS[biome] : TOWNSFOLK
      const roll = hash(seed, cx, cy, n * 6 + 3)
      // Most candidates come to nothing: a chunk with three critters on it every
      // time would read as a petting zoo, and the budget would go to the
      // nearest few chunks. The high country is thinner still — bare rock and
      // snow with the odd ghost on it after dark reads as empty, which is the
      // point of it.
      if (roll > (inside ? 0.5 : biome === 'mountain' ? 0.1 : 0.34)) continue
      let name = roster[Math.floor(hash(seed, cx, cy, n * 6 + 4) * roster.length)]!
      // Frogs want water. There is no cheap "nearest pond", so probe the point
      // itself and its surroundings; failing that they are rare.
      if (name === 'Frog' && !nearWater(x, y) && hash(seed, cx, cy, n * 6 + 5) > 0.15) name = 'Bunny'
      out.push({ name, x, y })
    }
    return out
  }

  /** A cheap four-point probe for standing water beside a point. */
  function nearWater(x: number, y: number): boolean {
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
      const h = surfaceHeight(world, x + dx, y + dy, Number.POSITIVE_INFINITY)
      if (Number.isFinite(h) && getSwimmingContact(world, { x: x + dx, y: y + dy, z: h })) return true
    }
    return false
  }

  return {
    /** A chunk is now drawn in detail: give it its cast. Idempotent. */
    mount(cx: number, cy: number) {
      if (disposed) return
      const key = chunkKey(cx, cy)
      if (residents.has(key)) return
      const pending = plan(cx, cy)
      for (const spawn of pending) ensureTemplate(spawn.name)
      residents.set(key, { critters: [], pending })
    },
    /** The chunk has gone: so does everything living on it. */
    unmount(cx: number, cy: number) {
      const key = chunkKey(cx, cy)
      const entry = residents.get(key)
      if (!entry) return
      residents.delete(key)
      for (const critter of entry.critters) destroy(critter)
      if (entry.critters.length) options.onChange?.()
    },
    /**
     * One frame: hatch what is waiting on its model, then walk, flee and animate
     * what is alive. `dayness` is the sky's own (0 at night), so the nocturnal
     * cast follows the shared server clock rather than a local guess.
     */
    update(dt: number, now: number, actors: readonly CritterActor[], eye: Vector3 | undefined, dayness: number) {
      if (disposed) return
      const night = dayness < NIGHT_DAYNESS
      // Hatch at most one a frame: a burst of chunk mounts must not build eight
      // skinned clones in the same frame as the terrain they stand on.
      if (live < MAX_LIVE) {
        for (const entry of residents.values()) {
          if (!entry.pending.length) continue
          const index = entry.pending.findIndex(s => templates.has(s.name) && (night || !(SPECIES[s.name] as Species).nocturnal))
          if (index < 0) continue
          const spawn = entry.pending[index]!
          const spec = SPECIES[spawn.name] as Species
          // Nothing hatches where there is no ground under it; the spawn point
          // is dropped rather than retried, so a cliff stays empty.
          if (spawn.name === 'Dragon' || standable(spawn.x, spawn.y, null, !!spec.hover) !== null) {
            const critter = build(spawn, now)
            if (critter) entry.critters.push(critter)
          }
          entry.pending.splice(index, 1)
          break
        }
      }

      // One Dragon for the whole world, on a slow wide orbit around the town.
      // It is not a chunk resident: it is scale, and it has to be there whichever
      // side of the town you are standing on.
      if (!dragon) {
        ensureTemplate('Dragon')
        if (templates.get('Dragon')) {
          dragon = build({ name: 'Dragon', x: LANDSCAPE_CENTER + DRAGON_RADIUS, y: LANDSCAPE_CENTER }, now)
          if (dragon) play(dragon, SPECIES.Dragon.walk, 0)
        }
      }
      if (dragon) {
        const angle = (now / 1000 / DRAGON_PERIOD) * Math.PI * 2
        dragon.x = LANDSCAPE_CENTER + Math.cos(angle) * DRAGON_RADIUS
        dragon.y = LANDSCAPE_CENTER + Math.sin(angle) * DRAGON_RADIUS
        // Ranges reach 74 units, and the orbit is a fixed circle: on some seed it
        // runs straight through a summit. So the cruise altitude is a floor, not a
        // height — the generated ground under the nose lifts it when it has to.
        // `worldTerrainHeight` and not `terrainHeight`, because most of the orbit
        // is over chunks this client never loads, where the latter reads -Infinity.
        dragon.z = Math.max(DRAGON_HEIGHT, worldTerrainHeight(dragon.x, dragon.y, seed) + DRAGON_CLEARANCE)
        // Tangent to the orbit: the velocity is (-sin, cos) in x/z, and a heading
        // is atan2(x, z) like every walker's, so the nose leads the way round.
        dragon.heading = Math.atan2(-Math.sin(angle), Math.cos(angle))
        dragon.group.position.set(dragon.x, dragon.z, dragon.y)
        dragon.group.rotation.y = dragon.heading + dragon.spec.yaw
        dragon.mixer.update(dt)
      }

      for (const entry of residents.values()) {
        for (const critter of entry.critters) {
          const { spec } = critter
          // Out of sight: nothing moves and no mixer runs. Cheaper than the
          // clip evaluation, and nobody can tell.
          const far = eye ? Math.hypot(eye.x - critter.x, eye.z - critter.y, eye.y - critter.z) : 0
          const hidden = far > CULL_DISTANCE || (spec.nocturnal && !night)
          if (critter.group.visible === hidden) critter.group.visible = !hidden
          if (hidden) continue

          // Flee: the nearest rendered body inside `FLEE_RADIUS` picks the
          // heading, straight away from it. Self and peers both count — they are
          // the same interpolated feet the grass and the fountain already get.
          let threatX = 0
          let threatY = 0
          let nearest = FLEE_RADIUS
          for (const actor of actors) {
            const d = Math.hypot(actor.x - critter.x, actor.z - critter.y)
            if (d >= nearest) continue
            nearest = d
            threatX = critter.x - actor.x
            threatY = critter.y - actor.z
          }
          if (nearest < FLEE_RADIUS) {
            const length = Math.max(0.001, Math.hypot(threatX, threatY))
            critter.behaviour = 'flee'
            critter.until = now + 1400
            critter.targetX = critter.x + (threatX / length) * 5
            critter.targetY = critter.y + (threatY / length) * 5
          }
          else if (now >= critter.until) {
            if (critter.behaviour === 'idle') {
              const angle = Math.random() * Math.PI * 2
              const reach = 1.5 + Math.random() * (HOME_RADIUS - 1.5)
              critter.behaviour = 'wander'
              critter.until = now + 1500 + Math.random() * 3000
              // Wander around the spawn point, so a critter cannot drift out of
              // the chunk that owns it and outlive its unmount.
              critter.targetX = critter.homeX + Math.cos(angle) * reach
              critter.targetY = critter.homeY + Math.sin(angle) * reach
            }
            else {
              critter.behaviour = 'idle'
              critter.until = now + 1200 + Math.random() * 3500
            }
          }

          const toX = critter.targetX - critter.x
          const toY = critter.targetY - critter.y
          const distance = Math.hypot(toX, toY)
          const moving = critter.behaviour !== 'idle' && distance > 0.25
          if (moving) {
            const speed = (critter.behaviour === 'flee' ? spec.fleeSpeed : spec.speed) * dt
            const step = Math.min(speed, distance)
            const nx = critter.x + (toX / distance) * step
            const ny = critter.y + (toY / distance) * step
            const ground = standable(nx, ny, critter.z - (spec.hover ?? 0), !!spec.hover)
            if (ground === null) {
              // Walked into water, a wall or a hole: stop here and pick again.
              critter.behaviour = 'idle'
              critter.until = now + 600
            }
            else {
              critter.x = nx
              critter.y = ny
              critter.z = ground + (spec.hover ?? 0)
            }
            const want = Math.atan2(toX, toY)
            let delta = want - critter.heading
            delta = Math.atan2(Math.sin(delta), Math.cos(delta))
            critter.heading += delta * Math.min(1, dt * TURN_RATE)
          }
          else if (critter.behaviour === 'wander') {
            critter.behaviour = 'idle'
            critter.until = now + 900 + Math.random() * 2500
          }

          critter.group.position.set(critter.x, critter.z, critter.y)
          critter.group.rotation.y = critter.heading + spec.yaw

          const clip = !moving
            ? spec.idle
            : critter.behaviour === 'flee'
              ? (spec.run ?? spec.walk ?? spec.idle)
              : (spec.walk ?? spec.idle)
          play(critter, clip)
          // Distant critters animate at half rate: the pose is carried over and
          // the accumulated delta applied on the next frame, so the clip still
          // runs at speed, at half the sampling cost.
          if (far > LOD_DISTANCE) {
            critter.carry += dt
            critter.skip = !critter.skip
            if (critter.skip) continue
            critter.mixer.update(critter.carry)
            critter.carry = 0
          }
          else critter.mixer.update(dt)
        }
      }
    },
    /** What is alive, for the dev hook and the verification harness. */
    list() {
      const out = []
      for (const entry of residents.values()) {
        for (const c of entry.critters) out.push({ name: c.name, x: c.x, y: c.y, z: c.z, clip: c.clip, behaviour: c.behaviour, visible: c.group.visible })
      }
      if (dragon) out.push({ name: dragon.name, x: dragon.x, y: dragon.y, z: dragon.z, clip: dragon.clip, behaviour: dragon.behaviour, visible: dragon.group.visible })
      return out
    },
    dispose() {
      disposed = true
      for (const entry of residents.values()) for (const critter of entry.critters) destroy(critter)
      residents.clear()
      if (dragon) destroy(dragon)
      dragon = null
      // The templates are ours alone (no chunk batch borrows a critter mesh), so
      // their geometry, materials and the shared atlas go with them.
      const textures = new Set<Texture>()
      for (const template of templates.values()) {
        template.scene.traverse((object) => {
          if (!(object instanceof Mesh)) return
          object.geometry.dispose()
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
            material.dispose()
          }
        })
      }
      for (const texture of textures) texture.dispose()
      templates.clear()
    },
  }
}

export type Critters = ReturnType<typeof createCritters>
