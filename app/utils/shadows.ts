import { MeshStandardMaterial, Vector3 } from 'three'
import type { Color, Material, Object3D, PerspectiveCamera, Scene } from 'three'
import { CSM } from 'three/addons/csm/CSM.js'

/** Two splits retain a sharp near field and a shadowed horizon while avoiding
 * a third scene render on every frame. Keep this explicit for visual A/Bs. */
export const SHADOW_CASCADES = 2

type Hookable = Material & {
  onBeforeCompile: NonNullable<Material['onBeforeCompile']>
  customProgramCacheKey: NonNullable<Material['customProgramCacheKey']>
}

/**
 * Cascaded shadow maps for the town's sun.
 *
 * The cascade lights *are* the sun: the CSM shader patch rewrites the
 * directional-light loop so exactly one cascade lights each fragment, and it
 * assumes every directional light in the scene is one of its cascades. Another
 * DirectionalLight would fall outside `NUM_DIR_LIGHT_SHADOWS` and contribute no
 * direct light at all, so the caller must not keep a separate sun.
 *
 * `setupMaterial` overwrites `material.onBeforeCompile`, which several town
 * materials already use (world-projected pigment, GPU grass wind). Every patch
 * here chains the previous hook in front of CSM's and extends the program cache
 * key so CSM and non-CSM variants never share a compiled program.
 */
