/**
 * VS7a: crash test measures from time histories, all public formulas (no test-house ratings):
 * the SAE J211 channel-frequency-class filter, the occupant load criterion (OLC), the head
 * injury criterion (HIC) and the relative displacement of chosen points (intrusion).
 *
 * Units: times in s; accelerations and velocities in whatever unit the caller passes (the
 * filter keeps it), except where a function names its unit (OLC: m/s; HIC: g).
 */

/** Standard gravity (m/s²), for accelerations in g. */
export const standardGravity = 9.80665;

/**
 * SAE J211-1 (Appendix C): a 2-pole Butterworth low-pass run forward and then backward (no
 * phase shift, 4 poles in all), for the class `cfc` (60, 180, 600, 1000) at the sample step
 * `dt` (s). The ends start from the first and last samples (no step at the ends).
 */
export function cfcFilter(signal: ArrayLike<number>, dt: number, cfc: number): Float64Array {
  if (!(dt > 0) || !(cfc > 0)) throw new RangeError('cfcFilter needs a positive step and class');
  // The design frequency 2.0775·CFC must be below the Nyquist frequency 1/(2·dt): past it the
  // tangent's argument passes π/2 and the recursion turns unstable (or aliases).
  if (!(2.0775 * cfc * dt < 0.5))
    throw new RangeError(
      `cfcFilter: class ${cfc} needs a sample step under ${(0.5 / (2.0775 * cfc)).toExponential(3)} s`,
    );
  const n = signal.length;
  const wd = 2 * Math.PI * cfc * 2.0775;
  const wa = Math.sin((wd * dt) / 2) / Math.cos((wd * dt) / 2);
  const den = 1 + Math.SQRT2 * wa + wa * wa;
  const a0 = (wa * wa) / den;
  const a1 = 2 * a0;
  const a2 = a0;
  const b1 = (-2 * (wa * wa - 1)) / den;
  const b2 = (-1 + Math.SQRT2 * wa - wa * wa) / den;
  const pass = (x: Float64Array): Float64Array => {
    const y = new Float64Array(n);
    if (!n) return y;
    let x1 = x[0]!,
      x2 = x[0]!,
      y1 = x[0]!,
      y2 = x[0]!;
    for (let k = 0; k < n; k++) {
      const xk = x[k]!;
      const yk = a0 * xk + a1 * x1 + a2 * x2 + b1 * y1 + b2 * y2;
      y[k] = yk;
      x2 = x1;
      x1 = xk;
      y2 = y1;
      y1 = yk;
    }
    return y;
  };
  const forward = pass(Float64Array.from(signal));
  forward.reverse();
  const back = pass(forward);
  return back.reverse();
}

/** Samples at an even step from (t, y) pairs (linear in between), for the filter. */
export function resample(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  dt: number,
): { t: Float64Array; y: Float64Array } {
  const n = t.length;
  if (n < 2 || y.length !== n) throw new RangeError('resample needs two samples or more');
  if (!(dt > 0)) throw new RangeError('resample needs a positive step');
  const count = Math.floor((t[n - 1]! - t[0]!) / dt + 1e-9) + 1;
  const ot = new Float64Array(count);
  const oy = new Float64Array(count);
  let k = 0;
  for (let q = 0; q < count; q++) {
    const at = t[0]! + q * dt;
    while (k < n - 2 && t[k + 1]! < at) k++;
    const span = t[k + 1]! - t[k]!;
    const s = span > 0 ? Math.min(1, Math.max(0, (at - t[k]!) / span)) : 0;
    ot[q] = at;
    oy[q] = y[k]! + s * (y[k + 1]! - y[k]!);
  }
  return { t: ot, y: oy };
}

export interface OlcResult {
  /** The occupant's uniform deceleration (m/s²) and in g. */
  olc: number;
  olcG: number;
  /** The end of the free flight (65 mm) and of the restrained phase (235 mm more) (s). */
  t1: number;
  t2: number;
}

/**
 * The occupant load criterion from the vehicle's forward velocity `v` (m/s) at times `t` (s):
 * a virtual occupant flies free at the initial velocity until it has moved 65 mm relative to
 * the vehicle (t1), then slows uniformly (the OLC) so that it reaches the vehicle's velocity
 * just when it has moved 300 mm relative to it (t2). Null when the vehicle never lets the
 * occupant move that far.
 */
