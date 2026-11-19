import { localFaces, nodesPerElement, tet10Edges, type FemMesh } from './fem';
import { boundaryFaceList, boundaryFacePoints, ElasticError } from './elastic';

/**
 * VS11b (docs/cad/vehicle-simulation.md, VS11): face-to-face radiation between gray, diffuse
 * surfaces. Each boundary face of the enclosure's shape faces is one patch. View factors F_ij
 * come from rays cast from each patch (cosine-weighted, stratified, deterministic) against every
 * boundary face of the mesh, so anything in between (a heat shield) blocks them. A ray that leaves
 * the mesh goes to the surroundings; one that hits a boundary face outside the enclosure is
 * counted as `unseen` and treated as the surroundings too (the result names that fraction, so the
 * missing faces can be added).
 */
export interface RadiationLimits {
  patches: number;
  raysPerPatch: number;
  rays: number;
}
export const radiationLimits: Readonly<RadiationLimits> = Object.freeze({
  patches: 4000,
  raysPerPatch: 1024,
  rays: 2_000_000,
});

export interface RadiationPatch {
  /** The boundary face (element, local face) and its shape face. */
  e: number;
  lf: number;
  face: number;
  /** mm². */
  area: number;
  /** The face's nodes and ∫ N_a dA of each (their sum is `area`). */
  nodes: number[];
  weights: number[];
}

export interface ViewFactors {
  patches: RadiationPatch[];
  /** F_ij in compressed rows (patch i to patch j), reciprocal: A_i F_ij = A_j F_ji. */
  rowPtr: Uint32Array;
  cols: Uint32Array;
  values: Float64Array;
  /** Per patch: the fraction to the surroundings (open, plus unseen), and the unseen part alone. */
  ambient: Float64Array;
  unseen: Float64Array;
  rays: number;
}

/** Splits a boundary face into flat triangles for the ray tests: 1 (tet4) or 4 (tet10). */
function faceTriangles(mesh: FemMesh, e: number, lf: number): number[][] {
  const npe = nodesPerElement(mesh.type);
  const c = localFaces[lf]!.map((k) => mesh.elements[e * npe + k]!);
  if (mesh.type === 'tet4') return [c];
  const lc = localFaces[lf]!;
  const mid = (a: number, b: number) => {
    const k = tet10Edges.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
    return mesh.elements[e * npe + 4 + k]!;
  };
  const m01 = mid(lc[0]!, lc[1]!),
    m12 = mid(lc[1]!, lc[2]!),
    m20 = mid(lc[2]!, lc[0]!);
  return [
    [c[0]!, m01, m20],
    [m01, c[1]!, m12],
    [m20, m12, c[2]!],
    [m01, m12, m20],
  ];
}

/** A bounding-volume hierarchy over flat triangles, for the first hit along a ray. */
class TriangleTree {
  private readonly order: Uint32Array;
  private readonly nodeBox: Float64Array[] = [];
  private readonly left: number[] = [];
  private readonly right: number[] = [];
  private readonly nodeRange: [number, number][] = [];
  constructor(
    private readonly tri: Float64Array, // 9 per triangle
    count: number,
  ) {
    this.order = new Uint32Array(count).map((_, i) => i);
    const cent = new Float64Array(3 * count);
    for (let t = 0; t < count; t++)
      for (let d = 0; d < 3; d++)
        cent[3 * t + d] = (tri[9 * t + d]! + tri[9 * t + 3 + d]! + tri[9 * t + 6 + d]!) / 3;
    const build = (lo: number, hi: number): number => {
      const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let i = lo; i < hi; i++) {
        const t = this.order[i]!;
        for (let v = 0; v < 3; v++)
          for (let d = 0; d < 3; d++) {
            const x = tri[9 * t + 3 * v + d]!;
            box[d] = Math.min(box[d]!, x);
            box[3 + d] = Math.max(box[3 + d]!, x);
          }
      }
      const id = this.nodeBox.length;
      this.nodeBox.push(box);
      this.left.push(-1);
      this.right.push(-1);
      this.nodeRange.push([lo, hi]);
      if (hi - lo <= 4) return id;
      let axis = 0;
      for (let d = 1; d < 3; d++) if (box[3 + d]! - box[d]! > box[3 + axis]! - box[axis]!) axis = d;
      this.order.subarray(lo, hi).sort((a, b) => cent[3 * a + axis]! - cent[3 * b + axis]!);
      const mid = (lo + hi) >> 1;
      this.left[id] = build(lo, mid);
      this.right[id] = build(mid, hi);
      return id;
    };
    if (count) build(0, count);
  }
  /** The first triangle hit at a distance in (tMin, ∞), or −1; `skip` triangles are ignored. */
  hit(o: number[], d: number[], tMin: number, skip: (t: number) => boolean): number {
    const tri = this.tri;
    const inv = d.map((x) => 1 / x);
    let best = Infinity;
    let found = -1;
    if (!this.nodeBox.length) return -1;
    const stack = [0];
    while (stack.length) {
      const id = stack.pop()!;
      const box = this.nodeBox[id]!;
      let t0 = tMin,
        t1 = best;
      let miss = false;
      for (let k = 0; k < 3; k++) {
        let a = (box[k]! - o[k]!) * inv[k]!;
        let b = (box[3 + k]! - o[k]!) * inv[k]!;
        if (a > b) [a, b] = [b, a];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) {
          miss = true;
          break;
        }
      }
      if (miss) continue;
      if (this.left[id]! >= 0) {
        stack.push(this.left[id]!, this.right[id]!);
        continue;
      }
      const [lo, hi] = this.nodeRange[id]!;
      for (let i = lo; i < hi; i++) {
        const t = this.order[i]!;
        if (skip(t)) continue;
        const s = rayTriangle(tri, t, o, d);
        if (s > tMin && s < best) {
          best = s;
          found = t;
        }
      }
    }
    return found;
  }
}

