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
