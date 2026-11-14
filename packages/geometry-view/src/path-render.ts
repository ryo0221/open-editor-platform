/**
 * Path-traced still image of a CAD or building view (#664, texture stage 4). The image is drawn
 * by `three-gpu-pathtracer` on its own WebGL2 canvas, not on the editing viewport: the view's
 * solids are copied into a scene of their own (instances expanded, display-only state such as
 * the selection tint taken off), lit by an HDRI or a built-in sky and sun, and sampled until the
 * sample count or the time limit is reached. Display only: no domain state.
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EquirectangularReflectionMapping,
  Euler,
  FloatType,
  type InstancedMesh,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RectAreaLight,
  Scene,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { geometryLightLimits, type GeometryEmission } from '@editor-platform/geometry-core';
import type { ViewMesh } from './instances';

/** Limits of the render settings; the time limit is in seconds, 0 for none. */
export const pathRenderLimits = {
  minSide: 16,
  maxSide: 4096,
  maxPixels: 4096 * 4096,
  minSamples: 1,
  maxSamples: 4096,
  maxTimeLimit: 3600,
  hdriBytes: 64 * 1024 * 1024,
  /** Exposure in stops either way of the standard one. */
  maxExposureStops: 5,
} as const;

/**
 * Light without an HDRI: `studio` is a dark room with soft boxes around the model and a light
 * floor (a product shot), `sky` a grey-to-blue sky and a sun.
 */
export type PathRenderLighting = 'studio' | 'sky';

export interface PathRenderSettings {
  width: number;
  height: number;
  /** Samples per pixel to stop at. */
  samples: number;
  /** Seconds after which sampling stops and the image reached is kept; 0 for no limit. */
  timeLimit: number;
  /** A ground under the model that takes its shadow. */
  floor: boolean;
  /** HDRI rotation about the vertical axis, in degrees. */
  hdriRotation: number;
  /** Strength of the HDRI's light and background. */
  hdriIntensity: number;
  /** The light when no HDRI is given. */
  lighting: PathRenderLighting;
  /** Stops brighter (+) or darker (−) than the standard exposure. */
  exposureStops: number;
}

export const defaultPathRenderSettings: PathRenderSettings = {
  width: 1600,
  height: 1000,
  samples: 256,
  timeLimit: 60,
  floor: true,
  hdriRotation: 0,
  hdriIntensity: 1,
  lighting: 'studio',
  exposureStops: 0,
};

/** Why the settings cannot be rendered, or undefined when they can. */
export function pathRenderProblem(s: PathRenderSettings): string | undefined {
  const { minSide, maxSide, maxPixels, minSamples, maxSamples, maxTimeLimit } = pathRenderLimits;
  const whole = (v: number) => Number.isInteger(v);
  if (![s.width, s.height].every((v) => whole(v) && v >= minSide && v <= maxSide))
    return `Width and height must be whole numbers from ${minSide} to ${maxSide} px.`;
  if (s.width * s.height > maxPixels) return `At most ${maxPixels} pixels.`;
  if (!whole(s.samples) || s.samples < minSamples || s.samples > maxSamples)
    return `Samples must be a whole number from ${minSamples} to ${maxSamples}.`;
  if (!Number.isFinite(s.timeLimit) || s.timeLimit < 0 || s.timeLimit > maxTimeLimit)
    return `The time limit must be from 0 (none) to ${maxTimeLimit} s.`;
  if (!Number.isFinite(s.hdriRotation)) return 'The HDRI rotation must be a number.';
  if (!Number.isFinite(s.hdriIntensity) || s.hdriIntensity <= 0 || s.hdriIntensity > 100)
    return 'The HDRI strength must be above 0 and at most 100.';
  const stops = pathRenderLimits.maxExposureStops;
  if (!Number.isFinite(s.exposureStops) || Math.abs(s.exposureStops) > stops)
    return `The exposure must be from −${stops} to +${stops} stops.`;
  if (s.lighting !== 'studio' && s.lighting !== 'sky') return 'Choose the studio or the sky light.';
  return undefined;
}

/**
 * Whether this browser can path trace: WebGL2 with float colour buffers. The message says what
 * to do instead, since a computer without a usable GPU often has neither.
 */
