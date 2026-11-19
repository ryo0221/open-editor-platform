import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createSimulationJobs, referenceCrash } from '../../../scripts/dev/simulation-host.mjs';
import { crashSetup, kmhToMmPerS } from './crash-setup';
import {
  checkCrashJob,
  crashJobLimits,
  crashJobOf,
  crashResultJson,
  readCrashResult,
  runCrashJob,
  CrashJobError,
} from './crash-job';
import { explicitDefaults, type ExplicitSettings } from './explicit';
import { f97SquareTube } from './explicit-tube';

/**
 * TS-2228 (ST-621, VS8a): a crash run on the reference Host: the job as JSON numbers checked
 * again there, run by the same explicit solver in a Node process of its own and read back into
 * the same result as a run here; refusals, cancel.
 */
function tubeJob(endTime = 0.004) {
  const tube = f97SquareTube({ perSide: 4, length: 60 }).model;
  // The tube along x (its axis is z): nose at the far end.
  const n = tube.nodes.length / 3;
  const nodes = new Float64Array(3 * n);
  for (let i = 0; i < n; i++)
    nodes.set([tube.nodes[3 * i + 2]!, tube.nodes[3 * i]!, tube.nodes[3 * i + 1]! + 100], 3 * i);
  const { fixed: _fixed, velocity: _velocity, ...rest } = tube;
  const setup = crashSetup(
    { ...rest, nodes, contact: { friction: 0.1, ignoreInitial: true } },
    { barrier: { kind: 'wall' }, speed: 30 * kmhToMmPerS },
  );
  const settings: ExplicitSettings = {
    ...explicitDefaults,
    thicknessPoints: 3,
    endTime,
    frameEvery: endTime / 4,
    historyNodes: [0],
  };
  return { model: setup.model, settings };
}

