"""Convert selected Quaternius Ultimate Modular Ruins .blend files to GLB.

Run headless:
  Blender --background --python convert_props.py -- <blends_dir> <out_dir>

Prints each prop's bounding box so placement scales can be chosen sensibly.
"""

import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
BLENDS_DIR = argv[0]
OUT_DIR = argv[1]

PROPS = [
    "Statue_Fox",
    "Statue_Stag",
    "Cart",
    "Crate",
    "Barrel",
    "Chest",
    "Flag_Wall",
    "Bricks",
    "Skull",
    "Pot1_Broken",
    "Pot2_Broken",
    "Column_Round_Short",
    "Bush_1x1",
    "Bush_Round",
    "Grass",
    "DeadTree_1",
    "Candles_1",
    # Structural modules
    "Floor_Standard",
    "Floor_Squares",
    "Floor_Diamond",
    "Floor_SquareLarge",
    "Arch_Gothic",
    "Arch_Round",
    "Column_Round",
    "Column_Square",
    "Support_Center",
    "Support_Left",
    "Support_Right",
    "Support_Tall",
    "Rail_Straight",
    "Curve_1_Overgrown",
    "Curve_2_Overgrown",
    "Torch",
]

os.makedirs(OUT_DIR, exist_ok=True)

for name in PROPS:
    path = os.path.join(BLENDS_DIR, f"{name}.blend")
    if not os.path.exists(path):
        print(f"SKIP {name}: no such blend")
        continue
    bpy.ops.wm.open_mainfile(filepath=path)

    # Report the combined bounding box of all mesh objects.
    from mathutils import Vector
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
        print(f"DIMS {name}: {max(xs) - min(xs):.2f} x {max(ys) - min(ys):.2f} x {max(zs) - min(zs):.2f} (w x d x h)")

    out = os.path.join(OUT_DIR, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True)
    print(f"OK {name} -> {os.path.getsize(out) // 1024} KB")

print("done")
