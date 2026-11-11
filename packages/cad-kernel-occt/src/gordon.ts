import type { Vec3 } from '@editor-platform/cad-core';

/**
 * CR1d (docs/cad/car-design.md, CR1の分け方): a Gordon surface through a network of curves,
 * worked out on the curves' exact points (the kernel evaluates them) and returned as one cubic
 * B-spline surface for the kernel to build.
 *
 * 1. Each u-curve meets each v-curve: the closest points of the pair, refined by Newton steps
 *    from the closest samples. A pair further apart than the tolerance is a gap.
 * 2. The intersections give each curve's parameters at the others; the curves are put in order
 *    (reversed where they run backwards) and must run in the same order on every curve.
 * 3. Common parameters: the mean share of arc length at each intersection. Each curve is
 *    reparametrised (monotone cubic) so that it meets the others at the common parameters.
 * 4. The Boolean sum of the two skins less the tensor product of the intersections, with
 *    cubic spline interpolation across the curves (linear across two).
 * 5. The sum is interpolated by a cubic B-spline surface on uniform knots, refined until it
 *    stays within the fit tolerance of the sum and of every curve.
 */

type V = Vec3;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A curve the kernel evaluates: its point at a parameter in [t0, t1]. */
export interface NetworkCurve {
  at(t: number): V;
  t0: number;
  t1: number;
  /**
   * The parameters, t0 to t1 in order, where the curve is no longer one polynomial (a B-spline's
   * knots). The fit is checked inside every span, so a feature narrower than the fixed checks is
   * not missed.
   */
  breaks?: number[];
}

export const gordonLimits = Object.freeze({
  /** Curves each way (docs/cad/car-design.md, CR1). */
  curves: [2, 16] as const,
  /** Samples per curve for the closest-point search and the arc length. */
  samples: 200,
  /** Control points each way, at most (the fit refines up to this). */
  maxPoles: 384,
  /** Points checked per curve and per grid line when judging the fit. */
  checks: 97,
});

export type GordonFailure =
  | { code: 'curve-network-gap'; u: number; v: number; gapMm: number }
  | { code: 'curve-network-order'; curve: ['u' | 'v', number] }
  | { code: 'curve-network-end'; curve: ['u' | 'v', number] }
  | { code: 'curve-network-fit'; deviationMm: number };

export interface GordonSurface {
  degree: 3;
  /** Distinct knots and their multiplicities, u then v. */
  uKnots: number[];
  uMults: number[];
  vKnots: number[];
  vMults: number[];
  /** Poles, `poles[i][j]` for the i-th along u and the j-th along v. */
  poles: V[][];
  /** The largest distance found between the surface and the network (mm). */
  deviationMm: number;
  /** The largest gap between a u-curve and a v-curve at their intersection (mm). */
  gapMm: number;
}

/** Samples of a curve: parameters, points and cumulative arc length. */
function sampled(c: NetworkCurve, n: number = gordonLimits.samples) {
  const t: number[] = [];
  const p: V[] = [];
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = c.t0 + ((c.t1 - c.t0) * i) / (n - 1);
    t.push(ti);
    p.push(c.at(ti));
    s.push(i ? s[i - 1]! + dist(p[i]!, p[i - 1]!) : 0);
  }
  return { t, p, s };
}

/** Arc length share at parameter `x` of sampled curve `c` (linear between samples). */
function shareAt(c: ReturnType<typeof sampled>, x: number) {
  const { t, s } = c;
  const total = s[s.length - 1]!;
  if (x <= t[0]!) return 0;
  if (x >= t[t.length - 1]!) return 1;
  const h = (t[t.length - 1]! - t[0]!) / (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor((x - t[0]!) / h));
  const f = (x - t[i]!) / h;
  return (s[i]! + f * (s[i + 1]! - s[i]!)) / total;
}

