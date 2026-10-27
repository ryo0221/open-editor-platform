import type { Vec3 } from './model';

/**
 * The fixed continuity check of an edge between two faces (docs/cad/r2a-freeform.md,
 * 連続性の判定と表示): samples at equal steps of the edge's parameter, both ends included, and
 * the fixed tolerances. A sample judgement, never a guarantee between the samples.
 */
export const cadContinuity = Object.freeze({
  samples: 65,
  /** Distance between the two faces, mm: the result tolerance limit. */
  g0Mm: 0.0001,
  /** Angle between the two faces' normals, degrees. */
  g1Deg: 0.1,
  /** Difference of the normal curvatures across the edge, as a share of the larger one. */
  g2Relative: 0.01,
  /** Both curvature radii above this (mm): flat, and G2 holds at that sample. */
  flatRadiusMm: 10_000,
});

/**
 * One sample on the edge, as the kernel measures it from the faces' exact geometry: where it
 * lies (model space, mm), the distance between the faces, the angle between their oriented
 * normals and each face's normal curvature (1/mm) in the direction across the edge.
 */
export interface CadContinuitySample {
  at: Vec3;
  g0Mm: number;
  g1Deg: number;
  curvature: [number, number];
}
export interface CadContinuityLevel {
  /** The largest deviation over the samples (mm, degrees, or a share for G2). */
  max: number;
  /** The sample where it is largest (the first such sample). */
  at: Vec3;
  /** Every sample is within the tolerance. */
  pass: boolean;
}
export interface CadContinuityReport {
  samples: number;
  g0: CadContinuityLevel;
  g1: CadContinuityLevel;
  /** `max` is the curvature difference as a share of the larger curvature. */
  g2: CadContinuityLevel & {
    /** The largest difference of the two curvatures, 1/mm. */
    difference: number;
  };
  /** The highest level met at every sample: G2 only with G1, G1 only with G0. */
  level: 'G2' | 'G1' | 'G0' | 'none';
}

/** A value equal to its tolerance passes: the comparison allows rounding of 1e-9 of it. */
const within = (value: number, tolerance: number) => value <= tolerance * (1 + 1e-9);

/** G2 deviation at one sample: 0 when both faces are flat there, else the relative difference. */
export function curvatureDeviation([a, b]: readonly [number, number]): number {
  const flat = 1 / cadContinuity.flatRadiusMm;
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger <= flat * (1 + 1e-9)) return 0;
  return Math.abs(a - b) / larger;
}

/** The report of an edge's samples (at least one). */
export function continuityReport(samples: readonly CadContinuitySample[]): CadContinuityReport {
  if (!samples.length) throw new Error('continuity-no-samples');
  const level = (value: (s: CadContinuitySample) => number, tolerance: number) => {
    let best = samples[0]!;
    for (const s of samples) if (value(s) > value(best)) best = s;
    return {
      max: value(best),
      at: best.at,
      pass: samples.every((s) => within(value(s), tolerance)),
    };
  };
  const g0 = level((s) => s.g0Mm, cadContinuity.g0Mm);
  const g1 = level((s) => s.g1Deg, cadContinuity.g1Deg);
  const g2 = {
    ...level((s) => curvatureDeviation(s.curvature), cadContinuity.g2Relative),
    difference: Math.max(...samples.map((s) => Math.abs(s.curvature[0] - s.curvature[1]))),
  };
  return {
    samples: samples.length,
    g0,
    g1,
    g2,
    level: !g0.pass ? 'none' : !g1.pass ? 'G0' : !g2.pass ? 'G1' : 'G2',
  };
}
