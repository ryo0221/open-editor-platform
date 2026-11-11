import {
  addNodalMasses,
  ElasticError,
  vonMisesOf,
  type AddedMass,
  type ElasticMaterial,
} from './elastic';
import { lowestModes, modalSummary, type ModalMode } from './modal';
import { CsrMatrix, csrPattern, incompleteFactor, pcg } from './sparse';

/**
 * R3i-1 (docs/cad/r3-analysis.md, A3): linear static and modal analysis of thin shells on a mesh
 * of flat three-node triangles, 6 DOFs per node (x, y, z translations and rotations, global
 * axes). An element is an Allman membrane (in-plane rotation from the LST, drilling stiffness
 * included) plus a DKT plate (discrete Kirchhoff, Batoz 1980) in its own plane. Units mm–N–MPa–t–s.
 */
export interface ShellMesh {
  /** x, y, z per node (mm), on the midsurface. */
  nodes: Float64Array;
  /** Three nodes per triangle; their order gives the normal n = (p2 − p1) × (p3 − p1). */
  triangles: Uint32Array;
  /** Thickness per triangle (mm). */
  thickness: Float64Array;
  /** The shape face tag (0..shapeFaces − 1) of each triangle. */
  faces: Int32Array;
  shapeFaces: number;
  shapeEdges: number;
  /** Node chains of the shape edges, in order: chain k is nodes[offsets[k]..offsets[k + 1]]. */
  edges: { offsets: Uint32Array; nodes: Uint32Array };
}

export type ShellLoad =
  /** A total force spread over the shape faces by area. */
  | { kind: 'face-force'; faces: number[]; force: [number, number, number] }
  /** A total force spread over the shape edges by length. */
  | { kind: 'edge-force'; edges: number[]; force: [number, number, number] }
  /** MPa on the shape faces, pushing against the triangle normal n (into a body whose outward normal it is). */
  | { kind: 'pressure'; faces: number[]; pressure: number }
  /** mm/s² on the whole shell. */
  | { kind: 'gravity'; acceleration: [number, number, number] };

/** Components per DOF on the nodes of shape faces or edges; null leaves one free. */
export interface ShellConstraint {
  faces: number[];
  edges: number[];
  /** mm per component; null = free. */
  displacement: [number | null, number | null, number | null];
  /** rad about the global x, y, z axes; null = free. Fixed (clamped) is displacement and rotation [0, 0, 0]. */
  rotation: [number | null, number | null, number | null];
}

export interface ShellInput {
  mesh: ShellMesh;
  material: ElasticMaterial;
  loads: ShellLoad[];
  constraints: ShellConstraint[];
  /** CR5a: added masses on shape faces. */
  masses?: AddedMass[];
  solver: { tolerance: number; maxIterations: number };
}

export interface ShellResult {
  /** x, y, z, rx, ry, rz per node (mm, rad). */
  displacement: Float64Array;
  /**
   * xx, yy, zz, xy, yz, zx per node (MPa, global axes) on the top (+t/2 along n), middle and
   * bottom surfaces, averaged over the triangles around the node.
   */
  stress: { top: Float64Array; middle: Float64Array; bottom: Float64Array };
  /** von Mises per node on the top and bottom surfaces, and the larger of the two. */
  vonMises: { top: Float64Array; bottom: Float64Array; max: Float64Array };
  /** Reaction per node DOF at the held DOFs, 0 elsewhere (N, N·mm). */
  reaction: Float64Array;
  /** Sums of the applied nodal forces and of the reaction forces (N). */
  appliedTotal: [number, number, number];
  reactionTotal: [number, number, number];
  /** Moments about the centre of the nodes of the applied loads and of the reactions (N·mm). */
  appliedMoment: [number, number, number];
  reactionMoment: [number, number, number];
  /**
   * The larger of the applied and the reaction moments summed node by node as magnitudes, before
   * they cancel (N·mm): the moment check's scale.
   */
  momentScale: number;
  /**
   * R3j-5a: the summed force magnitudes the reactions were added up from, when that is larger
   * than the reactions themselves (a Host's wedge layers, whose couples cancel in each node); the
   * equilibrium check's force scale is then at least this.
   */
  forceScale?: number;
  loadChecks: { force: [number, number, number]; measure: number }[];
  constrainedNodes: number[];
  iterations: number;
  residual: number;
  converged: boolean;
}

/** Drilling stiffness factor: penalises ω_i − ω(centroid) to remove Allman's equal-ω mode. */
const drilling = 1e-3;

type Vec = [number, number, number];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: ArrayLike<number>) => Math.sqrt(dot3(a, a));

/** The plane frame of a triangle: rows e1 (along edge 12), e2, e3 = n, and local 2-D corners. */
export function shellFrame(mesh: ShellMesh, e: number) {
  const c = mesh.triangles.subarray(3 * e, 3 * e + 3);
  const P = [0, 1, 2].map((a) => mesh.nodes.subarray(3 * c[a]!, 3 * c[a]! + 3));
  const a = sub(P[1]!, P[0]!),
    b = sub(P[2]!, P[0]!);
  const n = cross(a, b);
  const twoA = len(n);
  const la = len(a);
  const e1 = a.map((x) => x / la) as Vec;
  const e3 = n.map((x) => x / twoA) as Vec;
  const e2 = cross(e3, e1);
  return {
    nodes: [...c],
    R: [e1, e2, e3],
    x: [0, la, dot3(b, e1)],
    y: [0, 0, dot3(b, e2)],
    area: twoA / 2,
  };
}

