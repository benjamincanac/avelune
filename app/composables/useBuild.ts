import type { Ref } from 'vue'
import type { Surface } from '#shared/types/game'
import { KIT_NAMES, kitLabel } from '#shared/utils/kit'
import { BUILD_ROT_STEP, DEED_LIMIT, EDIT_REACH, MAX_PIECES_PER_PLAYER } from '#shared/utils/building'
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

/**
 * Camera pitch limits, in radians below the horizon.
 *
 * Walking, the view stays in a comfortable band. With a tool armed it has to
 * reach the tile you are standing on — and the eight around it — so the floor
 * drops to `PITCH_MAX_TOOL`, near straight down. They live here because the
 * extra range exists only for the hotbar: `GameScene` clamps mouse input with
 * them and `MazeScene` eases the view back up when the tool is put away.
 */
export const PITCH_MIN = -0.35
export const PITCH_MAX = 0.55
export const PITCH_MAX_TOOL = 1.5

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
]

/** Demolish belongs to no page. The piece you want gone is almost always the
 *  one you just placed, so it sits last on every page, on `0`, instead of
 *  costing two page turns back to the tools row. */
const DEMOLISH_SLOT: Slot = { id: 'demolish', label: 'Demolish', icon: 'i-lucide-hammer' }

const KIT_ICONS: Record<string, string> = {
  Kit_Wall: 'i-lucide-rectangle-vertical',
  Kit_WallWindow: 'i-lucide-app-window',
  Kit_WallDoor: 'i-lucide-door-open',
  Kit_Floor: 'i-lucide-square',
  Kit_Roof: 'i-lucide-triangle',
  Kit_RoofCorner: 'i-lucide-triangle-right',
  // Lucide has no staircase; ascending bars are the closest silhouette it has.
  Kit_Stairs: 'i-lucide-chart-no-axes-column-increasing',
  Kit_Fence: 'i-lucide-fence',
  Kit_Gate: 'i-lucide-archive',
  Kit_Torch: 'i-lucide-flame',
  Kit_Path: 'i-lucide-route',
  Kit_Crate: 'i-lucide-box',
  Kit_Deed: 'i-lucide-signpost',
}

const KIT_SLOTS: Slot[] = KIT_NAMES.map(kind => ({ id: kind, kind, label: kitLabel(kind), icon: KIT_ICONS[kind] ?? 'i-lucide-box' }))

/** Nine slots a page plus demolish on the end. The first page is the
 *  environment tools, the rest are the pieces to place. Tab turns the page,
 *  Shift+Tab turns it back. */
export interface BuildPage {
  label: string
  slots: Slot[]
}
export const BUILD_PAGES: BuildPage[] = [
  { label: 'Tools', slots: TOOL_SLOTS },
  { label: 'Build 1', slots: KIT_SLOTS.slice(0, 9) },
  { label: 'Build 2', slots: KIT_SLOTS.slice(9) },
].map(page => ({ ...page, slots: [...page.slots, DEMOLISH_SLOT] }))

/** Where demolish sits on a page: always last, always `0`. */
export function demolishIndex(page: number): number {
  return (BUILD_PAGES[page]?.slots.length ?? 1) - 1
}

/** Label per `SURFACE` value. `path` is called paving in the bar because that
 *  is what it lays: real flagstones, not a worn track. `snow` is here to be
 *  *named* — the HUD reports what is under the crosshair — and deliberately not
 *  in `SURFACE_CYCLE`: it is generated above the snowline, never painted. */
export const SURFACE_NAMES = ['grass', 'dirt', 'stone', 'sand', 'paving', 'water', 'snow'] as const
const SURFACE_CYCLE: Surface[] = [SURFACE.dirt, SURFACE.stone, SURFACE.sand, SURFACE.path, SURFACE.grass, SURFACE.water]

export interface UseBuild {
  page: Ref<number>
  /** Index into the current page, or -1 when nothing is armed (the default). */
  slot: Ref<number>
  /** The armed slot, or undefined when nothing is armed. */
  active: ComputedRef<Slot | undefined>
  /** Terraform brush, 1 to 3 tiles across. Never 1 while `flatten` is armed:
   *  that brush is the crosshair corner alone and there is nothing to level. */
  size: Ref<1 | 2 | 3>
  /** Ghost rotation, in quarter turns of radians. */
  rot: Ref<number>
  /** What `paint` writes. */
  surface: Ref<Surface>
  /** Pieces this player owns in the whole world. The server counts them and
   *  sends the total on `welcome` and on every `place`/`remove` of theirs;
   *  `useWorld` writes it here. */
  pieces: Ref<number>
  /** Plots this player holds, counted by the server the same way. */
  deeds: Ref<number>
  /** Whether the crosshair is on something the armed tool can act on. */
  targetOk: Ref<boolean>
  /** Why not, or what is targeted. One short line for the HUD. */
  targetHint: Ref<string>
  /** One-shot: a left click the scene consumes on its next frame. */
  fireQueued: Ref<boolean>
  /** The left button is down: the scene repeats the armed tool as the target
   *  moves, rate-limited to the server's own edit budget. */
  holding: Ref<boolean>
  /** Bumped on every press. The scene watches it to forget the last target it
   *  edited, so clicking the same tile twice is two edits and holding the
   *  button across it is one. */
  pressId: Ref<number>
  /** Which shoulder the camera looks over while a tool is armed. `V` flips it. */
  shoulder: Ref<1 | -1>
  reach: number
  budget: number
  plots: number
  select: (index: number) => void
  disarm: () => void
  cycleSlot: (delta: number) => void
  /** Arm demolish, or put back whatever it was swapped in for. */
  toggleDemolish: () => void
  turnPage: (delta?: number) => void
  cycleSurface: () => void
  rotate: () => void
  nudgeSize: (delta: number) => void
  fire: () => void
  press: () => void
  release: () => void
  flipShoulder: () => void
}

