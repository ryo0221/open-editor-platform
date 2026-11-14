import { cadContentHash, type CadTopologyTable } from '@editor-platform/cad-core';
import {
  aeroDomain,
  aeroLimits,
  boxSurface,
  type AeroJob,
  type TriangleSurface,
} from '@editor-platform/geometry-cfd';
import {
  aeroStudy,
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
  type SimulationAeroStudy,
} from '@editor-platform/simulation-core';
import { describe, expect, it } from 'vitest';
import { runStudy, type RunEnvironment, type RunProgress } from './run';
import { recordRunOp } from './run-record';
import {
  aeroAtYaw,
  aeroBrowserRequest,
  aeroHostLevel,
  frontalAreaMm2,
  parseYawSweep,
} from './run-aero';

/**
 * TS-2211 (ST-608): a wind-tunnel study run (VS4b), on a box the kernel stand-in gives as the
 * body's analysis surface: in the browser flow (CPU), and on a stand-in Host.
 */
const table: CadTopologyTable = { faces: [], edges: [], vertices: [] };
/** A block 400 × 200 × 150 mm, 20 mm above the ground. */
const block = boxSurface([0, -100, 20], [400, 100, 170]);

const setup = (over: (s: SimulationAeroStudy) => void = () => undefined) => {
  const { cad, doc } = simulationFixture();
  doc.source.contentHash = cadContentHash(cad);
  const study = aeroStudy('tunnel');
  study.aero.browserCellMm = 25;
  study.solver.maxIterations = 300;
  over(study);
  doc.studies.push(study);
  return { cad, doc, hash: doc.source.contentHash };
};

const env = (surface: TriangleSurface | { code: string } = block) => {
  const progress: RunProgress[] = [];
  const e: RunEnvironment & { progress: RunProgress[]; requests: unknown[] } = {
    progress,
    requests: [],
    builds: { kernel: 'k', mesher: 'm', solver: 's' },
    surface: async (_cad, request) => {
      e.requests.push(request);
      return 'code' in surface
        ? surface
        : ({ surface: { points: surface.positions, triangles: surface.triangles } } as never);
    },
    mesh: () => {
      throw new Error('a wind tunnel meshes nothing');
    },
    checkpoint: (p) => void progress.push(p),
  };
  return e;
};

