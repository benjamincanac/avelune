"""Player build kit: twelve modular pieces on a 2 unit grid.
Run Blender --background --python scripts/build_kit.py.
Use -- --sheet <path> to also render a twelve-up contact sheet.

Conventions, matching the authored town in build_courtyard_architecture.py:
  * Blender Z up, exported +Y up (export_yup): glTF X = Blender X,
    glTF Y = Blender Z, glTF Z = -Blender Y.
  * Origin is the bottom centre of the footprint, so a piece sits on the tile it
    is placed on and rotates about its own centre in quarter turns.
  * Front is Blender +Y, exported glTF -Z. Depth-wise rises (the roof pitch, the
    stair climb) run toward glTF +Z, like `Courtyard_Stairs`.
  * Material names carry the triplanar overlay in app/utils/townMaterials.ts:
    plaster / walnut / terracotta|clay / limestone / shutter. The torch flame is
    the only emissive material and is named so the runtime can find it.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/models/kit'
OUT.mkdir(parents=True, exist_ok=True)


def mat(name, color, rough=.7, metal=0, emission=None):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emission:
        p.inputs['Emission Color'].default_value = (*emission, 1)
        p.inputs['Emission Strength'].default_value = 3.5
    return m


# Same palette as the courtyard buildings so the kit reads as one game.
# Every painted material needs a roughness of its own: COLOR_0 drives base
# colour, so materials that also shared a roughness would be byte-identical and
# `gltf-transform optimize` would dedup them into one, collapsing the names the
# triplanar overlay keys off.
plaster = mat('Warm limewashed plaster', (.86, .80, .67), .78)
trim = mat('Carved pale limestone', (.84, .81, .69), .72)
wood = mat('Weathered walnut beams', (.15, .115, .087), .66)
roof = mat('Warm terracotta roof tiles', (.48, .19, .115), .82)
rooflight = mat('Sunlit clay tile edges', (.67, .30, .18), .80)
shutter = mat('Painted teal shutters', (.07, .27, .25), .60)
gold = mat('Warm brass accents', (.56, .34, .105), .32, .6)
flame = mat('Ember torch flame', (.98, .58, .16), .9, 0, (1, .52, .13))
materials = [plaster, trim, wood, roof, rooflight, shutter, gold, flame]
# Everything but the flame takes the baked COLOR_0 footing gradient.
painted = [plaster, trim, wood, roof, rooflight, shutter]


def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def mesh(name, verts, faces, material, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    for p in obj.data.polygons:
        p.use_smooth = smooth
    return obj


def bevel(obj, width=.02):
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new('Soft crafted edges', 'BEVEL')
    mod.width = width
    mod.segments = 1
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod = obj.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.weight = 40
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name, loc, scale, material=plaster, r=.02):
    """Axis-aligned box from its centre and full size."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    if r:
        bevel(obj, r)
    return obj


def slabbox(name, x0, x1, y0, y1, z0, z1, material=plaster, r=.02):
    """Box from its bounds, which is how the grid pieces are actually authored."""
    return box(name, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
               (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)), material, r)


def beam(name, a, b, r, material=wood):
    direction = Vector(b) - Vector(a)
    obj = box(name, (Vector(a) + Vector(b)) / 2, (r, r, direction.length), material, r * .14)
    obj.rotation_euler = direction.to_track_quat('Z', 'Y').to_euler()
    return obj


