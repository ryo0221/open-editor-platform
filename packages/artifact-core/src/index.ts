export type ArtifactId = string;
export type VersionId = string;
export type ActorRef = string;
export interface ArtifactRef {
  artifactId: ArtifactId;
}
export interface ArtifactVersionRef extends ArtifactRef {
  versionId: VersionId;
}
export interface ArtifactVersion<T> extends ArtifactVersionRef {
  parentVersionId: VersionId | null;
  schemaVersion: number;
  content: T;
  contentHash: string;
  createdAt: string;
  createdBy: ActorRef | null;
  reason: string | null;
}
export interface ArtifactDraft<T> {
  content: T;
  baseVersionId: VersionId | null;
  updatedAt: string;
}
export interface Provenance {
  template?: { id: string; version: number; hash: string; requestId: string; fingerprint: string };
  source: 'created' | 'imported';
  officeImport?: {
    requestId: string;
    sourceHash: string;
    fingerprint: string;
    adapterVersion: string;
  };
  format?: string;
  importedAt?: string;
}
export interface Artifact<T> {
  schemaVersion: 1;
  id: ArtifactId;
  name: string;
  kind: string;
  draft: ArtifactDraft<T>;
  versions: ArtifactVersion<T>[];
  provenance: Provenance;
}
export interface CompareInput<T> {
  before: ArtifactVersion<T>;
  after: ArtifactVersion<T>;
}
export interface Change {
  elementId: string;
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  before?: string;
  after?: string;
}
export interface CompareResult {
  changes: Change[];
}
export const newId = (prefix = 'el') => `${prefix}_${crypto.randomUUID()}`;
export const clone = <T>(value: T): T => structuredClone(value);
// Only trees traversed by this function may be skipped. A caller's shallow
// Object.freeze is not evidence that its children are immutable.
const frozenTrees = new WeakSet<object>();
const frozenJsonTrees = new WeakSet<object>();
/** True only for primitives or trees fully traversed by deepFreeze. */
export function isDeepFrozen(value: unknown): boolean {
  return !value || typeof value !== 'object' || frozenTrees.has(value);
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !frozenTrees.has(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
    frozenTrees.add(value);
  }
  return value;
}
/** Parse and own plain JSON before exposing any part of it to callers. The
 * certificate cannot be obtained by freezing an arbitrary object with accessors,
 * hidden properties or mutable children. This does not validate a domain schema.
 */
export function parseImmutableJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const freeze = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
    frozenTrees.add(entry);
    frozenJsonTrees.add(entry);
  };
  freeze(value);
  return value;
}
/** Whether this object was created and recursively frozen by parseImmutableJson. */
export function isImmutableJson(value: unknown): boolean {
  return !!value && typeof value === 'object' && frozenJsonTrees.has(value);
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    // Preserve the canonical byte order without allocating entry/filter/map
    // arrays for every text-engine node or retained definition.
    let result = '{',
      separator = '';
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      result += separator + JSON.stringify(key) + ':' + canonicalJson(child);
      separator = ',';
    }
    return result + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
