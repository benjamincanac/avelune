import {
  Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Group,
  InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3,
} from 'three'
import { COURTYARD, COURTYARD_ASSETS, FORTIFICATIONS, isInMoat, isOnGateBridge, TOWN_GARDENS } from '#shared/utils/courtyard'
import { MOAT_STAIRS, isOnMoatStairs } from '#shared/utils/moat'
import { applyFoliage } from './foliage'
import type { TownMaterials } from './townMaterials'
import type { HubPropPlacement } from '#shared/utils/maze'

/** Quaternius Stylized Nature MegaKit pieces (CC0), converted by
 *  scripts/convert_nature.sh into public/models/nature/. Variants share a
 *  prefix so the landscape can pick among them per placement. */
export const NATURE_NAMES = [
  'tree1', 'tree2', 'tree3', 'tree4', 'tree5',
  'bush1', 'bush2',
  'fern', 'clover', 'plant',
  'flowers1', 'flowers2',
  'rock1', 'rock2', 'rock3',
] as const

const gardens = TOWN_GARDENS

/** Decorative landscape only. All relief and tree trunks remain outside the
 * playable square; garden plants are low enough to walk through. */
export function createCourtyardLandscape(templates: ReadonlyMap<string, Group>, villagePlacements: readonly HubPropPlacement[], materials: TownMaterials) {
  const center = (COURTYARD.min + COURTYARD.max) / 2
  const expansion = (FORTIFICATIONS.exteriorMax - FORTIFICATIONS.exteriorMin) / 2 - 20
  const relocate = <T extends { x: number, z: number }>(p: T): T => {
    const dx = p.x - 28
    const dz = p.z - 28
    const scale = 1 + expansion / Math.max(1, Math.abs(dx), Math.abs(dz))
    return { ...p, x: center + dx * scale, z: center + dz * scale }
  }
  const group = new Group()
  group.name = 'Courtyard landscape'
  const ownedGeometries: BufferGeometry[] = []
  const ownedMaterials: MeshStandardMaterial[] = []
  const instances: InstancedMesh[] = []
  const time = { value: 0 }
  let seed = 57281
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  // Low meadow foothills open onto asymmetric eroded ridges. Several scales of
  // relief keep silhouettes articulated while the courtyard remains dominant.
  function height(x: number, z: number) {
    const dx = x - center
    const dz = z - center
    const distance = Math.max(0, Math.max(Math.abs(dx), Math.abs(dz)) - expansion)
    const ramp = smooth(27, 66, distance)
    const angle = Math.atan2(dz, dx)
    const ridge = 10 + 5 * Math.sin(angle * 3 + 0.6) + 4 * Math.sin(angle * 7 - 1.3)
    const folds = Math.sin(dx * 0.071 + Math.sin(dz * 0.039) * 2.1) * 4
      + Math.sin(dz * 0.095 - dx * 0.027) * 3
    const erosion = 1 - Math.abs(Math.sin(dx * 0.088 + dz * 0.052 + Math.sin(dz * 0.08)))
    const summit = Math.exp(-(((distance - 108) / 47) ** 2))
    const farRidge = smooth(107, 155, distance) * (1 - smooth(185, 220, distance))
      * (9 + 7 * Math.pow(0.5 + 0.5 * Math.sin(angle * 9 + 0.4), 2))
    return -0.06 + ramp * (3 + (ridge + folds + erosion * erosion * 5) * summit + farRidge)
  }

  // Copse footprints are declared before the terrain so the ground can wear
  // down to bare dirt underneath them.
  const copses = [
    { x: -10, z: 17, rx: 10, rz: 19, count: 10 },
    { x: 65, z: 12, rx: 12, rz: 18, count: 9 },
    { x: 12, z: -20, rx: 21, rz: 12, count: 8 },
    { x: 69, z: 59, rx: 16, rz: 12, count: 6 },
    { x: 16, z: 67, rx: 17, rz: 9, count: 7 },
  ].map(relocate)
  const woodland = [
    { x: -45, z: 4, rx: 21, rz: 34 },
    { x: -28, z: -49, rx: 37, rz: 22 },
    { x: 57, z: -53, rx: 26, rz: 20 },
    { x: 101, z: 35, rx: 23, rz: 48 },
    { x: 75, z: 104, rx: 36, rz: 19 },
    { x: 16, z: 109, rx: 24, rz: 16 },
    { x: -43, z: 92, rx: 29, rz: 28 },
  ].map(relocate)

  /** Trodden ground: bare soil under the copses, plus the widening approach
   *  track that runs out from the gate bridge into the meadow. */
  function wear(x: number, z: number) {
    let worn = 0
    for (const copse of copses) {
      const d = Math.hypot((x - copse.x) / (copse.rx + 5), (z - copse.z) / (copse.rz + 5))
      worn = Math.max(worn, 1 - smooth(0.4, 1.05, d))
    }
    const spread = 4.5 + smooth(FORTIFICATIONS.bridgeEnd, FORTIFICATIONS.exteriorMax + 30, z) * 6
    const road = (1 - smooth(spread * 0.5, spread, Math.abs(x - FORTIFICATIONS.gateX)))
      * smooth(FORTIFICATIONS.bridgeEnd - 4, FORTIFICATIONS.bridgeEnd + 3, z)
      * (1 - smooth(FORTIFICATIONS.exteriorMax + 34, FORTIFICATIONS.exteriorMax + 78, z))
    return Math.min(1, worn * 0.8 + road)
  }

  const extent = 420 + expansion * 2
  const terrainAxis = [...new Set([
    ...Array.from({ length: 179 }, (_, i) => center + (i / 178 - 0.5) * extent),
    COURTYARD.min, COURTYARD.max, FORTIFICATIONS.moatInnerMin, FORTIFICATIONS.moatInnerMax,
    FORTIFICATIONS.moatOuterMin, FORTIFICATIONS.moatOuterMax,
    // The approach road is a couple of quads wide, so it needs its own samples.
    FORTIFICATIONS.gateX, FORTIFICATIONS.gateX - 3, FORTIFICATIONS.gateX + 3,
    FORTIFICATIONS.gateX - 6, FORTIFICATIONS.gateX + 6,
    MOAT_STAIRS.x - MOAT_STAIRS.width / 2, MOAT_STAIRS.x + MOAT_STAIRS.width / 2, MOAT_STAIRS.zStart, MOAT_STAIRS.zEnd,
  ])].sort((a, b) => a - b)
  const resolution = terrainAxis.length - 1
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const lush = new Color('#5c8a3d')
  const dryGrass = new Color('#8b9553')
  const straw = new Color('#c2b07a')
  const soil = new Color('#8a6e4c')
  const highland = new Color('#74886f')
  const rock = new Color('#9b9483')
  const color = new Color()
  for (let z = 0; z <= resolution; z++) {
    for (let x = 0; x <= resolution; x++) {
      const px = terrainAxis[x]!
      const pz = terrainAxis[z]!
      const y = height(px, pz)
      positions.push(px, y, pz)
      const slope = Math.hypot(height(px + 1, pz) - y, height(px, pz + 1) - y)
      const distant = smooth(45, 145, Math.hypot(px - center, pz - center) - expansion)
      // Two low frequencies decide moisture and a third, coarser one dries whole
      // shoulders to straw, so the meadow never reads as one flat green.
      const moisture = 0.5 + 0.25 * Math.sin(px * 0.021 + Math.sin(pz * 0.017) * 2.3)
        + 0.25 * Math.sin(pz * 0.034 - px * 0.013)
      const dryness = 0.5 + 0.5 * Math.sin(px * 0.013 - pz * 0.029 + Math.sin(px * 0.008) * 1.7)
      color.copy(dryGrass).lerp(lush, smooth(0.28, 0.78, moisture))
      color.lerp(straw, smooth(0.5, 0.95, dryness) * 0.6)
      color.lerp(soil, wear(px, pz) * 0.82)
      // Steep faces shed their soil, so scree shows through on the eroded ridges.
      const exposed = smooth(0.22, 0.7, slope)
      color.lerp(rock, exposed * 0.88)
      // Distance cools the hills but keeps their green, so they stay readable
      // once fog and aerial perspective land on top.
      color.lerp(highland, distant * 0.42)
      const patch = Math.sin(px * 0.10 + Math.sin(pz * 0.09) * 2) * Math.cos(pz * 0.13)
      const strata = 0.86 + Math.sin(y * 1.8 + px * 0.09) * 0.08
      color.multiplyScalar((0.93 + patch * 0.14) * (1 - exposed + exposed * strata))
      colors.push(color.r, color.g, color.b)
      if (x < resolution && z < resolution) {
        // Keep the entire playable square free of terrain polygons.
        const nextX = terrainAxis[x + 1]!
        const nextZ = terrainAxis[z + 1]!
        if (isInMoat((px + nextX) / 2, (pz + nextZ) / 2) || isOnMoatStairs((px + nextX) / 2, (pz + nextZ) / 2)) continue
        if (nextX > COURTYARD.min && px < COURTYARD.max && nextZ > COURTYARD.min && pz < COURTYARD.max) continue
        const i = z * (resolution + 1) + x
        indices.push(i, i + resolution + 1, i + 1, i + 1, i + resolution + 1, i + resolution + 2)
      }
    }
  }
  const terrainGeometry = new BufferGeometry()
  terrainGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  terrainGeometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  terrainGeometry.setIndex(indices)
  terrainGeometry.computeVertexNormals()
  const terrainMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 1 })
  // Broad soil relief from the shared bank. A tighter second layer is added
  // below, but only where the camera can still resolve it.
  materials.apply(terrainMaterial, 'earth', 0.22, 0.55)
  const townTerrainHook = terrainMaterial.onBeforeCompile
  terrainMaterial.onBeforeCompile = function (shader, renderer) {
    townTerrainHook.call(this, shader, renderer)
    // `townP` / `townW` / `townSample` come from the town hook's own injection
    // earlier in main(); this reuses them at a tighter scale near the camera so
    // distant hills never show the repeat.
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
  terrainMaterial.customProgramCacheKey = () => 'avelune-terrain-v1'
  const terrain = new Mesh(terrainGeometry, terrainMaterial)
  terrain.receiveShadow = true
  group.add(terrain)
  ownedGeometries.push(terrainGeometry)
  ownedMaterials.push(terrainMaterial)

  const dummy = new Object3D()
  type Placement = { x: number, z: number, y: number, size: number, angle: number, width?: number }
  const placements = new Map<string, Placement[]>()
  function place(name: string, x: number, z: number, y: number, size: number) {
    const list = placements.get(name) ?? []
    list.push({ x, z, y, size, angle: random() * Math.PI * 2 })
    placements.set(name, list)
  }
  /** One of a kit family's variants, e.g. `pick('tree', 5)` → `tree1`..`tree5`. */
  const pick = (family: string, count: number) => `${family}${1 + Math.floor(random() * count)}`
  const pickBush = () => (random() < 0.3 ? 'bush2' : 'bush1')

  // Template geometry and materials stay untouched, including normalized GLB
  // attributes. Source mesh transforms are composed into each instance matrix;
  // alpha-cut cards get a per-batch material clone carrying the wind shader.
  const size = new Vector3()
  const sourceTransform = new Matrix4()
  const matrix = new Matrix4()
  function instanceTemplate(name: string, list: Placement[], options: { castShadow: boolean, receiveShadow: boolean, tint: boolean }) {
    const template = templates.get(name)
    if (!template || !list.length) return
    template.updateWorldMatrix(true, true)
    const bounds = new Box3().setFromObject(template)
    bounds.getSize(size)
    if (size.y < 0.001) return
    const templateHeight = size.y
    const centerX = (bounds.min.x + bounds.max.x) / 2
    const centerZ = (bounds.min.z + bounds.max.z) / 2
    sourceTransform.makeTranslation(-centerX, -bounds.min.y, -centerZ)
    template.traverse((child) => {
      if (!(child instanceof Mesh) || Array.isArray(child.material)) return
      let material = child.material as MeshStandardMaterial
      const card = material.alphaTest > 0
      if (card) {
        material = material.clone()
        // Cloning copies `userData` but not the hooks it marks, so the guards
        // would report shaders this clone does not carry.
        delete material.userData.foliageShader
        delete material.userData.characterRim
        materials.reapply(material)
        applyFoliage(material, time)
        ownedMaterials.push(material)
      }
      const batch = new InstancedMesh(child.geometry, material, list.length)
      const source = new Matrix4().multiplyMatrices(sourceTransform, child.matrixWorld)
      list.forEach((p, i) => {
        const spread = (p.width ?? 1) * p.size / templateHeight
        dummy.position.set(p.x, p.y, p.z)
        dummy.rotation.set(0, p.angle, 0)
        dummy.scale.set(spread, p.size / templateHeight, spread)
        dummy.updateMatrix()
        matrix.multiplyMatrices(dummy.matrix, source)
        batch.setMatrixAt(i, matrix)
      })
      if (options.tint) {
        list.forEach((p, i) => {
          const variation = 0.5 + Math.sin(p.x * 1.37 + p.z * 0.73) * 0.5
          batch.setColorAt(i, color.setRGB(0.83 + variation * 0.17, 0.91 + variation * 0.09, 0.76 + variation * 0.2))
        })
      }
      // Alpha-cut leaf cards: the renderer keeps them out of the opaque GTAO
      // pass (see courtyardRenderer), otherwise each card occludes as a quad.
      if (card) batch.userData.foliage = true
      batch.castShadow = options.castShadow
      batch.receiveShadow = options.receiveShadow
      // These flags are deliberate (the distant treeline casts nothing); the
      // scene's blanket shadow tagging leaves tagged objects alone.
      batch.userData.shadowTagged = true
      batch.computeBoundingSphere()
      group.add(batch)
      instances.push(batch)
    })
  }

  // Separate copses leave broad views between them, with smaller saplings and
  // shrubs feathering the edges. Never put decorative trunks inside collision.
  const outsideVillage = (x: number, z: number) => x <= FORTIFICATIONS.exteriorMin - 2 || x >= FORTIFICATIONS.exteriorMax + 2 || z <= FORTIFICATIONS.exteriorMin - 2 || z >= FORTIFICATIONS.exteriorMax + 2
  const treePositions: { x: number, z: number }[] = []
  for (const copse of copses) {
    for (let attempt = 0, planted = 0; attempt < copse.count * 12 && planted < copse.count; attempt++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = copse.x + Math.cos(angle) * copse.rx * radius
      const z = copse.z + Math.sin(angle) * copse.rz * radius
      if (!outsideVillage(x, z) || treePositions.some(p => Math.hypot(p.x - x, p.z - z) < 4.8)) continue
      const size = 5.5 + (1 - radius) * 4 + random() * 3
      place(pick('tree', 5), x, z, height(x, z) - 0.12, size)
      treePositions.push({ x, z })
      planted++
      for (let i = 0; i < 2; i++) {
        const spread = 2.2 + random() * 2.5
        const direction = random() * Math.PI * 2
        const bx = x + Math.cos(direction) * spread
        const bz = z + Math.sin(direction) * spread
        if (!outsideVillage(bx, bz)) continue
        place(pickBush(), bx, bz, height(bx, bz) - 0.05, 0.65 + random() * 0.8)
        if (i === 0) place(pick('flowers', 2), bx + 0.5, bz, height(bx + 0.5, bz), 0.32 + random() * 0.2)
      }
      // Undergrowth in the trunk's shade: ferns, clover and broadleaf plants.
      for (let i = 0, n = 2 + Math.floor(random() * 3); i < n; i++) {
        const spread = 1 + random() * 2.2
        const direction = random() * Math.PI * 2
        const ux = x + Math.cos(direction) * spread
        const uz = z + Math.sin(direction) * spread
        if (!outsideVillage(ux, uz)) continue
        const kind = random() < 0.45 ? 'fern' : random() < 0.5 ? 'clover' : 'plant'
        place(kind, ux, uz, height(ux, uz) - 0.02, kind === 'clover' ? 0.16 + random() * 0.1 : 0.4 + random() * 0.35)
      }
    }
  }

  // Distant woodland reuses the kit's cheapest tree (tree5, ~3.2k triangles) so
  // the far treeline matches the copses instead of the old procedural crowns.
  // Two draw calls cover the whole forest; it neither casts nor receives
  // shadows, which is invisible at that range. Spacing is wider and the trees
  // taller than the old crowns, keeping the instance count near 200.
  const distantTrees: Placement[] = []
  for (const copse of woodland) {
    for (let i = 0; i < 42; i++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = copse.x + Math.cos(angle) * copse.rx * radius
      const z = copse.z + Math.sin(angle) * copse.rz * radius
      if (!outsideVillage(x, z)) continue
      const y = height(x, z)
      const slope = Math.hypot(height(x + 1, z) - y, height(x, z + 1) - y)
      if (slope > 0.65 || distantTrees.some(p => Math.hypot(p.x - x, p.z - z) < 6)) continue
      distantTrees.push({ x, z, y: y - 0.14, size: 7 + random() * 4.5, angle, width: 0.8 + random() * 0.35 })
    }
  }
  instanceTemplate('tree5', distantTrees, { castShadow: false, receiveShadow: false, tint: true })

  // Partly buried, rotated rock clusters create visible geological structure
  // across the foothills, with the larger faces reserved for distant ridges.
  const outcrops = [[-19, -3], [72, -8], [-13, 60], [81, 47], [18, -53], [-55, -39]]
  for (const [x = 0, z = 0] of outcrops) {
    for (let i = 0; i < 3; i++) {
      const origin = relocate({ x, z })
      const px = origin.x + i * 2.4
      const pz = origin.z + Math.sin(i * 2) * 2
      const size = 2.5 + random() * 2.7
      place(pick('rock', 3), px, pz, height(px, pz) - size * 0.22, size)
    }
  }

  const buildings = villagePlacements.filter(p => ['Courtyard_Inn', 'Courtyard_Shop', 'Courtyard_Tower'].includes(p.kind))
  function beneathBuilding(x: number, z: number) {
    return buildings.some((p) => {
      const asset = COURTYARD_ASSETS[p.kind as 'Courtyard_Inn' | 'Courtyard_Shop' | 'Courtyard_Tower']
      const dx = x - p.x
      const dz = z - p.y
      const c = Math.cos(p.rot)
      const s = Math.sin(p.rot)
      return Math.abs(dx * c - dz * s) < asset.width * (p.s3?.[0] ?? p.scale) / 2 + 0.35
        && Math.abs(dx * s + dz * c) < asset.depth * (p.s3?.[2] ?? p.scale) / 2 + 0.35
    })
  }
  const grassPlacements: Placement[] = []
  for (const garden of gardens) {
    for (let i = 0; i < Math.min(1000, garden.rx * garden.rz * 32); i++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = garden.x + Math.cos(angle) * garden.rx * radius
      const z = garden.z + Math.sin(angle) * garden.rz * radius
      if (beneathBuilding(x, z)) continue
      grassPlacements.push({ x, z, y: 0.025, size: 0.55 + random() * 0.6, angle: random() * Math.PI * 2 })
      if (i % 90 === 0) place(pick('flowers', 2), x, z, 0.015, 0.30 + random() * 0.16)
      else if (i % 137 === 0) place(pickBush(), x, z, 0.01, 0.26 + random() * 0.1)
    }
  }

  // Dense patchy meadow near the wall thins uphill. Scattered flower drifts
  // follow the same moisture pattern, leaving dry gaps rather than a lawn.
  for (let i = 0; i < 34000; i++) {
    const x = COURTYARD.min - 43 + random() * (COURTYARD.max - COURTYARD.min + 86)
    const z = COURTYARD.min - 43 + random() * (COURTYARD.max - COURTYARD.min + 86)
    if ((x > COURTYARD.min && x < COURTYARD.max && z > COURTYARD.min && z < COURTYARD.max) || isInMoat(x, z) || isOnMoatStairs(x, z) || isOnGateBridge(x, z) || (Math.abs(x - FORTIFICATIONS.gateX) < FORTIFICATIONS.bridgeWidth / 2 + 0.3 && z >= FORTIFICATIONS.bridgeEnd && z <= FORTIFICATIONS.exteriorMax)) continue
    const distance = Math.max(Math.abs(x - center), Math.abs(z - center)) - expansion
    const patch = Math.sin(x * 0.14 + Math.sin(z * 0.19)) + Math.cos(z * 0.16 - x * 0.035)
    if (patch < -0.7 || random() > 1 - smooth(30, 65, distance) * 0.9) continue
    const y = height(x, z)
    // Mostly ankle-high cover with the odd taller clump, so the meadow reads as
    // a carpet the players wade through rather than a field of seedlings.
    const tall = random() < 0.18
    grassPlacements.push({ x, z, y, size: tall ? 1.1 + random() * 0.5 : 0.55 + random() * 0.5, angle: random() * Math.PI * 2 })
    if (i % 190 === 0 && patch > 0.1) place(pick('flowers', 2), x, z, y, 0.28 + random() * 0.24)
  }

  // A tuft of curved, tapered blades fanning outward, with a soft base-to-tip
  // gradient and coherent GPU wind. One draw call for every garden's grass.
  const bladePositions: number[] = []
  const bladeColors: number[] = []
  const bladeIndices: number[] = []
  const BLADES = 9
  const SEGMENTS = 3
  for (let blade = 0; blade < BLADES; blade++) {
    // Golden-angle spacing spreads the blades evenly; a small radial offset
    // keeps the tuft from pinching to a single spike at the root.
    const angle = blade * 2.399 + random() * 0.4
    const root = 0.02 + random() * 0.05
    const lean = 0.26 + random() * 0.3
    const length = 0.16 + random() * 0.17
    const width = 0.014 + random() * 0.012
    const base = bladePositions.length / 3
    for (let segment = 0; segment <= SEGMENTS; segment++) {
      const t = segment / SEGMENTS
      for (const side of [-1, 1]) {
        const across = side * width * (1 - t * 0.95)
        const bend = root + lean * t * t
        bladePositions.push(Math.cos(angle) * bend + Math.sin(angle) * across, t * length, Math.sin(angle) * bend - Math.cos(angle) * across)
        // Roots sit close to the terrain's own green so tufts don't read as
        // dark stars on the lawn; tips catch the light.
        color.set('#6a9a48').lerp(new Color('#cfe28a'), t * t)
        bladeColors.push(color.r, color.g, color.b)
      }
      if (segment < SEGMENTS) {
        const k = base + segment * 2
        bladeIndices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
      }
    }
  }
  const grassGeometry = new BufferGeometry()
  grassGeometry.setAttribute('position', new BufferAttribute(new Float32Array(bladePositions), 3))
  grassGeometry.setAttribute('color', new BufferAttribute(new Float32Array(bladeColors), 3))
  grassGeometry.setIndex(bladeIndices)
  // Broad upward normals give the blades a continuous meadow response to
  // sunlight, avoiding alternating dark paper faces as the camera rotates.
  const grassNormals = new Float32Array(bladePositions.length)
  for (let i = 0; i < grassNormals.length; i += 3) grassNormals[i + 1] = 1
  grassGeometry.setAttribute('normal', new BufferAttribute(grassNormals, 3))
  const grassMaterial = new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 1 })
  grassMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.landscapeTime = time
    shader.vertexShader = `uniform float landscapeTime;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 grassOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gust = sin(landscapeTime * 0.65 - grassOrigin.x * 0.13 - grassOrigin.z * 0.09);
        float breeze = sin(landscapeTime * 1.8 + grassOrigin.x * 0.65 + grassOrigin.z * 0.43) * 0.35 + gust * 0.65;
        transformed.x += breeze * position.y * position.y * 0.8;
        transformed.z += cos(landscapeTime + grassOrigin.z * 0.7) * position.y * position.y * 0.35;
      `)
  }
  grassMaterial.customProgramCacheKey = () => 'courtyard-meadow-grass-v2'
  const grass = new InstancedMesh(grassGeometry, grassMaterial, grassPlacements.length)
  grassPlacements.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.angle, 0)
    dummy.scale.setScalar(p.size)
    dummy.updateMatrix()
    grass.setMatrixAt(i, dummy.matrix)
    const patch = 0.5 + 0.5 * Math.sin(p.x * 0.61 + Math.cos(p.z * 0.49))
    grass.setColorAt(i, color.setRGB(0.74 + patch * 0.26, 0.86 + patch * 0.14, 0.68 + patch * 0.2))
  })
  grass.receiveShadow = true
  // A whole meadow of blades in three cascades buys nothing, and the swayed
  // vertices are not in the depth material anyway.
  grass.castShadow = false
  grass.userData.shadowTagged = true
  // Blades are flat cards; GTAO's opaque normal override would occlude with
  // them as solid quads.
  grass.userData.gtaoExclude = true
  grass.computeBoundingSphere()
  if (grass.boundingSphere) grass.boundingSphere.radius += 0.5
  group.add(grass)
  instances.push(grass)
  ownedGeometries.push(grassGeometry)
  ownedMaterials.push(grassMaterial)

  for (const [name, list] of placements) {
    instanceTemplate(name, list, {
      castShadow: !name.startsWith('flowers'),
      receiveShadow: true,
      tint: name.startsWith('tree') || name.startsWith('bush'),
    })
  }

  return {
    group,
    update(timeSeconds: number) { time.value = timeSeconds },
    dispose() {
      for (const instance of instances) instance.dispose()
      for (const geometry of ownedGeometries) geometry.dispose()
      for (const material of ownedMaterials) material.dispose()
      group.clear()
    },
  }
}
