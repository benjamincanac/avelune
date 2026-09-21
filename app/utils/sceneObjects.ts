import { Mesh, MeshStandardMaterial, PlaneGeometry } from 'three'
import type { Object3D } from 'three'

/** Batched terrain/grass already carry deliberate shadow flags. Respect them. */
export function tagSceneShadows(root: Object3D) {
  root.traverse((object) => {
    if (!(object instanceof Mesh) || object.userData.shadowTagged) return
    const opaque = object.material instanceof MeshStandardMaterial && !object.material.transparent
    object.castShadow = opaque && !(object.geometry instanceof PlaneGeometry)
    object.receiveShadow = opaque
  })
}
