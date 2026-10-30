import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Scene, Texture } from 'three'
import { createTownMaterials } from '../app/utils/townMaterials'
import { createChunkProps } from '../app/utils/chunkProps'
import { createCourtyardScene } from '../app/utils/courtyardScene'

// Texture generation needs a canvas; sharing behavior needs only texture identity.
vi.mock('../app/utils/materialTextures', () => ({
  createMaterialTextures: () => Object.fromEntries(['stone', 'plaster', 'timber', 'terracotta', 'earth'].map(family => [family, {
    map: new Texture(), normalMap: new Texture(), roughnessMap: new Texture(),
  }])),
}))

vi.mock('../app/utils/courtyardTextures', () => ({ makeCourtyardSurface: () => new Texture(), makePlazaSurface: () => new Texture() }))

test('batch owners reuse material variants without disposing another owner’s material', () => {
  const materials = createTownMaterials()
  const source = new MeshStandardMaterial({ alphaTest: 0.5, map: new Texture() })
  const geometry = new BoxGeometry()
  const template = new Group().add(new Mesh(geometry, source))
  const templates = new Map([['tree1', template]])
  const time = { value: 0 }
  const first = createChunkProps({ templates, materials, foliageTime: time, seed: 1 })
  const second = createChunkProps({ templates, materials, foliageTime: time, seed: 1 })
  const a = first.instantiateModule('tree1', [new Matrix4()])!
  const b = second.instantiateModule('tree1', [new Matrix4()])!
  const shared = (a.children[0] as Mesh).material as MeshStandardMaterial
  const dispose = vi.fn()
  shared.addEventListener('dispose', dispose)
  try {
    assert.equal(shared, (b.children[0] as Mesh).material)
    assert.equal(shared.map, source.map)
    first.release(a)
    assert.equal(dispose.mock.calls.length, 0)
    second.release(b)
    materials.dispose()
    assert.equal(dispose.mock.calls.length, 1)
  }
  finally {
    materials.dispose()
    source.map?.dispose()
    source.dispose()
    geometry.dispose()
  }
})

test('shared batch shaders keep independent wind clocks and retain source textures', () => {
  const bank = createTownMaterials()
  const source = new MeshStandardMaterial({ alphaTest: 0.5, map: new Texture() })
  const firstTime = { value: 10 }
  const secondTime = { value: 20 }
  const first = bank.batch(source, firstTime)
  const second = bank.batch(source, secondTime)
  try {
    assert.equal(bank.batch(source, firstTime), first)
    assert.notEqual(first, second)
    assert.equal(first.map, source.map)
    assert.equal(first.customProgramCacheKey(), second.customProgramCacheKey(), 'uniform values must not split identical shader code')
    for (const [material, clock] of [[first, firstTime], [second, secondTime]] as const) {
      const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <emissivemap_fragment>' } as Parameters<typeof material.onBeforeCompile>[0]
      material.onBeforeCompile(shader, {} as Parameters<typeof material.onBeforeCompile>[1])
      assert.equal(shader.uniforms.foliageTime, clock)
    }
  }
  finally {
    bank.dispose()
    source.map?.dispose()
    source.dispose()
  }
})

test('garden rebuilds and streamed chunks borrow the same live foliage material', () => {
  const materials = createTownMaterials()
  const source = new MeshStandardMaterial({ alphaTest: 0.5 })
  const geometry = new BoxGeometry()
  const templates = new Map([['bush1', new Group().add(new Mesh(geometry, source))]])
  const foliageTime = { value: 0 }
  const chunks = createChunkProps({ templates, materials, foliageTime, seed: 1 })
  const chunk = chunks.instantiateModule('bush1', [new Matrix4()])!
  const shared = (chunk.children[0] as Mesh).material as MeshStandardMaterial
  const dispose = vi.fn()
  shared.addEventListener('dispose', dispose)
  try {
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const courtyard = createCourtyardScene([], templates, materials, foliageTime)
      let matches = 0
      courtyard.group.traverse((object) => {
        if (!(object instanceof Mesh) || object.geometry !== geometry) return
        matches++
        assert.equal(object.material, shared)
      })
      assert.ok(matches > 0, 'fixture must draw garden bushes')
      courtyard.dispose()
      assert.equal(dispose.mock.calls.length, 0, 'garden teardown must retain the chunk material')
    }
  }
  finally {
    chunks.release(chunk)
    materials.dispose()
    source.dispose()
    geometry.dispose()
  }
  assert.equal(dispose.mock.calls.length, 1)
})

test('garden grass stops submitting faded instances and returns after moving its parent', () => {
  const materials = createTownMaterials()
  const courtyard = createCourtyardScene([], new Map(), materials)
  let grass: InstancedMesh | undefined
  courtyard.group.traverse((object) => {
    if (object instanceof InstancedMesh && object.userData.grass) grass = object
  })
  try {
    assert.ok(grass, 'fixture must draw garden grass')
    courtyard.updateGrass(10000, 10000)
    assert.equal(grass.count, 0)
    courtyard.group.position.set(10000, 0, 10000)
    const { centerX, centerZ } = grass.userData.grass
    courtyard.updateGrass(10000 + centerX, 10000 + centerZ)
    assert.ok(grass.count > 0, 'parent transforms must be refreshed before the render')
  }
  finally {
    courtyard.dispose()
    materials.dispose()
  }
})

test('courtyard teardown empties and hides its attached root and disposes owned paving once', () => {
  const materials = createTownMaterials()
  const courtyard = createCourtyardScene([], new Map(), materials)
  const scene = new Scene().add(courtyard.group)
  const paving = courtyard.group.getObjectByName('Courtyard paving stones') as InstancedMesh
  const geometryDisposed = vi.fn()
  const materialDisposed = vi.fn()
  const instancesDisposed = vi.fn()
  const pavingMaterial = paving.material as MeshStandardMaterial
  paving.geometry.addEventListener('dispose', geometryDisposed)
  pavingMaterial.addEventListener('dispose', materialDisposed)
  paving.addEventListener('dispose', instancesDisposed)
  try {
    courtyard.dispose()
    courtyard.dispose()
    assert.equal(courtyard.group.visible, false, 'retiring roots must stop rendering immediately')
    assert.equal(courtyard.group.children.length, 0, 'no disposed scenery may remain drawable during Vue replacement')
    assert.equal(courtyard.group.parent, scene, 'Vue retains ownership of root attachment')
    assert.equal(geometryDisposed.mock.calls.length, 1)
    assert.equal(materialDisposed.mock.calls.length, 1)
    assert.equal(instancesDisposed.mock.calls.length, 1)
  }
  finally {
    courtyard.dispose()
    materials.dispose()
  }
})
