<script setup lang="ts">
import type { WorldEvent } from '~/composables/useFeed'

/**
 * The title screen. This is the URL people and crawlers hit, so it renders on
 * the server and loads nothing from the game: the backdrop is a still of the
 * town (`/landing.jpg`), not the 3D scene, and the only client work is the
 * `/api/status` poll and the `/api/auth` probe that names the Play button.
 * `/play` is where the canvas, the socket and the gate live.
 *
 * Its job is to say "live and multiplayer" before a word of copy is read, so
 * everything the server reports — the roster, the feed, the counts, the round
 * trip — is first-class content here rather than a status bar. Nothing on it is
 * invented: the roster, peak and nine-hour series all come off `/api/status`,
 * and the latency is this page's own measured round trip to it.
 */
definePageMeta({
  colorMode: 'dark',
})

interface Status {
  players: number
  peak: number
  series: number[]
  realm: string
  roster: { name: string, minutes: number }[]
  persistent: boolean
  feed: WorldEvent[]
}

const feed = useFeed()

const status = ref<Status | null>(null)
/** Our own measured round trip to the server. There is no socket on this page,
 *  so the status poll is the only trip there is — and it is a real one. */
const rtt = ref<number | null>(null)
/** Null while the first probe is in flight, false once one has failed. */
const online = ref<boolean | null>(null)
/** A returning player keeps their character: name the button after them. */
const name = ref<string | null>(null)

const realm = computed(() => status.value ? realmName(status.value.realm) : null)
const series = computed(() => status.value?.series ?? [])

const features = [
  { icon: 'i-lucide-shovel', title: 'Dig and build', text: 'Raise and lower the land outside the walls, then build on it. Every edit is the server\'s call and it stays there.' },
  { icon: 'i-lucide-sparkles', title: 'The Oracle', text: 'An NPC that reads the live world. Ask it in chat who is around or what has been built.' },
  { icon: 'i-lucide-globe', title: 'Realms', text: 'Each deploy region keeps a world of its own, so the town you walk into is the one nearest you.' },
]

const controls = [
  { keys: ['W', 'A', 'S', 'D'], label: 'Move' },
  { keys: ['Space'], label: 'Jump' },
  { keys: ['Shift', 'E'], label: 'Sprint / dash' },
  { keys: ['Click'], label: 'Use tool' },
  { keys: ['1', '9', 'Tab'], label: 'Hotbar' },
  { keys: ['M'], label: 'World map' },
  { keys: ['F'], label: 'Fullscreen' },
  { keys: ['Esc'], label: 'Menu' },
]

async function probe() {
  const started = performance.now()
  try {
    status.value = await $fetch<Status>('/api/status')
    rtt.value = Math.round(performance.now() - started)
    online.value = true
    feed.adopt(status.value.feed)
  }
  catch {
    // The server is reachable enough to have served this page, so a failed
    // probe leaves the live data where it was and only dims the indicator.
    online.value = false
  }
}

onMounted(async () => {
  void probe()
  const timer = setInterval(probe, 10_000)
  onBeforeUnmount(() => clearInterval(timer))

  try {
    const me = await $fetch('/api/auth')
    if (me.authenticated) name.value = me.name
  }
  catch {
    // No cookie, or the probe failed: the button stays a plain invitation.
  }
})
</script>

