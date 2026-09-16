<script setup lang="ts">
/**
 * The landing page. This is the URL people and crawlers hit, so it renders on
 * the server and loads nothing from the game: the backdrop is a still of the
 * town (`/landing.jpg`), not the 3D scene, and the only client work is the
 * `/api/status` poll behind the live line and the `/api/auth` probe that names
 * the Play button. `/play` is where the canvas, the socket and the gate live.
 */
definePageMeta({
  colorMode: 'dark',
})

const features = [
  { icon: 'i-lucide-shovel', title: 'Dig and build', text: 'Raise and lower the land outside the walls, then build on it. Every edit is the server\'s call and it stays there.' },
  { icon: 'i-lucide-sparkles', title: 'The Oracle', text: 'An NPC that reads the live world. Ask it in chat who is around or what has been built.' },
  { icon: 'i-lucide-globe', title: 'Realms', text: 'Each deploy region keeps a world of its own, so the town you walk into is the one nearest you.' },
]

const controls = [
  { keys: ['W', 'A', 'S', 'D'], label: 'move' },
  { keys: ['Space'], label: 'jump' },
  { keys: ['Shift'], label: 'dash' },
  { keys: ['Click'], label: 'use tool' },
  { keys: ['M'], label: 'map' },
  { keys: ['Esc'], label: 'menu' },
]

/**
 * Who is around, before there is a socket to ask. `GET /api/status` is the
 * cheap half of what `welcome` carries: the roster size, the realm, and whether
 * this process has a store behind it. Client-side only, so the page itself can
 * be static — the SSR HTML simply has no live line yet.
 */
const status = ref<{ players: number, realm: string, persistent: boolean } | null>(null)
/** A returning player keeps their character: name the button after them. */
const name = ref<string | null>(null)

async function probe() {
  try {
    status.value = await $fetch('/api/status')
  }
  catch {
    // The server is reachable enough to serve this page; a failed probe just
    // leaves the live line where it was.
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
  <div class="relative flex min-h-dvh flex-col overflow-hidden bg-[#05070d] text-white">
    <!-- A still of the town, not the game: the scene costs ~180 models to
         load and this page is read, not played. -->
    <img
      src="/landing.jpg"
      alt=""
      class="absolute inset-0 size-full object-cover object-center opacity-65"
    >
    <div class="absolute inset-0 bg-[linear-gradient(100deg,#05070df5_20%,#05070dcc_52%,#05070d66_100%)]" />
    <div class="absolute inset-x-0 bottom-0 h-80 bg-[linear-gradient(to_top,#05070d_35%,transparent)]" />

    <div class="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-10 px-6 pb-24 pt-14 sm:gap-14">
      <main class="flex flex-col gap-7">
        <div class="flex items-center gap-4">
          <img
            src="/logo.svg?v=wind"
            alt=""
            class="size-12 rounded-lg sm:size-14"
          >
          <h1 class="text-4xl font-semibold tracking-[0.2em] text-highlighted sm:text-5xl lg:text-6xl">
            AVELUNE
          </h1>
        </div>

        <p class="max-w-[46ch] text-base leading-relaxed text-toned sm:text-lg">
          A shared fantasy world on Vercel WebSockets. Walk the town, dig and build beyond the walls, talk to the Oracle.
        </p>

        <div class="flex flex-col items-start gap-4">
          <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
            <UButton
              to="/play"
              :label="name ? `Continue as ${name}` : 'Play'"
              icon="i-lucide-play"
              color="primary"
              size="xl"
            />
            <p
              v-if="status"
              class="flex items-center gap-2 text-sm text-toned"
            >
              <span class="relative flex size-2">
                <span class="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
                <span class="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {{ status.players }} in town · {{ realmName(status.realm) }}
            </p>
          </div>
          <UBadge
            v-if="status && !status.persistent"
            color="warning"
            variant="subtle"
            size="sm"
            icon="i-lucide-triangle-alert"
            label="Sandbox: this world resets when the server restarts"
          />
        </div>
      </main>

      <!-- What you can do in there. It sits under the hero rather than beside
           it: the Play button is the only thing anyone needs on first read. -->
      <section>
        <ul class="grid gap-6 border-t border-white/10 pt-7 sm:grid-cols-3 sm:gap-8">
          <li
            v-for="feature in features"
            :key="feature.title"
            class="flex gap-3.5 sm:flex-col sm:gap-2"
          >
            <UIcon
              :name="feature.icon"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div class="flex flex-col gap-0.5">
              <p class="text-sm font-medium text-highlighted">
                {{ feature.title }}
              </p>
              <p class="max-w-[38ch] text-sm leading-relaxed text-muted">
                {{ feature.text }}
              </p>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <footer class="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-7">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted">
        <span
          v-for="control in controls"
          :key="control.label"
          class="flex items-center gap-1.5"
        >
          <span class="flex items-center gap-0.5">
            <UKbd
              v-for="key in control.keys"
              :key="key"
              :value="key"
            />
          </span>
          {{ control.label }}
        </span>
      </div>
      <UButton
        to="https://github.com/benjamincanac/avelune"
        target="_blank"
        icon="i-lucide-github"
        label="Source on GitHub"
        color="neutral"
        variant="link"
        size="sm"
        class="-ml-2.5 sm:ml-0"
      />
    </footer>
  </div>
</template>
