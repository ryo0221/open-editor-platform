import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  CadCoordinator,
  cadContentHash,
  f02Plate,
  fixtureKernel,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
  type CadTicket,
} from './index';

/** Kernel whose jobs resolve only when the test says so. */
function fakeKernel() {
  const jobs: {
    request: CadEvaluateRequest;
    resolve: (e: CadEvaluation) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const cancelled: string[] = [];
  const port: CadKernelPort = {
    evaluate: (request) =>
      new Promise((resolve, reject) => jobs.push({ request, resolve, reject })),
    cancel: (id) => void cancelled.push(id),
  };
  const ok = (request: CadEvaluateRequest, overrides: Partial<CadEvaluation> = {}): CadEvaluation =>
    ({
      status: 'ok',
      contentHash: request.candidateHash,
      buildHash: fixtureKernel.buildHash,
      geometryDigest: `digest:${request.candidateHash.slice(0, 8)}`,
      bodies: {},
      ...overrides,
    }) as CadEvaluation;
  const finish = async (index = jobs.length - 1, overrides: Partial<CadEvaluation> = {}) => {
    const job = jobs[index];
    job.resolve(ok(job.request, overrides));
    await Promise.resolve();
  };
  return { port, jobs, cancelled, finish };
}
function setup() {
  const session = new EditorSession(f02Plate());
  const kernel = fakeKernel();
  const auth = { canEdit: true, generation: 1 };
  const coordinator = new CadCoordinator({
    session,
    kernel: kernel.port,
    canEdit: () => auth.canEdit,
    permissionGeneration: () => auth.generation,
  });
  const widen = (value: number) =>
    coordinator.prepare({ type: 'setParameter', parameterId: 'W', value });
  /** Prepare and let the kernel answer. */
  const ready = async (value: number) => {
    const pending = widen(value);
    await kernel.finish();
    const result = await pending;
    if (result.status !== 'ready') throw new Error(`prepare ${result.status}`);
    return result.ticket;
  };
  return { session, kernel, auth, coordinator, widen, ready };
}
const width = (c: CadCoordinator) => c.content.parameters.find((p) => p.id === 'W')!.value;

describe('CadCoordinator prepare / apply (CAD03)', () => {
  it('prepare leaves live content and history unchanged; apply is one edit', async () => {
    const { session, coordinator, ready } = setup();
    const before = cadContentHash(session.content);
    const ticket = await ready(100);
    expect(cadContentHash(session.content)).toBe(before);
    expect(session.canUndo).toBe(false);
    const applied = coordinator.apply(ticket);
    expect(applied.status).toBe('applied');
    expect(width(coordinator)).toBe(100);
    expect(coordinator.geometryState).toBe('ready');
    session.undo();
    expect(cadContentHash(session.content)).toBe(before);
    expect(session.canUndo).toBe(false);
  });

  it('re-applying the same ticket returns the same receipt; after Undo it is outdated', async () => {
    const { coordinator, ready } = setup();
    const ticket = await ready(100);
    const first = coordinator.apply(ticket);
    const again = coordinator.apply(ticket);
    expect(again.status).toBe('already-applied');
    expect(again.status !== 'rejected' && first.status !== 'rejected' && again.receipt).toEqual(
      first.status !== 'rejected' && first.receipt,
    );
    coordinator.undo();
    expect(coordinator.apply(ticket)).toEqual({
      status: 'rejected',
      code: 'ticket-result-outdated',
    });
    expect(width(coordinator)).toBe(80);
    coordinator.redo();
    // Same bytes as the applied result, but a different revision: still outdated.
    expect(width(coordinator)).toBe(100);
    expect(coordinator.apply(ticket)).toEqual({
      status: 'rejected',
      code: 'ticket-result-outdated',
    });
  });

  it('a returned receipt cannot alter the recorded ticket result', async () => {
    const { coordinator, ready } = setup();
    const ticket = await ready(100);
    const first = coordinator.apply(ticket);
    if (first.status === 'rejected') throw new Error(first.code);
    expect(Object.isFrozen(first.receipt.revision)).toBe(true);
    expect(() => {
      (first.receipt as { revision: unknown }).revision = { forged: true };
    }).toThrow();
    expect(coordinator.apply(ticket).status).toBe('already-applied');
  });

  it('Cancel and rejected operations create no history', async () => {
    const { session, coordinator, ready } = setup();
    const ticket = await ready(100);
    coordinator.cancel(ticket);
    expect(coordinator.apply(ticket)).toEqual({ status: 'rejected', code: 'cancelled' });
    expect(
      await coordinator.prepare({ type: 'setParameter', parameterId: 'W', value: -1 }),
    ).toMatchObject({
      status: 'rejected',
      code: expect.stringContaining('dimension-range'),
    });
    expect(session.canUndo).toBe(false);
  });
});

describe('CadCoordinator stale results (CAD04)', () => {
  it('a newer prepare supersedes an in-flight one and cancels its job', async () => {
    const { kernel, widen } = setup();
    const first = widen(90);
    const second = widen(100);
    expect(kernel.cancelled).toEqual([kernel.jobs[0].request.requestId]);
    await kernel.finish(0);
    expect(await first).toEqual({ status: 'stale' });
    await kernel.finish(1);
    expect((await second).status).toBe('ready');
  });

  it('rejects a ticket after another edit, Undo, permission change or read-only', async () => {
    const { coordinator, auth, ready } = setup();
    const old = await ready(90);
    coordinator.apply(await ready(100));
    expect(coordinator.apply(old)).toEqual({ status: 'rejected', code: 'stale' });

    const beforeUndo = await ready(120);
    void coordinator.undo();
    expect(coordinator.apply(beforeUndo)).toEqual({ status: 'rejected', code: 'stale' });

    const revoked = await ready(130);
    auth.generation++;
    expect(coordinator.apply(revoked)).toEqual({ status: 'rejected', code: 'permission-changed' });
    const readonly = await ready(140);
    auth.canEdit = false;
    expect(coordinator.apply(readonly)).toEqual({ status: 'rejected', code: 'permission-denied' });
    expect(width(coordinator)).toBe(80);
  });

  it('ignores results for another candidate and forged tickets', async () => {
    const { kernel, coordinator, widen } = setup();
    const pending = widen(100);
    await kernel.finish(0, { contentHash: 'f'.repeat(64) });
    expect(await pending).toEqual({ status: 'stale' });
    expect(coordinator.apply(Object.freeze({}) as unknown as CadTicket)).toEqual({
      status: 'rejected',
      code: 'invalid-ticket',
    });
  });

  it('snapshots the operation before the kernel answers', async () => {
    const { kernel, coordinator } = setup();
    const op = { type: 'setParameter' as const, parameterId: 'W', value: 100 };
    const pending = coordinator.prepare(op);
    op.value = 120;
    await kernel.finish();
    const result = await pending;
    if (result.status !== 'ready') throw new Error(result.status);
    expect(coordinator.apply(result.ticket).status).toBe('applied');
    expect(width(coordinator)).toBe(100);
  });

  it('refuses Undo and Redo without edit authority', async () => {
    const { auth, session, coordinator, ready } = setup();
    coordinator.apply(await ready(100));
    auth.canEdit = false;
    expect(() => coordinator.undo()).toThrow('permission-denied');
    expect(width(coordinator)).toBe(100);
    auth.canEdit = true;
    void coordinator.undo();
    auth.canEdit = false;
    expect(() => coordinator.redo()).toThrow('permission-denied');
    expect(session.canRedo).toBe(true);
  });

  it('a rejected newer input still supersedes older work and tickets', async () => {
    const { kernel, coordinator, widen, ready } = setup();
    const issued = await ready(90);
    const pending = widen(100);
    expect((await widen(-1)).status).toBe('rejected');
    expect(kernel.cancelled).toContain(kernel.jobs[1].request.requestId);
    await kernel.finish(1);
    expect(await pending).toEqual({ status: 'stale' });
    expect(coordinator.apply(issued)).toEqual({ status: 'rejected', code: 'stale' });
    expect(width(coordinator)).toBe(80);
  });

  it('rejects an evaluation from a different kernel build', async () => {
    const { kernel, widen } = setup();
    const pending = widen(100);
    await kernel.finish(0, { buildHash: `sha256:${'1'.repeat(64)}` });
    expect(await pending).toEqual({ status: 'rejected', code: 'kernel-build-mismatch' });
  });
});

describe('CadCoordinator geometry state and recovery', () => {
  it('kernel failure yields geometry-error without touching live content; refresh retries', async () => {
    const { session, kernel, coordinator, widen } = setup();
    const pending = widen(100);
    kernel.jobs[0].reject(new Error('worker crashed'));
    expect(await pending).toMatchObject({
      status: 'geometry-error',
      evaluation: { code: 'kernel-unavailable' },
    });
    expect(session.canUndo).toBe(false);
    const refreshing = coordinator.refresh();
    expect(coordinator.geometryState).toBe('reevaluating');
    kernel.jobs[1].reject(new Error('still down'));
    expect(await refreshing).toBe('geometry-error');
    const retry = coordinator.refresh();
    await kernel.finish(2);
    expect(await retry).toBe('ready');
  });

  it('an explicit retry re-evaluates a cached failure; a plain refresh keeps it', async () => {
    const { coordinator, kernel } = setup();
    const first = coordinator.refresh();
    kernel.jobs[0].resolve({
      status: 'error',
      contentHash: kernel.jobs[0].request.candidateHash,
      code: 'timeout',
      retryable: false,
    });
    expect(await first).toBe('geometry-error');
    expect(await coordinator.refresh()).toBe('geometry-error');
    expect(kernel.jobs).toHaveLength(1);
    const retry = coordinator.refresh({ retry: true });
    expect(coordinator.geometryState).toBe('reevaluating');
    await kernel.finish(1);
    expect(await retry).toBe('ready');
  });

  it('refresh records a synchronously throwing kernel as recoverable', async () => {
    const { coordinator, kernel } = setup();
    kernel.port.evaluate = () => {
      throw new Error('no worker');
    };
    expect(await coordinator.refresh()).toBe('geometry-error');
    expect(coordinator.evaluation).toBeUndefined();
  });

  it('refresh never presents geometry from another kernel build', async () => {
    const { kernel, coordinator } = setup();
    const refreshing = coordinator.refresh();
    await kernel.finish(0, { buildHash: `sha256:${'1'.repeat(64)}` });
    expect(await refreshing).toBe('geometry-error');
    expect(coordinator.evaluation).toMatchObject({ code: 'kernel-build-mismatch' });
  });

  it('refresh ignores an answer for other content, whatever its build', async () => {
    const { kernel, coordinator } = setup();
    const refreshing = coordinator.refresh();
    await kernel.finish(0, { contentHash: 'f'.repeat(64), buildHash: `sha256:${'1'.repeat(64)}` });
    expect(await refreshing).toBe('reevaluating');
    expect(coordinator.evaluation).toBeUndefined();
    const retry = coordinator.refresh();
    expect(kernel.jobs).toHaveLength(2);
    await kernel.finish(1);
    expect(await retry).toBe('ready');
  });

  it('a superseded refresh never overwrites the newer answer', async () => {
    const { kernel, coordinator } = setup();
    const older = coordinator.refresh();
    const newer = coordinator.refresh();
    await kernel.finish(1);
    expect(await newer).toBe('ready');
    kernel.jobs[0].resolve({
      status: 'error',
      contentHash: kernel.jobs[0].request.candidateHash,
      code: 'invalid-solid',
      retryable: false,
    });
    await older;
    expect(coordinator.geometryState).toBe('ready');
  });

  it('a pending refresh never overwrites a newer evaluation of the same content', async () => {
    const { coordinator, kernel, ready } = setup();
    const stale = coordinator.refresh();
    coordinator.apply(await ready(100));
    coordinator.apply(await ready(80));
    expect(coordinator.geometryState).toBe('ready');
    kernel.jobs[0].resolve({
      status: 'error',
      contentHash: kernel.jobs[0].request.candidateHash,
      code: 'timeout',
      retryable: false,
    });
    expect(await stale).toBe('ready');
    expect(coordinator.evaluation?.status).toBe('ok');
  });

  it('retained evaluations cannot be changed through returned results', async () => {
    const { kernel, coordinator, widen } = setup();
    const pending = widen(100);
    const answer = kernel.jobs[0];
    await kernel.finish(0);
    const result = await pending;
    if (result.status !== 'ready') throw new Error(result.status);
    expect(Object.isFrozen(result.evaluation)).toBe(true);
    expect(() => {
      (result.evaluation as { contentHash: string }).contentHash = 'x';
    }).toThrow();
    const refreshing = coordinator.refresh();
    await kernel.finish(1);
    await refreshing;
    expect(Object.isFrozen(coordinator.evaluation)).toBe(true);
    expect(answer.request.candidateHash).toBe(result.evaluation.contentHash);
  });

  it('Undo/Redo reuse cached evaluations and re-evaluate only on a miss (CAD05)', async () => {
    const { kernel, coordinator, ready } = setup();
    const initial = coordinator.refresh();
    await kernel.finish(0);
    await initial;
    coordinator.apply(await ready(100));
    const jobs = kernel.jobs.length;
    expect(await coordinator.undo()).toBe('ready');
    expect(await coordinator.redo()).toBe('ready');
    expect(kernel.jobs).toHaveLength(jobs);
    // Evict by applying more candidates than the cache keeps, then Undo to the evicted state.
    coordinator.apply(await ready(110));
    coordinator.apply(await ready(120));
    coordinator.apply(await ready(130));
    const before = kernel.jobs.length;
    coordinator.undo();
    coordinator.undo();
    // Only the evicted state (W=100) asks the kernel again.
    const miss = coordinator.undo();
    expect(width(coordinator)).toBe(100);
    expect(kernel.jobs.length).toBe(before + 1);
    expect(coordinator.cachedContentHashes()).not.toContain(cadContentHash(coordinator.content));
    expect(coordinator.geometryState).toBe('reevaluating');
    await kernel.finish();
    expect(await miss).toBe('ready');
    expect(coordinator.cachedContentHashes()).toContain(cadContentHash(coordinator.content));
    expect(coordinator.cachedContentHashes().length).toBeLessThanOrEqual(3);
  });
});
