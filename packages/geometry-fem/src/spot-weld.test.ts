import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bondedHostModel,
  bondedResultFromFrd,
  ElasticError,
  readCalculixFrd,
  solveBonded,
  solveShell,
  spotWeldNodes,
  writeCalculixModel,
  type Bond,
  type BondedInput,
  type BondedPart,
  type BondedResult,
  type ShellConstraint,
  type ShellMesh,
} from './index';

/**
 * FX-CR2 (ST-268, docs/cad/car-design.md CR5b): a hat section and its closure plate, a box beam
 * 1000 mm long, clamped at x = 0 and twisted at x = 1000 through a rigid end (every end node turned
 * by θ about the x axis, a rigid end plate). The flanges joined by spot welds (`spotWeldNodes` →
 * `BondSide.nodes`) at a pitch of 10, 20 and 40 mm against the flanges bonded over their whole
 * face, and the hat alone (an open section). TS-1558 the browser, TS-1559 the Host.
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-10, maxIterations: 200_000 };
const close = (a: number, b: number, relative: number) =>
  expect(Math.abs(a / b - 1), `${a} for ${b}`).toBeLessThan(relative);
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

const L = 1000,
  h = 5, // element size along x (mm)
  hp = 10; // and around the profile
const T = 1; // sheet thickness (mm)
const theta = 1e-3; // rad at x = L
/** The twist's axis: y = 0, z = zc (about the box's middle). */
const zc = 20;

/**
 * A profile (y, z points, a face tag per segment, pieces of about `hp`) swept along x over [0, L]
 * at `h`: shape edge 0
 * is the chain at x = 0, edges 1… each single node at x = L (to give each its own displacement).
 */
function sweep(profile: [number, number][], tags: number[], faces: number): ShellMesh {
  // Split each segment into pieces of about h.
  const pts: [number, number][] = [profile[0]!];
  const segTag: number[] = [];
  for (let s = 0; s + 1 < profile.length; s++) {
    const [a, b] = [profile[s]!, profile[s + 1]!];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / hp));
    for (let k = 1; k <= n; k++) {
      pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      segTag.push(tags[s]!);
    }
  }
  const nx = Math.round(L / h);
  const np = pts.length;
  const nodes: number[] = [];
  for (let j = 0; j <= nx; j++) for (const [y, z] of pts) nodes.push((L * j) / nx, y, z);
  const id = (i: number, j: number) => j * np + i;
  const tris: number[] = [];
  const tagOf: number[] = [];
  for (let j = 0; j < nx; j++)
    for (let i = 0; i + 1 < np; i++) {
      const [a, b, c, d] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
      if ((i + j) % 2) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
      tagOf.push(segTag[i]!, segTag[i]!);
    }
  const chains = [
    Array.from({ length: np }, (_, i) => id(i, 0)),
    ...Array.from({ length: np }, (_, i) => [id(i, nx)]),
  ];
  const offsets = [0];
  for (const c of chains) offsets.push(offsets.at(-1)! + c.length);
  return {
    nodes: Float64Array.from(nodes),
    triangles: Uint32Array.from(tris),
    thickness: new Float64Array(tris.length / 3).fill(T),
    faces: Int32Array.from(tagOf),
    shapeFaces: faces,
    shapeEdges: chains.length,
    edges: { offsets: Uint32Array.from(offsets), nodes: Uint32Array.from(chains.flat()) },
  };
}

// The hat: flanges (faces 0, 4) at z = 0 over |y| in [25, 45], webs (1, 3) at |y| = 25 up to 40,
// the top (2) at z = 40. The closure at z = −T: its flange strips (faces 0, 2) under the hat's.
const hat = sweep(
  [
    [-45, 0],
    [-25, 0],
    [-25, 40],
    [25, 40],
    [25, 0],
    [45, 0],
  ],
  [0, 1, 2, 3, 4],
  5,
);
const closure = sweep(
  [
    [-45, -T],
    [-25, -T],
    [25, -T],
    [45, -T],
  ],
  [0, 1, 2],
  3,
);

/**
 * Clamped at x = 0; each node at x = L turned by θ about the axis with the end (a rigid end plate:
 * the Host holds a shell node's rotations only with all its translations).
 */
function twisted(mesh: ShellMesh): ShellConstraint[] {
  const out: ShellConstraint[] = [
    { faces: [], edges: [0], displacement: [0, 0, 0], rotation: [0, 0, 0] },
  ];
  for (let k = 1; k < mesh.shapeEdges; k++) {
    const p = mesh.edges.nodes[mesh.edges.offsets[k]!]!;
    const y = mesh.nodes[3 * p + 1]!,
      z = mesh.nodes[3 * p + 2]!;
    out.push({
      faces: [],
      edges: [k],
      displacement: [0, -theta * (z - zc), theta * y],
      rotation: [theta, 0, 0],
    });
  }
  return out;
}
const part = (mesh: ShellMesh): BondedPart => ({
  kind: 'shell',
  mesh,
  material: steel,
  loads: [],
  constraints: twisted(mesh),
});

/** The torque the x = L nodes take (N·mm) per radian: Σ (y R_z − (z − zc) R_y + M_x) / θ. */
function stiffness(meshes: ShellMesh[], reactions: Float64Array[]): number {
  let torque = 0;
  meshes.forEach((m, i) => {
    const R = reactions[i]!;
    for (let k = 1; k < m.shapeEdges; k++) {
      const p = m.edges.nodes[m.edges.offsets[k]!]!;
      const y = m.nodes[3 * p + 1]!,
        z = m.nodes[3 * p + 2]!;
      torque += y * R[6 * p + 2]! - (z - zc) * R[6 * p + 1]! + R[6 * p + 3]!;
    }
  });
  return torque / theta;
}

