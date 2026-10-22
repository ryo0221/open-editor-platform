import { EditorSession } from '@editor-platform/editor-core';
import {
  CadCoordinator,
  f02Plate,
  fixtureKernel,
  type CadEvaluateRequest,
} from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { WorkerKernelPort, type WorkerLike } from './port';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';

const build = {
  buildHash: fixtureKernel.buildHash,
  moduleUrl: '/kernel.js',
  wasmUrl: '/kernel.wasm',
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Manual timers so deadlines fire only when the test says so. */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    set: (fn: () => void) => (pending.set(++next, fn), next),
    clear: (id: unknown) => void pending.delete(id as number),
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    get size() {
      return pending.size;
    },
  };
}
function fakeWorkers() {
  const workers: (WorkerLike & {
    inbox: CadWorkerRequest[];
    terminated: boolean;
    send(m: CadWorkerResponse): void;
  })[] = [];
  const spawn = () => {
    const w = {
      inbox: [] as CadWorkerRequest[],
      terminated: false,
      onmessage: null as WorkerLike['onmessage'],
      onerror: null as WorkerLike['onerror'],
      postMessage(m: CadWorkerRequest) {
        this.inbox.push(m);
      },
      terminate() {
        this.terminated = true;
      },
      send(m: CadWorkerResponse) {
        if (!this.terminated) this.onmessage?.({ data: m });
      },
    };
    workers.push(w);
    return w;
  };
  return { workers, spawn };
}
const request = (id: string, hash = 'a'.repeat(64)): CadEvaluateRequest => ({
  requestId: id,
  generation: 1,
  baseHash: hash,
  candidateHash: hash,
  document: f02Plate(),
});
const ok = (r: CadEvaluateRequest): CadWorkerResponse => ({
  type: 'result',
  requestId: r.requestId,
  generation: r.generation,
  evaluation: {
    status: 'ok',
    contentHash: r.candidateHash,
    buildHash: build.buildHash,
    geometryDigest: 'd',
    bodies: {},
  },
  meshes: [],
});

