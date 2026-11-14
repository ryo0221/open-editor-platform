import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createSimulationJobs, referenceAero } from '../../../scripts/dev/simulation-host.mjs';
import { ahmedBody, ahmedSizes, type AeroHostResult, type AeroJob } from './index';

/**
 * TS-2208 (ST-606): wind-tunnel jobs on the reference Host, in the CalculiX queue. A fake
 * OpenFOAM (shell steps) here; TS-2209 runs the real one.
 */
const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of servers) s.close();
});

async function host(options: Parameters<typeof createSimulationJobs>[0]) {
  const jobs = createSimulationJobs(options);
  closers.push(jobs.close);
  const server = createServer((req, res) => {
    void jobs.handle(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`;
}

const limits = { nodes: 10, elements: 10, bytes: 64 * 1024 * 1024 };
const post = (url: string, body: unknown) =>
  fetch(`${url}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const until = async (url: string, id: string, states: string[]) => {
  for (let i = 0; i < 200; i++) {
    const s = (await (await fetch(`${url}/jobs/${id}`)).json()) as { state: string };
    if (states.includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no state');
};

const ahmed = ahmedBody(25);
const aeroJob = (over: Partial<AeroJob> = {}): AeroJob => ({
  kind: 'aero',
  surface: { positions: Array.from(ahmed.positions), triangles: Array.from(ahmed.triangles) },
  speed: 40,
  yawDeg: 0,
  ground: 'fixed',
  mesh: { baseMm: 160, level: 3 },
  iterations: 60,
  referenceAreaMm2: ahmedSizes.width * ahmedSizes.height,
  ...over,
});

describe('wind tunnel on the reference Host (VS3b)', () => {
  it('runs an aero job in the queue and gives its result as JSON', async () => {
    const seen: string[] = [];
    const url = await host({
      limits,
      toInp: async () => ({ inp: '' }),
      aero: {
        bashrc: '/dev/null',
        prepare: async (value: { speed: number }) => ({
          files: { 'system/x': 'x' },
          commands: [{ program: 'true', args: [] }],
          timeoutMs: 10_000,
          speed: value.speed,
        }),
        read: async (_dir: string, meta: { speed: number }) => {
          seen.push(`read ${meta.speed}`);
          return { cd: 0.3, speed: meta.speed };
        },
      },
    });
    const created = await post(url, { kind: 'aero', speed: 40 });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await until(url, id, ['done', 'failed'])).state).toBe('done');
    const result = await fetch(`${url}/jobs/${id}/result`);
    expect(result.headers.get('content-type')).toBe('application/json');
    expect(await result.json()).toEqual({ cd: 0.3, speed: 40 });
    expect(seen).toEqual(['read 40']);
    // Read once: the job and its folder are gone.
    expect((await fetch(`${url}/jobs/${id}`)).status).toBe(404);
  });

  it('refuses an aero job without a wind tunnel, and a job its check refuses', async () => {
    const none = await host({ limits, toInp: async () => ({ inp: '' }) });
    const a = await post(none, aeroJob());
    expect([a.status, await a.text()]).toEqual([400, '{"error":"this Host has no wind tunnel"}']);
    const url = await host({
      limits,
      toInp: async () => ({ inp: '' }),
      aero: referenceAero((m: string) => import(/* @vite-ignore */ m), '/dev/null'),
    });
    const b = await post(url, { ...aeroJob(), dict: '#include "/etc/passwd"' });
    expect(b.status).toBe(400);
    expect(await b.text()).toMatch(/job-invalid: job: unknown field \\"dict\\"/);
  });

  it('cancels a running aero job and stops its processes', async () => {
    const url = await host({
      limits,
      toInp: async () => ({ inp: '' }),
      aero: {
        bashrc: '/dev/null',
        prepare: async () => ({
          files: {},
          commands: [{ program: 'bash', args: ['-c', 'sleep 30 & wait'] }],
          timeoutMs: 60_000,
        }),
        read: async () => ({}),
      },
    });
    const { id } = (await (await post(url, { kind: 'aero' })).json()) as { id: string };
    await until(url, id, ['running']);
    const started = Date.now();
    const d = await fetch(`${url}/jobs/${id}`, { method: 'DELETE' });
    expect(await d.json()).toEqual({ state: 'cancelled' });
    expect((await fetch(`${url}/jobs/${id}`)).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says why an OpenFOAM step failed', async () => {
    const url = await host({
      limits,
      toInp: async () => ({ inp: '' }),
      aero: {
        bashrc: '/dev/null',
        prepare: async () => ({
          files: {},
          commands: [
            { program: 'bash', args: ['-c', 'echo "--> FOAM FATAL ERROR: no mesh"; exit 1'] },
          ],
          timeoutMs: 10_000,
        }),
        read: async () => ({}),
      },
    });
    const { id } = (await (await post(url, { kind: 'aero' })).json()) as { id: string };
    const s = (await until(url, id, ['failed', 'done'])) as { state: string; message?: string };
    expect(s).toEqual({ state: 'failed', message: 'bash failed: FOAM FATAL ERROR: no mesh' });
  });
});

/**
 * TS-2209 (ST-606 #3): the Ahmed body through the reference Host on a real OpenFOAM (CFD_OPENFOAM
 * as in TS-2205), a coarse case of a few minutes: the coefficients, and on the flat roof Cp, Cf and
 * the heat transfer coefficient against a turbulent flat plate.
 */
const env = process.env.CFD_OPENFOAM;
it.skipIf(!env)(
  'gives the coefficients and the surface heat transfer through the Host',
  async () => {
    const bashrc = env && env !== '1' ? env : '/usr/share/openfoam/etc/bashrc';
    const url = await host({
      limits,
      toInp: async () => ({ inp: '' }),
      aero: referenceAero((m: string) => import(/* @vite-ignore */ m), bashrc),
    });
    const level = Number(process.env.CFD_OPENFOAM_LEVEL ?? 5);
    const job = aeroJob({ mesh: { baseMm: 160, level }, iterations: 300 });
    const { id } = (await (await post(url, job)).json()) as { id: string };
    let s: { state: string; message?: string } = { state: 'queued' };
    for (let i = 0; i < 20 * 60 && !['done', 'failed'].includes(s.state); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = (await (await fetch(`${url}/jobs/${id}`)).json()) as typeof s;
    }
    expect(s.state, s.message).toBe('done');
    const r = (await (await fetch(`${url}/jobs/${id}/result`)).json()) as AeroHostResult;
    expect(r.cd).toBeGreaterThan(0.2);
    expect(r.cd).toBeLessThan(0.45);
    const n = r.cp.length;
    expect([r.cf.length, r.htc.length, r.points.length]).toEqual([n, n, 3 * n]);
    expect(r.htc.every((h) => h >= 0 && Number.isFinite(h))).toBe(true);
    // The roof: flat, from the end of the front rounding (100 mm behind the nose) to the slant.
    const top = 50 + ahmedSizes.height;
    const nose = ahmedSizes.length;
    const roof: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x, , z] = [r.points[3 * i]!, r.points[3 * i + 1]!, r.points[3 * i + 2]!];
      if (Math.abs(z - top) < 1 && x < nose - 300 && x > 400) roof.push(i);
    }
    expect(roof.length).toBeGreaterThan(20);
    const mean = (v: number[]) => roof.reduce((a, i) => a + v[i]!, 0) / roof.length;
    // Turbulent flat plate, local: h = 0.0296 Re_x^0.8 Pr^(1/3) k / x, x from the nose.
    const k = 0.0257;
    const plate =
      roof.reduce((a, i) => {
        const x = (nose - r.points[3 * i]!) / 1000;
        return a + (0.0296 * ((40 * x) / 1.5e-5) ** 0.8 * 0.71 ** (1 / 3) * k) / x;
      }, 0) / roof.length;
    console.log(JSON.stringify({ cd: r.cd, roofHtc: mean(r.htc), plate, roofCp: mean(r.cp) }));
    expect(mean(r.htc) / plate).toBeGreaterThan(0.5);
    expect(mean(r.htc) / plate).toBeLessThan(1.5);
    // Faster than the free stream over the roof: Cp below zero.
    expect(mean(r.cp)).toBeLessThan(0);
  },
  30 * 60 * 1000,
);

it('leaves no case folder behind when cancelled while the case is written', async () => {
  // TS-2208 (ST-606, Codex on #1180): many files, cancelled at once.
  const { readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('simulation-aero-')));
  const url = await host({
    limits,
    toInp: async () => ({ inp: '' }),
    aero: {
      bashrc: '/dev/null',
      prepare: async () => ({
        files: Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [`f/${i}`, 'x'.repeat(20_000)]),
        ),
        commands: [{ program: 'true', args: [] }],
        timeoutMs: 10_000,
      }),
      read: async () => ({}),
    },
  });
  const { id } = (await (await post(url, { kind: 'aero' })).json()) as { id: string };
  await until(url, id, ['running']);
  await fetch(`${url}/jobs/${id}`, { method: 'DELETE' });
  await new Promise((r) => setTimeout(r, 1500));
  const left = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('simulation-aero-') && !before.has(n),
  );
  expect(left).toEqual([]);
});
