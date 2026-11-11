import { cornerVolume6, localFaces, nodesPerElement, tet10Edges, type FemMesh } from './fem';
import { CsrMatrix, csrPattern, pcg } from './sparse';

/**
 * Linear static analysis of an isotropic linear elastic solid on a FEM 1 mesh (docs/cad/r3-analysis.md,
 * 解法と検査). Units are mm–N–MPa–t–s: displacements in mm, forces in N, stresses in MPa.
 */
export interface ElasticMaterial {
  youngsModulus: number;
  poissonsRatio: number;
  density: number;
}

/** A load on mesh entities, already mapped (R3c gives the face tags and edge indices). */
export type ElasticLoad =
  /** A total force spread over the shape faces by area. */
  | { kind: 'face-force'; faces: number[]; force: [number, number, number] }
  /** A total force spread over the shape edges by length. */
  | { kind: 'edge-force'; edges: number[]; force: [number, number, number] }
  /** MPa on the shape faces, positive into the body. */
  | { kind: 'pressure'; faces: number[]; pressure: number }
  /** mm/s² on the whole body. */
  | { kind: 'gravity'; acceleration: [number, number, number] };
/** Components given per DOF on the nodes of shape faces or edges; null leaves one free. */
export interface ElasticConstraint {
  faces: number[];
  edges: number[];
  /** mm per component; null = free. Fixed is [0, 0, 0]. */
  displacement: [number | null, number | null, number | null];
}

/**
 * CR5a: a point-free added mass (t) spread over shape faces by area, e.g. an engine or a passenger
 * on its mounting faces. It takes part in gravity and in the mass matrix of a modal study, adds no
 * stiffness, and goes on the translations only.
 */
export interface AddedMass {
  faces: number[];
  mass: number;
}

export interface ElasticInput {
  mesh: FemMesh;
  material: ElasticMaterial;
  loads: ElasticLoad[];
  constraints: ElasticConstraint[];
  /** CR5a: added masses on shape faces. */
  masses?: AddedMass[];
  solver: { tolerance: number; maxIterations: number };
}

export interface ElasticResult {
  /** x, y, z per node (mm). */
  displacement: Float64Array;
  /** xx, yy, zz, xy, yz, zx per node (MPa), averaged over the elements around the node. */
  stress: Float64Array;
  vonMises: Float64Array;
  /** Reaction force per node DOF at constrained DOFs, 0 elsewhere (N). */
  reaction: Float64Array;
  /** Sum of the applied nodal forces and of the reactions (N). */
  appliedTotal: [number, number, number];
  reactionTotal: [number, number, number];
  /** What each load put on the mesh: the nodal force sum, and the area or length it used. */
  loadChecks: { force: [number, number, number]; measure: number }[];
  /** Nodes each constraint holds. */
  constrainedNodes: number[];
  iterations: number;
  /** Relative residual ‖b − Ku‖ / ‖b‖ on the free DOFs at the end. */
  residual: number;
  converged: boolean;
}

export type ElasticProblem =
  | 'rigid-body-mode'
  | 'no-constraint'
  | 'empty-target'
  /** A face tag or edge index the mesh's analysis shape does not have. */
  | 'target-index'
  /** Two constraints prescribe different values for the same node and direction. */
  | 'constraint-conflict'
  | 'material'
  | 'mesh-quality'
  /** R3j-3 (`solveBonded`): a solid face set to follow a shell. */
  | 'bond-kind'
  /** R3j-3: a dependent node farther from the side it follows than the bond's tolerance. */
  | 'bond-gap'
  /** R3j-3: bonds that make a DOF follow itself. */
  | 'bond-cycle'
  /** A4 acceptance (#890): a dependent node that two bonds tie to two different parts. */
  | 'bond-overlap'
  /** A4 acceptance (#890): bonded pieces that can still move against each other. */
  | 'bond-mechanism'
  /** R3j-3: a group of bonded bodies that no constraint holds. */
  | 'body-unconnected'
  /** R3j-5a: a shell the Host's solid wedges cannot carry (a sharp crease, a partly held rotation). */
  | 'host-shell';
/** A refusal before solving: nothing is computed. `modes` names the free rigid motions. */
export class ElasticError extends Error {
  constructor(
    readonly problem: ElasticProblem,
    readonly detail: string,
    readonly modes: string[] = [],
  ) {
    super(`${problem}: ${detail}`);
    this.name = 'ElasticError';
  }
}

/** 4-point Gauss rule on the unit tetrahedron (exact for degree 2), weights sum to 1/6. */
const ga = 0.5854101966249685,
  gb = 0.1381966011250105;
export const gaussPoints: readonly (readonly [number, number, number])[] = [
  [gb, gb, gb],
  [ga, gb, gb],
  [gb, ga, gb],
  [gb, gb, ga],
];
export const gaussWeight = 1 / 24;

/** Natural coordinates (ξ, η, ζ) of the 10 nodes in VTK order. */
/** The natural coordinates of a tet10's nodes: corners, then mid-edges in `tet10Edges` order. */
export const tet10Natural: readonly (readonly [number, number, number])[] = (() => {
  const c: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  return [
    ...c,
    ...tet10Edges.map(
      ([a, b]) => [0, 1, 2].map((d) => (c[a]![d]! + c[b]![d]!) / 2) as [number, number, number],
    ),
  ];
})();

