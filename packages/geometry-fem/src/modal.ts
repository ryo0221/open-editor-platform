import {
  addNodalMasses,
  assembleMass,
  assembleStiffness,
  ElasticError,
  prepareElastic,
  type AddedMass,
  type ElasticConstraint,
  type ElasticMaterial,
} from './elastic';
import type { FemMesh } from './fem';
import { incompleteFactor, pcg, type CsrMatrix } from './sparse';

/**
 * R3g: the natural frequencies and mode shapes of a held, isotropic linear elastic solid
 * (docs/cad/r3-analysis.md, 解法と検査: 固有値). K φ = λ M φ with the consistent mass matrix and
 * the held DOFs eliminated, solved for the lowest modes by LOBPCG (Knyazev) preconditioned by an
 * incomplete Cholesky factor of K: each step costs a few products with K and M per vector, no inner solve. Units
 * mm–N–t–s: λ = ω² in 1/s², frequencies in Hz.
 */
export interface ModalInput {
  mesh: FemMesh;
  material: ElasticMaterial;
  /** Only fixed values: a prescribed displacement other than 0 is refused for a modal study. */
  constraints: ElasticConstraint[];
  /** CR5a: added masses on shape faces, in the mass matrix. */
  masses?: AddedMass[];
  modes: number;
  solver: {
    /** ‖K φ − λ M φ‖ / ‖K φ‖ every wanted mode must reach. */
    tolerance: number;
    maxIterations: number;
  };
  /** After each step, with the current eigenvalue estimates; throw to cancel. */
  progress?(step: number, eigenvalues: number[]): void;
}

export interface ModalMode {
  /** Hz. */
  frequency: number;
  /** ω² (1/s²). */
  eigenvalue: number;
  /** x, y, z per node, mass-normalised (φᵀ M φ = 1). */
  shape: Float64Array;
  /** ‖K φ − λ M φ‖ / ‖K φ‖ on the free DOFs. */
  residual: number;
  /** Effective mass in x, y, z as a fraction of the total mass (over all modes ≤ 1 each). */
  effectiveMass: [number, number, number];
}
export interface ModalResult {
  modes: ModalMode[];
  /** Total mass (t): the mass matrix summed in one direction. */
  mass: number;
  iterations: number;
  /** Every wanted mode reached the residual tolerance. */
  converged: boolean;
  /** The largest |φ_iᵀ M φ_j − δ_ij| over the returned modes. */
  orthogonality: number;
  constrainedNodes: number[];
}

/** Eigenvalues (ascending) and orthonormal eigenvectors (as columns `vectors[k]`) of a small symmetric matrix, by cyclic Jacobi. */
export function symmetricEigen(input: readonly (readonly number[])[]): {
  values: number[];
  vectors: number[][];
} {
  const q = input.length;
  const A = input.map((row, i) => row.map((_, j) => (input[i]![j]! + input[j]![i]!) / 2));
  const V: number[][] = A.map((_, i) => A.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    let scale = 0;
    for (let i = 0; i < q; i++)
      for (let j = 0; j < q; j++)
        if (i === j) scale += A[i]![j]! ** 2;
        else off += A[i]![j]! ** 2;
    if (off <= 1e-30 * scale || off === 0) break;
    for (let p = 0; p < q; p++)
      for (let r = p + 1; r < q; r++) {
        const apr = A[p]![r]!;
        if (apr === 0) continue;
        const theta = (A[r]![r]! - A[p]![p]!) / (2 * apr);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < q; k++) {
          const akp = A[k]![p]!,
            akr = A[k]![r]!;
          A[k]![p] = c * akp - s * akr;
          A[k]![r] = s * akp + c * akr;
        }
        for (let k = 0; k < q; k++) {
          const apk = A[p]![k]!,
            ark = A[r]![k]!;
          A[p]![k] = c * apk - s * ark;
          A[r]![k] = s * apk + c * ark;
        }
        for (let k = 0; k < q; k++) {
          const vkp = V[k]![p]!,
            vkr = V[k]![r]!;
          V[k]![p] = c * vkp - s * vkr;
          V[k]![r] = s * vkp + c * vkr;
        }
      }
  }
  const order = A.map((row, i) => [row[i]!, i] as const).sort((a, b) => a[0] - b[0]);
  return { values: order.map(([v]) => v), vectors: order.map(([, i]) => V.map((row) => row[i]!)) };
}

