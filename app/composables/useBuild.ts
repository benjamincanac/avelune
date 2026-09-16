import type { Ref } from 'vue'
import type { Surface } from '#shared/types/game'
import { KIT_NAMES } from '#shared/utils/kit'
import { BUILD_ROT_STEP, EDIT_REACH, MAX_PIECES_PER_PLAYER } from '#shared/utils/building'
import { SURFACE } from '#shared/utils/world'

/**
 * The hotbar's state: which tool is armed, how big the brush is, which way the
 * ghost faces.
 *
 * It is deliberately a dumb bag of refs shared by three owners. `Hotbar.vue`
 * renders it, `GameScene` writes to it from the keyboard and the wheel, and
 * `MazeScene` reads it in the render loop to aim, colour the ghost and send the
 * verb. Nothing here knows about the socket or the world — the scene holds both
 * and does the sending, the same way it already owns prediction.
 */

export type ToolId = 'raise' | 'lower' | 'flatten' | 'paint' | 'demolish'

export interface Slot {
  /** A terraform tool, or a kit piece's `kind`. */
  id: string
  label: string
  icon: string
  /** Set when this slot places a piece rather than moving ground. */
  kind?: string
}

const TOOL_SLOTS: Slot[] = [
  { id: 'raise', label: 'Raise', icon: 'i-lucide-chevrons-up' },
  { id: 'lower', label: 'Lower', icon: 'i-lucide-chevrons-down' },
  { id: 'flatten', label: 'Flatten', icon: 'i-lucide-minus' },
  { id: 'paint', label: 'Paint', icon: 'i-lucide-paintbrush' },
  { id: 'demolish', label: 'Demolish', icon: 'i-lucide-hammer' },
]

/** `Kit_WallWindow` reads as "Wall window" on a 9-slot bar. */
function kitLabel(kind: string): string {
  const words = kind.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const KIT_ICONS: Record<string, string> = {
  Kit_Wall: 'i-lucide-rectangle-vertical',
  Kit_WallWindow: 'i-lucide-app-window',
  Kit_WallDoor: 'i-lucide-door-open',
  Kit_Floor: 'i-lucide-square',
  Kit_Roof: 'i-lucide-triangle',
  Kit_RoofCorner: 'i-lucide-triangle-right',
  Kit_Stairs: 'i-lucide-stairs',
  Kit_Fence: 'i-lucide-fence',
  Kit_Gate: 'i-lucide-archive',
  Kit_Torch: 'i-lucide-flame',
  Kit_Path: 'i-lucide-route',
  Kit_Crate: 'i-lucide-box',
}

const KIT_SLOTS: Slot[] = KIT_NAMES.map(kind => ({ id: kind, kind, label: kitLabel(kind), icon: KIT_ICONS[kind] ?? 'i-lucide-box' }))

/** Nine slots a page. The first page is the environment tools, the rest are
 *  the pieces to place. Tab turns the page. */
export interface BuildPage {
  label: string
  slots: Slot[]
}
export const BUILD_PAGES: BuildPage[] = [
  { label: 'Tools', slots: TOOL_SLOTS },
  { label: 'Build 1', slots: KIT_SLOTS.slice(0, 9) },
  { label: 'Build 2', slots: KIT_SLOTS.slice(9) },
]

/** Label per `SURFACE` value. `path` is called paving in the bar because that
 *  is what it lays: real flagstones, not a worn track. */
export const SURFACE_NAMES = ['grass', 'dirt', 'stone', 'sand', 'paving', 'water'] as const
const SURFACE_CYCLE: Surface[] = [SURFACE.dirt, SURFACE.stone, SURFACE.sand, SURFACE.path, SURFACE.grass, SURFACE.water]

export interface UseBuild {
  page: Ref<number>
  /** Index into the current page, or -1 when nothing is armed (the default). */
  slot: Ref<number>
  /** The armed slot, or undefined when nothing is armed. */
  active: ComputedRef<Slot | undefined>
  /** Terraform brush, 1 to 3 tiles across. */
  size: Ref<1 | 2 | 3>
  /** Ghost rotation, in quarter turns of radians. */
  rot: Ref<number>
  /** What `paint` writes. */
  surface: Ref<Surface>
  /** Pieces this player owns in the whole world. The server counts them and
   *  sends the total on `welcome` and on every `place`/`remove` of theirs;
   *  `useWorld` writes it here. */
  pieces: Ref<number>
  /** Whether the crosshair is on something the armed tool can act on. */
  targetOk: Ref<boolean>
  /** Why not, or what is targeted. One short line for the HUD. */
  targetHint: Ref<string>
  /** One-shot: a left click the scene consumes on its next frame. */
  fireQueued: Ref<boolean>
  reach: number
  budget: number
  select: (index: number) => void
  disarm: () => void
  cycleSlot: (delta: number) => void
  turnPage: () => void
  cycleSurface: () => void
  rotate: () => void
  nudgeSize: (delta: number) => void
  fire: () => void
}

let singleton: UseBuild | null = null

export function useBuild(): UseBuild {
  if (singleton) return singleton

  const page = ref(0)
  const slot = ref(-1)
  const size = ref<1 | 2 | 3>(1)
  const rot = ref(0)
  // Paving is what players reach for the tool to do, so a fresh Paint click
  // lays flagstones rather than a patch of dirt nobody asked for.
  const surface = ref<Surface>(SURFACE.path)
  const pieces = ref(0)
  const targetOk = ref(false)
  const targetHint = ref('')
  const fireQueued = ref(false)

  const active = computed(() => BUILD_PAGES[page.value]?.slots[slot.value])

  /** Arm a slot; the same slot again disarms, so nothing stays armed by accident. */
  function select(index: number) {
    if (index < 0 || index >= (BUILD_PAGES[page.value]?.slots.length ?? 0)) return
    slot.value = slot.value === index ? -1 : index
  }

  function disarm() {
    slot.value = -1
  }

  /** The wheel only walks the bar once a slot is armed, so an incidental scroll
   *  while running never picks a tool. */
  function cycleSlot(delta: number) {
    if (slot.value < 0) return
    const length = BUILD_PAGES[page.value]?.slots.length ?? 1
    slot.value = (slot.value + delta % length + length) % length
  }

  function turnPage() {
    page.value = (page.value + 1) % BUILD_PAGES.length
    slot.value = Math.min(slot.value, (BUILD_PAGES[page.value]?.slots.length ?? 1) - 1)
  }

  function cycleSurface() {
    const at = SURFACE_CYCLE.indexOf(surface.value)
    surface.value = SURFACE_CYCLE[(at + 1) % SURFACE_CYCLE.length]!
  }

  function rotate() {
    rot.value = (rot.value + BUILD_ROT_STEP) % (Math.PI * 2)
  }

  function nudgeSize(delta: number) {
    size.value = Math.min(3, Math.max(1, size.value + delta)) as 1 | 2 | 3
  }

  function fire() {
    fireQueued.value = true
  }

  singleton = {
    page,
    slot,
    active,
    size,
    rot,
    surface,
    pieces,
    targetOk,
    targetHint,
    fireQueued,
    reach: EDIT_REACH,
    budget: MAX_PIECES_PER_PLAYER,
    select,
    disarm,
    cycleSlot,
    turnPage,
    cycleSurface,
    rotate,
    nudgeSize,
    fire,
  }
  return singleton
}
