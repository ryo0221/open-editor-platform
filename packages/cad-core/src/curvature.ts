import { deBoor, derivative, fullSpline } from './bspline';
import type { Vec3 } from './model';

/**
 * The curvature display (docs/cad/r2a-freeform.md, 連続性の判定と表示): display only, never
 * part of the content or its hash.
 */
export const cadCurvature = Object.freeze({
  /** Samples of an edge's comb, both ends included. */
  combSamples: 129,
  /** Samples per knot span of a spline's comb in Sketch mode. */
  combPerSpan: 16,
  /** The longest tooth of a comb at scale 1, as a share of the curve's size. */
  combShare: 0.2,
  /** The colour range at scale 1: this share of the shown nodes is inside it. */
  rangePercentile: 0.95,
  /** Curvatures within this of zero (1/mm, a radius over 10,000 mm) count as flat. */
  flat: 1 / 10_000,
});

/**
 * One tooth of a curvature comb: the point on the curve, its curvature (1/mm) and the unit
 * normal toward the centre of curvature (`[0, 0, 0]` where the curve is straight). A 2D comb
 * (Sketch mode) signs the curvature by the turn instead: positive turning left, with the left
 * normal.
 */
export interface CadCombSample {
  at: Vec3;
  curvature: number;
  normal: Vec3;
}

/** The tip of a tooth: away from the centre of curvature, `scale` mm per 1/mm of curvature. */
export function combTip(s: CadCombSample, scale: number): Vec3 {
  const k = -s.curvature * scale;
  return [s.at[0] + k * s.normal[0], s.at[1] + k * s.normal[1], s.at[2] + k * s.normal[2]];
}

/** The comb scale (mm per 1/mm) whose longest tooth is `combShare` of the curve's size. */
export function combScale(samples: readonly CadCombSample[]): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let largest = 0;
  for (const s of samples) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, s.at[i]!);
      max[i] = Math.max(max[i]!, s.at[i]!);
    }
    largest = Math.max(largest, Math.abs(s.curvature));
  }
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return largest > cadCurvature.flat && size > 0 ? (cadCurvature.combShare * size) / largest : 0;
}

/**
 * The curvature comb of a sketch spline (the same uniform knots as `splinePoints`), in the
 * sketch plane: `perSpan` samples per knot span, both ends included. Curvature is signed by the
 * turn (positive turning left) with the left normal, from the spline's exact first and second
 * derivatives.
 */
export function splineComb(
  poles: readonly (readonly [number, number])[],
  degree: number,
  closed: boolean,
  perSpan: number = cadCurvature.combPerSpan,
): CadCombSample[] {
  const n = poles.length;
  const p = degree;
  const { cps, knots } = fullSpline(p, closed, poles);
  const d1 = derivative(cps, knots, p);
  const d2 = derivative(d1, knots.slice(1, -1), p - 1);
  const spans = closed ? n : n - p;
  const out: CadCombSample[] = [];
  for (let k = 0; k <= spans * perSpan; k++) {
    const t = k / perSpan;
    const sp = p + Math.min(Math.floor(t), spans - 1);
    const at = deBoor(cps, knots, p, sp, t);
    const [x1, y1] = deBoor(d1, knots.slice(1, -1), p - 1, sp - 1, t);
    const [x2, y2] = deBoor(d2, knots.slice(2, -2), p - 2, sp - 2, t);
    const speed = Math.hypot(x1, y1);
    const curvature = speed > 0 ? (x1 * y2 - y1 * x2) / speed ** 3 : 0;
    out.push({
      at: [at[0], at[1], 0],
      curvature,
      normal: speed > 0 ? [-y1 / speed, x1 / speed, 0] : [0, 0, 0],
    });
  }
  return out;
}

/**
 * The symmetric colour range of curvature values: the `rangePercentile` quantile of their
 * magnitudes (NaN left out), at least `flat`, times `scale`.
 */
export function curvatureRange(values: Iterable<number>, scale = 1): number {
  const magnitudes: number[] = [];
  for (const v of values) if (Number.isFinite(v)) magnitudes.push(Math.abs(v));
  magnitudes.sort((a, b) => a - b);
  const at = magnitudes[Math.floor((magnitudes.length - 1) * cadCurvature.rangePercentile)] ?? 0;
  return Math.max(at, cadCurvature.flat) * scale;
}

/** The ends and middle of the diverging map: concave (negative), flat, convex (positive). */
export const curvatureColors = Object.freeze({
  negative: [0.15, 0.39, 0.92] as const,
  zero: [0.95, 0.95, 0.95] as const,
  positive: [0.86, 0.15, 0.15] as const,
  /** No curvature at that node (no parameters, a pole). */
  none: [0.6, 0.64, 0.69] as const,
});

/** The colour (linear 0–1 RGB) of a curvature value in the symmetric range ±`range`. */
export function curvatureColor(value: number, range: number): [number, number, number] {
  if (!Number.isFinite(value)) return [...curvatureColors.none];
  const t = Math.max(-1, Math.min(1, value / range));
  const end = t < 0 ? curvatureColors.negative : curvatureColors.positive;
  const a = Math.abs(t);
  const z = curvatureColors.zero;
  return [0, 1, 2].map((i) => (1 - a) * z[i]! + a * end[i]!) as [number, number, number];
}
