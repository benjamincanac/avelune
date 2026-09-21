#!/usr/bin/env bash
#
# Compress the player build kit exported by scripts/build_kit.py.
#
# Same gltf-transform flow as convert_nature.sh, minus the texture work: these are
# Blender-authored, untextured, COLOR_0-painted pieces, so the passes that matter
# are dedup/prune/weld plus Meshopt. Two are turned off on purpose:
#   --simplify false  low-poly kit geometry has no spare triangles to collapse,
#                     and the decimator rounds off the grid-critical edges.
#   --palette false   COLOR_0 already carries the paint; a palette texture would
#                     add an image and defeat the triplanar town overlay, which
#                     skips any material that has a map.
#
# Requires: npx. Run from anywhere:
#   ./scripts/convert_kit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/public/models/kit"
GT=(npx --yes @gltf-transform/cli@4.4.1)

for src in "$DIR"/Kit_*.glb; do
  name="$(basename "$src" .glb)"
  before=$(stat -f%z "$src")
  "${GT[@]}" optimize "$src" "$src" \
    --compress meshopt --simplify false --palette false \
    --texture-compress webp --texture-size 512 >/dev/null
  after=$(stat -f%z "$src")
  printf 'OK  %-16s %6s B -> %6s B\n' "$name" "$before" "$after"
done