describe('wind-tunnel study run (VS4b)', () => {
  it('runs the browser flow and records the coefficients and both checks', async () => {
    const { cad, doc, hash } = setup();
    const e = env();
    const run = await runStudy(doc, cad, hash, 'tunnel', table, e);
    expect(run.failure).toBeUndefined();
    expect(run.status.status).toBe('reference');
    expect(run.levels).toHaveLength(1);
    const [level] = run.levels;
    expect(level!.checks.map((c) => [c.name, c.pass])).toEqual([
      ['surface', true],
      ['solver', true],
    ]);
    const m = level!.metrics;
    // A bluff block: a drag of the order of one, nothing across a straight wind.
    expect(m['drag-coefficient']).toBeGreaterThan(0.3);
    expect(m['drag-coefficient']).toBeLessThan(3);
    expect(Math.abs(m['side-force-coefficient']!)).toBeLessThan(0.1);
    expect(level!.elements).toBe(12);
    expect(level!.nodes).toBeGreaterThan(1000);
    expect(level!.settings.size).toBe(25);
    expect(e.progress.map((p) => p.step)).toContain('solve');
    // The flow's steps reach the progress (the drag on the tunnel's own frontal area).
    const flows = e.progress.flatMap((p) => (p.flow ? [p.flow] : []));
    expect(flows.at(-1)).toMatchObject({ step: 300, steps: 300 });
    // VS4c (TS-2212): Cp on the block's points and the flow for streamlines.
    const f = run.fields;
    if (f?.kind !== 'aero') throw new Error('no wind-tunnel fields');
    expect(f.cp).toHaveLength(8);
    expect(f.flow?.velocity.length).toBe(3 * f.flow!.solid.length);
    // The nose corners (x = 400) face the wind.
    // A corner is the area-weighted mean of its three faces, so each nose corner (x = 400, with
    // the pushed front) is above its tail corner (x = 0, with the base in the wake).
    for (const i of [0, 2, 4, 6]) expect(f.cp[i + 1]!).toBeGreaterThan(f.cp[i]!);
    expect(e.requests).toEqual([{ bodyId: 'plate', deflectionMm: 6.25, clampDeflection: true }]);
  });

  it('turns the bodies by the yaw: the air from the left pushes them to +y', async () => {
    const { cad, doc, hash } = setup((s) => {
      s.aero.yawDeg = 15;
    });
    const run = await runStudy(doc, cad, hash, 'tunnel', table, env());
    expect(run.levels[0]!.metrics['side-force-coefficient']).toBeGreaterThan(0.05);
  });

  it('sends the job to the Host and gives its side force the browser sign', async () => {
    const { cad, doc, hash } = setup((s) => {
      s.convergence.levels = 2;
      s.aero.yawDeg = 10;
    });
    const jobs: AeroJob[] = [];
    const e = env();
    e.remote = {
      name: 'Host',
      limits: { nodes: 1, elements: 1 },
      solve: () => Promise.reject(new Error('not a mesh')),
      solveAero: async (job) => {
        jobs.push(job);
        return {
          cd: [0.41, 0.42][jobs.length - 1]!,
          cl: 0.1,
          cs: -0.2,
          clFront: 0,
          clRear: 0,
          history: [{ iteration: 1, cd: 1, cl: 0 }],
          points: [400, 0, 100, 0, 0, 100],
          cp: [0.9, -0.2],
          cf: [0.004, 0.001],
          htc: [60, 20],
        };
      },
    };
    const run = await runStudy(doc, cad, hash, 'tunnel', table, e);
    expect(run.failure).toBeUndefined();
    expect(jobs.map((j) => j.mesh)).toEqual([
      { baseMm: 160, level: 5 },
      { baseMm: 160, level: 6 },
    ]);
    expect(jobs[0]).toMatchObject({ kind: 'aero', speed: 30, yawDeg: 10, ground: 'moving' });
    // The block's frontal area, turned by 10°: 150 × (200 cos 10° + 400 sin 10°).
    const area = 150 * (200 * Math.cos(Math.PI / 18) + 400 * Math.sin(Math.PI / 18));
    expect(jobs[0]!.referenceAreaMm2 / area).toBeGreaterThan(0.97);
    expect(jobs[0]!.referenceAreaMm2 / area).toBeLessThan(1.03);
    expect(run.levels.map((l) => l.metrics['drag-coefficient'])).toEqual([0.41, 0.42]);
    expect(run.levels[1]!.metrics['side-force-coefficient']).toBe(0.2);
    expect(run.levels[1]!.settings.size).toBe(2.5);
    // VS4c: the Host's face values on the nearest points.
    const f = run.fields;
    if (f?.kind !== 'aero') throw new Error('no wind-tunnel fields');
    expect([f.cp[1], f.cp[0], f.htc?.[1], f.flow]).toEqual([0.9, -0.2, 60, undefined]);
    expect(run.status.status).toBe('reference');
    expect(e.progress.filter((p) => p.step === 'solve').every((p) => p.on === 'Host')).toBe(true);
    // Codex on #1182: a Host run records (its background cells as the level's count).
    expect(run.levels.every((l) => l.nodes > 0)).toBe(true);
    const made = recordRunOp(doc, run);
    if (!('op' in made)) throw new Error(made.reason);
    expect(validateSimulation(applySimulationOperation(doc, made.op))).toEqual([]);
  });

  it('takes the study reference area when it has one', async () => {
    const { cad, doc, hash } = setup((s) => {
      s.aero.referenceAreaMm2 = 1e6;
    });
    const e = env();
    let area = 0;
    e.remote = {
      name: 'Host',
      limits: { nodes: 1, elements: 1 },
      solve: () => Promise.reject(new Error('x')),
      solveAero: async (job) => {
        area = job.referenceAreaMm2;
        throw new Error('stop');
      },
    };
    await expect(runStudy(doc, cad, hash, 'tunnel', table, e)).rejects.toThrow('stop');
    expect(area).toBe(1e6);
  });

  it('refuses a Host without a wind tunnel, an open or sunk body and a kernel refusal', async () => {
    const { cad, doc, hash } = setup();
    const code = async (e: RunEnvironment) => {
      const run = await runStudy(doc, cad, hash, 'tunnel', table, e);
      expect(run.status.status).toBe('failed');
      return [run.failure!.code, run.failure!.detail];
    };
    const host = env();
    host.remote = {
      name: 'Host',
      limits: { nodes: 1, elements: 1 },
      solve: () => Promise.reject(new Error('x')),
    };
    expect(await code(host)).toEqual(['host', 'Host has no wind tunnel']);
    const open = {
      positions: block.positions,
      triangles: block.triangles.slice(0, block.triangles.length - 3),
    };
    expect((await code(env(open)))[0]).toBe('surface');
    expect(await code(env(boxSurface([0, -100, -5], [400, 100, 170])))).toEqual([
      'surface',
      'the bodies reach -5 mm below the ground (z = 0)',
    ]);
    expect(await code(env({ code: 'analysis-body-missing' }))).toEqual([
      'surface',
      'plate: analysis-body-missing',
    ]);
  });

  it('stops when the checkpoint cancels during the flow', async () => {
    const { cad, doc, hash } = setup();
    const e = env();
    let solving = 0;
    e.checkpoint = (p) => {
      if (p.step === 'solve' && ++solving > 2) throw new Error('cancelled');
    };
    await expect(runStudy(doc, cad, hash, 'tunnel', table, e)).rejects.toThrow('cancelled');
  });
});

