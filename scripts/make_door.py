"""Build the colosseum's monumental dungeon-entrance door and export it as GLB.

Run headless:
  Blender --background --python make_door.py -- <out_glb> [preview_png]

One model: colosseum_door.glb — a giant sealed double-door set in a stepped
stone archway, the gate from the colosseum arena down into the dungeon. Styled
after the Tempest dungeon's great sealed door: monumental scale, banded metal
leaves cracked slightly ajar over a glowing rune seam, a keystone arch of
voussoir blocks framing a runed tympanum, and floating rune-glyph shards.

Mirrors scripts/make_portal.py: Blender is Z-up here; the glTF exporter converts
to Y-up, and Blender -Y becomes glTF +Z, so the door front faces the viewer
in-engine (+Z). Modelled centred on X/Y with its base at Z=0.

Contracts the engine relies on (app/utils/portal.ts / bigDoor.ts):
- Material "Rune" is emissive; the engine pulses its emissiveIntensity. It sits
  on the door seam, the tympanum medallion, keystone inlays and the shards.
- Objects named "Shard_*" float freely; the engine bobs/spins them each frame.

The brand palette is shifting to Rimuru slime blues, so the Rune emissive is a
slime blue #93B9E8, not the portal's green-leaning cyan.
"""

import random
import sys
from math import cos, radians, sin

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
OUT_GLB = argv[0] if argv else "public/models/colosseum_door.glb"
PREVIEW = argv[1] if len(argv) > 1 else "/tmp/colosseum_door.png"

rng = random.Random(23)

# ---------------------------------------------------------------------------
# Load-bearing dimensions (Blender Z-up units). ~7 wide (X), ~10 tall (Z).
# ---------------------------------------------------------------------------
OPEN_HW = 2.0        # opening half-width: doorway spans X in [-2, 2]
SPRING_Z = 6.2       # arch springing line = top of the rectangular opening
SILL_Z = 0.35        # bottom of the door leaves (top of the threshold)
LEAF_TOP = 6.0       # top of the door leaves (just under the springers)
DOOR_Y = -0.15       # leaves' plane in Y (front is -Y)
LEAF_DEPTH = 0.35


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, rough=0.85, emission=None, strength=0.0, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
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