/** Plane-stress elasticity (3 × 3) of an isotropic material. */
function planeStress(E: number, nu: number) {
  const k = E / (1 - nu * nu);
  return [
    [k, k * nu, 0],
    [k * nu, k, 0],
    [0, 0, (k * (1 - nu)) / 2],
  ];
}

/**
 * The Allman membrane strain rows (3 × 9 on u1 v1 ω1 u2 v2 ω2 u3 v3 ω3) at area coordinates L,
 * and the centroid rotation row (1 × 9): the LST with the mid-side displacements given by the
 * corner rotations (Allman 1984, in the LST form of Cook).
 */
function allman(x: number[], y: number[], L: number[]) {
  const twoA = (x[1]! - x[0]!) * (y[2]! - y[0]!) - (x[2]! - x[0]!) * (y[1]! - y[0]!);
  const b = [y[1]! - y[2]!, y[2]! - y[0]!, y[0]! - y[1]!].map((v) => v / twoA);
  const c = [x[2]! - x[1]!, x[0]! - x[2]!, x[1]! - x[0]!].map((v) => v / twoA);
  // LST: corners N_i = L_i (2 L_i − 1), mid-sides 4 (12), 5 (23), 6 (31): 4 L_i L_j.
  const dNx = [0, 1, 2].map((i) => (4 * L[i]! - 1) * b[i]!);
  const dNy = [0, 1, 2].map((i) => (4 * L[i]! - 1) * c[i]!);
  const sides = [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as const;
  for (const [i, j] of sides) {
    dNx.push(4 * (L[i]! * b[j]! + L[j]! * b[i]!));
    dNy.push(4 * (L[i]! * c[j]! + L[j]! * c[i]!));
  }
  // T: LST (u, v at 6 nodes) ← Allman (u, v, ω at 3 corners).
  const Tu: number[][] = [],
    Tv: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const ru = new Array<number>(9).fill(0),
      rv = new Array<number>(9).fill(0);
    ru[3 * i] = 1;
    rv[3 * i + 1] = 1;
    Tu.push(ru);
    Tv.push(rv);
  }
  for (const [i, j] of sides) {
    const ru = new Array<number>(9).fill(0),
      rv = new Array<number>(9).fill(0);
    ru[3 * i] = ru[3 * j] = 0.5;
    rv[3 * i + 1] = rv[3 * j + 1] = 0.5;
    // u_m = ū + (y_j − y_i)(ω_j − ω_i)/8, v_m = v̄ + (x_i − x_j)(ω_j − ω_i)/8.
    const du = (y[j]! - y[i]!) / 8,
      dv = (x[i]! - x[j]!) / 8;
    ru[3 * j + 2] = du;
    ru[3 * i + 2] = -du;
    rv[3 * j + 2] = dv;
    rv[3 * i + 2] = -dv;
    Tu.push(ru);
    Tv.push(rv);
  }
  const B = [0, 1, 2].map(() => new Array<number>(9).fill(0));
  const spin = new Array<number>(9).fill(0);
  for (let k = 0; k < 6; k++)
    for (let d = 0; d < 9; d++) {
      B[0]![d]! += dNx[k]! * Tu[k]![d]!;
      B[1]![d]! += dNy[k]! * Tv[k]![d]!;
      B[2]![d]! += dNy[k]! * Tu[k]![d]! + dNx[k]! * Tv[k]![d]!;
      spin[d]! += (dNx[k]! * Tv[k]![d]! - dNy[k]! * Tu[k]![d]!) / 2;
    }
  return { B, spin };
}

/**
 * The DKT curvature rows (3 × 9 on w1 θx1 θy1 … with θx = ∂w/∂y, θy = −∂w/∂x) at (ξ, η) of the
 * corners 1 (0, 0), 2 (1, 0), 3 (0, 1): κ = [βx,x; βy,y; βx,y + βy,x] (Batoz, Bathe and Ho 1980).
 */
