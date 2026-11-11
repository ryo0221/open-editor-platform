import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cadContentHash,
  sportsCarBody,
  topologyRefOf,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad, type CadMesh } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { createSimulationJobs } from '../../../scripts/dev/simulation-host.mjs';
import { bondCandidates, candidateBond } from './bond-candidates';
import {
  computeEquilibriumTolerance,
  computeJobInp,
  computeModalTolerance,
  referenceComputeLimits,
  solveBondedModalOnHost,
  solveBondedOnHost,
  type SimulationComputeDescriptor,
} from './compute';
import { runStudy, type RunEnvironment, type StudyRun } from './run';

/**
 * TS-1469 (ST-239#1): FX9, the sports car's body (docs/cad/r3-analysis.md, R3j-6). Five plates
 * (0.8–1.5 mm shells) and four solid mounts of one CAD version, joined by the bonds the shape
 * offers; the mounts held at their feet, the roof pressed by 1 kPa. Static and modal studies are
 * solved on the reference Host and in the browser (a coarse mesh): every check passes and the two
 * agree within 2 %.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
/** The browser's element size (mm) for each study; the Host solves 50 mm. */
const browserSize = { static: 70, modes: 100 };
const mounts = ['mount-rear-left', 'mount-rear-right', 'mount-front-left', 'mount-front-right'];

