import { BufferAttribute, BufferGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, Object3D } from 'three'
import type { MeshStandardMaterial } from 'three'
import { CHUNK_CORNERS, CHUNK_SIZE, HEIGHT_STEP, SURFACE, isProtectedTile } from '#shared/utils/world'
import type { Chunk } from '#shared/utils/world'
import { smoothstep } from '#shared/utils/terrain'
import { biomeAt } from '#shared/utils/biome'
import type { Biome } from '#shared/utils/biome'
import type { HubPropPlacement, WorldPlacement } from '#shared/utils/props'
import { createCanopyShadow } from './foliage'
import { isGrassTile, meadowCover } from './terrainChunk'
import type { HeightSampler } from './terrainChunk'
import { makeCourtyardSurface } from './courtyardTextures'
import { createPaleStone } from './courtyardScene'
import type { GrassBlade } from './courtyardLandscape'
import type { TownMaterials } from './townMaterials'

/**
 * Everything standing on one chunk, drawn as instanced batches.
 *
 * A chunk's `placements` are the unit of rebuild: a player fells a tree and
 * only that chunk's group is thrown away and rebuilt, instead of the whole
 * town. Batching is per kind *per chunk*, which costs more draw calls than one
 * batch for the world but is the price of being able to rebuild a chunk without
 * touching its neighbours.
 *
 * Materials are borrowed from the world's TownMaterials bank. Chunks and
 * authored gardens using the same source and wind clock share one variant.
 */

const placementDummy = new Object3D()

/** Instance matrix for a placed piece, honoring elevation (`z`) and per-axis
 *  scale (`s3`). `PropSpec` is structurally a `HubPropPlacement` with collision
 *  fields, so both generated and authored pieces go through here. */
export function propMatrix(p: HubPropPlacement): Matrix4 {
  const [sx, sy, sz] = p.s3 ?? [p.scale, p.scale, p.scale]
  placementDummy.position.set(p.x, p.z ?? 0, p.y)
  placementDummy.rotation.set(0, p.rot, 0)
  placementDummy.scale.set(sx, sy, sz)
  placementDummy.updateMatrix()
  return placementDummy.matrix.clone()
}

/** Kinds that get a per-instance colour wobble so a stand of the same tree
 *  doesn't read as a photocopy. Green foliage takes a warm/cool wobble that
 *  reads as leaves; the autumn-red crooked trees and the bare dead trunks would
 *  only be dragged toward green by it, so they take a brightness-only one. */
const TINTED = /^(tree|bush|pine)/
const SHADED = /^(twisted|dead)/

export interface ChunkPropsOptions {
  templates: ReadonlyMap<string, Group>
  materials: TownMaterials
  /** The world seed, so the cosmetic scatter can ask `biomeAt` what country a
   *  point stands in. Same number the server hands `generateVegetation`. */
  seed: number
  /** Drives the wind sway on every alpha-cut batch (see utils/foliage). */
  foliageTime: { value: number }
  /** Dev editor: the authored town is rendered as selectable clones by
   *  `hubEditor`, so those placements are left out of the batches. */
  editor?: boolean
}

