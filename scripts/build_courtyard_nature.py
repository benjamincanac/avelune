"""Original courtyard botanicals. Run with Blender --background --python this_file.

Exports static GLBs with smooth normals and painted vertex colors, no textures.
Use --render for a studio preview at /tmp/tempest-nature.png.
"""
import bpy
import math
import random
import sys
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parents[1] / 'public/models/courtyard'
OUT.mkdir(parents=True, exist_ok=True)
random.seed(62)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, roughness=.88):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = roughness
    color = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    color.layer_name = 'Color'
    mat.node_tree.links.new(color.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


foliage = material('Painted jade foliage')
wood = material('Warm smooth bark')
petal_mat = material('Porcelain petals', .7)
rock_mat = material('Blue limestone', .92)
assets = {}


def mesh(name, verts, faces, mat, color, gradient=.15):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    zmin = min(v[2] for v in verts)
    zmax = max(v[2] for v in verts)
    colors = data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
    for vertex, attr in zip(data.vertices, colors.data):
        t = (vertex.co.z - zmin) / max(.001, zmax - zmin)
        gain = 1 - gradient / 2 + gradient * t
        attr.color = (*[max(.005, min(.98, c * gain)) for c in color], 1)
    for p in data.polygons:
        p.use_smooth = True
    return obj


def tube(name, points, radii, color=(.26, .16, .087), sides=9, mat=wood):
    verts, faces = [], []
    for i, point in enumerate(points):
        p = Vector(point)
        direction = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])
        direction.normalize()
        u = direction.cross(Vector((0, 1, 0))).normalized()
        v = direction.cross(u).normalized()
        for j in range(sides):
            a = math.tau * j / sides
            pos = p + radii[i] * (u * math.cos(a) + v * math.sin(a))
            verts.append(tuple(pos))
        if i:
            for j in range(sides):
                k = i * sides + j
                faces.append((k, i * sides + (j + 1) % sides, (i - 1) * sides + (j + 1) % sides, k - sides))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple((len(points) - 1) * sides + j for j in range(sides)))
    return mesh(name, verts, faces, mat, color)


def crown(name, center, scale, color, phase=0, segments=14, rings=7):
    """Closed convex foliage lobes with shared poles and soft surface variation."""
    verts = [(center[0], center[1], center[2] + scale[2])]
    faces = []
    for row in range(1, rings):
        phi = math.pi * row / rings
        for col in range(segments):
            theta = math.tau * col / segments
            ripple = 1 + .045 * math.sin(theta * 3 + phase) * math.sin(phi)**2
            radial = math.sin(phi) * ripple
            verts.append((center[0] + scale[0] * radial * math.cos(theta),
                          center[1] + scale[1] * radial * math.sin(theta),
                          center[2] + scale[2] * math.cos(phi)))
    bottom = len(verts)
    verts.append((center[0], center[1], center[2] - scale[2]))
    for col in range(segments):
        faces.append((0, 1 + col, 1 + (col + 1) % segments))
        for row in range(rings - 2):
            a = 1 + row * segments + col
            b = 1 + row * segments + (col + 1) % segments
            faces.append((a, a + segments, b + segments, b))
        a = 1 + (rings - 2) * segments + col
        b = 1 + (rings - 2) * segments + (col + 1) % segments
        faces.append((a, bottom, b))
    return mesh(name, verts, faces, foliage, color, .42)


def leaf(name, center, length, width, angle, color, mat=foliage, normal=None):
    # A convex folded almond leaf, eight smooth triangles instead of a plane.
    local = [(0, 0, .025), (-length*.5, 0, 0), (-length*.2, width*.5, 0),
             (length*.25, width*.42, 0), (length*.5, 0, .02),
             (length*.25, -width*.42, 0), (-length*.2, -width*.5, 0), (0, 0, -.02)]
    rotation = Vector(normal).to_track_quat('Z', 'Y') if normal else None
    verts = []
    for x, y, z in local:
        v = Vector((x*math.cos(angle)-y*math.sin(angle), x*math.sin(angle)+y*math.cos(angle), z))
        if rotation:
            v = rotation @ v
        verts.append(tuple(Vector(center) + v))
    faces = []
    for i in range(1, 7):
        j = 1 if i == 6 else i+1
        faces.extend([(0,i,j),(7,j,i)])
    return mesh(name, verts, faces, mat, color)


