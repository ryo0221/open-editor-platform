import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bondedHostModel,
  bondedResultFromFrd,
  boxTetMesh,
  readCalculixFrd,
  solveBonded,
  writeCalculixModel,
  type BondedInput,
  type BondedResult,
  type FemMesh,
  type ShellMesh,
} from './index';

/**
 * TS-1459 (ST-234#1): bonded bodies on the reference Host (R3j-5b): the FX8 models with their
 * bonds as `*EQUATION`s on the wedge and tet nodes, solved by CalculiX, against the browser's
 * elimination (`solveBonded`).
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 100_000 };
const zero: [number, number, number] = [0, 0, 0];
const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-bonded-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, 'job.frd'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const onHost = (input: BondedInput) => {
  const host = bondedHostModel(input);
  const frd = readCalculixFrd(runCcx(writeCalculixModel(host.model)), host.model.nodes.length / 3);
  return bondedResultFromFrd(input, host, frd);
};
/** The run's equilibrium check (run-bonded.ts) at the Host's 6-digit tolerance. */
const balanced = (r: BondedResult, relative = 2e-5) => {
  const force = Math.hypot(...r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!));
  const moment = Math.hypot(...r.appliedMoment.map((x, i) => x + r.reactionMoment[i]!));
  const scale = Math.max(Math.hypot(...r.appliedTotal), r.forceScale ?? 0);
  return { pass: force <= relative * scale && moment <= relative * r.momentScale, force, moment };
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

