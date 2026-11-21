import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  canonicalJson,
  commitVersion,
  contentHash,
  createArtifact,
  deserializeArtifact,
  deepFreeze,
  IndexedDBStorage,
  MemoryStorage,
  type OutOfLineParts,
  serializeArtifact,
  updateDraft,
  type StorageAdapter,
} from './index';
describe('artifact lifecycle', () => {
  it('freezes children of shallow-frozen input and shared branches of new immutable trees', () => {
    const existing = deepFreeze({ rows: [{ value: 1 }] });
    const next = Object.freeze({ existing, rows: [{ value: 2 }] });
    deepFreeze(next);
    expect(() => next.rows[0].value++).toThrow();
    expect(() => existing.rows[0].value++).toThrow();
    expect(next.existing).toBe(existing);
  });
  it('commits an immutable snapshot independently of the draft', async () => {
    const source = { items: ['one'] };
    let a = createArtifact('test', 'Example', source);
    source.items.push('outside');
    a = await commitVersion(a, 'actor', 'initial');
    expect(a.versions[0].content.items).toEqual(['one']);
    expect(Object.isFrozen(a.versions[0].content.items)).toBe(true);
    expect(() => a.versions[0].content.items.push('bad')).toThrow();
    a.draft.content.items.push('two');
    expect(a.versions[0].content.items).toEqual(['one']);
    const b = await commitVersion(a, 'actor', 'second');
    expect(b.versions[1].parentVersionId).toBe(b.versions[0].versionId);
    expect(b.versions[1].contentHash).not.toBe(b.versions[0].contentHash);
  });
  it('hashes canonical data consistently and detects changes', async () => {
    expect(await contentHash({ b: 2, a: 1 })).toBe(await contentHash({ a: 1, b: 2 }));
    expect(await contentHash({ a: 2 })).not.toBe(await contentHash({ a: 1 }));
    expect(await contentHash('hello')).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    // Pinned before the allocation optimization: lexical numeric keys, UTF-8,
    // lone surrogates, escaped text and the established nonfinite/undefined rules.
    expect(
      await contentHash({
        10: 'ten',
        2: 'two',
        z: [undefined, NaN, Infinity, -0],
        a: '日本語😀\ud800\n"\\',
        removed: undefined,
        nested: { y: false, x: null },
      }),
    ).toBe('f2b0737e87665645d4eb22522e80c80f21114bb758311f30c3e85ad89a05dcb1');
  });
  it('updates only the draft and round trips schema versions', async () => {
    const a = await commitVersion(createArtifact('test', 'Example', { text: 'first' }), null, null);
    const b = updateDraft(a, { text: 'second' });
    expect(b.versions[0].content.text).toBe('first');
    expect(deserializeArtifact(serializeArtifact(b))).toEqual(b);
  });
  it('rejects invalid envelopes and unsupported schemas', () => {
    expect(() => deserializeArtifact('{"schemaVersion":99}')).toThrow();
    expect(() => deserializeArtifact('null')).toThrow();
  });
  it('rejects repeated saved version IDs even when each content hash is valid', async () => {
    const first = await commitVersion(
      createArtifact('test', 'Example', { text: 'first' }),
      null,
      null,
    );
    const second = await commitVersion(updateDraft(first, { text: 'second' }), null, null);
    for (const version of second.versions) {
      const duplicate = { ...version, versionId: first.versions[0].versionId };
      expect(() =>
        deserializeArtifact(
          serializeArtifact({ ...first, versions: [...first.versions, duplicate] }),
        ),
      ).toThrow('Duplicate artifact version ID');
    }
  });
});
for (const kind of ['memory', 'indexeddb'])
  describe(`${kind} storage contract`, () => {
    it('lists, retrieves, replaces and removes isolated values', async () => {
      const adapter: StorageAdapter<{ id: string; items: string[] }> =
        kind === 'memory'
          ? new MemoryStorage()
          : new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      const a = { id: 'one', items: ['initial'] };
      await adapter.put(a);
      a.items.push('mutated');
      expect((await adapter.get('one'))?.items).toEqual(['initial']);
      const loaded = (await adapter.get('one'))!;
      loaded.items.push('changed');
      expect((await adapter.get('one'))?.items).toEqual(['initial']);
      await adapter.put(loaded);
      expect(await adapter.list()).toHaveLength(1);
      expect((await adapter.get('one'))?.items).toEqual(['initial', 'changed']);
      await adapter.remove('one');
      expect(await adapter.get('one')).toBeUndefined();
      expect(await adapter.list()).toEqual([]);
      if (adapter instanceof IndexedDBStorage) await adapter.close();
    });
    it('stores several values together, or none when one cannot be stored', async () => {
      const adapter: StorageAdapter<{ id: string; items: unknown[] }> =
        kind === 'memory'
          ? new MemoryStorage()
          : new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await adapter.putAll!([
        { id: 'one', items: ['a'] },
        { id: 'two', items: ['b'] },
      ]);
      expect((await adapter.list()).map((v) => v.id).sort()).toEqual(['one', 'two']);
      // A function cannot be cloned, so the whole batch is refused.
      await expect(
        adapter.putAll!([
          { id: 'one', items: ['changed'] },
          { id: 'three', items: [() => {}] },
        ]),
      ).rejects.toThrow();
      expect((await adapter.get('one'))?.items).toEqual(['a']);
      expect(await adapter.get('three')).toBeUndefined();
      if (adapter instanceof IndexedDBStorage) await adapter.close();
    });
  });