def leafy_crown(name, center, scale, color, phase=0, leaves=24):
    # The small shadow core is obscured by outward-facing overlapping leaves.
    core_scale = tuple(v*.54 for v in scale)
    crown(name + ' shadow core', center, core_scale, tuple(c*.78 for c in color), phase, 10, 5)
    for i in range(leaves):
        z = 1 - 2*(i+.5)/leaves
        radius = math.sqrt(1-z*z)
        theta = i*2.399963 + phase
        normal = Vector((radius*math.cos(theta),radius*math.sin(theta),z))
        pos = tuple(center[j] + normal[j]*scale[j]*.76 for j in range(3))
        tint = tuple(c*(.86+random.random()*.27) for c in color)
        length = max(scale)*(.77+random.random()*.23)
        leaf(name + ' almond foliage', pos, length, length*.53,
             random.random()*math.tau, tint, normal=normal)


def export(name, start):
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in start]
    joined = []
    groups = [[o for o in objects if o.data.materials[0] == mat] for mat in {o.data.materials[0] for o in objects}]
    for group in groups:
        bpy.ops.object.select_all(action='DESELECT')
        for o in group:
            o.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        if len(group) > 1:
            bpy.ops.object.join()
        group[0].name = name + '_' + group[0].data.materials[0].name
        joined.append(group[0])
    bpy.ops.object.select_all(action='DESELECT')
    for o in joined:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT / (name+'.glb')), export_format='GLB',
        use_selection=True, export_yup=True, export_animations=False,
        export_cameras=False, export_lights=False, export_texcoords=False)
    for o in joined:
        o.data.calc_loop_triangles()
    print('ASSET', name, 'triangles', sum(len(o.data.loop_triangles) for o in joined), 'bytes', (OUT/(name+'.glb')).stat().st_size)
    assets[name] = joined


start = set(bpy.context.scene.objects)
tube('Bent trunk', [(0,0,0),(.08,.02,.6),(.15,.01,1.25),(.08,.08,2),(-.11,.15,2.65),(-.22,.17,3.4),(-.1,.12,4.5),(.06,.16,5.4)], [.34,.27,.23,.205,.17,.12,.07,.015], sides=12)
for k in range(5):
    a = k*math.tau/5+.3
    tube('Root flare',[(math.cos(a)*.51,math.sin(a)*.51,.01),(math.cos(a)*.3,math.sin(a)*.3,.12),(0,0,.46)],[.025,.105,.12],sides=7)
# Broad asymmetrical layers leave visible negative space around the branches.
for k in range(10):
    a = k*2.399
    z = 2.8 + k*.21
    reach = 1.55 if k < 6 else 1.03
    end = Vector((math.cos(a)*reach, math.sin(a)*reach,z+.7))
    tube('Swept bough',[(0,.1,z-.55),(end.x*.38,end.y*.38,z-.14),(end.x*.76,end.y*.76,z+.26),tuple(end)],[.13,.09,.055,.016],sides=8)
    for q in range(5):
        theta = a + q*1.256
        center = (end.x+math.cos(theta)*.43, end.y+math.sin(theta)*.43,z+.72+(q%3)*.20)
        color = (.105+random.random()*.05,.285+random.random()*.075,.07+random.random()*.025)
        leafy_crown('Layered leaf pad',center,(.46+random.random()*.14,.42+random.random()*.13,.36+random.random()*.13),color,k+q)

for k in range(6):
    a=k*2.399
    center=(math.cos(a)*.52,math.sin(a)*.5,5.53+random.random()*.36)
    leafy_crown('Crown crest',center,(.60,.57,.47),(.16,.37,.10),k)
