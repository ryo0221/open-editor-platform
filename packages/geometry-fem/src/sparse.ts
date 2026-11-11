/** Compressed sparse rows: `rowPtr` (rows + 1), sorted column indices per row. */
export interface CsrPattern {
  rows: number;
  rowPtr: Uint32Array;
  cols: Uint32Array;
}

/**
 * The pattern of a matrix with `perNode` DOFs per node (3 for a 3-D vector field, 1 for a scalar
 * such as temperature) where every pair of nodes of one element couples all their DOFs.
 */
export function csrPattern(
  dofs: number,
  elements: number,
  connectivity: (e: number) => ArrayLike<number>,
  nodesPerElement: number,
  perNode = 3,
): CsrPattern {
  const nodes = dofs / perNode;
  const adj: Set<number>[] = Array.from({ length: nodes }, () => new Set<number>());
  for (let e = 0; e < elements; e++) {
    const c = connectivity(e);
    for (let a = 0; a < nodesPerElement; a++)
      for (let b = 0; b < nodesPerElement; b++) adj[c[a]!]!.add(c[b]!);
  }
  const rowPtr = new Uint32Array(dofs + 1);
  const k = perNode;
  for (let p = 0; p < nodes; p++)
    for (let i = 0; i < k; i++) rowPtr[p * k + i + 1] = rowPtr[p * k + i]! + adj[p]!.size * k;
  const cols = new Uint32Array(rowPtr[dofs]!);
  for (let p = 0; p < nodes; p++) {
    const ns = [...adj[p]!].sort((x, y) => x - y);
    for (let i = 0; i < k; i++) {
      let at = rowPtr[p * k + i]!;
      for (const q of ns) for (let j = 0; j < k; j++) cols[at++] = q * k + j;
    }
  }
  return { rows: dofs, rowPtr, cols };
}

export class CsrMatrix {
  readonly values: Float64Array;
  constructor(readonly pattern: CsrPattern) {
    this.values = new Float64Array(pattern.cols.length);
  }
  /** Adds `v` at (i, j), which must be in the pattern. */
  add(i: number, j: number, v: number) {
    const { rowPtr, cols } = this.pattern;
    let lo = rowPtr[i]!,
      hi = rowPtr[i + 1]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cols[mid]!;
      if (c === j) {
        this.values[mid]! += v;
        return;
      }
      if (c < j) lo = mid + 1;
      else hi = mid - 1;
    }
    throw new RangeError(`csr-pattern: (${i}, ${j})`);
  }
  diagonal(): Float64Array {
    const { rowPtr, cols, rows } = this.pattern;
    const d = new Float64Array(rows);
    for (let i = 0; i < rows; i++)
      for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) if (cols[k] === i) d[i] = this.values[k]!;
    return d;
  }
  multiply(x: Float64Array, out = new Float64Array(this.pattern.rows)): Float64Array {
    const { rowPtr, cols, rows } = this.pattern;
    const v = this.values;
    for (let i = 0; i < rows; i++) {
      let s = 0;
      for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) s += v[k]! * x[cols[k]!]!;
      out[i] = s;
    }
    return out;
  }
}

/**
 * Preconditioned conjugate gradients on the DOFs where `mask` is 1 (the others are held at 0, i.e.
 * eliminated), Jacobi unless `precondition` is given (R3i-1: the shells use `incompleteFactor`).
 * Stops at ‖r‖ ≤ tolerance · ‖b‖ or after `maxIterations`.
 */
