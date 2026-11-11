import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  emptyCad,
  identityQuaternion,
  mm,
  position,
  topologyRefOf,
  type CadDocument,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { createSimulationJobs } from '../../../scripts/dev/simulation-host.mjs';
import {
  computeEquilibriumTolerance,
  computeJobInp,
  computeModalTolerance,
  referenceComputeLimits,
  solveBondedModalOnHost,
  solveBondedOnHost,
  solveOnHost,
  type SimulationComputeDescriptor,
} from './compute';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-1453 (ST-231#1): a study of two bodies joined by a bond, run with the kernel and Netgen
 * (R3j-4b). Two 100 × 20 × 20 mm bars end to end, the right one's end face following the left
 * one's: clamped at x = 0 and pulled down by 1000 N at x = 200, they bend as one 200 mm
 * cantilever (FX8b: Timoshenko 0.96 mm).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Two bars, `left` over x 0–100 and `right` over x 100–200, each its own body. */
function twoBars(): CadDocument {
  const bar = (id: string, x: number) => ({
    profile: {
      id: `${id}-profile`,
      name: `${id} outline`,
      plane: { origin: position(x, 0, 0), orientation: identityQuaternion() },
      shape: { type: 'rectangle' as const, width: mm(100), height: mm(20) },
    },
    feature: {
      id: `${id}-extrude`,
      name: id,
      type: 'extrude' as const,
      inputFeatureIds: [] as [],
      args: { profileId: `${id}-profile`, distance: mm(20), direction: 1 as const },
    },
    body: {
      id,
      name: id,
      sourceFeatureId: `${id}-extrude`,
      placementFeatureId: `${id}-placement`,
      appearance: { color: '#9aa4b1', opacity: 1 },
    },
  });
  const [l, r] = [bar('left', 0), bar('right', 100)];
  return applyCadOperation(
    emptyCad({ id: 'fixture-kernel', buildHash: `sha256:${'0'.repeat(64)}` }),
    {
      type: 'insertFeatures',
      profiles: [l.profile, r.profile],
      features: [l.feature, r.feature],
      bodies: [l.body, r.body],
    },
  );
}

describe.skipIf(!available)('a bonded study with the kernel and Netgen (R3j-4b)', () => {
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

  const setup = async () => {
    const cad = twoBars();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    const tables = new Map<string, CadTopologyTable>(
      evaluated.meshes.map((m) => [m.bodyId, m.topology]),
    );
    const feature = (id: string) => cad.bodies.find((b) => b.id === id)!.resultFeatureId;
    /** The face of `bodyId` whose centroid is `c`, as a click would pick it. */
    const face = (bodyId: string, c: [number, number, number]) => {
      const t = tables.get(bodyId)!;
      let best = 0;
      t.faces.forEach((f, i) => {
        if (dist(f.centroid, c) < dist(t.faces[best]!.centroid, c)) best = i;
      });
      expect(dist(t.faces[best]!.centroid, c)).toBeLessThan(1e-6);
      return {
        kind: 'face' as const,
        ref: topologyRefOf(t, 'face', best, feature(bodyId)),
        ...(bodyId === 'left' ? {} : { body: bodyId }),
      };
    };
    let doc: SimulationDocument = emptySimulation(
      { artifactId: 'bars', versionId: 'v1', contentHash: cadContentHash(cad), bodyId: 'left' },
      'Bonded bars',
    );
    doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
    doc.materialId = 'steel';
    doc = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'right', materialId: 'steel' },
    });
    doc = applySimulationOperation(doc, {
      type: 'addBond',
      bond: {
        id: 'joint',
        name: 'Joint',
        follower: [face('right', [100, 10, 10])],
        on: [face('left', [100, 10, 10])],
        tolerance: 0.01,
      },
    });
    doc.constraints.push({
      id: 'clamp',
      name: 'Clamp',
      kind: 'fixed',
      targets: [face('left', [0, 10, 10])],
    });
    doc.loads.push({
      id: 'tip',
      name: 'Tip',
      kind: 'force',
      targets: [face('right', [200, 10, 10])],
      force: [0, 0, -1000],
    });
    doc.mesh = { ...doc.mesh, size: 10, minSize: 5, grading: 1.5 };
    doc.studies.push({
      id: 'static',
      name: 'Static',
      kind: 'linear-static',
      loadIds: ['tip'],
      constraintIds: ['clamp'],
      solver: { tolerance: 1e-10, maxIterations: 100_000 },
      convergence: { levels: 1, metrics: ['max-displacement'], tolerance: 0.05 },
    });
    return { cad, doc, tables };
  };

  it('bends two bonded bars as one cantilever, each body with its own result', async () => {
    const { cad, doc, tables } = await setup();
    const run = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'static',
      tables.get('left')!,
      env(),
      tables,
    );
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    expect(run.levels[0]!.checks[0]!.detail).toMatch(/on 2 bodies; Joint ties \d+ nodes/);
    const tip = run.levels[0]!.metrics['max-displacement']!;
    expect(Math.abs(tip / 0.96 - 1)).toBeLessThan(0.05);
    expect(run.levels[0]!.metrics['reaction-force']).toBeCloseTo(1000, 4);
    if (run.fields?.kind !== 'bonded-static') throw new Error('not a bonded run');
    expect(run.fields.bodies.map((b) => b.bodyId)).toEqual(['left', 'right']);
    expect(new Set(run.mapping.map((r) => r.body))).toEqual(new Set(['left', 'right']));
  }, 600_000);

  // TS-1460 (ST-234#2): the same bars on the reference Host, the bond as *EQUATIONs (R3j-5b).
  it.skipIf(!hasCcx)(
    'bends the two bonded bars on the reference Host as in the browser',
    async () => {
      const { cad, doc, tables } = await setup();
      const limits = referenceComputeLimits;
      const jobs = createSimulationJobs({ limits, toInp: async (v) => computeJobInp(v, limits) });
      const server = createServer((req, res) => void jobs.handle(req, res, () => res.end()));
      server.keepAliveTimeout = 600_000;
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const host: SimulationComputeDescriptor = {
        label: 'Reference Host (CalculiX)',
        destination: 'a local test server',
        solverBuild: 'calculix-2.21',
        limits,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
      };
      try {
        const remote = {
          name: host.label,
          limits,
          equilibrium: computeEquilibriumTolerance,
          solve: (input: Parameters<typeof solveOnHost>[1]) => solveOnHost(host, input),
          solveBonded: (input: Parameters<typeof solveBondedOnHost>[1]) =>
            solveBondedOnHost(host, input, { pollMs: 50 }),
        };
        const solve = (r?: typeof remote) =>
          runStudy(
            doc,
            cad,
            cadContentHash(cad),
            'static',
            tables.get('left')!,
            {
              ...env(),
              ...(r ? { remote: r } : {}),
            },
            tables,
          );
        const [onHost, browser] = [await solve(remote), await solve()];
        expect(onHost.failure, JSON.stringify(onHost.failure)).toBeUndefined();
        for (const c of onHost.levels[0]!.checks)
          expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
        expect(onHost.levels[0]!.checks.find((c) => c.name === 'solver')!.detail).toMatch(
          /^direct solve on Reference Host/,
        );
        const [h, b] = [onHost, browser].map((x) => x.levels[0]!.metrics);
        expect(Math.abs(h!['max-displacement']! / b!['max-displacement']! - 1)).toBeLessThan(2e-3);
        expect(h!['reaction-force']).toBeCloseTo(1000, 1);
        if (onHost.fields?.kind !== 'bonded-static') throw new Error('not a bonded run');
        expect(onHost.fields.bodies.map((x) => x.bodyId)).toEqual(['left', 'right']);
        // A Host without bonds refuses the study rather than sending it.
        const { solveBonded: _, ...solidOnly } = remote;
        const refused = await runStudy(
          doc,
          cad,
          cadContentHash(cad),
          'static',
          tables.get('left')!,
          { ...env(), remote: solidOnly },
          tables,
        );
        expect(refused.failure?.code).toBe('host');
      } finally {
        await jobs.close();
        server.close();
      }
    },
    600_000,
  );

  // TS-1463 (ST-235#3): the bonded bars' modes on the reference Host (R3j-5c).
  it.skipIf(!hasCcx)(
    'finds the bonded bars’ modes on the reference Host as in the browser',
    async () => {
      const { cad, doc, tables } = await setup();
      doc.mesh = { ...doc.mesh, size: 14, minSize: 7 };
      doc.studies.push({
        id: 'modes',
        name: 'Modes',
        kind: 'modal',
        modes: 2,
        loadIds: [],
        constraintIds: ['clamp'],
        solver: { tolerance: 1e-4, maxIterations: 2000 },
        convergence: { levels: 1, metrics: ['first-frequency'], tolerance: 0.05 },
      } as (typeof doc.studies)[number]);
      const limits = referenceComputeLimits;
      const jobs = createSimulationJobs({ limits, toInp: async (v) => computeJobInp(v, limits) });
      const server = createServer((req, res) => void jobs.handle(req, res, () => res.end()));
      server.keepAliveTimeout = 600_000;
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const host: SimulationComputeDescriptor = {
        label: 'Reference Host (CalculiX)',
        destination: 'a local test server',
        solverBuild: 'calculix-2.21',
        limits,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
      };
      try {
        const remote = {
          name: host.label,
          limits,
          orthogonality: computeModalTolerance,
          solve: () => Promise.reject(new Error('not called')),
          solveBondedModal: (input: Parameters<typeof solveBondedModalOnHost>[1]) =>
            solveBondedModalOnHost(host, input, { pollMs: 50 }),
        };
        const solve = (r?: typeof remote) =>
          runStudy(
            doc,
            cad,
            cadContentHash(cad),
            'modes',
            tables.get('left')!,
            { ...env(), ...(r ? { remote: r } : {}) },
            tables,
          );
        const [onHost, browser] = [await solve(remote), await solve()];
        expect(onHost.failure, JSON.stringify(onHost.failure)).toBeUndefined();
        for (const c of onHost.levels[0]!.checks)
          expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
        const [h, b] = [onHost, browser].map((x) => x.levels[0]!.metrics['first-frequency']!);
        expect(Math.abs(h! / b! - 1)).toBeLessThan(5e-3);
        if (onHost.fields?.kind !== 'bonded-modal') throw new Error('not a bonded modal run');
        expect(onHost.fields.bodies.map((x) => x.bodyId)).toEqual(['left', 'right']);
        for (const x of onHost.fields.bodies)
          expect(x.fields.modes[0]!.shape.length).toBe(x.fields.mesh.nodes.length);
        // A Host that solves bonded bodies statically only refuses their modes.
        const { solveBondedModal: _, ...staticOnly } = remote;
        expect((await solve(staticOnly as typeof remote)).failure?.code).toBe('host');
      } finally {
        await jobs.close();
        server.close();
      }
    },
    600_000,
  );

  // TS-1455 (ST-232#2): the same bars' modes as one 200 mm cantilever (R3j-4c).
  it('finds the modes of the two bonded bars, each body with its own shapes', async () => {
    const { cad, doc, tables } = await setup();
    // Within the browser's 10 000-node modal limit.
    doc.mesh = { ...doc.mesh, size: 14, minSize: 7 };
    doc.studies.push({
      id: 'modes',
      name: 'Modes',
      kind: 'modal',
      modes: 2,
      loadIds: [],
      constraintIds: ['clamp'],
      solver: { tolerance: 1e-4, maxIterations: 2000 },
      convergence: { levels: 1, metrics: ['first-frequency'], tolerance: 0.05 },
    } as (typeof doc.studies)[number]);
    const run = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'modes',
      tables.get('left')!,
      env(),
      tables,
    );
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    // Euler–Bernoulli 1.875² / 2π √(E I / ρ A L⁴) = 410 Hz; tet10 runs a little stiff.
    const f1 = run.levels[0]!.metrics['first-frequency']!;
    expect(Math.abs(f1 / 410 - 1)).toBeLessThan(0.05);
    if (run.fields?.kind !== 'bonded-modal') throw new Error('not a bonded modal run');
    expect(run.fields.bodies.map((b) => b.bodyId)).toEqual(['left', 'right']);
    for (const b of run.fields.bodies)
      expect(b.fields.modes[0]!.shape.length).toBe(b.fields.mesh.nodes.length);
  }, 600_000);

  it('refuses an unbonded body and a bond beyond its tolerance', async () => {
    const { cad, doc, tables } = await setup();
    const run = (d: SimulationDocument) =>
      runStudy(d, cad, cadContentHash(cad), 'static', tables.get('left')!, env(), tables);
    // Without the bond the right bar is held by nothing.
    const unbonded = structuredClone(doc);
    delete unbonded.bonds;
    const loose = await run(unbonded);
    expect(loose.failure?.code).toBe('solve');
    expect(loose.failure?.detail).toMatch(/^body-unconnected/);
    // The joint set to follow the left bar's far end: 100 mm away, the bond holds 0.01 mm.
    const moved = structuredClone(doc);
    const far = { ...moved.bonds![0]! };
    far.on = [
      {
        ...far.on[0]!,
        ref: topologyRefOf(
          tables.get('left')!,
          'face',
          tables.get('left')!.faces.findIndex((f) => dist(f.centroid, [0, 10, 10]) < 1e-6),
          cad.bodies.find((b) => b.id === 'left')!.resultFeatureId,
        ),
      },
    ];
    moved.bonds = [far];
    const gap = await run(moved);
    expect(gap.failure?.code).toBe('solve');
    expect(gap.failure?.detail).toMatch(/^bond-gap/);
  }, 600_000);
});
