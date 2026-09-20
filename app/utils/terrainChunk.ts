import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three'
import { COURTYARD, FORTIFICATIONS, isInMoat, isOnGateBridge } from '#shared/utils/courtyard'
import { isOnMoatStairs } from '#shared/utils/moat'
import { LANDSCAPE_CENTER, LANDSCAPE_EXPANSION, smoothstep } from '#shared/utils/terrain'
import { CHUNK_CORNERS, CHUNK_SIZE, HEIGHT_STEP, SURFACE, isProtectedTile } from '#shared/utils/world'
import type { Chunk } from '#shared/utils/world'
import type { TownMaterials } from './townMaterials'
import { TERRAIN_TINTS } from './surfaceColors'

/**
 * One ground mesh per world chunk.
 *
 * The 33×33 corner heights a chunk stores *are* the ground players walk on, so
 * this draws them directly: no separate decorative heightfield, no second
 * height function that can drift from the shared one. A terraform edit only has
 * to call `updateTerrainMesh` with the chunk it changed.
 *
 * Vertices are local to the chunk (0..32) and the mesh is positioned at the
 * chunk origin, which keeps float precision sane out at the world edge; the
 * pigment overlay in `townMaterials` projects in world space through the model
 * matrix, so it is continuous across the seams anyway.
 *
 * Normals are computed analytically from the height field rather than from the
 * triangles, sampling one corner *past* each edge through the caller's sampler.
 * Per-chunk `computeVertexNormals` would light the two sides of every seam
 * differently and draw a grid over the meadow.
 */

/** How far the protected town's ground sinks below zero so every plaza plane in
 *  `courtyardScene` (the lowest sits at -0.015) stays on top of it rather than
 *  z-fighting with it. Ramped out over the last tiles of the flat town ground,
 *  where it is a 6 cm step in open grass. */
const TOWN_CLEARANCE = 0.06

/** Reads a corner height in world tile coordinates, for normals that cross a
 *  chunk border. Returns a non-finite number where nothing is loaded. */
export type HeightSampler = (gx: number, gy: number) => number

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

const lush = new Color('#5c8a3d')
const dryGrass = new Color('#8b9553')
const straw = new Color('#c2b07a')
const soil = new Color(TERRAIN_TINTS.soil)
const highland = new Color('#74886f')
const rock = new Color(TERRAIN_TINTS.rock)
const sand = new Color(TERRAIN_TINTS.sand)
const wet = new Color(TERRAIN_TINTS.wet)
const snow = new Color(TERRAIN_TINTS.snow)
const scratch = new Color()
/** The grass bank colours its blades with the same pigments, so a tuft takes
 *  the colour of the ground it stands on. */
export const MEADOW_PALETTE = { lush, dryGrass, straw, highland }

/** Trodden ground: the widening approach track that runs out from the gate
 *  bridge into the meadow. */
function roadWear(x: number, z: number): number {
  const spread = 4.5 + smoothstep(FORTIFICATIONS.bridgeEnd, FORTIFICATIONS.exteriorMax + 30, z) * 6
  return Math.min(1, (1 - smoothstep(spread * 0.5, spread, Math.abs(x - FORTIFICATIONS.gateX)))
    * smoothstep(FORTIFICATIONS.bridgeEnd - 4, FORTIFICATIONS.bridgeEnd + 3, z)
    * (1 - smoothstep(FORTIFICATIONS.exteriorMax + 34, FORTIFICATIONS.exteriorMax + 78, z)))
}

/**
 * The meadow's own pigment, independent of the surface raster: two low
 * frequencies decide moisture, a coarser one dries whole shoulders to straw,
 * steep faces shed their soil to scree and distance cools the hills. Ported
 * from the decorative heightfield this replaced, so the view from the walls is
 * the one players already know.
 */
/** What grows at a point, in the terms `groundColor` mixes its pigments by:
 *  `lush` and `straw` are the two lerp weights, `bare` is how much of the
 *  ground is worn soil or exposed rock, where nothing should stand. */
