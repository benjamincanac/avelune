import { HalfFloatType, Sprite, Vector2, WebGLRenderTarget } from 'three'
import type { Camera, Object3D, Scene, WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/** A linear-light render pipeline. Contact shading grounds the detailed assets;
 * bloom is reserved for highlights, and tone mapping happens exactly once. */
export function createCourtyardRenderer(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, target)
  const color = new RenderPass(scene, camera)
  const occlusion = new GTAOPass(scene, camera, 1, 1)
  // GTAO replaces materials with an opaque normal material. Sprite alpha maps
  // are lost in that pass, so nameplates would occlude as solid rectangles.
  // The atmosphere has no surface depth. Water has a fragment-clipped circular
  // footprint that the opaque normal override cannot reproduce.
  const renderOcclusion = occlusion.render.bind(occlusion)
  const hiddenObjects: Object3D[] = []
  occlusion.render = (...args) => {
    scene.traverse((object) => {
      if ((object instanceof Sprite || object.name === 'courtyard-atmosphere' || object.userData.fountainSurface) && object.visible) {
        hiddenObjects.push(object)
        object.visible = false
      }
    })
    try {
      renderOcclusion(...args)
    }
    finally {
      for (const object of hiddenObjects) object.visible = true
      hiddenObjects.length = 0
    }
  }
  occlusion.blendIntensity = 0.42
  occlusion.updateGtaoMaterial({ radius: 0.45, thickness: 0.6, distanceExponent: 1.5, distanceFallOff: 0.65, scale: 0.65, samples: 8 })
  occlusion.updatePdMaterial({ radius: 4, rings: 2, samples: 8 })
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.15, 0.35, 1.1)
  const output = new OutputPass()
  composer.addPass(color)
  composer.addPass(occlusion)
  composer.addPass(bloom)
  composer.addPass(output)
  const size = new Vector2()
  let width = 0
  let height = 0
  let ratio = 0
  return {
    render(activeCamera: Camera) {
      renderer.getSize(size)
      const dpr = Math.min(renderer.getPixelRatio(), 1.5)
      if (width !== size.x || height !== size.y || ratio !== dpr) {
        width = size.x
        height = size.y
        ratio = dpr
        composer.setPixelRatio(dpr)
        composer.setSize(width, height)
      }
      color.camera = activeCamera
      occlusion.camera = activeCamera
      composer.render()
    },
    dispose() {
      for (const pass of composer.passes) pass.dispose()
      composer.dispose()
    },
  }
}