describe.skipIf(!hasCcx)('bonded bodies on the Host (R3j-5b, FX8)', () => {
  it('FX8a: two plates bonded along non-matching edges deflect as the whole plate on the Host', () => {
    const q = 0.01;
    const load = [{ kind: 'pressure' as const, faces: [0], pressure: -q }];
    const whole: BondedInput = {
      parts: [
        {
          kind: 'shell',
          mesh: grid(32, 32, [0, 100], [0, 100], 1),
          material: steel,
          loads: load,
          constraints: clampEdges([0, 1, 2, 3]),
        },
      ],
      bonds: [],
      solver,
    };
    const left = grid(16, 32, [0, 50], [0, 100], 1);
    const right = grid(15, 27, [50, 100], [0, 100], 1);
    const cut: BondedInput = {
      parts: [
        {
          kind: 'shell',
          mesh: left,
          material: steel,
          loads: load,
          constraints: clampEdges([0, 2, 3]),
        },
        {
          kind: 'shell',
          mesh: right,
          material: steel,
          loads: load,
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
      solver,
    };
    const one = onHost(whole);
    const two = onHost(cut);
    const browser = solveBonded(cut);
    const centre = (r: BondedResult, mesh: ShellMesh) =>
      r.parts[0]!.displacement[6 * nodeAt(mesh.nodes, [50, 50, 0]) + 2]!;
    const expected = centre(one, whole.parts[0]!.mesh as ShellMesh);
    expect(Math.abs(centre(two, left) / expected - 1)).toBeLessThan(0.01);
    expect(Math.abs(centre(two, left) / centre(browser, left) - 1)).toBeLessThan(0.02);
    expect(two.bonds).toEqual(browser.bonds);
    expect(two.preconditioner).toBe('direct');
    const eq = balanced(two);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
    expect(Math.hypot(...two.reactionTotal) / (q * 100 * 100)).toBeCloseTo(1, 4);
  }, 300_000);

  it('FX8b: a cantilever cut along non-matching faces bends on the Host as in the browser', () => {
    const left = boxTetMesh({ size: [100, 20, 20], divisions: [10, 2, 2], type: 'tet10' });
    const right = shifted(
      boxTetMesh({ size: [100, 20, 20], divisions: [7, 3, 3], type: 'tet10' }),
      100,
    );
    const input: BondedInput = {
      parts: [
        {
          kind: 'solid',
          mesh: left,
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'solid',
          mesh: right,
          material: steel,
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
    };
    const host = onHost(input);
    const browser = solveBonded(input);
    const tip = (r: BondedResult) =>
      r.parts[1]!.displacement[3 * nodeAt(right.nodes, [200, 10, 10]) + 2]!;
    expect(Math.abs(tip(host) / tip(browser) - 1)).toBeLessThan(2e-3);
    const eq = balanced(host);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
    expect(host.reactionTotal[2]).toBeCloseTo(1000, 1);
  }, 300_000);

  it('FX8c: a shell plate bonded by its edge to a solid block bends on the Host as in the browser', () => {
    const block = boxTetMesh({ size: [20, 50, 20], divisions: [4, 10, 4], type: 'tet10' });
    const nodes = block.nodes.slice();
    for (let p = 0; p < nodes.length / 3; p++) {
      nodes[3 * p]! -= 20;
      nodes[3 * p + 2]! -= 10;
    }
    const plate = grid(40, 10, [0, 200], [0, 50], 2);
    const input: BondedInput = {
      parts: [
        {
          kind: 'solid',
          mesh: { ...block, nodes },
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'shell',
          mesh: plate,
          material: steel,
          loads: [{ kind: 'edge-force', edges: [1], force: [0, 0, -10] }],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-6,
        },
      ],
      solver,
    };
    const host = onHost(input);
    const browser = solveBonded(input);
    const tip = (r: BondedResult) =>
      r.parts[1]!.displacement[6 * nodeAt(plate.nodes, [200, 25, 0]) + 2]!;
    expect(Math.abs(tip(host) / tip(browser) - 1)).toBeLessThan(0.03);
    const eq = balanced(host);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
    expect(host.reactionTotal[2]).toBeCloseTo(10, 2);
  }, 300_000);

  it('a shell skin glued flat on a bending block turns with it on the Host as in the browser (#890)', () => {
    const block = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
    const skin = grid(40, 4, [0, 200], [0, 20], 1);
    const nodes = skin.nodes.slice();
    for (let p = 0; p < nodes.length / 3; p++) nodes[3 * p + 2] = 20.5;
    const input: BondedInput = {
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
    };
    const host = onHost(input);
    const browser = solveBonded(input);
    const at = (r: BondedResult, x: number, i: number) =>
      r.parts[1]!.displacement[6 * nodeAt(nodes, [x, 10, 20.5]) + i]!;
    for (const x of [100, 200]) {
      expect(Math.abs(at(host, x, 2) / at(browser, x, 2) - 1)).toBeLessThan(0.03);
      expect(Math.abs(at(host, x, 4) / at(browser, x, 4) - 1)).toBeLessThan(0.03);
    }
    const eq = balanced(host);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
    // The skin as two faces, each bonded on its own: the nodes on their seam keep their skin side
    // (only the layer toward the block is tied), so the model has the same equations.
    const faces = new Int32Array(skin.triangles.length / 3);
    for (let e = 0; e < faces.length; e++)
      faces[e] =
        nodes[3 * skin.triangles[3 * e]!]! +
          nodes[3 * skin.triangles[3 * e + 1]!]! +
          nodes[3 * skin.triangles[3 * e + 2]!]! <
        300
          ? 0
          : 1;
    const split: BondedInput = {
      ...input,
      parts: [
        input.parts[0]!,
        {
          ...input.parts[1]!,
          mesh: { ...skin, nodes, faces, shapeFaces: 2 },
        } as BondedInput['parts'][number],
      ],
      bonds: [0, 1].map((f) => ({
        follower: { part: 1, faces: [f], edges: [] },
        on: { part: 0, faces: [5], edges: [] },
        tolerance: 1e-3,
      })),
    };
    expect(bondedHostModel(split).model.equations!.length).toBe(
      bondedHostModel(input).model.equations!.length,
    );
  }, 300_000);

  it('a skin on part of a block ties only the nodes on it, in the browser and on the Host (CR5f)', () => {
    // TS-1583, ST-274: the #890 block with a skin from x = −100 to 200: its 100 mm beyond the
    // block lies on nothing. As a bond every node must lie on the block (bond-gap); as a contact
    // only the 105 nodes over it (x 0–200) follow it, the Host as those nodes alone.
    const block = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
    const skin = grid(30, 4, [-100, 200], [0, 20], 1);
    const nodes = skin.nodes.slice();
    for (let p = 0; p < nodes.length / 3; p++) nodes[3 * p + 2] = 20.5;
    const input = (contact: boolean, only?: number[]): BondedInput => ({
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
          follower: { part: 1, faces: [0], edges: [], ...(only ? { nodes: only } : {}) },
          on: { part: 0, faces: [5], edges: [] },
          tolerance: 1e-3,
          ...(contact ? { contact: true } : {}),
        },
      ],
      solver,
    });
    expect(() => solveBonded(input(false))).toThrow(/bond 0: shell node \d+ is/);
    const browser = solveBonded(input(true));
    expect(browser.converged).toBe(true);
    expect(browser.bonds[0]!.nodes).toBe(105);
    const over: number[] = [];
    for (let p = 0; p < nodes.length / 3; p++) if (nodes[3 * p]! > -1e-9) over.push(p);
    expect(over).toHaveLength(105);
    expect(bondedHostModel(input(true)).model.equations!.length).toBe(
      bondedHostModel(input(false, over)).model.equations!.length,
    );
    // Codex on #1022: a contact of chosen nodes ties, on the Host too, only those over the block.
    const every = Array.from({ length: nodes.length / 3 }, (_, p) => p);
    expect(solveBonded(input(true, every)).bonds[0]!.nodes).toBe(105);
    expect(bondedHostModel(input(true, every)).model.equations!.length).toBe(
      bondedHostModel(input(true)).model.equations!.length,
    );
    const host = onHost(input(true));
    const at = (r: BondedResult, x: number, i: number) =>
      r.parts[1]!.displacement[6 * nodeAt(nodes, [x, 10, 20.5]) + i]!;
    for (const x of [100, 200])
      expect(Math.abs(at(host, x, 2) / at(browser, x, 2) - 1)).toBeLessThan(0.03);
    const eq = balanced(host);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
    // Codex on #1022: a contact whose nodes lie on the block but are all held ties nothing, as a
    // bond would, and is no gap.
    const held = input(true);
    held.parts[1] = {
      ...held.parts[1]!,
      constraints: [{ faces: [0], edges: [], displacement: zero, rotation: zero }],
    } as BondedInput['parts'][number];
    expect(solveBonded(held).bonds[0]!.nodes).toBe(0);
    // Codex on #1022: a contact whose nodes already follow the block by an earlier bond lies on
    // it: nothing more is tied, and it is no gap.
    const twice = input(false, over);
    twice.bonds.push({
      ...twice.bonds[0]!,
      follower: { part: 1, faces: [0], edges: [] },
      contact: true,
    });
    expect(solveBonded(twice).bonds.map((b) => b.nodes)).toEqual([105, 0]);
    // A contact none of whose nodes lies on the block is refused.
    const away = nodes.slice();
    for (let p = 0; p < away.length / 3; p++) away[3 * p + 2] = 30;
    const lifted = input(true);
    lifted.parts[1] = {
      ...lifted.parts[1]!,
      mesh: { ...skin, nodes: away },
    } as BondedInput['parts'][number];
    expect(() => solveBonded(lifted)).toThrow(/no node of the contact lies within/);
  }, 300_000);

  it('an L of two plates bonded at a right angle passes bending through the corner as in the browser', () => {
    // A plate in z = 0 clamped at x = 0, and a plate hanging down from its edge x = 100.
    const top = grid(20, 10, [0, 100], [0, 50], 1.5);
    const flat = grid(10, 8, [0, 50], [0, 50], 1);
    const hang = new Float64Array(flat.nodes.length);
    for (let q = 0; q < flat.nodes.length / 3; q++) {
      hang[3 * q] = 100;
      hang[3 * q + 1] = flat.nodes[3 * q + 1]!;
      hang[3 * q + 2] = -flat.nodes[3 * q]!;
    }
    const wall = { ...flat, nodes: hang };
    const input: BondedInput = {
      parts: [
        { kind: 'shell', mesh: top, material: steel, loads: [], constraints: clampEdges([3]) },
        {
          kind: 'shell',
          mesh: wall,
          material: steel,
          // Along x at the bottom: it bends the wall, and the top plate through the corner.
          loads: [{ kind: 'edge-force', edges: [1], force: [2, 0, 0] }],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [], edges: [1] },
          tolerance: 1e-6,
        },
      ],
      solver,
    };
    const host = onHost(input);
    const browser = solveBonded(input);
    const foot = (r: BondedResult) => r.parts[1]!.displacement[6 * nodeAt(hang, [100, 25, -50])]!;
    const corner = (r: BondedResult) =>
      r.parts[0]!.displacement[6 * nodeAt(top.nodes, [100, 25, 0]) + 2]!;
    // Measured: foot 0.2549 and 0.2538 mm, corner 0.1624 and 0.1633 mm (the corner's moment,
    // 100 N·mm, bends the top plate: M L² / 2 E I = 0.169 mm).
    expect(Math.abs(foot(host) / foot(browser) - 1)).toBeLessThan(0.02);
    expect(Math.abs(corner(host) / corner(browser) - 1)).toBeLessThan(0.02);
    const eq = balanced(host);
    expect(eq.pass, JSON.stringify(eq)).toBe(true);
  }, 300_000);
});

describe('a creased follower on the Host (CR4f)', () => {
  it('ties only the bonded face’s own side of a crease (Codex on #962)', () => {
    // Two triangles folded 90° along x = 0, y 0–10: face 0 in z = 0, face 1 in x = 0 below it,
    // and face 1 alone bonded to a plate in x = 0.
    const follower: ShellMesh = {
      nodes: Float64Array.from([0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, -10]),
      triangles: Uint32Array.from([0, 2, 1, 0, 1, 3]),
      thickness: new Float64Array(2).fill(1),
      faces: Int32Array.from([0, 1]),
      shapeFaces: 2,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const flat = grid(4, 4, [-2, 12], [-2, 12], 1);
    const wall = new Float64Array(flat.nodes.length);
    for (let q = 0; q < flat.nodes.length / 3; q++) {
      wall[3 * q + 1] = flat.nodes[3 * q + 1]!;
      wall[3 * q + 2] = -flat.nodes[3 * q]!;
    }
    const input: BondedInput = {
      parts: [
        {
          kind: 'shell',
          mesh: { ...flat, nodes: wall },
          material: steel,
          loads: [],
          constraints: clampEdges([0]),
        },
        { kind: 'shell', mesh: follower, material: steel, loads: [], constraints: [] },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [1], edges: [] },
          on: { part: 0, faces: [0], edges: [] },
          tolerance: 1e-3,
        },
      ],
      solver,
    };
    const host = bondedHostModel(input);
    const { base, expansion } = host.layout[1]!;
    const x = expansion!;
    // The crease's two sides (nodes 0–1), each with its own copies.
    const crease = [...Array(x.sides.ends.length / 2).keys()].filter(
      (k) =>
        Math.min(x.sides.ends[2 * k]!, x.sides.ends[2 * k + 1]!) === 0 &&
        Math.max(x.sides.ends[2 * k]!, x.sides.ends[2 * k + 1]!) === 1,
    );
    expect(crease).toHaveLength(2);
    const copiesOfTriangle = (e: number) => [0, 1, 2].map((k) => x.wedges[15 * e + k]! / 3);
    const owner = (k: number) =>
      [0, 1].find((e) =>
        [x.sides.copies[2 * k]!, x.sides.copies[2 * k + 1]!].every((c) =>
          copiesOfTriangle(e).includes(c),
        ),
      );
    /** The largest equation residual when the nodes `moved` go by `by`, the rest still. */
    const residual = (moved: Set<number>, by: number[]) =>
      Math.max(
        ...host.model.equations!.map((row) =>
          Math.abs(
            row.reduce(
              (sum, [d, c]) => sum + (moved.has(Math.floor(d / 3)) ? c * by[d % 3]! : 0),
              0,
            ),
          ),
        ),
      );
    // Face 1's crease side is bonded: moving both sides' mid-edge layers together (as the
    // crease ties keep them), the plate still, breaks an equation.
    const sideLayers = new Set(
      crease.flatMap((k) => [0, 1].map((l) => base + x.sides.layers[2 * k + l]!)),
    );
    for (const by of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
      expect(residual(sideLayers, by)).toBeGreaterThan(0.1);
    expect(crease.map(owner).sort()).toEqual([0, 1]);
    // And its corners by face 1's own copies: moving the middles of both copies of a crease
    // corner (nodes 0, 1) together, the plate still, breaks an equation (Codex on #962: face 1's
    // copies were eliminated by the crease ties, and the bond skipped them).
    const copiesOf = (p: number) => [
      p,
      ...[...x.creases.node.keys()].filter((j) => x.creases.node[j] === p).map((j) => 4 + j),
    ];
    for (const p of [0, 1]) {
      expect(copiesOf(p)).toHaveLength(2);
      const middles = new Set(copiesOf(p).map((c) => base + x.layers[3 * c + 1]!));
      for (const by of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ])
        expect(residual(middles, by)).toBeGreaterThan(0.5);
    }
  });

  it('bonds a crease copy once when two faces on one master share it (Codex on #962)', () => {
    // Faces 0 and 1 (z = 0) meet along the diagonal 1–2; face 2 folds 90° down along 0–1, so
    // nodes 0 and 1 are creased. Face 2's triangle comes first, so the copies faces 0 and 1
    // share at node 1 are the ones the crease equations eliminate. Faces 0 and 1 bonded to a
    // plate in z = 0 by separate bonds.
    const follower: ShellMesh = {
      nodes: Float64Array.from([0, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 0, 0, -10]),
      triangles: Uint32Array.from([0, 1, 4, 0, 2, 1, 1, 2, 3]),
      thickness: new Float64Array(3).fill(1),
      faces: Int32Array.from([2, 0, 1]),
      shapeFaces: 3,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const plate = grid(4, 4, [-2, 12], [-2, 12], 1);
    const parts: BondedInput['parts'] = [
      { kind: 'shell', mesh: plate, material: steel, loads: [], constraints: clampEdges([0]) },
      { kind: 'shell', mesh: follower, material: steel, loads: [], constraints: [] },
    ];
    const bond = (faces: number[]) => ({
      follower: { part: 1, faces, edges: [] },
      on: { part: 0, faces: [0], edges: [] },
      tolerance: 1e-3,
    });
    const rankOf = (host: ReturnType<typeof bondedHostModel>) => {
      // The equations with the held DOFs put in (they are known), as rows of a dense matrix.
      const rows = host.model.equations!.map((row) =>
        row.filter(([d]) => !host.model.prescribed.has(d)),
      );
      const cols = [...new Set(rows.flatMap((r) => r.map(([d]) => d)))];
      const at = new Map(cols.map((d, j) => [d, j]));
      const A = rows.map((r) => {
        const a = new Float64Array(cols.length);
        for (const [d, c] of r) a[at.get(d)!]! += c;
        return a;
      });
      let rank = 0;
      for (let col = 0; col < cols.length && rank < A.length; col++) {
        let pivot = rank;
        for (let i = rank; i < A.length; i++)
          if (Math.abs(A[i]![col]!) > Math.abs(A[pivot]![col]!)) pivot = i;
        if (Math.abs(A[pivot]![col]!) < 1e-9) continue;
        [A[rank], A[pivot]] = [A[pivot]!, A[rank]!];
        for (let i = 0; i < A.length; i++)
          if (i !== rank) {
            const f = A[i]![col]! / A[rank]![col]!;
            for (let j = col; j < cols.length; j++) A[i]![j]! -= f * A[rank]![j]!;
          }
        rank++;
      }
      return { equations: rows.length, rank };
    };
    const apart = rankOf(bondedHostModel({ parts, bonds: [bond([0]), bond([1])] }));
    const together = rankOf(bondedHostModel({ parts, bonds: [bond([0, 1])] }));
    expect(apart.rank).toBe(apart.equations);
    expect(together.rank).toBe(together.equations);
    expect(apart).toEqual(together);
  });

  it('passes a crease equation’s force through to the master only as the bond does (Codex on #962)', () => {
    // The two triangles of the first test, face 1 bonded to the plate in x = 0: a force along a
    // crease equation that a bond was put through (zero in sum) gives the master no reaction.
    const follower: ShellMesh = {
      nodes: Float64Array.from([0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, -10]),
      triangles: Uint32Array.from([0, 2, 1, 0, 1, 3]),
      thickness: new Float64Array(2).fill(1),
      faces: Int32Array.from([0, 1]),
      shapeFaces: 2,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const flat = grid(4, 4, [-2, 12], [-2, 12], 1);
    const wall = new Float64Array(flat.nodes.length);
    for (let q = 0; q < flat.nodes.length / 3; q++) {
      wall[3 * q + 1] = flat.nodes[3 * q + 1]!;
      wall[3 * q + 2] = -flat.nodes[3 * q]!;
    }
    const input: BondedInput = {
      parts: [
        {
          kind: 'shell',
          mesh: { ...flat, nodes: wall },
          material: steel,
          loads: [],
          constraints: clampEdges([0]),
        },
        { kind: 'shell', mesh: follower, material: steel, loads: [], constraints: [] },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [1], edges: [] },
          on: { part: 0, faces: [0], edges: [] },
          tolerance: 1e-3,
        },
      ],
      solver,
    };
    const host = bondedHostModel(input);
    const N = host.model.nodes.length / 3;
    const pivots = new Set(host.ties.keys());
    // The follower's own equations (before the bonds'), one of them through a bond's pivot.
    const { base, count } = host.layout[1]!;
    const inFollower = (d: number) => d >= 3 * base && d < 3 * (base + count);
    const through = host.model.equations!.find(
      (row) => row.every(([d]) => inFollower(d)) && row.slice(1).some(([d]) => pivots.has(d)),
    );
    expect(through).toBeDefined();
    const frd = {
      displacement: new Float64Array(3 * N),
      stress: new Float64Array(6 * N),
      force: Float64Array.from(host.model.force),
    };
    for (const [d, c] of through!) frd.force[d]! += c;
    const r = bondedResultFromFrd(input, host, frd);
    const master = r.parts[0]!;
    expect(Math.max(...master.reaction.map(Math.abs))).toBeLessThan(1e-9);
  });

  it('follows a creased master by its triangle’s own corner copies (Codex on #962)', () => {
    // A fan of 8 triangles about (0, 0, 0) with ring heights that crease it into several smooth
    // sides; triangle 4's centre copy is not the one whose normal is nearest its own.
    const hs = [-4, -7, 4, -3, 2, 4, 8, -2];
    const nodes = [0, 0, 0];
    for (let j = 0; j < 8; j++)
      nodes.push(10 * Math.cos((j * Math.PI) / 4), 10 * Math.sin((j * Math.PI) / 4), hs[j]!);
    const triangles: number[] = [];
    for (let j = 0; j < 8; j++) triangles.push(0, 1 + j, 1 + ((j + 1) % 8));
    const master: ShellMesh = {
      nodes: Float64Array.from(nodes),
      triangles: Uint32Array.from(triangles),
      thickness: new Float64Array(8).fill(1),
      faces: Int32Array.from([0, 0, 0, 0, 1, 0, 0, 0]),
      shapeFaces: 2,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    // A small triangle on triangle 4, shrunk to a fifth about its centroid.
    const corner = (c: number) => [0, 1, 2].map((i) => nodes[3 * triangles[12 + c]! + i]!);
    const mid = [0, 1, 2].map((i) => (corner(0)[i]! + corner(1)[i]! + corner(2)[i]!) / 3);
    const follower: ShellMesh = {
      nodes: Float64Array.from(
        [0, 1, 2].flatMap((c) => corner(c).map((v, i) => mid[i]! + (v - mid[i]!) / 5)),
      ),
      triangles: Uint32Array.from([0, 1, 2]),
      thickness: new Float64Array(1).fill(1),
      faces: new Int32Array(1),
      shapeFaces: 1,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const host = bondedHostModel({
      parts: [
        {
          kind: 'shell',
          mesh: master,
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero, rotation: zero }],
        },
        { kind: 'shell', mesh: follower, material: steel, loads: [], constraints: [] },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-3,
        },
      ],
    });
    const { base, expansion } = host.layout[0]!;
    const x = expansion!;
    const own = x.wedges[15 * 4]! / 3;
    const centre = [
      0,
      ...[...x.creases.node.keys()].filter((j) => x.creases.node[j] === 0).map((j) => 9 + j),
    ];
    expect(centre.length).toBeGreaterThan(1);
    const used = new Set([...host.ties.values()].flatMap((row) => row.map(([d]) => d)));
    const uses = (c: number) =>
      [0, 1, 2].some((l) => [0, 1, 2].some((i) => used.has(3 * (base + x.layers[3 * c + l]!) + i)));
    for (const c of centre) expect(uses(c)).toBe(c === own);
  });
});
