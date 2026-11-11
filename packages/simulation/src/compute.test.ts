import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  modalHostModel,
  prepareElastic,
  frdReadLimits,
  readCalculixFrd,
  shellEquilibriumCheck,
  solveElastic,
  solveModal,
  solveShell,
  writeCalculixInp,
  type ElasticInput,
  type ModalInput,
  type ShellInput,
} from '@editor-platform/geometry-fem';
import {
  createSimulationJobs,
  simulationReferenceHost,
} from '../../../scripts/dev/simulation-host.mjs';
import {
  checkComputeJob,
  computeEquilibriumTolerance,
  ComputeHostError,
  ComputeJobError,
  computeJobInp,
  computeJobOf,
  computeJobOfModel,
  computeModalTolerance,
  referenceComputeLimits,
  runComputeJob,
  solveModalOnHost,
  solveShellOnHost,
  type ComputeJobState,
  type SimulationComputeDescriptor,
} from './compute';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const cantilever = (d: number): ElasticInput => ({
  mesh: boxTetMesh({ size: [200, 20, 20], divisions: [d, 2, 2], type: 'tet10' }),
  material: steel,
  constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
  loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
  solver: { tolerance: 1e-12, maxIterations: 100_000 },
});
const jobOf = (input: ElasticInput, units: 'mm' | 'm' = 'mm') =>
  computeJobOf(input.mesh, input.material, prepareElastic(input), units);
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ComputeJobError);
    return (e as ComputeJobError).problem;
  }
  throw new Error('not refused');
};
const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);

