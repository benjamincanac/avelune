---
name: assets
description: >
  3D asset pipeline — Blender headless conversion, glTF processing/compression,
  and the models under public/models/**. Use for the scripts/*.py + scripts/*.sh
  conversion tooling (convert_universal_characters.py, rebuild_animations.py,
  convert_nature.sh, convert_monsters.sh, convert_kit.sh, build_kit.py,
  build_courtyard_*.py), the OG image generator (make_og.py), gltf-transform
  compression, and importing new Quaternius packs. NOT for how models are
  rendered in-game (that's scene-3d).
model: inherit
---

You own Avelune's asset pipeline: turning source packs into the optimized `.glb`
files the game loads, and the scripts that do it.

## Files you own
- `scripts/convert_universal_characters.py` — character pack conversion. Outfits
  come from the purchased CC0 superset `modular-character-outfits`
  (Peasant, Ranger, Knight, Knight_Cloth, Noble, Wizard; its Peasant and Ranger
  meshes and textures are byte-identical to the older free `module-character-outfits`,
  so the switch cannot change GLBs built before it). `ONLY="Name Name"` rebuilds a
  subset, which is how a new outfit lands without rewriting the shipped ones.
  Its `build_animations()` is opt-in behind `--animations` and must stay that way:
  it knows 16 clips, `rebuild_animations.py` ships 21, so an unguarded run silently
  dropped `Swim_Loop`/`Swim_Idle` from `animations.glb`.
  Head pieces (`*_Head_Hood`, `*_Head_Armet`, `*_Head_Crown`) ride inside the
  outfit's own `.gltf` already skinned, so nothing extra is imported or bound.
  A head piece that fully encloses the skull goes in `HELMETED`, its build
  imports no hair and it ships one GLB per gender (`Knight_Male`), mirrored by
  `hairless` on the outfit in `shared/utils/characters.ts`: the Ranger's hood is open at the face and keeps the hair, the
  Knight's closed armet had every style punching through the metal. The Wizard has
  no head piece anywhere in the pack.
  The male beard is a toggle mesh, not part of a hairstyle. Every male build of
  an outfit that has hair carries `Hair_Beard` as its own node, both
  `SimpleParted` and `Buzzed`, and the script renames the object and its mesh
  data to that exact string so the exported node name is predictable. The
  helmeted Knight and every female build have no beard. The beard keeps the
  hair material `MI_Hair_1`, which the `CLOTH` regex in
  `app/utils/appearance.ts` does not match, so the runtime toggles it by hiding
  the node and no texture swap touches it. Colourway PNGs under
  `public/models/characters/textures/` are `sips -Z 512 -s format png` of the pack's
  `T_<Outfit>_{2,3}_BaseColor.png`; that command reproduces the shipped ones byte
  for byte, Blender's own `image.scale` does not.
- `scripts/rebuild_animations.py` — shared `animations.glb` retargeting (the
  Universal Animation Library 1 & 2 clip set: `Idle_Loop`, `Walk_Loop`,
  `Jog_Fwd_Loop`, `Sprint_Loop`, `Jump_Start/Loop/Land`, `Roll`, …), one NLA
  track per clip so the exporter emits one animation each.
- `animations.glb` is the only clip file the client loads. `rebuild_animations.py`
  also exports the library's `Swim_Fwd_Loop` / `Swim_Idle_Loop` renamed to
  `Swim_Loop` / `Swim_Idle` (`RENAMED`). The library poses the swimmer around
  the feet origin, so the script lifts the pelvis keys (`LIFT`, world metres)
  to sit the stroke on the waterline (`MOAT.swimDraft` above the feet) and keep
  the treading head above it. Keep clip names, seamless endpoints and zero root
  translation stable. Rebuild the preview after exporting; replacing
  `.output/public` assets directly leaves Nitro serving stale content lengths
  and breaks character loading.
- Prefer a library clip over a hand-posed one. Every runtime clip now comes
  straight from UAL1/UAL2; `Sprint_Loop` and `Jog_Fwd_Loop` already share
  footfall phase (left foot down at ~0.0 / 0.05 of the cycle), so no sprint
  rebuild is needed for gait blending. The packs live in `~/GitHub/quaternius`.
- `scripts/make_og.py` renders the social OG image (`public/og.png`, 1200x630) from
  shipped assets only: `courtyard/{fountain,inn,shop,tower}.glb`, `nature/*.glb`,
  a pair of `characters/*.glb` posed from `characters/animations.glb`, and a
  procedural plaza (no floor model ships). Every courtyard/nature GLB is Meshopt,
  which Blender can't decode, so the script shells out to `gltf-transform cp` and
  caches the decompressed copies in `$TMPDIR/avelune_og_glb`. The character packs
  ship an unparented unit sphere as a bounds proxy that must be deleted, or it
  renders as a ball. The title and tagline are camera-locked text over a camera-locked scrim.
- `scripts/convert_nature.sh` converts the Quaternius Stylized Nature MegaKit (CC0,
  free tier, source at `~/GitHub/quaternius/stylized-nature-megakit/glTF`) into
  `public/models/nature/*.glb`: textures capped at 512px WebP, normal maps stripped,
  `--palette false` so two-material trees keep separate bark/leaves primitives,
  `alphaMode MASK` + `doubleSided` preserved (the runtime relies on both), Meshopt
  at the end. `bush1` swaps the autumn `Leaves_TwistedTree` texture for the green
  `Leaves_NormalTree`. Also covers `pine1-3`/`twisted1-3`/`dead1-3` (each the 3
  most distinct silhouettes of that family's 5 source variants, picked by bounding
  box and triangle count — `TwistedTree` keeps its autumn-red leaf texture as-is,
  the `bush1` green swap doesn't apply to the trees), `mushroom1-2`, and
  `pebble1-3` (mixed round/square). The twisted and dead trees are modelled two
  to three times the size of the others, so the script scales their root nodes
  (0.5 to 0.85) to keep every tree comparable at placement scale 1; the
  `SOLID_PROPS` radii in `shared/utils/props.ts` are the scaled trunks. `ONLY="a b"`
  reconverts a subset. The earlier Blender-built botanicals and
  their script are gone.
- `scripts/convert_monsters.sh` converts curated Quaternius Ultimate Monsters
  (`~/GitHub/quaternius/ultimate-monsters/{Big,Blob,Flying}/glTF`) into
  `public/models/monsters/*.glb` for ambient wildlife (`MushroomKing.glb` there
  is the unrelated Oracle model and is never touched by this script). These are
  skinned rigs, so `optimize` runs with `--simplify false --flatten false --join
  false --instance false` — untested flags here risk corrupting joints/weights.
  Before `optimize`, a `@gltf-transform/core` prepass (installed on the fly via
  `npm install --no-save` into a scratch dir, since the CLI package doesn't
  expose importable modules) drops every animation clip not in that model's keep
  list, and unconditionally re-points every texture at the source folder's own
  `Atlas_Monsters.png` on disk — the `Flying/` and `Blob/` folder `.gltf` files
  embed a broken 32x32 placeholder instead of the real 1024x1024 shared atlas
  that `Big/` embeds correctly, so the fix is applied to every folder rather
  than assumed per-folder.
- `scripts/build_courtyard_fountain.py` builds the original courtyard fountain
  at `public/models/courtyard/fountain.glb`. Run it headless without arguments;
  optional `--render` creates a studio preview after exporting.
- `scripts/build_kit.py` builds the twelve player build-kit pieces into
  `public/models/kit/*.glb` plus `manifest.json`, then `scripts/convert_kit.sh`
  Meshopt-compresses them (`optimize --simplify false --palette false`: the
  decimator rounds off grid-critical edges and a palette texture would defeat the
  triplanar overlay, which skips any material carrying a map). Conventions: 2 unit
  grid, origin at the bottom centre of the footprint, front is Blender +Y
  (exported glTF -Z), depth-wise rises (roof pitch, stair climb) run toward glTF
  +Z like `Courtyard_Stairs`, and the palette is the courtyard one so the town
  overlay picks the pieces up by material name. Every painted material needs its
  own roughness: COLOR_0 carries base colour, so materials sharing a roughness are
  byte-identical and `optimize`'s dedup collapses their names into one.
- `public/models/**` — the shipped `.glb` output: character models and shared
  animations, the Oracle monster, the original courtyard models, and the build kit.

## Environment (cold-start facts)
- **Blender 5.1.2** at `/Applications/Blender.app/Contents/MacOS/Blender`. Scripts
  run headless:
  `"/Applications/Blender.app/Contents/MacOS/Blender" --background --python scripts/<x>.py -- <args>`
- The local source library is `/Users/benjamincanac/GitHub/quaternius`. It
  remains available for future authored exports.
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
   `MazeScene.vue` can batch them. A piece that must sit flush on the ground
   needs its top measured, not guessed: placement `y = 0.01 - meshTop`, where
   `meshTop` is the mesh's Blender **max-Z**, not its height. Measure it headless
   with a `bound_box` world-Z scan, never by eye.
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

6. **Decode normalized attributes before baking transforms.** Optimized
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

## Working style
Run conversions headless and report the before/after file sizes and any dropped
meshes/animations. When a new pack needs a manual download, say exactly what to
fetch and where to drop it rather than guessing a URL.

## Wadeable fountain

The lower fountain radius is 3.8 at model scale, with water radius 3.05 at Y 0.48
and floor Y 0.12. Three exterior steps and the inner step at radius 2.85 to 3.05,
Y 0.30, match `FOUNTAIN` in `shared/utils/courtyard.ts`. Keep the generator profile
and shared collision dimensions aligned. The authored 1.4 scale applies to both.
