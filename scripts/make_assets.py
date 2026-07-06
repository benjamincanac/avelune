"""Build the labyrinth's 3D assets and export them as GLB.

Run headless:
  Blender --background --python make_assets.py -- <out_dir> <preview_dir>

Models (Blender axes, exported to glTF's +Y-up automatically):
- character.glb — chibi maze-runner facing -Y, ~0.8 units tall, standing on z=0.
  The body material is named "Body" so the engine can tint it per player.
- torch.glb — standing torch with an emissive "Flame" material the engine can
  find by name to animate a flicker.
"""

import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT_DIR = argv[0]
PREVIEW_DIR = argv[1]


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, rough=0.6, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


def add_sphere(name, loc, scale, mat, smooth=True, segments=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    if smooth:
        bpy.ops.object.shade_smooth()
    return obj


def add_cylinder(name, loc, radius, depth, mat, vertices=12, smooth=True):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    if smooth:
        bpy.ops.object.shade_smooth()
    return obj


def export_glb(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True)
    print(f"exported {path}")


def render_preview(path, cam_loc, cam_target=(0, 0, 0.4)):
    """Quick Cycles turnaround render so the result can be eyeballed."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.filepath = path

    bpy.ops.object.camera_add(location=cam_loc)
    cam = bpy.context.active_object
    # Point the camera at the target (cameras look down their local -Z).
    direction = Vector(cam_target) - Vector(cam_loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    bpy.ops.object.light_add(type="AREA", location=(2, -2, 3))
    key = bpy.context.active_object
    key.data.energy = 400
    key.data.size = 3
    bpy.ops.object.light_add(type="AREA", location=(-2.5, -1, 1.5))
    fill = bpy.context.active_object
    fill.data.energy = 120
    fill.data.size = 3

    scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.02, 0.03, 0.05, 1)

    bpy.ops.render.render(write_still=True)
    # Remove the studio rig so it never leaks into an export.
    for obj in (cam, key, fill):
        bpy.data.objects.remove(obj, do_unlink=True)
    print(f"rendered {path}")


# ---------------------------------------------------------------------------
# Character: a chibi runner facing -Y, standing on the ground plane.
# ---------------------------------------------------------------------------
reset_scene()

body_mat = make_material("Body", (1, 1, 1), rough=0.55)  # white: tinted per player in-engine
eye_mat = make_material("Eye", (1, 1, 1), rough=0.25)
pupil_mat = make_material("Pupil", (0.02, 0.025, 0.035), rough=0.3)

# Body: a rounded pebble, slightly taller than wide.
add_sphere("Body", (0, 0, 0.42), (0.26, 0.24, 0.33), body_mat)
# Hood tip on top for a bit of character.
add_sphere("Tip", (0, 0.03, 0.79), (0.055, 0.055, 0.07), body_mat)
# Stubby arms.
add_sphere("ArmL", (0.25, 0, 0.40), (0.06, 0.07, 0.13), body_mat)
add_sphere("ArmR", (-0.25, 0, 0.40), (0.06, 0.07, 0.13), body_mat)
# Feet peeking out at the front.
add_sphere("FootL", (0.11, -0.06, 0.055), (0.085, 0.115, 0.055), body_mat)
add_sphere("FootR", (-0.11, -0.06, 0.055), (0.085, 0.115, 0.055), body_mat)
# Googly eyes on the -Y (front) face.
for side, sx in (("L", 1), ("R", -1)):
    add_sphere(f"Eye{side}", (sx * 0.095, -0.185, 0.52), (0.075, 0.045, 0.075), eye_mat)
    add_sphere(f"Pupil{side}", (sx * 0.095, -0.222, 0.52), (0.034, 0.02, 0.034), pupil_mat)

render_preview(f"{PREVIEW_DIR}/character.png", (1.1, -1.5, 1.0))
export_glb(f"{OUT_DIR}/character.glb")

# ---------------------------------------------------------------------------
# Torch: wooden pole, iron cup, emissive low-poly flame.
# ---------------------------------------------------------------------------
reset_scene()

wood_mat = make_material("Wood", (0.23, 0.14, 0.08), rough=0.9)
iron_mat = make_material("Iron", (0.15, 0.15, 0.17), rough=0.5)
flame_mat = make_material("Flame", (1, 0.45, 0.08), rough=0.4, emission=(1, 0.35, 0.05), strength=2.2)

add_cylinder("Pole", (0, 0, 0.45), 0.028, 0.9, wood_mat, vertices=10)
bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=0.075, radius2=0.05, depth=0.12, location=(0, 0, 0.93))
cup = bpy.context.active_object
cup.name = "Cup"
cup.data.materials.append(iron_mat)

bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.06, location=(0, 0, 1.04))
flame = bpy.context.active_object
flame.name = "Flame"
flame.scale = (1, 1, 1.6)
flame.data.materials.append(flame_mat)

render_preview(f"{PREVIEW_DIR}/torch.png", (0.9, -1.3, 1.3), cam_target=(0, 0, 0.6))
export_glb(f"{OUT_DIR}/torch.glb")

print("done")
