import { verifyDerivedClosure } from './geo-derived-closure';
/** Private Host-only IndexedDB persistence; no second draft/history engine. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import type { WriteEvidence } from '@editor-platform/extension-runtime/draft2';
import {
  checkedSourceEnvelope,
  checkedSourceEnvelopeStructure,
  encodedBytes,
  sourceLimits,
  type GeoSourceEnvelope,
} from './geo-source-envelope';
export * from './geo-source-envelope';
type Ack = {
  operationId: string;
  fingerprint: string;
  versionId: string;
  evidence: Extract<WriteEvidence, { state: 'committed' }>;
};
type Bucket = {
  head: string | null;
  versions: { id: string; text: string }[];
  acknowledgements: Ack[];
};
export type SourceCommitResult =
  | {
      state: 'committed';
      evidence: Ack['evidence'];
      versionId: string;
      replay: boolean;
      noop: boolean;
    }
  | { state: 'no-write'; code: string }
  | { state: 'unknown' };
const empty = (): Bucket => ({ head: null, versions: [], acknowledgements: [] });
function bucket(text: unknown): Bucket {
  if (text === undefined) return empty();
  if (typeof text !== 'string' || encodedBytes(text) > sourceLimits.total)
    throw Error('SourceRetentionLimit');
  const b = JSON.parse(text) as Bucket;
  if (
    !b ||
    Object.keys(b).sort().join() !== 'acknowledgements,head,versions' ||
    !Array.isArray(b.versions) ||
    !Array.isArray(b.acknowledgements) ||
    b.versions.length > sourceLimits.versions
  )
    throw Error('SourceIndex');
  const ids = new Set<string>();
  for (const v of b.versions) {
    if (
      !v ||
      Object.keys(v).sort().join() !== 'id,text' ||
      typeof v.id !== 'string' ||
      typeof v.text !== 'string' ||
      encodedBytes(v.text) > sourceLimits.record ||
      ids.has(v.id)
    )
      throw Error('SourceIndex');
    ids.add(v.id);
  }
  if ((b.head !== null && !ids.has(b.head)) || (b.head === null && ids.size))
    throw Error('SourceHead');
  const ops = new Set<string>();
  for (const a of b.acknowledgements) {
    if (
      !a ||
      Object.keys(a).sort().join() !== 'evidence,fingerprint,operationId,versionId' ||
      typeof a.operationId !== 'string' ||
      ops.has(a.operationId) ||
      typeof a.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(a.fingerprint) ||
      !ids.has(a.versionId) ||
      a.evidence?.state !== 'committed' ||
      a.evidence.operationId !== a.operationId ||
      a.evidence.adapterReceiptId !== 'geo-source:' + a.operationId
    )
      throw Error('SourceAcknowledgement');
    ops.add(a.operationId);
  }
  return b;
}
/** The guard must throw if scope/authority/revision/dirty/IME have changed.
 * Originals supplied in a captured envelope remain owned by the caller until settlement. */