/**
 * Rayleigh–Ritz on the span of `S` (M-orthonormalised by its Gram matrix, dropping directions it
 * does not really span): the Ritz values ascending and each Ritz vector's coefficients in `S`.
 */
function rayleighRitz(
  KS: Float64Array[],
  MS: Float64Array[],
  S: Float64Array[],
  dot: (a: Float64Array, b: Float64Array) => number,
): { values: number[]; coefficients: number[][] } {
  const s = S.length;
  const GM = S.map((a) => MS.map((b) => dot(a, b)));
  const GK = S.map((a) => KS.map((b) => dot(a, b)));
  // Scale to unit diagonal first, so the drop threshold is relative.
  const d = GM.map((row, i) => 1 / Math.sqrt(Math.max(row[i]!, 1e-300)));
  const gm = GM.map((row, i) => row.map((v, j) => v * d[i]! * d[j]!));
  const { values: mv, vectors: mu } = symmetricEigen(gm);
  const top = Math.max(...mv);
  const keep = mv.map((v, k) => [v, k] as const).filter(([v]) => v > 1e-10 * top);
  // C = D U Λ^-1/2 (s × r): Cᵀ GM C = I.
  const C = Array.from({ length: s }, (_, i) =>
    keep.map(([v, k]) => (d[i]! * mu[k]![i]!) / Math.sqrt(v)),
  );
  const r = keep.length;
  const A = Array.from({ length: r }, (_, a) =>
    Array.from({ length: r }, (__, b) => {
      let sum = 0;
      for (let i = 0; i < s; i++)
        for (let j = 0; j < s; j++) sum += C[i]![a]! * GK[i]![j]! * C[j]![b]!;
      return sum;
    }),
  );
  const { values, vectors } = symmetricEigen(A);
  return {
    values,
    coefficients: vectors.map((y) =>
      Array.from({ length: s }, (_, i) => y.reduce((acc, yk, k) => acc + C[i]![k]! * yk, 0)),
    ),
  };
}

/**
 * Makes each `V[i]` (with `KV[i]`, `MV[i]` = K and M times it) M-orthogonal to the M-orthonormal
 * `X` (two passes) and of unit M-norm, in place. A column that is nearly in the span of `X` is
 * removed from all three.
 */
function orthogonalise(
  V: Float64Array[],
  KV: Float64Array[],
  MV: Float64Array[],
  X: Float64Array[],
  KX: Float64Array[],
  MX: Float64Array[],
  dot: (a: Float64Array, b: Float64Array) => number,
): void {
  const axpy = (y: Float64Array, a: number, x: Float64Array) => {
    for (let d = 0; d < y.length; d++) y[d]! -= a * x[d]!;
  };
  for (let i = V.length - 1; i >= 0; i--) {
    const v = V[i]!,
      kv = KV[i]!,
      mv = MV[i]!;
    const before = Math.sqrt(Math.max(dot(v, mv), 0));
    for (let pass = 0; pass < 2; pass++)
      X.forEach((x, k) => {
        // X M-orthonormal and M symmetric: x · M v = (M x) · v.
        const c = dot(MX[k]!, v);
        axpy(v, c, x);
        axpy(kv, c, KX[k]!);
        axpy(mv, c, MX[k]!);
      });
    const norm = Math.sqrt(Math.max(dot(v, mv), 0));
    if (!(norm > 1e-10 * before)) {
      V.splice(i, 1);
      KV.splice(i, 1);
      MV.splice(i, 1);
      continue;
    }
    for (const a of [v, kv, mv]) for (let d = 0; d < a.length; d++) a[d]! /= norm;
  }
}

