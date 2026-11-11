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
  f13ShellDraft,
  f18Hood,
  f18HoodArea,
  f18Sheets,
  f18WindowArea,
  faceRef,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { evaluateCad, type CadAnalysisSurface, type CadAnalysisSurfaceResult } from './index';

const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

/** An 80 × 50 plate extruded `t` mm up from z = 0. */
const plate = (t: number): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'outline',
        name: 'Outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(80), height: mm(50) },
      },
    ],
    features: [
      {
        id: 'slab',
        name: 'Slab',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'outline', distance: mm(t), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'slab-body',
        name: 'Slab',
        sourceFeatureId: 'slab',
        placementFeatureId: 'slab-placement',
        appearance: { color: '#999999', opacity: 1 },
      },
    ],
  });

/** The triangles' area, and each face's. */
const areas = (s: CadAnalysisSurface) => {
  const perFace = new Array<number>(s.shapeFaces).fill(0);
  for (let k = 0; k < s.faces.length; k++) {
    const [a, b, c] = [0, 1, 2].map((j) => 3 * s.triangles[3 * k + j]!);
    const u = [0, 1, 2].map((d) => s.points[b! + d]! - s.points[a! + d]!);
    const v = [0, 1, 2].map((d) => s.points[c! + d]! - s.points[a! + d]!);
    perFace[s.faces[k]!]! +=
      Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ) / 2;
  }
  return { total: perFace.reduce((x, y) => x + y, 0), perFace };
};