export function pathRenderSupport(
  canvas: () => HTMLCanvasElement | OffscreenCanvas = () => document.createElement('canvas'),
): { ok: true } | { ok: false; reason: string } {
  const instead =
    'Export GLB and render it on the CPU with Blender (scripts/render/blender-cycles-glb.py).';
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas().getContext('webgl2') as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return { ok: false, reason: `This browser has no WebGL2 for path tracing. ${instead}` };
  const float = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  if (!float)
    return {
      ok: false,
      reason: `This browser's WebGL2 cannot draw to float buffers, which path tracing needs. ${instead}`,
    };
  return { ok: true };
}

/** What the view gives to render: its solids and its camera. */
export interface PathRenderSource {
  /** Groups holding the shown solids; edges, labels, helpers and marks are not meshes and are left out. */
  roots: Object3D[];
  camera: PerspectiveCamera | OrthographicCamera;
  /**
   * A finer triangulation of a shown mesh's shape, for smoother surfaces in the image:
   * `mesh` in place of `shown`, both with their positions relative to their own origin. The
   * shown mesh is drawn as it is when this is absent or gives nothing.
   */
  finer?(object: Mesh): { mesh: ViewMesh; shown: ViewMesh } | undefined;
}

function renderMaterial(material: Material, copies: Map<Material, Material>): Material {
  const known = copies.get(material);
  if (known) return known;
  // An analysis shading (zebra, curvature) is a shader without a model colour: not a look the
  // path tracer can draw.
  // A view marks an analysis material (`userData.analysis`), such as CAD's curvature colours
  // on a standard material.
  if (material.userData.analysis || !(material as Material & { color?: Color }).color?.isColor)
    throw new Error(
      'The view shows an analysis shading. Switch the shading to Shaded or Realistic, then render.',
    );
  let copy = material.clone();
  // Both sides: a sheet is seen from either, and a closed solid's inside is never reached.
  copy.side = DoubleSide;
  if (copy instanceof MeshStandardMaterial) {
    // The metalness the look asks for, not the standard lighting's stand-in (see setViewFinish).
    if (typeof material.userData.metalness === 'number')
      copy.metalness = material.userData.metalness;
    // The selection tint is not the model's look; the look's own light (CR6a) is.
    const emission = material.userData.emission as GeometryEmission | undefined;
    copy.emissive.set(emission ? emission.color : 0x000000);
    copy.emissiveIntensity = emission ? emission.strength : 0;
    // CR6a: light through the surface, refracted, in place of the view's lower opacity.
    const transmission = material.userData.transmission;
    if (typeof transmission === 'number' && transmission > 0) {
      const physical = new MeshPhysicalMaterial();
      MeshStandardMaterial.prototype.copy.call(physical, copy);
      // The standard copy takes the physical shader's defines away.
      physical.defines = { STANDARD: '', PHYSICAL: '' };
      physical.transmission = transmission;
      physical.ior =
        (material.userData.ior as number | undefined) ?? geometryLightLimits.defaultIor;
      physical.thickness = 0;
      const opacity = material.userData.opacity;
      physical.opacity = typeof opacity === 'number' ? opacity : 1;
      physical.transparent = physical.opacity < 1;
      physical.depthWrite = !physical.transparent;
      copy.dispose();
      copy = physical;
    }
  }
  copies.set(material, copy);
  return copy;
}

/**
 * The scene to path trace: a copy of each visible mesh under the roots at its place in the world,
 * sharing the geometry and textures, with its own materials. An instanced mesh becomes one mesh
 * per instance (the path tracer draws a mesh once), without the instance colours (the selection).
 */