/** Closest points of two curves: parameters on each and the distance. */
function closest(
  a: NetworkCurve,
  sa: ReturnType<typeof sampled>,
  b: NetworkCurve,
  sb: ReturnType<typeof sampled>,
) {
  let best = { i: 0, j: 0, d: Infinity };
  for (let i = 0; i < sa.p.length; i++)
    for (let j = 0; j < sb.p.length; j++) {
      const d = dist(sa.p[i]!, sb.p[j]!);
      if (d < best.d) best = { i, j, d };
    }
  let [x, y] = [sa.t[best.i]!, sb.t[best.j]!];
  const ha = (a.t1 - a.t0) * 1e-6;
  const hb = (b.t1 - b.t0) * 1e-6;
  const clampA = (v: number) => Math.min(a.t1, Math.max(a.t0, v));
  const clampB = (v: number) => Math.min(b.t1, Math.max(b.t0, v));
  // Newton steps on the squared distance, with numerical derivatives.
  for (let k = 0; k < 40; k++) {
    const p = a.at(x);
    const q = b.at(y);
    const da = scale(
      sub(a.at(clampA(x + ha)), a.at(clampA(x - ha))),
      1 / (clampA(x + ha) - clampA(x - ha)),
    );
    const db = scale(
      sub(b.at(clampB(y + hb)), b.at(clampB(y - hb))),
      1 / (clampB(y + hb) - clampB(y - hb)),
    );
    const r = sub(p, q);
    // Gauss–Newton on r(x, y) = A(x) − B(y): J = [da, −db].
    const [e, f, g] = [dot(da, da), -dot(da, db), dot(db, db)];
    const det = e * g - f * f;
    if (!(det > 0)) break;
    const [ga, gb] = [dot(da, r), -dot(db, r)];
    const dx = -(g * ga - f * gb) / det;
    const dy = -(e * gb - f * ga) / det;
    const nx = clampA(x + dx);
    const ny = clampB(y + dy);
    if (Math.abs(nx - x) < ha * 1e-3 && Math.abs(ny - y) < hb * 1e-3) {
      [x, y] = [nx, ny];
      break;
    }
    [x, y] = [nx, ny];
  }
  return { ta: x, tb: y, d: dist(a.at(x), b.at(y)) };
}

/**
 * Monotone cubic (Fritsch–Carlson) through (xs[k], ys[k]), xs and ys increasing: the
 * reparametrisation of a curve from the common parameter to its own.
 */
/**
 * The inverse of an increasing map of [0, 1] onto its range, by bisection: each of a curve's own
 * spans is then checked where it lies on the common parameter.
 */
export function inverseOn01(map: (x: number) => number): (y: number) => number {
  return (y) => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (map(mid) < y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
}
export function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d = xs.slice(0, -1).map((x, k) => (ys[k + 1]! - ys[k]!) / (xs[k + 1]! - x));
  const m = xs.map((_, k) => (k === 0 ? d[0]! : k === n - 1 ? d[n - 2]! : (d[k - 1]! + d[k]!) / 2));
  for (let k = 0; k < n - 1; k++) {
    const a = m[k]! / d[k]!;
    const b = m[k + 1]! / d[k]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[k] = t * a * d[k]!;
      m[k + 1] = t * b * d[k]!;
    }
  }
  return (x: number) => {
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]!) k++;
    const h = xs[k + 1]! - xs[k]!;
    const t = Math.min(1, Math.max(0, (x - xs[k]!) / h));
    const [h00, h10, h01, h11] = [
      2 * t ** 3 - 3 * t ** 2 + 1,
      t ** 3 - 2 * t ** 2 + t,
      -2 * t ** 3 + 3 * t ** 2,
      t ** 3 - t ** 2,
    ];
    return h00 * ys[k]! + h10 * h * m[k]! + h01 * ys[k + 1]! + h11 * h * m[k + 1]!;
  };
}

/** Clamped cubic B-spline basis on `n` poles with uniform interior knots over [0, 1]. */
export function uniformKnots(n: number, degree = 3) {
  const spans = n - degree;
  const knots: number[] = [];
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i < spans; i++) knots.push(i / spans);
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

/** The non-zero basis values at x: the first index and `degree + 1` values (de Boor). */
export function basis(knots: number[], degree: number, n: number, x: number) {
  let span = degree;
  while (span < n - 1 && x >= knots[span + 1]!) span++;
  const N = [1];
  const left: number[] = [];
  const right: number[] = [];
  for (let j = 1; j <= degree; j++) {
    left[j] = x - knots[span + 1 - j]!;
    right[j] = knots[span + j]! - x;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r]! / (right[r + 1]! + left[j - r]!);
      N[r] = saved + right[r + 1]! * tmp;
      saved = left[j - r]! * tmp;
    }
    N[j] = saved;
  }
  return { first: span - degree, values: N };
}

