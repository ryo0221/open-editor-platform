import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { f30Fixtures, type GeometryGraph, type GeometryVec3 } from '@editor-platform/geometry-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import type { OcModule } from './module';
import { evaluateGeometry, type GeometryResult } from './ops';

/**
 * F30 (R2c-1b, CAD60): every geometry op against the shared development build. Opt-in: it needs
 * the build (`CAD_OCCT_DIST`, the kernel build CAD and bim share).
 */
const dist = process.env.CAD_OCCT_DIST;
const near = (actual: number, expected: number, relative = 1e-9) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relative + 1e-6);
const ok = (r: GeometryResult | undefined) => {
  if (r?.status !== 'ok') throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r;
};
const length = (line: Float64Array) => {
  let l = 0;
  for (let i = 3; i < line.length; i += 3)
    l += Math.hypot(
      line[i]! - line[i - 3]!,
      line[i + 1]! - line[i - 2]!,
      line[i + 2]! - line[i - 1]!,
    );
  return l;
};
const segmentsLength = (s: Float64Array) => {
  let l = 0;
  for (let i = 0; i < s.length; i += 4) l += Math.hypot(s[i + 2]! - s[i]!, s[i + 3]! - s[i + 1]!);
  return l;
};
/** Closed loops among polylines: chains of shared end points that come back to their start. */
const loops = (lines: Float64Array[]) => {
  const key = (l: Float64Array, end: boolean) => {
    const i = end ? l.length - 3 : 0;
    return [l[i]!, l[i + 1]!, l[i + 2]!].map((v) => v.toFixed(3)).join(',');
  };
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    while (parent.get(k) !== k) k = parent.get(k)!;
    return k;
  };
  for (const l of lines)
    for (const k of [key(l, false), key(l, true)]) if (!parent.has(k)) parent.set(k, k);
  for (const l of lines) parent.set(find(key(l, false)), find(key(l, true)));
  return new Set([...parent.keys()].map(find)).size;
};

