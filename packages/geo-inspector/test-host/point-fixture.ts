import type { GeoDocument, Geometry } from '@editor-platform/geo-core';
export type FixtureKind = 'points' | 'dateline' | 'polar' | 'wide' | 'unsupported' | 'legacy';
/** Source-free synthetic native data; no address, real asset or external resource. */
export function pointFixture(kind: Exclude<FixtureKind, 'legacy'> = 'points'): GeoDocument {
  const geometries: (Geometry | null)[] =
    kind === 'points'
      ? [
          { type: 'Point', coordinates: [12, 34] },
          { type: 'Point', coordinates: [13, 35] },
          { type: 'Point', coordinates: [12, 34] },
          null,
          {
            type: 'LineString',
            coordinates: [
              [12, 34],
              [13, 35],
            ],
          },
        ]
      : kind === 'dateline'
        ? [
            { type: 'Point', coordinates: [179, 0] },
            { type: 'Point', coordinates: [-179, 0] },
          ]
        : kind === 'polar'
          ? [{ type: 'Point', coordinates: [0, 70] }]
          : kind === 'wide'
            ? [
                { type: 'Point', coordinates: [0, 0] },
                { type: 'Point', coordinates: [6, 0] },
              ]
            : [
                null,
                {
                  type: 'MultiPoint',
                  coordinates: [
                    [179, 80],
                    [-179, 80],
                  ],
                },
                {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [0, 0],
                      [1, 0],
                      [0, 1],
                      [0, 0],
                    ],
                  ],
                },
              ];
  return {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'synthetic-sites',
        name: 'Synthetic sites',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [{ id: 'code', name: 'Code', type: 'string' }],
        features: geometries.map((geometry, i) => ({
          id: `point-${i + 1}`,
          rowId: `row-${i + 1}`,
          geometry,
          values: { code: String(i + 1).padStart(3, '0') },
        })),
      },
    ],
  };
}