export function occupantLoadCriterion(
  t: ArrayLike<number>,
  v: ArrayLike<number>,
): OlcResult | null {
  const n = t.length;
  if (n < 2 || v.length !== n) throw new RangeError('OLC needs two samples or more');
  const line = new PiecewiseLinear(t, v);
  const t0 = t[0]!;
  const v0 = v[0]!;
  // The free occupant's lead over the vehicle, and after t1 the restrained occupant's lead
  // with the deceleration that matches the velocities at t2 (both exact for a velocity linear
  // between the samples).
  const lead = (at: number) => v0 * (at - t0) - line.integral(at);
  const t1 = line.firstReach(lead, 0.065, t0);
  if (t1 === null) return null;
  // With the deceleration (v0 − v(at))/(at − t1) its lead is v0(at − t0) − ½(v0 − v(at))(at − t1)
  // − ∫v: quadratic within each sample interval too.
  const restrained = (at: number) =>
    v0 * (at - t0) - 0.5 * (v0 - line.at(at)) * (at - t1) - line.integral(at);
  const t2 = line.firstReach(restrained, 0.3, t1);
  if (t2 === null) return null;
  const olc = (v0 - line.at(t2)) / (t2 - t1);
  return { olc, olcG: olc / standardGravity, t1, t2 };
}

/**
 * Samples (t, y) with y linear in between: its value, its integral from the first sample and
 * the first time after `from` that a function quadratic within each interval reaches a level.
 */
class PiecewiseLinear {
  private readonly area: Float64Array;
  constructor(
    private readonly t: ArrayLike<number>,
    private readonly y: ArrayLike<number>,
  ) {
    const n = t.length;
    this.area = new Float64Array(n);
    for (let k = 1; k < n; k++)
      this.area[k] = this.area[k - 1]! + 0.5 * (t[k]! - t[k - 1]!) * (y[k]! + y[k - 1]!);
  }

  /** The sample interval holding `at` (clamped to the ends). */
  private span(at: number): number {
    const { t } = this;
    let lo = 0,
      hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid]! <= at) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  at(at: number): number {
    const k = this.span(at);
    const { t, y } = this;
    const h = t[k + 1]! - t[k]!;
    const s = h > 0 ? (at - t[k]!) / h : 0;
    return y[k]! + s * (y[k + 1]! - y[k]!);
  }

  integral(at: number): number {
    const k = this.span(at);
    const { t, y } = this;
    const d = at - t[k]!;
    const h = t[k + 1]! - t[k]!;
    const slope = h > 0 ? (y[k + 1]! - y[k]!) / h : 0;
    return this.area[k]! + y[k]! * d + 0.5 * slope * d * d;
  }

  /**
   * The first time after `from` that `f` reaches `level`, for an `f` that is a quadratic in
   * time within each sample interval (as a velocity linear between the samples makes its
   * integral): on each interval the quadratic through f at its ends and middle is solved for the
   * level, so a crossing and its return within one interval are not missed.
   */
  firstReach(f: (at: number) => number, level: number, from: number): number | null {
    const { t } = this;
    for (let k = this.span(from); k < t.length - 1; k++) {
      const a = Math.max(from, t[k]!);
      const b = t[k + 1]!;
      if (!(b > a)) continue;
      const fa = f(a) - level;
      const fm = f(0.5 * (a + b)) - level;
      const fb = f(b) - level;
      // f(a + s(b − a)) − level = fa + B s + A s², s in [0, 1].
      const A = 2 * fa - 4 * fm + 2 * fb;
      const B = -3 * fa + 4 * fm - fb;
      const roots: number[] = [];
      if (Math.abs(A) <= 1e-12 * (Math.abs(B) + Math.abs(fa) + Math.abs(fb))) {
        if (B !== 0) roots.push(-fa / B);
      } else {
        const disc = B * B - 4 * A * fa;
        if (disc >= 0) {
          // The stable pair: q = −(B + sign(B)√disc)/2, roots q/A and fa/q.
          const q = -0.5 * (B + (B >= 0 ? 1 : -1) * Math.sqrt(disc));
          roots.push(q / A);
          if (q !== 0) roots.push(fa / q);
        }
      }
      // f starts below the level here (it was below at the last interval's end), so the first
      // root is where it first reaches it (a touch counts).
      if (fa >= 0) return a;
      const hit = Math.min(...roots.filter((r) => r > 0 && r <= 1));
      if (Number.isFinite(hit)) return a + hit * (b - a);
      if (fb >= 0) return b;
    }
    return null;
  }
}

export interface HicResult {
  hic: number;
  /** The window that gives it (s). */
  t1: number;
  t2: number;
}

