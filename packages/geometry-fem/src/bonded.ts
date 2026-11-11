import { lowestModes, modalSummary } from './modal';
import {
  ElasticError,
  addNodalMasses,
  assembleMass,
  assembleStiffness,
  boundaryFaceList,
  elasticStress,
  meshComponents,
  prepareElastic,
  type AddedMass,
  type ElasticConstraint,
  type ElasticLoad,
  type ElasticMaterial,
} from './elastic';
import { localFaces, nodesPerElement, tet10Edges, type FemMesh } from './fem';
import {
  assembleShellMass,
  assembleShellStiffness,
  prepareShell,
  shellComponents,
  shellFrame,
  shellFreeRigidModes,
  shellStress,
  type ShellConstraint,
  type ShellLoad,
  type ShellMesh,
  type ShellResult,
} from './shell';
import { CsrMatrix, incompleteFactor, pcg, type CsrPattern } from './sparse';
import type { CalculixEquation, CalculixModel, CalculixPart, FrdResult } from './calculix';
import {
  expandShell,
  expandShellStudy,
  shellCornerCopy,
  shellNodeCopies,
  shellResultFromFrd,
  type ShellExpansion,
} from './calculix-shell';
import { vonMisesOf, type ElasticPrepared } from './elastic';

/**
 * R3j-3 (docs/cad/r3-analysis.md, A4): bodies solved together, each a tet10 solid or a shell,
 * joined by bonds. A bond makes the nodes of one side (the dependent side) follow the other side:
 * each dependent DOF is a linear combination of DOFs of the other side's element under it (its
 * shape functions at the node's projection), and is eliminated, K' = Tᵀ K T, f' = Tᵀ f (A4-U3).
 * The meshes need not match. Units mm–N–MPa–t–s.
 *
 * - A shell node bonded to a shell follows all six DOFs of the triangle (or edge segment) under it.
 * - A solid node bonded to a solid follows the three translations of the boundary face under it
 *   (the 6-node face of a tet10, 3-node of a tet4).
 * - A shell node bonded to a solid face (a shell's edge on a solid) follows the two points t/2
 *   above and below it along the shell's normal, U⁺ and U⁻: u = (U⁺ + U⁻) / 2, and the rotation
 *   about the in-plane axes θ⊥ = n × (U⁺ − U⁻) / t. The rotation about n stays the shell's own.
 * - A solid face cannot follow a shell (`bond-kind`): make the shell the dependent side.
 */
export type BondedPart =
  | {
      kind: 'solid';
      mesh: FemMesh;
      material: ElasticMaterial;
      loads: ElasticLoad[];
      constraints: ElasticConstraint[];
      /** CR5a: added masses on this part's shape faces. */
      masses?: AddedMass[];
    }
  | {
      kind: 'shell';
      mesh: ShellMesh;
      material: ElasticMaterial;
      loads: ShellLoad[];
      constraints: ShellConstraint[];
      /** CR5a: added masses on this part's shape faces. */
      masses?: AddedMass[];
    };

/** The shape faces and edges of one part a bond side is on. */
export interface BondSide {
  part: number;
  faces: number[];
  edges: number[];
  /**
   * CR5b: on the dependent side only, the nodes that follow, in place of every node of `faces`
   * and `edges` (a spot weld's nodes around its points, `spotWeldNodes`).
   */
  nodes?: number[];
}
export interface Bond {
  /** The dependent side: each of its nodes follows `on`. */
  follower: BondSide;
  on: BondSide;
  /** The largest distance (mm) from a follower node to the side it follows. */
  tolerance: number;
  /**
   * CR5f: only the follower nodes within the tolerance of `on` follow it, the others are left
   * free (a mount sitting on part of a panel's face); at least one node must. Absent, every
   * follower node must lie within the tolerance (`bond-gap`).
   */
  contact?: boolean;
}

export interface BondedInput {
  parts: BondedPart[];
  bonds: Bond[];
  solver: { tolerance: number; maxIterations: number };
}

export type BondedPartResult =
  | {
      kind: 'solid';
      /** x, y, z per node (mm). */
      displacement: Float64Array;
      stress: Float64Array;
      vonMises: Float64Array;
      /** Reaction per node DOF at the held DOFs, 0 elsewhere (N). */
      reaction: Float64Array;
      loadChecks: { force: [number, number, number]; measure: number }[];
      constrainedNodes: number[];
    }
  | ({
      kind: 'shell';
      /** x, y, z, rx, ry, rz per node (mm, rad). */
      displacement: Float64Array;
      /** Reaction per node DOF at the held DOFs (N, N·mm). */
      reaction: Float64Array;
      loadChecks: { force: [number, number, number]; measure: number }[];
      constrainedNodes: number[];
    } & Pick<ShellResult, 'stress' | 'vonMises'>);

export interface BondedResult {
  parts: BondedPartResult[];
  /** Per bond: the follower nodes it ties (a node another bond already tied is not counted). */
  bonds: { nodes: number; maxGap: number }[];
  appliedTotal: [number, number, number];
  reactionTotal: [number, number, number];
  /** About the centre of all nodes (N·mm), and the node-by-node magnitude scale of the moments. */
  appliedMoment: [number, number, number];
  reactionMoment: [number, number, number];
  momentScale: number;
  /** DOFs solved (after the followers are eliminated). */
  dofs: number;
  /**
   * The preconditioner the last CG run used (`jacobi` after ILU(0) did not converge); `direct`
   * for a Host's direct solve (R3j-5b).
   */
  preconditioner: 'ilu' | 'jacobi' | 'direct';
  /**
   * R3j-5b: the summed force magnitudes a Host's reactions were added up from, when larger than
   * the reactions (the `.frd`'s 6 digits are relative to them); the equilibrium check's force
   * scale is then at least this.
   */
  forceScale?: number;
  iterations: number;
  residual: number;
  converged: boolean;
}

type Vec = [number, number, number];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const norm = (a: ArrayLike<number>) => Math.sqrt(dot(a, a));

/** CG iterations ILU(0) is given before Jacobi takes over. */
const iluIterations = 2000;

/** A combination of global DOFs: dof → coefficient. */
type Combination = Map<number, number>;
const addTo = (out: Combination, dof: number, c: number) => {
  if (c !== 0) out.set(dof, (out.get(dof) ?? 0) + c);
};

