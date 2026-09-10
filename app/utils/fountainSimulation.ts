/** A bounded circular shallow-water surface. The mirrored finite-difference
 * stencil reflects waves at the basin; a narrow damped rim absorbs excess energy. */
export function createFountainSimulation(resolution = 64, radius = 1.48, pedestalRadius = 0.34) {
  const length = resolution * resolution
  const heights = new Float32Array(length)
  const velocities = new Float32Array(length)
  const active = new Uint8Array(length)
  const damping = new Float32Array(length)
  const spacing = radius * 2 / (resolution - 1)
  const speed = 1.2
  // CFL bound for the explicit two-dimensional wave equation.
  const timestep = Math.min(1 / 60, spacing / (speed * Math.SQRT2) * 0.8)
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const i = z * resolution + x
      const distance = Math.hypot(x * spacing - radius, z * spacing - radius) / radius
      active[i] = distance <= 1 && distance * radius >= pedestalRadius ? 1 : 0
      damping[i] = Math.exp(-(0.7 + Math.max(0, (distance - 0.88) / 0.12) * 5) * timestep)
    }
  }

  function impulse(x: number, z: number, strength = 0.12, spread = 0.10) {
    const cx = (x + radius) / spacing
    const cz = (z + radius) / spacing
    const reach = Math.ceil(spread * 2 / spacing)
    for (let iz = Math.max(0, Math.floor(cz) - reach); iz <= Math.min(resolution - 1, Math.ceil(cz) + reach); iz++) {
      for (let ix = Math.max(0, Math.floor(cx) - reach); ix <= Math.min(resolution - 1, Math.ceil(cx) + reach); ix++) {
        const i = iz * resolution + ix
        if (!active[i]) continue
        const distance2 = ((ix - cx) * spacing) ** 2 + ((iz - cz) * spacing) ** 2
        velocities[i]! += strength * Math.exp(-distance2 / (spread * spread))
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
      }
    }
  }

  function reset() {
    heights.fill(0)
    velocities.fill(0)
  }

  return { resolution, radius, spacing, timestep, heights, velocities, active, impulse, step, reset }
}