<template>
  <div class="relative min-h-dvh overflow-hidden bg-stage text-white">
    <!-- A still of the town, not the game: the scene costs ~180 models to
         load and this page is read, not played. -->
    <img
      src="/landing.jpg"
      alt=""
      class="fixed inset-0 size-full object-cover object-center"
    >
    <div class="fixed inset-0 bg-[linear-gradient(95deg,rgb(6_14_17/0.96)_0%,rgb(6_14_17/0.88)_34%,rgb(6_14_17/0.35)_64%,rgb(6_14_17/0.8)_100%)]" />

    <!-- The design frame: one screenful, three bands — live line, the pitch with
         the roster beside it, and the counters with the feed. Rows rather than
         pixel corners, so the middle band centres at any viewport height and the
         same clusters stack in flow order on a phone. -->
    <div class="relative flex min-h-dvh flex-col px-6 py-10 lg:h-dvh lg:px-9 lg:pb-11 lg:pt-0">
      <!-- Top right: the live line. No panel — this is not something you click,
           and an earlier full-width bar was rejected. -->
      <div class="wash-right telemetry on-render -mx-6 flex items-center justify-end gap-5 whitespace-nowrap py-3.5 pr-6 tracking-[0.14em] lg:-mr-9 lg:ml-auto lg:mt-9 lg:w-fit lg:pl-[90px] lg:pr-9">
        <span class="flex min-w-37 items-center justify-end gap-2 text-default">
          <span
            class="size-1.5"
            :class="online === false ? 'bg-[#e07a5f]' : online ? 'bg-primary' : 'bg-[#d8b13a]'"
          />
          {{ online === false ? 'Server unreachable' : online ? 'World online' : 'Connecting' }}
        </span>
        <!-- Kept in the flow with its space reserved: appearing after the probe
             would otherwise drag the items beside it sideways. -->
        <span class="min-w-30 text-right text-default">
          <template v-if="realm">{{ realm }}<template v-if="rtt != null"> · {{ rtt }}ms</template></template>
        </span>
        <a
          href="https://github.com/benjamincanac/avelune"
          target="_blank"
          rel="noopener"
          class="text-toned transition-colors duration-[120ms] ease-out hover:text-highlighted"
        >GitHub ↗</a>
      </div>

      <div class="flex flex-1 flex-col gap-14 py-12 lg:flex-row lg:items-center lg:gap-12 lg:py-0">
        <!-- Left column: the whole pitch, top to bottom. -->
        <main class="flex min-w-0 flex-col lg:flex-1">
          <BrandMark size="md" />

          <!-- Static on purpose. Whether the store persists is only known after
               the probe, so a prerendered eyebrow could only guess — and then
               swap its own text as the notice below appeared. "Shared" is true
               on every deploy; the persistence caveat is the notice's job. -->
          <p class="mt-[34px] flex items-center gap-3 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.24em] text-primary">
            <span class="h-0.5 w-[26px] shrink-0 bg-primary" />
            Shared multiplayer sandbox
          </p>

          <h1 class="mt-5 font-display text-[clamp(72px,14vw,132px)]/[0.84] font-extrabold uppercase tracking-[0.01em] text-highlighted">
            Avelune
          </h1>

          <p class="mt-6 max-w-[530px] text-[clamp(17px,2.2vw,22px)]/[1.5] text-muted text-pretty">
            One town, one live world. Reshape the land beyond the walls, build what stays, and ask the Oracle what changed while you were gone.
          </p>

          <div class="mt-9 flex flex-wrap items-stretch gap-3">
            <UButton
              to="/play"
              size="xl"
              icon="i-lucide-play"
              :label="name ? `Continue as ${name}` : 'Play now'"
              class="notch-btn"
            />
            <UButton
              to="#how-it-works"
              color="neutral"
              variant="outline"
              size="xl"
              label="How it works"
              class="px-7.5 text-[15px] tracking-[0.18em]"
            />
          </div>

          <!-- Whether this world is a sandbox is only known after the probe, and
               this column is vertically centred — so the line's height is
               reserved rather than appearing and lifting everything above it. -->
          <div class="mt-5 h-3">
            <Transition
              enter-active-class="transition-opacity duration-300 ease-out"
              enter-from-class="opacity-0"
            >
              <SandboxNotice
                v-if="status && !status.persistent"
                wide
              />
            </Transition>
          </div>
          <!-- CSS alone decides this one, so it is there at first paint. -->
          <DesktopNotice
            wide
            class="mt-3"
          />
        </main>

        <!-- Right: who is actually in there. The live data is the pitch on this
             page, so unlike the line above it this one is content and keeps a
             panel of its own, with the accent edge that marks it live. -->
        <PlayerRoster
          :entries="status?.roster ?? []"
          :realm="realm"
          :series="series"
          :self="name"
          class="lg:mt-5.5 lg:w-80 lg:shrink-0 lg:self-start xl:w-[326px]"
        />
      </div>

      <!-- Bottom: what the server is reporting, at a size you read from across
           the room, and what people are doing with it. -->
      <div class="relative flex flex-col gap-14 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
        <div class="fused w-full flex-wrap lg:w-fit lg:flex-nowrap">
          <div
            v-for="stat in [
              { value: String(status?.players ?? 0).padStart(2, '0'), label: 'In town now', unit: '', accent: false },
              { value: String(status?.peak ?? 0).padStart(2, '0'), label: 'Peak today', unit: '', accent: false },
              { value: rtt == null ? '—' : String(rtt), label: 'Round trip', unit: ' ms', accent: true },
            ]"
            :key="stat.label"
            class="flex min-w-27 flex-1 flex-col gap-1 bg-stage/50 px-6 pb-3.5 pt-4 backdrop-blur-[22px] lg:min-w-32 lg:flex-none"
          >
            <span
              class="font-display text-[34px] font-extrabold leading-none"
              :class="stat.accent ? 'text-primary' : 'text-highlighted'"
            >{{ stat.value }}<span
              v-if="stat.unit"
              class="text-[15px] tracking-[0.04em]"
            >{{ stat.unit }}</span></span>
            <span class="telemetry tracking-[0.18em] text-label">{{ stat.label }}</span>
          </div>
        </div>

        <!-- Plain text on the edge wash. It only exists after the probe and is
             taller than the counters, so on the one-screen frame it is pinned
             out of flow: in flow it would grow this band and lift the centred
             pitch above it. -->
        <WorldFeed
          :events="feed.events.value"
          class="-mx-6 lg:absolute lg:bottom-0 lg:-right-9 lg:mx-0 lg:w-97"
        />
      </div>
    </div>

    <!-- Below the frame: the rest of the pitch, for anyone who pressed "how it
         works" rather than "play". Same system, no new one. -->
    <section
      id="how-it-works"
      class="relative flex min-h-dvh items-center bg-stage/90 px-6 py-20 backdrop-blur-[26px] lg:px-9"
    >
      <!-- Left-anchored and capped rather than centred, so its rail lines up
           with the frame above instead of drifting 12px inward. -->
      <div class="flex w-full max-w-[1440px] flex-col gap-12">
        <div class="flex flex-col gap-3">
          <p class="label-section text-primary">
            How it works
          </p>
          <h2 class="font-display text-[clamp(32px,5vw,44px)]/[1.02] font-extrabold uppercase tracking-[0.02em] text-highlighted">
            One world, held by the server
          </h2>
          <p class="max-w-[70ch] text-[17px]/[1.55] text-dimmed text-pretty">
            Everything you walk on, dig into and build is simulated on Vercel at a fixed 20 Hz and streamed to every player over one WebSocket. Your browser predicts; the server decides.
          </p>
        </div>

        <ul class="grid gap-px bg-white/10 sm:grid-cols-3">
          <li
            v-for="feature in features"
            :key="feature.title"
            class="flex flex-col gap-2 bg-stage p-6"
          >
            <UIcon
              :name="feature.icon"
              class="size-5 text-primary"
            />
            <p class="font-display text-lg font-bold uppercase tracking-[0.12em] text-highlighted">
              {{ feature.title }}
            </p>
            <p class="text-[15px]/[1.5] text-muted text-pretty">
              {{ feature.text }}
            </p>
          </li>
        </ul>

        <div class="flex flex-col gap-4">
          <p class="label-section text-label">
            Controls
          </p>
          <ul class="grid gap-x-9 sm:grid-cols-2">
            <li
              v-for="control in controls"
              :key="control.label"
              class="flex items-center justify-between gap-4 border-b border-white/7 py-2.5 last:border-0 sm:[&:nth-last-child(2)]:border-0"
            >
              <span class="text-[15px] leading-none text-toned">{{ control.label }}</span>
              <span class="flex gap-1">
                <UKbd
                  v-for="key in control.keys"
                  :key="key"
                  :value="key"
                />
              </span>
            </li>
          </ul>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <UButton
            to="/play"
            size="xl"
            icon="i-lucide-play"
            :label="name ? `Continue as ${name}` : 'Play now'"
            class="notch-btn text-[17px]"
          />
          <UButton
            to="https://github.com/benjamincanac/avelune"
            target="_blank"
            color="neutral"
            variant="outline"
            size="xl"
            icon="i-lucide-github"
            label="Source"
            class="px-7.5 text-[15px] tracking-[0.18em]"
          />
        </div>
      </div>
    </section>
  </div>
</template>
