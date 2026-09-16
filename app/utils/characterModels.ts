import { SkinnedMesh } from 'three'
import type { AnimationClip, Group, Object3D, Skeleton } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CHARACTER_NAMES, DEFAULT_CHARACTER, OUTFITS, outfitColorCount, outfitColorTexture } from '#shared/utils/characters'
import { preloadTexture } from '~/utils/appearance'

/** Cached templates are borrowed by both canvases and cloned with
 * SkeletonUtils.clone. Never dispose their geometry or materials per rig. */
export interface CharacterAsset {
  scene: Group
  clips: AnimationClip[]
}

const loader = new GLTFLoader()
const characterCache = new Map<string, Promise<CharacterAsset>>()
let clipsPromise: Promise<AnimationClip[]> | null = null
let loadQueue: Promise<unknown> = Promise.resolve()

/** Serialize GLTF parses across the gate, preloader and live scene. The
 * WebP extension probe races when cold character parses run concurrently. */
function loadModel(url: string) {
  const pending = loadQueue.then(() => loader.loadAsync(url))
  loadQueue = pending.catch(() => {})
  return pending
}

/** All character models use the universal skeleton animation library. */
function loadSharedClips(): Promise<AnimationClip[]> {
  clipsPromise ??= loadModel('/models/characters/animations.glb')
    .then(gltf => gltf.animations)
    .catch((error) => {
      clipsPromise = null
      throw error
    })
  return clipsPromise
}

/** A character's scene and the shared animation clips load together. */
export function loadCharacterAsset(name: string): Promise<CharacterAsset> {
  let pending = characterCache.get(name)
  if (!pending) {
    pending = (async () => {
      const gltf = await loadModel(`/models/characters/${name}.glb`)
      const clips = await loadSharedClips()
      return { scene: gltf.scene, clips }
    })().catch((error) => {
      characterCache.delete(name)
      throw error
    })
    characterCache.set(name, pending)
  }
  return pending
}

export async function loadCharacterScene(name: string): Promise<Group> {
  return (await loadCharacterAsset(name)).scene
}

export async function loadClips(name: string = DEFAULT_CHARACTER): Promise<AnimationClip[]> {
  return (await loadCharacterAsset(name)).clips
}

let started: Promise<void> | null = null

/** Load the default first, then warm the remaining models and colorways. */
export function preloadCharacterAssets(): Promise<void> {
  started ??= (async () => {
    await loadCharacterAsset(DEFAULT_CHARACTER)
    for (const name of CHARACTER_NAMES) {
      if (name === DEFAULT_CHARACTER) continue
      await loadCharacterAsset(name).catch(() => {})
    }
    for (const outfit of OUTFITS) {
      for (let i = 0; i < outfitColorCount(outfit.id); i++) {
        const url = outfitColorTexture(outfit.id, i)
        if (url) preloadTexture(url)
      }
    }
  })().catch((error) => {
    started = null
    throw error
  })
  return started
}

/** SkeletonUtils clones own GPU bone textures, unlike the borrowed geometry. */
export function disposeCharacterSkeleton(root: Object3D): void {
  const skeletons = new Set<Skeleton>()
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton)
  })
  for (const skeleton of skeletons) skeleton.dispose()
}
