import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, vi } from 'vitest'
import { Group, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Texture } from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { createGltfResourcePool } from '../app/utils/gltfResources'

interface EmbeddedGltfJson {
  images: Array<{ name?: string, bufferView: number }>
  bufferViews: Array<{ byteOffset?: number, byteLength: number }>
  textures: Array<{ source?: number, extensions?: { EXT_texture_webp?: { source: number } } }>
}

function embeddedLeaf(file: string) {
  const bytes = readFileSync(new URL(`../public/models/nature/${file}.glb`, import.meta.url))
  let offset = 12
  let json: EmbeddedGltfJson = { images: [], bufferViews: [], textures: [] }
  let binary = Buffer.alloc(0)
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset)
    const kind = bytes.toString('ascii', offset + 4, offset + 8)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (kind === 'JSON') json = JSON.parse(chunk.toString('utf8')) as EmbeddedGltfJson
    if (kind === 'BIN\0') binary = chunk
    offset += length + 8
  }
  const imageIndex = json.images.findIndex((image: { name?: string }) => image.name === 'Leaves_NormalTree_C')
  assert.notEqual(imageIndex, -1)
  const view = json.bufferViews[json.images[imageIndex].bufferView]
  const image = Uint8Array.from(binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
  const textureIndex = json.textures.findIndex((texture: { source?: number, extensions?: { EXT_texture_webp?: { source: number } } }) =>
    (texture.extensions?.EXT_texture_webp?.source ?? texture.source) === imageIndex)
  assert.notEqual(textureIndex, -1)
  return { json, image, textureIndex }
}

function fixture(image: Uint8Array, textureIndex: number, json: EmbeddedGltfJson, name = 'Leaf') {
  const map = new Texture()
  map.name = 'Leaves_NormalTree_C'
  map.flipY = false
  map.colorSpace = SRGBColorSpace
  const material = new MeshStandardMaterial({ map })
  material.name = name
  const scene = new Group()
  scene.add(new Mesh(undefined, material))
  const parser = {
    json,
    associations: new Map([[map, { textures: textureIndex }]]),
    getDependency: async () => image.buffer,
  }
  const gltf = { scene, scenes: [scene], parser } as unknown as GLTF
  return { gltf, map, material, mesh: scene.children[0] as Mesh }
}

test('real leaf images in separate shipped GLBs share one texture instance', async () => {
  const bush = embeddedLeaf('bush1')
  const tree = embeddedLeaf('tree1')
  assert.equal(createHash('sha256').update(bush.image).digest('hex'), 'd904de42f2f02ed21e2c5d9cfcc61804cc2cd57e80a9872e549b0b003296c3ac')
  assert.deepEqual(bush.image, tree.image)
  const first = fixture(bush.image, bush.textureIndex, bush.json)
  const second = fixture(tree.image, tree.textureIndex, tree.json)
  const pool = createGltfResourcePool({ materials: false })
  const redundantDispose = vi.spyOn(second.map, 'dispose')
  try {
    await pool.canonicalize(first.gltf)
    await pool.canonicalize(second.gltf)
    assert.equal(second.material.map, first.map)
    assert.equal(redundantDispose.mock.calls.length, 1)
    assert.equal(pool.ownsTexture(first.map), true)
    assert.equal(pool.ownsTexture(second.map), false)
  }
  finally {
    pool.dispose()
    first.material.dispose()
    second.material.dispose()
  }
})

test('texture state and material name prevent unsafe aliasing', async () => {
  const leaf = embeddedLeaf('bush1')
  const first = fixture(leaf.image, leaf.textureIndex, leaf.json)
  const same = fixture(leaf.image, leaf.textureIndex, leaf.json)
  const changedWrap = fixture(leaf.image, leaf.textureIndex, leaf.json)
  changedWrap.map.wrapS = RepeatWrapping
  const changedTransform = fixture(leaf.image, leaf.textureIndex, leaf.json)
  changedTransform.map.offset.x = 0.25
  const changedName = fixture(leaf.image, leaf.textureIndex, leaf.json, 'OtherLeaf')
  const pool = createGltfResourcePool()
  try {
    for (const item of [first, same, changedWrap, changedTransform, changedName]) await pool.canonicalize(item.gltf)
    assert.equal(same.mesh.material, first.material)
    assert.equal(same.material.map, first.map)
    assert.notEqual(changedWrap.mesh.material, first.material)
    assert.notEqual(changedWrap.material.map, first.map)
    assert.notEqual(changedTransform.material.map, first.map)
    assert.equal(changedName.material.map, first.map)
    assert.notEqual(changedName.mesh.material, first.material)
  }
  finally {
    pool.dispose()
  }
})

test('a material already shared by two meshes is never disposed as its own duplicate', async () => {
  const leaf = embeddedLeaf('bush1')
  const item = fixture(leaf.image, leaf.textureIndex, leaf.json)
  item.gltf.scene.add(new Mesh(undefined, item.material))
  const dispose = vi.spyOn(item.material, 'dispose')
  const pool = createGltfResourcePool()
  try {
    await pool.canonicalize(item.gltf)
    await pool.canonicalize(item.gltf)
    assert.equal(item.gltf.scene.children.length, 2)
    assert.equal((item.gltf.scene.children[0] as Mesh).material, item.material)
    assert.equal((item.gltf.scene.children[1] as Mesh).material, item.material)
    assert.equal(dispose.mock.calls.length, 0)
  }
  finally {
    pool.dispose()
  }
  assert.equal(dispose.mock.calls.length, 1)
})

test('late digest after pool disposal leaves GLTF ownership with the caller', async () => {
  const leaf = embeddedLeaf('bush1')
  const item = fixture(leaf.image, leaf.textureIndex, leaf.json)
  let release!: (bytes: ArrayBuffer) => void
  item.gltf.parser.getDependency = () => new Promise((resolve) => {
    release = resolve
  })
  const pool = createGltfResourcePool()
  const pending = pool.canonicalize(item.gltf)
  pool.dispose()
  release(leaf.image.buffer)
  await pending
  assert.equal(pool.ownsTexture(item.map), false)
  assert.equal(pool.ownsMaterial(item.material), false)
  assert.equal(item.mesh.material, item.material)
  item.material.dispose()
  item.map.dispose()
})
