/**
 * The player build kit (`public/models/kit/**`): thirteen pieces on a 2-tile grid,
 * origin at the bottom centre of the footprint, front facing -Z. Dimensions
 * mirror `public/models/kit/manifest.json`, which `scripts/build_kit.py` writes;
 * change the script, rebuild, then update this table.
 *
 * `stackable` pieces present a top that other pieces (and feet) can rest on.
 * A placed kit piece's `z` is gameplay elevation, like the rampart kinds.
 */
export const KIT_ASSETS = {
  Kit_Wall: { width: 2, depth: 0.3, height: 2.5, stackable: true },
  Kit_WallWindow: { width: 2, depth: 0.3, height: 2.5, stackable: true },
  Kit_WallDoor: { width: 2, depth: 0.3, height: 2.5, stackable: true },
  Kit_Floor: { width: 2, depth: 2, height: 0.2, stackable: true },
  Kit_Roof: { width: 2, depth: 2, height: 1.2, stackable: false },
  Kit_RoofCorner: { width: 2, depth: 2, height: 1.2, stackable: false },
  Kit_Stairs: { width: 2, depth: 2, height: 2.5, stackable: true },
  Kit_Fence: { width: 2, depth: 0.15, height: 1, stackable: false },
  Kit_Gate: { width: 2, depth: 0.15, height: 1, stackable: false },
  Kit_Torch: { width: 0.4, depth: 0.4, height: 1.6, stackable: false },
  Kit_Path: { width: 2, depth: 2, height: 0.05, stackable: false },
  Kit_Crate: { width: 1, depth: 1, height: 1, stackable: true },
  Kit_Deed: { width: 0.4, depth: 0.4, height: 1.4, stackable: false },
} as const

/**
 * The claim post. Placing one claims the plot around it (`DEED_SIZE` in
 * `building.ts`), so `world.ts` indexes these per chunk and the edit rules read
 * that index. The kind lives here rather than in `building.ts` because
 * `world.ts` needs it too and may not import the rules that sit on top of it.
 */
export const DEED_KIND = 'Kit_Deed'

export type KitKind = keyof typeof KIT_ASSETS
export const KIT_NAMES = Object.keys(KIT_ASSETS) as KitKind[]

/** `Kit_WallWindow` reads as "Wall window" — on the hotbar and in the feed,
 *  which the server words too, so the label belongs to the kit, not the bar. */
export function kitLabel(kind: string): string {
  const words = kind.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