/** Equivalent to `canonicalJson(a) === canonicalJson(b)` for JSON data, without
 * serializing either side. Shared or equal large strings compare without copying. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      // canonicalJson renders holes as empty slots, so `Array(1)` and `[]` agree while
      // `[undefined]` does not. Sparse (or unequal-length) arrays use its exact output.
      if (!(i in a) || !(i in b)) return canonicalJson(a) === canonicalJson(b);
      if (!canonicalEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objectA = !!a && typeof a === 'object',
    objectB = !!b && typeof b === 'object';
  if (objectA !== objectB) return false;
  if (!objectA) return (JSON.stringify(a) ?? 'null') === (JSON.stringify(b) ?? 'null');
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(right).filter((key) => right[key] !== undefined);
  let count = 0;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    count++;
    if (!Object.prototype.propertyIsEnumerable.call(right, key)) return false;
    if (!canonicalEqual(left[key], right[key])) return false;
  }
  return count === keys.length;
}
export async function contentHash(content: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(content)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function createArtifact<T>(
  kind: string,
  name: string,
  content: T,
  provenance: Provenance = { source: 'created' },
): Artifact<T> {
  return {
    schemaVersion: 1,
    id: newId('artifact'),
    name,
    kind,
    draft: { content: clone(content), baseVersionId: null, updatedAt: new Date().toISOString() },
    versions: [],
    provenance,
  };
}
export function updateDraft<T>(artifact: Artifact<T>, content: T): Artifact<T> {
  return {
    ...artifact,
    draft: { ...artifact.draft, content: clone(content), updatedAt: new Date().toISOString() },
  };
}
export async function commitVersion<T>(
  artifact: Artifact<T>,
  actor: ActorRef | null,
  reason: string | null,
): Promise<Artifact<T>> {
  const content = clone(artifact.draft.content);
  const version: ArtifactVersion<T> = deepFreeze({
    artifactId: artifact.id,
    versionId: newId('version'),
    parentVersionId: artifact.draft.baseVersionId,
    schemaVersion: 1,
    content,
    contentHash: await contentHash(content),
    createdAt: new Date().toISOString(),
    createdBy: actor,
    reason,
  });
  return {
    ...artifact,
    versions: [...artifact.versions, version],
    draft: {
      content: clone(content),
      baseVersionId: version.versionId,
      updatedAt: version.createdAt,
    },
  };
}
export function serializeArtifact<T>(artifact: Artifact<T>): string {
  return JSON.stringify(artifact, null, 2);
}
export function deserializeArtifact(text: string): Artifact<unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Expected an artifact object');
  const a = value as Partial<Artifact<unknown>>;
  if (
    a.schemaVersion !== 1 ||
    typeof a.id !== 'string' ||
    typeof a.name !== 'string' ||
    typeof a.kind !== 'string' ||
    !a.draft ||
    !('content' in a.draft) ||
    !Array.isArray(a.versions)
  )
    throw new Error('Unsupported or invalid artifact envelope');
  for (const v of a.versions)
    if (
      !v ||
      v.artifactId !== a.id ||
      typeof v.versionId !== 'string' ||
      v.schemaVersion !== 1 ||
      !('content' in v) ||
      typeof v.contentHash !== 'string'
    )
      throw new Error('Invalid artifact version');
  return clone(a as Artifact<unknown>);
}
export interface StorageAdapter<T extends { id: string }> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  /** Atomically create or return the existing record without overwriting it. */
  putIfAbsent?(value: T): Promise<T>;
  remove(id: string): Promise<void>;
}
export class MemoryStorage<T extends { id: string }> implements StorageAdapter<T> {
  private records = new Map<string, T>();
  async list() {
    return clone([...this.records.values()]);
  }
  async get(id: string) {
    return clone(this.records.get(id));
  }
  async put(value: T) {
    this.records.set(value.id, clone(value));
  }
  async putIfAbsent(value: T) {
    if (!this.records.has(value.id)) this.records.set(value.id, clone(value));
    return clone(this.records.get(value.id)!);
  }
  async remove(id: string) {
    this.records.delete(id);
  }
}
export class IndexedDBStorage<T extends { id: string }> implements StorageAdapter<T> {
  private db: Promise<IDBDatabase>;
  constructor(name = 'editor-platform') {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('artifacts', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('Close another tab to finish the storage upgrade'));
    });
  }
  private async request<R>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('artifacts', mode);
      const req = run(tx.objectStore('artifacts'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
    });
  }
  list() {
    return this.request<T[]>('readonly', (s) => s.getAll());
  }
  get(id: string) {
    return this.request<T | undefined>('readonly', (s) => s.get(id));
  }
  async put(value: T) {
    // IndexedDB synchronously clones the value at put(), including nested content.
    await this.request('readwrite', (s) => s.put(value));
  }
  async putIfAbsent(value: T): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('artifacts', 'readwrite'),
        store = tx.objectStore('artifacts');
      const request = store.get(value.id);
      let result: T;
      request.onsuccess = () => {
        result = request.result ?? clone(value);
        if (!request.result) store.add(result);
      };
      tx.oncomplete = () => resolve(clone(result));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
    });
  }
  async remove(id: string) {
    await this.request('readwrite', (s) => s.delete(id));
  }
  async close() {
    (await this.db).close();
  }
}
export function diffElements(before: { id: string }[], after: { id: string }[]): CompareResult {
  const changes: Change[] = [];
  for (const old of before) {
    const next = after.find((n) => n.id === old.id);
    if (!next)
      changes.push({
        elementId: old.id,
        path: old.id,
        kind: 'removed',
        before: canonicalJson(old),
      });
    else {
      if (canonicalJson(old) !== canonicalJson(next))
        changes.push({
          elementId: old.id,
          path: old.id,
          kind: 'changed',
          before: canonicalJson(old),
          after: canonicalJson(next),
        });
      if (before.indexOf(old) !== after.indexOf(next))
        changes.push({ elementId: old.id, path: old.id, kind: 'moved' });
    }
  }
  for (const next of after)
    if (!before.some((o) => o.id === next.id))
      changes.push({
        elementId: next.id,
        path: next.id,
        kind: 'added',
        after: canonicalJson(next),
      });
  return { changes };
}

/** Domain adapters provide readable descriptions; comparison never needs to expose raw assets. */
export function describeChanges<T extends { id: string }>(
  before: T[],
  after: T[],
  label: (item: T) => string,
  describe: (item: T, side: 'before' | 'after') => string,
): Change[] {
  return diffElements(before, after).changes.map((change) => {
    const old = before.find((item) => item.id === change.elementId),
      next = after.find((item) => item.id === change.elementId);
    return {
      ...change,
      path: label(next ?? old!),
      before: old ? describe(old, 'before') : undefined,
      after: next ? describe(next, 'after') : undefined,
    };
  });
}

/** Shared atomic creation path for templates and confirmed Office imports.
 * Host adapters enforce authority in putIfAbsent; this function never emulates it with get/put.
 */
export async function createArtifactIfAbsent<T extends { id: string }>(
  storage: Pick<StorageAdapter<T>, 'putIfAbsent'>,
  artifact: T,
  fingerprint: string,
  storedFingerprint: (stored: T) => string | undefined,
  fail: (code: string, message: string) => never = (code, message) => {
    throw Object.assign(new Error(message), { code });
  },
): Promise<T> {
  if (!storage.putIfAbsent)
    fail('storage-capability', 'Host storage must support atomic putIfAbsent for creation');
  const stored = await storage.putIfAbsent(clone(artifact));
  if (stored.id !== artifact.id || storedFingerprint(stored) !== fingerprint)
    fail('request-conflict', 'Creation request was already used for different input');
  return clone(stored);
}