/** Weld points on both flanges' centre lines (|y| = 35, z = 0), 10 mm from the ends. */
function weldPoints(pitch: number, y: number): number[] {
  const out: number[] = [];
  for (let x = 10; x <= L - 10 + 1e-9; x += pitch) out.push(x, y, 0);
  return out;
}
/** The weld rows as bonds: hat flange nodes near the points follow the closure's strips. */
function welds(pitch: number): Bond[] {
  return [
    [0, -35, 0],
    [4, 35, 2],
  ].map(([hatFace, y, closureFace]) => {
    const tied = spotWeldNodes({ kind: 'shell', mesh: hat }, [hatFace!], weldPoints(pitch, y!), 3);
    return {
      follower: { part: 0, faces: [hatFace!], edges: [], nodes: tied.nodes },
      on: { part: 1, faces: [closureFace!], edges: [] },
      tolerance: 1.5 * T,
    };
  });
}
const faceBonds: Bond[] = [
  [0, 0],
  [4, 2],
].map(([a, b]) => ({
  follower: { part: 0, faces: [a!], edges: [] },
  on: { part: 1, faces: [b!], edges: [] },
  tolerance: 1.5 * T,
}));
const box = (bonds: Bond[]): BondedInput => ({ parts: [part(hat), part(closure)], bonds, solver });
const boxStiffness = (r: BondedResult) =>
  stiffness(
    [hat, closure],
    r.parts.map((p) => p.reaction),
  );

describe('FX-CR2: spot welds in the browser (CR5b, TS-1558)', { timeout: 600_000 }, () => {
  it('ties the flange nodes within the radius, or the nearest face’s where none is that near', () => {
    const near = spotWeldNodes({ kind: 'shell', mesh: hat }, [0], weldPoints(10, -35), 3);
    // One grid node at each point (points on the grid).
    expect(near.points.every((p) => p.nodes === 1 && !p.fallback)).toBe(true);
    expect(near.nodes).toHaveLength(weldPoints(10, -35).length / 3);
    // Between the grid nodes (x = 12.5): no node within 1 mm, the triangle's three.
    const between = spotWeldNodes({ kind: 'shell', mesh: hat }, [0], [12.5, -32.5, 0], 1);
    expect(between.points).toEqual([{ nodes: 3, fallback: true }]);
    expect(refusal(() => spotWeldNodes({ kind: 'shell', mesh: hat }, [0], [10, -35, 0], 0))).toBe(
      'bond-gap',
    );
    expect(refusal(() => spotWeldNodes({ kind: 'shell', mesh: hat }, [9], [10, -35, 0], 3))).toBe(
      'target-index',
    );
    expect(refusal(() => spotWeldNodes({ kind: 'shell', mesh: hat }, [0], [], 3))).toBe(
      'empty-target',
    );
  });

  it('a finer pitch nears the seam welded box; the open hat is far softer', () => {
    // The limit of a finer pitch: every node of the weld line tied (a seam, pitch = h).
    const seam = boxStiffness(solveBonded(box(welds(h))));
    const bonded = boxStiffness(solveBonded(box(faceBonds)));
    const byPitch = [40, 20, 10].map((p) => {
      const r = solveBonded(box(welds(p)));
      expect(r.bonds.map((b) => b.nodes)).toEqual([
        weldPoints(p, -35).length / 3,
        weldPoints(p, 35).length / 3,
      ]);
      return boxStiffness(r);
    });
    // Finer is stiffer, never stiffer than the seam, and the seam never stiffer than the flanges
    // bonded over their whole width (which also makes each flange pair one thick plate).
    expect(byPitch[0]!).toBeLessThan(byPitch[1]!);
    expect(byPitch[1]!).toBeLessThan(byPitch[2]!);
    expect(byPitch[2]!).toBeLessThanOrEqual(seam * (1 + 1e-6));
    expect(seam).toBeLessThanOrEqual(bonded * (1 + 1e-6));
    close(byPitch[2]!, seam, 0.05);
    // The hat alone, an open section.
    const open = solveShell({
      mesh: hat,
      material: steel,
      loads: [],
      constraints: twisted(hat),
      solver,
    });
    const openStiffness = stiffness([hat], [open.reaction]);
    expect(openStiffness).toBeLessThan(byPitch[0]! / 10);
  });
});

const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-weld-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 600_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, 'job.frd'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasCcx)('FX-CR2 on the Host (CR5b, TS-1559)', { timeout: 900_000 }, () => {
  it('the welded box at a 20 mm pitch as the browser, its welds as equations', () => {
    const input = box(welds(20));
    const host = bondedHostModel(input);
    expect(host.model.equations!.length).toBeGreaterThan(0);
    const frd = readCalculixFrd(
      runCcx(writeCalculixModel(host.model)),
      host.model.nodes.length / 3,
    );
    const r = bondedResultFromFrd(input, host, frd);
    const mine = solveBonded(input);
    // Wedges against the browser's DKT shells (the R3j-5 checks allow a few per cent).
    close(boxStiffness(r), boxStiffness(mine), 0.05);
    expect(r.bonds).toEqual(mine.bonds);
  });
});
