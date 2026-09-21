import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { BoxGeometry, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three'
import { SHADOW_CASCADES, createCascadedShadows } from '../app/utils/shadows'
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
