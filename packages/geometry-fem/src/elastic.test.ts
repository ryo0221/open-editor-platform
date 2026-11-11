import { describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  ElasticError,
  equilibriumCheck,
  femGaussVolume,
  femVolume,
  jacobianRatio,
  solveElastic,
  tet10Edges,
  type ElasticInput,
  type FemMesh,
} from './index';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 100_000 };
const at = (mesh: FemMesh, x: number, y: number, z: number) => {
  const n = mesh.nodes.length / 3;
  for (let p = 0; p < n; p++)
    if (
      Math.abs(mesh.nodes[p * 3]! - x) < 1e-9 &&
      Math.abs(mesh.nodes[p * 3 + 1]! - y) < 1e-9 &&
      Math.abs(mesh.nodes[p * 3 + 2]! - z) < 1e-9
    )
      return p;
  throw new Error(`no node at ${x}, ${y}, ${z}`);
};
const facesNodes = (mesh: FemMesh, axis: number, value: number) => {
  const out: number[] = [];
  for (let p = 0; p < mesh.nodes.length / 3; p++)
    if (Math.abs(mesh.nodes[p * 3 + axis]! - value) < 1e-9) out.push(p);
  return out;
};
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return e as ElasticError;
  }
  throw new Error('not refused');
};

describe('linear static solver (R3d core)', () => {
  it('reproduces uniform tension exactly (patch test, tet4 and tet10)', () => {
    for (const type of ['tet4', 'tet10'] as const) {
      const mesh = boxTetMesh({ size: [100, 20, 10], divisions: [5, 2, 2], type });
      const sigma = 50;
      const r = solveElastic({
        mesh,
        material: steel,
        // Symmetry planes x0, y0, z0 hold one component each; x1 is pulled by σ·A.
        constraints: [
          { faces: [0], edges: [], displacement: [0, null, null] },
          { faces: [2], edges: [], displacement: [null, 0, null] },
          { faces: [4], edges: [], displacement: [null, null, 0] },
        ],
        loads: [{ kind: 'face-force', faces: [1], force: [sigma * 200, 0, 0] }],
        solver,
      });
      expect(r.converged).toBe(true);
      const n = mesh.nodes.length / 3;
      for (let p = 0; p < n; p++) {
        expect(r.stress[p * 6]).toBeCloseTo(sigma, 6);
        expect(Math.abs(r.stress[p * 6 + 1]!)).toBeLessThan(1e-6);
        expect(r.vonMises[p]).toBeCloseTo(sigma, 6);
        expect(r.displacement[p * 3]).toBeCloseTo((sigma * mesh.nodes[p * 3]!) / 210_000, 10);
        expect(r.displacement[p * 3 + 1]).toBeCloseTo(
          (-0.3 * sigma * mesh.nodes[p * 3 + 1]!) / 210_000,
          10,
        );
      }
      expect(r.loadChecks[0]!.force[0]).toBeCloseTo(10_000, 8);
      expect(r.loadChecks[0]!.measure).toBeCloseTo(200, 9);
      r.appliedTotal.forEach((f, i) => expect(f + r.reactionTotal[i]!).toBeCloseTo(0, 6));
    }
  });

  it('FX1: a cantilever matches Timoshenko within 2 % and bending stress within 3 %', () => {
    const tips: number[] = [];
    for (const d of [10, 20, 40]) {
      const mesh = boxTetMesh({
        size: [200, 20, 20],
        divisions: [d, d / 10, d / 10].map((x) => Math.max(2, x)) as [number, number, number],
        type: 'tet10',
      });
      const input: ElasticInput = {
        mesh,
        material: steel,
        constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
        loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
        solver,
      };
      const r = solveElastic(input);
      expect(r.converged).toBe(true);
      const tip = facesNodes(mesh, 0, 200);
      tips.push(-tip.reduce((s, p) => s + r.displacement[p * 3 + 2]!, 0) / tip.length);
      const sum = r.appliedTotal.map((f, i) => f + r.reactionTotal[i]!);
      expect(Math.hypot(...sum)).toBeLessThan(1e-6 * 1000);
      if (d === 40) {
        const top = at(mesh, 100, 10, 20);
        expect(r.stress[top * 6]! / 75).toBeGreaterThan(0.97);
        expect(r.stress[top * 6]! / 75).toBeLessThan(1.03);
      }
    }
    const exact =
      (1000 * 200 ** 3) / (3 * 210_000 * (20 ** 4 / 12)) +
      (1000 * 200) / ((5 / 6) * (210_000 / 2.6) * 400);
    expect(exact).toBeCloseTo(0.96, 3);
    expect(Math.abs(tips[2]! / exact - 1)).toBeLessThan(0.02);
    // Convergence: the change between the last two levels is small and from below.
    expect(Math.abs(tips[2]! - tips[1]!) / tips[2]!).toBeLessThan(0.02);
  }, 120_000);

  it('refuses free rigid motions and empty targets before solving', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const base = { mesh, material: steel, loads: [], solver };
    const roller = refusal(() =>
      solveElastic({
        ...base,
        constraints: [{ faces: [0], edges: [], displacement: [0, null, null] }],
      }),
    );
    expect(roller.problem).toBe('rigid-body-mode');
    expect(roller.modes.sort()).toEqual(['rotation x', 'translation y', 'translation z']);
    // One edge held fully: the body can still turn about it.
    const hinge = refusal(() =>
      solveElastic({ ...base, constraints: [{ faces: [], edges: [0], displacement: [0, 0, 0] }] }),
    );
    expect(hinge.problem).toBe('rigid-body-mode');
    expect(hinge.modes).toEqual(['rotation x']);
    expect(refusal(() => solveElastic({ ...base, constraints: [] })).problem).toBe('no-constraint');
    expect(
      refusal(() =>
        solveElastic({
          ...base,
          constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
          loads: [{ kind: 'pressure', faces: [9], pressure: 1 }],
        }),
      ).problem,
    ).toBe('target-index');
    // An edge index past the mesh's edges is refused, never read as every edge.
    const fix = { faces: [0], edges: [], displacement: [0, 0, 0] as [number, number, number] };
    expect(
      refusal(() =>
        solveElastic({
          ...base,
          constraints: [fix],
          loads: [{ kind: 'edge-force', edges: [13], force: [0, 0, -1] }],
        }),
      ).problem,
    ).toBe('target-index');
    expect(
      refusal(() => solveElastic({ ...base, constraints: [{ ...fix, faces: [], edges: [12] }] }))
        .problem,
    ).toBe('target-index');
    // x0 fixed and y0 pulled along x share an edge: whichever order, the conflict is refused.
    const pull = { faces: [2], edges: [], displacement: [0.1, null, null] as [number, null, null] };
    for (const constraints of [
      [fix, pull],
      [pull, fix],
    ])
      expect(refusal(() => solveElastic({ ...base, constraints })).problem).toBe(
        'constraint-conflict',
      );
    expect(
      refusal(() =>
        solveElastic({
          ...base,
          material: { ...steel, poissonsRatio: 0.5 },
          constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
        }),
      ).problem,
    ).toBe('material');
  });

  it('puts the given totals on the mesh for pressure, edge forces and gravity', () => {
    const mesh = boxTetMesh({ size: [40, 20, 10], divisions: [4, 2, 2], type: 'tet10' });
    const r = solveElastic({
      mesh,
      material: steel,
      constraints: [{ faces: [4], edges: [], displacement: [0, 0, 0] }],
      loads: [
        { kind: 'pressure', faces: [5], pressure: 2 },
        { kind: 'edge-force', edges: [3], force: [0, 50, 0] },
        { kind: 'gravity', acceleration: [0, 0, -9806.65] },
      ],
      solver,
    });
    // 2 MPa on the 40×20 top pushes down 1,600 N; the edge carries 50 N over its 40 mm.
    expect(r.loadChecks[0]!.force[2]).toBeCloseTo(-1600, 8);
    expect(r.loadChecks[0]!.measure).toBeCloseTo(800, 9);
    expect(r.loadChecks[1]!.force[1]).toBeCloseTo(50, 9);
    expect(r.loadChecks[1]!.measure).toBeCloseTo(40, 9);
    expect(r.loadChecks[2]!.force[2]).toBeCloseTo(-9806.65 * 7.85e-9 * 8000, 11);
    const sum = r.appliedTotal.map((f, i) => f + r.reactionTotal[i]!);
    expect(Math.hypot(...sum)).toBeLessThan(1e-6);
    expect(r.constrainedNodes[0]).toBe(facesNodes(mesh, 2, 0).length);
  });
});

