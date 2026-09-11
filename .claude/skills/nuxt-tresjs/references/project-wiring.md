# How this project wires Nuxt + TresJS

## Contents

- Where things live
- The Nuxt side
- The Tres side (imperative pattern)
- Adding to the scene
- `@tresjs/nuxt` module options

## Where things live

- `nuxt.config.ts` — `modules: ['@nuxt/ui', '@tresjs/nuxt']`; no `tres` options set.
- `app/components/GameScene.client.vue` — hosts `<TresCanvas>` and owns all input (keys, pointer lock, mouse deltas). Client-only by filename.
- `app/components/ArenaScene.vue` — the whole 3D world, built imperatively inside the Tres context; its template is a bare `<TresGroup />`. Only ever mounted under GameScene, so it never renders on the server.
- `app/components/CharacterPreview*.client.vue` — the onboarding turntable, a second small canvas.
- `app/utils/{textures,stadium,appearance,characterModels}.ts` — three.js helpers; they touch `document` and are only imported from the client components above.

## The Nuxt side

- SSR is on. Anything touching `window`, `document` or WebGL at import or setup time sits in a `.client.vue` component, under `<ClientOnly>`, or behind `import.meta.client`. `@tresjs/nuxt` ships `TresCanvas` as a client + server pair, so the canvas itself is safe; your own three.js code is not.
- `@tresjs/nuxt` auto-imports the `@tresjs/core` composables (`useTresContext`, `useLoop`, `useLoader`, `extend`, …), registers the `Tres*` components, and patches the Vue compiler so `<TresMesh>` and friends resolve. Explicit imports (`import { useLoop, useTresContext } from '@tresjs/core'`) still work and are what ArenaScene does.
- Cross-layer state (chat bubbles, Coach speech) flows through Nuxt `useState` composables (`useGame`, `useCoach`), not props into the canvas.
- `shared/**` is also run by the server: it must stay free of three.js and DOM imports.

## The Tres side (imperative pattern)

```ts
const { scene, camera: cameraManager, renderer } = useTresContext()
const camera = cameraManager.activeCamera            // ComputedRef<Camera>
const { onBeforeRender } = useLoop()

scene.value.add(ambient, sun, floorGroup)            // plain three.js objects
onBeforeRender(({ delta, elapsed }) => {
  const dt = Math.min(delta, 0.1)                     // clamp: a hidden tab yields huge deltas
  // …
})
onUnmounted(() => scene.value.remove(ambient, sun, floorGroup))   // keeps HMR honest
renderer.instance?.domElement                        // the real <canvas>
```

- The camera is Tres's default `PerspectiveCamera`, configured once from the loop (`fov 70`, `near 0.05`, `far 90`). Do not add a `<TresPerspectiveCamera>`.
- `renderMode` is the default `'always'`; nothing calls `invalidate()`.
- A post-processing chain would be: `new EffectComposer(renderer.instance)`, passes ending in `OutputPass`, then `useLoop().render((notify) => { composer.render(); notify() })`.

## Adding to the scene

1. Build plain three.js objects in a `.client.vue` component or a util it imports.
2. Add them to `scene.value`, or to `floorGroup` for anything that belongs to the arena — `buildFloor()` clears and rebuilds that group (twice on load, as model waves land), so cache textures at module level.
3. Animate in `onBeforeRender`. Read time from `props.game.serverNow()` when it must match other players (sky, weather); `elapsed` is fine for purely local motion.
4. Remove in `onUnmounted`.
5. Kit pieces render as one `InstancedMesh` batch per kind (`instantiateModule`); `tagShadows(floorGroup)` then decides cast/receive — do not set shadow flags by hand.

## `@tresjs/nuxt` module options (`tres` key in `nuxt.config.ts`, v5.6.3)

| Option | Default | Effect |
| --- | --- | --- |
| `devtools` | `false` | Tres panel in Nuxt DevTools (needs `@nuxt/devtools`; DevTools is disabled in this project) |
| `glsl` | `false` | Import `.glsl` files as strings via vite-plugin-glsl. Off here — the sky dome's shaders are inline strings |
| `modules` | — | Extra TresJS ecosystem packages to auto-import (e.g. `@tresjs/cientos` once installed) |
