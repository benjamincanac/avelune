"""Original stylized courtyard architecture, authored from curved mesh profiles.
Run Blender --background --python scripts/build_courtyard_architecture.py.
Front is Blender -Y, exported +Z. Each asset is centered and grounded.
"""
import bpy
import math
import random
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/models/courtyard'
OUT.mkdir(parents=True, exist_ok=True)
random.seed(12)


def mat(name, color, rough=.7, metal=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color,1)
    m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=rough
    p.inputs['Metallic'].default_value=metal
    return m

stone=mat('Honey ivory plaster',(.75,.695,.54))
trim=mat('Carved pale limestone',(.91,.835,.64))
wood=mat('Walnut beams',(.205,.135,.08))
roof=mat('Glazed peacock roof',(.07,.29,.32),.42)
rooflight=mat('Celadon tile variation',(.13,.39,.40),.43)
glass=mat('Dusky blue window',(.095,.235,.285),.28,.15)
gold=mat('Warm brass accents',(.56,.34,.105),.32,.6)
leafmat=mat('Garden foliage',(.19,.35,.14))
materials=[stone,trim,wood,roof,rooflight,glass,gold,leafmat]


def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def mesh(name,verts,faces,material,smooth=True):
    data=bpy.data.meshes.new(name)
    data.from_pydata(verts,[],faces)
    data.update()
    obj=bpy.data.objects.new(name,data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    for p in obj.data.polygons:p.use_smooth=smooth
    return obj


def bevel(obj,width=.04):
    bpy.context.view_layer.objects.active=obj
    mod=obj.modifiers.new('Soft crafted edges','BEVEL');mod.width=width;mod.segments=2
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod=obj.modifiers.new('Face normals','WEIGHTED_NORMAL');mod.keep_sharp=True;mod.weight=40
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name,loc,scale,material=stone,r=.05):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc)
    obj=bpy.context.object;obj.name=name;obj.dimensions=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.data.materials.append(material)
    if r:bevel(obj,r)
    return obj


def beam(name,a,b,r,material=wood):
    direction=Vector(b)-Vector(a)
    obj=box(name,(Vector(a)+Vector(b))/2,(r,r,direction.length),material,r*.14)
    obj.rotation_euler=direction.to_track_quat('Z','Y').to_euler()
    return obj


