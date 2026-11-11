import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ElasticError,
  expandShell,
  expandShellStudy,
  prepareShell,
  readCalculixFrd,
  shellEquilibriumCheck,
  shellExpansionSize,
  shellResultFromFrd,
  solveShell,
  writeCalculixModel,
  type ShellConstraint,
  type ShellInput,
  type ShellMesh,
  type ShellResult,
} from './index';

/**
 * TS-1456 (ST-233#1): a shell on the reference Host as the editor's own 15-node wedges (R3j-5a).
 * The plates of FX6 solved by CalculiX agree with the known values and with the browser's shell.
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 20_000 };
const zero: [number, number, number] = [0, 0, 0];
const free: [null, null, null] = [null, null, null];
const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-shell-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, 'job.frd'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/** As shell.test.ts: an (s, t) patch mapped by `at`; edges 0 t = 0, 1 s = 1, 2 t = 1, 3 s = 0. */
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
): ShellConstraint[] => [{ faces: [], edges: [0, 1, 2, 3], displacement, rotation }];

/** The study solved by CalculiX on the wedges, as the Host does it. */
function onHost(input: ShellInput, units: 'mm' | 'm' = 'mm') {
  return onHostPrepared(input, prepareShell(input), units);
}
function onHostPrepared(
  input: ShellInput,
  prepared: ReturnType<typeof prepareShell>,
  units: 'mm' | 'm' = 'mm',
) {
  const expansion = expandShell(input.mesh);
  const model = expandShellStudy(input.mesh, expansion, input.material, prepared);
  const text = runCcx(writeCalculixModel({ ...model, units }));
  const frd = readCalculixFrd(text, expansion.nodes.length / 3, units);
  return shellResultFromFrd(input.mesh, expansion, prepared, frd);
}
const D = (210_000 * 1) / (12 * (1 - 0.09));