def diagonal(name, a, b, width, depth, material=wood):
    """A slanted timber in the XZ plane, `depth` thick across the wall so it
    reads on both faces instead of hiding inside the plaster."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    obj = box(name, ((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2),
              (width, depth, math.hypot(dx, dz)), material, .012)
    obj.rotation_euler = (0, math.atan2(dx, dz), 0)
    return obj


def prism(name, points, thickness, material, base=0, axis='Z'):
    """Extrude a closed polygon, given counter-clockwise looking down the
    extrusion axis, by `thickness`. `axis` 'Z' takes (x, y) points, 'X' takes
    (y, z) points."""
    def place(u, v, t):
        return (t, u, v) if axis == 'X' else (u, v, t)
    n = len(points)
    verts = [place(u, v, base) for u, v in points] + [place(u, v, base + thickness) for u, v in points]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return mesh(name, verts, faces, material)


def disc(radius, sides=8):
    return [(radius * math.cos(math.tau * i / sides), radius * math.sin(math.tau * i / sides))
            for i in range(sides)]


def height_slab(name, hfunc, thickness, material, nx=4, ny=4, x0=-1, x1=1, y0=-1, y1=1):
    """A slab whose top follows `hfunc(x, y)` and whose bottom trails it by
    `thickness`. The roof pitch and the hip corner share it, so their edge
    heights agree exactly and the two butt together without a seam."""
    top, bottom = [], []
    for i in range(nx + 1):
        x = x0 + (x1 - x0) * i / nx
        for j in range(ny + 1):
            y = y0 + (y1 - y0) * j / ny
            h = hfunc(x, y)
            top.append((x, y, h))
            bottom.append((x, y, h - thickness))
    off = len(top)
    faces = []
    for i in range(nx):
        for j in range(ny):
            a = i * (ny + 1) + j
            faces.append((a, a + ny + 1, a + ny + 2, a + 1))
            b = a + off
            faces.append((b + 1, b + ny + 2, b + ny + 1, b))
    for i in range(nx):
        a, c = i * (ny + 1), (i + 1) * (ny + 1)
        faces.append((a + off, c + off, c, a))
        a, c = a + ny, c + ny
        faces.append((a, c, c + off, a + off))
    for j in range(ny):
        a, c = j, j + 1
        faces.append((a, c, c + off, a + off))
        a, c = nx * (ny + 1) + j, nx * (ny + 1) + j + 1
        faces.append((a + off, c + off, c, a))
    return mesh(name, top + bottom, faces, material)


# --- the twelve pieces -------------------------------------------------------
# Declared as width (X) x depth (Y, exported Z) x height (Z, exported Y).

WALL_W, WALL_D, WALL_H = 2.0, .30, 2.5
HD = WALL_D / 2          # the frame face: nothing may stick out past it
PD = HD - .045           # the plaster sits recessed between the timbers


def wall_frame(door_gap=0.0):
    """Timber frame shared by the three wall panels. Posts and plates stand a
    little proud of the plaster on both faces, like the town's upper storeys."""
    for x in [-.9, .9]:
        slabbox('Corner post', x - .1, x + .1, -HD, HD, 0, WALL_H, wood)
    slabbox('Top plate', -1, 1, -HD, HD, WALL_H - .18, WALL_H, wood)
    if door_gap:
        for side in [-1, 1]:
            slabbox('Sill beam', side * door_gap, side, -HD, HD, 0, .16, wood)
    else:
        slabbox('Sill beam', -1, 1, -HD, HD, 0, .16, wood)


def kit_wall():
    slabbox('Plaster panel', -1, 1, -PD, PD, 0, WALL_H, plaster)
    wall_frame()
    slabbox('Mid rail', -.9, .9, -HD, HD, 1.42, 1.56, wood)
    for side in [-1, 1]:
        diagonal('Corner brace', (side * .86, .18), (side * .4, 1.42), .16, 2 * HD)


def kit_wall_window():
    ox0, ox1, oz0, oz1 = -.45, .45, 1.15, 1.95
    slabbox('Plaster apron', -1, 1, -PD, PD, 0, oz0, plaster)
    slabbox('Plaster header', -1, 1, -PD, PD, oz1, WALL_H, plaster)
    slabbox('Plaster jamb left', -1, ox0, -PD, PD, oz0, oz1, plaster)
    slabbox('Plaster jamb right', ox1, 1, -PD, PD, oz0, oz1, plaster)
    wall_frame()
    slabbox('Carved sill', ox0 - .16, ox1 + .16, -HD, HD, oz0 - .1, oz0, trim)
    slabbox('Window lintel', ox0 - .12, ox1 + .12, -PD - .01, PD + .01, oz1, oz1 + .11, trim)
    beam('Window mullion', (0, 0, oz0), (0, 0, oz1), .055, trim)
    for side in [-1, 1]:
        sx = side * (ox1 + .21)
        slabbox('Celadon shutter', sx - .19, sx + .19, PD, HD, oz0 + .02, oz1 - .02, shutter, .012)
        for dz in [oz0 + .17, oz1 - .17]:
            slabbox('Shutter strap', sx - .2, sx + .2, HD - .02, HD, dz - .02, dz + .02, gold, .006)


