/** Local visual flow only. The eight outlets follow the low points of the stone lily rim. */
export const FOUNTAIN_FLOW = {
  gravity: 9.81,
  outlets: 8,
  lipRadius: 0.701,
  lipHeight: 1.982,
  upperRadius: 0.654,
  upperHeight: 1.98,
  dropsPerSecond: 24,
} as const

/** A parcel retains its discharge and momentum after leaving the rim. */
export function sampleFountainFlow(outlet: number, emittedAt: number, age: number) {
  const angle = Math.PI / 8 + outlet * Math.PI / 4
  const pressure = 1 + 0.13 * Math.sin(emittedAt * 2.1 + outlet * 1.73)
    + 0.045 * Math.sin(emittedAt * 6.7 + outlet * 2.31)
  // Enough outward momentum to clear the lily's flared rim and land in the
  // basin rather than run down the bowl.
  const horizontal = 0.52 * Math.sqrt(pressure)
  const vertical = -0.08
  const initialSpeed = Math.hypot(horizontal, vertical)
  const vy = vertical - FOUNTAIN_FLOW.gravity * age
  const speed = Math.hypot(horizontal, vy)
  const flow = Math.PI * 0.044 * 0.018 * initialSpeed * pressure
  const radius = Math.sqrt(flow / (Math.PI * speed))
  const r = FOUNTAIN_FLOW.lipRadius + horizontal * age
  return {
    x: Math.cos(angle) * r,
    y: FOUNTAIN_FLOW.lipHeight + vertical * age - 0.5 * FOUNTAIN_FLOW.gravity * age * age,
    z: Math.sin(angle) * r,
    vx: Math.cos(angle) * horizontal,
    vy,
    vz: Math.sin(angle) * horizontal,
    speed,
    radius,
    flow,
    // Surface tension gathers each flattened spill into a jet before it breaks.
    aspect: 1 + 1.45 * Math.exp(-age * 14),
    breakupAge: 0.285 + 0.025 * Math.sin(emittedAt * 2.8 + outlet * 1.23),
  }
}

/** Fall time from the rim to a surface at `surfaceHeight` (ballistic, no drag). */
export function fountainFallAge(surfaceHeight: number) {
  const drop = FOUNTAIN_FLOW.lipHeight - surfaceHeight
  const vertical = -0.08
  return (vertical + Math.sqrt(vertical * vertical + 2 * FOUNTAIN_FLOW.gravity * drop)) / FOUNTAIN_FLOW.gravity
}
