"""Convert an entire Quaternius CC0 .blend pack to prefixed GLBs.

Run headless:
  Blender --background --python convert_new_kits.py -- <blends_dir> <out_dir> <Prefix_>

Unlike convert_props.py (which converts a curated name list from the Ruins pack),
this converts EVERY .blend in the given pack — these are small low-poly building
blocks and the whole set is kept. Every output filename is PREFIXED so its GLB
basename (which is the prop `kind` everywhere in the codebase) can't collide with
existing kinds or across packs. e.g. Wall_Modular.blend + prefix "Dungeon_" ->
public/models/dungeon/Dungeon_Wall_Modular.glb

Prints `DIMS <PrefixedName>: W x D x H (w x d x h)` per model so wall/column
collision footprints can be tuned later. Same GLB export flags as convert_props.py.
"""

import glob
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
BLENDS_DIR = argv[0]
OUT_DIR = argv[1]
PREFIX = argv[2]

os.makedirs(OUT_DIR, exist_ok=True)

blends = sorted(glob.glob(os.path.join(BLENDS_DIR, "*.blend")))
print(f"PACK {BLENDS_DIR} -> {OUT_DIR} (prefix {PREFIX}): {len(blends)} blends")

for path in blends:
    name = os.path.splitext(os.path.basename(path))[0]
    prefixed = f"{PREFIX}{name}"
    bpy.ops.wm.open_mainfile(filepath=path)

    # Report the combined world-space bounding box of all mesh objects.
    xs, ys, zs = [], [], []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            xs.append(world.x)
            ys.append(world.y)
            zs.append(world.z)
    if xs:
        print(
            f"DIMS {prefixed}: {max(xs) - min(xs):.2f} x {max(ys) - min(ys):.2f} "
            f"x {max(zs) - min(zs):.2f} (w x d x h)"
        )
    else:
        print(f"WARN {prefixed}: no mesh geometry (degenerate/empty)")

    out = os.path.join(OUT_DIR, f"{prefixed}.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True)
    print(f"OK {prefixed} -> {os.path.getsize(out) // 1024} KB")

print("done")