let singleton: UseBuild | null = null

export function useBuild(): UseBuild {
  if (singleton) return singleton

  const page = ref(0)
  const slot = ref(-1)
  const rawSize = ref<1 | 2 | 3>(1)
  const rot = ref(0)
  // Paving is what players reach for the tool to do, so a fresh Paint click
  // lays flagstones rather than a patch of dirt nobody asked for.
  const surface = ref<Surface>(SURFACE.path)
  const pieces = ref(0)
  const deeds = ref(0)
  const targetOk = ref(false)
  const targetHint = ref('')
  const fireQueued = ref(false)
  const holding = ref(false)
  const pressId = ref(0)
  // Over the right shoulder by default, because the hotbar and its refusal chip
  // sit under the middle of the screen and a left-shoulder default would put
  // the ghost behind them.
  const shoulder = ref<1 | -1>(1)

  // What each page had armed when it was last left, so turning back to one
  // picks it up rather than landing on whatever shares the index.
  const memory: number[] = BUILD_PAGES.map(() => -1)
  // What demolish was swapped in for, on this page. Not a ref: nothing renders it.
  let swapBack = -1

  const active = computed(() => BUILD_PAGES[page.value]?.slots[slot.value])

  /** The narrowest brush the armed tool can do anything with. `flatten` levels
   *  the brush to the corner at its centre, so at 1 that corner is levelled to
   *  itself and the click moves nothing: the tool would read as broken. */
  const minSize = computed(() => active.value?.id === 'flatten' ? 2 : 1)

  /** Reported rather than stored, so arming `flatten` widens the brush in the
   *  crosshair, the hotbar and the request together, and putting it away hands
   *  back the size that was in play. */
  const size = computed<1 | 2 | 3>({
    get: () => Math.max(minSize.value, rawSize.value) as 1 | 2 | 3,
    set: value => void (rawSize.value = value),
  })

  /** Arm a slot; the same slot again disarms, so nothing stays armed by accident. */
  function select(index: number) {
    const count = BUILD_PAGES[page.value]?.slots.length ?? 0
    if (index < 0 || index >= count) return
    if (index === count - 1) {
      toggleDemolish()
      return
    }
    swapBack = -1
    slot.value = slot.value === index ? -1 : index
  }

  /** Demolish is a swap, not a mode to undo: arming it remembers what was in
   *  hand and `0` again puts that back, so knocking down the wall you just
   *  placed costs two taps and leaves you still holding a wall. */
  function toggleDemolish() {
    const at = demolishIndex(page.value)
    if (slot.value === at) {
      slot.value = swapBack
      swapBack = -1
      return
    }
    swapBack = slot.value
    slot.value = at
  }

  function disarm() {
    slot.value = -1
    swapBack = -1
  }

  /** The wheel only walks the bar once a slot is armed, so an incidental scroll
   *  while running never picks a tool. Demolish sits outside the loop — the
   *  wheel is for choosing what to place, and a scroll past it would arm the
   *  one tool that takes something away. From demolish it walks on from
   *  whatever demolish was swapped in for. */
  function cycleSlot(delta: number) {
    if (slot.value < 0) return
    const count = demolishIndex(page.value)
    if (count < 1) return
    const from = slot.value === count ? Math.max(swapBack, 0) : slot.value
    swapBack = -1
    slot.value = (from + delta % count + count) % count
  }

  /** Turn the page, forwards by default and back on Shift. Demolish is on every
   *  page, so it stays in hand across the turn. */
  function turnPage(delta = 1) {
    const wasDemolish = slot.value === demolishIndex(page.value)
    memory[page.value] = wasDemolish ? swapBack : slot.value
    const count = BUILD_PAGES.length
    page.value = (page.value + delta % count + count) % count
    const restored = memory[page.value] ?? -1
    swapBack = wasDemolish ? restored : -1
    slot.value = wasDemolish ? demolishIndex(page.value) : restored
  }

  function cycleSurface() {
    const at = SURFACE_CYCLE.indexOf(surface.value)
    surface.value = SURFACE_CYCLE[(at + 1) % SURFACE_CYCLE.length]!
  }

  function rotate() {
    rot.value = (rot.value + BUILD_ROT_STEP) % (Math.PI * 2)
  }

  /** Walks the stored size, not the reported one, so a `[` under `flatten`'s
   *  floor is remembered and the brush narrows again once it is put away. */
  function nudgeSize(delta: number) {
    rawSize.value = Math.min(3, Math.max(1, size.value + delta)) as 1 | 2 | 3
  }

  function fire() {
    fireQueued.value = true
  }

  function press() {
    pressId.value++
    holding.value = true
  }

  function release() {
    holding.value = false
  }

  function flipShoulder() {
    shoulder.value = shoulder.value === 1 ? -1 : 1
  }

  singleton = {
    page,
    slot,
    active,
    size,
    rot,
    surface,
    pieces,
    deeds,
    targetOk,
    targetHint,
    fireQueued,
    holding,
    pressId,
    shoulder,
    reach: EDIT_REACH,
    budget: MAX_PIECES_PER_PLAYER,
    plots: DEED_LIMIT,
    select,
    disarm,
    cycleSlot,
    toggleDemolish,
    turnPage,
    cycleSurface,
    rotate,
    nudgeSize,
    fire,
    press,
    release,
    flipShoulder,
  }
  return singleton
}
