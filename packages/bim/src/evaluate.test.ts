import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  bimPanelMm,
  deriveBim,
  f31BoxBuilding,
  f33Types,
  f37Office,
  f39Roofs,
  type BimDocument,
} from '@editor-platform/bim-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  bimDirectKernel,
  bimEvaluationLimits,
  BimEvaluator,
  type BimEvaluation,
  type BimKernel,
} from './evaluate';

/**
 * CAD62 (kernel against analytic quantities) and CAD64 (evaluation) for R2c-3a, against the
 * shared development build. Opt-in: it needs the build (`CAD_OCCT_DIST`).
 */
const dist = process.env.CAD_OCCT_DIST;
const ok = (e: BimEvaluation) => {
  if (e.status !== 'ok') throw new Error(e.status);
  return e;
};
const near = (actual: number, expected: number, relative = 1e-9) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relative + 1e-3);

// Kernel jobs share the CPU with the whole suite: 5 s is too short there.
describe.skipIf(!dist)('bim evaluation (R2c-3a)', { timeout: 60_000 }, () => {
  let oc: OcModule;
  let kernel: BimKernel;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
    kernel = bimDirectKernel(oc);
  }, 120_000);

  /** Every element's kernel volume against its analytic volume (CAD62). */
  const checkVolumes = (doc: BimDocument, e: BimEvaluation & { status: 'ok' }) => {
    const derived = deriveBim(doc);
    let checked = 0;
    for (const el of doc.elements) {
      const r = e.elements.get(el.id);
      if (el.kind === 'opening') {
        expect(r, el.id).toBeUndefined();
        continue;
      }
      if (r?.status !== 'ok') throw new Error(`${el.id}: ${JSON.stringify(r)}`);
      expect(r.mesh.indices.length, el.id).toBeGreaterThan(0);
      const q = derived.quantities.get(el.id)!;
      const analytic =
        el.kind === 'door' || el.kind === 'window'
          ? (() => {
              const t = doc.types.find((x) => x.id === el.typeId)!;
              return 'widthMm' in t && 'heightMm' in t ? t.widthMm * t.heightMm * bimPanelMm : 0;
            })()
          : (q.values.netVolume ?? q.values.grossVolume);
      if (q.source === 'kernel') continue;
      near(r.measure.volumeMm3, analytic!, 1e-6);
      checked++;
    }
    return checked;
  };

  it('builds every element of the box building to its analytic volume', async () => {
    const doc = f31BoxBuilding();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    expect(checkVolumes(doc, e)).toBe(doc.elements.filter((x) => x.kind !== 'opening').length);
    expect(e.kernelQuantities.size).toBe(0);
  });

  it('builds a type once and re-evaluates only what an edit changed (CAD64)', async () => {
    const evaluator = new BimEvaluator(kernel);
    const doc = f33Types();
    const first = ok(await evaluator.evaluate(doc));
    checkVolumes(doc, first);
    // The wall and one window solid for 40 windows.
    expect(first.sent.solids).toBe(2);
    const windows = [...first.elements].filter(([id]) => id.startsWith('win-'));
    expect(new Set(windows.map(([, r]) => r.status === 'ok' && r.solid)).size).toBe(1);
    expect(new Set(windows.map(([, r]) => r.status === 'ok' && r.mesh)).size).toBe(1);
    // Nothing changed: nothing is sent.
    expect(ok(await evaluator.evaluate(doc)).sent).toEqual({ solids: 0, nodes: 0 });
    // A narrower window type: the new window solid and the wall it opens.
    const t = doc.types.find((x) => x.id === 't-window-600')!;
    if (t.kind === 'window') t.widthMm = 500;
    const second = ok(await evaluator.evaluate(doc));
    expect(second.sent.solids).toBe(2);
    checkVolumes(doc, second);
    // Undo: both solids are still cached.
    if (t.kind === 'window') t.widthMm = 600;
    expect(ok(await evaluator.evaluate(doc)).sent.solids).toBe(0);
  });

  it('measures clipped walls and columns with the kernel', async () => {
    for (const form of ['gable', 'hip'] as const) {
      const doc = f39Roofs(form);
      const e = ok(await new BimEvaluator(kernel).evaluate(doc));
      checkVolumes(doc, e);
      const clipped = doc.elements.filter((x) => 'clipBy' in x && x.clipBy);
      expect(clipped.length, form).toBeGreaterThan(0);
      for (const c of clipped) {
        const q = e.kernelQuantities.get(c.id)!;
        expect(q.netVolume, c.id).toBeGreaterThan(0);
        if (c.kind === 'wall') expect(q.grossVolume, c.id).toBeGreaterThanOrEqual(q.netVolume!);
        const derived = deriveBim(doc);
        const shape = derived.shapes.get(c.id)!;
        if (shape.kind !== 'wall') continue;
        // The openings lie below the roof: the clip leaves them whole.
        const thickness = derived.quantities.get(c.id)!.values.width!;
        near(
          q.grossVolume! - q.netVolume!,
          shape.openings.reduce((n, o) => n + o.widthMm * thickness * o.heightMm, 0),
          1e-9,
        );
        // The clip takes something off the unclipped prism.
        expect(q.grossVolume).toBeLessThan(
          derived.quantities.get(c.id)!.values.footprintArea! * (shape.zTop - shape.zBase),
        );
      }
    }
  });

  it('names an element that times out and keeps the others', async () => {
    const doc = f33Types();
    let calls = 0;
    const slow: BimKernel = {
      run: (graph, requests, assets) => {
        calls++;
        return Object.keys(graph.nodes).some((n) => n.startsWith('w-long'))
          ? Promise.resolve({ status: 'timeout' })
          : kernel.run(graph, requests, assets);
      },
    };
    const e = ok(await new BimEvaluator(slow).evaluate(doc));
    expect(e.elements.get('w-long')).toEqual({ status: 'error', code: 'element-timeout' });
    expect(e.elements.get('win-1')!.status).toBe('ok');
    // The batch of two, then each half.
    expect(calls).toBe(3);
  });

  it('splits a batch that fails validation and keeps the healthy solids', async () => {
    const doc = f33Types();
    const strict: BimKernel = {
      run: (graph, requests, assets) =>
        Object.keys(graph.nodes).some((n) => n.startsWith('w-long'))
          ? Promise.resolve({ status: 'invalid', issues: [] })
          : kernel.run(graph, requests, assets),
    };
    const evaluator = new BimEvaluator(strict);
    const e = ok(await evaluator.evaluate(doc));
    expect(e.elements.get('w-long')).toEqual({ status: 'error', code: 'graph-invalid' });
    expect(e.elements.get('win-1')!.status).toBe('ok');
  });

  it('keeps an overtaken call’s uncached errors out of the next call', async () => {
    const doc = f33Types();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Without assets the kernel answers late that every asset is missing.
    const late: BimKernel = {
      run: async (graph, requests, assets) => {
        if (assets.size) return kernel.run(graph, requests, assets);
        await gate;
        return {
          status: 'ok',
          results: requests.map((r) => ({ status: 'error', node: r.node, code: 'asset-missing' })),
        };
      },
    };
    const evaluator = new BimEvaluator(late);
    const first = evaluator.evaluate(doc);
    const second = evaluator.evaluate(doc, { assets: new Map([['unused', new Uint8Array()]]) });
    release();
    expect((await first).status).toBe('superseded');
    const e = ok(await second);
    expect([...e.elements.values()].every((r) => r.status === 'ok')).toBe(true);
  });

  it('keeps a solid a later call built when an overtaken call times out on it', async () => {
    const doc = f33Types();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    // The first job answers late with a timeout; later jobs build.
    const late: BimKernel = {
      run: async (graph, requests, assets) => {
        if (calls++ === 0) {
          await gate;
          return { status: 'timeout' };
        }
        return kernel.run(graph, requests, assets);
      },
    };
    const evaluator = new BimEvaluator(late, { ...bimEvaluationLimits, batch: 1 });
    const first = evaluator.evaluate(doc);
    ok(await evaluator.evaluate(doc));
    release();
    expect((await first).status).toBe('superseded');
    const again = ok(await evaluator.evaluate(doc));
    expect(again.sent.solids).toBe(0);
    expect([...again.elements.values()].every((r) => r.status === 'ok')).toBe(true);
  });

  it('keeps a mesh a later call built when an overtaken call measures the same solid', async () => {
    // With openings, a clipped wall's solid before them is only measured; without them it is
    // the wall's solid, meshed.
    const withOpenings = f39Roofs('gable');
    const without = f39Roofs('gable');
    without.elements = without.elements.filter(
      (e) => e.kind !== 'door' && e.kind !== 'window' && e.kind !== 'opening',
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const late: BimKernel = {
      run: async (graph, requests, assets) => {
        if (calls++ === 0) await gate;
        return kernel.run(graph, requests, assets);
      },
    };
    const evaluator = new BimEvaluator(late);
    const first = evaluator.evaluate(withOpenings);
    ok(await evaluator.evaluate(without));
    release();
    expect((await first).status).toBe('superseded');
    const again = ok(await evaluator.evaluate(without));
    expect(again.sent.solids).toBe(0);
    for (const r of again.elements.values())
      expect(r.status === 'ok' && r.mesh.indices.length).toBeGreaterThan(0);
  });

  it('does not adopt a result a later call superseded', async () => {
    const evaluator = new BimEvaluator(kernel);
    const doc = f33Types();
    const first = evaluator.evaluate(doc);
    const second = evaluator.evaluate(doc);
    expect((await first).status).toBe('superseded');
    ok(await second);
  });

  it('evaluates the office, sharing columns, beams, doors and windows', async () => {
    const doc = f37Office();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    checkVolumes(doc, e);
    const solids = new Set([...e.elements.values()].map((r) => r.status === 'ok' && r.solid));
    expect(solids.size).toBeLessThan(e.elements.size / 3);
    expect(e.sent.solids).toBe(solids.size);
  }, 120_000);
});
