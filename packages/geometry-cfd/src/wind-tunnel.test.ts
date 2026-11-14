import { describe, expect, it } from 'vitest';
import {
  CfdError,
  WindTunnelJobs,
  boxSurface,
  runWindTunnel,
  type WindTunnelMessage,
  type WindTunnelRequest,
} from './index';

// TS-2206 (ST-604): the browser wind tunnel as one run, on the page or in a worker.
const request = (over: Partial<WindTunnelRequest> = {}): WindTunnelRequest => ({
  bodies: [boxSurface([12, 6, 6], [16, 14, 14])],
  grid: { origin: [0, 0, 0], spacing: 1, dims: [40, 20, 20] },
  flow: { speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' },
  steps: 300,
  averageSteps: 100,
  progressEvery: 50,
  ...over,
});

describe('runWindTunnel', () => {
  it('settles, averages the force and the fields, and reports progress', async () => {
    const seen: number[] = [];
    let pauses = 0;
    const r = await runWindTunnel(request(), {
      onProgress: (p) => seen.push(p.step),
      pause: async () => void pauses++,
    });
    expect(seen).toEqual([50, 100, 150, 200, 250, 300]);
    expect(pauses).toBe(6);
    expect(r.history).toHaveLength(6);
    // A blunt plate: drag well above 1, no side force, little lift (symmetric in y and z).
    expect(r.cd).toBeGreaterThan(1);
    expect(Math.abs(r.cs)).toBeLessThan(0.05);
    expect(Math.abs(r.cl)).toBeLessThan(0.05);
    expect(r.frontalAreaMm2).toBe(64);
    expect(r.referenceDensity).toBeGreaterThan(1);
    // Fields are the mean of the averaging chunks: speed U far from the body, 0 in it.
    const c = 2 + 40 * (2 + 20 * 2);
    expect(r.velocity[3 * c]!).toBeGreaterThan(0.03);
    const inside = 14 + 40 * (10 + 20 * 10);
    expect(r.solid[inside]).toBe(1);
    expect(r.rho).toHaveLength(40 * 20 * 20);
  }, 60_000);

  it('refuses bad step counts and stops when cancelled', async () => {
    await expect(runWindTunnel(request({ steps: 0 }))).rejects.toThrow(/config/);
    await expect(runWindTunnel(request({ averageSteps: 400 }))).rejects.toThrow(/config/);
    await expect(runWindTunnel(request({ progressEvery: 0.5 }))).rejects.toThrow(/config/);
    const ac = new AbortController();
    await expect(
      runWindTunnel(request(), { onProgress: () => ac.abort(), signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
    // A cancel in the last report, or in the yield after it, is not lost.
    const last = new AbortController();
    await expect(
      runWindTunnel(request({ steps: 1, averageSteps: 1 }), {
        onProgress: () => last.abort(),
        signal: last.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    const later = new AbortController();
    await expect(
      runWindTunnel(request({ steps: 1, averageSteps: 1 }), {
        pause: async () => later.abort(),
        signal: later.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  }, 60_000);
});

/** A worker stand-in that answers with the given messages. */
class FakeWorker {
  onmessage: ((e: MessageEvent<WindTunnelMessage>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(private readonly reply: (w: FakeWorker) => void) {}
  postMessage() {
    setTimeout(() => this.reply(this), 0);
  }
  send(m: WindTunnelMessage) {
    this.onmessage?.({ data: m } as MessageEvent<WindTunnelMessage>);
  }
  terminate() {
    this.terminated = true;
  }
}

describe('WindTunnelJobs', () => {
  it('runs on the page where there is no Worker', async () => {
    const r = await new WindTunnelJobs().run(request({ steps: 100, averageSteps: 50 }));
    expect(r.cd).toBeGreaterThan(0);
  }, 60_000);

  it('relays progress and the result from its worker, then ends the worker', async () => {
    const progress = { step: 1, steps: 2, cd: 1, cl: 0, cs: 0, maxSpeed: 0.05 };
    const result = { cd: 0.3 } as never;
    let made: FakeWorker | undefined;
    const jobs = new WindTunnelJobs(() => {
      made = new FakeWorker((w) => {
        w.send({ kind: 'progress', progress });
        w.send({ kind: 'done', result });
      });
      return made as unknown as Worker;
    });
    const seen: unknown[] = [];
    const out = await jobs.run(request(), { onProgress: (p) => seen.push(p) });
    expect(out).toBe(result);
    expect(seen).toEqual([progress]);
    expect(made!.terminated).toBe(true);
  });

  it('passes on the worker’s error code and ends the worker when cancelled', async () => {
    const failing = new WindTunnelJobs(
      () =>
        new FakeWorker((w) =>
          w.send({ kind: 'failed', code: 'unstable', message: 'unstable: speed 0.5' }),
        ) as unknown as Worker,
    );
    const e = await failing.run(request()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CfdError);
    expect((e as CfdError).code).toBe('unstable');
    expect((e as CfdError).message).toBe('unstable: speed 0.5');

    let made: FakeWorker | undefined;
    const silent = new WindTunnelJobs(() => {
      made = new FakeWorker(() => undefined);
      return made as unknown as Worker;
    });
    const ac = new AbortController();
    const run = silent.run(request(), { signal: ac.signal });
    ac.abort();
    await expect(run).rejects.toThrow(/cancelled/);
    expect(made!.terminated).toBe(true);
  });

  it('goes on here when the worker does not load', async () => {
    const jobs = new WindTunnelJobs(
      () =>
        new FakeWorker((w) =>
          w.onerror?.({ preventDefault: () => undefined } as ErrorEvent),
        ) as unknown as Worker,
    );
    const r = await jobs.run(request({ steps: 100, averageSteps: 50 }));
    expect(r.cd).toBeGreaterThan(0);
  }, 60_000);
});
