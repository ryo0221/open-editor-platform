import { describe, expect, it } from 'vitest';
import { validateRing, type PlanarPoint } from '@editor-platform/geometry-core/planar';
import {
  applyGeoCommand,
  assertEditableGeometry,
  parseGeo,
  serializeGeo,
  unwrapLongitude,
  type Budgets,
  type GeoDocument,
  type Geometry,
  type Position,
} from '@editor-platform/geo-core';

const options = { maxVertices: 1000 };
const budgets: Budgets = {
  actions: 20,
  bytes: 65536,
  depth: 24,
  layers: 10,
  features: 200,
  vertices: 1000,
};
const asPolygon = (ring: readonly PlanarPoint[]): Geometry => ({
  type: 'Polygon',
  coordinates: [ring.map(([x, y]) => [x, y])],
});
function documentWith(geometry: Geometry): GeoDocument {
  return {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'layer',
        name: 'Retained',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [],
        features: [{ id: 'feature', rowId: 'row', geometry, values: {} }],
      },
    ],
  };
}

describe('intentional Geo / planar coexistence G01–G05', () => {
  it.each([
    [
      'G01 arbitrary-plane triangle (direct edit validator, not CRS84 admission)',
      [
        [0, 0],
        [120, 0],
        [240, 100],
        [0, 0],
      ],
      'polygon-ambiguous-wrap',
    ],
    [
      'G02 small square; legacy area threshold remains',
      [
        [0, 0],
        [1e-6, 0],
        [1e-6, 1e-6],
        [0, 1e-6],
        [0, 0],
      ],
      'polygon-zero-area',
    ],
  ] as const)('%s', (_name, ring, geoCode) => {
    expect(validateRing(ring, options).ok).toBe(true);
    expect(() => assertEditableGeometry(asPolygon(ring))).toThrow(geoCode);
  });

  it('G03 dateline: raw planar winding and unwrap geometry have intentionally different meanings', () => {
    const ring: Position[] = [
      [179, 0],
      [-179, 0],
      [-179, 2],
      [179, 2],
      [179, 0],
    ];
    const before = structuredClone(ring);
    expect(validateRing(ring, options)).toEqual({
      ok: true,
      value: { vertexCount: 4, winding: 'negative' },
    });
    const unwrapped = ring.map(([x, y]) => [unwrapLongitude(x, ring[0][0]), y]);
    expect(unwrapped[1][0]).toBe(181);
    expect(validateRing(unwrapped, options)).toEqual({
      ok: true,
      value: { vertexCount: 4, winding: 'positive' },
    });
    expect(() => assertEditableGeometry(asPolygon(ring))).not.toThrow();
    const native = documentWith(asPolygon(ring));
    expect(parseGeo(serializeGeo(native, budgets), budgets)).toEqual(native);
    expect(ring).toEqual(before);
  });

  it.each([
    [
      'G04 bow-tie',
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
      'self-crossing',
      'polygon-self-intersection',
    ],
    [
      'G04 open',
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
      'ring-not-closed',
      'ring-not-closed',
    ],
    [
      'G04 leading duplicate',
      [
        [0, 0],
        [0, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
      'adjacent-duplicate',
      'duplicate-vertex',
    ],
    [
      'G04 adjacent duplicate',
      [
        [0, 0],
        [2, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
      'adjacent-duplicate',
      'polygon-self-intersection',
    ],
  ] as const)('%s retains distinct public diagnostics', (_name, ring, planarCode, geoCode) => {
    expect(validateRing(ring, options)).toMatchObject({
      ok: false,
      diagnostic: { kind: 'geometry', code: planarCode },
    });
    expect(() => assertEditableGeometry(asPolygon(ring))).toThrow(geoCode);
  });

  it.each([
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 1],
        ],
      ],
    },
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [179, 0],
            [-179, 0],
            [-179, 2],
            [179, 0],
          ],
        ],
      ],
    },
    {
      type: 'MultiPoint',
      coordinates: [
        [180, 90],
        [-180, -90],
      ],
    },
  ] as Geometry[])('G05 retains read-only topology without flattening: $type', (geometry) => {
    const native = documentWith(geometry);
    const bytes = serializeGeo(native, budgets);
    expect(parseGeo(bytes, budgets)).toEqual(native);
    expect(() => assertEditableGeometry(geometry)).toThrow('geometry-readonly-topology-pending');
    expect(validateRing(geometry.coordinates, options)).toMatchObject({ ok: false });
    expect(serializeGeo(native, budgets)).toBe(bytes);
  });

  it('G05 failed geometry edit remains atomic with preceding scalar edits', () => {
    const native = documentWith(
      asPolygon([
        [0, 0],
        [4, 0],
        [0, 4],
        [0, 0],
      ]),
    );
    native.layers[0].fields = [{ id: 'name', name: 'Name', type: 'string' }];
    native.layers[0].features[0].values.name = 'before';
    const before = serializeGeo(native, budgets);
    const revision = { sessionId: 'coexistence', sequence: 0 };
    expect(() =>
      applyGeoCommand(
        native,
        {
          expectedRevision: revision,
          actions: [
            {
              type: 'setAttribute',
              layerId: 'layer',
              featureId: 'feature',
              fieldId: 'name',
              value: 'after',
            },
            {
              type: 'replaceGeometry',
              layerId: 'layer',
              featureId: 'feature',
              geometry: asPolygon([
                [0, 0],
                [2, 2],
                [0, 2],
                [2, 0],
                [0, 0],
              ]),
            },
          ],
        },
        { revision, canEdit: true, budgets },
      ),
    ).toThrow('polygon-self-intersection');
    expect(serializeGeo(native, budgets)).toBe(before);
  });
});
