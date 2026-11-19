import { describe, expect, it } from 'vitest';
import {
  ExplicitError,
  ExplicitSolver,
  explicitDefaults,
  quadPlate,
  runExplicit,
  type ExplicitModel,
} from './explicit';

/** TS-2214 (ST-611, VS5a): the explicit shell solver against beam and wave theory. */
const steel = { density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0 };

function strip(length: number, width: number, nx: number, ny: number, t: number): ExplicitModel {
  const { nodes, shells } = quadPlate(length, width, nx, ny);
  const ne = nx * ny;
  return {
    nodes,
    shells,
    thickness: new Float64Array(ne).fill(t),
    shellMaterial: new Uint16Array(ne),
    materials: [steel],
  };
}

describe('explicit shells (VS5a)', () => {
  it('carries a step of force along a bar at the bar wave speed', () => {
    // 1000 × 10 mm strip, 1 mm thick, ν = 0: c = √(E/ρ) ≈ 5.17e6 mm/s, L/c ≈ 193 µs.
    const nx = 200;
    const model = strip(1000, 10, nx, 2, 1);
    const left = [0, nx + 1, 2 * (nx + 1)];
    const right = [nx, 2 * nx + 1, 3 * nx + 2];
    const F = 300;
    model.forces = [
      { node: left[0]!, force: [-F / 4, 0, 0] },
      { node: left[1]!, force: [-F / 2, 0, 0] },
      { node: left[2]!, force: [-F / 4, 0, 0] },
    ];
    // In plane only: hold z and the rotations.
    model.fixed = new Uint8Array(model.nodes.length / 3).fill(4 | 8 | 16 | 32);
    const c = Math.sqrt(steel.youngsModulus / steel.density);
    const arrival = 1000 / c;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1.5 * arrival,
      frameEvery: arrival / 10,
      historyNodes: [right[1]!],
    });
    // The incident particle speed v = σ/(ρc); the free end moves at 2v once the wave arrives.
    const v = F / (10 * 1) / (steel.density * c);
    const h = r.history[0]!;
    let crossed = NaN;
    for (let k = 0; k < h.time.length; k++)
      if (-h.velocity[3 * k]! > v) {
        crossed = h.time[k]!;
        break;
      }
    expect(Math.abs(crossed / arrival - 1)).toBeLessThan(0.02);
    expect(-h.velocity[3 * (h.time.length - 1)]! / (2 * v)).toBeGreaterThan(0.9);
    expect(r.checks.every((k) => k.pass)).toBe(true);
  });

  it('swings a clamped strip at its first bending period, conserving energy', () => {
    // 200 × 20 × 2 mm cantilever, ν = 0: f1 = 1.8751²/(2π L²) √(E t²/(12ρ)) ≈ 41.8 Hz.
    const L = 200;
    const t = 2;
    const nx = 40;
    const ny = 4;
    const model = strip(L, 20, nx, ny, t);
    const n = model.nodes.length / 3;
    model.fixed = new Uint8Array(n);
    model.velocity = new Float64Array(3 * n);
    for (let j = 0; j <= ny; j++) model.fixed[(nx + 1) * j] = 63;
    // Started near the first mode: v_z ∝ (x/L)².
    for (let k = 0; k < n; k++) model.velocity[3 * k + 2] = 500 * (model.nodes[3 * k]! / L) ** 2;
    const f1 =
      (1.8751 ** 2 / (2 * Math.PI * L * L)) *
      Math.sqrt((steel.youngsModulus * t * t) / (12 * steel.density));
    const tip = nx + (nx + 1) * 2;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2.2 / f1,
      frameEvery: 0.1 / f1,
      historyNodes: [tip],
    });
    const h = r.history[0]!;
    // Downward zero crossings of the tip's z displacement (smoother than its velocity, which
    // carries the higher modes): one per period.
    const downs: number[] = [];
    for (let k = 1; k < h.time.length; k++) {
      const a = h.displacement[3 * (k - 1) + 2]!;
      const b = h.displacement[3 * k + 2]!;
      if (a > 0 && b <= 0)
        downs.push(h.time[k - 1]! + ((h.time[k]! - h.time[k - 1]!) * a) / (a - b));
    }
    expect(downs.length).toBeGreaterThanOrEqual(2);
    const period = downs[1]! - downs[0]!;
    expect(Math.abs(period * f1 - 1)).toBeLessThan(0.03);
    const [balance, hourglass] = r.checks;
    expect(balance!.pass, balance!.detail).toBe(true);
    expect(hourglass!.pass, hourglass!.detail).toBe(true);
    // Energy moves between kinetic and internal; their sum holds within 1 %.
    const e0 = r.energies[0]!.kinetic;
    for (const q of r.energies)
      expect(Math.abs(q.kinetic + q.internal + q.hourglass - e0) / e0).toBeLessThan(0.01);
  });

  it('turns a free plate as a rigid body without straining it', () => {
    // A 100 × 50 mm plate spun about its long edge (x) at 2000 rad/s through a quarter turn:
    // the corotational frame takes the rotation; the strain energy stays a trace of the motion.
    const model = strip(100, 50, 10, 5, 2);
    const n = model.nodes.length / 3;
    const omega = 2000;
    model.velocity = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) model.velocity[3 * k + 2] = omega * model.nodes[3 * k + 1]!;
    model.rotation = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) model.rotation[3 * k] = omega;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: Math.PI / 2 / omega,
      frameEvery: Math.PI / 20 / omega,
    });
    const last = r.energies.at(-1)!;
    expect((last.internal + last.hourglass) / r.energies[0]!.kinetic).toBeLessThan(1e-3);
    // A quarter turn about x (about the centre of mass, which moves on at ω·25 mm/s): the far
    // edge (y = 50) now lies 50 mm above the near one (y = 0), straight up.
    const u = r.frames.at(-1)!.displacement;
    const far = 5 * 11 + 5;
    const near = 5;
    const dy = 50 + u[3 * far + 1]! - u[3 * near + 1]!;
    const dz = u[3 * far + 2]! - u[3 * near + 2]!;
    expect(Math.abs(dy)).toBeLessThan(0.5);
    expect(Math.abs(dz / 50 - 1)).toBeLessThan(0.01);
    expect(r.checks.every((k) => k.pass)).toBe(true);
  });

  it('balances the work of gravity with the kinetic energy of a falling plate', () => {
    const model = strip(50, 50, 5, 5, 1);
    model.gravity = [0, 0, -9810];
    const T = 0.01;
    const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T / 4 });
    const last = r.energies.at(-1)!;
    // ½ m (gT)² = m g (½ g T²).
    expect(last.kinetic / last.external).toBeCloseTo(1, 4);
    const m = steel.density * 50 * 50 * 1;
    expect(last.kinetic / (0.5 * m * (9810 * T) ** 2)).toBeCloseTo(1, 2);
  });

  it('resists an hourglass motion of a free element', () => {
    // Corners moving in and out of the plane alternately (the w hourglass mode): no strain at the
    // one point, so only the hourglass control holds it; it turns back, keeping its energy.
    const model = strip(10, 10, 1, 1, 1);
    // quadPlate numbers the nodes row by row, so the element's corners are 0, 1, 3, 2: up, down,
    // up, down in that order.
    model.velocity = new Float64Array([0, 0, 1000, 0, 0, -1000, 0, 0, -1000, 0, 0, 1000]);
    const r = runExplicit(model, { ...explicitDefaults, endTime: 1.2e-2, frameEvery: 2e-4 });
    const peak = Math.max(...r.energies.map((q) => q.hourglass));
    expect(peak / r.energies[0]!.kinetic).toBeGreaterThan(0.5);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
    // All of its strain energy is spurious: the hourglass check fails.
    expect(r.checks[1]!.pass).toBe(false);
  });

  it('holds the hourglass motion alike in a ten times larger element', () => {
    // Lengths and times ×10 at the same speeds: the motion over the length is the same.
    const run = (s: number) => {
      const model = strip(10 * s, 10 * s, 1, 1, s);
      model.velocity = new Float64Array([0, 0, 1000, 0, 0, -1000, 0, 0, -1000, 0, 0, 1000]);
      const r = runExplicit(model, {
        ...explicitDefaults,
        endTime: 3e-3 * s,
        frameEvery: 1e-3 * s,
      });
      return r.frames.at(-1)!.displacement[2]! / (10 * s);
    };
    const small = run(1);
    expect(Math.abs(small)).toBeGreaterThan(1e-4);
    expect(Math.abs(run(10) / small - 1)).toBeLessThan(1e-3);
  });

  it("ends a shortened last step on the falling plate's path", () => {
    const model = strip(50, 50, 5, 5, 1);
    model.gravity = [0, 0, -9810];
    const step = new ExplicitSolver(model, { ...explicitDefaults, endTime: 1, frameEvery: 1 }).step;
    for (const T of [step, 1.1 * step, 7.3 * step]) {
      const r = runExplicit(model, {
        ...explicitDefaults,
        endTime: T,
        frameEvery: T,
        historyNodes: [0],
      });
      const h = r.history[0]!;
      const k = h.time.length - 1;
      expect(h.time[k]).toBeCloseTo(T, 15);
      // Constant acceleration: u = ½ g T², v at T−½dt and the energies at T itself.
      expect(h.displacement[3 * k + 2]! / (-0.5 * 9810 * T * T)).toBeCloseTo(1, 9);
      const last = r.energies.at(-1)!;
      const m = steel.density * 50 * 50 * 1;
      expect(last.time).toBe(T);
      expect(last.kinetic / (0.5 * m * (9810 * T) ** 2)).toBeCloseTo(1, 9);
      expect(last.external / (0.5 * m * (9810 * T) ** 2)).toBeCloseTo(1, 9);
      expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
    }
  });

  it('keeps each history sample once when the last frame is forced', () => {
    const model = strip(10, 10, 1, 1, 1);
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1e-5,
      frameEvery: 4e-6,
      historyNodes: [0],
    });
    const t = r.history[0]!.time;
    for (let k = 1; k < t.length; k++) expect(t[k]!).toBeGreaterThan(t[k - 1]!);
    expect(t.at(-1)).toBe(r.frames.at(-1)!.time);
  });

  it('stops when a shell is crushed through itself within a step', () => {
    // The right edge moves 1e7 mm/s to the left: past the left edge in the first step.
    const model = strip(10, 10, 1, 1, 1);
    model.velocity = new Float64Array([0, 0, 0, -1e7, 0, 0, 0, 0, 0, -1e7, 0, 0]);
    expect(() =>
      runExplicit(model, { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 }),
    ).toThrow(/element-inverted/);
  });

  it('steps by the smallest element and the plate wave speed', () => {
    const model = strip(100, 10, 20, 2, 1);
    const s = new ExplicitSolver(model, { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 });
    // 5 mm square elements: area / longest side = 5 mm; c = 5.17e6 mm/s at ν = 0.
    expect(s.step).toBeCloseTo((0.9 * 5) / Math.sqrt(steel.youngsModulus / steel.density), 12);
  });

  it('refuses a model it cannot run', () => {
    const settings = { ...explicitDefaults, endTime: 1e-4, frameEvery: 1e-5 };
    const bad = (f: (m: ExplicitModel) => void) => {
      const m = strip(10, 10, 1, 1, 1);
      f(m);
      return () => new ExplicitSolver(m, settings);
    };
    expect(bad((m) => (m.thickness[0] = 0))).toThrow(/model-invalid/);
    expect(bad((m) => (m.shells[2] = 99))).toThrow(/model-invalid/);
    expect(bad((m) => (m.shells[1] = m.shells[0]!))).toThrow(/model-invalid/);
    expect(bad((m) => (m.materials = [{ ...steel, poissonRatio: 0.5 }]))).toThrow(/model-invalid/);
    expect(() => new ExplicitSolver(strip(10, 10, 1, 1, 1), { ...settings, endTime: 10 })).toThrow(
      ExplicitError,
    );
  });
});