describe.skipIf(!available)(
  'the midsurface of a body of uniform thickness (R3i-2, TS-1392, ST-203)',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oc: any;
    beforeAll(async () => {
      const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
      expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
      globalThis.require ??= createRequire(import.meta.url);
      const { default: factory } = await import(
        pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
      );
      oc = await factory({ wasmBinary: wasm });
    }, 300_000);

    const midsurface = async (
      cad: CadDocument,
      bodyId: string,
      maxEdgeMm = 10,
    ): Promise<CadAnalysisSurfaceResult> => {
      const r = await evaluateCad(oc, cad, cadContentHash(cad), {
        analysisSurface: {
          bodyId,
          deflectionMm: 0.05,
          clampDeflection: true,
          maxEdgeMm,
          idealisation: 'shell',
        },
      });
      if (!r.analysisSurface)
        throw new Error(`no analysis surface: ${JSON.stringify(r).slice(0, 300)}`);
      return r.analysisSurface;
    };
    const surfaceOf = async (cad: CadDocument, bodyId: string, maxEdgeMm?: number) => {
      const r = await midsurface(cad, bodyId, maxEdgeMm);
      if (!('surface' in r)) throw new Error(`${r.code}: ${r.detail}`);
      return r.surface;
    };

    it('puts a thin extrude at half its height, its caps on the face and its sides on the edges', async () => {
      const s = await surfaceOf(plate(4), 'slab-body');
      expect(s.shell).toEqual({ thicknessMm: 4 });
      expect(s.shapeFaces).toBe(1);
      for (let p = 0; p < s.points.length / 3; p++) expect(s.points[3 * p + 2]).toBeCloseTo(2, 9);
      expect(areas(s).total).toBeCloseTo(80 * 50, 6);
      // Both caps become the face; each of the four sides becomes one edge of length 80 or 50.
      const sides = s.history.faces.filter((f) => f.deleted);
      expect(s.history.faces.filter((f) => !f.deleted).map((f) => f.images)).toEqual([[0], [0]]);
      // The end cap faces away from the start cap, whose outward normal the midsurface keeps.
      const cap = (name: string) => s.bodyTopology.faces.findIndex((f) => f.name?.[0] === name);
      expect(s.history.faces[cap('start')]!.reversed).toBeUndefined();
      expect(s.history.faces[cap('end')]!.reversed).toBe(true);
      const n = s.measures.faceVectorAreas;
      expect(n[2]! / Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(-1, 9);
      expect(sides.length).toBe(4);
      expect(new Set(sides.flatMap((f) => f.edges)).size).toBe(4);
      for (const side of sides) expect(side.edges!.length).toBe(1);
      expect([...s.measures.edgeLengths].sort((a, b) => a - b)).toEqual([
        expect.closeTo(50, 6),
        expect.closeTo(50, 6),
        expect.closeTo(80, 6),
        expect.closeTo(80, 6),
      ]);
    }, 120_000);

    it('offsets the F18 hood skin to its middle radius, the window rim becoming edges', async () => {
      const s = await surfaceOf(f18Hood(), 'left');
      expect(s.shell!.thicknessMm).toBeCloseTo(1.5, 12);
      // The skin lies between r = 98.5 and r = 100 about the y axis: its middle at 99.25.
      for (let p = 0; p < s.points.length / 3; p++)
        expect(Math.hypot(s.points[3 * p]!, s.points[3 * p + 2]!)).toBeCloseTo(99.25, 2);
      const expected = (99.25 / 100) * (f18HoodArea - f18WindowArea);
      // The crown is a fill, close to the cylinder but not on it.
      expect(Math.abs(s.measures.faceAreas.reduce((x, y) => x + y, 0) / expected - 1)).toBeLessThan(
        1e-4,
      );
      expect(Math.abs(areas(s).total / expected - 1)).toBeLessThan(2e-3);
      // Every face of the body is a wall (one image) or a side along midsurface edges.
      for (const f of s.history.faces)
        expect(f.deleted ? f.edges!.length > 0 : f.images.length === 1).toBe(true);
    }, 120_000);

    it('takes a sheet thickened each way to the middle of its wall', async () => {
      for (const [side, z] of [
        ['front', 0.75],
        ['back', -0.75],
        ['both', 0],
      ] as const) {
        const s = await surfaceOf(f18Sheets({ kind: 'thicken', sheet: 'plate', side }), 'surface');
        for (let p = 0; p < s.points.length / 3; p++) expect(s.points[3 * p + 2]).toBeCloseTo(z, 9);
        expect(areas(s).total).toBeCloseTo(40 * 40, 6);
        // The face and inner/face become the midsurface; the four sides its four edges.
        expect(s.history.faces.filter((f) => f.deleted).map((f) => f.edges!.length)).toEqual([
          1, 1, 1, 1,
        ]);
      }
    }, 120_000);

    it('gives the inner wall of a shelled box half the thickness in from its faces', async () => {
      const s = await surfaceOf(f13ShellDraft({ draft: false }), 'part');
      expect(s.shell!.thicknessMm).toBe(2);
      // 100 × 60 × 20 box, 2 mm inside, open at the top: floor at z = 1, walls 1 mm in.
      const expected = 98 * 58 + 2 * (98 + 58) * 19;
      expect(Math.abs(s.measures.faceAreas.reduce((x, y) => x + y, 0) / expected - 1)).toBeLessThan(
        1e-6,
      );
      expect(s.shapeFaces).toBe(5);
      // Ten wall faces (outside and inside) become the five; the rim, one flat frame at z = 20,
      // the four top edges.
      expect(s.history.faces.filter((f) => !f.deleted).length).toBe(10);
      const rims = s.history.faces.filter((f) => f.deleted);
      expect(rims.map((r) => r.edges!.length)).toEqual([4]);
      // A vertical outside corner edge and the inside one both become the midsurface's corner.
      const corners = s.history.edges.filter((e) => e.images.length === 1).length;
      expect(corners).toBeGreaterThanOrEqual(2 * 8);
    }, 120_000);

    it('keeps every rim edge of a narrow shelled box, trimmed at the corners', async () => {
      // The review's case: 100 × 3 × 20, 1 mm walls inside, open at the top. Each short rim edge is
      // 3 mm outside, 2 mm on the midsurface and 1 mm inside.
      let doc = applyCadOperation(f01Empty(), {
        type: 'insertFeatures',
        features: [
          {
            id: 'block',
            name: 'Block',
            type: 'box',
            inputFeatureIds: [],
            args: {
              size: [mm(100), mm(3), mm(20)],
              origin: position(0, 0, 0),
              orientation: identityQuaternion(),
            },
          },
        ],
        bodies: [
          {
            id: 'part',
            name: 'Part',
            sourceFeatureId: 'block',
            placementFeatureId: 'part-placement',
            appearance: { color: '#999999', opacity: 1 },
          },
        ],
      });
      doc = applyCadOperation(doc, {
        type: 'detailBody',
        bodyId: 'part',
        placementFeatureId: 'shell-placement',
        feature: {
          id: 'shell',
          name: 'Shell',
          type: 'shell',
          inputFeatureIds: ['part-placement'],
          args: {
            openFaces: [faceRef('part-placement', ['+z'], [50, 1.5, 20], 300)],
            thickness: mm(1),
            side: 'inside',
          },
        },
      });
      const s = await surfaceOf(doc, 'part', 2);
      // The rim frame runs along all four top edges of the midsurface.
      expect(s.history.faces.filter((f) => f.deleted).map((f) => f.edges!.length)).toEqual([4]);
      // Its eight edges (outer and inner) each become one of them, the short ones included.
      const rim = s.history.faces.findIndex((f) => f.deleted);
      const rimEdges = s.bodyTopology.edges.flatMap((e, k) => (e.faces.includes(rim) ? [k] : []));
      expect(rimEdges.length).toBe(8);
      for (const k of rimEdges) expect(s.history.edges[k]!.images.length).toBe(1);
    }, 120_000);

    it('maps each circle of a thin ring to its own radius, not the other', async () => {
      // The review's case: radii 99 and 100, 1 mm high. Both midsurface circles border the one
      // face, so only where they lie tells them apart, 0.5 mm off by a curve, not its polyline.
      const doc = applyCadOperation(f01Empty(), {
        type: 'insertFeatures',
        sketches: [
          {
            id: 'ring-sketch',
            name: 'Ring',
            plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
            entities: [
              { type: 'point', id: 'o' },
              { type: 'point', id: 'ro' },
              { type: 'point', id: 'ri' },
              { type: 'circle', id: 'outer', center: 'o' },
              { type: 'circle', id: 'inner', center: 'o' },
            ],
            constraints: [],
            solved: { o: [0, 0], ro: [0, 0], ri: [0, 0], outer: [100, 0], inner: [99, 0] },
          },
        ],
        features: [
          {
            id: 'ring',
            name: 'Ring',
            type: 'extrude',
            inputFeatureIds: [],
            args: {
              sketchId: 'ring-sketch',
              region: { outer: ['outer'], holes: [['inner']] },
              distance: mm(1),
              direction: 1,
            },
          },
        ],
        bodies: [
          {
            id: 'ring-body',
            name: 'Ring',
            sourceFeatureId: 'ring',
            placementFeatureId: 'ring-placement',
            appearance: { color: '#999999', opacity: 1 },
          },
        ],
      });
      const s = await surfaceOf(doc, 'ring-body', 20);
      expect(s.shell).toEqual({ thicknessMm: 1 });
      // Each cylindrical side becomes the one midsurface circle of its own radius.
      const radius = (k: number) => s.measures.edgeLengths[k]! / (2 * Math.PI);
      const sides = s.history.faces.filter((f) => f.deleted);
      expect(sides.map((f) => f.edges!.length)).toEqual([1, 1]);
      expect(sides.map((f) => radius(f.edges![0]!)).sort((a, b) => a - b)).toEqual([
        expect.closeTo(99, 2),
        expect.closeTo(100, 2),
      ]);
      // And each body circle (top and bottom of both sides) one image.
      for (const e of s.history.edges) expect(e.images.length).toBeLessThanOrEqual(1);
      expect(s.history.edges.filter((e) => e.images.length === 1).length).toBe(4);
    }, 120_000);

    it('refuses what has no midsurface, saying why', async () => {
      const refused = async (cad: CadDocument, bodyId: string) => {
        const r = await midsurface(cad, bodyId);
        expect('code' in r && r.code).toBe('midsurface-unsupported');
        return 'detail' in r ? r.detail : '';
      };
      // A hole cut after the extrude.
      expect(await refused(f02Plate(), 'plate')).toMatch(/boolean/);
      // 20 mm is more than a tenth of a 80 × 50 midsurface's size.
      expect(await refused(plate(20), 'slab-body')).toMatch(/tenth/);
    }, 120_000);
  },
);
