import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { CSM } from 'three/addons/csm/CSM.js'
import { BoxGeometry, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three'
import { SHADOW_CASCADES, createCascadedShadows, createCasterRange } from '../app/utils/shadows'
import { applyCharacterRim } from '../app/utils/characterRim'
import { applyFoliage } from '../app/utils/foliage'

test('shadow quality keeps two cascades at the requested map size', () => {
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 16 / 9, 0.1, 260)
  const shadows = createCascadedShadows(scene, camera)
  try {
    assert.equal(SHADOW_CASCADES, 2)
    assert.equal(shadows.lights.length, SHADOW_CASCADES)
    shadows.setQuality(1024, 100)
    for (const light of shadows.lights) {
      assert.equal(light.shadow.mapSize.x, 1024)
      assert.equal(light.shadow.mapSize.y, 1024)
    }
    shadows.update(camera, new Vector3(0.5, 1, 0.2), new Color('#ffffff'), 1, 1 / 60)
  }
  finally {
    shadows.dispose()
  }
})

test('new materials are registered when the scene version changes', () => {
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 16 / 9, 0.1, 260)
  const geometry = new BoxGeometry()
  const initialMaterial = new MeshStandardMaterial()
  scene.add(new Mesh(geometry, initialMaterial))
  const shadows = createCascadedShadows(scene, camera)
  const lateMaterial = new MeshStandardMaterial()
  try {
    assert.equal(initialMaterial.defines?.CSM_CASCADES, SHADOW_CASCADES)
    scene.add(new Mesh(geometry, lateMaterial))
    const traverse = vi.spyOn(scene, 'traverse')
    const update = () => shadows.update(camera, new Vector3(0.5, 1, 0.2), new Color('#ffffff'), 1, 1 / 60)
    update()
    assert.equal(traverse.mock.calls.length, 0)
    assert.equal(lateMaterial.defines?.USE_CSM, undefined)
    scene.userData.version = 1
    update()
    assert.equal(traverse.mock.calls.length, 1)
    assert.equal(lateMaterial.defines?.CSM_CASCADES, SHADOW_CASCADES)
    update()
    assert.equal(traverse.mock.calls.length, 1)
  }
  finally {
    shadows.dispose()
    initialMaterial.dispose()
    lateMaterial.dispose()
    geometry.dispose()
    vi.restoreAllMocks()
  }
})

test('rim installed before CSM survives teardown and is injected once after setup again', () => {
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 16 / 9, 0.1, 260)
  const geometry = new BoxGeometry()
  const material = new MeshStandardMaterial()
  scene.add(new Mesh(geometry, material))
  try {
    applyCharacterRim(scene)
    const rimCompile = material.onBeforeCompile
    const rimKey = material.customProgramCacheKey()
    const first = createCascadedShadows(scene, camera)
    first.dispose()
    assert.equal(material.userData.characterRim, true)
    applyCharacterRim(scene)
    assert.equal(material.onBeforeCompile, rimCompile)
    assert.equal(material.customProgramCacheKey(), rimKey)

    const second = createCascadedShadows(scene, camera)
    second.dispose()
    applyCharacterRim(scene)
    const shader = {
      uniforms: {},
      vertexShader: '',
      fragmentShader: '#include <common>\n#include <opaque_fragment>',
    } as Parameters<typeof material.onBeforeCompile>[0]
    material.onBeforeCompile(shader, {} as Parameters<typeof material.onBeforeCompile>[1])
    assert.equal(shader.fragmentShader.match(/uniform vec3 uRimSun;/g)?.length, 1)
  }
  finally {
    material.dispose()
    geometry.dispose()
  }
})

test('CSM teardown keeps older foliage hooks and clears newer ones for reinstall', () => {
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 16 / 9, 0.1, 260)
  const geometry = new BoxGeometry()
  const older = new MeshStandardMaterial()
  const newer = new MeshStandardMaterial()
  scene.add(new Mesh(geometry, older), new Mesh(geometry, newer))
  try {
    applyFoliage(older, { value: 0 })
    const olderCompile = older.onBeforeCompile
    const shadows = createCascadedShadows(scene, camera)
    applyFoliage(newer, { value: 0 })
    shadows.dispose()
    assert.equal(older.userData.foliageShader, true)
    assert.equal(older.onBeforeCompile, olderCompile)
    assert.equal(newer.userData.foliageShader, undefined)
    applyFoliage(newer, { value: 0 })
    assert.equal(newer.userData.foliageShader, true)
  }
  finally {
    older.dispose()
    newer.dispose()
    geometry.dispose()
  }
})

test('disposed materials leave the CSM registry and can be registered again', () => {
  const setup = vi.spyOn(CSM.prototype, 'setupMaterial')
  const scene = new Scene()
  const material = new MeshStandardMaterial()
  const geometry = new BoxGeometry()
  const mesh = new Mesh(geometry, material)
  scene.add(mesh)
  applyCharacterRim(mesh)
  const original = material.onBeforeCompile
  const shadows = createCascadedShadows(scene, new PerspectiveCamera())
  const csm = setup.mock.contexts[0] as CSM
  try {
    assert.equal(csm.shaders.has(material), true)
    scene.remove(mesh)
    material.dispose()
    assert.equal(csm.shaders.has(material), false, 'a retired material must not retain its shader/uniforms')
    assert.equal(material.onBeforeCompile, original)
    assert.equal(material.defines?.USE_CSM, undefined)
    scene.add(mesh)
    shadows.setupScene(scene)
    assert.equal(csm.shaders.has(material), true)
    assert.equal(material.defines?.CSM_CASCADES, SHADOW_CASCADES)
  }
  finally {
    shadows.dispose()
    material.dispose()
    geometry.dispose()
    setup.mockRestore()
  }
})

test('a caster stops casting out of range and only undoes its own work', () => {
  const scene = new Scene()
  // Half a unit across: out of reach past the 20 unit floor.
  const crate = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial())
  const keep = new Mesh(new BoxGeometry(40, 40, 40), new MeshStandardMaterial())
  const silent = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial())
  crate.castShadow = keep.castShadow = true
  silent.castShadow = false
  scene.add(crate, keep, silent)
  scene.updateMatrixWorld(true)
  const range = createCasterRange(scene)
  const eye = new Vector3(0, 0, 100)

  range.update(eye)
  assert.equal(crate.castShadow, false)
  assert.equal(keep.castShadow, true)
  assert.equal(silent.castShadow, false)

  // Coming back, it stays off until it is properly inside; going out again, it
  // stays on a little past the line, so pacing on the boundary flicks nothing.
  range.update(eye.set(0, 0, 21))
  assert.equal(crate.castShadow, false)
  range.update(eye.set(0, 0, 19))
  assert.equal(crate.castShadow, true)
  range.update(eye.set(0, 0, 21))
  assert.equal(crate.castShadow, true)
  range.update(eye.set(0, 0, 5))
  // Never cast, so it is never given a shadow.
  assert.equal(silent.castShadow, false)

  // Switched off by someone else while in range: coming back changes nothing.
  crate.castShadow = false
  range.update(eye.set(0, 0, 100))
  range.update(eye.set(0, 0, 5))
  assert.equal(crate.castShadow, false)

  // A rescan puts back what this switched off before it rebuilds its list.
  crate.castShadow = true
  scene.userData.version = 1
  range.update(eye.set(0, 0, 100))
  assert.equal(crate.castShadow, false)
  scene.userData.version = 2
  range.update(eye.set(0, 0, 5))
  assert.equal(crate.castShadow, true)

  range.update(eye.set(0, 0, 100))
  range.dispose()
  assert.equal(crate.castShadow, true)
})