/** Derivatives dN/d(ξ, η, ζ) of every shape function at a point, row-major [node][3]. */
function shapeDerivatives(type: 'tet4' | 'tet10', xi: number, eta: number, zeta: number) {
  const L = [1 - xi - eta - zeta, xi, eta, zeta];
  // dL_k / d(ξ, η, ζ)
  const dL = [
    [-1, -1, -1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  if (type === 'tet4') return dL.map((r) => r.slice());
  const out: number[][] = [];
  for (let k = 0; k < 4; k++) out.push(dL[k]!.map((d) => (4 * L[k]! - 1) * d));
  for (const [a, b] of tet10Edges)
    out.push([0, 1, 2].map((d) => 4 * (dL[a]![d]! * L[b]! + L[a]! * dL[b]![d]!)));
  return out;
}

/** dN/dx for every node at one point, and det J; throws on a non-positive Jacobian. */
export function shapeGradients(
  mesh: FemMesh,
  e: number,
  npe: number,
  natural: readonly [number, number, number],
): { dN: number[][]; det: number } {
  const dNn = shapeDerivatives(mesh.type, natural[0], natural[1], natural[2]);
  const J = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let a = 0; a < npe; a++) {
    const p = mesh.elements[e * npe + a]! * 3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) J[i]![j]! += dNn[a]![i]! * mesh.nodes[p + j]!;
  }
  // J[i][j] = d x_j / d ξ_i ; dN/dx = J⁻¹ dN/dξ
  const [[a, b, c], [d, f, g], [h, k, l]] = J as [number[], number[], number[]] as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  const det = a * (f * l - g * k) - b * (d * l - g * h) + c * (d * k - f * h);
  if (!(det > 0))
    throw new ElasticError('mesh-quality', `element ${e} has a non-positive Jacobian`);
  const inv = [
    [(f * l - g * k) / det, (c * k - b * l) / det, (b * g - c * f) / det],
    [(g * h - d * l) / det, (a * l - c * h) / det, (c * d - a * g) / det],
    [(d * k - f * h) / det, (b * h - a * k) / det, (a * f - b * d) / det],
  ];
  const dN = dNn.map((r) =>
    [0, 1, 2].map((i) => inv[i]![0]! * r[0]! + inv[i]![1]! * r[1]! + inv[i]![2]! * r[2]!),
  );
  return { dN, det };
}

/** det J at one natural point of an element (no sign check). */
function detAt(mesh: FemMesh, e: number, npe: number, at: readonly number[]): number {
  const dNn = shapeDerivatives(mesh.type, at[0]!, at[1]!, at[2]!);
  const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let a = 0; a < npe; a++) {
    const p = mesh.elements[e * npe + a]! * 3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) J[3 * i + j]! += dNn[a]![i]! * mesh.nodes[p + j]!;
  }
  const [a, b, c, d, f, g, h, k, l] = J as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return a * (f * l - g * k) - b * (d * l - g * h) + c * (d * k - f * h);
}

/**
 * det J of a tet10 is a cubic in the barycentric coordinates. Its values at the 20 points of the
 * cubic lattice give its Bernstein coefficients (`bernsteinOfLattice` × values); det J lies in
 * their convex hull, so the smallest coefficient is a lower bound of det J over the element.
 */
const cubicLattice: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (let a = 0; a <= 3; a++)
    for (let b = 0; a + b <= 3; b++)
      for (let c = 0; a + b + c <= 3; c++) out.push([3 - a - b - c, a, b, c]);
  return out;
})();
const bernsteinOfLattice: readonly (readonly number[])[] = (() => {
  const fact = [1, 1, 2, 6];
  const n = cubicLattice.length;
  // M[k][β] = B_β(λ_k): the Bernstein polynomials at the lattice points.
  const M = cubicLattice.map((pt) =>
    cubicLattice.map((beta) => {
      let v = 6;
      for (let i = 0; i < 4; i++) v *= (pt[i]! / 3) ** beta[i]! / fact[beta[i]!]!;
      return v;
    }),
  );
  const inv = cubicLattice.map((_, r) => cubicLattice.map((__, c) => (r === c ? 1 : 0)));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    [inv[c], inv[piv]] = [inv[piv]!, inv[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < n; k++) {
      M[c]![k]! /= d;
      inv[c]![k]! /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const q = M[r]![c]!;
      if (q === 0) continue;
      for (let k = 0; k < n; k++) {
        M[r]![k]! -= q * M[c]![k]!;
        inv[r]![k]! -= q * inv[c]![k]!;
      }
    }
  }
  return inv;
})();

/**
 * The smallest `jacobianRatio` a curved tet10 may keep (R3d-2b): below it the element is near a
 * fold, its stresses blow up (FX3 at the finest level had one at 2e-6 with a 100× von Mises peak),
 * so the mesher puts its mid nodes back on the straight edges. Straight elements are 1.
 */
export const curvedJacobianMin = 0.1;

/**
 * A lower bound of det J over the whole element (R3d-2a), relative to the corner tetrahedron's
 * det J (6 × its volume): 1 for a straight-sided element, and > 0 guarantees that a curved tet10
 * does not fold anywhere. It is conservative: an element with a small negative coefficient but a
 * positive det J everywhere is also reported as ≤ 0.
 */
export function jacobianRatio(mesh: FemMesh, e: number): number {
  const npe = mesh.type === 'tet4' ? 4 : 10;
  const corner = cornerVolume6(mesh.nodes, mesh.elements, npe, e);
  if (!(corner > 0)) return -Infinity;
  if (mesh.type === 'tet4') return 1;
  const values = cubicLattice.map((pt) => detAt(mesh, e, npe, [pt[1] / 3, pt[2] / 3, pt[3] / 3]));
  let min = Infinity;
  for (const row of bernsteinOfLattice) {
    let c = 0;
    for (let k = 0; k < values.length; k++) c += row[k]! * values[k]!;
    min = Math.min(min, c);
  }
  return min / corner;
}