describe('shells on the Host as 15-node wedges (R3j-5a)', () => {
  it('expands each triangle into one wedge over the wall, sized before it is built', () => {
    const mesh = plate(4);
    const x = expandShell(mesh);
    const size = shellExpansionSize(mesh);
    expect(x.nodes.length / 3).toBe(size.nodes);
    expect(x.wedges.length / 15).toBe(size.elements);
    // 25 corners × 3 layers + 56 sides × 2.
    expect(size.nodes).toBe(25 * 3 + 56 * 2);
    for (let p = 0; p < 25; p++) {
      expect(x.nodes[3 * x.layers[3 * p]! + 2]).toBeCloseTo(-0.5, 12);
      expect(x.nodes[3 * x.layers[3 * p + 2]! + 2]).toBeCloseTo(0.5, 12);
    }
  });

  // One layer of wedges is stiff on coarse plates (0.87 of the known value at 8 × 8, 0.97 at
  // 16 × 16, as CalculiX's own S6): the comparisons are on 32 × 32.
  it.skipIf(!hasCcx)(
    'FX6a: a clamped plate under pressure, as the browser and the known value',
    () => {
      const q = 0.01;
      const input: ShellInput = {
        mesh: plate(32),
        material: steel,
        loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
        constraints: edges(zero, zero),
        solver,
      };
      const host = onHost(input);
      const mine = solveShell(input);
      const centre = 16 * 33 + 16;
      const expected = (0.00126 * q * 100 ** 4) / D;
      expect(Math.abs(host.displacement[6 * centre + 2]! / expected - 1)).toBeLessThan(0.02);
      expect(
        Math.abs(host.displacement[6 * centre + 2]! / mine.displacement[6 * centre + 2]! - 1),
      ).toBeLessThan(0.02);
      const eq = shellEquilibriumCheck(host, 2e-5);
      expect(eq.pass, JSON.stringify(eq)).toBe(true);
      expect(Math.hypot(...host.reactionTotal) / (q * 100 * 100)).toBeCloseTo(1, 4);
    },
  );

  it.skipIf(!hasCcx)(
    'FX6d: a simply supported plate (rotations free) under pressure, in mm and in m',
    () => {
      const q = 0.01;
      const input: ShellInput = {
        mesh: plate(32),
        material: steel,
        loads: [{ kind: 'pressure', faces: [0], pressure: -q }],
        constraints: edges(zero, free),
        solver,
      };
      const centre = 16 * 33 + 16;
      // Timoshenko: 0.00406 q a⁴ / D.
      const expected = (0.00406 * q * 100 ** 4) / D;
      const mine = solveShell(input);
      for (const units of ['mm', 'm'] as const) {
        const host = onHost(input, units);
        expect(Math.abs(host.displacement[6 * centre + 2]! / expected - 1)).toBeLessThan(0.02);
        expect(
          Math.abs(host.displacement[6 * centre + 2]! / mine.displacement[6 * centre + 2]! - 1),
        ).toBeLessThan(0.02);
        expect(shellEquilibriumCheck(host, 2e-5).pass).toBe(true);
      }
    },
  );

  it.skipIf(!hasCcx)(
    'a cantilever strip: its tip, root rotation and top / bottom stresses as the browser',
    () => {
      const mesh = gridMesh(20, 4, (s, t) => [100 * s, 20 * t, 0], 1);
      const input: ShellInput = {
        mesh,
        material: steel,
        loads: [{ kind: 'edge-force', edges: [1], force: [0, 0, 1] }],
        constraints: [{ faces: [], edges: [3], displacement: zero, rotation: zero }],
        solver,
      };
      const host = onHost(input);
      const mine = solveShell(input);
      const tip = 2 * 21 + 20,
        mid = 2 * 21 + 10;
      expect(
        Math.abs(host.displacement[6 * tip + 2]! / mine.displacement[6 * tip + 2]! - 1),
      ).toBeLessThan(0.03);
      // The slope at mid-span about y, from the top and bottom layers.
      expect(
        Math.abs(host.displacement[6 * mid + 4]! / mine.displacement[6 * mid + 4]! - 1),
      ).toBeLessThan(0.03);
      // σxx at mid-span: M c / I = (50 N·mm) · 0.5 / (20 / 12) = 15 MPa, compressed on top.
      expect(host.stress.top[6 * mid]!).toBeCloseTo(-15, 0);
      expect(host.stress.bottom[6 * mid]!).toBeCloseTo(15, 0);
      expect(Math.abs(host.stress.middle[6 * mid]!)).toBeLessThan(0.5);
      const eq = shellEquilibriumCheck(host, 2e-5);
      expect(eq.pass, JSON.stringify(eq)).toBe(true);
      // The 6 digits of the root layers' couples (about 1100 N) leave 5e-4 N on the sum.
      expect(host.reactionTotal[2]).toBeCloseTo(-1, 2);
    },
  );

  it('refuses mixed thickness and a partly held rotation', () => {
    const mixed = plate(2);
    mixed.thickness[0] = 2;
    expect(refusal(() => expandShell(mixed))).toBe('host-shell');
    const mesh = plate(2);
    const prepared = prepareShell({
      mesh,
      material: steel,
      loads: [],
      constraints: [
        { faces: [], edges: [3], displacement: zero, rotation: [0, null, 0] },
        { faces: [], edges: [1], displacement: zero, rotation: free },
      ],
    });
    expect(refusal(() => expandShellStudy(mesh, expandShell(mesh), steel, prepared))).toBe(
      'host-shell',
    );
  });
});

/**
 * TS-1533 (ST-262#1, CR4f): a crease beyond 60° on the Host. Each creased node becomes one copy
 * per smooth side with its own normal, the copies' middles and their rotations about the crease
 * edge tied by equations; the folded strip and the box section solve as the browser's shell.
 */
