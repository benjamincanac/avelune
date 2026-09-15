"""Render Avelune's OG image (1200x630) from the game's own assets.

Run headless:
  Blender --background --python scripts/make_og.py -- <models_dir> <out_png> [--samples N]

Scene: the town square at golden hour. The courtyard fountain is the centerpiece
with still slime-blue water in its basin, the inn and the shop flank it, the
watchtower sits back on the treeline, and trees, bushes, rocks and flowers from
the nature kit dress the edges. Two adventurers stand in the foreground posed from
the shared-skeleton idle clip. The plaza and grass are procedural (no floor
model ships). The title is camera-locked text over a dark scrim so it renders
crisp like an overlay.

Models used: courtyard/{fountain,inn,shop,tower}.glb, nature/*.glb,
characters/<name>.glb + characters/animations.glb.
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
SAMPLES = 160
if "--samples" in argv:
    SAMPLES = int(argv[argv.index("--samples") + 1])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x = 1200
scene.render.resolution_y = 630

# Brand accent: Avelune slime blue (app/utils/palette.ts `slime`).
SLIME = (0.576, 0.725, 0.910)
# The brand blue is pale and high-luminance, so as raw emission/light it clips
# to white under AgX. This saturated sibling (same cornflower hue) survives the
# tone map and actually reads as slime blue for water glow and fill light.
SLIME_GLOW = (0.28, 0.50, 0.95)
# Late-afternoon key.
WARM = (1.0, 0.74, 0.46)

# Every shipped courtyard/nature glb is Meshopt-compressed, which Blender's
# bundled glTF addon can't decode. Decompress with the same gltf-transform CLI
# the convert scripts use, into a cache so repeat runs stay fast.
_DECOMP_DIR = os.path.join(tempfile.gettempdir(), "avelune_og_glb")
os.makedirs(_DECOMP_DIR, exist_ok=True)


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
        if not os.path.exists(out) or os.path.getmtime(out) < os.path.getmtime(path):
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
    return objs


def model(rel, loc=(0, 0, 0), rot_z=0.0, scale=1.0):
    return place(import_glb(os.path.join(MODELS, rel)), loc=loc, rot_z=rot_z, scale=scale)


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


def surface_material(name, color, roughness=0.85, specular=0.3, mix=None, mix_scale=6.0):
    """Principled surface, optionally broken up by a noise blend into `mix`."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = specular
    if mix:
        noise = m.node_tree.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = mix_scale
        noise.inputs["Detail"].default_value = 6.0
        ramp = m.node_tree.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[0].color = (*color, 1)
        ramp.color_ramp.elements[1].position = 0.62
        ramp.color_ramp.elements[1].color = (*mix, 1)
        m.node_tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        m.node_tree.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return m


# ---------------------------------------------------------------------------
# Ground: procedural meadow with a stone plaza ring. No floor model ships.
# ---------------------------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=160, location=(0, 0, -0.06))
grass = bpy.context.active_object
grass.data.materials.append(surface_material(
    "Meadow", (0.060, 0.095, 0.045), roughness=0.95,
    mix=(0.095, 0.130, 0.060), mix_scale=3.0,
))

bpy.ops.mesh.primitive_cylinder_add(radius=14.6, depth=0.14, vertices=96, location=(0, 0, -0.07))
plaza = bpy.context.active_object
plaza.data.materials.append(surface_material(
    "Plaza", (0.125, 0.118, 0.104), roughness=0.8,
    mix=(0.190, 0.170, 0.140), mix_scale=14.0,
))

bpy.ops.mesh.primitive_cylinder_add(radius=6.6, depth=0.13, vertices=96, location=(0, 0, -0.055))
apron = bpy.context.active_object
apron.data.materials.append(surface_material(
    "PlazaApron", (0.175, 0.155, 0.126), roughness=0.75,
    mix=(0.120, 0.108, 0.092), mix_scale=22.0,
))

# ---------------------------------------------------------------------------
# Hero set piece: the town fountain, with still water in the basin.
# The basin is authored open at Z=0.48 for runtime water; the OG fakes a calm
# surface there so the centrepiece isn't a dry bowl.
# ---------------------------------------------------------------------------
model("courtyard/fountain.glb", loc=(0, 0.6, 0))

bpy.ops.mesh.primitive_cylinder_add(radius=3.02, depth=0.02, vertices=96, location=(0, 0.6, 0.47))
water = bpy.context.active_object
water_mat = bpy.data.materials.new("FountainWater")
water_mat.use_nodes = True
wb = water_mat.node_tree.nodes["Principled BSDF"]
wb.inputs["Base Color"].default_value = (0.03, 0.075, 0.16, 1)
wb.inputs["Roughness"].default_value = 0.06
wb.inputs["Emission Color"].default_value = (*SLIME_GLOW, 1)
wb.inputs["Emission Strength"].default_value = 0.22
water.data.materials.append(water_mat)