const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of servers) s.close();
});
async function host() {
  const jobs = createSimulationJobs({
    limits: { bytes: 64 * 1024 * 1024 },
    toInp: async () => ({ inp: '' }),
    crash: referenceCrash((m: string) => import(/* @vite-ignore */ m)),
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`;
}
const post = (url: string, body: unknown) =>
  fetch(`${url}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const until = async (url: string, id: string, states: string[], seen?: string[]) => {
  for (let i = 0; i < 1200; i++) {
    const s = (await (await fetch(`${url}/jobs/${id}`)).json()) as {
      state: string;
      phase?: string;
      message?: string;
    };
    if (s.phase) seen?.push(s.phase);
    if (states.includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no state');
};

describe('crash runs on the reference Host (VS8a)', () => {
  it('reads a job back as the same model and a result back as the same result', () => {
    const job = tubeJob(0.001);
    const sent = JSON.parse(JSON.stringify(crashJobOf(job.model, job.settings))) as unknown;
    const back = checkCrashJob(sent);
    expect(Array.from(back.model.nodes)).toEqual(Array.from(job.model.nodes));
    expect(Array.from(back.model.shells)).toEqual(Array.from(job.model.shells));
    expect(back.model.walls).toEqual(job.model.walls);
    expect(back.model.materials).toEqual(job.model.materials);
    const here = runCrashJob(job);
    const there = readCrashResult(crashResultJson(runCrashJob(back)));
    expect(there.steps).toBe(here.steps);
    expect(Array.from(there.frames.at(-1)!.displacement)).toEqual(
      Array.from(here.frames.at(-1)!.displacement),
    );
    expect(Array.from(there.history[0]!.velocity)).toEqual(Array.from(here.history[0]!.velocity));
    expect(there.barriers[0]!.kind).toBe('wall');
    expect(there.checks.map((c) => c.name)).toEqual(here.checks.map((c) => c.name));
  }, 60_000);

  it('refuses what is not a crash job of numbers within the limits', () => {
    const job = crashJobOf(tubeJob().model, tubeJob().settings);
    const refuse = (change: (j: Record<string, never>) => void, why: RegExp) => {
      const j = JSON.parse(JSON.stringify(job)) as Record<string, never>;
      change(j);
      expect(() => checkCrashJob(j)).toThrow(CrashJobError);
      expect(() => checkCrashJob(j)).toThrow(why);
    };
    refuse((j) => ((j as Record<string, unknown>).script = 'x'), /unknown key script/);
    refuse(
      (j) => (((j as Record<string, Record<string, unknown>>).model!.include = 1), undefined),
      /unknown model key include/,
    );
    refuse(
      (j) => ((j as Record<string, Record<string, unknown[]>>).model!.nodes![0] = 'x'),
      /nodes holds a bad number/,
    );
    refuse(
      (j) => ((j as Record<string, Record<string, unknown[]>>).model!.shells![0] = 1.5),
      /shells holds a bad number/,
    );
    // Numbers a typed array would wrap: a node index past the nodes, a material past 16 bits.
    refuse(
      (j) => ((j as Record<string, Record<string, unknown[]>>).model!.shells![0] = 4294967296),
      /shells holds a bad number/,
    );
    refuse(
      (j) => ((j as Record<string, Record<string, unknown[]>>).model!.shellMaterial![0] = 65536),
      /shellMaterial holds a bad number/,
    );
    refuse(
      (j) =>
        ((j as Record<string, Record<string, unknown>>).model!.materials = [{ density: 'steel' }]),
      /materials holds something else than numbers/,
    );
    refuse(
      (j) =>
        ((j as Record<string, Record<string, unknown>>).settings!.endTime =
          crashJobLimits.endTime * 2),
      /end time/,
    );
    refuse(
      (j) => ((j as Record<string, Record<string, unknown>>).settings!.historyNodes = [1e9]),
      /history nodes/,
    );
    refuse(
      (j) => ((j as Record<string, Record<string, unknown>>).settings!.command = 'rm'),
      /unknown setting command/,
    );
  });

  it('runs a job in a Node process of its own, with its solved time, and cancels one', async () => {
    const url = await host();
    const job = tubeJob();
    const created = await post(url, crashJobOf(job.model, job.settings));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const end = await until(url, id, ['done', 'failed']);
    expect(end, JSON.stringify(end)).toMatchObject({ state: 'done' });
    const there = readCrashResult(await (await fetch(`${url}/jobs/${id}/result`)).text());
    const here = runCrashJob(job);
    expect(there.steps).toBe(here.steps);
    expect(Array.from(there.frames.at(-1)!.displacement)).toEqual(
      Array.from(here.frames.at(-1)!.displacement),
    );
    // A job refused before it is queued, and one the solver refuses in its process.
    const bad = await post(url, { kind: 'crash', model: {}, settings: {} });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/crash-job-invalid/);
    const broken = crashJobOf(job.model, job.settings);
    (broken.model.shellMaterial as number[])[0] = 9;
    const failed = (await (await post(url, broken)).json()) as { id: string };
    const why = await until(url, failed.id, ['done', 'failed']);
    expect(why.state).toBe('failed');
    expect(why.message).toMatch(/model-invalid/);
    // A long one cancelled while it solves.
    const long = tubeJob(0.05);
    const running = (await (await post(url, crashJobOf(long.model, long.settings))).json()) as {
      id: string;
    };
    // Its phase says how far it has solved.
    const phases: string[] = [];
    for (let i = 0; i < 400 && !phases.some((p) => /^solving \S+ of 0.05 s$/.test(p)); i++) {
      const st = (await (await fetch(`${url}/jobs/${running.id}`)).json()) as { phase?: string };
      if (st.phase) phases.push(st.phase);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      phases.some((p) => /^solving \S+ of 0.05 s$/.test(p)),
      phases.join(),
    ).toBe(true);
    const del = await fetch(`${url}/jobs/${running.id}`, { method: 'DELETE' });
    expect(((await del.json()) as { state: string }).state).toBe('cancelled');
    expect((await fetch(`${url}/jobs/${running.id}`)).status).toBe(404);
  }, 180_000);
});
