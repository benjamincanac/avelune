"""Build the game's characters from Quaternius' CC0 Universal modular packs.

Run headless:
  Blender --background --python convert_universal_characters.py -- <packs_dir> <out_dir>

<packs_dir> is the folder holding the unzipped packs (default: ~/Downloads/quaternius):
  - Universal Base Characters[Standard]      (heads/faces/eyes/skin + hairstyles)
  - Modular Character Outfits - Fantasy[...]  (Peasant + Ranger outfits, M/F)
  - Universal Animation Library[Standard]     (UAL1_Standard.glb, 43 clips)
  - Universal Animation Library 2[Standard]   (UAL2_Standard.glb, 43 clips)

All three share ONE 65-bone "universal" skeleton with identical bone names, so
outfit parts, base head, and hairstyles bind to a single armature, and the
animation clips retarget with zero fixups.

Two kinds of output land in <out_dir>:
  - <Name>.glb   one self-contained rigged character per roster entry (no clips)
  - animations.glb   the shared clip library (skeleton + clips, no mesh); the
                     runtime loads it once and plays its clips on every rig.
"""

import bmesh
import bpy
import json
import os
import struct
import sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PACKS = argv[0] if argv else os.path.expanduser("~/Downloads/quaternius")
OUT = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "public", "models", "characters")
OUT = os.path.abspath(OUT)

OUTFITS = os.path.join(PACKS, "module-character-outfits", "Exports", "glTF (Godot-Unreal)", "Outfits")
BASE = os.path.join(PACKS, "universal-base-character", "Base Characters", "Godot - UE")
HAIR = os.path.join(PACKS, "universal-base-character", "Hairstyles", "Rigged to Head Bone", "glTF (Godot -Unreal)")
UAL1 = os.path.join(PACKS, "universal-animation-library", "Unreal-Godot", "UAL1_Standard.glb")
UAL2 = os.path.join(PACKS, "universal-animation-library-2", "Unreal-Godot", "UAL2_Standard.glb")

# The base full body is trimmed to just the vertices whose dominant bone is one
# of these — everything the outfit doesn't cover. The universal skeleton weights
# the entire face to a single "Head" bone (no jaw/eye bones), so "head + neck"
# is exactly {Head, neck_01}, and the shoulder girdle (clavicle/spine/upperarm)
# is dropped whole. A flat Z cut couldn't do this: the trapezius slopes up toward
# the neck, so any plane low enough to keep the neck also kept shoulder-top skin,
# which poked through the outfit at the shoulders.
HEAD_BONES = {"Head", "neck_01"}
# Longest edge any texture is downscaled to before packing (web budget).
TEX_MAX = 512

# Clips pulled from the two animation libraries into the shared set. The game's
# state machine drives Idle/Jog/Jump/Roll; the rest are bundled for later use so
# both libraries are genuinely shipped.
CLIPS_UAL1 = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop",
              "Jump_Start", "Jump_Loop", "Jump_Land", "Roll", "Dance_Loop", "Death01"]
CLIPS_UAL2 = ["Slide_Start", "Slide_Loop", "Sword_Regular_A", "Yes", "Sword_Dash", "Shield_Dash"]