export('tree',start)

start=set(bpy.context.scene.objects)
for k in range(13):
    a=k*2.399
    center=(math.cos(a)*.40,math.sin(a)*.35,.25+random.random()*.22)
    leafy_crown('Low shrub rosette',center,(.25,.24,.24),(.10+random.random()*.05,.28+random.random()*.06,.07),k,leaves=18)
export('bush',start)

start=set(bpy.context.scene.objects)
for k in range(9):
    a=k*2.399
    x,y=math.cos(a)*.36,math.sin(a)*.3
    h=.26+random.random()*.23
    tube('Flower stem',[(x,y,0),(x+.035,y,h*.6),(x+.02,y,h)],[.012,.01,.007],(.12,.26,.07),5,foliage)
    leaf('Basal leaf',(x+.06,y,.07),.24,.12,a,(.12,.29,.09))
    for j in range(5):
        theta=j*math.tau/5
        color=(.70,.80,.72) if k%3 else (.25,.42,.73)
        leaf('Five petal blossom',(x+.02+math.cos(theta)*.064,y+math.sin(theta)*.064,h),.115,.074,theta,color,petal_mat)
    crown_obj=crown('Pollen heart',(x+.02,y,h+.014),(.025,.025,.017),(.8,.59,.12),segments=8,rings=4)
    crown_obj.data.materials[0]=petal_mat
export('flowers',start)

start=set(bpy.context.scene.objects)
# A continuous weather-rounded boulder with broad irregular ridges, no cube seams.
verts,faces=[],[]
for row in range(9):
    phi=math.pi*row/8
    for col in range(16):
        a=math.tau*col/16
        r=math.sin(phi)*(1+.09*math.sin(a*3+phi*2)+.06*math.cos(a*5))
        z=max(0,.43+.49*math.cos(phi)+.04*math.sin(a*3)*math.sin(phi))
        verts.append((r*.75,r*math.sin(a)*.60,z))
        verts[-1]=(r*math.cos(a)*.75,verts[-1][1],z)
        if row:
            i=(row-1)*16+col
            faces.append((i,row*16+col,row*16+(col+1)%16,(row-1)*16+(col+1)%16))
mesh('Eroded limestone',verts,faces,rock_mat,(.36,.40,.36),.22)
export('rock',start)

if '--render' in sys.argv:
    for name, objects in assets.items():
        offset={'tree':(0,0,0),'bush':(-1.65,-1.9,0),'flowers':(.25,-2.1,0),'rock':(1.6,-1.7,0)}[name]
        for obj in objects:
            obj.location += Vector(offset)
    bpy.ops.mesh.primitive_plane_add(size=200)
    ground=bpy.context.object
    mat=bpy.data.materials.new('Studio background')
    mat.diffuse_color=(.15,.19,.16,1)
    ground.data.materials.append(mat)
    bpy.ops.object.camera_add(location=(10,-15,10))
    cam=bpy.context.object
    cam.rotation_euler=(Vector((0,0,2.9))-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type='ORTHO'
    cam.data.ortho_scale=8.1
    bpy.context.scene.camera=cam
    for location,energy,size,color in [((0,-5,11),1700,6,(1,.91,.77)),((-5,1,7),1000,5,(.72,.83,1))]:
        bpy.ops.object.light_add(type='AREA',location=location)
        light=bpy.context.object
        light.data.energy=energy
        light.data.shape='DISK'
        light.data.size=size
        light.data.color=color
        light.rotation_euler=(Vector((0,0,3))-light.location).to_track_quat('-Z','Y').to_euler()
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=24
    scene.render.resolution_x=1000
    scene.render.resolution_y=1000
    scene.render.resolution_percentage=100
    scene.world.color=(.24,.24,.24)
    scene.render.filepath='/tmp/tempest-nature.png'
    bpy.ops.render.render(write_still=True)
