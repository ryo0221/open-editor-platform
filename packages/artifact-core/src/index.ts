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
  /** A copied draft starts a new Artifact lineage; this is not a version parent edge. */
  migration?: {
    converter: string;
    sourceArtifactId: ArtifactId;
    sourceBaseVersionId: VersionId | null;
    sourceContentHash: string;
    targetContentHash: string;
    sourceSchema: string;
    targetSchema: string;
    sourceReaderPin?: string;
    targetReaderPin?: string;
    converterPin?: string;
  };
  template?: { id: string; version: number; hash: string } & (
    | { requestId: string; fingerprint: string }
    | { requestId?: never; fingerprint?: never }
  );
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
export class DuplicateArtifactVersionError extends Error {
  constructor(readonly artifactId: ArtifactId) {
    super('Duplicate artifact version ID');
  }
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
  const versionIds = new Set<string>();
  for (const v of a.versions) {
    if (
      !v ||
      v.artifactId !== a.id ||
      typeof v.versionId !== 'string' ||
      v.schemaVersion !== 1 ||
      !('content' in v) ||
      typeof v.contentHash !== 'string'
    )
      throw new Error('Invalid artifact version');
    if (versionIds.has(v.versionId)) throw new DuplicateArtifactVersionError(a.id);
    versionIds.add(v.versionId);
  }
  return clone(a as Artifact<unknown>);
}
export interface StorageAdapter<T extends { id: string }> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  /** Atomically create or return the existing record without overwriting it. */
  putIfAbsent?(value: T): Promise<T>;
  /** Atomically store several records: either all are written or none is. */
  putAll?(values: T[]): Promise<void>;
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
  async putAll(values: T[]) {
    const copies = values.map((value) => clone(value));
    for (const copy of copies) this.records.set(copy.id, copy);
  }
  async remove(id: string) {
    this.records.delete(id);
  }
}
/**
 * Large parts of a record kept as their own IndexedDB values (#812). Chromium refuses one value
 * over about 133 MB, so a record whose assets are larger is stored as a small stub plus parts.
 * A part's key must name its value: the same key always stands for the same value, so a part
 * already stored under that key is not written again.
 */
export interface OutOfLineParts<T> {
  /** The stub to store and the parts taken out of it, by key. */
  split(value: T): { stub: T; parts: Map<string, unknown> };
  /** The parts the stub names. */
  keys(stub: T): string[];
  /**
   * The record again; a part that is missing is not in the map. Called for every stored record,
   * with an empty map when it names no parts.
   */
  join(stub: T, parts: Map<string, unknown>): T;
}
const partsStore = 'parts';
function openDb(name: string, store: string, keyPath?: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close another tab to finish the storage upgrade'));
  });
}
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}
/** All the part keys of one record: [record id, part key]. */
const partRange = (id: string) => IDBKeyRange.bound([id], [id, []]);

