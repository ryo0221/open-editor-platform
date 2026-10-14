import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ReferenceRecoveryStore, downloadRecoveryEntries } from './recovery-store';

class TabStorage implements Storage {
  private values = new Map<string, string>();
  writes: string[] = [];
  fail = false;
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.fail) throw new DOMException('Simulated quota failure', 'QuotaExceededError');
    this.writes.push(key);
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
type Checkpoint = { schema: number; rows: { id: string; value: number }[]; pending?: string[] };
const checkpoint = (value: number, pending: string[] = []): Checkpoint => ({
  schema: 1,
  rows: [{ id: 'stable-row', value }],
  pending,
});
const key = 'ep-shared-pending:artifact:A';

describe('reference Host recovery persistence', () => {
  it('uses asynchronous structured storage for routine writes and isolates tab namespaces', async () => {
    const tab = new TabStorage(),
      other = new TabStorage();
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    expect(await store.load()).toBeUndefined();
    const value = checkpoint(1);
    const written = store.write(value);
    value.rows[0].value = 999;
    await written;
    expect(tab.writes).toEqual(['ep-recovery-namespace']);
    expect(tab.getItem(key)).toBeNull();
    store.close();
    const resumed = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    expect(await resumed.load()).toEqual(checkpoint(1));
    const isolated = await ReferenceRecoveryStore.open<Checkpoint>(key, other);
    expect(await isolated.load()).toBeUndefined();
    await isolated.write(checkpoint(33));
    expect((await downloadRecoveryEntries(tab)).checkpoints[key]).toEqual(checkpoint(1));
    resumed.close();
    isolated.close();
  });

  it('keeps the latest synchronous pending checkpoint when an older transaction finishes after detach', async () => {
    const tab = new TabStorage();
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    await store.load();
    const older = store.write(checkpoint(1));
    store.retainSync(checkpoint(2, ['new-edit', 'pending-undo']));
    store.close();
    await older;
    const resumed = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    expect(await resumed.load()).toEqual(checkpoint(2, ['new-edit', 'pending-undo']));
    expect((await downloadRecoveryEntries(tab)).checkpoints[key]).toEqual(
      checkpoint(2, ['new-edit', 'pending-undo']),
    );
    await resumed.write(checkpoint(3));
    expect(tab.getItem(key)).toBeNull();
    expect(await resumed.load()).toEqual(checkpoint(3));
    resumed.close();
  });

  it('aborts a failed async write without deleting its backup and permits a successful retry', async () => {
    const tab = new TabStorage();
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    await store.load();
    store.retainSync(checkpoint(1, ['retained']));
    await expect(
      store.write({ ...checkpoint(2), uncloneable: () => {} } as Checkpoint),
    ).rejects.toThrow();
    expect(await store.load()).toEqual(checkpoint(1, ['retained']));
    expect(tab.getItem(key)).not.toBeNull();
    await store.write(checkpoint(2));
    expect(tab.getItem(key)).toBeNull();
    expect(await store.load()).toEqual(checkpoint(2));
    store.close();
  });

  it('propagates synchronous storage failure and leaves the previous retained state intact', async () => {
    const tab = new TabStorage();
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    await store.load();
    store.retainSync(checkpoint(1));
    tab.fail = true;
    expect(() => store.retainSync(checkpoint(2))).toThrow('Simulated quota failure');
    expect(await store.load()).toEqual(checkpoint(1));
    tab.fail = false;
    store.retainSync(checkpoint(2));
    expect(await store.load()).toEqual(checkpoint(2));
    store.close();
  });

  it('reads legacy plain checkpoints, then migrates on successful async persistence', async () => {
    const tab = new TabStorage();
    tab.setItem(key, JSON.stringify(checkpoint(1, ['legacy-op'])));
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    expect(await store.load()).toEqual(checkpoint(1, ['legacy-op']));
    await store.write(checkpoint(2));
    expect(tab.getItem(key)).toBeNull();
    expect((await downloadRecoveryEntries(tab)).checkpoints[key]).toEqual(checkpoint(2));
    store.close();
  });

  it('keeps unreadable backup bytes available for recovery instead of silently ignoring them', async () => {
    const tab = new TabStorage();
    tab.setItem(key, '{invalid retained bytes');
    const store = await ReferenceRecoveryStore.open<Checkpoint>(key, tab);
    await expect(store.load()).rejects.toThrow();
    expect((await downloadRecoveryEntries(tab)).checkpoints[key]).toEqual({
      invalidBackup: '{invalid retained bytes',
    });
    store.close();
  });
});
