import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  boxEdges,
  femGaussVolume,
  femVolume,
  curvedJacobianMin,
  jacobianRatio,
  solveElastic,
  type FemMesh,
} from '@editor-platform/geometry-fem';
import { describe, expect, it } from 'vitest';
import {
  assembleFemMesh,
  boxSurface,
  checkSurface,
  meshSurface,
  meshSurfaceReport,
  MesherError,
  netgenGrading,
  type FemMesherModule,
  type SurfaceMeshInput,
} from './index';

const problem = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(MesherError);
    return (e as MesherError).problem;
  }
  throw new Error('not refused');
};
const copy = (s: SurfaceMeshInput): SurfaceMeshInput => ({
  ...s,
  points: s.points.slice(),
  triangles: s.triangles.slice(),
  faces: s.faces.slice(),
  edges: { offsets: s.edges.offsets.slice(), nodes: s.edges.nodes.slice() },
});

describe('mesher input (R3b)', () => {
  const box = boxSurface([10, 20, 30], [2, 3, 4]);

  it('accepts a closed, outward box surface with tags and edge chains', () => {
    expect(() => checkSurface(box)).not.toThrow();
    expect(box.shapeEdges).toBe(boxEdges.length);
  });

  it('refuses open, mis-wound, inside-out and mistagged surfaces', () => {
    const open = copy(box);
    open.triangles = open.triangles.slice(3);
    open.faces = open.faces.slice(1);
    expect(problem(() => checkSurface(open))).toBe('surface-open');
    const flipped = copy(box);
    [flipped.triangles[1], flipped.triangles[2]] = [flipped.triangles[2]!, flipped.triangles[1]!];
    expect(problem(() => checkSurface(flipped))).toBe('surface-orientation');
    const inside = copy(box);
    for (let t = 0; t < inside.faces.length; t++)
      [inside.triangles[3 * t + 1], inside.triangles[3 * t + 2]] = [
        inside.triangles[3 * t + 2]!,
        inside.triangles[3 * t + 1]!,
      ];
    expect(problem(() => checkSurface(inside))).toBe('surface-inside-out');
    const tag = copy(box);
    tag.faces[0] = 6;
    expect(problem(() => checkSurface(tag))).toBe('face-tag');
    const nan = copy(box);
    nan.points[4] = Number.NaN;
    expect(problem(() => checkSurface(nan))).toBe('not-finite');
    const degenerate = copy(box);
    degenerate.triangles[1] = degenerate.triangles[0]!;
    expect(problem(() => checkSurface(degenerate))).toBe('surface-degenerate');
  });

  it('refuses edge chains that leave the triangle edges', () => {
    const chain = copy(box);
    // The first chain's middle point replaced by a point of another edge: neighbours not joined.
    chain.edges.nodes[1] = chain.edges.nodes[chain.edges.offsets[5]! + 1]!;
    expect(problem(() => checkSurface(chain))).toBe('edge-chain');
    const short = copy(box);
    short.edges.offsets = short.edges.offsets.slice(0, -1);
    expect(problem(() => checkSurface(short))).toBe('edge-chain');
  });

  it('refuses curved mid points that are not one per surface edge near its middle', () => {
    const [a, b] = [box.triangles[0]!, box.triangles[1]!];
    const mid = (k: number) => (box.points[3 * a + k]! + box.points[3 * b + k]!) / 2;
    const ok = { pairs: new Uint32Array([a, b]), points: new Float64Array([0, 1, 2].map(mid)) };
    expect(() => checkSurface({ ...box, midpoints: ok })).not.toThrow();
    const cases: [SurfaceMeshInput['midpoints'], string][] = [
      [{ pairs: new Uint32Array([a, b]), points: new Float64Array(2) }, 'midpoint'],
      [{ pairs: new Uint32Array([a, a]), points: new Float64Array(3) }, 'midpoint'],
      [
        {
          pairs: new Uint32Array([a, b, b, a]),
          points: new Float64Array([...ok.points, ...ok.points]),
        },
        'midpoint',
      ],
      [{ pairs: ok.pairs, points: new Float64Array([mid(0) + 100, mid(1), mid(2)]) }, 'midpoint'],
      [{ pairs: ok.pairs, points: new Float64Array([Number.NaN, mid(1), mid(2)]) }, 'not-finite'],
    ];
    for (const [midpoints, want] of cases)
      expect(problem(() => checkSurface({ ...box, midpoints }))).toBe(want);
  });

  it('accepts small and fractional boxes far from the origin', () => {
    expect(() => checkSurface(boxSurface([0.1, 0.1, 0.1], [3, 3, 3]))).not.toThrow();
    const far = boxSurface([0.01, 0.01, 0.01], [1, 1, 1]);
    far.points = far.points.map((x) => x + 10_000);
    expect(() => checkSurface(far)).not.toThrow();
  });

  it('maps the growth ratio to Netgen grading', () => {
    expect(netgenGrading(1.5)).toBeCloseTo(0.5);
    expect(netgenGrading(1)).toBe(0.05);
    expect(netgenGrading(4)).toBe(1);
  });

  it('refuses Netgen output that changed the surface', () => {
    const tiny = boxSurface([1, 1, 1], [1, 1, 1]);
    const moved = {
      points: tiny.points.map((x, i) => (i === 0 ? x + 1e-9 : x)),
      tets: new Int32Array(4),
      triangles: new Int32Array(tiny.triangles),
      triangleFaces: new Int32Array(tiny.faces),
    };
    expect(problem(() => assembleFemMesh(tiny, moved, 'tet4'))).toBe('surface-changed');
    // Same points, but two triangles' shape faces exchanged.
    const swapped = { ...moved, points: tiny.points.slice() };
    swapped.triangleFaces = new Int32Array(tiny.faces);
    [swapped.triangleFaces[0], swapped.triangleFaces[2]] = [tiny.faces[2]!, tiny.faces[0]!];
    expect(problem(() => assembleFemMesh(tiny, swapped, 'tet4'))).toBe('surface-changed');
  });
});