function dkt(x: number[], y: number[], xi: number, eta: number) {
  const coef = (i: number, j: number) => {
    const xij = x[i]! - x[j]!,
      yij = y[i]! - y[j]!;
    const l2 = xij * xij + yij * yij;
    return {
      a: -xij / l2,
      b: (0.75 * xij * yij) / l2,
      c: (0.25 * xij * xij - 0.5 * yij * yij) / l2,
      d: -yij / l2,
      e: (0.25 * yij * yij - 0.5 * xij * xij) / l2,
    };
  };
  // Sides 4 (23), 5 (31), 6 (12).
  const s4 = coef(1, 2),
    s5 = coef(2, 0),
    s6 = coef(0, 1);
  const lam = 1 - xi - eta;
  // ∂N/∂ξ and ∂N/∂η of N1..N6.
  const dXi = [1 - 4 * lam, 4 * xi - 1, 0, 4 * eta, -4 * eta, 4 * (lam - xi)];
  const dEta = [1 - 4 * lam, 0, 4 * eta - 1, 4 * xi, 4 * (lam - eta), -4 * xi];
  // Coefficients of N1..N6 in Hx and Hy, per DOF.
  const Hx = (N: number[]) => [
    1.5 * (s6.a * N[5]! - s5.a * N[4]!),
    s5.b * N[4]! + s6.b * N[5]!,
    N[0]! - s5.c * N[4]! - s6.c * N[5]!,
    1.5 * (s4.a * N[3]! - s6.a * N[5]!),
    s6.b * N[5]! + s4.b * N[3]!,
    N[1]! - s6.c * N[5]! - s4.c * N[3]!,
    1.5 * (s5.a * N[4]! - s4.a * N[3]!),
    s4.b * N[3]! + s5.b * N[4]!,
    N[2]! - s4.c * N[3]! - s5.c * N[4]!,
  ];
  const Hy = (N: number[]) => [
    1.5 * (s6.d * N[5]! - s5.d * N[4]!),
    -N[0]! + s5.e * N[4]! + s6.e * N[5]!,
    -s5.b * N[4]! - s6.b * N[5]!,
    1.5 * (s4.d * N[3]! - s6.d * N[5]!),
    -N[1]! + s6.e * N[5]! + s4.e * N[3]!,
    -s6.b * N[5]! - s4.b * N[3]!,
    1.5 * (s5.d * N[4]! - s4.d * N[3]!),
    -N[2]! + s4.e * N[3]! + s5.e * N[4]!,
    -s4.b * N[3]! - s5.b * N[4]!,
  ];
  const x21 = x[1]! - x[0]!,
    x31 = x[2]! - x[0]!,
    y21 = y[1]! - y[0]!,
    y31 = y[2]! - y[0]!;
  const twoA = x21 * y31 - x31 * y21;
  const HxXi = Hx(dXi),
    HxEta = Hx(dEta),
    HyXi = Hy(dXi),
    HyEta = Hy(dEta);
  // ∂/∂x = (y31 ∂/∂ξ − y21 ∂/∂η)/2A, ∂/∂y = (−x31 ∂/∂ξ + x21 ∂/∂η)/2A.
  const B = [0, 1, 2].map(() => new Array<number>(9).fill(0));
  for (let d = 0; d < 9; d++) {
    B[0]![d] = (y31 * HxXi[d]! - y21 * HxEta[d]!) / twoA;
    B[1]![d] = (-x31 * HyXi[d]! + x21 * HyEta[d]!) / twoA;
    B[2]![d] = (-x31 * HxXi[d]! + x21 * HxEta[d]! + y31 * HyXi[d]! - y21 * HyEta[d]!) / twoA;
  }
  return B;
}

/** Local DOF (of 18: u v w θx θy θz per corner) of the membrane and bending DOFs of corner i. */
const membraneDof = (k: number) => 6 * Math.floor(k / 3) + [0, 1, 5][k % 3]!;
const bendingDof = (k: number) => 6 * Math.floor(k / 3) + [2, 3, 4][k % 3]!;
/** Mid-side points (area coordinates), weight A/3 each: exact for quadratics. */
const midsides = [
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
];

/** The 18 × 18 stiffness of triangle e in global axes, row-major. */
export function shellElementStiffness(
  mesh: ShellMesh,
  e: number,
  material: ElasticMaterial,
): Float64Array {
  const { R, x, y, area } = shellFrame(mesh, e);
  const t = mesh.thickness[e]!;
  const D = planeStress(material.youngsModulus, material.poissonsRatio);
  const Kl = new Float64Array(324);
  const addBtDB = (B: number[][], scale: number, map: (k: number) => number) => {
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 9; j++) {
        let s = 0;
        for (let r = 0; r < 3; r++)
          for (let q = 0; q < 3; q++) s += B[r]![i]! * D[r]![q]! * B[q]![j]!;
        Kl[map(i) * 18 + map(j)]! += s * scale;
      }
  };
  for (const L of midsides) addBtDB(allman(x, y, L).B, (t * area) / 3, membraneDof);
  // Drilling: k Σ_i (ω_i − ω_c)² with ω_c the rotation of the membrane field at the centroid.
  const { spin } = allman(x, y, [1 / 3, 1 / 3, 1 / 3]);
  const kd = drilling * material.youngsModulus * t * area;
  for (let i = 0; i < 3; i++) {
    const row = spin.map((v) => -v);
    row[3 * i + 2]! += 1;
    for (let a = 0; a < 9; a++)
      for (let b = 0; b < 9; b++)
        Kl[membraneDof(a) * 18 + membraneDof(b)]! += kd * row[a]! * row[b]!;
  }
  const bend = (t * t * t) / 12;
  for (const [, l2, l3] of midsides) addBtDB(dkt(x, y, l2!, l3!), (bend * area) / 3, bendingDof);
  // Global: K = Tᵀ Kl T with T = blockdiag(R) (6 blocks), R rows e1, e2, e3.
  const T = (i: number, j: number) =>
    Math.floor(i / 3) === Math.floor(j / 3) ? R[i % 3]![j % 3]! : 0;
  const KT = new Float64Array(324);
  for (let i = 0; i < 18; i++)
    for (let j = 0; j < 18; j++) {
      let s = 0;
      const jb = 3 * Math.floor(j / 3);
      for (let k = jb; k < jb + 3; k++) s += Kl[i * 18 + k]! * T(k, j);
      KT[i * 18 + j] = s;
    }
  const K = new Float64Array(324);
  for (let i = 0; i < 18; i++) {
    const ib = 3 * Math.floor(i / 3);
    for (let j = 0; j < 18; j++) {
      let s = 0;
      for (let k = ib; k < ib + 3; k++) s += T(k, i) * KT[k * 18 + j]!;
      K[i * 18 + j] = s;
    }
  }
  return K;
}

const shellPattern = (mesh: ShellMesh) =>
  csrPattern(
    mesh.nodes.length * 2,
    mesh.triangles.length / 3,
    (e) => mesh.triangles.subarray(3 * e, 3 * e + 3),
    3,
    6,
  );

