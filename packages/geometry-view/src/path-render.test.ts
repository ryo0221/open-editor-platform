import {
  BoxGeometry,
  Color,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Group,
  ShaderMaterial,
  BackSide,
  Box3,
  DoubleSide,
  RectAreaLight,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  defaultPathRenderSettings,
  pathRenderCamera,
  pathRenderEnvironmentRotation,
  pathRenderPixels,
  withoutFloatBlending,
  pathRenderProblem,
  pathRenderScene,
  pathRenderStudioLights,
  pathRenderSupport,
  pathRenderTiles,
} from './path-render';
import { instancesGroup, type ViewMesh } from './instances';
import { setViewFinish } from './lighting';

describe('path render settings', () => {
  it('accepts the defaults and refuses sizes, samples and limits out of range', () => {
    expect(pathRenderProblem(defaultPathRenderSettings)).toBeUndefined();
    const s = defaultPathRenderSettings;
    expect(pathRenderProblem({ ...s, width: 8 })).toMatch(/16 to 4096/);
    expect(pathRenderProblem({ ...s, height: 100.5 })).toMatch(/whole/);
    expect(pathRenderProblem({ ...s, samples: 0 })).toMatch(/Samples/);
    expect(pathRenderProblem({ ...s, samples: 5000 })).toMatch(/Samples/);
    expect(pathRenderProblem({ ...s, timeLimit: -1 })).toMatch(/time limit/);
    expect(pathRenderProblem({ ...s, timeLimit: 0 })).toBeUndefined();
    expect(pathRenderProblem({ ...s, hdriIntensity: 0 })).toMatch(/strength/);
  });
  it('starts in the studio light at the standard exposure, within ±5 stops (ST-530, TS-2050)', () => {
    const s = defaultPathRenderSettings;
    expect([s.lighting, s.exposureStops]).toEqual(['studio', 0]);
    expect(pathRenderProblem({ ...s, lighting: 'sky', exposureStops: -5 })).toBeUndefined();
    expect(pathRenderProblem({ ...s, exposureStops: 5.5 })).toMatch(/exposure/);
    expect(pathRenderProblem({ ...s, exposureStops: Number.NaN })).toMatch(/exposure/);
    expect(pathRenderProblem({ ...s, lighting: 'night' as never })).toMatch(/studio or the sky/);
  });
  it('splits large images into tiles of about 512² pixels', () => {
    expect(pathRenderTiles(320, 200)).toBe(1);
    expect(pathRenderTiles(1600, 1000)).toBe(3);
    expect(pathRenderTiles(4096, 4096)).toBe(8);
  });
});

