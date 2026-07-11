<script setup lang="ts">
import { PROP_CATALOG } from '#shared/utils/propCatalog'
import { BIOMES, HUB_FLOOR, isSolidProp } from '#shared/utils/maze'
import type { EditorTool } from '~/composables/useEditor'

/**
 * 2D overlay for the dev world editor. Pure HUD chrome over the live scene — a
 * floor switcher moves between the hub and each dungeon floor, the palette arms
 * a kind for click-to-place, the inspector edits the selected prop, and Save
 * writes every floor's working copy to the repo's JSON. All 3D interaction (fly
 * camera, picking, drag) is handled by the scene controller
 * (`app/utils/hubEditor.ts`); this panel only reads/writes `useEditor` state.
 */
const emit = defineEmits<{ exit: [] }>()

const editor = useEditor()
const toast = useToast()

const search = ref('')

// Floor switcher: the hub plus each authored dungeon floor, in order.
const isHub = computed(() => editor.currentFloor.value === HUB_FLOOR)
const floors = computed(() => editor.docs.value.map(d => ({
  floor: d.floor,
  label: d.floor === HUB_FLOOR ? 'Hub' : `F${d.floor}`,
  dirty: editor.dirtyFloors.value.has(d.floor),
})))
const maxFloor = computed(() => Math.max(...editor.docs.value.map(d => d.floor)))

// Per-floor biome (dungeon floors only), edited live.
const biomes = BIOMES.map((b, i) => ({ label: b.name, value: i }))
const biome = computed({
  get: () => editor.current.value.biome,
  set: (v: number) => {
    editor.current.value.biome = v
    editor.commit()
  },
})

function addFloor() {
  editor.createFloor()
}
function removeFloor() {
  if (confirm(`Delete Floor ${maxFloor.value}? This can't be undone after saving.`)) editor.deleteFloor()
}

// Tools: select/place props everywhere; drop traps + drag spawn/exit on dungeon
// floors; drag the Oracle marker on the hub.
const tool = editor.tool
const tools = computed(() => {
  const t: { value: EditorTool, label: string, icon: string }[] = [
    { value: 'select', label: 'Select', icon: 'i-lucide-mouse-pointer-2' },
  ]
  if (!isHub.value) t.push({ value: 'trap', label: 'Trap', icon: 'i-lucide-circle-dot' })
  t.push({ value: 'marker', label: isHub.value ? 'Oracle' : 'Spawn / Exit', icon: isHub.value ? 'i-lucide-sparkles' : 'i-lucide-flag' })
  return t
})

/** The selected trap, when a trap is the current selection. */
const selTrap = computed(() => {
  const s = editor.selection.value
  return s?.type === 'trap' ? editor.traps.value[s.index] ?? null : null
})
function touchTrap() {
  editor.commit()
}
function removeTrap() {
  const s = editor.selection.value
  if (s?.type !== 'trap') return
  editor.traps.value.splice(s.index, 1)
  editor.selection.value = null
  editor.commit()
}

// Palette filtered by the search box; empty categories drop out.
const categories = computed(() => {
  const q = search.value.trim().toLowerCase()
  return PROP_CATALOG
    .map(c => ({
      label: c.label,
      names: q ? c.names.filter(n => n.toLowerCase().includes(q)) : c.names,
    }))
    .filter(c => c.names.length)
})

/** The selected placement, or null. Editing its fields updates the scene live. */
const sel = computed(() => {
  const i = editor.selected.value
  return i != null ? editor.placements.value[i] ?? null : null
})

function touch() {
  editor.commit()
}

// Rotation shown in whole degrees; scale to one decimal.
const rotDeg = computed({
  get: () => (sel.value ? Math.round((sel.value.rot * 180 / Math.PI) % 360) : 0),
  set: (deg: number) => {
    if (sel.value) {
      sel.value.rot = (deg * Math.PI) / 180
      touch()
    }
  },
})

// Elevation (3D height). Bound separately so ground props keep an implicit 0.
const height = computed({
  get: () => sel.value?.z ?? 0,
  set: (z: number) => {
    if (sel.value) {
      sel.value.z = z
      touch()
    }
  },
})

// Palette thumbnails live at /thumbnails/<kind>.png (rendered by
// scripts/make_thumbnails). Hide the icon gracefully if one is missing.
function onThumbError(e: Event) {
  (e.target as HTMLImageElement).style.visibility = 'hidden'
}

function arm(kind: string) {
  editor.paletteKind.value = editor.paletteKind.value === kind ? null : kind
  editor.selected.value = null
}

function removeSelected() {
  const i = editor.selected.value
  if (i == null) return
  editor.placements.value.splice(i, 1)
  editor.selected.value = null
  touch()
}

async function onSave() {
  try {
    await editor.save()
    // On success a full dev reload follows (the JSON is in the module graph),
    // so this toast is mostly a fallback if HMR is slow.
    toast.add({ title: 'Saved', description: 'Hub layout written — reloading…', color: 'success' })
  }
  catch (err) {
    toast.add({
      title: 'Save failed',
      description: err instanceof Error ? err.message : 'Could not write the hub layout',
      color: 'error',
    })
  }
}

