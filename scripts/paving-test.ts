import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { InstancedMesh, Texture, Vector3 } from 'three'
import { createCourtyardScene } from '../app/utils/courtyardScene'
import { createTownMaterials } from '../app/utils/townMaterials'
import { townPlacements } from '../shared/utils/world'
import { createPavingGeometry } from '../app/utils/pavingGeometry'

vi.mock('../app/utils/materialTextures', () => ({
  createMaterialTextures: () => Object.fromEntries(['stone', 'plaster', 'timber', 'terracotta', 'earth'].map(family => [family, {
    map: new Texture(), normalMap: new Texture(), roughnessMap: new Texture(),
  }])),
}))
vi.mock('../app/utils/courtyardTextures', () => ({ makeCourtyardSurface: () => new Texture(), makePlazaSurface: () => new Texture() }))

test('paving bevel is a watertight outward-facing box with exact bounds and a flat top', () => {
  const geometry = createPavingGeometry()
  try {
    const size = geometry.boundingBox!.getSize(new Vector3())
    for (const [actual, expected] of [[size.x, 0.983], [size.y, 0.045], [size.z, 0.983]]) assert.ok(Math.abs(actual! - expected!) < 1e-7)
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const uv = geometry.getAttribute('uv')
    assert.equal(position.count / 3, 44)
    const edges = new Map<string, { count: number, direction: number }>()
    let topTriangles = 0
    for (let i = 0; i < position.count; i += 3) {
      const points = [0, 1, 2].map(offset => new Vector3().fromBufferAttribute(position, i + offset))
      const cross = new Vector3().subVectors(points[1]!, points[0]!).cross(new Vector3().subVectors(points[2]!, points[0]!))
      assert.ok(cross.length() > 1e-8, 'no degenerate bevel triangles')
      assert.ok(cross.dot(points[0]!) > 0, 'every face winds outward from the box center')
      for (let vertex = 0; vertex < 3; vertex++) {
        const n = new Vector3().fromBufferAttribute(normal, i + vertex)
        assert.ok(n.dot(cross.clone().normalize()) > 0.99999, 'normals must match flat face winding')
        assert.ok(uv.getX(i + vertex) >= 0 && uv.getX(i + vertex) <= 1)
        assert.ok(uv.getY(i + vertex) >= 0 && uv.getY(i + vertex) <= 1)
        const a = points[vertex]!.toArray().join(',')
        const b = points[(vertex + 1) % 3]!.toArray().join(',')
        const key = [a, b].sort().join('|')
        const edge = edges.get(key) ?? { count: 0, direction: 0 }
        edge.count++
        edge.direction += a < b ? 1 : -1
        edges.set(key, edge)
      }
      if (points.every(point => Math.abs(point.y - 0.045 / 2) < 1e-7)) {
        topTriangles++
        assert.ok(new Vector3().fromBufferAttribute(normal, i).distanceTo(new Vector3(0, 1, 0)) < 1e-7)
      }
    }
    assert.equal(topTriangles, 2, 'top remains one flat rectangular face')
    for (const edge of edges.values()) {
      assert.equal(edge.count, 2, 'every geometric edge has exactly two incident triangles')
      assert.equal(edge.direction, 0, 'adjacent triangles traverse their common edge in opposite directions')
    }
  }
  finally {
    geometry.dispose()
  }
})

test.each([{ placements: [], count: 5950 }, { placements: townPlacements(), count: 5163 }])('courtyard paving keeps $count stones within its triangle budget', ({ placements, count }) => {
  const materials = createTownMaterials()
  const courtyard = createCourtyardScene(placements, new Map(), materials)
  let paving: InstancedMesh | undefined
  courtyard.group.traverse((object) => {
    if (!(object instanceof InstancedMesh)) return
    object.geometry.computeBoundingBox()
    const size = object.geometry.boundingBox!.getSize(new Vector3())
    if (Math.abs(size.x - 0.983) < 1e-6 && Math.abs(size.y - 0.045) < 1e-6 && Math.abs(size.z - 0.983) < 1e-6) paving = object
  })
  try {
    assert.ok(paving, 'the full authored paving must be present')
    assert.equal(paving.count, count, 'preserve every authored stone')
    const triangles = (paving.geometry.index?.count ?? paving.geometry.getAttribute('position').count) / 3
    assert.ok(triangles <= 60, `${triangles} triangles per stone repeats ${paving.count} times`)
    assert.ok(triangles * paving.count <= 60 * count)
  }
  finally {
    courtyard.dispose()
    materials.dispose()
  }
})
