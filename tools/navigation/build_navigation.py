"""Build conservative flat-floor player-center navigation from evaluated geometry."""
import argparse
import json
from pathlib import Path
import math
import time

import numpy as np
from shapely.geometry import Polygon, LineString, Point, MultiPoint, GeometryCollection
from shapely.ops import unary_union
import shapely
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', required=True)
parser.add_argument('--output-dir', required=True)
args = parser.parse_args()
root = Path(args.output_dir)
root.mkdir(parents=True, exist_ok=True)
raw = json.loads(Path(args.input).read_text())
radius = 0.22
safety = 0.008

def flatten_polygons(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == 'Polygon':
        return [geom]
    return [p for g in getattr(geom, 'geoms', []) for p in flatten_polygons(g)]

floor = unary_union([Polygon(t) for t in raw['floor_triangles']]).buffer(0)
object_geometries = {}
for obj in raw['obstacle_projections']:
    areas = []
    lines = []
    for coordinates in obj['projections']:
        # Triangles clipping to a standing-height slab may collapse to a wall
        # segment. Such lines must still block the circular player's footprint.
        hull = MultiPoint(coordinates).convex_hull
        if hull.is_empty:
            continue
        if hull.geom_type == 'Polygon' and hull.area > 1e-11:
            areas.append(hull)
        elif hull.geom_type in ('LineString', 'Point'):
            lines.append(hull)
        else:
            lines.append(LineString(coordinates))
    geometry = unary_union(areas + lines)
    object_geometries[obj['name']] = geometry
    print('Projected',obj['name'],geometry.geom_type,round(geometry.area,6),flush=True)

obstacles = unary_union(list(object_geometries.values()))
obstacle_clearance = obstacles.buffer(radius + safety, quad_segs=4)
walkable = floor.buffer(-(radius + safety), quad_segs=4).difference(obstacle_clearance)
components = sorted((p for p in flatten_polygons(walkable) if p.area > 0.04), key=lambda p:p.area, reverse=True)
if not components:
    raise RuntimeError('No safe walking region')
main = components[0]

def ring(coords):
    return [[round(float(x),6),round(float(z),6)] for x,z in coords]

def polygon_data(poly):
    return {'outer':ring(poly.exterior.coords), 'holes':[ring(i.coords) for i in poly.interiors], 'area':round(poly.area,6)}

# A dense candidate grid ensures chosen viewpoints have additional clearance
# inside the already inflated walk region. Picks are refined after visual map.
x0,z0,x1,z1 = main.bounds
samples=[]
for z in np.arange(z0+0.05,z1,0.1):
    for x in np.arange(x0+0.05,x1,0.1):
        p=Point(x,z)
        if main.contains(p):
            samples.append((float(x),float(z),p.distance(main.boundary)))

def safe_near(target):
    # Prefer at least 0.30 m extra free space, then nearest requested view.
    usable=[s for s in samples if s[2]>=0.30] or samples
    return min(usable,key=lambda s:(s[0]-target[0])**2+(s[1]-target[1])**2)

requests=[
    ('entrance','Начало комнаты',(6.25,12.7),(6.25,2.0)),
    ('middle','Центр',(5.6,7.0),(6.3,1.0)),
    ('far_end','У окна',(6.2,1.65),(6.2,12.7)),
    ('side','Двери и детали',(6.0,7.8),(7.65,7.4)),
]
views=[]
for ident,label,target,look in requests:
    x,z,clearance=safe_near(target)
    dx,dz=look[0]-x,look[1]-z
    # Three camera forward = [-sin(yaw),0,-cos(yaw)] with YXZ Euler.
    yaw=math.atan2(-dx,-dz)
    views.append({'id':ident,'label':label,'position':[round(x,5),1.62,round(z,5)],
                  'yaw':round(yaw,7),'pitch':0.0,'extra_clearance_m':round(clearance,4)})

data={
 'schema':1,
 'coordinate_system':'glTF/Three.js: Y up, [x,z] ground-plane rings',
 'source_coordinate_transform':'Blender [x,y,z] -> glTF [x,z,-y]; already applied',
 'floor_height':0.0,'eye_height':1.62,'body_height':1.80,
 'player_radius':radius,'collision_safety_margin':safety,
 'movement_model':'player center constrained to exact floor eroded by radius; all standing-height mesh projections dilated by radius',
 'movement_max_substep':0.035,
 'floor': [polygon_data(p) for p in flatten_polygons(floor)],
 'walkable': [polygon_data(main)],
 'other_walkable_components': [polygon_data(p) for p in components[1:]],
 'spawn':views[0], 'viewpoints':views,
 'bounds':{'min':[x0,0.0,z0],'max':[x1,2.29,z1]},
 'source_sha256':raw['source_sha256'],
 'excluded_static_duplicates':raw['excluded_static_duplicates'],
 'closed_doors_are_obstacles':True,
 'note':'Static flat-floor navigation only. No stairs/jumping/opening modeled closed doors.',
}
(root/'navigation.json').write_text(json.dumps(data,separators=(',',':'),ensure_ascii=False))
report={
 'source_unchanged':raw['source_unchanged'],
 'source_sha256':raw['source_sha256'],
 'method':data['movement_model'],
 'shapely_version':shapely.__version__,
 'source_objects':raw['objects'],
 'floor_area_m2':floor.area,'walkable_component_areas_m2':[p.area for p in components],
 'all_components_valid':all(p.is_valid for p in components),
 'floor_is_valid':floor.is_valid,
 'vertices_in_main_outer':len(main.exterior.coords),
 'holes_in_main':len(main.interiors),
 'body_height_interval':raw['body_height_interval_source_z'],
 'player_radius_m':radius,'safety_margin_m':safety,
 'viewpoints':views,
 'viewpoint_checks': [{'id':v['id'],'inside_main':main.contains(Point(v['position'][0],v['position'][2]))} for v in views],
 'browser_controls_tested':False,
}
(root/'navigation_report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))

fig,ax=plt.subplots(figsize=(8,14),dpi=130)
for p in flatten_polygons(floor):
    xx,zz=p.exterior.xy; ax.fill(xx,zz,color='#e6dfd5',label='Source floor')
for geometry in object_geometries.values():
    clipped=geometry.buffer(.012).intersection(floor.buffer(.15))
    for p in flatten_polygons(clipped):
        xx,zz=p.exterior.xy;ax.fill(xx,zz,color='#554c45',alpha=.8)
for i,p in enumerate(components):
    xx,zz=p.exterior.xy;ax.fill(xx,zz,color='#81c4ad' if i==0 else '#d7958f',alpha=.7)
    for h in p.interiors:
        xx,zz=h.xy;ax.fill(xx,zz,color='#d9c4ad')
for v in views:
    x,_,z=v['position']; ax.plot(x,z,'o',color='#1c5570',ms=8)
    yaw=v['yaw']; ax.arrow(x,z,-math.sin(yaw)*.7,-math.cos(yaw)*.7,width=.035,color='#1c5570')
    ax.text(x+.1,z+.13,v['id'],fontsize=10,color='#172f3b')
ax.set_aspect('equal'); ax.grid(alpha=.2)
ax.set_xlabel('Three.js X (m)');ax.set_ylabel('Three.js Z (m)')
ax.set_title('Actual floor and collision-clear player-center region\nGreen: main walk area; dark: standing-height geometry')
ax.set_xlim(floor.bounds[0]-.4,floor.bounds[2]+.4);ax.set_ylim(floor.bounds[1]-.4,floor.bounds[3]+.4)
fig.tight_layout();fig.savefig(root/'navigation_map.png');plt.close(fig)
print(json.dumps({'floor_area':floor.area,'components':[p.area for p in components],
                  'main_vertices':len(main.exterior.coords),'holes':len(main.interiors),
                  'output_bytes':(root/'navigation.json').stat().st_size,'views':views}),flush=True)