describe('compute job (R3f-2)', () => {
  it.skipIf(!hasCcx)('CR5f-8: the reference Host takes the simplified BIW F29 at 30 mm', () => {
    // TS-1589, ST-279: the limits the dev server offers are the package's, over F29's measured
    // 30 mm job (985,474 nodes, 203,468 elements sent; a 278 MB torsion result), and the result
    // cap stays under V8's longest string.
    expect(referenceComputeLimits).toEqual({
      nodes: 1_500_000,
      elements: 1_000_000,
      bytes: 256 * 1024 * 1024,
    });
    // The plugin's hooks, called as Vite calls them in `serve`.
    const plugin = simulationReferenceHost() as unknown as {
      configResolved: (config: { command: string }) => void;
      load: (id: string) => string | undefined;
    };
    plugin.configResolved({ command: 'serve' });
    const offered = JSON.parse(
      String(plugin.load('\0virtual:simulation-compute-host')).replace(/^export default |;$/g, ''),
    );
    expect(offered.limits).toEqual(referenceComputeLimits);
    expect(referenceComputeLimits.nodes).toBeGreaterThan(985_474);
    expect(referenceComputeLimits.elements).toBeGreaterThan(203_468);
    expect(frdReadLimits.bytes).toBeGreaterThan(278 * 1e6);
    expect(frdReadLimits.bytes).toBeLessThan(2 ** 29 - 24);
  });
  it('carries only numbers and gives the same .inp as the study itself', () => {
    const input = cantilever(2);
    const job = jobOf(input);
    expect(Object.keys(job).sort()).toEqual(
      ['equations', 'force', 'kind', 'nodes', 'parts', 'prescribed', 'units'].sort(),
    );
    expect(Object.keys(job.parts[0]!.material)).toEqual(['youngsModulus', 'poissonsRatio']);
    const sent = JSON.parse(JSON.stringify(job)) as unknown;
    const { inp } = computeJobInp(sent);
    expect(inp).toBe(
      writeCalculixInp({ mesh: input.mesh, material: steel, prepared: prepareElastic(input) }),
    );
  });

  it('refuses a job that is not exactly numbers within the limits', () => {
    const job = JSON.parse(JSON.stringify(jobOf(cantilever(2)))) as Record<string, unknown>;
    const edit = (change: (j: Record<string, unknown>) => void) => {
      const j = structuredClone(job);
      change(j);
      return () => checkComputeJob(j);
    };
    expect(refusal(edit((j) => (j.title = 'x')))).toBe('shape');
    expect(
      refusal(edit((j) => ((j.nodes as unknown[])[0] = '0\n*INCLUDE, INPUT=/etc/passwd'))),
    ).toBe('not-finite');
    const part = (j: Record<string, unknown>) => (j.parts as Record<string, unknown>[])[0]!;
    expect(refusal(edit((j) => ((part(j).elements as number[])[3] = 1e9)))).toBe('index');
    expect(refusal(edit((j) => ((part(j).elements as number[])[3] = 1.5)))).toBe('index');
    expect(
      refusal(edit((j) => ((part(j).material as Record<string, number>).poissonsRatio = 0.5))),
    ).toBe('material');
    expect(
      refusal(edit((j) => ((part(j).material as Record<string, unknown>).name = 'steel'))),
    ).toBe('shape');
    expect(refusal(edit((j) => (part(j).type = 'S3')))).toBe('shape');
    expect(refusal(edit((j) => (j.parts = [])))).toBe('shape');
    // R3j-5: an equation's eliminated DOF is free and eliminated once; coefficients are numbers.
    const held = (job.prescribed as number[][])[0]![0]!;
    // The last node is at the loaded end, free.
    const last = (job.nodes as number[]).length - 1;
    expect(
      refusal(
        edit(
          (j) =>
            (j.equations = [
              [
                [held, 1],
                [held + 3, -1],
              ],
            ]),
        ),
      ),
    ).toBe('index');
    expect(
      refusal(
        edit(
          (j) =>
            (j.equations = [
              [
                [last, 1],
                [last - 1, -1],
              ],
              [
                [last, 1],
                [last - 2, -1],
              ],
            ]),
        ),
      ),
    ).toBe('index');
    expect(refusal(edit((j) => (j.equations = [[[last, 1]]])))).toBe('shape');
    expect(
      refusal(
        edit(
          (j) =>
            (j.equations = [
              [
                [last, 1],
                [last - 1, '-1'],
              ],
            ]),
        ),
      ),
    ).toBe('not-finite');
    expect(
      refusal(
        edit(
          (j) =>
            (j.equations = [
              [
                [last, 1],
                [last - 1, 0],
              ],
            ]),
        ),
      ),
    ).toBe('not-finite');
    expect(refusal(edit((j) => delete j.equations))).toBe('shape');
    expect(
      refusal(edit((j) => (j.prescribed as unknown[]).push((j.prescribed as unknown[])[0]))),
    ).toBe('index');
    expect(refusal(edit((j) => (j.prescribed = [])))).toBe('shape');
    expect(refusal(edit((j) => ((j.force as number[][])[0]![0] = -1)))).toBe('index');
    expect(refusal(edit((j) => (j.kind = 'modal')))).toBe('shape');
    expect(refusal(() => checkComputeJob(job, { nodes: 10, elements: 1e6, bytes: 1e9 }))).toBe(
      'too-large',
    );
  });

  // TS-1462 (ST-235#2): a modal job (R3j-5c).
  it('carries a modal study as its modes and densities, held at 0 with no force', () => {
    const input: ModalInput = {
      ...cantilever(2),
      modes: 4,
      solver: { tolerance: 1e-4, maxIterations: 2000 },
    };
    const job = computeJobOfModel(modalHostModel(input).model);
    expect(job.kind).toBe('modal');
    expect(job.modes).toBe(4);
    expect(job.force).toEqual([]);
    expect(job.parts[0]!.material).toEqual({
      youngsModulus: 210_000,
      poissonsRatio: 0.3,
      density: 7.85e-9,
    });
    const { inp } = computeJobInp(JSON.parse(JSON.stringify(job)));
    expect(inp).toContain('*FREQUENCY\n4');
    const sent = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
    const edit = (change: (j: Record<string, unknown>) => void) => {
      const j = structuredClone(sent);
      change(j);
      return () => checkComputeJob(j);
    };
    const material = (j: Record<string, unknown>) =>
      (j.parts as Record<string, unknown>[])[0]!.material as Record<string, unknown>;
    expect(refusal(edit((j) => delete j.modes))).toBe('shape');
    expect(refusal(edit((j) => (j.modes = 0)))).toBe('shape');
    expect(refusal(edit((j) => (j.modes = 2.5)))).toBe('shape');
    expect(refusal(edit((j) => (j.modes = 101)))).toBe('too-large');
    expect(refusal(edit((j) => (j.units = 'm')))).toBe('shape');
    expect(refusal(edit((j) => delete material(j).density))).toBe('material');
    expect(refusal(edit((j) => (material(j).density = -1)))).toBe('material');
    expect(refusal(edit((j) => ((j.prescribed as number[][])[0]![1] = 0.1)))).toBe('shape');
    expect(refusal(edit((j) => (j.force = [[5, 1]])))).toBe('shape');
    // A static job takes neither modes nor a density.
    const statics = JSON.parse(JSON.stringify(jobOf(cantilever(2)))) as Record<string, unknown>;
    expect(refusal(() => checkComputeJob({ ...statics, modes: 2 }))).toBe('shape');
    const dense = structuredClone(statics);
    material(dense).density = 7.85e-9;
    expect(refusal(() => checkComputeJob(dense))).toBe('shape');
  });

  it('CR5a (Codex on #975): carries a modal job’s added masses through to the .inp', () => {
    const input: ModalInput = {
      ...cantilever(2),
      masses: [{ faces: [1], mass: 0.001 }],
      modes: 2,
      solver: { tolerance: 1e-4, maxIterations: 2000 },
    };
    const host = modalHostModel(input).model;
    const job = JSON.parse(JSON.stringify(computeJobOfModel(host))) as Record<string, unknown>;
    const sent = job.masses as [number, number][];
    expect(sent.length).toBe(host.masses!.length);
    expect(sent.reduce((s, [, m]) => s + m, 0)).toBeCloseTo(0.001, 15);
    const checked = checkComputeJob(job);
    expect(checked.masses).toEqual(host.masses);
    expect(computeJobInp(job).inp).toMatch(/\*ELEMENT, TYPE=MASS, ELSET=AM1/);
    const edit = (change: (j: Record<string, unknown>) => void) => {
      const j = structuredClone(job);
      change(j);
      return () => checkComputeJob(j);
    };
    const first = (j: Record<string, unknown>) => (j.masses as unknown[][])[0]!;
    expect(refusal(edit((j) => (first(j)[1] = 0)))).toBe('not-finite');
    expect(refusal(edit((j) => (first(j)[1] = 'x')))).toBe('not-finite');
    expect(refusal(edit((j) => (first(j)[0] = 1e9)))).toBe('index');
    expect(refusal(edit((j) => (j.masses as unknown[]).push(first(j))))).toBe('index');
    expect(refusal(edit((j) => (j.masses = {})))).toBe('shape');
    // A static job carries the weight in its forces, never masses.
    const statics = JSON.parse(JSON.stringify(jobOf(cantilever(2)))) as Record<string, unknown>;
    expect(refusal(() => checkComputeJob({ ...statics, masses: [[0, 1]] }))).toBe('shape');
  });
});

