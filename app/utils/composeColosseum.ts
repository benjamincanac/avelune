import type { HubPropPlacement } from '#shared/utils/maze'
import { HUB_LAYOUT } from '#shared/utils/maze'

/**
 * The procedural colosseum composition, as a flat list of kit-piece placements
 * (`{kind, x, y (world Z), z (elevation), rot, scale, s3?}`). This is both the
 * pre-bake visual fallback and the seed the dev editor bakes into
 * `hub-structure.json`; after baking, pieces flow through `plan.props` instead.
 *
 * A gigantic ring colosseum centred on the arena: a low parapet around the sand,
 * a ground-level arcade of arches + columns, three raised seating tiers, an
 * arched upper wall crowned with flags and corner towers, and guardian statues
 * flanking the north door. All from the Ruins + Castle kits.
 */

const TAU = Math.PI * 2
/** Y-rotation so a piece's front (+Z) faces the arena centre (inward). */
const faceIn = (dx: number, dz: number) => Math.atan2(-dx, -dz)

export function composeColosseum(): HubPropPlacement[] {
  const pieces: HubPropPlacement[] = []
  const cx = HUB_LAYOUT.center.x
  const cz = HUB_LAYOUT.center.y

  // emit(kind, worldX, elevation, worldZ, rot, scale?, s3?)
  const emit = (kind: string, x: number, z: number, worldZ: number, rot: number, scale = 1, s3?: [number, number, number]) =>
    pieces.push({ kind, x, y: worldZ, z, rot, scale, s3 })

  /** Place `count` copies of `kind` evenly around a ring of radius `r`, each
   *  facing the arena. `angle0` offsets the ring (to interleave two rings). */
  const ring = (kind: string, r: number, count: number, z: number, scale: number, angle0 = 0) => {
    for (let i = 0; i < count; i++) {
      const a = angle0 + (i / count) * TAU
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      emit(kind, cx + dx * r, z, cz + dz * r, faceIn(dx, dz), scale)
    }
  }

  // Parapet wall around the arena sand.
  ring('Wall_Half', 12.8, 44, 0, 1)

  // Ground arcade: arches, columns on the seams, torches, alternating banners.
  const BAYS = 22
  const half = TAU / BAYS / 2
  ring('Arch_Round', 15.4, BAYS, 0, 1.7)
  ring('Column_Round', 15.4, BAYS, 0, 1.7, half)
  ring('Torch', 14.9, BAYS, 2.4, 1.1, half)
  for (let i = 0; i < BAYS; i += 2) {
    const a = (i / BAYS) * TAU
    emit('Flag_Wall', cx + Math.cos(a) * 15.1, 3, cz + Math.sin(a) * 15.1, faceIn(Math.cos(a), Math.sin(a)), 1.4)
  }

  // Three raised seating tiers: a rake of stairs up to each flat ring of slabs.
  const tiers = [{ r: 17.4, z: 1.4 }, { r: 19.2, z: 2.8 }, { r: 21, z: 4.2 }]
  for (const t of tiers) {
    const n = Math.round(t.r * 2.3)
    ring('Floor_Standard', t.r, n, t.z, 1.1)
    ring('Stairs_2', t.r - 0.9, n, t.z - 0.7, 1)
  }
  ring('Rail_Straight', 21.9, 52, 4.2, 1)

  // Arched upper wall crowned with flags; quartered corner watchtowers behind.
  const UP = 30
  ring('Wall_ArchRound', 22.6, UP, 5.4, 1.4)
  for (let i = 0; i < UP; i += 3) {
    const a = (i / UP) * TAU
    emit('Flag_GothicArch', cx + Math.cos(a) * 22.4, 7.6, cz + Math.sin(a) * 22.4, faceIn(Math.cos(a), Math.sin(a)), 1.2)
  }
  for (let q = 0; q < 4; q++) {
    const a = Math.PI / 4 + q * (Math.PI / 2)
    emit('Castle_Watchtower', cx + Math.cos(a) * 24, 0, cz + Math.sin(a) * 24, faceIn(Math.cos(a), Math.sin(a)), 2.2)
  }

  // Guardian statues flanking the north door.
  const dz = HUB_LAYOUT.door.y + 3.4
  emit('Statue_Stag', cx - 3.4, 0, dz, faceIn(-0.5, -1), 0.8)
  emit('Statue_Fox', cx + 3.4, 0, dz, faceIn(0.5, -1), 0.9)

  return pieces
}