describe('wind-tunnel geometry (VS4b)', () => {
  it('measures the frontal area across the wind', () => {
    expect(frontalAreaMm2(block, 0, 1)).toBeCloseTo(200 * 150, -2);
    expect(frontalAreaMm2(block, 90, 1)).toBeCloseTo(400 * 150, -2);
    // Codex on #1182: a body 2 mm thin still shows its area on the default raster.
    const thin = frontalAreaMm2(boxSurface([0, 0, 0], [100, 50, 2]));
    expect(thin / 100).toBeGreaterThan(0.9);
    expect(thin / 100).toBeLessThan(1.1);
  });

  it('puts the nose upstream with the margins around the bodies', () => {
    const study = aeroStudy('t');
    const r = aeroBrowserRequest([block], study, 25);
    const b = r.bodies[0]!.positions;
    // The nose (x = 400) is mirrored to the upstream end.
    let minX = Infinity;
    for (let i = 0; i < b.length; i += 3) minX = Math.min(minX, b[i]!);
    expect(minX).toBe(-400);
    expect(r.grid.origin).toEqual([-400 - 300, -100 - 240, -25]);
    expect(r.grid.dims).toEqual([56, 28, 15]);
    expect(r.flow).toMatchObject({ ground: 'moving', speed: 0.1, road: [0.1, -0] });
    expect(r.averageSteps).toBe(study.solver.maxIterations / 5);
  });

  // Codex on #1185: the road runs with the car, as on the Host ((−U cos, 0, 0) in the car's frame):
  // turned into the tunnel at 15°, (U cos², −U cos sin), so back in the car's frame it has no side.
  it('turns the road with the car in a yawed tunnel', () => {
    const study = aeroStudy('t');
    study.aero.yawDeg = 15;
    const [rx, ry] = aeroBrowserRequest([block], study, 25).flow.road!;
    const c = Math.cos(Math.PI / 12);
    const s = Math.sin(Math.PI / 12);
    expect(rx).toBeCloseTo(0.1 * c * c, 12);
    expect(ry).toBeCloseTo(-0.1 * c * s, 12);
    // Back to the car's frame (tunnelToVehicle on a vector): x = −X c + Y s, y = X s + Y c.
    expect(-rx * c + ry * s).toBeCloseTo(-0.1 * c, 12);
    expect(rx * s + ry * c).toBeCloseTo(0, 12);
  });

  // Codex on #1185: 160 mm on a 4 m car passes the Host's background limit; the scaled default
  // (`aeroHostBaseMm`, a new wind tunnel on the shown bodies) stays inside it.
  it('fits a full-size car on the Host with the scaled background cell', () => {
    const cells = (base: number) =>
      aeroDomain([0, -880, 0], [3970, 880, 1247], base).cells.reduce((a, b) => a * b, 1);
    expect(cells(160)).toBeGreaterThan(aeroLimits.backgroundCells);
    const car = aeroStudy('t', 'Wind tunnel', 3970).aero.host.baseMm;
    expect(cells(car)).toBeLessThan(aeroLimits.backgroundCells);
    // About as many cells as the Ahmed-checked tunnel (the same margins, scaled to the length).
    const ahmed = aeroDomain([0, -195, 50], [1044, 195, 338], 160).cells.reduce((a, b) => a * b, 1);
    expect(cells(car) / ahmed).toBeLessThan(2);
  });

  it('coarsens the Host level for the coarser levels', () => {
    const s = aeroStudy('t');
    expect([0, 1, 2].map((l) => aeroHostLevel(s, l, 3))).toEqual([4, 5, 6]);
    // Codex on #1182: level 0 stays 0.
    s.aero.host.level = 0;
    expect([0, 1].map((l) => aeroHostLevel(s, l, 2))).toEqual([0, 0]);
  });
});

