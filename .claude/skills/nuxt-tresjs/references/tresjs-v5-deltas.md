# Bundled TresJS docs vs `@tresjs/core` 5.8.3

The docs under `tresjs/` were written against TresJS 4. Everything below was
checked against the installed `node_modules/@tresjs/core/dist/tres.d.ts`.
Read it alongside `tresjs/references/core.md`.

## Contents

- Composables
- TresCanvas props
- Pointer events
- Not installed here

## Composables

| Docs say (v4) | Installed (v5) |
| --- | --- |
| `useTres()` → `{ scene, renderer, camera, sizes }` with `renderer: WebGLRenderer`, `camera: computed<Camera>` | Two composables. `useTres()` returns a **partial** context: `renderer` is the raw `WebGLRenderer`, `camera` is `ComputedRef<Camera \| undefined>`. `useTresContext()` returns the full context: `scene: ShallowRef<Scene>`; `renderer` is a **manager** (`renderer.instance` is the renderer — typed `WebGLRenderer \| Renderer`, WebGL in this project — plus `advance()`, `invalidate()`, `mode`, `onReady`, `onError`, `replaceRenderFunction`); `camera` is a manager (`camera.activeCamera: ComputedRef`, `cameras`, `registerCamera`); plus `sizes`, `controls`, `events`, `extend`. This project uses `useTresContext()` (ArenaScene.vue) |
| `useLoop()` → `{ onBeforeRender, pause, resume }` | `{ onBeforeRender, onRender, render, start, stop, isActive }`. No `pause`/`resume`; there is no `onAfterRender` — the after-render hook is `onRender`. Callbacks receive `{ delta, elapsed, ...partialContext }` |
| `onBeforeRender(cb, { priority: -1 })` | The second argument is a plain number: `onBeforeRender(cb, -1)` (`PriorityEventHookOn<T> = (fn, priority?: number) => { off }`). Lower runs earlier; the return value's `off()` unsubscribes |
| — (not documented) | `useLoop().render(fn)` replaces the default render call: `fn(notifyFrameRendered)` must render (`composer.render()` or `renderer.render(scene, camera)`) **and then call `notifyFrameRendered()`**, or on-demand mode stops counting frames |
| `const texture = await useLoader(TextureLoader, url)` | `useLoader(Loader, path, options?)` returns a `useAsyncState`-style object (`state`, `isLoading`, `error`, `execute`, plus `load(path)` and `progress`). Not awaitable for the bare asset — read `state.value` |
| `sizes: { width, height, aspectRatio }` as numbers | Refs: `width`, `height`, `pixelRatio`, `aspectRatio` (computed) |
| `useGraph(model)` → `{ nodes, materials }` | Unchanged |
| `extend({ OrbitControls })` | Unchanged; also available as `useTresContext().extend` |

## TresCanvas props

Docs list `shadows, alpha, clearColor, antialias, toneMapping, outputColorSpace, windowSize, preset`.
Installed (`ContextProps` = `RendererOptions` + canvas props):

- Renderer: `antialias`, `alpha`, `premultipliedAlpha`, `stencil`, `depth`, `precision`, `logarithmicDepthBuffer`, `preserveDrawingBuffer`, `powerPreference`, `failIfMajorPerformanceCaveat`, `clearColor`, `clearAlpha`, `shadows`, `shadowMapType`, `toneMapping`, `toneMappingExposure`, `outputColorSpace`, `useLegacyLights`, `dpr` (`number | [min, max]`), `renderMode` (`'always' | 'on-demand' | 'manual'`), `renderer` (factory `(ctx) => TresRenderer`).
- Canvas: `camera`, `windowSize`, `fpsLimit`, `enableProvideBridge`, `customRendererOptions`.
- **No `preset` prop** in 5.8.3.
- Emits: `ready(context)`, `error`, `render`, `beforeLoop`, `loop`, `pointermissed`, and every pointer event below.

This project's canvas (GameScene.client.vue): `clear-color`, `:dpr="[1, 2]"`, `shadows`,
`:shadow-map-type="PCFSoftShadowMap"`, `:tone-mapping="ACESFilmicToneMapping"`,
`:tone-mapping-exposure="1.05"`.

## Pointer events

Docs: `@click`, `@pointer-move`, … on meshes, and `:pointer="{ events: true }"` on the canvas.
Installed: events come from `@pmndrs/pointer-events`; names are `click`, `contextmenu`,
`pointermove`, `pointerenter`, `pointerleave`, `pointerover`, `pointerout`, `dblclick`,
`pointerdown`, `pointerup`, `pointercancel`, `lostpointercapture`, `wheel`, plus
`pointermissed` on the canvas. **There is no `pointer` prop** on `TresCanvas` in 5.8.3.
This project does not use Tres pointer events — input is pointer lock + raw mouse deltas
in GameScene.client.vue.

## Not installed here

`@tresjs/cientos` and `@tresjs/post-processing` — so `cientos.md`, `effects.md` and most
of `cookbook.md` describe components that are not available. `@tresjs/nuxt` would
auto-import them once added, but the world here is built imperatively, not from Tres
components; check the project rules before adding either.
