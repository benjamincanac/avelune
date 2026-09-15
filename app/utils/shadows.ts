import { MeshStandardMaterial, Vector3 } from 'three'
import type { Color, Material, Object3D, PerspectiveCamera, Scene } from 'three'
import { CSM } from 'three/addons/csm/CSM.js'

/** How often the scene is re-scanned for materials that still need the CSM
 *  shader injection. Templates finish loading and character rigs appear long
 *  after the world is first built, and a material that misses the injection
 *  reads all three cascade lights as separate suns. */
const SETUP_INTERVAL = 0.5

type Hookable = Material & {
  onBeforeCompile: NonNullable<Material['onBeforeCompile']>
  customProgramCacheKey: NonNullable<Material['customProgramCacheKey']>
}

/**
 * Cascaded shadow maps for the town's sun.
 *
 * The three cascade lights *are* the sun: the CSM shader patch rewrites the
 * directional-light loop so exactly one cascade lights each fragment, and it
 * assumes every directional light in the scene is one of its cascades. A fourth
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
    cascades: 3,
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
  const originals = new WeakMap<Material, { compile: Hookable['onBeforeCompile'], key: Hookable['customProgramCacheKey'] }>()
  const cacheSuffix = `|csm${csm.cascades}${csm.fade ? 'f' : ''}`

  function setupMaterial(material: Hookable) {
    if (patched.has(material)) return
    patched.add(material)
    const compile = material.onBeforeCompile
    const key = material.customProgramCacheKey
    originals.set(material, { compile, key })
    csm.setupMaterial(material)
    const inject = material.onBeforeCompile
    material.onBeforeCompile = function (shader, renderer) {
      compile.call(this, shader, renderer)
      inject.call(this, shader, renderer)
    }
    material.customProgramCacheKey = function () {
      return key.call(this) + cacheSuffix
    }
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

  const direction = new Vector3()
  // Starts expired so the very first update patches everything the world built
  // during setup, before the renderer has compiled any of it.
  let scanTimer = 0
  let frustumCamera: PerspectiveCamera | null = camera
  let frustumKey = ''

  return {
    lights: csm.lights,
    setupScene,
    /**
     * `sunDirection` points from the town toward the sun (the sky module's
     * convention); CSM wants the direction light travels.
     */
    update(activeCamera: PerspectiveCamera, sunDirection: Vector3, color: Color, intensity: number, delta: number) {
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
      scanTimer -= delta
      if (scanTimer <= 0) {
        scanTimer = SETUP_INTERVAL
        setupScene(scene)
      }
    },
    dispose() {
      // CSM.dispose deletes `onBeforeCompile` outright, taking the town's own
      // shader hooks with it — put them back afterwards. Its own material list
      // is cleared by that call, so snapshot it first.
      const materials = [...csm.shaders.keys()] as Hookable[]
      csm.dispose()
      csm.remove()
      for (const material of materials) {
        const hooks = originals.get(material)
        if (!hooks) continue
        material.onBeforeCompile = hooks.compile
        material.customProgramCacheKey = hooks.key
        // Hooks installed *after* the CSM patch (the character rim, the foliage
        // wind) chained onto it and went with it. Their `userData` guards would
        // otherwise report them as still installed and block a reinstall.
        delete material.userData.characterRim
        delete material.userData.foliageShader
        material.needsUpdate = true
      }
      for (const light of csm.lights) light.shadow.dispose()
    },
  }
}

export type CascadedShadows = ReturnType<typeof createCascadedShadows>
