import { describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  ElasticError,
  solveBonded,
  solveBondedModal,
  solveElastic,
  solveModal,
  solveShell,
  solveShellModal,
  type BondedPart,
  type FemMesh,
  type ShellMesh,
} from './index';

/**
 * TS-1400 (ST-209#1, #2): bodies joined by bonds whose meshes do not match (R3j-3, FX8). The
 * references are the same models solved as one body.
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 100_000 };
const zero: [number, number, number] = [0, 0, 0];
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/** A flat grid shell over [x0, x1] × [y0, y1] at z; edges 0 y = y0, 1 x = x1, 2 y = y1, 3 x = x0. */
function grid(
  nu: number,
  nv: number,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  thickness: number,
): ShellMesh {
  const nodes: number[] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++)
      nodes.push(x0 + ((x1 - x0) * i) / nu, y0 + ((y1 - y0) * j) / nv, 0);
  const id = (i: number, j: number) => j * (nu + 1) + i;
  const tris: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const [a, b, c, d] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
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
const nodeAt = (nodes: Float64Array, p: [number, number, number]) => {
  let best = 0,
    d = Infinity;
  for (let q = 0; q < nodes.length / 3; q++) {
    const e = Math.hypot(nodes[3 * q]! - p[0], nodes[3 * q + 1]! - p[1], nodes[3 * q + 2]! - p[2]);
    if (e < d) [best, d] = [q, e];
  }
  expect(d).toBeLessThan(1e-9);
  return best;
};
const shifted = (mesh: FemMesh, dx: number): FemMesh => {
  const nodes = mesh.nodes.slice();
  for (let p = 0; p < nodes.length / 3; p++) nodes[3 * p]! += dx;
  return { ...mesh, nodes };
};
const clampEdges = (edges: number[]) => [{ faces: [], edges, displacement: zero, rotation: zero }];

