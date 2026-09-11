import {
  BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedMesh,
  Mesh, MeshPhysicalMaterial, Object3D, SphereGeometry, Vector3,
} from 'three'
import { createFountainSimulation } from './fountainSimulation'
import { createFountainSurface } from './fountainSurface'

/** Cosmetic water physics, independent of authoritative player movement. */
export function createFountainWater() {
  const group = new Group()
  group.name = 'Simulated fountain water'
  const sim = createFountainSimulation()
  const upperSim = createFountainSimulation(24, 0.44, 0)
  const waterY = 0.48
  const basin = createFountainSurface(sim, waterY)
  const upperBasin = createFountainSurface(upperSim, 1.81)
  group.add(basin.mesh, upperBasin.mesh)

  const dropletGeometry = new SphereGeometry(1, 6, 4)
  const dropletMaterial = new MeshPhysicalMaterial({
    color: '#c4eeeb', roughness: 0.10, metalness: 0, ior: 1.333,
    envMapIntensity: 1.5, transparent: true, opacity: 0.84, depthWrite: false,
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
  const jetCount = 12
  const nozzleRadius = 0.43
  const nozzleY = 2.01
  const launchHorizontal = 1
  const launchVertical = 0.45
  const launchSpeed = Math.hypot(launchHorizontal, launchVertical)
  const streamSegments = 28
  const streamSides = 7
  const streamPositions = new Float32Array(jetCount * (streamSegments + 1) * streamSides * 3)
  const streamNormals = new Float32Array(streamPositions.length)
  const streamIndices: number[] = []
  for (let jet = 0; jet < jetCount; jet++) {
    for (let segment = 0; segment < streamSegments; segment++) {
      for (let side = 0; side < streamSides; side++) {
        const base = (jet * (streamSegments + 1) + segment) * streamSides
        const a = base + side
        const b = base + (side + 1) % streamSides
        streamIndices.push(a, b, a + streamSides, b, b + streamSides, a + streamSides)
      }
    }
  }
  const streamGeometry = new BufferGeometry()
  streamGeometry.setAttribute('position', new BufferAttribute(streamPositions, 3).setUsage(DynamicDrawUsage))
  streamGeometry.setAttribute('normal', new BufferAttribute(streamNormals, 3).setUsage(DynamicDrawUsage))
  streamGeometry.setIndex(streamIndices)
  const streamMaterial = new MeshPhysicalMaterial({
    color: '#a1d9da', roughness: 0.075, metalness: 0, ior: 1.333,
    envMapIntensity: 1.5, transparent: true, opacity: 0.76, depthWrite: false,
  })
  const streams = new Mesh(streamGeometry, streamMaterial)
  streams.name = 'Continuous ballistic fountain streams'
  streams.frustumCulled = false
  group.add(streams)

  function drawStreams() {
    for (let jet = 0; jet < jetCount; jet++) {
      const angle = jet * Math.PI * 2 / jetCount
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      let flightTime = (launchVertical + Math.sqrt(launchVertical ** 2 + 2 * gravity * (nozzleY - waterY))) / gravity
      // Two fixed-point queries terminate the tube at the moving basin surface.
      for (let iteration = 0; iteration < 2; iteration++) {
        const r = nozzleRadius + launchHorizontal * flightTime
        const surface = waterY + sim.sampleHeight(c * r, s * r)
        flightTime = (launchVertical + Math.sqrt(launchVertical ** 2 + 2 * gravity * (nozzleY - surface))) / gravity
      }
      for (let segment = 0; segment <= streamSegments; segment++) {
        const t = flightTime * segment / streamSegments
        const r = nozzleRadius + launchHorizontal * t
        const y = nozzleY + launchVertical * t - 0.5 * gravity * t * t
        const vy = launchVertical - gravity * t
        const speed = Math.hypot(launchHorizontal, vy)
        // Mean discharge: gravity narrows the jet while nozzle pulsations
        // travel down it at the ballistic transit time.
        const pulse = Math.sin(((previous ?? 0) % 1000 - t) * 54 + jet * 0.87)
        const radius = 0.028 * Math.sqrt(launchSpeed / speed * (1 + pulse * 0.12))
        for (let side = 0; side < streamSides; side++) {
          const theta = side * Math.PI * 2 / streamSides
          const nx = -c * vy / speed * Math.cos(theta) - s * Math.sin(theta)
          const ny = launchHorizontal / speed * Math.cos(theta)
          const nz = -s * vy / speed * Math.cos(theta) + c * Math.sin(theta)
          const i = ((jet * (streamSegments + 1) + segment) * streamSides + side) * 3
          streamPositions[i] = c * r + nx * radius
          streamPositions[i + 1] = y + ny * radius
          streamPositions[i + 2] = s * r + nz * radius
          streamNormals[i] = nx
          streamNormals[i + 1] = ny
          streamNormals[i + 2] = nz
        }
      }
    }
    streamGeometry.attributes.position!.needsUpdate = true
    streamGeometry.attributes.normal!.needsUpdate = true
  }

  function emit() {
    for (let jet = 0; jet < jetCount; jet++) {
      if (particles.length >= maxParticles) return
      const angle = jet * Math.PI * 2 / jetCount
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      particles.push({ x: c * nozzleRadius, y: nozzleY, z: s * nozzleRadius, vx: c * launchHorizontal, vy: launchVertical, vz: s * launchHorizontal, life: 2, splash: false })
    }
  }

  function step() {
    const dt = sim.timestep
    tick++
    emission += dt
    if (emission >= 1 / 35) {
      emission -= 1 / 35
      emit()
      upperSim.impact(0, 0, 1.8)
    }
    const splashes: Particle[] = []
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!
      // Exact ballistic integration keeps acceleration independent of step size.
      p.x += p.vx * dt
      p.y += p.vy * dt - 0.5 * gravity * dt * dt
      p.z += p.vz * dt
      p.vy -= gravity * dt
      p.life -= dt
      const surface = waterY + sim.sampleHeight(p.x, p.z)
      if ((p.y <= surface && p.vy < 0) || p.life <= 0) {
        if (p.y <= surface && p.vy < 0 && Math.hypot(p.x, p.z) < sim.radius) {
          const normal = sim.sampleNormal(p.x, p.z)
          const impactSpeed = Math.max(0, -(p.vx * normal.x + p.vy * normal.y + p.vz * normal.z))
          sim.impact(p.x, p.z, impactSpeed * (p.splash ? 0.12 : 1))
          // Two secondary ballistic droplets carry each impact above the pool.
          for (let j = 0; !p.splash && j < 2; j++) {
            const angle = tick * 1.7 + j * Math.PI
            const rebound = Math.min(0.85, impactSpeed * (0.10 + j * 0.025))
            splashes.push({ x: p.x, y: surface + 0.018, z: p.z, vx: normal.x * rebound + Math.cos(angle) * 0.24, vy: normal.y * rebound, vz: normal.z * rebound + Math.sin(angle) * 0.24, life: 0.4, splash: true })
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
    drawStreams()
    basin.update(previous ?? 0)
    upperBasin.update(previous ?? 0)
    let visibleDroplets = 0
    particles.forEach((p) => {
      // The continuous core carries the upper flow. Individual drops become
      // visible only where the accelerated lower stream starts to aerate.
      if (!p.splash && p.y > waterY + 0.45) return
      dummy.position.set(p.x, p.y, p.z)
      const radius = p.splash ? 0.013 : 0.015
      velocity.set(p.vx, p.vy, p.vz)
      // Stretch along motion so a dense jet reads as flowing water between drops.
      dummy.scale.set(radius, p.splash ? radius : radius * 2.5, radius)
      dummy.quaternion.setFromUnitVectors(up, velocity.normalize())
      dummy.updateMatrix()
      droplets.setMatrixAt(visibleDroplets++, dummy.matrix)
    })
    droplets.count = visibleDroplets
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
      basin.dispose()
      upperBasin.dispose()
      dropletGeometry.dispose()
      dropletMaterial.dispose()
      streamGeometry.dispose()
      streamMaterial.dispose()
      particles.length = 0
      group.clear()
    },
  }
}
