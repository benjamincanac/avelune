<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'

/**
 * The main-menu hero: the hub's stone rune-gate and its swirling rift, staged
 * on a transparent canvas over the menu backdrop. The inner <MenuPortalModel>
 * builds the gate (plus the lights its stone needs) and drives its swirl /
 * rune spin / motes from Tres's render loop.
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
