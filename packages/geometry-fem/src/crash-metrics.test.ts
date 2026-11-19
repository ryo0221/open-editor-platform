import { describe, expect, it } from 'vitest';
import {
  cfcFilter,
  headInjuryCriterion,
  intrusion,
  occupantLoadCriterion,
  resample,
  standardGravity,
} from './crash-metrics';
import {
  ExplicitSolver,
  explicitDefaults,
  quadPlate,
  runExplicit,
  type ExplicitModel,
} from './explicit';

/** TS-2220 (ST-617, VS7a): crash measures from time histories. */
describe('crash measures (VS7a)', () => {
  const dt = 1e-4;
  const sine = (hz: number, n = 4000) =>
    Float64Array.from({ length: n }, (_, k) => Math.sin(2 * Math.PI * hz * k * dt));
  const amplitude = (y: Float64Array) => {
    // The middle half (away from the ends).
    let most = 0;
    for (let k = y.length / 4; k < (3 * y.length) / 4; k++) most = Math.max(most, Math.abs(y[k]!));
    return most;
  };

  it('passes low frequencies and cuts high ones as SAE J211 CFC 60 and 180 do', () => {
    // J211 class 60: flat to 60 Hz (within 0.5 dB), −3 dB near 100 Hz, −30 dB by 1 kHz or so.
    expect(amplitude(cfcFilter(new Float64Array(100).fill(3), dt, 60))).toBeCloseTo(3, 9);
    expect(amplitude(cfcFilter(sine(10), dt, 60))).toBeGreaterThan(0.99);
    const at100 = amplitude(cfcFilter(sine(100), dt, 60));
    expect(at100).toBeGreaterThan(0.6);
    expect(at100).toBeLessThan(0.8);
    expect(amplitude(cfcFilter(sine(1000), dt, 60))).toBeLessThan(0.01);
    // Class 180 keeps 180 Hz within 0.5 dB... about; 300 Hz near −3 dB.
    const at300 = amplitude(cfcFilter(sine(300), dt, 180));
    expect(at300).toBeGreaterThan(0.6);
    expect(at300).toBeLessThan(0.8);
    // A step too coarse for the class (2.0775·CFC past Nyquist) is refused, not filtered to NaN.
    expect(() => cfcFilter(new Float64Array(1000), 0.002, 180)).toThrow(/sample step/);
  });

  it('does not shift a pulse in time (forward and backward)', () => {
    const n = 2000;
    const pulse = Float64Array.from({ length: n }, (_, k) =>
      Math.exp(-((((k - 1000) * dt) / 0.004) ** 2)),
    );
    const y = cfcFilter(pulse, dt, 60);
    let at = 0;
    for (let k = 1; k < n; k++) if (y[k]! > y[at]!) at = k;
    expect(Math.abs(at - 1000)).toBeLessThanOrEqual(1);
  });

  it('resamples to an even step', () => {
    const r = resample([0, 1e-3, 3e-3], [0, 1, 3], 5e-4);
    [0, 5e-4, 1e-3, 1.5e-3, 2e-3, 2.5e-3, 3e-3].forEach((q, k) =>
      expect(r.t[k]).toBeCloseTo(q, 12),
    );
    expect(r.y[3]).toBeCloseTo(1.5, 12);
    expect(r.y.length).toBe(7);
  });

  it('gives the OLC of a uniform vehicle deceleration in closed form', () => {
    // 50 m/s slowing at 20 g: t1 = √(2·0.065/a), t2 = 0.6/(a·t1), OLC = a·t2/(t2 − t1).
    const a = 20 * standardGravity;
    const t = Float64Array.from({ length: 2001 }, (_, k) => k * 1e-4);
    const v = t.map((s) => 50 - a * s);
    const r = occupantLoadCriterion(t, v)!;
    const t1 = Math.sqrt(0.13 / a);
    const t2 = 0.6 / (a * t1);
    expect(r.t1).toBeCloseTo(t1, 5);
    expect(r.t2).toBeCloseTo(t2, 4);
    expect(r.olc / ((a * t2) / (t2 - t1))).toBeCloseTo(1, 3);
    expect(r.olcG).toBeCloseTo(r.olc / standardGravity, 12);
    // Coarse samples of the same history (velocity linear between them) give the same OLC.
    const coarse = occupantLoadCriterion(
      [0, 0.1, 0.2],
      [0, 0.1, 0.2].map((s) => 50 - a * s),
    )!;
    expect(coarse.t1).toBeCloseTo(t1, 6);
    expect(coarse.t2).toBeCloseTo(t2, 6);
    expect(coarse.olc / r.olc).toBeCloseTo(1, 4);
    // A lead that passes 65 mm and falls back within one interval (the vehicle speeds up past
    // its start): the first crossing is kept, as on the same history sampled finely.
    const tq = [0, 0.1, 0.2, 0.3, 0.8];
    const vq = [50, 48.72, 100, 0, 0];
    const back = occupantLoadCriterion(tq, vq)!;
    const fine = resample(tq, vq, 1e-5);
    const dense = occupantLoadCriterion(fine.t, fine.y)!;
    expect(back.t1).toBeCloseTo(0.10097, 5);
    expect(back.t1).toBeCloseTo(dense.t1, 6);
    expect(back.t2).toBeCloseTo(dense.t2, 6);
    expect(back.olcG / dense.olcG).toBeCloseTo(1, 4);
    expect(back.olcG).toBeCloseTo(10.1, 1);
    // A vehicle that never slows lets nothing move.
    expect(occupantLoadCriterion([0, 0.1], [10, 10])).toBeNull();
  });

  it('gives HIC15 of a constant and a half-sine head pulse', () => {
    // 80 g for 30 ms: the best 15 ms window gives 0.015 · 80^2.5.
    const t = Float64Array.from({ length: 601 }, (_, k) => k * 1e-4);
    const flat = t.map((s) => (s >= 0.01 && s <= 0.04 ? 80 : 0));
    const r = headInjuryCriterion(t, flat);
    expect(r.hic / (0.015 * 80 ** 2.5)).toBeCloseTo(1, 2);
    expect(r.t2 - r.t1).toBeLessThanOrEqual(0.015 + 1e-9);
    // A coarse triangle pulse (0, 100, 0 g at 0, 10, 20 ms, linear between): the best window has
    // neither end on a sample. A window centred on the peak, half width w, has the mean
    // 100(1 − w/0.02): 2w·mean^2.5 is largest at w = 0.02/3.5 (HIC 492.8).
    const tri = headInjuryCriterion([0, 0.01, 0.02], [0, 100, 0]);
    let exact = 0;
    for (let q = 1; q < 100_000; q++) {
      const w = (q / 100_000) * 0.0075;
      exact = Math.max(exact, 2 * w * (100 * (1 - w / 0.02)) ** 2.5);
    }
    expect(tri.hic / exact).toBeCloseTo(1, 6);
    expect(tri.hic).toBeCloseTo(492.8, 1);
    expect(tri.t2 - tri.t1).toBeCloseTo(0.04 / 3.5, 6);
    // Samples 10 or 20 ms apart: a full 15 ms window between them still counts.
    expect(
      headInjuryCriterion([0, 0.01, 0.02, 0.03], [80, 80, 80, 80]).hic / (0.015 * 80 ** 2.5),
    ).toBeCloseTo(1, 9);
    expect(
      headInjuryCriterion([0, 0.02, 0.04], [80, 80, 80]).hic / (0.015 * 80 ** 2.5),
    ).toBeCloseTo(1, 9);
    // A 10 ms half-sine of 100 g: the best window is centred and about 0.6 of the pulse; the
    // closed form (mean of A·sin over a centred window, maximised) gives 414.6.
    const half = t.map((s) => (s <= 0.01 ? 100 * Math.sin((Math.PI * s) / 0.01) : 0));
    const h = headInjuryCriterion(t, half);
    expect(h.hic / 414.65).toBeCloseTo(1, 2);
    expect((h.t1 + h.t2) / 2).toBeCloseTo(0.005, 4);
  });

  it('measures intrusion between two nodes along an axis or in all', () => {
    const frames = [new Float64Array([0, 0, 0, 0, 0, 0]), new Float64Array([-30, 4, 0, -5, 0, 0])];
    expect(Array.from(intrusion(frames, 0, 1, [1, 0, 0]))).toEqual([0, -25]);
    expect(intrusion(frames, 0, 1)[1]).toBeCloseTo(Math.hypot(25, 4), 12);
    expect(() => intrusion(frames, 0, 1, [0, 0, 0])).toThrow(/axis/);
  });

  it('splits the internal energy by part', () => {
    // A 20 × 10 strip of 4 × 2 shells, the left half part 0 and the right half part 1 (1 mm
    // thick), clamped at x = 0 and pulled at x = 20.
    const { nodes, shells } = quadPlate(20, 10, 4, 2);
    const n = nodes.length / 3;
    const model: ExplicitModel = {
      nodes,
      shells,
      thickness: new Float64Array(8).fill(1),
      shellMaterial: new Uint16Array(8),
      shellPart: Uint16Array.from({ length: 8 }, (_, e) => (e % 4 < 2 ? 0 : 1)),
      materials: [{ density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3 }],
      fixed: new Uint8Array(n),
      velocity: new Float64Array(3 * n),
    };
    for (let k = 0; k < n; k++) {
      if (nodes[3 * k] === 0) model.fixed![k] = 63;
      if (nodes[3 * k] === 20) {
        model.fixed![k] = 63;
        model.velocity![3 * k] = 1000;
      }
    }
    const r = runExplicit(model, { ...explicitDefaults, endTime: 2e-5, frameEvery: 1e-5 });
    const last = r.energies.at(-1)!;
    expect(last.parts).toHaveLength(2);
    expect(last.parts![0]).toBeGreaterThan(0);
    expect(last.parts![1]).toBeGreaterThan(0);
    expect((last.parts![0]! + last.parts![1]!) / last.internal).toBeCloseTo(1, 9);
    expect(r.energies[0]!.parts).toEqual([0, 0]);
    const bad = { ...model, shellPart: new Uint16Array(3) };
    expect(
      () => new ExplicitSolver(bad, { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 }),
    ).toThrow(/part per shell/);
  });
});