export function createChunkProps(options: ChunkPropsOptions) {
  const { templates, materials, foliageTime } = options
  const tint = new Color()

  /**
   * Instance a GLB module at many placements: one InstancedMesh per mesh part,
   * with the part's own transform baked into every instance matrix.
   */
  function instantiateModule(name: string, placements: Matrix4[], positions?: readonly HubPropPlacement[]): Group | null {
    const template = templates.get(name)
    if (!template || !placements.length) return null
    template.updateMatrixWorld(true)
    const group = new Group()
    const composed = new Matrix4()
    const tinted = TINTED.test(name)
    const shaded = SHADED.test(name)
    template.traverse((obj) => {
      if (!(obj instanceof Mesh)) return
      const material = materials.batch(obj.material as MeshStandardMaterial, foliageTime)
      const instanced = new InstancedMesh(obj.geometry, material, placements.length)
      placements.forEach((placement, index) => {
        composed.multiplyMatrices(placement, obj.matrixWorld)
        instanced.setMatrixAt(index, composed)
      })
      if ((tinted || shaded) && positions) {
        positions.forEach((p, index) => {
          const variation = 0.5 + Math.sin(p.x * 1.37 + p.y * 0.73) * 0.5
          if (shaded) {
            const value = 0.85 + variation * 0.15
            instanced.setColorAt(index, tint.setRGB(value, value, value))
          }
          else {
            instanced.setColorAt(index, tint.setRGB(0.83 + variation * 0.17, 0.91 + variation * 0.09, 0.76 + variation * 0.2))
          }
        })
      }
      instanced.computeBoundingSphere()
      group.add(instanced)
      if (material.alphaTest > 0) {
        // Alpha-cut leaf cards: the renderer keeps them out of the opaque GTAO
        // pass (see courtyardRenderer), otherwise each card occludes as a quad.
        instanced.userData.foliage = true
        // The cards cast nothing; a stand-in does it for them (see `foliage.ts`).
        instanced.castShadow = false
        instanced.receiveShadow = true
        instanced.userData.shadowTagged = true
        const canopy = createCanopyShadow(instanced)
        if (canopy) group.add(canopy)
      }
    })
    return group
  }

  return {
    instantiateModule,
    /** Everything this chunk owns, as one group per kind. */
    build(chunk: Chunk): Group {
      const group = new Group()
      group.name = `props ${chunk.cx},${chunk.cy}`
      const byKind = new Map<string, WorldPlacement[]>()
      for (const placement of chunk.placements) {
        // The editor authors the town; `hubEditor` draws those as selectable
        // clones, so drawing them here too would double every brick.
        if (options.editor && placement.id.startsWith('town:')) continue
        const list = byKind.get(placement.kind) ?? []
        // Every placement carries its own `z`: the town's is render-only
        // elevation, a wild plant's is the terrain it grew on and a kit piece's
        // is the support height the server resolved. Nothing is bedded here.
        list.push(placement)
        byKind.set(placement.kind, list)
      }
      for (const detail of chunkScatter(chunk, options.seed)) {
        const list = byKind.get(detail.kind) ?? []
        list.push(detail as WorldPlacement)
        byKind.set(detail.kind, list)
      }
      for (const [kind, list] of byKind) {
        const batch = instantiateModule(kind, list.map(propMatrix), list)
        if (batch) group.add(batch)
      }
      return group
    },
    /** Release one chunk's instance buffers. Geometry belongs to the template
     *  and materials to the world bank, so neither is touched. */
    release(group: Group) {
      group.traverse((object) => {
        if (object instanceof InstancedMesh) object.dispose()
      })
      group.clear()
    },

  }
}

export type ChunkProps = ReturnType<typeof createChunkProps>

/* -------------------------------------------------------------------------- */
/* Paving                                                                     */
/* -------------------------------------------------------------------------- */

/** How far the road sits above the ground it is laid on. Enough to clear the
 *  terrain it shares its corner heights with, small enough that the edge of a
 *  paved run does not read as a kerb. */
const ROAD_LIFT = 0.02

/** World units per tile of the stone map: one repeat every 8 tiles, the width
 *  of the gate bridge a road usually starts from. */
const ROAD_UV_SCALE = 1 / 8

/**
 * A player's paving, laid wherever someone paints the `path` surface.
 *
 * It is one flat mesh per chunk rather than a slab per tile: a run of tiles has
 * to read as a continuous road, not as a line of coasters. Every path tile's quad is indexed out of the
 * chunk's own 33×33 corner grid, so neighbouring tiles share their vertices and
 * there is no seam down the middle of a road; UVs are in world tiles, so the
 * stone carries across chunk borders too.
 *
 * It follows the terrain exactly, lifted `ROAD_LIFT`, and takes its normals
 * from the same analytic sampler the ground mesh uses, so a road over a rise is
 * lit as that rise.
 */
