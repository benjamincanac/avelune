#!/usr/bin/env bash
#
# Convert curated Quaternius MegaKit models (Stylized Nature + Medieval Village)
# to small, self-contained GLBs (kit catalog; nothing places them in the stadium today).
#
# The kits ship .gltf + .bin + shared texture atlases; gltf-transform's `optimize`
# resizes textures, dedups, prunes, and meshopt-compresses each into one GLB. The
# engine registers a MeshoptDecoder so these load like any other model.
#
# Requires: npx (fetches @gltf-transform/cli on demand). Run once from the repo root:
#   ./scripts/convert_kits.sh
#
# Override pack locations with NATURE_SRC / VILLAGE_SRC if they live elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATURE_SRC="${NATURE_SRC:-$HOME/Downloads/quaternius/Stylized Nature MegaKit/glTF}"
VILLAGE_SRC="${VILLAGE_SRC:-$HOME/Downloads/quaternius/medieval-village-megakit/glTF}"

NATURE_OUT="$ROOT/public/models/nature"
VILLAGE_OUT="$ROOT/public/models/village"

NATURE=(
  CommonTree_1 CommonTree_2 CommonTree_3 Pine_1 Pine_2
  Rock_Medium_1 Rock_Medium_2 Rock_Medium_3 Pebble_Round_1 Pebble_Round_2
  Bush_Common Bush_Common_Flowers Grass_Common_Tall Grass_Wispy_Tall
  Fern_1 Clover_1 Flower_3_Group Plant_1 Mushroom_Common
)

VILLAGE=(
  # Tower + roofs (gable roofs are named by the footprint they cap: Roof_RoundTiles_WxD)
  Roof_Tower_RoundTiles Roof_RoundTiles_6x6 Roof_RoundTiles_4x4
  Roof_RoundTiles_4x6 Roof_RoundTiles_4x8 Roof_RoundTiles_6x4 Roof_RoundTiles_6x8
  Roof_Front_Brick4 Roof_Front_Brick6 Roof_Dormer_RoundTile
  Roof_Wooden_2x1
  # Walls: stone/plaster ground floor + timber-frame upper floor
  Wall_Plaster_Straight Wall_Plaster_Window_Wide_Round Wall_Plaster_Door_Round
  Wall_Plaster_WoodGrid Wall_UnevenBrick_Straight
  Wall_UnevenBrick_Window_Wide_Round Wall_UnevenBrick_Door_Round
  Wall_Plaster_Window_Thin_Round Wall_Arch
  Corner_Exterior_Wood Corner_Exterior_Brick
  # Jettied upper storey + balconies + stairs
  Overhang_Plaster_Long Overhang_Plaster_Short Overhang_Plaster_Corner
  Balcony_Simple_Straight Balcony_Simple_Corner Stairs_Exterior_Straight
  # Detail
  Door_1_Round Window_Wide_Round1 Window_Thin_Round1
  WindowShutters_Wide_Round_Open WindowShutters_Thin_Round_Closed
  Prop_Chimney Prop_Chimney2 Prop_Vine1 Prop_Vine2 Prop_Vine4
  Prop_Wagon Prop_WoodenFence_Single Prop_WoodenFence_Extension1
  Prop_Crate Prop_Support Prop_Brick1 Prop_Brick2
  # Road curbs + tower-yard fence
  Prop_ExteriorBorder_Straight1 Prop_ExteriorBorder_Corner
  Prop_MetalFence_Simple Prop_MetalFence_Ornament
)

GT=(npx --yes @gltf-transform/cli@latest)

# convert <src_dir> <out_dir> <texture_size> <names...>
convert() {
  local src_dir="$1" out_dir="$2" tex="$3"; shift 3
  mkdir -p "$out_dir"
  for name in "$@"; do
    local src="$src_dir/$name.gltf"
    if [[ ! -f "$src" ]]; then
      echo "SKIP $name (no $src)"
      continue
    fi
    "${GT[@]}" optimize "$src" "$out_dir/$name.glb" \
      --texture-size "$tex" --texture-compress webp >/dev/null 2>&1
    printf 'OK  %-32s %s KB\n' "$name" "$(( $(stat -f%z "$out_dir/$name.glb") / 1024 ))"
  done
}

echo "== Nature -> $NATURE_OUT =="
convert "$NATURE_SRC" "$NATURE_OUT" 512 "${NATURE[@]}"
echo "== Village -> $VILLAGE_OUT (1024px, crisper for close-up buildings) =="
convert "$VILLAGE_SRC" "$VILLAGE_OUT" 1024 "${VILLAGE[@]}"
echo "done"
