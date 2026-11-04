import { afterEach, expect, it, vi } from 'vitest';
import type { Drawing } from '@editor-platform/editor-core';
import { createTypeScriptSpatialIndex } from '@editor-platform/spatial-index';
import * as spatialRuntime from '@editor-platform/spatial-index/experimental';
import { CanvasSpatialQuery } from './spatial-query';

afterEach(() => vi.restoreAllMocks());
type Clip = NonNullable<Drawing['clipBounds']>[number];
for (const indexed of [false, true]) {
  it(`${indexed ? 'indexed' : 'scan'} excludes clipped corners for every panel outline, rotation and reflection`, () => {
    if (indexed)
      vi.spyOn(spatialRuntime, 'getWasmFactory').mockReturnValue((snapshot) =>
        createTypeScriptSpatialIndex(
          Array.from({ length: snapshot.length / 4 }, (_, i) => ({
            x: snapshot[i * 4],
            y: snapshot[i * 4 + 1],
            width: snapshot[i * 4 + 2] - snapshot[i * 4],
            height: snapshot[i * 4 + 3] - snapshot[i * 4 + 1],
          })),
        ),
      );
    const q = new CanvasSpatialQuery();
    for (const shape of [
      'triangle',
      'right-triangle',
      'trapezoid',
      'parallelogram',
      'diamond',
      'hexagon',
      'ellipse',
    ] as const)
      for (const rotation of [0, 37, 90])
        for (const flipX of [false, true])
          for (const flipY of [false, true]) {
            const clip: Clip = {
              x: 120,
              y: 50,
              width: 200,
              height: 80,
              shape,
              rotation,
              flipX,
              flipY,
            };
            const target = {
              id: 'paint',
              bounds: clip,
              hitBounds: { x: 0, y: 0, width: 500, height: 500 },
              hitClipBounds: [clip],
            };
            const world = (x: number, y: number) => {
              x = (x - 0.5) * clip.width * (flipX ? -1 : 1);
              y = (y - 0.5) * clip.height * (flipY ? -1 : 1);
              const a = (rotation * Math.PI) / 180;
              return {
                x: 220 + x * Math.cos(a) - y * Math.sin(a),
                y: 90 + x * Math.sin(a) + y * Math.cos(a),
                width: 0.1,
                height: 0.1,
              };
            };
            // Right-triangle's missing corner is on the right; others omit the top-left.
            expect(
              q.query([target], world(shape === 'right-triangle' ? 0.98 : 0.02, 0.02)),
            ).toEqual([]);
            expect(q.query([target], world(0.45, 0.55))).toEqual([target]);
          }
    q.dispose();
  });
}
it('keeps exact oval boundary hits and detects intersections without an inside marquee corner', () => {
  const q = new CanvasSpatialQuery();
  const clip: Clip = { x: 0, y: 0, width: 100, height: 50, shape: 'ellipse' };
  const target = { id: 'paint', bounds: clip, hitBounds: clip, hitClipBounds: [clip] };
  const x = 50 + 50 / Math.sqrt(2),
    y = 25 + 25 / Math.sqrt(2);
  expect(q.query([target], { x, y, width: 0, height: 0 })).toEqual([target]);
  expect(q.query([target], { x: x + 0.01, y, width: 0, height: 0 })).toEqual([]);
  expect(q.query([target], { x: 0, y: 23, width: 100, height: 4 })).toEqual([target]);
  expect(q.query([target], { x: 0, y: 0, width: 100, height: 50 })).toEqual([target]);
});
it('uses normalized native panel polygons for point, marquee and nested clip hits', () => {
  const q = new CanvasSpatialQuery();
  const bounds = { x: 100, y: 200, width: 400, height: 200 };
  const polygon = [
    { x: 0, y: 0.5 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const target = {
    id: 'slanted',
    bounds,
    hitBounds: bounds,
    hitClipBounds: [{ ...bounds, polygon }],
  };
  expect(q.query([target], { x: 110, y: 210, width: 0, height: 0 })).toEqual([]);
  expect(q.query([target], { x: 110, y: 310, width: 0, height: 0 })).toEqual([target]);
  expect(q.query([target], { x: 100, y: 250, width: 400, height: 1 })).toEqual([target]);
  expect(
    q.query(
      [
        {
          ...target,
          hitClipBounds: [...target.hitClipBounds, { x: 100, y: 200, width: 10, height: 10 }],
        },
      ],
      bounds,
    ),
  ).toEqual([]);
});
it('retains the rotated element hull as well as its panel clip for image/shape/text targets', () => {
  const q = new CanvasSpatialQuery();
  const target = {
    id: 'rotated-art',
    bounds: { x: 100, y: 145, width: 100, height: 10 },
    rotation: 45,
    hitClipBounds: [{ x: 0, y: 0, width: 300, height: 300, shape: 'diamond' as const }],
  };
  expect(q.query([target], { x: 183, y: 113, width: 4, height: 4 })).toEqual([]);
  expect(q.query([target], { x: 150, y: 150, width: 4, height: 4 })).toEqual([target]);
  const sliced = {
    ...target,
    hitClipBounds: [{ x: 100, y: 100, width: 100, height: 100, shape: 'right-triangle' as const }],
  };
  // Marquee overlaps both the element and ancestor separately, but not their common region.
  expect(q.query([sliced], { x: 160, y: 120, width: 30, height: 30 })).toEqual([]);
  expect(q.query([sliced], { x: 125, y: 125, width: 4, height: 8 })).toEqual([sliced]);
});
it('intersects the common visible region across nested polygon and oval clips', () => {
  const q = new CanvasSpatialQuery();
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const target = (clips: Clip[]) => ({
    id: 'paint',
    bounds,
    hitBounds: bounds,
    hitClipBounds: clips,
  });
  const triangle: Clip = { ...bounds, shape: 'right-triangle' };
  const empty = target([triangle, { x: 80, y: 0, width: 20, height: 20 }]);
  expect(q.query([empty], bounds)).toEqual([]);
  const oval = target([
    { ...bounds, shape: 'ellipse' },
    { x: 0, y: 0, width: 5, height: 5 },
  ]);
  expect(q.query([oval], bounds)).toEqual([]);
  const nested = target([{ ...bounds, shape: 'ellipse' }, triangle]);
  expect(q.query([nested], { x: 30, y: 50, width: 10, height: 10 })).toEqual([nested]);
  const separate = target([
    { x: 0, y: 0, width: 60, height: 60, shape: 'ellipse' },
    { x: 50, y: 50, width: 50, height: 50, shape: 'ellipse' },
  ]);
  expect(q.query([separate], bounds)).toEqual([]);
  const overlapping = target([
    { x: 0, y: 0, width: 60, height: 60, shape: 'ellipse' },
    { x: 40, y: 40, width: 50, height: 50, shape: 'ellipse' },
  ]);
  expect(q.query([overlapping], bounds)).toEqual([overlapping]);
});
