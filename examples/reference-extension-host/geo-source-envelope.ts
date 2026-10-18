/** Host-private experimental format. Never passed through Basic/controlled messages. */
import { contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { assertGeo, type GeoDocument, type Pin } from '@editor-platform/geo-core';
import { assertGeoSaveCapacity } from '@editor-platform/geo-inspector/point-save';
import type { WriteRequest } from '@editor-platform/extension-runtime/draft2';
export const sourceBudgets = {
  actions: 10,
  bytes: 65536,
  depth: 24,
  layers: 10,
  features: 200,
  vertices: 1000,
};
export const sourceLimits = {
  originals: 100000,
  record: 262144,
  versions: 16,
  total: 4194304,
  sources: 10,
};
export interface SourceManifest {
  schemaVersion: 1;
  name: string;
  format: 'csv' | 'geojson' | 'png' | 'jpeg';
  byteLength: number;
  bytesHash: string;
}
export interface SourceClosure {
  sourceId: string;
  resourceId: string;
  pin: Pin;
  sourceVersion: ArtifactVersion<SourceManifest>;
  /** Exact explicit import mapping, axis, field types and exclusion decision. */
  recipe: { [key: string]: unknown };
  encoding: 'base64';
  bytes: string;
}
export interface GeoSourceEnvelope {
  format: 'geo-source-envelope@0-experiment';
  request: WriteRequest<GeoDocument>;
  nativeVersion: Omit<ArtifactVersion<GeoDocument>, 'content'>;
  closure: SourceClosure[];
  closureHash: string;
  receiptId: string;
}
export const encodedBytes = (text: string) => new TextEncoder().encode(text).length;
function requireValue(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error(code);
}
function exact(v: unknown, keys: string[]): asserts v is { [key: string]: unknown } {
  requireValue(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join() === [...keys].sort().join(),
    'SourceEnvelopeShape',
  );
}
const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const metadataKeys = [
  'artifactId',
  'versionId',
  'parentVersionId',
  'schemaVersion',
  'contentHash',
  'createdAt',
  'createdBy',
  'reason',
];
function metadata(value: unknown, withContent: boolean) {
  exact(value, [...metadataKeys, ...(withContent ? ['content'] : [])]);
  requireValue(
    id(value.artifactId) &&
      id(value.versionId) &&
      (value.parentVersionId === null || id(value.parentVersionId)) &&
      value.schemaVersion === 1 &&
      hash(value.contentHash) &&
      typeof value.createdAt === 'string' &&
      value.createdAt.length <= 128 &&
      Number.isFinite(Date.parse(value.createdAt)) &&
      (value.createdBy === null || id(value.createdBy)) &&
      (value.reason === null || id(value.reason)),
    'SourceVersionMetadata',
  );
}
export function decodeOriginal(text: string): Uint8Array {
  requireValue(
    typeof text === 'string' &&
      text.length <= Math.ceil(sourceLimits.originals / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text),
    'SourceEncoding',
  );
  const raw = atob(text);
  requireValue(btoa(raw) === text, 'SourceEncoding');
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
export async function originalHash(bytes: Uint8Array) {
  return (
    'sha256:' +
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
/** Complete synchronous read admission, excluding cryptographic recomputation.
 * Replay may use this inside an IDB transaction ONLY with full canonical native/closure
 * equality to a candidate already verified by checkedSourceEnvelope. Not hash evidence. */
export function checkedSourceEnvelopeStructure(
  text: string,
  artifactId: string,
): GeoSourceEnvelope {
  requireValue(
    typeof text === 'string' && encodedBytes(text) <= sourceLimits.record,
    'SourceRecordLimit',
  );
  const v: unknown = JSON.parse(text);
  exact(v, ['format', 'request', 'nativeVersion', 'closure', 'closureHash', 'receiptId']);
  requireValue(v.format === 'geo-source-envelope@0-experiment', 'SourceFormat');
  exact(v.request, ['operationId', 'capture', 'content']);
  const r = v.request;
  requireValue(
    id(r.operationId) &&
      v.receiptId === 'geo-source:' + r.operationId &&
      (v.receiptId as string).length <= 128,
    'SourceReceipt',
  );
  exact(r.capture, ['scope', 'revision', 'contentHash']);
  const c = r.capture;
  exact(c.scope, ['artifactId', 'sessionId', 'generation']);
  exact(c.revision, ['kind', 'sessionId', 'sequence']);
  requireValue(
    c.scope.artifactId === artifactId &&
      Object.values(c.scope).every(id) &&
      c.revision.kind === 'local-draft' &&
      c.revision.sessionId === c.scope.sessionId &&
      Number.isSafeInteger(c.revision.sequence) &&
      (c.revision.sequence as number) >= 0 &&
      hash(c.contentHash),
    'SourceCapture',
  );
  assertGeo(r.content, sourceBudgets);
  const record = v as unknown as GeoSourceEnvelope;
  assertGeoSaveCapacity({ ...record.request.capture, content: record.request.content });
  metadata(v.nativeVersion, false);
  requireValue(
    record.nativeVersion.artifactId === artifactId &&
      record.nativeVersion.contentHash === c.contentHash,
    'SourceNativeHash',
  );
  requireValue(
    Array.isArray(v.closure) &&
      v.closure.length <= sourceLimits.sources &&
      v.closure.length === r.content.sources.length,
    'SourceClosureCount',
  );
  let total = 0;
  const seen = new Set<string>(),
    resources = new Set<string>();
  for (const entry of record.closure) {
    exact(entry, ['sourceId', 'resourceId', 'pin', 'sourceVersion', 'recipe', 'encoding', 'bytes']);
    exact(entry.pin, ['artifactId', 'versionId', 'contentHash']);
    requireValue(
      id(entry.sourceId) &&
        id(entry.resourceId) &&
        !seen.has(entry.sourceId) &&
        !resources.has(entry.resourceId) &&
        entry.encoding === 'base64',
      'SourceClosureIdentity',
    );
    seen.add(entry.sourceId);
    resources.add(entry.resourceId);
    metadata(entry.sourceVersion, true);
    const manifest = entry.sourceVersion.content;
    exact(manifest, ['schemaVersion', 'name', 'format', 'byteLength', 'bytesHash']);
    requireValue(
      manifest.schemaVersion === 1 &&
        id(manifest.name) &&
        ['csv', 'geojson', 'png', 'jpeg'].includes(manifest.format) &&
        Number.isSafeInteger(manifest.byteLength) &&
        manifest.byteLength >= 0,
      'SourceManifest',
    );
    requireValue(
      entry.recipe && typeof entry.recipe === 'object' && !Array.isArray(entry.recipe),
      'SourceRecipe',
    );
    const bytes = decodeOriginal(entry.bytes);
    total += bytes.length;
    requireValue(
      total <= sourceLimits.originals && bytes.length === manifest.byteLength,
      'SourceOriginalHash',
    );
    const version = entry.sourceVersion;
    requireValue(
      entry.pin.artifactId === version.artifactId &&
        entry.pin.versionId === version.versionId &&
        entry.pin.contentHash === 'sha256:' + version.contentHash,
      'SourceManifestHash',
    );
    const source = r.content.sources.find((s) => s.id === entry.sourceId);
    requireValue(
      source &&
        source.resourceId === entry.resourceId &&
        source.bytesHash === manifest.bytesHash &&
        source.format === manifest.format &&
        source.pin.artifactId === entry.pin.artifactId &&
        source.pin.versionId === entry.pin.versionId &&
        source.pin.contentHash === entry.pin.contentHash,
      'SourceClosureCorrespondence',
    );
  }
  requireValue(hash(v.closureHash), 'SourceClosureHash');
  return record;
}

/** Read admission is the same as write admission; do not trust stored hashes or counts. */
export async function checkedSourceEnvelope(
  text: string,
  artifactId: string,
): Promise<GeoSourceEnvelope> {
  const record = checkedSourceEnvelopeStructure(text, artifactId);
  requireValue(
    (await contentHash(record.request.content)) === record.request.capture.contentHash,
    'SourceNativeHash',
  );
  for (const entry of record.closure) {
    requireValue(
      (await originalHash(decodeOriginal(entry.bytes))) === entry.sourceVersion.content.bytesHash,
      'SourceOriginalHash',
    );
    requireValue(
      (await contentHash(entry.sourceVersion.content)) === entry.sourceVersion.contentHash,
      'SourceManifestHash',
    );
  }
  requireValue((await contentHash(record.closure)) === record.closureHash, 'SourceClosureHash');
  return record;
}
