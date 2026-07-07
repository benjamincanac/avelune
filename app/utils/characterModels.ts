import type { AnimationClip, Group } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CHARACTER_NAMES, DEFAULT_CHARACTER, OUTFITS, outfitColorCount, outfitColorTexture, outfitOf } from '#shared/utils/characters'
import { preloadTexture } from '~/utils/appearance'

/**
 * Shared client-side cache for the onboarding character models. The creation
 * gate's preview reads from here, and the main menu warms it ahead of time so
 * "Create your runner" opens instantly (see `preloadCharacterAssets`).
 *
 * The character/animation GLBs are plain (no meshopt), so the loader needs no
 * decoder. Scenes are cached as templates and `SkeletonUtils.clone`d per rig by
 * the consumer, so a single cached scene is safe to share across canvases —
 * exactly like the colorway textures already shared via `~/utils/appearance`.
 */
const loader = new GLTFLoader()
const sceneCache = new Map<string, Group>()
let clips: AnimationClip[] = []
let clipsPromise: Promise<AnimationClip[]> | null = null

/** The shared animation library (skeleton + clips, no mesh), loaded once. */
export function loadClips(): Promise<AnimationClip[]> {
  if (clips.length) return Promise.resolve(clips)
  clipsPromise ??= loader.loadAsync('/models/characters/animations.glb').then((gltf) => {
    clips = gltf.animations
    return clips
  })
  return clipsPromise
}

/** Load (and cache) one character's scene template. */
export async function loadCharacterScene(name: string): Promise<Group> {
  const cached = sceneCache.get(name)
  if (cached) return cached
  const scene = (await loader.loadAsync(`/models/characters/${name}.glb`)).scene
  if (!sceneCache.has(name)) sceneCache.set(name, scene)
  return sceneCache.get(name)!
}

let started: Promise<void> | null = null

/**
 * Warm every creation-gate asset: the animation library, the default character
 * first (so the gate's opening frame is ready first), then the rest of the
 * roster sequentially, then every outfit colorway texture.
 *
 * Sequential character loads are deliberate: the GLBs carry EXT_texture_webp
 * textures and three's WebP support probe is per-parse — warming it on the
 * first model lets the rest decode reliably. Idempotent: repeat calls return
 * the same in-flight/settled promise.
 */
export function preloadCharacterAssets(): Promise<void> {
  started ??= (async () => {
    await loadClips()
    await loadCharacterScene(DEFAULT_CHARACTER)
    for (const name of CHARACTER_NAMES) {
      if (name === DEFAULT_CHARACTER) continue
      await loadCharacterScene(name).catch(() => {})
    }
    for (const o of OUTFITS) {
      for (let i = 0; i < outfitColorCount(o.id); i++) {
        const url = outfitColorTexture(o.id, i)
        if (url) preloadTexture(url)
      }
    }
  })()
  return started
}

/**
 * Warm just one character — the animation library, that character's scene, and
 * its chosen outfit colorway. Used on the main menu for a returning player: they
 * click Enter → hub, so there's no point warming the whole roster, only the rig
 * they'll actually spawn as. Shares the browser fetch cache with MazeScene's
 * in-world loader, so the hub's first paint skips the network round-trip.
 */
export async function preloadCharacter(name: string, outfitColor: number): Promise<void> {
  await loadClips()
  await loadCharacterScene(name).catch(() => {})
  const url = outfitColorTexture(outfitOf(name), outfitColor)
  if (url) preloadTexture(url)
}