/** Gauss–Legendre points and weights on [0, 1] (4 points: exact to degree 7). */
const legendre4 = (() => {
  const x = [0.3399810435848563, 0.8611363115940526];
  const w = [0.6521451548625461, 0.3478548451374538];
  const pts = [-x[1]!, -x[0]!, x[0]!, x[1]!].map((t) => (t + 1) / 2);
  const wts = [w[1]!, w[0]!, w[0]!, w[1]!].map((t) => t / 2);
  return pts.map((t, i) => [t, wts[i]!] as const);
})();
/**
 * A collapsed (Duffy) rule on the reference tetrahedron: exact for polynomials of degree 5,
 * enough for ∫ N_a det J of a curved tet10 (quadratic × cubic). Weights sum to 1/6.
 */
const tetRule: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (const [u, wu] of legendre4)
    for (const [v, wv] of legendre4)
      for (const [w, ww] of legendre4)
        out.push([u, v * (1 - u), w * (1 - u) * (1 - v), wu * wv * ww * (1 - u) ** 2 * (1 - v)]);
  return out;
})();
/** The same on the reference triangle: exact to degree 7 in each collapsed variable. */
const triangleRule: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const [u, wu] of legendre4)
    for (const [v, wv] of legendre4) out.push([u, v * (1 - u), wu * wv * (1 - u)]);
  return out;
})();

/** Shape function values of an element at a natural point, in node order. */
function shapeValues(type: 'tet4' | 'tet10', xi: number, eta: number, zeta: number): number[] {
  const L = [1 - xi - eta - zeta, xi, eta, zeta];
  if (type === 'tet4') return L;
  return [...L.map((l) => l * (2 * l - 1)), ...tet10Edges.map(([a, b]) => 4 * L[a]! * L[b]!)];
}

/** The volume of an isoparametric mesh (mm³), curved tet10 sides included (exact for tet10). */
export function femGaussVolume(mesh: FemMesh): number {
  const npe = mesh.type === 'tet4' ? 4 : 10;
  let v = 0;
  for (let e = 0; e < mesh.elements.length / npe; e++)
    for (const [x, y, z, w] of tetRule) v += detAt(mesh, e, npe, [x, y, z]) * w;
  return v;
}

/** The isotropic elasticity matrix D (Voigt order xx, yy, zz, xy, yz, zx; engineering shear). */
function elasticity(m: ElasticMaterial): number[][] {
  const { youngsModulus: E, poissonsRatio: v } = m;
  const c = E / ((1 + v) * (1 - 2 * v));
  const D = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) D[i]![j] = c * (i === j ? 1 - v : v);
    D[i + 3]![i + 3] = (c * (1 - 2 * v)) / 2;
  }
  return D;
}

/** Strain-displacement product: ε (Voigt) of the displacement `u` at one point. */
function strainAt(dN: number[][], u: (a: number, i: number) => number): number[] {
  const s = [0, 0, 0, 0, 0, 0];
  dN.forEach(([x, y, z], a) => {
    const ux = u(a, 0),
      uy = u(a, 1),
      uz = u(a, 2);
    s[0]! += x! * ux;
    s[1]! += y! * uy;
    s[2]! += z! * uz;
    s[3]! += y! * ux + x! * uy;
    s[4]! += z! * uy + y! * uz;
    s[5]! += z! * ux + x! * uz;
  });
  return s;
}

export const vonMisesOf = (s: ArrayLike<number>, o = 0) => {
  const [xx, yy, zz, xy, yz, zx] = [0, 1, 2, 3, 4, 5].map((k) => s[o + k]!);
  return Math.sqrt(
    0.5 * ((xx! - yy!) ** 2 + (yy! - zz!) ** 2 + (zz! - xx!) ** 2) +
      3 * (xy! ** 2 + yz! ** 2 + zx! ** 2),
  );
};

/**
 * R3e-5d: the principal stresses of one Voigt stress (xx, yy, zz, xy, yz, zx), largest first: the
 * eigenvalues of the symmetric tensor by the trigonometric solution of its characteristic cubic.
 */
export function principalOf(s: ArrayLike<number>, o = 0): [number, number, number] {
  const [xx, yy, zz, xy, yz, zx] = [0, 1, 2, 3, 4, 5].map((k) => s[o + k]!) as number[];
  const off = xy! ** 2 + yz! ** 2 + zx! ** 2;
  if (off === 0) {
    const d = [xx!, yy!, zz!].sort((a, b) => b - a);
    return [d[0]!, d[1]!, d[2]!];
  }
  const q = (xx! + yy! + zz!) / 3;
  const p = Math.sqrt(((xx! - q) ** 2 + (yy! - q) ** 2 + (zz! - q) ** 2 + 2 * off) / 6);
  if (p === 0) return [q, q, q];
  // det((A - qI) / p) / 2, clamped against rounding.
  const [a, b, c] = [(xx! - q) / p, (yy! - q) / p, (zz! - q) / p];
  const [d, e, f] = [xy! / p, yz! / p, zx! / p];
  const r = Math.min(
    1,
    Math.max(-1, (a * (b * c - e * e) - d * (d * c - e * f) + f * (d * e - b * f)) / 2),
  );
  const phi = Math.acos(r) / 3;
  const s1 = q + 2 * p * Math.cos(phi);
  const s3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [s1, 3 * q - s1 - s3, s3];
}

