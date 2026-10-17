/** Controlled synthetic storage test Host, never imported by the Video product. */
import { BrowserJournal, CHUNK, type Pin, type Verify } from './journal';
import { chunksFromReader } from './ranges';
interface Fixture {
  bytes: number;
  sha256: string;
  chunkHash: string;
  seed: number;
  captureKey: string;
}
const fixtures: Record<string, Fixture> = await (await fetch('/fixtures.json')).json();
let target: BrowserJournal,
  allowed = true,
  phase = '',
  writes = 0,
  pause = '',
  abortAfter = 0;
let control = new AbortController();
let maxRead = 0;
const digest = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(b))), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
// Known synthetic bytes only: each chunk is checked against independently generated Node hashes.
// This is NOT the production archive/native-closure verifier required by the adapter.
const verify: Verify = async (r, pin, signal) => {
  const f = Object.values(fixtures).find(
    (f) =>
      f.sha256 === pin.sha256 && f.bytes === pin.bytes && f.captureKey === pin.capture.contentHash,
  );
  if (!f || r.size !== f.bytes) return false;
  for (let offset = 0; offset < r.size; offset += CHUNK) {
    const bytes = await r.read(offset, Math.min(CHUNK, r.size - offset), signal);
    maxRead = Math.max(maxRead, bytes.length);
    if ((await digest(bytes)) !== f.chunkHash) return false;
  }
  return true;
};
let namespace = 'journal-tests';
let held: Awaited<ReturnType<BrowserJournal['lease']>> | undefined;
async function show() {
  document.querySelector('pre')!.textContent = JSON.stringify(await target.snapshot(), null, 2);
}
const qa = {
  async boundaryCancel(when: string) {
    const state = await target.snapshot(),
      f = fixtures.small,
      abort = new AbortController();
    const pin = structuredClone(state.operations[0].pin);
    pin.operationId = `boundary-${when}`;
    pin.capture.revision.sequence = state.head;
    let checks = 0;
    const owner = await BrowserJournal.open(
      namespace,
      64 * 1024 ** 2,
      verify,
      () => {
        if (++checks === 3 && when === 'commit') abort.abort();
        return true;
      },
      async (phase) => {
        if (phase === when) abort.abort();
      },
    );
    try {
      const chunks = chunksFromReader(
        {
          size: f.bytes,
          async read(_at, n) {
            return new Uint8Array(n).fill(f.seed);
          },
        },
        abort.signal,
      );
      return await owner.save(pin, state.head, chunks, abort.signal);
    } finally {
      owner.close();
    }
  },
  async rejectThenCompete(id: string, kind: string) {
    const f = fixtures.small;
    const pin: Pin = {
      operationId: id,
      capture: {
        scope: { artifactId: 'synthetic-storage', sessionId: 'session', generation: 'g1' },
        revision: { kind: 'local-draft', sessionId: 'session', sequence: 0 },
        contentHash: f.captureKey,
      },
      sha256: f.sha256,
      bytes: f.bytes,
    };
    const first = await BrowserJournal.open(
      namespace,
      64 * 1024 ** 2,
      verify,
      () => kind !== 'authority',
    );
    const second = await BrowserJournal.open(namespace, 64 * 1024 ** 2, verify, () => true);
    const abort = new AbortController();
    if (kind === 'cancel') abort.abort();
    const chunks = () =>
      chunksFromReader(
        {
          size: f.bytes,
          async read(_at, n) {
            return new Uint8Array(n).fill(f.seed);
          },
        },
        new AbortController().signal,
      );
    try {
      const a = first.save(pin, kind === 'stale' ? 99 : 0, chunks(), abort.signal);
      const b = second.save(pin, 0, chunks(), new AbortController().signal);
      return await Promise.all([a, b]);
    } finally {
      first.close();
      second.close();
    }
  },
  async open(name = 'journal-tests') {
    namespace = name;
    target = await BrowserJournal.open(
      name,
      64 * 1024 ** 2,
      verify,
      () => allowed,
      async (state) => {
        phase = state;
        if (state === 'chunk' && ++writes === abortAfter) control.abort();
        if (state === pause) await new Promise<void>(() => {});
      },
    );
    await show();
    return true;
  },
  phase: () => ({ phase, writes, maxRead }),
  state: () => target.snapshot(),
  async save(id: string, which: string, head: number, stop = '', cancelAfter = 0, render = true) {
    const f = fixtures[which];
    phase = '';
    writes = 0;
    pause = stop;
    abortAfter = cancelAfter;
    control = new AbortController();
    const pin: Pin = {
      operationId: id,
      capture: {
        scope: { artifactId: 'synthetic-storage', sessionId: 'session', generation: 'g1' },
        revision: { kind: 'local-draft', sessionId: 'session', sequence: head },
        contentHash: f.captureKey,
      },
      sha256: f.sha256,
      bytes: f.bytes,
    };
    const chunks = chunksFromReader(
      {
        size: f.bytes,
        async read(_offset, length) {
          return new Uint8Array(length).fill(f.seed);
        },
      },
      control.signal,
    );
    const result = await target.save(pin, head, chunks, control.signal);
    if (render) await show();
    return result;
  },
  reconcile: (id: string) => target.reconcile(id, new AbortController().signal),
  abandon: (id: string) => target.abandon(id, new AbortController().signal),
  async resume(id: string) {
    const result = await target.resume(id, new AbortController().signal);
    await show();
    return result;
  },
  authority(value: boolean) {
    allowed = value;
  },
  async leaseCheck(id: string) {
    const lease = await target.lease(id, new AbortController().signal);
    const file = lease.file();
    const blob = lease.slice(0, CHUNK);
    const first = await lease.reader.read(0, CHUNK, new AbortController().signal);
    const hashes = [
      await digest(first),
      await digest(new Uint8Array(await blob.arrayBuffer())),
      await digest(new Uint8Array(await file.slice(0, CHUNK).arrayBuffer())),
    ];
    lease.release();
    let refused = false;
    try {
      await lease.reader.read(0, 1, new AbortController().signal);
    } catch {
      refused = true;
    }
    return { bytes: file.size, hashes, refused };
  },
  async hold(id: string) {
    held = await target.lease(id, new AbortController().signal);
  },
  async checkHeld() {
    const file = held!.file(),
      blob = held!.slice(0, CHUNK);
    const hashes = [
      await digest(new Uint8Array(await file.slice(0, CHUNK).arrayBuffer())),
      await digest(new Uint8Array(await blob.arrayBuffer())),
    ];
    const pending = held!.reader.read(0, CHUNK, new AbortController().signal);
    held!.release();
    let refused = false;
    try {
      await pending;
    } catch {
      refused = true;
    }
    return { hashes, refused };
  },
  async quotaFault(head: number) {
    const original = FileSystemWritableFileStream.prototype.write;
    let writes = 0;
    FileSystemWritableFileStream.prototype.write = function (data) {
      if (++writes === 2)
        return Promise.reject(
          new DOMException('Controlled browser write fault', 'QuotaExceededError'),
        );
      return original.call(this, data);
    };
    try {
      return await qa.save('browser-quota-fault', 'small', head);
    } finally {
      FileSystemWritableFileStream.prototype.write = original;
    }
  },
  async files() {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace);
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    return names;
  },
  async remove(id: string) {
    const op = (await target.snapshot()).operations.find((o) => o.pin.operationId === id)!;
    await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace)
    ).removeEntry(op.file);
  },
  async tamper(id: string) {
    const op = (await target.snapshot()).operations.find((o) => o.pin.operationId === id)!;
    const file = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace)
    ).getFileHandle(op.file);
    const writer = await file.createWritable({ keepExistingData: true });
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([0]) });
    await writer.close();
  },
  async corruptCommittedParent() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`video-files-${namespace}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('journal', 'readwrite');
        const store = tx.objectStore('journal'),
          request = store.get('root');
        request.onsuccess = () => {
          const s = request.result;
          s.operations.find((op: { phase: string }) => op.phase === 'committed').parent = s.head;
          store.put(s, 'root');
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async dropJournal() {
    target.close();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase(`video-files-${namespace}`);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error('blocked'));
    });
  },
};
Object.assign(window, { qa });
document.querySelector('pre')!.textContent = 'Controlled OPFS/IndexedDB storage test ready';
