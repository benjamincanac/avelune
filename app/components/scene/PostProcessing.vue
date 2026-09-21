<script setup lang="ts">
import { WebGLRenderer } from 'three'
import { useLoop, useTresContext } from '@tresjs/core'
import { createCourtyardRenderer } from '~/utils/courtyardRenderer'
import type { RenderQuality } from '~/utils/courtyardRenderer'
import { createSceneDiagnostics } from '~/utils/sceneDiagnostics'

const props = defineProps<{ quality: RenderQuality }>()
const { renderer, scene, camera } = useTresContext()
const { onBeforeRender, render } = useLoop()
const diagnostics = import.meta.dev ? createSceneDiagnostics(scene.value) : null
let pipeline: ReturnType<typeof createCourtyardRenderer> | null = null
let disposed = false

// Resolution and shadow changes do not change the postprocessing chain. The
// composer follows renderer size itself; rebuild only when a pass changes. The
// source is a string because `quality` is a fresh object on every graphics
// change: an array of its fields would be a new array each time and fire anyway.
watch(() => `${props.quality.occlusion}|${props.quality.bloom}`, () => {
  pipeline?.dispose()
  pipeline = null
})

onBeforeRender(() => {
  if (!disposed && renderer.instance instanceof WebGLRenderer) diagnostics?.begin(renderer.instance)
}, -1000)

render((notify) => {
  if (disposed) return
  const gl = renderer.instance
  const active = camera.activeCamera.value
  if (!(gl instanceof WebGLRenderer) || !active) return
  pipeline ??= createCourtyardRenderer(gl, scene.value, active, props.quality)
  pipeline.render(active)
  diagnostics?.end()
  tickFps()
  notify()
})

// The canvas host calls this before disposing its renderer. The unmount hook
// also handles replacing just this component during development.
function dispose() {
  if (disposed) return
  disposed = true
  pipeline?.dispose()
  pipeline = null
  diagnostics?.dispose()
  resetFps()
}
defineExpose({ dispose })
onBeforeUnmount(dispose)
</script>

<template>
  <TresGroup name="Post_Processing" />
</template>
