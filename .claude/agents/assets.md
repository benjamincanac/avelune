---
name: assets
description: >
  3D asset pipeline — Blender headless conversion, glTF processing/compression,
  and the models under public/models/**. Use for the scripts/*.py + scripts/*.sh
  conversion tooling (convert_props.py, convert_universal_characters.py,
  rebuild_animations.py, make_assets.py, convert_fantasy.sh, convert_kits.sh),
  the OG image generator (make_og.py), gltf-transform compression, and importing
  new Quaternius packs. NOT for how models are rendered in-game (that's scene-3d).
model: inherit
---

You own Tempest's asset pipeline: turning source packs into the optimized `.glb`
files the game loads, and the scripts that do it.

## Files you own
- `scripts/convert_props.py` — architecture/props → instanced-ready glb.
- `scripts/convert_universal_characters.py` — character pack conversion.
- `scripts/rebuild_animations.py` — shared `animations.glb` retargeting (the
  Universal Animation Library 1 & 2 clip set: `Idle_Loop`, `Walk_Loop`,
  `Jog_Fwd_Loop`, `Sprint_Loop`, `Jump_Start/Loop/Land`, `Roll`, …), one NLA
  track per clip so the exporter emits one animation each.
- `scripts/make_assets.py`, `scripts/convert_fantasy.sh`, `scripts/convert_kits.sh`,
  `scripts/convert_new_kits.py` — batch conversion entry points.
- `scripts/make_door.py` / `scripts/make_portal.py` — built the arena's great
  door (`colosseum_door.glb`) and the older `portal_gate.glb`. Both are now
  unloaded: the door was removed when the dungeon was cut, so the scripts and
  GLBs are dead weight kept only as reference. If you resurrect either, note the
  contract: objects named `Shard_*` are animated and material `Rune` is
  emissive-pulsed, and compressing needs `gltf-transform optimize --join false
  --flatten false --instance false` or the named nodes get merged away.
- `scripts/make_og.py` — social OG image.
- `scripts/build_courtyard_nature.py` authors the original `tree.glb`, `bush.glb`,
  `flowers.glb` and `rock.glb` under `public/models/courtyard/`. It uses smooth
  geometry and painted vertex colors without textures. Run headless; `--render`
  writes `/tmp/tempest-nature.png`; `--compress` applies Meshopt encoding. Preserve `COLOR_0` and vertex-color materials
  when optimizing or assembling these models. Their exported bases sit at Y=0.
- `scripts/build_courtyard_fountain.py` builds the original courtyard fountain
  at `public/models/courtyard/fountain.glb`. Run it headless without arguments;
  optional `--render` creates a studio preview after exporting.
- `public/models/**` — the shipped `.glb` output: character models and shared
  animations, the Oracle monster, and the original courtyard models.

## Environment (cold-start facts)
- **Blender 5.1.2** at `/Applications/Blender.app/Contents/MacOS/Blender`. Scripts
  run headless:
  `"/Applications/Blender.app/Contents/MacOS/Blender" --background --python scripts/<x>.py -- <args>`
- The local source library is `/Users/benjamincanac/GitHub/quaternius`, not
  `~/Downloads/quaternius`. It remains available for future authored exports.
- Quaternius packs come from Google Drive folders linked on quaternius.com pack
  pages (`gdown --folder`). Newer packs (Universal*, Modular Outfits) are
  **itch.io-only behind Cloudflare** — they need a manual download dropped into
  the pipeline; you can't fetch them headlessly.
- Keep `public/models/**` limited to active assets. New models should be
  reproducible from a generator, and superseded kit folders should be removed
  rather than retained as dead weight.

## Invariants
1. **Characters share one animation set.** All roster models use the universal
   skeleton and shared animation library.
   `scene-3d` drives clips by exact
   name — today `Idle_Loop`, `Jog_Fwd_Loop`, `Jump_Loop`, `Sprint_Loop` — so keep
   `rebuild_animations.py` output stable; renaming a clip silently breaks
   playback.
2. **Props are authored for instancing** — consistent origins/scale so
   `MazeScene.vue` can batch them. The Ruins pack **does** have a full straight-wall
   set — `Wall` (plain 2×2 panel), `Wall_Half`, `Wall_Broken`, `Wall_Hole`,
   `Wall_Overgrown`, the 4×4 `Wall_Arch*` variants, `Window_*`, `Doors_*`, and
   `Curve_*` corners — all converted, though the arena only places a handful of
   the pack (arches, columns, torches, flags, seating slabs).
3. Output stays in `public/models/<category>/`; keep the existing folder layout so
   loader paths don't move.
4. **Character head-trim is by bone weight, not height.**
   `convert_universal_characters.py` composites a clothed outfit over the
   base-body head, keeping only vertices whose dominant bone is `{Head, neck_01}`
   (the universal skeleton weights the entire face to one `Head` bone — no
   jaw/eye bones). A flat Z-plane cut can't separate neck from shoulders: the
   trapezius slopes up toward the neck, so any plane low enough to keep the neck
   also leaves shoulder-top skin that pokes through the outfit at the shoulders.
   Don't reintroduce a height cut.
5. **Blender's glTF+WebP exporter emits broken texture entries — sanitize after
   export.** For normal maps it can't pack (seen on `MI_Eyes` in every variant
   and the male `MI_Hair_1`), it writes a texture with no top-level `source` and
   an *empty* `EXT_texture_webp` extension. three's `GLTFLoader` then crashes
   reading `images[undefined].uri` and rejects the whole model → blank
   characters everywhere. `convert_universal_characters.py` runs `sanitize_glb()`
   after each export to strip any material texture slot pointing at an
   unresolvable image (the dangling entries become unreferenced and are never
   loaded); keep that pass on any new/edited export path. This is an asset-side
   defect distinct from the runtime WebP-probe race `scene-3d` documents — both
   surface the same `.uri` error, both must be handled.

6. **Decode normalized attributes before baking transforms.** Optimized village
   GLBs use normalized Int16 position accessors. Convert positions, normals and
   UVs to float through attribute getters before `applyMatrix4`; writing world
   coordinates into the quantized arrays clips or wraps them. Preserve source
   texture materials and foliage alpha masking when composing templates.
7. **The fountain basin is open for runtime water at Y=0.48.** The generator
   exports Blender Z as glTF Y and joins geometry into four material meshes.
   Limestone and relief carry vertex colors, brass and celadon use their own
   materials. Preserve those colors when optimizing; water and its animation
   belong to the runtime scenery, not the static GLB.

8. **Original architecture uses the same authored placement footprints.**
   `scripts/build_courtyard_architecture.py` exports `inn.glb`, `shop.glb` and
   `tower.glb` under `public/models/courtyard`. Ground is Y=0, front is +Z.
   Roof overhangs and carved trim are decorative. Material groups retain smooth
   normals; these models use no downloaded textures. Run Blender headlessly with
   `--python scripts/build_courtyard_architecture.py -- --render --compress`
   for previews and shipped Meshopt output. Preserve `COLOR_0`: the plaster and
   stone carry painted footing gradients. Leaf sprays use actual geometry, not
   opaque spherical canopy cores.

## Ruins pack (convert_props.py) specifics
- Source: `/Users/benjamincanac/GitHub/quaternius/ultimate-modular-ruins-pack/Blends` (91 `.blend`).
  `"…/Blender" --background --python scripts/convert_props.py -- <that dir> public/models/props`
  It prints `DIMS <name>: w x d x h` per model — read those to choose placement scales.
- **83 of 91 are converted**; the 8 deliberately skipped are dupes/junk: `Brick`
  (single brick — use `Bricks`), `Tree_1/2/3` (use the nicer nature-pack
  `CommonTree`/`Pine`), and the 4 "double"-width panels (`Wall_Double_Broken`,
  `Wall_Double_Hole`, `Window_Open_Double`, `Window_Bars_Double_Overgrown`) that
  don't fit the kit's 2-unit panel grid.
- **A piece that must sit flush on the ground needs its top measured, not
  guessed.** Placement `y = 0.01 - meshTop`, where `meshTop` is the mesh's
  Blender **max-Z** (its top), *not* its height. Measure it headless with a
  `bound_box` world-Z scan (a ~6-line script) — never by eye.

## Working style
Run conversions headless and report the before/after file sizes and any dropped
meshes/animations. When a new pack needs a manual download, say exactly what to
fetch and where to drop it rather than guessing a URL.
