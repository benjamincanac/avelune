import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'vitest'
import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Texture, Vector3 } from 'three'
import { createCityMoat } from '../app/utils/cityMoat'
import type { TownMaterials } from '../app/utils/townMaterials'

/** World-space vertex fingerprints were captured from the separate-mesh moat.
 * They protect the banks, steps, and bridge from moving during batching. */
test('batched stonework keeps the original moat geometry', () => {
  const stoneMap = new Texture()
  const materials = { apply: (material: MeshStandardMaterial) => material } as TownMaterials
  const moat = createCityMoat(stoneMap, materials)
  try {
    moat.group.updateMatrixWorld(true)
    const byColor = new Map<string, string[]>()
    let stoneworkMeshes = 0
    moat.group.traverse((object) => {
      if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial) || object.material instanceof MeshPhysicalMaterial) return
      stoneworkMeshes++
      assert.equal(object.castShadow, true)
      assert.equal(object.receiveShadow, true)
      const color = object.material.color.getHexString()
      const points = byColor.get(color) ?? []
      const position = object.geometry.getAttribute('position')
      const point = new Vector3()
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld)
        points.push(`${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`)
      }
      byColor.set(color, points)
    })
    const signatures = [...byColor].map(([color, points]) => {
      const digest = createHash('sha256').update(points.sort().join('|')).digest('hex')
      return [color, points.length, digest]
    }).sort(([a], [b]) => String(a).localeCompare(String(b)))
    assert.equal(stoneworkMeshes, 10)
    assert.deepEqual(signatures, [
      ['64816c', 96, '0caa81bc32b575647202a4a29bd2cd9b774c103a27b484835d414e4f40bd7f31'],
      ['657e71', 432, 'ba12d9c7baed1ab46bf445351e822914bb2f80c2a8956bda031f78aca6b230e8'],
      ['a8b3ad', 1824, '87b9f6d2ec898610079e3a76afea49fefa7e5b64d58448c0346e7a00c7333c19'],
      ['c4c9b9', 768, '74222f5a7d256d115d7bca3e09a62a30084bea9612ef235fdf7b4780803b2abf'],
    ])
  }
  finally {
    moat.dispose()
    stoneMap.dispose()
  }
})
