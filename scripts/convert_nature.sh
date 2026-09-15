#!/usr/bin/env bash
#
# Convert curated Quaternius Stylized Nature MegaKit models to small,
# self-contained GLBs for public/models/nature/.
#
# The kit ships .gltf + .bin + PNG textures (including 4 MB bark normal maps
# the stylized look doesn't need). For each model this script copies the
# .gltf/.bin/textures into a scratch dir, strips `normalTexture` from every
# material with jq, then runs gltf-transform optimize (512px WebP textures,
# meshopt compression, palette disabled so material names/count survive).
#
# Requires: npx (fetches @gltf-transform/cli on demand), jq. Run once from
# the repo root:
#   ./scripts/convert_nature.sh
#
# Override the pack location with NATURE_SRC if it lives elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATURE_SRC="${NATURE_SRC:-/Users/benjamincanac/GitHub/quaternius/stylized-nature-megakit/glTF}"
OUT="$ROOT/public/models/nature"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

GT=(npx --yes @gltf-transform/cli@4.4.1)

# out_name:src_name pairs
MODELS=(
  tree1:CommonTree_1 tree2:CommonTree_2 tree3:CommonTree_3 tree4:CommonTree_4 tree5:CommonTree_5
  bush1:Bush_Common bush2:Bush_Common_Flowers
  fern:Fern_1
  flowers1:Flower_3_Group flowers2:Flower_4_Group
  clover:Clover_1
  plant:Plant_1_Big
  rock1:Rock_Medium_1 rock2:Rock_Medium_2 rock3:Rock_Medium_3
)

for pair in "${MODELS[@]}"; do
  out="${pair%%:*}"
  src="${pair##*:}"
  src_gltf="$NATURE_SRC/$src.gltf"
  if [[ ! -f "$src_gltf" ]]; then
    echo "SKIP $out (no $src_gltf)"
    continue
  fi

  work="$TMP/$src"
  mkdir -p "$work"
  cp "$src_gltf" "$work/$src.gltf"
  [[ -f "$NATURE_SRC/$src.bin" ]] && cp "$NATURE_SRC/$src.bin" "$work/"

  # Per-output overrides applied to the scratch .gltf before texture copy/optimize.
  case "$out" in
    bush1)
      # Bush_Common ships pointed at the autumn Leaves_TwistedTree_C texture,
      # which renders as a red blob in this arena. Swap in the same pack's
      # green Leaves_NormalTree_C texture/material (the one the trees use)
      # so the bush matches the palette.
      jq '.images |= map(if .uri == "Leaves_TwistedTree_C.png" then (.uri = "Leaves_NormalTree_C.png" | .name = "Leaves_NormalTree_C") else . end)
        | .materials |= map(if .name == "Leaves_TwistedTree" then .name = "Leaves_NormalTree" else . end)' \
        "$work/$src.gltf" > "$work/$src.override.gltf"
      mv "$work/$src.override.gltf" "$work/$src.gltf"
      ;;
  esac

  # copy every texture the gltf references, then strip normalTexture slots
  # (normal maps aren't needed for this stylized look and the bark PNGs are
  # 4 MB each; the leftover image/texture entries get pruned by `optimize`)
  for uri in $(jq -r '.images[]?.uri // empty' "$work/$src.gltf"); do
    cp "$NATURE_SRC/$uri" "$work/$uri"
  done
  jq 'if .materials then .materials |= map(del(.normalTexture)) else . end' \
    "$work/$src.gltf" > "$work/$src.stripped.gltf"
  mv "$work/$src.stripped.gltf" "$work/$src.gltf"

  "${GT[@]}" optimize "$work/$src.gltf" "$OUT/$out.glb" \
    --texture-size 512 --texture-compress webp --palette false >/dev/null

  printf 'OK  %-10s <- %-20s %s KB\n' "$out" "$src" "$(( $(stat -f%z "$OUT/$out.glb") / 1024 ))"
done

echo done