def add_cylinder(name, loc, radius, depth, mat, vertices=20, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def add_cone(name, loc, r1, r2, depth, mat, vertices=4, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r1, radius2=r2, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def make_shard(name, loc, s, mat, spin=0.0):
    """A small glowing rune-glyph shard: a 4-sided bipyramid (diamond).

    Built centred on `loc` so the engine's bob (around node translation Y) reads
    the hover height. Named Shard_* so bigDoor.ts finds and animates it.
    """
    x, y, z = loc
    h = s * 2.1
    top = add_cone(name, (x, y, z + h / 2), s, 0.0, h, mat, rot=(0, 0, radians(45)))
    bot = add_cone("_shard_tmp", (x, y, z - h / 2), s, 0.0, h, mat, rot=(radians(180), 0, radians(45)))
    bpy.ops.object.select_all(action="DESELECT")
    top.select_set(True)
    bot.select_set(True)
    bpy.context.view_layer.objects.active = top
    bpy.ops.object.join()
    top.rotation_euler = (0, spin, 0)
    return top


def export_glb(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True)
    print(f"exported {path}")


def render_preview(path, cam_loc, cam_target):
    from mathutils import Vector
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 40
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.filepath = path

    bpy.ops.object.camera_add(location=cam_loc)
    cam = bpy.context.active_object
    direction = Vector(cam_target) - Vector(cam_loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    bpy.ops.object.light_add(type="AREA", location=(6, -10, 9))
    key = bpy.context.active_object
    key.data.energy = 3000
    key.data.size = 9
    bpy.ops.object.light_add(type="AREA", location=(-7, -6, 4))
    fill = bpy.context.active_object
    fill.data.energy = 900
    fill.data.size = 9

    scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.02, 0.03, 0.05, 1)

    bpy.ops.render.render(write_still=True)
    for obj in (cam, key, fill):
        bpy.data.objects.remove(obj, do_unlink=True)
    print(f"rendered {path}")


# ---------------------------------------------------------------------------
# Materials — flat low-poly stone in the Quaternius style + dark iron banding.
# Rune emissive is slime blue #93B9E8 (Rimuru palette).
# ---------------------------------------------------------------------------
reset_scene()

stone = make_material("Stone", (0.40, 0.42, 0.48), rough=0.92)
stone_dark = make_material("StoneDark", (0.22, 0.23, 0.28), rough=0.95)
metal = make_material("Metal", (0.085, 0.095, 0.12), rough=0.42, metallic=0.85)
rune = make_material("Rune", (0.09, 0.16, 0.30), rough=0.35,
                     emission=(0.576, 0.725, 0.910), strength=4.5)

# ---------------------------------------------------------------------------
# Stepped stone threshold — base sits flush at Z=0.
# ---------------------------------------------------------------------------
add_box("Base_0", (0, 0, 0.20), (7.2, 1.9, 0.40), stone_dark)
add_box("Base_1", (0, 0, 0.55), (6.8, 1.6, 0.35), stone)
add_box("Threshold", (0, -1.15, 0.13), (4.8, 0.9, 0.26), stone_dark)

# ---------------------------------------------------------------------------
# Jambs — two stepped side pillars with a raised pilaster relief on the front.
# ---------------------------------------------------------------------------
for side, sx in (("L", -1), ("R", 1)):
    jx = sx * 2.75  # jamb column centre (spans X 1.8..3.7 on its side)

    add_box(f"JambFoot_{side}", (jx, 0, 0.7), (1.9, 1.7, 1.4), stone_dark)          # z 0..1.4
    add_box(f"JambShaft_{side}", (jx, 0, 3.75), (1.5, 1.4, 5.2), stone)            # z 1.15..6.35
    # Masonry courses banding the shaft.
    for cz in (2.1, 3.3, 4.5, 5.6):
        add_box(f"JambCourse_{side}_{int(cz*10)}", (jx, 0, cz), (1.58, 1.44, 0.16), stone_dark)
    # Impost / springer block the arch springs from.
    add_box(f"Impost_{side}", (jx, 0, 6.45), (1.85, 1.6, 0.55), stone_dark)        # z 6.17..6.72

    # A slender pilaster standing proud of the jamb front (front is -Y).
    add_box(f"PilasterBase_{side}", (jx, -0.82, 1.35), (0.7, 0.22, 0.5), stone_dark)
    add_box(f"Pilaster_{side}", (jx, -0.8, 4.0), (0.5, 0.2, 4.9), stone)           # z 1.55..6.45
    add_box(f"PilasterCap_{side}", (jx, -0.82, 6.55), (0.72, 0.24, 0.42), stone_dark)
    add_box(f"PilasterRune_{side}", (jx, -0.93, 4.0), (0.22, 0.04, 0.9), rune)     # glowing inlay

# ---------------------------------------------------------------------------
# Tympanum backing wall above the doors — fills the arch spandrels so nothing
# reads through, and carries the big rune medallion.
# ---------------------------------------------------------------------------
add_box("Tympanum", (0, 0.35, 7.5), (6.6, 0.7, 2.6), stone)  # z 6.2..8.8, set back
# Glowing rune medallion recessed into the tympanum, facing front, with a dark
# stone sigil struck across it so it reads as a carved seal rather than a disc.
add_cylinder("RuneMedallionRim", (0, 0.06, 7.35), 1.45, 0.16, stone_dark, vertices=32, rot=(radians(90), 0, 0))
add_cylinder("RuneMedallion", (0, -0.02, 7.35), 1.2, 0.14, rune, vertices=32, rot=(radians(90), 0, 0))
add_box("RuneSigilV", (0, -0.14, 7.35), (0.18, 0.06, 2.0), stone_dark)
add_box("RuneSigilH", (0, -0.14, 7.35), (2.0, 0.06, 0.18), stone_dark)
add_box("RuneSigilD", (0, -0.14, 7.35), (0.16, 0.06, 1.7), stone_dark, (0, radians(45), 0))
add_box("RuneSigilD2", (0, -0.14, 7.35), (0.16, 0.06, 1.7), stone_dark, (0, radians(-45), 0))

# ---------------------------------------------------------------------------
# Keystone arch — voussoir blocks over the opening (semicircle, springing at
# SPRING_Z), a fat keystone at the crown, rune inlays on alternating blocks.
# Same technique as make_portal.py's standing ring.
# ---------------------------------------------------------------------------
for i, ang in enumerate(range(0, 181, 15)):
    th = radians(ang)
    keystone = ang == 90
    tang = 0.72 if keystone else 0.56 + rng.uniform(-0.03, 0.03)   # tangential (X)
    rad = 0.9 if keystone else 0.62 + rng.uniform(-0.03, 0.03)     # radial (Z pre-rot)
    r = OPEN_HW + rad / 2                                          # inner edge at OPEN_HW
    loc = (r * cos(th), -0.25, SPRING_Z + r * sin(th))            # protrude to front
    rot = (0, radians(90 - ang), 0)
    mat = stone_dark if (not keystone and i % 2 == 0) else stone
    add_box(f"Voussoir_{i}", loc, (tang, 0.5, rad), mat, rot)

    if keystone or i % 2 == 1:
        s = 0.26 if keystone else 0.16
        ploc = (loc[0], -0.53, loc[2])
        add_box(f"VoussoirRune_{i}", ploc, (s, 0.04, s), rune, (0, radians(90 - ang + 45), 0))

# ---------------------------------------------------------------------------
# Stepped cornice / entablature capping the top at ~Z=10 (ziggurat-like steps).
# ---------------------------------------------------------------------------
add_box("Cornice_0", (0, 0.0, 9.05), (7.2, 1.7, 0.65), stone)        # z 8.72..9.38
add_box("Cornice_1", (0, 0.0, 9.6), (6.4, 1.5, 0.45), stone_dark)    # z 9.38..9.82
add_box("Cornice_2", (0, 0.0, 9.98), (5.4, 1.3, 0.35), stone)        # z 9.80..10.15

# ---------------------------------------------------------------------------
# Door leaves — two banded iron leaves, hinged on the jambs and cracked ajar so
# their free (inner) edges swing toward the viewer, opening a glowing rune seam.
# ---------------------------------------------------------------------------
LEAF_OUTER = OPEN_HW - 0.05   # outer (hinge) edge, just inside the jamb face
LEAF_INNER = 0.24             # inner (free) edge at rest → central gap of 0.48
LEAF_W = LEAF_OUTER - LEAF_INNER
LEAF_CX = (LEAF_OUTER + LEAF_INNER) / 2
LEAF_CZ = (SILL_Z + LEAF_TOP) / 2
LEAF_H = LEAF_TOP - SILL_Z
OPEN = radians(11)            # ajar angle — free edges swing toward the viewer


def add_leaf_part(name, cx, cz, size, mat, hinge_x, theta):
    """Place a leaf part, rotating the whole leaf about its outer hinge edge so
    the free edge swings forward (toward -Y). All parts share the leaf's Y plane
    (DOOR_Y), so the rotation is a pure swing about the vertical hinge."""
    rel_x = cx - hinge_x
    nx = hinge_x + rel_x * cos(theta)
    ny = DOOR_Y + rel_x * sin(theta)
    add_box(name, (nx, ny, cz), size, mat, rot=(0, 0, theta))


for side, sx in (("L", -1), ("R", 1)):
    hinge = sx * LEAF_OUTER
    # Left leaf swings its inner (+x-of-hinge) edge to -Y with theta<0; right leaf
    # is the mirror, so both free edges come forward symmetrically.
    theta = -OPEN if sx < 0 else OPEN

    # Leaf field slab.
    add_leaf_part(f"Leaf_{side}", sx * LEAF_CX, LEAF_CZ, (LEAF_W, LEAF_DEPTH, LEAF_H), stone_dark, hinge, theta)

    # Iron perimeter frame + horizontal bands (protruding to the front, -Y).
    by = LEAF_DEPTH / 2 + 0.06  # bands stand proud of the slab front
    add_leaf_part(f"LeafEdgeOut_{side}", sx * (LEAF_OUTER - 0.13), LEAF_CZ, (0.22, LEAF_DEPTH + 0.12, LEAF_H), metal, hinge, theta)
    add_leaf_part(f"LeafEdgeIn_{side}", sx * (LEAF_INNER + 0.13), LEAF_CZ, (0.22, LEAF_DEPTH + 0.12, LEAF_H), metal, hinge, theta)
    add_leaf_part(f"LeafTop_{side}", sx * LEAF_CX, LEAF_TOP - 0.13, (LEAF_W, LEAF_DEPTH + 0.12, 0.26), metal, hinge, theta)
    add_leaf_part(f"LeafBot_{side}", sx * LEAF_CX, SILL_Z + 0.13, (LEAF_W, LEAF_DEPTH + 0.12, 0.26), metal, hinge, theta)
    for k, bz in enumerate((1.9, 3.2, 4.5)):
        add_leaf_part(f"LeafBand_{side}_{k}", sx * LEAF_CX, bz, (LEAF_W, LEAF_DEPTH + 0.14, 0.2), metal, hinge, theta)
        # Rivets along each band.
        for j in (-0.55, 0.0, 0.55):
            add_leaf_part(f"Rivet_{side}_{k}_{int((j+1)*10)}", sx * (LEAF_CX + j), bz, (0.11, LEAF_DEPTH + 0.2, 0.11), metal, hinge, theta)

    # A round iron handle boss near the free edge.
    add_leaf_part(f"Handle_{side}", sx * (LEAF_INNER + 0.4), LEAF_CZ - 0.4, (0.34, LEAF_DEPTH + 0.24, 0.34), metal, hinge, theta)

# The glowing rune seam leaking light through the central crack. Sits just
# behind the leaf plane so it blazes through the ajar gap. Rune → engine-pulsed.
add_box("RuneSeam", (0, -0.06, LEAF_CZ - 0.1), (0.34, 0.22, LEAF_H - 0.2), rune)
# A few glowing sigils stamped down the seam, catching the eye at the crack.
for k, sz in enumerate((1.6, 3.0, 4.4)):
    add_box(f"SeamSigil_{k}", (0, -0.2, sz), (0.62, 0.05, 0.3), rune, (0, radians(45), 0))

# ---------------------------------------------------------------------------
# Floating rune-glyph shards — engine bobs/spins these (Shard_*). They hover in
# front of the doorway (toward the viewer, -Y) at varied heights.
# ---------------------------------------------------------------------------
shard_spots = [
    (-1.25, -1.8, 2.7, 0.17),
    (1.35, -1.6, 3.5, 0.15),
    (-0.95, -2.1, 4.7, 0.16),
    (1.05, -2.0, 5.6, 0.14),
    (0.0, -1.5, 7.15, 0.2),
    (-1.7, -1.9, 6.1, 0.15),
]
for i, (x, y, z, s) in enumerate(shard_spots, start=1):
    make_shard(f"Shard_{i}", (x, y, z), s, rune, spin=rng.uniform(0, 1.2))

# ---------------------------------------------------------------------------
# Bounding-box report + export.
# ---------------------------------------------------------------------------
bpy.context.view_layer.update()
xs, ys, zs = [], [], []
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    for corner in obj.bound_box:
        wc = obj.matrix_world @ __import__("mathutils").Vector(corner)
        xs.append(wc.x)
        ys.append(wc.y)
        zs.append(wc.z)
print(f"DIMS colosseum_door: W={max(xs)-min(xs):.2f} (X)  D={max(ys)-min(ys):.2f} (Y)  H={max(zs)-min(zs):.2f} (Z)")
print(f"BOUNDS x[{min(xs):.2f},{max(xs):.2f}] y[{min(ys):.2f},{max(ys):.2f}] z[{min(zs):.2f},{max(zs):.2f}]")

render_preview(PREVIEW, (8.5, -13.0, 7.5), (0, 0, 4.8))
export_glb(OUT_GLB)
print("done")
