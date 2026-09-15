"""Original stylized courtyard architecture, authored from curved mesh profiles.
Run Blender --background --python scripts/build_courtyard_architecture.py.
Use -- --render --compress for previews and the shipped Meshopt encoding.
Front is Blender -Y, exported +Z. Each asset is centered and grounded.
"""
import bpy
import math
import random
import sys
import subprocess
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

stone=mat('Warm limewashed plaster',(.86,.80,.67))
trim=mat('Carved pale limestone',(.84,.81,.69))
wood=mat('Weathered walnut beams',(.15,.115,.087))
roof=mat('Warm terracotta roof tiles',(.48,.19,.115),.82)
rooflight=mat('Sunlit clay tile edges',(.67,.30,.18),.80)
glass=mat('Dusky blue window',(.06,.145,.18),.22,.12)
gold=mat('Warm brass accents',(.56,.34,.105),.32,.6)
leafmat=mat('Garden foliage',(.16,.34,.085))
shutter=mat('Painted teal shutters',(.07,.27,.25))
cloth=mat('Avelune blue linen',(.06,.19,.38))
petal=mat('Buttercream garden flowers',(.98,.80,.35))
materials=[stone,trim,wood,roof,rooflight,glass,gold,leafmat,shutter,cloth,petal]


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


def bevel(obj,width=.025):
    bpy.context.view_layer.objects.active=obj
    mod=obj.modifiers.new('Soft crafted edges','BEVEL');mod.width=width;mod.segments=2
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod=obj.modifiers.new('Face normals','WEIGHTED_NORMAL');mod.keep_sharp=True;mod.weight=40
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name,loc,scale,material=stone,r=.025):
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
            box('Celadon shutter',(sx,y-.025,z+(h-rad)*.52),(.20,.07,max(.35,h-rad-.05)),shutter,.025)
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
    # Steep, almost planar slate pitches with a restrained kicked eave.
    # Preserve ridge and eave elevations used by the surrounding gable walls.
    return 1 - .90*t + .045*t**8


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
        # Staggered clay tiles with raised lower lips catch directional light.
        tileverts=[];tilefaces=[]
        columns=max(1,int(w/.36))
        for row in range(9):
            t0=row/9;t1=(row+1)/9
            for col in range(columns):
                left=cx-w/2+(col+(row%2)*.45)*w/columns
                right=min(cx+w/2,left+w/columns-.018)
                if right<=left:continue
                k=len(tileverts)
                for tx,t,lip in [(left,t0,.025),(right,t0,.025),(right,t1,.060),(left,t1,.060)]:
                    tileverts.append((tx,cy+side*half*t,z+rise*roof_shape(t)+lip))
                tilefaces.append((k,k+1,k+2,k+3))
        mesh('Overlapping staggered clay tiles',tileverts,tilefaces,rooflight,False)
        # Fine joints articulate the tile courses at a distance.
        cols=max(1,int(w/.27))
        for i in range(cols):
            x=cx-w/2+(i+.5)*w/cols
            pts=[(x,cy+side*half*j/14,z+rise*roof_shape(j/14)+.015) for j in range(15)]
            tube('Fine slate standing seam',pts,.014,rooflight if i%5==0 else roof,5)
        for j in range(1,7):
            t=j/6
            tube('Tile course overlap',[(cx-w/2,cy+side*half*t,z+rise*roof_shape(t)+.025),(cx+w/2,cy+side*half*t,z+rise*roof_shape(t)+.025)],.012,rooflight,5)
    for x in [cx-w/2,cx+w/2]:
        pts=[(x,cy-half*t,z+rise*roof_shape(abs(t))-.045) for t in [i/16 for i in range(-16,17)]]
        tube('Carved sweeping verge',pts,.055,trim,6)
    for side in [-1,1]:
        tube('Eave cornice',[(cx-w/2,cy+side*half,z+rise*roof_shape(1)-.06),(cx+w/2,cy+side*half,z+rise*roof_shape(1)-.06)],.055,wood,6)
    tube('Glazed roof ridge',[(cx-w/2-.1,cy,z+rise+.1),(cx-w/2+.18,cy,z+rise+.065),(cx+w/2-.18,cy,z+rise+.065),(cx+w/2+.1,cy,z+rise+.1)],.060,rooflight,6)


def gable_wall(x,y,z,d,rise):
    # End wall tucked inside curved roof.
    vs=[(x,y-d/2,z),(x,y+d/2,z)]
    vs += [(x,y+d/2*t,z+rise*roof_shape(abs(t))) for t in [1-i/12 for i in range(25)]]
    mesh('Curved plaster gable',vs,[tuple(range(len(vs)))],stone,False)


