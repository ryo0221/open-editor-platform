import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  topologyRefOf,
  f01Empty,
  f18Hood,
  identityQuaternion,
  mm,
  position,
  sportsCarBonnet,
  type CadDocument,
} from '@editor-platform/cad-core';
import { evaluateCad, type CadAnalysisSurface } from '@editor-platform/cad-kernel-occt';
import {
  shellEquilibriumCheck,
  shellMeshFromSurface,
  shellMeshQuality,
  solveShell,
  solveShellModal,
} from '@editor-platform/geometry-fem';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  simulationFixture,
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
  referenceComputeLimits,
  solveOnHost,
  solveShellOnHost,
  type SimulationComputeDescriptor,
} from './compute';
import { defaultModalStudy } from './conditions';
import { resultVtu, runResult } from './results';
import { runStudy, type RunEnvironment } from './run';

const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));
const withMesher = available && existsSync(path.join(mesher, 'fem-mesher.wasm'));
const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-9, maxIterations: 20_000 };

/** An 80 × 50 plate extruded 5 mm. */
const slab = (): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'outline',
        name: 'Outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(80), height: mm(50) },
      },
    ],
    features: [
      {
        id: 'slab',
        name: 'Slab',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'outline', distance: mm(5), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'slab-body',
        name: 'Slab',
        sourceFeatureId: 'slab',
        placementFeatureId: 'slab-placement',
        appearance: { color: '#999999', opacity: 1 },
      },
    ],
  });

