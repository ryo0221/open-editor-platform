import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  prepareElastic,
  solveElastic,
  solveTransientThermal,
  type ElasticInput,
  type TransientInput,
} from '@editor-platform/geometry-fem';
import { createSimulationJobs } from '../../../scripts/dev/simulation-host.mjs';
import {
  checkComputeJob,
  checkTransientJob,
  ComputeJobError,
  computeJobInp,
  computeJobOf,
  computeTransientBalance,
  computeTransientResidual,
  solveOnHost,
  solveTransientOnHost,
  transientComputeJob,
  type SimulationComputeDescriptor,
} from './compute';

const steel = { conductivity: 50, density: 7.85e-9, specificHeat: 4.6e8 };
const solver = { tolerance: 1e-12, maxIterations: 20_000 };
/** A bar heated from x = 0 over 30 s, cooled by air at x = 100, radiating on z = 10. */
const bar = (): TransientInput => ({
  mesh: boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' }),
  material: steel,
  conditions: [
    {
      kind: 'temperature',
      faces: [0],
      edges: [],
      temperature: 700,
      amplitude: { times: [0, 30], factors: [0.5, 1] },
    },
    { kind: 'convection', faces: [1], coefficient: 0.05, ambient: 300 },
    { kind: 'radiation', faces: [5], emissivity: 0.9, ambient: 300 },
  ],
  initialTemperature: 300,
  time: { end: 60, step: 5, theta: 1 },
  output: { every: 4 },
  solver,
  nonlinear: { tolerance: 1e-9, maxIterations: 50 },
});
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ComputeJobError);
    return (e as ComputeJobError).problem;
  }
  throw new Error('not refused');
};

describe('transient heat jobs (VS11d-3, TS-2283, ST-637)', () => {
  it('carries only numbers, gives the heat transfer .inp, and refuses the rest', () => {
    const job = transientComputeJob(bar());
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
    expect(job.heat.nodal.length).toBeGreaterThan(0); // the held ramp's capacity coupling
    const { inp, nodes } = computeJobInp(job);
    expect(nodes).toBe(job.heat.nodes.length / 3);
    expect(inp).toContain('*HEAT TRANSFER, DIRECT\n5, 60');
    expect(inp).toContain('*CFLUX, AMPLITUDE=A2');
    expect(checkTransientJob(job).holds[0]!.nodes).toEqual(job.heat.holds[0]!.nodes);
    const bad = (f: (h: Record<string, unknown>) => void) => {
      const copy = structuredClone(job) as unknown as { heat: Record<string, unknown> };
      f(copy.heat);
      return refusal(() => computeJobInp(copy));
    };
    expect(bad((h) => (h.secret = 'x'))).toBe('shape');
    expect(bad((h) => ((h.material as Record<string, number>).conductivity = 0))).toBe('material');
    expect(bad((h) => ((h.elements as number[])[0] = 1e9))).toBe('index');
    expect(bad((h) => ((h.initialTemperature as number[])[0] = -1))).toBe('shape');
    expect(bad((h) => ((h.time as Record<string, number>).step = 1e-6))).toBe('too-large');
    expect(bad((h) => ((h.holds as { amplitude?: number }[])[0]!.amplitude = 99))).toBe('index');
    expect(bad((h) => ((h.amplitudes as { times: number[] }[])[0]!.times = [5, 0]))).toBe('shape');
    expect(bad((h) => ((h.faces as { kind: string }[])[0]!.kind = 'cavity'))).toBe('shape');
    expect(
      bad(
        (h) =>
          ((h.faces as { kind: string; emissivity?: number }[]).find(
            (x) => x.kind === 'radiation',
          )!.emissivity = 2),
      ),
    ).toBe('not-finite');
    expect(bad((h) => ((h.nodal as { heat: number }[])[0]!.heat = Number.NaN))).toBe('not-finite');
  });

  it('carries a static job’s temperatures and expansion for thermal stress', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const n = mesh.nodes.length / 3;
    const input: ElasticInput = {
      mesh,
      material: { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 },
      loads: [],
      constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
      thermal: { temperature: new Float64Array(n).fill(400), reference: 300, expansion: 1.2e-5 },
      solver,
    };
    const job = computeJobOf(mesh, input.material, prepareElastic(input), 'mm', input.thermal);
    expect(job.thermal?.reference).toBe(300);
    expect(job.parts[0]!.material.expansion).toBe(1.2e-5);
    expect(computeJobInp(job).inp).toContain('*EXPANSION, ZERO=300');
    const without = structuredClone(job);
    delete without.parts[0]!.material.expansion;
    expect(refusal(() => checkComputeJob(without))).toBe('material');
    const short = structuredClone(job);
    short.thermal!.temperature.pop();
    expect(refusal(() => checkComputeJob(short))).toBe('shape');
    const modal = { ...structuredClone(job), kind: 'modal', modes: 1 };
    modal.parts[0]!.material.density = 7.85e-9;
    expect(refusal(() => checkComputeJob(modal))).toBe('shape');
  });
});

const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);

describe.skipIf(!hasCcx)('transient heat on the reference Host (VS11d-3, TS-2283)', () => {
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  const start = async (): Promise<SimulationComputeDescriptor> => {
    const limits = { nodes: 200_000, elements: 140_000, bytes: 64 * 1024 * 1024 };
    const jobs = createSimulationJobs({
      command: 'ccx',
      limits,
      toInp: async (value: unknown) => computeJobInp(value, limits),
    });
    closers.push(jobs.close);
    const server = createServer((req, res) => {
      void jobs.handle(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return {
      label: 'Test Host',
      destination: 'a test server',
      solverBuild: 'test',
      limits,
      endpoint: `http://127.0.0.1:${port}/__simulation-host`,
    };
  };
  afterAll(async () => {
    for (const c of closers) await c();
    for (const s of servers) s.close();
  });

  it('solves the bar on CalculiX as the browser does, and its thermal stress', async () => {
    const host = await start();
    const input = bar();
    const r = await solveTransientOnHost(host, input, { pollMs: 50 });
    // The browser on CalculiX's capacity rule, which the Host's replay also takes.
    const mine = solveTransientThermal({ ...input, capacityRule: 'conduction' });
    expect(r.times).toEqual(mine.times);
    let worst = 0;
    r.temperatures.forEach((T, k) =>
      T.forEach((v, p) => (worst = Math.max(worst, Math.abs(v - mine.temperatures[k]![p]!)))),
    );
    expect(worst / 400).toBeLessThan(1e-4);
    expect(r.replayResidual).toBeLessThan(computeTransientResidual);
    expect(r.balance / r.energyScale).toBeLessThan(computeTransientBalance);
    expect(r.conditionHeat[0]! / mine.conditionHeat[0]!).toBeCloseTo(1, 3);

    // The last field's thermal stress, held at x = 0.
    const stress: ElasticInput = {
      mesh: input.mesh,
      material: { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 },
      loads: [],
      constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
      thermal: { temperature: r.temperatures.at(-1)!, reference: 300, expansion: 1.2e-5 },
      solver,
    };
    const onHost = await solveOnHost(host, stress, { pollMs: 50 });
    const browser = solveElastic(stress);
    let du = 0,
      umax = 0;
    browser.displacement.forEach((u, k) => {
      du = Math.max(du, Math.abs(u - onHost.displacement[k]!));
      umax = Math.max(umax, Math.abs(u));
    });
    expect(du / umax).toBeLessThan(1e-4);
    for (let d = 0; d < 3; d++)
      expect(Math.abs(onHost.reactionTotal[d]!)).toBeLessThan(1e-3 * umax * 210_000);
  }, 120_000);
});
