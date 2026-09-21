import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three'

/** One flat bevel per edge keeps the paving silhouette and level top while
 * avoiding the rounded box's dense surface grid on thousands of tiny stones.
 * Six rectangular faces, twelve edge quads and eight corner triangles: 44
 * triangles total. Dimensions and bevel match the original paving stone. */
export function createPavingGeometry(): BufferGeometry {
  const half = [0.983 / 2, 0.045 / 2, 0.983 / 2] as const
  const inner = half.map(value => value - 0.014)
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const normal = new Vector3()
  const edge = new Vector3()
  const center = new Vector3()

  function face(points: Vector3[]) {
    normal.subVectors(points[1]!, points[0]!).cross(edge.subVectors(points[2]!, points[0]!)).normalize()
    center.set(0, 0, 0)
    for (const point of points) center.add(point)
    if (normal.dot(center) < 0) {
      points.reverse()
      normal.negate()
    }
    // Box-projected UVs retain a level, continuous top face and map the narrow
    // bevel faces without introducing another material or texture.
    const axis = Math.abs(normal.y) >= Math.abs(normal.x) && Math.abs(normal.y) >= Math.abs(normal.z) ? 1 : Math.abs(normal.x) >= Math.abs(normal.z) ? 0 : 2
    const u = axis === 0 ? 2 : 0
    const v = axis === 1 ? 2 : 1
    for (let i = 1; i < points.length - 1; i++) {
      for (const point of [points[0]!, points[i]!, points[i + 1]!]) {
        positions.push(point.x, point.y, point.z)
        normals.push(normal.x, normal.y, normal.z)
        uvs.push(point.getComponent(u) / (half[u]! * 2) + 0.5, point.getComponent(v) / (half[v]! * 2) + 0.5)
      }
    }
  }

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    for (const sign of [-1, 1]) {
      face([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => new Vector3()
        .setComponent(axis, sign * half[axis]!)
        .setComponent(u, su! * inner[u]!)
        .setComponent(v, sv! * inner[v]!)))
    }
    // Edges parallel to this axis join the neighboring rectangular faces.
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        face(([[-1, true], [1, true], [1, false], [-1, false]] as const).map(([along, outerU]) => new Vector3()
          .setComponent(axis, along * inner[axis]!)
          .setComponent(u, su * (outerU ? half[u]! : inner[u]!))
          .setComponent(v, sv * (outerU ? inner[v]! : half[v]!))))
      }
    }
  }
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        face([
          new Vector3(x * half[0], y * inner[1]!, z * inner[2]!),
          new Vector3(x * inner[0]!, y * half[1], z * inner[2]!),
          new Vector3(x * inner[0]!, y * inner[1]!, z * half[2]),
        ])
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.name = 'Paving stone with chamfered edges'
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