/** The point of triangle abc nearest p, and its barycentric coordinates (a, b, c). */
function nearestOnTriangle(p: Vec, a: Vec, b: Vec, c: Vec): { L: Vec; d: number } {
  // Ericson, Real-Time Collision Detection 5.1.5.
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const at = (L: Vec) => {
    const q = [0, 1, 2].map((i) => L[0] * a[i]! + L[1] * b[i]! + L[2] * c[i]!);
    return { L, d: norm(sub(p, q)) };
  };
  if (d1 <= 0 && d2 <= 0) return at([1, 0, 0]);
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at([0, 1, 0]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at([1 - v, v, 0]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at([0, 0, 1]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at([1 - w, 0, w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([0, 1 - w, w]);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  return at([1 - v - w, v, w]);
}

/** An element of the side followed: its nodes and their shape values at barycentric L. */
interface Target {
  corners: [Vec, Vec, Vec];
  /** A tet10 face's six nodes (corners, then mid-edges 01, 12, 20): its curved geometry. */
  quad?: Vec[];
  /** A tet10 edge's three nodes (ends, then middle): its curved geometry, L = (1 − s, s, 0). */
  edge3?: [Vec, Vec, Vec];
  /** A shell face's triangle (its corners in the mesh's order). */
  triangle?: number;
  /** Nodes and the shape values at L (3 corners; a tet10 face adds its 3 mid-edge nodes). */
  shape(L: Vec): { nodes: number[]; N: number[] };
}

const pointOf = (nodes: Float64Array, p: number): Vec => [
  nodes[3 * p]!,
  nodes[3 * p + 1]!,
  nodes[3 * p + 2]!,
];

/** The element pieces of one bond side to follow: triangles of faces, segments of edges. */
function targetsOf(part: BondedPart, side: BondSide): Target[] {
  const out: Target[] = [];
  const nodes = part.mesh.nodes;
  const segment = (a: number, b: number) => {
    const A = pointOf(nodes, a),
      B = pointOf(nodes, b);
    // A segment as a degenerate triangle: its third corner on the second, its weight joined to it.
    out.push({ corners: [A, B, B], shape: (L) => ({ nodes: [a, b], N: [L[0], L[1] + L[2]] }) });
  };
  // A tet10 edge's piece: its two ends and middle, with the quadratic shape values along it.
  const quadraticSegment = (a: number, m: number, b: number) => {
    const [A, M, B] = [pointOf(nodes, a), pointOf(nodes, m), pointOf(nodes, b)];
    out.push({
      corners: [A, B, B],
      edge3: [A, B, M],
      shape: (L) => {
        const t = L[1]! + L[2]!;
        return { nodes: [a, b, m], N: [(1 - t) * (1 - 2 * t), t * (2 * t - 1), 4 * t * (1 - t)] };
      },
    });
  };
  const edgeChain = (k: number) => {
    const { offsets, nodes: chain } = part.mesh.edges;
    if (!Number.isInteger(k) || k < 0 || k >= part.mesh.shapeEdges)
      throw new ElasticError('target-index', `edge ${k} is not in 0..${part.mesh.shapeEdges - 1}`);
    return [...chain.subarray(offsets[k]!, offsets[k + 1]!)];
  };
  if (part.kind === 'shell') {
    const m = part.mesh;
    for (const f of side.faces)
      if (!Number.isInteger(f) || f < 0 || f >= m.shapeFaces)
        throw new ElasticError('target-index', `face ${f} is not in 0..${m.shapeFaces - 1}`);
    const want = new Set(side.faces);
    for (let e = 0; e < m.triangles.length / 3; e++) {
      if (!want.has(m.faces[e]!)) continue;
      const t = [0, 1, 2].map((a) => m.triangles[3 * e + a]!);
      out.push({
        corners: [pointOf(nodes, t[0]!), pointOf(nodes, t[1]!), pointOf(nodes, t[2]!)],
        triangle: e,
        shape: (L) => ({ nodes: t, N: [...L] }),
      });
    }
  } else {
    const m = part.mesh;
    const npe = nodesPerElement(m.type);
    for (const { e, lf } of boundaryFaceList(m, side.faces)) {
      const el = m.elements.subarray(e * npe, (e + 1) * npe);
      const c = localFaces[lf]!.map((k) => el[k]!);
      // The mid-edge node of each face edge (corner k to corner k + 1), as tet10Edges numbers them.
      const mids =
        m.type === 'tet10'
          ? [0, 1, 2].map((k) => {
              const [a, b] = [localFaces[lf]![k]!, localFaces[lf]![(k + 1) % 3]!];
              const i = tet10Edges.findIndex(
                ([x, y]) => (x === a && y === b) || (x === b && y === a),
              );
              return el[4 + i]!;
            })
          : [];
      const corners: [Vec, Vec, Vec] = [
        pointOf(nodes, c[0]!),
        pointOf(nodes, c[1]!),
        pointOf(nodes, c[2]!),
      ];
      out.push({
        corners,
        ...(m.type === 'tet10'
          ? { quad: [...corners, ...mids.map((q) => pointOf(nodes, q))] }
          : {}),
        shape: (L) =>
          m.type === 'tet10'
            ? {
                nodes: [...c, ...mids],
                N: [
                  ...[0, 1, 2].map((k) => L[k]! * (2 * L[k]! - 1)),
                  ...[0, 1, 2].map((k) => 4 * L[k]! * L[(k + 1) % 3]!),
                ],
              }
            : { nodes: c, N: [...L] },
      });
    }
  }
  // A tet10 solid's edge chain runs end, middle, end, …: each three a quadratic piece.
  const quadratic = part.kind === 'solid' && part.mesh.type === 'tet10';
  for (const k of side.edges) {
    const chain = edgeChain(k);
    if (quadratic && chain.length % 2 === 1)
      for (let s = 0; s + 2 < chain.length; s += 2)
        quadraticSegment(chain[s]!, chain[s + 1]!, chain[s + 2]!);
    else for (let s = 0; s + 1 < chain.length; s++) segment(chain[s]!, chain[s + 1]!);
  }
  return out;
}

/** The nodes of one bond side, in node order. */
function nodesOf(part: BondedPart, side: BondSide): number[] {
  if (side.nodes) {
    const n = part.mesh.nodes.length / 3;
    for (const p of side.nodes)
      if (!Number.isInteger(p) || p < 0 || p >= n)
        throw new ElasticError('target-index', `node ${p} is not in 0..${n - 1}`);
    return [...new Set(side.nodes)].sort((a, b) => a - b);
  }
  const set = new Set<number>();
  if (part.kind === 'shell') {
    const m = part.mesh;
    for (const f of side.faces)
      if (!Number.isInteger(f) || f < 0 || f >= m.shapeFaces)
        throw new ElasticError('target-index', `face ${f} is not in 0..${m.shapeFaces - 1}`);
    const want = new Set(side.faces);
    for (let e = 0; e < m.triangles.length / 3; e++)
      if (want.has(m.faces[e]!)) for (let a = 0; a < 3; a++) set.add(m.triangles[3 * e + a]!);
  } else {
    const m = part.mesh;
    const npe = nodesPerElement(m.type);
    for (const { e, lf } of boundaryFaceList(m, side.faces)) {
      const el = m.elements.subarray(e * npe, (e + 1) * npe);
      const face = localFaces[lf]!;
      for (const k of face) set.add(el[k]!);
      if (m.type === 'tet10')
        tet10Edges.forEach(([a, b], i) => {
          if (face.includes(a) && face.includes(b)) set.add(el[4 + i]!);
        });
    }
  }
  for (const k of side.edges) {
    const { offsets, nodes } = part.mesh.edges;
    if (!Number.isInteger(k) || k < 0 || k >= part.mesh.shapeEdges)
      throw new ElasticError('target-index', `edge ${k} is not in 0..${part.mesh.shapeEdges - 1}`);
    for (const p of nodes.subarray(offsets[k]!, offsets[k + 1]!)) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

/** The barycentric coordinates of a tet10 face's six nodes (corners, mid-edges 01, 12, 20). */
const quadNodeL: Vec[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
];
/** The four flat triangles through a tet10 face's six nodes. */
const quadSubs = [
  [0, 3, 5],
  [3, 1, 4],
  [5, 4, 2],
  [3, 4, 5],
] as const;

/**
 * The point of a curved (tet10) face nearest p: the nearest of its four flat sub-triangles, then
 * Gauss-Newton on the quadratic map, kept on the triangle.
 */
function nearestOnQuadratic(p: Vec, X: Vec[]): { L: Vec; d: number } {
  const map = (xi: number, eta: number) => {
    const l0 = 1 - xi - eta;
    const N = [
      l0 * (2 * l0 - 1),
      xi * (2 * xi - 1),
      eta * (2 * eta - 1),
      4 * l0 * xi,
      4 * xi * eta,
      4 * eta * l0,
    ];
    const dXi = [-(4 * l0 - 1), 4 * xi - 1, 0, 4 * (l0 - xi), 4 * eta, -4 * eta];
    const dEta = [-(4 * l0 - 1), 0, 4 * eta - 1, -4 * xi, 4 * xi, 4 * (l0 - eta)];
    const x: Vec = [0, 0, 0],
      a: Vec = [0, 0, 0],
      b: Vec = [0, 0, 0];
    X.forEach((q, k) => {
      for (let i = 0; i < 3; i++) {
        x[i]! += N[k]! * q[i]!;
        a[i]! += dXi[k]! * q[i]!;
        b[i]! += dEta[k]! * q[i]!;
      }
    });
    return { x, a, b };
  };
  const clamp = (xi: number, eta: number): [number, number] => {
    xi = Math.max(0, xi);
    eta = Math.max(0, eta);
    const s = xi + eta;
    return s > 1 ? [xi / s, eta / s] : [xi, eta];
  };
  const distance = (xi: number, eta: number) => norm(sub(p, map(xi, eta).x));
  let best: [number, number] = [0, 0];
  let bestD = Infinity;
  for (const s of quadSubs) {
    const r = nearestOnTriangle(p, X[s[0]]!, X[s[1]]!, X[s[2]]!);
    const L = [0, 1, 2].map((i) =>
      s.reduce((sum: number, k, j) => sum + r.L[j]! * quadNodeL[k]![i]!, 0),
    );
    const d = distance(L[1]!, L[2]!);
    if (d < bestD) [best, bestD] = [[L[1]!, L[2]!], d];
  }
  let [xi, eta] = best;
  for (let it = 0; it < 12 && bestD > 0; it++) {
    const { x, a, b } = map(xi, eta);
    const r = sub(p, x);
    const [aa, ab, bb] = [dot(a, a), dot(a, b), dot(b, b)];
    const det = aa * bb - ab * ab;
    if (!(Math.abs(det) > 1e-30)) break;
    const [ra, rb] = [dot(a, r), dot(b, r)];
    [xi, eta] = clamp(xi + (bb * ra - ab * rb) / det, eta + (aa * rb - ab * ra) / det);
    const d = distance(xi, eta);
    if (d < bestD) [best, bestD] = [[xi, eta], d];
    else break;
  }
  return { L: [1 - best[0] - best[1], best[0], best[1]], d: bestD };
}

/** The point of a quadratic (tet10) edge A–M–B nearest p, as L = (1 − s, s, 0). */
function nearestOnQuadraticEdge(p: Vec, [A, B, M]: [Vec, Vec, Vec]): { L: Vec; d: number } {
  const map = (s: number) => {
    const N = [(1 - s) * (1 - 2 * s), s * (2 * s - 1), 4 * s * (1 - s)];
    const dN = [4 * s - 3, 4 * s - 1, 4 - 8 * s];
    const x: Vec = [0, 0, 0],
      a: Vec = [0, 0, 0];
    [A, B, M].forEach((q, k) => {
      for (let i = 0; i < 3; i++) {
        x[i]! += N[k]! * q[i]!;
        a[i]! += dN[k]! * q[i]!;
      }
    });
    return { x, a };
  };
  const distance = (s: number) => norm(sub(p, map(s).x));
  // The nearer of the two straight halves, then Gauss-Newton on the quadratic map, kept on it.
  const r0 = nearestOnTriangle(p, A, M, M),
    r1 = nearestOnTriangle(p, M, B, B);
  const starts = [0.5 * (r0.L[1] + r0.L[2]), 0.5 + 0.5 * (r1.L[1] + r1.L[2])];
  let best = starts[0]!,
    bestD = distance(best);
  const d1 = distance(starts[1]!);
  if (d1 < bestD) [best, bestD] = [starts[1]!, d1];
  let s = best;
  for (let it = 0; it < 12 && bestD > 0; it++) {
    const { x, a } = map(s);
    const aa = dot(a, a);
    if (!(aa > 1e-30)) break;
    s = Math.min(1, Math.max(0, s + dot(a, sub(p, x)) / aa));
    const d = distance(s);
    if (d < bestD) [best, bestD] = [s, d];
    else break;
  }
  return { L: [1 - best, best, 0], d: bestD };
}

/** The nearest point of a side's elements: the nodes and shape values there, and the distance. */
function follow(
  targets: Target[],
  p: Vec,
): { nodes: number[]; N: number[]; d: number; triangle?: number } {
  let best: { L: Vec; d: number; t: Target } | undefined;
  for (const t of targets) {
    const r = t.edge3
      ? nearestOnQuadraticEdge(p, t.edge3)
      : t.quad
        ? nearestOnQuadratic(p, t.quad)
        : nearestOnTriangle(p, ...t.corners);
    if (!best || r.d < best.d) best = { ...r, t };
  }
  if (!best) throw new ElasticError('empty-target', 'a bond follows no element');
  return {
    ...best.t.shape(best.L),
    d: best.d,
    ...(best.t.triangle !== undefined ? { triangle: best.t.triangle } : {}),
  };
}

/** The normal and thickness of a shell at a node: the area-weighted mean of its triangles. */
function shellNodeFrames(mesh: ShellMesh): { normal: Float64Array; thickness: Float64Array } {
  const n = mesh.nodes.length / 3;
  const normal = new Float64Array(3 * n);
  const thickness = new Float64Array(n);
  const area = new Float64Array(n);
  for (let e = 0; e < mesh.triangles.length / 3; e++) {
    const { nodes, R, area: A } = shellFrame(mesh, e);
    for (const p of nodes) {
      for (let i = 0; i < 3; i++) normal[3 * p + i]! += R[2]![i]! * A;
      thickness[p]! += mesh.thickness[e]! * A;
      area[p]! += A;
    }
  }
  for (let p = 0; p < n; p++) {
    const l = norm(normal.subarray(3 * p, 3 * p + 3));
    for (let i = 0; i < 3; i++) normal[3 * p + i] = l > 0 ? normal[3 * p + i]! / l : 0;
    thickness[p] = area[p]! > 0 ? thickness[p]! / area[p]! : 0;
  }
  return { normal, thickness };
}

/**
 * The bonded model's reduced system: each part's loads and constraints on the global DOFs, the
 * followers eliminated (T), the checks every bonded study needs before solving (the refusals of
 * `solveBonded`), and Tᵀ A T of any per-part matrix.
 */
/**
 * Refuses bonded pieces that can still move against each other (#890): a bond along an edge or at
 * a point ties the translations there but leaves a rotation about it free, which the check of each
 * connected group as one rigid body does not see. Each mesh piece gets its own six rigid motions;
 * the held DOFs and the bonds are constraints on them, and any motion left is a mechanism.
 */
function relativeMechanism(
  xyz: Float64Array,
  pieceOf: Int32Array,
  piecePart: readonly number[],
  follows: ReadonlyMap<number, Combination>,
  prescribed: ReadonlyMap<number, number>,
  nodeDof: (d: number) => { part: number; node: number; comp: number },
): void {
  const nodes = xyz.length / 3;
  // Each piece's own centre and size: one scale for the whole model leaves a small piece far from
  // the centre with nearly dependent translations and rotations.
  const pieces = piecePart.length;
  const lo = new Float64Array(3 * pieces).fill(Infinity);
  const hi = new Float64Array(3 * pieces).fill(-Infinity);
  for (let n = 0; n < nodes; n++)
    for (let k = 0; k < 3; k++) {
      const q = 3 * pieceOf[n]! + k;
      lo[q] = Math.min(lo[q]!, xyz[3 * n + k]!);
      hi[q] = Math.max(hi[q]!, xyz[3 * n + k]!);
    }
  const centre = new Float64Array(3 * pieces);
  const scale = new Float64Array(pieces);
  for (let q = 0; q < pieces; q++) {
    for (let k = 0; k < 3; k++) {
      centre[3 * q + k] = (lo[3 * q + k]! + hi[3 * q + k]!) / 2;
      scale[q] = Math.max(scale[q]!, hi[3 * q + k]! - lo[3 * q + k]!);
    }
    scale[q] ||= 1;
  }
  const size = 6 * piecePart.length;
  const G = new Float64Array(size * size);
  // The value of DOF `comp` of a node under its piece's rigid motion (t, w): u = t + w × r with
  // r = (x − c) / L, and a rotation θ = w / L (c and L the piece's centre and size).
  const add = (row: Map<number, number>, node: number, comp: number, factor: number) => {
    const piece = pieceOf[node]!;
    const col = 6 * piece;
    const L = scale[piece]!;
    const put = (j: number, v: number) => row.set(col + j, (row.get(col + j) ?? 0) + factor * v);
    if (comp >= 3) return put(comp, 1 / L);
    const r = [0, 1, 2].map((k) => (xyz[3 * node + k]! - centre[3 * piece + k]!) / L);
    put(comp, 1);
    const [a, b] = [(comp + 1) % 3, (comp + 2) % 3];
    // (w × r)_comp = w_a r_b − w_b r_a.
    put(3 + a, r[b]!);
    put(3 + b, -r[a]!);
  };
  const accumulate = (row: Map<number, number>) => {
    let norm = 0;
    for (const v of row.values()) norm += v * v;
    if (!(norm > 1e-24)) return;
    const entries = [...row];
    for (const [i, a] of entries) for (const [j, b] of entries) G[i * size + j]! += (a * b) / norm;
  };
  for (const d of prescribed.keys()) {
    const { node, comp } = nodeDof(d);
    const row = new Map<number, number>();
    add(row, node, comp, 1);
    accumulate(row);
  }
  for (const [d, combination] of follows) {
    const { node, comp } = nodeDof(d);
    const row = new Map<number, number>();
    add(row, node, comp, 1);
    for (const [q, w] of combination) {
      const m = nodeDof(q);
      add(row, m.node, m.comp, -w);
    }
    accumulate(row);
  }
  // Symmetric elimination with diagonal pivots: a pivot that vanishes is a free motion.
  const used = new Uint8Array(size);
  // Unit diagonal: a motion many rows hold does not hide one that few rows hold. A motion no row
  // touches is free outright.
  const d = new Float64Array(size);
  for (let i = 0; i < size; i++) d[i] = Math.sqrt(G[i * size + i]!);
  for (let i = 0; i < size; i++)
    for (let j = 0; j < size; j++)
      G[i * size + j] = d[i]! && d[j]! ? G[i * size + j]! / (d[i]! * d[j]!) : 0;
  const largest = 1;
  for (let k = 0; k < size; k++) {
    let p = -1;
    for (let i = 0; i < size; i++)
      if (!used[i] && (p < 0 || G[i * size + i]! > G[p * size + p]!)) p = i;
    const pivot = G[p * size + p]!;
    if (!(pivot > 1e-10 * largest)) {
      throw new ElasticError(
        'bond-mechanism',
        `bonded parts can still move against each other (a bond along an edge or at a point leaves a rotation about it free); bond a face or hold them`,
      );
    }
    used[p] = 1;
    for (let i = 0; i < size; i++) {
      if (used[i]) continue;
      const f = G[i * size + p]! / pivot;
      if (!f) continue;
      for (let j = 0; j < size; j++) if (!used[j]) G[i * size + j]! -= f * G[p * size + j]!;
    }
  }
}

function bondedSystem(input: Pick<BondedInput, 'parts' | 'bonds'>) {
  const { parts, bonds } = input;
  if (!parts.length) throw new ElasticError('empty-target', 'no part to solve');
  const per = parts.map((p) => (p.kind === 'shell' ? 6 : 3));
  const offset: number[] = [];
  let dofs = 0;
  parts.forEach((p, i) => {
    offset.push(dofs);
    dofs += per[i]! * (p.mesh.nodes.length / 3);
  });
  const dofOf = (part: number, node: number, i: number) => offset[part]! + per[part]! * node + i;

  // Each part's own loads and constraints, on the global DOFs.
  const prepared = parts.map((p) =>
    p.kind === 'shell'
      ? prepareShell(
          {
            mesh: p.mesh,
            material: p.material,
            loads: p.loads,
            constraints: p.constraints,
            masses: p.masses,
          },
          { bonded: true },
        )
      : prepareElastic(
          {
            mesh: p.mesh,
            material: p.material,
            loads: p.loads,
            constraints: p.constraints,
            masses: p.masses,
          },
          { bonded: true },
        ),
  );
  const f = new Float64Array(dofs);
  const prescribed = new Map<number, number>();
  prepared.forEach((pr, i) => {
    f.set(pr.force, offset[i]!);
    for (const [d, v] of pr.prescribed) prescribed.set(offset[i]! + d, v);
  });

  // The follower DOFs, each a combination of DOFs of the side it follows.
  const follows = new Map<number, Combination>();
  // The part each dependent node already follows: a node may follow only one part. Adjacent
  // follower faces on the same part share their edge nodes, which follow it once.
  const followedOn = new Map<string, { part: number; bond: number }>();
  const bondStats: BondedResult['bonds'] = [];
  // The skin side (±1, toward the solid) of each dependent shell node whose wall lies on it, by
  // `part:node`: a node shared by adjacent bonds on the same solid follows once, by the first.
  const skinSides = new Map<string, number>();
  for (const [bi, bond] of bonds.entries()) {
    const fp = parts[bond.follower.part];
    const op = parts[bond.on.part];
    if (!fp || !op)
      throw new ElasticError('target-index', `bond ${bi} names a part the model does not have`);
    if (fp.kind === 'solid' && op.kind === 'shell')
      throw new ElasticError(
        'bond-kind',
        `bond ${bi}: a solid face cannot follow a shell; make the shell the dependent side`,
      );
    if (!(bond.tolerance >= 0))
      throw new ElasticError('bond-gap', `bond ${bi}: the tolerance must be ≥ 0`);
    const targets = targetsOf(op, bond.on);
    if (!targets.length) throw new ElasticError('empty-target', `bond ${bi} follows no element`);
    const followers = nodesOf(fp, bond.follower);
    if (!followers.length)
      throw new ElasticError('empty-target', `bond ${bi} has no dependent node`);
    const frames =
      fp.kind === 'shell' && op.kind === 'solid' ? shellNodeFrames(fp.mesh) : undefined;
    let count = 0,
      maxGap = 0,
      lying = 0;
    const of = (
      target: { nodes: number[]; N: number[] },
      i: number,
      scale: number,
      out: Combination,
    ) =>
      target.nodes.forEach((q, a) => addTo(out, dofOf(bond.on.part, q, i), scale * target.N[a]!));
    for (const node of followers) {
      const earlier = followedOn.get(`${bond.follower.part}:${node}`);
      // Adjacent follower faces on the same part share their edge nodes: they follow it once.
      if (earlier?.part === bond.on.part) {
        // Codex on #1022: it lies on that part already, for a contact as for a bond.
        lying++;
        continue;
      }
      const p = pointOf(fp.mesh.nodes, node);
      const combos: [number, Combination][] = [];
      if (frames) {
        // A shell on a solid: on its edge, the points t/2 above and below follow the solid.
        const n: Vec = [
          frames.normal[3 * node]!,
          frames.normal[3 * node + 1]!,
          frames.normal[3 * node + 2]!,
        ];
        const h = frames.thickness[node]! / 2;
        if (!(h > 0) || !(norm(n) > 0.5))
          throw new ElasticError('bond-kind', `bond ${bi}: shell node ${node} has no normal`);
        const up = follow(targets, [p[0] + h * n[0], p[1] + h * n[1], p[2] + h * n[2]]);
        const down = follow(targets, [p[0] - h * n[0], p[1] - h * n[1], p[2] - h * n[2]]);
        const onSolid = (r: { nodes: number[]; N: number[] }): Vec => {
          const x: Vec = [0, 0, 0];
          r.nodes.forEach((q, a) => {
            for (let i = 0; i < 3; i++) x[i]! += r.N[a]! * op.mesh.nodes[3 * q + i]!;
          });
          return x;
        };
        // The wall flat on the solid's face (a skin): both points fall on one point of the face,
        // and U⁺ − U⁻ says nothing of the shell's rotation. Its face toward the solid follows it,
        // u + θ × (s h n) = U, and the shell's rotations are its own.
        const skin = norm(sub(onSolid(up), onSolid(down))) < h;
        const side = skin ? (up.d < down.d ? 1 : -1) : 0;
        const gap = skin ? Math.min(up.d, down.d) : Math.max(up.d, down.d);
        if (gap > bond.tolerance && bond.contact) continue;
        if (gap > bond.tolerance)
          throw new ElasticError(
            'bond-gap',
            `bond ${bi}: shell node ${node} is ${gap.toPrecision(3)} mm from the solid (tolerance ${bond.tolerance} mm)`,
          );
        maxGap = Math.max(maxGap, gap);
        lying++;
        if (skin) {
          skinSides.set(`${bond.follower.part}:${node}`, side);
          const contact = side > 0 ? up : down;
          for (let i = 0; i < 3; i++) {
            // u_i = U_i − s h (θ × n)_i, (θ × n)_i = θ_{i+1} n_{i+2} − θ_{i+2} n_{i+1}.
            const [a, b] = [(i + 1) % 3, (i + 2) % 3];
            const c: Combination = new Map();
            of(contact, i, 1, c);
            addTo(c, dofOf(bond.follower.part, node, 3 + a), -side * h * n[b]!);
            addTo(c, dofOf(bond.follower.part, node, 3 + b), side * h * n[a]!);
            combos.push([i, c]);
          }
        } else {
          // u = (U⁺ + U⁻) / 2.
          for (let i = 0; i < 3; i++) {
            const c: Combination = new Map();
            of(up, i, 0.5, c);
            of(down, i, 0.5, c);
            combos.push([i, c]);
          }
          // θ⊥ = n × d with d = (U⁺ − U⁻) / t; θ = θ⊥ + s n, s the shell's own rotation about n,
          // kept on the rotation component k with the largest |n_k|: θ_j = (n×d)_j + n_j/n_k (θ_k − (n×d)_k).
          const t = 2 * h;
          const nd = (j: number): Combination => {
            // (n × d)_j = n_{j+1} d_{j+2} − n_{j+2} d_{j+1}.
            const c: Combination = new Map();
            const [a, b] = [(j + 1) % 3, (j + 2) % 3];
            of(up, b, n[a]! / t, c);
            of(down, b, -n[a]! / t, c);
            of(up, a, -n[b]! / t, c);
            of(down, a, n[b]! / t, c);
            return c;
          };
          const k = [0, 1, 2].reduce(
            (best, i) => (Math.abs(n[i]!) > Math.abs(n[best]!) ? i : best),
            0,
          );
          const ndk = nd(k);
          for (const j of [0, 1, 2]) {
            if (j === k) continue;
            const c = nd(j);
            const r = n[j]! / n[k]!;
            addTo(c, dofOf(bond.follower.part, node, 3 + k), r);
            for (const [d, v] of ndk) addTo(c, d, -r * v);
            combos.push([3 + j, c]);
          }
        }
      } else {
        const at = follow(targets, p);
        if (at.d > bond.tolerance && bond.contact) continue;
        if (at.d > bond.tolerance)
          throw new ElasticError(
            'bond-gap',
            `bond ${bi}: node ${node} is ${at.d.toPrecision(3)} mm from the side it follows (tolerance ${bond.tolerance} mm)`,
          );
        maxGap = Math.max(maxGap, at.d);
        lying++;
        for (let i = 0; i < per[bond.follower.part]!; i++) {
          const c: Combination = new Map();
          of(at, i, 1, c);
          combos.push([i, c]);
        }
      }
      // A bond that ties none of the node's DOFs (all held) leaves it free to follow another part.
      const ties = combos.some(([i]) => !prescribed.has(dofOf(bond.follower.part, node, i)));
      if (!ties) continue;
      if (earlier)
        throw new ElasticError(
          'bond-overlap',
          `bonds ${earlier.bond} and ${bi} make node ${node} follow two parts; split the faces so each node follows one`,
        );
      let tied = false;
      for (const [i, c] of combos) {
        // A held DOF stays held: it follows nothing (a held seam's ends, a clamped edge).
        const d = dofOf(bond.follower.part, node, i);
        if (prescribed.has(d)) continue;
        follows.set(d, c);
        tied = true;
      }
      if (!tied) continue;
      // Only a node that ties a DOF follows a part (a held one, or a shell's held normal
      // rotation on a solid, ties nothing and can still be bonded elsewhere).
      followedOn.set(`${bond.follower.part}:${node}`, { part: bond.on.part, bond: bi });
      count++;
    }
    // Codex on #1022: a contact needs a node lying within its tolerance, not one it newly ties
    // (a node whose DOFs are all held lies on it and ties nothing, as for a bond).
    if (bond.contact && !lying)
      throw new ElasticError(
        'bond-gap',
        `bond ${bi}: no node of the contact lies within ${bond.tolerance} mm of the side it follows`,
      );
    bondStats.push({ nodes: count, maxGap });
  }

  // Resolve followers of followers, refusing a DOF that comes to follow itself.
  const resolved = new Map<number, Combination>();
  const visiting = new Set<number>();
  const expand = (d: number): Combination => {
    const c = follows.get(d);
    if (!c) return new Map([[d, 1]]);
    const done = resolved.get(d);
    if (done) return done;
    if (visiting.has(d))
      throw new ElasticError('bond-cycle', `the bonds make DOF ${d} follow itself`);
    visiting.add(d);
    const out: Combination = new Map();
    for (const [m, v] of c) for (const [q, w] of expand(m)) addTo(out, q, v * w);
    visiting.delete(d);
    if (out.has(d)) throw new ElasticError('bond-cycle', `the bonds make DOF ${d} follow itself`);
    resolved.set(d, out);
    return out;
  };
  for (const d of follows.keys()) expand(d);

  // Every connected piece of the model (mesh pieces joined by their elements and by the bonds) is
  // held against all six rigid motions: one held DOF somewhere in a piece is not enough.
  const nodeBase: number[] = [];
  let allNodes = 0;
  for (const p of parts) {
    nodeBase.push(allNodes);
    allNodes += p.mesh.nodes.length / 3;
  }
  const xyz = new Float64Array(3 * allNodes);
  parts.forEach((p, i) => xyz.set(p.mesh.nodes, 3 * nodeBase[i]!));
  const parent = Int32Array.from({ length: allNodes }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const join = (x: number, y: number) => {
    const [rx, ry] = [find(x), find(y)];
    if (rx !== ry) parent[ry] = rx;
  };
  // Each mesh piece (a part's connected component) moves rigidly on its own until bonded.
  const pieceOf = new Int32Array(allNodes);
  const piecePart: number[] = [];
  let pieces = 0;
  parts.forEach((p, i) => {
    const { label } = p.kind === 'shell' ? shellComponents(p.mesh) : meshComponents(p.mesh);
    const first = new Map<number, number>();
    const base = pieces;
    label.forEach((l, n) => {
      pieceOf[nodeBase[i]! + n] = base + l;
      piecePart[base + l] = i;
      pieces = Math.max(pieces, base + l + 1);
      const f = first.get(l);
      if (f === undefined) first.set(l, n);
      else join(nodeBase[i]! + f, nodeBase[i]! + n);
    });
  });
  /** A global DOF as its node over all parts and its component (6 per node: shell-style). */
  const nodeDof = (d: number) => {
    let i = parts.length - 1;
    while (offset[i]! > d) i--;
    const local = d - offset[i]!;
    return { part: i, node: nodeBase[i]! + Math.floor(local / per[i]!), comp: local % per[i]! };
  };
  for (const [d, c] of follows) {
    const x = nodeDof(d).node;
    for (const q of c.keys()) join(x, nodeDof(q).node);
  }
  const heldIn = new Map<number, number[]>();
  for (const d of prescribed.keys()) {
    const { node, comp } = nodeDof(d);
    const r = find(node);
    let list = heldIn.get(r);
    if (!list) heldIn.set(r, (list = []));
    list.push(6 * node + comp);
  }
  const checked = new Set<number>();
  parts.forEach((p, i) => {
    for (let n = 0; n < p.mesh.nodes.length / 3; n++) {
      const r = find(nodeBase[i]! + n);
      if (checked.has(r)) continue;
      checked.add(r);
      const held = heldIn.get(r);
      if (!held)
        throw new ElasticError(
          'body-unconnected',
          `part ${i} (node ${n}) is neither held nor bonded to a held part`,
        );
      const freeModes = shellFreeRigidModes(xyz, held);
      if (freeModes.length)
        throw new ElasticError(
          'rigid-body-mode',
          `the piece of part ${i} with node ${n} is free: ${freeModes.join(', ')}`,
          freeModes,
        );
    }
  });

  if (follows.size) relativeMechanism(xyz, pieceOf, piecePart, follows, prescribed, nodeDof);

  // The reduced system on the DOFs that follow nothing.
  const index = new Int32Array(dofs).fill(-1);
  let reduced = 0;
  for (let d = 0; d < dofs; d++) if (!follows.has(d)) index[d] = reduced++;
  const T = (d: number): Combination => resolved.get(d) ?? new Map([[d, 1]]);
  const fr = new Float64Array(reduced);
  for (let d = 0; d < dofs; d++) if (f[d]) for (const [q, c] of T(d)) fr[index[q]!]! += c * f[d]!;
  /** Tᵀ A T of the parts' matrices (each part's own, on its DOFs). */
  const reduce = (matrixOf: (p: BondedPart, i: number) => CsrMatrix): CsrMatrix => {
    const rows: Map<number, number>[] = Array.from({ length: reduced }, () => new Map());
    parts.forEach((p, pi) => {
      const K = matrixOf(p, pi);
      const { rowPtr, cols, rows: n } = K.pattern;
      const o = offset[pi]!;
      for (let i = 0; i < n; i++) {
        const Ti = T(o + i);
        for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) {
          const v = K.values[k]!;
          if (!v) continue;
          const Tj = T(o + cols[k]!);
          for (const [a, ca] of Ti) {
            const row = rows[index[a]!]!;
            for (const [b, cb] of Tj) {
              const j = index[b]!;
              row.set(j, (row.get(j) ?? 0) + ca * cb * v);
            }
          }
        }
      }
    });
    const rowPtr = new Uint32Array(reduced + 1);
    for (let i = 0; i < reduced; i++) rowPtr[i + 1] = rowPtr[i]! + rows[i]!.size;
    const cols = new Uint32Array(rowPtr[reduced]!);
    const pattern: CsrPattern = { rows: reduced, rowPtr, cols };
    const A = new CsrMatrix(pattern);
    for (let i = 0; i < reduced; i++) {
      const entries = [...rows[i]!].sort((x, y) => x[0] - y[0]);
      entries.forEach(([j, v], k) => {
        cols[rowPtr[i]! + k] = j;
        A.values[rowPtr[i]! + k] = v;
      });
      rows[i] = new Map();
    }
    return A;
  };
  /** A reduced vector on every DOF: the followers from what they follow. */
  const toFull = (ur: Float64Array) => {
    const u = new Float64Array(dofs);
    for (let d = 0; d < dofs; d++) {
      if (index[d]! >= 0) u[d] = ur[index[d]!]!;
      else for (const [q, c] of T(d)) u[d]! += c * ur[index[q]!]!;
    }
    return u;
  };
  /** Per reduced DOF: its translation direction (0–2, −1 for a rotation) and its node's position. */
  const component = new Int8Array(reduced);
  const position = new Float64Array(3 * reduced);
  parts.forEach((p, pi) => {
    for (let q = 0; q < p.mesh.nodes.length / 3; q++)
      for (let i = 0; i < per[pi]!; i++) {
        const r = index[dofOf(pi, q, i)]!;
        if (r < 0) continue;
        component[r] = i < 3 ? i : -1;
        for (let k = 0; k < 3; k++) position[3 * r + k] = p.mesh.nodes[3 * q + k]!;
      }
  });
  return {
    parts,
    per,
    offset,
    dofs,
    dofOf,
    prepared,
    f,
    fr,
    prescribed,
    bondStats,
    skinSides,
    followedOn,
    index,
    reduced,
    reduce,
    toFull,
    component,
    position,
  };
}

/**
 * Solves the bonded bodies' linear static problem. Refuses, before solving: a bond whose side is
 * on a part or face the model does not have (`target-index`); a solid face following a shell
 * (`bond-kind`); a follower node farther than the tolerance from what it follows (`bond-gap`);
 * bonds that make a DOF follow itself (`bond-cycle`); a connected piece of the model (mesh
 * pieces joined by elements and bonds) that nothing holds (`body-unconnected`) or that its held
 * DOFs leave a rigid motion (`rigid-body-mode`). A held follower DOF stays held and follows nothing.
 */
export function solveBonded(input: BondedInput): BondedResult {
  const system = bondedSystem(input);
  const {
    parts,
    per,
    offset,
    dofs,
    dofOf,
    prepared,
    f,
    fr,
    prescribed,
    bondStats,
    index,
    reduced,
  } = system;
  const K = system.reduce((p) =>
    p.kind === 'shell'
      ? assembleShellStiffness(p.mesh, p.material)
      : assembleStiffness(p.mesh, p.material),
  );
  const ur = new Float64Array(reduced);
  const free = new Uint8Array(reduced).fill(1);
  for (const [d, v] of prescribed) {
    ur[index[d]!] = v;
    free[index[d]!] = 0;
  }
  const Ku0 = K.multiply(ur);
  const b = new Float64Array(reduced);
  for (let i = 0; i < reduced; i++) b[i] = free[i] ? fr[i]! - Ku0[i]! : 0;
  // ILU(0) first, as the shells use; on the eliminated system it can fail to converge (it was
  // measured diverging on FX8c), so Jacobi takes the iterations left from where ILU was best.
  const { tolerance, maxIterations } = input.solver;
  const iluBudget = Math.min(maxIterations, iluIterations);
  let solved = pcg(K, b, free, tolerance, iluBudget, undefined, incompleteFactor(K, free).apply);
  let preconditioner: BondedResult['preconditioner'] = 'ilu';
  const left = maxIterations - solved.iterations;
  if (!solved.converged && left > 0) {
    // Jacobi continues from the ILU iterate.
    const jacobi = pcg(K, b, free, tolerance, left, solved.x);
    solved = { ...jacobi, iterations: solved.iterations + jacobi.iterations };
    preconditioner = 'jacobi';
  }
  for (let i = 0; i < reduced; i++) if (free[i]) ur[i] = solved.x[i]!;
  const Ku = K.multiply(ur);

  // Back to every DOF; reactions at the held DOFs of the reduced system.
  const u = system.toFull(ur);
  const reaction = new Float64Array(dofs);
  for (const d of prescribed.keys()) reaction[d] = Ku[index[d]!]! - fr[index[d]!]!;

  // Totals over every part about the centre of all nodes.
  const centre: Vec = [0, 0, 0];
  let nodes = 0;
  for (const p of parts) {
    const xs = p.mesh.nodes;
    for (let q = 0; q < xs.length / 3; q++)
      for (let i = 0; i < 3; i++) centre[i]! += xs[3 * q + i]!;
    nodes += xs.length / 3;
  }
  for (let i = 0; i < 3; i++) centre[i]! /= nodes;
  const totals = (v: Float64Array) => {
    const F: Vec = [0, 0, 0],
      Mo: Vec = [0, 0, 0];
    let size = 0;
    parts.forEach((p, pi) => {
      const xs = p.mesh.nodes;
      for (let q = 0; q < xs.length / 3; q++) {
        const at = dofOf(pi, q, 0);
        const fq: Vec = [v[at]!, v[at + 1]!, v[at + 2]!];
        const r = cross(sub(xs.subarray(3 * q, 3 * q + 3), centre), fq);
        const m = [0, 1, 2].map((i) => r[i]! + (per[pi] === 6 ? v[at + 3 + i]! : 0));
        for (let i = 0; i < 3; i++) {
          F[i]! += fq[i]!;
          Mo[i]! += m[i]!;
        }
        size += Math.hypot(m[0]!, m[1]!, m[2]!);
      }
    });
    return { F, Mo, size };
  };
  const applied = totals(f),
    reacted = totals(reaction);

  const results: BondedPartResult[] = parts.map((p, pi) => {
    const n = per[pi]! * (p.mesh.nodes.length / 3);
    const up = u.slice(offset[pi]!, offset[pi]! + n);
    const rp = reaction.slice(offset[pi]!, offset[pi]! + n);
    const { loadChecks, constrainedNodes } = prepared[pi]!;
    return p.kind === 'shell'
      ? {
          kind: 'shell',
          displacement: up,
          reaction: rp,
          loadChecks,
          constrainedNodes,
          ...shellStress(p.mesh, p.material, up),
        }
      : {
          kind: 'solid',
          displacement: up,
          reaction: rp,
          loadChecks,
          constrainedNodes,
          ...elasticStress(p.mesh, p.material, up),
        };
  });
  return {
    parts: results,
    bonds: bondStats,
    appliedTotal: applied.F,
    reactionTotal: reacted.F,
    appliedMoment: applied.Mo,
    reactionMoment: reacted.Mo,
    momentScale: Math.max(applied.size, reacted.size),
    dofs: reduced,
    preconditioner,
    iterations: solved.iterations,
    residual: solved.residual,
    converged: solved.converged,
  };
}

export interface BondedModalInput {
  /** The parts with their constraints (held at 0); their loads are not used. */
  parts: BondedPart[];
  bonds: Bond[];
  modes: number;
  solver: { tolerance: number; maxIterations: number };
  /** After each LOBPCG step, with the current eigenvalue estimates; throw to cancel. */
  progress?: (iteration: number, values: number[]) => void;
}
export interface BondedModalMode {
  frequency: number;
  eigenvalue: number;
  residual: number;
  /** The modal masses in x, y, z over all parts (t). */
  effectiveMass: [number, number, number];
  /** Each part's shape (3 or 6 DOFs per node), mass-normalised over all parts together. */
  shapes: Float64Array[];
}
export interface BondedModalResult {
  modes: BondedModalMode[];
  /** Total mass of all parts (t). */
  mass: number;
  /** Each part's own mass (t). */
  partMasses: number[];
  bonds: BondedResult['bonds'];
  dofs: number;
  iterations: number;
  converged: boolean;
  orthogonality: number;
  /** Per part, the nodes each of its constraints holds. */
  constrainedNodes: number[][];
}

/**
 * R3j-4c: the lowest natural modes of bonded bodies. The followers are eliminated from the mass as
 * from the stiffness (M' = Tᵀ M T, K' = Tᵀ K T), and LOBPCG solves the reduced problem. Refuses
 * what `solveBonded` refuses, a held DOF other than 0 (`constraint-conflict`) and a density ≤ 0
 * (`material`).
 */
export function solveBondedModal(input: BondedModalInput): BondedModalResult {
  if (!Number.isInteger(input.modes) || input.modes < 1)
    throw new RangeError('modes must be a whole number ≥ 1');
  input.parts.forEach((p, i) => {
    if (!(p.material.density > 0))
      throw new ElasticError('material', `part ${i}: density > 0 for a modal study`);
  });
  const parts = input.parts.map((p): BondedPart => ({ ...p, loads: [] }) as BondedPart);
  const system = bondedSystem({ parts, bonds: input.bonds });
  const { reduced, index, prescribed, offset, per } = system;
  for (const [d, v] of prescribed)
    if (v !== 0)
      throw new ElasticError('constraint-conflict', `DOF ${d}: a modal study holds DOFs at 0 only`);
  const free = new Uint8Array(reduced).fill(1);
  for (const d of prescribed.keys()) free[index[d]!] = 0;
  if (!free.some((x) => x))
    throw new ElasticError(
      'constraint-conflict',
      'the constraints hold every node in every direction: nothing is left to vibrate',
    );
  const K = system.reduce((p) =>
    p.kind === 'shell'
      ? assembleShellStiffness(p.mesh, p.material)
      : assembleStiffness(p.mesh, p.material),
  );
  const massOf = (p: BondedPart, i: number) => {
    const Mp =
      p.kind === 'shell'
        ? assembleShellMass(p.mesh, p.material.density)
        : assembleMass(p.mesh, p.material.density);
    addNodalMasses(Mp, system.prepared[i]!.added, p.kind === 'shell' ? 6 : 3);
    return Mp;
  };
  const M = system.reduce(massOf);
  const eigen = lowestModes({
    K,
    M,
    free,
    perNode: 3,
    coordinates: new Float64Array(0),
    layout: { component: system.component, position: system.position },
    preconditioner: 'inner',
    modes: input.modes,
    solver: input.solver,
    progress: input.progress,
  });
  const { modes, mass, orthogonality } = modalSummary(M, eigen, system.component);
  const partMasses = parts.map((p, i) => {
    const Mp = massOf(p, i);
    const n = Mp.pattern.rows;
    const ones = new Float64Array(n);
    for (let d = 0; d < n; d += p.kind === 'shell' ? 6 : 3) ones[d] = 1;
    return Mp.multiply(ones).reduce((s, x, d) => s + x * ones[d]!, 0);
  });
  return {
    modes: modes.map((m) => {
      const full = system.toFull(m.shape);
      return {
        frequency: m.frequency,
        eigenvalue: m.eigenvalue,
        residual: m.residual,
        effectiveMass: m.effectiveMass,
        shapes: parts.map((p, pi) =>
          full.slice(offset[pi]!, offset[pi]! + per[pi]! * (p.mesh.nodes.length / 3)),
        ),
      };
    }),
    mass,
    partMasses,
    bonds: system.bondStats,
    dofs: reduced,
    iterations: eigen.iterations,
    converged: eigen.converged,
    orthogonality,
    constrainedNodes: system.prepared.map((p) => p.constrainedNodes),
  };
}

/**
 * R3j-5b (docs/cad/r3-analysis.md, A4-U4): bonded bodies as one solid model for the reference
 * Host. Each solid part keeps its tet elements, each shell part becomes its 15-node wedges
 * (`expandShell`), each with its own material block. A bond ties every node of the dependent side
 * (a shell's three layers and the top and bottom of its sides on the bond) to the side it follows
 * by `*EQUATION`s, u_x = Σ c_k u_k:
 *
 * - On a solid: the shape values of the boundary face under the node (as `solveBonded`, whose
 *   shell-on-solid rule ties the points t/2 above and below; here they are the layer nodes).
 * - On a shell: the triangle (or edge segment) under the dependent node's midsurface point, its
 *   corners' bottom, middle and top nodes weighted by the quadratic through the wall at
 *   ζ = (x − x_mid) · n / (t/2), so a layer t'/2 off the dependent midsurface follows the side's
 *   midsurface field turned by its rotation, as the six-DOF tie of `solveBonded` does.
 *
 * The checks are `solveBonded`'s (`bondedSystem`): the same refusals before anything is sent.
 */
export interface BondedHostModel {
  model: CalculixModel;
  /** Per part: its first node in the model, its node count, and a shell's wedges. */
  layout: { base: number; count: number; expansion?: ShellExpansion }[];
  /**
   * The bonds' equations by dependent DOF: [DOF, c] with u_x = Σ c u_DOF; with them, a shell's
   * own (crease) equation whose dependent a bond was put through (CR4f).
   */
  ties: Map<number, [number, number][]>;
  prepared: (ElasticPrepared | ReturnType<typeof prepareShell>)[];
  bonds: BondedResult['bonds'];
}

export function bondedHostModel(input: Pick<BondedInput, 'parts' | 'bonds'>): BondedHostModel {
  const system = bondedSystem(input);
  const { parts } = input;
  const layout: BondedHostModel['layout'] = [];
  const blocks: CalculixPart[] = [];
  const xyz: number[] = [];
  const prescribed = new Map<number, number>();
  const force: number[] = [];
  const equations: CalculixEquation[] = [];
  const eliminated = new Set<number>();
  /** A shell's own equations (its creases, CR4f) by the DOF each eliminates. */
  const shellEquations = new Map<number, readonly (readonly [number, number])[]>();
  let base = 0;
  parts.forEach((p, i) => {
    if (p.kind === 'solid') {
      const n = p.mesh.nodes.length / 3;
      const pr = system.prepared[i] as ElasticPrepared;
      layout.push({ base, count: n });
      blocks.push({
        type: p.mesh.type,
        elements: Uint32Array.from(p.mesh.elements, (q) => q + base),
        material: p.material,
      });
      for (const v of p.mesh.nodes) xyz.push(v);
      for (const v of pr.force) force.push(v);
      for (const [d, v] of pr.prescribed) prescribed.set(3 * base + d, v);
      base += n;
    } else {
      const x = expandShell(p.mesh);
      const m = expandShellStudy(
        p.mesh,
        x,
        p.material,
        system.prepared[i] as ReturnType<typeof prepareShell>,
      );
      const n = x.nodes.length / 3;
      layout.push({ base, count: n, expansion: x });
      blocks.push({
        type: 'wedge15',
        elements: Uint32Array.from(m.parts[0]!.elements, (q) => q + base),
        material: p.material,
      });
      for (const v of x.nodes) xyz.push(v);
      for (let d = 0; d < m.force.length; d++) force.push(m.force[d]!);
      for (const [d, v] of m.prescribed) prescribed.set(3 * base + d, v);
      for (const e of m.equations ?? []) {
        const row = e.map(([d, c]) => [3 * base + d, c] as const);
        equations.push(row);
        eliminated.add(row[0]![0]);
        shellEquations.set(row[0]![0], row);
      }
      base += n;
    }
  });
  const at = (g: number): Vec => [xyz[3 * g]!, xyz[3 * g + 1]!, xyz[3 * g + 2]!];

  /** A dependent model node: its midsurface point, and for a shell its layer's offset h n. */
  interface Dependent {
    g: number;
    mid: Vec;
    /** s t / 2 of its layer (0 on a solid and on a shell's middle) along `normal`. */
    h: number;
    normal: Vec;
  }
  /** The triangles of each shell part by their sorted node pair, for an edge side's segments. */
  const sideTriangles = new Map<number, Map<number, number>>();
  const triangleOn = (pi: number, a: number, b: number) => {
    const m = parts[pi]!.mesh as ShellMesh;
    const n = m.nodes.length / 3;
    let map = sideTriangles.get(pi);
    if (!map) {
      sideTriangles.set(pi, (map = new Map()));
      for (let e = 0; e < m.triangles.length / 3; e++)
        for (let k = 0; k < 3; k++) {
          const [p, q] = [m.triangles[3 * e + k]!, m.triangles[3 * e + ((k + 1) % 3)]!];
          map.set(Math.min(p, q) * n + Math.max(p, q), e);
        }
    }
    return map.get(Math.min(a, b) * n + Math.max(a, b))!;
  };

  /**
   * The three rows (x, y, z) a dependent node follows, [model DOF, c] each. On a solid: the face's
   * shape values at the node itself. On a shell, as the six-DOF tie of `solveBonded`:
   * u = u_m + h θ_m × n_d at the dependent's midsurface point, with u_m from the middle layer,
   * θ_m ⊥ n_m = n_m × w, w = (u_top − u_bottom) / t, and θ_m about n_m from the triangle's
   * in-plane rotation ½ n_m · curl u_m (the wedges have no drilling DOF of their own).
   */
  const masterRows = (bond: Bond, targets: Target[], dep: Dependent): [number, number][][] => {
    const op = parts[bond.on.part]!;
    const L = layout[bond.on.part]!;
    const rows: Map<number, number>[] = [new Map(), new Map(), new Map()];
    const add = (i: number, d: number, c: number) => {
      if (c !== 0) rows[i]!.set(d, (rows[i]!.get(d) ?? 0) + c);
    };
    if (op.kind === 'solid') {
      const r = follow(targets, at(dep.g));
      r.nodes.forEach((q, a) => {
        for (let i = 0; i < 3; i++) add(i, 3 * (L.base + q) + i, r.N[a]!);
      });
    } else {
      const x = L.expansion!;
      const m = op.mesh;
      const r = follow(targets, dep.mid);
      // The triangle under the point: an edge segment's is the one on that segment.
      let tri: number[], N: number[], e: number;
      if (r.nodes.length === 3 && r.triangle !== undefined)
        [tri, N, e] = [r.nodes, r.N, r.triangle];
      else {
        e = triangleOn(bond.on.part, r.nodes[0]!, r.nodes[1]!);
        tri = [0, 1, 2].map((k) => m.triangles[3 * e + k]!);
        N = tri.map((c) => r.nodes.reduce((s2, q, a) => (q === c ? s2 + r.N[a]! : s2), 0));
      }
      const X = tri.map((c) => pointOf(m.nodes, c));
      const nt = cross(sub(X[1]!, X[0]!), sub(X[2]!, X[0]!));
      const twoA = norm(nt);
      for (let i = 0; i < 3; i++) nt[i]! /= twoA;
      // ∇N_c in the triangle's plane, and (n × ∇N_c) for the in-plane rotation.
      const grad = [0, 1, 2].map((c) => {
        const e = sub(X[(c + 2) % 3]!, X[(c + 1) % 3]!);
        return cross(nt, e).map((v) => v / twoA) as Vec;
      });
      // CR4f: a creased corner by its copy on this triangle (its wedge's, Codex on #962).
      tri = [0, 1, 2].map((a) => shellCornerCopy(x, e, a));
      const nm: Vec = [0, 0, 0];
      tri.forEach((c, a) => {
        for (let i = 0; i < 3; i++) nm[i]! += N[a]! * x.normals[3 * c + i]!;
      });
      const l = norm(nm);
      for (let i = 0; i < 3; i++) nm[i]! /= l;
      const nd = dep.normal;
      const h = dep.h;
      const nn = dot(nm, nd);
      const drill = cross(nm, nd);
      tri.forEach((c, a) => {
        const [bottom, middle, top] = [0, 1, 2].map((k) => L.base + x.layers[3 * c + k]!);
        const t = x.thickness[c]!;
        const curl = cross(nt, grad[a]!);
        for (let i = 0; i < 3; i++) {
          add(i, 3 * middle! + i, N[a]!);
          // h ((n_m · n_d) w − n_m (n_d · w)), w = Σ N (u_top − u_bottom) / t.
          for (let j = 0; j < 3; j++) {
            const k = h * ((i === j ? nn : 0) - nm[i]! * nd[j]!) * (N[a]! / t);
            add(i, 3 * top! + j, k);
            add(i, 3 * bottom! + j, -k);
            // h θ_n (n_m × n_d), θ_n = ½ Σ (n × ∇N_c) · u_c.
            add(i, 3 * middle! + j, (h * drill[i]! * curl[j]!) / 2);
          }
        }
      });
    }
    return rows.map((row) => [...row].filter(([, c]) => Math.abs(c) > 1e-12));
  };

  const ties = new Map<number, [number, number][]>();
  for (const [bi, bond] of input.bonds.entries()) {
    // A skin's (`bondedSystem`): only its layer toward the solid follows it, at its own place.
    const skinKeeps = (q: number, h: number) => {
      const side = system.skinSides.get(`${bond.follower.part}:${q}`);
      return side === undefined || h * side > 0;
    };
    const fp = parts[bond.follower.part]!;
    const F = layout[bond.follower.part]!;
    const targets = targetsOf(parts[bond.on.part]!, bond.on);
    const all = nodesOf(fp, bond.follower);
    // CR5f: a contact ties only the nodes the system found within its tolerance, the same way
    // (Codex on #1022: of the chosen nodes too, when they are given).
    const only = bond.contact
      ? new Set(all.filter((q) => system.followedOn.get(`${bond.follower.part}:${q}`)?.bond === bi))
      : bond.follower.nodes
        ? new Set(all)
        : undefined;
    const corners = only ? all.filter((q) => only.has(q)) : all;
    const dependents: Dependent[] = [];
    if (fp.kind === 'solid')
      for (const q of corners)
        dependents.push({ g: F.base + q, mid: at(F.base + q), h: 0, normal: [0, 0, 1] });
    else {
      const x = F.expansion!;
      const m = fp.mesh;
      const normalOf = (q: number): Vec => [
        x.normals[3 * q]!,
        x.normals[3 * q + 1]!,
        x.normals[3 * q + 2]!,
      ];
      const n = m.nodes.length / 3;
      const C = x.layers.length / 3;
      const keys = new Set<number>();
      const copyKeys = new Set<number>();
      const key = (a: number, b: number, size = n) => Math.min(a, b) * size + Math.max(a, b);
      const faces = new Set(bond.follower.faces);
      const copyAt = (e: number, a: number) => shellCornerCopy(x, e, a % 3);
      // The corners on the bond, by their copies (CR4f: a crease corner by the selected face's
      // own copy, Codex on #962): its faces' triangles' corners, then its edges' nodes not on
      // them (by their first copy).
      const cornerCopies = new Set<number>();
      // CR5b: a spot weld ties only its nodes (`BondSide.nodes`, all their layers), no side; CR5f: so
      // does a contact, its nodes within the tolerance.
      for (let e = 0; e < m.triangles.length / 3; e++)
        if (faces.has(m.faces[e]!))
          for (let a = 0; a < 3; a++) {
            if (only) {
              if (only.has(m.triangles[3 * e + a]!)) cornerCopies.add(copyAt(e, a));
              continue;
            }
            cornerCopies.add(copyAt(e, a));
            copyKeys.add(key(copyAt(e, a), copyAt(e, a + 1), C));
          }
      const copiesOf = shellNodeCopies(x);
      for (const q of corners)
        if (!copiesOf[q]!.some((c) => cornerCopies.has(c))) cornerCopies.add(q);
      const shellNode = (c: number) => (c < n ? c : x.creases.node[c - n]!);
      for (const c of [...cornerCopies].sort((a, b) => a - b)) {
        const q = shellNode(c);
        for (let k = 0; k < 3; k++)
          if (skinKeeps(q, k - 1))
            dependents.push({
              g: F.base + x.layers[3 * c + k]!,
              mid: pointOf(m.nodes, q),
              h: ((k - 1) * x.thickness[c]!) / 2,
              normal: normalOf(c),
            });
      }
      // The sides on the bond: of its faces' triangles (by their corners' copies, so a crease
      // side is the selected face's own, CR4f), and along its edges' chains (by shell nodes).
      for (const k of only ? [] : bond.follower.edges) {
        const chain = m.edges.nodes.subarray(m.edges.offsets[k]!, m.edges.offsets[k + 1]!);
        for (let s = 0; s + 1 < chain.length; s++) keys.add(key(chain[s]!, chain[s + 1]!));
      }
      const { ends, copies, layers } = x.sides;
      for (let k = 0; k < ends.length / 2; k++) {
        const [a, b] = [ends[2 * k]!, ends[2 * k + 1]!];
        if (!keys.has(key(a, b)) && !copyKeys.has(key(copies[2 * k]!, copies[2 * k + 1]!, C)))
          continue;
        const mid: Vec = [0, 1, 2].map(
          (i) => (m.nodes[3 * a + i]! + m.nodes[3 * b + i]!) / 2,
        ) as Vec;
        // The side's own copies (CR4f: a crease side has one per smooth side).
        const [ca, cb] = [copies[2 * k]!, copies[2 * k + 1]!];
        const nrm = [0, 1, 2].map((i) => x.normals[3 * ca + i]! + x.normals[3 * cb + i]!) as Vec;
        const l = norm(nrm);
        const t = (x.thickness[ca]! + x.thickness[cb]!) / 2;
        for (let s = 0; s < 2; s++)
          if (skinKeeps(a, 2 * s - 1) && skinKeeps(b, 2 * s - 1))
            dependents.push({
              g: F.base + layers[2 * k + s]!,
              mid,
              h: ((2 * s - 1) * t) / 2,
              normal: nrm.map((v) => v / l) as Vec,
            });
      }
    }
    for (const dep of dependents) {
      const rows = masterRows(bond, targets, dep);
      for (let i = 0; i < 3; i++) {
        const d = 3 * dep.g + i;
        // A held DOF stays held; one a bond already ties is not tied twice.
        if (prescribed.has(d)) continue;
        const row = rows[i]!.filter(([q]) => q !== d);
        if (!row.length) continue;
        const own = shellEquations.get(d);
        if (own) {
          // A crease copy its shell's equation already eliminates (CR4f, Codex on #962): that
          // equation's d = −Σ (c / c_d) x put in the bond, d − Σ c q = 0, which then eliminates
          // the free one of those x of largest weight. Once: another bond on the same copy (a
          // neighbouring face on the same master) would add the same equation again.
          if (ties.has(d)) continue;
          const a = own[0]![1];
          const terms = new Map<number, number>();
          for (const [x, c] of own.slice(1)) terms.set(x, (terms.get(x) ?? 0) - c / a);
          for (const [q, c] of row) terms.set(q, (terms.get(q) ?? 0) - c);
          const xs = new Set(own.slice(1).map(([x]) => x));
          let pivot: number | undefined;
          for (const x of xs)
            if (
              !eliminated.has(x) &&
              !prescribed.has(x) &&
              Math.abs(terms.get(x)!) > 1e-12 &&
              (pivot === undefined || Math.abs(terms.get(x)!) > Math.abs(terms.get(pivot)!))
            )
              pivot = x;
          if (pivot === undefined) continue;
          const k = terms.get(pivot)!;
          const others = [...terms].filter(([x, c]) => x !== pivot && Math.abs(c) > 1e-12);
          ties.set(
            pivot,
            others.map(([x, c]) => [x, -c / k] as [number, number]),
          );
          eliminated.add(pivot);
          equations.push([[pivot, 1], ...others.map(([x, c]) => [x, c / k] as const)]);
          // The shell's equation joins the ties too, so the residual at d reaches the x it
          // follows (the pivot among them) before the pivot's goes on to the master.
          ties.set(
            d,
            own.slice(1).map(([x, c]) => [x, -c / a] as [number, number]),
          );
          continue;
        }
        if (eliminated.has(d)) continue;
        ties.set(d, row);
        eliminated.add(d);
        equations.push([[d, 1], ...row.map(([q, c]) => [q, -c] as const)]);
      }
    }
  }
  return {
    model: {
      nodes: Float64Array.from(xyz),
      parts: blocks,
      prescribed,
      force: Float64Array.from(force),
      equations,
    },
    layout,
    ties,
    prepared: system.prepared,
    bonds: system.bondStats,
  };
}

/**
 * The bonded result from the Host's `.frd` on `bondedHostModel`'s model. The residual K u − f of
 * each tied DOF (its equation's force) goes to the DOFs it follows, as Tᵀ does in the browser,
 * so the reactions at the held DOFs balance the loads; then each part is read as its own: a
 * solid's nodes directly, a shell folded from its wedges (`shellResultFromFrd`).
 */
export function bondedResultFromFrd(
  input: Pick<BondedInput, 'parts'>,
  host: BondedHostModel,
  frd: FrdResult,
): BondedResult {
  const { parts } = input;
  const { model, layout, ties } = host;
  const N = model.nodes.length / 3;
  const R = new Float64Array(3 * N);
  for (let d = 0; d < 3 * N; d++) R[d] = frd.force[d]! - model.force[d]!;
  // Dependents before the dependents they follow.
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (d: number) => {
    if (seen.has(d)) return;
    seen.add(d);
    for (const [q] of ties.get(d)!) if (ties.has(q)) visit(q);
    order.push(d);
  };
  for (const d of ties.keys()) visit(d);
  let tiedForce = 0;
  for (const d of order.reverse()) {
    tiedForce += Math.abs(frd.force[d]!);
    for (const [q, c] of ties.get(d)!) R[q]! += c * R[d]!;
    R[d] = 0;
  }
  const forceAt = Float64Array.from(R, (r, d) => r + model.force[d]!);

  let forceScale = tiedForce;
  const results: BondedPartResult[] = parts.map((p, i) => {
    const { base, count, expansion } = layout[i]!;
    const part: FrdResult = {
      displacement: frd.displacement.subarray(3 * base, 3 * (base + count)),
      stress: frd.stress.subarray(6 * base, 6 * (base + count)),
      force: forceAt.subarray(3 * base, 3 * (base + count)),
    };
    const pr = host.prepared[i]!;
    if (p.kind === 'shell') {
      const r = shellResultFromFrd(p.mesh, expansion!, pr as ReturnType<typeof prepareShell>, part);
      forceScale += r.forceScale ?? 0;
      return {
        kind: 'shell',
        displacement: r.displacement,
        reaction: r.reaction,
        loadChecks: r.loadChecks,
        constrainedNodes: r.constrainedNodes,
        stress: r.stress,
        vonMises: r.vonMises,
      };
    }
    const reaction = new Float64Array(3 * count);
    for (const d of pr.prescribed.keys()) {
      reaction[d] = R[3 * base + d]!;
      forceScale += Math.abs(frd.force[3 * base + d]!);
    }
    const vonMises = new Float64Array(count);
    for (let q = 0; q < count; q++) vonMises[q] = vonMisesOf(part.stress, 6 * q);
    return {
      kind: 'solid',
      displacement: Float64Array.from(part.displacement),
      stress: Float64Array.from(part.stress),
      vonMises,
      reaction,
      loadChecks: pr.loadChecks,
      constrainedNodes: pr.constrainedNodes,
    };
  });

  // Totals over every part about the centre of all nodes, as `solveBonded`.
  const centre: Vec = [0, 0, 0];
  let nodes = 0;
  for (const p of parts) {
    const xs = p.mesh.nodes;
    for (let q = 0; q < xs.length / 3; q++)
      for (let i = 0; i < 3; i++) centre[i]! += xs[3 * q + i]!;
    nodes += xs.length / 3;
  }
  for (let i = 0; i < 3; i++) centre[i]! /= nodes;
  const F: Record<'applied' | 'reacted', { F: Vec; Mo: Vec; size: number }> = {
    applied: { F: [0, 0, 0], Mo: [0, 0, 0], size: 0 },
    reacted: { F: [0, 0, 0], Mo: [0, 0, 0], size: 0 },
  };
  let reach = 0;
  parts.forEach((p, i) => {
    const per = p.kind === 'shell' ? 6 : 3;
    const xs = p.mesh.nodes;
    const pairs = [
      ['applied', host.prepared[i]!.force],
      ['reacted', results[i]!.reaction],
    ] as const;
    for (const [k, v] of pairs)
      for (let q = 0; q < xs.length / 3; q++) {
        const fq: Vec = [v[per * q]!, v[per * q + 1]!, v[per * q + 2]!];
        const rq = sub(xs.subarray(3 * q, 3 * q + 3), centre);
        const r = cross(rq, fq);
        const m = [0, 1, 2].map((j) => r[j]! + (per === 6 ? v[per * q + 3 + j]! : 0));
        for (let j = 0; j < 3; j++) {
          F[k].F[j]! += fq[j]!;
          F[k].Mo[j]! += m[j]!;
        }
        F[k].size += Math.hypot(m[0]!, m[1]!, m[2]!);
      }
    for (let q = 0; q < xs.length / 3; q++)
      reach = Math.max(reach, norm(sub(xs.subarray(3 * q, 3 * q + 3), centre)));
  });
  return {
    parts: results,
    bonds: host.bonds,
    appliedTotal: F.applied.F,
    reactionTotal: F.reacted.F,
    appliedMoment: F.applied.Mo,
    reactionMoment: F.reacted.Mo,
    // The moments of the summed forces reach as far as the farthest node.
    momentScale: Math.max(F.applied.size, F.reacted.size, reach * forceScale),
    forceScale,
    dofs: 3 * N - model.prescribed.size - (model.equations?.length ?? 0),
    preconditioner: 'direct',
    iterations: 0,
    residual: 0,
    converged: true,
  };
}