describe.skipIf(!available || !hasCcx)(
  'FX9: the sports car body on the reference Host (R3j-6)',
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

    /** The analysis as the Playground makes it: every body, the bonds offered, the conditions. */
    const setup = async () => {
      const cad = sportsCarBody();
      const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
      const meshes = new Map<string, CadMesh>(
        evaluated.meshes.filter((m) => !m.lod).map((m) => [m.bodyId, m]),
      );
      const tables = new Map<string, CadTopologyTable>(
        [...meshes].map(([id, m]) => [id, m.topology]),
      );
      const named = new Map(
        cad.bodies.map((b) => [
          b.id,
          { table: tables.get(b.id)!, featureId: b.resultFeatureId, name: b.name },
        ]),
      );
      const face = (bodyId: string, c: [number, number, number]) => {
        const t = tables.get(bodyId)!;
        let best = 0;
        t.faces.forEach((f, i) => {
          if (dist(f.centroid, c) < dist(t.faces[best]!.centroid, c)) best = i;
        });
        expect(dist(t.faces[best]!.centroid, c)).toBeLessThan(1e-3);
        return {
          kind: 'face' as const,
          ref: topologyRefOf(t, 'face', best, named.get(bodyId)!.featureId),
          ...(bodyId === 'roof' ? {} : { body: bodyId }),
        };
      };
      let doc: SimulationDocument = emptySimulation(
        { artifactId: 'car', versionId: 'v1', contentHash: cadContentHash(cad), bodyId: 'roof' },
        'Sports car body',
      );
      doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
      doc.materialId = 'steel';
      for (const b of cad.bodies)
        if (b.id !== 'roof')
          doc = applySimulationOperation(doc, {
            type: 'addBody',
            body: {
              bodyId: b.id,
              materialId: 'steel',
              ...(mounts.includes(b.id) ? { idealisation: 'solid' as const } : {}),
            },
          });
      const offered = bondCandidates(
        cad.bodies.map((b) => ({
          bodyId: b.id,
          mesh: meshes.get(b.id)!,
          shell: !mounts.includes(b.id),
        })),
        0.5,
      );
      for (const c of offered.candidates)
        doc = applySimulationOperation(doc, {
          type: 'addBond',
          bond: candidateBond(doc, c, named, 0.5),
        });
      doc.constraints.push({
        id: 'feet',
        name: 'Mount feet',
        kind: 'fixed',
        targets: [
          face('mount-rear-left', [-50, -600, -20]),
          face('mount-rear-right', [-50, 600, -20]),
          face('mount-front-left', [2050, -600, -20]),
          face('mount-front-right', [2050, 600, -20]),
        ],
      });
      doc.loads.push({
        id: 'roof-load',
        name: 'Roof 1 kPa',
        kind: 'pressure',
        targets: [face('roof', [800, 0, 399])],
        pressure: 0.001,
      });
      doc.mesh = { ...doc.mesh, size: 50, minSize: 10, grading: 1.5 };
      const base = {
        constraintIds: ['feet'],
        idealisation: 'shell' as const,
        convergence: { levels: 1, tolerance: 0.05 },
      };
      doc.studies.push(
        {
          ...base,
          id: 'static',
          name: 'Static',
          kind: 'linear-static',
          loadIds: ['roof-load'],
          solver: { tolerance: 1e-10, maxIterations: 200_000 },
          convergence: { ...base.convergence, metrics: ['max-displacement'] },
        },
        {
          ...base,
          id: 'modes',
          name: 'Modes',
          kind: 'modal',
          modes: 4,
          loadIds: [],
          solver: { tolerance: 1e-4, maxIterations: 4000 },
          convergence: { ...base.convergence, metrics: ['first-frequency'] },
        },
      );
      return { cad, doc, tables, offered };
    };

    const host = async () => {
      const limits = referenceComputeLimits;
      const jobs = createSimulationJobs({ limits, toInp: async (v) => computeJobInp(v, limits) });
      const server = createServer((req, res) => void jobs.handle(req, res, () => res.end()));
      server.keepAliveTimeout = 600_000;
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const descriptor: SimulationComputeDescriptor = {
        label: 'Reference Host (CalculiX)',
        destination: 'a local test server',
        solverBuild: 'calculix-2.21',
        limits,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
      };
      return {
        remote: {
          name: descriptor.label,
          limits,
          equilibrium: computeEquilibriumTolerance,
          orthogonality: computeModalTolerance,
          solve: () => Promise.reject(new Error('not called')),
          solveBonded: (input: Parameters<typeof solveBondedOnHost>[1]) =>
            solveBondedOnHost(descriptor, input, { pollMs: 100 }),
          solveBondedModal: (input: Parameters<typeof solveBondedModalOnHost>[1]) =>
            solveBondedModalOnHost(descriptor, input, { pollMs: 100 }),
        },
        close: async () => {
          await jobs.close();
          server.close();
        },
      };
    };

    const passes = (run: StudyRun) => {
      expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
      for (const c of run.levels.at(-1)!.checks)
        expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    };

    it('offers a bond at every joint: the plates on the fenders, the fenders on the mounts', async () => {
      const { offered } = await setup();
      expect(offered.notOffered).toEqual([]);
      const pairs = offered.candidates.map((c) => `${c.follower.bodyId}>${c.on.bodyId}`).sort();
      expect(pairs).toEqual(
        [
          'bonnet>fender-left',
          'bonnet>fender-right',
          'fender-left>mount-front-left',
          'fender-left>mount-rear-left',
          'fender-right>mount-front-right',
          'fender-right>mount-rear-right',
          'floor>fender-left',
          'floor>fender-right',
          'roof>fender-left',
          'roof>fender-right',
        ].sort(),
      );
      for (const c of offered.candidates) expect(c.gap).toBeLessThan(1e-4);
    }, 600_000);

    for (const studyId of ['static', 'modes'] as const)
      it(`solves the ${studyId === 'static' ? 'roof load' : 'modes'} on the Host as in the browser`, async () => {
        const { cad, doc, tables } = await setup();
        const h = await host();
        try {
          const solve = (onHost: boolean) =>
            runStudy(
              // The browser solves a coarser mesh, within its limits (FX9).
              onHost ? doc : { ...doc, mesh: { ...doc.mesh, size: browserSize[studyId] } },
              cad,
              cadContentHash(cad),
              studyId,
              tables.get('roof')!,
              { ...env(), ...(onHost ? { remote: h.remote } : {}) },
              tables,
            );
          const started = performance.now();
          const onHost = await solve(true);
          const hostMs = performance.now() - started;
          console.log(`FX9 ${studyId} Host ${(hostMs / 1000).toFixed(1)} s`);
          const browser = await solve(false);
          passes(onHost);
          passes(browser);
          const metric = studyId === 'static' ? 'max-displacement' : 'first-frequency';
          const [a, b] = [onHost, browser].map((r) => r.levels.at(-1)!.metrics[metric]!);
          console.log(
            `FX9 ${studyId}: Host ${a} browser ${b} (ratio ${(a! / b!).toFixed(4)}), Host ${(hostMs / 1000).toFixed(1)} s; ${onHost.levels
              .at(-1)!
              .checks.map((c) => `${c.name}: ${c.detail}`)
              .join(' | ')}`,
          );
          expect(Math.abs(a! / b! - 1)).toBeLessThan(0.02);
          if (onHost.fields?.kind !== 'bonded-static' && onHost.fields?.kind !== 'bonded-modal')
            throw new Error('not a bonded run');
          expect(onHost.fields.bodies.map((x) => x.bodyId)).toEqual([
            'roof',
            ...cad.bodies.filter((x) => x.id !== 'roof').map((x) => x.id),
          ]);
        } finally {
          await h.close();
        }
      }, 1_200_000);
  },
);
