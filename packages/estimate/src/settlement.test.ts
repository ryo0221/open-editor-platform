import { afterEach, expect, it, vi } from 'vitest';
import * as core from '@editor-platform/estimate-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { estimateFixture } from '../../estimate-core/src/fixtures';
import { EstimateController, type EstimatePort } from './host';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const session = new EditorSession(estimateFixture());
  let generation = 0;
  const port: EstimatePort = {
    read: () => session.content,
    revision: () => canonicalJson(session.revision),
    generation: () => generation,
    canEdit: () => true,
    canRead: () => true,
    canExport: () => true,
    inputsReady: () => true,
    flush() {},
    execute: (c) => {
      session.execute(c);
    },
  };
  const requests: {
    worker: Worker;
    message: { id: string; document: core.EstimateDocument; scenarioId: string | null };
  }[] = [];
  const controller = new EstimateController(port, () => {
    const worker = {
      onmessage: null,
      onerror: null,
      terminate: vi.fn(),
      postMessage(message: (typeof requests)[number]['message']) {
        requests.push({ worker: worker as unknown as Worker, message });
      },
    };
    return worker as unknown as Worker;
  });
  return {
    controller,
    session,
    port,
    requests,
    revoke: () => {
      generation++;
    },
    async complete(index = requests.length - 1, corrupt = false) {
      const { worker, message } = requests[index];
      const result = await core.calculateEstimate(message.document, message.id, message.scenarioId);
      if (corrupt) result.result.total = '0';
      worker.onmessage?.({ data: { id: message.id, result } } as MessageEvent);
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('waits beyond worker termination through real verification and synchronous Host apply', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  const verify = core.verifyEstimate;
  vi.spyOn(core, 'verifyEstimate').mockImplementation(async (...args) => {
    entered.resolve();
    await gate.promise;
    return verify(...args);
  });
  const run = f.controller.run();
  const wait = f.controller.settlement.wait();
  let settled = false;
  void wait.then(() => {
    settled = true;
  });
  await f.complete();
  await entered.promise;
  expect(f.requests[0].worker.terminate).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  expect(f.controller.settlement.read().status).toBe('pending');
  expect(f.session.content.calculations).toHaveLength(0);
  gate.resolve();
  await run;
  const result = await wait;
  expect(result.status).toBe('accepted');
  expect(f.controller.settlement.isCurrent(result)).toBe(true);
  expect(f.session.content.calculations[0].result.total).toBe('1350');
  f.session.undo();
  expect(f.session.content.calculations).toHaveLength(0);
});
it('preview never mutates or becomes accepted through waiting; only explicit apply does', async () => {
  const f = fixture(),
    preview = f.controller.prepare();
  const wait = f.controller.settlement.wait();
  await f.complete();
  const candidate = await preview;
  expect((await wait).status).toBe('candidate');
  expect(f.controller.settlement.isCurrent(await wait)).toBe(true);
  expect(f.session.content.calculations).toHaveLength(0);
  f.controller.apply(candidate);
  expect((await f.controller.settlement.wait()).status).toBe('accepted');
});
it.each(['cancel', 'close', 'rerun'] as const)(
  'releases waiters on %s during verification and rejects late adoption',
  async (action) => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    const verify = core.verifyEstimate;
    vi.spyOn(core, 'verifyEstimate').mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return verify(...args);
    });
    const run = f.controller.run().catch((e: unknown) => e);
    const wait = f.controller.settlement.wait();
    await f.complete();
    await entered.promise;
    let rerun: Promise<unknown> | undefined;
    if (action === 'cancel') f.controller.cancel();
    if (action === 'close') f.controller.close();
    if (action === 'rerun') rerun = f.controller.run().catch((e: unknown) => e);
    expect((await wait).status).toBe(
      { cancel: 'cancelled', close: 'closed', rerun: 'superseded' }[action],
    );
    gate.resolve();
    expect(await run).toBeInstanceOf(Error);
    expect(f.session.content.calculations).toHaveLength(0);
    if (rerun) {
      await f.complete();
      await rerun;
      expect(f.session.content.calculations).toHaveLength(1);
    }
  },
);
it.each(['revision', 'generation', 'validation', 'apply'] as const)(
  'rejects %s failure without authorizing old content',
  async (failure) => {
    const f = fixture();
    const run = f.controller.run().catch((e: unknown) => e);
    const wait = f.controller.settlement.wait();
    if (failure === 'revision')
      f.session.execute(
        core.replaceEstimate(
          f.session.content,
          { ...f.session.content, title: 'Keep edit' },
          f.port,
        ),
      );
    if (failure === 'generation') f.revoke();
    if (failure === 'apply')
      vi.spyOn(f.port, 'execute').mockImplementation(() => {
        throw Error('Host refused');
      });
    await f.complete(undefined, failure === 'validation');
    expect(await run).toBeInstanceOf(Error);
    const result = await wait;
    expect(result.status).toBe('failed');
    expect(result).toHaveProperty('error');
    expect(f.controller.settlement.isCurrent(result)).toBe(true);
    expect(f.session.content.calculations).toHaveLength(0);
  },
);
it('waiter timeout is not success, does not cancel work, and permits a new wait', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    run = f.controller.run();
  const short = f.controller.settlement.wait({ timeoutMs: 10 });
  const other = f.controller.settlement.wait();
  await vi.advanceTimersByTimeAsync(10);
  expect((await short).status).toBe('timeout');
  expect(f.controller.settlement.read().status).toBe('pending');
  expect(f.controller.settlement.isCurrent(await short)).toBe(false);
  await f.complete();
  await run;
  expect((await other).status).toBe('accepted');
  expect(vi.getTimerCount()).toBe(0);
});
it('worker timeout and worker errors persist as failures until an explicit new operation', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const run = f.controller.run().catch((e: unknown) => e);
  const wait = f.controller.settlement.wait();
  await vi.advanceTimersByTimeAsync(30000);
  expect(await run).toMatchObject({ code: 'calculation-timeout' });
  expect(await wait).toMatchObject({ status: 'failed', error: { code: 'calculation-timeout' } });
  expect((await f.controller.settlement.wait()).status).toBe('failed');
  const retry = f.controller.run().catch((e: unknown) => e);
  f.requests[1].worker.onerror?.({ message: 'worker failed' } as ErrorEvent);
  expect(await retry).toBeInstanceOf(Error);
  expect((await f.controller.settlement.wait()).status).toBe('failed');
  expect(vi.getTimerCount()).toBe(0);
});
it('rechecks supersession after resolution, isolates instances and invalidates old receipts', async () => {
  const a = fixture(),
    b = fixture();
  const idle = await a.controller.settlement.wait();
  expect(a.controller.settlement.isCurrent(idle)).toBe(true);
  expect(b.controller.settlement.isCurrent(idle)).toBe(false);
  const run = a.controller.run().catch((e: unknown) => e);
  expect(a.controller.settlement.isCurrent(idle)).toBe(false);
  const wait = a.controller.settlement.wait();
  a.controller.cancel();
  const next = a.controller.run().catch((e: unknown) => e);
  expect((await wait).status).toBe('superseded');
  a.controller.close();
  await run;
  await next;
  expect((await a.controller.settlement.wait()).status).toBe('closed');
  await expect(a.controller.run()).rejects.toMatchObject({ code: 'closed' });
  expect((await b.controller.settlement.wait()).status).toBe('idle');
});