/** Per node, the largest and the smallest principal stress of a nodal Voigt stress field. */
export function principalStresses(stress: Float64Array): { max: Float64Array; min: Float64Array } {
  const n = stress.length / 6;
  const max = new Float64Array(n);
  const min = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [s1, , s3] = principalOf(stress, i * 6);
    max[i] = s1;
    min[i] = s3;
  }
  return { max, min };
}

/** Corner nodes (VTK order) and, for tet10, the mid-edge nodes of a local face. */
function faceNodes(mesh: FemMesh, e: number, lf: number): { corners: number[]; mids: number[] } {
  const npe = nodesPerElement(mesh.type);
  const f = localFaces[lf]!;
  const corners = f.map((c) => mesh.elements[e * npe + c]!);
  if (mesh.type === 'tet4') return { corners, mids: [] };
  const mids = [0, 1, 2].map((k) => {
    const a = f[k]!,
      b = f[(k + 1) % 3]!;
    const s = tet10Edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
    return mesh.elements[e * npe + 4 + s]!;
  });
  return { corners, mids };
}
const cross = (u: number[], v: number[]) => [
  u[1]! * v[2]! - u[2]! * v[1]!,
  u[2]! * v[0]! - u[0]! * v[2]!,
  u[0]! * v[1]! - u[1]! * v[0]!,
];

/**
 * The quadrature points of a boundary face over its curved (tet10) or flat (tet4) geometry: the
 * face's nodes (corners, then mid-edges), and at each point the face shape values N_a and the
 * outward normal times the point's area weight (|normal| is dA).
 */
export function boundaryFacePoints(
  mesh: FemMesh,
  e: number,
  lf: number,
): { nodes: number[]; points: { N: number[]; normal: number[] }[] } {
  const { corners, mids } = faceNodes(mesh, e, lf);
  const nodes = [...corners, ...mids];
  const points: { N: number[]; normal: number[] }[] = [];
  for (const [xi, eta, w] of triangleRule) {
    const L = [1 - xi - eta, xi, eta];
    // dL/dξ, dL/dη
    const dL = [
      [-1, -1],
      [1, 0],
      [0, 1],
    ];
    const N: number[] = [];
    const dN: number[][] = [];
    if (mesh.type === 'tet4') {
      N.push(...L);
      dN.push(...dL);
    } else {
      for (let k = 0; k < 3; k++) {
        N.push(L[k]! * (2 * L[k]! - 1));
        dN.push(dL[k]!.map((d) => (4 * L[k]! - 1) * d));
      }
      for (let k = 0; k < 3; k++) {
        const n = (k + 1) % 3;
        N.push(4 * L[k]! * L[n]!);
        dN.push([0, 1].map((d) => 4 * (dL[k]![d]! * L[n]! + L[k]! * dL[n]![d]!)));
      }
    }
    const tu = [0, 0, 0],
      tv = [0, 0, 0];
    nodes.forEach((p, a) => {
      for (let d = 0; d < 3; d++) {
        tu[d]! += dN[a]![0]! * mesh.nodes[3 * p + d]!;
        tv[d]! += dN[a]![1]! * mesh.nodes[3 * p + d]!;
      }
    });
    points.push({ N, normal: cross(tu, tv).map((x) => x * w) });
  }
  return { nodes, points };
}

/**
 * The (element, local face) pairs of the boundary faces tagged with the shape faces `faces`;
 * refuses a face index the mesh's analysis shape does not have (`target-index`).
 */
export function boundaryFaceList(mesh: FemMesh, faces: readonly number[]) {
  for (const f of faces)
    if (!Number.isInteger(f) || f < 0 || f >= mesh.shapeFaces)
      throw new ElasticError('target-index', `face ${f} is not in 0..${mesh.shapeFaces - 1}`);
  const want = new Set(faces);
  const out: { e: number; lf: number }[] = [];
  for (let i = 0; i < mesh.boundary.tags.length; i++)
    if (want.has(mesh.boundary.tags[i]!))
      out.push({ e: mesh.boundary.elements[i]!, lf: mesh.boundary.localFaces[i]! });
  return out;
}

/**
 * A study turned into nodal data: the prescribed DOF values and the consistent nodal forces of all
 * loads. The browser solver and the `.inp` export (R3f) use the same data, so both solve the same
 * discrete problem.
 */
export interface ElasticPrepared {
  /** DOF (3 · node + direction) → prescribed displacement (mm). */
  prescribed: Map<number, number>;
  /** Nodal force per DOF (N). */
  force: Float64Array;
  loadChecks: ElasticResult['loadChecks'];
  constrainedNodes: number[];
  /** CR5a: the added masses per node (t), 0 where none. */
  added?: Float64Array;
}

/**
 * CR5a: the added masses per node (t): each mass spread over its faces by the consistent shares
 * ∫ N_a dA / A (tet4 A/3 at the corners; tet10 on a flat face all at the mid-edges). Refuses a mass
 * ≤ 0 or not finite (`material`), a face the mesh does not have (`target-index`) and faces with no
 * boundary triangle (`empty-target`).
 */
export function solidAddedMasses(mesh: FemMesh, masses: readonly AddedMass[] = []): Float64Array {
  const out = new Float64Array(mesh.nodes.length / 3);
  masses.forEach((m, k) => {
    if (!(m.mass > 0) || !Number.isFinite(m.mass))
      throw new ElasticError('material', `added mass ${k} is ${m.mass} t: it must be > 0`);
    const share = new Map<number, number>();
    let area = 0;
    for (const { e, lf } of boundaryFaceList(mesh, m.faces)) {
      const { nodes, points } = boundaryFacePoints(mesh, e, lf);
      for (const { N, normal } of points) {
        const dA = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
        area += dA;
        nodes.forEach((p, a) => share.set(p, (share.get(p) ?? 0) + N[a]! * dA));
      }
    }
    if (!(area > 0)) throw new ElasticError('empty-target', `added mass ${k} is on no face`);
    // A tet10 corner's share is 0 on a flat face and may be slightly negative on a curved one: a
    // nodal mass is never negative, so those go to 0 and the rest is scaled to the whole mass.
    let kept = 0;
    for (const a of share.values()) if (a > 1e-12 * area) kept += a;
    for (const [p, a] of share) if (a > 1e-12 * area) out[p]! += (a / kept) * m.mass;
  });
  return out;
}

