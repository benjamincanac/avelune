/** Shared dimensions for the raised inner wall gallery and its access stairs. */
export const RAMPART_WALKWAYS = { min: 36, max: 108, width: 3, height: 6, railHeight: 1.1, railThickness: 0.18 } as const
export const RAMPART_STAIRS = [40, 104].map(x => ({ x, zStart: 90, zEnd: 106.5, width: 3, height: 6, steps: 36 }))
const { min, max, width, height, railHeight, railThickness } = RAMPART_WALKWAYS
const outerMin = min - width / 2
const outerMax = max + width / 2
const innerMin = min + width / 2
const innerMax = max - width / 2
export const RAMPART_RAILS: { x: number, z: number, width: number, depth: number, bottom: number, height: number }[] = []
function horizontal(start: number, end: number, z: number) {
  RAMPART_RAILS.push({ x: (start + end) / 2, z, width: end - start, depth: railThickness, bottom: height, height: railHeight })
}
for (const z of [outerMin, outerMax]) horizontal(outerMin, outerMax, z)
horizontal(innerMin, innerMax, innerMin)
let start = innerMin
for (const stair of RAMPART_STAIRS) {
  horizontal(start, stair.x - stair.width / 2, innerMax)
  start = stair.x + stair.width / 2
}
horizontal(start, innerMax, innerMax)
for (const x of [outerMin, outerMax]) RAMPART_RAILS.push({ x, z: (min + max) / 2, width: railThickness, depth: outerMax - outerMin, bottom: height, height: railHeight })
for (const x of [innerMin, innerMax]) RAMPART_RAILS.push({ x, z: (min + max) / 2, width: railThickness, depth: innerMax - innerMin, bottom: height, height: railHeight })

export function isOnRampart(x: number, z: number) {
  return x >= outerMin && x <= outerMax && z >= outerMin && z <= outerMax
    && (x <= innerMin || x >= innerMax || z <= innerMin || z >= innerMax)
}
export function rampartStairHeight(x: number, z: number): number | null {
  for (const stair of RAMPART_STAIRS) {
    if (Math.abs(x - stair.x) <= stair.width / 2 && z >= stair.zStart && z <= stair.zEnd) {
      return Math.ceil((z - stair.zStart) / (stair.zEnd - stair.zStart) * stair.steps) * stair.height / stair.steps
    }
  }
  return null
}

/** Finite raised solids for camera obstruction, without closing the passage below. */
export function isRampartCameraBlocked(x: number, z: number, elevation: number, radius: number) {
  if (elevation + radius >= height - 0.5 && elevation - radius <= height) {
    for (const dx of [-radius, 0, radius]) {
      for (const dz of [-radius, 0, radius]) {
        if (isOnRampart(x + dx, z + dz)) return true
      }
    }
  }
  for (const rail of RAMPART_RAILS) {
    if (elevation + radius < rail.bottom || elevation - radius > rail.bottom + rail.height) continue
    if (Math.abs(x - rail.x) <= rail.width / 2 + radius && Math.abs(z - rail.z) <= rail.depth / 2 + radius) return true
  }
  for (const stair of RAMPART_STAIRS) {
    if (z + radius < stair.zStart || z - radius > stair.zEnd) continue
    const progress = Math.max(0, Math.min(1, (z - stair.zStart) / (stair.zEnd - stair.zStart)))
    const top = progress * stair.height
    if (elevation + radius < top || elevation - radius > top + railHeight) continue
    if (Math.abs(Math.abs(x - stair.x) - stair.width / 2) <= railThickness / 2 + radius) return true
  }
  return false
}