describe('bonded bodies (R3j-3, FX8)', () => {
  it('FX8a: a clamped plate cut in two along non-matching edges deflects as one plate', () => {
    const q = 0.01;
    const whole = grid(16, 16, [0, 100], [0, 100], 1);
    const one = solveShell({
      mesh: whole,
      material: steel,
      loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
      constraints: clampEdges([0, 1, 2, 3]),
      solver,
    });
    const left = grid(8, 16, [0, 50], [0, 100], 1);
    const right = grid(7, 13, [50, 100], [0, 100], 1);
    const parts: BondedPart[] = [
      {
        kind: 'shell',
        mesh: left,
        material: steel,
        loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
        constraints: clampEdges([0, 2, 3]),
      },
      {
        kind: 'shell',
        mesh: right,
        material: steel,
        loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
        constraints: clampEdges([0, 1, 2]),
      },
    ];
    const r = solveBonded({
      parts,
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [], edges: [1] },
          tolerance: 1e-6,
        },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    // The two corner nodes of the seam are held, so they follow nothing.
    expect(r.bonds).toEqual([{ nodes: 12, maxGap: expect.any(Number) }]);
    const centre = (u: Float64Array, mesh: ShellMesh) =>
      u[6 * nodeAt(mesh.nodes, [50, 50, 0]) + 2]!;
    const expected = centre(one.displacement, whole);
    const got = centre(r.parts[0]!.displacement, left);
    expect(Math.abs(got / expected - 1)).toBeLessThan(0.01);
    // Equilibrium over both plates: the reactions take the whole pressure.
    const F = r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!);
    expect(Math.hypot(...F)).toBeLessThan(1e-6 * Math.hypot(...r.appliedTotal));
    expect(Math.hypot(...r.appliedTotal)).toBeCloseTo(q * 100 * 100, 6);
  });

  it('FX8b: a cantilever cut in two along non-matching faces bends as one beam', () => {
    const material = steel;
    const whole = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
    const one = solveElastic({
      mesh: whole,
      material,
      constraints: [{ faces: [0], edges: [], displacement: zero }],
      loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
      solver,
    });
    const left = boxTetMesh({ size: [100, 20, 20], divisions: [10, 2, 2], type: 'tet10' });
    const right = shifted(
      boxTetMesh({ size: [100, 20, 20], divisions: [7, 3, 3], type: 'tet10' }),
      100,
    );
    const r = solveBonded({
      parts: [
        {
          kind: 'solid',
          mesh: left,
          material,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'solid',
          mesh: right,
          material,
          loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-6,
        },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    const tip = (u: Float64Array, mesh: FemMesh) => u[3 * nodeAt(mesh.nodes, [200, 10, 10]) + 2]!;
    const expected = tip(one.displacement, whole);
    expect(Math.abs(tip(r.parts[1]!.displacement, right) / expected - 1)).toBeLessThan(0.01);
    // Timoshenko: 0.96 mm.
    expect(Math.abs(-expected / 0.96 - 1)).toBeLessThan(0.03);
    const F = r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!);
    expect(Math.hypot(...F)).toBeLessThan(1e-6 * 1000);
  });

  it('FX8c: a shell plate bonded by its edge to a solid block bends as one clamped there', () => {
    // Block x ∈ [-20, 0], y ∈ [0, 50], z ∈ [-10, 10], held at x = -20; the plate in z = 0 from
    // x = 0 to 200, 2 mm thick, 10 N down at its free edge.
    const block = boxTetMesh({ size: [20, 50, 20], divisions: [4, 10, 4], type: 'tet10' });
    const nodes = block.nodes.slice();
    for (let p = 0; p < nodes.length / 3; p++) {
      nodes[3 * p]! -= 20;
      nodes[3 * p + 2]! -= 10;
    }
    const plate = grid(40, 10, [0, 200], [0, 50], 2);
    const tipLoad = {
      kind: 'edge-force' as const,
      edges: [1],
      force: [0, 0, -10] as [number, number, number],
    };
    const r = solveBonded({
      parts: [
        {
          kind: 'solid',
          mesh: { ...block, nodes },
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        { kind: 'shell', mesh: plate, material: steel, loads: [tipLoad], constraints: [] },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-6,
        },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    const clamped = solveShell({
      mesh: plate,
      material: steel,
      loads: [tipLoad],
      constraints: clampEdges([3]),
      solver,
    });
    const tip = (u: Float64Array) => u[6 * nodeAt(plate.nodes, [200, 25, 0]) + 2]!;
    const reference = tip(clamped.displacement);
    // The block is far stiffer than the plate: the bond passes the moment as a clamp would.
    expect(Math.abs(tip(r.parts[1]!.displacement) / reference - 1)).toBeLessThan(0.03);
    // P L³ / 3 E I for the plate as a beam (a wide plate is a little stiffer: (1 − ν²)).
    const beam = (10 * 200 ** 3) / (3 * 210_000 * ((50 * 2 ** 3) / 12));
    expect(-reference / beam).toBeGreaterThan(0.9);
    expect(-reference / beam).toBeLessThan(1.02);
    const F = r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!);
    expect(Math.hypot(...F)).toBeLessThan(1e-6 * 10);
    const M = r.appliedMoment.map((x, i) => x + r.reactionMoment[i]!);
    expect(Math.hypot(...M)).toBeLessThan(1e-6 * r.momentScale);
  }, 120_000);

  it('a shell skin glued flat on a bending block turns with it (#890)', () => {
    // Block 200 × 20 × 20 held at x = 0, 1000 N down at x = 200; a 1 mm skin on its top face, its
    // midsurface at z = 20.5. The skin's face on the block follows it; its rotations are its own.
    const block = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
    const skin = grid(40, 4, [0, 200], [0, 20], 1);
    const nodes = skin.nodes.slice();
    for (let p = 0; p < nodes.length / 3; p++) nodes[3 * p + 2] = 20.5;
    const r = solveBonded({
      parts: [
        {
          kind: 'solid',
          mesh: block,
          material: steel,
          loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        { kind: 'shell', mesh: { ...skin, nodes }, material: steel, loads: [], constraints: [] },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [5], edges: [] },
          tolerance: 1e-3,
        },
      ],
      solver,
    });
    expect(r.converged).toBe(true);
    expect(r.bonds[0]!.maxGap).toBeLessThan(1e-9);
    // The skin's rotation about y is the block's slope there: θ_y = −dw/dx.
    const w = (x: number) => r.parts[0]!.displacement[3 * nodeAt(block.nodes, [x, 10, 20]) + 2]!;
    for (const x of [50, 100, 150]) {
      const slope = (w(x + 10) - w(x - 10)) / 20;
      const theta = r.parts[1]!.displacement[6 * nodeAt(nodes, [x, 10, 20.5]) + 4]!;
      expect(Math.abs(theta / -slope - 1)).toBeLessThan(0.03);
    }
    const F = r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!);
    expect(Math.hypot(...F)).toBeLessThan(1e-6 * 1000);
    const M = r.appliedMoment.map((x, i) => x + r.reactionMoment[i]!);
    expect(Math.hypot(...M)).toBeLessThan(1e-6 * r.momentScale);
  }, 120_000);

  it('a bond on a tet10 edge follows its quadratic field as the face beside it does (#890)', () => {
    // Block A 100 × 20 × 20 (two tet10 cells along x) held at x = 0, 1000 N down at x = 100. Block
    // B beside it shares A's edge y = 20, z = 20 with five cells along x, held at y = 40. B's
    // edge follows A's edge, or A's face y = 20 that the edge bounds: the same field on the edge.
    const a = boxTetMesh({ size: [100, 20, 20], divisions: [2, 1, 1], type: 'tet10' });
    const b0 = boxTetMesh({ size: [100, 20, 20], divisions: [5, 1, 1], type: 'tet10' });
    const bNodes = b0.nodes.slice();
    for (let p = 0; p < bNodes.length / 3; p++) {
      bNodes[3 * p + 1]! += 20;
      bNodes[3 * p + 2]! += 20;
    }
    const b = { ...b0, nodes: bNodes };
    const run = (on: { faces: number[]; edges: number[] }) =>
      solveBonded({
        parts: [
          {
            kind: 'solid',
            mesh: a,
            material: steel,
            loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
            constraints: [{ faces: [0], edges: [], displacement: zero }],
          },
          {
            kind: 'solid',
            mesh: b,
            material: steel,
            loads: [],
            constraints: [{ faces: [3], edges: [], displacement: zero }],
          },
        ],
        bonds: [
          { follower: { part: 1, faces: [], edges: [0] }, on: { part: 0, ...on }, tolerance: 1e-6 },
        ],
        solver,
      });
    const onEdge = run({ faces: [], edges: [3] });
    const onFace = run({ faces: [3], edges: [] });
    expect(onEdge.converged && onFace.converged).toBe(true);
    const u = onEdge.parts[1]!.displacement,
      v = onFace.parts[1]!.displacement;
    const scale = Math.max(...u.map(Math.abs));
    expect(scale).toBeGreaterThan(0);
    for (let d = 0; d < u.length; d++) expect(Math.abs(u[d]! - v[d]!)).toBeLessThan(1e-6 * scale);
  }, 120_000);

  it('refuses a solid following a shell, a gap, a loop and an unheld body, and leaves held DOFs held', () => {
    const plate = grid(4, 4, [0, 10], [0, 10], 1);
    const box = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const shell = (constraints = clampEdges([0])): BondedPart => ({
      kind: 'shell',
      mesh: plate,
      material: steel,
      loads: [],
      constraints,
    });
    const solid = (held: boolean): BondedPart => ({
      kind: 'solid',
      mesh: box,
      material: steel,
      loads: [],
      constraints: held ? [{ faces: [0], edges: [], displacement: zero }] : [],
    });
    const run = (parts: BondedPart[], bonds: Parameters<typeof solveBonded>[0]['bonds']) =>
      refusal(() => solveBonded({ parts, bonds, solver }));
    const side = (part: number, faces: number[], edges: number[] = []) => ({ part, faces, edges });
    // A solid face following a shell.
    expect(
      run([shell(), solid(false)], [{ follower: side(1, [4]), on: side(0, [0]), tolerance: 1 }]),
    ).toBe('bond-kind');
    // The plate's edge x = 10 is 10 mm from the box face x = 0.
    expect(
      run([shell(), solid(true)], [{ follower: side(0, [], [1]), on: side(1, [0]), tolerance: 1 }]),
    ).toBe('bond-gap');
    // A held edge set to follow stays held: none of its nodes is tied.
    const held = solveBonded({
      parts: [shell(), shell()],
      bonds: [{ follower: side(1, [], [0]), on: side(0, [], [0]), tolerance: 1e-6 }],
      solver,
    });
    expect(held.bonds).toEqual([{ nodes: 0, maxGap: 0 }]);
    // Each plate's edge following the other's.
    expect(
      run(
        [shell(), shell([])],
        [
          { follower: side(1, [], [2]), on: side(0, [], [2]), tolerance: 1e-6 },
          { follower: side(0, [], [2]), on: side(1, [], [2]), tolerance: 1e-6 },
        ],
      ),
    ).toBe('bond-cycle');
    // One plate's edge bonded to two plates: each node may follow one part only (#890).
    expect(
      run(
        [shell(), shell([]), shell()],
        [
          { follower: side(1, [], [2]), on: side(0, [], [2]), tolerance: 1e-6 },
          { follower: side(1, [], [2]), on: side(2, [], [2]), tolerance: 1e-6 },
        ],
      ),
    ).toBe('bond-overlap');
    // A cube bonded to a held cube along one edge only can still turn about that edge (#890).
    const cube = (dy: number, dz: number, dx = 0): FemMesh => {
      const m = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet4' });
      const nodes = Float64Array.from(m.nodes);
      for (let n = 0; n < nodes.length / 3; n++) {
        nodes[3 * n]! += dx;
        nodes[3 * n + 1]! += dy;
        nodes[3 * n + 2]! += dz;
      }
      return { ...m, nodes };
    };
    const block = (mesh: FemMesh, held: boolean): BondedPart => ({
      kind: 'solid',
      mesh,
      material: steel,
      loads: [],
      constraints: held ? [{ faces: [0], edges: [], displacement: zero }] : [],
    });
    expect(
      run(
        [block(cube(0, 0), true), block(cube(10, 10), false)],
        // The second cube's edge y = 0, z = 0 lies on the first cube's face y = 10.
        [{ follower: side(1, [], [0]), on: side(0, [3]), tolerance: 1e-6 }],
      ),
    ).toBe('bond-mechanism');
    // Bonded on a face, with a held cube far away: nothing is free (each piece is scaled alone).
    expect(
      solveBonded({
        parts: [block(cube(0, 0), true), block(cube(10, 0), false), block(cube(0, 0, 1e6), true)],
        bonds: [{ follower: side(1, [2]), on: side(0, [3]), tolerance: 1e-6 }],
        solver,
      }).converged,
    ).toBe(true);
    // The same two bonds on a clamped edge tie nothing, so they do not overlap.
    expect(
      solveBonded({
        parts: [shell(), shell(), shell()],
        bonds: [
          { follower: side(1, [], [0]), on: side(0, [], [0]), tolerance: 1e-6 },
          { follower: side(1, [], [0]), on: side(2, [], [0]), tolerance: 1e-6 },
        ],
        solver,
      }).bonds,
    ).toEqual([
      { nodes: 0, maxGap: 0 },
      { nodes: 0, maxGap: 0 },
    ]);
    // A second plate held by nothing and bonded to nothing.
    expect(run([shell(), shell([])], [])).toBe('body-unconnected');
    expect(run([shell()], [{ follower: side(3, [], [0]), on: side(0, [0]), tolerance: 1 }])).toBe(
      'target-index',
    );
    // A shell follower naming a face the plate does not have, beside one it has.
    expect(
      run([shell(), shell([])], [{ follower: side(1, [0, 99]), on: side(0, [0]), tolerance: 1 }]),
    ).toBe('target-index');
    // One held direction holds no rigid motion but that one.
    expect(
      run(
        [
          {
            kind: 'solid',
            mesh: box,
            material: steel,
            loads: [],
            constraints: [{ faces: [0], edges: [], displacement: [0, null, null] }],
          },
        ],
        [],
      ),
    ).toBe('rigid-body-mode');
  });

  it('follows the curved faces of tet10 elements and keeps the ILU iterate when the budget ends', () => {
    // Two cubes meeting at x = 10, a mid-edge node of the shared face moved off the corners' plane
    // on both meshes: the faces still coincide.
    const bent = (dx: number): FemMesh => {
      const m = shifted(
        boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' }),
        dx,
      );
      const q = nodeAt(m.nodes, [10, 2.5, 5]);
      m.nodes[3 * q]! += 0.1;
      return m;
    };
    const [a, b] = [bent(0), bent(10)];
    const parts: BondedPart[] = [
      {
        kind: 'solid',
        mesh: a,
        material: steel,
        loads: [],
        constraints: [{ faces: [0], edges: [], displacement: zero }],
      },
      {
        kind: 'solid',
        mesh: b,
        material: steel,
        loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -100] }],
        constraints: [],
      },
    ];
    const bonds = [
      {
        follower: { part: 1, faces: [0], edges: [] },
        on: { part: 0, faces: [1], edges: [] },
        tolerance: 1e-6,
      },
    ];
    const r = solveBonded({ parts, bonds, solver });
    expect(r.converged).toBe(true);
    expect(r.bonds[0]!.maxGap).toBeLessThan(1e-9);
    // Ten iterations: not converged, but not thrown away either.
    const short = solveBonded({ parts, bonds, solver: { tolerance: 1e-12, maxIterations: 10 } });
    expect(short.converged).toBe(false);
    expect(short.iterations).toBe(10);
    expect(short.preconditioner).toBe('ilu');
    expect(short.parts[1]!.displacement.some((x) => x !== 0)).toBe(true);
  });
});

