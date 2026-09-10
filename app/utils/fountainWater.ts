import {
  BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, InstancedMesh,
  Mesh, MeshPhysicalMaterial, Object3D, SphereGeometry, Vector3,
} from 'three'
import { createFountainSimulation } from './fountainSimulation'

/** Cosmetic water physics, independent of authoritative player movement. */
export function createFountainWater() {
  const group = new Group()
  group.name = 'Simulated fountain water'
  const sim = createFountainSimulation()
  const upperSim = createFountainSimulation(24, 0.44, 0)
  const waterY = 0.48
  const positions = new Float32Array(sim.resolution * sim.resolution * 3)
  const colors = new Float32Array(positions.length)
  const indices: number[] = []
  const deep = new Color('#2f9296')
  const light = new Color('#99d6c7')
  const color = new Color()
  for (let z = 0; z < sim.resolution; z++) {
    for (let x = 0; x < sim.resolution; x++) {
      const i = z * sim.resolution + x
      const px = x * sim.spacing - sim.radius
      const pz = z * sim.spacing - sim.radius
      positions.set([px, waterY, pz], i * 3)
      color.copy(deep).lerp(light, Math.pow(Math.min(1, Math.hypot(px, pz) / sim.radius), 3) * 0.55)
      colors.set([color.r, color.g, color.b], i * 3)
      if (x >= sim.resolution - 1 || z >= sim.resolution - 1) continue
      if (!sim.active[i] || !sim.active[i + 1] || !sim.active[i + sim.resolution] || !sim.active[i + sim.resolution + 1]) continue
      indices.push(i, i + sim.resolution, i + 1, i + 1, i + sim.resolution, i + sim.resolution + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const material = new MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.16, metalness: 0.10,
    clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, opacity: 0.88,
    depthWrite: false,
  })
  // A restrained sky reflection keeps grazing-angle water legible even when
  // the scene has no image-based environment. Surface normals come from waves.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float waterFresnel = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 4.0);
      outgoingLight += vec3(0.19, 0.32, 0.34) * waterFresnel * 0.32;
      #include <opaque_fragment>
    `)
  }
  material.customProgramCacheKey = () => 'fountain-wave-fresnel-v1'
  const water = new Mesh(geometry, material)
  water.receiveShadow = true
  group.add(water)

  const upperPositions = new Float32Array(24 * 24 * 3)
  const upperIndices: number[] = []
  for (let z = 0; z < 24; z++) {
    for (let x = 0; x < 24; x++) {
      const i = z * 24 + x
      upperPositions.set([x * upperSim.spacing - 0.44, 1.81, z * upperSim.spacing - 0.44], i * 3)
      if (x < 23 && z < 23 && upperSim.active[i] && upperSim.active[i + 1] && upperSim.active[i + 24] && upperSim.active[i + 25]) {
        upperIndices.push(i, i + 24, i + 1, i + 1, i + 24, i + 25)
      }
    }
  }
  const upperGeometry = new BufferGeometry()
  upperGeometry.setAttribute('position', new BufferAttribute(upperPositions, 3).setUsage(DynamicDrawUsage))
  const upperColors = new Float32Array(upperPositions.length)
  for (let i = 0; i < 24 * 24; i++) upperColors.set([light.r, light.g, light.b], i * 3)
  upperGeometry.setAttribute('color', new BufferAttribute(upperColors, 3))
  upperGeometry.setIndex(upperIndices)
  upperGeometry.computeVertexNormals()
  const upperWater = new Mesh(upperGeometry, material)
  upperWater.receiveShadow = true
  group.add(upperWater)

  const dropletGeometry = new SphereGeometry(1, 6, 4)
  const dropletMaterial = new MeshPhysicalMaterial({
    color: '#b0e4e2', roughness: 0.08, metalness: 0.08,
    clearcoat: 1, transparent: true, opacity: 0.78,
  })
  const maxParticles = 480
  const droplets = new InstancedMesh(dropletGeometry, dropletMaterial, maxParticles)
  droplets.instanceMatrix.setUsage(DynamicDrawUsage)
  droplets.frustumCulled = false
  group.add(droplets)
  const dummy = new Object3D()
  const up = new Vector3(0, 1, 0)
  const velocity = new Vector3()
  type Particle = { x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, splash: boolean }
  const particles: Particle[] = []
  let previous: number | undefined
  let accumulator = 0
  let emission = 0
  let tick = 0
  const gravity = 9.81

  function emit() {
    for (let jet = 0; jet < 12; jet++) {
      if (particles.length >= maxParticles) return
      const angle = jet * Math.PI / 6
      const jitter = Math.sin(tick * 2.3 + jet * 1.7) * 0.025
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      particles.push({ x: c * 0.43, y: 2.01, z: s * 0.43, vx: c * (1.0 + jitter), vy: 0.45 + jitter, vz: s * (1.0 + jitter), life: 2, splash: false })
    }
  }

  function step() {
    const dt = sim.timestep
    tick++
    emission += dt
    if (emission >= 1 / 35) {
      emission -= 1 / 35
      emit()
      upperSim.impulse(0, 0, 0.04, 0.06)
    }
    const splashes: Particle[] = []
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!
      p.vy -= gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.life -= dt
      if (p.y <= waterY || p.life <= 0) {
        if (!p.splash && Math.hypot(p.x, p.z) < sim.radius) {
          sim.impulse(p.x, p.z, -0.07, 0.065)
          // Two secondary ballistic droplets carry each impact above the pool.
          for (let j = 0; j < 2; j++) {
            const angle = tick * 1.7 + j * Math.PI
            splashes.push({ x: p.x, y: waterY + 0.018, z: p.z, vx: Math.cos(angle) * 0.22, vy: 0.55 + j * 0.12, vz: Math.sin(angle) * 0.22, life: 0.35, splash: true })
          }
        }
        particles.splice(i, 1)
      }
    }
    particles.push(...splashes.slice(0, Math.max(0, maxParticles - particles.length)))
    sim.step()
    upperSim.step()
  }

  function draw() {
    for (let i = 0; i < sim.heights.length; i++) positions[i * 3 + 1] = waterY + sim.heights[i]!
    geometry.attributes.position!.needsUpdate = true
    geometry.computeVertexNormals()
    for (let i = 0; i < upperSim.heights.length; i++) upperPositions[i * 3 + 1] = 1.81 + upperSim.heights[i]!
    upperGeometry.attributes.position!.needsUpdate = true
    upperGeometry.computeVertexNormals()
    droplets.count = particles.length
    particles.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z)
      const radius = p.splash ? 0.013 : 0.022
      velocity.set(p.vx, p.vy, p.vz)
      // Stretch along motion so a dense jet reads as flowing water between drops.
      dummy.scale.set(radius, p.splash ? radius : Math.max(radius * 1.3, velocity.length() / 35 * 0.58), radius)
      dummy.quaternion.setFromUnitVectors(up, velocity.normalize())
      dummy.updateMatrix()
      droplets.setMatrixAt(i, dummy.matrix)
    })
    droplets.instanceMatrix.needsUpdate = true
  }

  return {
    group,
    update(timeSeconds: number) {
      if (!Number.isFinite(timeSeconds)) return
      if (previous === undefined || timeSeconds < previous || timeSeconds - previous > 1) {
        sim.reset()
        upperSim.reset()
        particles.length = 0
        accumulator = 0
        emission = 0
        previous = timeSeconds
      }
      accumulator += Math.min(0.1, timeSeconds - previous)
      previous = timeSeconds
      let substeps = 0
      while (accumulator >= sim.timestep && substeps < 6) {
        step()
        accumulator -= sim.timestep
        substeps++
      }
      draw()
    },
    dispose() {
      droplets.dispose()
      geometry.dispose()
      upperGeometry.dispose()
      material.dispose()
      dropletGeometry.dispose()
      dropletMaterial.dispose()
      particles.length = 0
      group.clear()
    },
  }
}
