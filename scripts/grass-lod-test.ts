import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { Group, Sphere } from 'three'
import { createGrassBank, GRASS_FADE_END, setGrassDetail, updateGrassLod } from '../app/utils/courtyardLandscape'

afterEach(() => setGrassDetail(1, 1))

test('fully faded grass submits no instances and recovers when the camera returns', () => {
  const bank = createGrassBank({ value: 0 })
  const patch = bank.patch(Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: 0, z: Math.floor(i / 10), angle: 0, size: 1 })))!
  try {
    updateGrassLod(patch, 4, 4)
    assert.equal(patch.count, 100)
    updateGrassLod(patch, 1000, 1000)
    assert.equal(patch.count, 0)
    updateGrassLod(patch, 4, 4)
    assert.equal(patch.count, 100)
  }
  finally {
    patch.dispose()
    bank.dispose()
  }
})

test('fade rejection uses fresh world transforms and keeps the padded boundary', () => {
  const bank = createGrassBank({ value: 0 })
  const patch = bank.patch([{ x: 0, y: 0, z: 0, angle: 0, size: 2 }])!
  const parent = new Group().add(patch)
  try {
    // No render or manual matrix update between moving the parent and the LOD call.
    parent.position.set(300, 0, -200)
    parent.scale.setScalar(2)
    updateGrassLod(patch, 300, -200)
    assert.equal(patch.count, 1)
    const bounds = new Sphere().copy(patch.boundingSphere!).applyMatrix4(patch.matrixWorld)
    const edge = bounds.center.x + bounds.radius + GRASS_FADE_END
    updateGrassLod(patch, edge - 0.01, bounds.center.z)
    assert.equal(patch.count, 1, 'keep the conservative fade boundary to avoid visible popping')
    updateGrassLod(patch, edge + 0.01, bounds.center.z)
    assert.equal(patch.count, 0)
    parent.position.x += 100
    updateGrassLod(patch, parent.position.x, parent.position.z)
    assert.equal(patch.count, 1, 'moving a culled patch must restore it before the next render')
  }
  finally {
    patch.dispose()
    bank.dispose()
  }
})

test('grass fade culling follows range settings without rebuilding the patch', () => {
  const bank = createGrassBank({ value: 0 })
  const patch = bank.patch([{ x: 0, y: 0, z: 0, angle: 0, size: 1 }])!
  try {
    setGrassDetail(1, 1)
    updateGrassLod(patch, 45, 0)
    assert.equal(patch.count, 1)
    setGrassDetail(0.3, 0.5)
    updateGrassLod(patch, 45, 0)
    assert.equal(patch.count, 0)
    setGrassDetail(1, 1)
    updateGrassLod(patch, 45, 0)
    assert.equal(patch.count, 1)
  }
  finally {
    patch.dispose()
    bank.dispose()
  }
})
