import { describe, expect, it } from 'vitest';
import { boxTetMesh, ElasticError, solveThermal, type ThermalInput } from './index';

const solver = { tolerance: 1e-10, maxIterations: 5000 };
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

describe('steady heat conduction (R3h-1, TS-1386, ST-200)', () => {
  it('FX5: a 100 × 100 × 10 slab held at 300 K and 400 K has a linear profile and k ΔT / t', () => {
    const mesh = boxTetMesh({ size: [100, 100, 10], divisions: [5, 5, 2], type: 'tet10' });
    const r = solveThermal({
      mesh,
      material: { conductivity: 50 },
      conditions: [
        { kind: 'temperature', faces: [4], edges: [], temperature: 300 },
        { kind: 'temperature', faces: [5], edges: [], temperature: 400 },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    const n = mesh.nodes.length / 3;
    let worst = 0;
    for (let p = 0; p < n; p++)
      worst = Math.max(worst, Math.abs(r.temperature[p]! - (300 + 10 * mesh.nodes[p * 3 + 2]!)));
    expect(worst).toBeLessThan(1e-6);
    // q = −k dT/dz = −50 × 100 / 10 = −500 mW/mm² (0.5 MW/m²) everywhere, within 0.5 %.
    for (let p = 0; p < n; p++) {
      expect(Math.abs(r.flux[p * 3 + 2]! / -500 - 1)).toBeLessThan(0.005);
      expect(Math.abs(r.flux[p * 3]!)).toBeLessThan(1e-6);
    }
    // 500 × 10 000 mm² = 5 W in at the hot face, out at the cold one.
    for (const c of r.conditionChecks) expect(c.measure).toBeCloseTo(10_000, 6);
    expect(r.conditionChecks[1]!.heat / 5e6).toBeCloseTo(1, 6);
    expect(r.conditionChecks[0]!.heat / -5e6).toBeCloseTo(1, 6);
    expect(Math.abs(r.balance) / r.heatScale).toBeLessThan(1e-8);
    expect(r.constrainedNodes).toEqual([121, 121]);
  });

  it('carries a flux in at one end of a bar and convects it away at the other', () => {
    const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const r = solveThermal({
      mesh,
      material: { conductivity: 50 },
      conditions: [
        { kind: 'heat-flux', faces: [0], flux: 2 },
        { kind: 'convection', faces: [1], coefficient: 0.1, ambient: 300 },
      ],
      solver,
    });
    // All 2 × 100 = 200 mW leaves by convection: T(100) = 300 + q / h = 320, T(0) = 320 + q L / k.
    const n = mesh.nodes.length / 3;
    for (let p = 0; p < n; p++)
      expect(r.temperature[p]!).toBeCloseTo(324 - 0.04 * mesh.nodes[p * 3]!, 6);
    expect(r.conditionChecks[0]!.heat).toBeCloseTo(200, 9);
    expect(r.conditionChecks[1]!.heat).toBeCloseTo(-200, 6);
    expect(Math.abs(r.balance) / r.heatScale).toBeLessThan(1e-8);
  });

  it('resolves a small rise over a high held temperature, and a curved field at its own nodes', () => {
    // 1e-5 mW/mm² through a bar held at 300 K: the rise is 2e-5 K, still solved.
    const bar = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const small = solveThermal({
      mesh: bar,
      material: { conductivity: 50 },
      conditions: [
        { kind: 'temperature', faces: [0], edges: [], temperature: 300 },
        { kind: 'heat-flux', faces: [1], flux: 1e-5 },
      ],
      solver: { tolerance: 1e-8, maxIterations: 5000 },
    });
    for (let p = 0; p < bar.nodes.length / 3; p++) {
      expect(small.temperature[p]! - 300).toBeCloseTo(2e-7 * bar.nodes[p * 3]!, 11);
      expect(small.flux[p * 3]! / -1e-5).toBeCloseTo(1, 6);
    }
    expect(Math.abs(small.balance) / small.heatScale).toBeLessThan(1e-6);
    // T = x² − y² on a unit cube (k = 1): held 0 on the edge x = y = 0, inward fluxes ±2 on the
    // faces x = 1 and y = 1. Quadratic, so tet10 is exact, and q = −∇T = (−2x, 2y, 0) at every node.
    const cube = boxTetMesh({ size: [1, 1, 1], divisions: [1, 1, 1], type: 'tet10' });
    const curved = solveThermal({
      mesh: cube,
      material: { conductivity: 1 },
      conditions: [
        { kind: 'temperature', faces: [], edges: [8], temperature: 0 },
        { kind: 'heat-flux', faces: [1], flux: 2 },
        { kind: 'heat-flux', faces: [3], flux: -2 },
      ],
      solver,
    });
    for (let p = 0; p < cube.nodes.length / 3; p++) {
      const [x, y] = [cube.nodes[p * 3]!, cube.nodes[p * 3 + 1]!];
      expect(curved.temperature[p]!).toBeCloseTo(x * x - y * y, 9);
      expect(curved.flux[p * 3]!).toBeCloseTo(-2 * x, 9);
      expect(curved.flux[p * 3 + 1]!).toBeCloseTo(2 * y, 9);
    }
  });

  it('refuses a floating temperature, bad values and two temperatures on one node', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const base: ThermalInput = {
      mesh,
      material: { conductivity: 50 },
      conditions: [{ kind: 'temperature', faces: [0], edges: [], temperature: 300 }],
      solver,
    };
    expect(
      refusal(() =>
        solveThermal({ ...base, conditions: [{ kind: 'heat-flux', faces: [0], flux: 1 }] }),
      ),
    ).toBe('no-constraint');
    expect(refusal(() => solveThermal({ ...base, material: { conductivity: 0 } }))).toBe(
      'material',
    );
    expect(
      refusal(() =>
        solveThermal({
          ...base,
          conditions: [{ kind: 'convection', faces: [0], coefficient: 0, ambient: 300 }],
        }),
      ),
    ).toBe('material');
    expect(
      refusal(() =>
        solveThermal({
          ...base,
          conditions: [
            ...base.conditions,
            { kind: 'temperature', faces: [2], edges: [], temperature: 350 },
          ],
        }),
      ),
    ).toBe('constraint-conflict');
    expect(
      refusal(() =>
        solveThermal({
          ...base,
          conditions: [{ kind: 'temperature', faces: [9], edges: [], temperature: 300 }],
        }),
      ),
    ).toBe('target-index');
  });
});
