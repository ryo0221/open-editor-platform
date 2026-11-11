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
  f40Lattice,
  f47Taper,
  f49Pipes,
  f50Lean,
  f51Ramps,
  f52LeanOpenings,
  f54LeanJoins,
  f54LeanRoofs,
  f55RampOpenings,
  f55Stairs,
  f48Ramp,
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

  it('builds a room round a core, one side an arc, to its analytic volume (TW1)', async () => {
    const doc = f31BoxBuilding();
    const hall = doc.elements.find((x) => x.id === 'sp-hall')!;
    if (hall.kind !== 'space') throw new Error();
    hall.holes = [
      [
        [4000, 3000],
        [6000, 3000, 0.4],
        [6000, 5000],
        [4000, 5000],
      ],
    ];
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    expect(checkVolumes(doc, e)).toBe(doc.elements.filter((x) => x.kind !== 'opening').length);
  });

  it('builds leaning columns, sloping beams and members to their analytic volumes (TW2)', async () => {
    const doc = f40Lattice();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    expect(checkVolumes(doc, e)).toBe(doc.elements.length);
    // The leaning column's ends are square to its axis: its placed corners follow the axis.
    const placed = (id: string) => {
      const r = e.elements.get(id)!;
      if (r.status !== 'ok' || !r.placement) throw new Error(id);
      const { rotation: m, translation: t } = r.placement;
      const [lo, hi] = r.measure.bounds;
      const out = [
        [Infinity, Infinity, Infinity],
        [-Infinity, -Infinity, -Infinity],
      ];
      for (const cx of [lo[0], hi[0]])
        for (const cy of [lo[1], hi[1]])
          for (const cz of [lo[2], hi[2]])
            for (let k = 0; k < 3; k++) {
              const v = m[3 * k]! * cx + m[3 * k + 1]! * cy + m[3 * k + 2]! * cz + t[k]!;
              out[0]![k] = Math.min(out[0]![k]!, v);
              out[1]![k] = Math.max(out[1]![k]!, v);
            }
      return out as [number[], number[]];
    };
    const L = Math.hypot(2000, 6000);
    const [lo, hi] = placed('c-lean');
    near(lo[0]!, (-300 * 6000) / L, 1e-6);
    near(hi[0]!, 2000 + (300 * 6000) / L, 1e-6);
    near(lo[2]!, (-300 * 2000) / L, 1e-6);
    near(hi[2]!, 6000 + (300 * 2000) / L, 1e-6);
    const [vlo, vhi] = placed('m-vert');
    near(vlo[2]!, 0, 1e-6);
    near(vhi[2]!, 6000, 1e-6);
    near(vlo[0]!, 7800, 1e-6);
  });

  it('builds tapered columns to their analytic volumes (TW5)', async () => {
    const doc = f47Taper();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    expect(checkVolumes(doc, e)).toBe(doc.elements.length);
    // The square column's local bounds: its 600 mm base, its 300 mm top 6 m up.
    const r = e.elements.get('c-square')!;
    if (r.status !== 'ok') throw new Error('c-square');
    near(r.measure.bounds[1][2], 6000, 1e-9);
    near(r.measure.bounds[1][0], 300, 1e-9);
  });

  it('builds steel pipes hollow, to their analytic volumes (#936)', async () => {
    const doc = f49Pipes();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // A ring section, the tapered column's wall scaled with it; the beam meets the columns.
    expect(checkVolumes(doc, e)).toBe(doc.elements.length);
    const r = e.elements.get('c-pipe')!;
    if (r.status !== 'ok') throw new Error('c-pipe');
    near(r.measure.bounds[1][0], 300, 1e-6);
  });

  it('builds leaning walls ruled between base and top, to their analytic volumes (LR2)', async () => {
    const doc = f50Lean();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // The free wall, the cone of glass, the frustum and the L (its butt end faces ruled).
    expect(checkVolumes(doc, e)).toBe(doc.elements.length);
    const r = e.elements.get('w-free')!;
    if (r.status !== 'ok') throw new Error('w-free');
    // Its outer face leans 15° to −y: the top edge is 4,000·tan 15° further out.
    near(
      r.measure.bounds[0][1],
      -100 / Math.cos(Math.PI / 12) - 4000 * Math.tan(Math.PI / 12),
      1e-6,
    );
    near(r.measure.bounds[1][2], 4000, 1e-9);
  });

  it('cuts openings through leaning walls to their analytic volumes (FU3a)', async () => {
    const doc = f52LeanOpenings();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // Every wall with its windows, door and opening, and the panels (an opening has no solid).
    expect(checkVolumes(doc, e)).toBe(doc.elements.length - 1);
    const before = ok(await new BimEvaluator(kernel).evaluate(f50Lean()));
    for (const id of ['w-free', 'w-sq-1', 'w-ring-1']) {
      const a = before.elements.get(id)!;
      const b = e.elements.get(id)!;
      if (a.status !== 'ok' || b.status !== 'ok') throw new Error(id);
      expect(b.measure.volumeMm3).toBeLessThan(a.measure.volumeMm3 - 1e8);
    }
  });

  it('cuts leaning walls under their roofs (LS1, F54)', async () => {
    const doc = f54LeanRoofs();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    const before = ok(await new BimEvaluator(kernel).evaluate(f50Lean()));
    // The mono roof's underside: 4,000 mm at y = 8,500, rising 15° towards +y.
    const under = (y: number) => 4000 + (y - 8500) * Math.tan(Math.PI / 12);
    for (const id of ['w-sq-1', 'w-sq-2', 'w-sq-3', 'w-sq-4']) {
      const r = e.elements.get(id)!;
      if (r.status !== 'ok') throw new Error(id);
      // Under the plane at its highest corner, and above it where the wall stood 7,000 mm.
      const [lo, hi] = r.measure.bounds;
      expect(hi[2]).toBeLessThanOrEqual(under(hi[1]) + 1e-6);
      expect(hi[2]).toBeGreaterThan(under(lo[1]));
    }
    // The ring is cut flat 500 mm below L1: less than its 4,000 mm cone.
    for (const id of ['w-ring-1', 'w-ring-3']) {
      const [a, b] = [before.elements.get(id)!, e.elements.get(id)!];
      if (a.status !== 'ok' || b.status !== 'ok') throw new Error(id);
      near(b.measure.bounds[1][2], 3500, 1e-6);
      expect(b.measure.volumeMm3).toBeLessThan(a.measure.volumeMm3 * 0.95);
    }
  });

  it('rules upright walls joined to a leaning one to their analytic volumes (LS2, F54)', async () => {
    const doc = f54LeanJoins();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // Every wall (the T with its window cut upright) and the window's panel.
    expect(checkVolumes(doc, e)).toBe(doc.elements.length);
    const r = e.elements.get('w-up-l')!;
    if (r.status !== 'ok') throw new Error('w-up-l');
    // Its end reaches the leaning face's north side at the top: 4,000·tan 0.2 further south.
    near(r.measure.bounds[0][1], 100 / Math.cos(0.2) - 4000 * Math.tan(0.2), 1e-6);
  });

  it('builds spiral ramps as smooth lofts to their analytic volumes (LR3)', async () => {
    const doc = f51Ramps();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // The loft through 5° sections keeps the exact volume (planArea × thickness) to 1e-6.
    expect(checkVolumes(doc, e)).toBe(3);
    // Its heights run from the low end's underside to the high end's top, within its circle.
    for (const [id, z0, z1, R] of [
      ['r-spiral', -200, 4000, 5000],
      ['r-quarter', -200, 1000, 4500],
      ['r-down', 1800, 4000, 3000],
    ] as const) {
      const r = e.elements.get(id)!;
      if (r.status !== 'ok') throw new Error(id);
      near(r.measure.bounds[0][2], z0, 1e-6);
      near(r.measure.bounds[1][2], z1, 1e-6);
      near(Math.max(...r.measure.bounds[1].slice(0, 2)), R, 1e-6);
    }
  });

  it('cuts openings through spiral ramps and stands railings on them (LS4, LS5, F55)', async () => {
    const doc = f55RampOpenings();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // The three ramps (openings have no solid), each turn over an opening cut through, and
    // LS5's three railings along their edges.
    expect(checkVolumes(doc, e)).toBe(6);
    // A railing stands on the ramp's top: from it to 1,100 mm above, at the outer radius.
    const r = e.elements.get('rail-out')!;
    if (r.status !== 'ok') throw new Error('rail-out');
    near(r.measure.bounds[0][2], 0, 1e-3);
    near(r.measure.bounds[1][2], 5100, 1e-3);
    near(Math.max(...r.measure.bounds[1].slice(0, 2)), 5000, 1e-3);
  });

  it('builds straight stairs to their analytic volumes (LS6, F55)', async () => {
    const doc = f55Stairs();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    expect(checkVolumes(doc, e)).toBe(2);
    // The turned flight runs north from (6,000, 0): 9 treads of 280 mm, 1,000 mm across, up
    // to its last tread (the last riser is the upper floor's edge).
    const r = e.elements.get('st-north')!;
    if (r.status !== 'ok') throw new Error('st-north');
    // Its bounds in its own frame (placed at its start, turned up the flight).
    expect(r.placement?.translation).toEqual([6000, 0, 0]);
    near(r.measure.bounds[0][1], -500, 1e-3);
    near(r.measure.bounds[1][1], 500, 1e-3);
    near(r.measure.bounds[1][0], 9 * 280, 1e-3);
    near(r.measure.bounds[1][2], 1620, 1e-3);
  });

  it('builds sloped slabs to their analytic volumes (TW5)', async () => {
    const doc = f48Ramp();
    const e = ok(await new BimEvaluator(kernel).evaluate(doc));
    // Both slabs, the ramp with its hole and its opening near the high end cut through.
    expect(checkVolumes(doc, e)).toBe(2);
    // The ramp runs from 0–200 mm at its west edge to 2,800–3,000 mm at its east edge.
    const r = e.elements.get('s-ramp')!;
    if (r.status !== 'ok') throw new Error('s-ramp');
    near(r.measure.bounds[0][2], 0, 1e-6);
    near(r.measure.bounds[1][2], 3000, 1e-6);
    // The half-round one falls from L1 at its straight edge to 1,000 mm lower at the arc's crown.
    const h = e.elements.get('s-half')!;
    if (h.status !== 'ok') throw new Error('s-half');
    near(h.measure.bounds[1][2], 3000, 1e-6);
    near(h.measure.bounds[0][2], 1800, 1e-3);
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
