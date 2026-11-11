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
import { simulationFixture, type SimulationDocument } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSimulationJobs } from '../../../scripts/dev/simulation-host.mjs';
import {
  computeEquilibriumTolerance,
  computeJobInp,
  computeModalTolerance,
  referenceComputeLimits,
  solveModalOnHost,
  solveOnHost,
  type SimulationComputeDescriptor,
} from './compute';
import { defaultModalStudy, defaultThermalStudy } from './conditions';
import { runStudy, type RunEnvironment } from './run';

const root = path.resolve(__dirname, '../../..');
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)('a study run with the kernel and Netgen (R3e-3)', () => {
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
  /** The body's table from a display evaluation, as the editor holds it. */
  const tableOf = async (cad: CadDocument, bodyId: string): Promise<CadTopologyTable> => {
    const r = await evaluateCad(oc, cad, cadContentHash(cad));
    return r.meshes.find((m) => m.bodyId === bodyId)!.topology;
  };
  /**
   * The fixture's face names are placeholders: the targets are picked again on the evaluated
   * table, by the face whose centroid is the fixture's (as a click in the viewport would).
   */
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
    // Level 1 is size 10, min 2: the 30 000-node browser limit (cad-r3-performance) takes no finer.
    doc.mesh = { ...doc.mesh, size: 10 * Math.SQRT2, minSize: 2 * Math.SQRT2, grading: 1.5 };
    doc.studies[0]!.convergence.levels = 2;
    // A thin plate is ill-conditioned for the Jacobi PCG: the fixture's 10 000 iterations stop short.
    doc.studies[0]!.solver = { tolerance: 1e-8, maxIterations: 200_000 };
    doc.studies[0]!.convergence.tolerance = 0.05;
    return { cad, doc, table };
  };

  it('bends the F02 plate: every check passes on both levels, the tip moves as a cantilever', async () => {
    const { cad, doc, table } = await plate();
    const steps: string[] = [];
    const run = await runStudy(doc, cad, cadContentHash(cad), 'static', table, {
      ...env(),
      checkpoint: (p) => void steps.push(`${p.level}:${p.step}`),
    });
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    expect(run.levels).toHaveLength(2);
    for (const level of run.levels)
      for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    expect(steps.slice(0, 5)).toEqual(['0:surface', '0:mesh', '0:mapping', '0:solve', '0:checks']);
    // Beam theory gives 500 × 80³ / (3 × 210 000 × 50 × 5³ / 12) = 0.780 mm; a plate 10 times as
    // wide as thick bends nearer the plate stiffness E t³ / 12 (1 − ν²), 9 % stiffer (0.710 mm);
    // the hole and shear add a little.
    const tip = run.levels[1]!.metrics['max-displacement'];
    expect(tip).toBeGreaterThan(0.71);
    expect(tip).toBeLessThan(0.85);
    expect(run.levels[1]!.metrics['reaction-force']).toBeCloseTo(500, 6);
    expect(run.levels[1]!.nodes).toBeGreaterThan(run.levels[0]!.nodes);
    expect(run.mapping.every((r) => r.status === 'resolved')).toBe(true);
    expect(run.fields!.kind === undefined && run.fields!.displacement.length).toBe(
      (run.fields as { mesh: { nodes: Float64Array } }).mesh.nodes.length,
    );
    expect(['verified', 'reference']).toContain(run.status.status);
  }, 600_000);

  it("finds the plate's natural modes on two levels, refused by a Host without modes (TS-1384, ST-199#2)", async () => {
    const { cad, doc, table } = await plate();
    // Two coarse levels (20 and 14.1 mm) within the browser's 10 000-node modal limit.
    doc.mesh = { ...doc.mesh, size: 20, minSize: 4 };
    const modal = { ...defaultModalStudy(doc), modes: 4 };
    doc.studies.push(modal);
    const steps: string[] = [];
    const run = await runStudy(doc, cad, cadContentHash(cad), modal.id, table, {
      ...env(),
      checkpoint: (p) => void steps.push(`${p.level}:${p.step}`),
    });
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    expect(run.levels).toHaveLength(2);
    for (const level of run.levels) {
      expect(level.checks.map((c) => c.name).sort()).toEqual(
        ['mapping', 'mass', 'quality', 'orthogonality', 'solver'].sort(),
      );
      for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    }
    expect(steps.slice(0, 5)).toEqual(['0:surface', '0:mesh', '0:mapping', '0:solve', '0:checks']);
    // A cantilever 80 long and 5 thick bends out of plane first: 1.875² / (2π L²) · t √(E / 12ρ)
    // = 653 Hz as a beam, 5 % stiffer as a plate (1 / √(1 − ν²)); the hole lowers it a little.
    const f1 = run.levels[1]!.metrics['first-frequency']!;
    expect(f1).toBeGreaterThan(600);
    expect(f1).toBeLessThan(720);
    const fields = run.fields!;
    expect(fields.kind).toBe('modal');
    if (fields.kind !== 'modal') return;
    expect(fields.modes).toHaveLength(4);
    expect(fields.modes[0]!.frequency).toBe(f1);
    for (let k = 1; k < 4; k++)
      expect(fields.modes[k]!.frequency).toBeGreaterThanOrEqual(fields.modes[k - 1]!.frequency);
    // Out of plane: the first mode moves the mass in z.
    expect(fields.modes[0]!.effectiveMass[2]).toBeGreaterThan(0.4);
    expect(fields.modes[0]!.shape.length).toBe(fields.mesh.nodes.length);
    expect(['verified', 'reference']).toContain(run.status.status);
    // A Host that solves no modal study (R3j-5c: `solveModal`) refuses it rather than send it.
    const remote = await runStudy(doc, cad, cadContentHash(cad), modal.id, table, {
      ...env(),
      remote: {
        name: 'Host',
        limits: referenceComputeLimits,
        solve: () => Promise.reject(new Error('not called')),
      },
    });
    expect(remote.failure?.code).toBe('host');
  }, 600_000);

  it('CR5a (TS-1555): an added mass on the tip face lowers the modes and counts in the mass check', async () => {
    const { cad, doc, table } = await plate();
    doc.mesh = { ...doc.mesh, size: 20, minSize: 4 };
    const modal = {
      ...defaultModalStudy(doc),
      modes: 2,
      convergence: { ...defaultModalStudy(doc).convergence, levels: 1 },
    };
    doc.studies.push(modal);
    const bare = await runStudy(doc, cad, cadContentHash(cad), modal.id, table, env());
    expect(bare.failure, JSON.stringify(bare.failure)).toBeUndefined();
    const mass = bare.levels[0]!.checks.find((c) => c.name === 'mass')!;
    const plateMass = Number(/for (\S+) t/.exec(mass.detail)![1]);
    // The plate's own mass again, on the face the fixture's force pulls.
    const force = doc.loads.find((l) => l.kind === 'force')!;
    const heavy = structuredClone(doc);
    heavy.schemaVersion = 2;
    heavy.masses = [
      {
        id: 'tip-mass',
        name: 'Tip mass',
        targets: 'targets' in force ? force.targets : [],
        mass: plateMass,
      },
    ];
    const run = await runStudy(heavy, cad, cadContentHash(cad), modal.id, table, env());
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    const check = run.levels[0]!.checks.find((c) => c.name === 'mass')!;
    expect(check.detail).toContain('t added');
    const meshMass = (d: string) => Number(/^mesh (\S+) t/.exec(d)![1]);
    expect(meshMass(check.detail)).toBeCloseTo(meshMass(mass.detail) + plateMass, 12);
    // A cantilever with its own mass at the tip: (βL / 1.875)² = (1.2479 / 1.8751)² = 0.443 of the
    // bare frequency (Euler–Bernoulli); the hole and the face's width move it a little.
    const ratio =
      run.levels[0]!.metrics['first-frequency']! / bare.levels[0]!.metrics['first-frequency']!;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.5);
  }, 600_000);

  it('conducts heat along the plate from a held end to a cooled end (TS-1389, ST-201#2)', async () => {
    const { cad, doc, table } = await plate();
    // The support's face (x = 0) held at 400 K; the loaded end (x = 80) cooled by 300 K air.
    const fixed = doc.constraints[0]!;
    const loaded = doc.loads[0]! as { targets: typeof fixed.targets };
    doc.constraints.push({
      id: 'hot',
      name: 'Hot end',
      kind: 'temperature',
      targets: fixed.targets,
      temperature: 400,
    });
    doc.loads.push({
      id: 'air',
      name: 'Air',
      kind: 'convection',
      targets: loaded.targets,
      coefficient: 0.1,
      ambient: 300,
    });
    const thermal = defaultThermalStudy(doc);
    doc.studies.push(thermal);
    const run = await runStudy(doc, cad, cadContentHash(cad), thermal.id, table, env());
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    expect(run.levels).toHaveLength(2);
    for (const level of run.levels)
      for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    // In one dimension q = (400 − 300) / (L / k + 1 / h) = 100 / (1.6 + 10) = 8.62 kW/m², so the
    // cooled end is at 300 + q / h = 386.2 K; the hole narrows the path and lowers it a little.
    const fields = run.fields!;
    if (fields.kind !== 'thermal') throw new Error('not thermal');
    const t = Array.from(fields.temperature);
    expect(Math.max(...t)).toBeCloseTo(400, 9);
    expect(Math.min(...t)).toBeGreaterThan(383);
    expect(Math.min(...t)).toBeLessThan(386.3);
    expect(run.levels[1]!.metrics['max-temperature']).toBeCloseTo(400, 9);
    expect(['verified', 'reference']).toContain(run.status.status);
    // Without a conductivity it is refused before meshing.
    delete doc.materials[0]!.conductivity;
    const none = await runStudy(doc, cad, cadContentHash(cad), thermal.id, table, env());
    expect(none.failure?.code).toBe('material-missing');
  }, 600_000);

  it('checks a pressure against ∫ p n dA and holds a roller on an axis plane', async () => {
    const { cad, doc, table } = await plate();
    const tip = doc.loads[0]!;
    const fixed = doc.constraints[0]!;
    const next: SimulationDocument = {
      ...doc,
      loads: [
        {
          id: 'push',
          name: 'Push',
          kind: 'pressure',
          targets: 'targets' in tip ? tip.targets : [],
          pressure: 2,
        },
      ],
      constraints: [
        { ...fixed, kind: 'roller' },
        { id: 'pin', name: 'Pin', kind: 'fixed', targets: fixed.targets },
      ],
      studies: [
        {
          ...doc.studies[0]!,
          loadIds: ['push'],
          constraintIds: [fixed.id, 'pin'],
          convergence: { ...doc.studies[0]!.convergence, levels: 1 },
        },
      ],
    };
    const run = await runStudy(next, cad, cadContentHash(cad), 'static', table, env());
    expect(run.failure).toBeUndefined();
    const load = run.levels[0]!.checks.find((c) => c.name === 'load')!;
    expect(load.pass, load.detail).toBe(true);
    // 2 MPa on the 50 × 5 end face: 500 N into the body.
    // The pressure's resultant carries the mesh's area error (0.5 % allowed).
    expect(Math.abs(run.levels[0]!.metrics['reaction-force']! / 500 - 1)).toBeLessThan(0.005);
    expect(run.status.status).toBe('reference');
  }, 600_000);

  it('refuses a force on faces and edges at once and a roller on a curved face', async () => {
    const { cad, doc, table } = await plate();
    const tip = doc.loads[0]!;
    const fixed = doc.constraints[0]!;
    if (!('targets' in tip) || !('targets' in fixed)) throw new Error('fixture');
    const featureId = tip.targets[0]!.ref.featureId;
    const one = {
      ...doc,
      studies: [{ ...doc.studies[0]!, convergence: { ...doc.studies[0]!.convergence, levels: 1 } }],
    };
    const mixed: SimulationDocument = {
      ...one,
      loads: [
        {
          ...tip,
          targets: [
            ...tip.targets,
            { kind: 'edge', ref: topologyRefOf(table, 'edge', 0, featureId) },
          ],
        },
      ],
    };
    const r1 = await runStudy(mixed, cad, cadContentHash(cad), 'static', table, env());
    expect(r1.failure).toMatchObject({ code: 'load-targets-mixed', level: 0 });
    // The hole's wall: the one face whose centroid is inside the plate, off its six planes.
    const wall = table.faces.findIndex(
      (f) =>
        f.centroid[0] > 1 &&
        f.centroid[0] < 79 &&
        f.centroid[1] > 1 &&
        f.centroid[1] < 49 &&
        f.centroid[2] > 1 &&
        f.centroid[2] < 4,
    );
    expect(wall).toBeGreaterThanOrEqual(0);
    const curved: SimulationDocument = {
      ...one,
      constraints: [
        fixed,
        {
          id: 'slide',
          name: 'Slide',
          kind: 'roller',
          targets: [{ kind: 'face', ref: topologyRefOf(table, 'face', wall, featureId) }],
        },
      ],
      studies: [{ ...one.studies[0]!, constraintIds: [fixed.id, 'slide'] }],
    };
    const r2 = await runStudy(curved, cad, cadContentHash(cad), 'static', table, env());
    expect(r2.failure).toMatchObject({ code: 'roller-direction', level: 0 });
  }, 600_000);

  it('refuses a mapping that does not resolve and a mesh over the browser limit', async () => {
    const { cad, doc, table } = await plate();
    const fixed = doc.constraints[0]!;
    const lost: SimulationDocument = {
      ...doc,
      constraints: [
        {
          ...fixed,
          targets: [
            {
              kind: 'face',
              ref: {
                ...('targets' in fixed ? fixed.targets[0]!.ref : ({} as never)),
                name: [['nope', 'side:9']],
              },
            },
          ],
        },
      ],
    };
    const r1 = await runStudy(lost, cad, cadContentHash(cad), 'static', table, env());
    expect(r1.failure).toMatchObject({ code: 'mapping', level: 0 });
    expect(r1.mapping.some((r) => r.status === 'missing')).toBe(true);
    const fine = { ...doc, mesh: { ...doc.mesh, size: 0.9, minSize: 0.5 } };
    const r2 = await runStudy(fine, cad, cadContentHash(cad), 'static', table, env());
    expect(r2.failure).toMatchObject({ code: 'mesh-too-large', level: 0 });
    expect(r2.failure!.detail).toMatch(/expected/);
    // Another table than the kernel's is refused.
    const r3 = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'static',
      { ...table, faces: table.faces.slice(1) },
      env(),
    );
    expect(r3.failure).toMatchObject({ code: 'table-mismatch' });
  }, 600_000);

  /** The reference Host's job store on a local server (ccx on the server side, R3f-2). */
  const referenceHost = async () => {
    const limits = referenceComputeLimits;
    const jobs = createSimulationJobs({
      limits,
      toInp: async (value) => computeJobInp(value, limits),
    });
    const server = createServer((req, res) => void jobs.handle(req, res, () => res.end()));
    // Meshing blocks this thread (the server's too) for longer than the 5 s keep-alive: an idle
    // socket closed late would reset the next request. A real Host is another process.
    server.keepAliveTimeout = 600_000;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const host: SimulationComputeDescriptor = {
      label: 'Reference Host (CalculiX)',
      destination: 'a local test server',
      solverBuild: 'calculix-2.21',
      limits,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
    };
    return {
      host,
      remote: {
        name: host.label,
        limits: host.limits,
        equilibrium: computeEquilibriumTolerance,
        solve: (input: Parameters<typeof solveOnHost>[1]) =>
          solveOnHost(host, input, { pollMs: 50 }),
        orthogonality: computeModalTolerance,
        solveModal: (input: Parameters<typeof solveModalOnHost>[1]) =>
          solveModalOnHost(host, input, { pollMs: 50 }),
      },
      close: async () => {
        await jobs.close();
        server.close();
      },
    };
  };

  it.skipIf(!hasCcx)(
    'R3f-3: the same study on the reference Host agrees with the browser run and passes its checks above the browser limit',
    async () => {
      const { cad, doc, table } = await plate();
      const ref = await referenceHost();
      try {
        const steps: string[] = [];
        const browser = await runStudy(doc, cad, cadContentHash(cad), 'static', table, env());
        const onHost = await runStudy(doc, cad, cadContentHash(cad), 'static', table, {
          ...env(),
          builds: { ...env().builds, solver: ref.host.solverBuild },
          remote: ref.remote,
          checkpoint: (p) => void steps.push(`${p.step}${p.on ? `@${p.on}` : ''}`),
        });
        expect(onHost.failure, JSON.stringify(onHost.failure)).toBeUndefined();
        expect(steps).toContain('solve@Reference Host (CalculiX)');
        expect(onHost.builds.solver).toBe('calculix-2.21');
        onHost.levels.forEach((level, i) => {
          for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
          const mine = browser.levels[i]!.metrics;
          // Same mesh, same nodal data: the PCG stops at 1e-8, CalculiX solves directly.
          for (const m of ['max-displacement', 'reaction-force'] as const)
            expect(Math.abs(level.metrics[m]! / mine[m]! - 1), m).toBeLessThan(2e-3);
          // CalculiX extrapolates its stresses from the Gauss points before averaging them at the
          // nodes; at the hole's peak that differs from the exact nodal values by about 0.5 %.
          const vm = level.metrics['max-von-mises']! / mine['max-von-mises']! - 1;
          expect(Math.abs(vm), 'max-von-mises').toBeLessThan(0.02);
        });
        expect(onHost.levels[1]!.checks.find((c) => c.name === 'solver')!.detail).toContain(
          'direct solve by calculix-2.21',
        );
        // Finer than the browser takes (30 000 nodes): refused here, solved on the Host.
        const fine = {
          ...doc,
          mesh: { ...doc.mesh, size: 4, minSize: 1.5 },
          studies: [
            { ...doc.studies[0]!, convergence: { ...doc.studies[0]!.convergence, levels: 1 } },
          ],
        };
        const tooLarge = await runStudy(fine, cad, cadContentHash(cad), 'static', table, env());
        expect(tooLarge.failure?.code).toBe('mesh-too-large');
        const large = await runStudy(fine, cad, cadContentHash(cad), 'static', table, {
          ...env(),
          remote: ref.remote,
        });
        expect(large.failure, JSON.stringify(large.failure)).toBeUndefined();
        expect(large.levels[0]!.nodes).toBeGreaterThan(30_000);
        for (const c of large.levels[0]!.checks)
          expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
        expect(large.levels[0]!.metrics['reaction-force']).toBeCloseTo(500, 2);
      } finally {
        await ref.close();
      }
    },
    600_000,
  );

  // TS-1463 (ST-235#3): the plate's modes on the reference Host (R3j-5c).
  it.skipIf(!hasCcx)(
    "R3j-5c: the plate's modes on the reference Host agree with the browser, and above the browser's modal limit",
    async () => {
      const { cad, doc, table } = await plate();
      doc.mesh = { ...doc.mesh, size: 20, minSize: 4 };
      const modal = { ...defaultModalStudy(doc), modes: 4 };
      doc.studies.push(modal);
      const ref = await referenceHost();
      try {
        const browser = await runStudy(doc, cad, cadContentHash(cad), modal.id, table, env());
        const onHost = await runStudy(doc, cad, cadContentHash(cad), modal.id, table, {
          ...env(),
          builds: { ...env().builds, solver: ref.host.solverBuild },
          remote: ref.remote,
        });
        expect(onHost.failure, JSON.stringify(onHost.failure)).toBeUndefined();
        onHost.levels.forEach((level, i) => {
          for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
          const f = level.metrics['first-frequency']!;
          const mine = browser.levels[i]!.metrics['first-frequency']!;
          expect(Math.abs(f / mine - 1)).toBeLessThan(2e-3);
        });
        expect(onHost.levels[0]!.checks.find((c) => c.name === 'solver')!.detail).toMatch(
          /^eigensolve on Reference Host \(CalculiX\), frequencies from φᵀ K φ; largest \|φᵀ K φ \/ λ_CalculiX − 1\|/,
        );
        if (onHost.fields?.kind !== 'modal' || browser.fields?.kind !== 'modal')
          throw new Error('not a modal run');
        const browserModes = browser.fields.modes;
        // The first mode out of plane carries the same share of the mass in z.
        expect(
          Math.abs(onHost.fields.modes[0]!.effectiveMass[2] - browserModes[0]!.effectiveMass[2]),
        ).toBeLessThan(0.01);
        // Finer than the browser's 10 000-node modal limit: refused there, solved on the Host.
        const fine = {
          ...doc,
          mesh: { ...doc.mesh, size: 4, minSize: 1.5 },
          studies: [{ ...modal, convergence: { ...modal.convergence, levels: 1 } }],
        };
        const tooLarge = await runStudy(fine, cad, cadContentHash(cad), modal.id, table, env());
        expect(tooLarge.failure?.code).toBe('mesh-too-large');
        const large = await runStudy(fine, cad, cadContentHash(cad), modal.id, table, {
          ...env(),
          remote: ref.remote,
        });
        expect(large.failure, JSON.stringify(large.failure)).toBeUndefined();
        expect(large.levels[0]!.nodes).toBeGreaterThan(10_000);
        for (const c of large.levels[0]!.checks)
          expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      } finally {
        await ref.close();
      }
    },
    600_000,
  );
});
