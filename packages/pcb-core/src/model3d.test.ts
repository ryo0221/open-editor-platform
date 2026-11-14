import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { validateGeometry, type GeometryVec3 } from '@editor-platform/geometry-core';
import type { GeometryResult, OcModule } from '@editor-platform/geometry-kernel-occt';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  componentTransform,
  loopArea,
  pcbPartsSample,
  pcbModel3d,
  pcbPlacementProblems,
  validatePcb,
} from './index';

// PB7a 3D model (ST-467): graph TS-1939, placement TS-1940, kernel TS-1941.

const board = pcbPartsSample;

describe('PB7a board and parts in 3D', () => {
  it('TS-1939: makes a valid graph: the board with its holes and a piece per material', () => {
    const doc = board();
    expect(validatePcb(doc)).toEqual([]);
    expect(pcbPlacementProblems(doc)).toEqual([]);
    const model = pcbModel3d(doc);
    expect(validateGeometry(model.graph)).toEqual([]);
    const boardOp = model.graph.nodes.board!;
    expect(boardOp.op).toBe('prism');
    if (boardOp.op !== 'prism') return;
    expect(boardOp.vector).toEqual([0, 0, doc.board.thicknessMm]);
    // 4 mounting holes + every through and unplated pad's drill.
    const drills = doc.components.flatMap((c) =>
      doc.footprints.find((f) => f.id === c.footprint)!.pads.filter((p) => p.type !== 'smd'),
    );
    expect(boardOp.holes!.length).toBe(4 + drills.length);
    expect(model.omittedHoles).toBe(0);
    expect(model.parts[0]).toMatchObject({ node: 'board', material: 'board', color: '#1f6b3a' });
    // Every part has at least one piece, named by its reference.
    for (const c of doc.components) {
      const pieces = model.parts.filter((p) => p.component === c.id);
      expect(pieces.length, c.ref).toBeGreaterThan(0);
      for (const p of pieces) expect(p.name.startsWith(`${c.ref} `)).toBe(true);
    }
    const roles = (k: string) =>
      model.parts
        .filter((p) => p.component === `p-${k}`)
        .map((p) => [p.name.split(' ')[1], p.material]);
    expect(roles('pin-header')).toEqual([
      ['body', 'plastic'],
      ['pins', 'gold'],
    ]);
    expect(roles('usb-c')).toEqual([
      ['shell', 'metal'],
      ['tongue', 'plastic'],
    ]);
    expect(roles('soic')).toEqual([
      ['body', 'plastic'],
      ['leads', 'metal'],
    ]);
    // The connector ports are cut from their shells.
    const rj = model.graph.nodes[`p-rj45\u0000shell`]!;
    expect(rj.op === 'transform' && model.graph.nodes[rj.input]!.op).toBe('boolean');
    // Numbers the generator refuses (a document may carry any finite numbers), and a footprint
    // without a generator: the courtyard's box at the part's height, so the board still builds.
    const odd = {
      ...doc,
      footprints: doc.footprints.map((f) =>
        f.id === 'bga'
          ? { ...f, generator: { kind: 'bga', params: { ...f.generator!.params, bodyX: 0 } } }
          : f.id === 'qfn'
            ? (({ generator: _, ...rest }) => rest)(f)
            : f,
      ),
    };
    expect(validatePcb(odd)).toEqual([]);
    const fallback = pcbModel3d(odd);
    expect(validateGeometry(fallback.graph)).toEqual([]);
    for (const k of ['bga', 'qfn'])
      expect(
        fallback.parts
          .filter((p) => p.component === `p-${k}`)
          .map((p) => [p.name.split(' ')[1], p.material]),
      ).toEqual([['body', 'plastic']]);
  });

  it('TS-1940: places top parts on the top face and bottom parts mirrored under the board', () => {
    const doc = board();
    const model = pcbModel3d(doc);
    const t = doc.board.thicknessMm;
    const apply = (node: string, p: GeometryVec3): GeometryVec3 => {
      const op = model.graph.nodes[node]!;
      if (op.op !== 'transform') throw new Error(node);
      const r = op.rotation;
      return [0, 1, 2].map(
        (i) => r[3 * i]! * p[0] + r[3 * i + 1]! * p[1] + r[3 * i + 2]! * p[2] + op.translation[i]!,
      ) as GeometryVec3;
    };
    for (const c of doc.components) {
      const node = model.parts.find((p) => p.component === c.id)!.node;
      const plan = componentTransform(c)([1.5, -0.75]);
      const [x, y, z] = apply(node, [1.5, -0.75, 2]);
      expect(x).toBeCloseTo(plan[0], 9);
      expect(y).toBeCloseTo(plan[1], 9);
      // Up from the face it sits on: above the top, or below the bottom.
      expect(z).toBeCloseTo(c.side === 'top' ? t + 2 : -2, 9);
    }
    // More drills than the kernel takes: the board keeps the parts' holes and drops vias.
    const vias = Array.from({ length: 1100 }, (_, i) => ({
      id: `v${i}`,
      net: undefined as unknown as string,
      at: [6 + (i % 40) * 1.8, 8 + Math.floor(i / 40) * 1.4] as [number, number],
      diameterMm: 0.45,
      drillMm: 0.2,
    }));
    const crowded = pcbModel3d({ ...doc, vias });
    const op = crowded.graph.nodes.board!;
    expect(op.op === 'prism' && op.holes!.length).toBe(1000);
    expect(crowded.omittedHoles).toBeGreaterThan(0);
    expect(validateGeometry(crowded.graph)).toEqual([]);
  });
});

/** The kernel run (opt-in): `CAD_OCCT_DIST`, the shared development build. */
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('PB7a with the development build', () => {
  let oc: OcModule;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
  }, 120_000);

  it('TS-1941: builds every piece; the board is its area less its holes times its thickness', async () => {
    const { evaluateGeometry } = await import('@editor-platform/geometry-kernel-occt');
    const doc = board();
    const model = pcbModel3d(doc);
    const evaluation = await evaluateGeometry(
      oc,
      model.graph,
      model.parts.map((p) => ({ node: p.node, measure: true })),
    );
    expect(evaluation.status).toBe('ok');
    if (evaluation.status !== 'ok') return;
    const byNode = new Map(evaluation.results.map((r) => [r.node, r]));
    const ok = (r: GeometryResult | undefined) => {
      if (r?.status !== 'ok') throw new Error(JSON.stringify(r));
      return r.measure!;
    };
    const boardOp = model.graph.nodes.board!;
    if (boardOp.op !== 'prism') throw new Error('board');
    const area =
      loopArea(doc.board.outline) - boardOp.holes!.reduce((s, h) => s + Math.abs(loopArea(h)), 0);
    const b = ok(byNode.get('board'));
    expect(b.volumeMm3).toBeCloseTo(area * doc.board.thicknessMm, 6);
    const t = doc.board.thicknessMm;
    for (const p of model.parts.slice(1)) {
      const m = ok(byNode.get(p.node));
      expect(m.volumeMm3, p.name).toBeGreaterThan(0);
      const c = doc.components.find((x) => x.id === p.component)!;
      const [[, , z0], [, , z1]] = m.bounds;
      // Pins pass through the board; every other piece stays on its side.
      if (p.name.endsWith(' pins')) continue;
      if (c.side === 'top') expect(z0, p.name).toBeGreaterThanOrEqual(t - 1e-6);
      else expect(z1, p.name).toBeLessThanOrEqual(1e-6);
    }
  }, 120_000);
});
