"""Compare evaluated source geometry with a GLB reimport in Blender.

Usage: Blender --background --factory-startup --disable-autoexec SOURCE.blend
  --python-exit-code 1 --python scripts/verify_export.py --
  --glb assets/room.glb --output reports/roundtrip.json

Does not save .blend files. A geometry check is not browser/visual verification.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy


def summarize():
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    triangles = 0
    mesh_occurrences = 0
    materials = set()
    for occurrence in graph.object_instances:
        obj = occurrence.object
        if obj.type not in {'MESH', 'CURVE'} or not occurrence.show_self or obj.hide_render:
            continue
        owner = occurrence.parent.original if occurrence.is_instance and occurrence.parent else obj.original
        if not owner.visible_get():
            continue
        mesh = obj.to_mesh(preserve_all_data_layers=True, depsgraph=graph)
        try:
            if not mesh.vertices:
                continue
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            mesh_occurrences += 1
            materials.update(m.name for m in mesh.materials if m)
            matrix = occurrence.matrix_world
            for vertex in mesh.vertices:
                coordinate = matrix @ vertex.co
                for axis in range(3):
                    lo[axis] = min(lo[axis], coordinate[axis])
                    hi[axis] = max(hi[axis], coordinate[axis])
        finally:
            obj.to_mesh_clear()
    if not mesh_occurrences:
        raise RuntimeError('Scene contains no evaluated mesh geometry')
    return {'triangles': triangles, 'mesh_occurrences': mesh_occurrences,
            'bounds_blender_z_up': {'min': lo, 'max': hi},
            'materials': sorted(materials)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--glb', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--exclude-object', action='append', default=[])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source = Path(bpy.data.filepath).resolve()
    if source.suffix.lower() != '.blend' or not source.is_file():
        raise RuntimeError('Load the source .blend before running verification')
    glb = Path(args.glb).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if output in (source, glb) or output.exists():
        raise RuntimeError('Use a new, separate report path')
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    for name in args.exclude_object:
        obj = bpy.context.scene.objects.get(name)
        if obj is None:
            raise RuntimeError(f'Cannot exclude unknown object: {name!r}')
        obj.hide_set(True)
        obj.hide_render = True
    original = summarize()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    result = bpy.ops.import_scene.gltf(filepath=str(glb))
    if 'FINISHED' not in result:
        raise RuntimeError('GLB reimport did not finish')
    imported = summarize()
    bound_error = max(abs(original['bounds_blender_z_up'][end][axis] - imported['bounds_blender_z_up'][end][axis])
                      for end in ('min', 'max') for axis in range(3))
    checks = {
        'triangle_count_equal': original['triangles'] == imported['triangles'],
        'bounds_within_0_0001_blender_units': bound_error <= 0.0001,
        'material_names_equal': original['materials'] == imported['materials'],
        'source_unchanged': source_hash == hashlib.sha256(source.read_bytes()).hexdigest(),
    }
    report = {
        'status': 'PASS' if all(checks.values()) else 'FAIL',
        'blender_version': bpy.app.version_string,
        'source_sha256': source_hash,
        'excluded_objects_in_memory_only': list(args.exclude_object),
        'glb_sha256': hashlib.sha256(glb.read_bytes()).hexdigest(),
        'checks': checks, 'max_bounds_absolute_error': bound_error,
        'source_evaluated': original, 'glb_reimport_evaluated': imported,
        'not_verified': ['browser appearance', 'walk controls', 'collision navigation', 'macOS installation'],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    if not all(checks.values()):
        raise RuntimeError('Round-trip comparison failed; see report')


if __name__ == '__main__':
    main()
