"""Author original swimming clips on the bundled universal character skeleton.

Run: Blender --background --python scripts/build_swim_animations.py
No downloaded animation packs are needed. The output is a separate skeleton
and clip library, so the existing locomotion library stays untouched.
"""

import json
import math
import os
import struct

import bpy
from mathutils import Quaternion, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE = os.path.join(ROOT, 'public/models/characters/animations.glb')
OUTPUT = os.path.join(ROOT, 'public/models/characters/swimming.glb')
FPS = 30
FRAMES = 60
TAU = math.pi * 2

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOURCE)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
rig.animation_data_clear()
for obj in list(bpy.data.objects):
    if obj != rig:
        bpy.data.objects.remove(obj, do_unlink=True)
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)

scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = FRAMES + 1
rig.animation_data_create()
rest = {bone.name: bone.matrix_local.to_quaternion() for bone in rig.data.bones}


def rotate(name, axis, degrees):
    """A rest-space axis keeps mirrored bone rolls out of the authored motion."""
    basis = rest[name]
    rig.pose.bones[name].rotation_quaternion = basis.inverted() @ Quaternion(Vector(axis), math.radians(degrees)) @ basis


def orient_world(name, direction, twist=0):
    """Set an armature-space direction, compensating for the posed parent.

    Assigning the desired swing directly as a local quaternion double-rotates
    elbows and knees once their parent turns. Solve against the inherited rest
    frame instead, retaining the original roll of the universal skeleton.
    """
    bone = rig.data.bones[name]
    pose = rig.pose.bones[name]
    rest_direction = (bone.tail_local - bone.head_local).normalized()
    axis = Vector(direction).normalized()
    desired = Quaternion(axis, math.radians(twist)) @ rest_direction.rotation_difference(axis) @ rest[name]
    if pose.parent:
        inherited = pose.parent.matrix.to_quaternion() @ rest[pose.parent.name].inverted() @ rest[name]
    else:
        inherited = rest[name]
    pose.rotation_quaternion = inherited.inverted() @ desired
    bpy.context.view_layer.update()


def solve_limb(upper_name, lower_name, target, pole):
    """Analytic two-bone IK with an explicit elbow/knee bending plane."""
    start = rig.pose.bones[upper_name].head.copy()
    upper_length = rig.data.bones[upper_name].length
    lower_length = rig.data.bones[lower_name].length
    axis = target - start
    distance = min(axis.length, upper_length + lower_length - 0.002)
    distance = max(distance, abs(upper_length - lower_length) + 0.002)
    axis.normalize()
    bend = pole - start
    bend = (bend - axis * bend.dot(axis)).normalized()
    along = (upper_length ** 2 - lower_length ** 2 + distance ** 2) / (2 * distance)
    height = math.sqrt(max(0, upper_length ** 2 - along ** 2))
    elbow = start + axis * along + bend * height
    orient_world(upper_name, elbow - start)
    orient_world(lower_name, start + axis * distance - elbow)


def sample(keys, phase):
    """Cyclic cubic Hermite path with continuous velocity at catch/recovery.

    Equal adjacent poses define the intentional glide hold. Other waypoints
    preserve their shared tangent instead of stopping the limb at every key.
    """
    count = len(keys) - 1
    phase %= 1

    def tangent(index):
        i = index % count
        prev_t, prev = keys[(i - 1) % count]
        t, value = keys[i]
        next_t, following = keys[(i + 1) % count]
        if i == 0:
            prev_t -= 1
        if i == count - 1:
            next_t += 1
        if (Vector(value) - Vector(prev)).length < 0.00001 or (Vector(value) - Vector(following)).length < 0.00001:
            return Vector((0, 0, 0))
        return (Vector(following) - Vector(prev)) / (next_t - prev_t)

    for index, ((ta, a), (tb, b)) in enumerate(zip(keys, keys[1:])):
        if phase <= tb:
            t = (phase - ta) / (tb - ta)
            ma, mb = tangent(index) * (tb - ta), tangent(index + 1) * (tb - ta)
            return (2*t**3 - 3*t*t + 1) * Vector(a) + (t**3 - 2*t*t + t)*ma + (-2*t**3 + 3*t*t)*Vector(b) + (t**3 - t*t)*mb
    return Vector(keys[-1][1])