/** Möller–Trumbore: the ray parameter of the hit, or −1. Both sides count. */
function rayTriangle(tri: Float64Array, t: number, o: number[], d: number[]): number {
  const b = 9 * t;
  const e1 = [0, 1, 2].map((k) => tri[b + 3 + k]! - tri[b + k]!);
  const e2 = [0, 1, 2].map((k) => tri[b + 6 + k]! - tri[b + k]!);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-300) return -1;
  const s = [0, 1, 2].map((k) => o[k]! - tri[b + k]!);
  const u = dot(s, p) / det;
  if (u < 0 || u > 1) return -1;
  const q = cross(s, e1);
  const v = dot(d, q) / det;
  if (v < 0 || u + v > 1) return -1;
  return dot(e2, q) / det;
}
const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** The radical inverse in base b (Halton). */
function radical(i: number, b: number): number {
  let f = 1,
    r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}
/** A fixed per-patch shift in [0, 1) (Cranley–Patterson rotation), from an integer hash. */
function shift(i: number, k: number): number {
  let h = (i * 0x9e3779b1 + k * 0x85ebca77) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The view factors between the boundary faces of `faces` (shape faces), `raysPerPatch` rays from
 * each. Refuses a face index the mesh does not have (`target-index`), no face (`empty-target`),
 * and more patches or rays than `radiationLimits` (`limit`).
 */
export function viewFactors(
  mesh: FemMesh,
  faces: readonly number[],
  raysPerPatch: number,
  limits: Partial<RadiationLimits> = {},
): ViewFactors {
  const lim = { ...radiationLimits, ...limits };
  if (!Number.isSafeInteger(raysPerPatch) || raysPerPatch < 1 || raysPerPatch > lim.raysPerPatch)
    throw new ElasticError('limit', `rays per patch in 1..${lim.raysPerPatch}`);
  const list = boundaryFaceList(mesh, faces);
  if (!list.length) throw new ElasticError('empty-target', 'the enclosure has no face');
  if (list.length > lim.patches)
    throw new ElasticError('limit', `${list.length} patches, more than ${lim.patches}`);
  if (list.length * raysPerPatch > lim.rays)
    throw new ElasticError('limit', `${list.length * raysPerPatch} rays, more than ${lim.rays}`);

  // Every boundary face blocks; each knows its patch (or −1).
  const patchOf = new Map<string, number>();
  list.forEach(({ e, lf }, i) => patchOf.set(`${e}:${lf}`, i));
  const B = mesh.boundary.tags.length;
  const tagOf = new Map<string, number>();
  const tris: number[] = [];
  const triPatch: number[] = [];
  for (let b = 0; b < B; b++) {
    const e = mesh.boundary.elements[b]!;
    const lf = mesh.boundary.localFaces[b]!;
    const pi = patchOf.get(`${e}:${lf}`) ?? -1;
    tagOf.set(`${e}:${lf}`, mesh.boundary.tags[b]!);
    for (const t of faceTriangles(mesh, e, lf)) {
      for (const p of t)
        tris.push(mesh.nodes[3 * p]!, mesh.nodes[3 * p + 1]!, mesh.nodes[3 * p + 2]!);
      triPatch.push(pi);
    }
  }
  const triCount = triPatch.length;
  const triArray = new Float64Array(tris);
  const tree = new TriangleTree(triArray, triCount);

  // Patches: area, nodal weights and the sub-triangles to shoot from.
  const patches: RadiationPatch[] = list.map(({ e, lf }) => {
    const { nodes, points } = boundaryFacePoints(mesh, e, lf);
    const weights = nodes.map(() => 0);
    let area = 0;
    for (const { N, normal } of points) {
      const dA = Math.hypot(...normal);
      area += dA;
      N.forEach((na, a) => (weights[a]! += na * dA));
    }
    return { e, lf, face: tagOf.get(`${e}:${lf}`)!, area, nodes, weights };
  });
  const own = patches.map(() => [] as number[]);
  triPatch.forEach((pi, t) => pi >= 0 && own[pi]!.push(t));
  const raw: Map<number, number>[] = patches.map(() => new Map());
  const ambient = new Float64Array(patches.length);
  const unseen = new Float64Array(patches.length);
  let size = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let t = 0; t < triCount; t++)
      for (let v = 0; v < 3; v++) {
        lo = Math.min(lo, triArray[9 * t + 3 * v + k]!);
        hi = Math.max(hi, triArray[9 * t + 3 * v + k]!);
      }
    size = Math.max(size, hi - lo);
  }
  const eps = 1e-9 * Math.max(size, 1);
  patches.forEach((patch, i) => {
    const subs = own[i]!;
    const subArea = subs.map((t) => {
      const b = 9 * t;
      const e1 = [0, 1, 2].map((k) => triArray[b + 3 + k]! - triArray[b + k]!);
      const e2 = [0, 1, 2].map((k) => triArray[b + 6 + k]! - triArray[b + k]!);
      return Math.hypot(...cross(e1, e2)) / 2;
    });
    const total = subArea.reduce((s, a) => s + a, 0);
    const ownSet = new Set(subs);
    const s0 = shift(i, 0),
      s1 = shift(i, 1),
      s2 = shift(i, 2),
      s3 = shift(i, 3);
    for (let r = 0; r < raysPerPatch; r++) {
      // Pick the sub-triangle by area, a point on it and a cosine-weighted direction.
      let pick = ((r + 0.5) / raysPerPatch) * total;
      let st = 0;
      while (st < subs.length - 1 && pick > subArea[st]!) pick -= subArea[st++]!;
      const t = subs[st]!;
      const b = 9 * t;
      let u = (radical(r + 1, 2) + s0) % 1,
        v = (radical(r + 1, 3) + s1) % 1;
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const P = [0, 1, 2].map(
        (k) =>
          triArray[b + k]! +
          u * (triArray[b + 3 + k]! - triArray[b + k]!) +
          v * (triArray[b + 6 + k]! - triArray[b + k]!),
      );
      const e1 = [0, 1, 2].map((k) => triArray[b + 3 + k]! - triArray[b + k]!);
      const e2 = [0, 1, 2].map((k) => triArray[b + 6 + k]! - triArray[b + k]!);
      const nrm = cross(e1, e2);
      const nl = Math.hypot(...nrm);
      const n = nrm.map((x) => x / nl); // outward (local faces wind outward)
      const a = Math.abs(n[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const tx = cross(n, a);
      const tl = Math.hypot(...tx);
      const t1 = tx.map((x) => x / tl);
      const t2 = cross(n, t1);
      const q1 = (radical(r + 1, 5) + s2) % 1,
        q2 = (radical(r + 1, 7) + s3) % 1;
      const rad = Math.sqrt(q1),
        phi = 2 * Math.PI * q2,
        h = Math.sqrt(Math.max(0, 1 - q1));
      const d = [0, 1, 2].map(
        (k) => rad * Math.cos(phi) * t1[k]! + rad * Math.sin(phi) * t2[k]! + h * n[k]!,
      );
      const O = P.map((x, k) => x + eps * n[k]!);
      const hit = tree.hit(O, d, eps, (x) => ownSet.has(x));
      if (hit < 0) ambient[i]! += 1;
      else if (triPatch[hit]! < 0) {
        ambient[i]! += 1;
        unseen[i]! += 1;
      } else {
        const j = triPatch[hit]!;
        raw[i]!.set(j, (raw[i]!.get(j) ?? 0) + 1);
      }
    }
  });

  // Reciprocity: A_i F_ij = A_j F_ji, the mean of the two estimates; the rest goes to ambient.
  const R = raysPerPatch;
  const rows: Map<number, number>[] = patches.map(() => new Map());
  raw.forEach((row, i) =>
    row.forEach((count, j) => {
      const fij = count / R;
      const fji = (raw[j]!.get(i) ?? 0) / R;
      const g = (patches[i]!.area * fij + patches[j]!.area * fji) / 2; // A_i F_ij
      rows[i]!.set(j, g / patches[i]!.area);
      rows[j]!.set(i, g / patches[j]!.area);
    }),
  );
  // A row over 1 (sampling noise after the mean) is limited without breaking reciprocity: each
  // pair's A_i F_ij is scaled by √(c_i c_j), c_i = min(1, 1 / Σ_j F_ij), a few times, and then by
  // min(c_i, c_j) once, so A F stays symmetric (the exchange between patches still cancels), no
  // row exceeds 1, and the rows under 1 lose as little as they can.
  const sums = () =>
    rows.map((row) => {
      let sum = 0;
      for (const f of row.values()) sum += f;
      return sum > 1 ? 1 / sum : 1;
    });
  const limit = (pair: (a: number, b: number) => number) => {
    const c = sums();
    if (c.every((x) => x === 1)) return false;
    const next = rows.map(
      (row, i) => new Map([...row].map(([j, f]) => [j, f * pair(c[i]!, c[j]!)])),
    );
    next.forEach((row, i) => (rows[i] = row));
    return true;
  };
  for (let pass = 0; pass < 20 && limit((x, y) => Math.sqrt(x * y)); pass++);
  limit(Math.min);
  const rowPtr = new Uint32Array(patches.length + 1);
  rows.forEach((row, i) => (rowPtr[i + 1] = rowPtr[i]! + row.size));
  const cols = new Uint32Array(rowPtr[patches.length]!);
  const values = new Float64Array(cols.length);
  rows.forEach((row, i) => {
    let at = rowPtr[i]!;
    let sum = 0;
    for (const [j, f] of [...row].sort((x, y) => x[0] - y[0])) {
      cols[at] = j;
      values[at++] = f;
      sum += f;
    }
    ambient[i] = Math.max(0, 1 - sum);
    unseen[i]! /= R;
  });
  return { patches, rowPtr, cols, values, ambient, unseen, rays: patches.length * R };
}

/**
 * The radiosities J of gray diffuse patches at temperatures T (K) with emissivities ε, the
 * surroundings at T∞: (1/ε) J − (1/ε − 1) G = σ T⁴ ... solved as J = ε σ T⁴ + (1 − ε) G,
 * G = Σ F_ij J_j + F_i∞ σ T∞⁴, by Gauss–Seidel. Returns the net flux into each patch
 * q = ε (G − σ T⁴) (mW/mm²).
 */
export function radiosityFlux(
  vf: ViewFactors,
  temperature: ArrayLike<number>,
  emissivity: ArrayLike<number>,
  ambientTemperature: number,
  sigma: number,
  tolerance = 1e-12,
  maxIterations = 10_000,
): { flux: Float64Array; iterations: number; converged: boolean } {
  const n = vf.patches.length;
  const E = new Float64Array(n);
  for (let i = 0; i < n; i++) E[i] = sigma * temperature[i]! ** 4;
  const Ea = sigma * ambientTemperature ** 4;
  const J = E.slice();
  let scale = Ea;
  for (let i = 0; i < n; i++) scale = Math.max(scale, E[i]!);
  let it = 0;
  let converged = false;
  for (; it < maxIterations; it++) {
    let change = 0;
    for (let i = 0; i < n; i++) {
      let G = vf.ambient[i]! * Ea;
      for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++) G += vf.values[q]! * J[vf.cols[q]!]!;
      const e = emissivity[i]!;
      const next = e * E[i]! + (1 - e) * G;
      change = Math.max(change, Math.abs(next - J[i]!));
      J[i] = next;
    }
    if (change <= tolerance * Math.max(scale, 1e-300)) {
      converged = true;
      it++;
      break;
    }
  }
  const flux = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let G = vf.ambient[i]! * Ea;
    for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++) G += vf.values[q]! * J[vf.cols[q]!]!;
    flux[i] = emissivity[i]! * (G - E[i]!);
  }
  return { flux, iterations: it, converged };
}
