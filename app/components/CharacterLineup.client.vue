<script setup lang="ts">
import { NeutralToneMapping, Vector3 } from 'three'
import { TresCanvas } from '@tresjs/core'

/**
 * A static, forward-facing row of characters for the main menu — the cast lined
 * up, not the single turning bust of the creation gate.
 *
 * TresCanvas + lights live here; the row itself is an inner
 * <CharacterLineupModels> so it can drive its animation mixers and framing
 * camera from Tres's own render loop (useLoop only works inside the canvas
 * context). Lighting mirrors the single-character preview.
 */
defineProps<{ characters: { character: string, outfitColor: number }[] }>()

// Vector3 instances so the Tres light position props type-check. A bright key +
// fill lift the dark leather outfits, and a rim light from behind edges the
// silhouettes so the row reads against the dark backdrop. A low front bounce
// aims up at the legs/boots, which the overhead lights leave in shadow.
const keyLightPosition = new Vector3(3, 5, 4)
const fillLightPosition = new Vector3(-4, 2, -1)
const rimLightPosition = new Vector3(-2, 4, -5)
const bottomLightPosition = new Vector3(0, -3, 4)
</script>

<template>
  <TresCanvas
    :alpha="true"
    :clear-alpha="0"
    :dpr="[1, 2]"
    :tone-mapping="NeutralToneMapping"
    :tone-mapping-exposure="1.15"
  >
    <TresAmbientLight :intensity="2" />
    <TresDirectionalLight
      :position="keyLightPosition"
      :intensity="3.2"
    />
    <TresDirectionalLight
      :position="fillLightPosition"
      :intensity="1.4"
    />
    <TresDirectionalLight
      :position="rimLightPosition"
      color="#cfe0ff"
      :intensity="2.6"
    />
    <TresDirectionalLight
      :position="bottomLightPosition"
      :intensity="2.4"
    />
    <CharacterLineupModels :characters="characters" />
  </TresCanvas>
</template>
