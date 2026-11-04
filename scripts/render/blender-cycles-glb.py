"""Render a GLB exported from the CAD editor to a PNG with Blender Cycles on the CPU.

Usage (Blender 4.2 LTS or later, no GPU needed):

    blender -b --python scripts/render/blender-cycles-glb.py -- model.glb out.png \
        [--width 1600] [--height 1000] [--samples 128] [--time-limit 0] \
        [--hdri studio.hdr] [--hdri-strength 1] [--hdri-rotation 0] \
        [--view iso|front|side|top] [--no-ground] [--transparent] [--no-denoise] [--threads 0]

The same file also runs with the `bpy` wheel from PyPI: `python blender-cycles-glb.py model.glb out.png`.
See docs/verification/textures/README.md (stage 4) for the workflow and its limits.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector

VIEWS = {
    # Direction from the model centre to the camera, in Blender coordinates (Z up).
    'iso': Vector((1.0, -1.25, 0.85)),
    'front': Vector((0.0, -1.0, 0.12)),
    'side': Vector((1.0, 0.0, 0.12)),
    'top': Vector((0.0, -0.001, 1.0)),
}


def arguments(argv):
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description='Render a CAD editor GLB with Cycles on the CPU.')
    parser.add_argument('glb', type=Path)
    parser.add_argument('png', type=Path)
    parser.add_argument('--width', type=int, default=1600)
    parser.add_argument('--height', type=int, default=1000)
    parser.add_argument('--samples', type=int, default=128, help='maximum samples per pixel')
    parser.add_argument('--time-limit', type=float, default=0,
                        help='seconds; stop sampling at this time and write the image reached (0 = no limit)')
    parser.add_argument('--hdri', type=Path, help='equirectangular .hdr or .exr for background and light')
    parser.add_argument('--hdri-strength', type=float, default=1.0)
    parser.add_argument('--hdri-rotation', type=float, default=0.0, help='degrees about the vertical axis')
    parser.add_argument('--view', choices=sorted(VIEWS), default='iso')
    parser.add_argument('--no-ground', action='store_true', help='do not add a shadow-catcher ground')
    parser.add_argument('--transparent', action='store_true', help='write a transparent background')
    parser.add_argument('--no-denoise', action='store_true')
    parser.add_argument('--threads', type=int, default=0, help='CPU threads (0 = all)')
    options = parser.parse_args(argv)
    if options.width < 16 or options.height < 16 or options.width > 16384 or options.height > 16384:
        parser.error('width and height must be between 16 and 16384')
    if options.samples < 1:
        parser.error('samples must be at least 1')
    if options.time_limit < 0:
        parser.error('time limit must not be negative')
    if not options.glb.is_file():
        parser.error(f'GLB not found: {options.glb}')
    if options.hdri and not options.hdri.is_file():
        parser.error(f'HDRI not found: {options.hdri}')
    return options


def import_model(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    meshes = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    if not meshes:
        raise SystemExit(f'{path} contains no meshes')
    return meshes


def bounds(meshes):
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    for obj in meshes:
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            low = Vector(map(min, low, point))
            high = Vector(map(max, high, point))
    return low, high


def add_camera(scene, low, high, view, aspect):
    centre = (low + high) / 2
    radius = max((high - low).length / 2, 1e-4)
    data = bpy.data.cameras.new('Render camera')
    data.lens_unit = 'FOV'
    data.angle = math.radians(35)
    # With sensor fit AUTO the angle spans the longer side; fit the bounding sphere into the shorter one.
    ratio = aspect if aspect >= 1 else 1 / aspect
    narrow = 2 * math.atan(math.tan(data.angle / 2) / ratio)
    distance = radius / math.sin(narrow / 2) * 1.08
    data.clip_start = max(distance - radius * 3, distance * 1e-3)
    data.clip_end = distance + radius * 50
    camera = bpy.data.objects.new('Render camera', data)
    scene.collection.objects.link(camera)
    camera.location = centre + VIEWS[view].normalized() * distance
    camera.rotation_euler = (centre - camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = camera
    return radius


def add_world(scene, options):
    world = bpy.data.worlds.new('Render world')
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    background = nodes['Background']
    if options.hdri:
        texture = nodes.new('ShaderNodeTexEnvironment')
        texture.image = bpy.data.images.load(str(options.hdri.resolve()))
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Rotation'].default_value[2] = math.radians(options.hdri_rotation)
        coordinates = nodes.new('ShaderNodeTexCoord')
        links.new(coordinates.outputs['Generated'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], texture.inputs['Vector'])
        links.new(texture.outputs['Color'], background.inputs['Color'])
        background.inputs['Strength'].default_value = options.hdri_strength
    else:
        # No HDRI: a neutral sky gradient plus a sun, so the render needs no downloaded asset.
        separate = nodes.new('ShaderNodeSeparateXYZ')
        coordinates = nodes.new('ShaderNodeTexCoord')
        ramp = nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (0.42, 0.42, 0.40, 1)
        ramp.color_ramp.elements[1].color = (0.62, 0.72, 0.86, 1)
        links.new(coordinates.outputs['Generated'], separate.inputs[0])
        links.new(separate.outputs['Z'], ramp.inputs['Fac'])
        links.new(ramp.outputs['Color'], background.inputs['Color'])
        background.inputs['Strength'].default_value = 0.9
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
        sun.data.energy = 3.0
        sun.data.angle = math.radians(3)
        sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(35))
        scene.collection.objects.link(sun)
    scene.world = world


def add_ground(scene, low, high, radius):
    centre = (low + high) / 2
    size = radius * 40
    mesh = bpy.data.meshes.new('Ground')
    mesh.from_pydata([(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new('Ground', mesh)
    ground.location = (centre.x, centre.y, low.z)
    ground.is_shadow_catcher = True
    scene.collection.objects.link(ground)


def configure(scene, options):
    scene.render.engine = 'CYCLES'
    cycles = scene.cycles
    cycles.device = 'CPU'
    cycles.samples = options.samples
    cycles.use_adaptive_sampling = True
    cycles.time_limit = options.time_limit
    cycles.use_denoising = not options.no_denoise
    if cycles.use_denoising:
        cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.render.threads_mode = 'FIXED' if options.threads else 'AUTO'
    if options.threads:
        scene.render.threads = options.threads
    scene.render.resolution_x = options.width
    scene.render.resolution_y = options.height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = options.transparent
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA' if options.transparent else 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'AgX' if 'AgX' in [
        item.identifier for item in scene.view_settings.bl_rna.properties['view_transform'].enum_items
    ] else 'Filmic'


def main():
    options = arguments(sys.argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    meshes = import_model(options.glb)
    low, high = bounds(meshes)
    radius = add_camera(scene, low, high, options.view, options.width / options.height)
    add_world(scene, options)
    if not options.no_ground:
        add_ground(scene, low, high, radius)
    configure(scene, options)
    options.png.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(options.png.resolve())
    started = time.monotonic()
    bpy.ops.render.render(write_still=True)
    print(json.dumps({
        'output': str(options.png.resolve()),
        'width': options.width,
        'height': options.height,
        'maxSamples': options.samples,
        'timeLimitSeconds': options.time_limit,
        'meshes': len(meshes),
        'hdri': str(options.hdri) if options.hdri else None,
        'elapsedSeconds': round(time.monotonic() - started, 1),
    }))


if __name__ == '__main__':
    main()
