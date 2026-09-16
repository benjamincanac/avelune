import { COURTYARD_NAMES } from './courtyard'
import { KIT_NAMES } from './kit'

/** Placeable templates shared by the editor palette and save validation.
 * Courtyard kinds combine original GLBs with generated furniture templates. */
export interface PropCategory {
  label: string
  names: readonly string[]
}

export const PROP_CATALOG: PropCategory[] = [
  { label: 'Courtyard', names: COURTYARD_NAMES },
  { label: 'Build kit', names: KIT_NAMES },
]

/** Every valid prop kind. Removed legacy kits cannot be saved into the map. */
export const ALL_PROP_KINDS: ReadonlySet<string> = new Set([...COURTYARD_NAMES, ...KIT_NAMES])
