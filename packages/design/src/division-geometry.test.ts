import { expect, it } from 'vitest';
import {
  materializeDivision,
  validDivisionTree,
  validPanelGeometry,
  insetDivisionPolygon,
  rectanglePolygon,
  canonicalDivisionPolygon,
  type DesignDivisionNode,
} from './division-geometry';

it('uses page origin and Design distances for a nonzero region', () => {
  const result = materializeDivision(
    {
      region: { x: 30, y: 40, width: 540, height: 720 },
      root: {
        dividerId: 'd',
        line: { nx: 1, ny: 0, offset: 300 },
        gap: 20,
        a: { panelId: 'a' },
        b: { panelId: 'b' },
      },
    },
    { x: 100, y: 200, width: 600, height: 800 },
  );
  expect(result.panels.map((p) => p.bounds)).toEqual([
    { x: 130, y: 240, width: 260, height: 720 },
    { x: 410, y: 240, width: 260, height: 720 },
  ]);
});
it('checks depth eight and 32 leaves before computing geometry', () => {
  const chain = (depth: number): DesignDivisionNode =>
    depth
      ? {
          dividerId: `d${depth}`,
          line: { nx: 1, ny: 0, offset: 20 * depth },
          gap: 0,
          a: chain(depth - 1),
          b: { panelId: `p${depth}` },
        }
      : { panelId: 'base' };
  const region = { x: 0, y: 0, width: 500, height: 500 };
  expect(validDivisionTree({ region, root: chain(8) })).toBe(true);
  expect(validDivisionTree({ region, root: chain(9) })).toBe(false);
  const full = (depth: number, key = ''): DesignDivisionNode =>
    depth
      ? {
          dividerId: `d${key}`,
          line: { nx: 1, ny: 0, offset: 100 },
          gap: 0,
          a: full(depth - 1, key + 'a'),
          b: full(depth - 1, key + 'b'),
        }
      : { panelId: `p${key}` };
  expect(validDivisionTree({ region, root: full(5) })).toBe(true);
  expect(validDivisionTree({ region, root: full(6) })).toBe(false);
});
it('rejects concave/self-crossing/noncanonical/out-of-range vertices and unknown fields', () => {
  const rectangle = {
    polygon: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  };
  expect(validPanelGeometry(rectangle)).toBe(true);
  for (const polygon of [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
    [...rectangle.polygon].reverse(),
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 0.2 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    [{ x: -0.01, y: 0 }, ...rectangle.polygon.slice(1)],
  ])
    expect(validPanelGeometry({ polygon })).toBe(false);
  expect(validPanelGeometry({ ...rectangle, shape: 'rectangle' })).toBe(false);
  for (const count of [12, 13]) {
    const points = Array.from({ length: count }, (_, i) => ({
      x: Math.cos((i * Math.PI * 2) / count),
      y: Math.sin((i * Math.PI * 2) / count),
    }));
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y),
      normalized = points.map((p) => ({
        x: (p.x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs)),
        y: (p.y - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys)),
      }));
    expect(validPanelGeometry({ polygon: canonicalDivisionPolygon(normalized) })).toBe(
      count === 12,
    );
  }
});
it('insets overlay badges into a slanted panel rather than its empty AABB corner', () => {
  const polygon = [
    { x: 0, y: 50 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const inset = insetDivisionPolygon(polygon, 14);
  expect(inset.length).toBeGreaterThan(2);
  expect(inset.every((p) => p.x * 0.5 + p.y >= 50 + 14 * Math.hypot(0.5, 1) - 1e-7)).toBe(true);
  expect(insetDivisionPolygon(rectanglePolygon({ x: 0, y: 0, width: 5, height: 5 }), 14)).toEqual(
    [],
  );
});
