import { describe, expect, it } from 'vitest';
import {
  amplitudeAt,
  boxTetMesh,
  ElasticError,
  solveThermal,
  solveTransientThermal,
  stefanBoltzmann,
  type TransientInput,
} from './index';

// Steel in mm–N–MPa–t–s: k 50 W/(m·K), ρ 7850 kg/m³, c 460 J/(kg·K).
const steel = { conductivity: 50, density: 7.85e-9, specificHeat: 4.6e8 };
const rc = steel.density * steel.specificHeat; // mJ/(mm³·K)
const solver = { tolerance: 1e-12, maxIterations: 5000 };
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/** erf to about 1e-15 (series below 3, continued fraction above). */
function erf(x: number): number {
  if (x < 0) return -erf(-x);
  if (x < 3) {
    let term = x,
      sum = x;
    for (let k = 1; k < 200; k++) {
      term *= (-x * x) / k;
      const add = term / (2 * k + 1);
      sum += add;
      if (Math.abs(add) < 1e-17) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  let f = 0;
  for (let k = 60; k >= 1; k--) f = k / 2 / (x + f);
  return 1 - Math.exp(-x * x) / Math.sqrt(Math.PI) / (x + f);
}

describe('transient heat conduction (VS11a, TS-2275, ST-634)', () => {
  it('a held face heats a semi-infinite bar as the erf solution, with the heat 2 k ΔT A √(t / π α)', () => {
    const mesh = boxTetMesh({ size: [100, 5, 5], divisions: [50, 1, 1], type: 'tet10' });
    const alpha = steel.conductivity / rc; // mm²/s
    const end = 20;
    const r = solveTransientThermal({
      mesh,
      material: steel,
      conditions: [{ kind: 'temperature', faces: [0], edges: [], temperature: 400 }],
      initialTemperature: 300,
      time: { end, step: 0.02, theta: 1 },
      output: { every: 250 },
      solver,
    });
    expect(r.converged).toBe(true);
    expect(r.times).toEqual([0, 5, 10, 15, 20]);
    const T = r.temperatures.at(-1)!;
    let worst = 0;
    for (let p = 0; p < mesh.nodes.length / 3; p++) {
      const x = mesh.nodes[3 * p]!;
      const exact = 400 - 100 * erf(x / (2 * Math.sqrt(alpha * end)));
      worst = Math.max(worst, Math.abs(T[p]! - exact));
    }
    // Within 1 % of the 100 K step.
    expect(worst).toBeLessThan(1);
    const heat = 2 * steel.conductivity * 100 * 25 * Math.sqrt(end / (Math.PI * alpha));
    expect(Math.abs(r.conditionHeat[0]! / heat - 1)).toBeLessThan(0.03);
    expect(r.balance / r.energyScale).toBeLessThan(1e-8);
    expect(r.constrainedNodes).toEqual([9]);
  });

  it('cools a block of small Biot number as the lumped exponential', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const h = 0.01; // 10 W/(m²·K)
    const material = { ...steel, conductivity: 500 };
    const r = solveTransientThermal({
      mesh,
      material,
      conditions: [{ kind: 'convection', faces: [0, 1, 2, 3, 4, 5], coefficient: h, ambient: 300 }],
      initialTemperature: 400,
      time: { end: 1200, step: 5, theta: 0.5 },
      output: { every: 240 },
      probes: [{ name: 'top', faces: [5] }],
      solver,
    });
    const tau = (rc * 1000) / (h * 600);
    for (let s = 0; s < r.history.time.length; s += 20) {
      const exact = 300 + 100 * Math.exp(-r.history.time[s]! / tau);
      expect(Math.abs(r.history.maxTemperature[s]! - exact)).toBeLessThan(0.05);
      expect(Math.abs(r.history.probes[0]![s]! - exact)).toBeLessThan(0.05);
    }
    expect(r.probeAreas[0]).toBeCloseTo(100, 9);
    expect(r.conditionAreas[0]).toBeCloseTo(600, 9);
    // All heat left by convection: ρ c V ΔT.
    const lost = rc * 1000 * (r.history.maxTemperature.at(-1)! - 400);
    expect(Math.abs(r.conditionHeat[0]! / lost - 1)).toBeLessThan(1e-3);
    expect(r.balance / r.energyScale).toBeLessThan(1e-8);
  });

  it('cools a lumped block by radiation to 0 K as (T₀⁻³ + 3 ε σ A t / ρ c V)^(−1/3)', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const eps = 0.8;
    const r = solveTransientThermal({
      mesh,
      material: { ...steel, conductivity: 500 },
      conditions: [{ kind: 'radiation', faces: [0, 1, 2, 3, 4, 5], emissivity: eps, ambient: 0 }],
      initialTemperature: 1000,
      time: { end: 600, step: 2, theta: 0.5 },
      output: { every: 300 },
      solver,
      nonlinear: { tolerance: 1e-8, maxIterations: 20 },
    });
    expect(r.converged).toBe(true);
    expect(r.newtonIterations).toBeGreaterThan(1);
    const rate = (3 * eps * stefanBoltzmann * 600) / (rc * 1000);
    for (let s = 0; s < r.history.time.length; s += 30) {
      const exact = (1000 ** -3 + rate * r.history.time[s]!) ** (-1 / 3);
      expect(Math.abs(r.history.maxTemperature[s]! / exact - 1)).toBeLessThan(0.002);
    }
    expect(r.history.maxTemperature.at(-1)!).toBeLessThan(420);
    expect(r.balance / r.energyScale).toBeLessThan(1e-8);
  });

  it('switches a flux off by its amplitude and stores exactly the heat it put in', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const amplitude = { times: [0, 5, 5.5, 10], factors: [1, 1, 0, 0] };
    expect(amplitudeAt(amplitude, -1)).toBe(1);
    expect(amplitudeAt(amplitude, 5.25)).toBeCloseTo(0.5, 12);
    expect(amplitudeAt(amplitude, 99)).toBe(0);
    expect(amplitudeAt(undefined, 3)).toBe(1);
    const r = solveTransientThermal({
      mesh,
      material: steel,
      conditions: [{ kind: 'heat-flux', faces: [0], flux: 2, amplitude }],
      initialTemperature: 300,
      time: { end: 10, step: 0.5, theta: 1 },
      output: { every: 5 },
      solver,
    });
    // Backward Euler takes the flux at each step's end: 10 steps at 1, the step to 5.5 at 0.
    expect(r.conditionHeat[0]).toBeCloseTo(2 * 100 * 0.5 * 10, 6);
    expect(r.history.stored.at(-1)).toBeCloseTo(1000, 6);
    // Nothing leaves: the mean rises by E / (ρ c V), the heated side is warmer.
    const mean = 300 + 1000 / (rc * 1000);
    const T = r.temperatures.at(-1)!;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of T) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeLessThan(mean);
    expect(hi).toBeGreaterThan(mean);
    expect(r.times).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('reaches the steady solution after a long time', () => {
    const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const conditions = [
      { kind: 'heat-flux' as const, faces: [0], flux: 2 },
      { kind: 'convection' as const, faces: [1], coefficient: 0.1, ambient: 300 },
    ];
    const steady = solveThermal({ mesh, material: steel, conditions, solver });
    const r = solveTransientThermal({
      mesh,
      material: steel,
      conditions,
      initialTemperature: 300,
      time: { end: 100_000, step: 250, theta: 1 },
      output: { every: 400 },
      solver,
    });
    const T = r.temperatures.at(-1)!;
    for (let p = 0; p < T.length; p++)
      expect(Math.abs(T[p]! - steady.temperature[p]!)).toBeLessThan(1e-3);
  });

  it('runs on tet4, and with a field of start temperatures', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet4' });
    const n = mesh.nodes.length / 3;
    const start = new Float64Array(n).map((_, p) => 300 + mesh.nodes[3 * p]!);
    const r = solveTransientThermal({
      mesh,
      material: steel,
      conditions: [],
      initialTemperature: start,
      time: { end: 50, step: 1, theta: 1 },
      output: { every: 50 },
      solver,
    });
    // Insulated: the energy stays, the field evens out to the mean 305 K.
    expect(Math.abs(r.history.stored.at(-1)!)).toBeLessThan(1e-6 * rc * 1000 * 300);
    const T = r.temperatures.at(-1)!;
    for (const v of T) expect(Math.abs(v - 305)).toBeLessThan(0.05);
  });

  it('refuses bad inputs before solving', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const base: TransientInput = {
      mesh,
      material: steel,
      conditions: [{ kind: 'convection', faces: [0], coefficient: 0.01, ambient: 300 }],
      initialTemperature: 300,
      time: { end: 10, step: 1, theta: 1 },
      output: { every: 1 },
      solver,
    };
    const run = (patch: Partial<TransientInput>) => () =>
      solveTransientThermal({ ...base, ...patch });
    expect(refusal(run({ material: { ...steel, specificHeat: 0 } }))).toBe('material');
    expect(refusal(run({ material: { ...steel, density: Number.NaN } }))).toBe('material');
    expect(refusal(run({ time: { end: 10, step: 1, theta: 0.4 } }))).toBe('material');
    expect(refusal(run({ time: { end: 10, step: 0, theta: 1 } }))).toBe('material');
    expect(refusal(run({ time: { end: 1e6, step: 1, theta: 1 } }))).toBe('limit');
    expect(refusal(run({ output: { every: 0 } }))).toBe('material');
    expect(refusal(run({ limits: { snapshots: 5 } }))).toBe('limit');
    expect(refusal(run({ initialTemperature: new Float64Array(3) }))).toBe('material');
    expect(refusal(run({ nonlinear: { tolerance: 1e-6, maxIterations: 51 } }))).toBe('limit');
    const cond = (c: TransientInput['conditions'][number]) => run({ conditions: [c] });
    expect(refusal(cond({ kind: 'radiation', faces: [0], emissivity: 0, ambient: 300 }))).toBe(
      'material',
    );
    expect(refusal(cond({ kind: 'radiation', faces: [0], emissivity: 1, ambient: -1 }))).toBe(
      'material',
    );
    expect(
      refusal(
        cond({
          kind: 'heat-flux',
          faces: [0],
          flux: 1,
          amplitude: { times: [0, 0], factors: [1, 1] },
        }),
      ),
    ).toBe('material');
    expect(
      refusal(
        cond({
          kind: 'convection',
          faces: [0],
          coefficient: 1,
          ambient: 300,
          amplitude: { times: [0, 1], factors: [1, -1] },
        }),
      ),
    ).toBe('material');
    expect(refusal(cond({ kind: 'heat-flux', faces: [9], flux: 1 }))).toBe('target-index');
    expect(refusal(run({ probes: [{ name: 'none', faces: [] }] }))).toBe('empty-target');
    // Two holds on a shared edge: refused when they differ at any time, allowed when they agree.
    const two = (b: number, factors: number[]) =>
      run({
        conditions: [
          { kind: 'temperature', faces: [0], edges: [], temperature: 300 },
          {
            kind: 'temperature',
            faces: [2],
            edges: [],
            temperature: b,
            amplitude: { times: [0, 10], factors },
          },
        ],
      });
    expect(refusal(two(300, [1, 2]))).toBe('constraint-conflict');
    expect(two(600, [0.5, 0.5])().converged).toBe(true);
    // A table that differs only after the run's end is not a conflict.
    const later = run({
      conditions: [
        { kind: 'temperature', faces: [0], edges: [], temperature: 300 },
        {
          kind: 'temperature',
          faces: [2],
          edges: [],
          temperature: 300,
          amplitude: { times: [0, 10, 20], factors: [1, 1, 2] },
        },
      ],
    });
    expect(later().converged).toBe(true);
    // Absolute temperatures: nothing below 0 K.
    expect(refusal(run({ initialTemperature: -300 }))).toBe('material');
    expect(
      refusal(run({ initialTemperature: new Float64Array(mesh.nodes.length / 3).fill(-1) })),
    ).toBe('material');
    expect(refusal(cond({ kind: 'convection', faces: [0], coefficient: 1, ambient: -5 }))).toBe(
      'material',
    );
    expect(
      refusal(
        cond({
          kind: 'temperature',
          faces: [0],
          edges: [],
          temperature: 300,
          amplitude: { times: [0, 5], factors: [1, -0.1] },
        }),
      ),
    ).toBe('material');
  });
});
