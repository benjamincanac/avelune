"""Build the original courtyard fountain. Blender --background --python this_file.

Blender Z becomes glTF Y. The open basin receives the runtime water at Y=.48.
No source downloads, textures, or addon dependencies.
"""
import bpy
import math
import random
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/models/courtyard/fountain.glb'
random.seed(18)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, rgb, roughness=.8, metallic=0, vertex=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if vertex:
        attr = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Color'
        mat.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    return mat

stone = material('Warm carved limestone', (.68, .64, .50), vertex=True)
carving = material('Ivory relief', (.81, .77, .62), vertex=True)
gold = material('Aged champagne brass', (.59, .39, .13), .34, .72)
teal = material('Glazed celadon', (.09, .35, .29), .24, .2)
objects = []


def finish(obj, mat, shade=True):
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = shade
    if mat in (stone, carving):
        colors = obj.data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
        base = (.69, .655, .545) if mat == stone else (.81, .775, .645)
        # Broad, restrained mineral variation survives export as vertex colors.
        for v, color in zip(obj.data.vertices, colors.data):
            x, y, z = v.co
            grain = .014 * math.sin(x * 17 + y * 7 + z * 8)
            broad = .018 * math.sin(x * 3.1 + y * 2.3 + z * 4)
            shade_value = grain + broad - .025 * max(0, .38 - z)
            color.color = (*[max(0, channel + shade_value) for channel in base], 1)
    objects.append(obj)
    return obj


def lathe(name, profile, mat=stone, n=96):
    vertices = []
    for r, z in profile:
        for i in range(n):
            a = 2 * math.pi * i / n
            vertices.append((r * math.cos(a), r * math.sin(a), z))
    faces = []
    for j in range(len(profile) - 1):
        for i in range(n):
            k = j * n + i
            k1 = j * n + (i + 1) % n
            faces.append((k, k1, k1 + n, k + n))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, mat)


def bevel(obj, width=.025, segments=2):
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new('Rounded mason edges', 'BEVEL')
    mod.width = width
    mod.segments = segments
    bpy.ops.object.modifier_apply(modifier=mod.name)


# Three broad, individually cut stone courses form a walkable approach.
# Keep this profile aligned with shared fountain collision constants.
for course, (inner, outer, top, count) in enumerate([
    (3.5, 3.8, .18, 40), (3.25, 3.5, .36, 36), (3.05, 3.25, .54, 32),
]):
    for k in range(count):
        n = 6
        verts = []
        for z in (.0, top):
            for r in (inner, outer):
                for i in range(n + 1):
                    a = math.tau * (k + .005 + .99 * i / n) / count
                    verts.append((r * math.cos(a), r * math.sin(a), z))
        faces = []
        stride = 2 * (n + 1)
        for i in range(n):
            faces.extend([(i, i+1, i+n+2, i+n+1),
                          (stride+i+n+1, stride+i+n+2, stride+i+1, stride+i),
                          (i+stride, i+stride+1, i+1, i),
                          (i+n+1, i+n+2, i+n+2+stride, i+n+1+stride)])
        faces.extend([(0, n+1, n+1+stride, stride), (n, n+stride, 2*n+1+stride, 2*n+1)])
        mesh = bpy.data.meshes.new('Cut limestone')
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(f'Pool stair {course + 1}', mesh)
        bpy.context.collection.objects.link(obj)
        bevel(obj, .008, 2)
        finish(obj, carving if course == 2 else stone, False)

# Watertight floor and submerged inner step. Runtime water sits at .48.
basin = lathe('Shallow wading basin', [
    (0, 0), (3.05, 0), (3.05, .30), (2.85, .30),
    (2.85, .12), (0, .12), (0, 0),
], n=160)
for face in basin.data.polygons:
    face.use_smooth = False

# Celadon inlay gives the clear water a readable bottom without textures.
for radius in (.78, 2.55):
    lathe('Submerged celadon inlay', [
        (radius, .121), (radius + .035, .121),
    ], teal, 160)
for k in range(24):
    a = math.tau * k / 24
    r = 2.7
    bpy.ops.mesh.primitive_cube_add(size=1, location=(r*math.cos(a), r*math.sin(a), .124))
    tile = bpy.context.object
    tile.name = 'Submerged mosaic diamond'
    tile.scale = (.055, .055, .006)
    tile.rotation_euler.z = a + math.pi / 4
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel(tile, .003, 1)
    finish(tile, teal, False)

# The existing pedestal rises from the new, lower pool floor.
lathe('Submerged pedestal foundation', [(0,.12),(.55,.12),(.55,.30),(0,.30)])

# The stem is an urn-shaped, gently fluted stone baluster.
lathe('Pedestal foot', [(0,.30),(.53,.30),(.55,.33),(.55,.36),(.52,.39),
    (.45,.40),(.42,.44),(.42,.49),(.46,.52),(.46,.56),(.42,.59),
    (.34,.63),(.28,.70),(.24,.79),(.22,.84),(0,.84)])
profile = [(.22,.76),(.225,.84),(.245,.96),(.29,1.09),(.31,1.19),
           (.30,1.27),(.26,1.35),(.21,1.42),(.185,1.47),(.185,1.53)]
stem = lathe('Fluted urn baluster', profile, carving)
for v in stem.data.vertices:
    a = math.atan2(v.co.y, v.co.x)
    strength = math.sin(math.pi * (v.co.z - .76) / .77) ** 2
    scale = 1 + .07 * math.cos(a * 12) * strength
    v.co.x *= scale
    v.co.y *= scale
