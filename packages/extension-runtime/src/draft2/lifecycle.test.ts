import { it, expect, vi } from 'vitest';
import { api, harness, turns } from './harness';
import { deferred, toyDefinition } from './reference';
import { contentHash } from '@editor-platform/artifact-core';
it('D01 gates close before reentrant abort/install/open/uninstall', async () => {
  const h = harness();
  const lifecycle = api(h.handle, 'lifecycle');
  const observed: string[] = [];
  lifecycle.signal.addEventListener('abort', () => {
    for (const attempt of [
      () => h.handle.context.basic.read(),
      () => h.open(),
      () => h.registry.uninstall('toy'),
      () =>
        h.registry.install(toyDefinition({ ...h.definition.manifest, id: 'other' }), {
          trust: 'trusted',
          verifiedPin: { ...h.definition.manifest, id: 'other' },
        }),
    ]) {
      try {
        attempt();
      } catch (error) {
        observed.push((error as Error).message);
      }
    }
  });
  h.handle.revoke('replace');
  expect(observed).toEqual([
    'ScopeRevoked',
    'RegistryTransition',
    'RegistryTransition',
    'RegistryTransition',
  ]);
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('drained');
});
it('D02/D03/D05 deferred disposal remains owned until later drain, invoked once', async () => {
  const h = harness();
  const gate = deferred<void>();
  const dispose = vi.fn(() => gate.promise);
  api(h.handle, 'lifecycle').registerDisposable('slow', dispose);
  h.handle.revoke('host-close');
  const first = await h.handle.drain({ deadlineMs: 0 });
  expect(first).toMatchObject({ state: 'incomplete', pending: ['extension:slow'] });
  const later = h.handle.drain({ deadlineMs: 10 });
  gate.resolve();
  expect((await later).state).toBe('drained');
  h.handle.revoke('host-close');
  await h.handle.drain({ deadlineMs: 10 });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(first.state).toBe('incomplete');
  expect(() => h.handle.drain({ deadlineMs: NaN })).toThrow('Deadline');
});
it('D04 failed disposable remains failed while other disposer runs', async () => {
  const h = harness();
  const good = vi.fn();
  const bad = vi.fn(async () => {
    throw new Error('release failed');
  });
  api(h.handle, 'lifecycle').registerDisposable('bad', bad);
  api(h.handle, 'lifecycle').registerDisposable('good', good);
  h.handle.revoke('uninstall');
  await turns();
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    pending: [],
    failed: [{ resourceId: 'extension:bad', reason: 'Error: release failed' }],
  });
  expect(good).toHaveBeenCalledTimes(1);
  expect(bad).toHaveBeenCalledTimes(1);
});
it('D06 allocation resolving after revoke is released once; pending quota stays owned', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new Uint8Array([1, 2, 3]));
  const gate = deferred<void>();
  h.resources.openGate = gate.promise;
  const opening = api(h.handle, 'resources')
    .open(identity, h.resources.bounds)
    .catch((error) => error);
  await turns();
  h.handle.revoke('host-close');
  expect((await opening).code).toBe('ScopeRevoked');
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('incomplete');
  expect(h.resources.active).toBe(1);
  gate.resolve();
  await turns();
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('drained');
  expect(h.resources.releases).toBe(1);
  expect(h.resources.active).toBe(0);
});
it('D07 duplicate or late registration refused', () => {
  const h = harness();
  const lifecycle = api(h.handle, 'lifecycle');
  lifecycle.registerDisposable('same', () => {});
  expect(() => lifecycle.registerDisposable('same', () => {})).toThrow('OwnershipAdmission');
  h.handle.revoke('host-close');
  expect(() => lifecycle.registerDisposable('late', () => {})).toThrow('ScopeRevoked');
});
it('R01 exact byte copy and tightened visible bounds', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new Uint8Array([1, 2, 3]));
  const lease = await api(h.handle, 'resources').open(identity, {
    maxReadBytes: 100,
    maxTotalBytes: 100,
    maxReads: 100,
    maxPendingReads: 100,
  });
  expect(lease.bounds).toEqual(h.resources.bounds);
  const bytes = await lease.read(0, 2);
  bytes[0] = 99;
  expect(await lease.read(0, 2)).toEqual(new Uint8Array([1, 2]));
  await lease.release({ deadlineMs: 0 });
  await turns();
  expect((await lease.release({ deadlineMs: 0 })).state).toBe('drained');
});
it.each(['ref', 'hash', 'length'] as const)(
  'R02 catalog %s mismatch opens no lease',
  async (field) => {
    const h = harness();
    const identity = await h.resources.add('bytes', new Uint8Array([1, 2, 3]));
    const mismatched = {
      ...identity,
      ...(field === 'ref'
        ? { ref: 'missing' }
        : field === 'hash'
          ? { sha256: 'b'.repeat(64) }
          : { byteLength: identity.byteLength + 1 }),
    };
    await expect(api(h.handle, 'resources').open(mismatched, h.resources.bounds)).rejects.toThrow(
      'CatalogMismatch',
    );
    await turns();
    expect(h.resources.active).toBe(0);
  },
);
it('R02 invalid range/short bytes rejected; no fallback', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new Uint8Array([1, 2, 3]));
  const lease = await api(h.handle, 'resources').open(identity, h.resources.bounds);
  await expect(lease.read(-1, 1)).rejects.toThrow('ResourceRange');
  await expect(lease.read(2, 2)).rejects.toThrow('ResourceRange');
  h.resources.shortRead = true;
  await expect(lease.read(0, 2)).rejects.toThrow('ShortRead');
  void lease.release({ deadlineMs: 0 });
});
it('R03 pending/count/total/per-read limits reserve aborted failed reads without refund', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new Uint8Array(8));
  const gate = deferred<void>();
  h.resources.readGate = gate.promise;
  const lease = await api(h.handle, 'resources').open(identity, {
    maxReadBytes: 3,
    maxTotalBytes: 4,
    maxReads: 2,
    maxPendingReads: 1,
  });
  await expect(lease.read(0, 4)).rejects.toThrow('ResourceBudget');
  const caller = new AbortController();
  const reading = lease.read(0, 2, caller.signal).catch((error) => error);
  await turns();
  await expect(lease.read(0, 1)).rejects.toThrow('ResourceBudget');
  caller.abort();
  gate.resolve();
  expect((await reading).code).toBe('Aborted');
  await lease.read(0, 2);
  await expect(lease.read(0, 1)).rejects.toThrow('ResourceBudget');
  void lease.release({ deadlineMs: 0 });
});
it('R04/R05 pending read/release remain owned, late bytes denied, original retained', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new Uint8Array([1, 2, 3]));
  const read = deferred<void>();
  const release = deferred<void>();
  h.resources.readGate = read.promise;
  h.resources.releaseGate = release.promise;
  const lease = await api(h.handle, 'resources').open(identity, h.resources.bounds);
  const reading = lease.read(0, 2).catch((error) => error);
  await turns();
  h.handle.revoke('host-close');
  expect((await reading).code).toBe('ScopeRevoked');
  expect((await lease.release({ deadlineMs: 0 })).state).toBe('incomplete');
  expect(h.resources.releases).toBe(0);
  read.resolve();
  await turns();
  expect(h.resources.releases).toBe(1);
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('incomplete');
  release.resolve();
  await turns();
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('drained');
  await lease.release({ deadlineMs: 0 });
  expect(h.resources.releases).toBe(1);
  expect(h.resources.catalog.has('bytes')).toBe(true);
});
it('R06 native canonical hash does not substitute for raw byte identity', async () => {
  const h = harness();
  const identity = await h.resources.add('bytes', new TextEncoder().encode('{ "value": 1 }'));
  const native = await contentHash({ value: 1 });
  expect(native).not.toBe(identity.sha256);
  await expect(
    api(h.handle, 'resources').open({ ...identity, sha256: native }, h.resources.bounds),
  ).rejects.toThrow('CatalogMismatch');
});
it('D01/D04 unsubscribe reentry is denied before abort and throwing unsubscribe cannot skip teardown', async () => {
  const h = harness();
  const observed: string[] = [];
  const unsub = vi.fn(() => {
    for (const action of [
      () => next.context.basic.read(),
      () =>
        api(next, 'edit').execute({
          type: 'forbidden',
          label: 'forbidden',
          apply: () => ({ value: 99 }),
        }),
    ]) {
      try {
        action();
      } catch (error) {
        observed.push((error as Error).message);
      }
    }
    throw new Error('unsubscribe failed');
  });
  const opened = h.installed.open({ ...h.binding, subscribePermissions: () => unsub });
  if (opened.state !== 'opened') throw new Error();
  const next = opened.handle;
  api(next, 'inputs').register('dirty', {
    label: 'dirty',
    read: () => ({ dirty: true }),
    prepare: () => () => {},
    focus: () => {},
  });
  const cleanup = vi.fn();
  const lifecycle = api(next, 'lifecycle');
  lifecycle.registerDisposable('cleanup', cleanup);
  expect(() => next.revoke('host-close')).not.toThrow();
  expect(observed).toEqual(['ScopeRevoked', 'ScopeRevoked']);
  expect(lifecycle.signal.aborted).toBe(true);
  expect(h.binding.session.content).toEqual({ value: 0 });
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  await turns();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(await next.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    failed: [{ resourceId: 'host:teardown', reason: 'Error: unsubscribe failed' }],
  });
  next.revoke('host-close');
  expect(unsub).toHaveBeenCalledTimes(1);
});
it('D01 synchronous permission subscription revocation cleans the late unsubscribe function', () => {
  const h = harness();
  const stop = vi.fn();
  expect(() =>
    h.installed.open({
      ...h.binding,
      subscribePermissions: (listener) => {
        h.binding.setGrants([]);
        listener();
        return stop;
      },
    }),
  ).toThrow('ScopeRevoked');
  expect(stop).toHaveBeenCalledTimes(1);
});
