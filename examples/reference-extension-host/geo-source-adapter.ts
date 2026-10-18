/** Host-owned closure retention over the existing SaveCoordinator lifecycle. */
import { contentHash } from '@editor-platform/artifact-core';
import type { GeoDocument } from '@editor-platform/geo-core';
import type { LocalReadSnapshot, SaveCapture } from '@editor-platform/extension-contract/draft2';
import type {
  Storage,
  WriteRequest,
  WriteEvidence,
} from '@editor-platform/extension-runtime/draft2';
import {
  GeoSourceEnvelopeStore,
  type GeoSourceEnvelope,
  type SourceClosure,
  sourceLimits,
  encodedBytes,
} from './geo-source-storage';
const captureKey = (value: Pick<LocalReadSnapshot<GeoDocument>, 'scope' | 'revision'>) =>
  JSON.stringify([value.scope, value.revision]);
/** Synchronous final import admission; metadata reserves the actual adapter's worst shape.
 * Hashes are fixed-length placeholders here, then recomputed and checked before writing. */
export function assertSourceCaptureCapacity(
  snapshot: LocalReadSnapshot<GeoDocument>,
  closure: SourceClosure[],
) {
  const uuid = 'f'.repeat(36),
    hash = 'f'.repeat(64);
  const request = {
    operationId: uuid,
    capture: {
      scope: snapshot.scope,
      revision: { ...snapshot.revision, sequence: Number.MAX_SAFE_INTEGER },
      contentHash: hash,
    },
    content: snapshot.content,
  };
  const candidate: GeoSourceEnvelope = {
    format: 'geo-source-envelope@0-experiment',
    request,
    nativeVersion: {
      artifactId: snapshot.scope.artifactId,
      versionId: uuid,
      parentVersionId: uuid,
      schemaVersion: 1,
      contentHash: hash,
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: null,
      reason: 'Save captured native and originals',
    },
    closure,
    closureHash: hash,
    receiptId: 'geo-source:' + uuid,
  };
  if (encodedBytes(JSON.stringify(candidate)) > sourceLimits.record)
    throw Error('SourceRecordLimit');
}
export class GeoSourceStorage implements Storage<GeoDocument> {
  readonly settlementMs = 3000;
  readonly key: string;
  head: string | null = null;
  saved?: SaveCapture;
  writes = 0;
  lastEvidence?: WriteEvidence;
  lastCode?: string;
  mode: 'normal' | 'no-write' | 'uncertain' | 'delayed' = 'normal';
  pauseBefore = false;
  pendingBefore?: () => void;
  pending?: () => void;
  private captures = new Map<string, { closure: SourceClosure[]; expectedHead: string | null }>();
  constructor(
    readonly options: {
      key: string;
      databaseName: string;
      current(snapshot?: LocalReadSnapshot<GeoDocument>): void;
      closure(content: GeoDocument): SourceClosure[];
    },
  ) {
    this.key = options.key;
  }
  private store(snapshot?: LocalReadSnapshot<GeoDocument>) {
    return new GeoSourceEnvelopeStore({
      databaseName: this.options.databaseName,
      artifactId: this.key,
      current: () => this.options.current(snapshot),
    });
  }
  get retained() {
    return this.captures.size;
  }
  retainCapture = (snapshot: LocalReadSnapshot<GeoDocument>) => {
    this.options.current(snapshot);
    const key = captureKey(snapshot);
    if (this.captures.has(key)) throw Error('SourceCaptureAlreadyRetained');
    // Synchronous ownership transfer precedes SaveCoordinator hashing/dispatch.
    // This copy is independent of the live UI map cleared on scope loss.
    const retained = {
      closure: structuredClone(this.options.closure(snapshot.content)),
      expectedHead: this.head,
    };
    this.captures.set(key, retained);
    return () => {
      if (this.captures.get(key) === retained) this.captures.delete(key);
    };
  };
  beforeDispatch = async () => {
    if (this.pauseBefore)
      await new Promise<void>((resolve) => {
        this.pendingBefore = resolve;
      });
  };
  async write(request: WriteRequest<GeoDocument>, signal: AbortSignal): Promise<WriteEvidence> {
    const noWrite = (): WriteEvidence => ({
      state: 'no-write',
      operationId: request.operationId,
      capture: request.capture,
      guarantee: 'never-writes',
    });
    if (signal.aborted || this.mode === 'no-write') return noWrite();
    const captured = this.captures.get(captureKey(request.capture));
    if (!captured) {
      this.lastCode = 'SourceCaptureMissing';
      return noWrite();
    }
    const mode = this.mode;
    const snapshot = { ...request.capture, content: request.content };
    let envelope: GeoSourceEnvelope;
    try {
      const closure = structuredClone(captured.closure);
      envelope = {
        format: 'geo-source-envelope@0-experiment',
        request,
        nativeVersion: {
          artifactId: this.key,
          versionId: crypto.randomUUID(),
          parentVersionId: captured.expectedHead,
          schemaVersion: 1,
          contentHash: request.capture.contentHash,
          createdAt: new Date().toISOString(),
          createdBy: null,
          reason: 'Save captured native and originals',
        },
        closure,
        closureHash: await contentHash(closure),
        receiptId: 'geo-source:' + request.operationId,
      };
      this.options.current(snapshot);
    } catch (error) {
      this.lastCode = String(error);
      return noWrite();
    }
    const result = await this.store(snapshot).commit(envelope, captured.expectedHead, signal);
    if (result.state === 'no-write') {
      this.lastCode = result.code;
      return noWrite();
    }
    if (result.state === 'unknown') return result;
    this.lastCode = undefined;
    this.lastEvidence = result.evidence;
    if (!result.replay && !result.noop) this.writes++;
    // A replay must never advance the head to its historical version.
    if (!result.replay) this.head = result.versionId;
    if (mode === 'delayed')
      await new Promise<void>((resolve) => {
        this.pending = resolve;
      });
    if (mode === 'uncertain') return { state: 'unknown' };
    return result.evidence;
  }
  markSaved = (capture: SaveCapture) => {
    this.saved = structuredClone(capture);
  };
  inspect = () => this.store().inspect();
  checked = async (text: string) => {
    const record = await this.store().checked(text);
    this.options.current();
    return record;
  };
  async read(versionId?: string) {
    const store = this.store();
    const before = await store.inspect();
    const record = await store.load(versionId ?? before.head ?? undefined);
    const after = await store.inspect();
    if (before.head !== after.head || before.bytes !== after.bytes)
      throw Error('SourceReadConflict');
    this.options.current();
    return { record, head: after.head };
  }
  async load(versionId?: string) {
    const { record, head } = await this.read(versionId);
    this.head = head;
    return record;
  }
  async raw() {
    const { record } = await this.read();
    return record ? JSON.stringify(record) : undefined;
  }
}
