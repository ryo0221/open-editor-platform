import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { TotalCapacity, type TotalCapacityPolicy } from './capacity';
const policy: TotalCapacityPolicy = {
  totalBytes: 1000,
  managementBytes: 20,
  maxEntries: 100,
  maxDepth: 5,
  maxReservations: 10,
};
const scratch = 'a-scratch/preparation-' + '1'.repeat(36);
const candidate = 'a/candidate-' + '2'.repeat(36);
let files: Map<string, number>;
let opened: TotalCapacity[];
function directory(prefix = ''): unknown {
  return {
    async *entries() {
      const names = new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split('/')[0]),
      );
      for (const name of names) {
        const path = prefix + name;
        if (files.has(path))
          yield [name, { kind: 'file', getFile: async () => ({ size: files.get(path) }) }];
        else yield [name, { ...(directory(path + '/') as object), kind: 'directory' }];
      }
    },
  };
}
async function open(p = policy) {
  const c = await TotalCapacity.open(p);
  opened.push(c);
  return c;
}
beforeEach(() => {
  files = new Map();
  opened = [];
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => directory() },
    locks: {
      request(name: string, work: () => Promise<unknown>) {
        const result = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
        locks.set(name, result);
        return result;
      },
    },
  });
});
afterEach(() => {
  for (const c of opened) c.close();
  vi.unstubAllGlobals();
});
describe('Total capacity private contract', () => {
  it('CAP01 accounts old namespaces plus both prospective copies, refusing without writing files', async () => {
    files.set('old-host/archive', 500);
    const c = await open();
    await expect(c.reserve('a:one', scratch, 241)).rejects.toThrow('Total capacity');
    expect((await c.inspect()).reservations).toEqual([]);
    expect(files.size).toBe(1);
    await c.reserve('a:one', scratch, 240);
    expect(await c.inspect()).toMatchObject({
      observedBytes: 500,
      reservedAdditionalBytes: 480,
      accountedBytes: 1000,
      availableBytes: 0,
    });
  });
  it('CAP02 concurrent owners cannot oversubscribe; close/reopen preserves unknown reservations', async () => {
    const a = await open(),
      b = await open();
    const results = await Promise.allSettled([
      a.reserve('a:one', scratch, 300),
      b.reserve('b:two', scratch.replace('a-scratch', 'b-scratch'), 300),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    a.close();
    b.close();
    const reopened = await open();
    expect((await reopened.inspect()).reservedAdditionalBytes).toBe(600);
    await expect(
      reopened.reserve('c:three', scratch.replace('a-scratch', 'c-scratch'), 200),
    ).rejects.toThrow('Total capacity');
  });
  it('CAP03 materialized bytes replace reservations, settlement retains archive occupancy', async () => {
    const c = await open();
    await c.reserve('a:one', scratch, 200);
    files.set(scratch, 200);
    await c.candidate('a:one', scratch, candidate);
    files.set(candidate, 100);
    expect(await c.inspect()).toMatchObject({
      observedBytes: 300,
      reservedAdditionalBytes: 100,
      accountedBytes: 420,
    });
    await expect(c.settle('a:one', scratch, 'committed')).rejects.toThrow('Scratch');
    files.delete(scratch); // Simulates existing verified scratch cleanup, not new GC.
    await expect(c.settle('a:one', scratch, 'committed')).rejects.toThrow('settlement');
    files.set(candidate, 200);
    await c.settle('a:one', scratch, 'committed');
    expect(await c.inspect()).toMatchObject({
      observedBytes: 200,
      reservedAdditionalBytes: 0,
      accountedBytes: 220,
    });
    expect(files.get(candidate)).toBe(200);
  });
  it('CAP04 refuses no-write release while candidate exists and permits fenced absence', async () => {
    const c = await open();
    await c.reserve('a:one', scratch, 200);
    await c.candidate('a:one', scratch, candidate);
    files.set(candidate, 10);
    await expect(c.settle('a:one', scratch, 'no-write')).rejects.toThrow('settlement');
    expect((await c.inspect()).reservations).toHaveLength(1);
    files.delete(candidate); // Existing journal abandon has proved this absence.
    await c.settle('a:one', scratch, 'no-write');
    expect((await c.inspect()).reservations).toHaveLength(0);
  });
  it('CAP05 policy mismatch, invalid budgets, scan overflow and unbounded files fail closed', async () => {
    const c = await open({ ...policy, maxEntries: 2, maxDepth: 1 });
    await expect(open()).rejects.toThrow('mismatch');
    await expect(open({ ...policy, totalBytes: NaN })).rejects.toThrow('policy');
    files.set('a/b/c', 1);
    await expect(c.inspect()).rejects.toThrow('depth');
    files.clear();
    files.set('a', 1);
    files.set('b', 1);
    files.set('c', 1);
    await expect(c.inspect()).rejects.toThrow('entries');
  });
  it('CAP06 never credits an existing file or reuses reservation IDs', async () => {
    const c = await open();
    files.set(candidate, 100);
    await c.reserve('a:one', scratch, 200);
    await expect(c.candidate('a:one', scratch, candidate)).rejects.toThrow('identity');
    await expect(c.reserve('a:one', scratch, 200)).rejects.toThrow('identity');
    files.set(scratch, 201);
    await expect(c.inspect()).rejects.toThrow('bound');
  });
  it('CAP07 duplicate owner cannot attach a candidate or settle another preparation before file creation', async () => {
    const a = await open(),
      b = await open();
    const foreign = scratch.replace('1'.repeat(36), '4'.repeat(36));
    await a.reserve('a:one', scratch, 300);
    await expect(b.reserve('a:one', foreign, 300)).rejects.toThrow('identity');
    await expect(b.candidate('a:one', foreign, candidate)).rejects.toThrow('owner');
    await expect(b.settle('a:one', foreign, 'no-write')).rejects.toThrow('owner');
    expect(await b.inspect()).toMatchObject({ observedBytes: 0, reservedAdditionalBytes: 600 });
    await expect(
      b.reserve('b:next', 'b-scratch/preparation-' + '5'.repeat(36), 200),
    ).rejects.toThrow('Total capacity');
    a.close();
    const reopened = await open();
    await reopened.settle('a:one', scratch, 'no-write');
    expect((await reopened.inspect()).reservations).toHaveLength(0);
  });
});