describe('reference Host jobs (R3f-2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simulation-host-test-'));
  /** Stand-ins for ccx: one that waits, one that fails like CalculiX does. */
  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const slow = script('slow', 'sleep 30');
  const failing = script('failing', 'echo " *ERROR reading *NODE. Card image:"; exit 201');
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  const start = async (
    command: string,
    more: {
      maxJobs?: number;
      keepMs?: number;
      toInp?: (value: unknown) => Promise<{ inp: string }>;
    } = {},
  ): Promise<SimulationComputeDescriptor> => {
    const limits = { nodes: 200_000, elements: 140_000, bytes: 64 * 1024 * 1024 };
    const jobs = createSimulationJobs({
      command,
      limits,
      toInp: async (value) => computeJobInp(value, limits),
      ...more,
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
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasCcx)(
    'runs CalculiX on a job and returns a .frd that matches the browser solver',
    async () => {
      const host = await start('ccx');
      const input = cantilever(10);
      const states: ComputeJobState['state'][] = [];
      const text = await runComputeJob(host, jobOf(input, 'm'), {
        pollMs: 50,
        onProgress: (s) => states.push(s.state),
      });
      expect(states.at(-1)).toBe('done');
      const r = readCalculixFrd(text, input.mesh.nodes.length / 3, 'm');
      const mine = solveElastic(input);
      const max = mine.displacement.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
      const diff = r.displacement.reduce(
        (s, x, k) => Math.max(s, Math.abs(x - mine.displacement[k]!)),
        0,
      );
      expect(diff / max).toBeLessThan(1e-4);
      // The result is handed over once; the job and its folder are gone after that.
      const again = await fetch(`${host.endpoint}/jobs/none`);
      expect(again.status).toBe(404);
    },
    120_000,
  );

  // TS-1462 (ST-235#2): a modal study through the Host server (R3j-5c).
  it.skipIf(!hasCcx)(
    'finds the cantilever’s modes on the Host as the browser does',
    async () => {
      const host = await start('ccx');
      const input: ModalInput = {
        ...cantilever(10),
        modes: 3,
        solver: { tolerance: 1e-4, maxIterations: 2000 },
      };
      const r = await solveModalOnHost(host, input, { pollMs: 50 });
      const mine = solveModal(input);
      r.modes.forEach((m, k) =>
        expect(Math.abs(m.frequency / mine.modes[k]!.frequency - 1)).toBeLessThan(2e-3),
      );
      expect(r.orthogonality).toBeLessThan(computeModalTolerance);
      expect(r.mass).toBeCloseTo(mine.mass, 15);
    },
    120_000,
  );

  // TS-1457 (ST-233#2): a shell study through the Host server (R3j-5a).
  it.skipIf(!hasCcx)(
    'solves a shell on the Host as wedges, as the browser shell solver',
    async () => {
      const host = await start('ccx');
      // A 100 × 20 × 1 mm strip, 20 × 4 cells, clamped at x = 0, 1 N up at x = 100.
      const nx = 20,
        ny = 4;
      const nodes: number[] = [];
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) nodes.push((100 * i) / nx, (20 * j) / ny, 0);
      const id = (i: number, j: number) => j * (nx + 1) + i;
      const triangles: number[] = [];
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++)
          triangles.push(
            id(i, j),
            id(i + 1, j),
            id(i + 1, j + 1),
            id(i, j),
            id(i + 1, j + 1),
            id(i, j + 1),
          );
      const chain = (i: number) => Array.from({ length: ny + 1 }, (_, j) => id(i, j));
      const m = triangles.length / 3;
      const input: ShellInput = {
        mesh: {
          nodes: Float64Array.from(nodes),
          triangles: Uint32Array.from(triangles),
          thickness: new Float64Array(m).fill(1),
          faces: new Int32Array(m),
          shapeFaces: 1,
          shapeEdges: 2,
          edges: {
            offsets: Uint32Array.from([0, ny + 1, 2 * ny + 2]),
            nodes: Uint32Array.from([...chain(0), ...chain(nx)]),
          },
        },
        material: steel,
        loads: [{ kind: 'edge-force', edges: [1], force: [0, 0, 1] }],
        constraints: [{ faces: [], edges: [0], displacement: [0, 0, 0], rotation: [0, 0, 0] }],
        solver: { tolerance: 1e-10, maxIterations: 20_000 },
      };
      const r = await solveShellOnHost(host, input, { pollMs: 50 });
      const mine = solveShell(input);
      const tip = id(nx, ny);
      expect(
        Math.abs(r.displacement[6 * tip + 2]! / mine.displacement[6 * tip + 2]! - 1),
      ).toBeLessThan(0.03);
      expect(shellEquilibriumCheck(r, computeEquilibriumTolerance).pass).toBe(true);
      expect(r.loadChecks).toEqual(mine.loadChecks);
    },
    120_000,
  );

  it('cancels a running job on abort, and says why a job failed or was refused', async () => {
    const host = await start(slow);
    const abort = new AbortController();
    const run = runComputeJob(host, jobOf(cantilever(2)), {
      pollMs: 20,
      signal: abort.signal,
      onProgress: (s) => {
        if (s.state === 'running') abort.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ reason: 'cancelled' });

    const failed = await start(failing);
    await expect(runComputeJob(failed, jobOf(cantilever(2)), { pollMs: 20 })).rejects.toMatchObject(
      { reason: 'failed', message: expect.stringContaining('*ERROR reading *NODE') },
    );

    const bad = { ...jobOf(cantilever(2)), nodes: [Number.NaN] };
    await expect(runComputeJob(failed, bad, { pollMs: 20 })).rejects.toBeInstanceOf(
      ComputeHostError,
    );
    await expect(runComputeJob(failed, bad, { pollMs: 20 })).rejects.toMatchObject({
      reason: 'refused',
    });

    const gone = { ...host, endpoint: 'http://127.0.0.1:1/__simulation-host' };
    await expect(runComputeJob(gone, jobOf(cantilever(2)))).rejects.toMatchObject({
      reason: 'unreachable',
    });
  });

  /** The job folders the Host has in the temporary directory now. */
  const jobFolders = () => readdirSync(tmpdir()).filter((f) => f.startsWith('simulation-job-'));
  const post = (host: SimulationComputeDescriptor) =>
    fetch(`${host.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobOf(cantilever(2))),
    });
  const until = async (ok: () => boolean) => {
    for (let k = 0; k < 200 && !ok(); k++) await new Promise((r) => setTimeout(r, 25));
    return ok();
  };

  it('holds its job limit under concurrent posts, and leaves no folder behind (#840 review)', async () => {
    const before = jobFolders().length;
    const one = await start(slow, { maxJobs: 1 });
    const [a, b] = await Promise.all([post(one), post(one)]);
    expect([a.status, b.status].sort()).toEqual([201, 429]);
    const { id } = (await (a.status === 201 ? a : b).json()) as { id: string };
    await fetch(`${one.endpoint}/jobs/${id}`, { method: 'DELETE' });
    // Cancelled right after it was posted (while its folder is being made): nothing is left.
    const host = await start(slow);
    for (let k = 0; k < 5; k++) {
      const { id: job } = (await (await post(host)).json()) as { id: string };
      await fetch(`${host.endpoint}/jobs/${job}`, { method: 'DELETE' });
    }
    expect(await until(() => jobFolders().length === before)).toBe(true);
    // A finished result nobody reads goes after keepMs, without another request.
    const done = script('done', 'echo " -3" > job.frd');
    const expiring = await start(done, { keepMs: 100 });
    const { id: kept } = (await (await post(expiring)).json()) as { id: string };
    expect(await until(() => jobFolders().length === before + 1)).toBe(true);
    expect(await until(() => jobFolders().length === before)).toBe(true);
    expect((await fetch(`${expiring.endpoint}/jobs/${kept}`)).status).toBe(404);
  });

  it('does not start a job whose client left while it was checked, nor fail on a bad URL (#840 review)', async () => {
    const marker = join(dir, 'launched');
    const launch = script('launch', `touch ${marker}; sleep 30`);
    const limits = { nodes: 200_000, elements: 140_000, bytes: 64 * 1024 * 1024 };
    const slowCheck = async (value: unknown) => {
      await new Promise((r) => setTimeout(r, 300));
      return computeJobInp(value, limits);
    };
    const host = await start(launch, { toInp: slowCheck });
    const abort = new AbortController();
    const sent = fetch(`${host.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobOf(cantilever(2))),
      signal: abort.signal,
    }).catch(() => 'aborted');
    setTimeout(() => abort.abort(), 100);
    expect(await sent).toBe('aborted');
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(marker)).toBe(false);
    // The job place is free again.
    const next = await post(host);
    expect(next.status).toBe(201);
    const { id } = (await next.json()) as { id: string };
    await fetch(`${host.endpoint}/jobs/${id}`, { method: 'DELETE' });
    // A request line that is not a URL goes on to the rest of the server.
    const jobs = createSimulationJobs({ limits, toInp: async (v) => computeJobInp(v, limits) });
    let passed = false;
    await jobs.handle({ url: '//', headers: {} } as never, {} as never, () => void (passed = true));
    expect(passed).toBe(true);
    await jobs.close();
  });

  it('turns a connection lost while a body is read into unreachable, and cancels the job (#840 review)', async () => {
    const calls: string[] = [];
    const lost = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'job-1' }));
      if (init?.method === 'DELETE') return new Response('{}');
      return {
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('terminated')),
      } as unknown as Response;
    }) as typeof fetch;
    const host = { ...(await start(slow)), endpoint: 'http://host.test/__simulation-host' };
    await expect(
      runComputeJob(host, jobOf(cantilever(2)), { fetch: lost, pollMs: 1 }),
    ).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringContaining('terminated'),
    });
    expect(calls.at(-1)).toBe('DELETE http://host.test/__simulation-host/jobs/job-1');
    const garbled = (async (_url: string, init?: RequestInit) =>
      new Response(
        init?.method === 'POST' ? JSON.stringify({ id: 'job-2' }) : '<html>',
      )) as typeof fetch;
    await expect(
      runComputeJob(host, jobOf(cantilever(2)), { fetch: garbled, pollMs: 1 }),
    ).rejects.toMatchObject({ reason: 'failed' });
  });

  it('takes jobs from its own origin only, as JSON', async () => {
    const host = await start(slow);
    const body = JSON.stringify(jobOf(cantilever(2)));
    const elsewhere = await fetch(`${host.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body,
    });
    expect(elsewhere.status).toBe(403);
    const form = await fetch(`${host.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    expect(form.status).toBe(415);
    const created = await fetch(`${host.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await fetch(`${host.endpoint}/jobs/${id}/result`)).status).toBe(409);
    expect((await fetch(`${host.endpoint}/jobs/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${host.endpoint}/jobs/${id}`)).status).toBe(404);
  });
});
