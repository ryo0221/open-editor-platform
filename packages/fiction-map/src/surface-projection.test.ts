import { describe, expect, it } from 'vitest';
import { createFictionMap, validateFictionMap } from './model';
import {
  documentFrame,
  hitCandidates,
  hitRadius,
  projectTargets,
  queryAt,
  stagePoint,
  nativePoint,
  translationPreview,
} from './surface-projection';
function content() {
  const r = validateFictionMap({
    ...createFictionMap(),
    layers: [
      { id: 'back', name: 'Back', purpose: 'terrain', visibleByDefault: true },
      { id: 'front', name: 'Front', purpose: 'annotation', visibleByDefault: true },
    ],
    features: [
      {
        id: 'line',
        layerId: 'front',
        name: 'Line',
        featureKind: 'path',
        geometry: {
          type: 'polyline',
          coordinates: [
            [10, 10],
            [50, 10],
          ],
        },
        style: { lineWidth: 8 },
      },
      {
        id: 'region',
        layerId: 'back',
        name: 'Region',
        featureKind: 'region',
        geometry: {
          type: 'polygon',
          outer: [
            [0, 0],
            [100, 0],
            [100, 20],
            [20, 20],
            [20, 100],
            [0, 100],
            [0, 0],
          ],
        },
      },
    ],
  });
  if (!r.ok) throw Error(r.diagnostic.code);
  return r.value;
}
describe('D2 projection (native stays separate from camera)', () => {
  it('inverts both native y axes without interpreting Geo coordinates', () => {
    for (const axis of ['up', 'down'] as const) {
      expect(nativePoint(stagePoint([180, 90], axis), axis)).toEqual([180, 90]);
    }
    const c = content();
    expect(documentFrame({ ...c, coordinateSpace: { ...c.coordinateSpace, yAxis: 'up' } })).toEqual(
      { x: 0, y: -1024, width: 1024, height: 1024 },
    );
  });
  it('uses committed affine camera including viewport translation and y inversion', () => {
    expect(queryAt({ a: 0, b: 2, c: -2, d: 0, e: 80, f: 20 }, { x: 60, y: 60 }, 'up')).toEqual({
      point: [20, -10],
      zoom: 2,
    });
    expect(queryAt({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, { x: 1, y: 1 }, 'down')).toBeUndefined();
  });
  it('paints by layer then native feature order and does not enable unsupported transforms', () => {
    const t = projectTargets(content(), 1, new Map(), new Set());
    expect(t.map((t) => t.id)).toEqual(['region', 'line']);
    expect(
      t.every((t) => t.resizable === false && t.rotatable === false && !t.hitBox && !t.hitBounds),
    ).toBe(true);
  });
  it('matches closed CSS stroke bands at multiple zooms', () => {
    const c = content(),
      f = c.features[0];
    for (const zoom of [0.25, 1, 4]) {
      expect(hitRadius(f, zoom)).toBe(4 / zoom);
      expect(hitCandidates(c, [40, 10 + 4 / zoom], zoom, new Map(), new Set())[0]).toBe('line');
      expect(
        hitCandidates(c, [40, 10 + 4 / zoom + 0.001], zoom, new Map(), new Set()),
      ).not.toContain('line');
    }
  });
  it('preserves concave empty areas and top-first overlap order', () => {
    const c = content();
    expect(hitCandidates(c, [60, 60], 1, new Map(), new Set())).toEqual([]);
    expect(hitCandidates(c, [15, 10], 1, new Map(), new Set())).toEqual(['line', 'region']);
  });
  it('does not invent a world-unit epsilon for sub-unit and zero-height bounds', () => {
    const c = content();
    const t = projectTargets(c, 1, new Map(), new Set()).find((t) => t.id === 'line')!;
    expect(t.bounds.height).toBe(0);
  });
  it('filters hidden/locked even label owners, includes the rendered label owner away from geometry', () => {
    const c = content();
    expect(hitCandidates(c, [80, 80], 1, new Map(), new Set(), 'line')).toEqual(['line']);
    expect(hitCandidates(c, [15, 10], 1, new Map([['front', false]]), new Set(), 'line')).toEqual([
      'region',
    ]);
    expect(hitCandidates(c, [15, 10], 1, new Map(), new Set(['line']), 'line')).toEqual(['region']);
  });
  it('translates zero extents without generic resize division or clamp', () => {
    const targets = projectTargets(content(), 1, new Map(), new Set());
    const t = targets.find((t) => t.id === 'line')!;
    const preview = translationPreview(targets, ['line'], { dx: 5, dy: -3, dw: 0, dh: 0 });
    expect(preview.get('line')).toEqual({
      bounds: { ...t.bounds, x: t.bounds.x + 5, y: t.bounds.y - 3 },
      rotation: 0,
    });
    expect(preview.get('line')!.bounds.height).toBe(0);
    const vertical = { ...t, id: 'vertical', bounds: { x: 10, y: 10, width: 0, height: 40 } };
    expect(
      translationPreview([vertical], ['vertical'], { dx: 2, dy: 4, dw: 0, dh: 0 }).get('vertical')!
        .bounds,
    ).toEqual({ x: 12, y: 14, width: 0, height: 40 });
  });
  it('refuses partial, non-move and unresolved previews', () => {
    const ts = projectTargets(content(), 1, new Map(), new Set(['line']));
    for (const [ids, d] of [
      [['region', 'line'], { dx: 1, dy: 1, dw: 0, dh: 0 }],
      [['missing'], { dx: 1, dy: 1, dw: 0, dh: 0 }],
      [[], { dx: 1, dy: 1, dw: 0, dh: 0 }],
      [['region'], { dx: 1, dy: 1, dw: 1, dh: 0 }],
    ] as const)
      expect(translationPreview(ts, [...ids], d).size).toBe(0);
  });
});