export function pathRenderScene(roots: Object3D[], finer?: PathRenderSource['finer']): Scene {
  const scene = new Scene();
  const copies = new Map<Material, Material>();
  const instance = new Matrix4();
  /** Geometries made from finer meshes, one per mesh (instances share it); disposed with the scene. */
  const made = new Map<ViewMesh, BufferGeometry>();
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
      // Selection overlays (a picked face drawn over its solid) are not the model.
      if (mesh.userData.highlight) return;
      // A sheet's darker back is a display aid on the same triangles: two coincident surfaces
      // would speckle each other in a path tracer. The sheet's own surface is drawn two-sided.
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.some((m) => m.userData.sheetBack)) return;
      const material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => renderMaterial(m, copies))
        : renderMaterial(mesh.material, copies);
      // A finer mesh of the same shape: its own origin, so the placement shifts by the difference.
      const fine = finer?.(mesh);
      let geometry = mesh.geometry;
      let shift: Matrix4 | undefined;
      if (fine) {
        geometry = made.get(fine.mesh) ?? viewMeshGeometry(fine.mesh);
        geometry.userData.pathRenderOwned = true;
        made.set(fine.mesh, geometry);
        const [a, b] = [fine.mesh.origin, fine.shown.origin];
        shift = new Matrix4().makeTranslation(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      const add = (matrix: Matrix4) => {
        const copy = new Mesh(geometry, material);
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(matrix);
        if (shift) copy.matrix.multiply(shift);
        copy.name = mesh.name;
        scene.add(copy);
      };
      const instanced = mesh as Mesh & { isInstancedMesh?: boolean; count: number };
      if (instanced.isInstancedMesh) {
        const im = mesh as unknown as InstancedMesh;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, instance);
          add(new Matrix4().multiplyMatrices(im.matrixWorld, instance));
        }
      } else add(mesh.matrixWorld);
    });
  }
  scene.updateMatrixWorld(true);
  return scene;
}