def kit_wall_door():
    ox0, ox1, oz1 = -.5, .5, 2.0
    slabbox('Plaster header', -1, 1, -PD, PD, oz1, WALL_H, plaster)
    slabbox('Plaster jamb left', -1, ox0, -PD, PD, 0, oz1, plaster)
    slabbox('Plaster jamb right', ox1, 1, -PD, PD, 0, oz1, plaster)
    wall_frame(door_gap=.5)
    slabbox('Door lintel', ox0 - .16, ox1 + .16, -HD, HD, oz1, oz1 + .14, trim)
    slabbox('Threshold', ox0 - .06, ox1 + .06, -HD, HD, 0, .06, trim)
    for side in [-1, 1]:
        slabbox('Door jamb board', side * .43, side * .57, -HD, HD, .06, oz1, wood, .012)


def kit_floor():
    for i in range(5):
        x0 = -1 + i * .4
        slabbox('Floor plank', x0 + .012, x0 + .388, -.94, .94, .06, .2, wood, .012)
    for y in [-1, 1]:
        slabbox('Floor joist', -1, 1, y, y - math.copysign(.07, y), 0, .2, wood)
    slabbox('Floor underside', -1, 1, -.93, .93, 0, .07, wood, 0)


ROOF_TOP, ROOF_THICK = 1.2, .14
ROOF_SLOPE = ROOF_TOP - ROOF_THICK


def pitch(x, y):
    return ROOF_THICK + ROOF_SLOPE * (1 - y) / 2


def hip(x, y):
    return ROOF_THICK + ROOF_SLOPE * min((1 - y) / 2, (1 + x) / 2)


def kit_roof():
    # Climbs from the eave at Blender +Y (glTF -Z) to the ridge at Blender -Y.
    height_slab('Roof pitch', pitch, ROOF_THICK, roof, 2, 2)
    angle = math.atan2(ROOF_SLOPE, 2)
    for i in range(7):
        x = -.75 + i * .25
        tile = box('Tile course', (x, 0, ROOF_THICK + ROOF_SLOPE / 2 + .028),
                   (.10, 2 / math.cos(angle), .055), rooflight, .012)
        tile.rotation_euler = (-angle, 0, 0)
    slabbox('Ridge cap', -1, 1, -1, -.86, ROOF_TOP - .11, ROOF_TOP, rooflight, .015)
    slabbox('Eave board', -1, 1, .9, 1, 0, .15, trim, .015)


def kit_roof_corner():
    # Hip corner: the two outer edges (Blender +Y and -X) sit at the eave and the
    # piece climbs to the inner corner, so each edge matches Kit_Roof exactly.
    height_slab('Hip pitch', hip, ROOF_THICK, roof, 6, 6)
    line = [(-1 + 2 * t, 1 - 2 * t) for t in [.04 + .92 * i / 5 for i in range(6)]]
    for (x0, y0), (x1, y1) in zip(line, line[1:]):
        beam('Hip ridge', (x0, y0, hip(x0, y0) + .015), (x1, y1, hip(x1, y1) + .015), .075, rooflight)
    slabbox('Eave board', -1, 1, .9, 1, 0, .15, trim, .015)
    slabbox('Eave board', -1, -.9, -1, .9, 0, .15, trim, .015)


STAIR_STEPS, STAIR_H = 8, 2.5


def kit_stairs():
    # Climbs along Blender -Y, exported +Z, like Courtyard_Stairs.
    run = 2 / STAIR_STEPS
    for i in range(STAIR_STEPS):
        y1 = 1 - i * run
        slabbox('Step tread', -.86, .86, y1 - run, y1, 0, (i + 1) * STAIR_H / STAIR_STEPS, wood, .018)
    profile = [(1, 0)]
    for i in range(STAIR_STEPS):
        y1, z = 1 - i * run, (i + 1) * STAIR_H / STAIR_STEPS
        profile += [(y1, z), (y1 - run, z)]
    profile.append((-1, 0))
    for x in [-1, .86]:
        prism('Stair stringer', profile, .14, wood, x, 'X')


def kit_fence():
    for x in [-.93, 0, .93]:
        slabbox('Fence post', x - .07, x + .07, -.075, .075, 0, 1.0, wood)
    for z in [.34, .78]:
        slabbox('Fence rail', -1, 1, -.045, .045, z, z + .13, wood, .015)


def kit_gate():
    for x in [-.9, .9]:
        slabbox('Gate post', x - .075, x + .075, -.075, .075, 0, 1.0, wood)
        slabbox('Post cap', x - .1, x + .1, -.075, .075, .88, .98, trim, .015)
    slabbox('Gate lintel', -1, 1, -.055, .055, .84, .98, wood, .015)
    slabbox('Brass boss', -.11, .11, -.065, .065, .86, .96, gold, .015)


