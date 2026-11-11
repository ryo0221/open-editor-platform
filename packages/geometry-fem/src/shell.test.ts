import { describe, expect, it } from 'vitest';
import {
  assembleShellMass,
  assembleShellStiffness,
  ElasticError,
  shellEquilibriumCheck,
  shellMeshFromSurface,
  shellMeshQuality,
  solveShell,
  solveShellModal,
  type ShellConstraint,
  type ShellMesh,
} from './index';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 5000 };
const zero: [number, number, number] = [0, 0, 0];
const free: [null, null, null] = [null, null, null];
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/**
 * A structured mesh of an (s, t) ∈ [0, 1]² patch mapped by `at`, each cell split into two
 * triangles along alternating diagonals. Edges: 0 t = 0, 1 s = 1, 2 t = 1, 3 s = 0.
 */
function gridMesh(
  nu: number,
  nv: number,
  at: (s: number, t: number) => [number, number, number],
  thickness: number,
): ShellMesh {
  const nodes: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) nodes.push(...at(i / nu, j / nv));
  const id = (i: number, j: number) => j * (nu + 1) + i;
  const tris: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = id(i, j),
        b = id(i + 1, j),
        c = id(i + 1, j + 1),
        d = id(i, j + 1);
      if ((i + j) % 2) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
    }
  const chains = [
    Array.from({ length: nu + 1 }, (_, i) => id(i, 0)),
    Array.from({ length: nv + 1 }, (_, j) => id(nu, j)),
    Array.from({ length: nu + 1 }, (_, i) => id(i, nv)),
    Array.from({ length: nv + 1 }, (_, j) => id(0, j)),
  ];
  const offsets = [0];
  for (const c of chains) offsets.push(offsets.at(-1)! + c.length);
  const m = tris.length / 3;
  return {
    nodes: Float64Array.from(nodes),
    triangles: Uint32Array.from(tris),
    thickness: new Float64Array(m).fill(thickness),
    faces: new Int32Array(m),
    shapeFaces: 1,
    shapeEdges: 4,
    edges: { offsets: Uint32Array.from(offsets), nodes: Uint32Array.from(chains.flat()) },
  };
}

const plate = (n: number) => gridMesh(n, n, (s, t) => [100 * s, 100 * t, 0], 1);
const edges = (
  displacement: ShellConstraint['displacement'],
  rotation: ShellConstraint['rotation'],
) => [{ faces: [], edges: [0, 1, 2, 3], displacement, rotation }];

