"""Render a small square palette thumbnail for every placeable prop `kind`.

Run headless (single Blender process, iterates every kind):
  Blender --background --python scripts/make_thumbnails.py -- \
      [models_dir] [catalog_ts] [out_dir]

Defaults (run from the repo root) resolve to:
  models_dir = public/models
  catalog_ts = shared/utils/propCatalog.ts
  out_dir    = public/thumbnails

For each prop kind (a GLB basename listed in `PROP_CATALOG`) this imports
`<models_dir>/<dir>/<kind>.glb`, frames the camera to the model's own bounding
box so tiny coins and 10-unit towers both fill the frame, and writes
`<out_dir>/<kind>.png` — 128x128, RGBA, transparent background.

The kind -> dir mapping is parsed straight out of propCatalog.ts (source of
truth) so it stays correct when kits are added/removed. Camera *direction* and
lighting are identical for every model (a consistent ~30deg 3/4 view); only the
distance and look-at target vary with the model's bounding box.

Some packs may ship EXT_meshopt_compression, which Blender's bundled glTF addon
can't decode; those are transparently decompressed with the same gltf-transform
CLI the repo's convert scripts use (see make_og.py).
"""

import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile

import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------
# Args / paths.
# ---------------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
MODELS = os.path.abspath(argv[0]) if len(argv) > 0 else os.path.abspath("public/models")
CATALOG = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.abspath("shared/utils/propCatalog.ts")
OUT = os.path.abspath(argv[2]) if len(argv) > 2 else os.path.abspath("public/thumbnails")

RES = 128           # square thumbnail size in px
MARGIN = 1.12       # >1 pulls the camera back so the model isn't flush to the edge
AZIMUTH = math.radians(30)    # camera swung 30deg off dead-front
ELEVATION = math.radians(30)  # camera lifted 30deg above the model
FOV = math.radians(40)        # camera field of view

os.makedirs(OUT, exist_ok=True)

_DECOMP_DIR = tempfile.mkdtemp(prefix="thumb_glb_")


# ---------------------------------------------------------------------------
# Parse the kind -> dir mapping out of propCatalog.ts.
# ---------------------------------------------------------------------------
def parse_catalog(ts_path):
    """Return an ordered list of (kind, dir) parsed from PROP_CATALOG.

    Reads the `export const <NAME> = [ ... ] as const` arrays and the
    PROP_CATALOG entries that bind each array to a model dir. Never hardcodes
    the kind list.
    """
    src = open(ts_path, encoding="utf-8").read()

    # Each named string array -> its list of kinds (strip // line comments first
    # so comment prose can't leak in as fake entries).
    arrays = {}
    for m in re.finditer(r"export const (\w+)\s*=\s*\[(.*?)\]\s*as const", src, re.DOTALL):
        name, body = m.group(1), m.group(2)
        body = re.sub(r"//[^\n]*", "", body)
        arrays[name] = re.findall(r"'([^']+)'", body)

    # PROP_CATALOG entries bind { dir: '<dir>', names: <ARRAY_NAME> }.
    mapping = []
    seen = set()
    for m in re.finditer(
        r"\{\s*label:\s*'[^']*'\s*,\s*dir:\s*'([^']*)'\s*,\s*names:\s*(\w+)\s*\}",
        src,
    ):
        d, arr = m.group(1), m.group(2)
        for kind in arrays.get(arr, []):
            if kind not in seen:      # kinds are globally unique; guard anyway
                seen.add(kind)
                mapping.append((kind, d))
    return mapping


# ---------------------------------------------------------------------------
# GLB import (with meshopt fallback, matching make_og.py).
# ---------------------------------------------------------------------------
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


