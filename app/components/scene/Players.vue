<script setup lang="ts">
import type { GamePlayer, UseGame } from '~/composables/useGame'
import type { World } from '#shared/utils/world'
import { createPlayerResources } from '~/utils/playerResources'
import type { PlayerFrame } from '~/utils/playerFrame'
import Player from './Player.vue'

const props = defineProps<{ game: UseGame, world: World }>()
const emit = defineEmits<{ change: [] }>()
const resources = createPlayerResources()
// The network roster is a plain Map. Only roster/appearance changes enter Vue;
// transforms and animation stay in the ordered, imperative frame update.
interface Entry {
  player: GamePlayer
  key: number
  character: GamePlayer['character']
  outfitColor: GamePlayer['outfitColor']
  beard: GamePlayer['beard']
}
const roster = shallowReactive(new Map<string, Entry>())
const instances = new Map<number, InstanceType<typeof Player>>()
let generation = 0
let disposed = false

function setPlayer(key: number, instance: unknown) {
  if (instance) instances.set(key, instance as InstanceType<typeof Player>)
  else instances.delete(key)
}

function update(frame: PlayerFrame) {
  if (disposed) return
  for (const [id, entry] of roster) {
    if (props.game.players.has(id)) continue
    instances.get(entry.key)?.dispose()
    roster.delete(id)
  }
  for (const [id, player] of props.game.players) {
    let entry = roster.get(id)
    if (entry?.player !== player || entry.character !== player.character || entry.outfitColor !== player.outfitColor || entry.beard !== player.beard) {
      if (entry) instances.get(entry.key)?.dispose()
      entry = { player, key: ++generation, character: player.character, outfitColor: player.outfitColor, beard: player.beard }
      roster.set(id, entry)
    }
    instances.get(entry.key)?.update(frame)
  }
}

// The host calls this before Tres releases the renderer. Child cleanup and
// ordinary roster removals are safe to repeat; pooled resources outlive users.
function dispose() {
  if (disposed) return
  disposed = true
  for (const player of instances.values()) player.dispose()
  resources.dispose()
}
onBeforeUnmount(dispose)
defineExpose({ update, dispose })
</script>

<template>
  <TresGroup
    name="Players"
    :dispose="null"
  >
    <Player
      v-for="entry in roster.values()"
      :key="entry.key"
      :ref="instance => setPlayer(entry.key, instance)"
      :player="entry.player"
      :world="world"
      :resources="resources"
      @change="emit('change')"
    />
  </TresGroup>
</template>