/** A mesh's triangles as a geometry, positions relative to its origin. */
export function viewMeshGeometry(mesh: ViewMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * The studio light (no HDRI): a dark room's faint glow and four soft boxes sized to the model,
 * placed by the camera's heading so the model is lit the same from any side it is seen. A big
 * box overhead, a key at the camera's front left, a rim behind at the right and a long strip low
 * on the far side; the boxes show in glossy surfaces as a studio's do.
 */
export function pathRenderStudioLights(box: Box3, camera: Camera): RectAreaLight[] {
  const centre = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const r = Math.max(size.length() / 2, 1);
  // The camera's heading in the ground plane (z up); straight down, the model's long axis.
  const view = camera.getWorldDirection(new Vector3());
  const ahead = new Vector3(view.x, view.y, 0);
  if (ahead.lengthSq() < 1e-6) ahead.set(size.x >= size.y ? 0 : 1, size.x >= size.y ? 1 : 0, 0);
  ahead.normalize();
  const right = new Vector3(ahead.y, -ahead.x, 0);
  const at = (forward: number, side: number, up: number) =>
    centre
      .clone()
      .addScaledVector(ahead, forward * r)
      .addScaledVector(right, side * r)
      .add(new Vector3(0, 0, up * r));
  const light = (
    intensity: number,
    width: number,
    height: number,
    position: Vector3,
    target: Vector3,
  ) => {
    const l = new RectAreaLight(new Color('#ffffff'), intensity, width * r, height * r);
    l.position.copy(position);
    l.lookAt(target);
    l.updateMatrixWorld(true);
    return l;
  };
  const low = centre.clone().setZ(box.min.z + size.z * 0.3);
  return [
    // Overhead: the long side along the model's longer horizontal axis.
    (() => {
      const l = light(3.5, 1.6, 0.9, centre.clone().setZ(box.max.z + 1.6 * r), centre);
      // Looking straight down, the box's width (its x) runs square to `up`.
      l.up.set(size.x >= size.y ? 0 : 1, size.x >= size.y ? 1 : 0, 0);
      l.lookAt(centre);
      l.updateMatrixWorld(true);
      return l;
    })(),
    light(7, 0.9, 0.9, at(-1.4, -1.5, 1.1), centre),
    light(8, 0.6, 0.9, at(1.8, 1.4, 0.9), centre),
    light(4, 2.2, 0.18, at(1.6, -0.2, 0.25), low),
  ];
}

/** The view's camera at the render's aspect ratio, the shown area kept by its height. */
export function pathRenderCamera(
  camera: PerspectiveCamera | OrthographicCamera,
  width: number,
  height: number,
): PerspectiveCamera | OrthographicCamera {
  const copy = camera.clone();
  copy.updateMatrixWorld(true);
  const aspect = width / height;
  if (copy instanceof PerspectiveCamera) copy.aspect = aspect;
  else {
    const middle = (copy.left + copy.right) / 2;
    const half = ((copy.top - copy.bottom) / 2) * aspect;
    copy.left = middle - half;
    copy.right = middle + half;
  }
  copy.updateProjectionMatrix();
  return copy;
}

/** Z-up views: the equirect image's up (+y) turned to +z, then turned about the vertical. */
export function pathRenderEnvironmentRotation(degrees: number): Euler {
  return new Euler(Math.PI / 2, (degrees * Math.PI) / 180, 0, 'XYZ');
}

/** Reads an equirectangular `.hdr` or `.exr` image as a float texture. */
export async function readHdri(file: Blob & { name?: string }): Promise<DataTexture> {
  if (file.size > pathRenderLimits.hdriBytes)
    throw new Error(`The HDRI is over ${pathRenderLimits.hdriBytes / 1024 / 1024} MiB.`);
  const bytes = await file.arrayBuffer();
  const exr = /\.exr$/i.test(file.name ?? '') || new Uint32Array(bytes, 0, 1)[0] === 20000630;
  const parsed = exr
    ? new (await import('three/addons/loaders/EXRLoader.js')).EXRLoader()
        .setDataType(FloatType)
        .parse(bytes)
    : new (await import('three/addons/loaders/HDRLoader.js')).HDRLoader()
        .setDataType(FloatType)
        .parse(bytes);
  if (!parsed?.data || !parsed.width || !parsed.height)
    throw new Error('The HDRI cannot be read: use an equirectangular .hdr or .exr image.');
  const texture = new DataTexture(
    parsed.data as Float32Array,
    parsed.width,
    parsed.height,
    parsed.format,
    parsed.type,
  );
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  // Each loader says which way its rows run (HDR top-down, EXR bottom-up); the path tracer reads it.
  texture.flipY = parsed.flipY ?? !exr;
  texture.needsUpdate = true;
  return texture;
}

export interface PathRenderControl {
  /** Stops and throws an `AbortError`: nothing is kept. */
  cancelled?: boolean;
  /** Stops at the next sample and keeps the image reached. */
  finishNow?: boolean;
}
export interface PathRenderProgress {
  /** Whole samples per pixel reached. */
  samples: number;
  elapsedMs: number;
  /** The path-tracing shader is still being compiled (on the first render it may take a while). */
  preparing: boolean;
}
export interface PathRenderResult {
  png: Blob;
  width: number;
  height: number;
  samples: number;
  /** What ended the render. */
  stoppedBy: 'samples' | 'time' | 'finish';
  /** The GPU the browser reported, when it names it. */
  gpu?: string;
  /** The graphics API the path tracer ran on. */
  api: 'WebGPU' | 'WebGL';
  /** Why WebGPU was not used although the browser has it (the render fell back to WebGL). */
  webgpuFailure?: string;
  /** Pixels whose value was not a number (written black): a GPU or driver fault, not the model. */
  invalidPixels: number;
}

/** Exposure of the render, as the realistic lighting's (see lighting.ts). */
export const pathRenderExposure = 0.85;
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const rrtOdt = (v: number) =>
  (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The 8-bit opaque image of the path tracer's linear radiance (RGBA float rows, bottom row
 * first as WebGL reads them, or top row first as WebGPU does): three.js's ACES Filmic tone mapping at the exposure, then sRGB.
 * The image is always opaque, so a viewer shows it as the preview does; a pixel that is not a
 * number is written black and counted.
 */
export function pathRenderPixels(
  radiance: Float32Array,
  width: number,
  height: number,
  { exposure = pathRenderExposure, topRowFirst = false } = {},
): { pixels: Uint8ClampedArray<ArrayBuffer>; invalid: number } {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const k = exposure / 0.6;
  let invalid = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((topRowFirst ? y : height - 1 - y) * width + x) * 4;
      const o = (y * width + x) * 4;
      let r = radiance[i]! * k;
      let g = radiance[i + 1]! * k;
      let b = radiance[i + 2]! * k;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        invalid++;
        r = g = b = 0;
      }
      // ACES input matrix (sRGB to AP1 with the RRT saturation), the fit, then back to sRGB.
      const ar = rrtOdt(0.59719 * r + 0.35458 * g + 0.04823 * b);
      const ag = rrtOdt(0.076 * r + 0.90834 * g + 0.01566 * b);
      const ab = rrtOdt(0.0284 * r + 0.13383 * g + 0.83777 * b);
      pixels[o] = Math.round(srgb(clamp01(1.60475 * ar - 0.53108 * ag - 0.07367 * ab)) * 255);
      pixels[o + 1] = Math.round(srgb(clamp01(-0.10208 * ar + 1.10813 * ag - 0.00605 * ab)) * 255);
      pixels[o + 2] = Math.round(srgb(clamp01(-0.00327 * ar - 0.07276 * ag + 1.07602 * ab)) * 255);
      pixels[o + 3] = 255;
    }
  }
  return { pixels, invalid };
}

