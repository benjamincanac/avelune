import { BoxGeometry, Group, Mesh } from 'three'
import type { BufferGeometry, MeshStandardMaterial } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RAMPART_RAILS, RAMPART_STAIRS, RAMPART_WALKWAYS } from '#shared/utils/ramparts'

/** The shared stair treads and patrol gallery, rendered at their collision heights. */
export function createRampartWalkways(stone: MeshStandardMaterial, trim: MeshStandardMaterial) {
  const parts = new Map<MeshStandardMaterial, BufferGeometry[]>()
  function box(x: number, y: number, z: number, width: number, height: number, depth: number, material = stone, slope = 0) {
    const geometry = new BoxGeometry(width, height, depth).toNonIndexed()
    geometry.rotateX(slope)
    geometry.translate(x, y, z)
    const batch = parts.get(material) ?? []
    batch.push(geometry)
    parts.set(material, batch)
  }
  const w = RAMPART_WALKWAYS
  const center = (w.min + w.max) / 2
  const length = w.max - w.min
  // Four broad decks meet without seams. Open arcades preserve streets below.
  for (const side of [w.min, w.max]) {
    box(center, w.height - 0.25, side, length + w.width, 0.5, w.width, trim)
    box(side, w.height - 0.25, center, w.width, 0.5, length - w.width, trim)
  }
  // Masonry brackets reach back to the curtain wall, leaving the gate avenue open.
  for (let p = w.min + 4; p <= w.max - 4; p += 8) {
    for (const side of [w.min, w.max]) {
      const sign = side === w.min ? -1 : 1
      box(p, 4.9, side + sign * 1.5, 0.6, 1.2, 3.1)
      box(side + sign * 1.5, 4.9, p, 3.1, 1.2, 0.6)
    }
  }
  // These same rail segments block bodies in the authoritative simulation.
  for (const rail of RAMPART_RAILS) {
    box(rail.x, rail.bottom + rail.height / 2, rail.z, rail.width, rail.height, rail.depth)
    box(rail.x, rail.bottom + rail.height, rail.z, rail.width + 0.05, 0.08, rail.depth + 0.05, trim)
  }

  for (const stairs of RAMPART_STAIRS) {
    const run = stairs.zEnd - stairs.zStart
    const tread = run / stairs.steps
    const rise = stairs.height / stairs.steps
    for (let i = 0; i < stairs.steps; i++) {
      const top = (i + 1) * rise
      const z = stairs.zStart + (i + 0.5) * tread
      box(stairs.x, top / 2, z, stairs.width, top, tread)
      box(stairs.x, top - 0.025, z - 0.025, stairs.width + 0.04, 0.05, tread + 0.025, trim)
    }
    const slope = -Math.atan2(stairs.height, run)
    for (const sign of [-1, 1]) {
      const x = stairs.x + sign * stairs.width / 2
      box(x, stairs.height / 2 + w.railHeight / 2, (stairs.zStart + stairs.zEnd) / 2, w.railThickness, w.railHeight, Math.hypot(run, stairs.height), stone, slope)
      for (let i = 0; i <= 6; i++) {
        const t = i / 6
        box(x, stairs.height * t + w.railHeight / 2, stairs.zStart + run * t, 0.28, w.railHeight + 0.1, 0.28, trim)
      }
    }
  }
  const group = new Group()
  group.name = 'rampart-walkways'
  for (const [material, geometries] of parts) {
    const mesh = new Mesh(mergeGeometries(geometries)!, material)
    mesh.castShadow = mesh.receiveShadow = true
    group.add(mesh)
    geometries.forEach(geometry => geometry.dispose())
  }
  return group
}