/** The stiffness K of the shell, 6 DOFs per node. */
export function assembleShellStiffness(mesh: ShellMesh, material: ElasticMaterial): CsrMatrix {
  const K = new CsrMatrix(shellPattern(mesh));
  for (let e = 0; e < mesh.triangles.length / 3; e++) {
    const Ke = shellElementStiffness(mesh, e, material);
    const c = mesh.triangles.subarray(3 * e, 3 * e + 3);
    for (let i = 0; i < 18; i++)
      for (let j = 0; j < 18; j++) {
        const v = Ke[i * 18 + j]!;
        if (v !== 0)
          K.add(6 * c[Math.floor(i / 6)]! + (i % 6), 6 * c[Math.floor(j / 6)]! + (j % 6), v);
      }
  }
  return K;
}

/** The lumped mass: ρ t A / 3 per corner on the translations, ρ t³/12 · A/3 on the rotations. */
export function assembleShellMass(mesh: ShellMesh, density: number): CsrMatrix {
  const M = new CsrMatrix(shellPattern(mesh));
  for (let e = 0; e < mesh.triangles.length / 3; e++) {
    const { nodes, area } = shellFrame(mesh, e);
    const t = mesh.thickness[e]!;
    const mt = (density * t * area) / 3,
      mr = (density * t ** 3 * area) / 36;
    for (const p of nodes) for (let i = 0; i < 6; i++) M.add(6 * p + i, 6 * p + i, i < 3 ? mt : mr);
  }
  return M;
}

/**
 * CR5a: the added masses per node (t): each mass spread over the triangles of its faces by area,
 * a third of each triangle's share at each corner. Refuses what `solidAddedMasses` refuses.
 */
export function shellAddedMasses(mesh: ShellMesh, masses: readonly AddedMass[] = []): Float64Array {
  const out = new Float64Array(mesh.nodes.length / 3);
  masses.forEach((m, k) => {
    if (!(m.mass > 0) || !Number.isFinite(m.mass))
      throw new ElasticError('material', `added mass ${k} is ${m.mass} t: it must be > 0`);
    for (const f of m.faces)
      if (!Number.isInteger(f) || f < 0 || f >= mesh.shapeFaces)
        throw new ElasticError('target-index', `face ${f} is not in 0..${mesh.shapeFaces - 1}`);
    const want = new Set(m.faces);
    const tris: { nodes: number[]; area: number }[] = [];
    for (let e = 0; e < mesh.triangles.length / 3; e++)
      if (want.has(mesh.faces[e]!)) tris.push(shellFrame(mesh, e));
    const area = tris.reduce((s, t) => s + t.area, 0);
    if (!(area > 0)) throw new ElasticError('empty-target', `added mass ${k} is on no face`);
    for (const t of tris) for (const p of t.nodes) out[p]! += (t.area / 3 / area) * m.mass;
  });
  return out;
}

/** The connected pieces of a shell mesh (triangles sharing a node). */
export function shellComponents(mesh: ShellMesh): { label: Int32Array; count: number } {
  const n = mesh.nodes.length / 3;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (let e = 0; e < mesh.triangles.length / 3; e++)
    for (let a = 1; a < 3; a++) {
      const r1 = find(mesh.triangles[3 * e]!),
        r2 = find(mesh.triangles[3 * e + a]!);
      if (r1 !== r2) parent[r1] = r2;
    }
  const label = new Int32Array(n).fill(-1);
  const ids = new Map<number, number>();
  for (let p = 0; p < n; p++) {
    const r = find(p);
    if (!ids.has(r)) ids.set(r, ids.size);
    label[p] = ids.get(r)!;
  }
  return { label, count: ids.size };
}

const motionNames = [
  'translation x',
  'translation y',
  'translation z',
  'rotation x',
  'rotation y',
  'rotation z',
];

/**
 * The rigid motions a set of held DOFs (6 per node) leaves free: the null space of the six rigid
 * modes evaluated at those DOFs. A held rotation holds the rotation modes directly.
 */
export function shellFreeRigidModes(nodes: Float64Array, held: Iterable<number>): string[] {
  const dofs = [...held];
  if (!dofs.length) return motionNames.slice();
  const ps = [...new Set(dofs.map((d) => Math.floor(d / 6)))];
  const c = [0, 0, 0];
  for (const p of ps) for (let i = 0; i < 3; i++) c[i]! += nodes[3 * p + i]! / ps.length;
  let scale = 0;
  for (const p of ps)
    scale = Math.max(scale, Math.hypot(...[0, 1, 2].map((i) => nodes[3 * p + i]! - c[i]!)));
  scale = scale || 1;
  const G = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const d of dofs) {
    const p = Math.floor(d / 6),
      i = d % 6;
    const r = [0, 1, 2].map((k) => (nodes[3 * p + k]! - c[k]!) / scale);
    const row =
      i < 3
        ? [0, 1, 2]
            .map((j): number => (i === j ? 1 : 0))
            .concat(
              [0, 1, 2].map((j) => {
                const ej = [0, 0, 0];
                ej[j] = 1;
                return cross(ej, r)[i]!;
              }),
            )
        : [0, 0, 0, ...[0, 1, 2].map((j) => (i - 3 === j ? 1 : 0))];
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) G[a]![b]! += row[a]! * row[b]!;
  }
  const { values, vectors } = smallEigen(G);
  const top = Math.max(...values);
  const out: string[] = [];
  values.forEach((v, k) => {
    if (v <= 1e-10 * Math.max(top, 1)) {
      const vec = vectors.map((row) => row[k]!);
      let best = 0;
      vec.forEach((x, j) => {
        if (Math.abs(x) > Math.abs(vec[best]!)) best = j;
      });
      out.push(motionNames[best]!);
    }
  });
  return out;
}