def tube(name,points,r,material,sides=6):
    verts=[]
    for i,p in enumerate(points):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize();u=tangent.cross(Vector((0,0,1)))
        if u.length<.01:u=tangent.cross(Vector((0,1,0)))
        u.normalize();v=tangent.cross(u).normalized()
        for j in range(sides):
            q=Vector(p)+r*(math.cos(math.tau*j/sides)*u+math.sin(math.tau*j/sides)*v)
            verts.append(q)
    faces=[]
    for i in range(len(points)-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    faces.append(tuple(range(sides-1,-1,-1)))
    faces.append(tuple((len(points)-1)*sides+j for j in range(sides)))
    return mesh(name,verts,faces,material)


def arch(x,y,z,w,h,door=False):
    # An actual arched opening face with a fully modeled voussoir surround.
    rad=w/2; spring=z+h-rad
    outline=[(x-rad,y,z),(x+rad,y,z),(x+rad,y,spring)]
    outline += [(x+rad*math.cos(math.pi*j/16),y,spring+rad*math.sin(math.pi*j/16)) for j in range(1,17)]
    obj=mesh('Arched recessed door' if door else 'Arched glass',outline,[tuple(range(len(outline)))],wood if door else glass,False)
    path=[(x-rad,y-.05,z),(x-rad,y-.05,spring)]
    path += [(x+rad*math.cos(math.pi-math.pi*j/20),y-.05,spring+rad*math.sin(math.pi*j/20)) for j in range(1,21)]
    path += [(x+rad,y-.05,z)]
    tube('Rounded arch surround',path,.095 if door else .07,trim,8)
    box('Deep sill',(x,y-.08,z),(w+.25,.22,.12),trim,.03)
    if door:
        for dx in [-.3,-.15,0,.15,.3]:
            if abs(dx)<rad-.08:box('Door board seam',(x+dx,y-.01,z+(h-rad)*.5),(.014,.014,h-rad),wood,.004)
        box('Brass handle',(x+w*.23,y-.07,z+.7),(.065,.06,.13),gold,.022)
        for dz in [.38,.95]:box('Door strap',(x,y-.025,z+dz),(w*.82,.025,.045),gold,.012)
    else:
        box('Arch keystone',(x,y-.09,z+h+.035),(.14,.14,.17),trim,.035)
        for side in [-1,1]:
            sx=x+side*(rad+.19)
            box('Celadon shutter',(sx,y-.025,z+(h-rad)*.52),(.20,.07,max(.35,h-rad-.05)),roof,.025)
            for dz in [.19,max(.29,h-rad-.18)]:
                box('Shutter strap',(sx,y-.072,z+dz),(.22,.025,.033),gold,.009)
        beam('Window mullion',(x,y-.035,z+.02),(x,y-.035,z+h-.035),.045,trim)
        beam('Window transom',(x-rad,y-.035,spring),(x+rad,y-.035,spring),.045,trim)


def side_arch(x,y,z,w,h,angle):
    before=set(bpy.context.scene.objects)
    arch(x,y,z,w,h)
    rotation=Matrix.Rotation(angle,4,'Z')
    for o in set(bpy.context.scene.objects)-before:o.matrix_world=rotation @ o.matrix_world


def roof_shape(t):
    # Concave lower slope and subtly upturned eave, with rounded ridge.
    return 1 - .91*math.sin(t*math.pi/2)**.9 + .055*t**12


def gable_roof(cx,cy,z,w,d,rise):
    half=d/2
    for side in [-1,1]:
        verts=[];faces=[]
        for i in range(9):
            x=cx-w/2+w*i/8
            for j in range(17):
                t=j/16;verts.append((x,cy+side*half*t,z+rise*roof_shape(t)))
        for i in range(8):
            for j in range(16):
                a=i*17+j;faces.append((a,a+17,a+18,a+1))
        surface=mesh('Swept roof underlay',verts,faces,roof)
        # Rounded barrel strips follow the sweep; staggered horizontal courses.
        cols=max(1,int(w/.27))
        for i in range(cols):
            x=cx-w/2+(i+.5)*w/cols
            pts=[(x,cy+side*half*j/14,z+rise*roof_shape(j/14)+.015) for j in range(15)]
            tube('Curved barrel tile',pts,.046,rooflight if i%5==0 else roof,6)
        for j in range(1,7):
            t=j/6
            tube('Tile course overlap',[(cx-w/2,cy+side*half*t,z+rise*roof_shape(t)+.025),(cx+w/2,cy+side*half*t,z+rise*roof_shape(t)+.025)],.022,rooflight,5)
    for x in [cx-w/2,cx+w/2]:
        pts=[(x,cy-half*t,z+rise*roof_shape(abs(t))-.045) for t in [i/16 for i in range(-16,17)]]
        tube('Carved sweeping verge',pts,.095,trim,8)
    for side in [-1,1]:
        tube('Eave cornice',[(cx-w/2,cy+side*half,z+rise*roof_shape(1)-.06),(cx+w/2,cy+side*half,z+rise*roof_shape(1)-.06)],.085,wood,8)
    tube('Glazed roof ridge',[(cx-w/2-.1,cy,z+rise+.1),(cx-w/2+.18,cy,z+rise+.065),(cx+w/2-.18,cy,z+rise+.065),(cx+w/2+.1,cy,z+rise+.1)],.105,rooflight,10)


def gable_wall(x,y,z,d,rise):
    # End wall tucked inside curved roof.
    vs=[(x,y-d/2,z),(x,y+d/2,z)]
    vs += [(x,y+d/2*t,z+rise*roof_shape(abs(t))) for t in [1-i/12 for i in range(25)]]
    mesh('Curved plaster gable',vs,[tuple(range(len(vs)))],stone,False)


def body(w,d,h):
    box('Soft plaster volume',(0,0,h/2+.12),(w,d,h),stone,.14)
    box('Masonry footing',(0,0,.18),(w+.14,d+.14,.36),trim,.07)
    for x in [-w/2+.055,w/2-.055]:
        for j in range(3):
            box('Corner limestone quoin',(x,-d/2-.07,.47+j*.30),(.36 if j%2==0 else .26,.15,.22),trim,.035)
    for x in [-w/2+.06,w/2-.06]:
        for y in [-d/2-.015,d/2+.015]:
            box('Corner timber',(x,y,h/2+.15),(.19,.18,h+.05),wood,.028)
            for z in [.35,h-.25]:box('Carved post collar',(x,y,z),(.25,.24,.11),trim,.028)
    for y in [-d/2-.025,d/2+.025]:
        box('Timber plate',(0,y,h-.08),(w+.2,.20,.20),wood,.04)
    for x in [-w/2-.025,w/2+.025]:
        box('End plate',(x,0,h-.08),(.2,d,.2),wood,.035)


def planter(x,y,z,w=1.1):
    box('Window garden',(x,y,z),(w,.36,.25),wood,.045)
    for dx in [-w*.35,w*.35]:box('Planter band',(x+dx,y-.19,z),(.06,.035,.28),gold,.01)
    for i in range(7):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=.18,location=(x-w*.4+w*.8*i/6,y,z+.18+random.random()*.07))
        o=bpy.context.object;o.scale=(1,1,.7);o.data.materials.append(leafmat)
        for p in o.data.polygons:p.use_smooth=True


