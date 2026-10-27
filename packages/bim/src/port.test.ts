import type { GeometryGraph } from '@editor-platform/geometry-core';
import { describe, expect, it } from 'vitest';
import { WorkerBimKernel, type BimWorkerLike } from './port';
import type { BimWorkerRequest, BimWorkerResponse } from './protocol';

/** A Worker double: answers `init` at once and lets the test answer each `run`. */
class FakeWorker implements BimWorkerLike {
  onmessage: ((event: { data: BimWorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: BimWorkerRequest[] = [];
  terminated = false;
  constructor(private readonly init: 'ready' | 'fail' | 'silent' = 'ready') {}
  postMessage(message: BimWorkerRequest) {
    this.sent.push(message);
    if (message.type === 'init' && this.init !== 'silent')
      queueMicrotask(() =>
        this.reply(
          this.init === 'ready'
            ? { type: 'ready', buildHash: message.build.buildHash }
            : { type: 'init-failed', code: 'kernel-load-failed' },
        ),
      );
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: BimWorkerResponse) {
    this.onmessage?.({ data });
  }
  runs = () => this.sent.filter((m) => m.type === 'run');
}
/** Timers the test fires by hand. */
const manualTimers = () => {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  return {
    set: (fn: () => void, ms: number) => (pending.set(++id, { fn, ms }), id),
    clear: (i: unknown) => void pending.delete(i as number),
    fire(ms: number) {
      for (const [i, t] of [...pending])
        if (t.ms === ms) {
          pending.delete(i);
          t.fn();
        }
    },
  };
};
const build = { buildHash: 'sha256:00', moduleUrl: '/k.js', wasmUrl: '/k.wasm' };
const graph: GeometryGraph = { nodes: {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('bim Worker kernel port (R2c-3c)', () => {
  it('runs jobs one at a time on one Worker', async () => {
    const workers: FakeWorker[] = [];
    const kernel = new WorkerBimKernel({
      spawn: () => (workers.push(new FakeWorker()), workers.at(-1)!),
      build,
    });
    const a = kernel.run(graph, [], new Map([['k', new Uint8Array([1])]]));
    const b = kernel.run(graph, [], new Map());
    await tick();
    const w = workers[0]!;
    expect(w.runs()).toHaveLength(1);
    const [first] = w.runs() as Extract<BimWorkerRequest, { type: 'run' }>[];
    expect(first!.assets.k).toEqual(new Uint8Array([1]));
    w.reply({
      type: 'result',
      requestId: first!.requestId,
      evaluation: { status: 'ok', results: [] },
    });
    expect(await a).toEqual({ status: 'ok', results: [] });
    await tick();
    const second = w.runs()[1] as Extract<BimWorkerRequest, { type: 'run' }>;
    w.reply({
      type: 'result',
      requestId: second.requestId,
      evaluation: { status: 'ok', results: [] },
    });
    expect((await b).status).toBe('ok');
    expect(kernel.spawned).toBe(1);
    // An idle port still holds its Worker and kernel: disposing it terminates them.
    kernel.dispose();
    expect(w.terminated).toBe(true);
  });

  it('stops a job past the limit and starts the next on a fresh Worker', async () => {
    const workers: FakeWorker[] = [];
    const timers = manualTimers();
    const kernel = new WorkerBimKernel({
      spawn: () => (workers.push(new FakeWorker()), workers.at(-1)!),
      build,
      timers,
    });
    const a = kernel.run(graph, [], new Map());
    await tick();
    timers.fire(30_000);
    expect(await a).toEqual({ status: 'timeout' });
    expect(workers[0]!.terminated).toBe(true);
    const b = kernel.run(graph, [], new Map());
    await tick();
    expect(workers).toHaveLength(2);
    const run = workers[1]!.runs()[0] as Extract<BimWorkerRequest, { type: 'run' }>;
    workers[1]!.reply({
      type: 'result',
      requestId: run.requestId,
      evaluation: { status: 'ok', results: [] },
    });
    expect((await b).status).toBe('ok');
  });

  it("holds a job to its own limit when it has one (a drawing's projection)", async () => {
    const timers = manualTimers();
    const kernel = new WorkerBimKernel({ spawn: () => new FakeWorker(), build, timers });
    const a = kernel.run(graph, [], new Map(), undefined, { timeoutMs: 300_000 });
    let settled = false;
    void a.then(() => (settled = true));
    await tick();
    timers.fire(30_000);
    await tick();
    expect(settled).toBe(false);
    timers.fire(300_000);
    expect(await a).toEqual({ status: 'timeout' });
  });

  it('counts Worker start-up in the limit', async () => {
    const timers = manualTimers();
    const kernel = new WorkerBimKernel({ spawn: () => new FakeWorker('silent'), build, timers });
    const a = kernel.run(graph, [], new Map());
    await tick();
    timers.fire(30_000);
    expect(await a).toEqual({ status: 'timeout' });
  });

  it('cancels cooperatively, and terminates when the cancel is not acknowledged', async () => {
    const workers: FakeWorker[] = [];
    const timers = manualTimers();
    const kernel = new WorkerBimKernel({
      spawn: () => (workers.push(new FakeWorker()), workers.at(-1)!),
      build,
      timers,
    });
    const first = new AbortController();
    const a = kernel.run(graph, [], new Map(), first.signal);
    await tick();
    first.abort();
    const w = workers[0]!;
    const cancel = w.sent.at(-1)!;
    expect(cancel.type).toBe('cancel');
    w.reply({ type: 'cancelled', requestId: (cancel as { requestId: string }).requestId });
    expect(await a).toEqual({ status: 'cancelled' });
    expect(w.terminated).toBe(false);

    const second = new AbortController();
    const b = kernel.run(graph, [], new Map(), second.signal);
    await tick();
    second.abort();
    timers.fire(500);
    expect(await b).toEqual({ status: 'cancelled' });
    expect(w.terminated).toBe(true);
  });

  it('never sends a job aborted while it waited', async () => {
    const workers: FakeWorker[] = [];
    const kernel = new WorkerBimKernel({
      spawn: () => (workers.push(new FakeWorker()), workers.at(-1)!),
      build,
    });
    const a = kernel.run(graph, [], new Map());
    const waiting = new AbortController();
    const b = kernel.run(graph, [], new Map(), waiting.signal);
    waiting.abort();
    await tick();
    const run = workers[0]!.runs()[0] as Extract<BimWorkerRequest, { type: 'run' }>;
    workers[0]!.reply({
      type: 'result',
      requestId: run.requestId,
      evaluation: { status: 'ok', results: [] },
    });
    await a;
    expect(await b).toEqual({ status: 'cancelled' });
    expect(workers[0]!.runs()).toHaveLength(1);
  });

  it('names a build that cannot load, a crash, and a missing build', async () => {
    const failing = new WorkerBimKernel({ spawn: () => new FakeWorker('fail'), build });
    expect(await failing.run(graph, [], new Map())).toEqual({
      status: 'error',
      code: 'kernel-load-failed',
    });
    const workers: FakeWorker[] = [];
    const crashing = new WorkerBimKernel({
      spawn: () => (workers.push(new FakeWorker()), workers.at(-1)!),
      build,
    });
    const a = crashing.run(graph, [], new Map());
    await tick();
    workers[0]!.onerror?.(new Event('error'));
    expect(await a).toEqual({ status: 'error', code: 'kernel-crashed' });
    const none = new WorkerBimKernel({ spawn: () => new FakeWorker(), build: undefined });
    expect(await none.run(graph, [], new Map())).toEqual({
      status: 'error',
      code: 'kernel-build-unavailable',
    });
  });
});
