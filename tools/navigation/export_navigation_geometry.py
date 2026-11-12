"""Export floor and body-level obstacle projections for the static walkthrough.

Run with Blender 5.2 and the source .blend loaded. Does not save the source.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import bpy

EXCLUDED = {'Cube.029', 'Cube.003', 'Plane.009', 'Plane.010'}
FLOOR_NAME = 'Plane.007'
LOW = 0.08
HIGH = 1.80

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
source = Path(bpy.data.filepath)
before = hashlib.sha256(source.read_bytes()).hexdigest()

def clip_z(points, height, keep_above):
    out = []
    for a, b in zip(points, points[1:] + points[:1]):
        ina = a[2] >= height if keep_above else a[2] <= height
        inb = b[2] >= height if keep_above else b[2] <= height
        if ina:
            out.append(a)
        if ina != inb:
            factor = (height - a[2]) / (b[2] - a[2])
            out.append([a[i] + factor * (b[i] - a[i]) for i in range(3)])
    return out

bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
floor = []
obstacles = []
metadata = []
for occurrence in dg.object_instances:
    ob = occurrence.object
    original = ob.original
    if ob.type != 'MESH' or original.name in EXCLUDED or ob.hide_render or not original.visible_get() or not occurrence.show_self:
        continue
    mesh = ob.to_mesh(preserve_all_data_layers=True, depsgraph=dg)
    try:
        mesh.calc_loop_triangles()
        vertices = [(occurrence.matrix_world @ v.co)[:] for v in mesh.vertices]
        lo = [min(v[a] for v in vertices) for a in range(3)]
        hi = [max(v[a] for v in vertices) for a in range(3)]
        projected = []
        for tri in mesh.loop_triangles:
            points = [vertices[i] for i in tri.vertices]
            if original.name == FLOOR_NAME:
                floor.append([[p[0], -p[1]] for p in points])
            else:
                points = clip_z(clip_z(points, LOW, True), HIGH, False)
                if len(points) >= 2:
                    projected.append([[p[0], -p[1]] for p in points])
        if projected:
            obstacles.append({'name': original.name, 'projections': projected})
        metadata.append({'name': original.name, 'triangles': len(mesh.loop_triangles),
                         'source_bounds': {'min': lo, 'max': hi},
                         'projected_body_triangles': len(projected)})
    finally:
        ob.to_mesh_clear()

report = {'coordinate_system': 'glTF XZ ground plane: [source.x, -source.y]',
          'floor_object': FLOOR_NAME, 'floor_triangles': floor,
          'obstacle_projections': obstacles, 'objects': metadata,
          'body_height_interval_source_z': [LOW, HIGH],
          'excluded_static_duplicates': sorted(EXCLUDED),
          'source_sha256': before,
          'source_unchanged': hashlib.sha256(source.read_bytes()).hexdigest() == before}
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, separators=(',', ':')))
print(json.dumps({'output': str(output), 'objects': len(metadata), 'floor_triangles': len(floor),
                  'projected_triangles': sum(len(o['projections']) for o in obstacles),
                  'source_unchanged': report['source_unchanged']}))
