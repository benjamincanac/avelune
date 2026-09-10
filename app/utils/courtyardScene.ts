import {
  BufferAttribute, BufferGeometry, CircleGeometry, Color, CylinderGeometry,
  DoubleSide, Group, InstancedMesh, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry,
  RingGeometry, Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { COURTYARD } from '#shared/utils/courtyard'
import { createRng } from '#shared/utils/maze'
import type { HubPropPlacement } from '#shared/utils/maze'
import { createCourtyardLandscape } from './courtyardLandscape'
import { createFountainWater } from './fountainWater'
import { makeCourtyardSurface } from './courtyardTextures'

/** Ground and distant scenery. All walkable elevations stay at ground level;
 * buildings, furniture and tree trunks are authored props in the shared plan. */
export function createCourtyardScene(placements: readonly HubPropPlacement[], templates: ReadonlyMap<string, Group>) {
  const group = new Group()
  const rng = createRng(1709)
  const dummy = new Object3D()
  const stoneMap = makeCourtyardSurface('stone')
  const stone = new MeshStandardMaterial({ color: '#c8c4b3', map: stoneMap, roughness: 0.95 })
  const paleStone = new MeshStandardMaterial({ color: '#e5dcc4', map: stoneMap, roughness: 0.95 })
  const grass = new MeshStandardMaterial({ color: '#7a9d58', roughness: 1 })
  const soil = new MeshStandardMaterial({ color: '#7f745b', roughness: 1 })
  const arenaMaterial = new MeshStandardMaterial({ color: '#c9cbbd', map: stoneMap, roughness: 1 })
  const shadow = new MeshBasicMaterial({ color: '#453c2b', transparent: true, opacity: 0.07, depthWrite: false })

  function flat(geometry: BufferGeometry, material: MeshStandardMaterial | MeshBasicMaterial, x: number, z: number, y = 0.025) {
    const m = new Mesh(geometry, material)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y, z)
    m.receiveShadow = true
    group.add(m)
    return m
  }
  flat(new PlaneGeometry(40, 40), soil, 28, 28, -0.01)

  const gardens = [
    { x: 14, z: 17, rx: 5, rz: 4.5 },
    { x: 40.5, z: 17, rx: 4.5, rz: 4 },
    { x: 13, z: 40.5, rx: 4.5, rz: 6 },
    { x: 42, z: 42, rx: 4.5, rz: 4.5 },
  ]
  const inGarden = (x: number, z: number) => gardens.some(g => ((x - g.x) / g.rx) ** 2 + ((z - g.z) / g.rz) ** 2 < 1)
  const { arena } = COURTYARD
  const stones: { x: number, z: number, shade: number }[] = []
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 40; col++) {
      const x = 8.5 + col + (row % 2 ? 0.45 : 0)
      const z = 8.5 + row
      if (x > 47.8 || inGarden(x, z)) continue
      if (Math.hypot(x - arena.x, z - arena.y) < arena.radius + 0.3) continue
      stones.push({ x, z, shade: rng() })
    }
  }
  const paving = new InstancedMesh(new RoundedBoxGeometry(0.983, 0.045, 0.983, 2, 0.014), stone, stones.length)
  stones.forEach((s, i) => {
    dummy.position.set(s.x, -0.015, s.z)
    dummy.rotation.set(0, (rng() - 0.5) * 0.008, 0)
    dummy.updateMatrix()
    paving.setMatrixAt(i, dummy.matrix)
    paving.setColorAt(i, new Color().setHSL(0.12, 0.055 + s.shade * 0.04, 0.85 + s.shade * 0.1))
  })
  paving.receiveShadow = true
  group.add(paving)

  for (const garden of gardens) {
    const lawn = flat(new CircleGeometry(1, 48), grass, garden.x, garden.z, 0.005)
    lawn.scale.set(garden.rx + 0.2, garden.rz + 0.2, 1)
    // Separate edge stones follow each organic bed, leaving the walking paths clear.
    const count = 48
    const edge = new InstancedMesh(new RoundedBoxGeometry(0.54, 0.15, 0.22, 1, 0.035), paleStone, count)
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2
      dummy.position.set(garden.x + Math.cos(a) * garden.rx, 0.05, garden.z + Math.sin(a) * garden.rz)
      dummy.rotation.set(0, -a - Math.PI / 2, 0)
      dummy.updateMatrix()
      edge.setMatrixAt(i, dummy.matrix)
    }
    edge.receiveShadow = true
    group.add(edge)
  }

  // Limestone training circle with blue ceramic inlays and a compass rose.
  flat(new CircleGeometry(arena.radius, 96), arenaMaterial, arena.x, arena.y, 0.025)
  flat(new RingGeometry(arena.radius, arena.radius + 0.5, 96), paleStone, arena.x, arena.y, 0.03)
  flat(new RingGeometry(arena.radius - 0.45, arena.radius - 0.40, 96), stone, arena.x, arena.y, 0.033)
  flat(new RingGeometry(2.1, 2.16, 64), stone, arena.x, arena.y, 0.033)
  const blueInlay = new MeshStandardMaterial({ color: '#789b9d', roughness: 0.8, map: stoneMap })
  for (let i = 0; i < 32; i++) {
    flat(new RingGeometry(arena.radius - 0.36, arena.radius - 0.12, 4, 1, i * Math.PI / 16 + 0.009, Math.PI / 16 - 0.018), i % 4 === 0 ? blueInlay : paleStone, arena.x, arena.y, 0.036)
  }
  flat(new CircleGeometry(1.85, 64), paleStone, arena.x, arena.y, 0.034)
  flat(new RingGeometry(1.87, 1.93, 64), blueInlay, arena.x, arena.y, 0.035)
  const border = new InstancedMesh(new RoundedBoxGeometry(0.59, 0.08, 0.48, 1, 0.025), stone, 76)
  for (let i = 0; i < 76; i++) {
    const a = i / 76 * Math.PI * 2
    dummy.position.set(arena.x + Math.cos(a) * (arena.radius + 0.25), 0.035, arena.y + Math.sin(a) * (arena.radius + 0.25))
    dummy.rotation.set(0, -a - Math.PI / 2, 0)
    dummy.updateMatrix()
    border.setMatrixAt(i, dummy.matrix)
  }
  border.receiveShadow = true
  group.add(border)
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, -0.22, 0, -0.45, 0, 0, i % 2 ? -1.1 : -1.65, 0.22, 0, -0.45]), 3))
    geometry.setIndex([0, 2, 1, 0, 3, 2])
    geometry.computeVertexNormals()
    const ray = new Mesh(geometry, stone)
    ray.position.set(arena.x, 0.04, arena.y)
    ray.rotation.y = a
    group.add(ray)
  }
  // Foundation follows authored fountain placements, including editor scaling.
  for (const p of placements.filter(p => p.kind === 'Courtyard_Fountain')) {
    const radius = 2.12 * p.scale
    const base = flat(new CircleGeometry(radius, 64), paleStone, p.x, p.y, 0.045)
    const rim = flat(new RingGeometry(radius, radius + 0.1, 64), blueInlay, p.x, p.y, 0.047)
    for (const mesh of [base, rim]) {
      mesh.scale.set((p.s3?.[0] ?? p.scale) / p.scale, (p.s3?.[2] ?? p.scale) / p.scale, 1)
    }
  }

  const landscape = createCourtyardLandscape(templates)
  group.add(landscape.group)

  // Festival pennants sag between buildings, above the playable space.
  const pennants: Mesh[] = []
  const ropes = new InstancedMesh(new CylinderGeometry(0.016, 0.016, 1, 5), stone, 100)
  group.add(ropes)
  let ropeIndex = 0
  for (const z of [15, 36]) {
    const vertices: number[] = []
    const colors = ['#d18969', '#6d9e9d', '#e0bd70', '#e6dcc0']
    for (let i = 0; i <= 50; i++) {
      const t = i / 50
      vertices.push(12 + t * 32, 5.8 - Math.sin(t * Math.PI) * 1.6, z)
    }
    // Fine wooden rope segments avoid a screen-space line width dependency.
    for (let i = 0; i < 50; i++) {
      const p = new Vector3(...vertices.slice(i * 3, i * 3 + 3) as [number, number, number])
      const q = new Vector3(...vertices.slice(i * 3 + 3, i * 3 + 6) as [number, number, number])
      const d = q.sub(p)
      dummy.position.copy(p).addScaledVector(d, 0.5)
      dummy.scale.set(1, d.length(), 1)
      dummy.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize())
      dummy.updateMatrix()
      ropes.setMatrixAt(ropeIndex++, dummy.matrix)
    }
    for (let i = 1; i < 24; i++) {
      const t = i / 24
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.28, 0, 0, 0.02, -0.64, 0.06, 0.28, 0, 0]), 3))
      geometry.computeVertexNormals()
      const flag = new Mesh(geometry, new MeshStandardMaterial({ color: colors[i % 4], side: DoubleSide, roughness: 1 }))
      flag.position.set(12 + t * 32, 5.8 - Math.sin(t * Math.PI) * 1.6, z)
      group.add(flag)
      pennants.push(flag)
    }
  }

  // Soft contact patches help anchor trunks and furniture in overcast light.
  for (const p of placements) {
    if (!['Courtyard_Tree', 'Courtyard_Fountain'].includes(p.kind)) continue
    flat(new CircleGeometry((p.kind === 'Courtyard_Tree' ? 1.7 : 2) * p.scale, 32), shadow, p.x, p.y, 0.065)
  }
  const fountains = placements.filter(p => p.kind === 'Courtyard_Fountain').map((p) => {
    const effect = createFountainWater()
    const verticalScale = Math.max(0.01, p.s3?.[1] ?? p.scale)
    effect.group.position.set(p.x, p.z ?? 0, p.y)
    effect.group.rotation.y = p.rot
    effect.group.scale.set(p.s3?.[0] ?? p.scale, verticalScale, p.s3?.[2] ?? p.scale)
    group.add(effect.group)
    // Scaling time with height keeps gravity constant in world units.
    return { effect, timeScale: 1 / Math.sqrt(verticalScale) }
  })
  return {
    group,
    update(time: number) {
      landscape.update(time)
      pennants.forEach((flag, i) => {
        flag.rotation.x = Math.sin(time * 1.5 + i * 0.65) * 0.16
      })
      for (const { effect, timeScale } of fountains) effect.update(time * timeScale)
    },
    dispose() {
      for (const { effect } of fountains) {
        group.remove(effect.group)
        effect.dispose()
      }
      group.remove(landscape.group)
      landscape.dispose()
      stoneMap.dispose()
      const geometries = new Set<BufferGeometry>()
      const materials = new Set<MeshStandardMaterial | MeshBasicMaterial>()
      group.traverse((o) => {
        if (!(o instanceof Mesh)) return
        geometries.add(o.geometry)
        materials.add(o.material as MeshStandardMaterial | MeshBasicMaterial)
        if (o instanceof InstancedMesh) o.dispose()
      })
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
