import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  f01Empty,
  f02Plate,
  f02Volume,
  f03Revolve,
  f12Fillet,
  f12Holes,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
} from '@editor-platform/cad-core';
import { evaluateCad, type CadAnalysisPreparation } from '@editor-platform/cad-kernel-occt';
import { femGaussVolume, femVolume } from '@editor-platform/geometry-fem';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  checkSurface,
  meshSurface,
  meshSurfaceReport,
  type FemMesherModule,
  type SurfaceMeshInput,
} from './index';
import { facesAtRadius, facesOn, fx3 } from './fx-fixtures';

const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

/** Six times the enclosed volume, relative to the first point. */
const enclosed = (s: SurfaceMeshInput) => {
  const p = s.points;
  let v = 0;
  for (let t = 0; t < s.faces.length; t++) {
    const [a, b, c] = [0, 1, 2].map((j) => s.triangles[3 * t + j]! * 3);
    const q = [0, 1, 2].map((d) => p[a! + d]! - p[d]!);
    const r = [0, 1, 2].map((d) => p[b! + d]! - p[d]!);
    const u = [0, 1, 2].map((d) => p[c! + d]! - p[d]!);
    v +=
      q[0]! * (r[1]! * u[2]! - r[2]! * u[1]!) -
      q[1]! * (r[0]! * u[2]! - r[2]! * u[0]!) +
      q[2]! * (r[0]! * u[1]! - r[1]! * u[0]!);
  }
  return v / 6;
};

