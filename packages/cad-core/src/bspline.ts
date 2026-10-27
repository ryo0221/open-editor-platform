/** CAD-internal uniform non-rational B-spline arithmetic. No sampling, solver or public model policy. */
export function fullSpline(
  degree: number,
  closed: boolean,
  poles: readonly (readonly [number, number])[],
) {
  const n = poles.length,
    p = degree;
  // The full knot vector and the poles it applies to; a periodic spline wraps its first p poles.
  const cps = closed ? [...poles, ...poles.slice(0, p)] : [...poles];
  const knots = closed
    ? Array.from({ length: n + 2 * p + 1 }, (_, i) => i - p)
    : [
        ...Array<number>(p).fill(0),
        ...Array.from({ length: n - p + 1 }, (_, i) => i),
        ...Array<number>(p).fill(n - p),
      ];
  return { cps, knots };
}
/** A point of a B-spline (de Boor) of degree `p` in knot span `span` of the full knot vector. */
export function deBoor(
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
export function derivative(
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
