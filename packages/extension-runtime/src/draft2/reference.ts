/** Host/test fixtures only; all storage and byte retention are volatile. */
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import type {
  DefinitionD2,
  Grant,
  ManifestD2,
  ResourceBounds,
  ResourceIdentity,
  SaveCapture,
} from '@editor-platform/extension-contract/draft2';
import type {
  Binding,
  ResourceProvider,
  RawLease,
  Storage,
  WriteEvidence,
  WriteRequest,
} from '../draft2';
import { copyData, deferred, requireThat, type Clock } from './primitives';
export { deferred } from './primitives';
export class ManualClock implements Clock {
  private time = 0;
  private listeners = new Set<() => void>();
  now = () => this.time;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  advanceTo(value: number) {
    requireThat(Number.isFinite(value) && value >= this.time, 'MonotonicClock');
    this.time = value;
    for (const listener of [...this.listeners]) listener();
  }
}
export class FakeStorage<T> implements Storage<T> {
  settlementMs = 100;
  private requestEvent = deferred<WriteRequest<T>>();
  nextRequest() {
    return this.requestEvent.promise;
  }
  requests: WriteRequest<T>[] = [];
  writes: WriteRequest<T>[] = [];
  saved: SaveCapture[] = [];
  holds = 0;
  beforeDispatch?: () => Promise<void>;
  private pending = new Map<string, ReturnType<typeof deferred<WriteEvidence>>>();
  private fenced = new Set<string>();
  constructor(readonly key: string) {}
  write = (request: WriteRequest<T>, _signal: AbortSignal) => {
    const result = deferred<WriteEvidence>();
    this.requests.push(copyData(request));
    this.requestEvent.resolve(copyData(request));
    this.requestEvent = deferred<WriteRequest<T>>();
    this.pending.set(request.operationId, result);
    return result.promise;
  };
  retainCapture = () => {
    this.holds++;
    return () => {
      this.holds--;
    };
  };
  markSaved = (capture: SaveCapture) => {
    this.saved.push(copyData(capture));
  };
  evidence(operationId: string): WriteEvidence {
    const request = this.requests.find((request) => request.operationId === operationId);
    requireThat(request, 'UnknownOperation');
    return {
      state: 'committed',
      operationId,
      capture: copyData(request.capture),
      adapterReceiptId: `fake:${operationId}`,
    };
  }
  commit(operationId: string, ack = true) {
    requireThat(!this.fenced.has(operationId), 'Fenced');
    const request = this.requests.find((request) => request.operationId === operationId);
    requireThat(request, 'UnknownOperation');
    if (!this.writes.some((write) => write.operationId === operationId))
      this.writes.push(copyData(request));
    if (ack) this.ack(operationId, this.evidence(operationId));
  }
  ack(operationId: string, evidence: WriteEvidence) {
    this.pending.get(operationId)!.resolve(evidence);
  }
  noWrite(operationId: string) {
    requireThat(!this.writes.some((write) => write.operationId === operationId), 'AlreadyWritten');
    this.fenced.add(operationId);
    const request = this.requests.find((request) => request.operationId === operationId)!;
    this.ack(operationId, {
      state: 'no-write',
      operationId,
      capture: request.capture,
      guarantee: 'never-writes',
    });
  }
  fail(operationId: string, error: unknown = new Error('transport')) {
    this.pending.get(operationId)!.reject(error);
  }
}
export class FakeResources implements ResourceProvider<string> {
  bounds: ResourceBounds = { maxReadBytes: 8, maxTotalBytes: 16, maxReads: 4, maxPendingReads: 2 };
  catalog = new Map<string, { identity: ResourceIdentity<string>; bytes: Uint8Array }>();
  active = 0;
  opens = 0;
  releases = 0;
  openGate?: Promise<void>;
  readGate?: Promise<void>;
  releaseGate?: Promise<void>;
  shortRead = false;
  maxLeases = 4;
  async add(ref: string, bytes: Uint8Array): Promise<ResourceIdentity<string>> {
    const copy = bytes.slice();
    const digest = await crypto.subtle.digest('SHA-256', copy);
    const identity = {
      ref,
      sha256: Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join(''),
      byteLength: copy.length,
    };
    this.catalog.set(ref, { identity: copyData(identity), bytes: copy });
    return identity;
  }
  async open(expected: ResourceIdentity<string>, _signal: AbortSignal): Promise<RawLease<string>> {
    const entry = this.catalog.get(expected.ref);
    requireThat(
      entry && JSON.stringify(entry.identity) === JSON.stringify(expected),
      'CatalogMismatch',
    );
    requireThat(this.active < this.maxLeases, 'ResourceCapacity');
    this.active++;
    this.opens++;
    try {
      await this.openGate;
    } catch (error) {
      this.active--;
      throw error;
    }
    let released = false;
    return {
      identity: copyData(entry.identity),
      read: async (offset, length, _signal) => {
        await this.readGate;
        return entry.bytes.slice(offset, offset + length - (this.shortRead ? 1 : 0));
      },
      release: async () => {
        if (released) return;
        released = true;
        this.releases++;
        await this.releaseGate;
        this.active--;
      },
    };
  }
}
export function referenceBinding<T>(
  content: T,
  artifactId = 'toy',
): Binding<T, string> & { setGrants(values: readonly Grant[]): void } {
  let grants = new Set<Grant>(['artifact:read', 'artifact:edit', 'artifact:save', 'resource:read']);
  const listeners = new Set<() => void>();
  return {
    artifactId,
    artifactKind: 'toy',
    schemaVersion: 1,
    session: new EditorSession(content),
    inputs: new EditorInputs(),
    allowed: (grant) => grants.has(grant),
    subscribePermissions: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setGrants: (values) => {
      grants = new Set(values);
      for (const listener of [...listeners]) listener();
    },
    recovery: {
      codecs: [{ id: 'toy', version: '1' }],
      perBoundaryBytes: 2048,
      totalBytes: 8192,
      ttlMs: 1000,
      onRevoke: 'retain',
    },
  };
}
export const toyManifest: ManifestD2 = {
  id: 'toy',
  version: '1',
  packageHash: 'a'.repeat(64),
  contractVersion: '1.0.0-draft.2',
  artifactKind: 'toy',
  schemaVersion: 1,
  surface: false,
  permissions: ['artifact:read', 'artifact:edit', 'artifact:save', 'resource:read'],
  addons: {
    edit: { version: 'local-edit@0-draft', requirement: 'required' },
    inputs: { version: 'inputs@0-draft', requirement: 'required' },
    lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    save: { version: 'local-persistence@0-draft', requirement: 'optional' },
    resources: { version: 'resources@0-draft', requirement: 'optional' },
  },
  licenseNotices: [],
};
export function toyDefinition(
  manifest: ManifestD2 = copyData(toyManifest),
): DefinitionD2<{ value: number }, string> {
  return {
    manifest,
    validate: (value): value is { value: number } =>
      !!value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      'value' in value &&
      typeof value.value === 'number' &&
      Number.isFinite(value.value),
  };
}
