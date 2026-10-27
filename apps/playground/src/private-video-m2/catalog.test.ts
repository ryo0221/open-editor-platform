import { describe, expect, it } from 'vitest';
import { readCatalog, publishLocator, locatorPrefix as v1Prefix } from '../private-video/catalog';
import { privateVideo, privateVideoRoute, privateVideoUrl } from '../private-video/registration';
import {
  readM2Catalog,
  publishM2Locator,
  publishM2LocatorLocked,
  locatorPrefix,
  requireCurrentVideoLocator,
} from './catalog';
import {
  privateVideoM2,
  privateVideoM2Route,
  privateVideoM2Url,
  requirePrivateVideoM2Capability,
} from './registration';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
function memory() {
  const rows = new Map<string, string>();
  let fail = false;
  return {
    rows,
    set fail(value: boolean) {
      fail = value;
    },
    get length() {
      return rows.size;
    },
    key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw new Error('Injected publication failure');
      rows.set(key, value);
    },
  };
}
const row = (id = a) => ({
  id,
  namespace: `normal-video-m2-${id}`,
  name: 'M2',
  updatedAt: '2026-10-13T12:00:00Z',
});
describe('private M2 preparation without runtime registration', () => {
  it('keeps v1 defaults and fails closed across distinct private routes', () => {
    expect(privateVideoM2.label).toBe('Video');
    expect(privateVideo.id).toBe('video-v1-review');
    expect(privateVideoRoute(privateVideoUrl(a).slice(1))).toEqual({ entryId: a });
    expect(privateVideoM2Route(privateVideoM2Url(a).slice(1))).toEqual({ entryId: a });
    expect(() => privateVideoRoute(privateVideoM2Url(a).slice(1))).toThrow();
    expect(() => privateVideoM2Route(privateVideoUrl(a).slice(1))).toThrow();
    expect(privateVideoM2Route('')).toBeUndefined();
    for (const suffix of ['&shared=', '&project=bad', `&privateEditor=${privateVideoM2.id}`])
      expect(() => privateVideoM2Route(privateVideoM2Url(a).slice(1) + suffix)).toThrow();
    expect(() => privateVideoM2Url('-'.repeat(36))).toThrow();
    for (const capability of ['shared', 'execute', 'network', 'migrate'])
      expect(() => requirePrivateVideoM2Capability(capability)).toThrow();
    requirePrivateVideoM2Capability('save');
  });
  it('preserves exact v1 bytes and relative order across failed publication and same-locator retry', () => {
    const storage = memory();
    for (const id of [b, a])
      publishLocator({ ...row(id), namespace: `normal-video-${id}` }, undefined, storage);
    const before = [...storage.rows];
    storage.fail = true;
    expect(() => publishM2Locator(row(), undefined, storage)).toThrow('publication failure');
    expect([...storage.rows]).toEqual(before);
    storage.fail = false;
    publishM2Locator(row(), undefined, storage);
    publishM2Locator({ ...row(), updatedAt: '2026-10-13T13:00:00Z' }, row().namespace, storage);
    expect(readM2Catalog(storage)).toHaveLength(1);
    expect(readCatalog(storage).map((v) => v.id)).toEqual([b, a]);
    expect([...storage.rows].filter(([key]) => key.startsWith(v1Prefix))).toEqual(before);
    expect(() => publishM2Locator(row(), undefined, storage)).toThrow('conflict');
    expect(() => publishM2Locator(row(), `normal-video-m2-${b}`, storage)).toThrow('conflict');
  });
  it('rejects foreign schema, namespace, identity and oversized locator without writing', () => {
    for (const bad of [
      { ...row(), namespace: `normal-video-${a}` },
      { ...row(), history: [] },
      { ...row(), id: '-'.repeat(36) },
      { ...row(), name: 'x'.repeat(101) },
      { ...row(), updatedAt: 'bad' },
    ]) {
      const storage = memory();
      expect(() => publishM2Locator(bad, undefined, storage)).toThrow();
      expect(storage.length).toBe(0);
    }
    const storage = memory();
    storage.rows.set(locatorPrefix + b, JSON.stringify(row()));
    expect(() => readM2Catalog(storage)).toThrow('identity');
    storage.rows.set(locatorPrefix + b, ' '.repeat(1025));
    expect(() => readM2Catalog(storage)).toThrow('capacity');
  });
  it('serializes publication under its own lock and propagates write errors', async () => {
    const storage = memory();
    const requests: string[] = [];
    const locks = {
      request: async (name: string, callback: () => unknown) => {
        requests.push(name);
        return callback();
      },
    } as unknown as Pick<LockManager, 'request'>;
    storage.fail = true;
    await expect(publishM2LocatorLocked(row(), undefined, storage, locks)).rejects.toThrow(
      'publication failure',
    );
    storage.fail = false;
    await publishM2LocatorLocked(row(), undefined, storage, locks);
    expect(requests).toEqual(['normal-video-m2-catalog@0', 'normal-video-m2-catalog@0']);
    expect(readM2Catalog(storage)).toEqual([row()]);
  });
});

it('retains a Host-only exact source locator while refusing untrusted fields', () => {
  const storage = memory();
  const origin = {
    namespace: `normal-video-${b}`,
    operationId: 'retained-source',
    archiveHash: 'a'.repeat(64),
  };
  publishM2Locator({ ...row(), origin }, undefined, storage);
  expect(readM2Catalog(storage)[0].origin).toEqual(origin);
  for (const invalid of [
    { ...origin, namespace: 'https://elsewhere' },
    { ...origin, archiveHash: 'bad' },
    { ...origin, permission: 'admin' },
    { ...origin, operationId: '../escape' },
  ])
    expect(() =>
      publishM2Locator({ ...row(), origin: invalid }, row().namespace, storage),
    ).toThrow();
  expect(readM2Catalog(storage)[0].origin).toEqual(origin);
});

it('keeps explicit v3 locators separate from unchanged v2 and migration locators', () => {
  const storage = memory();
  publishM2Locator(row(), undefined, storage);
  publishM2Locator({ ...row(b), nativeSchema: 'v3' }, undefined, storage);
  expect(readM2Catalog(storage)).toEqual([row(), { ...row(b), nativeSchema: 'v3' }]);
  expect(privateVideoM2Route(privateVideoM2Url().slice(1))).toEqual({ entryId: undefined });
  expect(privateVideoM2.schema).toBe('video-core-prototype-v3');
  for (const query of [
    '&nativeSchema=v4',
    '&nativeSchema=v3&nativeSchema=v3',
    '&nativeSchema=v3&project=' + a,
  ])
    expect(() => privateVideoM2Route('?privateEditor=video-v2-review' + query)).toThrow();
  expect(() =>
    publishM2Locator(
      {
        ...row(b),
        nativeSchema: 'v3',
        origin: { namespace: 'normal-video-' + a, operationId: 'old', archiveHash: 'a'.repeat(64) },
      },
      row(b).namespace,
      storage,
    ),
  ).toThrow();
  expect(readM2Catalog(storage)[1].nativeSchema).toBe('v3');
});

it('rejects legacy locators before opening storage without rewriting them', () => {
  const entry = row();
  const before = JSON.stringify(entry);
  expect(() => requireCurrentVideoLocator(entry)).toThrow('stored data is unchanged');
  expect(JSON.stringify(entry)).toBe(before);
  expect(() => requireCurrentVideoLocator({ ...entry, nativeSchema: 'v3' })).not.toThrow();
  expect(() => requireCurrentVideoLocator(undefined)).not.toThrow();
});
