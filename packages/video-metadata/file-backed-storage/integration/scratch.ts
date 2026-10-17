/** Private durable scratch ownership ledger. Caller must hold the namespace Web Lock. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import { assertCapture, assertPin, type Pin } from '../browser/journal';
import { need } from '../portable/io';
export interface ScratchRecord {
  operationId: string;
  capture: SaveCapture;
  file: string;
  head: number;
  phase: 'preparing' | 'ready' | 'cleaning' | 'done';
  pin: Pin | null;
  outcome: 'unknown' | 'committed' | 'no-write';
}
interface Root {
  format: 'video-scratch-ledger-v1';
  artifactId: string;
  budget: number;
  records: ScratchRecord[];
}
function fields(v: unknown, keys: string[]) {
  need(v && typeof v === 'object' && !Array.isArray(v), 'Scratch record');
  const actual = Object.keys(v).sort(),
    expected = [...keys].sort();
  need(
    actual.length === expected.length && actual.every((k, i) => k === expected[i]),
    'Scratch fields',
  );
}
function validate(root: Root, artifactId: string, budget: number) {
  fields(root, ['format', 'artifactId', 'budget', 'records']);
  need(
    root.format === 'video-scratch-ledger-v1' &&
      root.artifactId === artifactId &&
      root.budget === budget &&
      Array.isArray(root.records) &&
      root.records.length <= 64,
    'Scratch ledger identity/budget',
  );
  const ids = new Set<string>(),
    files = new Set<string>();
  for (const r of root.records) {
    fields(r, ['operationId', 'capture', 'file', 'head', 'phase', 'pin', 'outcome']);
    assertCapture(r.capture);
    need(
      /^[a-zA-Z0-9_-]{1,128}$/.test(r.operationId) &&
        !ids.has(r.operationId) &&
        r.capture.scope.artifactId === artifactId &&
        /^preparation-[a-f0-9-]{36}$/.test(r.file) &&
        !files.has(r.file) &&
        Number.isSafeInteger(r.head) &&
        r.head >= 0 &&
        ['preparing', 'ready', 'cleaning', 'done'].includes(r.phase) &&
        ['unknown', 'committed', 'no-write'].includes(r.outcome),
      'Scratch operation',
    );
    if (r.pin !== null) {
      assertPin(r.pin);
      need(
        r.pin.operationId === r.operationId &&
          canonicalJson(r.pin.capture) === canonicalJson(r.capture) &&
          r.pin.bytes <= budget,
        'Scratch archive pin',
      );
    }
    need(
      (r.phase !== 'ready' || r.pin !== null) && (r.outcome !== 'committed' || r.pin !== null),
      'Scratch ready/outcome',
    );
    ids.add(r.operationId);
    files.add(r.file);
  }
  need(root.records.filter((r) => r.phase !== 'done').length <= 1, 'Concurrent scratch ownership');
}
export class ScratchLedger {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly artifactId: string,
    private readonly budget: number,
  ) {}
  static async open(
    namespace: string,
    artifactId: string,
    budget: number,
    directory: FileSystemDirectoryHandle,
  ) {
    let created = false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('video-scratch-ledger-' + namespace, 1);
      request.onupgradeneeded = () => {
        created = true;
        request.result.createObjectStore('ledger');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Scratch ledger blocked'));
    });
    db.onversionchange = () => db.close();
    const ledger = new ScratchLedger(db, artifactId, budget);
    try {
      let empty = true;
      for await (const _ of (directory as unknown as { keys(): AsyncIterable<string> }).keys()) {
        empty = false;
        break;
      }
      await ledger.change(() => {}, created && empty);
      return ledger;
    } catch (e) {
      db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  private change<T>(work: (root: Root) => T, create = false): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('ledger', 'readwrite', { durability: 'strict' }),
        store = tx.objectStore('ledger'),
        request = store.get('root');
      let result: T, error: unknown;
      request.onsuccess = () => {
        try {
          need(
            request.result !== undefined || create,
            'Missing scratch ledger; explicit recovery required',
          );
          const root: Root = request.result ?? {
            format: 'video-scratch-ledger-v1',
            artifactId: this.artifactId,
            budget: this.budget,
            records: [],
          };
          validate(root, this.artifactId, this.budget);
          result = work(root);
          validate(root, this.artifactId, this.budget);
          store.put(root, 'root');
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error ?? tx.error ?? Error('Scratch ledger transaction aborted'));
    });
  }
  records() {
    return this.change((root) => structuredClone(root.records));
  }
  reserve(operationId: string, capture: SaveCapture, head: number) {
    return this.change((root) => {
      need(
        root.records.length < 64 &&
          !root.records.some((r) => r.operationId === operationId) &&
          root.records.every((r) => r.phase === 'done'),
        'Scratch operation reused/unresolved/budget',
      );
      const record: ScratchRecord = {
        operationId,
        capture: structuredClone(capture),
        head,
        file: 'preparation-' + crypto.randomUUID(),
        phase: 'preparing',
        pin: null,
        outcome: 'unknown',
      };
      root.records.push(record);
      return structuredClone(record);
    });
  }
  update(operationId: string, work: (record: ScratchRecord) => void) {
    return this.change((root) => {
      const record = root.records.find((r) => r.operationId === operationId);
      need(record, 'Unknown scratch operation');
      work(record);
      return structuredClone(record);
    });
  }
}
export type ScratchPhase =
  | 'scratch-intent'
  | 'scratch-chunk'
  | 'scratch-closed'
  | 'scratch-ready'
  | 'scratch-cleaning'
  | 'scratch-removed';
export interface ScratchHooks {
  observe?(phase: ScratchPhase, record: Readonly<ScratchRecord>): Promise<void>;
}
