"""Rebuild sprint from the bundled jog's footwork and gait phase.

Run Blender --background --python scripts/build_sprint_animation.py.
The separate clip overrides Sprint_Loop without modifying the shared library.
"""
import json
import math
import os
import struct

import bpy
from mathutils import Quaternion, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE = os.path.join(ROOT, 'public/models/characters/animations.glb')
OUTPUT = os.path.join(ROOT, 'public/models/characters/sprinting.glb')
FPS = 60
FRAMES = 34
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOURCE)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
source = bpy.data.actions['Jog_Fwd_Loop']
start, end = source.frame_range
rig.animation_data_clear()
rig.animation_data_create()
rig.animation_data.action = source
scene = bpy.context.scene
rest = {bone.name: bone.matrix_local.to_quaternion() for bone in rig.data.bones}


def orient_world(name, direction):
    bone = rig.data.bones[name]
    pose = rig.pose.bones[name]
    original = (bone.tail_local - bone.head_local).normalized()
    desired = original.rotation_difference(Vector(direction).normalized()) @ rest[name]
    inherited = pose.parent.matrix.to_quaternion() @ rest[pose.parent.name].inverted() @ rest[name] if pose.parent else rest[name]
    pose.rotation_quaternion = inherited.inverted() @ desired
    bpy.context.view_layer.update()


# Capture the source before assigning the authored action. Sampling by normalized
# phase lets the runtime preserve footfall timing when changing between gaits.
poses = []
for frame in range(FRAMES + 1):
    sample = start + (frame % FRAMES) / FRAMES * (end - start)
    scene.frame_set(int(sample), subframe=sample % 1)
    poses.append({bone.name: (bone.location.copy(), bone.rotation_quaternion.copy(), bone.scale.copy()) for bone in rig.pose.bones})
rig.animation_data.action = None
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)
action = bpy.data.actions.new('Sprint_Loop')
rig.animation_data.action = action
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = FRAMES + 1
for frame, source_pose in enumerate(poses, 1):
    scene.frame_set(frame)
    for bone in rig.pose.bones:
        bone.rotation_mode = 'QUATERNION'
        bone.location, bone.rotation_quaternion, bone.scale = source_pose[bone.name]
    root = rig.pose.bones['root']
    root.location = (0, 0, 0)
    pelvis = rig.pose.bones['pelvis']
    # Slight acceleration pitch without bending the athlete at the waist.
    basis = rest['pelvis']
    pelvis.rotation_quaternion = (basis.inverted() @ Quaternion(Vector((1, 0, 0)), math.radians(5)) @ basis) @ pelvis.rotation_quaternion
    bpy.context.view_layer.update()
    for side, sign in [('l', 1), ('r', -1)]:
        thigh = rig.pose.bones['thigh_' + side]
        calf = rig.pose.bones['calf_' + side]
        # Opposite arm follows thigh angle, not an independent oscillation.
        # Keep elbows beside the ribs, avoiding the original lateral flailing.
        leg = (calf.head - thigh.head).normalized()
        angle = max(-1, min(1, -leg.y)) * math.radians(62)
        orient_world('upperarm_' + side, (sign * .09, math.sin(angle), -math.cos(angle)))
        # Fixed bend around 85 degrees with a little opening in the rear drive.
        forearm_angle = angle - math.radians(88 - 9 * max(0, math.sin(angle)))
        orient_world('lowerarm_' + side, (-sign * .045, math.sin(forearm_angle), -math.cos(forearm_angle)))
    for bone in rig.pose.bones:
        bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
        bone.keyframe_insert('location', frame=frame, group=bone.name)
        bone.keyframe_insert('scale', frame=frame, group=bone.name)
rig.animation_data.action = None
track = rig.animation_data.nla_tracks.new()
track.name = 'Sprint_Loop'
strip = track.strips.new('Sprint_Loop', 1, action)
strip.name = 'Sprint_Loop'
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=OUTPUT, export_format='GLB', export_apply=False, export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True)
raw = open(OUTPUT, 'rb').read()
length = struct.unpack_from('<I', raw, 12)[0]
doc = json.loads(raw[20:20 + length])
binary = 28 + length

def values(index):
    accessor = doc['accessors'][index]
    view = doc['bufferViews'][accessor['bufferView']]
    width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    offset = binary + view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return struct.unpack_from('<' + 'f' * accessor['count'] * width, raw, offset), width

assert len(doc['animations']) == 1 and doc['animations'][0]['name'] == 'Sprint_Loop'
assert not doc.get('meshes')
for channel in doc['animations'][0]['channels']:
    sampler = doc['animations'][0]['samplers'][channel['sampler']]
    times, _ = values(sampler['input'])
    samples, width = values(sampler['output'])
    assert abs(times[-1] - times[0] - FRAMES / FPS) < .001
    assert all(math.isfinite(value) for value in samples)
    assert max(abs(a - b) for a, b in zip(samples[:width], samples[-width:])) < .0001
    name = doc['nodes'][channel['target']['node']]['name']
    assert name in rest
    if name == 'root' and channel['target']['path'] == 'translation':
        assert max(abs(value) for value in samples) < .0001
print('Sprint_Loop:', FRAMES / FPS, 'seconds, seamless, zero root drift,', len(raw), 'bytes')