describe('WorkerKernelPort (CAD24)', () => {
  it('initializes once, runs one job and keeps only the latest waiting job', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new WorkerKernelPort({ spawn, build, timers: manualTimers() });
    const a = port.evaluate(request('a'));
    const b = port.evaluate(request('b'));
    const c = port.evaluate(request('c'));
    expect(await b).toMatchObject({ status: 'error', code: 'superseded' });
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    expect(workers[0].inbox.map((m) => m.type)).toEqual(['init', 'evaluate']);
    workers[0].send(ok(request('a')));
    expect(await a).toMatchObject({ status: 'ok' });
    await flush();
    workers[0].send(ok(request('c')));
    expect(await c).toMatchObject({ status: 'ok' });
    expect(port.spawned).toBe(1);
  });

  it('acknowledged cancel reuses the Worker; a missing ack terminates and respawns', async () => {
    const { workers, spawn } = fakeWorkers();
    const timers = manualTimers();
    const port = new WorkerKernelPort({ spawn, build, timers });
    const first = port.evaluate(request('first'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    port.cancel('first');
    expect(workers[0].inbox.at(-1)).toEqual({ type: 'cancel', requestId: 'first' });
    workers[0].send({ type: 'cancelled', requestId: 'first' });
    expect(await first).toMatchObject({ code: 'cancelled' });

    const stuck = port.evaluate(request('stuck'));
    await flush();
    port.cancel('stuck');
    timers.fireAll();
    expect(await stuck).toMatchObject({ code: 'cancelled', retryable: true });
    expect(workers[0].terminated).toBe(true);
    // A late result from the terminated instance is never delivered.
    workers[0].send(ok(request('stuck')));
    const next = port.evaluate(request('next'));
    workers[1].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[1].send(ok(request('next')));
    expect(await next).toMatchObject({ status: 'ok' });
    expect(port.spawned).toBe(2);
  });

  it('times out a job, reports crashes and refuses a different build', async () => {
    const { workers, spawn } = fakeWorkers();
    const timers = manualTimers();
    const port = new WorkerKernelPort({ spawn, build, timers });
    const slow = port.evaluate(request('slow'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    timers.fireAll();
    expect(await slow).toMatchObject({ code: 'timeout', retryable: false });

    const crash = port.evaluate(request('crash'));
    workers[1].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[1].onerror?.(new Error('boom'));
    expect(await crash).toMatchObject({ code: 'kernel-unavailable', retryable: true });

    const wrong = port.evaluate(request('wrong'));
    workers[2].send({ type: 'ready', buildHash: `sha256:${'9'.repeat(64)}` });
    expect(await wrong).toMatchObject({ code: 'kernel-unavailable' });
    expect(workers[2].terminated).toBe(true);
  });

  it('stops a Worker that never reports ready and recovers on a fresh instance', async () => {
    const { workers, spawn } = fakeWorkers();
    const timers = manualTimers();
    const port = new WorkerKernelPort({ spawn, build, timers });
    const hung = port.evaluate(request('hung'));
    expect(timers.size).toBe(1);
    timers.fireAll();
    expect(await hung).toMatchObject({ code: 'kernel-unavailable', retryable: true });
    expect(workers[0].terminated).toBe(true);
    const next = port.evaluate(request('next'));
    workers[1].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[1].send(ok(request('next')));
    expect(await next).toMatchObject({ status: 'ok' });
  });

  it('settles the job at once when the Worker cannot be constructed', async () => {
    const { workers, spawn } = fakeWorkers();
    let refuse = true;
    const timers = manualTimers();
    const port = new WorkerKernelPort({
      spawn: () => {
        if (refuse) throw new Error('SecurityError');
        return spawn();
      },
      build,
      timers,
    });
    expect(await port.evaluate(request('refused'))).toMatchObject({
      code: 'kernel-unavailable',
      retryable: true,
    });
    expect(timers.size).toBe(0);
    refuse = false;
    const next = port.evaluate(request('next'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[0].send(ok(request('next')));
    expect(await next).toMatchObject({ status: 'ok' });
  });

  it('dispose terminates an idle Worker and never starts waiting work', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new WorkerKernelPort({ spawn, build, timers: manualTimers() });
    const first = port.evaluate(request('first'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[0].send(ok(request('first')));
    await first;
    port.dispose();
    expect(workers[0].terminated).toBe(true);

    const busy = new WorkerKernelPort({ spawn, build, timers: manualTimers() });
    const running = busy.evaluate(request('running'));
    const waiting = busy.evaluate(request('waiting'));
    busy.dispose();
    expect(await running).toMatchObject({ code: 'kernel-unavailable' });
    expect(await waiting).toMatchObject({ code: 'kernel-unavailable' });
    expect(await busy.evaluate(request('later'))).toMatchObject({ code: 'kernel-unavailable' });
    await flush();
    expect(workers).toHaveLength(2);
    expect(workers[1].terminated).toBe(true);
  });

  it('drives CadCoordinator end to end', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new WorkerKernelPort({ spawn, build, timers: manualTimers() });
    const session = new EditorSession(f02Plate());
    const coordinator = new CadCoordinator({
      session,
      kernel: port,
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    const pending = coordinator.prepare({ type: 'setParameter', parameterId: 'W', value: 100 });
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    const sent = workers[0].inbox.find((m) => m.type === 'evaluate') as Extract<
      CadWorkerRequest,
      { type: 'evaluate' }
    >;
    workers[0].send(ok(sent));
    const prepared = await pending;
    expect(prepared.status).toBe('ready');
    if (prepared.status === 'ready')
      expect(coordinator.apply(prepared.ticket).status).toBe('applied');
    expect(coordinator.geometryState).toBe('ready');
  });
});