def body(w,d,h):
    box('Crisp plaster volume',(0,0,h/2+.12),(w,d,h),stone,.035)
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
    for i in range(22):
        cx=x-w*.44+w*.88*i/21
        cy=y+random.uniform(-.12,.12)
        height=.15+random.random()*.18
        if i%3==0:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=.065,location=(cx,cy-.05,z+height+.05))
            bpy.context.object.name='Small garden blossom'
            bpy.context.object.scale=(1,1,.55)
            bpy.context.object.data.materials.append(petal)
        for side in [-1,1]:
            mesh('Trailing garden leaf',[(cx,cy,z+.11),(cx+side*.11,cy-.10,z+height),
                 (cx+side*.23,cy-.22,z+height-.07),(cx+side*.09,cy-.16,z+height-.02)],
                 [(0,1,3),(1,2,3)],leafmat,False)


def ivy(x,y,z,width=1.0,height=2.0):
    verts=[];faces=[]
    for strand in range(7):
        sx=x+(strand/6-.5)*width
        length=height*(.65+random.random()*.35)
        points=[]
        for j in range(14):
            t=j/13
            px=sx+.09*math.sin(t*10+strand);pz=z-t*length
            points.append((px,y,pz))
            for side in [-1,1]:
                size=random.uniform(.065,.135)
                k=len(verts)
                verts.extend([(px,y-.025,pz),(px+side*size,y-.055,pz+size*.5),
                              (px+side*size*1.7,y-.04,pz-size*.25),(px+side*size*.7,y-.085,pz-size*.8)])
                faces.extend([(k,k+1,k+3),(k+1,k+2,k+3)])
        tube('Climbing ivy stems',points,.012,leafmat,4)
    mesh('Individual ivy leaves',verts,faces,leafmat,False)


def banner(x,y,z,height=1.45):
    beam('Banner wall bracket',(x,y+.18,z+.1),(x,y-.17,z+.1),.045,gold)
    beam('Banner crossbar',(x-.32,y-.17,z),(x+.32,y-.17,z),.04,gold)
    verts=[]
    for j in range(9):
        t=j/8
        for side in [-1,1]:
            verts.append((x+side*.27,y-.17-.06*math.sin(t*7),z-height*t+(.15 if j==8 else 0)))
    verts.append((x,y-.17-.06*math.sin(7),z-height))
    faces=[(j*2,j*2+1,j*2+3,j*2+2) for j in range(8)]+[(16,17,18)]
    mesh('Blue village banner',verts,faces,cloth,False)
    # A simple original diamond emblem.
    mesh('Banner ivory emblem',[(x,y-.25,z-.35),(x+.10,y-.25,z-.57),
          (x,y-.25,z-.84),(x-.10,y-.25,z-.57)],[(0,1,2,3)],trim,False)


def balcony(x,y,z,w=1.3):
    box('Balcony carved ledge',(x,y-.19,z),(w,.62,.13),wood,.025)
    box('Balcony handrail',(x,y-.48,z+.48),(w+.08,.07,.075),wood,.016)
    for j in range(7):
        dx=(j/6-.5)*w
        beam('Balcony spindle',(x+dx,y-.48,z+.06),(x+dx,y-.48,z+.47),.035)
    for side in [-1,1]:
        beam('Balcony support',(x+side*w*.35,y+.1,z-.45),(x+side*w*.35,y-.4,z-.02),.08)


def dormer(cx):
    # Small perpendicular gables add a lived-in roof silhouette without changing
    # the building's authored ground footprint or main ridge height.
    y=-1.35; base=4.08; height=.33; rise=.60
    box('Dormer plaster',(cx,y,base+height/2),(1.12,.90,height),stone,.025)
    mesh('Dormer front gable',[(cx-.56,y-.46,base+height),
         (cx+.56,y-.46,base+height),(cx,y-.46,base+height+rise)],[(0,1,2)],stone,False)
    arch(cx,y-.475,base+.035,.37,.53)
    before=set(bpy.context.scene.objects)
    gable_roof(0,0,base+height,1.10,1.35,rise)
    transform=Matrix.Translation((cx,y,0)) @ Matrix.Rotation(math.pi/2,4,'Z')
    for obj in set(bpy.context.scene.objects)-before:obj.matrix_world=transform @ obj.matrix_world
    for side in [-1,1]:
        beam('Dormer bargeboard',(cx+side*.60,y-.51,base+height+.05),
             (cx,y-.51,base+height+rise+.035),.065,wood)


def gable_truss(x,z,depth,rise):
    for side in [-1,1]:
        beam('Gable diagonal framing',(x,side*depth*.44,z+.18),
             (x,0,z+rise*.89),.085,wood)
    beam('Gable tie beam',(x,-depth*.44,z+.18),(x,depth*.44,z+.18),.095,wood)


