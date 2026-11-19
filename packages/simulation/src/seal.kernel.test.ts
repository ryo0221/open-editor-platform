import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { f98SealSimulation, type SimulationDocument } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy } from './run';
import type { SealRunFields } from './run-seal';

/**
 * TS-2252 (ST-629): F98 (the gap box) through `runStudy` with the kernel: the lid's seal shut,
 * opened on its hinge, with a smaller bulb and with a wider clearance.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

describe.skipIf(!available)('F98 seal through the kernel (VS9b)', () => {
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

  const run = async ({ cad, doc }: { cad: CadDocument; doc: SimulationDocument }) => {
    const hash = cadContentHash(cad);
    const d = { ...doc, source: { ...doc.source, contentHash: hash } };
    const display = await evaluateCad(oc, cad, hash);
    const r = await runStudy(
      d,
      cad,
      hash,
      'seals',
      display.meshes.find((m) => m.bodyId === d.source.bodyId)!.topology,
      {
        builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'none', solver: 'seal-measure' },
        surface: async (c, request) =>
          (await evaluateCad(oc, c, cadContentHash(c), { analysisSurface: request }))
            .analysisSurface!,
        mesh: () => {
          throw new Error('no mesh');
        },
      },
    );
    expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
    const seal = (r.fields as SealRunFields).seals[0]!;
    return { r, m: seal.measurement, metrics: r.levels[0]!.metrics };
  };

  it('presses the shut lid’s seal 37.5 % all round, with no leak or tight bend', async () => {
    const { r, m, metrics } = await run(f98SealSimulation());
    expect(r.status.status).toBe('reference');
    expect(r.levels[0]!.checks.map((c) => [c.name, c.pass])).toEqual([
      ['mapping', true],
      ['seal', true],
    ]);
    expect(metrics['min-compression']).toBeCloseTo(0.375, 6);
    expect(metrics['max-compression']).toBeCloseTo(0.375, 6);
    expect(metrics['leak-length']).toBe(0);
    expect(m.breaks).toEqual([]);
    expect(m.bends).toEqual([]);
    // The pocket's walls 2 mm outside the 400 × 240 outline (r 30), the seal 12 mm in: a loop
    // 380 × 220 round corners of 20 mm.
    const loop = 2 * (380 - 40 + 220 - 40) + 2 * Math.PI * 20;
    expect(m.lengthMm).toBeGreaterThan(loop - 2);
    expect(m.lengthMm).toBeLessThan(loop + 2);
  }, 600_000);

  it('opens a gap at the front when the lid is turned 2° on its hinge', async () => {
    const { m, metrics } = await run(f98SealSimulation({ angleDeg: 2 }));
    expect(metrics['leak-length']).toBeGreaterThan(0);
    const front = m.points.filter((p) => p.position[1] < -100);
    expect(front.every((p) => p.status === 'gap')).toBe(true);
    // The front seal is 220 mm in front of the hinge (y = 122): 10 + 232 · tan 2° ≈ 18.1 mm.
    const d = Math.min(...front.map((p) => p.distanceMm!));
    expect(d).toBeGreaterThan(17);
    expect(d).toBeLessThan(19);
    expect(m.points.filter((p) => p.position[1] > 100).every((p) => !p.leak)).toBe(true);
  }, 600_000);

  it('leaks all round with a smaller bulb or a wider clearance', async () => {
    const small = await run(
      f98SealSimulation({
        section: { diameterMm: 12, compression: [0.3, 0.5], minBendRadiusMm: 10 },
      }),
    );
    expect(small.metrics['max-compression']).toBeCloseTo(2 / 12, 6);
    expect(small.m.points.every((p) => p.status === 'under')).toBe(true);
    const wide = await run(f98SealSimulation({ clearance: 20 }));
    expect(wide.m.points.every((p) => p.status === 'gap')).toBe(true);
    expect(wide.m.points[0]!.gapMm).toBeCloseTo(4, 6);
    expect(wide.metrics['leak-length']).toBeCloseTo(wide.m.lengthMm, 6);
  }, 600_000);
});