def inn():
    body(7.6,4.6,3.70)
    for y in [-2.33,2.33]:box('Upper story belt',(0,y,2.12),(7.8,.2,.2),wood,.04)
    for x in [-2.65,0,2.65]:
        arch(x,-2.335,2.37,.78,1.03)
        if x:planter(x,-2.57,2.28)
    arch(0,-2.335,.25,1.23,1.73,True)
    for x in [-2.62,2.62]:arch(x,-2.335,.6,1.02,1.12)
    for x in [-1.35,1.35]:
        box('Facade upright',(x,-2.33,2.9),(.15,.14,1.45),wood,.025)
        beam('Diagonal brace',(x,-2.35,2.23),(x+(.75 if x<0 else -.75),-2.35,2.95),.12)
    for side in [-1,1]:
        for x in [-1.15,1.15]:
            side_arch(x,-3.815,.65,.85,1.05,side*math.pi/2)
            side_arch(x,-3.815,2.4,.73,1.0,side*math.pi/2)
        box('End story belt',(side*3.815,0,2.12),(.18,4.6,.2),wood,.035)
        beam('Gable timber',(side*3.805,0,3.7),(side*3.805,0,4.87),.13)
    gable_roof(0,0,3.7,8.2,5.25,1.35)
    for x in [-3.78,3.78]:gable_wall(x,0,3.7,4.58,1.29)
    # Modest carved entrance canopy and footstones.
    gable_roof(0,-2.45,1.91,1.9,1.5,.43)
    for x in [-.79,.79]:beam('Canopy brace',(x,-2.38,1.51),(x,-2.9,1.98),.11)
    box('Threshold',(0,-2.57,.12),(1.8,.7,.20),trim,.06)
    box('Chimney',(2.35,.55,4.85),(.65,.72,1.2),stone,.055)
    box('Chimney crown',(2.35,.55,5.44),(.83,.88,.18),trim,.04)
    for z in [4.6,4.9,5.2]:box('Chimney masonry',(2.35,.55,z),(.69,.76,.035),trim,.012)


def shop():
    body(5.65,3.65,2.47)
    for side in [-1,1]:
        side_arch(0,-2.84,.72,.97,1.25,side*math.pi/2)
        beam('Gable timber',(side*2.83,0,2.47),(side*2.83,0,3.6),.12)
    gable_roof(0,0,2.47,6.25,4.2,1.25)
    for x in [-2.81,2.81]:gable_wall(x,0,2.47,3.6,1.18)
    arch(-1.61,-1.85,.18,1.05,1.8,True)
    for x in [.2,1.65]:arch(x,-1.85,.62,1.02,1.13)
    planter(.85,-2.10,.57,2.6)
    # Front awning uses the same sculpted roof language.
    gable_roof(.8,-1.70,2.14,3.25,1.65,.34)
    for x in [-.58,2.18]:beam('Awning bracket',(x,-1.87,1.62),(x,-2.42,2.16),.10)
    # Small merchant sign with brass inset.
    beam('Hanging sign arm',(-2.55,-1.9,2.20),(-2.55,-2.48,2.20),.065)
    box('Shop plaque',(-2.55,-2.4,1.91),(.48,.08,.38),wood,.06)
    box('Plaque inlay',(-2.55,-2.447,1.91),(.29,.025,.22),gold,.035)


