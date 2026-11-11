import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { counterExtension } from '@editor-platform/extension-sample';
import {
  describeExtensionPackage,
  verifyExtensionPackage,
  type ExtensionPackage,
} from '@editor-platform/extension-runtime/package';
import {
  discardInterruptedInstalls,
  PackageRetentionError,
  removeRetainedPackage,
  repairRetainedPackage,
  restoreRetainedPackage,
  retainVerifiedPackage,
} from '@editor-platform/extension-runtime/package-store';
import { openIndexedDbPackageStorage, PACKAGE_STORAGE_VERSION } from './package-storage';

let n = 0;
const fresh = () => `package-storage-test-${++n}`;
function bundle(version = '0.0.1', text = 'export const value = 1;'): ExtensionPackage {
  const { packageHash: _h, ...manifest } = counterExtension(`sha256:${'0'.repeat(64)}`).manifest;
  return {
    manifest: { ...manifest, version },
    entry: 'counter.js',
    files: [{ path: 'counter.js', bytes: new TextEncoder().encode(text) }],
  };
}
async function pinned(...inputs: ExtensionPackage[]) {
  const pins = new Map<string, string>();
  for (const input of inputs)
    pins.set(input.manifest.version, (await describeExtensionPackage(input)).hash);
  return (id: string, version: string) =>
    id === 'example.counter' ? pins.get(version) : undefined;
}
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e) => (e instanceof PackageRetentionError ? e.code : String(e)),
  );

it('retains across a reopen of the database, as after a browser restart', async () => {
  const name = fresh(),
    lookup = await pinned(bundle());
  const first = await openIndexedDbPackageStorage(name);
  expect(await retainVerifiedPackage(first, await verifyExtensionPackage(bundle(), lookup))).toBe(
    'retained',
  );
  first.close();
  const second = await openIndexedDbPackageStorage(name);
  const restored = await restoreRetainedPackage(second, 'example.counter', '0.0.1', lookup);
  expect(new TextDecoder().decode(restored.readFile('counter.js'))).toBe('export const value = 1;');
  expect(await second.staged()).toEqual([]);
  second.close();
});

it('activates atomically and refuses another package for a retained id@version', async () => {
  const store = await openIndexedDbPackageStorage(fresh());
  const a = bundle(),
    b = bundle('0.0.1', 'export const value = 2;');
  const lookupA = await pinned(a);
  await retainVerifiedPackage(store, await verifyExtensionPackage(a, lookupA));
  // Bypass the protocol's pre-check to exercise the adapter's own refusal inside activate.
  const token = await store.stage({
    ...b,
    packageHash: (await describeExtensionPackage(b)).hash,
  });
  await expect(store.activate(token)).rejects.toThrow('Another package');
  expect(await store.staged()).toEqual([token]);
  expect((await store.read('example.counter', '0.0.1'))!.files[0].bytes).toEqual(a.files[0].bytes);
  await expect(store.activate('missing-token')).rejects.toThrow('Unknown staged');
  store.close();
});

it('discards an interrupted install after a restart and never exposes it', async () => {
  const name = fresh(),
    lookup = await pinned(bundle());
  const first = await openIndexedDbPackageStorage(name);
  const verified = await verifyExtensionPackage(bundle(), lookup);
  await first.stage({
    manifest: bundle().manifest,
    entry: 'counter.js',
    files: bundle().files,
    packageHash: verified.manifest.packageHash,
  });
  first.close();
  const second = await openIndexedDbPackageStorage(name);
  expect(await code(restoreRetainedPackage(second, 'example.counter', '0.0.1', lookup))).toBe(
    'missing',
  );
  expect(await discardInterruptedInstalls(second)).toBe(1);
  expect(await second.staged()).toEqual([]);
  expect(await retainVerifiedPackage(second, verified)).toBe('retained');
  second.close();
});