/** Makes the renderer report no EXT_float_blend, so the path tracer averages in a shader pass. */
export function withoutFloatBlending(renderer: WebGLRenderer) {
  const extensions = renderer.extensions as { get(name: string): unknown };
  const get = extensions.get.bind(extensions);
  extensions.get = (name: string) => (name === 'EXT_float_blend' ? null : get(name));
}

/** The GPU the context runs on, when the browser names it. */
function gpuName(renderer: WebGLRenderer): string | undefined {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return typeof name === 'string' && name ? name : undefined;
}

/** Tiles per side so one pass covers about 512² pixels, keeping each frame short. */
export function pathRenderTiles(width: number, height: number): number {
  return Math.max(1, Math.min(8, Math.ceil(Math.sqrt((width * height) / (512 * 512)))));
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sunDirection = new Vector3(1, -1.5, 2).normalize();

/**
 * Path traces the source at the settings' size and writes a PNG. Runs on a canvas of its own
 * that is thrown away at the end; the editing view and its WebGL context are not used.
 */
export async function renderPathTraced(
  source: PathRenderSource,
  settings: PathRenderSettings,
  options: {
    control?: PathRenderControl;
    hdri?: Texture;
    onProgress?(progress: PathRenderProgress): void;
    now?: () => number;
  } = {},
): Promise<PathRenderResult> {
  const problem = pathRenderProblem(settings);
  if (problem) throw new Error(problem);
  const control = options.control ?? {};
  const now = options.now ?? (() => performance.now());
  const { width, height } = settings;
  // The model and camera as they are now, copied before anything is awaited.
  const scene = pathRenderScene(source.roots, source.finer);
  if (!scene.children.length) throw new Error('Nothing is shown to render.');
  const camera = pathRenderCamera(source.camera, width, height);
  const { GradientEquirectTexture } = await import('three-gpu-pathtracer');
  // Cancelled while the module loaded: nothing is prepared or drawn.
  if (control.cancelled) {
    disposeMaterials(scene);
    throw new DOMException('The render was cancelled.', 'AbortError');
  }
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.length() / 2, 1);
  const owned: { dispose(): void }[] = [];
  const studio = !options.hdri && settings.lighting === 'studio';
  if (settings.floor) {
    const floor = new Mesh(
      new PlaneGeometry(radius * 60, radius * 60),
      new MeshStandardMaterial(
        studio
          ? { color: '#6f7378', roughness: 0.45, metalness: 0 }
          : { color: '#d4d7da', roughness: 0.9, metalness: 0 },
      ),
    );
    floor.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
    owned.push(floor.geometry, floor.material);
    scene.add(floor);
  }
  let environment: Texture;
  if (options.hdri) {
    environment = options.hdri;
    scene.environmentIntensity = scene.backgroundIntensity = settings.hdriIntensity;
  } else if (studio) {
    // A dark room: a faint glow from above, darker towards the floor, and the soft boxes.
    const room = new GradientEquirectTexture(256);
    room.topColor.set('#3a3e44');
    room.bottomColor.set('#0b0c0e');
    room.exponent = 1.4;
    room.update();
    owned.push(room);
    environment = room;
    scene.environmentIntensity = scene.backgroundIntensity = 0.6;
    scene.add(...pathRenderStudioLights(box, camera));
  } else {
    // No HDRI: a grey-to-blue sky and a sun, so a render needs no downloaded image.
    const sky = new GradientEquirectTexture(256);
    sky.topColor.set('#9fb6d6');
    sky.bottomColor.set('#5e5d58');
    sky.exponent = 0.8;
    sky.update();
    owned.push(sky);
    environment = sky;
    const sun = new DirectionalLight(new Color('#fff6e8'), 2.2);
    sun.position.copy(sunDirection);
    scene.add(sun, sun.target);
  }
  scene.environment = scene.background = environment;
  const rotation = pathRenderEnvironmentRotation(options.hdri ? settings.hdriRotation : 0);
  scene.environmentRotation.copy(rotation);
  scene.backgroundRotation.copy(rotation);
  try {
    const loop = { settings, control, now, onProgress: options.onProgress };
    // WebGPU first: on Intel Iris Xe under Direct3D 11 (#692 acceptance) the WebGL path tracer
    // drew black and white noise, while the library's WebGPU path tracer drew correctly.
    // A WebGPU failure (no device, a lost device, an unsupported feature) falls back to WebGL
    // and says so in the result; a Cancel stops.
    let fallback: string | undefined;
    let traced: Traced | undefined;
    if (hasWebGPU()) {
      try {
        traced = await traceWebGPU(scene, camera, loop);
      } catch (error) {
        if (control.cancelled) throw error;
        fallback = error instanceof Error ? error.message : String(error);
        console.warn('WebGPU path tracing failed; using WebGL.', error);
      }
    }
    traced ??= await traceWebGL(scene, camera, loop);
    const { pixels, invalid } = pathRenderPixels(traced.radiance, width, height, {
      topRowFirst: traced.topRowFirst,
      exposure: pathRenderExposure * 2 ** settings.exposureStops,
    });
    const out = Object.assign(document.createElement('canvas'), { width, height });
    out.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
    const png = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('The rendered image could not be written as PNG.');
    return {
      png,
      width,
      height,
      samples: traced.samples,
      stoppedBy: traced.stoppedBy,
      gpu: traced.gpu,
      api: traced.api,
      webgpuFailure: fallback,
      invalidPixels: invalid,
    };
  } finally {
    for (const o of owned) o.dispose();
    disposeMaterials(scene);
  }
}

