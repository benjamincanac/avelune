#!/usr/bin/env bash
#
# Convert curated Quaternius Ultimate Monsters models to small, skinned
# GLBs for public/models/monsters/ (ambient critters, not the Oracle).
#
# Two defects in the source pack need handling before gltf-transform's
# `optimize` ever sees these files:
#
#   1. Every model shares one Atlas_Monsters.png per folder, but the Flying/
#      and Blob/ folder .gltf files embed a broken 32x32 placeholder texture
#      instead of the real 1024x1024 atlas that sits right beside them on
#      disk (Big/ folder .gltf files embed the real one already). Silently
#      running these through the normal pipeline ships a near-blank texture.
#      prep_monster.mjs always re-points every texture at the folder's own
#      Atlas_Monsters.png on disk, regardless of what's embedded, so the fix
#      applies uniformly and doesn't depend on which folder happened to be
#      correct.
#   2. Each model ships every clip from its shared Mixamo-style rig (Idle,
#      Walk, Punch, Wave, …). Ambient critters only need a couple, so
#      prep_monster.mjs also drops every Animation not in the keep list
#      before optimize ever touches keyframe data.
#
# Both fixes run through @gltf-transform/core directly (prep_monster.mjs),
# then the result is handed to the `optimize` CLI for WebP textures +
# meshopt. These are skinned meshes: --simplify/--flatten/--join/--instance
# are all disabled since none of them are needed for a single ambient
# instance and simplify in particular is not safe to trust on skinned
# geometry without per-model verification.
#
# Requires: npx (fetches @gltf-transform/cli on demand), npm (installs
# @gltf-transform/core + @gltf-transform/extensions into a scratch dir so
# prep_monster.mjs can import them). Run once from the repo root:
#   ./scripts/convert_monsters.sh
#
# Override the pack location with MONSTERS_SRC if it lives elsewhere.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONSTERS_SRC="${MONSTERS_SRC:-/Users/benjamincanac/GitHub/quaternius/ultimate-monsters}"
OUT="$ROOT/public/models/monsters"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

GT=(npx --yes @gltf-transform/cli@4.4.1)

cat > "$TMP/prep_monster.mjs" <<'EOF'
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync } from 'node:fs';

// Usage: node prep_monster.mjs <input.gltf> <output.glb> <keep,clip,names> <atlas.png>
const [, , input, output, keepCsv, atlasPath] = process.argv;
const keep = new Set(keepCsv.split(','));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);

const atlasBytes = readFileSync(atlasPath);
for (const tex of doc.getRoot().listTextures()) {
  tex.setImage(atlasBytes);
  tex.setMimeType('image/png');
}

for (const anim of doc.getRoot().listAnimations()) {
  if (!keep.has(anim.getName())) {
    anim.dispose();
  }
}

await io.write(output, doc);
EOF

(cd "$TMP" && npm init -y >/dev/null 2>&1 && npm install --no-save --silent \
  @gltf-transform/core@4.4.1 @gltf-transform/extensions@4.4.1 >/dev/null 2>&1)

# out_name:folder:src_name:keep_clips (csv, no spaces)
MODELS=(
  "Chicken:Blob:Chicken:Idle,Walk,Jump"
  "Pigeon:Flying:Pigeon:Flying_Idle,Fast_Flying"
  "Bunny:Big:Bunny:Idle,Walk,Run,Jump"
  "Frog:Big:Frog:Idle,Walk,Run,Jump"
  "Mushnub:Blob:Mushnub:Idle,Walk,Jump"
  "Ghost:Flying:Ghost:Flying_Idle,Fast_Flying"
  "Dragon:Flying:Dragon:Flying_Idle,Fast_Flying"
)

for entry in "${MODELS[@]}"; do
  IFS=':' read -r out folder src keep <<< "$entry"
  src_gltf="$MONSTERS_SRC/$folder/glTF/$src.gltf"
  atlas="$MONSTERS_SRC/$folder/glTF/Atlas_Monsters.png"
  if [[ ! -f "$src_gltf" ]]; then
    echo "SKIP $out (no $src_gltf)"
    continue
  fi

  prepped="$TMP/$out.prepped.glb"
  node "$TMP/prep_monster.mjs" "$src_gltf" "$prepped" "$keep" "$atlas"

  "${GT[@]}" optimize "$prepped" "$OUT/$out.glb" \
    --texture-size 512 --texture-compress webp --palette false \
    --simplify false --flatten false --join false --instance false >/dev/null

  printf 'OK  %-10s <- %-8s/%-10s [%s]  %s KB\n' "$out" "$folder" "$src" "$keep" \
    "$(( $(stat -f%z "$OUT/$out.glb") / 1024 ))"
done

echo done
