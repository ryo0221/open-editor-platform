import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  crashSetup,
  explicitDefaults,
  f97SquareTube,
  kmhToMmPerS,
  runCrashJob,
  type ExplicitSettings,
} from '@editor-platform/geometry-fem';
import { createSimulationJobs, referenceCrash } from '../../../scripts/dev/simulation-host.mjs';
import { ComputeHostError, solveCrashOnHost, type SimulationComputeDescriptor } from './compute';

/**
 * TS-2229 (ST-621, VS8a): the editor's side of a Host crash run: `solveCrashOnHost` sends the
 * explicit model, follows the solved time and reads the result back as the run here gives it; a
 * Host without crash runs is refused before anything is sent.
 */
const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of servers) s.close();
});

function tube(endTime: number) {
  const t = f97SquareTube({ perSide: 4, length: 60 }).model;
  const n = t.nodes.length / 3;
  const nodes = new Float64Array(3 * n);
  for (let i = 0; i < n; i++)
    nodes.set([t.nodes[3 * i + 2]!, t.nodes[3 * i]!, t.nodes[3 * i + 1]! + 100], 3 * i);
  const { fixed: _f, velocity: _v, ...rest } = t;
  const model = crashSetup(
    { ...rest, nodes },
    { barrier: { kind: 'wall' }, speed: 30 * kmhToMmPerS },
  ).model;
  const settings: ExplicitSettings = {
    ...explicitDefaults,
    thicknessPoints: 3,
    endTime,
    frameEvery: endTime / 4,
    historyNodes: [0],
  };
  return { model, settings };
}

describe('crash runs sent to a Host (VS8a)', () => {
  it('gives the result of the run here, with the solved time on the way', async () => {
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
    const host: SimulationComputeDescriptor = {
      label: 'Test Host',
      destination: 'this test',
      solverBuild: 'calculix-test',
      limits: { nodes: 1e6, elements: 1e6, bytes: 64 * 1024 * 1024 },
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`,
      crash: { solverBuild: 'geometry-fem-node-test' },
    };
    const job = tube(0.03);
    const times: number[] = [];
    const there = await solveCrashOnHost(host, job.model, job.settings, {
      pollMs: 20,
      onTime: (t, end) => {
        expect(end).toBe(0.03);
        times.push(t);
      },
    });
    const here = runCrashJob(job);
    expect(there.steps).toBe(here.steps);
    expect(Array.from(there.frames.at(-1)!.plasticStrain)).toEqual(
      Array.from(here.frames.at(-1)!.plasticStrain),
    );
    expect(there.energies.at(-1)).toEqual(here.energies.at(-1));
    expect(times.length).toBeGreaterThan(0);
    const { crash: _c, ...none } = host;
    await expect(solveCrashOnHost(none, job.model, job.settings)).rejects.toThrow(ComputeHostError);
  }, 180_000);
});