/** A generalised eigenproblem K φ = λ M φ on the `free` DOFs (the others held at 0). */
export interface EigenProblem {
  K: CsrMatrix;
  M: CsrMatrix;
  free: Uint8Array;
  /** DOFs per node, the first three the x, y, z translations (3 for a solid, 6 for a shell). */
  perNode: number;
  /** x, y, z per node: the smooth starting fields are built from them. */
  coordinates: Float64Array;
  /**
   * R3j-4c: per DOF, its translation direction (0–2, −1 for a rotation) and its node's x, y, z,
   * in place of `perNode` and `coordinates` (a bonded model's reduced DOFs follow no pattern).
   */
  layout?: { component: Int8Array; position: Float64Array };
  /** R3j-4c: ILU(0) of K (default), or a few ILU-preconditioned CG steps on K (`inner`). */
  preconditioner?: 'ilu' | 'inner';
  modes: number;
  solver: ModalInput['solver'];
  progress?: ModalInput['progress'];
}
export interface EigenResult {
  /** The lowest eigenvalues, ascending, as many as asked (fewer if there are fewer free DOFs). */
  values: number[];
  /** M-orthonormal eigenvectors, one per value. */
  vectors: Float64Array[];
  residuals: number[];
  iterations: number;
  converged: boolean;
}

/**
 * The lowest `modes` eigenpairs by LOBPCG preconditioned by an incomplete Cholesky factor of K
 * (R3g-1; shared with the shell modes of R3i-1).
 */