/** Cyclic Jacobi on a small symmetric matrix: eigenvalues and eigenvector columns. */
function smallEigen(A0: number[][]) {
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

export interface ShellPrepared {
  /** DOF (6 · node + component) → prescribed value (mm or rad). */
  prescribed: Map<number, number>;
  /** Nodal force per DOF (N; the rotation DOFs get none). */
  force: Float64Array;
  loadChecks: ShellResult['loadChecks'];
  constrainedNodes: number[];
  /** CR5a: the added masses per node (t), 0 where none. */
  added?: Float64Array;
}

/**
 * Checks a shell study and maps its loads and constraints to nodes. Refuses, before any solving:
 * E ≤ 0, ν outside (−1, 0.5), density < 0 or a thickness ≤ 0 (`material`); a triangle with no
 * area (`mesh-quality`); no constraint, an empty target, a face or edge index the mesh does not
 * have, two constraints giving one DOF different values, and a piece left with a free rigid motion.
 */
export function prepareShell(
  input: Omit<ShellInput, 'solver'>,
  /** R3j-3: as `prepareElastic`'s: a shell held through bonds may have no constraint. */
  options: { bonded?: boolean } = {},
): ShellPrepared {
  const { mesh, material } = input;
  const { youngsModulus: E, poissonsRatio: nu } = material;
  if (!(E > 0) || !(nu > -1 && nu < 0.5) || !(material.density >= 0))
    throw new ElasticError('material', 'E > 0, −1 < ν < 0.5 and density ≥ 0');
  const n = mesh.nodes.length / 3;
  const m = mesh.triangles.length / 3;
  for (let e = 0; e < m; e++) {
    const t = mesh.thickness[e]!;
    if (!(t > 0) || !Number.isFinite(t))
      throw new ElasticError('material', `triangle ${e} has thickness ${t}: it must be > 0`);
    const { x, y, area } = shellFrame(mesh, e);
    const longest = Math.max(x[1]!, Math.hypot(x[2]!, y[2]!), Math.hypot(x[2]! - x[1]!, y[2]!));
    if (!(area > 1e-10 * longest * longest))
      throw new ElasticError('mesh-quality', `triangle ${e} has no area`);
  }
  const index = (k: number, count: number, what: string) => {
    if (!Number.isInteger(k) || k < 0 || k >= count)
      throw new ElasticError('target-index', `${what} ${k} is not in 0..${count - 1}`);
  };
  const trianglesOf = (faces: number[]) => {
    for (const f of faces) index(f, mesh.shapeFaces, 'face');
    const want = new Set(faces);
    const out: number[] = [];
    for (let e = 0; e < m; e++) if (want.has(mesh.faces[e]!)) out.push(e);
    return out;
  };
  const edgeChain = (k: number) => {
    index(k, mesh.shapeEdges, 'edge');
    return [...mesh.edges.nodes.subarray(mesh.edges.offsets[k]!, mesh.edges.offsets[k + 1]!)];
  };

  if (!input.constraints.length && !options.bonded)
    throw new ElasticError('no-constraint', 'no constraint holds the shell');
  const prescribed = new Map<number, number>();
  const constrainedNodes: number[] = [];
  input.constraints.forEach((c, ci) => {
    const nodes = new Set<number>();
    for (const e of trianglesOf(c.faces))
      for (let a = 0; a < 3; a++) nodes.add(mesh.triangles[3 * e + a]!);
    for (const k of c.edges) for (const p of edgeChain(k)) nodes.add(p);
    if (!nodes.size) throw new ElasticError('empty-target', `constraint ${ci} holds no node`);
    constrainedNodes.push(nodes.size);
    const values = [...c.displacement, ...c.rotation];
    for (const p of nodes)
      values.forEach((v, i) => {
        if (v === null) return;
        const before = prescribed.get(6 * p + i);
        if (before !== undefined && before !== v)
          throw new ElasticError(
            'constraint-conflict',
            `constraint ${ci} gives node ${p} ${i < 3 ? 'direction' : 'rotation'} ${'xyz'[i % 3]} ${v}, another gave ${before}`,
          );
        prescribed.set(6 * p + i, v);
      });
  });
  const pieces = options.bonded ? { count: 0, label: new Int32Array(0) } : shellComponents(mesh);
  for (let k = 0; k < pieces.count; k++) {
    const held = [...prescribed.keys()].filter((d) => pieces.label[Math.floor(d / 6)] === k);
    const free = shellFreeRigidModes(mesh.nodes, held);
    if (free.length)
      throw new ElasticError(
        'rigid-body-mode',
        `${pieces.count > 1 ? `piece ${k + 1} of ${pieces.count} is ` : ''}free: ${free.join(', ')}`,
        free,
      );
  }

  const added = shellAddedMasses(mesh, input.masses);
  const f = new Float64Array(6 * n);
  const loadChecks: ShellResult['loadChecks'] = [];
  const add = (p: number, v: ArrayLike<number>, s: number) => {
    for (let i = 0; i < 3; i++) f[6 * p + i]! += v[i]! * s;
  };
  const sum = () => [0, 1, 2].map((i) => f.reduce((s, x, k) => (k % 6 === i ? s + x : s), 0));
  for (const [li, load] of input.loads.entries()) {
    const before = sum();
    let measure = 0;
    if (load.kind === 'face-force' || load.kind === 'pressure') {
      const tris = trianglesOf(load.faces);
      if (!tris.length) throw new ElasticError('empty-target', `load ${li} is on no face`);
      const frames = tris.map((e) => shellFrame(mesh, e));
      measure = frames.reduce((s, fr) => s + fr.area, 0);
      for (const fr of frames)
        for (const p of fr.nodes)
          if (load.kind === 'pressure') add(p, fr.R[2]!, (-load.pressure * fr.area) / 3);
          else add(p, load.force, fr.area / 3 / measure);
    } else if (load.kind === 'edge-force') {
      const segs: [number, number, number][] = [];
      for (const k of load.edges) {
        const chain = edgeChain(k);
        for (let s = 0; s + 1 < chain.length; s++) {
          const a = chain[s]!,
            b = chain[s + 1]!;
          const l = len(
            sub(mesh.nodes.subarray(3 * b, 3 * b + 3), mesh.nodes.subarray(3 * a, 3 * a + 3)),
          );
          segs.push([a, b, l]);
        }
      }
      if (!segs.length) throw new ElasticError('empty-target', `load ${li} is on no edge`);
      measure = segs.reduce((s, x) => s + x[2], 0);
      for (const [a, b, l] of segs) {
        add(a, load.force, l / 2 / measure);
        add(b, load.force, l / 2 / measure);
      }
    } else {
      for (let e = 0; e < m; e++) {
        const fr = shellFrame(mesh, e);
        const mass = material.density * mesh.thickness[e]! * fr.area;
        measure += fr.area * mesh.thickness[e]!;
        for (const p of fr.nodes) add(p, load.acceleration, mass / 3);
      }
      // CR5a: the added masses fall with the shell.
      added.forEach((mass, p) => mass && add(p, load.acceleration, mass));
    }
    const after = sum();
    loadChecks.push({
      force: [0, 1, 2].map((i) => after[i]! - before[i]!) as [number, number, number],
      measure,
    });
  }
  return { prescribed, force: f, loadChecks, constrainedNodes, added };
}

/** Solves K u = f with the constraints applied by elimination (CG preconditioned by ILU(0)). */
export function solveShell(input: ShellInput): ShellResult {
  const { mesh, material } = input;
  const { prescribed, force: f, loadChecks, constrainedNodes } = prepareShell(input);
  const n = mesh.nodes.length / 3;
  const dofs = 6 * n;
  const K = assembleShellStiffness(mesh, material);
  const u = new Float64Array(dofs);
  for (const [d, v] of prescribed) u[d] = v;
  const free = new Uint8Array(dofs).fill(1);
  for (const d of prescribed.keys()) free[d] = 0;
  const Ku0 = K.multiply(u);
  const b = new Float64Array(dofs);
  for (let d = 0; d < dofs; d++) b[d] = free[d] ? f[d]! - Ku0[d]! : 0;
  const ilu = incompleteFactor(K, free);
  const solved = pcg(
    K,
    b,
    free,
    input.solver.tolerance,
    input.solver.maxIterations,
    undefined,
    ilu.apply,
  );
  for (let d = 0; d < dofs; d++) if (free[d]) u[d] = solved.x[d]!;

  const Ku = K.multiply(u);
  const reaction = new Float64Array(dofs);
  for (const d of prescribed.keys()) reaction[d] = Ku[d]! - f[d]!;
  const { stress, vonMises } = shellStress(mesh, material, u);
  return {
    displacement: u,
    stress,
    vonMises,
    reaction,
    ...shellBalance(mesh.nodes, f, reaction),
    loadChecks,
    constrainedNodes,
    iterations: solved.iterations,
    residual: solved.residual,
    converged: solved.converged,
  };
}

/**
 * The force and moment sums of the applied nodal forces `f` and the reactions (6 per node), the
 * moments about the centre of the nodes; `momentScale` sums each node's |r × F + M| before they
 * cancel (R3j-5a: shared with the Host's result).
 */
export function shellBalance(
  nodes: Float64Array,
  f: Float64Array,
  reaction: Float64Array,
): Pick<
  ShellResult,
  'appliedTotal' | 'reactionTotal' | 'appliedMoment' | 'reactionMoment' | 'momentScale'
> {
  const n = nodes.length / 3;
  const centre: Vec = [0, 0, 0];
  for (let p = 0; p < n; p++) for (let i = 0; i < 3; i++) centre[i]! += nodes[3 * p + i]! / n;
  const totals = (v: Float64Array) => {
    const F: Vec = [0, 0, 0],
      Mo: Vec = [0, 0, 0];
    let size = 0;
    for (let p = 0; p < n; p++) {
      const fp = v.subarray(6 * p, 6 * p + 3);
      const r = cross(sub(nodes.subarray(3 * p, 3 * p + 3), centre), fp);
      const m = [0, 1, 2].map((i) => r[i]! + v[6 * p + 3 + i]!);
      for (let i = 0; i < 3; i++) {
        F[i]! += fp[i]!;
        Mo[i]! += m[i]!;
      }
      size += Math.hypot(m[0]!, m[1]!, m[2]!);
    }
    return { F, Mo, size };
  };
  const applied = totals(f),
    reacted = totals(reaction);
  return {
    appliedTotal: applied.F,
    reactionTotal: reacted.F,
    appliedMoment: applied.Mo,
    reactionMoment: reacted.Mo,
    momentScale: Math.max(applied.size, reacted.size),
  };
}

/**
 * Stresses at the corners of each triangle on z = +t/2, 0, −t/2 as global tensors, averaged over
 * the triangles around a node, and the von Mises values on the top and bottom.
 */
export function shellStress(
  mesh: ShellMesh,
  material: ElasticMaterial,
  u: Float64Array,
): Pick<ShellResult, 'stress' | 'vonMises'> {
  const n = mesh.nodes.length / 3;
  const m = mesh.triangles.length / 3;
  const D = planeStress(material.youngsModulus, material.poissonsRatio);
  const top = new Float64Array(6 * n),
    middle = new Float64Array(6 * n),
    bottom = new Float64Array(6 * n);
  const count = new Uint32Array(n);
  const corners = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let e = 0; e < m; e++) {
    const { nodes, R, x, y } = shellFrame(mesh, e);
    const t = mesh.thickness[e]!;
    // Local DOFs of the element (18): R applied to each node's translation and rotation.
    const ul = new Array<number>(18).fill(0);
    nodes.forEach((p, a) => {
      for (let blk = 0; blk < 2; blk++)
        for (let i = 0; i < 3; i++)
          ul[6 * a + 3 * blk + i] = dot3(R[i]!, u.subarray(6 * p + 3 * blk, 6 * p + 3 * blk + 3));
    });
    corners.forEach((L, a) => {
      const Bm = allman(x, y, L).B;
      const Bb = dkt(x, y, L[1]!, L[2]!);
      const eps = [0, 1, 2].map((r) => Bm[r]!.reduce((s, v, k) => s + v * ul[membraneDof(k)]!, 0));
      const kap = [0, 1, 2].map((r) => Bb[r]!.reduce((s, v, k) => s + v * ul[bendingDof(k)]!, 0));
      const p = nodes[a]!;
      for (const [out, z] of [
        [top, t / 2],
        [middle, 0],
        [bottom, -t / 2],
      ] as const) {
        const strain = eps.map((v, r) => v + z * kap[r]!);
        const s = D.map((row) => row.reduce((acc, d, k) => acc + d * strain[k]!, 0));
        // σ = sxx e1e1ᵀ + syy e2e2ᵀ + sxy (e1e2ᵀ + e2e1ᵀ).
        const e1 = R[0]!,
          e2 = R[1]!;
        const comp = (i: number, j: number) =>
          s[0]! * e1[i]! * e1[j]! +
          s[1]! * e2[i]! * e2[j]! +
          s[2]! * (e1[i]! * e2[j]! + e2[i]! * e1[j]!);
        const g = [comp(0, 0), comp(1, 1), comp(2, 2), comp(0, 1), comp(1, 2), comp(2, 0)];
        for (let r = 0; r < 6; r++) out[6 * p + r]! += g[r]!;
      }
      count[p]!++;
    });
  }
  const vmTop = new Float64Array(n),
    vmBottom = new Float64Array(n),
    vmMax = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const k = Math.max(1, count[p]!);
    for (let r = 0; r < 6; r++) {
      top[6 * p + r]! /= k;
      middle[6 * p + r]! /= k;
      bottom[6 * p + r]! /= k;
    }
    vmTop[p] = vonMisesOf(top, 6 * p);
    vmBottom[p] = vonMisesOf(bottom, 6 * p);
    vmMax[p] = Math.max(vmTop[p]!, vmBottom[p]!);
  }
  return {
    stress: { top, middle, bottom },
    vonMises: { top: vmTop, bottom: vmBottom, max: vmMax },
  };
}