interface SampleLoop {
  settings: PathRenderSettings;
  control: PathRenderControl;
  now: () => number;
  onProgress?(progress: PathRenderProgress): void;
}
interface Traced {
  /** Linear RGBA radiance. */
  radiance: Float32Array;
  topRowFirst: boolean;
  samples: number;
  stoppedBy: PathRenderResult['stoppedBy'];
  gpu?: string;
  api: PathRenderResult['api'];
}

/**
 * Takes samples until the sample count, the time limit or Stop; `step` takes one and gives the
 * whole samples every pixel has. Throws an `AbortError` on Cancel.
 */
async function sampleUntilDone(
  { settings, control, now, onProgress }: SampleLoop,
  step: () => Promise<{ samples: number; preparing: boolean }>,
): Promise<{ samples: number; stoppedBy: PathRenderResult['stoppedBy'] }> {
  const started = now();
  for (;;) {
    await nextTask();
    if (control.cancelled) throw new DOMException('The render was cancelled.', 'AbortError');
    const { samples, preparing } = await step();
    const elapsedMs = now() - started;
    onProgress?.({ samples, elapsedMs, preparing });
    // Keep going until one whole sample is in every pixel.
    if (samples < 1) continue;
    if (samples >= settings.samples) return { samples, stoppedBy: 'samples' };
    if (settings.timeLimit && elapsedMs >= settings.timeLimit * 1000)
      return { samples, stoppedBy: 'time' };
    if (control.finishNow) return { samples, stoppedBy: 'finish' };
  }
}

/** Whether the browser offers WebGPU; the renderer asks for the adapter itself (a second adapter
 * requested here could leave the renderer's device on a stale instance). */
function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

