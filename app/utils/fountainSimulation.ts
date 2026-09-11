/** A bounded circular shallow-water surface. The mirrored finite-difference
 * stencil reflects waves at the basin; a narrow damped rim absorbs excess energy. */
export function createFountainSimulation(resolution = 64, radius = 1.48, pedestalRadius = 0.34) {
  if (!Number.isInteger(resolution) || resolution < 4 || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(pedestalRadius) || pedestalRadius < 0 || pedestalRadius >= radius) {
    throw new RangeError('A fountain needs at least four cells and a positive annular water surface')
  }
  const length = resolution * resolution
  const heights = new Float32Array(length)
  const velocities = new Float32Array(length)
  const active = new Uint8Array(length)
  const foam = new Float32Array(length)
  const damping = new Float32Array(length)
  const flowX = new Float32Array(length)
  const flowZ = new Float32Array(length)
  const nextFoam = new Float32Array(length)
  const spacing = radius * 2 / (resolution - 1)
  const speed = 1.2
  // CFL bound for the explicit two-dimensional wave equation.
  const timestep = Math.min(1 / 60, spacing / (speed * Math.SQRT2) * 0.8)
  const flowDamping = Math.exp(-2.0 * timestep)
  const foamDecay = Math.exp(-1.8 * timestep)
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const i = z * resolution + x
      const distance = Math.hypot(x * spacing - radius, z * spacing - radius) / radius
      active[i] = distance <= 1 && distance * radius >= pedestalRadius ? 1 : 0
      damping[i] = Math.exp(-(0.7 + Math.max(0, (distance - 0.88) / 0.12) * 5) * timestep)
    }
  }

  function impulse(x: number, z: number, strength = 0.12, spread = 0.10) {
    if (![x, z, strength, spread].every(Number.isFinite) || spread <= 0) return
    const cx = (x + radius) / spacing
    const cz = (z + radius) / spacing
    // A depression displaces water into a surrounding ring. Balance the two
    // kernels locally, including at walls, instead of lifting the entire pool.
    const reach = Math.ceil(spread * 3 / spacing)
    const cells: { i: number, core: number, ring: number }[] = []
    let coreSum = 0
    let ringSum = 0
    for (let iz = Math.max(0, Math.floor(cz) - reach); iz <= Math.min(resolution - 1, Math.ceil(cz) + reach); iz++) {
      for (let ix = Math.max(0, Math.floor(cx) - reach); ix <= Math.min(resolution - 1, Math.ceil(cx) + reach); ix++) {
        const i = iz * resolution + ix
        if (!active[i]) continue
        const distance2 = ((ix - cx) * spacing) ** 2 + ((iz - cz) * spacing) ** 2
        if (distance2 > (spread * 3) ** 2) continue
        const core = Math.exp(-distance2 / (spread * spread))
        const ring = Math.exp(-distance2 / (spread * spread * 4))
        cells.push({ i, core, ring })
        coreSum += core
        ringSum += ring
      }
    }
    if (ringSum === 0) return
    const balance = coreSum / ringSum
    const amplitude = strength / Math.max(0.1, 1 - balance)
    for (const { i, core, ring } of cells) velocities[i]! += amplitude * (core - ring * balance)
  }

  /** Bilinear surface query with the same solid boundary used by the solver. */
  function sampleField(field: Float32Array, x: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0
    const cx = Math.max(0, Math.min(resolution - 1, (x + radius) / spacing))
    const cz = Math.max(0, Math.min(resolution - 1, (z + radius) / spacing))
    const ix = Math.min(resolution - 2, Math.floor(cx))
    const iz = Math.min(resolution - 2, Math.floor(cz))
    const fx = cx - ix
    const fz = cz - iz
    let height = 0
    let weight = 0
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const i = (iz + dz) * resolution + ix + dx
        if (!active[i]) continue
        const w = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz)
        height += field[i]! * w
        weight += w
      }
    }
    return weight > 0 ? height / weight : 0
  }

  function sampleHeight(x: number, z: number) {
    return sampleField(heights, x, z)
  }

  /** World-up normal for lighting and reflected highlights. Solid neighbours
   * mirror the surface height, so the pedestal cannot create artificial cliffs. */
  function sampleNormal(x: number, z: number) {
    const center = sampleHeight(x, z)
    const at = (px: number, pz: number) => {
      const r = Math.hypot(px, pz)
      return r < pedestalRadius || r > radius ? center : sampleHeight(px, pz)
    }
    const nx = (at(x - spacing, z) - at(x + spacing, z)) / (2 * spacing)
    const nz = (at(x, z - spacing) - at(x, z + spacing)) / (2 * spacing)
    const magnitude = Math.hypot(nx, 1, nz)
    return { x: nx / magnitude, y: 1 / magnitude, z: nz / magnitude }
  }

  /** Transfer falling water's vertical momentum and entrained air to the pool. */
  function impact(x: number, z: number, downwardSpeed: number) {
    if (![x, z, downwardSpeed].every(Number.isFinite) || downwardSpeed <= 0) return
    const strength = Math.min(downwardSpeed, 12) * 0.035
    impulse(x, z, -strength, 0.075)
    const reach = Math.ceil(0.16 / spacing)
    const cx = Math.round((x + radius) / spacing)
    const cz = Math.round((z + radius) / spacing)
    for (let iz = Math.max(0, cz - reach); iz <= Math.min(resolution - 1, cz + reach); iz++) {
      for (let ix = Math.max(0, cx - reach); ix <= Math.min(resolution - 1, cx + reach); ix++) {
        const i = iz * resolution + ix
        if (!active[i]) continue
        const distance2 = (ix * spacing - radius - x) ** 2 + (iz * spacing - radius - z) ** 2
        foam[i] = Math.min(1, foam[i]! + strength * 0.28 * Math.exp(-distance2 / 0.012))
      }
    }
  }

  function step() {
    const coefficient = speed * speed * timestep / (spacing * spacing)
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const i = z * resolution + x
        if (!active[i]) continue
        const h = heights[i]!
        const left = x > 0 && active[i - 1] ? heights[i - 1]! : h
        const right = x < resolution - 1 && active[i + 1] ? heights[i + 1]! : h
        const up = z > 0 && active[i - resolution] ? heights[i - resolution]! : h
        const down = z < resolution - 1 && active[i + resolution] ? heights[i + resolution]! : h
        // Horizontal surface flow carries entrained foam away from impacts.
        // Wall-facing components are zero rather than transporting through stone.
        flowX[i] = x > 0 && x < resolution - 1 && active[i - 1] && active[i + 1]
          ? (flowX[i]! - 9.81 * (right - left) / (2 * spacing) * timestep) * flowDamping
          : 0
        flowZ[i] = z > 0 && z < resolution - 1 && active[i - resolution] && active[i + resolution]
          ? (flowZ[i]! - 9.81 * (down - up) / (2 * spacing) * timestep) * flowDamping
          : 0
        velocities[i] = (velocities[i]! + (left + right + up + down - 4 * h) * coefficient) * damping[i]!
      }
    }
    // Integrate only after the complete stencil pass, so no cell reads the
    // next frame of its neighbour and wave propagation stays symmetric.
    let mean = 0
    let count = 0
    for (let i = 0; i < length; i++) {
      if (!active[i]) continue
      heights[i]! += velocities[i]! * timestep
      mean += heights[i]!
      count++
    }
    // The fixed-volume pool cannot gain water from a visual impact impulse.
    mean /= count
    for (let i = 0; i < length; i++) {
      if (active[i]) {
        heights[i]! -= mean
        velocities[i]! -= mean / timestep
        const x = i % resolution
        const z = Math.floor(i / resolution)
        const px = x * spacing - radius
        const pz = z * spacing - radius
        // Semi-Lagrangian transport is bounded even when a strong impact
        // produces a fast local flow; diffusion softly spreads the bubbles.
        const transported = sampleField(foam, px - flowX[i]! * timestep, pz - flowZ[i]! * timestep)
        let surrounding = 0
        let count = 0
        if (x > 0 && active[i - 1]) {
          surrounding += foam[i - 1]!
          count++
        }
        if (x < resolution - 1 && active[i + 1]) {
          surrounding += foam[i + 1]!
          count++
        }
        if (z > 0 && active[i - resolution]) {
          surrounding += foam[i - resolution]!
          count++
        }
        if (z < resolution - 1 && active[i + resolution]) {
          surrounding += foam[i + resolution]!
          count++
        }
        const diffused = count ? surrounding / count : foam[i]!
        nextFoam[i] = Math.max(0, Math.min(1, (transported * 0.96 + diffused * 0.04) * foamDecay))
      }
    }
    foam.set(nextFoam)
  }

  function reset() {
    heights.fill(0)
    velocities.fill(0)
    foam.fill(0)
    nextFoam.fill(0)
    flowX.fill(0)
    flowZ.fill(0)
  }

  return { resolution, radius, pedestalRadius, spacing, timestep, heights, velocities, active, foam, flowX, flowZ, impulse, impact, sampleHeight, sampleNormal, step, reset }
}
