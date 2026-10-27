import { describe, expect, it } from 'vitest';
import {
  cadCurvature,
  combScale,
  combTip,
  curvatureColor,
  curvatureColors,
  curvatureRange,
  splineComb,
} from './curvature';
import { splinePoints } from './sketch';

describe('curvature display (R2a-4, CAD43)', () => {
  it('combs a spline from its exact derivatives, signed by the turn', () => {
    // A quadratic Bézier: r(t) = (2t, 2t − 2t²), r' = (2, 2 − 4t), r'' = (0, −4).
    const arch = splineComb(
      [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
      2,
      false,
      2,
    );
    expect(arch.map((s) => s.at)).toEqual([
      [0, 0, 0],
      [1, 0.5, 0],
      [2, 0, 0],
    ]);
    // Turning right (clockwise): negative; −8/|r'|³ at the ends, −1 at the top.
    expect(arch[1]!.curvature).toBeCloseTo(-1, 12);
    expect(arch[0]!.curvature).toBeCloseTo(-8 / 8 ** 1.5, 12);
    expect(arch[2]!.curvature).toBeCloseTo(-8 / 8 ** 1.5, 12);
    expect(arch[1]!.normal).toEqual([-0, 1, 0]);
    // The tooth points away from the centre of curvature (below the top).
    expect(combTip(arch[1]!, 0.5)).toEqual([1, 1, 0]);
    // Straight: no curvature, any degree.
    const line = splineComb(
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      3,
      false,
    );
    for (const s of line) expect(Math.abs(s.curvature)).toBeLessThan(1e-12);
    // The comb's points are the drawn curve's; a closed spline around a square turns left
    // everywhere, the same at each quarter.
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    for (const degree of [2, 3, 5]) {
      const poles: [number, number][] = degree === 5 ? [...square, [-5, 5], [5, -5]] : square;
      const comb = splineComb(poles, degree, true, 8);
      const points = splinePoints(poles, degree, true, 8);
      comb.forEach((s, i) => {
        expect(s.at[0]).toBeCloseTo(points[i]![0], 9);
        expect(s.at[1]).toBeCloseTo(points[i]![1], 9);
      });
      if (degree !== 5) {
        for (const s of comb) expect(s.curvature).toBeGreaterThan(0);
        for (let i = 0; i < 8; i++)
          expect(comb[i]!.curvature).toBeCloseTo(comb[i + 8]!.curvature, 9);
      }
    }
  });

  it('matches a finite-difference curvature on a cubic', () => {
    const poles: [number, number][] = [
      [0, 0],
      [10, 15],
      [25, -5],
      [40, 10],
      [50, 0],
    ];
    const comb = splineComb(poles, 3, false, 4);
    const fine = splinePoints(poles, 3, false, 4000);
    // Every comb sample k sits at fine sample 1000k; curvature from three neighbouring points
    // (the circle through them, first-order in the uneven spacing).
    for (let k = 1; k < comb.length - 1; k++) {
      const [a, b, c] = [fine[1000 * k - 1]!, fine[1000 * k]!, fine[1000 * k + 1]!];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const sides =
        Math.hypot(b[0] - a[0], b[1] - a[1]) *
        Math.hypot(c[0] - b[0], c[1] - b[1]) *
        Math.hypot(c[0] - a[0], c[1] - a[1]);
      const near = (2 * cross) / sides;
      expect(Math.abs(comb[k]!.curvature - near)).toBeLessThan(1e-3 * Math.abs(near));
    }
  });

  it('scales a comb to a share of the curve and ranges colours by a percentile', () => {
    const comb = splineComb(
      [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
      2,
      false,
      2,
    );
    const scale = combScale(comb);
    // The longest tooth (the top, curvature 1) is 0.2 of the size (the diagonal of 2 × 0.5).
    expect(scale).toBeCloseTo(cadCurvature.combShare * Math.hypot(2, 0.5), 12);
    expect(
      combScale(
        splineComb(
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          2,
          false,
        ),
      ),
    ).toBe(0);
    // 95% of the magnitudes lie within the range; NaN (no curvature) is left out.
    const values = [
      ...Array.from({ length: 100 }, (_, i) => (i % 2 ? -1 : 1) * (i + 1) * 0.001),
      NaN,
    ];
    expect(curvatureRange(values)).toBeCloseTo(0.095, 12);
    expect(curvatureRange(values, 2)).toBeCloseTo(0.19, 12);
    expect(curvatureRange([0, 0, NaN])).toBe(cadCurvature.flat);
    expect(curvatureRange([])).toBe(cadCurvature.flat);
    expect(curvatureColor(0, 1)).toEqual([...curvatureColors.zero]);
    expect(curvatureColor(5, 1)).toEqual([...curvatureColors.positive]);
    expect(curvatureColor(-1, 1)).toEqual([...curvatureColors.negative]);
    expect(curvatureColor(NaN, 1)).toEqual([...curvatureColors.none]);
    const half = curvatureColor(0.5, 1);
    expect(half[0]).toBeCloseTo((curvatureColors.zero[0] + curvatureColors.positive[0]) / 2, 12);
  });
});
