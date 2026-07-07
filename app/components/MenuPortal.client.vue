<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'

/**
 * The main-menu hero: the hub's swirling rune teleport, staged on a transparent
 * canvas over the menu backdrop. The gate's materials are all unlit + additive,
 * so no lights are needed — the inner <MenuPortalModel> builds the rift and
 * drives its swirl / rune spin / motes from Tres's render loop.
 */
</script>

<template>
  <TresCanvas
    :alpha="true"
    :clear-alpha="0"
  >
    <MenuPortalModel />
  </TresCanvas>
</template>