function onExit() {
  if (editor.dirty.value && !confirm('Discard unsaved placement changes?')) return
  emit('exit')
}
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-20 text-white">
    <!-- Top bar: title + save / exit. -->
    <div class="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-black/45 px-3 py-2 backdrop-blur">
      <UIcon
        name="i-lucide-hammer"
        class="size-4 text-primary"
      />
      <span class="text-sm font-semibold tracking-wide">Editor</span>
      <span class="ml-1 text-xs text-muted">{{ editor.placements.value.length }} props</span>
      <span
        v-if="editor.dirty.value"
        class="size-1.5 rounded-full bg-warning"
        title="Unsaved changes"
      />
      <div class="mx-1 h-4 w-px bg-white/15" />
      <UButton
        icon="i-lucide-undo-2"
        size="xs"
        color="neutral"
        variant="ghost"
        title="Undo (⌘Z)"
        :disabled="!editor.canUndo()"
        @click="editor.undo()"
      />
      <UButton
        icon="i-lucide-redo-2"
        size="xs"
        color="neutral"
        variant="ghost"
        title="Redo (⇧⌘Z)"
        :disabled="!editor.canRedo()"
        @click="editor.redo()"
      />
      <div class="mx-1 h-4 w-px bg-white/15" />
      <UButton
        label="Save"
        icon="i-lucide-save"
        size="xs"
        color="primary"
        :loading="editor.saving.value"
        :disabled="!editor.dirty.value"
        @click="onSave"
      />
      <UButton
        label="Exit"
        icon="i-lucide-door-open"
        size="xs"
        color="neutral"
        variant="soft"
        @click="onExit"
      />
    </div>

    <!-- Floor switcher: hub + each dungeon floor, new-floor, per-floor biome. -->
    <div class="pointer-events-auto absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-black/45 px-2 py-1.5 backdrop-blur">
      <button
        v-for="f in floors"
        :key="f.floor"
        type="button"
        class="relative rounded px-2 py-1 text-xs font-medium transition-colors"
        :class="editor.currentFloor.value === f.floor ? 'bg-primary text-inverted' : 'hover:bg-white/10'"
        @click="editor.switchFloor(f.floor)"
      >
        {{ f.label }}
        <span
          v-if="f.dirty"
          class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warning"
          title="Unsaved"
        />
      </button>
      <UButton
        icon="i-lucide-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        title="New floor"
        @click="addFloor"
      />
      <template v-if="!isHub">
        <div class="mx-0.5 h-4 w-px bg-white/15" />
        <select
          class="rounded bg-black/40 px-1 py-0.5 text-[11px] text-white outline-none ring-1 ring-white/10"
          :value="biome"
          title="Biome"
          @change="biome = Number(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="b in biomes"
            :key="b.value"
            :value="b.value"
          >
            {{ b.label }}
          </option>
        </select>
        <UButton
          v-if="editor.currentFloor.value === maxFloor"
          icon="i-lucide-trash-2"
          size="xs"
          color="error"
          variant="ghost"
          title="Delete this (deepest) floor"
          @click="removeFloor"
        />
      </template>
    </div>

    <!-- Tool selector: select/place everywhere; trap + spawn/exit on floors;
         the Oracle marker on the hub. -->
    <div
      class="pointer-events-auto absolute left-1/2 top-28 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-black/45 px-1.5 py-1 backdrop-blur"
    >
      <button
        v-for="t in tools"
        :key="t.value"
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors"
        :class="tool === t.value ? 'bg-primary text-inverted' : 'hover:bg-white/10'"
        @click="tool = t.value"
      >
        <UIcon
          :name="t.icon"
          class="size-3"
        />
        {{ t.label }}
      </button>
    </div>

    <!-- Left: prop palette. -->
    <div class="pointer-events-auto absolute bottom-4 left-4 top-4 flex w-60 flex-col gap-3 rounded-lg bg-black/45 p-3 backdrop-blur">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search props…"
        variant="soft"
        color="neutral"
        autocomplete="off"
      />
      <div class="-mx-3 flex flex-col gap-3 overflow-y-auto px-3">
        <div
          v-for="cat in categories"
          :key="cat.label"
        >
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {{ cat.label }}
          </div>
          <div class="flex flex-col">
            <button
              v-for="kind in cat.names"
              :key="kind"
              type="button"
              class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition-colors"
              :class="editor.paletteKind.value === kind ? 'bg-primary text-inverted' : 'hover:bg-white/5'"
              @click="arm(kind)"
            >
              <img
                :src="`/thumbnails/${kind}.png`"
                alt=""
                loading="lazy"
                class="size-6 shrink-0 rounded-md bg-black/20 object-contain"
                @error="onThumbError"
              >
              <span class="flex-1 truncate">{{ kind }}</span>
              <UIcon
                v-if="isSolidProp(kind)"
                name="i-lucide-brick-wall"
                class="size-3 shrink-0 opacity-60"
                title="Solid (collides)"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Right: inspector for the selected prop. -->
    <div
      v-if="sel"
      class="pointer-events-auto absolute right-4 top-4 flex w-52 flex-col gap-3 rounded-lg bg-black/45 p-3 backdrop-blur"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-sm font-semibold">{{ sel.kind }}</span>
        <UBadge
          :color="isSolidProp(sel.kind) ? 'primary' : 'neutral'"
          variant="subtle"
          size="sm"
        >
          {{ isSolidProp(sel.kind) ? 'Solid' : 'Decor' }}
        </UBadge>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <UFormField
          label="X"
          size="xs"
        >
          <UInputNumber
            v-model="sel.x"
            :step="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touch"
          />
        </UFormField>
        <UFormField
          label="Y"
          size="xs"
        >
          <UInputNumber
            v-model="sel.y"
            :step="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touch"
          />
        </UFormField>
        <UFormField
          label="Height"
          size="xs"
        >
          <UInputNumber
            v-model="height"
            :step="0.25"
            :min="0"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
          />
        </UFormField>
        <UFormField
          label="Rotation°"
          size="xs"
        >
          <UInputNumber
            v-model="rotDeg"
            :step="15"
            size="xs"
          />
        </UFormField>
        <UFormField
          :label="sel.s3 ? 'Scale (fixed)' : 'Scale'"
          size="xs"
        >
          <UInputNumber
            v-model="sel.scale"
            :step="0.1"
            :min="0.2"
            :max="3"
            :disabled="!!sel.s3"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touch"
          />
        </UFormField>
      </div>

      <UButton
        label="Delete"
        icon="i-lucide-trash-2"
        size="xs"
        color="error"
        variant="soft"
        block
        @click="removeSelected"
      />
    </div>

    <!-- Right: inspector for the selected trap (timed hazard). -->
    <div
      v-else-if="selTrap"
      class="pointer-events-auto absolute right-4 top-4 flex w-52 flex-col gap-3 rounded-lg bg-black/45 p-3 backdrop-blur"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-sm font-semibold">Trap</span>
        <UBadge
          color="error"
          variant="subtle"
          size="sm"
        >
          Hazard
        </UBadge>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <UFormField
          label="X"
          size="xs"
        >
          <UInputNumber
            v-model="selTrap.x"
            :step="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touchTrap"
          />
        </UFormField>
        <UFormField
          label="Y"
          size="xs"
        >
          <UInputNumber
            v-model="selTrap.y"
            :step="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touchTrap"
          />
        </UFormField>
        <UFormField
          label="Cycle (s)"
          size="xs"
          help="Full period"
        >
          <UInputNumber
            v-model="selTrap.period"
            :step="0.5"
            :min="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touchTrap"
          />
        </UFormField>
        <UFormField
          label="Active (s)"
          size="xs"
          help="Lethal window"
        >
          <UInputNumber
            v-model="selTrap.duration"
            :step="0.25"
            :min="0.1"
            :max="selTrap.period"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touchTrap"
          />
        </UFormField>
        <UFormField
          label="Phase (s)"
          size="xs"
          help="Cycle offset"
        >
          <UInputNumber
            v-model="selTrap.phase"
            :step="0.25"
            :min="0"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touchTrap"
          />
        </UFormField>
      </div>
      <UButton
        label="Delete trap"
        icon="i-lucide-trash-2"
        size="xs"
        color="error"
        variant="soft"
        block
        @click="removeTrap"
      />
    </div>

    <!-- Bottom: keybinding hints. -->
    <div class="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg bg-black/40 px-3 py-1.5 text-[11px] text-muted backdrop-blur">
      <span class="flex items-center gap-1"><UKbd value="RMB" />drag look</span>
      <span class="flex items-center gap-1"><UKbd value="W" /><UKbd value="A" /><UKbd value="S" /><UKbd value="D" />fly</span>
      <span class="flex items-center gap-1"><UKbd value="Space" />/<UKbd value="Q" />up · down</span>
      <span class="flex items-center gap-1"><UKbd value="Shift" />faster</span>
      <span class="flex items-center gap-1"><UKbd value="LMB" />place / select</span>
      <span class="flex items-center gap-1"><UKbd value="↑" /><UKbd value="↓" /><UKbd value="←" /><UKbd value="→" />nudge</span>
      <span class="flex items-center gap-1"><UKbd value="PgUp" /><UKbd value="PgDn" />raise · lower</span>
      <span class="flex items-center gap-1"><UKbd value="R" />rotate</span>
      <span class="flex items-center gap-1"><UKbd value="[" /><UKbd value="]" />scale</span>
      <span class="flex items-center gap-1"><UKbd value="Del" />remove</span>
      <span class="flex items-center gap-1"><UKbd value="⌘" /><UKbd value="Z" />undo</span>
    </div>
  </div>
</template>
