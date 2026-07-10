import type { AuthoredFloorData, HubPropPlacement, Trap } from '#shared/utils/maze'
import { HUB_FLOOR, HUB_LAYOUT } from '#shared/utils/maze'
import propsSeed from '#shared/data/hub-props.json'
import structureSeed from '#shared/data/hub-structure.json'
import floorsSeed from '#shared/data/floors.json'

/**
 * Shared state for the dev-only world editor.
 *
 * The editor now spans every floor: the colosseum hub (floor 0) plus each
 * hand-authored dungeon floor. One `EditorFloorDoc` per floor is the working
 * copy; a floor switcher moves between them and `save()` writes them all at once
 * (`POST /api/editor/save`).
 *
 * The hub keeps a two-layer placement model so the exploded structure and the
 * free-standing clutter persist to their own files (`hub-structure.json` /
 * `hub-props.json`); dungeon floors are single-layer and persist together to
 * `floors.json`. `top`/`r` collision is never stored — it's derived through
 * `makeProp`, so server collision and client render stay in lockstep.
 *
 * Before the colosseum is baked (`hub-structure.json` empty), `MazeScene` seeds
 * the hub structure layer from its procedural composition via `seedStructure`,
 * so it's immediately editable and the first save IS the bake.
 */
export const EDITOR_REENTER_KEY = 'tempest:editor-reenter'

export type EditorLayer = 'props' | 'structure'
export interface EditorPlacement extends HubPropPlacement {
  /** Hub only: which file this persists to. Absent ⇒ `props`. Floors ignore it. */
  layer?: EditorLayer
}

/** Active editor interaction mode. */
export type EditorTool = 'select' | 'trap' | 'marker'

/** What the inspector is editing. */
export type EditorSelection
  = { type: 'placement', index: number }
    | { type: 'trap', index: number }
    | { type: 'marker', which: 'start' | 'exit' }
    | null

/** One floor's editable working copy. Floor 0 is the hub (size/biome fixed). */
export interface EditorFloorDoc {
  floor: number
  size: number
  biome: number
  start: { x: number, y: number }
  exit: { x: number, y: number }
  traps: Trap[]
  placements: EditorPlacement[]
}

const clonePlacement = (p: EditorPlacement): EditorPlacement => ({
  ...p,
  ...(p.s3 ? { s3: [...p.s3] as [number, number, number] } : {}),
})
const cloneTrap = (t: Trap): Trap => ({ ...t })
const cloneDoc = (d: EditorFloorDoc): EditorFloorDoc => ({
  ...d,
  start: { ...d.start },
  exit: { ...d.exit },
  traps: d.traps.map(cloneTrap),
  placements: d.placements.map(clonePlacement),
})

/** Build the initial per-floor docs from the committed JSON seeds. */
function seedDocs(): EditorFloorDoc[] {
  const hub: EditorFloorDoc = {
    floor: HUB_FLOOR,
    size: HUB_LAYOUT.size,
    biome: -1,
    start: { ...HUB_LAYOUT.start },
    exit: { ...HUB_LAYOUT.exit },
    traps: [],
    placements: [
      ...(propsSeed as HubPropPlacement[]).map(p => ({ ...clonePlacement(p), layer: 'props' as const })),
      ...(structureSeed as HubPropPlacement[]).map(p => ({ ...clonePlacement(p), layer: 'structure' as const })),
    ],
  }
  const floors: EditorFloorDoc[] = (floorsSeed as AuthoredFloorData[]).map(f => ({
    floor: f.floor,
    size: f.size,
    biome: f.biome,
    start: { ...f.start },
    exit: { ...f.exit },
    traps: f.traps.map(cloneTrap),
    placements: f.placements.map(clonePlacement),
  }))
  return [hub, ...floors].sort((a, b) => a.floor - b.floor)
}

interface FloorHistory {
  stack: EditorFloorDoc[]
  index: number
}

