import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { FrameModel } from '@editor-platform/geometry-fem';
import { createSimulationJobs } from '../../../scripts/dev/simulation-host.mjs';
import {
  checkFrameJob,
  ComputeJobError,
  computeJobInp,
  solveFrameOnHost,
  type SimulationComputeDescriptor,
} from './compute';

const hasCcx = /Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`);

/** A 2 m cantilever of 100 × 200 mm in two elements, 1 kN down at its tip. */
const cantilever = (): FrameModel => ({
  nodes: [0, 0, 0, 1000, 0, 0, 2000, 0, 0],
  groups: [
    {
      section: {
        area: 20000,
        i11: (100 * 200 ** 3) / 12,
        i22: (200 * 100 ** 3) / 12,
        torsion: 0.229 * 200 * 100 ** 3,
        c1: 100,
        c2: 50,
      },
      depthDirection: [0, 0, 1],
      material: { youngsModulus: 210000, poissonsRatio: 0.3 },
      elements: [0, 1, 1, 2],
    },
  ],
  fixed: [0],
  force: [[2, 0, 0, -1000]],
});

describe('CS4 frame jobs on the reference Host (ST-547, TS-2081)', () => {
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const s of servers) s.close();
  });

  it('checks a frame job like any job, and writes its .inp (ST-547#1)', () => {
    const job = { kind: 'frame-static', frame: cantilever() };
    expect(computeJobInp(JSON.parse(JSON.stringify(job))).inp).toContain('TYPE=U1');
    const problem = (value: unknown) => {
      try {
        checkFrameJob(value);
      } catch (e) {
        expect(e).toBeInstanceOf(ComputeJobError);
        return (e as ComputeJobError).problem;
      }
      return 'accepted';
    };
    expect(problem({ ...job, extra: 1 })).toBe('shape');
    expect(problem({ kind: 'frame-static', frame: { ...cantilever(), fixed: [9] } })).toBe('index');
    expect(
      problem({
        kind: 'frame-static',
        frame: {
          ...cantilever(),
          groups: [{ ...cantilever().groups[0]!, section: { area: 1 } }],
        },
      }),
    ).toBe('shape');
    expect(() => checkFrameJob(job, { nodes: 2, elements: 1e6, bytes: 1e9 })).toThrow(/too-large/);
  });

  it.skipIf(!hasCcx)('solves a frame on the Host (ST-547#2)', async () => {
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
    const host: SimulationComputeDescriptor = {
      label: 'Test Host',
      destination: 'a test server',
      solverBuild: 'test',
      limits,
      endpoint: `http://127.0.0.1:${port}/__simulation-host`,
    };
    const r = await solveFrameOnHost(host, cantilever(), { pollMs: 20 });
    // PL³/3EI = 0.1905 mm, and M/W = 3 MPa at the root.
    expect(r.displacement[3 * 2 + 2]!).toBeCloseTo(-0.1905, 4);
    expect(r.stress[0]).toBeCloseTo(3, 3);
  });
});
