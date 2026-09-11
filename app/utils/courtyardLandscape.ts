import {
  Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Group,
  InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3,
} from 'three'

export const COURTYARD_LANDSCAPE_NAMES = ['tree', 'bush', 'flowers', 'rock'] as const

const gardens = [
  { x: 14, z: 17, rx: 4.7, rz: 4.2 },
  { x: 40.5, z: 17, rx: 4.2, rz: 3.7 },
  { x: 13, z: 40.5, rx: 4.2, rz: 5.7 },
  { x: 42, z: 42, rx: 4.2, rz: 4.2 },
]

/** Decorative landscape only. All relief and tree trunks remain outside the
 * playable square; garden plants are low enough to walk through. */
export function createCourtyardLandscape(templates: ReadonlyMap<string, Group>) {
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
    const dx = x - 28
    const dz = z - 28
    const distance = Math.max(Math.abs(dx), Math.abs(dz))
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

  const resolution = 140
  const extent = 420
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const meadow = new Color('#71944f')
  const highland = new Color('#637f91')
  const rock = new Color('#9c9c85')
  const color = new Color()
  for (let z = 0; z <= resolution; z++) {
    for (let x = 0; x <= resolution; x++) {
      const px = 28 + (x / resolution - 0.5) * extent
      const pz = 28 + (z / resolution - 0.5) * extent
      const y = height(px, pz)
      positions.push(px, y, pz)
      const slope = Math.hypot(height(px + 1, pz) - y, height(px, pz + 1) - y)
      const distant = smooth(45, 145, Math.hypot(px - 28, pz - 28))
      const patch = Math.sin(px * 0.10 + Math.sin(pz * 0.09) * 2) * Math.cos(pz * 0.13)
      color.copy(meadow).lerp(highland, distant * 0.72)
      const exposed = smooth(0.26, 0.76, slope)
      const strata = 0.86 + Math.sin(y * 1.8 + px * 0.09) * 0.08
      color.lerp(rock, exposed * 0.86)
      color.multiplyScalar((0.95 + patch * 0.12) * (1 - exposed + exposed * strata))
      colors.push(color.r, color.g, color.b)
      if (x < resolution && z < resolution) {
        // Keep the entire playable square free of terrain polygons.
        const nextX = px + extent / resolution
        const nextZ = pz + extent / resolution
        if (nextX > 8 && px < 48 && nextZ > 8 && pz < 48) continue
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
  type Placement = { x: number, z: number, y: number, size: number, angle: number }
  const placements = new Map<string, Placement[]>()
  function place(name: string, x: number, z: number, y: number, size: number) {
    const list = placements.get(name) ?? []
    list.push({ x, z, y, size, angle: random() * Math.PI * 2 })
    placements.set(name, list)
  }

  // Authored woodland groups frame the town rather than forming an even ring.
  const trees = [
    [-6, 10, 8.4], [-11, 17, 7], [-4, 25, 9.1],
    [57, 6, 9.4], [63, 15, 7.8], [57, 23, 8.6],
    [2, -14, 7.2], [10, -18, 8], [46, -16, 7.6], [59, 44, 8.4],
  ]
  for (const [x = 0, z = 0, size = 8] of trees) {
    place('tree', x, z, height(x, z) - 0.1, size)
    place('bush', x + 2.8, z - 1.4, height(x + 2.8, z - 1.4) - 0.03, 0.8 + random() * 0.4)
  }
  // Partly buried, rotated rock clusters create visible geological structure
  // across the foothills, with the larger faces reserved for distant ridges.
  const outcrops = [[-19, -3], [72, -8], [-13, 60], [81, 47], [18, -53], [-55, -39]]
  for (const [x = 0, z = 0] of outcrops) {
    for (let i = 0; i < 3; i++) {
      const px = x + i * 2.4
      const pz = z + Math.sin(i * 2) * 2
      const size = 2.5 + random() * 2.7
      place('rock', px, pz, height(px, pz) - size * 0.22, size)
    }
  }

  const grassPlacements: Placement[] = []
  for (const garden of gardens) {
    for (let i = 0; i < 900; i++) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      const x = garden.x + Math.cos(angle) * garden.rx * radius
      const z = garden.z + Math.sin(angle) * garden.rz * radius
      grassPlacements.push({ x, z, y: 0.025, size: 0.7 + random() * 0.8, angle: random() * Math.PI * 2 })
      if (i % 90 === 0) place('flowers', x, z, 0.015, 0.30 + random() * 0.16)
      else if (i % 137 === 0) place('bush', x, z, 0.01, 0.26 + random() * 0.1)
    }
  }

  // Meadow islands continue the gardens beyond the wall without placing any
  // decorative relief or solid trunks in the playable square.
  for (let i = 0; i < 2200; i++) {
    const x = -16 + random() * 88
    const z = -16 + random() * 88
    if (x > 6 && x < 50 && z > 6 && z < 50) continue
    if (Math.sin(x * 0.23) + Math.cos(z * 0.31) < -0.15) continue
    grassPlacements.push({ x, z, y: height(x, z), size: 0.8 + random() * 0.9, angle: random() * Math.PI * 2 })
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
