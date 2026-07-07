<script setup lang="ts">
import { PerspectiveCamera } from 'three'
import { useLoop, useTresContext } from '@tresjs/core'
import { buildPortal } from '~/utils/portal'

/**
 * The hub's teleport gate, staged for the menu. Geometry + animation come from
 * the shared `buildPortal` (so it matches the in-world hub exactly); here we
 * just drop it at the origin, skip the world light, and drive it with a fixed
 * hero camera that looks slightly down so the rune circles read as spinning
 * ellipses at the gate's foot.
 */
const portal = buildPortal({ light: false })

const { camera: cameraManager } = useTresContext()
const { onBeforeRender } = useLoop()

let elapsed = 0
onBeforeRender(({ delta }) => {
  elapsed += delta

  const cam = cameraManager.activeCamera.value
  if (cam instanceof PerspectiveCamera) {
    cam.fov = 42
    cam.position.set(0, 2.5, 7.4)
    cam.lookAt(0, 1.45, 0)
    cam.updateProjectionMatrix()
  }

  portal.update(elapsed, delta)
})
</script>

<template>
  <primitive :object="portal.root" />
</template>
