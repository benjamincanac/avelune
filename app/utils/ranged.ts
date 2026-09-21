import type { BufferGeometry, Object3D, Sphere, Vector3 } from 'three'

/**
 * A mesh and the sphere it is culled by, kept so a per-frame pass can ask "is
 * this too far away to be worth a draw call" without touching the geometry.
 * Shared by the two passes that redraw the whole town for an effect only read
 * up close: the shadow cascades (`shadows.ts`) and GTAO's normal pass
 * (`courtyardRenderer.ts`).
 */
export interface Ranged {
  object: Object3D
  radius: number
  /** The bounding sphere's centre in the object's own space, so a rig that
   *  walks is followed without recomputing anything. */
  cx: number
  cy: number
  cz: number
}

/** Null for anything without a geometry to measure. */
export function measureRanged(object: Object3D): Ranged | null {
  const mesh = object as Object3D & { isInstancedMesh?: boolean, boundingSphere?: Sphere | null, computeBoundingSphere?: () => void, geometry?: BufferGeometry }
  // An InstancedMesh is culled as one batch, so its sphere is the one over
  // every instance rather than the geometry's.
  let sphere: Sphere | null | undefined
  if (mesh.isInstancedMesh) {
    if (!mesh.boundingSphere) mesh.computeBoundingSphere?.()
    sphere = mesh.boundingSphere
  }
  else {
    if (mesh.geometry && !mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
    sphere = mesh.geometry?.boundingSphere
  }
  if (!sphere) return null
  const e = object.matrixWorld.elements
  const scale = Math.max(Math.abs(e[0]!), Math.abs(e[5]!), Math.abs(e[10]!))
  return { object, radius: sphere.radius * scale, cx: sphere.center.x, cy: sphere.center.y, cz: sphere.center.z }
}

/**
 * Whether `focus` is within `spans` times the object's radius of it, with a
 * floor under that so nothing near the player is ever out of reach.
 *
 * `focus` is the player, not the camera. The boom orbits a player who is
 * standing still, and measured from the lens every mesh near the edge of its
 * range would come and go as the view swung round. `RANGE_SLACK` is for the
 * caller to pass once something is in range, so that a player pacing on the
 * boundary does not flick it either.
 */
export const RANGE_SLACK = 1.15

export function withinReach(entry: Ranged, focus: Vector3, spans: number, floor: number, slack = 1): boolean {
  const e = entry.object.matrixWorld.elements
  const x = e[0]! * entry.cx + e[4]! * entry.cy + e[8]! * entry.cz + e[12]! - focus.x
  const y = e[1]! * entry.cx + e[5]! * entry.cy + e[9]! * entry.cz + e[13]! - focus.y
  const z = e[2]! * entry.cx + e[6]! * entry.cy + e[10]! * entry.cz + e[14]! - focus.z
  const reach = Math.max(floor, entry.radius * spans) * slack
  return x * x + y * y + z * z <= reach * reach
}