const sphere = (radius: number): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    profiles: [],
    features: [
      {
        id: 'ball',
        name: 'ball',
        type: 'sphere',
        inputFeatureIds: [],
        args: { radius: mm(radius), origin: position(0, 0, 0), orientation: identityQuaternion() },
      },
    ],
    bodies: [
      {
        id: 'ball-body',
        name: 'ball',
        sourceFeatureId: 'ball',
        placementFeatureId: 'ball-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });

describe.skipIf(!available)('CAD body → analysis surface → Netgen (R3c-2a)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let fem: FemMesherModule;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    // The Emscripten loader expects CommonJS globals under Node.
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
    const create = (await import(pathToFileURL(path.join(mesher, 'fem-mesher.mjs')).href)) as {
      default: () => Promise<FemMesherModule>;
    };
    fem = await create.default();
  }, 300_000);

  const surfaceOf = async (doc: CadDocument, bodyId: string, deflectionMm: number) => {
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId, deflectionMm },
    });
    expect(r.evaluation.status).toBe('ok');
    return r;
  };

  it('gives the plate with a hole as a closed surface tagged by its faces, and meshes it', async () => {
    const r = await surfaceOf(f02Plate(), 'plate', 0.05);
    if (!r.analysisSurface || !('surface' in r.analysisSurface)) throw new Error('no surface');
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    const exact = f02Volume(80);
    // The hole is a polygon inside its circle: the volume is a little larger, never smaller.
    expect(enclosed(s)).toBeGreaterThanOrEqual(exact - 1e-6);
    expect(enclosed(s) / exact - 1).toBeLessThan(1e-3);
    // Every face of the body has triangles; every edge between two faces has a chain.
    const tagged = new Set(s.faces);
    for (let f = 0; f < s.shapeFaces; f++) expect(tagged.has(f)).toBe(true);
    const mesh = meshSurface(fem, s, { type: 'tet10', size: 4, minSize: 0.2, grading: 1.4 });
    expect(femVolume(mesh) / enclosed(s) - 1).toBeLessThan(1e-9);
    expect(mesh.shapeFaces).toBe(s.shapeFaces);
  }, 120_000);

  it('puts tet10 mid nodes on the hole and the sphere, closer to the exact volume (R3d-2a)', async () => {
    const plate = await surfaceOf(f02Plate(), 'plate', 0.2);
    if (!plate.analysisSurface || !('surface' in plate.analysisSurface)) throw new Error('none');
    const ps = plate.analysisSurface.surface;
    // Only the hole is curved: every listed mid point is off its chord, none on the flat faces.
    expect(ps.midpoints.pairs.length).toBeGreaterThan(0);
    const settings = { type: 'tet10', size: 4, minSize: 0.2, grading: 1.4 } as const;
    const curved = meshSurfaceReport(fem, ps, settings);
    const straight = meshSurface(fem, { ...ps, midpoints: undefined }, settings);
    expect(curved.curved).toBe(ps.midpoints.pairs.length / 2);
    expect(curved.straightened).toBe(0);
    const exact = f02Volume(80);
    const errCurved = Math.abs(femGaussVolume(curved.mesh) / exact - 1);
    const errStraight = Math.abs(femGaussVolume(straight) / exact - 1);
    expect(errCurved).toBeLessThan(errStraight / 10);

    const ball = await surfaceOf(sphere(10), 'ball-body', 0.2);
    if (!ball.analysisSurface || !('surface' in ball.analysisSurface)) throw new Error('none');
    const bs = ball.analysisSurface.surface;
    const b = meshSurfaceReport(fem, bs, { type: 'tet10', size: 3, minSize: 0.2, grading: 1.4 });
    const v = (4 / 3) * Math.PI * 1000;
    expect(b.curved).toBeGreaterThan(0);
    expect(Math.abs(femGaussVolume(b.mesh) / v - 1)).toBeLessThan(
      Math.abs(femVolume(b.mesh) / v - 1) / 10,
    );
    // Every surface mid node of the sphere is on it, unless straightened.
    const chainMids = new Set<number>();
    let onSphere = 0;
    for (let k = 0; k < b.mesh.boundary.elements.length; k++) {
      const e = b.mesh.boundary.elements[k]!;
      for (let j = 4; j < 10; j++) chainMids.add(b.mesh.elements[10 * e + j]!);
    }
    for (const id of chainMids) {
      const r = Math.hypot(
        b.mesh.nodes[3 * id]!,
        b.mesh.nodes[3 * id + 1]!,
        b.mesh.nodes[3 * id + 2]!,
      );
      if (Math.abs(r - 10) < 1e-9) onSphere++;
    }
    expect(onSphere).toBeGreaterThanOrEqual(b.curved);
  }, 120_000);

  it('joins a revolved ring along its seams and meshes it', async () => {
    const r = await surfaceOf(f03Revolve(), 'ring', 0.05);
    if (!r.analysisSurface || !('surface' in r.analysisSurface)) throw new Error('no surface');
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    const mesh = meshSurface(fem, s, { type: 'tet4', size: 3, minSize: 0.2, grading: 1.4 });
    expect(femVolume(mesh)).toBeCloseTo(enclosed(s), 6);
  }, 120_000);

  it('joins the faces of a quarter-revolved tube whose edges the kernel gives slightly apart (R3d-2b)', async () => {
    // Exact-coordinate joining left this surface open (analysis-surface-nonconforming).
    const doc = fx3();
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId: 'tube', deflectionMm: 0.05, maxEdgeMm: 10 },
    });
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    expect(facesAtRadius(s, 50)).toHaveLength(1);
    expect(facesAtRadius(s, 100)).toHaveLength(1);
    expect(enclosed(s) / ((Math.PI / 4) * (100 ** 2 - 50 ** 2) * 20)).toBeCloseTo(1, 3);
    const mesh = meshSurface(fem, s, { type: 'tet4', size: 10, minSize: 2.5, grading: 1.4 });
    expect(femVolume(mesh)).toBeCloseTo(enclosed(s), 6);
  }, 120_000);

  it('closes a sphere over its poles (degenerated edges have empty chains)', async () => {
    const r = await surfaceOf(sphere(10), 'ball-body', 0.05);
    if (!r.analysisSurface || !('surface' in r.analysisSurface)) throw new Error('no surface');
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    expect(enclosed(s) / ((4 / 3) * Math.PI * 1000)).toBeGreaterThan(0.99);
    const mesh = meshSurface(fem, s, { type: 'tet4', size: 3, minSize: 0.2, grading: 1.4 });
    expect(femVolume(mesh)).toBeCloseTo(enclosed(s), 6);
  }, 120_000);

  it('sizes the surface: no edge over the size, the hole finer, and Netgen fills it (R3d-2b)', async () => {
    const coarse = await surfaceOf(f02Plate(), 'plate', 0.2);
    if (!coarse.analysisSurface || !('surface' in coarse.analysisSurface)) throw new Error('none');
    // The hole's face is the one with curved mid points.
    const c = coarse.analysisSurface.surface;
    const holeFaces = new Set<number>();
    const pairs = new Set<string>();
    for (let i = 0; i < c.midpoints.pairs.length; i += 2)
      pairs.add(`${c.midpoints.pairs[i]},${c.midpoints.pairs[i + 1]}`);
    for (let t = 0; t < c.faces.length; t++)
      for (let j = 0; j < 3; j++) {
        const a = c.triangles[3 * t + j]!,
          b = c.triangles[3 * t + ((j + 1) % 3)]!;
        if (pairs.has(`${Math.min(a, b)},${Math.max(a, b)}`)) holeFaces.add(c.faces[t]!);
      }
    expect(holeFaces.size).toBeGreaterThan(0);
    const r = await evaluateCad(oc, f02Plate(), cadContentHash(f02Plate()), {
      analysisSurface: {
        bodyId: 'plate',
        deflectionMm: 0.2,
        maxEdgeMm: 10,
        faceSizes: [...holeFaces].map((face) => ({ face, maxEdgeMm: 2 })),
      },
    });
    if (!r.analysisSurface || !('surface' in r.analysisSurface)) throw new Error('none');
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    let longest = 0,
      longestOnHole = 0;
    for (let t = 0; t < s.faces.length; t++)
      for (let j = 0; j < 3; j++) {
        const a = s.triangles[3 * t + j]!,
          b = s.triangles[3 * t + ((j + 1) % 3)]!;
        const l = Math.hypot(...[0, 1, 2].map((d) => s.points[3 * a + d]! - s.points[3 * b + d]!));
        longest = Math.max(longest, l);
        if (holeFaces.has(s.faces[t]!)) longestOnHole = Math.max(longestOnHole, l);
      }
    expect(longest).toBeLessThanOrEqual(10);
    expect(longestOnHole).toBeLessThanOrEqual(2);
    expect(s.faces.length).toBeGreaterThan(c.faces.length);
    const m = meshSurfaceReport(fem, s, { type: 'tet10', size: 10, minSize: 1, grading: 2 });
    expect(m.curved).toBeGreaterThan(0);
    // Mid nodes straightened to keep elements unfolded sit on chords: a few 1e-6 of the volume.
    expect(Math.abs(femGaussVolume(m.mesh) / f02Volume(80) - 1)).toBeLessThan(1e-5);
    // Sizes outside the model are refused before meshing.
    for (const wanted of [
      { maxEdgeMm: 0 },
      { maxEdgeMm: Number.POSITIVE_INFINITY },
      { faceSizes: [{ face: 999, maxEdgeMm: 1 }] },
      { faceSizes: [{ face: 0, maxEdgeMm: -1 }] },
      {
        faceSizes: [
          { face: 0, maxEdgeMm: 1 },
          { face: 0, maxEdgeMm: 2 },
        ],
      },
    ]) {
      const bad = await evaluateCad(oc, f02Plate(), cadContentHash(f02Plate()), {
        analysisSurface: { bodyId: 'plate', deflectionMm: 0.2, ...wanted },
      });
      expect(bad.analysisSurface).toEqual({ code: 'analysis-size' });
    }
    // The triangle limit (`analysis-surface-limit`) is tested on the refinement alone
    // (cad-kernel-occt analysis-surface.test.ts): reaching 2,000,000 triangles here takes long.
  }, 300_000);

  /** The analysis surface of `bodyId` with a preparation, or the refusal's code. */
  const prepared = async (
    doc: CadDocument,
    bodyId: string,
    preparation: CadAnalysisPreparation,
    faceSizes?: { face: number; maxEdgeMm: number }[],
  ) => {
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: {
        bodyId,
        deflectionMm: 0.05,
        preparation,
        ...(faceSizes ? { faceSizes } : {}),
      },
    });
    expect(r.evaluation.status).toBe('ok');
    return r.analysisSurface!;
  };
  const keep = { removeHolesBelow: null, removeFilletsBelow: null, removeFaces: [] };
  const surfaceOfResult = (r: { surface: SurfaceMeshInput } | { code: string }) => {
    if (!('surface' in r)) throw new Error(JSON.stringify(r));
    return r.surface as SurfaceMeshInput & {
      history: {
        faces: { deleted: boolean; images: number[] }[];
        edges: { deleted: boolean; images: number[] }[];
        analysisFaces: number;
        analysisEdges: number;
        removed: number[];
      };
    };
  };

  it('removes the F12 holes with their rim fillet below 13 mm and keeps the history (R3c-2b)', async () => {
    const doc = f12Holes();
    const plain = surfaceOfResult(await prepared(doc, 'part', keep));
    const faces = plain.history.faces.length;
    // Without a preparation the analysis shape is the body: the identity history.
    expect(plain.history.removed).toEqual([]);
    expect(plain.history.analysisFaces).toBe(faces);
    expect(plain.history.faces.every((f, i) => !f.deleted && f.images.join() === `${i}`)).toBe(
      true,
    );
    expect(
      surfaceOfResult(await prepared(doc, 'part', { ...keep, removeHolesBelow: 12 })).history
        .removed,
    ).toEqual([]);
    const s = surfaceOfResult(await prepared(doc, 'part', { ...keep, removeHolesBelow: 13 }));
    const h = s.history;
    // Two hole walls (each one or more faces) and the R1 rim torus of hole a.
    expect(h.removed.length).toBeGreaterThanOrEqual(3);
    expect(h.analysisFaces).toBe(6);
    expect(s.shapeFaces).toBe(6);
    for (const i of h.removed) expect(h.faces[i]).toEqual({ deleted: true, images: [] });
    for (let i = 0; i < faces; i++)
      if (!h.removed.includes(i)) expect(h.faces[i]!.images).toHaveLength(1);
    // Every edge of the block survives as one edge; the holes' edges are gone.
    expect(h.analysisEdges).toBe(12);
    expect(h.edges.filter((e) => !e.deleted).every((e) => e.images.length === 1)).toBe(true);
    expect(() => checkSurface(s)).not.toThrow();
    expect(enclosed(s) / (100 * 60 * 20)).toBeCloseTo(1, 6);
    const mesh = meshSurface(fem, s, { type: 'tet4', size: 10, minSize: 1, grading: 1.5 });
    expect(femVolume(mesh)).toBeCloseTo(enclosed(s), 6);
    // The same faces removed explicitly give the same shape.
    const explicit = surfaceOfResult(
      await prepared(doc, 'part', { ...keep, removeFaces: h.removed }),
    );
    expect(explicit.history).toEqual(h);
    // A body face's size reaches the analysis face it became.
    const [top] = facesOn(plain, 2, 20);
    expect(top).toBeDefined();
    const sized = surfaceOfResult(
      await prepared(doc, 'part', { ...keep, removeHolesBelow: 13 }, [
        { face: top!, maxEdgeMm: 4 },
      ]),
    );
    const image = h.faces[top!]!.images[0]!;
    let longest = 0;
    for (let t = 0; t < sized.faces.length; t++) {
      if (sized.faces[t] !== image) continue;
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const) {
        const p = sized.triangles[3 * t + a]!,
          q = sized.triangles[3 * t + b]!;
        longest = Math.max(
          longest,
          Math.hypot(...[0, 1, 2].map((d) => sized.points[3 * p + d]! - sized.points[3 * q + d]!)),
        );
      }
    }
    expect(longest).toBeLessThanOrEqual(4 + 1e-9);
  }, 300_000);

  it('removes the F12 top fillets below their radius and fills the edges back (R3c-2b)', async () => {
    const doc = f12Fillet();
    const plain = surfaceOfResult(await prepared(doc, 'part', keep));
    expect(
      surfaceOfResult(await prepared(doc, 'part', { ...keep, removeFilletsBelow: 3 })).history
        .removed,
    ).toEqual([]);
    const s = surfaceOfResult(await prepared(doc, 'part', { ...keep, removeFilletsBelow: 4 }));
    expect(s.history.removed.length).toBeGreaterThanOrEqual(4);
    expect(s.history.analysisFaces).toBe(plain.history.faces.length - s.history.removed.length);
    expect(() => checkSurface(s)).not.toThrow();
    // Sharp edges again: more material than with the R3 fillets.
    expect(enclosed(s)).toBeGreaterThan(enclosed(plain) + 1);
  }, 300_000);

  it('gives the analysis shape its exact areas, vector areas and edge lengths (R3e-2)', async () => {
    /** The surface's own vector area per tag: Σ ½ (b − a) × (c − a) over its triangles. */
    const triangulated = (sf: SurfaceMeshInput) => {
      const out = new Float64Array(sf.shapeFaces * 3);
      const p = sf.points;
      for (let t = 0; t < sf.faces.length; t++) {
        const [a, b, c] = [0, 1, 2].map((j) => sf.triangles[3 * t + j]! * 3) as [
          number,
          number,
          number,
        ];
        const q = [0, 1, 2].map((d) => p[b + d]! - p[a + d]!);
        const r = [0, 1, 2].map((d) => p[c + d]! - p[a + d]!);
        const n = [
          q[1]! * r[2]! - q[2]! * r[1]!,
          q[2]! * r[0]! - q[0]! * r[2]!,
          q[0]! * r[1]! - q[1]! * r[0]!,
        ];
        for (let d = 0; d < 3; d++) out[3 * sf.faces[t]! + d]! += n[d]! / 2;
      }
      return out;
    };
    // The plate with a hole: every face's vector area matches its triangles', and they close.
    const r = await surfaceOf(f02Plate(), 'plate', 0.05);
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const s = r.analysisSurface.surface;
    const { faceAreas, faceVectorAreas, edgeLengths } = s.measures;
    expect(faceAreas.length).toBe(s.shapeFaces);
    expect(faceVectorAreas.length).toBe(3 * s.shapeFaces);
    expect(edgeLengths.length).toBe(s.shapeEdges);
    // Nothing removed: the body's own table, in the same order.
    expect(s.bodyTopology.faces.length).toBe(s.shapeFaces);
    s.bodyTopology.faces.forEach((f, i) =>
      expect(Math.abs(f.area - faceAreas[i]!)).toBeLessThan(1e-9 * faceAreas[i]!),
    );
    const tri = triangulated(s);
    const scale = Math.max(...faceAreas);
    for (let f = 0; f < s.shapeFaces; f++) {
      const exact = faceVectorAreas.subarray(3 * f, 3 * f + 3);
      for (let d = 0; d < 3; d++)
        expect(Math.abs(exact[d]! - tri[3 * f + d]!)).toBeLessThan(2e-3 * scale);
      // No face's vector area is larger than its area; a plane's equals it.
      expect(Math.hypot(...exact)).toBeLessThanOrEqual(faceAreas[f]! * (1 + 1e-9));
    }
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (let f = 0; f < s.shapeFaces; f++) sum += faceVectorAreas[3 * f + d]!;
      expect(Math.abs(sum)).toBeLessThan(1e-9 * scale);
    }
    // F12 with its holes removed is a 100 × 60 × 20 box: ± its face areas along the axes.
    const box = await evaluateCad(oc, f12Holes(), cadContentHash(f12Holes()), {
      analysisSurface: {
        bodyId: f12Holes().bodies[0]!.id,
        deflectionMm: 0.05,
        preparation: { removeHolesBelow: 13, removeFilletsBelow: null, removeFaces: [] },
      },
    });
    if (!box.analysisSurface || !('surface' in box.analysisSurface)) throw new Error('no box');
    const m = box.analysisSurface.surface.measures;
    // The table is the body's before the preparation (F12 has 13 faces), as the history indexes.
    expect(box.analysisSurface.surface.bodyTopology.faces.length).toBe(
      box.analysisSurface.surface.history.faces.length,
    );
    // Each face's vector area lies along one axis, as large as its area, outward: the six
    // faces pair off opposite each other, and the box's faces are 100 × 60, 100 × 20, 60 × 20.
    const found = [...Array(6)].map((_, f) => [...m.faceVectorAreas.subarray(3 * f, 3 * f + 3)]);
    const areas = [100 * 60, 100 * 20, 60 * 20];
    expect(found.map((v) => Math.round(Math.hypot(...v))).sort((a, b) => a - b)).toEqual(
      [...areas, ...areas].sort((a, b) => a - b),
    );
    for (const v of found) expect(v.filter((x) => Math.abs(x) > 1e-6).length).toBe(1);
    for (let d = 0; d < 3; d++)
      expect(Math.abs(found.reduce((t, v) => t + v[d]!, 0))).toBeLessThan(1e-6);
    for (let f = 0; f < 6; f++) expect(Math.hypot(...found[f]!)).toBeCloseTo(m.faceAreas[f]!, 6);
    expect([...m.edgeLengths].reduce((a, b) => a + b, 0)).toBeCloseTo(4 * (100 + 60 + 20), 6);
  }, 120_000);

  it('splits a spline of 252 spans at its knots (R3e-2)', async () => {
    // 255 poles, 1 mm apart, alternating between heights 10 and 13, closed by a line: a cubic of
    // 252 spans in one edge, past what an adaptive rule from 16 even pieces resolved within its
    // work bound (the #799 review's case, here in a shape the kernel triangulates).
    const pts: Record<string, [number, number]> = {};
    for (let i = 0; i < 255; i++) pts[`p${i}`] = [i, i === 0 || i === 254 ? 0 : i % 2 ? 10 : 13];
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      sketches: [
        {
          id: 'star-sketch',
          name: 'Star',
          plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
          entities: [
            ...Object.keys(pts).map((id) => ({ type: 'point' as const, id })),
            { type: 'spline', id: 's', poles: Object.keys(pts), degree: 3 },
            { type: 'line', id: 'close', start: 'p254', end: 'p0' },
          ],
          constraints: [],
          solved: pts,
        },
      ],
      features: [
        {
          id: 'star-extrude',
          name: 'Star',
          type: 'extrude',
          inputFeatureIds: [],
          args: {
            sketchId: 'star-sketch',
            region: { outer: ['s', 'close'], holes: [] },
            distance: mm(5),
            direction: 1,
          },
        },
      ],
      bodies: [
        {
          id: 'star',
          name: 'star',
          sourceFeatureId: 'star-extrude',
          placementFeatureId: 'star-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const r = await surfaceOf(doc, 'star', 0.05);
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const m = r.analysisSurface.surface.measures;
    let planes = 0;
    for (let f = 0; f < m.faceAreas.length; f++) {
      const v = [...m.faceVectorAreas.subarray(3 * f, 3 * f + 3)];
      if (Math.abs(Math.abs(v[2]!) - Math.hypot(...v)) > 1e-9 * m.faceAreas[f]!) continue;
      planes++;
      expect(Math.abs(Math.hypot(...v) / m.faceAreas[f]! - 1)).toBeLessThan(1e-9);
    }
    expect(planes).toBe(2);
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (let f = 0; f < m.faceAreas.length; f++) sum += m.faceVectorAreas[3 * f + d]!;
      expect(Math.abs(sum)).toBeLessThan(1e-9 * Math.max(...m.faceAreas));
    }
  }, 120_000);

  it('integrates an edge through the origin, whose r × r′ cancels, in bounded work (R3e-2)', async () => {
    // A triangle with a corner at the origin: the edge to (30, 40) has r × r′ = 0 up to roundoff.
    const pts: Record<string, [number, number]> = { a: [0, 0], b: [30, 40], c: [60, 0] };
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      sketches: [
        {
          id: 'tri-sketch',
          name: 'Tri',
          plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
          entities: [
            ...Object.keys(pts).map((id) => ({ type: 'point' as const, id })),
            { type: 'line', id: 'ab', start: 'a', end: 'b' },
            { type: 'line', id: 'bc', start: 'b', end: 'c' },
            { type: 'line', id: 'ca', start: 'c', end: 'a' },
          ],
          constraints: [],
          solved: pts,
        },
      ],
      features: [
        {
          id: 'tri-extrude',
          name: 'Tri',
          type: 'extrude',
          inputFeatureIds: [],
          args: {
            sketchId: 'tri-sketch',
            region: { outer: ['ab', 'bc', 'ca'], holes: [] },
            distance: mm(10),
            direction: 1,
          },
        },
      ],
      bodies: [
        {
          id: 'tri',
          name: 'tri',
          sourceFeatureId: 'tri-extrude',
          placementFeatureId: 'tri-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const started = performance.now();
    const r = await surfaceOf(doc, 'tri', 0.1);
    expect(performance.now() - started).toBeLessThan(20_000);
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const m = r.analysisSurface.surface.measures;
    // Each face's |∫ n dA| is its area (all planar); the closed sum is zero; the lengths add up.
    for (let f = 0; f < m.faceAreas.length; f++)
      expect(Math.hypot(...m.faceVectorAreas.subarray(3 * f, 3 * f + 3))).toBeCloseTo(
        m.faceAreas[f]!,
        9,
      );
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (let f = 0; f < m.faceAreas.length; f++) sum += m.faceVectorAreas[3 * f + d]!;
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
    expect([...m.faceAreas].sort((x, y) => x - y)[4]).toBeCloseTo(1200, 9);
    expect([...m.edgeLengths].reduce((x, y) => x + y, 0)).toBeCloseTo(2 * (50 + 50 + 60) + 30, 9);
  });

  it('integrates a spline edge of many knot spans to the face area (R3e-2)', async () => {
    // A 41-pole cubic zigzag (38 knot spans) closed by a line, extruded 10 mm: its two planar
    // faces' vector areas are their exact areas, however the knots fall on the pieces.
    const pts: Record<string, [number, number]> = {};
    for (let i = 0; i <= 40; i++) pts[`p${i}`] = [2 * i, i === 0 || i === 40 ? 0 : i % 2 ? 5 : 15];
    const poles = Object.keys(pts);
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      sketches: [
        {
          id: 'zig-sketch',
          name: 'Zig',
          plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
          entities: [
            ...poles.map((id) => ({ type: 'point' as const, id })),
            { type: 'spline', id: 'sp', poles, degree: 3 },
            { type: 'line', id: 'base', start: 'p40', end: 'p0' },
          ],
          constraints: [],
          solved: pts,
        },
      ],
      features: [
        {
          id: 'zig-extrude',
          name: 'Zig',
          type: 'extrude',
          inputFeatureIds: [],
          args: {
            sketchId: 'zig-sketch',
            region: { outer: ['sp', 'base'], holes: [] },
            distance: mm(10),
            direction: 1,
          },
        },
      ],
      bodies: [
        {
          id: 'zig',
          name: 'zig',
          sourceFeatureId: 'zig-extrude',
          placementFeatureId: 'zig-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const r = await surfaceOf(doc, 'zig', 0.01);
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const m = r.analysisSurface.surface.measures;
    let planes = 0;
    for (let f = 0; f < m.faceAreas.length; f++) {
      const v = [...m.faceVectorAreas.subarray(3 * f, 3 * f + 3)];
      if (Math.abs(Math.abs(v[2]!) - Math.hypot(...v)) > 1e-9 * m.faceAreas[f]!) continue;
      planes++;
      expect(Math.abs(Math.hypot(...v) / m.faceAreas[f]! - 1)).toBeLessThan(1e-9);
    }
    expect(planes).toBe(2);
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (let f = 0; f < m.faceAreas.length; f++) sum += m.faceVectorAreas[3 * f + d]!;
      expect(Math.abs(sum)).toBeLessThan(1e-9 * Math.max(...m.faceAreas));
    }
  }, 120_000);

  it('keeps the F12 fillet strips unfolded through the improvement, so Netgen meshes them (R3 perf)', async () => {
    // The kernel joins each fillet strip's mitred ends in long fans; flips and moves that passed
    // the 3D tests alone folded them over (self-intersecting), and Netgen made no tetrahedron.
    const doc = f12Fillet();
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: {
        bodyId: 'part',
        deflectionMm: 0.105,
        clampDeflection: true,
        maxEdgeMm: 10.5,
        minEdgeMm: 5.25,
      },
    });
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    const s = r.analysisSurface.surface;
    expect(() => checkSurface(s)).not.toThrow();
    const mesh = meshSurface(fem, s, { type: 'tet4', size: 10.5, minSize: 5.25, grading: 1.3 });
    expect(femVolume(mesh) / enclosed(s) - 1).toBeLessThan(1e-9);
  }, 300_000);

  it('refuses preparation settings outside the model, and a removal the kernel cannot make', async () => {
    const doc = f12Holes();
    for (const bad of [
      { ...keep, removeHolesBelow: -1 },
      { ...keep, removeFilletsBelow: Number.POSITIVE_INFINITY },
      { ...keep, removeFaces: [999] },
      { ...keep, removeFaces: [0, 0] },
    ])
      expect(await prepared(doc, 'part', bad)).toEqual({ code: 'analysis-preparation' });
    const plain = surfaceOfResult(await prepared(doc, 'part', keep));
    const top = facesOn(plain, 2, 20);
    expect(await prepared(doc, 'part', { ...keep, removeFaces: top })).toEqual({
      code: 'analysis-preparation-failed',
    });
  }, 300_000);

  it('refuses a body that is not there and a deflection outside the model', async () => {
    const doc = f02Plate();
    const missing = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId: 'nope', deflectionMm: 0.1 },
    });
    expect(missing.analysisSurface).toEqual({ code: 'analysis-body-missing' });
    const zero = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId: 'plate', deflectionMm: 0 },
    });
    expect(zero.analysisSurface).toEqual({ code: 'analysis-deflection' });
    for (const wanted of [
      { bodyId: 'plate', deflectionMm: 11 },
      { bodyId: 'plate', deflectionMm: 1e-4 },
      { bodyId: 'plate', deflectionMm: 0.1, angularDeflectionRad: 0 },
      { bodyId: 'plate', deflectionMm: 0.1, angularDeflectionRad: 2 },
    ]) {
      const r = await evaluateCad(oc, doc, cadContentHash(doc), { analysisSurface: wanted });
      expect(r.analysisSurface).toEqual({ code: 'analysis-deflection' });
    }
    // R3e-3: with clampDeflection the body's smallest raises a fine request; too coarse still fails.
    const raised = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId: 'plate', deflectionMm: 1e-4, clampDeflection: true },
    });
    expect(raised.analysisSurface && 'surface' in raised.analysisSurface).toBe(true);
    const coarse = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId: 'plate', deflectionMm: 11, clampDeflection: true },
    });
    expect(coarse.analysisSurface).toEqual({ code: 'analysis-deflection' });
  }, 120_000);
});
