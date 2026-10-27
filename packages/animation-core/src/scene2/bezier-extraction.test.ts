import { expect, it } from 'vitest';
import { baselinePointOnAnimationPath2 } from './bezier-baseline.fixture';
import { pointOnAnimationPath2 } from './evaluate';
import type { VectorPath2 } from './model';
// Existing scene2 and limiting-tangent fixtures, plus mixed/degenerate segments.
const paths: VectorPath2[] = [
  [
    ['M', 0, 0],
    ['C', 0, 100, 100, 100, 100, 0],
  ],
  [
    ['M', 0, 0],
    ['C', 20, 40, 100, 100, 100, 100],
  ],
  [
    ['M', 0, 0],
    ['Q', 100, 100, 100, 100],
  ],
  [
    ['M', 0, 0],
    ['C', 0, 0, 0, 0, 0, 0],
  ],
  [
    ['M', 0, 0],
    ['C', 0, 0, 10, 20, 30, 40],
  ],
  [
    ['M', 0, 0],
    ['C', 1, 1, -1, -1, 0, 0],
  ],
  [['M', -0, 0], ['L', 10, -20], ['C', 30, -40, 1e6, -1e6, 100, 0], ['Q', 1, 2, 3, 4], ['Z']],
];
it('is Object.is identical to the pre-extraction evaluator (including rotation, clamping and cache)', () => {
  for (const path of paths)
    for (const frozen of [false, true]) {
      const input = structuredClone(path);
      if (frozen) {
        input.forEach(Object.freeze);
        Object.freeze(input);
      }
      for (const t of [
        -1,
        -0,
        0,
        1e-9,
        0.25,
        0.5,
        0.75,
        1 - 1e-9,
        1,
        2,
        ...Array.from({ length: 101 }, (_, i) => i / 100),
      ]) {
        const expected = baselinePointOnAnimationPath2(input, t),
          actual = pointOnAnimationPath2(input, t);
        for (const key of ['x', 'y', 'rotation'] as const)
          expect(Object.is(actual[key], expected[key]), `${key} at ${t}`).toBe(true);
      }
    }
});
