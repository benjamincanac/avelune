import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, TextureLoader } from 'three'
import { applyOutfitColor, createOutfitMaterialPool } from '../app/utils/appearance'
import { applyCharacterRim } from '../app/utils/characterRim'

afterEach(() => vi.restoreAllMocks())

function rig(material: MeshStandardMaterial) {
  const root = new Group()
  const geometry = new BoxGeometry()
  root.add(new Mesh(geometry, material), new Mesh(geometry, material))
  return root
}

function cloth() {
  const material = new MeshStandardMaterial()
  material.name = 'MI_Peasant.001'
  return material
}

function stubTextures() {
  vi.spyOn(TextureLoader.prototype, 'load').mockImplementation(() => new Texture())
}

test('matching outfits share one material across rigs and preserve cached geometry and textures', () => {
  stubTextures()
  const source = cloth()
  const pool = createOutfitMaterialPool()
  const first = rig(source)
  const second = first.clone(true)
  const geometry = (first.children[0] as Mesh).geometry
  const a = pool.apply(first, '/test/shared-outfit.png')
  const b = pool.apply(second, '/test/shared-outfit.png')
  assert.equal(a.materials.length, 1)
  assert.equal(a.materials[0], b.materials[0])
  assert.equal((first.children[0] as Mesh).material, (first.children[1] as Mesh).material)
  assert.equal((second.children[0] as Mesh).geometry, geometry)
  assert.equal(source.map, null)
  assert.notEqual(a.materials[0], source)
  pool.dispose()
})

test('different outfit URLs and distinct source materials retain their own variants', () => {
  stubTextures()
  const source = cloth()
  const pool = createOutfitMaterialPool()
  const a = pool.apply(rig(source), '/test/red-outfit.png')
  const b = pool.apply(rig(source), '/test/blue-outfit.png')
  const c = pool.apply(rig(cloth()), '/test/red-outfit.png')
  assert.notEqual(a.materials[0], b.materials[0])
  assert.notEqual(a.materials[0]!.map, b.materials[0]!.map)
  assert.notEqual(a.materials[0], c.materials[0])
  assert.equal(a.materials[0]!.map, c.materials[0]!.map)
  pool.dispose()
})

test('only the last rig releases a shared variant, and repeated cleanup never disposes textures', () => {
  stubTextures()
  const source = cloth()
  const pool = createOutfitMaterialPool()
  const a = pool.apply(rig(source), '/test/leased-outfit.png')
  const b = pool.apply(rig(source), '/test/leased-outfit.png')
  const material = a.materials[0]!
  const dispose = vi.spyOn(material, 'dispose')
  const disposeTexture = vi.spyOn(material.map!, 'dispose')
  const disposeSource = vi.spyOn(source, 'dispose')
  a.release()
  a.release()
  assert.equal(dispose.mock.calls.length, 0)
  b.release()
  assert.equal(dispose.mock.calls.length, 1)
  pool.dispose()
  b.release()
  assert.equal(dispose.mock.calls.length, 1)
  assert.equal(disposeTexture.mock.calls.length, 0)
  assert.equal(disposeSource.mock.calls.length, 0)
})

test('scene disposal releases remaining leases once and a new acquisition recreates a released variant', () => {
  stubTextures()
  const source = cloth()
  const pool = createOutfitMaterialPool()
  const a = pool.apply(rig(source), '/test/recreated-outfit.png')
  a.release()
  const b = pool.apply(rig(source), '/test/recreated-outfit.png')
  assert.notEqual(a.materials[0], b.materials[0])
  const dispose = vi.spyOn(b.materials[0]!, 'dispose')
  pool.dispose()
  pool.dispose()
  b.release()
  assert.equal(dispose.mock.calls.length, 1)
  assert.throws(() => pool.apply(rig(source), '/test/recreated-outfit.png'), /disposed scene/)
})

test('variants rebuild rim hooks without inheriting another scene’s CSM defines', () => {
  stubTextures()
  const source = cloth()
  const template = rig(source)
  applyCharacterRim(template)
  source.defines.USE_CSM = 1
  source.defines.CSM_CASCADES = 3
  source.defines.CSM_FADE = ''
  const pool = createOutfitMaterialPool()
  const first = rig(source)
  const lease = pool.apply(first, '/test/shader-outfit.png')
  const variant = lease.materials[0]!
  assert.equal(variant.userData.characterRim, undefined)
  for (const key of ['USE_CSM', 'CSM_CASCADES', 'CSM_FADE']) assert.equal(key in variant.defines, false)
  assert.equal(source.defines.CSM_CASCADES, 3)
  applyCharacterRim(first)
  assert.equal(variant.userData.characterRim, true)
  const hook = variant.onBeforeCompile
  const second = rig(source)
  pool.apply(second, '/test/shader-outfit.png')
  applyCharacterRim(second)
  assert.equal(variant.onBeforeCompile, hook, 'sharing must not repeatedly chain the rim shader')
  pool.dispose()
})

test('default cloth, skin and isolated previews keep their ownership', () => {
  stubTextures()
  const source = cloth()
  const root = rig(source)
  const pool = createOutfitMaterialPool()
  const defaultOutfit = pool.apply(root, null)
  assert.deepEqual(defaultOutfit.materials, [])
  assert.equal((root.children[0] as Mesh).material, source)
  const skin = new MeshStandardMaterial()
  skin.name = 'Skin'
  const skinMesh = new Mesh(new BoxGeometry(), skin)
  root.add(skinMesh)
  const previewA = applyOutfitColor(root, '/test/preview-outfit.png')
  const previewB = applyOutfitColor(rig(source), '/test/preview-outfit.png')
  assert.notEqual(previewA[0], previewB[0])
  assert.equal(previewA[0]!.map, previewB[0]!.map)
  assert.equal(skinMesh.material, skin)
  defaultOutfit.release()
  pool.dispose()
  for (const material of [...previewA, ...previewB]) material.dispose()
})
