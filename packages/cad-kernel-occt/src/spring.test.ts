import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  cadBuilder,
  cadContentHash,
  coilFreeLength,
  f155Springs,
  measureDesignTargets,
  parameterValues,
  resolveSpring,
  spiralStripLength,
  type CadDocument,
  type CoilSpringSpec,
  type SpiralSpringSpec,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('PD5 springs in the kernel (ST-764, TS-2540)', () => {
  const host = { evaluate: undefined as unknown as (d: CadDocument) => Promise<CadWorkerResponse> };
  const kernel = { id: 'occt', buildHash: `sha256:${cadKernelBuild.wasmSha256}` };
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    globalThis.require ??= createRequire(import.meta.url);
    const posted: CadWorkerResponse[] = [];
    const handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({
      type: 'init',
      build: { buildHash: `sha256:${sha}`, moduleUrl: '', wasmUrl: '' },
    });
    let n = 0;
    host.evaluate = async (document) => {
      const requestId = `spring-${n++}`;
      await handle({
        type: 'evaluate',
        requestId,
        generation: n,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
      } as CadWorkerRequest);
      return posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      )!;
    };
  }, 120_000);

  it('builds F155: each spring one solid of the expected volume and size, targets measured', async () => {
    const doc = f155Springs(kernel);
    const t0 = performance.now();
    const m = await host.evaluate(doc);
    const ms = performance.now() - t0;
    if (m.type !== 'result' || m.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(m).slice(0, 2000));
    const values = parameterValues(doc);
    for (const body of doc.bodies) {
      const f = doc.features.find((x) => x.name === body.name && x.type === 'spring')!;
      if (f.type !== 'spring') throw new Error('not a spring');
      const s = resolveSpring(f.args, values);
      const e = m.evaluation.bodies[body.id]!;
      if (e.kind !== 'solid') throw new Error(`${body.name} is not a solid`);
      const [lo, hi] = e.bounds;
      if (s.form === 'spiral') {
        const sp = s as SpiralSpringSpec;
        // The strip's cross-section (radial t by b) along its centre line.
        const expected = spiralStripLength(sp) * sp.thickness * sp.height;
        expect(Math.abs(e.volumeMm3 - expected) / expected).toBeLessThan(0.005);
        expect(hi[2] - lo[2]).toBeCloseTo(sp.height, 4);
        const outer = sp.innerRadius + sp.pitch * sp.turns + sp.thickness;
        expect(hi[0] - lo[0]).toBeLessThan(2 * outer + 1e-3);
      } else {
        const c = s as CoilSpringSpec;
        const wire = c.coils * Math.hypot(Math.PI * c.meanDiameter, c.pitch);
        const expected = ((Math.PI * c.wireDiameter ** 2) / 4) * wire;
        expect(Math.abs(e.volumeMm3 - expected) / expected).toBeLessThan(0.005);
        expect(hi[0] - lo[0]).toBeCloseTo(c.meanDiameter + c.wireDiameter, 2);
        // Ends cut square to the wire lean by the helix angle: within d of the free length.
        expect(Math.abs(hi[2] - lo[2] - coilFreeLength(c))).toBeLessThan(c.wireDiameter);
      }
    }
    const results = measureDesignTargets(doc, { bodies: m.evaluation.bodies });
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['power-reserve', 'pass'],
      ['mainspring-stress', 'pass'],
      ['hairspring-rate', 'pass'],
      ['crown-force', 'pass'],
    ]);
    console.log(`F155 evaluated in ${ms.toFixed(0)} ms (not a performance claim)`);
  }, 300_000);

  it('builds left- and right-hand torsion coils and refuses touching turns', async () => {
    const coil = (hand: 'left' | 'right', pitch: number) => {
      const b = cadBuilder(kernel);
      b.coilSpring('Coil', {
        use: 'torsion',
        wireDiameter: 1,
        meanDiameter: 8,
        pitch,
        coils: 5.5,
        hand,
        material: { youngsModulusMpa: 206_000 },
        angle: Math.PI / 2,
      });
      return b.document;
    };
    for (const hand of ['left', 'right'] as const) {
      const m = await host.evaluate(coil(hand, 1.5));
      if (m.type !== 'result' || m.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(m).slice(0, 2000));
      const e = Object.values(m.evaluation.bodies)[0]!;
      expect(e.kind).toBe('solid');
    }
  }, 300_000);
});