describe('wind-tunnel job on a compute Host (VS4b)', () => {
  const descriptor = (aero?: { solverBuild: string }) => ({
    endpoint: 'http://host.test/__simulation-host',
    label: 'Host',
    destination: 'the test Host',
    solverBuild: 'ccx',
    limits: { nodes: 10, elements: 10, bytes: 1e8 },
    ...(aero ? { aero } : {}),
  });
  const job = (): AeroJob => ({
    kind: 'aero',
    surface: { positions: Array.from(block.positions), triangles: Array.from(block.triangles) },
    speed: 30,
    yawDeg: 0,
    ground: 'moving',
    mesh: { baseMm: 160, level: 3 },
    iterations: 50,
    referenceAreaMm2: 30_000,
  });
  /** A Host that takes the job, says it is done and sends `result`. */
  const fake = (result: unknown) =>
    (async (url: string, init?: RequestInit) => {
      const text =
        init?.method === 'POST'
          ? '{"id":"a1"}'
          : url.endsWith('/result')
            ? JSON.stringify(result)
            : '{"state":"done"}';
      return new Response(text, { status: init?.method === 'POST' ? 201 : 200 });
    }) as typeof fetch;
  const good = {
    cd: 0.3,
    cl: 0.1,
    cs: 0,
    clFront: 0,
    clRear: 0.1,
    history: [],
    points: [1, 2, 3],
    cp: [0.5],
    cf: [0.01],
    htc: [40],
  };

  it('reads a checked result, and refuses a Host without a wind tunnel', async () => {
    const { solveAeroOnHost, ComputeHostError } = await import('./compute');
    const host = descriptor({ solverBuild: 'openfoam-v2412' });
    expect(await solveAeroOnHost(host as never, job(), { fetch: fake(good), pollMs: 1 })).toEqual(
      good,
    );
    await expect(solveAeroOnHost(descriptor() as never, job())).rejects.toBeInstanceOf(
      ComputeHostError,
    );
    await expect(
      solveAeroOnHost(host as never, job(), { fetch: fake({ ...good, cd: null }), pollMs: 1 }),
    ).rejects.toThrow('without a finite cd');
    await expect(
      solveAeroOnHost(host as never, job(), { fetch: fake({ ...good, cf: [] }), pollMs: 1 }),
    ).rejects.toThrow('surface samples that line up');
  });
});

describe('yaw sweep (VS4d)', () => {
  it('runs a study at another yaw without changing the document', () => {
    const { doc } = setup();
    const turned = aeroAtYaw(doc, 'tunnel', 10);
    const t = turned.studies.find((s) => s.id === 'tunnel');
    expect(t?.kind === 'aero' && t.aero.yawDeg).toBe(10);
    const own = doc.studies.find((s) => s.id === 'tunnel');
    expect(own?.kind === 'aero' && own.aero.yawDeg).toBe(0);
    // Another study is left as it is.
    expect(aeroAtYaw(doc, 'static', 10).studies).toEqual(doc.studies);
  });

  it('reads the angles of a sweep', () => {
    expect(parseYawSweep('0, 5 10,-15, 5', 20)).toEqual([0, 5, 10, -15]);
    expect(parseYawSweep('', 20)).toMatch(/one or more/);
    expect(parseYawSweep('0, 25', 20)).toBe('25: an angle within ±20°.');
    expect(parseYawSweep('a', 20)).toMatch(/^a: /);
    expect(parseYawSweep(Array.from({ length: 13 }, (_, i) => i).join(','), 20)).toMatch(/12/);
  });
});