it('reports damaged stored bytes as corrupt', async () => {
  const name = fresh(),
    lookup = await pinned(bundle());
  const store = await openIndexedDbPackageStorage(name);
  await retainVerifiedPackage(store, await verifyExtensionPackage(bundle(), lookup));
  store.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, PACKAGE_STORAGE_VERSION);
    request.onsuccess = () => {
      const tx = request.result.transaction('active', 'readwrite');
      const records = tx.objectStore('active');
      const get = records.get('example.counter@0.0.1');
      get.onsuccess = () => {
        get.result.files[0].bytes[0] ^= 1;
        records.put(get.result, 'example.counter@0.0.1');
      };
      tx.oncomplete = () => {
        request.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
  const reopened = await openIndexedDbPackageStorage(name);
  expect(await code(restoreRetainedPackage(reopened, 'example.counter', '0.0.1', lookup))).toBe(
    'corrupt',
  );
  // Explicit repair swaps in verified bytes atomically against the damaged record.
  const verified = await verifyExtensionPackage(bundle(), lookup);
  await expect(reopened.activate('missing-token', { replacing: 'x' })).rejects.toThrow(
    'Unknown staged',
  );
  expect(await repairRetainedPackage(reopened, verified)).toBe('repaired');
  reopened.close();
  const after = await openIndexedDbPackageStorage(name);
  await restoreRetainedPackage(after, 'example.counter', '0.0.1', lookup);
  expect(await after.staged()).toEqual([]);
  // The compare-and-swap refuses a record other than the one named.
  const token = await after.stage({ ...bundle(), packageHash: verified.manifest.packageHash });
  await expect(after.activate(token, { replacing: 'sha256:other' })).rejects.toThrow(
    'Retained package changed',
  );
  after.close();
});

it('upgrades a version 1 database without losing its retained package', async () => {
  const name = fresh(),
    lookup = await pinned(bundle());
  // Version 1 layout, as step 2 shipped it, holding one retained record.
  const verified = await verifyExtensionPackage(bundle(), lookup);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('active');
      request.result.createObjectStore('staged');
    };
    request.onsuccess = () => {
      const tx = request.result.transaction('active', 'readwrite');
      const { packageHash, ...manifest } = verified.manifest;
      tx.objectStore('active').put(
        {
          manifest,
          entry: verified.entry,
          files: verified.paths.map((path) => ({ path, bytes: verified.readFile(path) })),
          packageHash,
        },
        'example.counter@0.0.1',
      );
      tx.oncomplete = () => {
        request.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
  const store = await openIndexedDbPackageStorage(name);
  await restoreRetainedPackage(store, 'example.counter', '0.0.1', lookup);
  expect(await store.removed('example.counter', '0.0.1')).toBeUndefined();
  store.close();
});

it('removes only unreferenced packages and keeps the removal across a reopen', async () => {
  const name = fresh(),
    a = bundle(),
    b = bundle('0.0.1', 'export const value = 2;');
  const lookupA = await pinned(a);
  const first = await openIndexedDbPackageStorage(name);
  const verified = await verifyExtensionPackage(a, lookupA);
  await retainVerifiedPackage(first, verified);
  expect(
    await code(removeRetainedPackage(first, 'example.counter', '0.0.1', () => ['saved version'])),
  ).toBe('referenced');
  expect(await removeRetainedPackage(first, 'example.counter', '0.0.1', () => [])).toBe('removed');
  first.close();
  const second = await openIndexedDbPackageStorage(name);
  expect(await second.read('example.counter', '0.0.1')).toBeUndefined();
  expect(await second.removed('example.counter', '0.0.1')).toBe(verified.manifest.packageHash);
  // Another build under the removed id@version is refused by the protocol and by the adapter.
  const lookupB = await pinned(b);
  const other = await verifyExtensionPackage(b, lookupB);
  expect(await code(retainVerifiedPackage(second, other))).toBe('conflict');
  const token = await second.stage({
    ...b,
    packageHash: other.manifest.packageHash,
  });
  await expect(second.activate(token)).rejects.toThrow('was removed');
  // Removal names the exact hash; the adapter checks it inside its transaction.
  await expect(
    second.remove('example.counter', '0.0.1', other.manifest.packageHash),
  ).rejects.toThrow('Retained package changed');
  expect(await retainVerifiedPackage(second, verified)).toBe('retained');
  second.close();
});
