"""Build the old game's monumental door arch and export it as GLB (only make_og.py still uses it).

Run headless:
  Blender --background --python make_door.py -- <out_glb> [preview_png]

One model: colosseum_door.glb — a grand, OPEN dungeon-entrance gate: a tall
ornate stone arch on two heavy pilasters, a proud keystone bearing a glowing
rune medallion, rune-inscribed bands framing the opening (glyphs down the jambs
and around the archivolt), coiling-serpent reliefs down the pilasters, blocky
gargoyles perched at the top corners, stepped masonry, base plinths, and a
crenellated cornice. The archway itself is left CLEAR — no door leaves — because
the engine (app/utils/bigDoor.ts) fills the opening with a swirling blue rift,
braziers and a threshold glow at runtime.

Blender is Z-up here; the glTF exporter converts to Y-up, and Blender -Y becomes
glTF +Z, so the arch front faces the viewer in-engine (+Z). Modelled centred on
X/Y with its base flush at Z=0. Envelope ~7 wide (X) x ~10 tall (Z), passable
opening ~4 wide (X in [-2, 2]).

Contracts the engine relies on (app/utils/bigDoor.ts):
- Material "Rune" is emissive; the engine pulses its emissiveIntensity. It sits
  on the keystone medallion, the rune-band glyphs, the serpent/gargoyle eyes and
  the floating shards.
- Objects named "Shard_*" float freely; the engine bobs/spins them each frame.
- The opening (and the space just behind it) is kept clear so the runtime rift
  can fill and recede through it — nothing bridges X in [-2, 2] except a low,
  passable threshold sill.

The brand palette is Rimuru slime blues, so the Rune emissive is slime blue
#93B9E8 (RGB ~0.576, 0.725, 0.910).
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
ARCH_FRONT = -0.25   # Y-plane the arch voussoirs protrude to (front is -Y)
PIL_CX = 2.7         # pilaster column centre in X
PIL_HW = 0.7         # pilaster half-width (spans X 2.0..3.4 on its side)


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
# Materials — flat low-poly stone in the Quaternius style (grey + darker grey).
# Rune emissive is slime blue #93B9E8 (Rimuru palette). No textures.
# ---------------------------------------------------------------------------
reset_scene()

stone = make_material("Stone", (0.40, 0.42, 0.48), rough=0.92)
stone_dark = make_material("StoneDark", (0.22, 0.23, 0.28), rough=0.95)
rune = make_material("Rune", (0.09, 0.16, 0.30), rough=0.35,
                     emission=(0.576, 0.725, 0.910), strength=4.5)


# ---------------------------------------------------------------------------
# Ornamental builders — kept self-contained + symmetric so they read cleanly
# and can be dropped at either corner/pilaster without fragile mirroring.
# ---------------------------------------------------------------------------
def add_serpent(cx, sx):
    """A low-poly coiling-serpent relief running up a pilaster front face.

    ~9 short segments weaving side to side in an S-curve, tapering upward to a
    small blocky head with glowing eyes. `sx` (+/-1) flips the weave so the two
    pilasters read as a mirrored pair. Sits proud of the pilaster front (-Y).
    """
    tag = "L" if sx < 0 else "R"
    fy = -0.82                       # serpent plane, proud of the pilaster front
    n = 9
    z0, z1 = 1.7, 5.6
    for i in range(n):
        t = i / (n - 1)
        z = z0 + t * (z1 - z0)
        wob = sx * 0.30 * sin(t * 6.3)          # side-to-side weave (the coil)
        w = 0.34 - 0.13 * t                      # taper toward the head
        add_box(f"Serpent_{tag}_{i}", (cx + wob, fy, z), (w, 0.16, 0.44),
                stone_dark, rot=(0, 0, sx * 0.32 * cos(t * 6.3)))
    # Blocky head turned outward at the top of the coil.
    hx = cx + sx * 0.30 * sin(6.3)
    hz = z1 + 0.34
    add_box(f"SerpentHead_{tag}", (hx, fy - 0.03, hz), (0.36, 0.22, 0.34), stone)
    add_box(f"SerpentSnout_{tag}", (hx, fy - 0.18, hz - 0.03), (0.22, 0.24, 0.18), stone_dark)
    for k, ex in enumerate((-0.10, 0.10)):
        add_box(f"SerpentEye_{tag}_{k}", (hx + ex, fy - 0.20, hz + 0.03), (0.06, 0.06, 0.06), rune)


def add_gargoyle(name, cx):
    """A simple stylized crouched-winged gargoyle perched at a top corner.

    A blocky faceted silhouette (corbel, haunched body, forward-leaning head +
    snout, back-swept folded wings, gripping forelegs, tiny glowing eyes) that
    reads as a guardian looking down over the arena. Self-symmetric in X.
    """
    gz = 6.95                         # body-centre height (on the pilaster caps)
    fy = -0.55                        # perch it proud of the pilaster front (-Y)
    # Corbel bracket it perches on (juts forward from the corner).
    add_box(f"{name}_Corbel", (cx, fy + 0.05, gz - 0.55), (0.98, 1.0, 0.5), stone_dark)
    add_box(f"{name}_Corbel2", (cx, fy - 0.14, gz - 0.30), (0.82, 0.7, 0.32), stone)
    # Haunched, crouched body + forward-leaning chest.
    add_box(f"{name}_Body", (cx, fy + 0.14, gz + 0.16), (0.74, 0.66, 0.72), stone, rot=(radians(10), 0, 0))
    add_box(f"{name}_Chest", (cx, fy - 0.20, gz + 0.04), (0.58, 0.42, 0.5), stone, rot=(radians(20), 0, 0))
    # Head craned down over the arena + a jutting snout.
    add_box(f"{name}_Head", (cx, fy - 0.37, gz + 0.42), (0.46, 0.44, 0.4), stone, rot=(radians(22), 0, 0))
    add_box(f"{name}_Snout", (cx, fy - 0.58, gz + 0.30), (0.30, 0.30, 0.22), stone_dark, rot=(radians(30), 0, 0))
    # Little back-swept horns.
    for k, hx in enumerate((-0.15, 0.15)):
        add_cone(f"{name}_Horn_{k}", (cx + hx, fy - 0.16, gz + 0.66), 0.08, 0.0, 0.32,
                 stone_dark, vertices=4, rot=(radians(-32), 0, 0))
    # Folded wings sweeping up and back (two facets each).
    for tag, wx, roll in (("L", -1, radians(22)), ("R", 1, radians(-22))):
        add_box(f"{name}_Wing_{tag}", (cx + wx * 0.36, fy + 0.36, gz + 0.66), (0.12, 0.5, 1.05),
                stone, rot=(radians(18), 0, roll))
        add_box(f"{name}_WingTip_{tag}", (cx + wx * 0.52, fy + 0.42, gz + 1.14), (0.1, 0.4, 0.5),
                stone_dark, rot=(radians(26), 0, roll))
    # Forelegs gripping the corbel edge.
    for k, lx in enumerate((-0.22, 0.22)):
        add_box(f"{name}_Leg_{k}", (cx + lx, fy - 0.34, gz - 0.28), (0.16, 0.24, 0.56), stone, rot=(radians(-8), 0, 0))
    # Tiny glowing eyes.
    for k, ex in enumerate((-0.11, 0.11)):
        add_box(f"{name}_Eye_{k}", (cx + ex, fy - 0.58, gz + 0.46), (0.06, 0.05, 0.06), rune)


# ---------------------------------------------------------------------------
# Stepped stone plinths + threshold — base sits flush at Z=0.
# ---------------------------------------------------------------------------
add_box("Base_0", (0, 0, 0.20), (7.2, 2.0, 0.40), stone_dark)         # z 0..0.40
add_box("Base_1", (0, 0, 0.575), (6.9, 1.8, 0.35), stone)            # z 0.40..0.75
# A low, passable threshold sill across the mouth of the opening (front step).
add_box("Threshold", (0, -0.9, 0.13), (4.2, 0.8, 0.26), stone_dark)  # z 0..0.26

for side, sx in (("L", -1), ("R", 1)):
    jx = sx * PIL_CX
    # Heavy base plinth at the foot of each pilaster (two stepped blocks).
    add_box(f"Plinth_{side}", (jx, 0, 0.98), (1.7, 1.7, 0.5), stone_dark)   # z 0.73..1.23
    add_box(f"PlinthCap_{side}", (jx, 0, 1.34), (1.55, 1.55, 0.26), stone)  # z 1.21..1.47

# ---------------------------------------------------------------------------
# Pilasters — two heavy stepped side pillars framing the opening, banded with
# masonry courses, a proud slender pilaster relief on the front, a capital and
# the impost/springer block the arch springs from.
# ---------------------------------------------------------------------------
for side, sx in (("L", -1), ("R", 1)):
    jx = sx * PIL_CX

    add_box(f"JambShaft_{side}", (jx, 0, 3.83), (1.4, 1.4, 4.72), stone)     # z 1.47..6.19
    # Masonry courses banding the shaft (darker stone).
    for cz in (2.2, 3.3, 4.4, 5.5):
        add_box(f"JambCourse_{side}_{int(cz * 10)}", (jx, 0, cz), (1.5, 1.5, 0.16), stone_dark)
    # Capital + impost/springer block (arch springs from the impost top).
    add_box(f"Capital_{side}", (jx, 0, 6.32), (1.62, 1.62, 0.34), stone_dark)  # z 6.15..6.49
    add_box(f"Impost_{side}", (jx - sx * 0.12, 0, 6.72), (1.62, 1.5, 0.5), stone)  # z 6.47..6.97
    # Spandrel seat backing the arch springing corner (kills the corner notch).
    add_box(f"Spandrel_{side}", (jx - sx * 0.25, 0.12, 6.6), (1.5, 0.9, 1.0), stone_dark)  # z 6.1..7.1

    # Slender pilaster standing proud of the jamb front (front is -Y).
    add_box(f"PilasterBase_{side}", (jx, -0.78, 1.6), (0.78, 0.24, 0.4), stone_dark)
    add_box(f"Pilaster_{side}", (jx, -0.76, 3.95), (0.6, 0.2, 4.3), stone)      # z 1.8..6.1
    add_box(f"PilasterCap_{side}", (jx, -0.78, 6.25), (0.82, 0.26, 0.36), stone_dark)

    # Coiling-serpent relief up the pilaster front.
    add_serpent(jx, sx)

# ---------------------------------------------------------------------------
# Rune-inscribed band framing the OPENING — a recessed dark reveal channel down
# each jamb with glowing glyphs, continuing around the archivolt below.
# Kept at |X| >= ~2.05 so the ~4-wide passage (X in [-2, 2]) stays clear.
# ---------------------------------------------------------------------------
for side, sx in (("L", -1), ("R", 1)):
    rx = sx * 2.13
    # Recessed reveal channel down the inner jamb (front face).
    add_box(f"JambBand_{side}", (rx, -0.62, 3.7), (0.34, 0.14, 4.4), stone_dark)  # z 1.5..5.9
    # Glowing rune glyphs stamped down the channel.
    for k, gz in enumerate((1.9, 2.75, 3.6, 4.45, 5.3)):
        add_box(f"JambRune_{side}_{k}", (rx, -0.71, gz), (0.17, 0.05, 0.17), rune,
                rot=(0, radians(45), 0))

# ---------------------------------------------------------------------------
# Keystone arch — voussoir blocks over the opening (semicircle springing at
# SPRING_Z, inner edge at OPEN_HW), a fat keystone at the crown, and a glowing
# rune glyph on every block so the archivolt reads as a band of runes. Same
# voussoir technique as make_portal.py's standing ring.
# ---------------------------------------------------------------------------
KEYSTONE_Z = None
for i, ang in enumerate(range(0, 181, 15)):
    th = radians(ang)
    keystone = ang == 90
    tang = 0.78 if keystone else 0.58 + rng.uniform(-0.03, 0.03)   # tangential (X)
    rad = 0.95 if keystone else 0.64 + rng.uniform(-0.03, 0.03)    # radial (Z pre-rot)
    r = OPEN_HW + rad / 2                                          # inner edge at OPEN_HW
    loc = (r * cos(th), ARCH_FRONT, SPRING_Z + r * sin(th))       # protrude to front
    rot = (0, radians(90 - ang), 0)
    mat = stone_dark if (not keystone and i % 2 == 0) else stone
    add_box(f"Voussoir_{i}", loc, (tang, 0.55, rad), mat, rot)
    if keystone:
        KEYSTONE_Z = loc[2]

    # A glowing rune glyph on the front face of each voussoir → archivolt band.
    if not keystone:
        s = 0.15
        add_box(f"VoussoirRune_{i}", (loc[0], ARCH_FRONT - 0.31, loc[2]), (s, 0.04, s), rune,
                rot=(0, radians(90 - ang + 45), 0))

# ---------------------------------------------------------------------------
# Keystone rune medallion — a glowing disc recessed into the crown, a dark stone
# sigil struck across it so it reads as a carved seal rather than a plain disc.
# ---------------------------------------------------------------------------
MZ = KEYSTONE_Z + 0.05
add_cylinder("RuneMedallionRim", (0, ARCH_FRONT - 0.30, MZ), 0.86, 0.16, stone_dark, vertices=28, rot=(radians(90), 0, 0))
add_cylinder("RuneMedallion", (0, ARCH_FRONT - 0.38, MZ), 0.68, 0.14, rune, vertices=28, rot=(radians(90), 0, 0))
add_box("RuneSigilV", (0, ARCH_FRONT - 0.46, MZ), (0.11, 0.06, 1.16), stone_dark)
add_box("RuneSigilH", (0, ARCH_FRONT - 0.46, MZ), (1.16, 0.06, 0.11), stone_dark)
add_box("RuneSigilD", (0, ARCH_FRONT - 0.46, MZ), (0.1, 0.06, 1.0), stone_dark, (0, radians(45), 0))
add_box("RuneSigilD2", (0, ARCH_FRONT - 0.46, MZ), (0.1, 0.06, 1.0), stone_dark, (0, radians(-45), 0))

# ---------------------------------------------------------------------------
# Set-back tympanum wall closing the arch crown + spandrels ABOVE the rift so
# the top reads solid (the rift only reaches ~Z 6.95, so this stays clear of it).
# ---------------------------------------------------------------------------
add_box("Tympanum", (0, 0.45, 7.8), (7.0, 0.6, 1.8), stone_dark)     # z 6.9..8.7, set back

# ---------------------------------------------------------------------------
# Stepped cornice / entablature + a light crenellated crown capping ~Z 10.
# ---------------------------------------------------------------------------
add_box("Cornice_0", (0, 0.0, 9.0), (7.0, 1.7, 0.6), stone)          # z 8.70..9.30
add_box("Cornice_1", (0, 0.0, 9.52), (6.2, 1.5, 0.44), stone_dark)   # z 9.30..9.74
add_box("Cornice_2", (0, 0.0, 9.9), (5.2, 1.3, 0.34), stone)         # z 9.73..10.07
# Merlons — a low battlement crown for an ornate silhouette.
for k, mx in enumerate((-2.3, -1.15, 0.0, 1.15, 2.3)):
    mat = stone if k % 2 == 0 else stone_dark
    add_box(f"Merlon_{k}", (mx, 0.0, 9.9), (0.62, 1.1, 0.44), mat)   # z 9.68..10.12
# A small rune keystone-crown glyph centred above the medallion.
add_box("CrownRune", (0, -0.55, 9.05), (0.24, 0.06, 0.24), rune, (0, radians(45), 0))

# ---------------------------------------------------------------------------
# Gargoyles perched at the two top corners, above the pilaster capitals.
# ---------------------------------------------------------------------------
add_gargoyle("Gargoyle_L", -2.85)
add_gargoyle("Gargoyle_R", 2.85)

# ---------------------------------------------------------------------------
# Floating rune-glyph shards — engine bobs/spins these (Shard_*). Clustered
# above/around the keystone, hovering toward the viewer (-Y) at varied heights.
# ---------------------------------------------------------------------------
shard_spots = [
    (0.0, -1.5, 9.2, 0.20),     # crowning shard above the keystone
    (-1.05, -1.6, 8.3, 0.16),
    (1.1, -1.6, 8.5, 0.15),
    (-1.75, -1.9, 7.4, 0.15),
    (1.8, -1.9, 7.2, 0.14),
    (0.0, -1.35, 6.55, 0.17),   # just over the arch, below the medallion
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

render_preview(PREVIEW, (5.0, -14.0, 6.6), (0, 0, 5.2))
export_glb(OUT_GLB)
print("done")