export class GeoSourceEnvelopeStore {
  constructor(readonly options: { databaseName: string; artifactId: string; current(): void }) {}
  checked = async (text: string) => {
    const record = await checkedSourceEnvelope(text, this.options.artifactId);
    if (
      record.request.content.workspace?.joins.length ||
      record.request.content.workspace?.comparisons.length
    ) {
      await verifyDerivedClosure(record, bucket(await this.raw()).versions, this.options.current);
    }
    return record;
  };
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(this.options.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('artifacts');
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(Error('SourceDatabaseBlocked'));
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  private async raw(): Promise<string | undefined> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('artifacts', 'readonly');
        const request = tx.objectStore('artifacts').get(this.options.artifactId);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error ?? Error('SourceReadAbort'));
        tx.onerror = () => {};
      });
    } finally {
      db.close();
    }
  }
  async inspect() {
    const b = bucket(await this.raw());
    this.options.current();
    return {
      head: b.head,
      versionIds: b.versions.map((v) => v.id),
      versions: b.versions.length,
      bytes: encodedBytes(JSON.stringify(b)),
      acknowledgements: b.acknowledgements.length,
    };
  }
  async load(versionId?: string): Promise<GeoSourceEnvelope | undefined> {
    const b = bucket(await this.raw());
    const entry = b.versions.find((v) => v.id === (versionId ?? b.head));
    if (!entry) {
      if (versionId) throw Error('SourceVersionMissing');
      this.options.current();
      return undefined;
    }
    const record = await this.checked(entry.text);
    if (record.nativeVersion.versionId !== entry.id) throw Error('SourceVersionIdentity');
    this.options.current();
    return record;
  }
  async commit(
    candidate: GeoSourceEnvelope,
    expectedHead: string | null,
    signal: AbortSignal,
  ): Promise<SourceCommitResult> {
    // Serialize synchronously to sever caller mutation before the first await.
    let text: string;
    let record: GeoSourceEnvelope;
    let previous: string | undefined;
    let fingerprint: string;
    let head: GeoSourceEnvelope | undefined;
    let payload: string;
    try {
      text = JSON.stringify(candidate);
      record = await this.checked(text);
      // Retry identity includes capture and closure, but deliberately not freshly generated version metadata.
      fingerprint = await contentHash({ request: record.request, closure: record.closure });
      payload = canonicalJson({ content: record.request.content, closure: record.closure });
      previous = await this.raw();
      const b = bucket(previous);
      await verifyDerivedClosure(record, b.versions, this.options.current);
      const h = b.versions.find((v) => v.id === b.head);
      if (h) {
        head = await this.checked(h.text);
        if (head.nativeVersion.versionId !== h.id) throw Error('SourceVersionIdentity');
      }
      this.options.current();
      if (signal.aborted) throw Error('SourceAborted');
    } catch (error) {
      return {
        state: 'no-write',
        code: error instanceof Error ? error.message : 'SourcePreparation',
      };
    }
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch {
      return { state: 'no-write', code: 'SourceDatabase' };
    }
    try {
      return await new Promise<SourceCommitResult>((resolve) => {
        let result: SourceCommitResult = { state: 'unknown' };
        let reason = 'SourceTransactionAbort';
        const tx = db.transaction('artifacts', 'readwrite');
        const abort = () => {
          reason = 'SourceAborted';
          try {
            tx.abort();
          } catch {
            /* Completion wins; do not invent a no-write guarantee. */
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        };
        tx.onabort = () => {
          signal.removeEventListener('abort', abort);
          resolve({ state: 'no-write', code: reason });
        };
        tx.onerror = () => {};
        const store = tx.objectStore('artifacts');
        const read = store.get(this.options.artifactId);
        read.onsuccess = () => {
          try {
            // All identity/replay/CAS/count/quota checks occur in this SAME write transaction.
            const b = bucket(read.result);
            const replay = b.acknowledgements.find(
              (a) => a.operationId === record.request.operationId,
            );
            this.options.current();
            if (signal.aborted) throw Error('SourceAborted');
            if (replay) {
              if (replay.fingerprint !== fingerprint) throw Error('SourceOperationConflict');
              // A matching operation may have committed after preparation, and other
              // operations may have advanced head. Validate the CURRENT transaction's
              // complete synchronous admission and immutable payload against the already
              // hash-verified candidate; never
              // infer a no-write result from an unrelated bucket change.
              const entry = b.versions.find((v) => v.id === replay.versionId);
              const stored = entry
                ? checkedSourceEnvelopeStructure(entry.text, this.options.artifactId)
                : undefined;
              if (
                !stored ||
                stored.nativeVersion.versionId !== replay.versionId ||
                stored.nativeVersion.contentHash !== record.request.capture.contentHash ||
                stored.request?.capture?.contentHash !== record.request.capture.contentHash ||
                stored.closureHash !== record.closureHash ||
                canonicalJson({ content: stored.request.content, closure: stored.closure }) !==
                  payload ||
                JSON.stringify(replay.evidence.capture) !== JSON.stringify(record.request.capture)
              )
                throw Error('SourceAcknowledgement');
              // No-op acknowledgements deliberately refer to an earlier version's
              // request. Only this operation's ack must match the current capture.

              result = {
                state: 'committed',
                evidence: replay.evidence,
                versionId: replay.versionId,
                replay: true,
                noop: false,
              };
              return; // Replay neither consumes a version nor moves head, including after other saves.
            }
            if (b.head !== expectedHead) throw Error('SourceHeadConflict');
            if (read.result !== previous) throw Error('SourceConcurrentChange');
            const noop =
              !!head &&
              head.request.capture.contentHash === record.request.capture.contentHash &&
              head.closureHash === record.closureHash;
            let versionId = record.nativeVersion.versionId;
            if (noop) versionId = head!.nativeVersion.versionId;
            else {
              if (b.versions.some((v) => v.id === versionId)) throw Error('SourceImmutableVersion');
              if (record.nativeVersion.parentVersionId !== expectedHead)
                throw Error('SourceParent');
              if (b.versions.length >= sourceLimits.versions) throw Error('SourceVersionLimit');
              b.versions.push({ id: versionId, text });
              b.head = versionId;
            }
            const evidence: Ack['evidence'] = {
              state: 'committed',
              operationId: record.request.operationId,
              capture: record.request.capture,
              adapterReceiptId: record.receiptId,
            };
            b.acknowledgements.push({
              operationId: record.request.operationId,
              fingerprint,
              versionId,
              evidence,
            });
            // Entire bucket serialization counts immutable records, head, acknowledgements and index overhead.
            const serialized = JSON.stringify(b);
            if (encodedBytes(serialized) > sourceLimits.total) throw Error('SourceRetentionLimit');
            this.options.current();
            if (signal.aborted) throw Error('SourceAborted');
            store.put(serialized, this.options.artifactId);
            result = { state: 'committed', evidence, versionId, replay: false, noop };
          } catch (error) {
            reason = error instanceof Error ? error.message : 'SourceTransaction';
            tx.abort();
          }
        };
      });
    } catch {
      return { state: 'no-write', code: 'SourceTransactionUnavailable' };
    } finally {
      db.close();
    }
  }
}