export function pcg(
  A: CsrMatrix,
  b: Float64Array,
  mask: Uint8Array,
  tolerance: number,
  maxIterations: number,
  /** A starting guess (R3g: the previous iterate); 0 when absent. */
  x0?: Float64Array,
  /** M⁻¹ r, 0 on the masked DOFs; Jacobi when absent. */
  precondition?: (r: Float64Array) => Float64Array,
): { x: Float64Array; iterations: number; residual: number; converged: boolean } {
  const n = b.length;
  const diag = A.diagonal();
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) inv[i] = mask[i] && diag[i]! > 0 ? 1 / diag[i]! : 0;
  const apply = (r: Float64Array, z: Float64Array) => {
    if (precondition) z.set(precondition(r));
    else for (let i = 0; i < n; i++) z[i] = r[i]! * inv[i]!;
  };
  const x = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = mask[i] ? b[i]! : 0;
  const norm = (v: Float64Array) => Math.sqrt(v.reduce((s, y) => s + y * y, 0));
  const bn = norm(r);
  if (bn === 0) return { x, iterations: 0, residual: 0, converged: true };
  if (x0) {
    for (let i = 0; i < n; i++) x[i] = mask[i] ? x0[i]! : 0;
    const Ax = A.multiply(x);
    for (let i = 0; i < n; i++) r[i] = mask[i] ? b[i]! - Ax[i]! : 0;
    const start = norm(r) / bn;
    if (start <= tolerance) return { x, iterations: 0, residual: start, converged: true };
  }
  const z = new Float64Array(n);
  apply(r, z);
  const p = z.slice();
  const q = new Float64Array(n);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i]! * z[i]!;
  let it = 0;
  let res = 1;
  for (; it < maxIterations; it++) {
    A.multiply(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) q[i] = 0;
      pq += p[i]! * q[i]!;
    }
    if (!(pq > 0)) break; // not positive definite on the free DOFs
    const alpha = rz / pq;
    for (let i = 0; i < n; i++) {
      x[i]! += alpha * p[i]!;
      r[i]! -= alpha * q[i]!;
    }
    res = norm(r) / bn;
    if (res <= tolerance) {
      it++;
      return { x, iterations: it, residual: res, converged: true };
    }
    apply(r, z);
    let rzNext = 0;
    for (let i = 0; i < n; i++) rzNext += r[i]! * z[i]!;
    const beta = rzNext / rz;
    rz = rzNext;
    for (let i = 0; i < n; i++) p[i] = z[i]! + beta * p[i]!;
  }
  return { x, iterations: it, residual: res, converged: false };
}

/**
 * R3g: an incomplete LU factorisation with no fill (ILU(0), the same as an incomplete Cholesky
 * for a symmetric matrix) on the pattern of `A`, restricted to the DOFs where `mask` is 1, as a
 * preconditioner: `apply(r)` returns (L U)⁻¹ r, 0 on the masked DOFs. A pivot that is not
 * positive (the factorisation broke down) retries with a growing diagonal shift.
 */
export function incompleteFactor(
  A: CsrMatrix,
  mask: Uint8Array,
): { apply(r: Float64Array): Float64Array; shift: number } {
  const { rowPtr, cols, rows } = A.pattern;
  const diagAt = new Int32Array(rows).fill(-1);
  for (let i = 0; i < rows; i++)
    for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) if (cols[k] === i) diagAt[i] = k;
  const where = new Int32Array(rows).fill(-1);
  for (let shift = 0; ; shift = shift ? shift * 10 : 1e-4) {
    if (shift > 1) throw new RangeError('incomplete factorisation broke down');
    const v = new Float64Array(A.values.length);
    for (let i = 0; i < rows; i++)
      for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) {
        const j = cols[k]!;
        v[k] = !mask[i] || !mask[j] ? (i === j ? 1 : 0) : A.values[k]! * (i === j ? 1 + shift : 1);
      }
    let ok = true;
    for (let i = 0; i < rows && ok; i++) {
      const start = rowPtr[i]!,
        end = rowPtr[i + 1]!;
      for (let k = start; k < end; k++) where[cols[k]!] = k;
      for (let k = start; k < end; k++) {
        const c = cols[k]!;
        if (c >= i) break;
        const pivot = v[diagAt[c]!]!;
        v[k]! /= pivot;
        const f = v[k]!;
        if (f === 0) continue;
        for (let kk = diagAt[c]! + 1; kk < rowPtr[c + 1]!; kk++) {
          const at = where[cols[kk]!]!;
          if (at >= 0) v[at]! -= f * v[kk]!;
        }
      }
      for (let k = start; k < end; k++) where[cols[k]!] = -1;
      if (!(v[diagAt[i]!]! > 0)) ok = false;
    }
    if (!ok) continue;
    const apply = (r: Float64Array) => {
      const y = new Float64Array(rows);
      for (let i = 0; i < rows; i++) {
        let s = mask[i] ? r[i]! : 0;
        for (let k = rowPtr[i]!; k < diagAt[i]!; k++) s -= v[k]! * y[cols[k]!]!;
        y[i] = s;
      }
      for (let i = rows - 1; i >= 0; i--) {
        let s = y[i]!;
        for (let k = diagAt[i]! + 1; k < rowPtr[i + 1]!; k++) s -= v[k]! * y[cols[k]!]!;
        y[i] = mask[i] ? s / v[diagAt[i]!]! : 0;
      }
      return y;
    };
    return { apply, shift };
  }
}