it.each(['run', 'prepare'] as const)(
  'a refused %s preserves the in-flight operation at flush and guard boundaries',
  async (method) => {
    const f = fixture();
    const first = f.controller.run().catch((error: unknown) => error);
    const snapshot = f.controller.settlement.read();
    const waiting = f.controller.settlement.wait();
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    const flush = vi.spyOn(f.port, 'flush').mockImplementation(() => {
      throw Error('Keep input');
    });
    await expect(f.controller[method]()).rejects.toThrow('Keep input');
    flush.mockRestore();
    const guard = vi.spyOn(f.port, 'inputsReady').mockReturnValue(false);
    await expect(f.controller[method]()).rejects.toThrow('input-pending');
    guard.mockRestore();
    expect(f.controller.settlement.read()).toBe(snapshot);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].worker.terminate).not.toHaveBeenCalled();
    expect(done).toBe(false);
    await f.complete();
    expect(await first).toBeUndefined();
    expect((await waiting).status).toBe('accepted');
    expect(f.session.content.calculations).toHaveLength(1);
  },
);
it.each(['run', 'prepare'] as const)(
  'a refused idle %s is observed as failure without changing input',
  async (method) => {
    const f = fixture();
    const before = canonicalJson(f.session.content);
    vi.spyOn(f.port, 'flush').mockImplementation(() => {
      throw Error('Keep input');
    });
    await expect(f.controller[method]()).rejects.toThrow('Keep input');
    expect((await f.controller.settlement.wait()).status).toBe('failed');
    expect(f.requests).toHaveLength(0);
    expect(canonicalJson(f.session.content)).toBe(before);
  },
);

