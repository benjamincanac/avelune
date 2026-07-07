"""Render Mugen's OG image (1200x630) from the game's own assets.

Run headless:
  Blender --background --python scripts/make_og.py -- <models_dir> <out_png>

Scene: slab floor, gothic gateway over a glowing portal, guardian statues,
two characters posed from their animation clips, torchlight — and the title
as camera-locked text so it renders crisp like an overlay.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
MODELS = argv[0]
OUT = argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

GREEN = (0.0, 0.86, 0.51)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def place(objs, loc=(0, 0, 0), rot_z=0.0, scale=1.0):
    for obj in objs:
        if obj.parent is None:
            obj.location = Vector(obj.location) * scale + Vector(loc)
            obj.rotation_euler.z += rot_z
            obj.scale = [s * scale for s in obj.scale]


def emission_material(name, color, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    nodes.clear()
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*color, 1)
    emit.inputs["Strength"].default_value = strength
    out = nodes.new("ShaderNodeOutputMaterial")
    m.node_tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return m


# ---------------------------------------------------------------------------
# Floor: a grid of pack slabs.
# ---------------------------------------------------------------------------
slab_source = import_glb(os.path.join(MODELS, "props/Floor_Standard.glb"))
slab_roots = [o for o in slab_source if o.parent is None]
for gx in range(-4, 5):
    for gy in range(-2, 4):
        for root in slab_roots:
            copy = root.copy()
            copy.location = (gx * 2.0, gy * 2.0, -0.28)
            copy.rotation_euler = (0, 0, (gx * 3 + gy) % 4 * math.pi / 2)
            bpy.context.collection.objects.link(copy)
            for child in root.children_recursive:
                cc = child.copy()
                cc.parent = copy
                bpy.context.collection.objects.link(cc)
for o in slab_source:
    o.hide_render = True

# ---------------------------------------------------------------------------
# Set pieces.
# ---------------------------------------------------------------------------
place(import_glb(os.path.join(MODELS, "props/Arch_Gothic.glb")), loc=(0, 2.2, 0), rot_z=0, scale=1.15)
place(import_glb(os.path.join(MODELS, "props/Statue_Fox.glb")), loc=(-3.6, 2.6, 0), rot_z=math.radians(155), scale=0.9)
place(import_glb(os.path.join(MODELS, "props/Statue_Stag.glb")), loc=(3.6, 2.8, 0), rot_z=math.radians(-155), scale=0.8)
place(import_glb(os.path.join(MODELS, "props/Torch.glb")), loc=(-2.1, 0.4, 0), rot_z=0.4, scale=1.3)
place(import_glb(os.path.join(MODELS, "props/Torch.glb")), loc=(2.1, 0.4, 0), rot_z=-0.4, scale=1.3)
place(import_glb(os.path.join(MODELS, "props/Bricks.glb")), loc=(-3.0, -1.2, 0), rot_z=1.1, scale=0.7)
place(import_glb(os.path.join(MODELS, "props/Skull.glb")), loc=(2.6, -1.6, 0), rot_z=2.2, scale=1.0)

# Portal: emissive disc under the arch.
bpy.ops.mesh.primitive_cylinder_add(radius=1.05, depth=0.04, location=(0, 2.2, 0.03))
portal = bpy.context.active_object
portal.data.materials.append(emission_material("Portal", GREEN, 4))

# ---------------------------------------------------------------------------
# Characters, posed from their clips.
# ---------------------------------------------------------------------------
def add_character(name, loc, rot_z, action_hint, frame):
    objs = import_glb(os.path.join(MODELS, f"characters/{name}.glb"))
    place(objs, loc=loc, rot_z=rot_z, scale=0.5)
    for obj in objs:
        if obj.type == "ARMATURE":
            actions = [a for a in bpy.data.actions if action_hint in a.name]
            if actions:
                obj.animation_data_create()
                obj.animation_data.action = actions[-1]
    return frame


add_character("Knight_Male", (-1.35, -1.4, 0), math.radians(20), "Idle", 30)
add_character("Witch", (1.3, -1.2, 0), math.radians(-25), "Idle", 10)
scene.frame_set(22)

# ---------------------------------------------------------------------------
# Lights and atmosphere.
# ---------------------------------------------------------------------------
def add_light(kind, loc, color, energy, size=1.0):
    bpy.ops.object.light_add(type=kind, location=loc)
    light = bpy.context.active_object
    light.data.color = color
    light.data.energy = energy
    if kind == "AREA":
        light.data.size = size
    return light


add_light("AREA", (0, 2.2, 2.6), GREEN, 300, size=2.6)          # portal glow
add_light("POINT", (-2.1, 0.2, 1.6), (1.0, 0.62, 0.3), 120)      # torch left
add_light("POINT", (2.1, 0.2, 1.6), (1.0, 0.62, 0.3), 120)       # torch right
add_light("AREA", (0, -8, 5), (0.72, 0.76, 0.95), 620, size=8)    # cool front fill
rim = add_light("AREA", (0, 6, 4), (0.35, 0.7, 0.85), 200, size=6) # teal rim
rim.rotation_euler = (math.radians(120), 0, 0)

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.008, 0.012, 0.022, 1)

# ---------------------------------------------------------------------------
# Camera + camera-locked title text.
# ---------------------------------------------------------------------------
bpy.ops.object.camera_add(location=(0, -7.6, 2.1))
cam = bpy.context.active_object
target = Vector((0, 1.6, 1.5))
cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = 42
scene.camera = cam

font = None
for candidate in [
    "/System/Library/Fonts/Supplemental/Futura.ttc",
    "/System/Library/Fonts/Avenir Next.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]:
    if os.path.exists(candidate):
        font = bpy.data.fonts.load(candidate)
        break


def add_text(body, local_y, size, color, strength, spacing=1.0):
    bpy.ops.object.text_add()
    text = bpy.context.active_object
    text.data.body = body
    if font:
        text.data.font = font
    text.data.size = size
    text.data.space_character = spacing
    text.data.align_x = "CENTER"
    text.data.extrude = 0.004
    text.data.materials.append(emission_material(f"Text{body}", color, strength))
    text.parent = cam
    text.location = (0, local_y, -6)
    text.rotation_euler = (0, 0, 0)
    return text


add_text("MUGEN", 0.92, 0.52, (1, 1, 1), 4, spacing=1.32)
add_text("THE ENDLESS TOWER", 0.74, 0.125, GREEN, 6, spacing=1.7)

# ---------------------------------------------------------------------------
# Render.
# ---------------------------------------------------------------------------
scene.render.engine = "CYCLES"
scene.cycles.samples = 128
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 630
scene.render.filepath = OUT
scene.view_settings.look = "AgX - Punchy"
bpy.ops.render.render(write_still=True)
print(f"rendered {OUT}")