/** CR5a: adds nodal masses (t) to the translations of a mass matrix with `perNode` DOFs per node. */
export function addNodalMasses(
  M: CsrMatrix,
  added: Float64Array | undefined,
  perNode: number,
  offset = 0,
) {
  added?.forEach((m, p) => {
    if (m) for (let i = 0; i < 3; i++) M.add(offset + perNode * p + i, offset + perNode * p + i, m);
  });
}

/**
 * Checks a study and maps its loads and constraints to nodes. Refuses, before any solving, a
 * constraint set that leaves a rigid motion free (`rigid-body-mode`, with the free motions), an
 * empty target, a folded curved element, and a material outside −1 < ν < 0.5, E > 0.
 */
export function prepareElastic(
  input: Omit<ElasticInput, 'solver'>,
  /**
   * R3j-3: `bonded` for a body held through bonds to others (`solveBonded`): it may have no
   * constraint, and its rigid motions are left to the bonded model's own check.
   */
  options: { bonded?: boolean } = {},
): ElasticPrepared {
  const { mesh, material } = input;
  const { youngsModulus: E, poissonsRatio: nu } = material;
  if (!(E > 0) || !(nu > -1 && nu < 0.5) || !(material.density >= 0))
    throw new ElasticError('material', 'E > 0 and −1 < ν < 0.5');
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const dofs = 3 * n;
  // A curved tet10 folded anywhere inside (not only at the Gauss points) is refused.
  if (mesh.type === 'tet10')
    for (let e = 0; e < m; e++)
      if (!(jacobianRatio(mesh, e) > 0))
        throw new ElasticError('mesh-quality', `element ${e} may fold (det J bound ≤ 0)`);

  // Faces and edges → nodes.
  const index = (k: number, count: number, what: string) => {
    if (!Number.isInteger(k) || k < 0 || k >= count)
      throw new ElasticError('target-index', `${what} ${k} is not in 0..${count - 1}`);
  };
  const faceList = (faces: number[]) => {
    for (const f of faces) index(f, mesh.shapeFaces, 'face');
    const want = new Set(faces);
    const out: { e: number; lf: number }[] = [];
    for (let i = 0; i < mesh.boundary.tags.length; i++)
      if (want.has(mesh.boundary.tags[i]!))
        out.push({ e: mesh.boundary.elements[i]!, lf: mesh.boundary.localFaces[i]! });
    return out;
  };
  const edgeChain = (k: number) => {
    index(k, mesh.shapeEdges, 'edge');
    return [...mesh.edges.nodes.subarray(mesh.edges.offsets[k]!, mesh.edges.offsets[k + 1]!)];
  };

  // Constraints first: a rigid motion left free is refused before assembly.
  if (!input.constraints.length && !options.bonded)
    throw new ElasticError('no-constraint', 'no constraint holds the body');
  const prescribed = new Map<number, number>();
  const constrainedNodes: number[] = [];
  input.constraints.forEach((c, ci) => {
    const nodes = new Set<number>();
    for (const { e, lf } of faceList(c.faces)) {
      const { corners, mids } = faceNodes(mesh, e, lf);
      for (const p of [...corners, ...mids]) nodes.add(p);
    }
    for (const k of c.edges) for (const p of edgeChain(k)) nodes.add(p);
    if (!nodes.size) throw new ElasticError('empty-target', `constraint ${ci} holds no node`);
    constrainedNodes.push(nodes.size);
    for (const p of nodes)
      c.displacement.forEach((v, i) => {
        if (v === null) return;
        const before = prescribed.get(p * 3 + i);
        if (before !== undefined && before !== v)
          throw new ElasticError(
            'constraint-conflict',
            `constraint ${ci} gives node ${p} direction ${'xyz'[i]} ${v}, another gave ${before}`,
          );
        prescribed.set(p * 3 + i, v);
      });
  });
  // Each connected piece of the mesh must be held on its own: holding one piece leaves another
  // free to move however well the first is held.
  const pieces = options.bonded ? { count: 0, label: new Int32Array(0) } : meshComponents(mesh);
  for (let k = 0; k < pieces.count; k++) {
    const held = new Map<number, number>();
    for (const [d, v] of prescribed) if (pieces.label[Math.floor(d / 3)] === k) held.set(d, v);
    const free = freeRigidModes(mesh.nodes, held);
    if (free.length)
      throw new ElasticError(
        'rigid-body-mode',
        `${pieces.count > 1 ? `piece ${k + 1} of ${pieces.count} is ` : ''}free: ${free.join(', ')}`,
        free,
      );
  }

  const added = solidAddedMasses(mesh, input.masses);

  // Loads.
  const conn = (e: number) => mesh.elements.subarray(e * npe, (e + 1) * npe);
  const f = new Float64Array(dofs);
  const loadChecks: ElasticResult['loadChecks'] = [];
  const addForce = (p: number, v: number[], s: number) => {
    for (let i = 0; i < 3; i++) f[p * 3 + i]! += v[i]! * s;
  };
  /**
   * A boundary face's nodes with ∫ N_a dA and ∫ N_a n dA (n outward) over its curved (tet10) or
   * flat (tet4) geometry, and its area. On a straight face this gives the consistent shares:
   * tet4 A/3 at the corners; tet10 0 at the corners, A/3 at the mid-edges.
   */
  const triangle = (e: number, lf: number) => {
    const { nodes, points } = boundaryFacePoints(mesh, e, lf);
    const shares = new Array<number>(nodes.length).fill(0);
    const vectors = nodes.map(() => [0, 0, 0]);
    let area = 0;
    for (const { N, normal } of points) {
      const dA = Math.hypot(...normal);
      area += dA;
      N.forEach((na, a) => {
        shares[a]! += na * dA;
        for (let d = 0; d < 3; d++) vectors[a]![d]! += na * normal[d]!;
      });
    }
    return { nodes, shares, vectors, area };
  };
  for (const [li, load] of input.loads.entries()) {
    const before = [0, 1, 2].map((i) => f.reduce((s, x, k) => (k % 3 === i ? s + x : s), 0));
    let measure = 0;
    if (load.kind === 'face-force' || load.kind === 'pressure') {
      const tris = faceList(load.faces).map(({ e, lf }) => triangle(e, lf));
      if (!tris.length) throw new ElasticError('empty-target', `load ${li} is on no face`);
      measure = tris.reduce((s, t) => s + t.area, 0);
      // A pressure pushes against the outward normal; a force is a uniform traction over the area.
      for (const t of tris)
        t.nodes.forEach((p, a) =>
          load.kind === 'pressure'
            ? addForce(p, t.vectors[a]!, -load.pressure)
            : addForce(p, load.force, t.shares[a]! / measure),
        );
    } else if (load.kind === 'edge-force') {
      const segs: number[][] = [];
      const step = mesh.type === 'tet4' ? 1 : 2;
      for (const k of load.edges) {
        const c = edgeChain(k);
        for (let s = 0; s + step < c.length; s += step) segs.push(c.slice(s, s + step + 1));
      }
      if (!segs.length) throw new ElasticError('empty-target', `load ${li} is on no edge`);
      /** ∫ N_a ds along a 2- or 3-node segment, curved when its mid node is off the chord. */
      const sharesOf = (seg: number[]) => {
        const out = seg.map(() => 0);
        for (const [t, w] of legendre4) {
          const N =
            seg.length === 2
              ? [1 - t, t]
              : [(1 - t) * (1 - 2 * t), 4 * t * (1 - t), t * (2 * t - 1)];
          const dN = seg.length === 2 ? [-1, 1] : [4 * t - 3, 4 - 8 * t, 4 * t - 1];
          const tangent = [0, 1, 2].map((d) =>
            seg.reduce((acc, p, a) => acc + dN[a]! * mesh.nodes[3 * p + d]!, 0),
          );
          const ds = Math.hypot(...tangent) * w;
          N.forEach((n, a) => (out[a]! += n * ds));
        }
        return out;
      };
      const shares = segs.map(sharesOf);
      measure = shares.reduce((acc, sh) => acc + sh.reduce((x, y) => x + y, 0), 0);
      const q = load.force.map((x) => x / measure);
      segs.forEach((seg, k) => seg.forEach((p, a) => addForce(p, q, shares[k]![a]!)));
    } else {
      const body = load.acceleration.map((a) => a * material.density);
      for (let e = 0; e < m; e++) {
        const nodes = conn(e);
        // Consistent shares ∫ N_a dV (straight: tet4 V/4; tet10 corners −V/20, mid-edges V/5).
        for (const [x, y, z, w] of tetRule) {
          const dV = detAt(mesh, e, npe, [x, y, z]) * w;
          measure += dV;
          shapeValues(mesh.type, x, y, z).forEach((n, a) => addForce(nodes[a]!, body, n * dV));
        }
      }
      // CR5a: the added masses fall with the body.
      added.forEach((mass, p) => mass && addForce(p, load.acceleration, mass));
    }
    const after = [0, 1, 2].map((i) => f.reduce((s, x, k) => (k % 3 === i ? s + x : s), 0));
    loadChecks.push({
      force: [0, 1, 2].map((i) => after[i]! - before[i]!) as [number, number, number],
      measure,
    });
  }

  return { prescribed, force: f, loadChecks, constrainedNodes, added };
}

