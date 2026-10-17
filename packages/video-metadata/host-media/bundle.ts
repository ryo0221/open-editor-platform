/** First bounded single-file Host scaffold. Not ZIP64 or a permanent public format. */
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { assertVideoContent, type VideoContent } from '@editor-platform/video-core';
import type { LocalReadSnapshot, SaveCapture } from '@editor-platform/extension-contract/draft2';
import type {
  Storage,
  WriteRequest,
  WriteEvidence,
} from '@editor-platform/extension-runtime/draft2';
import { digest, prepareImportSet, type ImportSet, type OriginalStore } from './import';
export const BUNDLE_LIMIT = 32 * 1024 * 1024;
// Eight maximum native envelopes, one maximum manifest and framing always fit.
export const ORIGINAL_STORE_LIMIT = BUNDLE_LIMIT - 9 * 65536 - 8;
const PLAN_STORE_LIMIT = 24 * 1024;
export class MediaStore implements OriginalStore {
  private blobs = new Map<string, Blob>();
  private plans = new Map<string, ImportSet>();
  get(hash: string) {
    return this.blobs.get(hash);
  }
  put(hash: string, bytes: Blob) {
    const total = [...this.blobs].reduce(
      (n, [key, blob]) => n + (key === hash ? 0 : blob.size),
      bytes.size,
    );
    need(
      total <= ORIGINAL_STORE_LIMIT && (this.blobs.has(hash) || this.blobs.size < 100),
      'Host original quota',
    );
    const old = this.blobs.get(hash);
    need(!old || old.size === bytes.size, 'Original identity collision');
    this.blobs.set(hash, bytes);
  }
  delete(hash: string) {
    this.blobs.delete(hash);
  }
  getPlan(id: string) {
    const p = this.plans.get(id);
    return p ? structuredClone(p) : undefined;
  }
  putPlan(id: string, p: ImportSet) {
    need(this.plans.has(id) || this.plans.size < 100, 'Host interpretation quota');
    const next = new Map(this.plans);
    next.set(id, structuredClone(p));
    need(
      new TextEncoder().encode(
        JSON.stringify([...next].map(([sourceId, plan]) => ({ sourceId, plan }))),
      ).length <= PLAN_STORE_LIMIT,
      'Host interpretation byte quota',
    );
    this.plans = next;
  }
  deletePlan(id: string) {
    this.plans.delete(id);
  }
}
interface Entry {
  id: string;
  kind: 'version' | 'original';
  sha256: string;
  byteLength: number;
}
interface Manifest {
  format: 'video-host-bundle-scaffold-v0';
  operationId: string;
  capture: SaveCapture;
  selectedVersionId: string;
  entries: Entry[];
  plans: { sourceId: string; plan: ImportSet }[];
}
export interface OpenedBundle {
  manifest: Manifest;
  versions: ArtifactVersion<VideoContent>[];
  selected: ArtifactVersion<VideoContent>;
  store: MediaStore;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const validHash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  need(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join() === keys.sort().join(),
    'Bundle fields',
  );
}
export async function openBundle(bundle: Blob, signal: AbortSignal): Promise<OpenedBundle> {
  signal.throwIfAborted();
  need(bundle.size >= 8 && bundle.size <= BUNDLE_LIMIT, 'Bundle budget');
  const header = new DataView(await bundle.slice(0, 8).arrayBuffer());
  need(header.getUint32(0) === 0x56425030, 'Bundle format');
  const length = header.getUint32(4);
  need(length > 0 && length <= 65536 && length + 8 <= bundle.size, 'Manifest length');
  const value: unknown = JSON.parse(
    decoder.decode(await bundle.slice(8, 8 + length).arrayBuffer()),
  );
  fields(value, ['format', 'operationId', 'capture', 'selectedVersionId', 'entries', 'plans']);
  need(
    value.format === 'video-host-bundle-scaffold-v0' &&
      typeof value.operationId === 'string' &&
      typeof value.selectedVersionId === 'string' &&
      Array.isArray(value.entries) &&
      value.entries.length <= 108 &&
      Array.isArray(value.plans) &&
      value.plans.length <= 100,
    'Manifest shape',
  );
  const manifest = value as unknown as Manifest,
    store = new MediaStore(),
    versions: ArtifactVersion<VideoContent>[] = [],
    ids = new Set<string>();
  let offset = 8 + length;
  for (const entry of manifest.entries) {
    fields(entry, ['id', 'kind', 'sha256', 'byteLength']);
    need(
      typeof entry.id === 'string' &&
        !ids.has(entry.id) &&
        validHash(entry.sha256) &&
        Number.isSafeInteger(entry.byteLength) &&
        entry.byteLength > 0 &&
        entry.byteLength <= BUNDLE_LIMIT,
      'Entry identity/size',
    );
    ids.add(entry.id);
    need(offset + entry.byteLength <= bundle.size, 'Missing entry bytes');
    const blob = bundle.slice(offset, offset + entry.byteLength);
    offset += entry.byteLength;
    need((await digest(blob)) === entry.sha256, 'Entry digest mismatch');
    signal.throwIfAborted();
    if (entry.kind === 'original') {
      need(entry.id === 'original:' + entry.sha256, 'Original identity');
      store.put(entry.sha256, blob);
    } else {
      need(entry.kind === 'version' && entry.byteLength <= 65536, 'Version entry');
      const raw: unknown = JSON.parse(decoder.decode(await blob.arrayBuffer()));
      fields(raw, [
        'artifactId',
        'versionId',
        'parentVersionId',
        'schemaVersion',
        'content',
        'contentHash',
        'createdAt',
        'createdBy',
        'reason',
      ]);
      const v = raw as unknown as ArtifactVersion<VideoContent>;
      assertVideoContent(v.content);
      need(
        typeof v.artifactId === 'string' &&
          typeof v.versionId === 'string' &&
          entry.id === 'version:' + v.versionId &&
          (v.parentVersionId === null || typeof v.parentVersionId === 'string') &&
          v.schemaVersion === 1 &&
          typeof v.createdAt === 'string' &&
          (v.createdBy === null || typeof v.createdBy === 'string') &&
          (v.reason === null || typeof v.reason === 'string') &&
          (await contentHash(v.content)) === v.contentHash,
        'Native envelope/hash',
      );
      versions.push(v);
    }
  }
  need(offset === bundle.size, 'Trailing bytes');
  const selected = versions.find((v) => v.versionId === manifest.selectedVersionId);
  need(selected && versions.length <= 8, 'Selected/retained versions');
  fields(manifest.capture, ['scope', 'revision', 'contentHash']);
  fields(manifest.capture.scope, ['artifactId', 'sessionId', 'generation']);
  fields(manifest.capture.revision, ['kind', 'sessionId', 'sequence']);
  need(
    Object.values(manifest.capture.scope).every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
    ) &&
      manifest.capture.scope.artifactId === selected.artifactId &&
      manifest.capture.revision.kind === 'local-draft' &&
      typeof manifest.capture.revision.sessionId === 'string' &&
      manifest.capture.revision.sessionId.length > 0 &&
      Number.isSafeInteger(manifest.capture.revision.sequence) &&
      manifest.capture.revision.sequence >= 0,
    'Capture scope/revision',
  );
  need(manifest.operationId.length > 0 && manifest.operationId.length <= 256, 'Operation identity');
  need(manifest.capture.contentHash === selected.contentHash, 'Capture canonical hash');
  const versionIds = new Set(versions.map((v) => v.versionId));
  for (const v of versions) {
    need(
      v.artifactId === selected.artifactId &&
        (v.parentVersionId === null || versionIds.has(v.parentVersionId)),
      'Missing retained parent',
    );
    let next: ArtifactVersion<VideoContent> | undefined = v;
    const seen = new Set<string>();
    while (next) {
      need(!seen.has(next.versionId), 'Version cycle');
      seen.add(next.versionId);
      next = versions.find((p) => p.versionId === next!.parentVersionId);
    }
  }
  const planIds = new Set<string>();
  for (const p of manifest.plans) {
    fields(p, ['sourceId', 'plan']);
    need(typeof p.sourceId === 'string' && !planIds.has(p.sourceId), 'Duplicate source plan');
    planIds.add(p.sourceId);
    store.putPlan(p.sourceId, p.plan);
  }
  const required = new Set<string>(),
    sources = new Set<string>();
  for (const v of versions)
    for (const source of v.content.sources) {
      sources.add(source.id);
      required.add(source.asset.sha256);
      const original = store.get(source.asset.sha256),
        plan = store.getPlan(source.id);
      need(
        original && original.size === source.asset.byteLength && plan,
        'Missing original/interpretation closure',
      );
      // Reuse pure import validation to validate the entire selected A/V set. No partial activation.
      const empty: VideoContent = {
        schema: 'video-core-prototype-v0',
        sources: [],
        sequence: {
          id: 'verify-sequence',
          duration: { value: 0, timescale: 1 },
          frameRate: { value: 25, timescale: 1 },
          clips: [],
          tracks: plan.streams.map((s) => ({
            id: s.destination,
            kind: s.kind === 'video' ? ('visual' as const) : ('audio' as const),
            locked: false,
            enabled: true,
          })),
        },
      };
      const verified = prepareImportSet(empty, plan, source.asset, source.id);
      need(
        canonicalJson(verified.sources[0]) === canonicalJson(source),
        'Interpretation/native mismatch',
      );
    }
  need(
    manifest.entries.filter((e) => e.kind === 'original').length === required.size &&
      planIds.size === sources.size,
    'Unexpected closure entries',
  );
  signal.throwIfAborted();
  return { manifest, versions, selected, store };
}
export interface BundleStage {
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  read(): Promise<Blob>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}
export interface BundleTarget {
  begin(operationId: string): Promise<BundleStage>;
  inspect(operationId: string): Promise<Blob | undefined | 'unknown'>;
}
interface Pin {
  selectedVersionId: string | null;
  versions: ArtifactVersion<VideoContent>[];
  assets: Map<string, Blob>;
  plans: Map<string, ImportSet>;
}
const snapshotKey = (s: { scope: unknown; revision: unknown }) =>
  JSON.stringify([s.scope, s.revision]);
