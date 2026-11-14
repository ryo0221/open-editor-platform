import { describe, expect, it } from 'vitest';
import { twoViewCurve, type ViewCurve } from './two-view';

type V = [number, number, number];
const view = (t0: number, t1: number, at: (t: number) => V): ViewCurve => ({ t0, t1, at });

// CLF2 (docs/cad/car-look-process.md). ST-500, TS-2000: the pure fit, without the kernel.
describe('twoViewCurve (CLF2)', () => {
  it('meets both views: Z from the side, Y from the plan, over the X both reach', () => {
    // Side: z = 100 + 30 sin(x/100) over x 0–400, on y = 7. Plan: y = 50 cos(x/150) over
    // x 380 → −20 (drawn back to front, on z = 3). The curve spans x 0–380 the side's way.
    const side = view(0, 400, (t) => [t, 7, 100 + 30 * Math.sin(t / 100)]);
    const plan = view(0, 1, (t) => {
      const x = 380 - 400 * t;
      return [x, 50 * Math.cos(x / 150), 3];
    });
    const made = twoViewCurve(side, plan, 1e-6, 0.001);
    if ('code' in made) throw new Error(made.code);
    expect(made.deviation).toBeLessThanOrEqual(0.001);
    for (let i = 0; i <= 50; i++) {
      const p = made.at(i / 50);
      expect(p[0]).toBeGreaterThan(-1e-3);
      expect(p[0]).toBeLessThan(380 + 1e-3);
      expect(Math.abs(p[2] - (100 + 30 * Math.sin(p[0] / 100)))).toBeLessThan(0.002);
      expect(Math.abs(p[1] - 50 * Math.cos(p[0] / 150))).toBeLessThan(0.002);
    }
    expect(made.at(0)[0]).toBeCloseTo(0, 3);
    expect(made.at(1)[0]).toBeCloseTo(380, 3);
  });

  it('refuses views off their planes, views that turn back along X, and views apart', () => {
    const side = view(0, 100, (t) => [t, 0, t / 2]);
    const plan = view(0, 100, (t) => [t, t / 3, 0]);
    expect(twoViewCurve(side, plan, 1e-6, 0.001)).not.toHaveProperty('code');
    const tilted = view(0, 100, (t) => [t, t / 100, t / 2]);
    expect(twoViewCurve(tilted, plan, 1e-6, 0.001)).toEqual({ code: 'two-view-plane' });
    const lifted = view(0, 100, (t) => [t, t / 3, t / 1000]);
    expect(twoViewCurve(side, lifted, 1e-6, 0.001)).toEqual({ code: 'two-view-plane' });
    const folded = view(0, Math.PI * 1.5, (t) => [50 * Math.cos(t), 0, 50 * Math.sin(t)]);
    expect(twoViewCurve(folded, plan, 1e-6, 0.001)).toEqual({ code: 'two-view-not-monotonic' });
    const upright = view(0, 100, () => [10, 0, 5]);
    expect(twoViewCurve(upright, plan, 1e-6, 0.001)).toEqual({ code: 'two-view-not-monotonic' });
    const apart = view(0, 100, (t) => [t + 200, t / 3, 0]);
    expect(twoViewCurve(side, apart, 1e-6, 0.001)).toEqual({ code: 'two-view-no-overlap' });
  });

  // #1111 review: the curve ends exactly on the views' ends, so it closes a loop with sketch
  // lines drawn to them; a detail inside a short span of a view is fitted or refused, never lost.
  it('ends exactly on the views and never steps over a detail in a short span', () => {
    const arc = view(-0.4, 0.4, (t) => [100 * Math.sin(t), 0, 100 * Math.cos(t)]);
    const flat = view(-50, 50, (t) => [t, 20, 0]);
    const made = twoViewCurve(arc, flat, 1e-6, 0.001);
    if ('code' in made) throw new Error(made.code);
    const [a, b] = [made.at(0), made.at(1)];
    const x = 100 * Math.sin(0.4);
    expect(Math.hypot(a[0] + x, a[1] - 20, a[2] - 100 * Math.cos(0.4))).toBeLessThan(1e-9);
    expect(Math.hypot(b[0] - x, b[1] - 20, b[2] - 100 * Math.cos(0.4))).toBeLessThan(1e-9);
    // A 6.67 mm bump 4 mm wide at x 500 of a 1 m line, inside its own short spans.
    const bump = (x: number) => 6.67 * Math.exp(-(((x - 500) / 1) ** 2));
    const breaks = [0, ...Array.from({ length: 21 }, (_, i) => 490 + i), 1000];
    const side = { ...view(0, 1000, (t): V => [t, 0, bump(t)]), breaks };
    const line = view(0, 1000, (t) => [t, 0, 0]);
    const out = twoViewCurve(side, line, 1e-6, 0.001);
    if ('code' in out) expect(out.code).toBe('two-view-fit');
    else expect(out.at(0.5)[2]).toBeCloseTo(6.67, 2);
    // Without its breaks the even samples step over it: the guard is the spans.
    const blind = twoViewCurve(
      view(0, 1000, (t): V => [t, 0, bump(t)]),
      line,
      1e-6,
      0.001,
    );
    expect('code' in blind ? blind.code : blind.at(0.5)[2]).not.toBeCloseTo(6.67, 2);
  });
});