export function meadowCover(x: number, z: number, slope: number) {
  const moisture = 0.5 + 0.25 * Math.sin(x * 0.021 + Math.sin(z * 0.017) * 2.3)
    + 0.25 * Math.sin(z * 0.034 - x * 0.013)
  const dryness = 0.5 + 0.5 * Math.sin(x * 0.013 - z * 0.029 + Math.sin(x * 0.008) * 1.7)
  return {
    lush: smoothstep(0.28, 0.78, moisture),
    straw: smoothstep(0.5, 0.95, dryness) * 0.6,
    bare: Math.max(roadWear(x, z) * 0.82, smoothstep(0.22, 0.7, slope) * 0.88),
  }
}

function groundColor(out: Color, x: number, z: number, y: number, slope: number) {
  const distant = smoothstep(45, 145, Math.hypot(x - LANDSCAPE_CENTER, z - LANDSCAPE_CENTER) - LANDSCAPE_EXPANSION)
  const cover = meadowCover(x, z, slope)
  out.copy(dryGrass).lerp(lush, cover.lush)
  out.lerp(straw, cover.straw)
  out.lerp(soil, roadWear(x, z) * 0.82)
  const exposed = smoothstep(0.22, 0.7, slope)
  out.lerp(rock, exposed * 0.88)
  out.lerp(highland, distant * 0.42)
  const patch = Math.sin(x * 0.10 + Math.sin(z * 0.09) * 2) * Math.cos(z * 0.13)
  const strata = 0.86 + Math.sin(y * 1.8 + x * 0.09) * 0.08
  out.multiplyScalar((0.93 + patch * 0.14) * (1 - exposed + exposed * strata))
}

/** How far a surface type pulls the ground away from its natural pigment.
 *  `path` is the odd one out: it is not a tint at all but a continuous stone
 *  road drawn over the ground (`createPavingBank` in `chunkProps.ts`), so the
 *  ground under it keeps its natural colour. A corner takes its colour from
 *  one neighbouring tile, so any tint here would bleed onto the unpainted tile
 *  next door as a dark strip along the edge of a road. */
function surfaceTint(out: Color, surface: number) {
  switch (surface) {
    case SURFACE.dirt: return out.lerp(soil, 0.55)
    case SURFACE.stone: return out.lerp(rock, 0.7)
    case SURFACE.sand: return out.lerp(sand, 0.65)
    case SURFACE.path: return out
    case SURFACE.water: return out.lerp(wet, 0.7)
    // The deepest lerp of the lot. Every other surface is soil or stone showing
    // through the meadow's own pigment, but snow lies *over* the ground: leave
    // a third of a green hillside in it and the summits come out sage. The
    // remaining tenth is what the ground's own patch and strata variation shows
    // through as drift, so a snowfield is not one flat value.
    case SURFACE.snow: return out.lerp(snow, 0.9)
    default: return out
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const cornerAt = (chunk: Chunk, lx: number, ly: number) =>
  chunk.heights[ly * CHUNK_CORNERS + lx]! * HEIGHT_STEP

/** The town's ground sits fractionally low so the authored plaza and the gate
 *  road cover it. Keyed to the protected *tile footprint*, not to the chunk: a
 *  town chunk's outer tiles are ordinary meadow and must not step down with
 *  it. A corner is sunk when any of the four tiles it belongs to is protected,
 *  so every authored plane is fully cleared out to its last tile (the road is
 *  only eight wide; an inward ramp buried its edges) and the ramp back up to
 *  the meadow is the one tile outside, whose outer corners stay at 0. */
function clearance(gx: number, gy: number): number {
  const sunk = isProtectedTile(gx, gy) || isProtectedTile(gx - 1, gy)
    || isProtectedTile(gx, gy - 1) || isProtectedTile(gx - 1, gy - 1)
  return sunk ? -TOWN_CLEARANCE : 0
}

/**
 * Tiles the town draws itself. The moat channel and its stair are real geometry
 * in `cityMoat`, and a flat lid over them would seal the water off.
 */
function isHole(chunk: Chunk, lx: number, ly: number): boolean {
  const x = chunk.cx * CHUNK_SIZE + lx + 0.5
  const y = chunk.cy * CHUNK_SIZE + ly + 0.5
  return isInMoat(x, y) || isOnMoatStairs(x, y)
}

function buildIndex(chunk: Chunk): number[] {
  const indices: number[] = []
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      if (isHole(chunk, lx, ly)) continue
      const i = ly * CHUNK_CORNERS + lx
      indices.push(i, i + CHUNK_CORNERS, i + 1, i + 1, i + CHUNK_CORNERS, i + CHUNK_CORNERS + 1)
    }
  }
  return indices
}