/**
 * The equilibrium check of a shell result: |applied + reactions| for the forces within `relative`
 * × the larger of |applied| and the summed reaction magnitudes, and for the moments about the
 * centre of the nodes within `relative` × `momentScale` (node by node magnitudes, so a study held
 * by prescribed rotations whose reaction moments cancel is still judged on their size).
 */
export function shellEquilibriumCheck(
  r: ShellResult,
  relative = 1e-6,
): { pass: boolean; force: number; moment: number; forceScale: number; momentScale: number } {
  const force = Math.hypot(...r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!));
  const moment = Math.hypot(...r.appliedMoment.map((x, i) => x + r.reactionMoment[i]!));
  let reactions = 0;
  for (let p = 0; p < r.reaction.length / 6; p++)
    reactions += Math.hypot(r.reaction[6 * p]!, r.reaction[6 * p + 1]!, r.reaction[6 * p + 2]!);
  const forceScale = Math.max(Math.hypot(...r.appliedTotal), reactions, r.forceScale ?? 0);
  return {
    pass: force <= relative * forceScale && moment <= relative * r.momentScale,
    force,
    moment,
    forceScale,
    momentScale: r.momentScale,
  };
}

export interface ShellModalInput {
  mesh: ShellMesh;
  material: ElasticMaterial;
  constraints: ShellConstraint[];
  /** CR5a: added masses on shape faces, in the mass matrix. */
  masses?: AddedMass[];
  modes: number;
  solver: { tolerance: number; maxIterations: number };
  /** After each step, with the current eigenvalue estimates; throw to cancel. */
  progress?(step: number, eigenvalues: number[]): void;
}
export interface ShellModalResult {
  /** Mode shapes have 6 DOFs per node; effective masses are on the translations. */
  modes: ModalMode[];
  mass: number;
  iterations: number;
  converged: boolean;
  orthogonality: number;
  constrainedNodes: number[];
}

