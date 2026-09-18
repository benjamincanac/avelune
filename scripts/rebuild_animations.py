"""Rebuild ONLY the shared clip library (animations.glb), adding the dash clips.

The packs under ~/GitHub/quaternius were renamed to lowercase-hyphenated
folders, which broke convert_universal_characters.py's hardcoded paths. This
targeted script rebuilds just animations.glb (no character regen) using the
current paths, and adds Sword_Dash + Shield_Dash on top of the shipped set.

It mirrors convert_universal_characters.py's build_animations(): import UAL1 +
UAL2, keep the shared universal skeleton (drop every mesh), then write each
wanted clip as its own NLA track so the exporter emits one animation per clip.

Run headless:
  Blender --background --python scripts/rebuild_animations.py -- [packs_dir] [out_dir]
"""

import bpy
import os
import sys
from bpy_extras import anim_utils
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PACKS = argv[0] if argv else os.path.expanduser("~/GitHub/quaternius")
OUT = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "public", "models", "characters")
OUT = os.path.abspath(OUT)

UAL1 = os.path.join(PACKS, "universal-animation-library", "Unreal-Godot", "UAL1_Standard.glb")
UAL2 = os.path.join(PACKS, "universal-animation-library-2", "Unreal-Godot", "UAL2_Standard.glb")

# Keep in sync with CLIPS_UAL1/CLIPS_UAL2 in convert_universal_characters.py.
CLIPS_UAL1 = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop",
              "Jump_Start", "Jump_Loop", "Jump_Land", "Roll", "Dance_Loop", "Death01",
              "Spell_Simple_Shoot"]
CLIPS_UAL2 = ["Slide_Start", "Slide_Loop", "Sword_Regular_A", "Yes",
              "Sword_Dash", "Shield_Dash", "Idle_FoldArms_Loop", "OverhandThrow"]
# Exported name -> library action, plus the pelvis lift baked into each.
RENAMED = {"Swim_Loop": "Swim_Fwd_Loop", "Swim_Idle": "Swim_Idle_Loop"}
LIFT = {"Swim_Loop": 0.80, "Swim_Idle": 0.60}


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in added if o.type == "ARMATURE"), None)
    meshes = [o for o in added if o.type == "MESH"]
    return arm, meshes


bpy.ops.wm.read_factory_settings(use_empty=True)

rig, m1 = import_gltf(UAL1)
for m in m1:
    bpy.data.objects.remove(m, do_unlink=True)
arm2, m2 = import_gltf(UAL2)
for m in m2:
    bpy.data.objects.remove(m, do_unlink=True)
if arm2 and arm2 is not rig:
    bpy.data.objects.remove(arm2, do_unlink=True)

rig.animation_data_clear()
rig.animation_data_create()
scene = bpy.context.scene


def lift_pelvis(action, metres):
    """Add a constant world-up offset to the pelvis location keys. Pose-bone
    location lives in the bone's rest space, so map world up through the posed
    parent chain first (the root bone never rotates in these clips)."""
    rig.animation_data.action = action
    scene.frame_set(int(action.frame_range[0]))
    pelvis = rig.pose.bones["pelvis"]
    basis = (rig.matrix_world.to_3x3() @ pelvis.parent.matrix.to_3x3()
             @ pelvis.parent.bone.matrix_local.to_3x3().inverted() @ pelvis.bone.matrix_local.to_3x3())
    local = basis.inverted() @ Vector((0.0, 0.0, metres))
    bag = anim_utils.action_get_channelbag_for_slot(action, action.slots[0])
    curves = [c for c in bag.fcurves if c.data_path == 'pose.bones["pelvis"].location']
    assert len(curves) == 3, "pelvis location is not keyed on all axes"
    for curve in curves:
        for key in curve.keyframe_points:
            key.co.y += local[curve.array_index]
            key.handle_left.y += local[curve.array_index]
            key.handle_right.y += local[curve.array_index]
    rig.animation_data.action = None


added = []
for name in CLIPS_UAL1 + CLIPS_UAL2 + list(RENAMED):
    act = bpy.data.actions.get(RENAMED.get(name, name))
    if not act:
        print("  MISSING clip %s" % name)
        continue
    if name in LIFT:
        lift_pelvis(act, LIFT[name])
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(act.frame_range[0]), act)
    strip.name = name
    added.append(name)
scene.frame_set(1)

os.makedirs(OUT, exist_ok=True)
out = os.path.join(OUT, "animations.glb")
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=False,          # armature deform modifiers must survive
    use_selection=False,
    export_yup=True,
    export_image_format="WEBP",
    export_image_quality=80,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_force_sampling=True,
)
print("OK animations.glb clips=%d -> %d KB" % (len(added), os.path.getsize(out) // 1024))
print("   " + ", ".join(added))