async function traceWebGPU(scene: Scene, camera: Camera, loop: SampleLoop): Promise<Traced> {
  const { width, height } = loop.settings;
  const [{ WebGPURenderer }, { WebGPUPathTracer }] = await Promise.all([
    import('three/webgpu'),
    import('three-gpu-pathtracer/webgpu'),
  ]);
  const canvas = document.createElement('canvas');
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  let tracer: InstanceType<typeof WebGPUPathTracer> | undefined;
  try {
    await renderer.init();
    const backend = renderer.backend as {
      isWebGPUBackend?: boolean;
      adapter?: { info?: Record<string, string> };
    };
    // Without an adapter the renderer quietly falls back to its WebGL 2 backend, which the WebGPU
    // path tracer cannot use.
    if (!backend.isWebGPUBackend) throw new Error('The browser has no WebGPU adapter.');
    const info = backend.adapter?.info ?? {};
    const gpu =
      [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || undefined;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    tracer = new WebGPUPathTracer(renderer);
    tracer.renderDelay = 0;
    tracer.minSamples = 0;
    tracer.fadeDuration = 0;
    tracer.dynamicLowRes = false;
    tracer.maxBounces = 6;
    tracer.maxSamples = loop.settings.samples;
    tracer.setScene(scene, camera);
    const t = tracer;
    const { samples, stoppedBy } = await sampleUntilDone(loop, async () => {
      t.renderSample();
      const counts = await t.getSampleCountsAsync();
      return { samples: Math.floor(counts.min), preparing: counts.max === 0 };
    });
    const read = (await renderer.readRenderTargetPixelsAsync(
      { textures: [t.target] } as unknown as Parameters<
        typeof renderer.readRenderTargetPixelsAsync
      >[0],
      0,
      0,
      width,
      height,
    )) as Float32Array;
    return {
      radiance: unpadRows(read, width, height),
      topRowFirst: true,
      samples,
      stoppedBy,
      gpu,
      api: 'WebGPU',
    };
  } finally {
    tracer?.dispose();
    renderer.dispose();
  }
}

/** A GPU buffer's rows may be padded to an alignment: the rows of `width` RGBA texels alone. */
export function unpadRows(data: Float32Array, width: number, height: number): Float32Array {
  const row = width * 4;
  if (data.length === row * height) return data;
  const stride = Math.floor(data.length / height);
  if (stride < row) throw new Error('The rendered image could not be read back.');
  const out = new Float32Array(row * height);
  for (let y = 0; y < height; y++) out.set(data.subarray(y * stride, y * stride + row), y * row);
  return out;
}

async function traceWebGL(scene: Scene, camera: Camera, loop: SampleLoop): Promise<Traced> {
  const { width, height } = loop.settings;
  const { WebGLPathTracer } = await import('three-gpu-pathtracer');
  // Its own canvas and context: the editing view keeps drawing and its context is untouched.
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  // Accumulate samples by the path tracer's own blend pass, never by GPU float blending: on
  // real GPUs (#692 acceptance) hardware blending of float targets added the samples up into a
  // white image with tile-shaped seams. The path tracer takes this route itself on browsers
  // without EXT_float_blend, and it averages exactly.
  withoutFloatBlending(renderer);
  const tracer = new WebGLPathTracer(renderer);
  try {
    tracer.renderDelay = 0;
    tracer.minSamples = 1;
    tracer.fadeDuration = 0;
    tracer.rasterizeScene = false;
    // The image is read from the path tracer's own float target, not from this canvas.
    tracer.renderToCanvas = false;
    tracer.dynamicLowRes = false;
    tracer.bounces = 6;
    const tiles = pathRenderTiles(width, height);
    tracer.tiles.set(tiles, tiles);
    tracer.setScene(scene, camera);
    const { samples, stoppedBy } = await sampleUntilDone(loop, async () => {
      tracer.renderSample();
      return {
        samples: Math.floor(tracer.samples),
        preparing: (tracer as { isCompiling?: boolean }).isCompiling === true,
      };
    });
    const radiance = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(tracer.target, 0, 0, width, height, radiance);
    return {
      radiance,
      topRowFirst: false,
      samples,
      stoppedBy,
      gpu: gpuName(renderer),
      api: 'WebGL',
    };
  } finally {
    tracer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/** The scene's own materials, and the geometries it made from finer meshes (the view's stay). */
function disposeMaterials(scene: Scene) {
  const materials = new Set<Material>();
  const geometries = new Set<BufferGeometry>();
  scene.traverse((o) => {
    const { material: m, geometry } = o as Mesh;
    if (m) for (const x of Array.isArray(m) ? m : [m]) materials.add(x);
    if (geometry?.userData.pathRenderOwned) geometries.add(geometry);
  });
  for (const m of materials) m.dispose();
  for (const g of geometries) g.dispose();
}