// The Wasm is built by scripts/fem-mesher/build.sh and stays outside Git (FEM_MESHER_DIST).
const dist = process.env.FEM_MESHER_DIST
  ? path.resolve(process.env.FEM_MESHER_DIST)
  : path.resolve(__dirname, '../../../work/fem-mesher');
const available = existsSync(path.join(dist, 'fem-mesher.wasm'));
const load = async (): Promise<FemMesherModule> => {
  const create = (await import(pathToFileURL(path.join(dist, 'fem-mesher.mjs')).href)) as {
    default: () => Promise<FemMesherModule>;
  };
  return create.default();
};
const faceArea = (mesh: FemMesh, tag: number) => {
  let area = 0;
  const npe = mesh.type === 'tet4' ? 4 : 10;
  const faces = [
    [1, 2, 3],
    [0, 3, 2],
    [0, 1, 3],
    [0, 2, 1],
  ];
  for (let i = 0; i < mesh.boundary.tags.length; i++) {
    if (mesh.boundary.tags[i] !== tag) continue;
    const e = mesh.boundary.elements[i]!;
    const [p, q, r] = faces[mesh.boundary.localFaces[i]!]!.map((k) => mesh.elements[e * npe + k]!);
    const v = (j: number) => [0, 1, 2].map((d) => mesh.nodes[3 * j + d]!);
    const [a, b, c] = [v(p!), v(q!), v(r!)];
    const u = b!.map((x, d) => x - a![d]!),
      w = c!.map((x, d) => x - a![d]!);
    area +=
      Math.hypot(
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!,
      ) / 2;
  }
  return area;
};

