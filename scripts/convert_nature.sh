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
# Set ONLY to a space separated list of output names to convert a subset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATURE_SRC="${NATURE_SRC:-/Users/benjamincanac/GitHub/quaternius/stylized-nature-megakit/glTF}"
OUT="$ROOT/public/models/nature"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

GT=(npx --yes @gltf-transform/cli@4.4.1)

# out_name:src_name pairs
#
# pine1/2/3, twisted1/2/3, dead1/2/3 are the 3 most visually distinct
# silhouettes out of each family's 5 source variants (compared by bounding
# box and triangle count): a compact one, a tall/wide one and either a
# slender or sprawling outlier, so instancing across the arena doesn't read
# as repetition.
#   Pine_1 (compact, 2.4x7.1x3.2)  Pine_4 (tallest+widest, 4.0x9.9x2.8)
#   Pine_5 (slender spire, 1.1x8.6x2.0, lowest tri count)
#   TwistedTree_1 (sprawling, 11.4x15.5x8.6)  TwistedTree_2 (tallest+spindly, 8.5x17.8x6.5)
#   TwistedTree_5 (most compact, 6.7x14.6x6.8)
#   DeadTree_1 (shortest, 6.1x9.5x5.7)  DeadTree_4 (widest gnarled, 8.0x12.8x7.7)
#   DeadTree_5 (tallest, 8.4x16.4x8.4)
MODELS=(
  tree1:CommonTree_1 tree2:CommonTree_2 tree3:CommonTree_3 tree4:CommonTree_4 tree5:CommonTree_5
  bush1:Bush_Common bush2:Bush_Common_Flowers
  fern:Fern_1
  flowers1:Flower_3_Group flowers2:Flower_4_Group
  clover:Clover_1
  plant:Plant_1_Big
  rock1:Rock_Medium_1 rock2:Rock_Medium_2 rock3:Rock_Medium_3
  pine1:Pine_1 pine2:Pine_4 pine3:Pine_5
  twisted1:TwistedTree_1 twisted2:TwistedTree_2 twisted3:TwistedTree_5
  dead1:DeadTree_1 dead2:DeadTree_4 dead3:DeadTree_5
  mushroom1:Mushroom_Common mushroom2:Mushroom_Laetiporus
  pebble1:Pebble_Round_1 pebble2:Pebble_Square_1 pebble3:Pebble_Round_5
)

for pair in "${MODELS[@]}"; do
  out="${pair%%:*}"
  src="${pair##*:}"
  # ONLY="twisted1 dead2" reconverts just those outputs.
  if [[ -n "${ONLY:-}" && " $ONLY " != *" $out "* ]]; then continue; fi
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

  # The twisted and dead trees are modelled two to three times the size of the
  # common trees (15 to 19 m against 7 to 9 m). Scale the root nodes so every
  # tree kind is comparable at placement scale 1: planting, the hotbar ghost and
  # the shared collision discs all assume that. The runtime instancer bakes each
  # mesh's world matrix, so a node scale is enough.
  tree_scale=""
  case "$out" in
    twisted*) tree_scale=0.5 ;;
    dead1) tree_scale=0.85 ;;
    dead2) tree_scale=0.65 ;;
    dead3) tree_scale=0.55 ;;
  esac
  if [[ -n "$tree_scale" ]]; then
    jq --argjson s "$tree_scale" '(.scenes[0].nodes) as $roots
      | .nodes |= (to_entries | map(if (.key as $k | $roots | index($k)) != null
          then .value.scale = ((.value.scale // [1,1,1]) | map(. * $s)) else . end) | map(.value))' \
      "$work/$src.gltf" > "$work/$src.scaled.gltf"
    mv "$work/$src.scaled.gltf" "$work/$src.gltf"
  fi

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
