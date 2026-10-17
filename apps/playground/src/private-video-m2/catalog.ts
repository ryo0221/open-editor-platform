import { projectIdPattern } from './registration';
/** Locators only: retained native versions and history remain in reviewed Video Storage. */
export interface PrivateVideoM2Entry {
  id: string;
  namespace: string;
  name: string;
  updatedAt: string;
}
export const locatorPrefix = 'ep-private-video-m2-locator@0:';
type Reader = Pick<Storage, 'getItem' | 'key' | 'length'>;
type Writer = Reader & Pick<Storage, 'setItem'>;
function parse(text: string): PrivateVideoM2Entry {
  if (text.length > 1024) throw new Error('Private Video M2 locator capacity');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Private Video M2 locator schema');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'id,name,namespace,updatedAt' ||
    typeof row.id !== 'string' ||
    !projectIdPattern.test(row.id) ||
    typeof row.namespace !== 'string' ||
    !row.namespace.startsWith('normal-video-m2-') ||
    !projectIdPattern.test(row.namespace.slice('normal-video-m2-'.length)) ||
    typeof row.name !== 'string' ||
    row.name.length < 1 ||
    row.name.length > 100 ||
    typeof row.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw new Error('Private Video M2 locator schema');
  return value as PrivateVideoM2Entry;
}
export function readM2Catalog(storage: Reader = localStorage): PrivateVideoM2Entry[] {
  const entries: PrivateVideoM2Entry[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(locatorPrefix)) continue;
    const text = storage.getItem(key);
    if (text === null) continue;
    const entry = parse(text);
    if (key !== locatorPrefix + entry.id) throw new Error('Private Video M2 locator identity');
    entries.push(entry);
  }
  // This is a separate Library section. Never sort/rewrite the v1 catalog.
  return entries;
}
export function publishM2Locator(
  entry: PrivateVideoM2Entry,
  expectedNamespace: string | undefined,
  storage: Writer = localStorage,
) {
  const text = JSON.stringify(entry);
  parse(text);
  const existing = readM2Catalog(storage).find((row) => row.id === entry.id);
  if (existing?.namespace !== expectedNamespace)
    throw new Error('Private Video M2 catalog conflict');
  storage.setItem(locatorPrefix + entry.id, text);
}
/** Publication errors propagate: the runtime must retain the same committed Save for retry. */
export async function publishM2LocatorLocked(
  entry: PrivateVideoM2Entry,
  expectedNamespace: string | undefined,
  storage: Writer = localStorage,
  locks: Pick<LockManager, 'request'> = navigator.locks,
) {
  await locks.request('normal-video-m2-catalog@0', () => {
    publishM2Locator(entry, expectedNamespace, storage);
  });
}
