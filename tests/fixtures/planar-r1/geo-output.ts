/** Trusted offline compatibility fixture, using existing public Geo entrypoints. */
import { contentHash } from '@editor-platform/artifact-core';
import {
  defaultGeoStyle,
  emptyGeoWorkspace,
  parseGeo,
  renderGeoSvg,
  serializeGeo,
  type Budgets,
  type GeoDocument,
} from '@editor-platform/geo-core';
import { createGeoPng } from '@editor-platform/geo-inspector/import-experiment';

export async function captureGeoOutput(doc: Document) {
  const budgets: Budgets = {
    actions: 20,
    bytes: 65536,
    depth: 24,
    layers: 10,
    features: 200,
    vertices: 1000,
  };
  const style = defaultGeoStyle('regions');
  style.labelFieldId = 'name';
  const content: GeoDocument = {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'regions',
        name: 'Regions',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [{ id: 'name', name: 'Name', type: 'string' }],
        features: [
          {
            id: 'dateline',
            rowId: 'row',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [179, 0],
                  [-179, 0],
                  [-179, 2],
                  [179, 2],
                  [179, 0],
                ],
              ],
            },
            values: { name: 'Dateline' },
          },
          {
            id: 'polar',
            rowId: 'polar-row',
            geometry: { type: 'Point', coordinates: [180, 90] },
            values: { name: 'Polar' },
          },
        ],
      },
    ],
    workspace: {
      ...emptyGeoWorkspace(),
      styles: [style],
      views: [
        { id: 'saved', name: 'Saved', extent: [178, -2, 182, 4], styles: [style], annotations: [] },
      ],
    },
  };
  const native = serializeGeo(content, budgets);
  const hash = await contentHash(content);
  const view = content.workspace!.views[0];
  const svg = renderGeoSvg(
    content,
    { extent: view.extent, view, width: 800, height: 400 },
    budgets,
  );
  const png = await createGeoPng(
    doc,
    { content, pin: { artifactId: 'compat', versionId: 'v1', contentHash: 'sha256:' + hash } },
    'saved',
    [800, 400],
    budgets,
    () => {},
  );
  return {
    native,
    hash,
    svg,
    png: Array.from(png.bytes),
    receipt: png.receipt,
    roundtrip: serializeGeo(parseGeo(native, budgets), budgets),
    after: serializeGeo(content, budgets),
  };
}
