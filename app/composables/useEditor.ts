import type { HubPropPlacement } from '#shared/utils/maze'
import { HUB_LAYOUT } from '#shared/utils/maze'
import propsSeed from '#shared/data/courtyard-props.json'
import structureSeed from '#shared/data/courtyard-structure.json'
import oracleSeed from '#shared/data/courtyard-oracle.json'

/**
 * Shared state for the dev-only world editor.
 *
 * There is one courtyard map and one working document:
 * every placement in the arena plus the Oracle's position. `save()` writes it
 * back to the repo's JSON in a single call (`POST /api/editor/save`).
 *
 * Placements keep a two-layer model so the exploded structure and the
 * free-standing clutter persist to their own files (`courtyard-structure.json` /
 * `courtyard-props.json`). `top`/`r` collision is never stored — it's derived through
 * `makeProp`, so server collision and client render stay in lockstep.
 *
 */
export const EDITOR_REENTER_KEY = 'tempest:editor-reenter'

export type EditorLayer = 'props' | 'structure'
export interface EditorPlacement extends HubPropPlacement {
  /** Which file this persists to. Absent ⇒ `props`. */
  layer?: EditorLayer
}

/** Active editor interaction mode. */
export type EditorTool = 'select' | 'marker'

/** A draggable point marker. The arena spawn is a shared constant, so the
 *  Oracle is the only position the editor owns. */
export type MarkerKind = 'oracle'

/** What the inspector is editing. */
export type EditorSelection
  = { type: 'placement', index: number }
    | { type: 'marker', which: MarkerKind }
    | null

/** The arena's editable working copy. */
export interface EditorDoc {
  /** Tile extent — bounds placement and seeds the fly camera. */
  size: number
  /** The Oracle NPC's position (a draggable marker). */
  oracle: { x: number, y: number }
  placements: EditorPlacement[]
}

const clonePlacement = (p: EditorPlacement): EditorPlacement => ({
  ...p,
  ...(p.s3 ? { s3: [...p.s3] as [number, number, number] } : {}),
})
const cloneDoc = (d: EditorDoc): EditorDoc => ({
  ...d,
  oracle: { ...d.oracle },
  placements: d.placements.map(clonePlacement),
})

/** Build the initial working copy from the committed JSON seeds. */
function seedDoc(): EditorDoc {
  return {
    size: HUB_LAYOUT.size,
    oracle: { x: (oracleSeed as [number, number])[0], y: (oracleSeed as [number, number])[1] },
    placements: [
      ...(propsSeed as HubPropPlacement[]).map(p => ({ ...clonePlacement(p), layer: 'props' as const })),
      ...(structureSeed as HubPropPlacement[]).map(p => ({ ...clonePlacement(p), layer: 'structure' as const })),
    ],
  }
}

interface History {
  stack: EditorDoc[]
  index: number
  /** The stack index that matches the last save — the doc is dirty (unsaved)
   *  exactly when `index !== savedIndex`, so undoing back to it clears dirty. */
  savedIndex: number
}

export function useEditor() {
  const current = useState<EditorDoc>('editor:doc', seedDoc)

  // The controller reads this as a plain ref; back it with the doc so the whole
  // working set can be swapped (undo/redo) without the controller knowing.
  const placements = computed(() => current.value.placements)

  const selection = useState<EditorSelection>('editor:selection', () => null)
  /** Legacy placement-index selection the scene controller/inspector still use. */
  const selected = computed<number | null>({
    get: () => (selection.value?.type === 'placement' ? selection.value.index : null),
    set: (i) => { selection.value = i == null ? null : { type: 'placement', index: i } },
  })

  const tool = useState<EditorTool>('editor:tool', () => 'select')
  const paletteKind = useState<string | null>('editor:paletteKind', () => null)
  const saving = useState('editor:saving', () => false)
  /** True once the structure layer exists (loaded from file, or seeded). */
  const structureReady = useState('editor:structureReady', () => (structureSeed as unknown[]).length > 0)
  /** Bumped on structural changes (undo/redo, seeding) so the scene rebuilds. */
  const structureVersion = useState('editor:structureVersion', () => 0)

  // Undo/redo: a snapshot stack of whole-doc clones.
  const MAX_HISTORY = 60
  const history = useState<History>('editor:history', () => ({ stack: [cloneDoc(current.value)], index: 0, savedIndex: 0 }))
  const dirty = computed(() => history.value.index !== history.value.savedIndex)

  /** Snapshot the doc as a new undo step (and mark it dirty). */
  function commit() {
    const h = history.value
    h.stack = h.stack.slice(0, h.index + 1)
    h.stack.push(cloneDoc(current.value))
    if (h.stack.length > MAX_HISTORY) {
      h.stack.shift()
      h.savedIndex -= 1 // the baseline shifted down with the dropped entry
    }
    h.index = h.stack.length - 1
  }

  /** Replace the doc with an undo/redo snapshot. */
  function restore(index: number) {
    const h = history.value
    h.index = index
    const snap = cloneDoc(h.stack[index]!)
    current.value = snap
    if (selection.value?.type === 'placement' && selection.value.index >= snap.placements.length) selection.value = null
    structureVersion.value++
  }
  function undo() {
    const h = history.value
    if (h.index > 0) restore(h.index - 1)
  }
  function redo() {
    const h = history.value
    if (h.index < h.stack.length - 1) restore(h.index + 1)
  }
  const canUndo = () => history.value.index > 0
  const canRedo = () => history.value.index < history.value.stack.length - 1

  /** Seed the structure layer from the scene's procedural composition, once,
   *  before anything is baked. Becomes the undo baseline, and counts as unsaved
   *  (a negative saved index can never be reached) so the first save is the bake. */
  function seedStructure(pieces: HubPropPlacement[]) {
    if (structureReady.value) return
    structureReady.value = true
    current.value.placements.push(...pieces.map(p => ({ ...clonePlacement(p), layer: 'structure' as const })))
    history.value = { stack: [cloneDoc(current.value)], index: 0, savedIndex: -1 }
    structureVersion.value++
  }

  async function save() {
    if (saving.value) return
    saving.value = true
    try {
      const strip = ({ layer: _l, ...rest }: EditorPlacement): HubPropPlacement => rest
      const doc = current.value
      const hubProps = doc.placements.filter(p => (p.layer ?? 'props') === 'props').map(strip)
      const hubStructure = doc.placements.filter(p => p.layer === 'structure').map(strip)
      const oracle: [number, number] = [doc.oracle.x, doc.oracle.y]
      await $fetch('/api/editor/save', { method: 'POST', body: { hubProps, hubStructure, oracle } })
      // Disk now matches the working copy: the current index is the new baseline.
      history.value.savedIndex = history.value.index
      // Every file is in the module graph; the write reloads the dev server —
      // drop straight back into the editor.
      sessionStorage.setItem(EDITOR_REENTER_KEY, '1')
    }
    finally {
      saving.value = false
    }
  }

  return {
    current,
    placements,
    /** The draggable markers (the reactive doc objects). */
    getMarkers: (): Partial<Record<MarkerKind, { x: number, y: number }>> => ({ oracle: current.value.oracle }),
    selection,
    selected,
    tool,
    paletteKind,
    dirty,
    saving,
    structureReady,
    structureVersion,
    seedStructure,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    save,
  }
}
