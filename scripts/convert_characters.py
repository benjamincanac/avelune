"""Convert Quaternius Ultimate Animated Character Pack .blends to GLB.

Run headless:
  Blender --background --python convert_characters.py -- <blends_dir> <out_dir>

Keeps only the animation clips the game uses so files stay small.
"""

import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
BLENDS_DIR = argv[0]
OUT_DIR = argv[1]

CHARACTERS = [
    "Knight_Male",
    "Knight_Golden_Female",
    "Elf",
    "Witch",
    "Wizard",
    "Viking_Male",
    "Goblin_Female",
    "Ninja_Male",
]

KEEP_ACTIONS = {"Idle", "Run", "Jump", "Roll", "Death", "Victory", "Walk"}

os.makedirs(OUT_DIR, exist_ok=True)

for name in CHARACTERS:
    path = os.path.join(BLENDS_DIR, f"{name}.blend")
    if not os.path.exists(path):
        print(f"SKIP {name}")
        continue
    bpy.ops.wm.open_mainfile(filepath=path)

    for action in list(bpy.data.actions):
        if action.name not in KEEP_ACTIONS:
            bpy.data.actions.remove(action)

    out = os.path.join(OUT_DIR, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_apply=False,  # armatures can't have modifiers applied
        export_animations=True,
    )
    print(f"OK {name} -> {os.path.getsize(out) // 1024} KB")

print("done")
