/**
 * This reference Host's durable PackageStorageAdapter (#500 E2), on IndexedDB.
 *
 * Host-owned, as the retention protocol expects: the shared steps live in
 * `@editor-platform/extension-runtime/package-store`. Object stores: `active` (key `id@version`),
 * `staged` (key token) and, since version 2, `removed` (key `id@version` → packageHash of a
 * removed package; no bytes). `activate` and `remove` each run in a single readwrite transaction,
 * so a crash or quota failure leaves either the old or the new state, never a partial one. A
 * transaction that fails rejects and changes nothing.
 */
import type {
  PackageStorageAdapter,
  RetainedPackage,
} from '@editor-platform/extension-runtime/package-store';

const ACTIVE = 'active',
  STAGED = 'staged',
  REMOVED = 'removed';
export const PACKAGE_STORAGE_VERSION = 2;
const key = (id: string, version: string) => `${id}@${version}`;

function open(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, PACKAGE_STORAGE_VERSION);
    request.onupgradeneeded = (event) => {
      // Additive upgrades only: existing active and staged records are kept as they are.
      if (event.oldVersion < 1) {
        request.result.createObjectStore(ACTIVE);
        request.result.createObjectStore(STAGED);
      }
      if (event.oldVersion < 2) request.result.createObjectStore(REMOVED);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close another tab to finish the storage upgrade'));
  });
}

export async function openIndexedDbPackageStorage(
  name: string,
): Promise<PackageStorageAdapter & { close(): void }> {
  const db = await open(name);
  /** Runs `body` in one transaction and resolves with its value only after the commit. */
  function transact<R>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction, done: (value: R) => void, fail: (error: Error) => void) => void,
  ) {
    return new Promise<R>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: R;
      let failure: Error | undefined;
      tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
      tx.onerror = () => reject(tx.error ?? new Error('Package storage failed'));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Package storage aborted'));
      body(
        tx,
        (value) => (result = value),
        (error) => {
          failure = error;
          tx.abort();
        },
      );
    });
  }
  const get = (store: string, id: string) =>
    transact<RetainedPackage | undefined>([store], 'readonly', (tx, done) => {
      const request = tx.objectStore(store).get(id);
      request.onsuccess = () => done(request.result as RetainedPackage | undefined);
    });
  return {
    close: () => db.close(),
    stage: (record) =>
      transact<string>([STAGED], 'readwrite', (tx, done) => {
        const token = crypto.randomUUID();
        tx.objectStore(STAGED).add(structuredClone(record), token);
        done(token);
      }),
    readStaged: (token) => get(STAGED, token),
    activate: (token, options) =>
      transact<void>([STAGED, ACTIVE, REMOVED], 'readwrite', (tx, done, fail) => {
        const staged = tx.objectStore(STAGED),
          active = tx.objectStore(ACTIVE),
          removed = tx.objectStore(REMOVED);
        const read = staged.get(token);
        read.onsuccess = () => {
          const record = read.result as RetainedPackage | undefined;
          if (!record) return fail(new Error('Unknown staged package'));
          const k = key(record.manifest.id, record.manifest.version);
          const current = active.get(k);
          current.onsuccess = () => {
            const existing = current.result as RetainedPackage | undefined;
            // Repair: compare-and-swap against the exact damaged record the caller read.
            if (options) {
              if (!existing || String(existing.packageHash) !== options.replacing)
                return fail(new Error('Retained package changed'));
            } else if (existing && existing.packageHash !== record.packageHash)
              return fail(new Error('Another package is active for this id@version'));
            const previous = removed.get(k);
            previous.onsuccess = () => {
              if (previous.result !== undefined && previous.result !== record.packageHash)
                return fail(new Error('Another package was removed for this id@version'));
              active.put(record, k);
              staged.delete(token);
              done(undefined);
            };
          };
        };
      }),
    discard: (token) =>
      transact<void>([STAGED], 'readwrite', (tx, done) => {
        tx.objectStore(STAGED).delete(token);
        done(undefined);
      }),
    staged: () =>
      transact<string[]>([STAGED], 'readonly', (tx, done) => {
        const request = tx.objectStore(STAGED).getAllKeys();
        request.onsuccess = () => done(request.result.map(String));
      }),
    read: (id, version) => get(ACTIVE, key(id, version)),
    remove: (id, version, packageHash) =>
      transact<void>([ACTIVE, REMOVED], 'readwrite', (tx, done, fail) => {
        const k = key(id, version),
          active = tx.objectStore(ACTIVE);
        const current = active.get(k);
        current.onsuccess = () => {
          if ((current.result as RetainedPackage | undefined)?.packageHash !== packageHash)
            return fail(new Error('Retained package changed'));
          tx.objectStore(REMOVED).put(packageHash, k);
          active.delete(k);
          done(undefined);
        };
      }),
    removed: (id, version) =>
      transact<string | undefined>([REMOVED], 'readonly', (tx, done) => {
        const request = tx.objectStore(REMOVED).get(key(id, version));
        request.onsuccess = () => done(request.result as string | undefined);
      }),
  };
}