describe.skipIf(!available)('shell meshes of CAD midsurfaces (R3i-3, TS-1393, ST-204)', () => {
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

  const midsurface = async (cad: CadDocument, bodyId: string, size: number) => {
    const r = await evaluateCad(oc, cad, cadContentHash(cad), {
      analysisSurface: {
        bodyId,
        deflectionMm: 0.05,
        clampDeflection: true,
        maxEdgeMm: size,
        idealisation: 'shell',
      },
    });
    const s = r.analysisSurface;
    if (!s || !('surface' in s)) throw new Error(JSON.stringify(s));
    return s.surface;
  };
  /** The midsurface edges of the body's side faces picked by `pick` on their centroids. */
  const sideEdges = (s: CadAnalysisSurface, pick: (c: [number, number, number]) => boolean) =>
    s.history.faces.flatMap((f, i) =>
      f.deleted && pick(s.bodyTopology.faces[i]!.centroid as [number, number, number])
        ? f.edges!
        : [],
    );

  it('bends an extruded plate held at one end as a plate strip should', async () => {
    const s = await midsurface(slab(), 'slab-body', 5);
    const mesh = shellMeshFromSurface(s, s.shell!.thicknessMm);
    const quality = shellMeshQuality(mesh);
    expect(quality.below).toEqual([]);
    const xs = s.bodyTopology.faces.map((f) => f.centroid[0]!);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const r = solveShell({
      mesh,
      material: steel,
      loads: [
        { kind: 'edge-force', edges: sideEdges(s, (c) => c[0] > x1 - 1e-6), force: [0, 0, -100] },
      ],
      constraints: [
        {
          faces: [],
          edges: sideEdges(s, (c) => c[0] < x0 + 1e-6),
          displacement: [0, 0, 0],
          rotation: [0, 0, 0],
        },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    expect(shellEquilibriumCheck(r).pass).toBe(true);
    // A cantilever 80 long, 50 wide, 5 thick: P L³ / (3 E I) = 0.156 mm as a beam, (1 − ν²) of it
    // (0.142) as a strip held across its whole width; the plate lies between.
    let tip = 0;
    for (let p = 0; p < mesh.nodes.length / 3; p++)
      if (mesh.nodes[3 * p]! > x1 - 1e-6) tip = Math.min(tip, r.displacement[6 * p + 2]!);
    const beam = (100 * 80 ** 3) / (3 * 210_000 * ((50 * 5 ** 3) / 12));
    expect(-tip).toBeGreaterThan(0.97 * beam * (1 - 0.09));
    expect(-tip).toBeLessThan(1.03 * beam);
  }, 300_000);

  it('solves the F18 hood skin held on its rims, statics and modes', async () => {
    const s = await midsurface(f18Hood(), 'left', 6);
    const mesh = shellMeshFromSurface(s, s.shell!.thicknessMm);
    expect(mesh.thickness[0]).toBeCloseTo(1.5, 12);
    const quality = shellMeshQuality(mesh);
    expect(quality.minAngleDeg).toBeGreaterThan(4);
    expect(quality.below).toEqual([]);
    const rims = sideEdges(s, () => true);
    expect(rims.length).toBeGreaterThan(4);
    const held = [{ faces: [], edges: rims, displacement: [0, 0, 0], rotation: [0, 0, 0] }] as {
      faces: number[];
      edges: number[];
      displacement: [number, number, number];
      rotation: [number, number, number];
    }[];
    const r = solveShell({
      mesh,
      material: steel,
      loads: [{ kind: 'gravity', acceleration: [0, 0, -9810] }],
      constraints: held,
      solver,
    });
    expect(r.converged).toBe(true);
    expect(shellEquilibriumCheck(r).pass).toBe(true);
    // The weight: ρ g t × the midsurface's area.
    const area = s.measures.faceAreas.reduce((x, y) => x + y, 0);
    expect(-r.appliedTotal[2] / (steel.density * 9810 * 1.5 * area)).toBeCloseTo(1, 3);
    const modes = solveShellModal({
      mesh,
      material: steel,
      constraints: held,
      modes: 3,
      solver: { tolerance: 1e-5, maxIterations: 3000 },
    });
    expect(modes.converged).toBe(true);
    expect(modes.modes[0]!.frequency).toBeGreaterThan(0);
  }, 300_000);
});

describe.skipIf(!withMesher)(
  'a shell study run beside a solid one (R3i-4, TS-1394, ST-205)',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oc: any;
    let fem: FemMesherModule;
    beforeAll(async () => {
      const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
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
    /** The reference Host's job store on a local server (ccx on the server side, R3f-2). */
    const referenceHost = async () => {
      const limits = referenceComputeLimits;
      const jobs = createSimulationJobs({
        limits,
        toInp: async (value) => computeJobInp(value, limits),
      });
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
      return {
        remote: {
          name: host.label,
          limits: host.limits,
          equilibrium: computeEquilibriumTolerance,
          solve: (input: Parameters<typeof solveOnHost>[1]) =>
            solveOnHost(host, input, { pollMs: 50 }),
          solveShell: (input: Parameters<typeof solveShellOnHost>[1]) =>
            solveShellOnHost(host, input, { pollMs: 50 }),
        },
        close: async () => {
          await jobs.close();
          server.close();
        },
      };
    };
    /** The F02 analysis on the plate without its hole (an extrude alone has a midsurface). */
    const study = async () => {
      const cad = slab();
      const { doc } = simulationFixture();
      doc.source = { ...doc.source, bodyId: 'slab-body', contentHash: cadContentHash(cad) };
      const r = await evaluateCad(oc, cad, cadContentHash(cad));
      const table = r.meshes.find((m) => m.bodyId === 'slab-body')!.topology;
      const featureId = cad.bodies[0]!.resultFeatureId;
      // The end faces at x = 0 and x = 80, picked on the evaluated table.
      const end = (x: number) => table.faces.findIndex((f) => Math.abs(f.centroid[0]! - x) < 1e-6);
      const face = (x: number) => ({
        kind: 'face' as const,
        ref: topologyRefOf(table, 'face', end(x), featureId),
      });
      (doc.constraints[0]! as { targets: unknown }).targets = [face(0)];
      (doc.loads[0]! as { targets: unknown }).targets = [face(80)];
      doc.mesh = { ...doc.mesh, size: 10, minSize: 2, grading: 1.5 };
      doc.studies[0]!.convergence.levels = 1;
      doc.studies[0]!.solver = { tolerance: 1e-8, maxIterations: 200_000 };
      const shell = {
        ...doc.studies[0]!,
        id: 'shell',
        name: 'Shell',
        idealisation: 'shell' as const,
      };
      doc.studies.push(shell);
      return { cad, doc: doc as SimulationDocument, table };
    };

    it('bends the plate as a shell as it does as tet10, every check passing', async () => {
      const { cad, doc, table } = await study();
      const solid = await runStudy(doc, cad, cadContentHash(cad), 'static', table, env());
      const shell = await runStudy(doc, cad, cadContentHash(cad), 'shell', table, env());
      for (const run of [solid, shell]) {
        expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
        for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      }
      // The end faces are sides of the wall: they map onto the midsurface's end edges.
      expect(shell.mapping.every((r) => r.as === 'edge')).toBe(true);
      const tip = (r: typeof solid) => r.levels[0]!.metrics['max-displacement']!;
      expect(Math.abs(tip(shell) / tip(solid) - 1)).toBeLessThan(0.05);
      expect(shell.levels[0]!.metrics['reaction-force']).toBeCloseTo(500, 6);
      const fields = shell.fields!;
      expect(fields.kind).toBe('shell-static');
      const result = runResult(fields);
      expect(result.tets.length).toBe(0);
      expect(result.scalars.map((x) => x.id)).toEqual([
        'von-mises',
        'von-mises-top',
        'von-mises-bottom',
        'displacement',
      ]);
      expect(result.displacement!.length).toBe(result.nodes.length);
      const vtu = resultVtu(fields);
      expect(vtu).toContain('Name="Thickness (mm)"');
      expect(vtu).toContain('Name="von Mises top (MPa)"');
    }, 600_000);

    it('refuses a finer size on a side of the wall for a shell', async () => {
      const { cad, doc, table } = await study();
      const end = table.faces.findIndex((f) => Math.abs(f.centroid[0]!) < 1e-6);
      doc.mesh.local = [
        {
          target: {
            kind: 'face',
            ref: topologyRefOf(table, 'face', end, cad.bodies[0]!.resultFeatureId),
          },
          size: 5,
        },
      ];
      const shell = await runStudy(doc, cad, cadContentHash(cad), 'shell', table, env());
      expect(shell.failure?.code).toBe('shell-target');
      expect(shell.failure?.detail).toMatch(/side face of the wall/);
    }, 600_000);
    it('solves the sports-car bonnet as a shell, pinned at the hinge line and the latch (FX7)', async () => {
      const cad = sportsCarBonnet();
      const { doc } = simulationFixture();
      doc.source = { ...doc.source, bodyId: 'bonnet', contentHash: cadContentHash(cad) };
      const r = await evaluateCad(oc, cad, cadContentHash(cad));
      const table = r.meshes.find((m) => m.bodyId === 'bonnet')!.topology;
      const featureId = cad.bodies[0]!.resultFeatureId;
      const ref = (i: number) => ({
        kind: 'face' as const,
        ref: topologyRefOf(table, 'face', i, featureId),
      });
      const at = (pick: (c: number[]) => boolean) =>
        table.faces.flatMap((f, i) => (pick(f.centroid as number[]) ? [i] : []));
      // Six faces: the outer and inner skins, and the rims at the rear, the nose and each side.
      expect(table.faces.length).toBe(6);
      const rear = at((c) => c[0]! < 5);
      const nose = at((c) => c[0]! > 995);
      const skins = at((c) => c[0]! > 5 && c[0]! < 995 && Math.abs(c[1]!) < 600);
      expect([rear.length, nose.length, skins.length]).toEqual([1, 1, 2]);
      const [top] = skins.sort(
        (a, b) => table.faces[b]!.centroid[2]! - table.faces[a]!.centroid[2]!,
      );
      doc.materials = [{ id: 'al', ...simulationMaterialPresets[1]! }];
      doc.materialId = 'al';
      doc.constraints = [
        {
          id: 'hinge',
          name: 'Hinge line and latch',
          kind: 'pinned',
          targets: [...rear, ...nose].map(ref),
        },
      ];
      // 1 kPa down on the outer skin (a hand spread over it, or wet snow).
      doc.loads = [
        { id: 'press', name: 'Press', kind: 'pressure', targets: [ref(top!)], pressure: 0.001 },
      ];
      doc.mesh = { ...doc.mesh, size: 40, minSize: 10, grading: 1.5 };
      const statics = {
        ...doc.studies[0]!,
        loadIds: ['press'],
        constraintIds: ['hinge'],
        idealisation: 'shell' as const,
        convergence: { ...doc.studies[0]!.convergence, levels: 2 },
        solver: { tolerance: 1e-8, maxIterations: 200_000 },
      };
      const modal = {
        ...defaultModalStudy(doc as SimulationDocument),
        idealisation: 'shell' as const,
        convergence: { levels: 1, metrics: ['first-frequency' as const], tolerance: 0.02 },
      };
      doc.studies = [statics, modal];
      const solve = (id: string) =>
        runStudy(doc as SimulationDocument, cad, cadContentHash(cad), id, table, env());
      const s = await solve(statics.id);
      expect(s.failure, JSON.stringify(s.failure)).toBeUndefined();
      for (const level of s.levels)
        for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      // Measured (2026-11-07, 3317 and 4822 nodes): 1.98 and 1.98 mm, 14.9 and 14.4 MPa, 1326 N.
      // The press over the 1000 × 1300 mm plan is 1300 N; the slope adds its forward part.
      const last = s.levels.at(-1)!.metrics;
      expect(last['reaction-force']).toBeGreaterThan(1300);
      expect(last['reaction-force']).toBeLessThan(1360);
      expect(last['max-displacement']).toBeGreaterThan(1);
      expect(last['max-displacement']).toBeLessThan(4);
      expect(s.status.changes['max-displacement']).toBeLessThan(0.02);
      const m = await solve(modal.id);
      expect(m.failure, JSON.stringify(m.failure)).toBeUndefined();
      for (const c of m.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      // Measured: 41.7 Hz at 3317 nodes, the skin breathing between its held ends.
      expect(m.levels[0]!.metrics['first-frequency']).toBeGreaterThan(20);
      expect(m.levels[0]!.metrics['first-frequency']).toBeLessThan(80);
    }, 900_000);

    // TS-1458 (ST-233#3): the FX7 bonnet's statics on the reference Host as 15-node wedges
    // (R3j-5a), against the browser shell.
    it.skipIf(!hasCcx)(
      'solves the FX7 bonnet on the reference Host as wedges, as the browser does',
      async () => {
        const cad = sportsCarBonnet();
        const { doc } = simulationFixture();
        doc.source = { ...doc.source, bodyId: 'bonnet', contentHash: cadContentHash(cad) };
        const r = await evaluateCad(oc, cad, cadContentHash(cad));
        const table = r.meshes.find((m) => m.bodyId === 'bonnet')!.topology;
        const featureId = cad.bodies[0]!.resultFeatureId;
        const ref = (i: number) => ({
          kind: 'face' as const,
          ref: topologyRefOf(table, 'face', i, featureId),
        });
        const at = (pick: (c: number[]) => boolean) =>
          table.faces.flatMap((f, i) => (pick(f.centroid as number[]) ? [i] : []));
        const ends = at((c) => c[0]! < 5 || c[0]! > 995);
        const [top] = at((c) => c[0]! > 5 && c[0]! < 995 && Math.abs(c[1]!) < 600).sort(
          (a, b) => table.faces[b]!.centroid[2]! - table.faces[a]!.centroid[2]!,
        );
        doc.materials = [{ id: 'al', ...simulationMaterialPresets[1]! }];
        doc.materialId = 'al';
        doc.constraints = [{ id: 'hinge', name: 'Hinge', kind: 'pinned', targets: ends.map(ref) }];
        doc.loads = [
          { id: 'press', name: 'Press', kind: 'pressure', targets: [ref(top!)], pressure: 0.001 },
        ];
        doc.mesh = { ...doc.mesh, size: 20, minSize: 10, grading: 1.5 };
        const statics = {
          ...doc.studies[0]!,
          loadIds: ['press'],
          constraintIds: ['hinge'],
          idealisation: 'shell' as const,
          convergence: { ...doc.studies[0]!.convergence, levels: 1 },
          solver: { tolerance: 1e-8, maxIterations: 200_000 },
        };
        doc.studies = [statics];
        const id = doc.studies[0]!.id;
        const ref2 = await referenceHost();
        try {
          const steps: string[] = [];
          const host = await runStudy(
            doc as SimulationDocument,
            cad,
            cadContentHash(cad),
            id,
            table,
            {
              ...env(),
              builds: { ...env().builds, solver: 'calculix-2.21' },
              remote: ref2.remote,
              checkpoint: (p) => void steps.push(`${p.step}${p.on ? `@${p.on}` : ''}`),
            },
          );
          expect(host.failure, JSON.stringify(host.failure)).toBeUndefined();
          expect(steps).toContain('solve@Reference Host (CalculiX)');
          for (const c of host.levels[0]!.checks)
            expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
          expect(host.levels[0]!.checks.find((c) => c.name === 'solver')!.detail).toMatch(
            /15-node wedges on Reference Host/,
          );
          // The browser on the FX7 mesh (40 mm, converged to 2 %): 23 514 triangles at 20 mm
          // are more than it takes (20 000).
          const coarse = { ...doc, mesh: { ...doc.mesh, size: 40 } } as SimulationDocument;
          const browser = await runStudy(coarse, cad, cadContentHash(cad), id, table, env());
          expect(browser.failure, JSON.stringify(browser.failure)).toBeUndefined();
          const [h, b] = [host, browser].map((x) => x.levels[0]!.metrics);
          // Measured (2026-11-07, 11 936 nodes on the Host, 3317 in the browser): 1.99 and
          // 1.98 mm, 15.0 and 14.9 MPa, 1326 N on both.
          expect(Math.abs(h!['max-displacement']! / b!['max-displacement']! - 1)).toBeLessThan(
            0.02,
          );
          expect(Math.abs(h!['reaction-force']! / b!['reaction-force']! - 1)).toBeLessThan(1e-3);
          expect(Math.abs(h!['max-von-mises']! / b!['max-von-mises']! - 1)).toBeLessThan(0.03);
          // A Host without shells refuses the study rather than sending it.
          const { solveShell: _, ...solidOnly } = ref2.remote;
          const refused = await runStudy(
            doc as SimulationDocument,
            cad,
            cadContentHash(cad),
            id,
            table,
            {
              ...env(),
              remote: solidOnly,
            },
          );
          expect(refused.failure?.code).toBe('host');
        } finally {
          await ref2.close();
        }
      },
      900_000,
    );

    it("finds the plate's first mode as a shell near the tet10 one", async () => {
      const { cad, doc, table } = await study();
      doc.mesh = { ...doc.mesh, size: 16, minSize: 4 };
      const solid = { ...defaultModalStudy(doc), modes: 2 };
      doc.studies.push(solid);
      const shell = {
        ...solid,
        id: 'modal-shell',
        name: 'Modal shell',
        idealisation: 'shell' as const,
      };
      doc.studies.push(shell);
      const a = await runStudy(doc, cad, cadContentHash(cad), solid.id, table, env());
      const b = await runStudy(doc, cad, cadContentHash(cad), shell.id, table, env());
      for (const run of [a, b]) {
        expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
        for (const level of run.levels)
          for (const c of level.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      }
      const f = (r: typeof a) => r.levels.at(-1)!.metrics['first-frequency']!;
      expect(Math.abs(f(b) / f(a) - 1)).toBeLessThan(0.05);
      expect(b.fields!.kind).toBe('shell-modal');
    }, 600_000);
  },
);
