"""Export an inspected Blender scene to GLB without changing the .blend file.

Run with Blender (4.5+; 5.2.3 is the verified version for temka.blend):
  Blender --background --factory-startup --disable-autoexec SOURCE.blend \
    --python-exit-code 1 --python scripts/export_room.py -- --output OUTPUT.glb

This is an asset export, not a walkthrough. It does not add lights, a player,
collisions, or a browser UI. Geometry Nodes instances are explicitly enabled.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import sys

import bpy


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--scene', help='Explicit source scene; otherwise active scene')
    parser.add_argument('--exclude-object', action='append', default=[],
                        help='Skip a proven duplicate in the in-memory export copy; repeatable')
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def shader_images(tree, seen=None):
    if tree is None:
        return []
    seen = set() if seen is None else seen
    key = tree.as_pointer()
    if key in seen:
        return []
    seen.add(key)
    result = []
    for node in tree.nodes:
        image = getattr(node, 'image', None)
        if image is not None:
            result.append(image)
        nested = getattr(node, 'node_tree', None)
        if nested is not None:
            result.extend(shader_images(nested, seen))
    return result


def inspect_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data):
        raise RuntimeError('Invalid GLB header or length')
    json_length, json_type = struct.unpack_from('<II', data, 12)
    if json_type != 0x4E4F534A:
        raise RuntimeError('Missing glTF JSON chunk')
    document = json.loads(data[20:20 + json_length])
    external = []
    for key in ('buffers', 'images'):
        for item in document.get(key, []):
            uri = item.get('uri')
            if uri and not uri.startswith('data:'):
                external.append(uri)
    if external:
        raise RuntimeError('GLB has external dependencies: ' + repr(external))
    if not document.get('meshes'):
        raise RuntimeError('No meshes were exported')
    accessors = document.get('accessors', [])
    mesh_triangles = []
    for mesh in document['meshes']:
        total = 0
        for primitive in mesh['primitives']:
            if primitive.get('mode', 4) != 4:
                continue
            accessor = primitive.get('indices', primitive['attributes']['POSITION'])
            total += accessors[accessor]['count'] // 3
        mesh_triangles.append(total)
    nodes = document.get('nodes', [])
    scene_index = document.get('scene', 0)
    roots = document.get('scenes', [{}])[scene_index].get('nodes', [])
    def triangles_for_node(index):
        node = nodes[index]
        total = mesh_triangles[node['mesh']] if 'mesh' in node else 0
        instancing = node.get('extensions', {}).get('EXT_mesh_gpu_instancing')
        if instancing:
            attribute = next(iter(instancing['attributes'].values()))
            total *= accessors[attribute]['count']
        return total + sum(triangles_for_node(child) for child in node.get('children', []))
    return {
        'size_bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'mesh_datablocks': len(document.get('meshes', [])),
        'nodes': len(nodes),
        'material_count': len(document.get('materials', [])),
        'image_count': len(document.get('images', [])),
        'scene_triangles_including_instances': sum(triangles_for_node(i) for i in roots),
        'external_resource_uris': external,
        'extensions_used': document.get('extensionsUsed', []),
        'extensions_required': document.get('extensionsRequired', []),
    }


def main():
    args = arguments()
    if not bpy.data.filepath:
        raise RuntimeError('Open the source .blend before running this script')
    source = Path(bpy.data.filepath).resolve()
    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() != '.glb' or output == source:
        raise RuntimeError('Output must be a separate .glb file')
    if output.exists():
        raise FileExistsError(f'Refusing to overwrite existing output: {output}')
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    if args.scene:
        target_scene = bpy.data.scenes.get(args.scene)
        if target_scene is None:
            raise RuntimeError(f'No scene named {args.scene!r}')
        bpy.context.window.scene = target_scene
    scene = bpy.context.scene
    for name in args.exclude_object:
        obj = scene.objects.get(name)
        if obj is None:
            raise RuntimeError(f'Cannot exclude unknown object: {name!r}')
        obj.hide_set(True)
        obj.hide_render = True
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    scene.frame_set(scene.frame_current)
    bpy.context.view_layer.update()
    objects = [o for o in scene.objects if o.visible_get() and not o.hide_render]
    if not any(o.type == 'MESH' for o in objects):
        raise RuntimeError('No visible/renderable mesh objects')

    missing_groups = []
    for obj in objects:
        for modifier in obj.modifiers:
            if modifier.type == 'NODES' and modifier.show_viewport:
                group = modifier.node_group
                if group is None or getattr(group, 'is_missing', False):
                    missing_groups.append(f'{obj.name}/{modifier.name}')
    if missing_groups:
        raise RuntimeError('Missing Geometry Nodes groups: ' + ', '.join(missing_groups))

    used_materials = {slot.material for obj in objects for slot in obj.material_slots if slot.material}
    missing_images = []
    for material in used_materials:
        for image in shader_images(material.node_tree):
            if image.source not in ('FILE', 'TILED'):
                continue
            packed = bool(image.packed_file) or bool(image.packed_files)
            resolved = bpy.path.abspath(image.filepath, library=image.library)
            if not packed and not os.path.isfile(resolved):
                missing_images.append({'material': material.name, 'image': image.name, 'path': image.filepath})
    if missing_images:
        raise RuntimeError('Missing images referenced by material nodes: ' + json.dumps(missing_images, ensure_ascii=False))

    output.parent.mkdir(parents=True, exist_ok=True)
    options = dict(
        filepath=str(output), export_format='GLB',
        use_active_scene=True, use_visible=True, use_renderable=True,
        export_apply=True, export_gn_mesh=True,
        export_yup=True, export_materials='EXPORT',
        export_texcoords=True, export_normals=True,
        export_animations=False, export_cameras=False, export_lights=False,
        export_extras=False, export_image_format='AUTO',
    )
    supported = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    unsupported = sorted(set(options) - supported)
    if unsupported:
        raise RuntimeError('Exporter does not support required options: ' + ', '.join(unsupported))
    result = bpy.ops.export_scene.gltf(**options)
    if 'FINISHED' not in result or not output.is_file():
        raise RuntimeError(f'Export did not finish: {result}')
    after = hashlib.sha256(source.read_bytes()).hexdigest()
    if after != before:
        raise RuntimeError('Source hash unexpectedly changed')
    report = {
        'status': 'asset_exported_walkthrough_not_created',
        'source_filename': source.name,
        'source_sha256_before': before, 'source_sha256_after': after,
        'source_unchanged': before == after,
        'blender_version': bpy.app.version_string,
        'blender_build_hash': bpy.app.build_hash.decode('ascii', errors='replace'),
        'scene': scene.name,
        'excluded_objects_in_memory_only': list(args.exclude_object),
        'units': {'system': scene.unit_settings.system, 'scale_length': scene.unit_settings.scale_length},
        'export_options': {k: v for k, v in options.items() if k != 'filepath'},
        'glb': inspect_glb(output),
        'limitations': [
            'Visual appearance must be checked in the actual browser viewer.',
            'No player, navigation, collision geometry, or lighting rig was created.',
            'Geometry Nodes instance export is marked experimental by Blender; compare evaluated geometry and re-import.',
            'No material baking or intentional scene redesign was performed.',
        ],
    }
    report_path = output.with_suffix('.export.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'export': str(output), 'report': str(report_path), 'glb': report['glb']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
