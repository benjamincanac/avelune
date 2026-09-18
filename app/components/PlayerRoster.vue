<script setup lang="ts">
/**
 * Who is in town, on the title screen. Live data is the point of this page, so
 * the roster is content rather than debug output: a panel of its own, marked
 * live by the 2px accent edge along its top.
 *
 * The right-hand column is minutes in town, not a ping. Latency is measured by
 * each client's own heartbeat, so the server has no honest per-player number to
 * report — and a made-up one would undercut the only thing this panel is for.
 */
const props = defineProps<{
  entries: { name: string, minutes: number }[]
  /** The realm's display name; null before the first probe resolves. */
  realm: string | null
  /** Highest roster size in each of the last nine hours. */
  series: number[]
  /** Our own character's name, if we have one — that row is ours. */
  self: string | null
}>()

/** `Maren` → `MR`: the first letter and the first consonant after it, which
 *  reads better on a 32px tile than the first two letters ever do. */
function monogram(name: string) {
  const letters = [...name.toUpperCase()].filter(c => /[A-Z]/.test(c))
  const first = letters[0] ?? '?'
  const second = letters.slice(1).find(c => !'AEIOU'.includes(c)) ?? letters[1] ?? ''
  return `${first}${second}`
}

/** A world nobody has visited yet has nothing to chart, and nine flat ticks
 *  read as a broken widget rather than as "quiet". */
const hasHistory = computed(() => props.series.some(value => value > 0))

/** Bars are relative to the busiest hour, with a floor so an empty hour still
 *  reads as a tick rather than nothing at all. */
const bars = computed(() => {
  const peak = Math.max(1, ...props.series)
  return props.series.map((value, index) => ({
    index,
    height: `${Math.max(6, Math.round((value / peak) * 100))}%`,
    /** The last two hours are now-ish, so they carry the accent. */
    recent: index >= props.series.length - 2,
  }))
})
</script>

<template>
  <section class="frost rounded-[6px] border-t-2 border-primary px-6 pb-5 pt-[22px]">
    <header class="flex items-center justify-between gap-4">
      <h2 class="font-display text-sm font-bold uppercase leading-none tracking-[0.22em] text-highlighted">
        Roster
      </h2>
      <span class="telemetry min-w-24 text-right tracking-[0.14em] text-primary">Live<template v-if="realm"> · {{ realm }}</template></span>
    </header>

    <ul class="mt-[18px] flex flex-col gap-0.5">
      <li
        v-for="entry in entries"
        :key="entry.name"
        class="flex items-center gap-[13px] border-l-2 px-3 py-2.5"
        :class="entry.name === self ? 'border-primary bg-primary/10' : 'border-transparent'"
      >
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-[4px] font-display text-sm font-bold leading-none"
          :class="entry.name === self ? 'bg-primary text-avelune-950' : 'bg-white/14 text-muted'"
        >{{ monogram(entry.name) }}</span>
        <span
          class="flex-1 truncate text-base leading-none"
          :class="entry.name === self ? 'font-semibold text-highlighted' : 'font-medium text-toned'"
        >{{ entry.name }}</span>
        <span
          class="font-mono text-[11px] font-semibold leading-none"
          :class="entry.name === self ? 'text-primary' : 'text-label'"
        >{{ entry.minutes }}m</span>
      </li>
      <li
        v-if="!entries.length"
        class="py-2.5 font-medium leading-none text-label"
      >
        Nobody in town yet
      </li>
    </ul>

    <div
      v-if="hasHistory"
      class="mt-[22px] flex h-11 items-end justify-between gap-[3px]"
    >
      <span
        v-for="bar in bars"
        :key="bar.index"
        class="flex-1"
        :class="bar.recent ? 'bg-primary/60 last:bg-primary' : 'bg-white/16'"
        :style="{ height: bar.height }"
      />
    </div>
    <p
      v-if="hasHistory"
      class="telemetry mt-2 tracking-[0.14em] text-label"
    >
      Players · last 9h
    </p>
  </section>
</template>
