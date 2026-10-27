import { EditorSession } from '@editor-platform/editor-core';
import {
  applyCadOperation,
  cadContentHash,
  CadCoordinator,
  f02Plate,
  f03Revolve,
  fixtureComponent,
  fixtureKernel,
  fixturePart,
  fixtureVersion,
  position,
  identityQuaternion,
  type CadDocument,
  type CadEvaluateRequest,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
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
  /** Each deadline's milliseconds, in the order set. */
  const delays: number[] = [];
  return {
    delays,
    set: (fn: () => void, ms: number) => (delays.push(ms), pending.set(++next, fn), next),
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

  it('evaluates for export with its deflection and keeps the meshes away from the display', async () => {
    const { workers, spawn } = fakeWorkers();
    const shown: string[] = [];
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers: manualTimers(),
      onMeshes: (hash) => shown.push(hash),
    });
    const exported = port.exportMeshes(request('x'), 0.01);
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    expect(workers[0].inbox.at(-1)).toMatchObject({
      type: 'evaluate',
      requestId: 'x',
      deflectionMm: 0.01,
    });
    workers[0].send(ok(request('x')));
    expect(await exported).toMatchObject({ evaluation: { status: 'ok' }, meshes: [] });
    expect(shown).toEqual([]);
    const display = port.evaluate(request('d', 'b'.repeat(64)));
    await flush();
    expect(workers[0].inbox.at(-1)).not.toHaveProperty('deflectionMm');
    workers[0].send(ok(request('d', 'b'.repeat(64))));
    await display;
    expect(shown).toEqual(['b'.repeat(64)]);
  });

  it('an export waits beside the evaluations: neither supersedes the other, the edit runs first (CAD21)', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new WorkerKernelPort({ spawn, build, timers: manualTimers() });
    const running = port.evaluate(request('a'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    // While an edit's evaluation runs: an export of the confirmed content, a newer edit, and a
    // newer export. Only the older export is superseded, by the newer export.
    const older = port.exportStep(request('x'));
    const edit = port.evaluate(request('b', 'b'.repeat(64)));
    const exported = port.exportMeshes(request('y'), 0.05);
    expect(await older).toMatchObject({ evaluation: { code: 'superseded' } });
    workers[0].send(ok(request('a')));
    expect(await running).toMatchObject({ status: 'ok' });
    await flush();
    expect(workers[0].inbox.at(-1)).toMatchObject({ requestId: 'b' });
    workers[0].send(ok(request('b', 'b'.repeat(64))));
    expect(await edit).toMatchObject({ status: 'ok' });
    await flush();
    expect(workers[0].inbox.at(-1)).toMatchObject({ requestId: 'y', deflectionMm: 0.05 });
    workers[0].send(ok(request('y')));
    expect(await exported).toMatchObject({ evaluation: { status: 'ok' } });
  });

  it('a STEP export asks for the file and returns it without touching the display', async () => {
    const { workers, spawn } = fakeWorkers();
    const shown: string[] = [];
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers: manualTimers(),
      onMeshes: (hash) => shown.push(hash),
    });
    const exported = port.exportStep(request('s'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    expect(workers[0].inbox.at(-1)).toMatchObject({ type: 'evaluate', requestId: 's', step: true });
    const step = new TextEncoder().encode('ISO-10303-21;');
    workers[0].send({ ...(ok(request('s')) as object), step } as CadWorkerResponse);
    expect(await exported).toMatchObject({ evaluation: { status: 'ok' }, step });
    expect(shown).toEqual([]);
  });

  it("sends the imported features' BRep bytes from the Host and reads STEP as a queued job", async () => {
    const { workers, spawn } = fakeWorkers();
    const brep = new Uint8Array([1, 2, 3]);
    const sha = `sha256:${'b'.repeat(64)}`;
    const timers = manualTimers();
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers,
      assets: (hash) => (hash === sha ? brep : undefined),
    });
    const doc = f02Plate();
    doc.assets = [
      {
        id: 's',
        kind: 'source-step',
        sha256: `sha256:${'a'.repeat(64)}`,
        byteLength: 9,
        mediaType: 'model/step',
      },
      {
        id: 'b',
        kind: 'normalized-brep',
        sha256: sha,
        byteLength: 3,
        mediaType: 'model/x-occt-brep',
      },
    ];
    const evaluated = port.evaluate({ ...request('e'), document: doc });
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    // Only the BRep travels: the source STEP is never evaluated.
    expect(workers[0].inbox.at(-1)).toMatchObject({ type: 'evaluate', assets: { [sha]: brep } });
    workers[0].send(ok(request('e')));
    await evaluated;
    const plain = port.evaluate(request('p'));
    await flush();
    expect(workers[0].inbox.at(-1)).not.toHaveProperty('assets');
    workers[0].send(ok(request('p')));
    await plain;

    const step = new Uint8Array([9]);
    const read = port.importStep('i', step);
    await flush();
    expect(workers[0].inbox.at(-1)).toEqual({ type: 'import-step', requestId: 'i', bytes: step });
    workers[0].send({
      type: 'import-result',
      requestId: 'i',
      result: { status: 'rejected', code: 'step-assembly' },
    });
    expect(await read).toEqual({ status: 'rejected', code: 'step-assembly' });
    // A read past the job limit stops the Worker and says so; the next read starts afresh.
    const slow = port.importStep('j', step);
    await flush();
    timers.fireAll();
    expect(await slow).toMatchObject({ status: 'rejected', code: 'step-import-timeout' });
    expect(workers[0].terminated).toBe(true);
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

  it('names the feature or body the Worker was on when the job times out (#372)', async () => {
    const { workers, spawn } = fakeWorkers();
    const timers = manualTimers();
    const port = new WorkerKernelPort({ spawn, build, timers });
    const slow = port.evaluate(request('slow'));
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[0].send({ type: 'progress', requestId: 'slow', elementId: 'plate-extrude' });
    workers[0].send({ type: 'progress', requestId: 'other', elementId: 'ignored' });
    workers[0].send({ type: 'progress', requestId: 'slow', elementId: 'plate' });
    timers.fireAll();
    expect(await slow).toEqual({
      status: 'error',
      contentHash: 'a'.repeat(64),
      code: 'timeout',
      featureId: 'plate',
      retryable: false,
    });
    // A job stopped before any progress names nothing.
    const quiet = port.evaluate(request('quiet'));
    workers[1].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    timers.fireAll();
    expect(await quiet).not.toHaveProperty('featureId');
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

describe('placement-only edits (CM-3b)', () => {
  const shaft = fixtureVersion('shaft', 'v1', f03Revolve());
  // The plate's own features, with one shaft placed beside them.
  const placed = (x: number): CadDocument =>
    applyCadOperation(f02Plate(), {
      type: 'insertComponents',
      parts: [fixturePart('part-shaft', 'Shaft', shaft)],
      components: [fixtureComponent('c-shaft', 'part-shaft', [x, 0, 0])],
    });
  const moved = (doc: CadDocument, x: number) =>
    applyCadOperation(doc, {
      type: 'setComponentPlacement',
      componentId: 'c-shaft',
      placement: { translation: position(x, 0, 0), rotation: identityQuaternion() },
    });
  const own = (id: string, document: CadDocument): CadEvaluateRequest => ({
    requestId: id,
    generation: 1,
    baseHash: cadContentHash(document),
    candidateHash: cadContentHash(document),
    document,
  });
  async function started() {
    const { workers, spawn } = fakeWorkers();
    const meshes: string[] = [];
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers: manualTimers(),
      onMeshes: (hash) => void meshes.push(hash),
    });
    const first = own('first', placed(50));
    const evaluated = port.evaluate(first);
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[0].send(ok(first));
    expect(await evaluated).toMatchObject({ status: 'ok', contentHash: first.candidateHash });
    return { workers, port, meshes, first };
  }
  const jobs = (w: { inbox: CadWorkerRequest[] }) =>
    w.inbox.filter((m) => m.type === 'evaluate').length;

  it('answers a component move from the kept result: no Worker job, the new hash, its meshes', async () => {
    const { workers, port, meshes, first } = await started();
    const next = own('next', moved(first.document, 80));
    const result = await port.evaluate(next);
    expect(result).toEqual({
      ...(ok(first) as Extract<CadWorkerResponse, { type: 'result' }>).evaluation,
      contentHash: next.candidateHash,
    });
    expect(jobs(workers[0])).toBe(1);
    expect(port.reused).toBe(1);
    expect(meshes).toEqual([first.candidateHash, next.candidateHash]);
    // Back to the first placement: still no job, the first hash again.
    expect(await port.evaluate(own('back', first.document))).toMatchObject({
      contentHash: first.candidateHash,
    });
    expect(jobs(workers[0])).toBe(1);
  });

  it("evaluates an edit of the document's own features, and never reuses for a part or a hash not its own", async () => {
    const { workers, port, first } = await started();
    const edited = applyCadOperation(first.document, {
      type: 'setParameter',
      parameterId: 'W',
      value: 120,
    });
    void port.evaluate(own('edit', edited));
    await flush();
    expect(jobs(workers[0])).toBe(2);
    expect(port.reused).toBe(0);

    const { workers: w2, port: p2, first: f2 } = await started();
    // A placed part's evaluation goes to the Worker even when its own shapes are kept.
    void p2.evaluate(own('part', moved(f2.document, 70)), { part: true });
    // A request whose hash is not the document's (a Host's own hash) is evaluated too.
    void p2.evaluate({ ...own('fake', moved(f2.document, 90)), candidateHash: 'f'.repeat(64) });
    // So is the same own part with other connector references or a coarse mesh.
    void p2.evaluate({ ...own('coarse', moved(f2.document, 95)), coarse: true });
    await flush();
    // None is answered from the kept result: the part runs, the coarse one waits behind it.
    expect(p2.reused).toBe(0);
    expect(w2[0].inbox.filter((m) => m.type === 'evaluate').map((m) => m.requestId)).toEqual([
      'first',
      'part',
    ]);
  });

  it("reuses with an imported shape only while the Host's bytes are still the named ones", async () => {
    const good = new Uint8Array([1, 2, 3]);
    const sha = `sha256:${bytesToHex(sha256(good))}`;
    let held: Uint8Array | undefined = good;
    const { workers, spawn } = fakeWorkers();
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers: manualTimers(),
      assets: (hash) => (hash === sha ? held : undefined),
    });
    // The asset is set after each edit: an edit drops the assets no feature reads.
    const at = (x: number): CadDocument => ({
      ...moved(placed(50), x),
      assets: [
        {
          id: 'b',
          kind: 'normalized-brep',
          sha256: sha,
          byteLength: 3,
          mediaType: 'model/x-occt-brep',
        },
      ],
    });
    const first = own('first', at(50));
    const evaluated = port.evaluate(first);
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    workers[0].send(ok(first));
    await evaluated;
    await port.evaluate(own('same', at(60)));
    expect(port.reused).toBe(1);
    // Other bytes under the same hash, too few bytes, or none: the Worker decides (and refuses).
    for (const [i, bytes] of [
      new Uint8Array([1, 2, 4]),
      new Uint8Array([1, 2]),
      undefined,
    ].entries()) {
      held = bytes;
      void port.evaluate(own(`bad-${i}`, at(70 + i)));
    }
    await flush();
    expect(port.reused).toBe(1);
    expect(jobs(workers[0])).toBe(2);
  });

  it('a reused result supersedes the waiting job, as a newer job would', async () => {
    const { workers, port, first } = await started();
    const edited = applyCadOperation(first.document, {
      type: 'setParameter',
      parameterId: 'W',
      value: 120,
    });
    const running = port.evaluate(own('running', edited));
    const waiting = port.evaluate(own('waiting', moved(edited, 10)));
    const reused = port.evaluate(own('reused', moved(first.document, 30)));
    expect(await waiting).toMatchObject({ status: 'error', code: 'superseded' });
    expect(await reused).toMatchObject({ status: 'ok' });
    await flush();
    workers[0].send(ok(own('running', edited)));
    expect(await running).toMatchObject({ status: 'ok' });
    expect(jobs(workers[0])).toBe(2);
  });
});