export function createPavingBank(materials: TownMaterials) {
  const map = makeCourtyardSurface('stone')
  const material = createPaleStone(materials, map)

  return {
    material,
    /** This chunk's road, or null when nothing on it is paved. */
    patch(chunk: Chunk, sample: HeightSampler): Mesh | null {
      const originX = chunk.cx * CHUNK_SIZE
      const originY = chunk.cy * CHUNK_SIZE
      const indices: number[] = []
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (chunk.surface[ly * CHUNK_SIZE + lx] !== SURFACE.path) continue
          // The town paves itself in `courtyardScene`, and the raster inside the
          // protected footprint is a uniform `path` placeholder — a road there
          // would be a second layer over the authored square.
          // Same integer tile coordinate as `surfaceFor` and the tint pass, or
          // the inclusive edge of the footprint is paved on one side only.
          if (isProtectedTile(originX + lx, originY + ly)) continue
          const i = ly * CHUNK_CORNERS + lx
          indices.push(i, i + CHUNK_CORNERS, i + 1, i + 1, i + CHUNK_CORNERS, i + CHUNK_CORNERS + 1)
        }
      }
      if (!indices.length) return null
      const count = CHUNK_CORNERS * CHUNK_CORNERS
      const positions = new Float32Array(count * 3)
      const normals = new Float32Array(count * 3)
      const uvs = new Float32Array(count * 2)
      for (let ly = 0; ly < CHUNK_CORNERS; ly++) {
        for (let lx = 0; lx < CHUNK_CORNERS; lx++) {
          const i = ly * CHUNK_CORNERS + lx
          const gx = originX + lx
          const gy = originY + ly
          const h = chunk.heights[i]! * HEIGHT_STEP
          positions[i * 3] = lx
          positions[i * 3 + 1] = h + ROAD_LIFT
          positions[i * 3 + 2] = ly
          // Central differences through the caller's sampler, so a corner on a
          // chunk border is lit from the neighbour's heights too.
          const west = sample(gx - 1, gy)
          const east = sample(gx + 1, gy)
          const north = sample(gx, gy - 1)
          const south = sample(gx, gy + 1)
          const dx = ((Number.isFinite(east) ? east : h) - (Number.isFinite(west) ? west : h)) / 2
          const dz = ((Number.isFinite(south) ? south : h) - (Number.isFinite(north) ? north : h)) / 2
          const length = Math.hypot(dx, 1, dz)
          normals[i * 3] = -dx / length
          normals[i * 3 + 1] = 1 / length
          normals[i * 3 + 2] = -dz / length
          uvs[i * 2] = gx * ROAD_UV_SCALE
          uvs[i * 2 + 1] = gy * ROAD_UV_SCALE
        }
      }
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
      geometry.setIndex(indices)
      geometry.computeBoundingSphere()
      const mesh = new Mesh(geometry, material)
      mesh.name = `paving ${chunk.cx},${chunk.cy}`
      mesh.position.set(originX, 0, originY)
      mesh.receiveShadow = true
      // A road is a skin on the ground; it has nothing to cast. Deliberate, so
      // the scene's blanket shadow tagging leaves it alone.
      mesh.castShadow = false
      mesh.userData.shadowTagged = true
      return mesh
    },
    dispose() {
      material.dispose()
      map.dispose()
    },
  }
}

export type PavingBank = ReturnType<typeof createPavingBank>

/* -------------------------------------------------------------------------- */
/* Cosmetic scatter                                                           */
/* -------------------------------------------------------------------------- */

/** Stable hash, so a chunk's grass is the same tuft-for-tuft every time it is
 *  mounted — walking away and back must not reshuffle the meadow. Not
 *  `world.ts`'s `hash3`: this one folds the running hash back in with an extra
 *  shift-xor before each `imul` and a final avalanche step, a different
 *  sequence than the shared mixer produces, so it is kept separate rather than
 *  merged. */