/**
 * Solves K u = f with the constraints applied by elimination, after `prepareElastic` has checked
 * and mapped the study.
 */
export function solveElastic(input: ElasticInput): ElasticResult {
  const { mesh, material } = input;
  const { prescribed, force: f, loadChecks, constrainedNodes } = prepareElastic(input);
  const dofs = mesh.nodes.length;

  // Assembly.
  const K = assembleStiffness(mesh, material);

  // Elimination: u = prescribed on constrained DOFs, solve the free DOFs.
  const u = new Float64Array(dofs);
  for (const [d, v] of prescribed) u[d] = v;
  const isFree = new Uint8Array(dofs).fill(1);
  for (const d of prescribed.keys()) isFree[d] = 0;
  const Ku0 = K.multiply(u);
  const b = new Float64Array(dofs);
  for (let d = 0; d < dofs; d++) b[d] = isFree[d] ? f[d]! - Ku0[d]! : 0;
  const solved = pcg(K, b, isFree, input.solver.tolerance, input.solver.maxIterations);
  for (let d = 0; d < dofs; d++) if (isFree[d]) u[d] = solved.x[d]!;

  const Ku = K.multiply(u);
  const reaction = new Float64Array(dofs);
  for (const d of prescribed.keys()) reaction[d] = Ku[d]! - f[d]!;
  const total = (v: Float64Array) =>
    [0, 1, 2].map((i) => v.reduce((s, x, k) => (k % 3 === i ? s + x : s), 0)) as [
      number,
      number,
      number,
    ];

  const { stress, vonMises } = elasticStress(mesh, material, u);
  return {
    displacement: u,
    stress,
    vonMises,
    reaction,
    appliedTotal: total(f),
    reactionTotal: total(reaction),
    loadChecks,
    constrainedNodes,
    iterations: solved.iterations,
    residual: solved.residual,
    converged: solved.converged,
  };
}

