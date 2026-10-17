import { describe, expect, it } from 'vitest';
import { privateVideoRoute, requirePrivateVideoCapability } from './registration';
import { catalogKey, locatorPrefix, publishLocator, readCatalog } from './catalog';
describe('private normal Video admission', () => {
  it('refuses unknown and shared routing and unsupported capability', () => {
    expect(privateVideoRoute('')).toBeUndefined();
    expect(() => privateVideoRoute('?shared=x&kind=video')).toThrow();
    expect(() => privateVideoRoute('?privateEditor=other')).toThrow();
    expect(() => privateVideoRoute('?privateEditor=video-v1-review&shared=x')).toThrow();
    expect(() => requirePrivateVideoCapability('shared')).toThrow();
    expect(() => requirePrivateVideoCapability('template')).toThrow();
    expect(() => requirePrivateVideoCapability('untrusted')).toThrow();
  });
  it('retains the committed locator on storage error or stale publication', () => {
    const values = new Map<string, string>();
    let fail = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
      setItem: (key: string, next: string) => {
        if (fail) throw Error('Quota');
        values.set(key, next);
      },
    };
    const id = '11111111-1111-4111-8111-111111111111';
    const first = {
      id,
      namespace: 'normal-video-' + id,
      name: 'Video project',
      updatedAt: '2026-10-13T00:00:00Z',
    };
    publishLocator(first, undefined, storage);
    const old = storage.getItem(locatorPrefix + id);
    expect(() => publishLocator({ ...first, name: 'stale' }, undefined, storage)).toThrow(
      'conflict',
    );
    expect(storage.getItem(locatorPrefix + id)).toBe(old);
    fail = true;
    expect(() => publishLocator({ ...first, name: 'failed' }, first.namespace, storage)).toThrow(
      'Quota',
    );
    expect(readCatalog(storage)).toEqual([first]);
    values.set(catalogKey, JSON.stringify([{ ...first, name: 'old prototype' }]));
    expect(readCatalog(storage)).toEqual([first]); // New identity key supersedes retained legacy input.
    expect(values.has(catalogKey)).toBe(true);
  });
  it('refuses malformed locators rather than silently replacing retained data', () => {
    for (const text of ['{}', '[{"id":"x"}]', 'not json'])
      expect(() => readCatalog({ getItem: () => text, key: () => null, length: 0 })).toThrow();
  });
});
