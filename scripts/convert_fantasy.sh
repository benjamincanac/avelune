#!/usr/bin/env bash
#
# Convert curated Quaternius "Fantasy Props MegaKit" models to small, self-contained
# GLBs (kit catalog; nothing places them in the stadium today).
#
# The kit ships .gltf + .bin + shared PBR trim atlases (T_Trim_*). gltf-transform's
# `optimize` resolves those references, resizes/compresses the textures, dedups, prunes,
# and meshopt-compresses each model into one GLB. The engine already registers a
# MeshoptDecoder, so these load like any other model.
#
# Requires: npx (fetches @gltf-transform/cli on demand). Run once from the repo root:
#   ./scripts/convert_fantasy.sh
#
# Override the pack location with FANTASY_SRC if it lives elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FANTASY_SRC="${FANTASY_SRC:-$HOME/Downloads/quaternius/Fantasy Props MegaKit/Exports/glTF}"
FANTASY_OUT="$ROOT/public/models/fantasy"

FANTASY=(
  Bookcase_2 Chair_1 Bench Stool Bed_Twin1
  Chandelier CandleStick CandleStick_Triple
  Chest_Wood Barrel Crate_Wooden
  Banner_1 Banner_2 WeaponStand Sword_Bronze Shield_Wooden
  Cauldron BookStand Book_Stack_1 Coin_Pile Coin_Pile_2
  Cabinet Shelf_Simple Lantern_Wall Torch_Metal Rope_1
  Anvil Workbench Cage_Small Vase_2 Potion_1 Scroll_1 Table_Large
)

GT=(npx --yes @gltf-transform/cli@latest)

mkdir -p "$FANTASY_OUT"
echo "== Fantasy -> $FANTASY_OUT =="
for name in "${FANTASY[@]}"; do
  src="$FANTASY_SRC/$name.gltf"
  if [[ ! -f "$src" ]]; then
    echo "SKIP $name (no $src)"
    continue
  fi
  "${GT[@]}" optimize "$src" "$FANTASY_OUT/$name.glb" \
    --texture-size 512 --texture-compress webp >/dev/null 2>&1
  printf 'OK  %-24s %s KB\n' "$name" "$(( $(stat -f%z "$FANTASY_OUT/$name.glb") / 1024 ))"
done
echo "done"
