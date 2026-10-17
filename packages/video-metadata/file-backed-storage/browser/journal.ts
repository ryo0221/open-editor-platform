/** Private browser adapter candidate. No archive engine, picker or permission acquisition. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
export const CHUNK = 65536;
export interface Pin {
  operationId: string;
  capture: SaveCapture;
  sha256: string;
  bytes: number;
}
export interface RangeReader {
  readonly size: number;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}
/** Trusted Host verifier must validate full archive closure and exact hash, not merely file length. */
export type Verify = (
  reader: RangeReader,
  pin: Readonly<Pin>,
  signal: AbortSignal,
) => Promise<boolean>;
type Phase = 'intent' | 'prepared' | 'committed' | 'aborted';
interface Operation {
  pin: Pin;
  file: string;
  parent: number;
  phase: Phase;
}
interface State {
  format: 'video-opfs-journal-v0';
  quota: number;
  head: number;
  current: string | null;
  operations: Operation[];
}
export type Result = { state: 'saved' | 'ready' | 'unknown' | 'not-written' | 'stale'; pin: Pin };
/** Fault/interrupt observation hook for controlled tests; not an authorization grant. */
export type Observe = (
  phase: 'intent' | 'chunk' | 'closed' | 'prepared' | 'committed',
) => Promise<void>;
function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function fields(value: unknown, keys: string[]) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Journal record');
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  need(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    'Journal keys',
  );
}
export function assertCapture(capture: SaveCapture) {
  fields(capture, ['scope', 'revision', 'contentHash']);
  fields(capture.scope, ['artifactId', 'sessionId', 'generation']);
  fields(capture.revision, ['kind', 'sessionId', 'sequence']);
  need(
    Object.values(capture.scope).every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
    ) &&
      capture.revision.kind === 'local-draft' &&
      capture.revision.sessionId === capture.scope.sessionId &&
      Number.isSafeInteger(capture.revision.sequence) &&
      capture.revision.sequence >= 0 &&
      typeof capture.contentHash === 'string' &&
      /^[a-f0-9]{64}$/.test(capture.contentHash),
    'Capture',
  );
}
export function assertPin(p: Pin) {
  fields(p, ['operationId', 'capture', 'sha256', 'bytes']);
  assertCapture(p.capture);
  need(
    p &&
      typeof p.operationId === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(p.operationId) &&
      typeof p.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(p.sha256) &&
      Number.isSafeInteger(p.bytes) &&
      p.bytes > 0 &&
      p.bytes <= 8 * 1024 ** 3,
    'Pin bounds',
  );
}
function validate(s: State, quota: number) {
  fields(s, ['format', 'quota', 'head', 'current', 'operations']);
  need(
    s?.format === 'video-opfs-journal-v0' &&
      s.quota === quota &&
      Number.isSafeInteger(s.head) &&
      s.head >= 0 &&
      Array.isArray(s.operations) &&
      s.operations.length <= 64,
    'Journal schema/bounds',
  );
  const ids = new Set<string>(),
    files = new Set<string>();
  for (const op of s.operations) {
    fields(op, ['pin', 'file', 'parent', 'phase']);
    assertPin(op.pin);
    need(
      !ids.has(op.pin.operationId) &&
        /^candidate-[a-f0-9-]{36}$/.test(op.file) &&
        !files.has(op.file) &&
        Number.isSafeInteger(op.parent) &&
        op.parent >= 0 &&
        op.parent <= s.head &&
        ['intent', 'prepared', 'committed', 'aborted'].includes(op.phase),
      'Journal operation',
    );
    ids.add(op.pin.operationId);
    files.add(op.file);
  }
  const committed = s.operations.filter((op) => op.phase === 'committed');
  need(
    committed.length === s.head &&
      committed.every((op) => op.parent < s.head) &&
      new Set(committed.map((op) => op.parent)).size === committed.length,
    'Journal sequence',
  );
  need(
    (s.head === 0) === (s.current === null) &&
      (s.current === null ||
        committed.some((op) => op.pin.operationId === s.current && op.parent === s.head - 1)),
    'Journal selected head',
  );
  need(
    s.current === null ||
      s.operations.some((op) => op.pin.operationId === s.current && op.phase === 'committed'),
    'Journal current',
  );
  need(
    s.operations.reduce((n, op) => n + (op.phase === 'aborted' ? 0 : op.pin.bytes), 0) <= quota,
    'Journal reservation',
  );
}
function reader(file: File): RangeReader {
  return {
    size: file.size,
    async read(offset, length, signal) {
      signal.throwIfAborted();
      need(
        Number.isSafeInteger(offset) &&
          Number.isSafeInteger(length) &&
          offset >= 0 &&
          length >= 0 &&
          length <= CHUNK &&
          offset + length <= file.size,
        'Range budget',
      );
      const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      signal.throwIfAborted();
      need(bytes.length === length, 'Short read');
      return bytes;
    },
  };
}
export class BrowserJournal {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly directory: FileSystemDirectoryHandle,
    private readonly lock: string,
    private readonly quota: number,
    readonly namespace: string,
    private readonly verify: Verify,
    private readonly authorize: (pin: Readonly<Pin>) => boolean,
    private readonly observe: Observe,
  ) {}
  static async open(
    namespace: string,
    quota: number,
    verify: Verify,
    authorize: (pin: Readonly<Pin>) => boolean,
    observe: Observe = async () => {},
  ) {
    need(
      /^[a-z0-9-]{1,64}$/.test(namespace) &&
        Number.isSafeInteger(quota) &&
        quota > 0 &&
        quota <= 16 * 1024 ** 3,
      'Namespace/quota',
    );
    need(navigator.locks && navigator.storage?.getDirectory, 'OPFS/Web Locks required');
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(namespace, { create: true });
    let newDatabase = false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(`video-files-${namespace}`, 2);
      r.onupgradeneeded = (event) => {
        newDatabase = event.oldVersion === 0;
        if (event.oldVersion < 1) r.result.createObjectStore('journal');
        if (event.oldVersion < 2) r.result.createObjectStore('capture-refusals').put([], 'root');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error('Journal upgrade blocked'));
    });
    db.onversionchange = () => db.close();
    const target = new BrowserJournal(
      db,
      directory,
      `video-files-${namespace}`,
      quota,
      namespace,
      verify,
      authorize,
      observe,
    );
    try {
      await navigator.locks.request(target.lock, async () => {
        let empty = true;
        const iterable = directory as unknown as { keys(): AsyncIterable<string> };
        for await (const _name of iterable.keys()) {
          empty = false;
          break;
        }
        await target.change(() => {}, newDatabase && empty);
      });
      return target;
    } catch (e) {
      db.close();
      throw e;
    }
  }
  private refusals<T>(
    update: (records: { operationId: string; capture: SaveCapture }[]) => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('capture-refusals', 'readwrite', { durability: 'strict' }),
        store = tx.objectStore('capture-refusals'),
        request = store.get('root');
      let result: T, error: unknown;
      request.onsuccess = () => {
        try {
          const records = request.result;
          need(Array.isArray(records) && records.length <= 64, 'Capture refusal ledger');
          const ids = new Set<string>();
          for (const record of records) {
            fields(record, ['operationId', 'capture']);
            need(
              typeof record.operationId === 'string' &&
                /^[a-zA-Z0-9_-]{1,128}$/.test(record.operationId) &&
                !ids.has(record.operationId),
              'Capture refusal identity',
            );
            ids.add(record.operationId);
            assertCapture(record.capture);
          }
          result = update(records);
          need(records.length <= 64, 'Capture refusal budget');
          store.put(records, 'root');
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error ?? tx.error ?? Error('Refusal transaction aborted'));
    });
  }
  /** Durable operation-wide refusal before archive hash/length exist. Never invents a Pin. */
  async fenceCapture(
    operationId: string,
    capture: SaveCapture,
  ): Promise<'fenced' | 'occupied' | 'unknown'> {
    assertCapture(capture);
    need(/^[a-zA-Z0-9_-]{1,128}$/.test(operationId), 'Operation identity');
    const owned = structuredClone(capture);
    return navigator.locks.request(this.lock, async () => {
      try {
        const op = (await this.snapshot()).operations.find(
          (o) => o.pin.operationId === operationId,
        );
        if (op)
          return op.phase === 'aborted' && canonicalJson(op.pin.capture) === canonicalJson(owned)
            ? 'fenced'
            : 'occupied';
        return await this.refusals((records) => {
          const prior = records.find((r) => r.operationId === operationId);
          if (prior)
            return canonicalJson(prior.capture) === canonicalJson(owned) ? 'fenced' : 'occupied';
          need(records.length < 64, 'Capture refusal budget');
          records.push({ operationId, capture: owned });
          return 'fenced';
        });
      } catch {
        return 'unknown';
      }
    });
  }
  private allowed(pin: Pin) {
    return this.authorize(Object.freeze(structuredClone(pin))) === true;
  }
  close() {
    this.db.close();
  }
  private change<T>(update: (s: State) => T, allowCreate = false): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('journal', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('journal'),
        request = store.get('root');
      let result: T, error: unknown;
      request.onsuccess = () => {
        try {
          need(request.result !== undefined || allowCreate, 'Missing journal; recovery required');
          const s: State = request.result ?? {
            format: 'video-opfs-journal-v0',
            quota: this.quota,
            head: 0,
            current: null,
            operations: [],
          };
          validate(s, this.quota);
          result = update(s);
          validate(s, this.quota);
          store.put(s, 'root');
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error ?? tx.error ?? Error('Journal transaction aborted'));
      tx.onerror = () => {
        /* onabort provides the definitive transaction result */
      };
    });
  }
  async snapshot(): Promise<State> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('journal'),
        r = tx.objectStore('journal').get('root');
      let state: State;
      r.onsuccess = () => {
        state = r.result;
      };
      tx.oncomplete = () => {
        try {
          validate(state, this.quota);
          resolve(structuredClone(state));
        } catch (e) {
          reject(e);
        }
      };
      tx.onabort = () => reject(tx.error);
    });
  }
  private async verified(op: Operation, signal: AbortSignal) {
    signal.throwIfAborted();
    const file = await (await this.directory.getFileHandle(op.file)).getFile();
    need(
      file.size === op.pin.bytes &&
        (await this.verify(reader(file), Object.freeze(structuredClone(op.pin)), signal)) === true,
      'File verification refused',
    );
    signal.throwIfAborted();
    return file;
  }
  /** Advisory early check; save repeats it under the journal lock before publication. */
  async preflight(bytes: number, expectedHead: number) {
    return navigator.locks.request(this.lock, async () => {
      const state = await this.snapshot();
      need(
        Number.isSafeInteger(bytes) &&
          bytes > 0 &&
          state.head === expectedHead &&
          state.operations.length < 64 &&
          !state.operations.some((o) => o.phase === 'intent' || o.phase === 'prepared') &&
          state.operations.reduce((n, o) => n + (o.phase === 'aborted' ? 0 : o.pin.bytes), bytes) <=
            this.quota,
        'Journal capacity/head before scratch',
      );
    });
  }
  async save(
    input: Pin,
    expectedHead: number,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    beforeCandidate?: (path: string) => Promise<void>,
  ): Promise<Result> {
    const pin = structuredClone(input);
    assertPin(pin);
    return navigator.locks.request(this.lock, async () => {
      let op: Operation | undefined,
        stream: FileSystemWritableFileStream | undefined,
        commitAttempted = false,
        admissionKnown = false;
      try {
        // Reusing an ID with earlier evidence can never promise that it never wrote.
        const prior = await this.snapshot();
        if (
          await this.refusals((records) => records.some((r) => r.operationId === pin.operationId))
        )
          return { state: 'unknown', pin };
        if (prior.operations.some((item) => item.pin.operationId === pin.operationId))
          return { state: 'unknown', pin };
        admissionKnown = true;
        signal.throwIfAborted();
        need(this.allowed(pin), 'Authority');
        op = await this.change((s) => {
          need(s.head === expectedHead, 'Stale head');
          need(
            !s.operations.some((o) => o.phase === 'intent' || o.phase === 'prepared'),
            'Unsettled operation',
          );
          need(
            s.operations.length < 64 &&
              !s.operations.some((o) => o.pin.operationId === pin.operationId),
            'Operation reused/budget',
          );
          need(
            s.operations.reduce(
              (n, o) => n + (o.phase === 'aborted' ? 0 : o.pin.bytes),
              pin.bytes,
            ) <= this.quota,
            'Quota before staging',
          );
          const next: Operation = {
            pin,
            parent: s.head,
            file: `candidate-${crypto.randomUUID()}`,
            phase: 'intent',
          };
          s.operations.push(next);
          return structuredClone(next);
        });
        await this.observe('intent');
        await beforeCandidate?.(this.namespace + '/' + op.file);
        signal.throwIfAborted();
        const handle = await this.directory.getFileHandle(op.file, { create: true });
        stream = await handle.createWritable();
        let size = 0;
        for await (const bytes of chunks) {
          signal.throwIfAborted();
          need(
            bytes instanceof Uint8Array &&
              bytes.length > 0 &&
              bytes.length <= CHUNK &&
              size + bytes.length <= pin.bytes,
            'Chunk budget',
          );
          await stream.write(Uint8Array.from(bytes));
          size += bytes.length;
          await this.observe('chunk');
        }
        need(size === pin.bytes, 'Incomplete source');
        signal.throwIfAborted();
        await stream.close();
        stream = undefined;
        await this.observe('closed');
        await this.verified(op, signal);
        await this.change((s) => {
          const item = s.operations.find((o) => o.pin.operationId === pin.operationId)!;
          need(item.phase === 'intent' && s.head === op!.parent, 'Stale preparation');
          item.phase = 'prepared';
        });
        await this.observe('prepared');
        signal.throwIfAborted();
        need(this.allowed(pin), 'Authority');
        commitAttempted = true;
        await this.commit(op, signal);
        await this.observe('committed');
        return { state: 'saved', pin };
      } catch {
        if (!op) {
          if (!admissionKnown) return { state: 'unknown', pin };
          try {
            // A no-write result is operation-wide: fence the rejected ID before releasing the lock.
            await this.change((s) => {
              need(
                s.operations.length < 64 &&
                  !s.operations.some((o) => o.pin.operationId === pin.operationId),
                'Rejected operation fence',
              );
              s.operations.push({
                pin,
                parent: s.head,
                file: `candidate-${crypto.randomUUID()}`,
                phase: 'aborted',
              });
            });
            return { state: 'not-written', pin };
          } catch {
            return { state: 'unknown', pin };
          }
        }
        if (commitAttempted) return { state: 'unknown', pin };
        try {
          if (stream) await stream.abort();
          await this.directory.removeEntry(op.file).catch((e) => {
            if (e.name !== 'NotFoundError') throw e;
          });
          await this.change((s) => {
            const item = s.operations.find((o) => o.pin.operationId === pin.operationId)!;
            need(item.phase !== 'committed', 'Committed operation');
            item.phase = 'aborted';
          });
          return { state: 'not-written', pin };
        } catch {
          return { state: 'unknown', pin };
        }
      }
    });
  }
  private commit(op: Operation, signal: AbortSignal) {
    return this.change((s) => {
      signal.throwIfAborted();
      const item = s.operations.find((o) => o.pin.operationId === op.pin.operationId)!;
      need(
        item?.phase === 'prepared' && s.head === op.parent && this.allowed(op.pin),
        'Stale/unauthorized commit',
      );
      signal.throwIfAborted();
      item.phase = 'committed';
      s.current = op.pin.operationId;
      s.head++;
    });
  }
  async reconcile(operationId: string, signal: AbortSignal): Promise<Result> {
    return navigator.locks.request(this.lock, async () => {
      const s = await this.snapshot(),
        op = s.operations.find((o) => o.pin.operationId === operationId);
      need(op, 'Unknown operation');
      if (op.phase === 'aborted') return { state: 'not-written', pin: op.pin };
      try {
        await this.verified(op, signal);
      } catch {
        return { state: 'unknown', pin: op.pin };
      }
      if (op.phase === 'committed') return { state: 'saved', pin: op.pin }; // Never republish old current.
      return {
        state: op.phase === 'prepared' && op.parent === s.head ? 'ready' : 'unknown',
        pin: op.pin,
      };
    });
  }
  /** Explicit Host decision after interruption; never deletes a committed candidate. */
  async abandon(operationId: string, signal: AbortSignal): Promise<Result> {
    return navigator.locks.request(this.lock, async () => {
      const s = await this.snapshot(),
        op = s.operations.find((o) => o.pin.operationId === operationId);
      need(op, 'Unknown operation');
      if (op.phase === 'committed') {
        try {
          await this.verified(op, signal);
          return { state: 'saved', pin: op.pin };
        } catch {
          return { state: 'unknown', pin: op.pin };
        }
      }
      if (op.phase === 'aborted') return { state: 'not-written', pin: op.pin };
      try {
        signal.throwIfAborted();
        need(this.allowed(op.pin), 'Authority');
        signal.throwIfAborted();
        await this.directory.removeEntry(op.file).catch((e) => {
          if (e.name !== 'NotFoundError') throw e;
        });
        signal.throwIfAborted();
        await this.change((state) => {
          const item = state.operations.find((o) => o.pin.operationId === operationId)!;
          need(item.phase !== 'committed', 'Committed candidate');
          item.phase = 'aborted';
        });
        return { state: 'not-written', pin: op.pin };
      } catch {
        return { state: 'unknown', pin: op.pin };
      }
    });
  }
  /** Borrowed immutable completed file; the caller must retain it through media/save work. */
  async lease(operationId: string, signal: AbortSignal) {
    return navigator.locks.request(this.lock, async () => {
      const s = await this.snapshot(),
        op = s.operations.find((o) => o.pin.operationId === operationId);
      need(op?.phase === 'committed', 'Completed operation required');
      const file = await this.verified(op, signal),
        ranges = reader(file);
      let released = false;
      const check = () => need(!released, 'Released file lease');
      return {
        pin: Object.freeze(structuredClone(op.pin)),
        file() {
          check();
          return file;
        },
        slice(offset: number, length: number): Blob {
          check();
          need(
            Number.isSafeInteger(offset) &&
              Number.isSafeInteger(length) &&
              offset >= 0 &&
              length >= 0 &&
              offset + length <= file.size,
            'Blob range',
          );
          return file.slice(offset, offset + length);
        },
        reader: {
          size: file.size,
          async read(offset: number, length: number, abort: AbortSignal) {
            check();
            const bytes = await ranges.read(offset, length, abort);
            check();
            return bytes;
          },
        },
        release() {
          released = true;
        },
      };
    });
  }
  /** Explicit Host-authorized resume; simple inspection never selects a staged file. */
  async resume(operationId: string, signal: AbortSignal): Promise<Result> {
    return navigator.locks.request(this.lock, async () => {
      const s = await this.snapshot(),
        op = s.operations.find((o) => o.pin.operationId === operationId);
      need(op, 'Unknown operation');
      if (op.phase === 'committed') {
        await this.verified(op, signal);
        return { state: 'saved', pin: op.pin };
      }
      if (op.parent !== s.head) return { state: 'stale', pin: op.pin };
      if (op.phase !== 'prepared') return { state: 'unknown', pin: op.pin };
      try {
        await this.verified(op, signal);
        need(this.allowed(op.pin), 'Authority');
      } catch {
        return { state: 'unknown', pin: op.pin };
      }
      try {
        await this.commit(op, signal);
        return { state: 'saved', pin: op.pin };
      } catch {
        return { state: 'unknown', pin: op.pin };
      }
    });
  }
}