/**
 * TS-1454 (ST-232#1): natural modes of bonded bodies (R3j-4c, FX8d): the same cut models as FX8a
 * and FX8b vibrate as the whole ones do.
 */
describe('modes of bonded bodies (R3j-4c, FX8d)', () => {
  const modal = { tolerance: 1e-4, maxIterations: 2000 };
  it('a clamped plate cut in two along non-matching edges has the whole plate’s modes', () => {
    const one = solveShellModal({
      mesh: grid(12, 12, [0, 100], [0, 100], 1),
      material: steel,
      constraints: clampEdges([0, 1, 2, 3]),
      modes: 3,
      solver: modal,
    });
    const r = solveBondedModal({
      parts: [
        {
          kind: 'shell',
          mesh: grid(6, 12, [0, 50], [0, 100], 1),
          material: steel,
          loads: [],
          constraints: clampEdges([0, 2, 3]),
        },
        {
          kind: 'shell',
          mesh: grid(5, 10, [50, 100], [0, 100], 1),
          material: steel,
          loads: [],
          constraints: clampEdges([0, 1, 2]),
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [], edges: [1] },
          tolerance: 1e-6,
        },
      ],
      modes: 3,
      solver: modal,
    });
    expect(r.converged).toBe(true);
    expect(r.orthogonality).toBeLessThan(1e-6);
    expect(Math.abs(r.modes[0]!.frequency / one.modes[0]!.frequency - 1)).toBeLessThan(0.02);
    expect(r.mass).toBeCloseTo(7.85e-9 * 100 * 100 * 1, 12);
    expect(r.partMasses.reduce((s, m) => s + m, 0)).toBeCloseTo(r.mass, 12);
    expect(r.modes[0]!.shapes.map((s) => s.length)).toEqual([6 * 7 * 13, 6 * 6 * 11]);
  });

  it('a cantilever cut in two along non-matching faces has the whole beam’s first bending mode', () => {
    const whole = boxTetMesh({ size: [200, 20, 20], divisions: [10, 2, 2], type: 'tet10' });
    const one = solveModal({
      mesh: whole,
      material: steel,
      constraints: [{ faces: [0], edges: [], displacement: zero }],
      modes: 2,
      solver: modal,
    });
    const r = solveBondedModal({
      parts: [
        {
          kind: 'solid',
          mesh: boxTetMesh({ size: [100, 20, 20], divisions: [5, 2, 2], type: 'tet10' }),
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'solid',
          mesh: shifted(
            boxTetMesh({ size: [100, 20, 20], divisions: [4, 3, 3], type: 'tet10' }),
            100,
          ),
          material: steel,
          loads: [],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-6,
        },
      ],
      modes: 2,
      solver: modal,
    });
    expect(r.converged).toBe(true);
    expect(Math.abs(r.modes[0]!.frequency / one.modes[0]!.frequency - 1)).toBeLessThan(0.02);
    // Euler–Bernoulli: f1 = 1.875² / 2π √(E I / ρ A L⁴) ≈ 410 Hz for a 200 mm 20 × 20 steel bar.
    expect(Math.abs(r.modes[0]!.frequency / 410 - 1)).toBeLessThan(0.05);
    expect(r.modes[0]!.effectiveMass[0]).toBeLessThan(1e-3 * r.mass);
    // A held DOF other than 0 is refused.
    expect(
      refusal(() =>
        solveBondedModal({
          ...{ bonds: [], modes: 1, solver: modal },
          parts: [
            {
              kind: 'solid',
              mesh: whole,
              material: steel,
              loads: [],
              constraints: [{ faces: [0], edges: [], displacement: [0.1, 0, 0] }],
            },
          ],
        }),
      ),
    ).toBe('constraint-conflict');
  }, 15_000);
});