export function lowestModes(input: EigenProblem): EigenResult {
  const { K, M, free, perNode, coordinates, modes, solver, progress, layout } = input;
  const dofs = free.length;
  const freeCount = free.reduce((s, x) => s + x, 0);
  const p = Math.min(modes, freeCount);
  // A few guard vectors beyond the wanted modes speed up the last of them.
  const m = Math.min(p + Math.max(2, Math.ceil(p / 2)), freeCount);
  const mask = (v: Float64Array) => {
    for (let d = 0; d < dofs; d++) if (!free[d]) v[d] = 0;
    return v;
  };
  const dot = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let d = 0; d < dofs; d++) s += a[d]! * b[d]!;
    return s;
  };
  const Kx = (x: Float64Array) => mask(K.multiply(x));
  const Mx = (x: Float64Array) => mask(M.multiply(x));
  const combine = (S: Float64Array[], c: number[]) => {
    const v = new Float64Array(dofs);
    c.forEach((ck, k) => {
      if (ck === 0) return;
      const s = S[k]!;
      for (let d = 0; d < dofs; d++) v[d]! += ck * s[d]!;
    });
    return v;
  };
  // Incomplete Cholesky of K: several times fewer steps than the Jacobi preconditioner.
  let precondition: (r: Float64Array) => Float64Array;
  if (input.preconditioner === 'inner') {
    // K⁻¹ r by a few ILU-preconditioned CG steps: on a bonded model's eliminated K, ILU(0) alone
    // left LOBPCG stalled at residuals near 1e-3 (FX8d, non-matching meshes); this took 9 steps.
    const factor = incompleteFactor(K, free);
    precondition = (r) => pcg(K, r, free, 1e-2, 50, undefined, factor.apply).x;
  } else {
    const factor = incompleteFactor(K, free);
    precondition = (r) => factor.apply(r);
  }

  // Start: the uniform fields in x, y, z, then each times a coordinate (x, then y, then z),
  // smooth fields that low modes resemble, then a fixed pseudo-random fill. Each smooth field
  // carries a pseudo-random part (a tenth of its size): identical pieces of the body would
  // otherwise only ever move together, missing the modes in which they differ.
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const randomField = () => mask(new Float64Array(dofs).map(() => random()));
  let X: Float64Array[] = Array.from({ length: m }, (_, k) => {
    if (k >= 12) return randomField();
    const v = new Float64Array(dofs);
    const direction = k % 3;
    const coordinate = Math.floor(k / 3) - 1;
    if (layout) {
      for (let d = 0; d < dofs; d++)
        if (layout.component[d] === direction)
          v[d] = coordinate < 0 ? 1 : layout.position[3 * d + coordinate]!;
    } else
      for (let d = direction; d < dofs; d += perNode)
        v[d] = coordinate < 0 ? 1 : coordinates[3 * Math.floor(d / perNode) + coordinate]!;
    mask(v);
    const r = randomField();
    const scale = (0.1 * Math.sqrt(dot(v, v))) / Math.max(Math.sqrt(dot(r, r)), 1e-300);
    for (let d = 0; d < dofs; d++) v[d]! += scale * r[d]!;
    return v;
  });
  let P: Float64Array[] = [];
  let values: number[] = [];
  let residuals: number[] = [];
  let KX: Float64Array[] = [];
  let MX: Float64Array[] = [];
  // A start the held DOFs make dependent (a field that is zero once masked) loses vectors in
  // Rayleigh–Ritz: they are replaced by pseudo-random fields on the free DOFs until there are m.
  for (let attempt = 0; ; attempt++) {
    KX = X.map(Kx);
    MX = X.map(Mx);
    const rr = rayleighRitz(KX, MX, X, dot);
    const take = rr.coefficients.slice(0, m);
    X = take.map((c) => combine(X, c));
    values = rr.values.slice(0, m);
    if (X.length >= m) break;
    if (attempt >= 8)
      throw new ElasticError('constraint-conflict', `no ${m} independent motions to start from`);
    X = [...X, ...Array.from({ length: m - X.length }, randomField)];
  }
  let iterations = 0;
  let converged = false;
  let KP: Float64Array[] = [];
  let MP: Float64Array[] = [];
  for (; ; iterations++) {
    // K X and M X follow X through the same combinations; recomputed now and then against drift.
    if (iterations % 20 === 0) {
      KX = X.map(Kx);
      MX = X.map(Mx);
    }
    const R = X.map((_, k) => {
      const r = new Float64Array(dofs);
      const kx = KX[k]!,
        mx = MX[k]!;
      for (let d = 0; d < dofs; d++) r[d] = kx[d]! - values[k]! * mx[d]!;
      return r;
    });
    residuals = R.map(
      (r, k) => Math.sqrt(dot(r, r)) / Math.max(Math.sqrt(dot(KX[k]!, KX[k]!)), 1e-300),
    );
    progress?.(iterations, values.slice(0, p));
    if (residuals.slice(0, p).every((r) => r <= solver.tolerance)) {
      // Confirmed on freshly computed products.
      const kx = X.map(Kx);
      const mx = X.map(Mx);
      const fresh = X.map((_, k) => {
        let rr = 0;
        for (let d = 0; d < dofs; d++) rr += (kx[k]![d]! - values[k]! * mx[k]![d]!) ** 2;
        return Math.sqrt(rr) / Math.max(Math.sqrt(dot(kx[k]!, kx[k]!)), 1e-300);
      });
      KX = kx;
      MX = mx;
      residuals = fresh;
      if (fresh.slice(0, p).every((r) => r <= solver.tolerance)) {
        converged = true;
        break;
      }
    }
    if (iterations >= solver.maxIterations) break;
    // Converged columns stay in the basis but get no new direction (soft locking).
    const W = R.map((r, k) =>
      residuals[k]! <= solver.tolerance ? undefined : mask(precondition(r)),
    ).filter((w): w is Float64Array => !!w);
    const KW = W.map(Kx);
    const MW = W.map(Mx);
    // W and P are made M-orthogonal to X (twice) and M-normalised before Rayleigh–Ritz: without it
    // the basis grows nearly dependent as X converges and the residuals stall well above the
    // tolerance while the frequencies have long settled (the classic LOBPCG instability).
    orthogonalise(W, KW, MW, X, KX, MX, dot);
    orthogonalise(P, KP, MP, X, KX, MX, dot);
    const S = [...X, ...W, ...P];
    const KS = [...KX, ...KW, ...KP];
    const MS = [...MX, ...MW, ...MP];
    const rr = rayleighRitz(KS, MS, S, dot);
    const take = rr.coefficients.slice(0, m);
    values = rr.values.slice(0, m);
    const outside = take.map((c) => c.map((v, i) => (i < m ? 0 : v)));
    X = take.map((c) => combine(S, c));
    KX = take.map((c) => combine(KS, c));
    MX = take.map((c) => combine(MS, c));
    // P: the part of the new X outside the old one.
    P = outside.map((c) => combine(S, c));
    KP = outside.map((c) => combine(KS, c));
    MP = outside.map((c) => combine(MS, c));
  }

  return {
    values: values.slice(0, p),
    vectors: X.slice(0, p),
    residuals: residuals.slice(0, p),
    iterations,
    converged,
  };
}