describe('IndexedDB storage with parts kept apart (#812, ST-218)', () => {
  // TS-1448
  type Rec = { id: string; blobs: { key: string; data: string }[] };
  const parts: OutOfLineParts<Rec> = {
    split(value) {
      const out = new Map<string, unknown>();
      const blobs = value.blobs.map((b) => {
        if (b.data.length < 4) return b;
        out.set(b.key, b.data);
        return { ...b, data: '' };
      });
      return { stub: { ...value, blobs }, parts: out };
    },
    keys: (stub) => stub.blobs.filter((b) => b.data === '').map((b) => b.key),
    join: (stub, found) => ({
      ...stub,
      blobs: stub.blobs.map((b) =>
        b.data === '' && typeof found.get(b.key) === 'string'
          ? { ...b, data: found.get(b.key) as string }
          : b,
      ),
    }),
  };
  const rawParts = (name: string) =>
    new Promise<[string, string][]>((resolve, reject) => {
      const open = indexedDB.open(`${name}-parts`);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const req = open.result.transaction('parts').objectStore('parts').getAllKeys();
        req.onsuccess = () => {
          resolve(req.result as [string, string][]);
          open.result.close();
        };
      };
    });
  const rawRecord = (name: string, id: string) =>
    new Promise<Rec | undefined>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const req = open.result.transaction('artifacts').objectStore('artifacts').get(id);
        req.onsuccess = () => {
          resolve(req.result as Rec | undefined);
          open.result.close();
        };
      };
    });

  it('stores large parts as their own values, reads them back, and drops the ones no longer named', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const adapter = new IndexedDBStorage<Rec>(name, parts);
    const one: Rec = {
      id: 'one',
      blobs: [
        { key: 'a', data: 'xy' },
        { key: 'b', data: 'large-b' },
        { key: 'c', data: 'large-c' },
      ],
    };
    await adapter.put(one);
    // The record itself holds only the small one; the database of records stays at version 1.
    expect((await rawRecord(name, 'one'))!.blobs.map((b) => b.data)).toEqual(['xy', '', '']);
    expect((await rawParts(name)).sort()).toEqual([
      ['one', 'b'],
      ['one', 'c'],
    ]);
    expect(await adapter.get('one')).toEqual(one);
    expect(await adapter.list()).toEqual([one]);
    // A later write that no longer names c removes it; b stays.
    await adapter.put({ ...one, blobs: one.blobs.slice(0, 2) });
    expect(await rawParts(name)).toEqual([['one', 'b']]);
    // Several records at once, and putIfAbsent keeps the stored record.
    await adapter.putAll([{ id: 'two', blobs: [{ key: 'd', data: 'large-d' }] }]);
    expect(
      await adapter.putIfAbsent({ id: 'two', blobs: [{ key: 'e', data: 'large-e' }] }),
    ).toEqual({ id: 'two', blobs: [{ key: 'd', data: 'large-d' }] });
    expect((await rawParts(name)).sort()).toEqual([
      ['one', 'b'],
      ['two', 'd'],
    ]);
    await adapter.remove('one');
    expect(await rawParts(name)).toEqual([['two', 'd']]);
    expect((await adapter.list()).map((r) => r.id)).toEqual(['two']);
    await adapter.close();
  });

  it('runs each write under one lock across tabs, and reads under a shared one', async () => {
    const name = `test-${crypto.randomUUID()}`;
    // A minimal Web Locks stand-in: one holder at a time, in request order.
    const calls: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (lock: string, options: { mode: string }, run: () => Promise<unknown>) => {
        calls.push(`${lock}:${options.mode}`);
        const next = chain.then(run);
        chain = next.catch(() => undefined);
        return next;
      },
    };
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
    try {
      // Two tabs write the same record with different large parts at the same time.
      const a = new IndexedDBStorage<Rec>(name, parts);
      const b = new IndexedDBStorage<Rec>(name, parts);
      await Promise.all([
        a.put({ id: 'one', blobs: [{ key: 'a', data: 'large-a' }] }),
        b.put({ id: 'one', blobs: [{ key: 'b', data: 'large-b' }] }),
      ]);
      // The record stored last keeps its part; the other write's part is gone with its stub.
      expect(await a.get('one')).toEqual({ id: 'one', blobs: [{ key: 'b', data: 'large-b' }] });
      expect(await rawParts(name)).toEqual([['one', 'b']]);
      expect(calls).toEqual([
        `artifact-parts:${name}:exclusive`,
        `artifact-parts:${name}:exclusive`,
        `artifact-parts:${name}:shared`,
      ]);
      await a.close();
      await b.close();
    } finally {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });

  it('opens a database written before the parts existed, and leaves a missing part empty', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const old = new IndexedDBStorage<Rec>(name);
    await old.put({ id: 'old', blobs: [{ key: 'z', data: 'large-z' }] });
    await old.close();
    const adapter = new IndexedDBStorage<Rec>(name, parts);
    expect(await adapter.get('old')).toEqual({ id: 'old', blobs: [{ key: 'z', data: 'large-z' }] });
    await adapter.put({ id: 'lost', blobs: [{ key: 'q', data: 'large-q' }] });
    await adapter.close();
    // Without its parts database, the stub reads back with the part left empty.
    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase(`${name}-parts`);
      del.onsuccess = () => resolve();
    });
    const again = new IndexedDBStorage<Rec>(name, parts);
    expect(await again.get('lost')).toEqual({ id: 'lost', blobs: [{ key: 'q', data: '' }] });
    await again.close();
  });
});
