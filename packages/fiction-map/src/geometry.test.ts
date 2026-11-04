import { describe, expect, it } from 'vitest';
import {
  createFictionMap,
  validateFictionMap,
  validateFictionMapGeometry,
  isFictionMapPointNear,
  snapFictionMapPoint,
  hitTestFictionMapGeometry,
  translateFictionMapGeometry,
  serializeFictionMap,
  parseFictionMap,
} from '@editor-platform/fiction-map/model';
import { exact, exactPoint, quantum, snapped, twiceArea } from './numeric';
import oracle from '../test-fixtures/numeric-oracle.json';
import { unwrap } from './result';
import { draft, layer, native, pointFeature } from './test-data';
import type { FictionMapGeometry, FictionMapPoint } from './types';
const bounds = { minX: -(2 ** 20), minY: -(2 ** 20), maxX: 2 ** 20, maxY: 2 ** 20 };
const zero = createFictionMap().precision;
const geometry = (g: FictionMapGeometry) => unwrap(validateFictionMapGeometry(g, zero, bounds));
function result(g: FictionMapGeometry, precision = zero) {
  return validateFictionMap({
    ...draft(),
    coordinateSpace: { ...draft().coordinateSpace, bounds },
    precision,
    layers: [layer()],
    features: [pointFeature('p', g)],
  });
}
describe('Fiction Map B2 exact numeric policy', () => {
  it('B2-01 nonfinite coordinates and strict scalar points', () => {
    for (const x of [NaN, Infinity, -Infinity])
      expect(result({ type: 'point', coordinates: [x, 0] })).toMatchObject({
        ok: false,
        diagnostic: { code: 'coordinate-not-finite', path: '/features/0/geometry/coordinates/0' },
      });
    expect(
      result({ type: 'point', coordinates: ['1', 0] as unknown as FictionMapPoint }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-field' } });
  });
  it('B2-02 hard bounds inclusive and proper nonzero/view extents', () => {
    expect(result({ type: 'point', coordinates: [2 ** 20, -(2 ** 20)] }).ok).toBe(true);
    expect(result({ type: 'point', coordinates: [2 ** 20 + 2 ** -32, 0] })).toMatchObject({
      ok: false,
      diagnostic: { code: 'coordinate-out-of-range' },
    });
    for (const b of [
      { ...bounds, minX: bounds.maxX },
      { ...bounds, minX: bounds.maxX + 1 },
    ])
      expect(
        validateFictionMap({
          ...draft(),
          coordinateSpace: { ...draft().coordinateSpace, bounds: b },
        }).ok,
      ).toBe(false);
    expect(
      validateFictionMap({
        ...draft(),
        namedViews: [
          {
            id: 'v',
            name: 'v',
            extent: { minX: 0, minY: 0, maxX: 1025, maxY: 1 },
            visibleLayerIds: [],
          },
        ],
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'view-out-of-bounds' } });
  });
  it('B2-03/04 subnormal nonzero area versus collinearity', () => {
    const s = Number.MIN_VALUE,
      g: FictionMapGeometry = {
        type: 'polygon',
        outer: [
          [0, 0],
          [s, 0],
          [0, s],
          [0, 0],
        ],
      };
    expect(s * s).toBe(0);
    expect(result(g).ok).toBe(true);
    expect(result(g, { minEdgeLength: 0, minPolygonArea: Number.MIN_VALUE })).toMatchObject({
      ok: false,
      diagnostic: { code: 'area-below-minimum' },
    });
    expect(
      result({
        type: 'polygon',
        outer: [
          [0, 0],
          [1, 0],
          [2, 0],
          [0, 0],
        ],
      }),
    ).toMatchObject({ ok: false, diagnostic: { cause: { code: 'zero-area' } } });
  });
  it('B2-05 exact minimum edge equality and just below, Point exempt', () => {
    const precision = { minEdgeLength: 5, minPolygonArea: 0 };
    expect(
      result(
        {
          type: 'polyline',
          coordinates: [
            [0, 0],
            [3, 4],
          ],
        },
        precision,
      ).ok,
    ).toBe(true);
    expect(
      result(
        {
          type: 'polyline',
          coordinates: [
            [0, 0],
            [3, 4 - 2 ** -50],
          ],
        },
        precision,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: 'edge-below-minimum', path: '/features/0/geometry/coordinates/0' },
    });
    expect(
      result(
        { type: 'point', coordinates: [0, 0] },
        { minEdgeLength: Number.MAX_VALUE, minPolygonArea: Number.MAX_VALUE },
      ).ok,
    ).toBe(true);
  });
  it('B2-06 exact minimum area equality, profile strengthening and invalid profiles', () => {
    const g: FictionMapGeometry = {
      type: 'polygon',
      outer: [
        [0, 0],
        [4, 0],
        [0, 3],
        [0, 0],
      ],
    };
    expect(result(g, { minEdgeLength: 0, minPolygonArea: 6 }).ok).toBe(true);
    expect(result(g, { minEdgeLength: 0, minPolygonArea: 6 + 2 ** -50 })).toMatchObject({
      ok: false,
      diagnostic: { code: 'area-below-minimum' },
    });
    for (const min of [-1, Infinity, NaN])
      expect(result(g, { minEdgeLength: min, minPolygonArea: 0 })).toMatchObject({
        ok: false,
        diagnostic: { code: 'invalid-precision' },
      });
  });
  it('B2-07 near is explicit Euclidean radius, not duplicate/weld', () => {
    expect(unwrap(isFictionMapPointNear([0, 0], [2 ** -50, 0], 0))).toBe(false);
    expect(unwrap(isFictionMapPointNear([0, 0], [2 ** -50, 0], 2 ** -50))).toBe(true);
    expect(unwrap(isFictionMapPointNear([-0, +0], [+0, -0], 0))).toBe(true);
    for (const r of [-1, Infinity, NaN])
      expect(isFictionMapPointNear([0, 0], [0, 0], r).ok).toBe(false);
  });
  it('B2-08 snap ties-to-even, negative values, exact power bounds and no grid admission', () => {
    const precision = { ...zero, snapGrid: { step: 1 } };
    expect(
      [0.5, 1.5, -0.5, -1.5, 2.5, -2.5].map(
        (x) => unwrap(snapFictionMapPoint([x, 0], precision, bounds))[0],
      ),
    ).toEqual([0, 2, 0, -2, 2, -2]);
    for (const step of [2 ** -20, 2 ** 20])
      expect(snapFictionMapPoint([0.5, 0], { ...zero, snapGrid: { step } }, bounds).ok).toBe(true);
    for (const step of [0, 0.1, 2 ** -21, 2 ** 21, 2 ** 20 - 2 ** -33, 2 ** -20 + 2 ** -72])
      expect(
        result({ type: 'point', coordinates: [0.1, 0.2] }, { ...zero, snapGrid: { step } }),
      ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-precision' } });
    expect(result({ type: 'point', coordinates: [0.1, 0.2] }, precision).ok).toBe(true);
  });
  it('B2-09 snapping a valid ring can yield a rejected candidate and never clamps', () => {
    const precision = { ...zero, snapGrid: { step: 1 } },
      small: FictionMapGeometry = {
        type: 'polygon',
        outer: [
          [0.1, 0.1],
          [0.2, 0.1],
          [0.1, 0.2],
          [0.1, 0.1],
        ],
      };
    expect(result(small).ok).toBe(true);
    if (small.type !== 'polygon') throw Error();
    const outer = small.outer.map((p) => unwrap(snapFictionMapPoint(p, precision, bounds)));
    expect(result({ type: 'polygon', outer })).toMatchObject({
      ok: false,
      diagnostic: { cause: { code: 'adjacent-duplicate' } },
    });
    expect(
      snapFictionMapPoint([0.6, 0.5], precision, { minX: 0.1, minY: 0.1, maxX: 0.8, maxY: 0.8 }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'snap-out-of-bounds' } });
  });
  it('B2-09 explicit translate rejects lost increments/bounds but preserves represented changes', () => {
    const g = geometry({ type: 'point', coordinates: [2 ** 19, 0] });
    expect(translateFictionMapGeometry(g, 2 ** -40, 0, zero, bounds)).toMatchObject({
      ok: false,
      diagnostic: { code: 'coordinate-precision-loss' },
    });
    expect(translateFictionMapGeometry(g, 2 ** 20, 0, zero, bounds)).toMatchObject({
      ok: false,
      diagnostic: { code: 'coordinate-out-of-range' },
    });
    expect(unwrap(translateFictionMapGeometry(g, 1, -1, zero, bounds))).toEqual({
      type: 'point',
      coordinates: [2 ** 19 + 1, -1],
    });
    expect(g).toEqual({ type: 'point', coordinates: [2 ** 19, 0] });
  });
  it('B2-10/11 unit conversion metadata does not alter coordinates or axes on roundtrip', () => {
    const n = native();
    for (const yAxis of ['up', 'down'] as const) {
      const c = unwrap(
        validateFictionMap({
          ...n,
          coordinateSpace: {
            ...n.coordinateSpace,
            yAxis,
            unit: { name: '架空単位', distancePerUnit: { value: Number.MAX_VALUE, unit: 'm' } },
          },
        }),
      );
      expect(unwrap(parseFictionMap(unwrap(serializeFictionMap(c))))).toEqual(c);
      expect(c.features).toEqual(n.features);
    }
    expect(
      validateFictionMap({
        ...n,
        coordinateSpace: {
          ...n.coordinateSpace,
          unit: { name: 'u', distancePerUnit: { value: 0, unit: 'km' } },
        },
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-field' } });
    // Physical metric display and Canvas projection are D2, not tested as D1.
  });
  it('pure Polygon hit is interior union closed Euclidean boundary band, r=0 inclusive', () => {
    const g = geometry({
      type: 'polygon',
      outer: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    });
    for (const [p, r, hit] of [
      [[2, 2], 0, true],
      [[2, 0], 0, true],
      [[2, -1], 0, false],
      [[2, -1], 1, true],
      [[5, 5], 1, false],
      [[5, 5], 2, true],
    ] as const)
      expect(unwrap(hitTestFictionMapGeometry(g, p, r))).toBe(hit);
  });
  it('concave empty AABB area is not hit, reverse winding unchanged, thin Polyline/Point radii', () => {
    const outer = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
      [0, 0],
    ] as const;
    for (const ring of [outer, [...outer].reverse()]) {
      const g = geometry({ type: 'polygon', outer: ring });
      expect(unwrap(hitTestFictionMapGeometry(g, [3, 3], 0))).toBe(false);
      expect(unwrap(hitTestFictionMapGeometry(g, [0.5, 3], 0))).toBe(true);
    }
    const line = geometry({
      type: 'polyline',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
    });
    expect(unwrap(hitTestFictionMapGeometry(line, [5, 1], 1))).toBe(true);
    expect(unwrap(hitTestFictionMapGeometry(line, [5, 1.01], 1))).toBe(false);
    const p = geometry({ type: 'point', coordinates: [0, 0] });
    expect(unwrap(hitTestFictionMapGeometry(p, [3, 4], 5))).toBe(true);
  });
  it('public hit does not trust caller-frozen or forged geometry certificates', () => {
    const g = Object.freeze({ type: 'point' as const, coordinates: [0, 0] as const });
    expect(hitTestFictionMapGeometry(g, [0, 0], 0)).toMatchObject({
      ok: false,
      diagnostic: { code: 'invalid-data' },
    });
  });
  it('independent Python Fraction oracle: 96 represented-value classifications', () => {
    expect(oracle).toHaveLength(96);
    for (const row of oracle) {
      if (row.kind === 'near')
        expect(unwrap(isFictionMapPointNear(row.a, row.b, row.r!))).toBe(row.expected);
      else if (row.kind === 'segment') {
        const g = geometry({
          type: 'polyline',
          coordinates: [row.a!, row.b!] as unknown as readonly FictionMapPoint[],
        });
        expect(unwrap(hitTestFictionMapGeometry(g, row.p, row.r!))).toBe(row.expected);
      } else if (row.kind === 'area') {
        const ps = (row.ring! as unknown as readonly FictionMapPoint[]).map(exactPoint);
        expect(twiceArea(ps) >= 2n * exact(row.threshold!) * quantum).toBe(row.expected);
      } else expect(snapped(row.value!, row.step!)).toBe(row.expected);
    }
  });
});