/**
 * Total mass, effective masses and M-orthogonality of eigenvectors with `perNode` DOFs per node,
 * or (R3j-4c) with each DOF's translation direction given (−1 for a rotation).
 */
export function modalSummary(
  M: CsrMatrix,
  eigen: EigenResult,
  perNode: number | Int8Array,
): { modes: ModalMode[]; mass: number; orthogonality: number } {
  const dofs = M.pattern.rows;
  const dot = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let d = 0; d < dofs; d++) s += a[d]! * b[d]!;
    return s;
  };
  const ones = [0, 1, 2].map((i) => {
    const r = new Float64Array(dofs);
    if (typeof perNode === 'number') for (let d = i; d < dofs; d += perNode) r[d] = 1;
    else for (let d = 0; d < dofs; d++) if (perNode[d] === i) r[d] = 1;
    return r;
  });
  const Mr = ones.map((r) => M.multiply(r));
  const mass = dot(ones[0]!, Mr[0]!);
  const shapes = eigen.vectors;
  const p = shapes.length;
  const MS = shapes.map((x) => M.multiply(x));
  let orthogonality = 0;
  for (let i = 0; i < p; i++)
    for (let j = 0; j < p; j++)
      orthogonality = Math.max(
        orthogonality,
        Math.abs(dot(shapes[i]!, MS[j]!) - (i === j ? 1 : 0)),
      );
  const modes = shapes.map(
    (phi, k): ModalMode => ({
      frequency: Math.sqrt(Math.max(eigen.values[k]!, 0)) / (2 * Math.PI),
      eigenvalue: eigen.values[k]!,
      shape: phi,
      residual: eigen.residuals[k]!,
      effectiveMass: [0, 1, 2].map((i) => dot(phi, Mr[i]!) ** 2 / mass) as [number, number, number],
    }),
  );
  return { modes, mass, orthogonality };
}

/**
 * The lowest `modes` natural modes. Refuses, before any solving, what the static solver refuses
 * (no constraint, a free rigid motion on any piece, empty targets, a material, a folded element),
 * a prescribed displacement other than 0 (`constraint-conflict`) and a density ≤ 0 (`material`).
 */
export function solveModal(input: ModalInput): ModalResult {
  const { mesh, material } = input;
  if (!(material.density > 0)) throw new ElasticError('material', 'density > 0 for a modal study');
  if (!Number.isInteger(input.modes) || input.modes < 1)
    throw new RangeError('modes must be a whole number ≥ 1');
  const prepared = prepareElastic({
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
        `node ${Math.floor(d / 3)} direction ${'xyz'[d % 3]}: a modal study holds DOFs at 0 only`,
      );
  const dofs = mesh.nodes.length;
  const free = new Uint8Array(dofs).fill(1);
  for (const d of prepared.prescribed.keys()) free[d] = 0;
  const freeCount = free.reduce((s, x) => s + x, 0);
  if (freeCount === 0)
    throw new ElasticError(
      'constraint-conflict',
      'the constraints hold every node in every direction: nothing is left to vibrate',
    );
  const K = assembleStiffness(mesh, material);
  const M = assembleMass(mesh, material.density);
  addNodalMasses(M, prepared.added, 3);
  const eigen = lowestModes({
    K,
    M,
    free,
    perNode: 3,
    coordinates: mesh.nodes,
    modes: input.modes,
    solver: input.solver,
    progress: input.progress,
  });
  const { modes, mass, orthogonality } = modalSummary(M, eigen, 3);
  return {
    modes,
    mass,
    iterations: eigen.iterations,
    converged: eigen.converged,
    orthogonality,
    constrainedNodes: prepared.constrainedNodes,
  };
}