# ---------------------------------------------------------------------------
# Architecture: inn and shop flank the square, the watchtower holds the skyline.
# Authored front is glTF +Z, which imports as Blender -Y, so rot_z 0 faces the
# camera and the flanking rotations swing each facade toward the fountain.
# ---------------------------------------------------------------------------
model("courtyard/inn.glb", loc=(-8.6, 10.6, 0), rot_z=math.radians(32))
model("courtyard/shop.glb", loc=(8.8, 8.2, 0), rot_z=math.radians(-34))
model("courtyard/tower.glb", loc=(-17.0, 30.0, 0), rot_z=math.radians(24))

# ---------------------------------------------------------------------------
# Nature dressing: a treeline behind the town, planting around the plaza edge.
# ---------------------------------------------------------------------------
for rel, loc, rot, sc in [
    ("nature/tree1.glb", (-15.0, 21.0, 0), 1.9, 0.95),
    ("nature/tree2.glb", (4.5, 20.5, 0), 2.7, 1.0),
    ("nature/tree3.glb", (-7.0, 27.0, 0), 0.4, 0.8),
    ("nature/tree2.glb", (15.5, 19.5, 0), 0.9, 0.9),
    ("nature/tree5.glb", (10.5, 27.0, 0), 3.4, 0.95),
    ("nature/bush2.glb", (-7.6, 3.0, 0), 0.7, 1.1),
    ("nature/bush1.glb", (7.8, 3.2, 0), 2.4, 1.0),
    ("nature/bush1.glb", (-11.4, 6.2, 0), 1.1, 0.9),
    ("nature/bush2.glb", (11.2, 5.8, 0), 3.0, 0.95),
    ("nature/rock1.glb", (-9.4, 2.0, 0), 2.2, 0.5),
    ("nature/rock2.glb", (9.6, 1.6, 0), 0.6, 0.45),
    ("nature/flowers1.glb", (-6.4, -0.4, 0), 0.5, 0.55),
    ("nature/flowers2.glb", (6.6, -0.2, 0), 2.8, 0.55),
    ("nature/plant.glb", (-8.8, 1.0, 0), 1.4, 0.6),
    ("nature/fern.glb", (8.9, 1.2, 0), 2.1, 0.6),
    ("nature/clover.glb", (2.4, -3.2, 0), 0.9, 0.55),
    ("nature/clover.glb", (-2.8, -3.0, 0), 2.5, 0.55),
    ("nature/flowers1.glb", (-6.7, -4.1, 0), 1.8, 0.5),
    ("nature/fern.glb", (6.3, -4.3, 0), 0.3, 0.55),
]:
    for obj in model(rel, loc=loc, rot_z=rot, scale=sc):
        # The kit models dip slightly below their origin; lift them onto the slab.
        if obj.parent is None:
            obj.location.z += 0.2 * sc

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


def add_character(name, loc, rot_z, action_hint="Idle", scale=1.0):
    objs = model(f"characters/{name}.glb", loc=loc, rot_z=rot_z, scale=scale)
    for obj in list(objs):
        # The character packs ship an unparented unit sphere as a bounds proxy;
        # it is invisible in game but would render as a ball here.
        if obj.type == "MESH" and obj.parent is None:
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
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
    return objs


add_character("Ranger_Female_Long", (-4.8, -2.3, 0), math.radians(26))
add_character("Peasant_Male_Buzzed", (4.4, -3.0, 0), math.radians(-30))
scene.frame_set(22)

# ---------------------------------------------------------------------------
# Lights and atmosphere: warm low sun, slime-blue sky fill, lantern accents.
# ---------------------------------------------------------------------------
def add_light(kind, loc, color, energy, size=1.0, rot=None):
    bpy.ops.object.light_add(type=kind, location=loc)
    light = bpy.context.active_object
    light.data.color = color
    light.data.energy = energy
    if kind == "AREA":
        light.data.size = size
    if kind == "SUN":
        light.data.angle = math.radians(3.0)
    if rot:
        light.rotation_euler = rot
    return light


add_light("SUN", (16, -14, 18), WARM, 5.0,
          rot=(math.radians(52), 0, math.radians(32)))         # warm low key, front-right
add_light("AREA", (-13, -13, 9), (0.55, 0.68, 0.95), 1400, size=16,
          rot=(math.radians(62), 0, math.radians(-40)))        # cool sky fill, front-left