export function useEditor() {
  const docs = useState<EditorFloorDoc[]>('editor:docs', seedDocs)
  const currentFloor = useState<number>('editor:currentFloor', () => HUB_FLOOR)

  /** The active floor's working doc (falls back to the hub if the index drifts). */
  const current = computed(() => docs.value.find(d => d.floor === currentFloor.value) ?? docs.value[0]!)

  // The controller reads these as plain refs; back them with the active doc so a
  // floor switch swaps the whole working set without the controller knowing.
  const placements = computed(() => current.value.placements)
  const traps = computed(() => current.value.traps)

  const selection = useState<EditorSelection>('editor:selection', () => null)
  /** Legacy placement-index selection the scene controller/inspector still use. */
  const selected = computed<number | null>({
    get: () => (selection.value?.type === 'placement' ? selection.value.index : null),
    set: (i) => { selection.value = i == null ? null : { type: 'placement', index: i } },
  })

  const tool = useState<EditorTool>('editor:tool', () => 'select')
  const paletteKind = useState<string | null>('editor:paletteKind', () => null)
  const saving = useState('editor:saving', () => false)
  /** Floors with unsaved edits (a save writes every floor, clears the set). */
  const dirtyFloors = useState<Set<number>>('editor:dirtyFloors', () => new Set())
  const dirty = computed(() => dirtyFloors.value.size > 0)
  /** True once the hub structure layer exists (loaded from file, or seeded). */
  const structureReady = useState('editor:structureReady', () => (structureSeed as unknown[]).length > 0)
  /** Bumped on any structural (add/remove/floor-switch) change so the scene rebuilds. */
  const structureVersion = useState('editor:structureVersion', () => 0)

  // Undo/redo: an independent snapshot stack per floor (whole-doc clones).
  const MAX_HISTORY = 60
  const histories = useState<Record<number, FloorHistory>>('editor:histories', () => ({}))
  function history(): FloorHistory {
    return (histories.value[currentFloor.value] ??= { stack: [cloneDoc(current.value)], index: 0 })
  }

  function markDirty() {
    dirtyFloors.value = new Set(dirtyFloors.value).add(currentFloor.value)
  }

  /** Snapshot the active floor as a new undo step (and mark it dirty). */
  function commit() {
    markDirty()
    const h = history()
    h.stack = h.stack.slice(0, h.index + 1)
    h.stack.push(cloneDoc(current.value))
    if (h.stack.length > MAX_HISTORY) h.stack.shift()
    h.index = h.stack.length - 1
  }

  /** Replace the active doc with an undo/redo snapshot. */
  function restore(index: number) {
    const h = history()
    h.index = index
    const snap = cloneDoc(h.stack[index]!)
    const i = docs.value.findIndex(d => d.floor === currentFloor.value)
    docs.value.splice(i, 1, snap)
    if (selection.value?.type === 'placement' && selection.value.index >= snap.placements.length) selection.value = null
    if (selection.value?.type === 'trap' && selection.value.index >= snap.traps.length) selection.value = null
    markDirty()
    structureVersion.value++
  }
  function undo() {
    const h = history()
    if (h.index > 0) restore(h.index - 1)
  }
  function redo() {
    const h = history()
    if (h.index < h.stack.length - 1) restore(h.index + 1)
  }
  const canUndo = () => history().index > 0
  const canRedo = () => {
    const h = history()
    return h.index < h.stack.length - 1
  }

  /** Reset the active floor's undo baseline (after seeding/loading). */
  function resetHistory() {
    histories.value[currentFloor.value] = { stack: [cloneDoc(current.value)], index: 0 }
  }

  /** Switch the active floor; the scene + controller rebuild off `structureVersion`. */
  function switchFloor(floor: number) {
    if (!docs.value.some(d => d.floor === floor)) return
    currentFloor.value = floor
    selection.value = null
    paletteKind.value = null
    if (floor === HUB_FLOOR && tool.value === 'trap') tool.value = 'select'
    structureVersion.value++
  }

  /** Append a new empty dungeon floor (bordered ground, default markers). */
  function createFloor(size = 31, biome = 0): number {
    const floor = Math.max(0, ...docs.value.map(d => d.floor)) + 1
    docs.value.push({
      floor,
      size,
      biome,
      start: { x: 4, y: 4 },
      exit: { x: size - 4, y: size - 4 },
      traps: [],
      placements: [],
    })
    docs.value.sort((a, b) => a.floor - b.floor)
    switchFloor(floor)
    markDirty()
    return floor
  }

  /** Remove the deepest floor (floors stay contiguous; the hub can't be removed). */
  function deleteFloor() {
    const max = Math.max(...docs.value.map(d => d.floor))
    if (max <= HUB_FLOOR) return
    docs.value = docs.value.filter(d => d.floor !== max)
    const { [max]: _dropped, ...rest } = histories.value
    histories.value = rest
    // Force a save (the file must be rewritten without the removed floor).
    const next = new Set(dirtyFloors.value)
    next.add(HUB_FLOOR)
    next.delete(max)
    dirtyFloors.value = next
    switchFloor(Math.max(HUB_FLOOR, max - 1))
  }

  /** Seed the hub structure layer from the scene's procedural composition, once,
   *  before anything is baked. Counts as unsaved and becomes the undo baseline. */
  function seedStructure(pieces: HubPropPlacement[]) {
    if (structureReady.value) return
    structureReady.value = true
    current.value.placements.push(...pieces.map(p => ({ ...clonePlacement(p), layer: 'structure' as const })))
    resetHistory()
    markDirty()
    structureVersion.value++
  }

  async function save() {
    if (saving.value) return
    saving.value = true
    try {
      const strip = ({ layer: _l, ...rest }: EditorPlacement): HubPropPlacement => rest
      const hub = docs.value.find(d => d.floor === HUB_FLOOR)!
      const hubProps = hub.placements.filter(p => (p.layer ?? 'props') === 'props').map(strip)
      const hubStructure = hub.placements.filter(p => p.layer === 'structure').map(strip)
      const floors: AuthoredFloorData[] = docs.value
        .filter(d => d.floor !== HUB_FLOOR)
        .map(d => ({
          version: 1,
          floor: d.floor,
          size: d.size,
          biome: d.biome,
          start: { ...d.start },
          exit: { ...d.exit },
          traps: d.traps.map(cloneTrap),
          placements: d.placements.map(strip),
        }))
      await $fetch('/api/editor/save', { method: 'POST', body: { hubProps, hubStructure, floors } })
      dirtyFloors.value = new Set()
      // All three files are in the module graph; the write reloads the dev
      // server — drop straight back into the editor on the same floor.
      sessionStorage.setItem(EDITOR_REENTER_KEY, String(currentFloor.value))
    }
    finally {
      saving.value = false
    }
  }

  return {
    docs,
    current,
    currentFloor,
    placements,
    traps,
    /** The active floor's spawn/exit markers (the reactive doc objects). */
    getMarkers: () => ({ start: current.value.start, exit: current.value.exit }),
    selection,
    selected,
    tool,
    paletteKind,
    dirty,
    dirtyFloors,
    saving,
    structureReady,
    structureVersion,
    seedStructure,
    switchFloor,
    createFloor,
    deleteFloor,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    save,
  }
}