/** Greville abscissae of a knot vector: where interpolation is well posed. */
const greville = (knots: number[], degree: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let k = 1; k <= degree; k++) s += knots[i + k]!;
    return s / degree;
  });

/** LU decomposition with partial pivoting of a dense square matrix (in place). */
function lu(a: number[][]) {
  const n = a.length;
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i]![k]!) > Math.abs(a[p]![k]!)) p = i;
    [a[k], a[p]] = [a[p]!, a[k]!];
    [piv[k], piv[p]] = [piv[p]!, piv[k]!];
    for (let i = k + 1; i < n; i++) {
      const f = (a[i]![k]! /= a[k]![k]!);
      for (let j = k + 1; j < n; j++) a[i]![j]! -= f * a[k]![j]!;
    }
  }
  return (b: number[]) => {
    const x = piv.map((p) => b[p]!);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) x[i]! -= a[i]![j]! * x[j]!;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j < n; j++) x[i]! -= a[i]![j]! * x[j]!;
      x[i]! /= a[i]![i]!;
    }
    return x;
  };
}

/** Interpolation weights: for nodes xs, w(x)[k] such that Σ w[k] y[k] interpolates the y's. */
function cardinal(xs: number[]): (x: number) => number[] {
  const n = xs.length;
  if (n === 2) return (x) => [(xs[1]! - x) / (xs[1]! - xs[0]!), (x - xs[0]!) / (xs[1]! - xs[0]!)];
  // A cubic (or quadratic for three) B-spline through the nodes, knots by averaging.
  const degree = Math.min(3, n - 1);
  const knots: number[] = [];
  for (let i = 0; i <= degree; i++) knots.push(xs[0]!);
  for (let j = 1; j < n - degree; j++) {
    let s = 0;
    for (let i = j; i < j + degree; i++) s += xs[i]!;
    knots.push(s / degree);
  }
  for (let i = 0; i <= degree; i++) knots.push(xs[n - 1]!);
  const a = xs.map((x) => {
    const row = new Array<number>(n).fill(0);
    const b = basis(knots, degree, n, x);
    b.values.forEach((v, k) => (row[b.first + k] = v));
    return row;
  });
  const solve = lu(a);
  // Column k of the inverse: the poles that interpolate the k-th unit vector.
  const inverse = xs.map((_, k) => solve(xs.map((_, i) => (i === k ? 1 : 0))));
  return (x) => {
    const b = basis(knots, degree, n, Math.min(xs[n - 1]!, Math.max(xs[0]!, x)));
    return xs.map((_, k) => b.values.reduce((s, v, r) => s + v * inverse[k]![b.first + r]!, 0));
  };
}