def kit_torch():
    prism('Torch footing', disc(.16), .12, trim)
    prism('Torch post', disc(.075), 1.22, wood)
    prism('Brazier bowl', disc(.2), .2, gold, 1.16)
    for radius, depth, z in [(.15, .30, 1.45), (.09, .20, 1.40)]:
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=radius, radius2=0, depth=depth, location=(0, 0, z))
        bpy.context.object.name = 'Torch flame'
        bpy.context.object.data.materials.append(flame)


def kit_path():
    # Irregular flagstones, low enough to walk straight over.
    for i in range(3):
        for j in range(3):
            x, y = -1 + (i + .5) * 2 / 3, -1 + (j + .5) * 2 / 3
            w = 2 / 3 - .07 + .04 * math.sin(i * 3.1 + j * 1.7)
            slabbox('Flagstone', x - w / 2, x + w / 2, y - w / 2, y + w / 2, 0, .05, trim, .012)
    slabbox('Path bedding', -1, 1, -1, 1, 0, .022, trim, 0)


def kit_deed():
    # A land-claim signpost: a square post with a small board near the top,
    # facing Blender +Y (exported -Z, the kit's front). The stone base fills the
    # declared 0.4 x 0.4 footprint; the post and board sit inside it.
    slabbox('Deed base', -.2, .2, -.2, .2, 0, .05, trim, .015)
    slabbox('Deed post', -.05, .05, -.05, .05, .05, 1.4, wood)
    slabbox('Deed post cap', -.07, .07, -.07, .07, 1.34, 1.4, trim, .012)
    slabbox('Deed board', -.18, .18, .05, .10, 1.02, 1.26, wood, .012)


def kit_crate():
    slabbox('Crate body', -.45, .45, -.45, .45, .05, .95, wood)
    for z in [.04, .5, .96]:
        for sx in [-1, 1]:
            slabbox('Crate slat', sx * .42, sx * .5, -.5, .5, z - .04, z + .04, wood, .01)
        for sy in [-1, 1]:
            slabbox('Crate slat', -.5, .5, sy * .42, sy * .5, z - .04, z + .04, wood, .01)
    for sx in [-1, 1]:
        for sy in [-1, 1]:
            slabbox('Crate corner', sx * .42, sx * .5, sy * .42, sy * .5, 0, 1, wood, .01)


SPEC = [
    ('Kit_Wall', kit_wall, 2.0, 0.3, 2.5, True),
    ('Kit_WallWindow', kit_wall_window, 2.0, 0.3, 2.5, True),
    ('Kit_WallDoor', kit_wall_door, 2.0, 0.3, 2.5, True),
    ('Kit_Floor', kit_floor, 2.0, 2.0, 0.2, True),
    ('Kit_Roof', kit_roof, 2.0, 2.0, 1.2, False),
    ('Kit_RoofCorner', kit_roof_corner, 2.0, 2.0, 1.2, False),
    ('Kit_Stairs', kit_stairs, 2.0, 2.0, 2.5, True),
    ('Kit_Fence', kit_fence, 2.0, 0.15, 1.0, False),
    ('Kit_Gate', kit_gate, 2.0, 0.15, 1.0, False),
    ('Kit_Torch', kit_torch, 0.4, 0.4, 1.6, False),
    ('Kit_Deed', kit_deed, 0.4, 0.4, 1.4, False),
    ('Kit_Path', kit_path, 2.0, 2.0, 0.05, False),
    ('Kit_Crate', kit_crate, 1.0, 1.0, 1.0, True),
]


def paint_surfaces():
    """COLOR_0 as in build_courtyard_architecture.py: the material base colour
    with a cool footing and a faint sun-bleached drift, so nothing requests a
    texture at runtime."""
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.data.materials:
            continue
        material = obj.data.materials[0]
        if material not in painted or obj.data.color_attributes.get('Color'):
            continue
        colors = obj.data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
        for vertex, attr in zip(obj.data.vertices, colors.data):
            world = obj.matrix_world @ vertex.co
            low = max(0, 1 - world.z / 1.4)
            variation = .015 * math.sin(world.x * 3.7 + world.z * 4.1) * math.cos(world.y * 3.1)
            gains = (.98 - low * .08 + variation, .99 - low * .055 + variation, 1 - low * .012 + variation)
            attr.color = tuple(material.diffuse_color[i] * gains[i] for i in range(3)) + (1,)
    for material in painted:
        if material.node_tree.nodes.get('Kit vertex colour'):
            continue
        nodes, links = material.node_tree.nodes, material.node_tree.links
        vertex = nodes.new('ShaderNodeVertexColor')
        vertex.name = 'Kit vertex colour'
        vertex.layer_name = 'Color'
        links.new(vertex.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])


