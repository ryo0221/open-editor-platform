import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { validateRing } from '@editor-platform/geometry-core/planar';
import {
  createFictionMap,
  parseFictionMap,
  serializeFictionMap,
  validateFictionMap,
} from '@editor-platform/fiction-map/model';
import { mergeNative } from './import';
import { attempt, unwrap } from './result';
import { draft, layer, native, pointFeature, polygon } from './test-data';
import type { FictionMapContent, FictionMapGeometry } from './types';

function rejects(input: unknown, code: string, path?: string) {
  const r = validateFictionMap(input);
  expect(r).toMatchObject({
    ok: false,
    diagnostic: { code, ...(path === undefined ? {} : { path }) },
  });
}
function sized(bytes: number): FictionMapContent {
  const d = {
    ...draft(),
    layers: [layer()],
    features: Array.from({ length: 30 }, (_, i) => ({ ...pointFeature('p' + i), description: '' })),
  };
  let remaining = bytes - new TextEncoder().encode(canonicalJson(d)).length;
  for (const f of d.features) {
    const n = Math.min(4096, remaining);
    f.description = 'a'.repeat(n);
    remaining -= n;
  }
  expect(remaining).toBe(0);
  return d;
}
describe('Fiction Map B1/B3 admission', () => {
  it('B1-01 empty explicit defaults, canonical/UTF8 roundtrip and owned snapshots', () => {
    const c = createFictionMap();
    expect(c).toMatchObject({
      kind: 'fiction-map',
      schemaVersion: 1,
      precision: { minEdgeLength: 0, minPolygonArea: 0 },
      features: [],
      layers: [],
      namedViews: [],
    });
    expect(Object.isFrozen(c.coordinateSpace.bounds)).toBe(true);
    const json = unwrap(serializeFictionMap(c));
    expect(unwrap(parseFictionMap(json))).toEqual(c);
    expect(unwrap(parseFictionMap(new TextEncoder().encode(json)))).toEqual(c);
    const d = draft();
    const validated = unwrap(validateFictionMap(d));
    d.coordinateSpace.unit.name = 'changed';
    expect(validated.coordinateSpace.unit.name).toBe('map-unit');
  });
  for (const kind of ['place', 'path', 'region', 'landform'] as const)
    for (const type of ['point', 'polyline', 'polygon'] as const)
      it('B1-02 ' + kind + '/' + type, () => {
        const geometry: FictionMapGeometry =
          type === 'point'
            ? { type, coordinates: [0, 0] }
            : type === 'polyline'
              ? {
                  type,
                  coordinates: [
                    [0, 0],
                    [1, 1],
                  ],
                }
              : {
                  type,
                  outer: [
                    [0, 0],
                    [2, 0],
                    [0, 2],
                    [0, 0],
                  ],
                };
        const input = {
          ...draft(),
          layers: [layer()],
          features: [{ ...pointFeature('p', geometry), featureKind: kind }],
        };
        expect(validateFictionMap(input).ok).toBe(
          kind === 'landform' ||
            ({ place: 'point', path: 'polyline', region: 'polygon' } as const)[kind] === type,
        );
      });
  it('B1-03 unsupported schemas/formats never become Geo', () => {
    rejects({ ...draft(), schemaVersion: 2 }, 'unsupported-schema', '/schemaVersion');
    rejects({ type: 'FeatureCollection', features: [] }, 'unsupported-format', '/kind');
    const c = { ...draft() };
    Reflect.deleteProperty(c, 'kind');
    rejects(c, 'unsupported-format', '/kind');
  });
  it('B1-04 unknown keys, null, getters, hidden/symbol keys, sparse, cyclic, prototypes and undefined', () => {
    rejects({ ...draft(), extra: 1 }, 'unknown-field', '/extra');
    rejects(
      { ...draft(), features: [{ ...pointFeature(), style: { extra: 1 } }] },
      'unknown-field',
      '/features/0/style/extra',
    );
    rejects({ ...draft(), features: [{ ...pointFeature(), description: null }] }, 'invalid-string');
    let reads = 0;
    const o = { ...draft() };
    Object.defineProperty(o, 'layers', {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    rejects(o, 'invalid-data', '/layers');
    expect(reads).toBe(0);
    for (const bad of [new Date(), new Float64Array(2), () => 0, undefined])
      rejects({ ...draft(), extra: bad }, 'invalid-data');
    const hidden = { ...draft() };
    Object.defineProperty(hidden, 'extra', { value: 1 });
    rejects(hidden, 'invalid-data');
    rejects({ ...draft(), [Symbol()]: 1 }, 'invalid-data');
    rejects({ ...draft(), features: Array(1) }, 'invalid-data');
    const cycle: Record<string, unknown> = { ...draft() };
    cycle.extra = cycle;
    rejects(cycle, 'invalid-data');
    const a: unknown[] = [];
    Object.assign(a, { extra: true });
    rejects({ ...draft(), features: a }, 'invalid-data');
  });
  it('B1-04 JSON duplicate keys before parse, decoded escapes, invalid UTF8/BOM/syntax', () => {
    for (const s of [
      '{"name":"a","name":"b"}',
      '{"name":"a","\\u006eame":"b"}',
      '{"x":{"a":1,"\\u0061":2}}',
      '[1,]',
      '{"x":01}',
      '"\\x"',
      '{"a":1}x',
    ])
      expect(parseFictionMap(s)).toMatchObject({ ok: false, diagnostic: { code: 'invalid-json' } });
    for (const b of [new Uint8Array([255]), new Uint8Array([239, 187, 191, 123, 125])])
      expect(parseFictionMap(b)).toMatchObject({ ok: false, diagnostic: { code: 'invalid-json' } });
    expect(parseFictionMap('\ufeff{}')).toMatchObject({
      ok: false,
      diagnostic: { code: 'invalid-json' },
    });
    const json = canonicalJson({ ...draft(), layers: [layer('name')], features: [] });
    expect(parseFictionMap(json).ok).toBe(true);
  });
  it('B1-05 scoped IDs, strings, exact Unicode and field limits', () => {
    const id = 'a'.repeat(512);
    expect(
      validateFictionMap({
        ...draft(),
        layers: [{ ...layer(id), name: 'layer' }],
        features: [{ ...pointFeature(id), name: 'feature', layerId: id }],
      }).ok,
    ).toBe(true);
    for (const id of ['a'.repeat(513), ' ', '\ud800', '\0'])
      rejects({ ...draft(), layers: [layer(id)] }, 'invalid-string');
    rejects({ ...draft(), layers: [layer(), layer()] }, 'duplicate-id', '/layers/1/id');
    expect(
      validateFictionMap({ ...draft(), layers: [layer('a'), layer('A'), layer('é'), layer('é')] })
        .ok,
    ).toBe(true);
    const c = native([
      {
        ...pointFeature(),
        description: '\t\n\r',
        category: '',
        style: { color: '#Ab00ff', lineWidth: 64, label: false },
        worldEntityRef: { namespace: 'world', entityId: 'same' },
      },
    ]);
    expect(unwrap(parseFictionMap(unwrap(serializeFictionMap(c))))).toEqual(c);
  });
  it('B1-06 exact feature/view layer references and final state layer removal', () => {
    rejects({ ...draft(), features: [pointFeature()] }, 'missing-layer', '/features/0/layerId');
    rejects(
      {
        ...draft(),
        namedViews: [
          {
            id: 'v',
            name: 'v',
            extent: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
            visibleLayerIds: ['gone'],
          },
        ],
      },
      'dangling-view-layer',
      '/namedViews/0/visibleLayerIds/0',
    );
    const c = {
      ...native(),
      layers: [layer('dest')],
      features: [{ ...pointFeature(), layerId: 'dest' }],
      namedViews: [],
    };
    expect(validateFictionMap(c).ok).toBe(true);
  });
  it('B1-07 append collisions/remap all scopes, source admission first, replace IDs', () => {
    const base = unwrap(
      validateFictionMap({
        ...native(),
        namedViews: [
          {
            id: 'v',
            name: 'v',
            extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
            visibleLayerIds: ['l'],
          },
        ],
      }),
    );
    expect(attempt('candidate', () => mergeNative(base, base, { mode: 'append' }))).toMatchObject({
      ok: false,
      diagnostic: { code: 'duplicate-id' },
    });
    const merged = mergeNative(base, base, {
      mode: 'append',
      remap: {
        layers: [{ from: 'l', to: 'l2' }],
        features: [{ from: 'p', to: 'p2' }],
        namedViews: [{ from: 'v', to: 'v2' }],
      },
    });
    expect(merged.features.map((f) => [f.id, f.layerId])).toEqual([
      ['p', 'l'],
      ['p2', 'l2'],
    ]);
    expect(merged.namedViews[1].visibleLayerIds).toEqual(['l2']);
    expect(base.features).toHaveLength(1);
    const invalid = { ...base, layers: [] };
    expect(
      attempt('candidate', () => mergeNative(base, invalid, { mode: 'append' })),
    ).toMatchObject({ ok: false, diagnostic: { code: 'missing-layer' } });
    expect(mergeNative(base, base, { mode: 'replace' })).toEqual(base);
    for (const mapping of [
      [{ from: 'absent', to: 'x' }],
      [{ from: 'p', to: 'p' }],
      [
        { from: 'p', to: 'x' },
        { from: 'p', to: 'y' },
      ],
    ])
      expect(
        attempt('candidate', () =>
          mergeNative(base, base, {
            mode: 'append',
            remap: { features: mapping, layers: [{ from: 'l', to: 'l2' }] },
          }),
        ).ok,
      ).toBe(false);
  });
  it('B1-08/09 World references do not imply identity; 180/90 is planar', () => {
    const ref = { namespace: 'world', entityId: 'same' },
      c = native([
        { ...pointFeature('a', { type: 'point', coordinates: [180, 90] }), worldEntityRef: ref },
        { ...pointFeature('b'), worldEntityRef: ref },
      ]);
    const parsed = unwrap(parseFictionMap(unwrap(serializeFictionMap(c))));
    expect(parsed).toEqual(c);
    expect(parsed.features.map((f) => f.id)).toEqual(['a', 'b']);
  });
  const rings = [
    [
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
      'self-crossing',
      'edgeIndices',
      [0, 2],
    ],
    [
      [
        [0, 0],
        [3, 3],
        [0, 3],
        [2, 0],
        [0, 0],
      ],
      'self-crossing',
      'edgeIndices',
      [0, 2],
    ],
    [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ],
      'zero-area',
      undefined,
      undefined,
    ],
    [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
        [0, 0],
      ],
      'self-contact',
      'edgeIndices',
      [0, 2],
    ],
    [
      [
        [0, 0],
        [3, 0],
        [1, 0],
        [1, 2],
        [0, 2],
        [0, 0],
      ],
      'edge-overlap',
      'edgeIndices',
      [0, 1],
    ],
    [
      [
        [0, 0],
        [2, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
      'adjacent-duplicate',
      'vertexIndices',
      [1, 2],
    ],
    [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
        [0, 2],
        [0, 0],
      ],
      'repeated-vertex',
      'vertexIndices',
      [0, 3],
    ],
    [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 2],
        [0, 4],
        [0, 0],
      ],
      null,
      undefined,
      undefined,
    ],
    [
      [
        [0, 0],
        [0, 4],
        [2, 2],
        [4, 4],
        [4, 0],
        [0, 0],
      ],
      null,
      undefined,
      undefined,
    ],
  ] as const;
  rings.forEach(([ring, code, key, indices], i) =>
    it('B1-10' + String.fromCharCode(97 + i) + ' fixed R1 diagnostic and native cause', () => {
      const before = structuredClone(ring),
        result = validateRing(ring, { maxVertices: 64 });
      const input = {
        ...draft(),
        layers: [layer()],
        features: [pointFeature('p', { type: 'polygon', outer: ring })],
      };
      if (code) {
        expect(result).toEqual({
          ok: false,
          diagnostic: { kind: 'geometry', code, ...(key ? { [key]: indices } : {}) },
        });
        expect(validateFictionMap(input)).toEqual({
          ok: false,
          diagnostic: {
            code: 'invalid-geometry',
            path: '/features/0/geometry/outer',
            source: 'input',
            cause: !result.ok ? result.diagnostic : undefined,
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: true,
          value: { vertexCount: 5, winding: i === 7 ? 'positive' : 'negative' },
        });
        expect(validateFictionMap(input).ok).toBe(true);
      }
      expect(ring).toEqual(before);
    }),
  );
  it('B1 polyline revisit and crossing are accepted, adjacent zero edge refused', () => {
    native([
      pointFeature('p', {
        type: 'polyline',
        coordinates: [
          [0, 0],
          [2, 2],
          [0, 2],
          [2, 0],
          [0, 0],
        ],
      }),
    ]);
    rejects(
      {
        ...native(),
        features: [
          pointFeature('p', {
            type: 'polyline',
            coordinates: [
              [1, 1],
              [1, 1],
            ],
          }),
        ],
      },
      'zero-length-edge',
    );
  });
  it('B3-01/02/07 ring raw cap before malformed points and closure, Polyline cap', () => {
    native([pointFeature('r', polygon(64))]);
    for (const coords of [
      (polygon(65) as Extract<FictionMapGeometry, { type: 'polygon' }>).outer,
      Array(66),
      Array(66).fill(null),
    ])
      rejects(
        { ...native(), features: [pointFeature('r', { type: 'polygon', outer: coords })] },
        'geometry-vertex-limit',
      );
    const g = polygon(64);
    if (g.type !== 'polygon') throw Error();
    rejects(
      {
        ...native(),
        features: [pointFeature('r', { type: 'polygon', outer: g.outer.slice(0, -1) })],
      },
      'invalid-geometry',
    );
    native([
      pointFeature('l', {
        type: 'polyline',
        coordinates: Array.from({ length: 64 }, (_, i) => [i, 0]),
      }),
    ]);
    rejects(
      {
        ...native(),
        features: [
          pointFeature('l', {
            type: 'polyline',
            coordinates: Array.from({ length: 65 }, (_, i) => [i, 0]),
          }),
        ],
      },
      'geometry-vertex-limit',
    );
    rejects({ ...native(), features: [pointFeature('r', polygon(1000))] }, 'geometry-vertex-limit');
  });
  it('B3-03/04 independent counts, logical 1000 inclusive', () => {
    const features = Array.from({ length: 200 }, (_, i) =>
      pointFeature('p' + i, {
        type: 'polyline',
        coordinates: Array.from({ length: 5 }, (_, j) => [i, j]),
      }),
    );
    const d = {
      ...draft(),
      layers: Array.from({ length: 10 }, (_, i) => layer(i ? 'l' + i : 'l')),
      features,
      namedViews: Array.from({ length: 10 }, (_, i) => ({
        id: 'v' + i,
        name: 'v',
        extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        visibleLayerIds: [],
      })),
    };
    expect(validateFictionMap(d).ok).toBe(true);
    rejects({ ...d, layers: [...d.layers, layer('eleven')] }, 'layer-limit');
    rejects({ ...d, features: [...features, pointFeature('new')] }, 'feature-limit');
    rejects(
      { ...d, namedViews: [...d.namedViews, { ...d.namedViews[0], id: 'eleven' }] },
      'view-limit',
    );
    rejects(
      {
        ...d,
        features: [
          ...features.slice(1),
          pointFeature('p0', {
            type: 'polyline',
            coordinates: Array.from({ length: 6 }, (_, j) => [0, j]),
          }),
        ],
      },
      'map-vertex-limit',
    );
    expect(
      validateFictionMap({
        ...native(),
        features: [
          pointFeature('p'),
          pointFeature('l', {
            type: 'polyline',
            coordinates: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          }),
          pointFeature('r', {
            type: 'polygon',
            outer: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          }),
        ],
      }).ok,
    ).toBe(true);
  });
  it('B3-05 canonical exact UTF8 byte boundary and independent field string guards', () => {
    expect(validateFictionMap(sized(65536)).ok).toBe(true);
    rejects(sized(65537), 'native-byte-limit');
    const c = native([{ ...pointFeature(), description: '地図\\"\n' }]);
    expect(new TextEncoder().encode(unwrap(serializeFictionMap(c))).length).toBe(
      new TextEncoder().encode(canonicalJson(c)).length,
    );
    rejects(
      { ...native(), features: [{ ...pointFeature(), description: 'a'.repeat(4097) }] },
      'invalid-string',
    );
  });
  it('B3-06 raw whitespace/UTF8 bytes before parse and merged capacity', () => {
    const valid = canonicalJson(draft());
    expect(parseFictionMap(' '.repeat(65536 - valid.length) + valid).ok).toBe(true);
    expect(parseFictionMap(' '.repeat(65537 - valid.length) + valid)).toMatchObject({
      ok: false,
      diagnostic: { code: 'input-byte-limit' },
    });
    expect(parseFictionMap(' '.repeat(65537))).toMatchObject({
      ok: false,
      diagnostic: { code: 'input-byte-limit' },
    });
    expect(parseFictionMap(new Uint8Array(65537))).toMatchObject({
      ok: false,
      diagnostic: { code: 'input-byte-limit' },
    });
    const base = native();
    const source = unwrap(validateFictionMap(sized(65536)));
    expect(
      attempt('candidate', () =>
        mergeNative(base, source, { mode: 'append', remap: { layers: [{ from: 'l', to: 'l2' }] } }),
      ),
    ).toMatchObject({ ok: false, diagnostic: { code: 'native-byte-limit' } });
  });
  it('B3 bounded depth/value input, scalar shapes and no coercion', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 7; i++) deep = [deep];
    rejects({ ...draft(), extra: deep }, 'input-structure-limit');
    expect(parseFictionMap('['.repeat(7) + '0' + ']'.repeat(7))).toMatchObject({
      ok: false,
      diagnostic: { code: 'input-structure-limit' },
    });
    rejects(
      {
        ...native(),
        features: [
          pointFeature('p', {
            type: 'point',
            coordinates: ['1', 2] as unknown as readonly [number, number],
          }),
        ],
      },
      'invalid-field',
    );
  });
});
