import { describe, expect, it } from 'vitest';
import {
  basis,
  gordonSurface,
  inverseOn01,
  monotoneCubic,
  uniformKnots,
  type NetworkCurve,
} from './gordon';

type V = [number, number, number];
const line = (a: V, b: V): NetworkCurve => ({
  t0: 0,
  t1: 1,
  at: (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
});
/** An arc of the cylinder y² + z² = r² about the x axis at `x`, from angle a0 to a1. */
const arc = (x: number, r: number, a0: number, a1: number): NetworkCurve => ({
  t0: a0,
  t1: a1,
  at: (t) => [x, r * Math.cos(t), r * Math.sin(t)],
});
/** The surface's point at (u, v) from its poles and knots. */
function evaluate(
  s: Exclude<ReturnType<typeof gordonSurface>, { code: string }>,
  u: number,
  v: number,
) {
  const expand = (k: number[], m: number[]) =>
    k.flatMap((x, i) => new Array<number>(m[i]!).fill(x));
  const ku = expand(s.uKnots, s.uMults);
  const kv = expand(s.vKnots, s.vMults);
  const bu = basis(ku, 3, s.poles.length, u);
  const bv = basis(kv, 3, s.poles[0]!.length, v);
  const p: V = [0, 0, 0];
  bu.values.forEach((a, r) =>
    bv.values.forEach((b, q) => {
      const P = s.poles[bu.first + r]![bv.first + q]!;
      for (let c = 0; c < 3; c++) p[c] += P[c]! * a * b;
    }),
  );
  return p;
}

// TS-1481, ST-246 (CR1d).
describe('Gordon surface through a curve network (CR1d)', () => {
  it('reproduces a plane from a grid of lines', () => {
    const us = [0, 30, 100].map((y) => line([0, y, 0], [200, y, 0]));
    const vs = [0, 50, 120, 200].map((x) => line([x, 0, 0], [x, 100, 0]));
    const s = gordonSurface(us, vs, 0.01, 0.001);
    if ('code' in s) throw new Error(JSON.stringify(s));
    expect(s.deviationMm).toBeLessThan(1e-6);
    for (const [u, v] of [
      [0.3, 0.7],
      [0.9, 0.1],
    ])
      expect(Math.abs(evaluate(s, u, v)[2])).toBeLessThan(1e-9);
  });

  it('stays on a cylinder through its arcs and rulings, curves reversed or not', () => {
    const r = 500;
    const us = [0, 400, 1000].map((x) => arc(x, r, 0.2, 1.4));
    // Rulings, one listed backwards.
    const vs = [0.2, 0.6, 1.0, 1.4].map((a, k) => {
      const [p, q]: [V, V] = [
        [0, r * Math.cos(a), r * Math.sin(a)],
        [1000, r * Math.cos(a), r * Math.sin(a)],
      ];
      return k === 2 ? line(q, p) : line(p, q);
    });
    const s = gordonSurface(us, vs, 0.01, 0.001);
    if ('code' in s) throw new Error(JSON.stringify(s));
    expect(s.deviationMm).toBeLessThan(0.001);
    for (const [u, v] of [
      [0.13, 0.41],
      [0.77, 0.66],
      [0.5, 0.95],
    ]) {
      const p = evaluate(s, u, v);
      expect(Math.abs(Math.hypot(p[1], p[2]) - r)).toBeLessThan(0.01);
    }
  });

  it('passes through latitude and longitude arcs of a sphere (curved both ways)', () => {
    const R = 1000;
    const at = (lat: number, lon: number): V => [
      R * Math.cos(lat) * Math.cos(lon),
      R * Math.cos(lat) * Math.sin(lon),
      R * Math.sin(lat),
    ];
    const [lat0, lat1, lon0, lon1] = [0.1, 0.7, -0.5, 0.5];
    const us = [0.1, 0.3, 0.45, 0.7].map((lat) => ({
      t0: lon0,
      t1: lon1,
      at: (t: number) => at(lat, t),
    }));
    // Longitudes parametrised by t³ (uneven speed): the reparametrisation evens it out.
    const vs = [-0.5, -0.1, 0.2, 0.5].map((lon) => ({
      t0: Math.cbrt(lat0),
      t1: Math.cbrt(lat1),
      at: (t: number) => at(t ** 3, lon),
    }));
    const s = gordonSurface(us, vs, 0.01, 0.001);
    if ('code' in s) throw new Error(JSON.stringify(s));
    expect(s.deviationMm).toBeLessThan(0.001);
    for (const [u, v] of [
      [0.25, 0.2],
      [0.6, 0.8],
    ]) {
      const p = evaluate(s, u, v);
      expect(Math.abs(Math.hypot(...p) - R)).toBeLessThan(2);
    }
  });

  it('refuses a gap, curves out of order, and a curve past the network', () => {
    const us = [0, 50, 100].map((y) => line([0, y, 0], [200, y, 0]));
    const vs = [0, 100, 200].map((x) => line([x, 0, 0], [x, 100, 0]));
    expect(
      gordonSurface(us, [vs[0]!, line([100, 0, 1], [100, 100, 1]), vs[2]!], 0.01, 0.001),
    ).toMatchObject({
      code: 'curve-network-gap',
      u: 0,
      v: 1,
    });
    expect(gordonSurface(us, [vs[1]!, vs[0]!, vs[2]!], 0.01, 0.001)).toMatchObject({
      code: 'curve-network-order',
    });
    const long = [line([-50, 0, 0], [200, 0, 0]), us[1]!, us[2]!];
    expect(gordonSurface(long, vs, 0.01, 0.001)).toEqual({
      code: 'curve-network-end',
      curve: ['u', 0],
    });
  });

  it('checks every span of a spline, so a narrow bump is not fitted away (CR1d review)', () => {
    // 256 poles along x, one raised 0.1 mm: a bump narrower than the fixed checks' spacing.
    const n = 256;
    const knots = uniformKnots(n, 2);
    const bumped = (y: number): NetworkCurve => ({
      t0: 0,
      t1: 1,
      breaks: [...new Set(knots)],
      at: (t) => {
        const b = basis(knots, 2, n, t);
        let x = 0;
        let z = 0;
        b.values.forEach((w, r) => {
          x += (w * (200 * (b.first + r))) / (n - 1);
          z += w * (b.first + r === 7 ? 0.1 : 0);
        });
        return [x, y, z];
      },
    });
    const us = [bumped(0), bumped(100)];
    const vs = [line([0, 0, 0], [0, 100, 0]), line([200, 0, 0], [200, 100, 0])];
    const peak = us[0]!.at(7 / (n - 2));
    const s = gordonSurface(us, vs, 0.01, 0.001);
    // The surface keeps the bump within the tolerance, or the network is refused; never flattened.
    if ('code' in s) expect(s.code).toBe('curve-network-fit');
    else {
      let best = Infinity;
      for (let a = 0; a <= 4000; a++) {
        const p = evaluate(s, a / 4000, 0);
        best = Math.min(best, Math.hypot(p[0] - peak[0], p[1] - peak[1], p[2] - peak[2]));
      }
      expect(best).toBeLessThan(0.011);
    }
  });

  it('maps a curve’s spans back through the exact inverse of its parameter map (#930 review)', () => {
    // Crossings far from even: a cubic through the swapped points is no inverse, and the span
    // checks would land outside the spans they are for.
    const bar = [0, 0.1, 1];
    const ts = [0, 0.464, 1];
    const map = monotoneCubic(bar, ts);
    const back = inverseOn01(map);
    const swapped = monotoneCubic(ts, bar);
    let exact = 0;
    let wrong = 0;
    for (let k = 0; k <= 100; k++) {
      const t = k / 100;
      exact = Math.max(exact, Math.abs(map(back(t)) - t));
      wrong = Math.max(wrong, Math.abs(map(swapped(t)) - t));
    }
    expect(exact).toBeLessThan(1e-12);
    expect(wrong).toBeGreaterThan(1e-3);
  });

  // TS-1833, ST-297 (CR7g-1).
  it('halves the poles each way a lean fit can spare, still within the fit (CR7g-1)', () => {
    // A long wavy run lifted straight across: many poles along x, few across y.
    const wave = (y: number, z0: number): NetworkCurve => ({
      t0: 0,
      t1: 1,
      at: (t) => [800 * t, y, z0 + 20 * Math.sin(12 * Math.PI * t)],
    });
    const us = [wave(0, 0), wave(100, 30)];
    const vs = Array.from({ length: 9 }, (_, j) => {
      const t = j / 8;
      return line(us[0]!.at(t) as V, us[1]!.at(t) as V);
    });
    const square = gordonSurface(us, vs, 0.01, 0.005);
    const lean = gordonSurface(us, vs, 0.01, 0.005, { lean: true });
    if ('code' in square || 'code' in lean) throw new Error('no fit');
    expect(square.poles.length).toBe(square.poles[0]!.length);
    expect(lean.poles.length).toBe(square.poles.length);
    expect(lean.poles[0]!.length).toBeLessThan(square.poles[0]!.length);
    expect(lean.deviationMm).toBeLessThanOrEqual(0.005 + lean.gapMm);
    for (const t of [0.13, 0.5, 0.77]) {
      const p = evaluate(lean, t, 0.5);
      // Midway across, over the point's own x.
      const z = 15 + 20 * Math.sin((12 * Math.PI * p[0]) / 800);
      expect(Math.hypot(p[1] - 50, p[2] - z)).toBeLessThan(0.05);
    }
  });

  it('maps parameters monotonically through the intersections', () => {
    const f = monotoneCubic([0, 0.3, 1], [2, 2.1, 5]);
    expect(f(0)).toBeCloseTo(2, 12);
    expect(f(0.3)).toBeCloseTo(2.1, 12);
    expect(f(1)).toBeCloseTo(5, 12);
    let last = -Infinity;
    for (let x = 0; x <= 1; x += 0.01) {
      expect(f(x)).toBeGreaterThanOrEqual(last);
      last = f(x);
    }
    expect(uniformKnots(5)).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
  });
});
