"""Build the hub teleport gate's stone structure and export it as GLB.

Run headless:
  Blender --background --python make_portal.py -- <out_dir> <preview_dir>

One model: portal_gate.glb — a ruined low-poly rune gate sized around the
engine's energy rift (rift radius 1.7, centre y 1.75; see app/utils/portal.ts).
Blender is Z-up here; the glTF exporter converts to Y-up, and Blender -Y
becomes glTF +Z, so the gate front faces the viewer in-engine.

Contracts the engine relies on (app/utils/portal.ts):
- Material "Rune" is emissive; the engine pulses its emissiveIntensity.
- Objects named "Shard_*" float freely; the engine bobs/spins them.
"""

import random
import sys
from math import cos, pi, radians, sin

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT_DIR = argv[0]
PREVIEW_DIR = argv[1]

rng = random.Random(11)

# Matches portal.ts: rift RADIUS 1.7 at CENTER_Y 1.75. The stone ring's inner
# edge sits just outside the rift's glowing rim.
RING_R = 2.0
RING_CZ = 1.75


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, rough=0.85, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


def add_box(name, loc, size, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def add_cylinder(name, loc, radius, depth, mat, vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def add_cone(name, loc, r1, r2, depth, mat, vertices=4, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r1, radius2=r2, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def export_glb(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True)
    print(f"exported {path}")


def render_preview(path, cam_loc, cam_target):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x = 800
    scene.render.resolution_y = 800
    scene.render.filepath = path

    bpy.ops.object.camera_add(location=cam_loc)
    cam = bpy.context.active_object
    direction = Vector(cam_target) - Vector(cam_loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    bpy.ops.object.light_add(type="AREA", location=(4, -5, 6))
    key = bpy.context.active_object
    key.data.energy = 1100
    key.data.size = 6
    bpy.ops.object.light_add(type="AREA", location=(-5, -3, 3))
    fill = bpy.context.active_object
    fill.data.energy = 300
    fill.data.size = 6

    scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.02, 0.03, 0.05, 1)

    bpy.ops.render.render(write_still=True)
    for obj in (cam, key, fill):
        bpy.data.objects.remove(obj, do_unlink=True)
    print(f"rendered {path}")


# ---------------------------------------------------------------------------
# Portal gate: stepped dais, broken standing ring, twin obelisks, floaters.
# ---------------------------------------------------------------------------
reset_scene()

stone = make_material("Stone", (0.36, 0.38, 0.45))
stone_dark = make_material("StoneDark", (0.20, 0.21, 0.27), rough=0.9)
rune = make_material("Rune", (0.05, 0.16, 0.30), rough=0.4, emission=(0.35, 0.75, 1.0), strength=4.0)

# Dais: two shallow stone steps. Kept low so players walking onto the exit
# tile only clip a few centimetres.
add_cylinder("DaisOuter", (0, 0, 0.05), 2.7, 0.10, stone_dark)
add_cylinder("DaisInner", (0, 0, 0.09), 2.15, 0.18, stone)

# The standing ring: stone blocks along the visible arc (-60°..240°, through
# the top), tangential X, radial Z before each is rotated into place. The two
# end blocks sit at z≈0 so the ring emerges from the dais.
for i, ang in enumerate(range(-60, 241, 20)):
    th = radians(ang)
    keystone = ang == 90
    tang = 0.85 if keystone else 0.58 + rng.uniform(-0.04, 0.04)
    depth = 0.50 if keystone else 0.42 + rng.uniform(-0.03, 0.03)
    rad = 0.75 if keystone else 0.55 + rng.uniform(-0.03, 0.03)
    r = RING_R + rng.uniform(-0.03, 0.03)
    loc = (r * cos(th), 0, RING_CZ + r * sin(th))
    rot = (0, radians(90 - ang) + rng.uniform(-0.02, 0.02), 0)
    mat = stone_dark if (not keystone and i % 3 == 2) else stone
    add_box(f"Ring_{i}", loc, (tang, depth, rad), mat, rot)

    # Every other block carries a glowing rune inlay on its front face.
    if keystone or i % 2 == 0:
        s = 0.22 if keystone else 0.15
        ploc = (loc[0], -(depth / 2 + 0.02), loc[2])
        add_box(f"RunePlaque_{i}", ploc, (s, 0.03, s), rune, (0, radians(90 - ang + 45), 0))

# Twin obelisks flanking the ring, standing on the dais's outer step.
for side, sx in (("L", -1), ("R", 1)):
    x = sx * 2.55
    add_box(f"Plinth{side}", (x, 0, 0.35), (0.72, 0.72, 0.50), stone_dark)
    add_cone(f"Shaft{side}", (x, 0, 1.55), 0.34, 0.26, 1.90, stone, rot=(0, 0, radians(45)))
    add_box(f"Cap{side}", (x, 0, 2.58), (0.62, 0.62, 0.16), stone_dark)
    add_cone(f"Tip{side}", (x, 0, 2.87), 0.30, 0.02, 0.42, stone, rot=(0, 0, radians(45)))
    add_box(f"PillarRune{side}", (x, -0.36, 1.85), (0.14, 0.03, 0.14), rune, (0, radians(45), 0))

    # A rune diamond hovering above each tip — animated by the engine.
    top = add_cone(f"Shard_Pillar{side}", (x, 0, 3.25), 0.14, 0.0, 0.20, rune, rot=(0, 0, radians(45)))
    top.location.z += 0.10
    bot = add_cone(f"_tmp{side}", (x, 0, 3.15), 0.14, 0.0, 0.20, rune, rot=(radians(180), 0, radians(45)))
    bpy.ops.object.select_all(action="DESELECT")
    top.select_set(True)
    bot.select_set(True)
    bpy.context.view_layer.objects.active = top
    bpy.ops.object.join()

# Broken stone shards drifting around the upper arc of the ring.
for i in range(7):
    th = radians(30 + i * 20 + rng.uniform(-6, 6))
    r = RING_R + 0.85 + rng.uniform(0, 0.5)
    loc = (r * cos(th), rng.uniform(-0.3, 0.3), RING_CZ + r * sin(th))
    s = rng.uniform(0.09, 0.20)
    size = (s, s * rng.uniform(0.6, 0.9), s * rng.uniform(1.1, 1.6))
    rot = (rng.uniform(0, pi), rng.uniform(0, pi), rng.uniform(0, pi))
    add_box(f"Shard_{i}", loc, size, stone_dark if i % 2 else stone, rot)

# Rubble at the dais edge for wear.
for i, ang in enumerate((35, 150, 205, 320)):
    th = radians(ang)
    loc = (2.45 * cos(th), 2.45 * sin(th), 0.12)
    s = rng.uniform(0.10, 0.18)
    add_box(f"Rubble_{i}", loc, (s * 1.4, s * 1.2, s), stone_dark if i % 2 else stone,
            (rng.uniform(0, pi), rng.uniform(0, pi), rng.uniform(0, pi)))

render_preview(f"{PREVIEW_DIR}/portal_gate.png", (5.5, -8.5, 4.5), (0, 0, 1.7))
export_glb(f"{OUT_DIR}/portal_gate.glb")

print("done")