describe('split evaluations (CM-4, P3)', () => {
  const continued = (r: CadEvaluateRequest, done: number): CadWorkerResponse => ({
    type: 'continued',
    requestId: r.requestId,
    done,
    total: 10,
  });
  const sent = (w: { inbox: CadWorkerRequest[] }, type: CadWorkerRequest['type']) =>
    w.inbox.filter((m) => m.type === type);
  async function started(options: { totalTimeoutMs?: number } = {}) {
    const { workers, spawn } = fakeWorkers();
    const timers = manualTimers();
    let clock = 0;
    const progress: [string, number, number][] = [];
    const port = new WorkerKernelPort({
      spawn,
      build,
      timers,
      sliceMs: 5000,
      now: () => clock,
      onProgress: ({ requestId }, done, total) => void progress.push([requestId, done, total]),
      ...options,
    });
    const r = request('split');
    const result = port.evaluate(r);
    workers[0].send({ type: 'ready', buildHash: build.buildHash });
    await flush();
    return {
      worker: workers[0],
      port,
      r,
      result,
      timers,
      progress,
      tick: (ms: number) => void (clock += ms),
    };
  }

  it('lets the paused evaluation go on as the next job, each with its own job limit', async () => {
    const { worker, r, result, timers, progress } = await started();
    expect(sent(worker, 'evaluate')[0]).toMatchObject({ slice: { ms: 5000 } });
    worker.send(continued(r, 4));
    worker.send(continued(r, 7));
    expect(sent(worker, 'continue')).toEqual([
      { type: 'continue', requestId: 'split' },
      { type: 'continue', requestId: 'split' },
    ]);
    expect(sent(worker, 'evaluate')).toHaveLength(1);
    expect(progress).toEqual([
      ['split', 4, 10],
      ['split', 7, 10],
    ]);
    // One job limit is running: the earlier jobs' limits were cleared.
    expect(timers.size).toBe(1);
    worker.send(ok(r));
    expect(await result).toMatchObject({ status: 'ok' });
  });

  it('an export or analysis is never split', async () => {
    const { worker, port, r } = await started();
    void port.exportMeshes(request('x'), 0.1);
    worker.send(ok(r));
    await flush();
    expect(sent(worker, 'evaluate').at(-1)).not.toHaveProperty('slice');
  });

  it('stops between jobs on a cancel, on newer waiting work and at the total limit', async () => {
    const cancelled = await started();
    cancelled.port.cancel('split');
    cancelled.worker.send(continued(cancelled.r, 3));
    expect(await cancelled.result).toMatchObject({ status: 'error', code: 'cancelled' });
    expect(sent(cancelled.worker, 'continue')).toHaveLength(0);
    // The Worker was paused, not stuck: it stays, and runs the next job.
    expect(cancelled.worker.terminated).toBe(false);

    const superseded = await started();
    void superseded.port.evaluate(request('newer'));
    superseded.worker.send(continued(superseded.r, 3));
    expect(await superseded.result).toMatchObject({ status: 'error', code: 'superseded' });
    await flush();
    // The newer request itself ends the paused one in the Worker.
    expect(sent(superseded.worker, 'evaluate').map((m) => 'requestId' in m && m.requestId)).toEqual(
      ['split', 'newer'],
    );
    expect(sent(superseded.worker, 'continue')).toHaveLength(0);

    const long = await started({ totalTimeoutMs: 60_000 });
    long.worker.send({ type: 'progress', requestId: 'split', elementId: 'hanger-12' });
    long.worker.send(continued(long.r, 3));
    long.tick(60_000);
    long.worker.send(continued(long.r, 6));
    expect(await long.result).toMatchObject({
      status: 'error',
      code: 'timeout',
      featureId: 'hanger-12',
    });
    expect(sent(long.worker, 'continue')).toHaveLength(1);
    expect(sent(long.worker, 'cancel')).toEqual([{ type: 'cancel', requestId: 'split' }]);
  });

  it("caps each job's limit at what is left of the total limit", async () => {
    const { worker, r, result, timers, tick } = await started({ totalTimeoutMs: 60_000 });
    tick(45_000);
    worker.send(continued(r, 3));
    // The first job had the job limit; the next one only the 15 s left of the total.
    expect(timers.delays).toEqual([30_000, 15_000]);
    timers.fireAll();
    expect(await result).toMatchObject({ status: 'error', code: 'timeout' });
  });
});
