import { expect, it } from 'vitest';
import { splineKnots, splinePoints } from './sketch';
import { splineComb } from './curvature';
import {
  baselineSplineKnots,
  baselineSplinePoints,
  baselineSplineComb,
} from './bspline-baseline.fixture';
function identical(a: unknown, b: unknown) {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Object.is(a, b)).toBe(true);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => identical(v, b[i]));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a)).toEqual(Object.keys(b));
    for (const key of Object.keys(a))
      identical((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
    return;
  }
  expect(a).toEqual(b);
}
it('is Object.is identical for degree 2/3/5, open/periodic, seams, defaults and explicit sampling', () => {
  for (const degree of [2, 3, 5])
    for (const closed of [false, true])
      for (const count of [degree + 1, 8, 16]) {
        const poles: Array<[number, number]> = Array.from({ length: count }, (_, i) => [
          Math.sin(i * 0.73) * 31 + i * 3,
          Math.cos(i * 0.19) * 17 - i / 7,
        ]);
        identical(splineKnots(count, degree, closed), baselineSplineKnots(count, degree, closed));
        for (const perSpan of [undefined, 1, 3, 17]) {
          identical(
            splinePoints(poles, degree, closed, perSpan),
            baselineSplinePoints(poles, degree, closed, perSpan),
          );
          identical(
            splineComb(poles, degree, closed, perSpan),
            baselineSplineComb(poles, degree, closed, perSpan),
          );
        }
      }
});