it('rejecting an old candidate during a newer run must not poison its eventual accepted settlement', async () => {
  const f = fixture();
  const preview = f.controller.prepare();
  await f.complete();
  const oldCandidate = await preview;
  const run = f.controller.run();
  const original = f.controller.settlement.read();
  const waiting = f.controller.settlement.wait();
  expect(() => f.controller.apply(oldCandidate)).toThrow('stale-result');
  const afterRefusal = f.controller.settlement.read();
  await f.complete();
  await run;
  // Complete the real calculation first: the bug is accepted native content paired
  // with failed settlement, not a failed calculation or a cancelled worker.
  expect(f.session.content.calculations).toHaveLength(1);
  expect(f.session.content.calculations[0].id).toBe(f.requests[1].message.id);
  expect(afterRefusal).toBe(original);
  expect((await waiting).status).toBe('accepted');
  expect((await f.controller.settlement.wait()).status).toBe('accepted');
});
it.each(['unverified', 'flush', 'guard'] as const)(
  'apply %s refusal preserves the pending run and its waiters',
  async (reason) => {
    const f = fixture();
    const preview = f.controller.prepare();
    await f.complete();
    const candidate = await preview;
    const run = f.controller.run();
    const pending = f.controller.settlement.read();
    const waiting = f.controller.settlement.wait();
    if (reason === 'unverified') candidate.document.title = 'tampered';
    const restore =
      reason === 'flush'
        ? vi.spyOn(f.port, 'flush').mockImplementation(() => {
            throw Error('Keep input');
          })
        : reason === 'guard'
          ? vi.spyOn(f.port, 'inputsReady').mockReturnValue(false)
          : undefined;
    expect(() => f.controller.apply(candidate)).toThrow(
      reason === 'unverified'
        ? 'unverified-candidate'
        : reason === 'flush'
          ? 'Keep input'
          : 'input-pending',
    );
    restore?.mockRestore();
    const afterRefusal = f.controller.settlement.read();
    expect(f.requests[1].worker.terminate).not.toHaveBeenCalled();
    await f.complete();
    await run;
    expect(afterRefusal).toBe(pending);
    expect((await waiting).status).toBe('accepted');
  },
);
it('an actual apply execution failure is still failed and cannot authorize a save', async () => {
  const f = fixture();
  const preview = f.controller.prepare();
  await f.complete();
  const candidate = await preview;
  vi.spyOn(f.port, 'execute').mockImplementation(() => {
    throw Error('Host refused');
  });
  expect(() => f.controller.apply(candidate)).toThrow('Host refused');
  expect((await f.controller.settlement.wait()).status).toBe('failed');
  expect(f.session.content.calculations).toHaveLength(0);
});
