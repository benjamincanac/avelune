/** Fountain dimensions in model units, before the authored placement scale. */
export const FOUNTAIN = {
  outerRadius: 3.8,
  waterRadius: 3.05,
  floorHeight: 0.12,
  waterHeight: 0.48,
  pedestalRadius: 0.56,
  pedestalHeight: 2.7,
  innerStepRadius: 2.85,
  innerStepHeight: 0.30,
  rimRadius: 3.25,
  rimHeight: 0.54,
  middleStepRadius: 3.5,
  middleStepHeight: 0.36,
  outerStepHeight: 0.18,
} as const

/** Dimensions at scale 1, shared by the art templates and collision. */
export const COURTYARD_ASSETS = {
  Courtyard_BridgeRail: { width: 0.35, depth: 12, height: 0.65 },
  Courtyard_Rampart: { width: 4, depth: 2, height: 6 },
  Courtyard_Bastion: { width: 6, depth: 6, height: 9 },
  Courtyard_Inn: { width: 8, depth: 5, height: 5.2 },
  Courtyard_Shop: { width: 6, depth: 4, height: 3.8 },
  Courtyard_Tower: { width: 4, depth: 4, height: 9 },
  Courtyard_Wall: { width: 4, depth: 0.8, height: 2.6 },
  Courtyard_Planter: { width: 3, depth: 1.4, height: 0.55 },
  Courtyard_Bench: { width: 2.4, depth: 0.8, height: 0.65 },
  Courtyard_Stall: { width: 3.2, depth: 1.8, height: 1.1 },
  Courtyard_Fountain: { radius: FOUNTAIN.outerRadius, height: FOUNTAIN.pedestalHeight },
  Courtyard_Tree: { radius: 0.38, height: 6.5 },
  Courtyard_Lantern: { radius: 0.16, height: 3.5 },
} as const

export type CourtyardKind = keyof typeof COURTYARD_ASSETS
export const COURTYARD_NAMES = Object.keys(COURTYARD_ASSETS) as CourtyardKind[]

/** A walled town, arranged around a fountain square and connected districts. */
export const COURTYARD = {
  min: 32,
  max: 112,
  arena: { x: 72, y: 72, radius: 9 },
  fountain: { x: 72, y: 72 },
}

/** Authored garden beds shared by landscape materials and planted decoration. */
export const TOWN_GARDENS = [
  { x: 48, z: 85, rx: 7, rz: 1.8 },
  { x: 96, z: 85, rx: 7, rz: 1.8 },
  { x: 96, z: 68.5, rx: 6, rz: 1 },
  { x: 96, z: 75.5, rx: 6, rz: 1 },
  { x: 45, z: 39.5, rx: 4, rz: 1.2 },
  { x: 99, z: 39.5, rx: 4, rz: 1.2 },
] as const

/** Opposing facades define three cross streets and a continuous civic avenue. */
export const TOWN_STREETS = [
  { x1: 72, z1: 134, x2: 72, z2: 82, width: 7 },
  { x1: 72, z1: 62, x2: 72, z2: 47, width: 7 },
  { x1: 36, z1: 50, x2: 108, z2: 50, width: 6 },
  { x1: 36, z1: 72, x2: 108, z2: 72, width: 6 },
  { x1: 36, z1: 96, x2: 108, z2: 96, width: 6 },
  { x1: 36, z1: 60, x2: 108, z2: 60, width: 2 },
  { x1: 36, z1: 85, x2: 40, z2: 85, width: 3 },
  { x1: 55, z1: 85, x2: 89, z2: 85, width: 3 },
  { x1: 104, z1: 85, x2: 108, z2: 85, width: 3 },
  { x1: 36, z1: 36, x2: 108, z2: 36, width: 3 },
  { x1: 36, z1: 108, x2: 108, z2: 108, width: 3 },
  { x1: 36, z1: 36, x2: 36, z2: 108, width: 3 },
  { x1: 108, z1: 36, x2: 108, z2: 108, width: 3 },
  { x1: 40, z1: 50, x2: 40, z2: 90, width: 3 },
  { x1: 104, z1: 50, x2: 104, z2: 90, width: 3 },
] as const

export const TOWN_DISTRICTS = [
  { name: 'Fountain Square', x: 72, z: 72 },
  { name: 'Market Lane', x: 50, z: 72 },
  { name: 'Willow Gardens', x: 96, z: 72 },
  { name: 'High Court', x: 72, z: 50 },
  { name: 'South Gate', x: 72, z: 108 },
] as const

/** Shared footprint of the walls, moat, bridge and exterior approach. */
export const FORTIFICATIONS = {
  wallMin: 32,
  wallMax: 112,
  gateX: 72,
  gateZ: 112,
  gateWidth: 8,
  wallThickness: 2,
  wallHeight: 6,
  moatInnerMin: 29,
  moatInnerMax: 115,
  moatOuterMin: 23,
  moatOuterMax: 121,
  bridgeWidth: 8,
  bridgeStart: 111,
  bridgeEnd: 123,
  exteriorMin: 4,
  exteriorMax: 140,
  spawn: { x: 72, y: 129 },
  oracle: { x: 79, y: 125 },
} as const

export function isInMoat(x: number, z: number): boolean {
  const f = FORTIFICATIONS
  return x >= f.moatOuterMin && x < f.moatOuterMax && z >= f.moatOuterMin && z < f.moatOuterMax
    && !(x >= f.moatInnerMin && x < f.moatInnerMax && z >= f.moatInnerMin && z < f.moatInnerMax)
}

export function isOnGateBridge(x: number, z: number): boolean {
  const f = FORTIFICATIONS
  return Math.abs(x - f.gateX) < f.bridgeWidth / 2 && z >= f.bridgeStart && z <= f.bridgeEnd
}
