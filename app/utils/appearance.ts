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
 * cloned so a swap never leaks into the shared template. Preview clones are
 * isolated; the arena shares identical variants through a scene-owned pool.
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

function cloneVariant(material: MeshStandardMaterial, map: Texture): MeshStandardMaterial {
  const cloned = material.clone()
  // Cloning copies userData but not its shader callbacks. The scene installs
  // the rim and CSM hooks on the variant when it first mounts.
  delete cloned.userData.characterRim
  // Never inherit a scene's CSM defines without its uniforms and callback.
  if (cloned.defines) {
    delete cloned.defines.USE_CSM
    delete cloned.defines.CSM_CASCADES
    delete cloned.defines.CSM_FADE
  }
  cloned.map = map
  cloned.needsUpdate = true
  return cloned
}

/** Visit each source material once per rig, even across multiple submeshes. */
function swapCloth(root: Object3D, variant: (source: MeshStandardMaterial) => MeshStandardMaterial): MeshStandardMaterial[] {
  const swapped = new Map<MeshStandardMaterial, MeshStandardMaterial>()
  function swap(material: MeshStandardMaterial) {
    if (!CLOTH.test(material.name)) return material
    let result = swapped.get(material)
    if (!result) {
      result = variant(material)
      swapped.set(material, result)
    }
    return result
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
  return [...swapped.values()]
}

/** Isolated preview materials. Callers own these clones, never their maps. */
export function applyOutfitColor(root: Object3D, url: string | null): MeshStandardMaterial[] {
  if (!url) return []
  const map = texture(url)
  return swapCloth(root, source => cloneVariant(source, map))
}

/** Identical outfits share a material within one live scene. Templates and
 * texture-cache entries remain owned by the asset loader, while each rig holds
 * one lease per source material. Releasing the last lease frees that variant. */
export function createOutfitMaterialPool() {
  interface Entry { material: MeshStandardMaterial, users: number }
  const variants = new Map<MeshStandardMaterial, Map<string, Entry>>()
  let disposed = false

  return {
    apply(root: Object3D, url: string | null) {
      if (disposed) throw new Error('Cannot acquire outfit materials from a disposed scene')
      if (!url) return { materials: [] as MeshStandardMaterial[], release() {} }
      const map = texture(url)
      const leases: { source: MeshStandardMaterial, entry: Entry }[] = []
      const materials = swapCloth(root, (source) => {
        let colors = variants.get(source)
        if (!colors) {
          colors = new Map()
          variants.set(source, colors)
        }
        let entry = colors.get(url)
        if (!entry) {
          entry = { material: cloneVariant(source, map), users: 0 }
          colors.set(url, entry)
        }
        entry.users++
        leases.push({ source, entry })
        return entry.material
      })
      let released = false
      return {
        materials,
        release() {
          if (released || disposed) return
          released = true
          for (const { source, entry } of leases) {
            if (--entry.users !== 0) continue
            const colors = variants.get(source)!
            colors.delete(url)
            if (!colors.size) variants.delete(source)
            entry.material.dispose()
          }
        },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const colors of variants.values()) {
        for (const entry of colors.values()) entry.material.dispose()
      }
      variants.clear()
    },
  }
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