# name, base full body, outfit, [hairstyles]. The GLB basename encodes
# outfit_gender_hair and must match CHARACTER_NAMES in shared/utils/characters.
# The Ranger is baked WITH its hood over the hair (always hooded); the Peasant
# is bareheaded. Outfit colorways are swapped at runtime, not baked here. Males
# skip "Long" — the pack's only long hair is a female mesh (bald male crown).
ROSTER = [
    {"name": "Peasant_Male_SimpleParted",   "base": "Superhero_Male_FullBody",   "outfit": "Male_Peasant",   "hair": ["Hair_SimpleParted", "Hair_Beard"]},
    {"name": "Peasant_Male_Buzzed",         "base": "Superhero_Male_FullBody",   "outfit": "Male_Peasant",   "hair": ["Hair_Buzzed"]},
    {"name": "Peasant_Female_Long",         "base": "Superhero_Female_FullBody", "outfit": "Female_Peasant", "hair": ["Hair_Long"]},
    {"name": "Peasant_Female_Buns",         "base": "Superhero_Female_FullBody", "outfit": "Female_Peasant", "hair": ["Hair_Buns"]},
    {"name": "Ranger_Male_SimpleParted",    "base": "Superhero_Male_FullBody",   "outfit": "Male_Ranger",    "hair": ["Hair_SimpleParted", "Hair_Beard"]},
    {"name": "Ranger_Male_Buzzed",          "base": "Superhero_Male_FullBody",   "outfit": "Male_Ranger",    "hair": ["Hair_Buzzed"]},
    {"name": "Ranger_Female_Long",          "base": "Superhero_Female_FullBody", "outfit": "Female_Ranger",  "hair": ["Hair_Long"]},
    {"name": "Ranger_Female_Buns",          "base": "Superhero_Female_FullBody", "outfit": "Female_Ranger",  "hair": ["Hair_Buns"]},
]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_gltf(path):
    """Import a glTF/GLB and return (armature, [mesh objects]) it added."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in added if o.type == "ARMATURE"), None)
    meshes = [o for o in added if o.type == "MESH"]
    return arm, meshes


def drop_junk(meshes):
    """Every Quaternius import carries a stray unskinned 'Icosphere' helper."""
    kept = []
    for m in meshes:
        if m.name.startswith("Icosphere") or len(m.vertex_groups) == 0:
            bpy.data.objects.remove(m, do_unlink=True)
        else:
            kept.append(m)
    return kept


def rebind(meshes, target_arm, source_arm):
    """Move meshes from source_arm onto target_arm (identical bone names), then
    drop the now-empty source armature."""
    for m in meshes:
        for mod in m.modifiers:
            if mod.type == "ARMATURE":
                mod.object = target_arm
        m.parent = target_arm
        m.matrix_parent_inverse = target_arm.matrix_world.inverted()
    if source_arm and source_arm is not target_arm:
        bpy.data.objects.remove(source_arm, do_unlink=True)


def trim_to_head(body):
    """Keep only the base-body vertices whose dominant bone is the head or neck;
    delete the rest. The outfit already supplies clothed torso/arms/legs, so only
    the head is wanted (per the pack's own readme). Selecting by dominant bone
    weight (rather than a flat Z plane) removes the whole shoulder girdle cleanly
    while keeping the full neck to tuck under the collar — a Z cut left the
    trapezius/shoulder tops as bare skin poking through the outfit."""
    keep = {i for i, g in enumerate(body.vertex_groups) if g.name in HEAD_BONES}
    doomed_idx = [
        v.index for v in body.data.vertices
        if (dom := max(v.groups, key=lambda g: g.weight, default=None)) is None
        or dom.group not in keep
    ]
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    doomed = [bm.verts[i] for i in doomed_idx]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()


def shrink_textures():
    for img in bpy.data.images:
        w, h = img.size
        if max(w, h) > TEX_MAX and w and h:
            if w >= h:
                img.scale(TEX_MAX, max(1, round(h * TEX_MAX / w)))
            else:
                img.scale(max(1, round(w * TEX_MAX / h)), TEX_MAX)


def height_of(objs):
    zs = []
    for o in objs:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            zs.append((o.matrix_world @ Vector(c)).z)
    return (max(zs) - min(zs)) if zs else 0.0


def export(path, extra_args=None):
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        export_apply=False,          # armature deform modifiers must survive
        use_selection=False,
        export_yup=True,
        export_image_format="WEBP",
        export_image_quality=80,
    )
    if extra_args:
        kwargs.update(extra_args)
    bpy.ops.export_scene.gltf(**kwargs)


def sanitize_glb(path):
    """Blender's glTF+WebP exporter emits empty texture entries for normal maps
    whose image wasn't packed (seen on MI_Eyes and the male MI_Hair_1): the
    texture has neither a `source` nor an `EXT_texture_webp.source`. three.js'
    GLTFLoader then crashes reading `images[undefined].uri` and rejects the whole
    model. Strip any material texture slot pointing at an unresolvable image so
    those dangling entries stay unreferenced and are never loaded."""
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, _total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    jlen, jtype = struct.unpack_from("<II", data, 12)
    assert jtype == 0x4E4F534A, "chunk0 not JSON"
    doc = json.loads(data[20:20 + jlen].decode("utf-8"))
    rest = data[20 + jlen:]  # BIN chunk, copied verbatim (bufferViews untouched)

    imgs = doc.get("images", [])
    broken = set()
    for i, t in enumerate(doc.get("textures", [])):
        webp = t.get("extensions", {}).get("EXT_texture_webp", {})
        src = webp.get("source", t.get("source"))
        if src is None or src >= len(imgs) or imgs[src] is None:
            broken.add(i)

    removed = 0
    for m in doc.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        for holder, slot in ((pbr, "baseColorTexture"), (pbr, "metallicRoughnessTexture"),
                             (m, "normalTexture"), (m, "occlusionTexture"), (m, "emissiveTexture")):
            tex = holder.get(slot)
            if tex and tex.get("index") in broken:
                del holder[slot]
                removed += 1
    if not removed:
        return

    jbytes = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    jbytes += b" " * ((4 - len(jbytes) % 4) % 4)  # 4-byte align with spaces
    new_total = 12 + 8 + len(jbytes) + len(rest)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, new_total)
    out += struct.pack("<II", len(jbytes), 0x4E4F534A)
    out += jbytes + rest
    with open(path, "wb") as f:
        f.write(bytes(out))
    print("   sanitized %d broken texture ref(s)" % removed)


def build_character(spec):
    reset()
    arm, meshes = import_gltf(os.path.join(OUTFITS, spec["outfit"] + ".gltf"))
    meshes = drop_junk(meshes)

    # The outfit's hood (Ranger) is kept alongside the hair; the runtime toggles
    # its visibility, so one model serves both hood+hair and hair-only.

    # Base head: trim the full body to the head, keep eyes/eyebrows, rebind.
    base_arm, base_meshes = import_gltf(os.path.join(BASE, spec["base"] + ".gltf"))
    base_meshes = drop_junk(base_meshes)
    for m in base_meshes:
        # The lone whole-body mesh is the one to trim; eyes/eyebrows pass through.
        if len(m.data.vertices) > 3000:
            trim_to_head(m)
    rebind(base_meshes, arm, base_arm)
    meshes += base_meshes

    # Hair pieces (rigged to the head bone).
    for hair_name in spec["hair"]:
        hair_arm, hair_meshes = import_gltf(os.path.join(HAIR, hair_name + ".gltf"))
        hair_meshes = drop_junk(hair_meshes)
        rebind(hair_meshes, arm, hair_arm)
        meshes += hair_meshes

    # Keep the pack's full PBR materials (base colour + normal + metallic/
    # roughness) so the outfits render with the depth/shading of the Quaternius
    # preview — just downscale the textures for the web.
    shrink_textures()

    out = os.path.join(OUT, spec["name"] + ".glb")
    export(out)
    sanitize_glb(out)
    print("OK %-24s h=%.2fm meshes=%d -> %d KB" % (
        spec["name"], height_of([arm] + meshes), len(meshes), os.path.getsize(out) // 1024))


def build_animations():
    """One GLB with the shared skeleton + curated clips from both libraries,
    each clip an NLA track so the exporter writes it as its own animation."""
    reset()
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
    wanted = CLIPS_UAL1 + CLIPS_UAL2
    added = []
    for name in wanted:
        act = bpy.data.actions.get(name)
        if not act:
            print("  MISSING clip %s" % name)
            continue
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        start = int(act.frame_range[0])
        strip = track.strips.new(name, start, act)
        strip.name = name
        added.append(name)

    out = os.path.join(OUT, "animations.glb")
    export(out, {"export_animations": True, "export_animation_mode": "NLA_TRACKS"})
    print("OK animations.glb clips=%d -> %d KB" % (len(added), os.path.getsize(out) // 1024))
    print("   " + ", ".join(added))


os.makedirs(OUT, exist_ok=True)
for spec in ROSTER:
    build_character(spec)
build_animations()
print("done")
