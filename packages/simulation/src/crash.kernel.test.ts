import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, f22Split, type CadTopologyTable } from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  crashStudy,
  emptySimulation,
  simulationMaterialPresets,
  studyStatus,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy, type RunEnvironment, type RunProgress } from './run';
import { solveCrashOnHost, type SimulationComputeDescriptor } from './compute';
import { createSimulationJobs, referenceCrash } from '../../../scripts/dev/simulation-host.mjs';

/**
 * TS-2225 (ST-619, VS7c): a crash study run from the analysis document. The F22 panel (a CAD
 * sheet, 100 × 60 at z = 0, nose at x = 100) as a 1.5 mm steel shell goes edge-on into the wall
 * at 56 km/h: the run meshes it as the static runs do, solves it on the explicit solver, and
 * records the crash measures and checks (reference only).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)('a crash study of a CAD sheet (VS7c)', () => {
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

  it('runs the panel into the wall and records its measures', async () => {
    const cad = f22Split('open');
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    const tables = new Map<string, CadTopologyTable>(
      evaluated.meshes.map((m) => [m.bodyId, m.topology]),
    );
    let doc: SimulationDocument = emptySimulation(
      {
        artifactId: 'panel',
        versionId: 'v1',
        contentHash: cadContentHash(cad),
        bodyId: 'panel-body',
      },
      'Panel crash',
    );
    doc.materials.push({
      id: 'steel',
      ...simulationMaterialPresets[0]!,
      plasticity: { strain: [0, 0.2], stress: [250, 400], cowperSymonds: { C: 40.4, p: 5 } },
    });
    doc.materialId = 'steel';
    doc = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId: 'panel-body',
      thicknessMm: 1.5,
    });
    doc.mesh = { ...doc.mesh, size: 10, minSize: 5, grading: 1.5 };
    const study = crashStudy('front', [0, -30, 0]);
    study.crash.gravity = false;
    study.crash.endTimeMs = 60;
    study.crash.intrusions = [{ name: 'nose', point: [100, -30, 0], reference: [0, -30, 0] }];
    doc.studies.push(study);
    const seen: RunProgress[] = [];
    const env: RunEnvironment = {
      builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
      surface: async (c, request) =>
        (await evaluateCad(oc, c, cadContentHash(c), { analysisSurface: request }))
          .analysisSurface!,
      mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
      checkpoint: (p) => void seen.push(p),
    };
    const r = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'front',
      tables.get('panel-body')!,
      env,
      tables,
    );
    expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
    const level = r.levels[0]!;
    for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    expect(level.checks.map((c) => c.name)).toEqual([
      'mapping',
      'quality',
      'energy-balance',
      'hourglass-energy',
      'mass-scaling',
    ]);
    if (process.env.VS7C_PRINT)
      console.log(JSON.stringify({ metrics: level.metrics, checks: level.checks }));
    expect(level.metrics.crush).toBeGreaterThan(0);
    expect(level.metrics['max-intrusion']).toBeGreaterThan(0);
    expect(level.metrics['occupant-load-criterion']).toBeGreaterThan(0);
    expect(r.status.status).toBe('reference');
    expect(r.status.reasons).toContain('crash: crash-test results are for reference');
    expect(seen.some((p) => p.crash && p.crash.time > 0)).toBe(true);
    if (r.fields?.kind !== 'crash') throw new Error('not a crash run');
    expect(r.fields.bodies.map((b) => b.bodyId)).toEqual(['panel-body']);
    // The wall just ahead of the nose's contact face (half the 1.5 mm sheet, then the 1 mm gap).
    expect(r.fields.walls[0]!.point[0]).toBeCloseTo(101.75, 6);
    expect(studyStatus({ study, checks: level.checks, levels: [level.metrics] }).status).toBe(
      'reference',
    );
    // TS-2230 (ST-621, VS8a): the same study on the reference Host (its crash runs in a Node
    // process of its own) gives the same measures, with the solved time as its progress.
    const jobs = createSimulationJobs({
      limits: { bytes: 256 * 1024 * 1024 },
      toInp: async () => ({ inp: '' }),
      crash: referenceCrash((m: string) => import(/* @vite-ignore */ m)),
    });
    const server = createServer((req, res) => {
      void jobs.handle(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const host: SimulationComputeDescriptor = {
        label: 'Test Host',
        destination: 'this test',
        solverBuild: 'calculix-test',
        limits: { nodes: 1e6, elements: 1e6, bytes: 256 * 1024 * 1024 },
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
        crash: { solverBuild: 'geometry-fem-node-test' },
      };
      const onHost: RunProgress[] = [];
      const h = await runStudy(
        doc,
        cad,
        cadContentHash(cad),
        'front',
        tables.get('panel-body')!,
        {
          ...env,
          builds: { ...env.builds, solver: host.crash!.solverBuild },
          checkpoint: (p) => void onHost.push(p),
          remote: {
            name: host.label,
            limits: host.limits,
            solve: () => Promise.reject(new Error('not a static run')),
            solveCrash: (model, settings, onTime) =>
              solveCrashOnHost(host, model, settings, {
                pollMs: 200,
                ...(onTime ? { onTime } : {}),
              }),
          },
        },
        tables,
      );
      expect(h.failure, JSON.stringify(h.failure)).toBeUndefined();
      expect(h.levels[0]!.metrics).toEqual(level.metrics);
      expect(h.levels[0]!.checks.map((c) => c.pass)).toEqual(level.checks.map((c) => c.pass));
      expect(onHost.some((p) => p.crash && p.on === 'Test Host')).toBe(true);
    } finally {
      await jobs.close();
      server.close();
    }
  }, 900_000);
});
