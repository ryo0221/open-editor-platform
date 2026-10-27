import { describe, expect, it } from 'vitest';
import {
  cadContinuity,
  continuityReport,
  curvatureDeviation,
  type CadContinuitySample,
} from './continuity';

const sample = (
  i: number,
  g0Mm: number,
  g1Deg: number,
  curvature: [number, number],
): CadContinuitySample => ({ at: [i, 0, 0], g0Mm, g1Deg, curvature });

describe('continuity report (R2a-4, CAD43)', () => {
  it('judges each level at every sample, a value equal to its tolerance passing', () => {
    const at = continuityReport([
      sample(0, 0, 0, [0.01, 0.01]),
      sample(1, cadContinuity.g0Mm, cadContinuity.g1Deg, [0.01, 0.0099]),
      sample(2, 0, 0, [0.01, 0.01]),
    ]);
    expect(at).toMatchObject({
      samples: 3,
      level: 'G2',
      g0: { max: 0.0001, at: [1, 0, 0], pass: true },
      g1: { max: 0.1, at: [1, 0, 0], pass: true },
      g2: { at: [1, 0, 0], pass: true },
    });
    expect(at.g2.max).toBeCloseTo(0.01, 12);
    expect(at.g2.difference).toBeCloseTo(0.0001, 12);
    // Past each tolerance: the level drops to the one below, G2 only with G1, G1 only with G0.
    const past = (g0Mm: number, g1Deg: number, curvature: [number, number]) =>
      continuityReport([sample(0, 0, 0, [0, 0]), sample(1, g0Mm, g1Deg, curvature)]).level;
    expect(past(0, 0, [0.01, 0.00989])).toBe('G1');
    expect(past(0, 0.1001, [0, 0])).toBe('G0');
    expect(past(0.00011, 0, [0, 0])).toBe('none');
    expect(past(0.00011, 0.2, [0.01, 0])).toBe('none');
    expect(() => continuityReport([])).toThrow('continuity-no-samples');
  });

  it('counts both faces flat (radii past 10,000 mm) as G2 at that sample', () => {
    expect(curvatureDeviation([0, 0])).toBe(0);
    expect(curvatureDeviation([1 / 10_000, -1 / 20_000])).toBe(0);
    expect(curvatureDeviation([1 / 9_000, 0])).toBe(1);
    expect(curvatureDeviation([0.05, 0])).toBe(1);
    expect(curvatureDeviation([-0.05, -0.05])).toBe(0);
    // Opposite bending is a difference of both curvatures.
    expect(curvatureDeviation([0.01, -0.01])).toBe(2);
  });
});
