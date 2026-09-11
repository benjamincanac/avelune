import {
  BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedMesh,
  Mesh, MeshPhysicalMaterial, Object3D, SphereGeometry, Vector3,
} from 'three'
import { createFountainInteractions, createFountainSimulation } from './fountainSimulation'
import { FOUNTAIN } from '../../shared/utils/courtyard'
import type { FountainBodySample } from './fountainSimulation'
import { createFountainSurface } from './fountainSurface'
import { FOUNTAIN_FLOW, sampleFountainFlow } from './fountainFlow'

export type FountainInteractor = FountainBodySample

/** Cosmetic water physics, independent of authoritative player movement. */
export function createFountainWater() {
  const group = new Group()
  group.name = 'Simulated fountain water'
  const sim = createFountainSimulation(96, FOUNTAIN.waterRadius, FOUNTAIN.pedestalRadius)
  const upperSim = createFountainSimulation(32, FOUNTAIN_FLOW.upperRadius, 0.13)
  const waterY = FOUNTAIN.waterHeight
  const interactions = createFountainInteractions(sim, waterY, FOUNTAIN.floorHeight)
  const basin = createFountainSurface(sim, waterY)
  const upperBasin = createFountainSurface(upperSim, FOUNTAIN_FLOW.upperHeight)
  group.add(basin.mesh, upperBasin.mesh)
  if (basin.caustics) group.add(basin.caustics)

  const dropletGeometry = new SphereGeometry(1, 6, 4)
  const dropletMaterial = new MeshPhysicalMaterial({
    color: '#c4eeeb', roughness: 0.10, metalness: 0, ior: 1.333,
    envMapIntensity: 1.5, transparent: true, opacity: 0.84, depthWrite: false,
  })
  const maxParticles = 480
  const droplets = new InstancedMesh(dropletGeometry, dropletMaterial, maxParticles)
  droplets.instanceMatrix.setUsage(DynamicDrawUsage)
  droplets.frustumCulled = false
  droplets.userData.fountainParticles = true
  group.add(droplets)
  const dummy = new Object3D()
  const up = new Vector3(0, 1, 0)
  const velocity = new Vector3()
  type Particle = { x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, splash: boolean, radius: number }
  const particles: Particle[] = []
  let previous: number | undefined
  let accumulator = 0
  const emission = new Float64Array(FOUNTAIN_FLOW.outlets)
  let simulationTime = 0
  let tick = 0
  const gravity = FOUNTAIN_FLOW.gravity
  const jetCount = FOUNTAIN_FLOW.outlets
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
  streams.userData.fountainParticles = true
  streams.frustumCulled = false
  group.add(streams)

  function drawStreams() {
    for (let jet = 0; jet < jetCount; jet++) {
      const angle = Math.PI / 8 + jet * Math.PI / 4
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      let breakup = sampleFountainFlow(jet, simulationTime, 0).breakupAge
      for (let i = 0; i < 2; i++) breakup = sampleFountainFlow(jet, simulationTime - breakup, 0).breakupAge
      for (let segment = 0; segment <= streamSegments; segment++) {
        const age = breakup * segment / streamSegments
        const parcel = sampleFountainFlow(jet, simulationTime - age, age)
        const horizontal = Math.hypot(parcel.vx, parcel.vz)
        const neck = 1 - 0.9 * Math.max(0, (segment / streamSegments - 0.85) / 0.15)
        const pulse = 1 + 0.09 * Math.sin((simulationTime - age) * 45 + jet)
        for (let side = 0; side < streamSides; side++) {
          const theta = side * Math.PI * 2 / streamSides
          const radial = Math.cos(theta)
          const tangent = Math.sin(theta)
          const nr = -parcel.vy / parcel.speed
          const ny = horizontal / parcel.speed
          const thin = parcel.radius / Math.sqrt(parcel.aspect) * neck * pulse
          const wide = parcel.radius * Math.sqrt(parcel.aspect) * neck * pulse
          const i = ((jet * (streamSegments + 1) + segment) * streamSides + side) * 3
          streamPositions[i] = parcel.x + c * nr * radial * thin - s * tangent * wide
          streamPositions[i + 1] = parcel.y + ny * radial * thin
          streamPositions[i + 2] = parcel.z + s * nr * radial * thin + c * tangent * wide
          // Elliptical section normals use the inverse axis lengths.
          const normalLength = Math.hypot(radial / thin, tangent / wide)
          streamNormals[i] = (c * nr * radial / thin - s * tangent / wide) / normalLength
          streamNormals[i + 1] = ny * radial / thin / normalLength
          streamNormals[i + 2] = (s * nr * radial / thin + c * tangent / wide) / normalLength
        }
      }
    }
    streamGeometry.attributes.position!.needsUpdate = true
    streamGeometry.attributes.normal!.needsUpdate = true
  }

  function emit(dt: number) {
    for (let jet = 0; jet < jetCount; jet++) {
      emission[jet]! += dt
      const interval = 1 / FOUNTAIN_FLOW.dropsPerSecond
      if (emission[jet]! < interval) continue
      emission[jet]! -= interval
      if (particles.length >= maxParticles) continue
      let age = sampleFountainFlow(jet, simulationTime, 0).breakupAge
      for (let i = 0; i < 2; i++) age = sampleFountainFlow(jet, simulationTime - age, 0).breakupAge
      // Catch up the fractional emission time so beads stay evenly spaced at any frame rate.
      const parcel = sampleFountainFlow(jet, simulationTime - age - emission[jet]!, age + emission[jet]!)
      particles.push({ x: parcel.x, y: parcel.y, z: parcel.z,
        vx: parcel.vx, vy: parcel.vy, vz: parcel.vz, life: 1, splash: false,
        radius: Math.cbrt(3 * parcel.flow * interval / (4 * Math.PI)) })
    }
  }

  function step() {
    const dt = sim.timestep
    tick++
    simulationTime += dt
    if (tick % 6 === 0) upperSim.impact(Math.cos(simulationTime) * 0.18, Math.sin(simulationTime) * 0.18, 0.04)
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
          sim.impact(p.x, p.z, impactSpeed * (p.splash ? 0.025 : 0.32) * (p.radius / 0.018) ** 3)
          // Two secondary ballistic droplets carry each impact above the pool.
          for (let j = 0; !p.splash && j < 2; j++) {
            const angle = tick * 1.7 + j * Math.PI
            const rebound = Math.min(0.85, impactSpeed * (0.10 + j * 0.025))
            splashes.push({ x: p.x, y: surface + 0.018, z: p.z, vx: p.vx * 0.3 + normal.x * rebound + Math.cos(angle) * 0.24, vy: normal.y * rebound, vz: p.vz * 0.3 + normal.z * rebound + Math.sin(angle) * 0.24, life: 0.4, splash: true, radius: p.radius * 0.48 })
          }
        }
        particles.splice(i, 1)
      }
    }
    particles.push(...splashes.slice(0, Math.max(0, maxParticles - particles.length)))
    emit(dt)
    sim.step()
    upperSim.step()
  }

  function draw() {
    drawStreams()
    basin.update(previous ?? 0)
    upperBasin.update(previous ?? 0)
    let visibleDroplets = 0
    particles.forEach((p) => {
      dummy.position.set(p.x, p.y, p.z)
      const radius = p.radius
      velocity.set(p.vx, p.vy, p.vz)
      // Stretch along motion so a dense jet reads as flowing water between drops.
      const stretch = p.splash ? 1 : 1.45 + 0.25 * Math.sin(p.life * 48)
      dummy.scale.set(radius / Math.sqrt(stretch), radius * stretch, radius / Math.sqrt(stretch))
      dummy.quaternion.setFromUnitVectors(up, velocity.normalize())
      dummy.updateMatrix()
      droplets.setMatrixAt(visibleDroplets++, dummy.matrix)
    })
    droplets.count = visibleDroplets
    droplets.instanceMatrix.needsUpdate = true
  }

  return {
    group,
    update(timeSeconds: number, interactors: readonly FountainInteractor[] = []) {
      if (!Number.isFinite(timeSeconds)) return
      if (previous === undefined || timeSeconds < previous || timeSeconds - previous > 1) {
        sim.reset()
        interactions.reset()
        upperSim.reset()
        particles.length = 0
        accumulator = 0
        for (let i = 0; i < jetCount; i++) emission[i] = i / jetCount / FOUNTAIN_FLOW.dropsPerSecond
        simulationTime = timeSeconds
        previous = timeSeconds
      }
      interactions.update(timeSeconds, interactors, (x, z, strength) => {
        for (let i = 0; i < 12 && particles.length < maxParticles; i++) {
          const angle = i / 12 * Math.PI * 2 + tick * 0.7
          const speed = 0.4 + Math.min(strength, 8) * 0.08
          particles.push({ x, z, y: waterY + 0.02, vx: Math.cos(angle) * speed, vz: Math.sin(angle) * speed,
            vy: 0.7 + (i % 3) * 0.2 + Math.min(strength, 8) * 0.1, life: 0.7, splash: true, radius: 0.013 })
        }
      })
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
      interactions.reset()
      group.clear()
    },
  }
}