/** Builds the Gordon surface of the network, or why it cannot. */
export function gordonSurface(
  uCurves: NetworkCurve[],
  vCurves: NetworkCurve[],
  toleranceMm: number,
  fitMm: number,
): GordonSurface | GordonFailure {
  const m = uCurves.length;
  const n = vCurves.length;
  const su = uCurves.map((c) => sampled(c));
  const sv = vCurves.map((c) => sampled(c));
  const tU: number[][] = [];
  const tV: number[][] = [];
  const X: V[][] = [];
  let gapMm = 0;
  for (let i = 0; i < m; i++) {
    tU.push([]);
    X.push([]);
    for (let j = 0; j < n; j++) {
      const c = closest(uCurves[i]!, su[i]!, vCurves[j]!, sv[j]!);
      if (c.d > toleranceMm) return { code: 'curve-network-gap', u: i, v: j, gapMm: c.d };
      gapMm = Math.max(gapMm, c.d);
      tU[i]!.push(c.ta);
      (tV[j] ??= []).push(c.tb);
      X[i]!.push(scale(add(uCurves[i]!.at(c.ta), vCurves[j]!.at(c.tb)), 0.5));
    }
  }
  // Order: along each u-curve the v-curves come in one order, and along each v-curve the
  // u-curves; a curve that runs backwards is read reversed.
  const ordered = (ts: number[], c: NetworkCurve) => {
    const forward = ts.every((t, k) => k === 0 || t > ts[k - 1]!);
    const backward = ts.every((t, k) => k === 0 || t < ts[k - 1]!);
    if (!forward && !backward) return undefined;
    return forward ? ts : ts.map((t) => c.t0 + c.t1 - t);
  };
  const flip = (c: NetworkCurve): NetworkCurve => ({
    ...c,
    at: (t) => c.at(c.t0 + c.t1 - t),
    breaks: c.breaks?.map((t) => c.t0 + c.t1 - t).reverse(),
  });
  const U = uCurves.map((c, i) => {
    const o = ordered(tU[i]!, c);
    return o && { curve: o === tU[i] ? c : flip(c), t: o };
  });
  const Vc = vCurves.map((c, j) => {
    const o = ordered(tV[j]!, c);
    return o && { curve: o === tV[j] ? c : flip(c), t: o };
  });
  const badU = U.findIndex((x) => !x);
  if (badU >= 0) return { code: 'curve-network-order', curve: ['u', badU] };
  const badV = Vc.findIndex((x) => !x);
  if (badV >= 0) return { code: 'curve-network-order', curve: ['v', badV] };
  // Each curve ends on the first and last curves of the other way.
  const endsOn = (c: NetworkCurve, t: number[]) =>
    dist(c.at(c.t0), c.at(t[0]!)) <= toleranceMm &&
    dist(c.at(c.t1), c.at(t[t.length - 1]!)) <= toleranceMm;
  const endU = U.findIndex((x) => !endsOn(x!.curve, x!.t));
  if (endU >= 0) return { code: 'curve-network-end', curve: ['u', endU] };
  const endV = Vc.findIndex((x) => !endsOn(x!.curve, x!.t));
  if (endV >= 0) return { code: 'curve-network-end', curve: ['v', endV] };
  // Common parameters: mean arc-length share; ends are 0 and 1.
  const sU = U.map((x) => sampled(x!.curve));
  const sV = Vc.map((x) => sampled(x!.curve));
  const uBar = Array.from({ length: n }, (_, j) =>
    j === 0 ? 0 : j === n - 1 ? 1 : sU.reduce((s, c, i) => s + shareAt(c, U[i]!.t[j]!), 0) / m,
  );
  const vBar = Array.from({ length: m }, (_, i) =>
    i === 0 ? 0 : i === m - 1 ? 1 : sV.reduce((s, c, j) => s + shareAt(c, Vc[j]!.t[i]!), 0) / n,
  );
  for (let k = 1; k < n; k++)
    if (!(uBar[k]! > uBar[k - 1]!)) return { code: 'curve-network-order', curve: ['v', k] };
  for (let k = 1; k < m; k++)
    if (!(vBar[k]! > vBar[k - 1]!)) return { code: 'curve-network-order', curve: ['u', k] };
  // Each curve on the common parameter, and the common parameters its fit is checked at: the
  // fixed checks and three inside each of its own spans (mapped back through the inverse).
  const k = gordonLimits.checks;
  const uniform = Array.from({ length: k }, (_, a) => a / (k - 1));
  const along = (x: { curve: NetworkCurve; t: number[] } | undefined, bar: number[]) => {
    const c = x!.curve;
    const ts = [c.t0, ...x!.t.slice(1, -1), c.t1];
    const map = monotoneCubic(bar, ts);
    // The inverse of `map` itself: a cubic through the swapped points is not it (Codex, #930).
    const back = inverseOn01(map);
    const b = c.breaks ?? [];
    const inside = b
      .slice(1)
      .flatMap((t1, s) => [0.25, 0.5, 0.75].map((q) => back(b[s]! + (t1 - b[s]!) * q)));
    return { at: (w: number) => c.at(map(w)), checks: [...uniform, ...inside] };
  };
  const cu = U.map((x) => along(x, uBar));
  const dv = Vc.map((x) => along(x, vBar));
  const Cu = cu.map((c) => c.at);
  const Dv = dv.map((c) => c.at);
  const Lv = cardinal(vBar);
  const Mu = cardinal(uBar);
  const sum = (u: number, v: number): V => {
    const lv = Lv(v);
    const mu = Mu(u);
    let p: V = [0, 0, 0];
    for (let i = 0; i < m; i++) p = add(p, scale(Cu[i]!(u), lv[i]!));
    for (let j = 0; j < n; j++) p = add(p, scale(Dv[j]!(v), mu[j]!));
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++) p = sub(p, scale(X[i]![j]!, lv[i]! * mu[j]!));
    return p;
  };
  // Interpolate the sum, refining the pole count until the surface keeps to the network.
  let count = Math.max(8, 2 * Math.max(m, n));
  for (;;) {
    const nu = count;
    const nv = count;
    const ku = uniformKnots(nu);
    const kv = uniformKnots(nv);
    const gu = greville(ku, 3, nu);
    const gv = greville(kv, 3, nv);
    const matrix = (k: number[], g: number[], size: number) =>
      g.map((x) => {
        const row = new Array<number>(size).fill(0);
        const b = basis(k, 3, size, x);
        b.values.forEach((val, r) => (row[b.first + r] = val));
        return row;
      });
    const solveU = lu(matrix(ku, gu, nu));
    const solveV = lu(matrix(kv, gv, nv));
    const grid = gu.map((u) => gv.map((v) => sum(u, v)));
    // Rows then columns: P = A_u⁻¹ G A_v⁻ᵀ, each coordinate apart.
    const poles: V[][] = Array.from({ length: nu }, () => new Array<V>(nv));
    for (let c = 0; c < 3; c++) {
      const rows = grid.map((row) => solveV(row.map((p) => p[c]!)));
      for (let j = 0; j < nv; j++) {
        const col = solveU(rows.map((r) => r[j]!));
        for (let i = 0; i < nu; i++) (poles[i]![j] ??= [0, 0, 0])[c] = col[i]!;
      }
    }
    const surface = (u: number, v: number): V => {
      const bu = basis(ku, 3, nu, u);
      const bv = basis(kv, 3, nv, v);
      let p: V = [0, 0, 0];
      bu.values.forEach((a, r) =>
        bv.values.forEach(
          (b, s) => (p = add(p, scale(poles[bu.first + r]![bv.first + s]!, a * b))),
        ),
      );
      return p;
    };
    let deviation = 0;
    for (let i = 0; i < m; i++)
      for (const x of cu[i]!.checks)
        deviation = Math.max(deviation, dist(surface(x, vBar[i]!), Cu[i]!(x)));
    for (let j = 0; j < n; j++)
      for (const x of dv[j]!.checks)
        deviation = Math.max(deviation, dist(surface(uBar[j]!, x), Dv[j]!(x)));
    for (const x of uniform) {
      for (let b = 0; b < 9; b++) {
        const y = (b + 0.5) / 9;
        deviation = Math.max(
          deviation,
          dist(surface(x, y), sum(x, y)),
          dist(surface(y, x), sum(y, x)),
        );
      }
    }
    // The curves are met within the network's own gaps; the fit adds at most `fitMm`.
    if (deviation <= gapMm + fitMm) {
      const distinct = (knots: number[]) => {
        const values: number[] = [];
        const mults: number[] = [];
        for (const x of knots) {
          if (values.length && values[values.length - 1] === x) mults[mults.length - 1]!++;
          else {
            values.push(x);
            mults.push(1);
          }
        }
        return { values, mults };
      };
      const du = distinct(ku);
      const dv = distinct(kv);
      return {
        degree: 3,
        uKnots: du.values,
        uMults: du.mults,
        vKnots: dv.values,
        vMults: dv.mults,
        poles,
        deviationMm: deviation,
        gapMm,
      };
    }
    if (count >= gordonLimits.maxPoles)
      return { code: 'curve-network-fit', deviationMm: deviation };
    count = Math.min(gordonLimits.maxPoles, count * 2);
  }
}

