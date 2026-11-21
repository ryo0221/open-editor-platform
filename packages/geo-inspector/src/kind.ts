import { defineKind } from '@editor-platform/artifact-kinds';
import { assertGeo, emptyGeo, type GeoDocument } from '@editor-platform/geo-core';

/** Stored Geo content within the Host's limits. */
function isGeoContent(content: unknown): content is GeoDocument {
  try {
    assertGeo(content, {
      actions: 10,
      bytes: 65536,
      depth: 24,
      layers: 10,
      features: 200,
      vertices: 1000,
    });
    return true;
  } catch {
    return false;
  }
}
/** The Geo kind (docs/kind-registry-design.md). */
export const geoKind = defineKind<GeoDocument>({
  kind: 'geo',
  area: 'office',
  label: 'Geo',
  icon: '◎',
  description: 'Map geographic features and pinned Data values',
  creatable: true,
  create: (count) => ({ name: `Geo ${count}`, content: emptyGeo() }),
  validate: isGeoContent,
});
