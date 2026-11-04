import { it, expect } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { createFictionMap, type FictionMapContent } from './model';
import { layoutMapLabels } from './label-layout';
import { projectTargets } from './surface-projection';
it('declutters coincident labels deterministically, gives selection priority, and leaves native and hit bounds intact', () => {
  const map: FictionMapContent = {
    ...createFictionMap(),
    layers: [{ id: 'l', name: 'Places', purpose: 'settlement', visibleByDefault: true }],
    features: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: 'Coincident',
      layerId: 'l',
      featureKind: 'place',
      geometry: { type: 'point', coordinates: [100, 100] },
    })),
  };
  const before = canonicalJson(map);
  for (const zoom of [0.25, 1, 4]) {
    const labels = layoutMapLabels(map, zoom, new Map(), ['p11']);
    expect(labels.get('p11')).toEqual({ x: 12, y: -12 });
    const placed = [...labels.values()].filter((v) => v !== null);
    expect(placed).toHaveLength(8);
    expect(new Set(placed.map((v) => JSON.stringify(v))).size).toBe(8);
    expect(layoutMapLabels(map, zoom, new Map(), ['p11'])).toEqual(labels);
    const targets = projectTargets(map, zoom, new Map(), new Set(), labels);
    expect(targets.map((t) => t.bounds)).toEqual(
      projectTargets(map, zoom, new Map(), new Set()).map((t) => t.bounds),
    );
    for (const target of targets) {
      const label = labels.get(target.id);
      if (!label) continue;
      expect(target.paintBounds!.x).toBeLessThanOrEqual(100 + label.x / zoom);
      expect(target.paintBounds!.y).toBeLessThanOrEqual(100 + label.y / zoom);
    }
  }
  expect(layoutMapLabels(map, 1, new Map([['l', false]]), [])).toEqual(new Map());
  expect(canonicalJson(map)).toBe(before);
});
