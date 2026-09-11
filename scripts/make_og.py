"""Render the OG image (1200x630). STALE: still the old game's medieval door scene, not the stadium.

Run headless:
  Blender --background --python scripts/make_og.py -- <models_dir> <out_png>

Scene (old game): slab floor, the monumental great door with slime-blue
glowing runes as the hero set piece, guardian statues, two adventurers posed
from their shared-skeleton idle clip, torchlight — and the title as
camera-locked text so it renders crisp like an overlay.
"""

import json
import math
import os
import struct
import subprocess
import sys
import tempfile

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
MODELS = argv[0]
OUT = argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Some packs (e.g. colosseum_door.glb) ship EXT_meshopt_compression, which
# Blender's bundled glTF addon can't decode. Decompress those on the fly with
# the same gltf-transform CLI the repo's convert scripts use.
_DECOMP_DIR = tempfile.mkdtemp(prefix="og_glb_")

# Brand accent: Vercel Stadium slime blue (tagline / exact brand value).
SLIME = (0.576, 0.725, 0.910)
# The brand blue is pale and high-luminance, so as raw emission/light it clips
# to white under AgX. This saturated sibling (same cornflower hue) survives the
# tone map and actually reads as slime blue for the rune/portal glow.
SLIME_GLOW = (0.28, 0.50, 0.95)


def _needs_meshopt(path):
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"glTF":
                return False
            f.seek(12)
            clen = struct.unpack("<I", f.read(4))[0]
            f.seek(20)
            head = json.loads(f.read(clen))
        return "EXT_meshopt_compression" in (head.get("extensionsUsed") or [])
    except Exception:
        return False


def import_glb(path):
    if _needs_meshopt(path):
        out = os.path.join(_DECOMP_DIR, os.path.basename(path))
        subprocess.run(
            ["npx", "--yes", "@gltf-transform/cli@latest", "cp", path, out],
            check=True, capture_output=True, text=True,
        )
        path = out
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
# Hero set piece: the old game's monumental great door.
# ---------------------------------------------------------------------------
DOOR_Y = 3.3            # depth of the door plane
DOOR_TARGET_H = 4.1     # world height in metres (seated with base on the floor)

door_objs = import_glb(os.path.join(MODELS, "colosseum_door.glb"))
door_meshes = [o for o in door_objs if o.type == "MESH"]
door_roots = [o for o in door_objs if o.parent is None]

# Make the door's runes glow slime blue.
rune_mat = emission_material("DoorRune", SLIME_GLOW, 2.4)
for obj in door_meshes:
    for slot in obj.material_slots:
        if slot.material and "Rune" in slot.material.name:
            slot.material = rune_mat


def door_bbox_z():
    bpy.context.view_layer.update()
    zs = [(o.matrix_world @ Vector(c)).z for o in door_meshes for c in o.bound_box]
    return min(zs), max(zs)


# Scale to target height, then seat the base on the floor at DOOR_Y.
zmin, zmax = door_bbox_z()
door_scale = DOOR_TARGET_H / (zmax - zmin)
for root in door_roots:
    root.scale = [v * door_scale for v in root.scale]
    root.location = Vector(root.location) * door_scale
zmin, zmax = door_bbox_z()
for root in door_roots:
    root.location = root.location + Vector((0, DOOR_Y, -zmin))

# ---------------------------------------------------------------------------
# Flanking set dressing.
# ---------------------------------------------------------------------------
place(import_glb(os.path.join(MODELS, "props/Statue_Fox.glb")), loc=(-3.7, 2.6, 0), rot_z=math.radians(155), scale=0.9)
place(import_glb(os.path.join(MODELS, "props/Statue_Stag.glb")), loc=(3.7, 2.8, 0), rot_z=math.radians(-155), scale=0.8)
place(import_glb(os.path.join(MODELS, "props/Torch.glb")), loc=(-2.4, 0.4, 0), rot_z=0.4, scale=1.3)
place(import_glb(os.path.join(MODELS, "props/Torch.glb")), loc=(2.4, 0.4, 0), rot_z=-0.4, scale=1.3)
place(import_glb(os.path.join(MODELS, "props/Bricks.glb")), loc=(-3.0, -1.2, 0), rot_z=1.1, scale=0.7)
place(import_glb(os.path.join(MODELS, "props/Skull.glb")), loc=(2.6, -1.6, 0), rot_z=2.2, scale=1.0)

# Threshold glow: a slime-blue disc on the ground before the door.
bpy.ops.mesh.primitive_cylinder_add(radius=1.1, depth=0.04, location=(0, DOOR_Y - 1.5, 0.03))
portal = bpy.context.active_object
portal.data.materials.append(emission_material("Threshold", SLIME_GLOW, 1.7))

# ---------------------------------------------------------------------------
# Characters, posed from the shared-skeleton clips.
# The character GLBs ship no animation of their own; the clips live in
# characters/animations.glb, so import it once to populate bpy.data.actions
# (the armature carries no mesh, so nothing extra renders).
# ---------------------------------------------------------------------------
for obj in import_glb(os.path.join(MODELS, "characters/animations.glb")):
    obj.hide_render = True
for act in bpy.data.actions:
    act.use_fake_user = True  # keep clips alive for reuse across armatures


def add_character(name, loc, rot_z, action_hint, frame):
    objs = import_glb(os.path.join(MODELS, f"characters/{name}.glb"))
    place(objs, loc=loc, rot_z=rot_z, scale=0.5)
    for obj in objs:
        if obj.type == "ARMATURE":
            actions = [a for a in bpy.data.actions if action_hint in a.name]
            if actions:
                act = actions[-1]
                obj.animation_data_create()
                obj.animation_data.action = act
                # Blender 4.4+ slotted actions: the action only drives the
                # armature once its slot is bound explicitly.
                if act.slots:
                    obj.animation_data.action_slot = act.slots[0]
    return frame


add_character("Peasant_Male_Buzzed", (-1.35, -1.4, 0), math.radians(20), "Idle", 30)
add_character("Ranger_Female_Long", (1.3, -1.2, 0), math.radians(-25), "Idle", 10)
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


add_light("POINT", (0, DOOR_Y - 0.7, 1.9), SLIME_GLOW, 240)      # slime wash from the doorway
add_light("POINT", (-2.4, 0.2, 1.6), (1.0, 0.62, 0.3), 120)      # torch left
add_light("POINT", (2.4, 0.2, 1.6), (1.0, 0.62, 0.3), 120)       # torch right
add_light("AREA", (0, -8, 5), (0.72, 0.76, 0.95), 280, size=8)    # cool front fill
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


add_text("VERCEL STADIUM", 0.92, 0.52, (1, 1, 1), 4, spacing=1.32)
# Lower strength so the pale brand blue reads as blue instead of clipping white.
add_text("THE GREAT DUNGEON", 0.74, 0.125, SLIME, 3, spacing=1.7)

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