def pose_swim(phase, moving):
    for bone in rig.pose.bones:
        bone.location = (0, 0, 0)
        bone.rotation_mode = 'QUATERNION'
        bone.rotation_quaternion = (1, 0, 0, 0)
        bone.scale = (1, 1, 1)
    cycle = phase / TAU
    # A breaststroke cycle is pull, breathe, recover, kick, then glide. Both
    # sides share the same phase. The hands recover underneath the chin and
    # the heels recover toward the seat before sweeping outward and together.
    breath = math.sin(math.pi * max(0, min(1, (cycle - 0.25) / 0.42))) ** 2
    pitch = 82 - breath * 4 if moving else 8
    rotate('pelvis', (1, 0, 0), pitch)
    height_offset = (-0.055 + breath * 0.018) if moving else (-0.43 + math.sin(phase * 2) * 0.012)
    rig.pose.bones['pelvis'].location = rest['pelvis'].inverted() @ Vector((0, 0, height_offset))
    rotate('spine_01', (1, 0, 0), -breath * 3 if moving else -1)
    rotate('spine_02', (1, 0, 0), -breath * 5 if moving else -1)
    rotate('spine_03', (1, 0, 0), -breath * 4 if moving else 0)
    rotate('neck_01', (1, 0, 0), -14 - breath * 12 if moving else -5)
    rotate('Head', (1, 0, 0), -8 - breath * 10 if moving else -2)
    for suffix, side in [('l', 1), ('r', -1)]:
        # Shoulder blades slide forward during the reach, then retract as
        # the forearms catch the water. This keeps the shoulders alive.
        rotate('clavicle_' + suffix, (0, 1, 0), side * (-5 + breath * 7) if moving else 0)
    bpy.context.view_layer.update()
    body = rig.pose.bones['pelvis'].matrix.to_quaternion() @ rest['pelvis'].inverted()
    pelvis_rest = rig.data.bones['pelvis'].head_local
    pelvis_pos = rig.pose.bones['pelvis'].head.copy()

    def point(value, side):
        return pelvis_pos + body @ (Vector((value[0] * side, value[1], value[2])) - pelvis_rest)

    for suffix, side in [('l', 1), ('r', -1)]:
        if moving:
            hand = sample([
                (0, (0.10, 0.025, 1.96)),
                (0.12, (0.10, 0.025, 1.96)),
                (0.29, (0.40, -0.035, 1.90)),
                (0.39, (0.48, -0.12, 1.73)),
                (0.48, (0.31, -0.25, 1.55)),
                (0.56, (0.075, -0.24, 1.57)),
                (0.66, (0.08, -0.06, 1.82)),
                (0.76, (0.10, 0.025, 1.96)),
                (1, (0.10, 0.025, 1.96)),
            ], cycle)
            ankle = sample([
                (0, (0.075, 0.03, 0.112)),
                (0.35, (0.075, 0.03, 0.112)),
                (0.51, (0.17, 0.10, 0.29)),
                (0.62, (0.27, 0.095, 0.48)),
                (0.72, (0.34, 0.045, 0.24)),
                (0.82, (0.075, 0.03, 0.112)),
                (1, (0.075, 0.03, 0.112)),
            ], cycle)
            elbow_pole = sample([
                (0, (0.36, -0.12, 1.74)),
                (0.18, (0.36, -0.12, 1.74)),
                (0.38, (0.60, 0.015, 1.57)),
                (0.49, (0.42, -0.04, 1.40)),
                (0.58, (0.19, -0.23, 1.40)),
                (0.76, (0.36, -0.12, 1.74)),
                (1, (0.36, -0.12, 1.74)),
            ], cycle)
            knee_pole = (0.14, -0.42, 0.52)
            hand_direction = sample([
                (0, (0.04, -0.03, 1)),
                (0.18, (0.04, -0.03, 1)),
                (0.35, (0.30, -0.30, 0.90)),
                (0.47, (-0.70, -0.30, 0.40)),
                (0.56, (-0.06, 0.02, 1)),
                (0.76, (0.04, -0.03, 1)),
                (1, (0.04, -0.03, 1)),
            ], cycle)
            hand_direction.x *= side

        else:
            # Quiet symmetric sculling and a small frog kick keep the idle
            # silhouette upright without an alternating running leg motion.
            hand = Vector((0.43 + math.cos(phase) * 0.065, -0.25, 1.05 + math.sin(phase) * 0.02))
            ankle = Vector((0.20 + math.sin(phase) * 0.055, 0.11 + math.cos(phase) * 0.04, 0.20))
            elbow_pole = (0.65, 0.0, 1.12)
            knee_pole = (0.38, -0.30, 0.56)
            hand_direction = Vector((side * 0.7, -0.7, 0.1))
        solve_limb('upperarm_' + suffix, 'lowerarm_' + suffix, point(hand, side), point(elbow_pole, side))
        orient_world('hand_' + suffix, body @ hand_direction, side * breath * 18 if moving else 0)
        solve_limb('thigh_' + suffix, 'calf_' + suffix, point(ankle, side), point(knee_pole, side))
        # Toes point down the body during the glide. Feet turn outward during
        # the propulsive frog kick, then close symmetrically.
        kick = math.sin(math.pi * max(0, min(1, (cycle - 0.48) / 0.34))) ** 2 if moving else 0.2
        orient_world('foot_' + suffix, body @ Vector((side * kick * 0.7, -0.12 - kick * 0.4, -1 + kick * 0.35)))


for name, moving in [('Swim_Loop', True), ('Swim_Idle', False)]:
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    for frame in range(1, FRAMES + 2):
        scene.frame_set(frame)
        pose_swim((frame - 1) / FRAMES * TAU, moving)
        for bone in rig.pose.bones:
            bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
        rig.pose.bones['pelvis'].keyframe_insert('location', frame=frame, group='pelvis')
        rig.pose.bones['root'].keyframe_insert('location', frame=frame, group='root')
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.name = name
    track.mute = True

# Export each NLA track independently with the exact universal bone names.
for track in rig.animation_data.nla_tracks:
    track.mute = False
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

# Validate the generated binary itself, including first/last sample agreement.
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


assert {clip['name'] for clip in document['animations']} == {'Swim_Loop', 'Swim_Idle'}
assert not document.get('meshes'), 'The clip library must contain no character meshes'
for clip in document['animations']:
    for channel in clip['channels']:
        sampler = clip['samplers'][channel['sampler']]
        times, _ = values(sampler['input'])
        samples, width = values(sampler['output'])
        assert abs(times[-1] - times[0] - 2) < 0.001
        assert all(math.isfinite(value) for value in samples)
        assert max(abs(a - b) for a, b in zip(samples[:width], samples[-width:])) < 0.0001
        name = document['nodes'][channel['target']['node']]['name']
        assert name in rest, 'Animation changed the universal skeleton binding: ' + name
        if name == 'root' and channel['target']['path'] == 'translation':
            assert max(samples) - min(samples) < 0.0001, 'Swimming may not translate the root'
    print(clip['name'], '2 seconds, seamless finite tracks:', len(clip['channels']))
print('Wrote', OUTPUT, len(raw), 'bytes')