def tower_roof(z,w,rise):
    # Four concave curved roof planes, broad eaves, authored ridges.
    n=16; half=w/2
    for side in range(4):
        a=side*math.pi/2
        def transform(x,y,height):return (x*math.cos(a)-y*math.sin(a),x*math.sin(a)+y*math.cos(a),height)
        verts=[];faces=[]
        for j in range(n+1):
            t=j/n;span=max(.025,half*t)
            for i in range(9):verts.append(transform(-span+2*span*i/8,half*t,z+rise*roof_shape(t)))
        for j in range(n):
            for i in range(8):
                k=j*9+i;faces.append((k,k+1,k+10,k+9))
        mesh('Bell tower swept roof',verts,faces,roof)
        for i in range(15):
            f=-1+2*(i+.5)/15
            pts=[transform(f*half*t,half*t,z+rise*roof_shape(t)+.02) for t in [.09+j*.91/15 for j in range(16)]]
            tube('Tower barrel tile',pts,.033,rooflight if i%4==0 else roof,6)
        for j in range(2,9):
            t=j/8
            tube('Tower tile course',[transform(-half*t,half*t,z+rise*roof_shape(t)+.02),transform(half*t,half*t,z+rise*roof_shape(t)+.02)],.022,rooflight,5)
        pts=[transform(half*t,half*t,z+rise*roof_shape(t)) for t in [j/16 for j in range(17)]]
        tube('Raised hip ridge',pts,.075,rooflight,8)
        tube('Tower eave carving',[transform(-half,half,z+rise*roof_shape(1)-.06),transform(half,half,z+rise*roof_shape(1)-.06)],.09,trim,8)


def tower():
    body(3.55,3.55,6.57)
    # Stone plinth courses and flared balcony beneath the belfry.
    for z in [.45,.75]:
        for x in [-1.22,1.22]:box('Front plinth course',(x,-1.80,z),(1.20,.16,.13),trim,.045)
        box('Back plinth course',(0,1.8,z),(3.65,.16,.13),trim,.045)
        for x in [-1.80,1.80]:box('Side plinth course',(x,0,z),(.16,3.65,.13),trim,.045)
    for z,w in [(4.83,3.69),(5.0,3.88),(5.15,4.02),(6.62,3.83)]:box('Tower molded cornice',(0,0,z),(w,w,.15),trim,.05)
    arch(0,-1.80,.25,1.18,1.96,True)
    arch(0,-1.80,2.9,.76,1.52)
    for x in [-1.07,1.07]:arch(x,-1.80,5.36,.60,1.10)
    for angle in [math.pi/2,math.pi,3*math.pi/2]:
        for x in [-1.07,1.07]:side_arch(x,-1.80,5.36,.60,1.10,angle)
        side_arch(0,-1.80,2.9,.76,1.52,angle)
    tower_roof(6.64,4.45,2.12)
    tube('Tower finial',[(0,0,8.69),(0,0,8.93),(0,0,9.10)],.047,gold,8)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,radius=.13,location=(0,0,8.91))
    bpy.context.object.data.materials.append(gold)


def export(name):
    for material in materials:
        obs=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.materials and o.data.materials[0]==material]
        if not obs:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in obs:o.select_set(True)
        bpy.context.view_layer.objects.active=obs[0]
        if len(obs)>1:bpy.ops.object.join()
        obs[0].name=material.name
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',export_yup=True,export_animations=False,export_cameras=False,export_lights=False,export_texcoords=False)
    verts=[o.matrix_world@v.co for o in bpy.context.scene.objects if o.type=='MESH' for v in o.data.vertices]
    print('ASSET',name,'bytes',(OUT/(name+'.glb')).stat().st_size,'vertices',len(verts),'bounds',[(round(min(v[i] for v in verts),3),round(max(v[i] for v in verts),3)) for i in range(3)])


def render(name):
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(mat('Studio',(.25,.30,.28)))
    bpy.ops.object.camera_add(location=(11,-15,10))
    cam=bpy.context.object;target=Vector((0,0,3.6 if name=='tower' else 2.1))
    cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type='ORTHO';cam.data.ortho_scale=11 if name=='tower' else 10.5
    scene=bpy.context.scene;scene.camera=cam
    for loc,power,size in [((2,-5,12),1800,8),((-7,-3,7),900,7)]:
        bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
    scene.render.engine='CYCLES';scene.cycles.samples=16
    scene.render.resolution_x=900;scene.render.resolution_y=900;scene.render.resolution_percentage=100
    scene.world.color=(.3,.3,.3);scene.render.filepath='/tmp/tempest-'+name+'.png'
    bpy.ops.render.render(write_still=True)

for name,build in [('inn',inn),('shop',shop),('tower',tower)]:
    reset();build();export(name);render(name)