export class VideoBundleStorage implements Storage<VideoContent> {
  readonly settlementMs = 30000;
  private pins = new Map<string, Pin>();
  private pending = new Map<
    string,
    { request: WriteRequest<VideoContent>; hash: string; settled?: WriteEvidence }
  >();
  private reconciling = new Map<string, Promise<WriteEvidence>>();
  versions: ArtifactVersion<VideoContent>[] = [];
  selectedVersionId: string | null = null;
  constructor(
    readonly key: string,
    readonly store: OriginalStore,
    readonly target: BundleTarget,
  ) {}
  retainCapture(snapshot: LocalReadSnapshot<VideoContent>) {
    need(snapshot.scope.artifactId === this.key, 'Foreign capture scope');
    const versions = structuredClone(this.versions),
      assets = new Map<string, Blob>(),
      plans = new Map<string, ImportSet>();
    for (const content of [snapshot.content, ...versions.map((v) => v.content)]) {
      assertVideoContent(content);
      for (const s of content.sources) {
        const blob = this.store.get(s.asset.sha256),
          plan = this.store.getPlan(s.id);
        need(blob && blob.size === s.asset.byteLength && plan, 'Missing captured original');
        assets.set(s.asset.sha256, blob);
        plans.set(s.id, plan);
      }
    }
    need(
      versions.length === 0
        ? this.selectedVersionId === null
        : versions.some((v) => v.versionId === this.selectedVersionId),
      'Missing selected native root',
    );
    const key = snapshotKey(snapshot);
    need(!this.pins.has(key), 'Capture already pinned');
    this.pins.set(key, { versions, assets, plans, selectedVersionId: this.selectedVersionId });
    return () => {
      this.pins.delete(key);
    };
  }
  async write(request: WriteRequest<VideoContent>, signal: AbortSignal): Promise<WriteEvidence> {
    let stage: BundleStage | undefined,
      attempted = false;
    const noWrite = (): WriteEvidence => ({
      state: 'no-write',
      operationId: request.operationId,
      capture: request.capture,
      guarantee: 'never-writes',
    });
    try {
      signal.throwIfAborted();
      const pin = this.pins.get(snapshotKey(request.capture));
      need(pin && request.capture.scope.artifactId === this.key, 'Missing retained capture');
      need(
        !this.pending.has(request.operationId) && this.pending.size < 64,
        'Operation reused/budget',
      );
      need(
        (await contentHash(request.content)) === request.capture.contentHash,
        'Capture mismatch',
      );
      need(pin.versions.length < 8, 'Retained version budget');
      const version: ArtifactVersion<VideoContent> = {
        artifactId: this.key,
        versionId: 'version:' + request.operationId,
        parentVersionId: pin.selectedVersionId,
        schemaVersion: 1,
        content: request.content,
        contentHash: request.capture.contentHash,
        createdAt: new Date().toISOString(),
        createdBy: null,
        reason: 'Captured Video project save',
      };
      const versions = [...pin.versions, version],
        entries: Entry[] = [],
        payload: Blob[] = [];
      for (const v of versions) {
        const blob = new Blob([JSON.stringify(v)]);
        need(blob.size <= 65536, 'Native envelope budget');
        entries.push({
          id: 'version:' + v.versionId,
          kind: 'version',
          byteLength: blob.size,
          sha256: await digest(blob),
        });
        payload.push(blob);
      }
      for (const [hash, blob] of pin.assets) {
        need((await digest(blob)) === hash, 'Captured original digest mismatch');
        entries.push({
          id: 'original:' + hash,
          kind: 'original',
          byteLength: blob.size,
          sha256: hash,
        });
        payload.push(blob);
      }
      const manifest: Manifest = {
          format: 'video-host-bundle-scaffold-v0',
          operationId: request.operationId,
          capture: request.capture,
          selectedVersionId: version.versionId,
          entries,
          plans: [...pin.plans].map(([sourceId, plan]) => ({ sourceId, plan })),
        },
        text = encoder.encode(JSON.stringify(manifest));
      need(text.length <= 65536, 'Manifest budget');
      const header = new Uint8Array(8);
      new DataView(header.buffer).setUint32(0, 0x56425030);
      new DataView(header.buffer).setUint32(4, text.length);
      const bundle = new Blob([header, text, ...payload]);
      need(bundle.size <= BUNDLE_LIMIT, 'Bundle staging budget');
      stage = await this.target.begin(request.operationId);
      const reader = bundle.stream().getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          await stage.write(chunk.value, signal);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const readback = await stage.read();
      await openBundle(readback, signal);
      const hash = await digest(bundle);
      need((await digest(readback)) === hash, 'Staging readback mismatch');
      signal.throwIfAborted();
      this.pending.set(request.operationId, { request: structuredClone(request), hash });
      attempted = true;
      await stage.commit();
      return this.reconcile(request.operationId);
    } catch {
      if (!attempted) {
        await stage?.abort();
        return noWrite();
      }
      return { state: 'unknown' };
    }
  }
  async reconcile(operationId: string): Promise<WriteEvidence> {
    const pending = this.pending.get(operationId);
    need(pending, 'Unknown bundle operation');
    if (pending.settled) return structuredClone(pending.settled);
    const existing = this.reconciling.get(operationId);
    if (existing) return existing;
    // Register before invoking any Host callback, including synchronous reentry.
    const job = Promise.resolve()
      .then(() => this.readReceipt(operationId))
      .finally(() => {
        if (this.reconciling.get(operationId) === job) this.reconciling.delete(operationId);
      });
    this.reconciling.set(operationId, job);
    return job;
  }
  private async readReceipt(operationId: string): Promise<WriteEvidence> {
    const pending = this.pending.get(operationId)!;
    if (pending.settled) return structuredClone(pending.settled);
    const actual = await this.target.inspect(operationId);
    if (!actual || actual === 'unknown') return { state: 'unknown' };
    if ((await digest(actual)) !== pending.hash) return { state: 'unknown' };
    const verified = await openBundle(actual, new AbortController().signal);
    need(
      verified.manifest.operationId === operationId &&
        JSON.stringify(verified.manifest.capture) === JSON.stringify(pending.request.capture),
      'Bundle correlation',
    );
    if (pending.settled) return structuredClone(pending.settled);
    this.versions = structuredClone(verified.versions);
    this.selectedVersionId = verified.selected.versionId;
    pending.settled = {
      state: 'committed',
      operationId,
      capture: pending.request.capture,
      adapterReceiptId: 'verified-bundle:' + pending.hash,
    };
    return structuredClone(pending.settled);
  }
}
