"""Extract the swimming clips from Quaternius' Universal Animation Library.

Run: Blender --background --python scripts/build_swim_animations.py -- [ual1.glb]

Writes public/models/characters/swimming.glb with Swim_Fwd_Loop and
Swim_Idle_Loop exported as Swim_Loop and Swim_Idle on the shared universal
skeleton, so the client clip names stay stable. Uses the non-RM library file:
the moat kinematics own forward motion, the clip may not translate the root.
"""
import json
import math
import os
import struct
import sys

import bpy
from bpy_extras import anim_utils
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SOURCE = argv[0] if argv else os.path.expanduser('~/GitHub/quaternius/universal-animation-library/Unreal-Godot/UAL1_Standard.glb')
OUTPUT = os.path.join(ROOT, 'public/models/characters/swimming.glb')
CLIPS = {'Swim_Loop': 'Swim_Fwd_Loop', 'Swim_Idle': 'Swim_Idle_Loop'}
# The library poses the swimmer around the feet origin, so the body would hang
# MOAT.swimDraft below the surface. Lift the pelvis so the stroke rides the
# waterline and the treading head clears it. Metres, world up.
LIFT = {'Swim_Loop': 0.80, 'Swim_Idle': 0.60}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOURCE)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
    bpy.data.objects.remove(obj, do_unlink=True)
rest = {bone.name for bone in rig.data.bones}
scene = bpy.context.scene


def lift_pelvis(action, metres):
    """Add a constant world-up offset to the pelvis location keys. Pose-bone
    location lives in the bone's rest space, so map world up through the posed
    parent chain first (the root bone never rotates in these clips)."""
    rig.animation_data.action = action
    scene.frame_set(int(action.frame_range[0]))
    pelvis = rig.pose.bones['pelvis']
    basis = rig.matrix_world.to_3x3() @ pelvis.parent.matrix.to_3x3() @ pelvis.parent.bone.matrix_local.to_3x3().inverted() @ pelvis.bone.matrix_local.to_3x3()
    local = basis.inverted() @ Vector((0.0, 0.0, metres))
    bag = anim_utils.action_get_channelbag_for_slot(action, action.slots[0])
    curves = [c for c in bag.fcurves if c.data_path == 'pose.bones["pelvis"].location']
    assert len(curves) == 3, 'pelvis location is not keyed on all axes'
    for curve in curves:
        for key in curve.keyframe_points:
            key.co.y += local[curve.array_index]
            key.handle_left.y += local[curve.array_index]
            key.handle_right.y += local[curve.array_index]
    rig.animation_data.action = None

rig.animation_data_clear()
rig.animation_data_create()
for name, source in CLIPS.items():
    action = bpy.data.actions[source]
    lift_pelvis(action, LIFT[name])
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(action.frame_range[0]), action)
    strip.name = name

scene.frame_set(1)
bpy.ops.export_scene.gltf(
    filepath=OUTPUT,
    export_format='GLB',
    export_apply=False,
    export_yup=True,
    export_animations=True,
    export_animation_mode='NLA_TRACKS',
    export_force_sampling=True,
)

# Validate the binary: names, no meshes, finite seamless tracks, no root motion.
with open(OUTPUT, 'rb') as handle:
    raw = handle.read()
json_length = struct.unpack_from('<I', raw, 12)[0]
document = json.loads(raw[20:20 + json_length])
binary_start = 20 + json_length + 8


def values(accessor_index):
    accessor = document['accessors'][accessor_index]
    view = document['bufferViews'][accessor['bufferView']]
    components = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    assert accessor['componentType'] == 5126
    start = binary_start + view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return struct.unpack_from('<' + 'f' * accessor['count'] * components, raw, start), components


assert {clip['name'] for clip in document['animations']} == set(CLIPS)
assert not document.get('meshes'), 'The clip library must contain no character meshes'
for clip in document['animations']:
    length = 0
    for channel in clip['channels']:
        sampler = clip['samplers'][channel['sampler']]
        times, _ = values(sampler['input'])
        samples, width = values(sampler['output'])
        length = max(length, times[-1] - times[0])
        assert all(math.isfinite(value) for value in samples)
        assert max(abs(a - b) for a, b in zip(samples[:width], samples[-width:])) < 0.01, clip['name'] + ' does not loop'
        name = document['nodes'][channel['target']['node']]['name']
        assert name in rest, 'Animation changed the universal skeleton binding: ' + name
        if name == 'root' and channel['target']['path'] == 'translation':
            assert max(samples) - min(samples) < 0.0001, 'Swimming may not translate the root'
    print(clip['name'], '%.2f seconds, seamless finite tracks:' % length, len(clip['channels']))
print('Wrote', OUTPUT, len(raw), 'bytes')
