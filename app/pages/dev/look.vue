<script setup lang="ts">
/**
 * Dev-only look lab: both Developer bodies on a turntable, close up, in the game's
 * lighting. `?raw=1` shows the untouched Peasant GLBs; `?focus=head|arms|feet` moves the camera in.
 */
if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })

definePageMeta({ colorMode: 'dark' })

const raw = computed(() => useRoute().query.raw != null)
const focus = computed(() => String(useRoute().query.focus ?? 'full'))
</script>

<template>
  <div class="fixed inset-0 bg-[#2c2f34]">
    <ClientOnly>
      <DevLookLab
        :raw="raw"
        :focus="focus"
      />
    </ClientOnly>
    <p class="absolute bottom-3 left-4 text-xs text-white/50 font-mono">
      look lab — {{ raw ? 'raw Peasant rigs' : 'Developer look' }} · add ?raw=1 for the source rigs
    </p>
  </div>
</template>
