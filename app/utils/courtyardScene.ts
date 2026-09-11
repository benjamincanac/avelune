import {
  BufferAttribute, BufferGeometry, CircleGeometry, Color, CylinderGeometry,
  DoubleSide, Group, IcosahedronGeometry, InstancedMesh, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry,
  RingGeometry, TorusGeometry, Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { COURTYARD, FOUNTAIN } from '#shared/utils/courtyard'
import { createRng } from '#shared/utils/maze'
import type { HubPropPlacement } from '#shared/utils/maze'
import { createCourtyardLandscape } from './courtyardLandscape'
import { createFountainWater } from './fountainWater'
import type { FountainInteractor } from './fountainWater'
import { makeCourtyardSurface, makePlazaSurface } from './courtyardTextures'

/** Ground and distant scenery. All walkable elevations stay at ground level;
 * buildings, furniture and tree trunks are authored props in the shared plan. */
export function createCourtyardScene(placements: readonly HubPropPlacement[], templates: ReadonlyMap<string, Group>) {
  const group = new Group()
  const rng = createRng(1709)
  const dummy = new Object3D()
  const stoneMap = makeCourtyardSurface('stone')
  const plazaMap = makePlazaSurface()
  const stone = new MeshStandardMaterial({ color: '#b8c4c7', map: stoneMap, roughness: 0.95 })
  const paleStone = new MeshStandardMaterial({ color: '#e5dcc4', map: stoneMap, roughness: 0.95 })
  const grass = new MeshStandardMaterial({ color: '#7a9d58', roughness: 1 })
  const soil = new MeshStandardMaterial({ color: '#7f745b', roughness: 1 })
  const arenaMaterial = new MeshStandardMaterial({ color: '#e4cf9f', map: plazaMap, roughness: 1 })
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
    paving.setColorAt(i, new Color().setHSL(0.53 + s.shade * 0.04, 0.025 + s.shade * 0.025, 0.85 + s.shade * 0.12))
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
    const radius = (FOUNTAIN.outerRadius + 0.2) * p.scale
    const base = flat(new CircleGeometry(radius, 64), paleStone, p.x, p.y, 0.045)
    const rim = flat(new RingGeometry(radius, radius + 0.1, 64), blueInlay, p.x, p.y, 0.047)
    for (const mesh of [base, rim]) {
      mesh.scale.set((p.s3?.[0] ?? p.scale) / p.scale, (p.s3?.[2] ?? p.scale) / p.scale, 1)
    }
  }

  const landscape = createCourtyardLandscape(templates, placements)
  group.add(landscape.group)

  // Ropes follow authored tree transforms, including editor moves and scaling.
  const trees = placements.filter(p => p.kind === 'Courtyard_Tree')
  const spans: { start: Vector3, end: Vector3 }[] = []
  const ropeMaterial = new MeshStandardMaterial({ color: '#82745b', roughness: 1 })
  const tieGeometry = new TorusGeometry(0.13, 0.022, 5, 20)
  function tieToTree(tree: HubPropPlacement) {
    const [sx, sy, sz] = tree.s3 ?? [tree.scale, tree.scale, tree.scale]
    // Bent trunk center and radius at height 3.4 in the botanical model.
    const x = -0.22 * sx
    const z = -0.17 * sz
    const point = new Vector3(tree.x + x * Math.cos(tree.rot) + z * Math.sin(tree.rot),
      (tree.z ?? 0) + 3.4 * sy, tree.y - x * Math.sin(tree.rot) + z * Math.cos(tree.rot))
    const tie = new Mesh(tieGeometry, ropeMaterial)
    tie.position.copy(point)
    tie.rotation.set(-Math.PI / 2, 0, tree.rot)
    tie.scale.set(sx, sz, sy)
    group.add(tie)
    return point
  }
  for (const targetZ of [17, 40]) {
    const nearby = trees.filter(p => targetZ === 17 ? p.y < 30 : p.y >= 30)
    const nearest = (left: boolean) => nearby.filter(p => left ? p.x < 28 : p.x >= 28)
      .sort((a, b) => Math.abs(a.y - targetZ) - Math.abs(b.y - targetZ))[0]
    const left = nearest(true)
    const right = nearest(false)
    if (left && right) spans.push({ start: tieToTree(left), end: tieToTree(right) })
  }
  // No tree pair means no floating rope in that part of the editor layout.
  if (!spans.length) tieGeometry.dispose()
  const ropePoint = (span: { start: Vector3, end: Vector3 }, t: number) => {
    const point = span.start.clone().lerp(span.end, t)
    point.y -= Math.sin(t * Math.PI) * 0.45
    return point
  }
  const pennants: Mesh[] = []
  const ropes = new InstancedMesh(new CylinderGeometry(0.016, 0.016, 1, 5), ropeMaterial, spans.length * 50)
  group.add(ropes)
  let ropeIndex = 0
  const flagGeometry = new BufferGeometry()
  flagGeometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.28, 0, 0, 0.02, -0.64, 0.06, 0.28, 0, 0]), 3))
  flagGeometry.computeVertexNormals()
  const flagMaterials = ['#426c94', '#e5ce89', '#7195b1', '#eee2c2'].map(color => new MeshStandardMaterial({ color, side: DoubleSide, roughness: 1 }))
  for (const span of spans) {
    const vertices: number[] = []
    for (let i = 0; i <= 50; i++) {
      const t = i / 50
      const point = ropePoint(span, t)
      vertices.push(point.x, point.y, point.z)
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
      const flag = new Mesh(flagGeometry, flagMaterials[i % 4]!)
      flag.position.copy(ropePoint(span, t))
      group.add(flag)
      pennants.push(flag)
    }
  }

  // Light floral swags follow the existing overhead ropes, clear of all players.
  const garlandLeaves = new InstancedMesh(new IcosahedronGeometry(0.12, 0), new MeshStandardMaterial({ color: '#6b934e', roughness: 1 }), spans.length * 94)
  const garlandPetals = new InstancedMesh(new IcosahedronGeometry(0.068, 0), new MeshStandardMaterial({ color: '#f2e6b7', roughness: 1 }), spans.length * 55)
  let leafIndex = 0
  let petalIndex = 0
  for (const span of spans) {
    for (let i = 1; i < 48; i++) {
      const t = i / 48
      const { x, y, z } = ropePoint(span, t)
      for (const side of [-1, 1]) {
        dummy.position.set(x + side * 0.07, y - 0.035, z + side * 0.12)
        dummy.rotation.set(side * 0.3, i * 1.7, side * 0.6)
        dummy.scale.set(1.5, 0.3, 0.75)
        dummy.updateMatrix()
        garlandLeaves.setMatrixAt(leafIndex++, dummy.matrix)
      }
      if (i % 4) continue
      for (let petal = 0; petal < 5; petal++) {
        const angle = petal / 5 * Math.PI * 2
        dummy.position.set(x + Math.cos(angle) * 0.07, y - 0.1 + Math.sin(angle) * 0.07, z - 0.035)
        dummy.rotation.set(0, 0, angle)
        dummy.scale.set(1, 0.7, 0.35)
        dummy.updateMatrix()
        garlandPetals.setMatrixAt(petalIndex++, dummy.matrix)
        garlandPetals.setColorAt(petalIndex - 1, new Color(i % 8 ? '#ffffff' : '#f3cd62'))
      }
    }
  }
  group.add(garlandLeaves, garlandPetals)

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
    return { effect, timeScale: 1 / Math.sqrt(verticalScale), actors: [] as FountainInteractor[] }
  })
  return {
    group,
    update(time: number, players: readonly FountainInteractor[] = []) {
      landscape.update(time)
      pennants.forEach((flag, i) => {
        flag.rotation.x = Math.sin(time * 1.5 + i * 0.65) * 0.16
      })
      for (const { effect, timeScale, actors } of fountains) {
        effect.group.updateWorldMatrix(true, false)
        actors.length = players.length
        for (let i = 0; i < players.length; i++) {
          const player = players[i]!
          const point = dummy.position.set(player.x, player.feetY, player.z)
          effect.group.worldToLocal(point)
          const actor = actors[i] ??= { id: player.id, x: 0, z: 0, feetY: 0 }
          actor.id = player.id
          actor.x = point.x
          actor.z = point.z
          actor.feetY = point.y
        }
        effect.update(time * timeScale, actors)
      }
    },
    dispose() {
      for (const { effect } of fountains) {
        group.remove(effect.group)
        effect.dispose()
      }
      group.remove(landscape.group)
      landscape.dispose()
      stoneMap.dispose()
      plazaMap.dispose()
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