def world_bbox(objs):
    """Combined world-space bbox (min, max) over all MESH objects, or None."""
    bpy.context.view_layer.update()
    corners = [
        obj.matrix_world @ Vector(c)
        for obj in objs if obj.type == "MESH"
        for c in obj.bound_box
    ]
    if not corners:
        return None
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def purge(new_objs):
    """Remove the imported objects and any data they orphaned."""
    for obj in new_objs:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except Exception:
            pass
    try:
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# One-time scene: camera + neutral lighting. Camera *direction* is fixed for
# every model; only its distance + look-at target change per bounding box.
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

bpy.ops.object.camera_add()
cam = bpy.context.active_object
cam.data.sensor_fit = "AUTO"
cam.data.angle = FOV
scene.camera = cam

# Fixed view direction (unit vector from the model centre toward the camera).
CAM_DIR = Vector((
    math.cos(ELEVATION) * math.sin(AZIMUTH),
    -math.cos(ELEVATION) * math.cos(AZIMUTH),
    math.sin(ELEVATION),
))

# Neutral lighting: soft world ambient + a key/fill sun pair. Suns are
# directional (world-fixed) and the view direction is constant, so shading
# reads consistently across every model regardless of where it sits.
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.62, 0.64, 0.70, 1)
bg.inputs["Strength"].default_value = 0.55


def add_sun(energy, rot):
    bpy.ops.object.light_add(type="SUN")
    sun = bpy.context.active_object
    sun.data.energy = energy
    sun.data.angle = math.radians(6)   # soft-ish shadows
    sun.rotation_euler = [math.radians(a) for a in rot]
    return sun


add_sun(3.2, (52, 8, 40))     # key: upper front, camera-ish side
add_sun(1.1, (66, 0, -150))   # fill: opposite side, weaker

scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 16
scene.render.film_transparent = True
scene.render.resolution_x = RES
scene.render.resolution_y = RES
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
# Literal colours for tiny icons (AgX washes them out at this size).
try:
    scene.view_settings.view_transform = "Standard"
except Exception:
    pass

PERSISTENT = set(bpy.data.objects)
HALF_FOV = FOV / 2.0


# ---------------------------------------------------------------------------
# Render loop.
# ---------------------------------------------------------------------------
kinds = parse_catalog(CATALOG)
print(f"THUMBS parsed {len(kinds)} kinds from {CATALOG}")

ok, failed = 0, []
for kind, d in kinds:
    path = os.path.join(MODELS, d, f"{kind}.glb")
    if not os.path.isfile(path):
        failed.append((kind, f"missing GLB {os.path.relpath(path, MODELS)}"))
        print(f"MISS {kind}: no file at {path}")
        continue

    try:
        objs = import_glb(path)
    except Exception as e:
        failed.append((kind, f"import error: {e}"))
        print(f"FAIL {kind}: import error {e}")
        continue

    new_objs = [o for o in objs if o not in PERSISTENT]
    box = world_bbox(new_objs)
    if box is None:
        purge(new_objs)
        failed.append((kind, "no mesh geometry (degenerate/empty)"))
        print(f"FAIL {kind}: no mesh geometry")
        continue

    lo, hi = box
    center = (lo + hi) * 0.5
    radius = max((Vector(c) - center).length for c in (
        Vector((lo.x, lo.y, lo.z)), Vector((hi.x, hi.y, hi.z)),
        Vector((lo.x, lo.y, hi.z)), Vector((hi.x, hi.y, lo.z)),
        Vector((lo.x, hi.y, lo.z)), Vector((hi.x, lo.y, hi.z)),
        Vector((lo.x, hi.y, hi.z)), Vector((hi.x, lo.y, lo.z)),
    ))
    radius = max(radius, 1e-4)

    distance = radius / math.sin(HALF_FOV) * MARGIN
    cam.location = center + CAM_DIR * distance
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()

    scene.render.filepath = os.path.join(OUT, f"{kind}.png")
    bpy.ops.render.render(write_still=True)
    purge(new_objs)
    ok += 1
    print(f"OK {kind} -> {kind}.png")

print(f"THUMBS done: {ok} ok, {len(failed)} failed")
for kind, why in failed:
    print(f"  - {kind}: {why}")
