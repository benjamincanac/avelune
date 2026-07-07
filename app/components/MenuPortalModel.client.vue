<script setup lang="ts">
import { PerspectiveCamera, Vector3 } from 'three'
import { useLoop, useTresContext } from '@tresjs/core'
import { buildPortal } from '~/utils/portal'

/**
 * The hub's teleport gate, staged for the menu. Geometry + animation come from
 * the shared `buildPortal` (so it matches the in-world hub exactly); here we
 * just drop it at the origin, skip the world light, and drive it with a fixed
 * hero camera that looks slightly down so the rune circles read as spinning
 * ellipses at the gate's foot. The rift itself is unlit + additive, but the
 * stone gate around it is standard-material — the cool hemisphere + warm key
 * below stand in for the hub's sky and sun.
 */
const portal = buildPortal({ light: false })

// A Vector3 instance so the Tres light position prop type-checks.
const keyLightPosition = new Vector3(3.5, 6, 5)

const { camera: cameraManager } = useTresContext()
const { onBeforeRender } = useLoop()

let elapsed = 0
onBeforeRender(({ delta }) => {
  elapsed += delta

  const cam = cameraManager.activeCamera.value
  if (cam instanceof PerspectiveCamera) {
    cam.fov = 42
    cam.position.set(0, 3.1, 9.2)
    cam.lookAt(0, 1.9, 0)
    cam.updateProjectionMatrix()
  }

  portal.update(elapsed, delta)
})
</script>

<template>
  <primitive :object="portal.root" />
  <TresHemisphereLight :args="['#cfe2ff', '#2c2a3a', 1.1]" />
  <TresDirectionalLight
    :position="keyLightPosition"
    :intensity="1.6"
    color="#fff2dd"
  />
</template>
