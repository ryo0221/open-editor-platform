/** Private Playground resource closure, separate from Geo's pure native document. */
import { contentHash, canonicalJson } from '@editor-platform/artifact-core';
import {
  assertGeo,
  createPinnedGeoJoinBetween,
  compareGeoVersions,
  type GeoDocument,
  type Pin,
} from '@editor-platform/geo-core';
import {
  isStructuredData,
  cellValue,
  validateData,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import type { StoredArtifact } from '../model';
import {
  sourceBudgets,
  decodeOriginal,
  originalHash,
  sourceLimits,
  type SourceClosure,
} from './geo-source-envelope';
export function projectData(data: StructuredData): GeoDocument {
  if (!isStructuredData(data) || validateData(data).length) throw Error('Invalid Data input');
  return {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'data',
        name: 'Pinned Data table',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: data.columns.map((c) => ({
          id: c.id,
          name: c.name,
          type:
            c.type === 'number' || c.type === 'formula'
              ? 'number'
              : c.type === 'boolean'
                ? 'boolean'
                : 'string',
        })),
        features: data.rows.map((r) => ({
          id: r.id,
          rowId: r.id,
          geometry: null,
          values: Object.fromEntries(data.columns.map((c) => [c.id, cellValue(data, r, c)])),
        })),
      },
    ],
  };
}
export function closureFor(content: GeoDocument, originals: Map<string, SourceClosure>) {
  const closure = content.sources.map((s) => {
    const c = originals.get(s.resourceId);
    if (
      !c ||
      c.sourceId !== s.id ||
      canonicalJson(c.pin) !== canonicalJson(s.pin) ||
      c.sourceVersion.content.bytesHash !== s.bytesHash ||
      c.sourceVersion.content.format !== s.format
    )
      throw Error('GeoSourceMissing');
    return c;
  });
  if (
    closure.length > sourceLimits.sources ||
    closure.reduce((n, c) => n + decodeOriginal(c.bytes).length, 0) > sourceLimits.originals
  )
    throw Error('GeoOriginalBudget');
  return closure;
}
export async function validateGeoRecord(record: StoredArtifact) {
  const originals = new Map((record.geoResources ?? []).map((c) => [c.resourceId, c]));
  if (
    originals.size !== (record.geoResources ?? []).length ||
    originals.size > sourceLimits.sources
  )
    throw Error('Geo original identities');
  for (const c of originals.values()) {
    const v = c.sourceVersion;
    if (
      c.encoding !== 'base64' ||
      c.pin.artifactId !== v.artifactId ||
      c.pin.versionId !== v.versionId ||
      c.pin.contentHash !== 'sha256:' + v.contentHash ||
      (await contentHash(v.content)) !== v.contentHash ||
      (await originalHash(decodeOriginal(c.bytes))) !== v.content.bytesHash ||
      decodeOriginal(c.bytes).length !== v.content.byteLength
    )
      throw Error('Geo original hash mismatch');
  }
  const inputs = record.geoDataInputs ?? [];
  if (inputs.length > 16) throw Error('Geo Data dependency budget');
  for (const s of inputs)
    if (
      s.domain !== 'data' ||
      !isStructuredData(s.content) ||
      s.dependencies.length ||
      (await contentHash(s.content)) !== s.contentHash
    )
      throw Error('Geo Data input hash mismatch');
  const versions = new Map(record.versions.map((v) => [v.versionId, v]));
  for (const v of record.versions)
    if ((await contentHash(v.content)) !== v.contentHash) throw Error('Geo native hash mismatch');
  const capture = (pin: Pin) => {
    if (pin.artifactId !== record.id) throw Error('Geo dependency artifact mismatch');
    const v = versions.get(pin.versionId);
    if (!v || 'sha256:' + v.contentHash !== pin.contentHash)
      throw Error('Geo retained input missing');
    return { content: v.content as GeoDocument, pin };
  };
  for (const content of [
    record.draft.content,
    ...record.versions.map((v) => v.content),
  ] as GeoDocument[]) {
    assertGeo(content, sourceBudgets);
    closureFor(content, originals);
    for (const j of content.workspace?.joins ?? []) {
      const left = capture(j.inputs.left);
      const right =
        j.inputs.right.artifactId === record.id
          ? capture(j.inputs.right)
          : (() => {
              const s = inputs.find(
                (s) =>
                  s.artifactId === j.inputs.right.artifactId &&
                  s.versionId === j.inputs.right.versionId &&
                  'sha256:' + s.contentHash === j.inputs.right.contentHash,
              );
              if (!s) throw Error('Geo Data input missing');
              return { content: projectData(s.content as StructuredData), pin: j.inputs.right };
            })();
      const recomputed = createPinnedGeoJoinBetween(left, right, j, sourceBudgets);
      if (canonicalJson(recomputed) !== canonicalJson(j))
        throw Error('Geo join projection mismatch');
    }
    for (const c of content.workspace?.comparisons ?? [])
      if (
        canonicalJson(compareGeoVersions(capture(c.before), capture(c.after), c, sourceBudgets)) !==
        canonicalJson(c)
      )
        throw Error('Geo comparison projection mismatch');
  }
}
export async function stageSource(
  bytes: Uint8Array,
  name: string,
  format: 'csv' | 'geojson' | 'png' | 'jpeg',
  sourceId: string,
): Promise<SourceClosure> {
  if (!name || name.length > 128 || bytes.length > sourceLimits.originals)
    throw Error('Geo source input budget');
  const owned = bytes.slice(),
    manifest = {
      schemaVersion: 1 as const,
      name,
      format,
      byteLength: owned.length,
      bytesHash: await originalHash(owned),
    };
  const hash = await contentHash(manifest),
    versionId = crypto.randomUUID(),
    pin = { artifactId: sourceId, versionId, contentHash: 'sha256:' + hash };
  let raw = '';
  for (const b of owned) raw += String.fromCharCode(b);
  return {
    sourceId,
    resourceId: 'resource-' + sourceId,
    pin,
    encoding: 'base64',
    bytes: btoa(raw),
    recipe: {},
    sourceVersion: {
      artifactId: sourceId,
      versionId,
      parentVersionId: null,
      schemaVersion: 1,
      contentHash: hash,
      createdAt: new Date().toISOString(),
      createdBy: null,
      reason: 'Local Geo source',
      content: manifest,
    },
  };
}