/** A curve run the other way. */
export function reversedCurve(c: NetworkCurve): NetworkCurve {
  return {
    t0: -c.t1,
    t1: -c.t0,
    at: (t) => c.at(-t),
    ...(c.breaks && { breaks: c.breaks.map((b) => -b).reverse() }),
  };
}

/** A curve moved by `v`. */
export function movedCurve(c: NetworkCurve, v: V): NetworkCurve {
  return { ...c, at: (t) => add(c.at(t), v) };
}

/**
 * Curves that run end to end (in any order and either way, ends within `reachMm`) as one curve:
 * the k-th piece over [k, k + 1]. Undefined when they do not make one open run.
 */
export function joinedCurve(curves: NetworkCurve[], reachMm = 1e-4): NetworkCurve | undefined {
  if (!curves.length) return undefined;
  const ends = (c: NetworkCurve): [V, V] => [c.at(c.t0), c.at(c.t1)];
  const near = (a: V, b: V) => dist(a, b) <= reachMm;
  const left = curves.slice(1);
  const run: NetworkCurve[] = [curves[0]!];
  while (left.length) {
    const head = ends(run[0]!)[0];
    const tail = ends(run[run.length - 1]!)[1];
    const k = left.findIndex((c) => ends(c).some((p) => near(p, head) || near(p, tail)));
    if (k < 0) return undefined;
    const [c] = left.splice(k, 1);
    const [p, q] = ends(c!);
    if (near(p, tail)) run.push(c!);
    else if (near(q, tail)) run.push(reversedCurve(c!));
    else if (near(q, head)) run.unshift(c!);
    else run.unshift(reversedCurve(c!));
  }
  if (run.length > 1 && near(ends(run[0]!)[0], ends(run[run.length - 1]!)[1])) return undefined;
  const local = (c: NetworkCurve, s: number) => c.t0 + (c.t1 - c.t0) * s;
  return {
    t0: 0,
    t1: run.length,
    at: (t) => {
      const k = Math.min(run.length - 1, Math.max(0, Math.floor(t)));
      return run[k]!.at(local(run[k]!, t - k));
    },
    breaks: run
      .flatMap((c, k) => [
        k,
        ...(c.breaks ?? [])
          .map((b) => k + (b - c.t0) / (c.t1 - c.t0))
          .filter((x) => x > k && x < k + 1),
      ])
      .concat(run.length),
  };
}

