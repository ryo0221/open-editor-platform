import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f95WaterHinges,
  type CadDocument,
  type F95WaterOpening,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { nagiWaterSimulation, type SimulationDocument } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy } from './run';
import type { SealRunFields } from './run-seal';

/**
 * TS-2254 (ST-630): 凪's water model (`f95NagiWater`) through `runStudy` with the kernel: the four
 * seals (both doors, hood, lid) shut, then the left door and the hood opened 1° on their hinges.
 * About 4 minutes: every body of the car is evaluated for its analysis surface.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

describe.skipIf(!available)('凪 seals through the kernel (VS9c)', () => {
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
    return { r, seals: (r.fields as SealRunFields).seals, metrics: r.levels[0]!.metrics };
  };

  it('presses all four seals 37.5 % when shut, with no leak, the doors alike', async () => {
    const { r, seals, metrics } = await run(nagiWaterSimulation());
    expect(r.status.status).toBe('reference');
    expect(seals.map((s) => s.sealId)).toEqual([
      'door-l-seal',
      'door-r-seal',
      'hood-seal',
      'lid-seal',
    ]);
    expect(metrics['min-compression']).toBeCloseTo(0.375, 6);
    expect(metrics['max-compression']).toBeCloseTo(0.375, 6);
    expect(metrics['leak-length']).toBe(0);
    for (const s of seals) {
      expect(s.measurement.runs).toEqual([]);
      expect(s.measurement.breaks).toEqual([]);
      expect(s.measurement.bends).toEqual([]);
    }
    const [l, rr, hood, lid] = seals.map((s) => s.measurement.lengthMm);
    // Each line runs round its pocket's floor 12 mm in: about 2.2 m round a door, 4.3 m round the
    // hood, 3.8 m round the lid; the doors mirror each other.
    expect(l).toBeCloseTo(rr!, 3);
    expect(l).toBeGreaterThan(2000);
    expect(hood).toBeGreaterThan(4000);
    expect(lid).toBeGreaterThan(3500);
  }, 900_000);

  it('gaps a door and the hood away from their hinges when opened 1°', async () => {
    const { seals, metrics } = await run(
      nagiWaterSimulation({ openings: ['door-l', 'hood'], angles: { 'door-l': 1, hood: 1 } }),
    );
    expect(metrics['leak-length']).toBeGreaterThan(0);
    for (const s of seals) {
      const h = f95WaterHinges[s.sealId.replace(/-seal$/, '') as F95WaterOpening];
      // The distance of a point from the hinge's axis.
      const arm = (p: readonly number[]) => {
        const v = [p[0]! - h.origin[0], p[1]! - h.origin[1], p[2]! - h.origin[2]];
        const a = h.axis;
        return Math.hypot(
          v[1]! * a[2] - v[2]! * a[1],
          v[2]! * a[0] - v[0]! * a[2],
          v[0]! * a[1] - v[1]! * a[0],
        );
      };
      const m = s.measurement;
      const far = m.points.reduce((a, b) => (arm(b.position) > arm(a.position) ? b : a));
      const near = m.points.reduce((a, b) => (arm(b.position) < arm(a.position) ? b : a));
      // Lifted by its arm · sin 1° from the shut 10 mm: the door's rear (arm ≈ 870 mm) by about
      // 15 mm, the hood's front (≈ 1210 mm) by about 21 mm; the hinge side stays pressed.
      expect(far.status).toBe('gap');
      expect(far.distanceMm!).toBeCloseTo(10 + arm(far.position) * Math.sin(Math.PI / 180), 0);
      expect(near.status).toBe('ok');
      expect(new Set(m.runs.map((x) => x.status))).toEqual(new Set(['under', 'near', 'gap']));
    }
  }, 900_000);
});
