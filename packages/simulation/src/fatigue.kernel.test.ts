import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  topologyRefOf,
  type CadTopologyRef,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  cyclesToFailure,
  minerDamage,
  rainflow,
  repeated,
  signedVonMises,
  steelSn,
} from '@editor-platform/geometry-fem';
import {
  simulationFixture,
  validateSimulation,
  type SimulationStaticStudy,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { fatigueLifeCap, resultVtu, runResult } from './results';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-2291 (ST-639 #2): fatigue of the F02 plate's tip load through `runStudy`: fully reversed at
 * 1.5 × the load, every node's damage is its cycles over its Basquin life; a road-like history's
 * worst node is the most stressed one and its damage the rainflow count's.
 */
const root = path.resolve(__dirname, '../../..');
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)('fatigue of a static study (VS13a, TS-2291, ST-639)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let fem: FemMesherModule;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
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

  const env = (): RunEnvironment => ({
    builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
    surface: async (cad, request) =>
      (await evaluateCad(oc, cad, cadContentHash(cad), { analysisSurface: request }))
        .analysisSurface!,
    mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
  });
  const plate = async (history: number[]) => {
    const { cad, doc } = simulationFixture();
    doc.source.contentHash = cadContentHash(cad);
    const r = await evaluateCad(oc, cad, cadContentHash(cad));
    const table: CadTopologyTable = r.meshes.find((m) => m.bodyId === 'plate')!.topology;
    const repick = (t: { kind: 'face' | 'edge'; ref: CadTopologyRef }) => {
      const c = t.ref.hint!.centroid;
      let best = -1;
      table.faces.forEach((f, i) => {
        if (f.name && (best < 0 || dist(f.centroid, c) < dist(table.faces[best]!.centroid, c)))
          best = i;
      });
      return { ...t, ref: topologyRefOf(table, 'face', best, t.ref.featureId) };
    };
    for (const x of [...doc.loads, ...doc.constraints])
      if ('targets' in x) x.targets = x.targets.map(repick);
    doc.mesh = { ...doc.mesh, size: 10, minSize: 2, grading: 1.5 };
    const study = doc.studies[0] as SimulationStaticStudy;
    study.convergence.levels = 1;
    study.solver = { tolerance: 1e-8, maxIterations: 200_000 };
    study.fatigue = {
      history,
      sn: { amplitude: 250, cycles: 1e6, slope: 10, endurance: 0, ultimate: 510 },
    };
    expect(validateSimulation(doc)).toEqual([]);
    const run = await runStudy(doc, cad, cadContentHash(cad), 'static', table, env());
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    const fields = run.fields!;
    if (fields.kind !== undefined || !fields.fatigue) throw new Error('no fatigue field');
    return { run, fields, fatigue: fields.fatigue, sn: { ...steelSn, endurance: 0 } };
  };

  it('gives each node its cycles over its life under a fully reversed load', async () => {
    const k = 500;
    const history = Array.from({ length: 2 * k + 1 }, (_, i) => (i % 2 ? 1.5 : -1.5));
    const { run, fields, fatigue, sn } = await plate(history);
    expect(run.levels[0]!.checks.map((c) => c.name)).toContain('fatigue');
    // k cycles at 1.5 × each node's von Mises stress (signed by its trace).
    let worst = 0;
    for (let n = 0; n < fields.vonMises.length; n++) {
      const s = 1.5 * Math.abs(signedVonMises(fields.stress, 6 * n));
      const expected = s > 0 ? k / cyclesToFailure(sn, s, 0) : 0;
      if (expected > 1e-300) expect(fatigue.damage[n]! / expected).toBeCloseTo(1, 9);
      if (fields.vonMises[n]! > fields.vonMises[worst]!) worst = n;
    }
    // The root of the cantilever (about 190 MPa there, 290 MPa at 1.5 ×) is the worst place.
    let most = 0;
    for (let n = 1; n < fatigue.damage.length; n++)
      if (fatigue.damage[n]! > fatigue.damage[most]!) most = n;
    expect(most).toBe(worst);
    const result = runResult(fields);
    const life = result.scalars.find((s) => s.id === 'fatigue-life')!;
    expect(life.label).toBe('Fatigue life (log₁₀ passes)');
    expect(Math.min(...life.values)).toBeCloseTo(Math.log10(fatigue.life[most]!), 9);
    expect(Math.max(...life.values)).toBeLessThanOrEqual(fatigueLifeCap);
    expect(resultVtu(fields)).toContain('Name="Fatigue life (log10 passes)"');
  }, 600_000);

  it('counts a road-like history once and scales it at every node', async () => {
    // A deterministic rough road: three sines and a small saw tooth, 4 000 points.
    const history = Array.from(
      { length: 4000 },
      (_, i) =>
        Math.sin(i / 7) +
        0.6 * Math.sin(i / 2.3 + 1) +
        0.3 * Math.sin(i * 1.7) +
        ((i % 13) - 6) / 30,
    );
    const { fields, fatigue, sn } = await plate(history);
    // One pass of a road that repeats (Codex on #1283).
    const counted = rainflow(repeated(history));
    let most = 0;
    for (let n = 1; n < fatigue.damage.length; n++)
      if (fatigue.damage[n]! > fatigue.damage[most]!) most = n;
    const s = signedVonMises(fields.stress, 6 * most);
    const expected = minerDamage(
      sn,
      counted.map((c) => ({ range: Math.abs(s) * c.range, mean: s * c.mean, count: c.count })),
    );
    expect(fatigue.damage[most]! / expected).toBeCloseTo(1, 12);
    expect(fatigue.life[most]!).toBeCloseTo(1 / expected, 6);
  }, 600_000);
});
