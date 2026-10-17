import { assertGeo, type Budgets, type GeoDocument } from '@editor-platform/geo-core';
import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import type { Binding } from '@editor-platform/extension-runtime/draft2';
// Test policy only; the lower Basic.read copy limits remain authoritative.
export const budgets: Budgets = {
  actions: 10,
  bytes: 2_000_000,
  depth: 32,
  layers: 10,
  features: 200,
  vertices: 2000,
};
export const packageHash = 'a'.repeat(64); // Synthetic admission pin, not a package-byte verification claim.
export function fixture(): GeoDocument {
  return {
    schemaVersion: 1,
    layers: [
      {
        id: 'synthetic-sites',
        name: 'Synthetic sites',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [
          { id: 'code', name: 'Code', type: 'string' },
          { id: 'value', name: 'Value', type: 'number' },
          { id: 'active', name: 'Active', type: 'boolean' },
        ],
        features: [
          {
            id: 'site-01',
            rowId: 'row-01',
            geometry: { type: 'Point', coordinates: [12, 34] },
            values: { code: '001', value: 0, active: true },
            sourceRef: { sourceId: 'source-1', externalId: '001' },
          },
          {
            id: 'site-02',
            rowId: 'row-02',
            geometry: null,
            values: {
              code: '<img src="https://invalid.example/x" onerror="alert(1)">',
              value: null,
              active: false,
            },
          },
          {
            id: 'multi-03',
            rowId: 'row-03',
            geometry: {
              type: 'MultiPoint',
              coordinates: [
                [179, 80],
                [-179, 80],
              ],
            },
            values: { code: '003', value: 12, active: null },
          },
        ],
      },
    ],
    sources: [
      {
        id: 'source-1',
        resourceId: 'synthetic-resource',
        pin: {
          artifactId: 'synthetic-source',
          versionId: 'version-1',
          contentHash: `sha256:${'b'.repeat(64)}`,
        },
        bytesHash: `sha256:${'c'.repeat(64)}`,
        format: 'geojson',
        adapterVersion: 'synthetic/1',
        declaredCrs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        attribution: 'Synthetic test data; no real locations or external resources.',
      },
    ],
  };
}
export function nativeBinding(content: GeoDocument = fixture(), artifactId = 'synthetic-geo') {
  assertGeo(content, budgets);
  let readable = true;
  const listeners = new Set<() => void>();
  const binding: Binding<GeoDocument, never> = {
    artifactId,
    artifactKind: 'geo',
    schemaVersion: 1,
    session: new EditorSession(content),
    inputs: new EditorInputs(),
    allowed: (grant) => readable && grant === 'artifact:read',
    subscribePermissions: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    binding,
    revokeRead() {
      readable = false;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}