/**
 * Stresses at the nodes of each element (tet10 strain is linear, so nodal values are exact for the
 * element), averaged over the elements around a node, and their von Mises values.
 */
export function elasticStress(
  mesh: FemMesh,
  material: ElasticMaterial,
  u: Float64Array,
): { stress: Float64Array; vonMises: Float64Array } {
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const conn = (e: number) => mesh.elements.subarray(e * npe, (e + 1) * npe);
  const D = elasticity(material);
  const stress = new Float64Array(6 * n);
  const count = new Uint32Array(n);
  const natural = mesh.type === 'tet4' ? tet10Natural.slice(0, 4) : tet10Natural;
  for (let e = 0; e < m; e++) {
    const nodes = conn(e);
    natural.forEach((pt, a) => {
      const { dN } = shapeGradients(mesh, e, npe, pt);
      const eps = strainAt(dN, (k, i) => u[nodes[k]! * 3 + i]!);
      const p = nodes[a]!;
      for (let r = 0; r < 6; r++)
        stress[p * 6 + r]! += D[r]!.reduce((s, d, k) => s + d * eps[k]!, 0);
      count[p]!++;
    });
  }
  const vonMises = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    for (let r = 0; r < 6; r++) stress[p * 6 + r]! /= Math.max(1, count[p]!);
    vonMises[p] = vonMisesOf(stress, p * 6);
  }
  return { stress, vonMises };
}

/** The stiffness matrix K (N/mm) of an isotropic linear elastic solid, 3 DOFs per node. */
export function assembleStiffness(mesh: FemMesh, material: ElasticMaterial): CsrMatrix {
  const { youngsModulus: E, poissonsRatio: nu } = material;
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const dofs = 3 * n;
  const conn = (e: number) => mesh.elements.subarray(e * npe, (e + 1) * npe);
  const K = new CsrMatrix(csrPattern(dofs, m, (e) => conn(e), npe));
  // Isotropic: K_ab,ij = w (λ ∂_i N_a ∂_j N_b + μ ∂_j N_a ∂_i N_b + μ δ_ij ∇N_a·∇N_b).
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  const size = 3 * npe;
  const ke = new Float64Array(size * size);
  for (let e = 0; e < m; e++) {
    ke.fill(0);
    for (const g of gaussPoints) {
      const { dN, det } = shapeGradients(mesh, e, npe, g);
      const w = det * gaussWeight;
      for (let a = 0; a < npe; a++) {
        const ga = dN[a]!;
        for (let b = 0; b < npe; b++) {
          const gb = dN[b]!;
          const dot = ga[0]! * gb[0]! + ga[1]! * gb[1]! + ga[2]! * gb[2]!;
          for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
              ke[(a * 3 + i) * size + b * 3 + j]! +=
                w * (lambda * ga[i]! * gb[j]! + mu * ga[j]! * gb[i]! + (i === j ? mu * dot : 0));
        }
      }
    }
    const nodes = conn(e);
    for (let a = 0; a < npe; a++)
      for (let i = 0; i < 3; i++)
        for (let b = 0; b < npe; b++)
          for (let j = 0; j < 3; j++)
            K.add(nodes[a]! * 3 + i, nodes[b]! * 3 + j, ke[(a * 3 + i) * size + b * 3 + j]!);
  }

  return K;
}

/**
 * The consistent mass matrix M (t) of a solid of `density` (t/mm³): M_ab,ij = ρ ∫ N_a N_b dV δ_ij,
 * in the same pattern as `assembleStiffness`; its entries in one direction sum to ρ V.
 */
/**
 * R3j-5c: each node's row sum of the consistent mass, ρ ∫ N_a dV (t): M r for a uniform
 * translation r, so φᵀ M r = Σ m_p φ_p for any φ, held rows included.
 */
export function nodalMasses(mesh: FemMesh, density: number): Float64Array {
  const npe = nodesPerElement(mesh.type);
  const out = new Float64Array(mesh.nodes.length / 3);
  for (let e = 0; e < mesh.elements.length / npe; e++)
    for (const [x, y, z, w] of tetRule) {
      const dV = detAt(mesh, e, npe, [x, y, z]) * w * density;
      shapeValues(mesh.type, x, y, z).forEach((n, a) => {
        out[mesh.elements[e * npe + a]!]! += n * dV;
      });
    }
  return out;
}

export function assembleMass(mesh: FemMesh, density: number): CsrMatrix {
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const conn = (e: number) => mesh.elements.subarray(e * npe, (e + 1) * npe);
  const M = new CsrMatrix(csrPattern(3 * n, m, (e) => conn(e), npe));
  const me = new Float64Array(npe * npe);
  for (let e = 0; e < m; e++) {
    me.fill(0);
    for (const [x, y, z, w] of tetRule) {
      const dV = detAt(mesh, e, npe, [x, y, z]) * w * density;
      const N = shapeValues(mesh.type, x, y, z);
      for (let a = 0; a < npe; a++)
        for (let b = 0; b < npe; b++) me[a * npe + b]! += N[a]! * N[b]! * dV;
    }
    const nodes = conn(e);
    for (let a = 0; a < npe; a++)
      for (let b = 0; b < npe; b++)
        for (let i = 0; i < 3; i++) M.add(nodes[a]! * 3 + i, nodes[b]! * 3 + i, me[a * npe + b]!);
  }
  return M;
}

