import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  topologyRefOf,
  type CadDocument,
  type CadTopologyRef,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  simulationFixture,
  validateSimulation,
  type SimulationTransientStudy,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { defaultTransientStudy } from './conditions';
import { resultVtu, runResult } from './results';
import { runStudy, type RunEnvironment } from './run';

const root = path.resolve(__dirname, '../../..');
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)(
  'a transient thermal study on the kernel (VS11d, TS-2279, ST-637)',
  () => {
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
    const tableOf = async (cad: CadDocument, bodyId: string): Promise<CadTopologyTable> => {
      const r = await evaluateCad(oc, cad, cadContentHash(cad));
      return r.meshes.find((m) => m.bodyId === bodyId)!.topology;
    };
    /** The F02 plate with its end faces picked on the evaluated table, a heat study on them. */
    const plate = async () => {
      const { cad, doc } = simulationFixture();
      doc.source.contentHash = cadContentHash(cad);
      const table = await tableOf(cad, 'plate');
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
      const cold = doc.constraints[0]!.targets;
      const hot = (doc.loads[0] as { targets: typeof cold }).targets;
      // The end at x = 0 is held and heated from 293.15 K to 493.15 K over the first minute; the
      // far end convects and radiates to the room.
      doc.constraints.push({
        id: 'hot-end',
        name: 'Heated end',
        kind: 'temperature',
        targets: cold,
        temperature: 493.15,
        amplitude: { times: [0, 60], factors: [293.15 / 493.15, 1] },
      });
      doc.loads.push(
        {
          id: 'air',
          name: 'Air',
          kind: 'convection',
          targets: hot,
          coefficient: 0.02,
          ambient: 293.15,
        },
        {
          id: 'glow',
          name: 'Glow',
          kind: 'radiation',
          targets: hot,
          emissivity: 0.8,
          ambient: 293.15,
        },
      );
      const study = defaultTransientStudy(doc) as SimulationTransientStudy;
      study.transient = { ...study.transient, endS: 300, stepS: 10, outputEvery: 10 };
      doc.studies.push(study);
      return { cad, doc, table, study };
    };

    it('heats the plate from one end over time, convecting and radiating at the other', async () => {
      const { cad, doc, table, study } = await plate();
      expect(validateSimulation(doc)).toEqual([]);
      expect(study.loadIds).toEqual(['air', 'glow']);
      expect(study.constraintIds).toEqual(['hot-end']);
      const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
      const [level] = run.levels;
      expect(level!.checks.map((c) => c.name)).toEqual([
        'mapping',
        'load',
        'quality',
        'solver',
        'equilibrium',
      ]);
      for (const c of level!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      const fields = run.fields!;
      if (fields.kind !== 'transient-thermal') throw new Error('not transient');
      expect(fields.times).toEqual([0, 100, 200, 300]);
      // Held at the end temperature from 60 s: the highest temperature is the held one.
      expect(level!.metrics['max-temperature']).toBeCloseTo(493.15, 6);
      expect(fields.history.maxTemperature[0]).toBeCloseTo(293.15, 6);
      // The far end warms with time but stays below the held end.
      const far = (T: Float64Array) => {
        let lo = Infinity;
        for (const v of T) lo = Math.min(lo, v);
        return lo;
      };
      expect(far(fields.temperatures[1]!)).toBeLessThan(far(fields.temperatures[3]!));
      expect(far(fields.temperatures[3]!)).toBeLessThan(493.15);
      expect(level!.metrics['max-heat-flux']).toBeGreaterThan(0);
      // One field per kept time, the last first; the VTU holds them all.
      const result = runResult(fields);
      expect(result.scalars.map((s) => s.label).slice(0, 4)).toEqual([
        'Temperature at 300 s',
        'Temperature at 0 s',
        'Temperature at 100 s',
        'Temperature at 200 s',
      ]);
      const vtu = resultVtu(fields);
      expect(vtu).toContain('Name="Temperature at 300 s (K)"');
      expect(['verified', 'reference']).toContain(run.status.status);
    }, 600_000);

    it('solves the thermal stress of the last field on the structural constraints', async () => {
      const { cad, doc, table, study } = await plate();
      study.transient.stress = { reference: 293.15 };
      study.constraintIds.push('fix-left');
      study.convergence.metrics = ['max-temperature', 'max-von-mises'];
      expect(validateSimulation(doc)).toEqual([]);
      const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
      const [level] = run.levels;
      for (const c of level!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      const fields = run.fields!;
      if (fields.kind !== 'transient-thermal' || !fields.stress) throw new Error('no stress');
      // Held fixed where it is 200 K hotter: about E α ΔT = 210 000 × 1.2e-5 × 200 ≈ 500 MPa there.
      const vm = level!.metrics['max-von-mises']!;
      expect(vm).toBeGreaterThan(100);
      expect(vm).toBeLessThan(2000);
      expect(runResult(fields).scalars.at(-1)!.id).toBe('von-mises');
      // Without an expansion or a specific heat it is refused before solving.
      delete doc.materials[0]!.expansion;
      const none = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      expect(none.failure?.code).toBe('material-missing');
      delete doc.materials[0]!.specificHeat;
      study.transient.stress = null;
      study.constraintIds = ['hot-end'];
      study.convergence.metrics = ['max-temperature'];
      const cold = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      expect(cold.failure?.code).toBe('material-missing');
    }, 600_000);
  },
);
