import type { HubPropPlacement } from '#shared/utils/maze'
import propsSeed from '#shared/data/hub-props.json'
import structureSeed from '#shared/data/hub-structure.json'

/**
 * Shared state for the dev-only hub editor.
 *
 * The working copy `placements` merges two persisted layers so the editor can
 * treat every object uniformly (select/move/rotate/scale/delete):
 *  - `props`     — free-standing gameplay clutter (`hub-props.json`): trees,
 *                  rocks, crates. Ground-placed, collision from `SOLID_PROPS`.
 *  - `structure` — the exploded village (`hub-structure.json`): every wall,
 *                  roof, corner, statue, fence. Carries `z` (elevation) and
 *                  optional `s3` (per-axis scale).
 *
 * `save()` splits the layers back to their files (both are committed inputs to
 * server collision + client render, so a save triggers a full dev reload — we
 * flag `sessionStorage` to drop straight back into the editor).
 *
 * Before the village is baked (`hub-structure.json` empty), `MazeScene` seeds
 * the structure layer from its procedural composition via `seedStructure`, so
 * the village is immediately editable and the first save IS the bake.
 */
export const EDITOR_REENTER_KEY = 'mugen:editor-reenter'

export type EditorLayer = 'props' | 'structure'
export interface EditorPlacement extends HubPropPlacement {
  /** Which file this is persisted to. Absent is treated as `props`. */
  layer?: EditorLayer
}

const seed = (rows: unknown, layer: EditorLayer): EditorPlacement[] =>
  (rows as HubPropPlacement[]).map(p => ({ ...structuredClone(p), layer }))

export function useEditor() {
  const placements = useState<EditorPlacement[]>('editor:placements', () => [
    ...seed(propsSeed, 'props'),
    ...seed(structureSeed, 'structure'),
  ])
  /** Index into `placements` of the selected object, or null. */
  const selected = useState<number | null>('editor:selected', () => null)
  /** The palette kind armed for stamping, or null (select/move mode). */
  const paletteKind = useState<string | null>('editor:paletteKind', () => null)
  const dirty = useState('editor:dirty', () => false)
  const saving = useState('editor:saving', () => false)
  /** True once the structure layer exists (loaded from file, or seeded). */
  const structureReady = useState('editor:structureReady', () => (structureSeed as unknown[]).length > 0)

  // Undo/redo: a stack of full-placement snapshots + a cursor. Each committed
  // edit truncates the redo tail and pushes the new state; undo/redo restore a
  // snapshot. Placements are flat (primitives + an `s3` array), so a shallow
  // per-row copy is a sufficient deep clone.
  const MAX_HISTORY = 60
  const clone = (rows: EditorPlacement[]): EditorPlacement[] =>
    rows.map(p => ({ ...p, ...(p.s3 ? { s3: [...p.s3] as [number, number, number] } : {}) }))
  const history = useState<EditorPlacement[][]>('editor:history', () => [clone(placements.value)])
  const histIndex = useState('editor:histIndex', () => 0)

  /** Snapshot the current placements as a new undo step (and mark dirty). */
  function commit() {
    dirty.value = true
    history.value = history.value.slice(0, histIndex.value + 1)
    history.value.push(clone(placements.value))
    if (history.value.length > MAX_HISTORY) history.value.shift()
    histIndex.value = history.value.length - 1
  }

  function restore(index: number) {
    histIndex.value = index
    placements.value = clone(history.value[index]!)
    // Keep the selection if it still points at an existing piece (transform
    // undos); drop it only when the item is gone (place/delete undos).
    if (selected.value != null && selected.value >= placements.value.length) selected.value = null
    dirty.value = true
  }

  function undo() {
    if (histIndex.value > 0) restore(histIndex.value - 1)
  }
  function redo() {
    if (histIndex.value < history.value.length - 1) restore(histIndex.value + 1)
  }
  /** Reset the undo baseline to the current placements (after seeding/loading). */
  function resetHistory() {
    history.value = [clone(placements.value)]
    histIndex.value = 0
  }

  /** Populate the structure layer from the scene's procedural village, once,
   *  before anything is baked. The seeded pieces count as unsaved (dirty), and
   *  become the undo baseline so undo can't strip the village. */
  function seedStructure(pieces: HubPropPlacement[]) {
    if (structureReady.value) return
    structureReady.value = true
    placements.value.push(...pieces.map(p => ({ ...p, layer: 'structure' as const })))
    resetHistory()
    dirty.value = true
  }

  async function save() {
    if (saving.value) return
    saving.value = true
    try {
      const rows = (layer: EditorLayer) => placements.value
        .filter(p => (p.layer ?? 'props') === layer)
        .map(({ layer: _l, ...rest }) => rest)
      await $fetch('/api/editor/hub-props', { method: 'POST', body: rows('props') })
      await $fetch('/api/editor/hub-structure', { method: 'POST', body: rows('structure') })
      dirty.value = false
      // Both files are in the module graph; the write reloads the dev server.
      sessionStorage.setItem(EDITOR_REENTER_KEY, '1')
    }
    finally {
      saving.value = false
    }
  }

  return { placements, selected, paletteKind, dirty, saving, structureReady, seedStructure, commit, undo, redo, canUndo: () => histIndex.value > 0, canRedo: () => histIndex.value < history.value.length - 1, save }
}
