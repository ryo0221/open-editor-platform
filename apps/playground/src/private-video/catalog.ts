/** Private Library locators only; native bytes, versions and history stay in reviewed Storage. */
export interface PrivateVideoEntry {
  id: string;
  namespace: string;
  name: string;
  updatedAt: string;
}
export const catalogKey = 'ep-private-video-locators@0'; // Retained prototype migration input.
export const locatorPrefix = 'ep-private-video-locator@0:';
type CatalogReader = Pick<Storage, 'getItem' | 'key' | 'length'>;
const uuid = /^[a-f0-9-]{36}$/;
function parseRecords(text: string | null): PrivateVideoEntry[] {
  if (text === null) return [];
  if (text.length > 65536) throw new Error('Private Video catalog capacity');
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 64) throw new Error('Private Video catalog schema');
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('Private Video locator');
    const v = row as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(',') !== 'id,name,namespace,updatedAt' ||
      typeof v.id !== 'string' ||
      !uuid.test(v.id) ||
      ids.has(v.id) ||
      typeof v.namespace !== 'string' ||
      !/^normal-video-[a-f0-9-]{36}$/.test(v.namespace) ||
      typeof v.name !== 'string' ||
      v.name.length < 1 ||
      v.name.length > 100 ||
      typeof v.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.updatedAt))
    )
      throw new Error('Private Video locator schema');
    ids.add(v.id);
  }
  return value as PrivateVideoEntry[];
}
export function readCatalog(storage: CatalogReader = localStorage): PrivateVideoEntry[] {
  const records = new Map(parseRecords(storage.getItem(catalogKey)).map((row) => [row.id, row]));
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(locatorPrefix)) continue;
    const text = storage.getItem(key);
    if (text === null) continue;
    if (text.length > 1024) throw new Error('Private Video locator capacity');
    const [entry] = parseRecords(JSON.stringify([JSON.parse(text)]));
    if (key !== locatorPrefix + entry.id) throw new Error('Private Video locator identity');
    records.set(entry.id, entry);
  }
  return [...records.values()];
}
export function publishLocator(
  entry: PrivateVideoEntry,
  expectedNamespace: string | undefined,
  storage: CatalogReader & Pick<Storage, 'setItem'> = localStorage,
) {
  const records = readCatalog(storage);
  const existing = records.find((row) => row.id === entry.id);
  if (existing?.namespace !== expectedNamespace) throw new Error('Private Video catalog conflict');
  parseRecords(JSON.stringify([entry]));
  // Separate immutable project identity keys avoid cross-renderer shared-value lost updates.
  const json = JSON.stringify(entry);
  if (json.length > 1024) throw new Error('Private Video locator capacity');
  storage.setItem(locatorPrefix + entry.id, json);
}

/** All normal Host publishers serialize the complete shared catalog transaction. */
export async function publishLocatorLocked(
  entry: PrivateVideoEntry,
  expectedNamespace: string | undefined,
  storage: CatalogReader & Pick<Storage, 'setItem'> = localStorage,
  locks: Pick<LockManager, 'request'> = navigator.locks,
) {
  await locks.request('normal-video-catalog@0', () => {
    publishLocator(entry, expectedNamespace, storage);
  });
}
