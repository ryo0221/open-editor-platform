import {
  BoxGeometry,
  Color,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Group,
  ShaderMaterial,
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
  pathRenderSupport,
  pathRenderTiles,
} from './path-render';
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

  it('refuses an analysis shading, which has no model colour', () => {
    const zebra = new Mesh(new BoxGeometry(1, 1, 1), new ShaderMaterial());
    expect(() => pathRenderScene([zebra])).toThrow(/Shaded or Realistic/);
    const curvature = new MeshStandardMaterial({ vertexColors: true });
    curvature.userData.analysis = true;
    const coloured = new Mesh(new BoxGeometry(1, 1, 1), curvature);
    expect(() => pathRenderScene([coloured])).toThrow(/Shaded or Realistic/);
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
