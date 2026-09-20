import { HalfFloatType, Sprite, Vector2, WebGLRenderTarget } from 'three'
import type { Camera, Object3D, Scene, WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/** A soft corner falloff, applied after tone mapping so it darkens the graded
 *  image rather than the linear radiance feeding bloom. */
const VignetteShader = {
  name: 'AveluneVignette',
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.25 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = length(vUv - 0.5) * 1.414;
      color.rgb *= mix(1.0, 1.0 - strength, smoothstep(0.45, 1.0, d));
      gl_FragColor = color;
    }
  `,
}

/** Bloom is reserved for emissive highlights. At night the lanterns, the
 *  fountain and the Oracle should carry a halo; in daylight almost nothing
 *  should, or lit stone smears. */
const BLOOM_DAY = { threshold: 1.25, strength: 0.13 }
const BLOOM_NIGHT = { threshold: 0.52, strength: 0.42 }

/** What the graphics settings let this pipeline spend. Read once, at build
 *  time: a pass cannot be added to a composer after the fact, so `MazeScene`
 *  rebuilds the pipeline rather than mutating it. */
export interface RenderQuality {
  /** MSAA samples on the target every pass reads from. */
  samples: number
  /** Ground-truth ambient occlusion. A whole extra scene pass, and the first
   *  thing to go on a machine that cannot hold the frame. */
  occlusion: boolean
  bloom: boolean
}

const FULL_QUALITY: RenderQuality = { samples: 4, occlusion: true, bloom: true }

/** A linear-light render pipeline. Contact shading grounds the detailed assets;
 * bloom is reserved for highlights, and tone mapping happens exactly once. */
export function createCourtyardRenderer(renderer: WebGLRenderer, scene: Scene, camera: Camera, quality: RenderQuality = FULL_QUALITY) {
  // A frame issues several `renderer.render` calls — the water's planar
  // reflection, the sky's cube capture, GTAO's normal override — and three
  // regenerates every shadow map on each one. With three shadow cascades that
  // is most of the frame spent redrawing the same maps, so drive them by hand,
  // exactly once per frame, at the top of the pipeline.
  const previousAutoUpdate = renderer.shadowMap.autoUpdate
  renderer.shadowMap.autoUpdate = false
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: quality.samples })
  const composer = new EffectComposer(renderer, target)
  const color = new RenderPass(scene, camera)
  // GTAO replaces materials with an opaque normal material. Sprite alpha maps
  // are lost in that pass, so nameplates would occlude as solid rectangles.
  // The atmosphere has no surface depth. Water has a fragment-clipped circular
  // footprint that the opaque normal override cannot reproduce. Alpha-cut leaf
  // cards (`userData.foliage`) would occlude as solid quads and halo every tree;
  // `userData.gtaoExclude` opts any other flat cosmetic (blob shadows) out too.
  function createOcclusion() {
    const occlusion = new GTAOPass(scene, camera, 1, 1)
    const renderOcclusion = occlusion.render.bind(occlusion)
    const hiddenObjects: Object3D[] = []
    // The list only changes when the scene does, so it is cached against the
    // version `MazeScene` bumps on a floor rebuild or a rig coming and going —
    // traversing the whole town every frame just to find a handful of sprites is
    // the kind of per-frame work this pipeline cannot afford.
    const excluded: Object3D[] = []
    let excludedVersion = -1
    const isExcluded = (object: Object3D) => object instanceof Sprite
      || object.name === 'courtyard-atmosphere'
      || object.userData.foliage || object.userData.gtaoExclude
      || object.userData.fountainSurface || object.userData.fountainCaustics || object.userData.waterRipple
    occlusion.render = (...args) => {
      const version = typeof scene.userData.version === 'number' ? scene.userData.version : 0
      if (version !== excludedVersion) {
        excludedVersion = version
        excluded.length = 0
        scene.traverse((object) => {
          if (isExcluded(object)) excluded.push(object)
        })
      }
      for (const object of excluded) {
        if (!object.visible) continue
        hiddenObjects.push(object)
        object.visible = false
      }
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
    return occlusion
  }

  const occlusion = quality.occlusion ? createOcclusion() : null
  const bloom = quality.bloom ? new UnrealBloomPass(new Vector2(1, 1), BLOOM_DAY.strength, 0.5, BLOOM_DAY.threshold) : null
  const output = new OutputPass()
  // SMAA and the vignette read the tone-mapped, sRGB-encoded image, which is
  // what SMAA's edge detection expects.
  const smaa = new SMAAPass()
  const vignette = new ShaderPass(VignetteShader)
  composer.addPass(color)
  if (occlusion) composer.addPass(occlusion)
  if (bloom) composer.addPass(bloom)
  composer.addPass(output)
  composer.addPass(smaa)
  composer.addPass(vignette)
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
      if (occlusion) occlusion.camera = activeCamera
      // `courtyardSky` publishes the clock here; the pipeline has no other
      // view of it and bloom has to follow the sun.
      if (bloom) {
        const dayness = typeof scene.userData.dayness === 'number' ? scene.userData.dayness : 1
        bloom.threshold = BLOOM_NIGHT.threshold + (BLOOM_DAY.threshold - BLOOM_NIGHT.threshold) * dayness
        bloom.strength = BLOOM_NIGHT.strength + (BLOOM_DAY.strength - BLOOM_NIGHT.strength) * dayness
      }
      // Everything drawn earlier this frame (reflections, the sky capture) has
      // already reused last frame's maps; refresh them for the main pass.
      renderer.shadowMap.needsUpdate = true
      composer.render()
    },
    dispose() {
      renderer.shadowMap.autoUpdate = previousAutoUpdate
      for (const pass of composer.passes) pass.dispose()
      composer.dispose()
    },
  }
}