/**
 * The lowest natural modes of a shell. Refuses what `prepareShell` refuses, a density ≤ 0, a
 * prescribed value other than 0 and constraints that hold every DOF.
 */
export function solveShellModal(input: ShellModalInput): ShellModalResult {
  const { mesh, material } = input;
  if (!(material.density > 0)) throw new ElasticError('material', 'density > 0 for a modal study');
  if (!Number.isInteger(input.modes) || input.modes < 1)
    throw new RangeError('modes must be a whole number ≥ 1');
  const prepared = prepareShell({
    mesh,
    material,
    constraints: input.constraints,
    masses: input.masses,
    loads: [],
  });
  for (const [d, v] of prepared.prescribed)
    if (v !== 0)
      throw new ElasticError(
        'constraint-conflict',
        `node ${Math.floor(d / 6)}: a modal study holds DOFs at 0 only`,
      );
  const dofs = 2 * mesh.nodes.length;
  const free = new Uint8Array(dofs).fill(1);
  for (const d of prepared.prescribed.keys()) free[d] = 0;
  if (!free.some((x) => x))
    throw new ElasticError(
      'constraint-conflict',
      'the constraints hold every node in every direction: nothing is left to vibrate',
    );
  const K = assembleShellStiffness(mesh, material);
  const M = assembleShellMass(mesh, material.density);
  addNodalMasses(M, prepared.added, 6);
  const eigen = lowestModes({
    K,
    M,
    free,
    perNode: 6,
    coordinates: mesh.nodes,
    modes: input.modes,
    solver: input.solver,
    progress: input.progress,
  });
  const { modes, mass, orthogonality } = modalSummary(M, eigen, 6);
  return {
    modes,
    mass,
    iterations: eigen.iterations,
    converged: eigen.converged,
    orthogonality,
    constrainedNodes: prepared.constrainedNodes,
  };
}

