import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { createFictionMap } from './model';
import { createFictionMapProjection, hitFictionMapProjection, renderFictionMapSvg } from './render';

function map(axis: 'up' | 'down') {
  return {
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane' as const,
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      unit: { name: 'map-unit' },
      yAxis: axis,
    },
    layers: [
      { id: 'visible', name: 'Visible', purpose: 'annotation' as const, visibleByDefault: true },
      { id: 'hidden', name: 'Hidden', purpose: 'annotation' as const, visibleByDefault: false },
    ],
    features: [
      {
        id: 'a',
        name: 'A',
        featureKind: 'place' as const,
        layerId: 'visible',
        geometry: { type: 'point' as const, coordinates: [30, 20] as const },
      },
      {
        id: 'b',
        name: 'B',
        featureKind: 'place' as const,
        layerId: 'visible',
        geometry: { type: 'point' as const, coordinates: [80, 70] as const },
      },
      {
        id: 'secret',
        name: 'Hidden',
        featureKind: 'place' as const,
        layerId: 'hidden',
        geometry: { type: 'point' as const, coordinates: [30, 20] as const },
      },
    ],
    namedViews: [
      {
        id: 'subset',
        name: 'Subset',
        extent: { minX: 10, minY: 10, maxX: 50, maxY: 30 },
        visibleLayerIds: ['visible'],
      },
    ],
  };
}
it.each(['up', 'down'] as const)(
  'SB04/07/09: %s projection keeps SVG, marker and hit coordinates aligned through resize',
  (axis) => {
    const source = map(axis),
      before = canonicalJson(source);
    for (const [width, height] of [
      [200, 200],
      [400, 100],
      [100, 300],
    ]) {
      const options = { width, height, view: { kind: 'named' as const, id: 'subset' } };
      const p = createFictionMapProjection(source, options);
      const marker = p.visiblePoint([30, 20])!;
      expect(renderFictionMapSvg(source, options).svg).toContain(
        `cx="${marker.x}" cy="${marker.y}"`,
      );
      expect(p.unproject(marker)).toEqual([30, 20]);
      expect(hitFictionMapProjection(p, marker)).toEqual(['a']);
      expect(p.visiblePoint([80, 70])).toBeUndefined();
      expect(p.unproject({ x: p.clip.x - 1, y: marker.y })).toBeUndefined();
      expect(hitFictionMapProjection(p, { x: p.clip.x - 1, y: marker.y })).toEqual([]);
      expect(Object.isFrozen(p.clip)).toBe(true);
    }
    expect(canonicalJson(source)).toBe(before);
  },
);
it('SB04/09: saved visible layers and feature subset control both background and hit candidates', () => {
  const source = map('up');
  const options = { width: 100, height: 100, featureIds: ['b'] };
  const p = createFictionMapProjection(source, options);
  expect(p.features.map((f) => f.id)).toEqual(['b']);
  expect(hitFictionMapProjection(p, p.project([30, 20]))).toEqual([]);
  expect(hitFictionMapProjection(p, p.project([80, 70]))).toEqual(['b']);
  const svg = renderFictionMapSvg(source, options).svg;
  expect(svg).not.toContain('data-feature-id="a"');
  expect(svg).not.toContain('data-feature-id="secret"');
});
it('SB09: caller mutation cannot change a captured projection, view or subset', () => {
  const source = map('down'),
    options = { width: 100, height: 100, featureIds: ['a'] };
  const p = createFictionMapProjection(source, options);
  options.featureIds[0] = 'b';
  source.features[0].name = 'Changed';
  expect(p.features.map((f) => f.id)).toEqual(['a']);
  expect(p.features[0].name).toBe('A');
});

it.each(['up', 'down'] as const)(
  'SB07: far outside %s markers are clipped before SVG coordinate projection',
  (axis) => {
    const source = map(axis);
    source.coordinateSpace.bounds = { minX: 0, minY: 0, maxX: 100000, maxY: 100000 };
    source.namedViews[0].extent = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    source.features = [];
    const options = { width: 1000, height: 1000, view: { kind: 'named' as const, id: 'subset' } };
    expect(() => renderFictionMapSvg(source, options)).not.toThrow();
    const projection = createFictionMapProjection(source, options);
    expect(projection.visiblePoint([2, 2])).toBeUndefined();
    expect(projection.visiblePoint([100000, 100000])).toBeUndefined();
    expect(projection.visiblePoint([0.5, 0.5])).toEqual({ x: 500, y: 500 });
    expect(projection.visiblePoint([Number.NaN, 0])).toBeUndefined();
  },
);