describe.skipIf(!dist)('geometry ops with the development build (F30)', () => {
  let oc: OcModule;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
  }, 120_000);

  it('builds every F30 fixture to its analytic values', async () => {
    for (const [name, fixture] of Object.entries(f30Fixtures)) {
      const { graph, requests, expect: expected } = fixture();
      const evaluation = await evaluateGeometry(oc, graph, requests);
      expect(evaluation.status, name).toBe('ok');
      if (evaluation.status !== 'ok') continue;
      for (const r of evaluation.results) {
        const result = ok(r);
        const e = expected[result.node]!;
        if (e.volumeMm3 !== undefined) near(result.measure!.volumeMm3, e.volumeMm3);
        if (e.areaMm2 !== undefined) near(result.measure!.areaMm2, e.areaMm2);
        if (e.bounds)
          result.measure!.bounds.flat().forEach((v, i) => near(v, e.bounds!.flat()[i]!, 1e-7));
        if (e.section) {
          const total = result.section!.reduce((s, l) => s + length(l), 0);
          // Circles become chords of 1/128 turn: within 0.01 % of their length.
          near(total, e.section.lengthMm, 1e-4);
          expect(loops(result.section!), name).toBe(e.section.loops);
        }
        if (e.projection) {
          near(segmentsLength(result.projection!.visible), e.projection.visibleMm, 1e-9);
          near(segmentsLength(result.projection!.hidden), e.projection.hiddenMm, 1e-9);
        }
      }
    }
  });

  it('meshes a node with outward normals and a face per triangle', async () => {
    const { graph } = f30Fixtures.prism();
    const evaluation = await evaluateGeometry(oc, graph, [
      { node: 'slab', mesh: { deflectionMm: 0.5, angularDeflectionRad: 0.1 } },
    ]);
    const { mesh } = ok(evaluation.status === 'ok' ? evaluation.results[0] : undefined);
    expect(mesh!.indices.length / 3).toBe(mesh!.faceIndices.length);
    // The signed volume of the triangles is the slab's: they wind outwards.
    let v = 0;
    const p = mesh!.positions;
    for (let i = 0; i < mesh!.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => mesh!.indices[i + k]! * 3);
      v +=
        (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
          p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
          p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
        6;
    }
    near(v, f30Fixtures.prism().expect.slab!.volumeMm3!, 2e-3);
  });

  it('names the node that failed and keeps the other requests', async () => {
    const cube = f30Fixtures.boolean().graph.nodes.a!;
    const graph: GeometryGraph = {
      nodes: {
        a: cube,
        far: {
          op: 'transform',
          input: 'a',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [500, 0, 0],
        },
        none: { op: 'boolean', kind: 'common', target: 'a', tools: ['far'] },
        moved: {
          op: 'transform',
          input: 'none',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, 0, 1],
        },
        missing: { op: 'brep', asset: 'x' },
      },
    };
    const evaluation = await evaluateGeometry(oc, graph, [
      { node: 'moved', measure: true },
      { node: 'missing', measure: true },
      { node: 'a', measure: true },
    ]);
    expect(
      evaluation.status === 'ok' &&
        evaluation.results.map((r) => (r.status === 'error' ? `${r.code}@${r.node}` : 'ok')),
    ).toEqual(['empty-result@none', 'asset-missing@missing', 'ok']);
    // An invalid graph is not run.
    const bad = await evaluateGeometry(oc, { nodes: { a: cube } }, [{ node: 'b', measure: true }]);
    expect(bad.status).toBe('invalid');
  });

  it('builds a chain as long as validation allows without recursion', async () => {
    // 20,000 transforms over a missing asset: the walk reaches the asset, which fails, and every
    // node above it fails with the same error without being built.
    const nodes: GeometryGraph['nodes'] = { base: { op: 'brep', asset: 'x' } };
    let last = 'base';
    for (let i = 0; i < 20_000; i++) {
      nodes[`t${i}`] = {
        op: 'transform',
        input: last,
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        translation: [0, 0, 1],
      };
      last = `t${i}`;
    }
    const built: string[] = [];
    const evaluation = await evaluateGeometry(oc, { nodes }, [{ node: last, measure: true }], {
      checkpoint: (id) => void built.push(id),
    });
    expect(
      evaluation.status === 'ok' &&
        evaluation.results.map((r) => (r.status === 'error' ? `${r.code}@${r.node}` : 'ok')),
    ).toEqual(['asset-missing@base']);
    expect(built).toEqual(['base']);
  });

  it('cuts a sloped plane exactly where the half-space ends', async () => {
    const { graph } = f30Fixtures.halfSpace();
    const evaluation = await evaluateGeometry(oc, graph, [
      { node: 'below', section: { origin: [50, 0, 0], normal: [1, 0, 0] } },
    ]);
    const lines = ok(evaluation.status === 'ok' ? evaluation.results[0] : undefined).section!;
    // At x = 50 the plane is at 55 mm: the cut is a 100 × 55 rectangle.
    near(
      lines.reduce((s, l) => s + length(l), 0),
      2 * (100 + 55),
      1e-9,
    );
    const zs: GeometryVec3[] = lines.flatMap((l) => [[l[0]!, l[1]!, l[2]!]]);
    expect(Math.max(...zs.map((p) => p[2]))).toBeCloseTo(55, 6);
  });

  it('keeps the faces of a sheet on the kept side, and empties a sheet wholly on the other', async () => {
    // A 100 × 100 vertical sheet in the x-z plane, from z = 0 to 100.
    const face = new oc.BRepBuilderAPI_MakeFace_9(
      new oc.gp_Pln_3(new oc.gp_Pnt_3(0, 0, 50), new oc.gp_Dir_4(0, 1, 0)),
      -50,
      50,
      -50,
      50,
    ).Face();
    const path = '/sheet-test.brep';
    expect(oc.BRepTools.Write_3(face, path, new oc.Message_ProgressRange_1())).toBe(true);
    const bytes = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    const graph: GeometryGraph = {
      nodes: {
        sheet: { op: 'brep', asset: 's' },
        below: {
          op: 'halfSpace',
          input: 'sheet',
          origin: [0, 0, 40],
          normal: [0, 0, 1],
          keep: 'below',
        },
        gone: {
          op: 'halfSpace',
          input: 'sheet',
          origin: [0, 0, 400],
          normal: [0, 0, 1],
          keep: 'above',
        },
      },
    };
    const evaluation = await evaluateGeometry(
      oc,
      graph,
      [
        { node: 'sheet', measure: true },
        { node: 'below', measure: true },
        { node: 'gone', measure: true },
      ],
      { assets: new Map([['s', bytes]]) },
    );
    if (evaluation.status !== 'ok') throw new Error(evaluation.status);
    const [whole, below, gone] = evaluation.results;
    near(ok(whole).measure!.areaMm2, 100 * 100, 1e-6);
    near(ok(below).measure!.areaMm2, 100 * 40, 1e-6);
    expect(gone).toMatchObject({ status: 'error', code: 'empty-result', node: 'gone' });
  });

  it('keeps the sheet of a mixed body when the clip leaves no solid, and tells its bodies apart', async () => {
    const face = new oc.BRepBuilderAPI_MakeFace_9(
      new oc.gp_Pln_3(new oc.gp_Pnt_3(0, 0, 50), new oc.gp_Dir_4(0, 1, 0)),
      -50,
      50,
      -50,
      50,
    ).Face();
    const path = '/mixed-test.brep';
    expect(oc.BRepTools.Write_3(face, path, new oc.Message_ProgressRange_1())).toBe(true);
    const bytes = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    const cube = f30Fixtures.boolean().graph.nodes.a!;
    const graph: GeometryGraph = {
      nodes: {
        cube,
        sheet: { op: 'brep', asset: 's' },
        // The sheet 500 mm in front of the cube (at y = −500).
        away: {
          op: 'transform',
          input: 'sheet',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, -500, 0],
        },
        mixed: { op: 'compound', inputs: ['cube', 'away'] },
        front: {
          op: 'halfSpace',
          input: 'mixed',
          origin: [0, -200, 0],
          normal: [0, 1, 0],
          keep: 'below',
        },
        solids: { op: 'bodies', input: 'mixed', kind: 'solid' },
        sheets: { op: 'bodies', input: 'mixed', kind: 'sheet' },
        none: { op: 'bodies', input: 'cube', kind: 'sheet' },
      },
    };
    const evaluation = await evaluateGeometry(
      oc,
      graph,
      ['cube', 'front', 'solids', 'sheets', 'none'].map((node) => ({ node, measure: true })),
      { assets: new Map([['s', bytes]]) },
    );
    if (evaluation.status !== 'ok') throw new Error(evaluation.status);
    const [whole, front, solids, sheets, none] = evaluation.results;
    // The clip removes the cube and keeps the whole sheet.
    near(ok(front).measure!.areaMm2, 100 * 100, 1e-6);
    near(ok(front).measure!.volumeMm3, 0, 1e-6);
    near(ok(solids).measure!.volumeMm3, ok(whole).measure!.volumeMm3, 1e-9);
    near(ok(sheets).measure!.areaMm2, 100 * 100, 1e-6);
    expect(none).toMatchObject({ status: 'error', code: 'empty-result', node: 'none' });
  });

  it('outlines overlapping solids once in a section, without fusing them', async () => {
    const cube = f30Fixtures.halfSpace().graph.nodes.a!;
    const graph: GeometryGraph = {
      nodes: {
        cube,
        // A second 100 mm cube half way along x: they share half their volume.
        moved: {
          op: 'transform',
          input: 'cube',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [50, 0, 0],
        },
        both: { op: 'compound', inputs: ['cube', 'moved'] },
        solids: { op: 'bodies', input: 'both', kind: 'solid' },
        // A second cube above the first: the plane meets only one of the two.
        above: {
          op: 'transform',
          input: 'cube',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, 0, 200],
        },
        stacked: { op: 'compound', inputs: ['cube', 'above'] },
      },
    };
    const evaluation = await evaluateGeometry(oc, graph, [
      { node: 'solids', measure: true },
      { node: 'solids', section: { origin: [0, 0, 50], normal: [0, 0, 1] } },
      { node: 'stacked', section: { origin: [0, 0, 50], normal: [0, 0, 1] } },
    ]);
    if (evaluation.status !== 'ok') throw new Error(evaluation.status);
    const [m, cut, one] = evaluation.results;
    // The solids are kept apart: their volumes add up.
    near(ok(m).measure!.volumeMm3, 2 * 100 * 100 * 100, 1e-9);
    // One outline, 150 × 100, around both.
    near(
      ok(cut).section!.reduce((t, l) => t + length(l), 0),
      2 * (150 + 100),
      1e-9,
    );
    near(
      ok(one).section!.reduce((t, l) => t + length(l), 0),
      4 * 100,
      1e-9,
    );
  });

  it('clips overlapping solids one by one, so the kept pieces are each valid', async () => {
    const cube = f30Fixtures.halfSpace().graph.nodes.a!;
    const graph: GeometryGraph = {
      nodes: {
        cube,
        moved: {
          op: 'transform',
          input: 'cube',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [50, 0, 0],
        },
        // A part's bodies: two solids sharing half their volume, not fused.
        both: { op: 'compound', inputs: ['cube', 'moved'] },
        clipped: {
          op: 'halfSpace',
          input: 'both',
          origin: [0, 40, 0],
          normal: [0, 1, 0],
          keep: 'below',
        },
        gone: {
          op: 'halfSpace',
          input: 'both',
          origin: [0, -10, 0],
          normal: [0, 1, 0],
          keep: 'below',
        },
      },
    };
    const evaluation = await evaluateGeometry(oc, graph, [
      { node: 'clipped', measure: true },
      { node: 'clipped', section: { origin: [0, 0, 50], normal: [0, 0, 1] } },
      { node: 'gone', measure: true },
    ]);
    if (evaluation.status !== 'ok') throw new Error(evaluation.status);
    const [clipped, cut, gone] = evaluation.results;
    // Cut together, the two overlapping cubes gave an invalid shape (`invalid-shape`).
    near(ok(clipped).measure!.volumeMm3, 2 * 100 * 40 * 100, 1e-9);
    // What is kept of both is outlined once: 150 × 40.
    near(
      ok(cut).section!.reduce((t, l) => t + length(l), 0),
      2 * (150 + 40),
      1e-9,
    );
    expect(gone).toMatchObject({ status: 'error', code: 'empty-result', node: 'gone' });
  });

  it('frees every handle it made (the leak check of the D0 build)', async () => {
    const run = async () => {
      for (const fixture of Object.values(f30Fixtures)) {
        const { graph, requests } = fixture();
        await evaluateGeometry(oc, graph, [
          ...requests,
          { node: requests[0]!.node, mesh: { deflectionMm: 0.5, angularDeflectionRad: 0.1 } },
        ]);
      }
      // Overlapping solids: clipped one by one, and outlined once in a section.
      const cube = f30Fixtures.halfSpace().graph.nodes.a!;
      await evaluateGeometry(
        oc,
        {
          nodes: {
            cube,
            moved: {
              op: 'transform',
              input: 'cube',
              rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
              translation: [50, 0, 0],
            },
            both: { op: 'compound', inputs: ['cube', 'moved'] },
            clipped: {
              op: 'halfSpace',
              input: 'both',
              origin: [0, 40, 0],
              normal: [0, 1, 0],
              keep: 'below',
            },
          },
        },
        [{ node: 'clipped', measure: true, section: { origin: [0, 0, 50], normal: [0, 0, 1] } }],
      );
    };
    await run();
    await run();
    const before = oc.OCJS.heapAllocatedBytes() as number;
    for (let i = 0; i < 5; i++) await run();
    const grown = (oc.OCJS.heapAllocatedBytes() as number) - before;
    expect(grown).toBeLessThan(64 * 1024);
  }, 120_000);
});