def inn():
    body(7.6,4.6,3.70)
    for y in [-2.33,2.33]:box('Upper story belt',(0,y,2.12),(7.8,.2,.2),wood,.04)
    for x in [-2.65,0,2.65]:
        arch(x,-2.335,2.37,.78,1.03)
        if x:planter(x,-2.57,2.28)
    balcony(0,-2.35,2.16)
    ivy(-3.32,-2.46,3.62,.7,2.9)
    ivy(3.1,-2.46,3.56,.8,1.1)
    banner(1.4,-2.4,3.47,1.35)
    for x in [-2.65,0,2.65]:
        side_arch(x,-2.335,2.37,.78,1.03,math.pi)
        side_arch(x,-2.335,.6,1.02,1.12,math.pi)
    arch(0,-2.335,.25,1.23,1.73,True)
    for x in [-2.62,2.62]:arch(x,-2.335,.6,1.02,1.12)
    for x in [-1.35,1.35]:
        box('Facade upright',(x,-2.33,2.9),(.15,.14,1.45),wood,.025)
        beam('Diagonal brace',(x,-2.35,2.23),(x+(.75 if x<0 else -.75),-2.35,2.95),.12)
    for side in [-1,1]:
        for x in [-1.15,1.15]:
            side_arch(x,-3.815,.65,.85,1.05,side*math.pi/2)
            side_arch(x,-3.815,2.4,.73,1.0,side*math.pi/2)
        for y in [-.1]:
            beam('Side facade diagonal',(side*3.825,y-.50,2.3),(side*3.825,y,3.5),.14)
            beam('Side facade diagonal',(side*3.825,y,3.5),(side*3.825,y+.50,2.3),.14)
        box('End story belt',(side*3.815,0,2.12),(.18,4.6,.2),wood,.035)
        beam('Gable timber',(side*3.805,0,3.7),(side*3.805,0,4.87),.13)
    gable_roof(0,0,3.7,8.2,5.25,1.35)
    for x in [-3.78,3.78]:
        gable_wall(x,0,3.7,4.58,1.29)
        gable_truss(x+math.copysign(.03,x),3.7,4.58,1.29)
    for x in [-2.20,2.20]:dormer(x)
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
    for x in [-2.81,2.81]:
        gable_wall(x,0,2.47,3.6,1.18)
        gable_truss(x+math.copysign(.03,x),2.47,3.6,1.18)
    arch(-1.61,-1.85,.18,1.05,1.8,True)
    for x in [.2,1.65]:arch(x,-1.85,.62,1.02,1.13)
    planter(.85,-2.10,.57,2.6)
    ivy(2.48,-1.96,2.35,.5,1.55)
    for x in [-1.2,1.2]:side_arch(x,-1.85,.65,.9,1.12,math.pi)
    for x in [-.8,2.65]:beam('Merchant facade timber',(x,-1.90,.3),(x,-1.90,2.35),.13)
    banner(-.82,-1.96,2.23,.96)
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
            tube('Tower slate seam',pts,.012,rooflight if i%4==0 else roof,5)
        for j in range(2,9):
            t=j/8
            tube('Tower tile course',[transform(-half*t,half*t,z+rise*roof_shape(t)+.02),transform(half*t,half*t,z+rise*roof_shape(t)+.02)],.012,rooflight,5)
        pts=[transform(half*t,half*t,z+rise*roof_shape(t)) for t in [j/16 for j in range(17)]]
        tube('Raised hip ridge',pts,.045,rooflight,6)
        tube('Tower eave carving',[transform(-half,half,z+rise*roof_shape(1)-.06),transform(half,half,z+rise*roof_shape(1)-.06)],.055,trim,6)


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
    banner(-1.22,-1.92,4.64,1.9)
    ivy(1.34,-1.90,2.75,.65,2.3)
    tower_roof(6.64,4.45,2.12)
    tube('Tower finial',[(0,0,8.69),(0,0,8.93),(0,0,9.10)],.047,gold,8)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,radius=.13,location=(0,0,8.91))
    bpy.context.object.data.materials.append(gold)


def paint_surfaces():
    # COLOR_0 bakes the material base plus restrained cool shade at the
    # footing and sun-bleached variation above, without runtime texture requests.
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.data.materials:continue
        material=obj.data.materials[0]
        if material not in [stone,trim,wood,roof,rooflight]:continue
        colors=obj.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='POINT')
        for vertex,attr in zip(obj.data.vertices,colors.data):
            world=obj.matrix_world @ vertex.co
            low=max(0,1-world.z/1.4)
            variation=.015*math.sin(world.x*3.7+world.z*4.1)*math.cos(world.y*3.1)
            gains=(.98-low*.10+variation,.99-low*.07+variation,1-low*.015+variation)
            attr.color=tuple(material.diffuse_color[i]*gains[i] for i in range(3))+(1,)
    for material in [stone,trim,wood,roof,rooflight]:
        nodes=material.node_tree.nodes; links=material.node_tree.links
        vertex=nodes.new('ShaderNodeVertexColor');vertex.layer_name='Color'
        links.new(vertex.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])


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
    if '--compress' in sys.argv:
        path=str(OUT/(name+'.glb'))
        subprocess.run(['npx','--yes','@gltf-transform/cli@4.4.1','meshopt',path,path],check=True)
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
    scene.world.color=(.3,.3,.3);scene.render.filepath='/tmp/avelune-'+name+'.png'
    bpy.ops.render.render(write_still=True)

for name,build in [('inn',inn),('shop',shop),('tower',tower)]:
    reset();build();paint_surfaces();export(name)
    if '--render' in sys.argv:render(name)
