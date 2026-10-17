import { contentHash } from '@editor-platform/artifact-core';
import { emptyGeo } from '@editor-platform/geo-core';
import {
  originalHash,
  type GeoSourceEnvelope,
  type SourceClosure,
} from '../../examples/reference-extension-host/geo-source-storage';
export async function sourceRecord(
  n = 1,
  parent: string | null = null,
  original?: string,
): Promise<GeoSourceEnvelope> {
  const content = emptyGeo();
  const closure: SourceClosure[] = [];
  if (original !== undefined) {
    const bytes = new TextEncoder().encode(original);
    const manifest = {
      schemaVersion: 1 as const,
      name: 'input.csv',
      format: 'csv' as const,
      byteLength: bytes.length,
      bytesHash: await originalHash(bytes),
    };
    const manifestHash = await contentHash(manifest);
    const pin = { artifactId: 'source', versionId: 's1', contentHash: 'sha256:' + manifestHash };
    content.sources.push({
      id: 'source-1',
      resourceId: 'resource-1',
      pin,
      bytesHash: manifest.bytesHash,
      format: 'csv',
      adapterVersion: 'csv@0',
      declaredCrs: 'OGC:CRS84',
      axis: 'longitude-latitude',
      attribution: 'Original retained',
    });
    closure.push({
      sourceId: 'source-1',
      resourceId: 'resource-1',
      pin,
      sourceVersion: {
        artifactId: 'source',
        versionId: 's1',
        parentVersionId: null,
        schemaVersion: 1,
        content: manifest,
        contentHash: manifestHash,
        createdAt: '2026-10-12T00:00:00.000Z',
        createdBy: null,
        reason: null,
      },
      recipe: {
        format: 'csv',
        crs: 'OGC:CRS84',
        fields: [],
        csv: { axis: 'longitude-latitude' },
        decision: { mode: 'all' },
      },
      encoding: 'base64',
      bytes: btoa(original),
    });
  }
  // Different native material without requiring editor commands in adapter tests.
  content.layers.push({
    id: 'layer-' + n,
    name: 'Layer',
    crs: 'OGC:CRS84',
    axis: 'longitude-latitude',
    fields: [],
    features: [],
  });
  const hash = await contentHash(content);
  return {
    format: 'geo-source-envelope@0-experiment',
    request: {
      operationId: 'op-' + n,
      capture: {
        scope: { artifactId: 'geo', sessionId: 'session', generation: 'generation' },
        revision: { kind: 'local-draft', sessionId: 'session', sequence: n },
        contentHash: hash,
      },
      content,
    },
    nativeVersion: {
      artifactId: 'geo',
      versionId: 'v' + n,
      parentVersionId: parent,
      schemaVersion: 1,
      contentHash: hash,
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: null,
      reason: null,
    },
    closure,
    closureHash: await contentHash(closure),
    receiptId: 'geo-source:op-' + n,
  };
}