describe.skipIf(!available)('Netgen volume meshing (R3b, fem-mesher.wasm)', () => {
  it('is the pinned build', async () => {
    const { femMesherBuild } = await import('../../../scripts/fem-mesher/build.mjs');
    const sha = (f: string) =>
      createHash('sha256')
        .update(readFileSync(path.join(dist, f)))
        .digest('hex');
    expect(sha(femMesherBuild.wasm)).toBe(femMesherBuild.wasmSha256);
    expect(sha(femMesherBuild.js)).toBe(femMesherBuild.jsSha256);
  });

  const box = boxSurface([10, 20, 30], [3, 4, 6]);

  it('meshes the box into tet4 and tet10 that keep the surface, the tags and the edges', async () => {
    const m = await load();
    for (const type of ['tet4', 'tet10'] as const) {
      const mesh = meshSurface(m, box, { type, size: 4, minSize: 0.5, grading: 1.3 });
      expect(femVolume(mesh)).toBeCloseTo(6000, 6);
      expect(mesh.boundary.tags.length).toBe(box.faces.length);
      const areas = [600, 600, 300, 300, 200, 200];
      areas.forEach((a, tag) => expect(faceArea(mesh, tag)).toBeCloseTo(a, 6));
      // Interior points were added after the surface's, which stay first and unchanged.
      expect(Array.from(mesh.nodes.subarray(0, box.points.length))).toEqual(Array.from(box.points));
      const per = type === 'tet4' ? 1 : 2;
      for (let k = 0; k < box.shapeEdges; k++) {
        const kept = box.edges.offsets[k + 1]! - box.edges.offsets[k]!;
        expect(mesh.edges.offsets[k + 1]! - mesh.edges.offsets[k]!).toBe((kept - 1) * per + 1);
      }
    }
  });

  it('reproduces uniform tension exactly on the unstructured tet10 mesh (patch test)', async () => {
    const m = await load();
    const mesh = meshSurface(m, box, { type: 'tet10', size: 5, minSize: 0.5, grading: 1.5 });
    // x0 roller in x, y0 roller in y, z0 roller in z; x1 pulled to σxx = 100 MPa.
    const E = 210_000,
      nu = 0.3;
    const r = solveElastic({
      mesh,
      material: { youngsModulus: E, poissonsRatio: nu, density: 0 },
      constraints: [
        { faces: [0], edges: [], displacement: [0, null, null] },
        { faces: [2], edges: [], displacement: [null, 0, null] },
        { faces: [4], edges: [], displacement: [null, null, 0] },
      ],
      loads: [{ kind: 'face-force', faces: [1], force: [100 * 600, 0, 0] }],
      solver: { tolerance: 1e-12, maxIterations: 100_000 },
    });
    expect(r.converged).toBe(true);
    let worst = 0;
    for (let p = 0; p < mesh.nodes.length / 3; p++) {
      const x = mesh.nodes[3 * p]!,
        y = mesh.nodes[3 * p + 1]!,
        z = mesh.nodes[3 * p + 2]!;
      const exact = [(100 / E) * x, ((-nu * 100) / E) * y, ((-nu * 100) / E) * z];
      for (let d = 0; d < 3; d++)
        worst = Math.max(worst, Math.abs(r.displacement[3 * p + d]! - exact[d]!));
    }
    expect(worst).toBeLessThan(1e-7);
    for (let p = 0; p < mesh.nodes.length / 3; p++) expect(r.vonMises[p]!).toBeCloseTo(100, 4);
  }, 120_000);

  /** Mid points on every surface edge of face x1 (x = 10), moved along x by `k` × the edge. */
  const pushedX1 = (k: number): SurfaceMeshInput['midpoints'] => {
    const pairs: number[] = [],
      points: number[] = [];
    const done = new Set<string>();
    for (let t = 0; t < box.faces.length; t++) {
      if (box.faces[t] !== 1) continue;
      for (const [i, j] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const) {
        const u = box.triangles[3 * t + i]!,
          v = box.triangles[3 * t + j]!;
        const id = u < v ? `${u},${v}` : `${v},${u}`;
        if (done.has(id)) continue;
        done.add(id);
        const p = [0, 1, 2].map((d) => (box.points[3 * u + d]! + box.points[3 * v + d]!) / 2);
        const len = Math.hypot(
          ...[0, 1, 2].map((d) => box.points[3 * u + d]! - box.points[3 * v + d]!),
        );
        p[0]! += k * len;
        pairs.push(Math.min(u, v), Math.max(u, v));
        points.push(...p);
      }
    }
    return { pairs: new Uint32Array(pairs), points: new Float64Array(points) };
  };

  it('puts tet10 mid nodes on the given points and straightens elements that would fold (R3d-2a)', async () => {
    const m = await load();
    const settings = { type: 'tet10', size: 4, minSize: 0.5, grading: 1.3 } as const;
    const bulge = pushedX1(0.01);
    const r = meshSurfaceReport(m, { ...box, midpoints: bulge }, settings);
    expect(r.curved).toBe(bulge!.pairs.length / 2);
    expect(r.straightened).toBe(0);
    // A bulge outward adds volume; the corners' volume is still the box's.
    expect(femGaussVolume(r.mesh)).toBeGreaterThan(6000);
    expect(femVolume(r.mesh)).toBeCloseTo(6000, 6);
    const fold = meshSurfaceReport(m, { ...box, midpoints: pushedX1(-0.49) }, settings);
    expect(fold.straightened).toBeGreaterThan(0);
    // Folded and nearly folded elements (R3d-2b) are put back on their straight edges.
    for (let e = 0; e < fold.mesh.elements.length / 10; e++)
      expect(jacobianRatio(fold.mesh, e)).toBeGreaterThanOrEqual(curvedJacobianMin);
    expect(fold.minJacobian).toBeGreaterThanOrEqual(curvedJacobianMin);
    expect(r.minJacobian).toBeLessThan(1);
    // tet4 has no mid nodes: the points are ignored.
    const t4 = meshSurfaceReport(m, { ...box, midpoints: bulge }, { ...settings, type: 'tet4' });
    expect(t4.curved).toBe(0);
  }, 120_000);

  it('refuses settings outside the model before meshing', async () => {
    const m = await load();
    expect(
      problem(() => meshSurface(m, box, { type: 'tet4', size: 0, minSize: 0.1, grading: 1.5 })),
    ).toBe('settings');
    expect(
      problem(() => meshSurface(m, box, { type: 'tet4', size: 1, minSize: 2, grading: 1.5 })),
    ).toBe('settings');
    expect(
      problem(() => meshSurface(m, box, { type: 'tet4', size: 1, minSize: 0.5, grading: 0.5 })),
    ).toBe('settings');
  });
});