describe('flat shell triangles (R3i-1, TS-1391, ST-202)', () => {
  it('FX6a: a clamped square plate under pressure deflects 0.00126 q a⁴ / D at the centre', () => {
    const mesh = plate(16);
    const q = 0.01;
    const r = solveShell({
      mesh,
      material: steel,
      loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
      constraints: edges(zero, zero),
      solver,
    });
    const D = (210_000 * 1) / (12 * (1 - 0.09));
    const expected = (0.00126 * q * 100 ** 4) / D;
    const centre = 8 * 17 + 8;
    expect(r.converged).toBe(true);
    expect(Math.abs(r.displacement[6 * centre + 2]! - expected) / expected).toBeLessThan(0.02);
    expect(shellEquilibriumCheck(r).pass).toBe(true);
  });

  it('FX6c: a simply supported square plate vibrates first at (π / a²) √(D / ρt)', () => {
    const mesh = plate(16);
    const r = solveShellModal({
      mesh,
      material: steel,
      constraints: edges(zero, free),
      modes: 3,
      solver: { tolerance: 1e-6, maxIterations: 2000 },
    });
    const D = (210_000 * 1) / (12 * (1 - 0.09));
    const f = (Math.PI / 100 ** 2) * Math.sqrt(D / (steel.density * 1));
    expect(r.converged).toBe(true);
    expect(Math.abs(r.modes[0]!.frequency - f) / f).toBeLessThan(0.02);
  });

  it('FX6b: the Scordelis–Lo roof under its own weight sags 0.3024 at the free edge mid-span', () => {
    const R = 25,
      phi = (40 * Math.PI) / 180;
    // A quarter: s along the arc from the crown, t along the axis from a diaphragm to mid-span.
    const n = 16;
    const mesh = gridMesh(
      n,
      n,
      (s, t) => [R * Math.sin(phi * s), 25 * t, R * Math.cos(phi * s)],
      0.25,
    );
    const area = R * phi * 25;
    const r = solveShell({
      mesh,
      material: { youngsModulus: 4.32e8, poissonsRatio: 0, density: 0 },
      loads: [{ kind: 'face-force', faces: [0], force: [0, 0, -90 * area] }],
      constraints: [
        // The diaphragm holds x and z; mid-span (y = 25) and the crown (x = 0) are symmetry planes.
        { faces: [], edges: [0], displacement: [0, null, 0], rotation: free },
        { faces: [], edges: [2], displacement: [null, 0, null], rotation: [0, null, 0] },
        { faces: [], edges: [3], displacement: [0, null, null], rotation: [null, 0, 0] },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    const sag = -r.displacement[6 * (n * (n + 1) + n) + 2]!;
    expect(Math.abs(sag - 0.3024) / 0.3024).toBeLessThan(0.03);
    // The facets lose a little of the arc's area; the force is spread over what they have.
    expect(Math.abs(r.loadChecks[0]!.measure / area - 1)).toBeLessThan(2e-4);
    expect(r.loadChecks[0]!.force[2]).toBeCloseTo(-90 * area, 6);
    expect(shellEquilibriumCheck(r).pass).toBe(true);
  });

  /** A 2 × 2 patch with a skewed interior node, every boundary node its own shape edge. */
  const patch = (Q: number[][]) => {
    const base = gridMesh(2, 2, (s, t) => [100 * s, 80 * t, 0], 2);
    base.nodes[3 * 4] = 55;
    base.nodes[3 * 4 + 1] = 37;
    const local = Float64Array.from(base.nodes);
    for (let p = 0; p < 9; p++)
      for (let i = 0; i < 3; i++)
        base.nodes[3 * p + i] = Q[i]!.reduce((s, q, k) => s + q * local[3 * p + k]!, 0);
    const boundary = [0, 1, 2, 3, 5, 6, 7, 8];
    base.shapeEdges = boundary.length;
    base.edges = {
      offsets: Uint32Array.from({ length: boundary.length + 1 }, (_, k) => k),
      nodes: Uint32Array.from(boundary),
    };
    return { mesh: base, local, boundary };
  };
  const tilt = (() => {
    const a = 0.7,
      b = -0.4;
    const Rz = [
      [Math.cos(a), -Math.sin(a), 0],
      [Math.sin(a), Math.cos(a), 0],
      [0, 0, 1],
    ];
    const Rx = [
      [1, 0, 0],
      [0, Math.cos(b), -Math.sin(b)],
      [0, Math.sin(b), Math.cos(b)],
    ];
    return Rz.map((row) => [0, 1, 2].map((j) => row.reduce((s, x, k) => s + x * Rx[k]![j]!, 0)));
  })();
  const identity = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (const [name, Q] of [
    ['flat', identity],
    ['tilted', tilt],
  ] as const)
    it(`passes the membrane and bending patch tests on a ${name} skewed patch`, () => {
      const { mesh, local, boundary } = patch(Q);
      // In-plane u, v linear (ω its rotation), w quadratic: constant strain and curvature.
      const c = 1e-3;
      const field = (x: number, y: number) => {
        const u = c * (2 * x + y),
          v = c * (3 * x - y);
        const w = c * 1e-2 * (x * x + 2 * x * y - 0.5 * y * y);
        const wx = c * 1e-2 * (2 * x + 2 * y),
          wy = c * 1e-2 * (2 * x - y);
        // θx = ∂w/∂y, θy = −∂w/∂x, θz = (∂v/∂x − ∂u/∂y)/2.
        const rot = [wy, -wx, (c * (3 - 1)) / 2];
        const rotate = (v3: number[]) =>
          Q.map((row) => row.reduce((s, q, k) => s + q * v3[k]!, 0)) as [number, number, number];
        return { d: rotate([u, v, w]), r: rotate(rot) };
      };
      const constraints = boundary.map((p, k) => {
        const { d, r } = field(local[3 * p]!, local[3 * p + 1]!);
        return { faces: [], edges: [k], displacement: d, rotation: r };
      });
      const r = solveShell({ mesh, material: steel, loads: [], constraints, solver });
      const want = field(55, 37);
      for (let i = 0; i < 3; i++) {
        expect(r.displacement[6 * 4 + i]).toBeCloseTo(want.d[i]!, 10);
        expect(r.displacement[6 * 4 + 3 + i]).toBeCloseTo(want.r[i]!, 10);
      }
      // The stresses are the same at every node, on both surfaces.
      for (const surface of [r.stress.top, r.stress.bottom, r.stress.middle])
        for (let p = 1; p < 9; p++)
          for (let k = 0; k < 6; k++) expect(surface[6 * p + k]).toBeCloseTo(surface[k]!, 6);
      // Membrane: σxx, σyy, τxy of εx 2c, εy −c, γ 4c in the patch plane.
      const E = 210_000 / (1 - 0.09);
      const mid = r.stress.middle;
      const inPlane = (i: number, j: number) => {
        let s = 0;
        const sym = [
          [mid[0]!, mid[3]!, mid[5]!],
          [mid[3]!, mid[1]!, mid[4]!],
          [mid[5]!, mid[4]!, mid[2]!],
        ];
        for (let a = 0; a < 3; a++)
          for (let b = 0; b < 3; b++) s += Q[a]![i]! * sym[a]![b]! * Q[b]![j]!;
        return s;
      };
      expect(inPlane(0, 0)).toBeCloseTo(E * (2 * c - 0.3 * c), 6);
      expect(inPlane(1, 1)).toBeCloseTo(E * (-c + 0.3 * 2 * c), 6);
      expect(inPlane(0, 1)).toBeCloseTo(((E * 0.7) / 2) * 4 * c, 6);
      expect(inPlane(2, 2)).toBeCloseTo(0, 8);
    });

  it('checks the moments of a plate bent by prescribed rotations alone on their own size', () => {
    // The review's case: no load, w = 0.001 x², θy = −∂w/∂x at every node of two triangles.
    const mesh = gridMesh(1, 1, (s, t) => [100 * s, 100 * t, 0], 1);
    mesh.shapeEdges = 4;
    mesh.edges = {
      offsets: Uint32Array.from([0, 1, 2, 3, 4]),
      nodes: Uint32Array.from([0, 1, 2, 3]),
    };
    const constraints = [0, 1, 2, 3].map((p) => {
      const x = mesh.nodes[3 * p]!;
      return {
        faces: [],
        edges: [p],
        displacement: [0, 0, 0.001 * x * x] as [number, number, number],
        rotation: [0, -0.002 * x, 0] as [number, number, number],
      };
    });
    const r = solveShell({
      mesh,
      material: { youngsModulus: 210_000, poissonsRatio: 0, density: 0 },
      loads: [],
      constraints,
      solver,
    });
    const check = shellEquilibriumCheck(r);
    expect(check.momentScale).toBeGreaterThan(100);
    expect(check.pass).toBe(true);
  });

  it('rigid motions of a curved shell make no force, and the lumped mass is ρ t A', () => {
    const mesh = gridMesh(
      6,
      5,
      (s, t) => [25 * Math.sin(s), 30 * t, 25 * Math.cos(s) + 3 * t * t],
      0.5,
    );
    const K = assembleShellStiffness(mesh, steel);
    const n = mesh.nodes.length / 3;
    const theta = [0.3, -0.2, 0.5],
      shift = [1, 2, -3];
    const x = new Float64Array(6 * n);
    for (let p = 0; p < n; p++) {
      const pos = mesh.nodes.subarray(3 * p, 3 * p + 3);
      const turn = [
        theta[1]! * pos[2]! - theta[2]! * pos[1]!,
        theta[2]! * pos[0]! - theta[0]! * pos[2]!,
        theta[0]! * pos[1]! - theta[1]! * pos[0]!,
      ];
      for (let i = 0; i < 3; i++) {
        x[6 * p + i] = shift[i]! + turn[i]!;
        x[6 * p + 3 + i] = theta[i]!;
      }
    }
    const Kx = K.multiply(x);
    const norm = (v: Float64Array) => Math.sqrt(v.reduce((s, y) => s + y * y, 0));
    const scale = Math.max(...K.values.map(Math.abs)) * norm(x);
    expect(norm(Kx) / scale).toBeLessThan(1e-12);

    const flat = plate(4);
    const M = assembleShellMass(flat, steel.density);
    const ones = new Float64Array(6 * 25);
    for (let p = 0; p < 25; p++) ones[6 * p] = 1;
    expect(M.multiply(ones).reduce((s, y) => s + y, 0)).toBeCloseTo(steel.density * 100 * 100, 15);
  });

  it('gives the modal effective masses on the translations', () => {
    const r = solveShellModal({
      mesh: plate(8),
      material: steel,
      constraints: edges(zero, free),
      modes: 4,
      solver: { tolerance: 1e-6, maxIterations: 2000 },
    });
    expect(r.mass).toBeCloseTo(7.85e-5, 12);
    expect(r.orthogonality).toBeLessThan(1e-6);
    // The first mode moves along z only; the antisymmetric second and third carry no net mass.
    expect(r.modes[0]!.effectiveMass[2]).toBeGreaterThan(0.5);
    expect(r.modes[0]!.effectiveMass[0]).toBeLessThan(1e-10);
    expect(r.modes[1]!.effectiveMass[2]).toBeLessThan(1e-6);
  });

  it('refuses studies it cannot solve, before solving', () => {
    const mesh = plate(2);
    const base = {
      mesh,
      material: steel,
      loads: [],
      constraints: edges(zero, zero),
      solver,
    };
    expect(refusal(() => solveShell({ ...base, constraints: [] }))).toBe('no-constraint');
    // w held on the edges only: the plate can still slide and spin in its plane.
    let modes: string[] = [];
    try {
      solveShell({ ...base, constraints: edges([null, null, 0], free) });
    } catch (e) {
      modes = (e as ElasticError).modes;
      expect((e as ElasticError).problem).toBe('rigid-body-mode');
    }
    expect(modes.sort()).toEqual(['rotation z', 'translation x', 'translation y']);
    expect(
      refusal(() =>
        solveShell({
          ...base,
          constraints: [{ faces: [], edges: [4], displacement: zero, rotation: zero }],
        }),
      ),
    ).toBe('target-index');
    expect(
      refusal(() => solveShell({ ...base, loads: [{ kind: 'pressure', faces: [], pressure: 1 }] })),
    ).toBe('empty-target');
    expect(refusal(() => solveShell({ ...base, material: { ...steel, poissonsRatio: 0.5 } }))).toBe(
      'material',
    );
    expect(
      refusal(() =>
        solveShell({ ...base, mesh: { ...mesh, thickness: new Float64Array(8).fill(0) } }),
      ),
    ).toBe('material');
    const flat = Float64Array.from(mesh.nodes);
    for (let p = 0; p < 9; p++) flat[3 * p + 1] = 0;
    expect(refusal(() => solveShell({ ...base, mesh: { ...mesh, nodes: flat } }))).toBe(
      'mesh-quality',
    );
    expect(
      refusal(() =>
        solveShell({
          ...base,
          constraints: [
            ...edges(zero, zero),
            { faces: [], edges: [0], displacement: [1, null, null], rotation: free },
          ],
        }),
      ),
    ).toBe('constraint-conflict');
    const modal = { mesh, material: steel, modes: 2, solver };
    expect(refusal(() => solveShellModal({ ...modal, constraints: edges([0, 0, 1], zero) }))).toBe(
      'constraint-conflict',
    );
    expect(
      refusal(() =>
        solveShellModal({
          ...modal,
          constraints: [{ faces: [0], edges: [], displacement: zero, rotation: zero }],
        }),
      ),
    ).toBe('constraint-conflict');
    expect(
      refusal(() =>
        solveShellModal({
          ...modal,
          material: { ...steel, density: 0 },
          constraints: edges(zero, zero),
        }),
      ),
    ).toBe('material');
  });

  it('makes a shell mesh from a triangulated midsurface and judges its triangles (R3i-3)', () => {
    const grid = plate(4);
    const surface = {
      points: grid.nodes,
      triangles: grid.triangles,
      faces: Uint32Array.from(grid.faces),
      shapeFaces: 1,
      shapeEdges: 4,
      edges: grid.edges,
    };
    const mesh = shellMeshFromSurface(surface, 1.5);
    expect([...new Set(mesh.thickness)]).toEqual([1.5]);
    expect(mesh.triangles).toEqual(grid.triangles);
    // Right isosceles triangles: 45° and aspect (1 + 1 + √2)·√2 / (4√3 · ½) ≈ 1.39.
    const q = shellMeshQuality(mesh);
    expect(q.minAngleDeg).toBeCloseTo(45, 9);
    expect(q.maxAspect).toBeCloseTo(((2 + Math.SQRT2) * Math.SQRT2) / (2 * Math.sqrt(3)), 9);
    expect(q.below).toEqual([]);
    // A sliver: one node pulled almost onto the opposite edge.
    const thin = Float64Array.from(grid.nodes);
    thin[3 * 6 + 1] = 0.1;
    expect(shellMeshQuality({ ...mesh, nodes: thin }).below.length).toBeGreaterThan(0);
    for (const bad of [
      { ...surface, triangles: new Uint32Array(0), faces: new Uint32Array(0) },
      { ...surface, faces: surface.faces.map(() => 1) },
      { ...surface, triangles: surface.triangles.map((x) => (x === 0 ? 99 : x)) },
      { ...surface, shapeEdges: 5 },
    ])
      expect(() => shellMeshFromSurface(bad, 1.5)).toThrow(RangeError);
    expect(() => shellMeshFromSurface(surface, 0)).toThrow(RangeError);
  });
});
