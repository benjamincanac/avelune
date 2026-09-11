import {
  Box3, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, Group,
  InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COURTYARD, COURTYARD_ASSETS, FORTIFICATIONS, isInMoat, isOnGateBridge, TOWN_GARDENS } from '#shared/utils/courtyard'
import type { HubPropPlacement } from '#shared/utils/maze'

export const COURTYARD_LANDSCAPE_NAMES = ['tree', 'bush', 'flowers', 'rock'] as const

const gardens = TOWN_GARDENS

/** Decorative landscape only. All relief and tree trunks remain outside the
 * playable square; garden plants are low enough to walk through. */
export function createCourtyardLandscape(templates: ReadonlyMap<string, Group>, villagePlacements: readonly HubPropPlacement[] = []) {
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

  const extent = 420 + expansion * 2
  const terrainAxis = [...new Set([
    ...Array.from({ length: 155 }, (_, i) => center + (i / 154 - 0.5) * extent),
    COURTYARD.min, COURTYARD.max, FORTIFICATIONS.moatInnerMin, FORTIFICATIONS.moatInnerMax,
    FORTIFICATIONS.moatOuterMin, FORTIFICATIONS.moatOuterMax,
  ])].sort((a, b) => a - b)
  const resolution = terrainAxis.length - 1
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const meadow = new Color('#71944f')
  const highland = new Color('#637f91')
  const rock = new Color('#9c9c85')
  const color = new Color()
  for (let z = 0; z <= resolution; z++) {
    for (let x = 0; x <= resolution; x++) {
      const px = terrainAxis[x]!
      const pz = terrainAxis[z]!
      const y = height(px, pz)
      positions.push(px, y, pz)
      const slope = Math.hypot(height(px + 1, pz) - y, height(px, pz + 1) - y)
      const distant = smooth(45, 145, Math.hypot(px - center, pz - center) - expansion)
      const patch = Math.sin(px * 0.10 + Math.sin(pz * 0.09) * 2) * Math.cos(pz * 0.13)
      color.copy(meadow).lerp(highland, distant * 0.72)
      const exposed = smooth(0.26, 0.76, slope)
      const strata = 0.86 + Math.sin(y * 1.8 + px * 0.09) * 0.08
      color.lerp(rock, exposed * 0.86)
      color.multiplyScalar((0.95 + patch * 0.12) * (1 - exposed + exposed * strata))
      colors.push(color.r, color.g, color.b)
      if (x < resolution && z < resolution) {
        // Keep the entire playable square free of terrain polygons.
        const nextX = terrainAxis[x + 1]!
        const nextZ = terrainAxis[z + 1]!
        if (isInMoat((px + nextX) / 2, (pz + nextZ) / 2)) continue
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

  // Separate copses leave broad views between them, with smaller saplings and
  // shrubs feathering the edges. Never put decorative trunks inside collision.
  const outsideVillage = (x: number, z: number) => x <= FORTIFICATIONS.exteriorMin - 2 || x >= FORTIFICATIONS.exteriorMax + 2 || z <= FORTIFICATIONS.exteriorMin - 2 || z >= FORTIFICATIONS.exteriorMax + 2
  const copses = [
    { x: -10, z: 17, rx: 10, rz: 19, count: 10 },
    { x: 65, z: 12, rx: 12, rz: 18, count: 9 },
    { x: 12, z: -20, rx: 21, rz: 12, count: 8 },
    { x: 69, z: 59, rx: 16, rz: 12, count: 6 },
    { x: 16, z: 67, rx: 17, rz: 9, count: 7 },
  ]
  const treePositions: { x: number, z: number }[] = []
  for (const copse of copses.map(relocate)) {
    for (let attempt = 0, planted = 0; attempt < copse.count * 12 && planted < copse.count; attempt++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = copse.x + Math.cos(angle) * copse.rx * radius
      const z = copse.z + Math.sin(angle) * copse.rz * radius
      if (!outsideVillage(x, z) || treePositions.some(p => Math.hypot(p.x - x, p.z - z) < 4.8)) continue
      const size = 5.5 + (1 - radius) * 4 + random() * 3
      place('tree', x, z, height(x, z) - 0.12, size)
      treePositions.push({ x, z })
      planted++
      for (let i = 0; i < 2; i++) {
        const spread = 2.2 + random() * 2.5
        const direction = random() * Math.PI * 2
        const bx = x + Math.cos(direction) * spread
        const bz = z + Math.sin(direction) * spread
        if (!outsideVillage(bx, bz)) continue
        place('bush', bx, bz, height(bx, bz) - 0.05, 0.65 + random() * 0.8)
        if (i === 0) place('flowers', bx + 0.5, bz, height(bx + 0.5, bz), 0.32 + random() * 0.2)
      }
    }
  }

  // Sparse folded leaf sprays preserve the detailed tree's broken silhouette
  // at distance, with under 1k triangles instead of the full tree's 38k.
  const distantParts: BufferGeometry[] = []
  function branch(start: Vector3, end: Vector3, radius: number) {
    const direction = end.clone().sub(start)
    const cylinder = new CylinderGeometry(radius * 0.3, radius, direction.length(), 5).toNonIndexed()
    cylinder.deleteAttribute('uv')
    cylinder.applyQuaternion(dummy.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()))
    cylinder.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)
    const tint = new Float32Array(cylinder.getAttribute('position').count * 3)
    color.set('#635d43')
    for (let i = 0; i < tint.length; i += 3) tint.set([color.r, color.g, color.b], i)
    cylinder.setAttribute('color', new BufferAttribute(tint, 3))
    distantParts.push(cylinder)
  }
  branch(new Vector3(), new Vector3(0.025, 0.78, -0.015), 0.038)
  const leafPositions: number[] = []
  const leafColors: number[] = []
  const axis = new Vector3()
  const across = new Vector3()
  const leafCenter = new Vector3()
  const normal = new Vector3()
  for (let cluster = 0; cluster < 12; cluster++) {
    const angle = cluster * 2.399
    const radius = cluster < 8 ? 0.24 : 0.095
    const cy = 0.58 + cluster * 0.027
    const center = new Vector3(Math.cos(angle) * radius, cy, Math.sin(angle) * radius)
    if (cluster < 8) branch(new Vector3(0.01, cy - 0.23, 0), center, 0.018)
    for (let leaf = 0; leaf < 17; leaf++) {
      const elevation = 1 - 2 * (leaf + 0.5) / 17
      const radial = Math.sqrt(1 - elevation * elevation)
      const theta = leaf * 2.399 + cluster
      normal.set(Math.cos(theta) * radial, elevation, Math.sin(theta) * radial)
      leafCenter.copy(center).addScaledVector(normal, 0.075)
      axis.set(Math.cos(theta + 0.7), 0.5, Math.sin(theta + 0.7)).normalize()
      across.crossVectors(normal, axis).normalize()
      const length = 0.12 + ((leaf + cluster) % 4) * 0.014
      const width = length * 0.32
      const points = [
        leafCenter.clone().addScaledVector(axis, -length * 0.5),
        leafCenter.clone().addScaledVector(across, width),
        leafCenter.clone().addScaledVector(axis, length * 0.65),
        leafCenter.clone().addScaledVector(across, -width),
        leafCenter.clone().addScaledVector(normal, length * 0.12),
      ]
      color.set('#527745').multiplyScalar(0.9 + elevation * 0.13 + ((leaf + cluster) % 3) * 0.08)
      for (const index of [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]) {
        const point = points[index]!
        leafPositions.push(point.x, point.y, point.z)
        leafColors.push(color.r, color.g, color.b)
      }
    }
  }
  const leafGeometry = new BufferGeometry()
  leafGeometry.setAttribute('position', new BufferAttribute(new Float32Array(leafPositions), 3))
  leafGeometry.setAttribute('color', new BufferAttribute(new Float32Array(leafColors), 3))
  leafGeometry.computeVertexNormals()
  distantParts.push(leafGeometry)
  const distantGeometry = mergeGeometries(distantParts)!
  distantParts.forEach(part => part.dispose())
  const distantMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 1, side: DoubleSide })
  const distantTrees: Placement[] = []
  const woodland = [
    { x: -45, z: 4, rx: 21, rz: 34 },
    { x: -28, z: -49, rx: 37, rz: 22 },
    { x: 57, z: -53, rx: 26, rz: 20 },
    { x: 101, z: 35, rx: 23, rz: 48 },
    { x: 75, z: 104, rx: 36, rz: 19 },
    { x: 16, z: 109, rx: 24, rz: 16 },
    { x: -43, z: 92, rx: 29, rz: 28 },
  ]
  for (const copse of woodland.map(relocate)) {
    for (let i = 0; i < 75; i++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = copse.x + Math.cos(angle) * copse.rx * radius
      const z = copse.z + Math.sin(angle) * copse.rz * radius
      if (!outsideVillage(x, z)) continue
      const y = height(x, z)
      const slope = Math.hypot(height(x + 1, z) - y, height(x, z + 1) - y)
      if (slope > 0.65 || distantTrees.some(p => Math.hypot(p.x - x, p.z - z) < 3.8)) continue
      distantTrees.push({ x, z, y: y - 0.22, size: 6 + random() * 5, angle, width: 0.8 + random() * 0.35 })
    }
  }
  const distantForest = new InstancedMesh(distantGeometry, distantMaterial, distantTrees.length)
  distantTrees.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.angle, 0)
    dummy.scale.set(p.size * p.width!, p.size, p.size * p.width!)
    dummy.updateMatrix()
    distantForest.setMatrixAt(i, dummy.matrix)
    const variation = 0.8 + random() * 0.2
    distantForest.setColorAt(i, color.setRGB(variation, 0.9 + random() * 0.1, variation))
  })
  distantForest.receiveShadow = true
  distantForest.computeBoundingSphere()
  group.add(distantForest)
  instances.push(distantForest)
  ownedGeometries.push(distantGeometry)
  ownedMaterials.push(distantMaterial)
  // Partly buried, rotated rock clusters create visible geological structure
  // across the foothills, with the larger faces reserved for distant ridges.
  const outcrops = [[-19, -3], [72, -8], [-13, 60], [81, 47], [18, -53], [-55, -39]]
  for (const [x = 0, z = 0] of outcrops) {
    for (let i = 0; i < 3; i++) {
      const origin = relocate({ x, z })
      const px = origin.x + i * 2.4
      const pz = origin.z + Math.sin(i * 2) * 2
      const size = 2.5 + random() * 2.7
      place('rock', px, pz, height(px, pz) - size * 0.22, size)
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
      grassPlacements.push({ x, z, y: 0.025, size: 0.7 + random() * 0.8, angle: random() * Math.PI * 2 })
      if (i % 90 === 0) place('flowers', x, z, 0.015, 0.30 + random() * 0.16)
      else if (i % 137 === 0) place('bush', x, z, 0.01, 0.26 + random() * 0.1)
    }
  }

  // Dense patchy meadow near the wall thins uphill. Scattered flower drifts
  // follow the same moisture pattern, leaving dry gaps rather than a lawn.
  for (let i = 0; i < 22000; i++) {
    const x = COURTYARD.min - 43 + random() * (COURTYARD.max - COURTYARD.min + 86)
    const z = COURTYARD.min - 43 + random() * (COURTYARD.max - COURTYARD.min + 86)
    if ((x > COURTYARD.min && x < COURTYARD.max && z > COURTYARD.min && z < COURTYARD.max) || isInMoat(x, z) || isOnGateBridge(x, z) || (Math.abs(x - FORTIFICATIONS.gateX) < FORTIFICATIONS.bridgeWidth / 2 + 0.3 && z >= FORTIFICATIONS.bridgeEnd && z <= FORTIFICATIONS.exteriorMax)) continue
    const distance = Math.max(Math.abs(x - center), Math.abs(z - center)) - expansion
    const patch = Math.sin(x * 0.14 + Math.sin(z * 0.19)) + Math.cos(z * 0.16 - x * 0.035)
    if (patch < -0.9 || random() > 1 - smooth(30, 65, distance) * 0.87) continue
    const y = height(x, z)
    grassPlacements.push({ x, z, y, size: 0.9 + random() * 1.1, angle: random() * Math.PI * 2 })
    if (i % 130 === 0 && patch > 0.1) place('flowers', x, z, y, 0.28 + random() * 0.24)
  }

  // Curved, tapered blades with several segments, a soft base-to-tip gradient,
  // and coherent GPU wind. One draw call for every garden's grass.
  const bladePositions: number[] = []
  const bladeColors: number[] = []
  const bladeIndices: number[] = []
  for (let blade = 0; blade < 5; blade++) {
    const angle = blade * 2.4
    const lean = 0.15 + random() * 0.16
    const length = 0.24 + random() * 0.24
    const width = 0.025 + random() * 0.018
    const base = bladePositions.length / 3
    for (let segment = 0; segment <= 4; segment++) {
      const t = segment / 4
      for (const side of [-1, 1]) {
        const across = side * width * (1 - t * 0.97)
        const bend = lean * t * t
        bladePositions.push(Math.cos(angle) * bend + Math.sin(angle) * across, t * length, Math.sin(angle) * bend - Math.cos(angle) * across)
        color.set('#3e703e').lerp(new Color('#b6ce70'), t * t)
        bladeColors.push(color.r, color.g, color.b)
      }
      if (segment < 4) {
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
    grass.setColorAt(i, color.setRGB(0.78 + patch * 0.22, 0.88 + patch * 0.12, 0.72 + patch * 0.18))
  })
  grass.receiveShadow = true
  grass.computeBoundingSphere()
  if (grass.boundingSphere) grass.boundingSphere.radius += 0.5
  group.add(grass)
  instances.push(grass)
  ownedGeometries.push(grassGeometry)
  ownedMaterials.push(grassMaterial)

  // Template geometry and materials stay untouched, including normalized GLB
  // attributes. Source mesh transforms are composed into each instance matrix.
  const size = new Vector3()
  const sourceTransform = new Matrix4()
  const matrix = new Matrix4()
  for (const [name, list] of placements) {
    const template = templates.get(name)
    if (!template) continue
    template.updateWorldMatrix(true, true)
    const bounds = new Box3().setFromObject(template)
    bounds.getSize(size)
    if (size.y < 0.001) continue
    const templateHeight = size.y
    const centerX = (bounds.min.x + bounds.max.x) / 2
    const centerZ = (bounds.min.z + bounds.max.z) / 2
    sourceTransform.makeTranslation(-centerX, -bounds.min.y, -centerZ)
    template.traverse((child) => {
      if (!(child instanceof Mesh)) return
      const batch = new InstancedMesh(child.geometry, child.material, list.length)
      const source = new Matrix4().multiplyMatrices(sourceTransform, child.matrixWorld)
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z)
        dummy.rotation.set(0, p.angle, 0)
        dummy.scale.setScalar(p.size / templateHeight)
        dummy.updateMatrix()
        matrix.multiplyMatrices(dummy.matrix, source)
        batch.setMatrixAt(i, matrix)
      })
      if (name === 'tree' || name === 'bush') {
        list.forEach((p, i) => {
          const variation = 0.5 + Math.sin(p.x * 1.37 + p.z * 0.73) * 0.5
          batch.setColorAt(i, color.setRGB(0.83 + variation * 0.17, 0.91 + variation * 0.09, 0.76 + variation * 0.2))
        })
      }
      batch.castShadow = name !== 'flowers'
      batch.receiveShadow = true
      batch.computeBoundingSphere()
      group.add(batch)
      instances.push(batch)
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