/** One unit tet10 (corners at the origin and the unit points), its faces tagged by local face. */
const unitTet10 = (moved: Record<number, [number, number, number]> = {}): FemMesh => {
  const c = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const nodes = [
    ...c,
    ...tet10Edges.map(([a, b]) => [0, 1, 2].map((d) => (c[a]![d]! + c[b]![d]!) / 2)),
  ];
  for (const [k, p] of Object.entries(moved)) nodes[Number(k)] = p;
  return {
    type: 'tet10',
    nodes: new Float64Array(nodes.flat()),
    elements: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    shapeFaces: 4,
    shapeEdges: 0,
    boundary: {
      elements: new Uint32Array([0, 0, 0, 0]),
      localFaces: new Uint8Array([0, 1, 2, 3]),
      tags: new Uint32Array([0, 1, 2, 3]),
    },
    edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array() },
  };
};

describe('curved tet10 (R3d-2a)', () => {
  it('bounds det J over the whole element, not only at sample points', () => {
    expect(jacobianRatio(unitTet10(), 0)).toBeCloseTo(1, 12);
    // Positive at the nodes and Gauss points, negative at (0.01, 0.62, 0.36).
    const folded = unitTet10({ 6: [0.15, 0.8, -0.05], 9: [0.05, 0.6, 0.25] });
    expect(jacobianRatio(folded, 0)).toBeLessThanOrEqual(0);
    const solve = () =>
      solveElastic({
        mesh: folded,
        material: steel,
        constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
        loads: [],
        solver,
      });
    expect(refusal(solve).problem).toBe('mesh-quality');
    // A mild bulge stays valid.
    expect(jacobianRatio(unitTet10({ 4: [0.5, 0, 0.1] }), 0)).toBeGreaterThan(0);
  });

  it('integrates pressure, face force and body force over the curved geometry', () => {
    const mesh = unitTet10({ 4: [0.5, 0, 0.1] });
    const fixed = [{ faces: [0], edges: [], displacement: [0, 0, 0] as [number, number, number] }];
    const run = (loads: ElasticInput['loads']) =>
      solveElastic({ mesh, material: steel, constraints: fixed, loads, solver }).loadChecks;
    // Unit pressure on face 3 (z = 0 with edge 01 lifted to z = 0.1): ∫ −p n dA.
    const [p3] = run([{ kind: 'pressure', faces: [3], pressure: 1 }]);
    expect(p3!.force[0]).toBeCloseTo(0, 12);
    expect(p3!.force[1]).toBeCloseTo(1 / 15, 12);
    expect(p3!.force[2]).toBeCloseTo(0.5, 12);
    // Pressure on the whole closed surface has no resultant.
    const [all] = run([{ kind: 'pressure', faces: [0, 1, 2, 3], pressure: 1 }]);
    for (const x of all!.force) expect(Math.abs(x)).toBeLessThan(1e-12);
    // A face force keeps its total; its measure is the curved area.
    const [ff] = run([{ kind: 'face-force', faces: [3], force: [0, 0, 7] }]);
    expect(ff!.force[2]).toBeCloseTo(7, 12);
    expect(ff!.measure).toBeGreaterThan(0.5);
    // Gravity: ρ g times the curved volume, which is not the corners' volume.
    const [g] = run([{ kind: 'gravity', acceleration: [0, 0, -9810] }]);
    expect(femGaussVolume(mesh)).not.toBeCloseTo(femVolume(mesh), 6);
    expect(g!.measure).toBeCloseTo(femGaussVolume(mesh), 12);
    expect(g!.force[2]).toBeCloseTo(-9810 * steel.density * femGaussVolume(mesh), 15);
  });
});

describe('equilibrium check (R3d-2b)', () => {
  it('passes a solved study and fails a tampered one', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const r = solveElastic({
      mesh,
      material: steel,
      constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
      loads: [{ kind: 'face-force', faces: [1], force: [1000, 0, 0] }],
      solver,
    });
    const good = equilibriumCheck(r);
    expect(good.pass).toBe(true);
    expect(good.scale).toBeGreaterThanOrEqual(1000);
    expect(equilibriumCheck({ ...r, reactionTotal: [-999, 0, 0] }).pass).toBe(false);
  });
});
