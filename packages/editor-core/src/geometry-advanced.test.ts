import { describe, it, expect } from 'vitest';
import {
  alignGeometry,
  distributeGeometry,
  transformGeometry,
  selectedRoots,
  resizedBounds,
  resizedRotatedBounds,
  intersectsRotated,
  screenToWorld,
  type GeometryItem,
} from './geometry';
const objects: GeometryItem[] = [
  { id: 'a', bounds: { x: 10, y: 20, width: 20, height: 30 } },
  { id: 'b', bounds: { x: 80, y: 90, width: 40, height: 20 } },
  { id: 'c', bounds: { x: 180, y: 160, width: 30, height: 40 } },
];
describe('visual geometry contract', () => {
  it('uses oriented geometry for marquee hit testing', () => {
    const box = { x: 100, y: 100, width: 200, height: 20 };
    expect(intersectsRotated({ x: 190, y: 20, width: 20, height: 10 }, box, 90)).toBe(true);
    expect(intersectsRotated({ x: 105, y: 105, width: 10, height: 10 }, box, 90)).toBe(false);
    expect(intersectsRotated({ x: 125, y: 175, width: 5, height: 5 }, box, 45)).toBe(false);
  });
  it('keeps the opposite rotated handle anchored and scales group children in parent axes', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 };
    const resized = resizedRotatedBounds(box, 90, 'e', 0, 40);
    expect(resized).toEqual({ x: 80, y: 120, width: 240, height: 100 });
    const group = { id: 'g', bounds: box, rotation: 90 };
    const child = {
      id: 'c',
      parentId: 'g',
      rotation: 90,
      bounds: { x: 190, y: 190, width: 20, height: 20 },
    };
    const result = transformGeometry([group, child], ['g'], { dx: -20, dy: 20, dw: 40, dh: 0 });
    expect(result.get('g')?.bounds).toEqual(resized);
    expect(result.get('c')?.bounds).toEqual({ x: 188, y: 220, width: 24, height: 20 });
    for (const angle of [0, 30, 90, 135])
      for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const theta = (angle * Math.PI) / 180;
        const localDx = handle.includes('w') ? -20 : handle.includes('e') ? 20 : 0;
        const localDy = handle.includes('n') ? -10 : handle.includes('s') ? 10 : 0;
        const next = resizedRotatedBounds(
          box,
          angle,
          handle,
          localDx * Math.cos(theta) - localDy * Math.sin(theta),
          localDx * Math.sin(theta) + localDy * Math.cos(theta),
        );
        expect(next.width).toBeCloseTo(box.width + Math.abs(localDx));
        expect(next.height).toBeCloseTo(box.height + Math.abs(localDy));
      }
  });
  it('aligns all six edges/centres and preserves unequal sizes', () => {
    for (const mode of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) {
      const m = alignGeometry(objects, ['a', 'b', 'c'], mode);
      const b = m.get('b')!;
      expect(b.width).toBe(40);
      expect(b.height).toBe(20);
      expect(
        mode === 'left'
          ? b.x
          : mode === 'right'
            ? b.x + b.width
            : mode === 'center'
              ? b.x + b.width / 2
              : mode === 'top'
                ? b.y
                : mode === 'bottom'
                  ? b.y + b.height
                  : b.y + b.height / 2,
      ).toBe(
        mode === 'left'
          ? 10
          : mode === 'right'
            ? 210
            : mode === 'center'
              ? 110
              : mode === 'top'
                ? 20
                : mode === 'bottom'
                  ? 200
                  : 110,
      );
    }
  });
  it('distributes bounding-box gaps with endpoints fixed and accepts explicit gap', () => {
    const m = distributeGeometry(objects, ['c', 'a', 'b'], 'x');
    expect(m.get('a')!.x).toBe(10);
    expect(m.get('c')!.x).toBe(180);
    expect(m.get('b')!.x - 30).toBe(180 - (m.get('b')!.x + 40));
    expect(distributeGeometry(objects, ['a', 'b', 'c'], 'y', 12).get('b')!.y).toBe(62);
  });
  it('scales nested geometry once when parent and child are selected', () => {
    const items = [
      { id: 'g', bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'child', parentId: 'g', bounds: { x: 10, y: 20, width: 20, height: 30 } },
    ];
    expect(selectedRoots(items, ['g', 'child']).map((i) => i.id)).toEqual(['g']);
    const m = transformGeometry(items, ['g', 'child'], { dx: 5, dy: 10, dw: 100, dh: 100 });
    expect(m.get('child')!.bounds).toEqual({ x: 25, y: 50, width: 40, height: 60 });
  });
  it('rejects locked descendants and mixed parents without partial changes', () => {
    expect(() =>
      transformGeometry(
        [...objects, { id: 'locked', parentId: 'a', locked: true, bounds: objects[0].bounds }],
        ['a'],
        { dx: 1, dy: 0, dw: 0, dh: 0 },
      ),
    ).toThrow(/Unlock/);
    expect(() =>
      alignGeometry([objects[0], { ...objects[1], parentId: 'a' }], ['a', 'b'], 'left'),
    ).not.toThrow();
  });
  it('maps screen coordinates after pan and arbitrary zoom', () => {
    for (const zoom of [0.25, 1, 2])
      expect(
        screenToWorld(
          { x: 40 + 120 * zoom, y: 60 + 80 * zoom },
          { x: 10, y: 20 },
          { x: 30, y: 40 },
          zoom,
        ),
      ).toEqual({ x: 120, y: 80 });
  });
  it('resizes west/north handles with fixed opposite corner and ratio lock', () => {
    expect(resizedBounds({ x: 10, y: 10, width: 100, height: 50 }, 'nw', -100, -50, true)).toEqual({
      x: -90,
      y: -40,
      width: 200,
      height: 100,
    });
  });
});
