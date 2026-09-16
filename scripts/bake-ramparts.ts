/**
 * Run once: `pnpm exec jiti scripts/bake-ramparts.ts`
 *
 * One-off migration that turned the rampart patrol gallery, its two stair
 * flights and its rails from generated geometry into authored placements in
 * `shared/data/courtyard-structure.json`, so the world editor can move them.
 *
 * It is kept in the repo so the derivation stays auditable: the constants below
 * are verbatim the old `RAMPART_WALKWAYS` / `RAMPART_STAIRS` / `RAMPART_RAILS`
 * definitions that used to live in `shared/utils/ramparts.ts`, and the output is
 * normalised exactly like `server/api/editor/save.post.ts` writes it (round3 on
 * coordinates and scales, rotation normalised into `[0, 2π)`). Re-running it
 * would append a duplicate set, so don't.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COURTYARD_ASSETS } from '../shared/utils/courtyard'
import type { HubPropPlacement } from '../shared/utils/props'

/* ---- the old generated layout, copied verbatim from ramparts.ts ---------- */

const RAMPART_WALKWAYS = { min: 35.25, max: 108.75, width: 4.5, height: 6, railHeight: 1.1, railThickness: 0.18 } as const
const RAMPART_STAIRS = [40, 104].map(x => ({ x, zStart: 90, zEnd: 106.5, width: 3, height: 6, steps: 36 }))
const { min, max, width, height, railThickness } = RAMPART_WALKWAYS
const outerMin = min - width / 2
const outerMax = max + width / 2
const innerMin = min + width / 2
const innerMax = max - width / 2
const RAMPART_RAILS: { x: number, z: number, width: number, depth: number, bottom: number, height: number }[] = []
function horizontal(start: number, end: number, z: number) {
  RAMPART_RAILS.push({ x: (start + end) / 2, z, width: end - start, depth: railThickness, bottom: height, height: RAMPART_WALKWAYS.railHeight })
}
for (const z of [outerMin, outerMax]) horizontal(outerMin, outerMax, z)
horizontal(innerMin, innerMax, innerMin)
let start = innerMin
for (const stair of RAMPART_STAIRS) {
  horizontal(start, stair.x - stair.width / 2, innerMax)
  start = stair.x + stair.width / 2
}
horizontal(start, innerMax, innerMax)
for (const x of [outerMin, outerMax]) RAMPART_RAILS.push({ x, z: (min + max) / 2, width: railThickness, depth: outerMax - outerMin, bottom: height, height: RAMPART_WALKWAYS.railHeight })
for (const x of [innerMin, innerMax]) RAMPART_RAILS.push({ x, z: (min + max) / 2, width: railThickness, depth: innerMax - innerMin, bottom: height, height: RAMPART_WALKWAYS.railHeight })

/* ---- translate it into placements ---------------------------------------- */

const QUARTER = Math.PI / 2
const placements: HubPropPlacement[] = []

// Four gallery decks, one per wall side. The piece is 4 × 4.5 at scale 1, so a
// 78-long run stretches local x by 19.5; the sides carry the same piece rotated
// a quarter turn. `z` is the walking surface.
const gallery = COURTYARD_ASSETS.Courtyard_Gallery
const deckLength = outerMax - outerMin
const centre = (min + max) / 2
for (const [x, y, rot] of [
  [centre, min, 0], [centre, max, 0], [min, centre, QUARTER], [max, centre, QUARTER],
] as const) {
  placements.push({ kind: 'Courtyard_Gallery', x, y, rot, scale: 1, z: height, s3: [deckLength / gallery.width, 1, width / gallery.depth] })
}

// Two stair flights. The piece rises along its local +depth axis, so rot 0
// climbs toward +y (the south wall); its base sits on the ground.
for (const stair of RAMPART_STAIRS) {
  placements.push({ kind: 'Courtyard_Stairs', x: stair.x, y: (stair.zStart + stair.zEnd) / 2, rot: 0, scale: 1 })
}

// One rail per generated segment: `width`/`depth` told them apart before, now
// the long axis is always local x and a quarter turn stands it along world y.
const rail = COURTYARD_ASSETS.Courtyard_Rail
for (const segment of RAMPART_RAILS) {
  const along = Math.max(segment.width, segment.depth)
  placements.push({
    kind: 'Courtyard_Rail',
    x: segment.x,
    y: segment.z,
    rot: segment.depth > segment.width ? QUARTER : 0,
    scale: 1,
    z: segment.bottom,
    s3: [along / rail.width, 1, 1],
  })
}

/* ---- append, normalised the way the editor's save route writes ----------- */

const TWO_PI = Math.PI * 2
const round3 = (n: number) => Math.round(n * 1000) / 1000
const normPiece = (p: HubPropPlacement) => ({
  kind: p.kind,
  x: round3(p.x),
  y: round3(p.y),
  rot: round3(((p.rot % TWO_PI) + TWO_PI) % TWO_PI),
  scale: round3(p.scale),
  ...(p.z != null ? { z: round3(p.z) } : {}),
  ...(p.s3 ? { s3: p.s3.map(round3) as [number, number, number] } : {}),
})

const file = fileURLToPath(new URL('../shared/data/courtyard-structure.json', import.meta.url))
const existing = JSON.parse(await readFile(file, 'utf8')) as HubPropPlacement[]
const baked = [...existing.filter(p => !p.kind.startsWith('Courtyard_Gallery') && p.kind !== 'Courtyard_Stairs' && p.kind !== 'Courtyard_Rail'), ...placements.map(normPiece)]
await writeFile(file, `${JSON.stringify(baked, null, 2)}\n`)
console.log(`Wrote ${placements.length} rampart placements (${baked.length} pieces total).`)
