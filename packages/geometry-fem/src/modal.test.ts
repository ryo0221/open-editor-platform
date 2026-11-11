import { describe, expect, it } from 'vitest';
import {
  assembleMass,
  assembleStiffness,
  boxTetMesh,
  ElasticError,
  femVolume,
  incompleteFactor,
  solveModal,
  symmetricEigen,
  type FemMesh,
  type ModalInput,
} from './index';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-4, maxIterations: 2000 };
const fixedEnd = [{ faces: [0], edges: [], displacement: [0, 0, 0] as [number, number, number] }];
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

describe('modal analysis (R3g-1)', () => {
  it('FX4: the cantilever of FX1 bends first at about 418 Hz, and stretches as a rod', () => {
    const mesh = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
    const steps: number[] = [];
    const r = solveModal({
      mesh,
      material: steel,
      constraints: fixedEnd,
      modes: 6,
      solver,
      progress: (step) => void steps.push(step),
    });
    expect(r.converged).toBe(true);
    expect(steps.length).toBe(r.iterations + 1);
    // Euler–Bernoulli: f1 = 1.875² / (2π L²) √(E I / ρ A) = 417.7 Hz; shear lowers it about 1 %.
    const exact =
      (1.875104 ** 2 / (2 * Math.PI * 200 ** 2)) *
      Math.sqrt((210_000 * (20 ** 4 / 12)) / (7.85e-9 * 400));
    expect(exact).toBeCloseTo(417.7, 0);
    const [first, second] = r.modes;
    expect(Math.abs(first!.frequency / exact - 1)).toBeLessThan(0.03);
    // The square section bends the same in y and z.
    expect(Math.abs(second!.frequency / first!.frequency - 1)).toBeLessThan(1e-2);
    // The first bending pair carries 61 % of the mass in y and in z (the cantilever's 0.613).
    const y = first!.effectiveMass[1] + second!.effectiveMass[1];
    const z = first!.effectiveMass[2] + second!.effectiveMass[2];
    expect(y).toBeGreaterThan(0.59);
    expect(y).toBeLessThan(0.63);
    expect(z).toBeGreaterThan(0.59);
    expect(z).toBeLessThan(0.63);
    // The axial mode: f = √(E/ρ) / 4L = 6465 Hz with 8/π² = 81 % of the mass in x.
    const axial = r.modes.find((m) => m.effectiveMass[0] > 0.5)!;
    expect(Math.abs(axial.frequency / (Math.sqrt(210_000 / 7.85e-9) / 800) - 1)).toBeLessThan(0.01);
    expect(axial.effectiveMass[0]).toBeCloseTo(8 / Math.PI ** 2, 1);
    // Mass, orthogonality, residuals.
    expect(r.mass / (7.85e-9 * femVolume(mesh))).toBeCloseTo(1, 12);
    expect(r.orthogonality).toBeLessThan(1e-8);
    for (const m of r.modes) expect(m.residual).toBeLessThanOrEqual(1e-4);
    expect(r.constrainedNodes).toEqual([25]);
  }, 120_000);

  it('refuses a free body, a moved support, a massless material and a body held everywhere before solving', () => {
    const mesh = boxTetMesh({ size: [20, 10, 10], divisions: [2, 1, 1], type: 'tet10' });
    const base: ModalInput = { mesh, material: steel, constraints: fixedEnd, modes: 2, solver };
    expect(refusal(() => solveModal({ ...base, constraints: [] }))).toBe('no-constraint');
    expect(
      refusal(() =>
        solveModal({
          ...base,
          constraints: [{ faces: [0], edges: [], displacement: [0, null, null] }],
        }),
      ),
    ).toBe('rigid-body-mode');
    expect(
      refusal(() =>
        solveModal({
          ...base,
          constraints: [{ faces: [0], edges: [], displacement: [0.1, 0, 0] }],
        }),
      ),
    ).toBe('constraint-conflict');
    expect(refusal(() => solveModal({ ...base, material: { ...steel, density: 0 } }))).toBe(
      'material',
    );
    // Every DOF held: a tet4 cube (all nodes on its faces) fixed on all six faces.
    const one = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet4' });
    expect(
      refusal(() =>
        solveModal({
          ...base,
          mesh: one,
          constraints: [{ faces: [0, 1, 2, 3, 4, 5], edges: [], displacement: [0, 0, 0] }],
        }),
      ),
    ).toBe('constraint-conflict');
  });

  it('finds a mode whose only free direction no starting field has, and each of two identical pieces', () => {
    // One tet4 cube with a single free y DOF: the seeded x field vanishes once masked.
    const cube = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet4' });
    const one = solveModal({
      mesh: cube,
      material: steel,
      constraints: [
        { faces: [0, 2, 4], edges: [], displacement: [0, 0, 0] },
        { faces: [1, 3, 5], edges: [], displacement: [0, null, 0] },
      ],
      modes: 1,
      solver,
    });
    expect(one.converged).toBe(true);
    expect(one.modes).toHaveLength(1);
    expect(one.modes[0]!.frequency).toBeGreaterThan(0);
    // Two identical boxes, each fixed at one end: the fundamental comes twice.
    const box = boxTetMesh({ size: [100, 10, 20], divisions: [4, 1, 1], type: 'tet10' });
    const n = box.nodes.length / 3;
    const nodes = new Float64Array(6 * n);
    nodes.set(box.nodes);
    for (let i = 0; i < n; i++) {
      nodes[3 * (n + i)] = box.nodes[3 * i]!;
      nodes[3 * (n + i) + 1] = box.nodes[3 * i + 1]!;
      nodes[3 * (n + i) + 2] = box.nodes[3 * i + 2]! + 50;
    }
    const twin: FemMesh = {
      ...box,
      nodes,
      elements: Uint32Array.from([...box.elements, ...box.elements.map((x) => x + n)]),
      boundary: {
        elements: Uint32Array.from([
          ...box.boundary.elements,
          ...box.boundary.elements.map((e) => e + box.elements.length / 10),
        ]),
        localFaces: Uint8Array.from([...box.boundary.localFaces, ...box.boundary.localFaces]),
        tags: Uint32Array.from([...box.boundary.tags, ...box.boundary.tags]),
      },
      edges: { offsets: new Uint32Array(box.shapeEdges + 1), nodes: new Uint32Array() },
    };
    const two = solveModal({
      mesh: twin,
      material: steel,
      constraints: fixedEnd,
      modes: 2,
      solver,
    });
    expect(two.converged).toBe(true);
    expect(Math.abs(two.modes[1]!.frequency / two.modes[0]!.frequency - 1)).toBeLessThan(1e-4);
  }, 120_000);

  it('has a mass matrix that sums to ρ V and a small eigen solver and factor that are exact', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const M = assembleMass(mesh, 2);
    const n = mesh.nodes.length / 3;
    const ones = new Float64Array(3 * n).map((_, d) => (d % 3 === 0 ? 1 : 0));
    expect(M.multiply(ones).reduce((s, v) => s + v, 0)).toBeCloseTo(2 * 1000, 9);
    const e = symmetricEigen([
      [2, 1, 0],
      [1, 2, 1],
      [0, 1, 2],
    ]);
    expect(e.values.map((v) => v.toFixed(9))).toEqual(
      [2 - Math.SQRT2, 2, 2 + Math.SQRT2].map((v) => v.toFixed(9)),
    );
    // ILU(0) on a pattern with no fill (one element couples every node) is the exact factor.
    const one: FemMesh = {
      type: 'tet4',
      nodes: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      elements: Uint32Array.from([0, 1, 2, 3]),
      shapeFaces: 0,
      shapeEdges: 0,
      boundary: {
        elements: new Uint32Array(),
        localFaces: new Uint8Array(),
        tags: new Uint32Array(),
      },
      edges: { offsets: new Uint32Array(1), nodes: new Uint32Array() },
    };
    const K = assembleStiffness(one, steel);
    const free = new Uint8Array(12).fill(1).fill(0, 0, 9);
    const x = new Float64Array(12).map((_, d) => (free[d] ? Math.sin(d + 1) : 0));
    const factor = incompleteFactor(K, free);
    expect(factor.shift).toBe(0);
    const back = factor.apply(K.multiply(x));
    for (let d = 0; d < 12; d++) expect(back[d]).toBeCloseTo(x[d]!, 9);
  });
});