export class IndexedDBStorage<T extends { id: string }> implements StorageAdapter<T> {
  private db: Promise<IDBDatabase>;
  /** The parts live in their own database, so the records' database keeps its version 1. */
  private partsDb?: Promise<IDBDatabase>;
  /** Without the Web Locks API, writes in this context still run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private name = 'editor-platform',
    private outOfLine?: OutOfLineParts<T>,
  ) {
    this.db = openDb(name, 'artifacts', 'id');
    if (outOfLine) this.partsDb = openDb(`${name}-parts`, partsStore);
  }
  /**
   * The records and their parts are in two databases, so a write (parts, record, then the
   * removal of parts no record names) is not one transaction. Writes hold an exclusive lock
   * across tabs, and reads a shared one: otherwise one tab's removal could take parts that
   * another tab has written but not yet named, or that a reader is about to read.
   */
  private locked<R>(mode: 'shared' | 'exclusive', run: () => Promise<R>): Promise<R> {
    if (!this.outOfLine) return run();
    const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
    if (locks) return locks.request(`artifact-parts:${this.name}`, { mode }, run) as Promise<R>;
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
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
  /** Reads the parts the stubs name and joins each record again. */
  private async joined(stubs: T[]): Promise<T[]> {
    if (!this.outOfLine || !this.partsDb) return stubs;
    const wanted = stubs.map((stub) => this.outOfLine!.keys(stub));
    // Every stub is joined, one without parts too: `split` may have changed more than the parts
    // it took out (an escaped string), and `join` restores it.
    if (!wanted.some((keys) => keys.length))
      return stubs.map((stub) => this.outOfLine!.join(stub, new Map()));
    const tx = (await this.partsDb).transaction(partsStore, 'readonly');
    const store = tx.objectStore(partsStore);
    const found = stubs.map(() => new Map<string, unknown>());
    stubs.forEach((stub, i) => {
      for (const key of wanted[i]!) {
        const req = store.get([stub.id, key]);
        req.onsuccess = () => {
          if (req.result !== undefined) found[i]!.set(key, req.result);
        };
      }
    });
    await done(tx);
    return stubs.map((stub, i) => this.outOfLine!.join(stub, found[i]!));
  }
  /** Writes the parts of these records that are not stored yet; returns their stubs. */
  private async writeParts(values: T[]): Promise<T[]> {
    if (!this.outOfLine || !this.partsDb) return values;
    const split = values.map((value) => this.outOfLine!.split(value));
    if (!split.some((s) => s.parts.size)) return split.map((s) => s.stub);
    const tx = (await this.partsDb).transaction(partsStore, 'readwrite');
    const store = tx.objectStore(partsStore);
    let failure: unknown;
    const written = done(tx).catch((e) => Promise.reject(failure ?? e));
    try {
      split.forEach(({ parts }, i) => {
        const id = values[i]!.id;
        for (const [key, part] of parts) {
          const req = store.getKey([id, key]);
          req.onsuccess = () => {
            if (req.result === undefined) store.put(part, [id, key]);
          };
        }
      });
    } catch (error) {
      failure = error;
      tx.abort();
    }
    await written;
    return split.map((s) => s.stub);
  }
  /**
   * Removes the parts of these records that their stored stubs no longer name. The two
   * databases cannot share a transaction, so parts are written before and removed after the
   * records (under the write lock); a failure in between leaves unused parts, which the next
   * write removes.
   */
  private async dropParts(ids: string[]) {
    if (!this.outOfLine || !this.partsDb) return;
    const stored = await Promise.all(
      ids.map((id) => this.request<T | undefined>('readonly', (s) => s.get(id))),
    );
    const tx = (await this.partsDb).transaction(partsStore, 'readwrite');
    const store = tx.objectStore(partsStore);
    ids.forEach((id, i) => {
      const keep = new Set(stored[i] ? this.outOfLine!.keys(stored[i]!) : []);
      const req = store.getAllKeys(partRange(id));
      req.onsuccess = () => {
        for (const key of req.result as [string, string][])
          if (!keep.has(key[1])) store.delete(key);
      };
    });
    await done(tx);
  }
  list() {
    return this.locked('shared', async () =>
      this.joined(await this.request<T[]>('readonly', (s) => s.getAll())),
    );
  }
  get(id: string) {
    return this.locked('shared', () => this.getJoined(id));
  }
  private async getJoined(id: string) {
    const stub = await this.request<T | undefined>('readonly', (s) => s.get(id));
    return stub ? (await this.joined([stub]))[0] : undefined;
  }
  put(value: T) {
    return this.locked('exclusive', async () => {
      const [stub] = await this.writeParts([value]);
      // IndexedDB synchronously clones the value at put(), including nested content.
      await this.request('readwrite', (s) => s.put(stub));
      await this.dropParts([value.id]);
    });
  }
  putIfAbsent(value: T): Promise<T> {
    return this.locked('exclusive', async () => {
      const existing = await this.getJoined(value.id);
      if (existing) return existing;
      const [stub] = await this.writeParts([value]);
      const db = await this.db;
      const stored = await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('artifacts', 'readwrite'),
          store = tx.objectStore('artifacts');
        const request = store.get(value.id);
        let result: T;
        request.onsuccess = () => {
          result = request.result ?? clone(stub!);
          if (!request.result) store.add(result);
        };
        tx.oncomplete = () => resolve(clone(result));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
      });
      await this.dropParts([value.id]);
      return (await this.joined([stored]))[0]!;
    });
  }
  putAll(values: T[]): Promise<void> {
    return this.locked('exclusive', async () => {
      const stubs = await this.writeParts(values);
      const db = await this.db;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('artifacts', 'readwrite'),
          store = tx.objectStore('artifacts');
        let failure: unknown;
        // Aborting also fails the queued puts, whose error events carry no transaction error.
        const fail = () => reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
        tx.oncomplete = () => resolve();
        tx.onerror = fail;
        tx.onabort = fail;
        try {
          for (const value of stubs) store.put(value);
        } catch (error) {
          // A record that cannot be cloned or stored throws here; abort so nothing is kept.
          failure = error;
          tx.abort();
        }
      });
      await this.dropParts(values.map((v) => v.id));
    });
  }
  remove(id: string) {
    return this.locked('exclusive', async () => {
      await this.request('readwrite', (s) => s.delete(id));
      await this.dropParts([id]);
    });
  }
  async close() {
    (await this.db).close();
    if (this.partsDb) (await this.partsDb).close();
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
export * from './proposal-reads';
