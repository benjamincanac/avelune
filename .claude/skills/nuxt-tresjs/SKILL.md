---
name: nuxt-tresjs
description: Hub for this project's 3D layer — Nuxt × TresJS × three.js. Routes 3D work to the right reference (vanilla three.js API via the threejs-* skills with their known r185 inaccuracies, bundled TresJS docs with v5 deltas, the global nuxt skill) and explains how this codebase wires them (imperative scene under TresCanvas, client-only, useLoop). Use when touching ArenaScene/GameScene, the camera, lights or shadows, materials and textures, GLTF models or animation, post-processing, or any Tres/three code inside a Nuxt component.
---

# Nuxt × TresJS × three.js

Three layers, one scene. Nuxt renders the app (server first), `@tresjs/nuxt`
registers TresJS, `<TresCanvas>` owns the WebGL renderer/scene/camera/loop, and
three.js is the API everything is ultimately built from. This skill tells you
which reference answers which question, and what the generic references get
wrong for this project.

```
Nuxt 5 (nightly)  →  @tresjs/nuxt 5.6.3  →  @tresjs/core 5.8.3  →  three 0.185.1
SSR, auto-imports     module, auto-imports    TresCanvas, useLoop     the actual API
```

Not installed: `@tresjs/cientos`, `@tresjs/post-processing`. The bundled TresJS
docs assume both — treat their components as "available if added", not present.

## Route the question

| Working on… | Read |
| --- | --- |
| Nuxt itself: SSR, `<ClientOnly>`, `.client.vue`, auto-imports, `useState`, server routes, config | Invoke the global **`nuxt`** skill. Most relevant there: `features-components` (ClientOnly), `best-practices-ssr`, `features-composables`, `features-state` |
| TresCanvas props, `useTresContext`/`useLoop`, pointer events, `extend` | [tresjs/references/core.md](references/tresjs/references/core.md) **together with** [tresjs-v5-deltas.md](references/tresjs-v5-deltas.md) — the docs are v4-shaped in places |
| Tres recipes (models, camera, loop, effects) | [tresjs/references/cookbook.md](references/tresjs/references/cookbook.md) |
| Cientos helpers (controls, loaders, staging) | [tresjs/references/cientos.md](references/tresjs/references/cientos.md) — package not installed |
| Post-processing components | [tresjs/references/effects.md](references/tresjs/references/effects.md) — package not installed; this project would drive an `EffectComposer` from `useLoop().render` instead |
| How **this** codebase wires Nuxt + Tres (imperative scene, client-only, loop, module options) | [project-wiring.md](references/project-wiring.md) |
| Any three.js API | The matching `threejs-*` skill (table below), then [threejs-skill-corrections.md](references/threejs-skill-corrections.md) before applying its recipe |
| The project's own rules (physics in `shared/`, instancing, shadows, assets) | `CLAUDE.md` and `.claude/agents/scene-3d.md` — authoritative over everything above |

### three.js topics → skill

| Topic | Skill | Watch for |
| --- | --- | --- |
| Scene graph, cameras, transforms, renderer settings | `threejs-fundamentals` | Renderer/loop setup is Tres's job here |
| Geometry, BufferGeometry, `InstancedMesh` | `threejs-geometry` | — |
| Materials, PBR, material props | `threejs-materials` | Never sets `colorSpace` on color maps |
| Textures, UVs, env maps, canvas textures | `threejs-textures` | — |
| Lights, shadows, IBL | `threejs-lighting` | `ContactShadows` does not exist; physical light units |
| GLTF, textures, decoders, loading managers | `threejs-loaders` | KTX2 transcoder pin is stale |
| Keyframes, skeletal animation, mixing | `threejs-animation` | — |
| Raycasting, controls, input | `threejs-interaction` | Controls and raycasting are custom in this project |
| GLSL, ShaderMaterial, `onBeforeCompile` | `threejs-shaders` | — |
| EffectComposer, bloom, DOF | `threejs-postprocessing` | Use `OutputPass`, not `GammaCorrectionShader`; WebGPU section is wrong |

## Workflow for a 3D change

```
- [ ] Place it client-only (`.client.vue` or a child of GameScene.client.vue) — three.js never runs in SSR
- [ ] Find what Tres already owns (renderer, camera, sizes, loop) before creating any of it
- [ ] Take the three.js API from the matching threejs-* skill
- [ ] Check threejs-skill-corrections.md for that skill's known misses
- [ ] Translate vanilla patterns to Tres (translation table in the corrections file)
- [ ] Gameplay-affecting math (position, collision, elevation) goes to shared/utils/arena.ts, never the scene
- [ ] Verify in the running game, not just typecheck (see the run-mmo skill)
```

## Hard rules

- One renderer: never `new WebGLRenderer()`; configure through `<TresCanvas>` props and read it via `useTresContext().renderer.instance`.
- Per-frame work goes in `useLoop().onBeforeRender`; a composer takes over via `useLoop().render(fn)`.
- Import addons from `three/addons/…`, not `three/examples/jsm/…`.
- Colours from `app/utils/palette.ts`; no hardcoded accents.
- The client predicts, the server decides: no client-side physics engine, no forked kinematics.

## References

- [references/project-wiring.md](references/project-wiring.md) — how this repo composes Nuxt, `@tresjs/nuxt`, `TresCanvas` and an imperative scene; module options; client-only rules.
- [references/tresjs-v5-deltas.md](references/tresjs-v5-deltas.md) — where the bundled TresJS docs lag `@tresjs/core` 5 (composable shapes, loop API, loaders, props).
- [references/threejs-skill-corrections.md](references/threejs-skill-corrections.md) — verified inaccuracies in the `threejs-*` skills vs three r185, plus the vanilla → Tres translation table.
- [references/tresjs/SKILL.md](references/tresjs/SKILL.md) — the bundled TresJS skill (onmax/nuxt-skills, verbatim; provenance in [SOURCE.md](references/tresjs/SOURCE.md)) with [core.md](references/tresjs/references/core.md), [cientos.md](references/tresjs/references/cientos.md), [effects.md](references/tresjs/references/effects.md), [cookbook.md](references/tresjs/references/cookbook.md).
- Global `nuxt` skill — invoke by name; on this machine its references live in `~/.claude/skills/nuxt/references/`.
