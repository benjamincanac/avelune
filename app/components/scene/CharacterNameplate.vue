<script setup lang="ts">
import { CanvasTexture, LinearFilter, SpriteMaterial, SRGBColorSpace, Vector3 } from 'three'

const props = defineProps<{ name: string, color: string, height: number }>()

// The texture stays fixed in size; only changes to identity redraw it. Keeping
// Three resources outside deep Vue reactivity avoids proxying GPU state.
const canvas = document.createElement('canvas')
canvas.width = 1024
canvas.height = 256
const texture = new CanvasTexture(canvas)
texture.minFilter = LinearFilter
texture.colorSpace = SRGBColorSpace
const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false })
const position = computed(() => new Vector3(0, props.height + 0.06 + 0.28 / 2, 0))
const scale = new Vector3(1.12, 0.28, 1)

watch(() => [props.name, props.color], () => {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = `600 ${Math.round(canvas.height * 0.34)}px Archivo, ui-sans-serif, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = Math.max(2, Math.round(canvas.height * 0.055))
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.62)'
  ctx.strokeText(props.name, canvas.width / 2, canvas.height / 2)
  ctx.fillStyle = props.color
  ctx.fillText(props.name, canvas.width / 2, canvas.height / 2)
  texture.needsUpdate = true
}, { immediate: true })

let disposed = false
function dispose() {
  if (disposed) return
  disposed = true
  texture.dispose()
  material.dispose()
}
defineExpose({ dispose })
onBeforeUnmount(dispose)
</script>

<template>
  <TresSprite
    :name="`Nameplate_${name}`"
    :position="position"
    :scale="scale"
    :material="material"
    :dispose="null"
  />
</template>