add_light("POINT", (0, 0.6, 1.5), SLIME_GLOW, 160)             # slime wash from the basin
add_light("POINT", (-7.0, 5.2, 2.4), (1.0, 0.58, 0.28), 320)   # inn lantern
add_light("POINT", (6.6, 4.2, 2.2), (1.0, 0.60, 0.30), 260)    # shop lantern

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
bg = wn["Background"]
bg.inputs["Strength"].default_value = 1.9
coord = wn.new("ShaderNodeTexCoord")
sep = wn.new("ShaderNodeSeparateXYZ")
ramp = wn.new("ShaderNodeValToRGB")
ramp.color_ramp.interpolation = "EASE"
ramp.color_ramp.elements[0].position = 0.02
ramp.color_ramp.elements[0].color = (0.66, 0.30, 0.12, 1)   # warm haze at the horizon
ramp.color_ramp.elements[1].position = 0.48
ramp.color_ramp.elements[1].color = (0.018, 0.030, 0.070, 1)  # deep navy overhead
wl.new(coord.outputs["Generated"], sep.inputs["Vector"])
wl.new(sep.outputs["Z"], ramp.inputs["Fac"])
wl.new(ramp.outputs["Color"], bg.inputs["Color"])

# ---------------------------------------------------------------------------
# Camera + camera-locked title overlay.
# ---------------------------------------------------------------------------
LENS = 35.0
bpy.ops.object.camera_add(location=(0, -19.2, 5.6))
cam = bpy.context.active_object
target = Vector((0, 3.4, 1.7))
cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = LENS
scene.camera = cam


def frame_half(distance):
    """Half width/height of the camera frustum at `distance` in front of it."""
    half_w = distance * (cam.data.sensor_width / 2) / LENS
    return half_w, half_w * scene.render.resolution_y / scene.render.resolution_x


# Dark scrim behind the title so the type reads over the lit scene: transparent
# at the bottom, near-opaque at the top. Camera rays only, so it lights nothing.
SCRIM_Z = -6.4
half_w, half_h = frame_half(-SCRIM_Z)
bpy.ops.mesh.primitive_plane_add(size=2)
scrim = bpy.context.active_object
scrim.scale = (half_w * 1.05, half_h * 1.05, 1)
scrim.parent = cam
scrim.location = (0, 0, SCRIM_Z)
scrim.rotation_euler = (0, 0, 0)
for attr in ("visible_shadow", "visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter"):
    setattr(scrim, attr, False)

scrim_mat = bpy.data.materials.new("TitleScrim")
scrim_mat.use_nodes = True
sn = scrim_mat.node_tree.nodes
sl = scrim_mat.node_tree.links
sn.clear()
s_coord = sn.new("ShaderNodeTexCoord")
s_sep = sn.new("ShaderNodeSeparateXYZ")
s_ramp = sn.new("ShaderNodeValToRGB")
s_ramp.color_ramp.interpolation = "EASE"
s_ramp.color_ramp.elements[0].position = 0.35
s_ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
s_ramp.color_ramp.elements[1].position = 0.72
s_ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
s_transp = sn.new("ShaderNodeBsdfTransparent")
s_emit = sn.new("ShaderNodeEmission")
s_emit.inputs["Color"].default_value = (0.010, 0.020, 0.042, 1)
s_emit.inputs["Strength"].default_value = 1.0
s_mix = sn.new("ShaderNodeMixShader")
s_out = sn.new("ShaderNodeOutputMaterial")
sl.new(s_coord.outputs["Generated"], s_sep.inputs["Vector"])
sl.new(s_sep.outputs["Y"], s_ramp.inputs["Fac"])
sl.new(s_ramp.outputs["Color"], s_mix.inputs["Fac"])
sl.new(s_transp.outputs["BSDF"], s_mix.inputs[1])
sl.new(s_emit.outputs["Emission"], s_mix.inputs[2])
sl.new(s_mix.outputs["Shader"], s_out.inputs["Surface"])
scrim.data.materials.append(scrim_mat)

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
    for attr in ("visible_shadow", "visible_diffuse", "visible_glossy"):
        setattr(text, attr, False)
    return text


add_text("AVELUNE", 0.86, 0.42, (1, 1, 1), 4, spacing=1.32)
# Lower strength so the pale brand blue reads as blue instead of clipping white.
add_text("A SHARED FANTASY TOWN", 0.70, 0.105, SLIME, 3, spacing=1.7)

# ---------------------------------------------------------------------------
# Render.
# ---------------------------------------------------------------------------
scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.filepath = OUT
scene.view_settings.look = "AgX - Punchy"
bpy.ops.render.render(write_still=True)
print(f"rendered {OUT}")
