/** Private reference-Host recovery storage; never an ordinary Artifact export. */
const databaseName = 'editor-platform-reference-recovery';
const storeName = 'checkpoints';
const backupFormat = 'reference-recovery/1';
interface Backup<T> {
  format: typeof backupFormat;
  sequence: number;
  checkpoint: T;
}
interface Entry<T> extends Backup<T> {
  key: string;
  namespace: string;
  location: string;
}
function parseBackup<T>(raw: string | null): Backup<T> | undefined {
  if (raw === null) return;
  const value = JSON.parse(raw);
  if (value?.format === backupFormat) {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !value.checkpoint)
      throw new Error('Invalid recovery backup');
    return value;
  }
  // Existing schema-1 SharedEditorSession checkpoints remain readable.
  return { format: backupFormat, sequence: 0, checkpoint: value as T };
}
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'key' });
      store.createIndex('namespace', 'namespace');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Recovery database is blocked'));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function recoveryNamespace(storage: Storage): string {
  const key = 'ep-recovery-namespace';
  let namespace = storage.getItem(key);
  if (!namespace) {
    namespace = crypto.randomUUID();
    storage.setItem(key, namespace);
  }
  return namespace;
}

/** Routine writes use IndexedDB's structured clone. A synchronous backup always
 * wins over an older in-flight transaction, including one that finishes after close.
 * Sequence numbers order private Host writes; they are not authority revisions.
 */
export class ReferenceRecoveryStore<T> {
  private sequence = 0;
  private backupSequence = -1;
  private closed = false;
  private constructor(
    private db: IDBDatabase,
    private storage: Storage,
    private namespace: string,
    private location: string,
  ) {}
  private get key() {
    return JSON.stringify([this.namespace, this.location]);
  }
  static async open<T>(
    location: string,
    storage: Storage,
    factory: IDBFactory = indexedDB,
  ): Promise<ReferenceRecoveryStore<T>> {
    const namespace = recoveryNamespace(storage);
    return new ReferenceRecoveryStore<T>(await openDatabase(factory), storage, namespace, location);
  }
  async load(): Promise<T | undefined> {
    const backup = parseBackup<T>(this.storage.getItem(this.location));
    const entry = (await requestValue(
      this.db.transaction(storeName).objectStore(storeName).get(this.key),
    )) as Entry<T> | undefined;
    if (
      entry &&
      (entry.format !== backupFormat ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1 ||
        entry.namespace !== this.namespace ||
        entry.location !== this.location)
    )
      throw new Error('Invalid recovery database entry');
    this.backupSequence = backup?.sequence ?? -1;
    this.sequence = Math.max(this.sequence, this.backupSequence, entry?.sequence ?? 0);
    return backup && (!entry || backup.sequence >= entry.sequence)
      ? backup.checkpoint
      : entry?.checkpoint;
  }
  write(checkpoint: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Recovery store is closed'));
    const sequence = ++this.sequence;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, 'readwrite');
      transaction.onabort = () => reject(transaction.error ?? new Error('Recovery write aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Recovery write failed'));
      transaction.oncomplete = () => {
        // Remove only the backup this transaction has superseded. A newer emergency
        // backup must survive an older async completion or a detached Host.
        if (!this.closed && this.backupSequence >= 0 && this.backupSequence <= sequence) {
          try {
            this.storage.removeItem(this.location);
            this.backupSequence = -1;
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve();
      };
      try {
        transaction.objectStore(storeName).put({
          format: backupFormat,
          key: this.key,
          namespace: this.namespace,
          location: this.location,
          sequence,
          checkpoint,
        } satisfies Entry<T>);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }
  retainSync(checkpoint: T) {
    if (this.closed) throw new Error('Recovery store is closed');
    const sequence = ++this.sequence;
    this.storage.setItem(
      this.location,
      JSON.stringify({ format: backupFormat, sequence, checkpoint } satisfies Backup<T>),
    );
    this.backupSequence = sequence;
  }
  close() {
    this.closed = true;
    this.db.close();
  }
}

export async function downloadRecoveryEntries(storage: Storage, factory: IDBFactory = indexedDB) {
  const checkpoints: Record<string, unknown> = {};
  const sequences = new Map<string, number>();
  // Preserve usable synchronous backups even if IndexedDB is unavailable.
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (!key.startsWith('ep-shared-pending:')) continue;
    const raw = storage.getItem(key);
    try {
      const backup = parseBackup(raw)!;
      checkpoints[key] = backup.checkpoint;
      sequences.set(key, backup.sequence);
    } catch {
      checkpoints[key] = { invalidBackup: raw };
      sequences.set(key, Infinity);
    }
  }
  let error: string | undefined;
  try {
    const db = await openDatabase(factory);
    try {
      const entries = (await requestValue(
        db
          .transaction(storeName)
          .objectStore(storeName)
          .index('namespace')
          .getAll(recoveryNamespace(storage)),
      )) as Entry<unknown>[];
      for (const entry of entries)
        if (entry.sequence > (sequences.get(entry.location) ?? -1))
          checkpoints[entry.location] = entry.checkpoint;
    } finally {
      db.close();
    }
  } catch (cause) {
    error = `IndexedDB recovery records could not be read: ${String(cause)}`;
  }
  return { checkpoints, ...(error ? { error } : {}) };
}
