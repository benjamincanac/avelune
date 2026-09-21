import { Material, Mesh, MeshStandardMaterial, Texture } from 'three'
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/** GLTFLoader caches images and textures within one file, never across files. */
export function createGltfResourcePool(options: { materials?: boolean } = {}) {
  const textures = new Map<string, Texture>()
  const materials = new Map<string, MeshStandardMaterial>()
  const ownedTextures = new Set<Texture>()
  const ownedMaterials = new Set<MeshStandardMaterial>()
  let disposed = false

  /** Only plain data is eligible. An unknown mutable value must not alias. */
  function snapshot(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
    if (value instanceof Texture) return ['texture', value.uuid]
    if (Array.isArray(value)) {
      const values = value.map(snapshot)
      return values.some(item => item === undefined) ? undefined : values
    }
    if (typeof value !== 'object') return undefined
    if ('toArray' in value && typeof value.toArray === 'function') {
      return [value.constructor.name, value.toArray()]
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      const saved = snapshot(item)
      if (saved === undefined) return undefined
      result[key] = saved
    }
    return result
  }

  function textureKey(texture: Texture, hash: string): string | null {
    if (texture.constructor !== Texture || texture.onUpdate) return null
    const state = snapshot({
      name: texture.name,
      mapping: texture.mapping,
      channel: texture.channel,
      wrapS: texture.wrapS,
      wrapT: texture.wrapT,
      magFilter: texture.magFilter,
      minFilter: texture.minFilter,
      anisotropy: texture.anisotropy,
      format: texture.format,
      internalFormat: texture.internalFormat,
      type: texture.type,
      colorSpace: texture.colorSpace,
      flipY: texture.flipY,
      generateMipmaps: texture.generateMipmaps,
      premultiplyAlpha: texture.premultiplyAlpha,
      unpackAlignment: texture.unpackAlignment,
      offset: texture.offset,
      repeat: texture.repeat,
      center: texture.center,
      rotation: texture.rotation,
      matrixAutoUpdate: texture.matrixAutoUpdate,
      matrix: texture.matrix,
      userData: texture.userData,
    })
    return state === undefined ? null : `${hash}|${JSON.stringify(state)}`
  }

  function materialKey(material: MeshStandardMaterial): string | null {
    if (material.onBeforeCompile !== Material.prototype.onBeforeCompile
      || material.customProgramCacheKey !== Material.prototype.customProgramCacheKey) return null
    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(material)) {
      if (key === 'uuid' || key === 'id' || key === 'version' || key === '_listeners') continue
      data[key] = value
    }
    const state = snapshot(data)
    return state === undefined ? null : JSON.stringify(state)
  }

  async function canonicalize(gltf: GLTF): Promise<void> {
    if (disposed) return
    const parser = gltf.parser
    const images = parser.json.images as Array<{ bufferView?: number }> | undefined
    const definitions = parser.json.textures as Array<{ source?: number, extensions?: { EXT_texture_webp?: { source: number } } }> | undefined
    const sourceHashes = new Map<number, Promise<string>>()
    const candidates = new Map<Texture, Promise<string | null>>()
    const meshList: Mesh[] = []

    for (const scene of gltf.scenes) {
      scene.traverse((object) => {
        if (!(object instanceof Mesh)) return
        meshList.push(object)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          for (const value of Object.values(material)) {
            if (!(value instanceof Texture) || candidates.has(value)) continue
            const textureIndex = parser.associations.get(value)?.textures
            const definition = textureIndex === undefined ? undefined : definitions?.[textureIndex]
            const webpSource = definition?.extensions?.EXT_texture_webp?.source
            // If both alternatives exist, the selected browser decoder decides
            // which image was loaded. A hash of the other would be unsafe.
            if (webpSource !== undefined && definition?.source !== undefined && webpSource !== definition.source) continue
            const sourceIndex = webpSource ?? definition?.source
            const image = sourceIndex === undefined ? undefined : images?.[sourceIndex]
            if (sourceIndex === undefined || image?.bufferView === undefined) continue
            let pending = sourceHashes.get(sourceIndex)
            if (!pending) {
              pending = parser.getDependency('bufferView', image.bufferView)
                .then(async (bytes: ArrayBuffer) => {
                  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
                  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
                })
              sourceHashes.set(sourceIndex, pending)
            }
            candidates.set(value, pending.then(hash => textureKey(value, hash)))
          }
        }
      })
    }

    const resolved = await Promise.all([...candidates].map(async ([texture, pending]) => [texture, await pending] as const))
    // A scene may unmount while the digest runs. Its late-load path still owns
    // the untouched GLTF, so do not register anything after disposal.
    if (disposed) return

    const replacements = new Map<Texture, Texture>()
    for (const [texture, key] of resolved) {
      if (!key) continue
      const existing = textures.get(key)
      const hash = key.slice(0, key.indexOf('|'))
      if (existing && existing !== texture && textureKey(existing, hash) === key) replacements.set(texture, existing)
      else {
        textures.set(key, texture)
        ownedTextures.add(texture)
      }
    }
    for (const mesh of meshList) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const [slot, value] of Object.entries(material)) {
          if (value instanceof Texture && replacements.has(value)) {
            ;(material as unknown as Record<string, unknown>)[slot] = replacements.get(value)
          }
        }
      }
    }
    for (const texture of replacements.keys()) texture.dispose()

    if (options.materials !== false) {
      const materialReplacements = new Map<MeshStandardMaterial, MeshStandardMaterial>()
      for (const mesh of meshList) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (!(material instanceof MeshStandardMaterial) || materialReplacements.has(material)) continue
          const key = materialKey(material)
          if (!key) continue
          const existing = materials.get(key)
          // Decoration can mutate a previously pooled material before another
          // GLB finishes loading. Never reuse a stale raw-material entry.
          if (existing && existing !== material && materialKey(existing) === key) materialReplacements.set(material, existing)
          else {
            materials.set(key, material)
            ownedMaterials.add(material)
          }
        }
      }
      for (const mesh of meshList) {
        if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(material => materialReplacements.get(material as MeshStandardMaterial) ?? material)
        else mesh.material = materialReplacements.get(mesh.material as MeshStandardMaterial) ?? mesh.material
      }
      for (const material of materialReplacements.keys()) material.dispose()
    }
  }

  return {
    canonicalize,
    register(loader: GLTFLoader) {
      loader.register(() => ({ name: 'AveluneGltfResourcePool', afterRoot: canonicalize }))
    },
    ownsTexture: (texture: Texture) => ownedTextures.has(texture),
    ownsMaterial: (material: Material) => ownedMaterials.has(material as MeshStandardMaterial),
    dispose() {
      if (disposed) return
      disposed = true
      for (const material of ownedMaterials) material.dispose()
      for (const texture of ownedTextures) texture.dispose()
      materials.clear()
      textures.clear()
      // Keep the ownership markers until this scene-scoped pool is collected:
      // an already pooled load can settle after disposeScene and be released by
      // its caller without disposing a canonical resource a second time.
    },
  }
}
