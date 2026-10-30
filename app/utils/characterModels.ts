import { LoaderUtils, SkinnedMesh } from 'three'
import type { AnimationClip, Group, Object3D, Skeleton } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CHARACTER_NAMES, DEFAULT_CHARACTER, OUTFITS, outfitColorCount, outfitColorTexture } from '#shared/utils/characters'
import { preloadTexture } from '~/utils/appearance'
import { createGltfResourcePool } from '~/utils/gltfResources'

/** Cached templates are borrowed by both canvases and cloned with
 * SkeletonUtils.clone. Never dispose their geometry or materials per rig. */
export interface CharacterAsset {
  scene: Group
  clips: AnimationClip[]
}

const loader = new GLTFLoader()
// Cached character templates live for the page lifetime. Their textures can
// share GPU uploads across separate GLBs; rig shader hooks mutate materials,
// so material identity remains per template.
const resources = createGltfResourcePool({ materials: false })
resources.register(loader)
const characterCache = new Map<string, Promise<CharacterAsset>>()
let clipsPromise: Promise<AnimationClip[]> | null = null
let loadQueue: Promise<unknown> = Promise.resolve()

const downloads = new Map<string, Promise<ArrayBuffer>>()

/** Downloads overlap freely, so the preloader can start every file at once and
 * leave the pacing to the browser. Only the bytes are shared, never a parse. */
function download(url: string): Promise<ArrayBuffer> {
  let pending = downloads.get(url)
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${url}`)
      return response.arrayBuffer()
    })
    downloads.set(url, pending)
    // A failed download must not be the one a retry gets handed.
    pending.catch(() => downloads.delete(url))
  }
  return pending
}

/** Serialize GLTF parses across the gate, preloader and live scene. The
 * WebP extension probe races when cold character parses run concurrently.
 * The download starts now and only the parse waits its turn. */
function loadModel(url: string) {
  const data = download(url)
  const pending = loadQueue
    .then(async () => loader.parseAsync(await data, LoaderUtils.extractUrlBase(url)))
    .finally(() => downloads.delete(url))
  loadQueue = pending.catch(() => {})
  return pending
}

/**
 * Bump when `rebuild_animations.py` changes the clip set. The file keeps its
 * name, and a server that sends no `Cache-Control` (Nitro dev) lets the browser
 * reuse the old copy for hours, so new clips silently never play.
 */
const CLIPS_VERSION = 21

/** All character models use the universal skeleton animation library. */
function loadSharedClips(): Promise<AnimationClip[]> {
  clipsPromise ??= loadModel(`/models/characters/animations.glb?v=${CLIPS_VERSION}`)
    .then(gltf => gltf.animations)
    .catch((error) => {
      clipsPromise = null
      throw error
    })
  return clipsPromise
}

function characterUrl(name: string) {
  return `/models/characters/${name}.glb`
}

/** A character's scene and the shared animation clips load together. */
export function loadCharacterAsset(name: string): Promise<CharacterAsset> {
  let pending = characterCache.get(name)
  if (!pending) {
    pending = (async () => {
      // Ask for the clips first: no rig can show without them, so they must
      // never sit behind the models in the connection pool or the parse queue.
      const clips = loadSharedClips()
      const gltf = await loadModel(characterUrl(name))
      return { scene: gltf.scene, clips: await clips }
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

/** How many models the preloader downloads at once. The browser gives a host
 * six connections over HTTP/1.1, and the outfit a player clicks mid-warm needs
 * one of them free. */
const PRELOAD_DOWNLOADS = 3

/**
 * Load the default first, then warm the remaining models and colorways.
 *
 * Downloads run a few at a time ahead of the parses, which are still asked for
 * one by one. That keeps a single preload entry in the parse queue, so an outfit
 * the player clicks mid-warm parses next, from bytes that are usually here
 * already, not after the whole cast.
 */
export function preloadCharacterAssets(): Promise<void> {
  started ??= (async () => {
    const names = CHARACTER_NAMES.filter(name => !characterCache.has(name))
    let next = 0
    const worker = async () => {
      while (next < names.length) await download(characterUrl(names[next++]!)).catch(() => {})
    }
    for (let i = 0; i < PRELOAD_DOWNLOADS; i++) worker()
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