describe('creases on the Host (CR4f)', () => {
  /** A strip folded by `deg` along x = 50: a hinge without the rotation ties. */
  const folded = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return gridMesh(
      20,
      4,
      (s, t) =>
        s <= 0.5
          ? [100 * s, 20 * t, 0]
          : [50 + 100 * (s - 0.5) * Math.cos(a), 20 * t, 100 * (s - 0.5) * Math.sin(a)],
      1,
    );
  };

  /** A square tube 20 × 20 mm (midline) of `k` triangles a wall across, 200 mm along x. */
  function box(k: number, nx: number): ShellMesh {
    const P = 4 * k;
    const nodes: number[] = [];
    for (let j = 0; j <= nx; j++)
      for (let i = 0; i < P; i++) {
        const w = Math.floor(i / k),
          f = (i % k) / k;
        const [y, z] = [
          [-10 + 20 * f, -10],
          [10, -10 + 20 * f],
          [10 - 20 * f, 10],
          [-10, 10 - 20 * f],
        ][w]!;
        nodes.push((200 * j) / nx, y!, z!);
      }
    const id = (i: number, j: number) => j * P + (i % P);
    const tris: number[] = [];
    const faces: number[] = [];
    for (let j = 0; j < nx; j++)
      for (let i = 0; i < P; i++) {
        const [a, b, c, d] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
        if ((i + j) % 2) tris.push(a, b, c, a, c, d);
        else tris.push(a, b, d, b, c, d);
        faces.push(Math.floor(i / k), Math.floor(i / k));
      }
    const loop = (j: number) => [...Array.from({ length: P }, (_, i) => id(i, j)), id(0, j)];
    const chains = [loop(0), loop(nx)];
    const m = tris.length / 3;
    return {
      nodes: Float64Array.from(nodes),
      triangles: Uint32Array.from(tris),
      thickness: new Float64Array(m).fill(1),
      faces: Int32Array.from(faces),
      shapeFaces: 4,
      shapeEdges: 2,
      edges: {
        offsets: Uint32Array.from([0, P + 1, 2 * P + 2]),
        nodes: Uint32Array.from(chains.flat()),
      },
    };
  }

  it('splits a creased node into one copy per side, and counts them before it is built', () => {
    const mesh = folded(90);
    const x = expandShell(mesh);
    // The 5 nodes on the fold (i = 10) have a second copy each.
    expect(Array.from(x.creases.node)).toEqual([10, 31, 52, 73, 94]);
    expect(x.creases.ties.length / 5).toBe(5);
    const size = shellExpansionSize(mesh);
    expect(x.nodes.length / 3).toBe(size.nodes);
    // 105 + 5 copies × 3 layers; 100 + 84 + 80 sides, the 4 on the fold twice.
    expect(size.nodes).toBe(110 * 3 + (264 + 4) * 2);
    // Each copy's normal is its own side's: z on the flat part, −x on the raised one.
    const [c0, c1] = [10, 105];
    expect(Math.abs(x.normals[3 * c0 + 2]!)).toBeCloseTo(1, 12);
    expect(Math.abs(x.normals[3 * c1]!)).toBeCloseTo(1, 12);
    // A bend that turns its triangles up to 30° from the mean normal keeps one copy per node.
    expect(expandShell(folded(20)).creases.node.length).toBe(0);
  });

  /** Each equation's residual for expanded-node displacements u(x) (x, y, z of the node). */
  const residuals = (mesh: ShellMesh, u: (x: number[], node: number) => number[]) => {
    const x = expandShell(mesh);
    const free = {
      prescribed: new Map<number, number>(),
      force: new Float64Array((mesh.nodes.length / 3) * 6),
      loadChecks: [],
      constrainedNodes: [],
    };
    const model = expandShellStudy(mesh, x, steel, free);
    const U = new Float64Array(x.nodes.length);
    for (let q = 0; q < x.nodes.length / 3; q++)
      U.set(
        u(
          [0, 1, 2].map((i) => x.nodes[3 * q + i]!),
          q,
        ),
        3 * q,
      );
    return {
      x,
      model,
      r: model.equations!.map((row) => row.reduce((s, [d, c]) => s + c * U[d]!, 0)),
    };
  };

  it('keeps a rigid turn free across a crease that does not lie flat (Codex on #962)', () => {
    // A crease through (0, −10, 0), (0, 0, 0), (0, 10, 1): a wing in z ≈ 0 and one in x = 0.
    const mesh: ShellMesh = {
      nodes: Float64Array.from([
        0, -10, 0, 0, 0, 0, 0, 10, 1, -10, -10, 0, -10, 0, 0, -10, 10, 1, 0, -10, 10, 0, 0, 10, 0,
        10, 11,
      ]),
      triangles: Uint32Array.from([
        0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 0, 6, 7, 0, 7, 1, 1, 7, 8, 1, 8, 2,
      ]),
      thickness: new Float64Array(8).fill(1),
      faces: new Int32Array(8),
      shapeFaces: 1,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    for (const th of [
      [0, 0, 1],
      [1, 0, 0],
      [0.3, -0.5, 0.8],
    ]) {
      const { x, r } = residuals(mesh, (p) => [
        th[1]! * p[2]! - th[2]! * p[1]!,
        th[2]! * p[0]! - th[0]! * p[2]!,
        th[0]! * p[1]! - th[1]! * p[0]!,
      ]);
      expect(x.creases.node.length).toBeGreaterThan(0);
      expect(Math.max(...r.map(Math.abs))).toBeLessThan(1e-9);
    }
  });

  it('ties the crease sides’ own mid-edge nodes as well as their corners (Codex on #962)', () => {
    const mesh = folded(90);
    // Moving one crease side's mid-edge nodes alone (both layers) breaks an equation.
    const { x } = residuals(mesh, () => [0, 0, 0]);
    const byEnds = new Map<string, number[]>();
    for (let k = 0; k < x.sides.ends.length / 2; k++) {
      const key = [x.sides.ends[2 * k]!, x.sides.ends[2 * k + 1]!].sort((a, b) => a - b).join();
      byEnds.set(key, [...(byEnds.get(key) ?? []), k]);
    }
    const crease = [...byEnds.values()].filter((l) => l.length === 2);
    expect(crease).toHaveLength(4);
    for (const [, k] of crease) {
      const moved = new Set([x.sides.layers[2 * k!]!, x.sides.layers[2 * k! + 1]!]);
      const { r } = residuals(mesh, (_, q) => (moved.has(q) ? [0, 0, 1] : [0, 0, 0]));
      expect(Math.max(...r.map(Math.abs))).toBeGreaterThan(0.5);
      // Turning it about the crease alone (its layers apart along the normal) breaks one too.
      const [bottom, top] = [x.sides.layers[2 * k!]!, x.sides.layers[2 * k! + 1]!];
      const { r: turn } = residuals(mesh, (_, q) =>
        q === top ? [0.5, 0, 0.5] : q === bottom ? [-0.5, 0, -0.5] : [0, 0, 0],
      );
      expect(Math.max(...turn.map(Math.abs))).toBeGreaterThan(0.1);
    }
  });

  it('turns all copies of a node where four creases meet as one rotation (Codex on #962)', () => {
    // A four-sided pyramid: apex (0, 0, 10), base corners (±10, ±10, 0); the apex has 4 copies.
    const mesh: ShellMesh = {
      nodes: Float64Array.from([0, 0, 10, 10, 10, 0, -10, 10, 0, -10, -10, 0, 10, -10, 0]),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]),
      thickness: new Float64Array(4).fill(1),
      faces: new Int32Array(4),
      shapeFaces: 1,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const { x } = residuals(mesh, () => [0, 0, 0]);
    const apex = [
      0,
      ...[...x.creases.node.keys()].filter((j) => x.creases.node[j] === 0).map((j) => 5 + j),
    ];
    expect(apex).toHaveLength(4);
    // Each copy's turn w square to its normal (two components), top +w/2, bottom −w/2: the
    // turns the equations leave free are those of one rotation θ (w = θ × n), 3 of the 8.
    const basis = apex.flatMap((c) => {
      const n = [0, 1, 2].map((i) => x.normals[3 * c + i]!);
      const a = Math.hypot(n[1]!, n[0]!) > 1e-9 ? [-n[1]!, n[0]!, 0] : [1, 0, 0];
      const la = Math.hypot(...a);
      const g1 = a.map((v) => v / la);
      const g2 = [
        n[1]! * g1[2]! - n[2]! * g1[1]!,
        n[2]! * g1[0]! - n[0]! * g1[2]!,
        n[0]! * g1[1]! - n[1]! * g1[0]!,
      ];
      return [g1, g2].map((g) => ({ c, g }));
    });
    const columns = basis.map(({ c, g }) => {
      const [bottom, top] = [x.layers[3 * c]!, x.layers[3 * c + 2]!];
      return residuals(mesh, (_, q) =>
        q === top ? g.map((v) => v / 2) : q === bottom ? g.map((v) => -v / 2) : [0, 0, 0],
      ).r;
    });
    const A = columns[0]!.map((_, i) => columns.map((col) => col[i]!));
    let rank = 0;
    const cols = basis.length;
    for (let col = 0; col < cols && rank < A.length; col++) {
      let pivot = rank;
      for (let i = rank; i < A.length; i++)
        if (Math.abs(A[i]![col]!) > Math.abs(A[pivot]![col]!)) pivot = i;
      if (Math.abs(A[pivot]![col]!) < 1e-9) continue;
      [A[rank], A[pivot]] = [A[pivot]!, A[rank]!];
      for (let i = 0; i < A.length; i++)
        if (i !== rank) {
          const f = A[i]![col]! / A[rank]![col]!;
          for (let j = col; j < cols; j++) A[i]![j]! -= f * A[rank]![j]!;
        }
      rank++;
    }
    expect(cols - rank).toBe(3);
    // And a rigid turn of the whole pyramid stays free.
    const { r } = residuals(mesh, (p) => [
      0.2 * p[2]! - 0.5 * p[1]!,
      0.5 * p[0]! - 0.7 * p[2]!,
      0.7 * p[1]! - 0.2 * p[0]!,
    ]);
    expect(Math.max(...r.map(Math.abs))).toBeLessThan(1e-9);
  });

  it('adds no crease tie the supports already imply (Codex on #962)', () => {
    // Two triangles folded 90° along x = 0, y 0–10, the crease's ends held in place, free to turn.
    const mesh: ShellMesh = {
      nodes: Float64Array.from([0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, -10]),
      triangles: Uint32Array.from([0, 2, 1, 0, 1, 3]),
      thickness: new Float64Array(2).fill(1),
      faces: Int32Array.from([0, 1]),
      shapeFaces: 2,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const x = expandShell(mesh);
    const prescribed = new Map<number, number>();
    for (const p of [0, 1]) for (let i = 0; i < 3; i++) prescribed.set(6 * p + i, 0);
    const model = expandShellStudy(mesh, x, steel, {
      prescribed,
      force: new Float64Array(24),
      loadChecks: [],
      constrainedNodes: [],
    });
    // The equations' rank on the free DOFs (the held ones substituted) is their number.
    const rows = model.equations!.map((row) => {
      const r = new Map<number, number>();
      for (const [d, c] of row) if (!model.prescribed.has(d)) r.set(d, (r.get(d) ?? 0) + c);
      return r;
    });
    const dofs = [...new Set(rows.flatMap((r) => [...r.keys()]))];
    const A = rows.map((r) => dofs.map((d) => r.get(d) ?? 0));
    let rank = 0;
    for (let col = 0; col < dofs.length && rank < A.length; col++) {
      let pivot = rank;
      for (let i = rank; i < A.length; i++)
        if (Math.abs(A[i]![col]!) > Math.abs(A[pivot]![col]!)) pivot = i;
      if (Math.abs(A[pivot]![col]!) < 1e-9) continue;
      [A[rank], A[pivot]] = [A[pivot]!, A[rank]!];
      for (let i = 0; i < A.length; i++)
        if (i !== rank) {
          const f = A[i]![col]! / A[rank]![col]!;
          for (let j = col; j < dofs.length; j++) A[i]![j]! -= f * A[rank]![j]!;
        }
      rank++;
    }
    expect(x.creases.node.length).toBe(2);
    expect(rank).toBe(rows.length);
  });

  it.skipIf(!hasCcx)(
    'a strip folded by 90° and loaded across its raised end, as the browser',
    () => {
      const mesh = folded(90);
      const input: ShellInput = {
        mesh,
        material: steel,
        loads: [{ kind: 'edge-force', edges: [1], force: [1, 0, 0] }],
        constraints: [{ faces: [], edges: [3], displacement: zero, rotation: zero }],
        solver,
      };
      const host = onHost(input);
      const mine = solveShell(input);
      const tip = 2 * 21 + 20,
        fold = 2 * 21 + 10;
      // Without the tie about the fold it would be a hinge (no solution). Measured 0.993 (1.045
      // before the fold's mid-edge nodes were tied too, Codex on #962).
      expect(Math.abs(host.displacement[6 * tip]! / mine.displacement[6 * tip]! - 1)).toBeLessThan(
        0.03,
      );
      // The fold's rotation about y from both sides' copies.
      expect(
        Math.abs(host.displacement[6 * fold + 4]! / mine.displacement[6 * fold + 4]! - 1),
      ).toBeLessThan(0.05);
      const eq = shellEquilibriumCheck(host, 2e-5);
      expect(eq.pass, JSON.stringify(eq)).toBe(true);
      expect(host.reactionTotal[0]).toBeCloseTo(-1, 2);
    },
  );

  it.skipIf(!hasCcx)(
    'a 90° box section cantilever: bending and twist at its tip as the browser',
    () => {
      const mesh = box(4, 40);
      const x = expandShell(mesh);
      // The 4 corners of each of the 41 rings.
      expect(x.creases.node.length).toBe(4 * 41);
      const P = 16;
      const tipRing = Array.from({ length: P }, (_, i) => 40 * P + i);
      const clamp: ShellConstraint[] = [
        { faces: [], edges: [0], displacement: zero, rotation: zero },
      ];
      const bend: ShellInput = {
        mesh,
        material: steel,
        loads: [{ kind: 'edge-force', edges: [1], force: [0, 0, 10] }],
        constraints: clamp,
        solver,
      };
      const hb = onHost(bend);
      const mb = solveShell(bend);
      const mean = (r: ShellResult, d: number) =>
        tipRing.reduce((s, p) => s + r.displacement[6 * p + d]!, 0) / P;
      // Euler–Bernoulli: F L³ / (3 E I), I = 2 · 20³ / 12 + 2 · 20 · 10² = 5333 mm⁴.
      const euler = (10 * 200 ** 3) / (3 * 210_000 * (16_000 / 3));
      expect(mean(mb, 2) / euler).toBeGreaterThan(0.95);
      // Measured 1.010 (with one mitred normal per corner node, as before CR4f: 1.11).
      expect(Math.abs(mean(hb, 2) / mean(mb, 2) - 1)).toBeLessThan(0.05);
      expect(shellEquilibriumCheck(hb, 2e-5).pass).toBe(true);
      // A couple about x at the tip: ±z forces on the walls at y = ±10.
      const twist: ShellInput = {
        mesh,
        material: steel,
        loads: [],
        constraints: clamp,
        solver,
      };
      const prepared = prepareShell(twist);
      const preparedTwist = {
        ...prepared,
        force: Float64Array.from(prepared.force),
      };
      for (const p of tipRing) {
        const y = mesh.nodes[3 * p + 1]!;
        if (Math.abs(Math.abs(y) - 10) < 1e-9 && Math.abs(mesh.nodes[3 * p + 2]!) < 10 - 1e-9)
          preparedTwist.force[6 * p + 2] = y > 0 ? 1 : -1;
      }
      const ht = onHostPrepared(twist, preparedTwist);
      const turn = (r: ShellResult) =>
        tipRing.reduce((s, p) => {
          const [y, z] = [mesh.nodes[3 * p + 1]!, mesh.nodes[3 * p + 2]!];
          const [v, w] = [r.displacement[6 * p + 1]!, r.displacement[6 * p + 2]!];
          return s + (y * w - z * v) / (y * y + z * z);
        }, 0) / P;
      // Bredt: T L / (G J), J = 4 A² t / s = 4 · 400² / 80 = 8000 mm⁴; T = 3 · 2 · 10 N·mm.
      const bredt = (60 * 200) / ((210_000 / 2.6) * 8000);
      // Measured 0.999 (1.047 before the mid-edge ties).
      expect(Math.abs(turn(ht) / bredt - 1)).toBeLessThan(0.03);
      expect(shellEquilibriumCheck(ht, 2e-5).pass).toBe(true);
    },
  );
});