export function createCascadedShadows(scene: Scene, camera: PerspectiveCamera) {
  const csm = new CSM({
    parent: scene,
    camera,
    cascades: SHADOW_CASCADES,
    maxFar: 120,
    mode: 'practical',
    shadowMapSize: 2048,
    shadowBias: -0.00016,
    lightIntensity: 1,
    lightMargin: 80,
    lightDirection: new Vector3(-1, -1, -1).normalize(),
  })
  // Set before any material is patched: `setupMaterial` bakes CSM_FADE in.
  csm.fade = true
  csm.updateFrustums()
  for (const light of csm.lights) light.shadow.normalBias = 0.028

  const patched = new WeakSet<Material>()
  // Weak: a material that the scene has dropped must not be kept alive by the
  // restore bookkeeping. `csm.shaders` is the enumerable list of what to restore.
  const originals = new WeakMap<Material, {
    compile: Hookable['onBeforeCompile']
    key: Hookable['customProgramCacheKey']
    characterRim: unknown
    foliageShader: unknown
    release: () => void
  }>()
  const cacheSuffix = `|csm${csm.cascades}${csm.fade ? 'f' : ''}`

  function setupMaterial(material: Hookable) {
    if (patched.has(material)) return
    patched.add(material)
    const compile = material.onBeforeCompile
    const key = material.customProgramCacheKey
    originals.set(material, {
      compile,
      key,
      characterRim: material.userData.characterRim,
      foliageShader: material.userData.foliageShader,
      release: () => releaseMaterial(material),
    })
    csm.setupMaterial(material)
    const inject = material.onBeforeCompile
    material.onBeforeCompile = function (shader, renderer) {
      compile.call(this, shader, renderer)
      inject.call(this, shader, renderer)
    }
    material.customProgramCacheKey = function () {
      return key.call(this) + cacheSuffix
    }
    material.addEventListener('dispose', originals.get(material)!.release)
    material.needsUpdate = true
  }

  // CSM's registry is strong: disposed chunk/outfit materials would otherwise
  // keep shaders and uniforms alive until the entire world is torn down.
  function releaseMaterial(material: Hookable) {
    const hooks = originals.get(material)
    if (!hooks) return
    material.removeEventListener('dispose', hooks.release)
    // @types/three calls these strings, but CSM stores compile parameters.
    const shader = csm.shaders.get(material) as unknown as Parameters<Hookable['onBeforeCompile']>[0] | null | undefined
    if (shader) {
      delete shader.uniforms.CSM_cascades
      delete shader.uniforms.cameraNear
      delete shader.uniforms.shadowFar
    }
    csm.shaders.delete(material)
    if (material.defines) {
      delete material.defines.USE_CSM
      delete material.defines.CSM_CASCADES
      delete material.defines.CSM_FADE
    }
    material.onBeforeCompile = hooks.compile
    material.customProgramCacheKey = hooks.key
    // Restore the guards with their hooks so a later mount injects each once.
    if (hooks.characterRim === undefined) delete material.userData.characterRim
    else material.userData.characterRim = hooks.characterRim
    if (hooks.foliageShader === undefined) delete material.userData.foliageShader
    else material.userData.foliageShader = hooks.foliageShader
    originals.delete(material)
    patched.delete(material)
    material.needsUpdate = true
  }

  /** Patch every standard/physical material below `root`. Idempotent. */
  function setupScene(root: Object3D) {
    root.traverse((object) => {
      const material = (object as { material?: Material | Material[] }).material
      if (!material) return
      for (const entry of Array.isArray(material) ? material : [material]) {
        // MeshPhysicalMaterial extends MeshStandardMaterial, so both land here.
        if (entry instanceof MeshStandardMaterial) setupMaterial(entry as Hookable)
      }
    })
  }
  setupScene(scene)
  // MazeScene bumps this when a chunk, floor, or rig changes. An explicit
  // setupScene call still covers a newly added rig before the next render.
  let scannedVersion = typeof scene.userData.version === 'number' ? scene.userData.version : 0

  const direction = new Vector3()
  let frustumCamera: PerspectiveCamera | null = camera
  let frustumKey = ''

  return {
    lights: csm.lights,
    setupScene,
    /**
     * How sharp the cascades are and how far they reach, from the graphics
     * settings. Dropping a light's map releases it so three allocates the new
     * size on the next shadow pass, and a new `maxFar` has to re-split the
     * cascades or they keep covering the old distance.
     *
     * Turning shadows *off* is not here: that is `renderer.shadowMap.enabled`,
     * which leaves `castShadow` alone so CSM's patched light loop still lights
     * the town from the cascade it can no longer sample.
     */
    setQuality(mapSize: number, maxFar: number) {
      if (csm.maxFar !== maxFar) {
        csm.maxFar = maxFar
        csm.updateFrustums()
      }
      // CSM uses this field to snap cascade centres to shadow-map texels.
      // Updating the lights alone would leave Medium's 1024px maps snapped
      // on the old 2048px grid and make their shadows shimmer in motion.
      csm.shadowMapSize = mapSize
      for (const light of csm.lights) {
        if (light.shadow.mapSize.x === mapSize) continue
        light.shadow.mapSize.setScalar(mapSize)
        light.shadow.map?.dispose()
        light.shadow.map = null
      }
    },
    /**
     * `sunDirection` points from the town toward the sun (the sky module's
     * convention); CSM wants the direction light travels.
     */
    update(activeCamera: PerspectiveCamera, sunDirection: Vector3, color: Color, intensity: number, _delta: number) {
      const key = `${activeCamera.fov}|${activeCamera.aspect}|${activeCamera.near}|${activeCamera.far}`
      if (frustumCamera !== activeCamera || frustumKey !== key) {
        frustumCamera = activeCamera
        frustumKey = key
        csm.camera = activeCamera
        csm.updateFrustums()
      }
      direction.copy(sunDirection).negate()
      // A sun straight overhead is parallel to `up`, which degenerates CSM's
      // light-space basis and silently drops every shadow. Nudge sideways, not
      // vertically: scaling y alone leaves a (0, -1, 0) direction unchanged
      // once it is renormalised.
      if (direction.x * direction.x + direction.z * direction.z < 1e-4) direction.x += 0.03
      csm.lightDirection.copy(direction).normalize()
      for (const light of csm.lights) {
        light.color.copy(color)
        light.intensity = intensity
      }
      csm.update()
      const version = typeof scene.userData.version === 'number' ? scene.userData.version : 0
      if (version !== scannedVersion) {
        scannedVersion = version
        setupScene(scene)
      }
    },
    dispose() {
      for (const material of [...csm.shaders.keys()]) releaseMaterial(material as Hookable)
      csm.dispose()
      csm.remove()
      for (const light of csm.lights) light.shadow.dispose()
    },
  }
}

export type CascadedShadows = ReturnType<typeof createCascadedShadows>
