import { expect, it } from 'vitest';
import { canvasDetailScale } from './index';

it('rounds the zoom down to a power of two, so drawings re-render only at each step (#124)', () => {
  expect(canvasDetailScale(1)).toBe(1);
  expect(canvasDetailScale(1.5)).toBe(1);
  expect(canvasDetailScale(0.0136)).toBe(2 ** -7);
  expect(canvasDetailScale(0.0137)).toBe(canvasDetailScale(0.009));
  // Never above the real zoom, so nothing visible is left out.
  for (const zoom of [0.003, 0.02, 0.3, 2.5, 8])
    expect(canvasDetailScale(zoom)!).toBeLessThanOrEqual(zoom);
  expect(canvasDetailScale(0)).toBeUndefined();
  expect(canvasDetailScale(Number.NaN)).toBeUndefined();
});
