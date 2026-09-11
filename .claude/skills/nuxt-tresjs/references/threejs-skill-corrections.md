# The `threejs-*` skills: known inaccuracies and the TresJS translation

The ten `threejs-*` skills (`.claude/skills/threejs-*`, from CloudAI-X/threejs-skills)
are vanilla three.js references. Every `import { X } from 'three'` symbol and every
addon path in them was checked against the installed `three@0.185.1`; the misses
are listed here. Apply the "Do instead" column when following one of their recipes.

## Contents

- Inaccuracies vs three r185
- Vanilla three.js → TresJS translation
- What the skills cannot know (project rules)

## Inaccuracies vs three r185

| Skill | Claim | Reality | Do instead |
| --- | --- | --- | --- |
| `threejs-lighting` | `ContactShadows` from `three/examples/jsm/objects/ContactShadows.js` | Does not exist in three.js — it is a react-three/drei component | Blurred shadow texture on a plane, or `@tresjs/cientos` `<ContactShadows>` (not installed here) |
| `threejs-postprocessing` | `GammaCorrectionShader` as the final pass | Deprecated since r155; with `outputColorSpace = SRGBColorSpace` + tone mapping it double-corrects and drops the tone map | End the chain with `OutputPass` (`three/addons/postprocessing/OutputPass.js`) — it applies tone mapping and sRGB |
| `threejs-postprocessing` | WebGPU section: `three/addons/nodes/Nodes.js`, `THREE.PostProcessing`, "r150+" | Path removed; TSL lives in `three/tsl`, `PostProcessing` in `three/webgpu`. Tres renders with `WebGLRenderer` | Ignore the section |
| `threejs-loaders` | KTX2 transcoder pinned to `three@0.160.0` on jsDelivr | The transcoder must match the installed three version | Pin to the installed version, or self-host `examples/jsm/libs/basis/` |
| `threejs-lighting` | `new PointLight(color, 1, 100, 2)`-style intensities | Since r155 lights use physical units (candela); `1` is near-invisible | Start around 5–50 for point/spot lights (this project: torch `5`, Coach glow `5`) |
| `threejs-interaction` | Intersection `face: Face3` | `Face3` was removed in r125; `face` is `{ a, b, c, normal, materialIndex }` | — |
| `threejs-materials` | Never sets `texture.colorSpace` on a color `map` | r152+: textures default to `NoColorSpace`; a hand-loaded color map renders washed out | `texture.colorSpace = SRGBColorSpace` for color/emissive maps only; `GLTFLoader` does it for you |
| all | Mixed `three/examples/jsm/…` and `three/addons/…` imports | Both resolve; `three/addons` is the alias this project uses everywhere | Import from `three/addons/…` |

Everything else checked out: `outputColorSpace`/`SRGBColorSpace`, `mergeGeometries`
(r151 rename), TextGeometry `depth` (r163 rename), `shadow.normalBias`,
`InstancedMesh`, `AnimationMixer`/`crossFadeTo`/`setEffectiveWeight`,
`SkeletonUtils`, `GLTFLoader` + `MeshoptDecoder`/`DRACOLoader`.

## Vanilla three.js → TresJS translation

The skills assume you own the renderer. Under `<TresCanvas>` you do not:

| Skill pattern | In TresJS (`@tresjs/core` 5) |
| --- | --- |
| `new WebGLRenderer()`, `setSize`, `setPixelRatio`, `appendChild`, resize listener | `<TresCanvas>` props: `shadows`, `:shadow-map-type`, `:dpr`, `:tone-mapping`, `:tone-mapping-exposure`, `clear-color`, `window-size`. Never create a second renderer |
| `new Scene()`, `new PerspectiveCamera()` | `useTresContext()` → `scene.value`, `camera.activeCamera`; or declare `<TresPerspectiveCamera>` |
| `renderer` (the object) | `useTresContext().renderer.instance` — the manager wraps it |
| `function animate() { requestAnimationFrame(animate) … }` | `useLoop().onBeforeRender(({ delta, elapsed }) => …)` — clamp `delta` yourself |
| `renderer.render(scene, camera)` replaced by `composer.render()` | `useLoop().render(() => composer.render())` takes over the render call; build the `EffectComposer` from `renderer.instance` |
| `OrbitControls`/`PointerLockControls` | Custom camera code in the loop (this project), or `@tresjs/cientos` controls (not installed) |
| `raycaster.intersectObjects(scene.children)` on `mousemove` | Tres pointer events on components (`@click`, `@pointer-enter` …) or a `Raycaster` fed from `renderer.instance.domElement` |
| `window.innerWidth/Height` | `useTresContext().sizes` (`width`, `height`, `aspectRatio`) |
| Anything touching `window`/`document` at import time | Keep three.js code in `.client.vue` components or behind `<ClientOnly>`; Nuxt renders on the server first |

## What the skills cannot know (project rules)

They are generic. These take precedence and live in `CLAUDE.md` and
`.claude/agents/scene-3d.md`:

- Gameplay physics stays in `shared/utils/arena.ts` (`stepBody`); no client physics engine (`@tresjs/rapier` and friends cannot be the authority).
- Kit pieces render as one `InstancedMesh` batch per kind; shadows are tagged after a build by `tagShadows`, not per mesh.
- `GLTFLoader` has `MeshoptDecoder` registered; character GLBs load sequentially to warm three's WebP probe.
- Colours come from `app/utils/palette.ts`, never hardcoded accents.
