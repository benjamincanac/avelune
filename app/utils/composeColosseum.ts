import type { HubPropPlacement } from '#shared/utils/maze'
import { HUB_LAYOUT } from '#shared/utils/maze'

/**
 * The procedural colosseum composition, as a flat list of kit-piece placements
 * (`{kind, x, y (world Z), z (elevation), rot, scale, s3?}`). This is both the
 * pre-bake visual fallback and the seed the dev editor bakes into
 * `hub-structure.json`; after baking, pieces flow through `plan.props` instead.
 *
 * A gigantic ring colosseum centred on the arena: a ground-level arcade of
 * arches + columns around the sand, a continuous rake of stepped seating rising
 * behind (and clear of) the arcade, an arched upper wall crowned with flags, and
 * guardian statues flanking the north door. All from the Ruins + Castle kits.
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

  // Ground arcade around the sand: arches, columns on the seams, torches,
  // alternating banners. Sits at r 15, z 0 (the arena boundary is the tile ring).
  const BAYS = 22
  const half = TAU / BAYS / 2
  ring('Arch_Round', 15, BAYS, 0, 1.7)
  ring('Column_Round', 15, BAYS, 0, 1.7, half)
  ring('Torch', 14.6, BAYS, 2.4, 1.1, half)
  for (let i = 0; i < BAYS; i += 2) {
    const a = (i / BAYS) * TAU
    emit('Flag_Wall', cx + Math.cos(a) * 14.9, 3, cz + Math.sin(a) * 14.9, faceIn(Math.cos(a), Math.sin(a)), 1.4)
  }

  // Seating: a continuous rake of stepped stone slabs rising up-and-back BEHIND
  // the arcade (first tier's inner edge clears the r~15.6 columns), each ring one
  // step higher and one step further out so consecutive rings overlap into a rake.
  const TIERS = 6
  const SLAB = 1.25 // uniform scale → ~2.5-unit slab, wider than the 1.15 r-step (overlap)
  let topR = 0
  let topZ = 0
  for (let i = 0; i < TIERS; i++) {
    const r = 17 + i * 1.15
    const z = 1.1 + i * 1.0
    ring('Floor_Standard', r, Math.round(r * 2.5), z, SLAB)
    topR = r
    topZ = z
  }
  // Parapet rail along the top row of seats.
  ring('Rail_Straight', topR + 0.6, Math.round(topR * 2.6), topZ, 1)

  // Arched upper wall crowning the stands, with flags; corner watchtowers behind.
  const wallR = topR + 1.4
  const wallZ = topZ + 1.2
  const UP = 32
  ring('Wall_ArchRound', wallR, UP, wallZ, 1.4)
  for (let i = 0; i < UP; i += 3) {
    const a = (i / UP) * TAU
    emit('Flag_GothicArch', cx + Math.cos(a) * (wallR - 0.2), wallZ + 2.2, cz + Math.sin(a) * (wallR - 0.2), faceIn(Math.cos(a), Math.sin(a)), 1.2)
  }
  for (let q = 0; q < 4; q++) {
    const a = Math.PI / 4 + q * (Math.PI / 2)
    emit('Castle_Watchtower', cx + Math.cos(a) * (wallR + 1.5), 0, cz + Math.sin(a) * (wallR + 1.5), faceIn(Math.cos(a), Math.sin(a)), 2.2)
  }

  // Guardian statues watching the arena from its north rim.
  const dz = 16.4
  emit('Statue_Stag', cx - 3.4, 0, dz, faceIn(-0.5, -1), 0.8)
  emit('Statue_Fox', cx + 3.4, 0, dz, faceIn(0.5, -1), 0.9)

  return pieces
}