/**
 * The head injury criterion over windows of at most `window` s (0.015 for HIC15) from the
 * resultant acceleration `a` in g at times `t`: the largest (t2 − t1)·(mean of a over the
 * window)^2.5.
 */
export function headInjuryCriterion(
  t: ArrayLike<number>,
  a: ArrayLike<number>,
  window = 0.015,
): HicResult {
  const n = t.length;
  if (n < 2 || a.length !== n) throw new RangeError('HIC needs two samples or more');
  if (!(window > 0)) throw new RangeError('HIC needs a positive window');
  const line = new PiecewiseLinear(t, a);
  const first = t[0]!;
  const last = t[n - 1]!;
  let best: HicResult = { hic: 0, t1: first, t2: first };
  const take = (t1: number, t2: number) => {
    const span = t2 - t1;
    if (!(span > 0)) return;
    const mean = (line.integral(t2) - line.integral(t1)) / span;
    if (!(mean > 0)) return;
    const hic = span * mean ** 2.5;
    if (hic > best.hic) best = { hic, t1, t2 };
  };
  // Candidate ends: the samples, and a grid of window/200 where the samples are coarser (the
  // acceleration is linear between samples, so its integral is exact anywhere). Every pair of
  // candidates within the window, and every full-length window from a candidate.
  const step = window / 200;
  const ends: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    ends.push(t[k]!);
    const parts = Math.ceil((t[k + 1]! - t[k]!) / step);
    for (let q = 1; q < parts; q++) ends.push(t[k]! + ((t[k + 1]! - t[k]!) * q) / parts);
  }
  ends.push(last);
  const m = ends.length;
  for (let i = 0; i < m - 1; i++) {
    for (let j = i + 1; j < m && ends[j]! - ends[i]! <= window * (1 + 1e-12); j++)
      take(ends[i]!, ends[j]!);
    take(ends[i]!, Math.min(last, ends[i]! + window));
    take(Math.max(first, ends[i + 1]! - window), ends[i + 1]!);
  }
  // Then each end moved in turn by golden sections within a grid step of the best (the best
  // window need not end on a candidate).
  const golden = (lo: number, hi: number, f: (u: number) => number) => {
    const r = (Math.sqrt(5) - 1) / 2;
    let a1 = hi - r * (hi - lo),
      a2 = lo + r * (hi - lo);
    let f1 = f(a1),
      f2 = f(a2);
    for (let it = 0; it < 40; it++)
      if (f1 < f2) {
        lo = a1;
        a1 = a2;
        f1 = f2;
        a2 = lo + r * (hi - lo);
        f2 = f(a2);
      } else {
        hi = a2;
        a2 = a1;
        f2 = f1;
        a1 = hi - r * (hi - lo);
        f1 = f(a1);
      }
    return 0.5 * (lo + hi);
  };
  const value = (t1: number, t2: number) => {
    const span = t2 - t1;
    if (!(span > 0) || span > window * (1 + 1e-12)) return 0;
    const mean = (line.integral(t2) - line.integral(t1)) / span;
    return mean > 0 ? span * mean ** 2.5 : 0;
  };
  const h = Math.min(step, t[1]! - t[0]!) || step;
  for (let round = 0; round < 4 && best.hic > 0; round++) {
    const { t1, t2 } = best;
    const u1 = golden(Math.max(first, t1 - h), Math.min(t2, t1 + h), (u) => value(u, t2));
    take(u1, t2);
    const b1 = best.t1;
    const u2 = golden(Math.max(b1, t2 - h), Math.min(last, t2 + h, b1 + window), (u) =>
      value(b1, u),
    );
    take(b1, u2);
  }
  return best;
}

/**
 * Intrusion: per frame, the displacement of point `p` relative to point `q` along the unit
 * `axis` (or its length without one), from per-node displacements (3 per node).
 */
export function intrusion(
  frames: ArrayLike<number>[],
  p: number,
  q: number,
  axis?: [number, number, number],
): Float64Array {
  const out = new Float64Array(frames.length);
  let l = 1;
  if (axis) {
    l = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(l > 0)) throw new RangeError('intrusion needs a nonzero axis');
  }
  frames.forEach((u, k) => {
    const d = [0, 1, 2].map((a) => u[3 * p + a]! - u[3 * q + a]!);
    out[k] = axis
      ? (d[0]! * axis[0] + d[1]! * axis[1] + d[2]! * axis[2]) / l
      : Math.hypot(d[0]!, d[1]!, d[2]!);
  });
  return out;
}
