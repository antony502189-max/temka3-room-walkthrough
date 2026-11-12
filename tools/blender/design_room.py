"""Create room 3 from the unmodified temka2 source; coordinates below use glTF Y-up.
Run Blender with source/temka2.blend open and --python this_file.
All new decor lies against walls; coves are above the 1.8 m collision slab.
"""
from pathlib import Path
import bpy, math, json, hashlib
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT/'source/temka2.blend'
before = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
collection = bpy.data.collections.new('Room 3 • murals and indirect light')
bpy.context.scene.collection.children.link(collection)
def coord(x,y,z): return (x,-z,y)
def move_collection(obj):
    for c in list(obj.users_collection): c.objects.unlink(obj)
    collection.objects.link(obj)
def material(name,color,emission=0):
    m=bpy.data.materials.new(name);m.use_nodes=True
    b=m.node_tree.nodes.get('Principled BSDF'); b.inputs['Base Color'].default_value=(*color,1)
    b.inputs['Roughness'].default_value=.8
    if emission:
        b.inputs['Emission Color'].default_value=(*color,1); b.inputs['Emission Strength'].default_value=emission
    return m
def cube(name,center,size,mat):
    bpy.ops.mesh.primitive_cube_add(size=1,location=coord(*center));o=bpy.context.object;o.name=name
    o.dimensions=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat);move_collection(o);return o
def image_material(name,file):
    m=material(name,(1,1,1));b=m.node_tree.nodes.get('Principled BSDF')
    tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(file),check_existing=True)
    tex.image.pack();m.node_tree.links.new(tex.outputs['Color'],b.inputs['Base Color'])
    b.inputs['Specular IOR Level'].default_value=0
    b.inputs['Roughness'].default_value=1
    return m
def panel(name,x,z0,z1,y0,y1,mat,normal=1,uv=None):
    # Positive normal: viewer on +X, left wall. UV direction follows viewer's right.
    zs=[z1,z0] if normal==1 else [z0,z1]
    verts=[coord(x,y0,zs[0]),coord(x,y0,zs[1]),coord(x,y1,zs[1]),coord(x,y1,zs[0])]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],[(0,1,2,3)]);mesh.update()
    layer=mesh.uv_layers.new(name='UVMap');coords=uv or [(0,0),(1,0),(1,1),(0,1)]
    for loop in mesh.loops:layer.data[loop.index].uv=coords[loop.vertex_index]
    ob=bpy.data.objects.new(name,mesh);collection.objects.link(ob);ob.data.materials.append(mat)
    return ob

flax=image_material('Mural • flax',ROOT/'assets/flax.png')
landscape=image_material('Mural • wetland',ROOT/'assets/landscape.png')
memories=image_material('Mural • memories interpretation',ROOT/'assets/memories.png')
panel('Mural_Flax',2.738,.30,5.63,.095,1.94,flax)
panel('Mural_Landscape',2.800,9.27,14.16,.095,1.845,landscape)
panel('Mural_Memories',8.942,9.33,13.88,.095,1.82,memories,normal=-1)

# Original reference document pixels are mapped onto five separate planes.
# No invented document text or coat of arms is substituted.
documents=image_material('Reference • original five documents',ROOT/'references/reference-2.jpg')
frame=material('Frames • walnut',(.105,.060,.032))
for i,(left,right) in enumerate([(414,489),(504,585),(603,685),(704,779),(801,871)]):
    center=12.85-i*.55
    cube('Document_Frame_%02d'%i,(2.823,1.47,center),(.038,.67,.49),frame)
    uv=[(left/1280,1-327/743),(right/1280,1-327/743),(right/1280,1-223/743),(left/1280,1-223/743)]
    panel('Document_Print_%02d'%i,2.845,center-.217,center+.217,1.16,1.78,documents,uv=uv)

profile=material('Cove • warm plaster',(.73,.70,.60))
led=material('LED • warm 3000K', (1,.71,.37),5)
# x and z endpoints follow the main room perimeter inside the stepped ceiling.
segments=[(3.32,.38,3.32,5.65),(3.32,5.76,3.32,9.10),(3.32,9.23,3.32,13.50),
          (8.83,.38,8.83,6.10),(7.53,6.30,7.53,8.75),(8.82,9.00,8.82,13.50),
          (3.40,.30,8.72,.30),(3.40,13.49,8.72,13.49)]
for i,(x0,z0,x1,z1) in enumerate(segments):
    along_x=abs(x1-x0)>.01;length=math.hypot(x1-x0,z1-z0);cx=(x0+x1)/2;cz=(z0+z1)/2
    size=(length,.035,.105) if along_x else (.105,.035,length)
    cube('Cove_Profile_%02d'%i,(cx,2.105,cz),size,profile)
    size=(length-.04,.009,.025) if along_x else (.025,.009,length-.04)
    cube('LED_Cove_%02d'%i,(cx,2.129,cz),size,led)
    light=bpy.data.lights.new('Indirect_LED_%02d'%i,'AREA');light.energy=length*12;light.color=(1,.80,.56)
    light.shape='RECTANGLE';light.size=length-.06;light.size_y=.04
    obj=bpy.data.objects.new(light.name,light);collection.objects.link(obj);obj.location=coord(cx,2.14,cz)
    obj.rotation_euler=(math.pi,0,math.pi/2 if not along_x else 0)

# A physical warm fairy-light strand runs above the photo display.
cord=material('Photo garland • cable',(.18,.13,.07))
points=[]
for i in range(49):
    t=i/48;points.append((8.915,1.50+.10*(2*t-1)**2,9.60+t*4.0))
curve=bpy.data.curves.new('Photo string','CURVE');curve.dimensions='3D';curve.bevel_depth=.0025;curve.bevel_resolution=2
spline=curve.splines.new('POLY');spline.points.add(len(points)-1)
for p,xyz in zip(spline.points,points):p.co=(*coord(*xyz),1)
ob=bpy.data.objects.new('Garland_Cord',curve);collection.objects.link(ob);ob.data.materials.append(cord)
for i in range(13):
    t=i/12;y=1.50+.10*(2*t-1)**2;z=9.60+t*4
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=.012,location=coord(8.90,y,z))
    ob=bpy.context.object;ob.name='LED_Garland_%02d'%i;ob.data.materials.append(led);move_collection(ob)

# Use the same soft ceiling finish in Blender and in the web viewer.
ceiling=bpy.data.objects.get('Plane')
if ceiling:
    ceiling.data.materials.clear();ceiling.data.materials.append(material('Ceiling • ivory',(.79,.77,.70)))

scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=64
scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.45
for name in ['Cube.029','Cube.003','Plane.009','Plane.010']:
    bpy.data.objects[name].hide_render=True;bpy.data.objects[name].hide_set(True)
scene['design_note']='Room 3: reference-inspired murals, original document images, 3000K upper coves. Source temka2 untouched.'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'source/room3-designed.blend'))
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==before
(ROOT/'assets/design-layout.json').write_text(json.dumps({'source_sha256':before,'segments':segments,'led_height':2.129,'light_height':2.14,'ceiling_height':2.2545,'temperature_kelvin':3000,'murals':['Mural_Flax','Mural_Landscape','Mural_Memories'],'original_document_count':5,'note':'Murals re-created from references using image_gen; small gallery photos are illustrative interpretations, not archival originals.'},indent=2))
print('SAVED room3-designed.blend; original source unchanged')