/** A triangulated midsurface as the kernel gives it (`CadAnalysisSurface` with `shell`). */
export interface ShellSurfaceInput {
  points: Float64Array;
  triangles: Uint32Array;
  faces: ArrayLike<number>;
  shapeFaces: number;
  shapeEdges: number;
  edges: { offsets: Uint32Array; nodes: Uint32Array };
}

/**
 * R3i-3: a shell mesh from a triangulated midsurface: its points and triangles (wound as the
 * kernel gives them, so the normal is the wall's outward one), face tags and edge chains, with
 * one thickness for every triangle. Refuses a surface with no triangles, a tag or chain node out
 * of range and a thickness ≤ 0 (`RangeError`).
 */
export function shellMeshFromSurface(surface: ShellSurfaceInput, thicknessMm: number): ShellMesh {
  const n = surface.points.length / 3;
  const m = surface.triangles.length / 3;
  if (!(m > 0) || !Number.isInteger(m) || !Number.isInteger(n))
    throw new RangeError('shell-mesh: no triangles');
  if (!(thicknessMm > 0) || !Number.isFinite(thicknessMm))
    throw new RangeError(`shell-mesh: thickness ${thicknessMm}`);
  if (surface.faces.length !== m) throw new RangeError('shell-mesh: one face tag per triangle');
  for (const p of surface.triangles) if (p >= n) throw new RangeError('shell-mesh: node index');
  for (let e = 0; e < m; e++) {
    const f = surface.faces[e]!;
    if (!Number.isInteger(f) || f < 0 || f >= surface.shapeFaces)
      throw new RangeError('shell-mesh: face tag');
  }
  for (const p of surface.edges.nodes) if (p >= n) throw new RangeError('shell-mesh: chain node');
  if (surface.edges.offsets.length !== surface.shapeEdges + 1)
    throw new RangeError('shell-mesh: one chain per shape edge');
  return {
    nodes: Float64Array.from(surface.points),
    triangles: Uint32Array.from(surface.triangles),
    thickness: new Float64Array(m).fill(thicknessMm),
    faces: Int32Array.from(surface.faces),
    shapeFaces: surface.shapeFaces,
    shapeEdges: surface.shapeEdges,
    edges: {
      offsets: Uint32Array.from(surface.edges.offsets),
      nodes: Uint32Array.from(surface.edges.nodes),
    },
  };
}

/**
 * R3i-3: the triangle shapes a shell run accepts (docs/cad/r3-analysis.md, A3): every angle at
 * least `minAngleDeg` and an aspect ratio (longest edge × perimeter / (4√3 × area), 1 for an
 * equilateral triangle) at most `maxAspect`. As lenient as the tetrahedra's (dihedral 2°): the
 * kernel's triangulation keeps two shape edges' chain points apart however close they meet
 * (4.4° on the F18 hood at 6 mm), and DKT and Allman pass their patch tests on any triangle.
 */
export const shellQualityMin = { minAngleDeg: 2, maxAspect: 30 };

/** The smallest angle and the largest aspect ratio of a shell mesh, and the triangles past the limits. */
export function shellMeshQuality(mesh: ShellMesh): {
  minAngleDeg: number;
  maxAspect: number;
  below: number[];
} {
  let minAngleDeg = 180,
    maxAspect = 1;
  const below: number[] = [];
  for (let e = 0; e < mesh.triangles.length / 3; e++) {
    const P = [0, 1, 2].map((a) =>
      mesh.nodes.subarray(3 * mesh.triangles[3 * e + a]!, 3 * mesh.triangles[3 * e + a]! + 3),
    );
    const l = [0, 1, 2].map((a) => len(sub(P[(a + 1) % 3]!, P[(a + 2) % 3]!)));
    const area = len(cross(sub(P[1]!, P[0]!), sub(P[2]!, P[0]!))) / 2;
    // The angle at corner a is opposite edge a: by the law of cosines.
    const angles = [0, 1, 2].map((a) => {
      const [x, y, z] = [l[a]!, l[(a + 1) % 3]!, l[(a + 2) % 3]!];
      const c = (y * y + z * z - x * x) / (2 * y * z);
      return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
    });
    const smallest = area > 0 ? Math.min(...angles) : 0;
    const aspect =
      area > 0 ? (Math.max(...l) * (l[0]! + l[1]! + l[2]!)) / (4 * Math.sqrt(3) * area) : Infinity;
    minAngleDeg = Math.min(minAngleDeg, smallest);
    maxAspect = Math.max(maxAspect, aspect);
    if (smallest < shellQualityMin.minAngleDeg || aspect > shellQualityMin.maxAspect) below.push(e);
  }
  return { minAngleDeg, maxAspect, below };
}