/**
 * The rigid motions (3 translations, 3 rotations about the centroid of the held nodes) that the
 * prescribed DOFs do not stop, as an orthonormal basis named by its largest component.
 */
/**
 * The connected pieces of a mesh: nodes joined through shared elements get the same label, from 0,
 * in order of their first node. A node in no element is a piece of its own.
 */
export function meshComponents(mesh: FemMesh): { label: Int32Array; count: number } {
  const n = mesh.nodes.length / 3;
  const npe = nodesPerElement(mesh.type);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let e = 0; e < mesh.elements.length / npe; e++) {
    const a = find(mesh.elements[e * npe]!);
    for (let k = 1; k < npe; k++) {
      const b = find(mesh.elements[e * npe + k]!);
      if (a !== b) parent[b] = a;
    }
  }
  const label = new Int32Array(n).fill(-1);
  const root = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!root.has(r)) root.set(r, root.size);
    label[i] = root.get(r)!;
  }
  return { label, count: root.size };
}

export function freeRigidModes(nodes: Float64Array, prescribed: Map<number, number>): string[] {
  if (!prescribed.size)
    return [
      'translation x',
      'translation y',
      'translation z',
      'rotation x',
      'rotation y',
      'rotation z',
    ];
  const c = [0, 0, 0];
  const held = new Set<number>();
  for (const d of prescribed.keys()) held.add(Math.floor(d / 3));
  for (const p of held) for (let i = 0; i < 3; i++) c[i]! += nodes[p * 3 + i]! / held.size;
  let scale = 0;
  for (const p of held)
    scale = Math.max(scale, Math.hypot(...[0, 1, 2].map((i) => nodes[p * 3 + i]! - c[i]!)));
  scale = scale || 1;
  // Normal matrix G = Cᵀ C (6×6) of the modes evaluated at the prescribed DOFs (rotation scaled).
  const G = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const d of prescribed.keys()) {
    const p = Math.floor(d / 3),
      i = d % 3;
    const r = [0, 1, 2].map((k) => (nodes[p * 3 + k]! - c[k]!) / scale);
    // Translation j moves DOF i by δ_ij; rotation about axis j moves it by (e_j × r)_i.
    const row = [0, 1, 2]
      .map((j): number => (i === j ? 1 : 0))
      .concat(
        [0, 1, 2].map((j) => {
          const e = [0, 0, 0];
          e[j] = 1;
          return cross(e, r)[i]!;
        }),
      );
    for (let a = 0; a < 6; a++) for (let b2 = 0; b2 < 6; b2++) G[a]![b2]! += row[a]! * row[b2]!;
  }
  // Eigen-decompose G (Jacobi); eigenvectors with tiny eigenvalues are free motions.
  const { values, vectors } = jacobiEigen(G);
  const top = Math.max(...values);
  const names = [
    'translation x',
    'translation y',
    'translation z',
    'rotation x',
    'rotation y',
    'rotation z',
  ];
  const out: string[] = [];
  values.forEach((v, k) => {
    if (v <= 1e-10 * Math.max(top, 1)) {
      const vec = vectors.map((row) => row[k]!);
      let best = 0;
      vec.forEach((x, j) => {
        if (Math.abs(x) > Math.abs(vec[best]!)) best = j;
      });
      out.push(names[best]!);
    }
  });
  return out;
}

/** Eigenvalues and eigenvectors (columns) of a small symmetric matrix, cyclic Jacobi. */
function jacobiEigen(A0: number[][]) {
  const n = A0.length;
  const A = A0.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p]![q]!) < 1e-300) continue;
        const theta = (A[q]![q]! - A[p]![p]!) / (2 * A[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1),
          sn = t * cs;
        for (let k = 0; k < n; k++) {
          const akp = A[k]![p]!,
            akq = A[k]![q]!;
          A[k]![p] = cs * akp - sn * akq;
          A[k]![q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p]![k]!,
            aqk = A[q]![k]!;
          A[p]![k] = cs * apk - sn * aqk;
          A[q]![k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k]![p]!,
            vkq = V[k]![q]!;
          V[k]![p] = cs * vkp - sn * vkq;
          V[k]![q] = sn * vkp + cs * vkq;
        }
      }
  }
  return { values: A.map((r, i) => r[i]!), vectors: V };
}

/**
 * The equilibrium check of the design (解法と検査): |applied + reactions| within 1e-6 × the
 * larger of |applied| and the sum of the reaction magnitudes per node. Normalising by the
 * reactions too lets a study with prescribed displacements only be checked.
 */
export function equilibriumCheck(
  r: ElasticResult,
  /** Relative imbalance allowed; a result read from text with fewer digits needs more. */
  relative = 1e-6,
): {
  pass: boolean;
  imbalance: number;
  scale: number;
} {
  const sum = r.appliedTotal.map((f, i) => f + r.reactionTotal[i]!);
  let reactions = 0;
  for (let p = 0; p < r.reaction.length / 3; p++)
    reactions += Math.hypot(r.reaction[3 * p]!, r.reaction[3 * p + 1]!, r.reaction[3 * p + 2]!);
  const scale = Math.max(Math.hypot(...r.appliedTotal), reactions);
  const imbalance = Math.hypot(...sum);
  return { pass: imbalance <= relative * scale, imbalance, scale };
}
