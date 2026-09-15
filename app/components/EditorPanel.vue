<script setup lang="ts">
import { PROP_CATALOG } from '#shared/utils/propCatalog'
import { isSolidProp } from '#shared/utils/maze'

/**
 * 2D overlay for the dev world editor. Pure HUD chrome over the live scene — the
 * palette arms a kind for click-to-place, the inspector edits the selected prop,
 * and Save writes the arena's working copy back to the repo's JSON. All 3D
 * interaction (fly camera, picking, drag) is handled by the scene controller
 * (`app/utils/hubEditor.ts`); this panel only reads/writes `useEditor` state.
 */
const emit = defineEmits<{ exit: [] }>()

const editor = useEditor()
const toast = useToast()

const search = ref('')

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

/** The Oracle's pose when it is the selection. It shares the placement inspector's
 *  position/rotation fields but has no height, scale or delete. */
const oracleSel = computed(() => (editor.selection.value?.type === 'oracle' ? editor.oracle.value : null))

/** Whatever is selected, as the reactive object the position/rotation fields bind to. */
const xf = computed(() => sel.value ?? oracleSel.value)

function touch() {
  editor.commit()
}

// Rotation shown in whole degrees; scale to one decimal.
const rotDeg = computed({
  get: () => (xf.value ? Math.round((xf.value.rot * 180 / Math.PI) % 360) : 0),
  set: (deg: number) => {
    if (xf.value) {
      xf.value.rot = (deg * Math.PI) / 180
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
              <UIcon
                name="i-lucide-blocks"
                class="size-6 shrink-0 p-1"
              />
              <span class="flex-1 truncate">{{ kind.replace(/^Courtyard_/, '') }}</span>
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

    <!-- Right: inspector for the selection (a prop, or the Oracle). -->
    <div
      v-if="xf"
      class="pointer-events-auto absolute right-4 top-4 flex w-52 flex-col gap-3 rounded-lg bg-black/45 p-3 backdrop-blur"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-sm font-semibold">{{ sel ? sel.kind : 'The Oracle' }}</span>
        <UBadge
          :color="sel ? (isSolidProp(sel.kind) ? 'primary' : 'neutral') : 'info'"
          variant="subtle"
          size="sm"
        >
          {{ sel ? (isSolidProp(sel.kind) ? 'Solid' : 'Decor') : 'NPC' }}
        </UBadge>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <UFormField
          label="X"
          size="xs"
        >
          <UInputNumber
            v-model="xf.x"
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
            v-model="xf.y"
            :step="0.5"
            :format-options="{ maximumFractionDigits: 2 }"
            size="xs"
            @update:model-value="touch"
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
          v-if="sel"
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
          v-if="sel"
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
        v-if="sel"
        label="Delete"
        icon="i-lucide-trash-2"
        size="xs"
        color="error"
        variant="soft"
        block
        @click="removeSelected"
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
