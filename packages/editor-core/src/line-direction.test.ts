import { expect, it } from 'vitest';
import {
  drawingSvg,
  lineArrowheads,
  shapePath,
  shapePrimitives,
  straightLineEnds,
} from './drawing';
import { validVisualStyle } from './validation';

const box = { x: 10, y: 20, width: 100, height: 60 };

it('runs a straight line horizontally by default, or vertically and diagonally (#589)', () => {
  expect(shapePath('line', 100, 60)).toBe('M0 30 H100');
  expect(shapePath('arrow', 100, 60, 'vertical')).toBe('M50 0 L50 60');
  expect(shapePath('arrow', 100, 60, 'down')).toBe('M0 0 L100 60');
  expect(shapePath('double-arrow', 100, 60, 'up')).toBe('M0 60 L100 0');
  expect(straightLineEnds(box, 'up')).toEqual([
    { x: 10, y: 80 },
    { x: 110, y: 20 },
  ]);
});

it('points the heads along the line, and keeps the horizontal heads as before', () => {
  expect(lineArrowheads('arrow', box, {})).toEqual(['M100 44 L110 50 L100 56']);
  expect(lineArrowheads('double-arrow', box, {})).toEqual([
    'M100 44 L110 50 L100 56',
    'M20 44 L10 50 L20 56',
  ]);
  // Downward: the tip is the bottom end, the head's sides are 10 back along the line.
  const [head] = lineArrowheads(
    'arrow',
    { x: 0, y: 0, width: 0, height: 60 },
    {
      lineDirection: 'vertical',
    },
  );
  expect(head).toBe('M6 50 L0 60 L-6 50');
  const diagonal = lineArrowheads(
    'arrow',
    { x: 0, y: 0, width: 60, height: 80 },
    {
      lineDirection: 'down',
    },
  )[0]!;
  const [x0, y0, , , x2, y2] = diagonal.match(/-?[\d.]+/g)!.map(Number);
  // Both sides are 10 back along (0.6, 0.8) from the tip (60, 80), 6 to either side.
  expect((x0! + x2!) / 2).toBeCloseTo(54, 9);
  expect((y0! + y2!) / 2).toBeCloseTo(72, 9);
  // Elbow and curve keep their heads.
  expect(lineArrowheads('elbow', box, { arrowhead: 'end', lineDirection: 'up' })).toEqual([
    'M100 74 L110 80 L100 86',
  ]);
  expect(shapePrimitives('arrow', box, { lineDirection: 'down' }, '#000')).toHaveLength(2);
});

it('accepts only the known directions', () => {
  expect(validVisualStyle({ lineDirection: 'vertical' })).toBe(true);
  expect(validVisualStyle({ lineDirection: 'sideways' })).toBe(false);
});

it('names an SVG by its title (#589)', () => {
  const svg = drawingSvg([], { x: 0, y: 0, width: 10, height: 10 }, '#fff', '題 <1>');
  expect(svg).toContain('<title>題 &lt;1&gt;</title>');
  expect(drawingSvg([], { x: 0, y: 0, width: 10, height: 10 })).not.toContain('<title>');
});
