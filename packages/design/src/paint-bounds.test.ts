import { expect, it } from 'vitest';
import { gridTextLayout, type Drawing } from '@editor-platform/editor-core';
import { designExportPaintBounds, designPaintBounds } from './paint-bounds';

const bounds = { x: 0, y: 0, width: 100, height: 20 };
const shape: Drawing = { id: 'part', kind: 'shape', bounds, fill: 'red', text: '' };

it('keeps rotated component parts and their strokes outside an instance hit box', () => {
  expect(
    designPaintBounds([{ ...shape, rotation: 90, strokeWidth: 10 }], {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }),
  ).toEqual({ x: 0, y: -60, width: 80, height: 140 });
});

it('keeps unbounded text and image error UI mounted', () => {
  expect(
    designPaintBounds(
      [{ ...shape, kind: 'text', text: 'Visible overflow', typography: { overflow: 'expand' } }],
      bounds,
    ),
  ).toBeUndefined();
  expect(designPaintBounds([{ ...shape, kind: 'image', src: 'broken' }], bounds)).toBeUndefined();
  expect(
    designPaintBounds(
      [{ ...shape, kind: 'text', text: 'Clipped', typography: { overflow: 'clip' } }],
      bounds,
    ),
  ).toBeDefined();
});

it('exports expanded vertical text by its grid layout (Codex on #29)', () => {
  const text: Drawing = {
    ...shape,
    kind: 'text',
    text: 'あ'.repeat(400),
    typography: { fontSize: 20, overflow: 'expand', writingMode: 'vertical-rl' },
  };
  // A 20 px tall box holds about one cell a column, so the columns run far to the left of it.
  const layout = gridTextLayout(text);
  const leftmost = Math.min(...layout.lines.flatMap((l) => l.glyphs.map((g) => g.x)));
  expect(leftmost).toBeLessThan(-200);
  const e = designExportPaintBounds([text], bounds);
  expect(e.x).toBeLessThanOrEqual(leftmost - 10);
  expect(e.x + e.width).toBeGreaterThanOrEqual(bounds.width);
});
