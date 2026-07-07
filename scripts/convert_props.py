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
    # Tower-interior masonry + fittings
    "Wall",
    "Wall_Half",
    "Wall_ArchRound",
    "Wall_Broken",
    "Wall_Hole",
    "Window_Open",
    "Doors_GothicArch",
    "Doors_RoundArch",
    "Stairs",
    "Stairs_2",
    "Rail_Corner",
    "Rail_Divider",
    "Bookcase_Full",
    "Bookcase_Empty",
    "Chest_Gold",
    "Pot1",
    "Pot2",
    "Pot3",
    "Candles_2",
    "Trapdoor",
    "Arch_Gothic_RoundColumn",
    # Extra floor tiles (ruined + edges + overgrown)
    "Floor_Hole_Corner",
    "Floor_Hole_Straight",
    "Floor_Standard_Half",
    "Floor_Tree",
    # Wall + window variety, incl. the overgrown (Verdant) set
    "Wall_ArchGothic",
    "Wall_ArchRound_Broken",
    "Wall_Overgrown",
    "Wall_ArchRound_Overgrown",
    "Wall_ArchRound_Overgrown_Broken",
    "Window_Bars",
    "Window_Bars_Overgrown",
    # Curved corner walls (plain — the *_Overgrown pair is already converted)
    "Curve_1",
    "Curve_2",
    # Arch + door + banner variety
    "Arch_Round_RoundColumn",
    "Doors_GothicArch_Covered",
    "Doors_RoundArch_Covered",
    "Flag_GothicArch",
    "Flag_RoundArch",
    "Flag_Wall2",
    # Ground hazards
    "BearTrap_Closed",
    "BearTrap_Open",
    # Water-biome bridge
    "BridgeSection",
    "Column_BridgeSupport",
    # Scatter: broken pot, dead trees, larger bushes
    "Pot3_Broken",
    "DeadTree_2",
    "DeadTree_3",
    "Bush_2x1",
    "Bush_2x2",
    "Bush_Large",
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