describe('path render scene', () => {
  it('copies visible meshes at their world place, expands instances and leaves lines out', () => {
    const root = new Group();
    root.position.set(10, 0, 0);
    const material = setViewFinish(new MeshStandardMaterial({ color: '#808080' }), {
      metalness: 1,
    });
    // The standard lighting shows a metal at the default metalness; selection tints it.
    material.metalness = 0.05;
    material.emissive = new Color('#2563eb');
    material.emissiveIntensity = 0.12;
    const box = new Mesh(new BoxGeometry(1, 1, 1), material);
    box.position.set(0, 5, 0);
    const hidden = new Mesh(new BoxGeometry(1, 1, 1), material);
    hidden.visible = false;
    const edges = new LineSegments(box.geometry, new LineBasicMaterial());
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), material, 3);
    for (let i = 0; i < 3; i++)
      instanced.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, 100 * i));
    instanced.setColorAt(0, new Color('#2563eb'));
    const overlay = new Mesh(box.geometry, new MeshStandardMaterial({ color: '#2563eb' }));
    overlay.userData.highlight = true;
    root.add(box, hidden, edges, instanced, overlay);
    const scene = pathRenderScene([root]);
    const meshes = scene.children as Mesh[];
    expect(meshes).toHaveLength(4);
    expect(meshes.every((m) => !(m as InstancedMesh).isInstancedMesh)).toBe(true);
    const at = meshes.map((m) => new Vector3().setFromMatrixPosition(m.matrixWorld).toArray());
    expect(at).toEqual([
      [10, 5, 0],
      [10, 0, 0],
      [10, 0, 100],
      [10, 0, 200],
    ]);
    const copy = meshes[0].material as MeshStandardMaterial;
    expect(copy).not.toBe(material);
    expect(meshes[1].material).toBe(copy);
    expect(copy.metalness).toBe(1);
    expect(copy.emissiveIntensity).toBe(0);
    expect(meshes[0].geometry).toBe(box.geometry);
    // The view's own material is untouched.
    expect(material.emissiveIntensity).toBe(0.12);
  });

  it('draws a look’s light as light and its transmission refracted (CR6a, TS-1592)', () => {
    const lamp = setViewFinish(new MeshStandardMaterial(), {
      emission: { color: '#ff0000', strength: 6 },
    });
    // The view caps the glow at 1 and the selection tint is drawn over it.
    expect([lamp.emissive.getHexString(), lamp.emissiveIntensity]).toEqual(['ff0000', 1]);
    lamp.emissive.set('#2563eb');
    lamp.emissiveIntensity = 0.12;
    const lens = setViewFinish(new MeshStandardMaterial({ opacity: 1 }), {
      roughness: 0.02,
      metalness: 0,
      transmission: 1,
      ior: 1.49,
    });
    // The view's stand-in: a lower opacity, drawn see-through.
    expect([lens.opacity, lens.transparent, lens.depthWrite]).toEqual([0.25, true, false]);
    const plain = setViewFinish(new MeshStandardMaterial(), { roughness: 0.5, metalness: 0 });
    const root = new Group();
    root.add(
      new Mesh(new BoxGeometry(1, 1, 1), lamp),
      new Mesh(new BoxGeometry(1, 1, 1), lens),
      new Mesh(new BoxGeometry(1, 1, 1), plain),
    );
    const [lit, clear, other] = pathRenderScene([root]).children as Mesh[];
    const litCopy = lit!.material as MeshStandardMaterial;
    expect([litCopy.emissive.getHexString(), litCopy.emissiveIntensity]).toEqual(['ff0000', 6]);
    const clearCopy = clear!.material as MeshPhysicalMaterial;
    expect(clearCopy.isMeshPhysicalMaterial).toBe(true);
    expect([clearCopy.transmission, clearCopy.ior, clearCopy.opacity]).toEqual([1, 1.49, 1]);
    expect([clearCopy.transparent, clearCopy.roughness]).toEqual([false, 0.02]);
    expect((other!.material as MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeUndefined();
    expect((other!.material as MeshStandardMaterial).emissiveIntensity).toBe(0);
    // A look set again without light drops it, and setting one twice does not compound.
    setViewFinish(lamp, { roughness: 0.5, metalness: 0 });
    expect(lamp.userData.emission).toBeUndefined();
    expect([lamp.emissive.getHexString(), lamp.emissiveIntensity]).toEqual(['000000', 0]);
    setViewFinish(lens, { transmission: 1 });
    expect([lens.opacity, lens.transparent]).toEqual([0.25, true]);
    setViewFinish(lens, { transmission: 0.5 });
    expect(lens.opacity).toBeCloseTo(0.625, 6);
    setViewFinish(lens, undefined);
    expect([lens.opacity, lens.transparent, lens.depthWrite]).toEqual([1, false, true]);
    expect(lens.userData.opacity).toBeUndefined();
  });

  it('draws a sheet once, two-sided, without the view’s darker back (ST-530, TS-2051)', () => {
    const mesh: ViewMesh = {
      origin: [0, 0, 0],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const group = instancesGroup([
      {
        meshes: [{ mesh, color: '#cc0000', opacity: 1, sheet: true }],
        bounds: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        instances: [{ path: ['a'], matrix: new Matrix4().toArray(), selected: false }],
      },
    ]);
    // The view: the sheet's face, its darker back on the same triangles, and outlines.
    const faces = group.children.filter((o) => (o as Mesh).isMesh) as Mesh[];
    expect(faces.map((m) => (m.material as MeshStandardMaterial).side)).toEqual([0, BackSide]);
    const drawn = pathRenderScene([group]).children as Mesh[];
    expect(drawn).toHaveLength(1);
    const material = drawn[0]!.material as MeshStandardMaterial;
    expect([material.side, material.color.getHexString()]).toEqual([DoubleSide, 'cc0000']);
  });

  it('draws a finer mesh in place of the shown one, moved by their origins (ST-530, TS-2052)', () => {
    const triangle = (origin: [number, number, number], scale: number): ViewMesh => ({
      origin,
      positions: new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    });
    const shown = triangle([10, 0, 0], 1);
    const fine = triangle([12, 0, 0], 1);
    const group = instancesGroup([
      {
        meshes: [{ mesh: shown, color: '#808080', opacity: 1, sheet: false }],
        bounds: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        instances: [0, 100].map((y, i) => ({
          path: [`p${i}`],
          matrix: new Matrix4().makeTranslation(0, y, 0).toArray(),
          selected: false,
        })),
      },
    ]);
    const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    const scene = pathRenderScene([group, plain], (object) =>
      object.userData.mesh === shown ? { mesh: fine, shown } : undefined,
    );
    const [a, b, box] = scene.children as Mesh[];
    // One geometry for both instances, from the finer mesh; the view's mesh is left alone.
    expect(a!.geometry).toBe(b!.geometry);
    expect(a!.geometry.getAttribute('position').array).toBe(fine.positions);
    expect(a!.geometry.userData.pathRenderOwned).toBe(true);
    // Its points are relative to its own origin: placed 2 mm further along x.
    const at = (m: Mesh) => new Vector3().setFromMatrixPosition(m.matrixWorld).toArray();
    expect([at(a!), at(b!)]).toEqual([
      [12, 0, 0],
      [12, 100, 0],
    ]);
    expect(box!.geometry).toBe(plain.geometry);
  });

  it('refuses an analysis shading, which has no model colour', () => {
    const zebra = new Mesh(new BoxGeometry(1, 1, 1), new ShaderMaterial());
    expect(() => pathRenderScene([zebra])).toThrow(/Shaded or Realistic/);
    const curvature = new MeshStandardMaterial({ vertexColors: true });
    curvature.userData.analysis = true;
    const coloured = new Mesh(new BoxGeometry(1, 1, 1), curvature);
    expect(() => pathRenderScene([coloured])).toThrow(/Shaded or Realistic/);
  });
});

describe('path render studio', () => {
  it('lights the model from four soft boxes sized to it and turned with the camera (ST-530, TS-2053)', () => {
    const box = new Box3(new Vector3(0, -900, 0), new Vector3(4000, 900, 1300));
    const centre = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    const camera = new PerspectiveCamera();
    camera.position.set(9000, -6000, 2500);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    const lights = pathRenderStudioLights(box, camera);
    expect(lights).toHaveLength(4);
    expect(lights.every((l) => l instanceof RectAreaLight)).toBe(true);
    for (const l of lights) {
      // Above the floor, and shining at the model (a rect light shines along its −z).
      expect(l.position.z).toBeGreaterThan(box.min.z);
      const shine = new Vector3(0, 0, -1).transformDirection(l.matrixWorld);
      const toModel = centre.clone().sub(l.position).normalize();
      expect(shine.dot(toModel)).toBeGreaterThan(0.8);
    }
    // The overhead box is long along the model's longer side, above its top.
    const [top] = lights;
    expect(top!.position.z).toBeGreaterThan(box.max.z + radius);
    expect(top!.width).toBeGreaterThan(top!.height);
    const along = new Vector3(1, 0, 0).transformDirection(top!.matrixWorld);
    expect(Math.abs(along.x)).toBeCloseTo(1, 6);
    // The key is on the camera's side of the model, the rim behind it.
    const toCamera = camera.position.clone().sub(centre).setZ(0).normalize();
    const side = (l: RectAreaLight) => l.position.clone().sub(centre).setZ(0).dot(toCamera);
    expect(side(lights[1]!)).toBeGreaterThan(0);
    expect(side(lights[2]!)).toBeLessThan(0);
    // Twice the model, twice the boxes and their distances.
    const twice = new Box3(box.min.clone().multiplyScalar(2), box.max.clone().multiplyScalar(2));
    const big = pathRenderStudioLights(twice, camera);
    expect(big[0]!.width).toBeCloseTo(2 * top!.width, 6);
  });
});

describe('path render camera', () => {
  it('keeps a perspective view and widens an orthographic one to the image aspect', () => {
    const p = new PerspectiveCamera(45, 1, 1, 1000);
    p.position.set(1, 2, 3);
    const pc = pathRenderCamera(p, 1600, 800) as PerspectiveCamera;
    expect(pc.aspect).toBe(2);
    expect(pc.position.toArray()).toEqual([1, 2, 3]);
    expect(p.aspect).toBe(1);
    const o = new OrthographicCamera(-50, 50, 25, -25, 0, 100);
    const oc = pathRenderCamera(o, 1000, 1000) as OrthographicCamera;
    expect([oc.left, oc.right, oc.top, oc.bottom]).toEqual([-25, 25, 25, -25]);
  });
  it('turns the environment image up (+y) to the views’ up (+z)', () => {
    const up = new Vector3(0, 1, 0).applyEuler(pathRenderEnvironmentRotation(0));
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(0);
    expect(up.z).toBeCloseTo(1);
    const turned = new Vector3(1, 0, 0).applyEuler(pathRenderEnvironmentRotation(90));
    expect(turned.z).toBeCloseTo(0);
    expect(Math.hypot(turned.x, turned.y)).toBeCloseTo(1);
    expect(turned.x).toBeCloseTo(0);
  });
});

describe('path render support', () => {
  const canvas = (gl: unknown) => () => ({ getContext: () => gl }) as unknown as HTMLCanvasElement;
  it('says what to do instead when WebGL2 or float buffers are missing', () => {
    const none = pathRenderSupport(canvas(null));
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toMatch(/no WebGL2.*Blender/);
    const noFloat = pathRenderSupport(canvas({ getExtension: () => null }));
    expect(!noFloat.ok && noFloat.reason).toMatch(/float buffers.*blender-cycles-glb/);
    expect(pathRenderSupport(canvas({ getExtension: () => ({ loseContext() {} }) }))).toEqual({
      ok: true,
    });
  });
});

describe('path render pixels', () => {
  it('tone maps the linear radiance like the realistic view, opaque, top row first', () => {
    // 1×2 image as WebGL reads it: bottom row first.
    const radiance = new Float32Array([0, 0, 0, 1, 0.18, 0.18, 0.18, 0.03]);
    const { pixels, invalid } = pathRenderPixels(radiance, 1, 2);
    expect(invalid).toBe(0);
    // Top row: the mid grey (ACES at exposure 0.85, then sRGB), opaque whatever the alpha was.
    expect(pixels[0]).toBeGreaterThanOrEqual(114);
    expect(pixels[0]).toBeLessThanOrEqual(116);
    expect([pixels[0], pixels[1], pixels[2]]).toEqual([pixels[0], pixels[0], pixels[0]]);
    expect(pixels[3]).toBe(255);
    expect(Array.from(pixels.slice(4))).toEqual([0, 0, 0, 255]);
  });
  it('writes very bright light white and counts pixels that are not numbers', () => {
    const { pixels, invalid } = pathRenderPixels(
      new Float32Array([1e6, 1e6, 1e6, 1, Number.NaN, 0.5, 0.5, 1]),
      2,
      1,
    );
    expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(invalid).toBe(1);
  });
});

describe('path render accumulation', () => {
  it('hides EXT_float_blend from the path tracer and keeps the other extensions', () => {
    const renderer = {
      extensions: { get: (name: string) => ({ name }) },
    } as unknown as Parameters<typeof withoutFloatBlending>[0];
    withoutFloatBlending(renderer);
    expect(renderer.extensions.get('EXT_float_blend')).toBeNull();
    expect(renderer.extensions.get('EXT_color_buffer_float')).toEqual({
      name: 'EXT_color_buffer_float',
    });
  });
});
