/** Unit-free cubic Bézier arithmetic. No domain, tolerance, ID or rendering dependencies. */
export type BezierPoint = readonly [number, number];
export type Bezier3 = readonly [BezierPoint, BezierPoint, BezierPoint, BezierPoint];
export type Bezier3Coordinate = readonly [number, number, number, number];
/** Bounds arithmetic stays finite within this explicit computational input limit. */
export const bezierCoordinateLimit = 1e12;
function parameter(t: number) {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('bezier-parameter');
}
function coordinates(values: readonly number[]) {
  if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > bezierCoordinateLimit))
    throw new RangeError('bezier-coordinate');
}
/** Formula and operation order retained from Animation scene2 (7c9b6413). */
export function sampleBezier3Coordinate(curve: Bezier3Coordinate, t: number) {
  parameter(t);
  coordinates(curve);
  const [a, b, c, d] = curve;
  return {
    value: (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d,
    delta: 3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t * t * (d - c),
  };
}
const axis = (curve: Bezier3, i: number): Bezier3Coordinate => [
  curve[0][i],
  curve[1][i],
  curve[2][i],
  curve[3][i],
];
export function evaluateBezier3(curve: Bezier3, t: number): BezierPoint {
  return [
    sampleBezier3Coordinate(axis(curve, 0), t).value,
    sampleBezier3Coordinate(axis(curve, 1), t).value,
  ];
}
export function derivativeBezier3(curve: Bezier3, t: number): BezierPoint {
  return [
    sampleBezier3Coordinate(axis(curve, 0), t).delta,
    sampleBezier3Coordinate(axis(curve, 1), t).delta,
  ];
}
export function secondDerivativeBezier3(curve: Bezier3, t: number): BezierPoint {
  parameter(t);
  coordinates(curve.flat());
  const component = (i: number) =>
    6 * (1 - t) * (curve[2][i] - 2 * curve[1][i] + curve[0][i]) +
    6 * t * (curve[3][i] - 2 * curve[2][i] + curve[1][i]);
  return [component(0), component(1)];
}
/** de Casteljau split; zero-length curves and endpoint splits are supported. */
export function splitBezier3(curve: Bezier3, t: number): readonly [Bezier3, Bezier3] {
  parameter(t);
  coordinates(curve.flat());
  if (t === 0) return [[curve[0], curve[0], curve[0], curve[0]], curve];
  if (t === 1) return [curve, [curve[3], curve[3], curve[3], curve[3]]];
  const mix = (a: BezierPoint, b: BezierPoint): BezierPoint => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const a = mix(curve[0], curve[1]),
    b = mix(curve[1], curve[2]),
    c = mix(curve[2], curve[3]);
  const d = mix(a, b),
    e = mix(b, c),
    f = mix(d, e);
  return [
    [curve[0], a, d, f],
    [f, e, c, curve[3]],
  ];
}
/** Axis-aligned bounds, including interior extrema. No flattening/sampling tolerance. */
export function boundsBezier3(curve: Bezier3): { min: BezierPoint; max: BezierPoint } {
  coordinates(curve.flat());
  const bounds = (i: number) => {
    const [p0, p1, p2, p3] = axis(curve, i);
    let a = -p0 + 3 * p1 - 3 * p2 + p3;
    let b = 2 * (p0 - 2 * p1 + p2),
      c = p1 - p0;
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
    if (scale > 0) {
      a /= scale;
      b /= scale;
      c /= scale;
    }
    const roots: number[] = [];
    if (a === 0) {
      if (b !== 0) roots.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        // Stable quadratic roots avoid cancellation when one root is close to zero.
        const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
        if (q === 0) roots.push(-b / (2 * a));
        else roots.push(q / a, c / q);
      }
    }
    const values = [
      p0,
      p3,
      ...roots
        .filter((t) => t > 0 && t < 1)
        .map((t) => sampleBezier3Coordinate(axis(curve, i), t).value),
    ];
    return [Math.min(...values), Math.max(...values)];
  };
  const x = bounds(0),
    y = bounds(1);
  return { min: [x[0], y[0]], max: [x[1], y[1]] };
}
