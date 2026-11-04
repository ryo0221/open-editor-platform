import { expect, it } from 'vitest';
import { makeDesignElement } from './model';
import { canonicalDivisionPolygon, rectanglePolygon } from './division-geometry';
import { mangaDialoguePlacement } from './manga-dialogue';

it.each([
  [
    [0, 1],
    [1, 0],
    [1, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  [
    [0, 0],
    [1, 1],
    [0, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  [
    [0.2, 0],
    [0.8, 0],
    [1, 1],
    [0, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
])('places the complete dialogue box inside convex polygon %j', (...coordinates) => {
  const polygon = canonicalDivisionPolygon(coordinates.map(([x, y]) => ({ x, y })));
  const parent = {
    ...makeDesignElement('frame'),
    bounds: { x: 700, y: -200, width: 540, height: 740 },
    panelGeometry: { polygon },
  };
  for (const width of [300, 400]) {
    const placement = mangaDialoguePlacement(parent, width)!;
    expect(placement).toBeDefined();
    expect(placement.typography.fontSize).toBeGreaterThanOrEqual(8);
    expect(placement.bounds.width).toBeLessThanOrEqual(width);
    const points = polygon.map((p) => ({ x: p.x * 540 + 700, y: p.y * 740 - 200 }));
    for (const corner of rectanglePolygon(placement.bounds))
      for (const [i, a] of points.entries()) {
        const b = points[(i + 1) % points.length];
        const distance =
          ((b.x - a.x) * (corner.y - a.y) - (b.y - a.y) * (corner.x - a.x)) /
          Math.hypot(b.x - a.x, b.y - a.y);
        expect(distance).toBeGreaterThanOrEqual(8 - 1e-7);
      }
  }
});

it('scales bounds and type together and refuses an unreadable insertion', () => {
  const parent = makeDesignElement('frame');
  parent.bounds = { x: 600, y: 30, width: 150, height: 100 };
  const placement = mangaDialoguePlacement(parent)!;
  expect(placement.bounds.width).toBeCloseTo(134);
  expect(placement.typography.fontSize / 28).toBeCloseTo(placement.bounds.width / 300);
  parent.bounds.width = 30;
  expect(mangaDialoguePlacement(parent)).toBeUndefined();
});
