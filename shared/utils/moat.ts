import { FORTIFICATIONS, isInMoat, isOnGateBridge } from './courtyard'

export const MOAT = { floorHeight: -2.4, waterHeight: -1.3, swimDraft: 0.65, swimSpeed: 1.8, buoyancyFrequency: 8, bridgeUnderside: -0.3, bodyHeight: 1.7 } as const
export const MOAT_STAIRS = { x: 84, width: 3, zStart: 118, zEnd: 124, steps: 12 } as const

export function isOnMoatStairs(x: number, z: number) {
  return Math.abs(x - MOAT_STAIRS.x) <= MOAT_STAIRS.width / 2 && z >= MOAT_STAIRS.zStart && z <= MOAT_STAIRS.zEnd
}

export function moatGroundHeight(x: number, z: number, feet: number) {
  if (isOnMoatStairs(x, z)) {
    const progress = (z - MOAT_STAIRS.zStart) / (MOAT_STAIRS.zEnd - MOAT_STAIRS.zStart)
    return MOAT.floorHeight * (1 - Math.ceil(progress * MOAT_STAIRS.steps) / MOAT_STAIRS.steps)
  }
  if (!isInMoat(x, z)) return 0
  // The deck supports feet approaching from above. Below it, the channel continues.
  if (isOnGateBridge(x, z) && feet >= -0.5) return 0
  return MOAT.floorHeight
}

export function moatWaterDepth(x: number, z: number, feet: number) {
  return isInMoat(x, z) ? Math.max(0, MOAT.waterHeight - feet) : 0
}

/** Side piers match the three arch spans drawn along both sides of the bridge. */
export function hitsMoatObstacle(x: number, z: number, feet: number, radius: number) {
  if (feet >= 0) return false
  if (z >= MOAT_STAIRS.zStart - radius && z <= MOAT_STAIRS.zEnd + radius
    && Math.abs(Math.abs(x - MOAT_STAIRS.x) - (MOAT_STAIRS.width / 2 + 0.15)) < 0.15 + radius) return true
  const f = FORTIFICATIONS
  const side = f.bridgeWidth / 2 - 0.175
  if (Math.abs(Math.abs(x - f.gateX) - side) >= 0.25 + radius) return false
  const span = (f.bridgeEnd - f.bridgeStart) / 3
  for (let i = 0; i <= 3; i++) {
    if (Math.abs(z - (f.bridgeStart + i * span)) < 0.4 + radius) return true
  }
  return false
}
