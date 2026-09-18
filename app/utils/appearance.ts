import { Mesh, MeshStandardMaterial, SRGBColorSpace, TextureLoader } from 'three'
import type { Object3D, Texture } from 'three'
import { BEARD_MESH } from '#shared/utils/characters'

/**
 * Swap a character's outfit cloth to an alternate colorway from the texture
 * pack (the designed variants — not a dye). `url` null means the baked default
 * (no-op). Only the outfit materials (`MI_Peasant*`, `MI_Knight*`, …) are
 * touched; skin/hair/face keep their textures. The prefix match matters: the
 * importer suffixes the second copy of a shared material (`MI_Knight.001`), and
 * both copies are cloth.
 *
 * The alt texture reuses the same UV atlas as the baked one, so it just
 * replaces `material.map` (glTF convention: flipY = false, sRGB). Materials are
 * cloned per rig so a swap never leaks into the shared template or other players.
 * The clones are returned so the caller can dispose them with the rig.
 */
const CLOTH = /^MI_(Peasant|Ranger|Knight|Noble|Wizard)/

const loader = new TextureLoader()
const cache = new Map<string, Texture>()

function texture(url: string): Texture {
  let tex = cache.get(url)
  if (!tex) {
    tex = loader.load(url)
    tex.flipY = false
    tex.colorSpace = SRGBColorSpace
    cache.set(url, tex)
  }
  return tex
}

/** Warm the texture cache ahead of time (see the gate's preloading). */
export function preloadTexture(url: string): void {
  texture(url)
}

export function applyOutfitColor(root: Object3D, url: string | null): MeshStandardMaterial[] {
  if (!url) return []
  const map = texture(url)
  const clones = new Map<string, MeshStandardMaterial>()

  const swap = (material: MeshStandardMaterial): MeshStandardMaterial => {
    if (!CLOTH.test(material.name)) return material
    let cloned = clones.get(material.uuid)
    if (!cloned) {
      cloned = material.clone()
      // Cloning copies `userData` but not the hooks it marks, so the rim's own
      // guard would report a shader this material does not carry.
      delete cloned.userData.characterRim
      cloned.map = map
      cloned.needsUpdate = true
      clones.set(material.uuid, cloned)
    }
    return cloned
  }

  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(m => m instanceof MeshStandardMaterial ? swap(m) : m)
    }
    else if (obj.material instanceof MeshStandardMaterial) {
      obj.material = swap(obj.material)
    }
  })
  return [...clones.values()]
}

/**
 * Show or hide the beard. Every male GLB with an open face carries it as its own
 * node, visible as exported, so each rig sets the flag on its own clone.
 * `SkeletonUtils.clone` copies visibility, so this must never run on the shared
 * template. Females and the Knight carry no such node and the call does nothing.
 *
 * The importer suffixes a duplicated node (`Hair_Beard.001`), hence the prefix
 * match rather than an equality test.
 */
export function applyBeard(root: Object3D, visible: boolean): void {
  root.traverse((obj) => {
    if (obj.name.startsWith(BEARD_MESH)) obj.visible = visible
  })
}
