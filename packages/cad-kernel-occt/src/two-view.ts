import { fitCurve } from './gordon';

type V = [number, number, number];
/** A curve in world space over [t0, t1] (an edge's own parameters). */
export interface ViewCurve {
  t0: number;
  t1: number;
  at(t: number): V;
  /**
   * Where the curve is smooth only between (its knots, with t0 and t1): each span is sampled on
   * its own, so a detail inside a short span is never stepped over.
   */
  breaks?: number[];
}
/** Why two views make no curve (CLF2, docs/cad/car-look-process.md). */
export type TwoViewRefusal =
  | 'two-view-plane'
  | 'two-view-not-monotonic'
  | 'two-view-no-overlap'
  | 'two-view-fit';

/** Samples taken along each view to check its plane and its direction along X. */
const checkSamples = 512;
/** Samples inside each span of a view: checked, fitted (every other one) and measured. */
const spanSamples = 32;
/** The parameters along `c`: `count` evenly, and `spanSamples` inside each of its spans. */
function params(c: ViewCurve, count: number): number[] {
  const out = Array.from({ length: count + 1 }, (_, i) => c.t0 + ((c.t1 - c.t0) * i) / count);
  const b = c.breaks ?? [];
  for (let i = 1; i < b.length; i++)
    for (let k = 1; k < spanSamples; k++)
      out.push(b[i - 1]! + ((b[i]! - b[i - 1]!) * k) / spanSamples);
  // In order, each once (a span sample may fall on an even one).
  const eps = 1e-12 * Math.abs(c.t1 - c.t0);
  return out.sort((x, y) => x - y).filter((t, i, all) => i === 0 || t - all[i - 1]! > eps);
}
/** Bisection steps that find a view's parameter for an X (2⁻⁶⁰ of the range). */
const bisections = 60;

/**
 * CLF2: the 3D curve whose side view (onto XZ) is `side` and whose plan view (onto XY) is `plan`,
 * as a cubic B-spline on uniform knots over [0, 1]: at each X where both views reach, Z is the
 * side view's and Y the plan view's. `side` must keep one Y and `plan` one Z (within `planeTol`),
 * and each must run one way along X, so each X has one point in each view. The curve starts and
 * ends exactly on the views' points; the poles grow (8, 16, … 512) until the fit is within
 * `fitTol` of the exact points, measured between its own samples and inside every span of each
 * view, or the views are refused (`two-view-fit`).
 */
export function twoViewCurve(
  side: ViewCurve,
  plan: ViewCurve,
  planeTol: number,
  fitTol: number,
):
  | { poles: V[]; knots: number[]; deviation: number; at: (s: number) => V }
  | { code: TwoViewRefusal } {
  const sample = (c: ViewCurve) => params(c, checkSamples).map((t) => c.at(t));
  const sp = sample(side);
  const pp = sample(plan);
  const spread = (ps: V[], axis: number) =>
    Math.max(...ps.map((p) => p[axis]!)) - Math.min(...ps.map((p) => p[axis]!));
  if (spread(sp, 1) > planeTol || spread(pp, 2) > planeTol) return { code: 'two-view-plane' };
  // One way along X: every step moves the same way (a step within the tolerance is a stall).
  const direction = (ps: V[]) => {
    const sign = Math.sign(ps[ps.length - 1]![0] - ps[0]![0]);
    if (!sign) return 0;
    for (let i = 1; i < ps.length; i++) if ((ps[i]![0] - ps[i - 1]![0]) * sign <= 0) return 0;
    return sign;
  };
  const ds = direction(sp);
  const dp = direction(pp);
  if (!ds || !dp) return { code: 'two-view-not-monotonic' };
  const range = (ps: V[]) => [
    Math.min(ps[0]![0], ps[ps.length - 1]![0]),
    Math.max(ps[0]![0], ps[ps.length - 1]![0]),
  ];
  const [s0, s1] = range(sp);
  const [p0, p1] = range(pp);
  const lo = Math.max(s0!, p0!);
  const hi = Math.min(s1!, p1!);
  if (!(hi - lo > planeTol)) return { code: 'two-view-no-overlap' };
  // The point of view `c` (running `dir` along X) at `x`, by bisection on its parameter.
  const atX = (c: ViewCurve, dir: number, x: number): V => {
    let [a, b] = [c.t0, c.t1];
    for (let i = 0; i < bisections; i++) {
      const m = (a + b) / 2;
      if ((c.at(m)[0] - x) * dir < 0) a = m;
      else b = m;
    }
    return c.at((a + b) / 2);
  };
  // From low X to high X: the side view's direction decides, so the curve follows it.
  const xOf = (s: number) => (ds > 0 ? lo + (hi - lo) * s : hi - (hi - lo) * s);
  const point = (s: number): V => {
    const x = xOf(s);
    return [x, atX(plan, dp, x)[1], atX(side, ds, x)[2]];
  };
  // Each span sample of both views, as the curve's parameter (by its X): where the fit is held
  // besides the even samples (every other one) and where it is measured (all).
  const sOf = (x: number) => (ds > 0 ? (x - lo) / (hi - lo) : (hi - x) / (hi - lo));
  const inSpans = [side, plan]
    .flatMap((c) => (c.breaks ? params(c, 1).map((t) => sOf(c.at(t)[0])) : []))
    .filter((x) => x > 0 && x < 1);
  const ends: [V, V] = [point(0), point(1)];
  const gap = (p: V, q: V) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  for (let n = 8; n <= 512; n *= 2) {
    const m = 8 * n;
    const ts = [
      ...Array.from({ length: m + 1 }, (_, i) => i / m),
      ...inSpans.filter((_, i) => i % 2 === 0),
    ].sort((x, y) => x - y);
    // The ends are the views' own: a loop closed with other curves stays closed.
    const fit = fitCurve(ts, ts.map(point), n, ends);
    let deviation = 0;
    for (const s of [...Array.from({ length: 2 * m }, (_, k) => (k + 0.5) / (2 * m)), ...inSpans])
      deviation = Math.max(deviation, gap(fit.at(s), point(s)));
    if (deviation <= fitTol) return { ...fit, deviation };
  }
  return { code: 'two-view-fit' };
}