/** The curve's point at a share (0 to 1) of its length, from its samples. */
export function atShare(c: NetworkCurve): (share: number) => V {
  const { t, s } = sampled(c, 4 * gordonLimits.samples);
  const total = s[s.length - 1]!;
  return (share) => {
    const target = share * total;
    let k = 1;
    while (k < s.length - 1 && s[k]! < target) k++;
    const w = s[k]! > s[k - 1]! ? (target - s[k - 1]!) / (s[k]! - s[k - 1]!) : 0;
    return c.at(t[k - 1]! + w * (t[k]! - t[k - 1]!));
  };
}

/** A Bézier curve through its poles, over [0, 1]. */
export function bezierCurve(poles: V[]): NetworkCurve {
  return {
    t0: 0,
    t1: 1,
    at: (t) => {
      let p = poles.slice();
      while (p.length > 1) p = p.slice(1).map((q, i) => add(scale(p[i]!, 1 - t), scale(q, t)));
      return p[0]!;
    },
  };
}

/** About how far a point is from a curve (the nearest of its samples). */
export function distanceToCurve(c: NetworkCurve, p: V): number {
  const { p: points } = sampled(c);
  return Math.min(...points.map((q) => dist(p, q)));
}

/**
 * A cubic B-spline through `points` at parameters `ts` (0 to 1, in order) on `n` poles with
 * uniform knots: least squares, each point weighted alike. Returns the full knot vector (over
 * [0, 1]) and the poles.
 */
export function fitCurve(ts: number[], points: V[], n: number) {
  const knots = uniformKnots(n);
  // Normal equations AᵀA x = Aᵀb, A banded: dense is fine for n up to a few hundred.
  const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb = Array.from({ length: n }, () => [0, 0, 0]);
  ts.forEach((t, k) => {
    const b = basis(knots, 3, n, t);
    b.values.forEach((vi, i) => {
      const r = b.first + i;
      b.values.forEach((vj, j) => (ata[r]![b.first + j]! += vi * vj));
      for (let c = 0; c < 3; c++) atb[r]![c]! += vi * points[k]![c]!;
    });
  });
  const solve = lu(ata);
  const cols = [0, 1, 2].map((c) => solve(atb.map((row) => row[c]!)));
  const poles = Array.from(
    { length: n },
    (_, i) => [cols[0]![i]!, cols[1]![i]!, cols[2]![i]!] as V,
  );
  const at = (t: number): V => {
    const b = basis(knots, 3, n, t);
    let p: V = [0, 0, 0];
    b.values.forEach((v, i) => (p = add(p, scale(poles[b.first + i]!, v))));
    return p;
  };
  return { knots, poles, at };
}
