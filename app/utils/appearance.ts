import { Mesh, MeshStandardMaterial, SRGBColorSpace, TextureLoader } from 'three'
import type { Object3D, Texture } from 'three'

/**
 * Swap a character's outfit cloth to an alternate colorway from the texture
 * pack (the designed variants — not a dye). `url` null means the baked default
 * (no-op). Only the cloth materials (`MI_Peasant*` / `MI_Ranger*`) are touched;
 * skin/hair/face keep their textures.
 *
 * The alt texture reuses the same UV atlas as the baked one, so it just
 * replaces `material.map` (glTF convention: flipY = false, sRGB). Materials are
 * cloned per rig so a swap never leaks into the shared template or other players.
 * The clones are returned so the caller can dispose them with the rig.
 */
const CLOTH = /^MI_(Peasant|Ranger)/

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