/** Surface type at a corner: the average of the tiles it bounds, clamped to the
 *  chunk. A corner shared with a neighbour reads that neighbour's edge tile
 *  through the duplicated border, so the bands line up across a seam. */
function cornerSurface(chunk: Chunk, lx: number, ly: number, out: Color) {
  const tx = Math.min(lx, CHUNK_SIZE - 1)
  const ty = Math.min(ly, CHUNK_SIZE - 1)
  surfaceTint(out, chunk.surface[ty * CHUNK_SIZE + tx]!)
}

function writeVertices(chunk: Chunk, positions: Float32Array, colors: Float32Array, normals: Float32Array, sample: HeightSampler) {
  const originX = chunk.cx * CHUNK_SIZE
  const originY = chunk.cy * CHUNK_SIZE
  for (let ly = 0; ly < CHUNK_CORNERS; ly++) {
    for (let lx = 0; lx < CHUNK_CORNERS; lx++) {
      const i = ly * CHUNK_CORNERS + lx
      const gx = originX + lx
      const gy = originY + ly
      const h = cornerAt(chunk, lx, ly)
      const y = h + clearance(gx, gy)
      positions[i * 3] = lx
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = ly
      // Central differences across the chunk border keep the seams smooth.
      const west = sample(gx - 1, gy)
      const east = sample(gx + 1, gy)
      const north = sample(gx, gy - 1)
      const south = sample(gx, gy + 1)
      const dx = (Number.isFinite(east) ? east : h) - (Number.isFinite(west) ? west : h)
      const dz = (Number.isFinite(south) ? south : h) - (Number.isFinite(north) ? north : h)
      const nx = -dx / 2
      const nz = -dz / 2
      const length = Math.hypot(nx, 1, nz)
      normals[i * 3] = nx / length
      normals[i * 3 + 1] = 1 / length
      normals[i * 3 + 2] = nz / length
      groundColor(scratch, gx, gy, h, Math.hypot(dx / 2, dz / 2))
      // On the protected footprint the raster is a uniform `path` placeholder
      // (the town's ground is authored, not painted), so tinting by it would
      // wash the outer bank pale. Terrain there keeps its natural pigment; the
      // rest of a town chunk is plain meadow and is tinted like anywhere else.
      if (!isProtectedTile(gx, gy)) cornerSurface(chunk, lx, ly, scratch)
      colors[i * 3] = scratch.r
      colors[i * 3 + 1] = scratch.g
      colors[i * 3 + 2] = scratch.b
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The one material every terrain chunk shares: vertex-coloured earth with the
 * town's world-projected pigment, plus a tighter near-field relief layer that
 * fades out before the distant hills can show the repeat. Shared on purpose —
 * a clone per chunk would be a program and a CSM registration per chunk.
 */
export function createTerrainMaterial(materials: TownMaterials): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1 })
  materials.apply(material, 'earth', 0.22, 0.55)
  const townHook = material.onBeforeCompile
  material.onBeforeCompile = function (shader, renderer) {
    townHook.call(this, shader, renderer)
    // `townP` / `townW` / `townSample` come from the town hook's own injection
    // earlier in main(); this reuses them at a tighter scale near the camera.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float terrainNear = 1.0 - smoothstep(9.0, 62.0, length(vViewPosition));
        if (terrainNear > 0.002) {
          vec3 terrainP = townP * 5.5;
          vec2 tnx = texture2D(townNormal, terrainP.zy).xy * 2.0 - 1.0;
          vec2 tny = texture2D(townNormal, terrainP.xz).xy * 2.0 - 1.0;
          vec2 tnz = texture2D(townNormal, terrainP.xy).xy * 2.0 - 1.0;
          vec3 terrainDetail = vec3(0.0, tnx.y, tnx.x) * townW.x
            + vec3(tny.x, 0.0, tny.y) * townW.y
            + vec3(tnz.x, tnz.y, 0.0) * townW.z;
          normal = normalize(normal + mat3(viewMatrix) * terrainDetail * 0.8 * terrainNear);
          float grit = townSample(townColor, terrainP, townW).g;
          diffuseColor.rgb *= mix(1.0, 0.76 + grit * 0.52, terrainNear);
        }
      `)
  }
  material.customProgramCacheKey = () => 'avelune-terrain-v1'
  return material
}

/** One chunk's ground. The mesh owns its geometry and borrows the material. */
export function createTerrainMesh(chunk: Chunk, material: MeshStandardMaterial, sample: HeightSampler): Mesh {
  const count = CHUNK_CORNERS * CHUNK_CORNERS
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setIndex(buildIndex(chunk))
  const mesh = new Mesh(geometry, material)
  mesh.name = `terrain ${chunk.cx},${chunk.cy}`
  mesh.position.set(chunk.cx * CHUNK_SIZE, 0, chunk.cy * CHUNK_SIZE)
  mesh.receiveShadow = true
  // Ground cannot shadow itself usefully and three cascades of it is most of a
  // frame; the relief reads from the sun's own shading. Deliberate, so the
  // scene's blanket shadow tagging leaves it alone.
  mesh.castShadow = false
  mesh.userData.shadowTagged = true
  mesh.userData.terrainChunk = `${chunk.cx},${chunk.cy}`
  updateTerrainMesh(mesh, chunk, sample)
  return mesh
}

/**
 * Re-read a chunk into an existing mesh: heights, surface colours and normals.
 * The index only changes where the town's own geometry punches holes, which is
 * fixed, so the triangle list is left alone.
 */
export function updateTerrainMesh(mesh: Mesh, chunk: Chunk, sample: HeightSampler): void {
  const position = mesh.geometry.getAttribute('position') as BufferAttribute
  const color = mesh.geometry.getAttribute('color') as BufferAttribute
  const normal = mesh.geometry.getAttribute('normal') as BufferAttribute
  writeVertices(chunk, position.array as Float32Array, color.array as Float32Array, normal.array as Float32Array, sample)
  position.needsUpdate = true
  color.needsUpdate = true
  normal.needsUpdate = true
  mesh.geometry.computeBoundingSphere()
}

/** Whether a tile is open ground the meadow's grass may grow on. Inside the
 *  protected footprint the raster says nothing useful, so the town's own
 *  geometry (plaza, moat and bridge) is what is excluded instead;
 *  everywhere else, the outer tiles of a town chunk included, the raster
 *  decides — which is what keeps grass and flowers off a player's flagstones. */
export function isGrassTile(chunk: Chunk, lx: number, ly: number): boolean {
  const x = chunk.cx * CHUNK_SIZE + lx + 0.5
  const y = chunk.cy * CHUNK_SIZE + ly + 0.5
  if (!isProtectedTile(x, y)) return chunk.surface[ly * CHUNK_SIZE + lx] === SURFACE.grass
  if (x > COURTYARD.min && x < COURTYARD.max && y > COURTYARD.min && y < COURTYARD.max) return false
  return !(isInMoat(x, y) || isOnMoatStairs(x, y) || isOnGateBridge(x, y))
}
