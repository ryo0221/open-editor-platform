// Frozen 7c9b6413 pre-C1 arithmetic; test-only exact regression oracle.
import { cadCurvature, type CadCombSample } from './curvature';
const splineSamplesPerSpan = 8;
export function baselineSplineKnots(
  poles: number,
  degree: number,
  closed: boolean,
): { knots: number[]; mults: number[] } {
  if (closed) {
    const knots = Array.from({ length: poles + 1 }, (_, i) => i);
    return { knots, mults: knots.map(() => 1) };
  }
  const knots = Array.from({ length: poles - degree + 1 }, (_, i) => i);
  return {
    knots,
    mults: knots.map((_, i) => (i === 0 || i === knots.length - 1 ? degree + 1 : 1)),
  };
}
export function baselineSplinePoints(
  poles: readonly (readonly [number, number])[],
  degree: number,
  closed: boolean,
  perSpan = splineSamplesPerSpan,
): [number, number][] {
  const n = poles.length;
  const p = degree;
  // The full knot vector and the poles it applies to; a periodic spline wraps its first p poles.
  const cps = closed ? [...poles, ...poles.slice(0, p)] : [...poles];
  const knots = closed
    ? Array.from({ length: n + 2 * p + 1 }, (_, i) => i - p)
    : [
        ...Array<number>(p).fill(0),
        ...Array.from({ length: n - p + 1 }, (_, i) => i),
        ...Array<number>(p).fill(n - p),
      ];
  const spans = closed ? n : n - p;
  const out: [number, number][] = [];
  for (let k = 0; k <= spans * perSpan; k++) {
    const t = k / perSpan;
    // The span: knots[sp] <= t < knots[sp + 1] (the last span includes its end).
    const sp = p + Math.min(Math.floor(t), spans - 1);
    const d = Array.from({ length: p + 1 }, (_, j) => [...cps[sp - p + j]!] as [number, number]);
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const i = sp - p + j;
        const den = knots[i + p - r + 1]! - knots[i]!;
        const a = den ? (t - knots[i]!) / den : 0;
        d[j] = [(1 - a) * d[j - 1]![0] + a * d[j]![0], (1 - a) * d[j - 1]![1] + a * d[j]![1]];
      }
    out.push(d[p]!);
  }
  if (!closed) {
    out[0] = [...poles[0]!] as [number, number];
    out[out.length - 1] = [...poles[n - 1]!] as [number, number];
  } else out[out.length - 1] = out[0]!;
  return out;
}
/** A point of a B-spline (de Boor) of degree `p` in knot span `span` of the full knot vector. */
function deBoor(
  cps: readonly (readonly [number, number])[],
  knots: readonly number[],
  p: number,
  span: number,
  t: number,
): [number, number] {
  const d = Array.from({ length: p + 1 }, (_, j) => [...cps[span - p + j]!] as [number, number]);
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = span - p + j;
      const den = knots[i + p - r + 1]! - knots[i]!;
      const a = den ? (t - knots[i]!) / den : 0;
      d[j] = [(1 - a) * d[j - 1]![0] + a * d[j]![0], (1 - a) * d[j - 1]![1] + a * d[j]![1]];
    }
  return d[p]!;
}
/** The control points of a B-spline's derivative (degree p − 1, knots without the ends). */
function derivative(
  cps: readonly (readonly [number, number])[],
  knots: readonly number[],
  p: number,
): [number, number][] {
  return cps.slice(1).map((q, i) => {
    const den = knots[i + p + 1]! - knots[i + 1]!;
    const k = den ? p / den : 0;
    return [k * (q[0] - cps[i]![0]), k * (q[1] - cps[i]![1])];
  });
}

/**
 * The curvature comb of a sketch spline (the same uniform knots as `splinePoints`), in the
 * sketch plane: `perSpan` samples per knot span, both ends included. Curvature is signed by the
 * turn (positive turning left) with the left normal, from the spline's exact first and second
 * derivatives.
 */
export function baselineSplineComb(
  poles: readonly (readonly [number, number])[],
  degree: number,
  closed: boolean,
  perSpan: number = cadCurvature.combPerSpan,
): CadCombSample[] {
  const n = poles.length;
  const p = degree;
  const cps = closed ? [...poles, ...poles.slice(0, p)] : [...poles];
  const knots = closed
    ? Array.from({ length: n + 2 * p + 1 }, (_, i) => i - p)
    : [
        ...Array<number>(p).fill(0),
        ...Array.from({ length: n - p + 1 }, (_, i) => i),
        ...Array<number>(p).fill(n - p),
      ];
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