lathe('Upper capital', [(0,1.48),(.205,1.48),(.23,1.51),(.23,1.54),
    (.29,1.56),(.31,1.60),(.31,1.64),(0,1.64)], carving)

# Small lily-shaped receiving bowl, with a thin scalloped edge.
upper = lathe('Lily upper bowl', [(0,1.59),(.29,1.59),(.36,1.63),(.43,1.67),
    (.52,1.72),(.62,1.81),(.70,1.91),(.72,1.96),(.715,1.985),
    (.685,2.00),(.654,1.97),(.64,1.92),(.58,1.84),(.49,1.77),
    (.38,1.73),(0,1.72),(0,1.59)], carving)
for v in upper.data.vertices:
    a = math.atan2(v.co.y, v.co.x)
    blend = max(0, (v.co.z - 1.72) / .28)
    v.co.z += .025 * math.cos(8 * a) * blend
    radius_scale = 1 + .025 * math.cos(8 * a) * blend
    v.co.x *= radius_scale
    v.co.y *= radius_scale

# Raised acanthus leaves formed as thick curved lanceolate surfaces.
def leaf(name, angle, r0, r1, z0, z1, width, mat=carving):
    verts = []
    rows, cols = 12, 6
    for back in (False, True):
        for j in range(rows + 1):
            t = j / rows
            half_width = width * math.sin(math.pi * t) ** .8 + .001
            for i in range(cols + 1):
                s = 2 * i / cols - 1
                ridge = .028 * (1 - abs(s)) * math.sin(math.pi * t)
                r = r0 + (r1 - r0) * t + .035 * math.sin(math.pi * t) + ridge
                r -= .012 if back else 0
                tangent = s * half_width
                verts.append((r * math.cos(angle) - tangent * math.sin(angle),
                              r * math.sin(angle) + tangent * math.cos(angle),
                              z0 + (z1 - z0) * t + .013 * abs(s) * math.sin(math.pi * t)))
    size = (rows + 1) * (cols + 1)
    faces = []
    for j in range(rows):
        for i in range(cols):
            a = j * (cols + 1) + i
            faces.append((a,a+1,a+cols+2,a+cols+1))
            faces.append((a+size+cols+1,a+size+cols+2,a+size+1,a+size))
    for j in range(rows):
        for i in (0,cols):
            a = j * (cols + 1) + i
            b = a + cols + 1
            faces.append((a,b,b+size,a+size))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, mat)

for k in range(8):
    leaf('Capital lily carving', math.tau*k/8, .345, .657, 1.645, 1.928, .075)

lathe('Brass finial socket', [(0,1.72),(.15,1.72),(.165,1.76),(.16,1.80),
    (.11,1.83),(.09,1.89),(.075,1.94),(0,1.94)], gold, 48)
lathe('Celadon bud', [(0,1.86),(.075,1.86),(.12,1.95),(.13,2.06),
    (.105,2.17),(.075,2.25),(.045,2.34),(.02,2.43),(0,2.47)], teal, 48)
for k in range(5):
    leaf('Gilded lotus prong', math.tau*k/5, .075, .06, 1.87, 2.30, .045, gold)

# Recalculate consistent outside normals before joining into four draw calls.
for obj in objects:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
for mat in (stone, carving, gold, teal):
    selected = [obj for obj in list(bpy.context.scene.objects) if obj.type == 'MESH' and obj.data.materials[0] == mat]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = selected[0]
    if len(selected) > 1:
        bpy.ops.object.join()
    selected[0].name = mat.name

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(OUTPUT), export_format='GLB',
    export_yup=True, export_animations=False, export_cameras=False,
    export_lights=False, export_materials='EXPORT', export_normals=True,
    export_texcoords=False, export_attributes=False)
verts = [o.matrix_world @ v.co for o in bpy.context.scene.objects if o.type == 'MESH' for v in o.data.vertices]
print('FOUNTAIN', {'bytes': OUTPUT.stat().st_size,
    'meshes':len([o for o in bpy.context.scene.objects if o.type == 'MESH']),
    'vertices':len(verts), 'radius':round(max(math.hypot(v.x,v.y) for v in verts), 4),
    'height':round(max(v.z for v in verts), 4), 'min_z':round(min(v.z for v in verts),4)})

# Optional Meshopt output preserves vertex colors and the four material groups.
import sys
if '--compress' in sys.argv:
    import subprocess
    subprocess.run(['npx', '--yes', '@gltf-transform/cli@4.4.1', 'meshopt', str(OUTPUT), str(OUTPUT)], check=True)

# Optional studio image for inspecting the authored mesh.
if '--render' in sys.argv:
    floor_mat = material('Studio floor', (.25,.29,.24))
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(floor_mat)
    bpy.ops.object.camera_add(location=(5,-6,4.6))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0,0,1.03)) - camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 9.2
    bpy.context.scene.camera = camera
    for loc, energy, size, color in [((2,-3,7),900,5,(1,.88,.71)),((-3,-1,4),600,4,(.7,.82,1))]:
        bpy.ops.object.light_add(type='AREA', location=loc)
        light = bpy.context.object
        light.data.energy = energy
        light.data.shape = 'DISK'
        light.data.size = size
        light.data.color = color
        light.rotation_euler = (-light.location).to_track_quat('-Z','Y').to_euler()
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.world.color = (.25,.25,.25)
    scene.render.filepath = '/tmp/avelune-fountain.png'
    bpy.ops.render.render(write_still=True)