def join_by_material():
    for material in materials:
        obs = [o for o in bpy.context.scene.objects
               if o.type == 'MESH' and o.data.materials and o.data.materials[0] == material]
        if not obs:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in obs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = obs[0]
        if len(obs) > 1:
            bpy.ops.object.join()
        obs[0].name = material.name


def bounds():
    verts = [o.matrix_world @ v.co for o in bpy.context.scene.objects
             if o.type == 'MESH' for v in o.data.vertices]
    return [(round(min(v[i] for v in verts), 3), round(max(v[i] for v in verts), 3)) for i in range(3)]


def triangles():
    total = 0
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        o.data.calc_loop_triangles()
        total += len(o.data.loop_triangles)
    return total


def export(name):
    join_by_material()
    box3, tris = bounds(), triangles()
    bpy.ops.export_scene.gltf(filepath=str(OUT / (name + '.glb')), export_format='GLB',
                              export_yup=True, export_animations=False, export_cameras=False,
                              export_lights=False, export_texcoords=False)
    print('KIT', name, 'bytes', (OUT / (name + '.glb')).stat().st_size, 'tris', tris, 'bounds', box3)
    return box3


def contact_sheet(path):
    reset()
    for index, spec in enumerate(SPEC):
        before = set(bpy.context.scene.objects)
        spec[1]()
        offset = Vector(((index % 4) * 2.9 - 4.35, 2.9 - (index // 4) * 2.9, 0))
        for o in set(bpy.context.scene.objects) - before:
            o.location = o.location + offset
    paint_surfaces()
    box('Sheet ground', (0, 0, -.06), (40, 40, .1), mat('Sheet ground', (.22, .26, .22)), 0)
    # A 2 unit outline under every piece, so anything off-grid is obvious.
    marker = mat('Sheet grid', (.45, .50, .42))
    for index in range(len(SPEC)):
        cx, cy = (index % 4) * 2.9 - 4.35, 2.9 - (index // 4) * 2.9
        for side in [-1, 1]:
            box('Grid edge', (cx + side, cy, -.004), (.03, 2, .02), marker, 0)
            box('Grid edge', (cx, cy + side, -.004), (2, .03, .02), marker, 0)
    bpy.ops.object.camera_add(location=(8, -14, 12))
    cam = bpy.context.object
    cam.rotation_euler = (Vector((0, 0, .9)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 16
    scene = bpy.context.scene
    scene.camera = cam
    for loc, power, size in [((3, -7, 14), 1500, 10), ((-9, -4, 8), 700, 9)]:
        bpy.ops.object.light_add(type='AREA', location=loc)
        o = bpy.context.object
        o.data.energy = power
        o.data.shape = 'DISK'
        o.data.size = size
        o.rotation_euler = (-o.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.world.color = (.3, .3, .3)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('SHEET', path)


manifest = []
for name, builder, width, depth, height, stackable in SPEC:
    reset()
    builder()
    paint_surfaces()
    measured = export(name)
    for label, declared, span in [('width', width, measured[0][1] - measured[0][0]),
                                  ('depth', depth, measured[1][1] - measured[1][0]),
                                  ('height', height, measured[2][1] - measured[2][0])]:
        if abs(span - declared) > .06:
            print('WARN', name, label, 'declared', declared, 'measured', round(span, 3))
    if abs(measured[2][0]) > .015:
        print('WARN', name, 'does not sit on the ground, min z', measured[2][0])
    if abs(measured[0][0] + measured[0][1]) > .03 or abs(measured[1][0] + measured[1][1]) > .03:
        print('WARN', name, 'is not centred on its footprint', measured[0], measured[1])
    manifest.append({'kind': name, 'file': name + '.glb', 'width': width, 'depth': depth,
                     'height': height, 'solid': True, 'stackable': stackable})

(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('MANIFEST', OUT / 'manifest.json')

if '--sheet' in sys.argv:
    contact_sheet(sys.argv[sys.argv.index('--sheet') + 1])