function hash(cx: number, cy: number, n: number): number {
  let h = Math.imul(cx ^ 0x9E3779B9, 0x85EBCA6B)
  h = Math.imul(h ^ (h >>> 13) ^ cy, 0xC2B2AE35)
  h = Math.imul(h ^ (h >>> 16) ^ n, 0x27D4EB2F)
  h ^= h >>> 15
  h = Math.imul(h, 0x2545F491)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Bilinear ground height inside a chunk, in chunk-local tile coordinates.
 *  Reimplements what `cornerHeight`/`terrainHeight` in `shared/utils/world.ts`
 *  and `shared/utils/maze.ts` already do, but those take a `World` to look
 *  corners up across chunk borders and this only has the one `Chunk` scatter
 *  runs against, so it stays local; treat the shared functions as the
 *  reference if this ever needs to change. */
function localHeight(chunk: Chunk, lx: number, ly: number): number {
  const x0 = Math.min(CHUNK_SIZE - 1, Math.floor(lx))
  const y0 = Math.min(CHUNK_SIZE - 1, Math.floor(ly))
  const fx = lx - x0
  const fy = ly - y0
  const i = y0 * CHUNK_CORNERS + x0
  const h00 = chunk.heights[i]!
  const h10 = chunk.heights[i + 1]!
  const h01 = chunk.heights[i + CHUNK_CORNERS]!
  const h11 = chunk.heights[i + CHUNK_CORNERS + 1]!
  return (h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy) * HEIGHT_STEP
}

/** How steep the tile under a point is, as rise per unit: the same measure
 *  the terrain colours its scree by. */
function localSlope(chunk: Chunk, lx: number, ly: number): number {
  const x0 = Math.min(CHUNK_SIZE - 1, Math.floor(lx))
  const y0 = Math.min(CHUNK_SIZE - 1, Math.floor(ly))
  const i = y0 * CHUNK_CORNERS + x0
  const h00 = chunk.heights[i]!
  const h10 = chunk.heights[i + 1]!
  const h01 = chunk.heights[i + CHUNK_CORNERS]!
  const h11 = chunk.heights[i + CHUNK_CORNERS + 1]!
  return Math.hypot(h10 - h00 + h11 - h01, h01 - h00 + h11 - h10) * 0.5 * HEIGHT_STEP
}

/** Candidate tufts per chunk, before the ground thins them. The grass bank
 *  draws only the share that can be seen at a patch's distance, so this is the
 *  density underfoot, not the cost of every mounted chunk. */
const GRASS_CANDIDATES = 6000

/**
 * The chunk's grass, deterministic and purely cosmetic. It follows the ground
 * the terrain paints: thick where the meadow is lush, thinner and shorter on
 * dry straw, and absent from worn soil and exposed rock. Candidate order is
 * hashed, which the bank relies on: it ranks tufts by index to thin them with
 * distance.
 */
/** How each biome thins and dries its sward, as a density multiplier and how
 *  far the tuft's own pigment is pushed from lush toward straw. Meadow is 1 and
 *  0, so a meadow chunk grows the grass it always did. A pinewood floor is shaded
 *  out; a heath is thin and dry. A mountain's sward is only the thin grass low
 *  on its skirts — the high ground is stone and snow in the raster, which
 *  `isGrassTile` already refuses, so nothing has to be said about it here.
 *  Nothing here needs the blade shader to change: `lush` and `straw` are
 *  already the two weights it colours from. */
const BIOME_SWARD: Record<Biome, readonly [number, number]> = {
  meadow: [1, 0],
  forest: [0.5, 0.05],
  pinewood: [0.45, 0.25],
  grove: [0.85, 0.1],
  heath: [0.4, 0.75],
  mountain: [0.24, 0.6],
}

export function chunkGrassBlades(chunk: Chunk, seed: number): GrassBlade[] {
  const blades: GrassBlade[] = []
  const originX = chunk.cx * CHUNK_SIZE
  const originY = chunk.cy * CHUNK_SIZE
  for (let n = 0; n < GRASS_CANDIDATES; n++) {
    const lx = hash(chunk.cx, chunk.cy, n * 5 + 1) * CHUNK_SIZE
    const ly = hash(chunk.cx, chunk.cy, n * 5 + 2) * CHUNK_SIZE
    if (!isGrassTile(chunk, Math.floor(lx), Math.floor(ly))) continue
    const x = originX + lx
    const z = originY + ly
    const cover = meadowCover(x, z, localSlope(chunk, lx, ly))
    const [density, drying] = BIOME_SWARD[biomeAt(seed, x, z)]
    if (drying > 0) {
      cover.lush *= 1 - drying
      cover.straw = Math.min(1, cover.straw + drying * 0.6)
    }
    const growth = density * (0.7 + cover.lush * 0.3) * (1 - cover.straw * 0.5) * (1 - smoothstep(0.15, 0.5, cover.bare))
    if (hash(chunk.cx, chunk.cy, n * 5 + 3) > growth) continue
    // Mostly shin-high cover with the odd taller clump, so the meadow reads as
    // a carpet the players wade through rather than a field of seedlings.
    const roll = hash(chunk.cx, chunk.cy, n * 5 + 4)
    const tall = roll < 0.12
    blades.push({
      x,
      z,
      y: localHeight(chunk, lx, ly),
      size: (tall ? 1.5 + roll * 5 : 0.8 + roll * 0.5) * (0.75 + cover.lush * 0.35),
      angle: hash(chunk.cx, chunk.cy, n * 5 + 5) * Math.PI * 2,
      lush: cover.lush,
      straw: cover.straw,
    })
  }
  return blades
}

/**
 * The undergrowth each biome carries, as `[kind, cumulative share]`. Sampled
 * per point rather than per chunk, so a region border runs through a chunk the
 * same way the server's vegetation does. Heath is stones with the odd fungus in
 * their lee; the wooded biomes are fungus and low green cover, which is the
 * ground the pines and the crooked stands stand on.
 */
const UNDERSTORY: Record<Biome, readonly (readonly [string, number])[]> = {
  // The meadow's cover is its flower drifts, below; clover is the only thing
  // this pass adds to it, thinly, so the open ground stays open.
  meadow: [['clover', 0.3]],
  // The broadleaf floor is the fullest of them: damp, shaded, and the only one
  // that carries fern, plant and clover together.
  forest: [['mushroom1', 0.16], ['mushroom2', 0.26], ['fern', 0.64], ['plant', 0.82], ['clover', 0.92]],
  pinewood: [['mushroom1', 0.2], ['mushroom2', 0.3], ['fern', 0.6], ['plant', 0.78]],
  grove: [['mushroom1', 0.14], ['mushroom2', 0.22], ['fern', 0.5], ['plant', 0.7], ['clover', 0.9]],
  heath: [['pebble1', 0.26], ['pebble2', 0.5], ['pebble3', 0.74], ['mushroom1', 0.79]],
  // Scree and the odd fungus in its lee, and sparse: the share that misses
  // every entry leaves the ground bare, which is what high country should be.
  mountain: [['pebble1', 0.18], ['pebble2', 0.32], ['pebble3', 0.44], ['mushroom1', 0.48]],
}

/** Scale range per family, as `[lower, spread]`. The mushrooms and pebbles ship
 *  near life size. The kit's green cover is authored huge: the fern is 9 m
 *  across and the plant 3.8 m tall at scale 1, so they come down to knee height. */
const SCATTER_SCALE: Record<string, readonly [number, number]> = {
  clover: [0.3, 0.3],
  fern: [0.1, 0.07],
  plant: [0.14, 0.1],
  mushroom1: [0.7, 0.6],
  mushroom2: [0.5, 0.45],
  pebble1: [0.7, 0.7],
  pebble2: [0.7, 0.7],
  pebble3: [0.7, 0.7],
}

/**
 * The chunk's ground detail: flower drifts in the meadow, fungus and low cover
 * under the woods, stones on the heath.
 *
 * Cosmetic, collision-free and generated rather than streamed, because nobody
 * needs to pick any of it — which is also why it may follow `biomeAt` without
 * asking the server anything. Deterministic per chunk, so walking away and back
 * finds the same ground.
 *
 * The flower pass keeps its own candidate sequence and its own drift gate, so a
 * meadow chunk scatters exactly what it always did.
 */
export function chunkScatter(chunk: Chunk, seed: number): HubPropPlacement[] {
  const out: HubPropPlacement[] = []
  const originX = chunk.cx * CHUNK_SIZE
  const originY = chunk.cy * CHUNK_SIZE
  for (let n = 0; n < 26; n++) {
    const lx = hash(chunk.cx, chunk.cy, n * 3 + 901) * CHUNK_SIZE
    const ly = hash(chunk.cx, chunk.cy, n * 3 + 902) * CHUNK_SIZE
    if (!isGrassTile(chunk, Math.floor(lx), Math.floor(ly))) continue
    const x = originX + lx
    const z = originY + ly
    if (biomeAt(seed, x, z) !== 'meadow') continue
    if (Math.sin(x * 0.14 + Math.sin(z * 0.19)) + Math.cos(z * 0.16 - x * 0.035) < 0.1) continue
    const roll = hash(chunk.cx, chunk.cy, n * 3 + 903)
    out.push({ kind: roll < 0.5 ? 'flowers1' : 'flowers2', x, y: z, rot: roll * Math.PI * 2, scale: 0.28 + roll * 0.24, z: localHeight(chunk, lx, ly) })
  }
  for (let n = 0; n < 30; n++) {
    const lx = hash(chunk.cx, chunk.cy, n * 4 + 1301) * CHUNK_SIZE
    const ly = hash(chunk.cx, chunk.cy, n * 4 + 1302) * CHUNK_SIZE
    if (!isGrassTile(chunk, Math.floor(lx), Math.floor(ly))) continue
    const x = originX + lx
    const z = originY + ly
    const roll = hash(chunk.cx, chunk.cy, n * 4 + 1303)
    const entry = UNDERSTORY[biomeAt(seed, x, z)].find(([, share]) => roll < share)
    if (!entry) continue
    const [lower, spread] = SCATTER_SCALE[entry[0]] ?? [0.4, 0.3]
    const size = hash(chunk.cx, chunk.cy, n * 4 + 1304)
    out.push({ kind: entry[0], x, y: z, rot: size * Math.PI * 2, scale: lower + size * spread, z: localHeight(chunk, lx, ly) })
  }
  return out
}
