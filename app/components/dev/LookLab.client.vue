<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import { ACESFilmicToneMapping } from 'three'

defineProps<{ raw: boolean, focus: string }>()
</script>

<template>
  <TresCanvas
    window-size
    shadows
    :dpr="[1, 2]"
    :tone-mapping="ACESFilmicToneMapping"
    :tone-mapping-exposure="1.05"
    clear-color="#2c2f34"
  >
    <DevLookLabScene
      :raw="raw"
      :focus="focus"
    />
  </TresCanvas>
</template>
