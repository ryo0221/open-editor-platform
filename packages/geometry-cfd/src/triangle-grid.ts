/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): a uniform grid over a triangle surface for the water
 * analyses' two queries: the first triangle a ray meets (the seal's distance to the closure, a
 * drop's flight) and the nearest point on the surface (where a seal point sits on its face).
 */
import { CfdError } from './errors';
import type { TriangleSurface } from './voxelize';

export type Vec3 = [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** A ray's hit: the distance along the (unit) direction, the triangle and its barycentric u, v. */
export interface RayHit {
  t: number;
  triangle: number;
  u: number;
  v: number;
}
/** The nearest point of the surface to a point. */
export interface NearestPoint {
  triangle: number;
  point: Vec3;
  distance: number;
}

/** The largest grid the index builds (cells); a coarser cell is taken above it. */
const maxCells = 2_000_000;

/** Checks a surface's arrays (finite points, indices in range); throws `surface-invalid`. */
export function checkTriangles(s: TriangleSurface, what = 'surface'): void {
  const n = s.positions.length / 3;
  if (!Number.isInteger(n) || s.triangles.length % 3 !== 0)
    throw new CfdError('surface-invalid', `${what}: arrays are not whole points and triangles`);
  for (let i = 0; i < s.positions.length; i++)
    if (!Number.isFinite(s.positions[i]!))
      throw new CfdError('surface-invalid', `${what}: a coordinate is not finite`);
  for (let i = 0; i < s.triangles.length; i++)
    if (s.triangles[i]! >= n)
      throw new CfdError('surface-invalid', `${what}: an index is out of range`);
}

export class TriangleGrid {
  readonly lo: Vec3;
  readonly cell: number;
  readonly dims: [number, number, number];
  /** CSR: triangles of cell c are `items[start[c] .. start[c + 1]]`. */
  readonly #start: Uint32Array;
  readonly #items: Uint32Array;
  /** Per triangle its unit normal by its winding (x, y, z), zero for a degenerate one. */
  readonly normals: Float64Array;
  /** A stamp per triangle, so a query visits each once. */
  #stamp: Uint32Array;
  #query = 0;

  constructor(
    readonly surface: TriangleSurface,
    cellMm?: number,
  ) {
    checkTriangles(surface);
    const p = surface.positions;
    const t = surface.triangles;
    const count = t.length / 3;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, p[i + a]!);
        hi[a] = Math.max(hi[a]!, p[i + a]!);
      }
    if (!count) {
      lo.fill(0);
      hi.fill(1);
    }
    let edge = 0;
    for (let k = 0; k < t.length; k += 3) {
      const a = 3 * t[k]!;
      const b = 3 * t[k + 1]!;
      edge += Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
    }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    let cell = cellMm ?? Math.max(count ? (2 * edge) / count : span, span / 256, 1e-3);
    const dimsOf = (c: number): [number, number, number] =>
      [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a]! - lo[a]!) / c + 1e-9))) as [
        number,
        number,
        number,
      ];
    let dims = dimsOf(cell);
    while (dims[0] * dims[1] * dims[2] > maxCells) {
      cell *= 1.5;
      dims = dimsOf(cell);
    }
    this.lo = lo;
    this.cell = cell;
    this.dims = dims;
    this.normals = new Float64Array(3 * count);
    const cells = dims[0] * dims[1] * dims[2];
    const counts = new Uint32Array(cells + 1);
    const each = (k: number, f: (c: number) => void) => {
      const r = [0, 1, 2].map((a) => {
        const v = [p[3 * t[k]! + a]!, p[3 * t[k + 1]! + a]!, p[3 * t[k + 2]! + a]!];
        return [
          Math.max(0, Math.floor((Math.min(...v) - lo[a]!) / cell)),
          Math.min(dims[a]! - 1, Math.floor((Math.max(...v) - lo[a]!) / cell)),
        ];
      });
      for (let z = r[2]![0]!; z <= r[2]![1]!; z++)
        for (let y = r[1]![0]!; y <= r[1]![1]!; y++)
          for (let x = r[0]![0]!; x <= r[0]![1]!; x++) f(x + dims[0] * (y + dims[1] * z));
    };
    for (let k = 0; k < t.length; k += 3) each(k, (c) => counts[c + 1]!++);
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    const fill = counts.slice(0, cells);
    const items = new Uint32Array(counts[cells]!);
    for (let k = 0; k < t.length; k += 3) {
      each(k, (c) => (items[fill[c]!++] = k / 3));
      const [a, b, d] = [this.point(t[k]!), this.point(t[k + 1]!), this.point(t[k + 2]!)];
      const n = unit(cross(sub(b, a), sub(d, a)));
      this.normals.set(n, k);
    }
    this.#start = counts;
    this.#items = items;
    this.#stamp = new Uint32Array(count);
  }

  point(i: number): Vec3 {
    const p = this.surface.positions;
    return [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
  }
  corners(tri: number): [Vec3, Vec3, Vec3] {
    const t = this.surface.triangles;
    return [this.point(t[3 * tri]!), this.point(t[3 * tri + 1]!), this.point(t[3 * tri + 2]!)];
  }
  normal(tri: number): Vec3 {
    const n = this.normals;
    return [n[3 * tri]!, n[3 * tri + 1]!, n[3 * tri + 2]!];
  }
  #next() {
    if (++this.#query === 0xffffffff) {
      this.#stamp.fill(0);
      this.#query = 1;
    }
    return this.#query;
  }

  /**
   * The first triangle the ray `origin + t·dir` (unit `dir`) meets with `tMin ≤ t ≤ tMax`, either
   * side of the triangle, or null. `skip` leaves one triangle out (the one a point starts on).
   */
  raycast(origin: Vec3, dir: Vec3, tMin: number, tMax: number, skip = -1): RayHit | null {
    const { lo, cell, dims } = this;
    // Clip the ray to the grid's box.
    let t0 = tMin;
    let t1 = tMax;
    for (let a = 0; a < 3; a++) {
      const lo_a = lo[a]!;
      const hi_a = lo_a + dims[a]! * cell;
      if (Math.abs(dir[a]!) < 1e-300) {
        if (origin[a]! < lo_a || origin[a]! > hi_a) return null;
        continue;
      }
      let ta = (lo_a - origin[a]!) / dir[a]!;
      let tb = (hi_a - origin[a]!) / dir[a]!;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    const q = this.#next();
    const start = add(origin, scale(dir, t0));
    const ijk = [0, 1, 2].map((a) =>
      Math.min(dims[a]! - 1, Math.max(0, Math.floor((start[a]! - lo[a]!) / cell))),
    ) as [number, number, number];
    const step = [0, 1, 2].map((a) => (dir[a]! > 0 ? 1 : dir[a]! < 0 ? -1 : 0));
    const tNext = [0, 1, 2].map((a) =>
      step[a] === 0
        ? Infinity
        : (lo[a]! + (ijk[a]! + (step[a]! > 0 ? 1 : 0)) * cell - origin[a]!) / dir[a]!,
    );
    const tDelta = [0, 1, 2].map((a) => (step[a] === 0 ? Infinity : cell / Math.abs(dir[a]!)));
    let best: RayHit | null = null;
    for (;;) {
      const c = ijk[0] + dims[0] * (ijk[1] + dims[1] * ijk[2]);
      for (let k = this.#start[c]!; k < this.#start[c + 1]!; k++) {
        const tri = this.#items[k]!;
        if (this.#stamp[tri] === q || tri === skip) continue;
        this.#stamp[tri] = q;
        const h = this.#intersect(tri, origin, dir);
        if (h && h.t >= tMin && h.t <= tMax && (!best || h.t < best.t)) best = h;
      }
      const a =
        tNext[0]! < tNext[1]! ? (tNext[0]! < tNext[2]! ? 0 : 2) : tNext[1]! < tNext[2]! ? 1 : 2;
      // A hit nearer than the next cell's boundary cannot be beaten by a later cell.
      if (best && best.t <= tNext[a]!) return best;
      if (tNext[a]! > t1) return best;
      ijk[a] += step[a]!;
      if (ijk[a]! < 0 || ijk[a]! >= dims[a]!) return best;
      tNext[a]! += tDelta[a]!;
    }
  }

  /** Möller–Trumbore, both sides. */
  #intersect(tri: number, o: Vec3, d: Vec3): RayHit | null {
    const [a, b, c] = this.corners(tri);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const pv = cross(d, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-14 * (norm(e1) * norm(e2) || 1)) return null;
    const inv = 1 / det;
    const tv = sub(o, a);
    const u = dot(tv, pv) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    const qv = cross(tv, e1);
    const v = dot(d, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    return { t: dot(e2, qv) * inv, triangle: tri, u, v };
  }

  /** The nearest point of the surface within `maxDist` of `p`, or null. */
  nearest(p: Vec3, maxDist: number): NearestPoint | null {
    const { lo, cell, dims } = this;
    const q = this.#next();
    let best: NearestPoint | null = null;
    const r = [0, 1, 2].map((a) => [
      Math.max(0, Math.floor((p[a]! - maxDist - lo[a]!) / cell)),
      Math.min(dims[a]! - 1, Math.floor((p[a]! + maxDist - lo[a]!) / cell)),
    ]);
    for (let z = r[2]![0]!; z <= r[2]![1]!; z++)
      for (let y = r[1]![0]!; y <= r[1]![1]!; y++)
        for (let x = r[0]![0]!; x <= r[0]![1]!; x++) {
          const c = x + dims[0] * (y + dims[1] * z);
          for (let k = this.#start[c]!; k < this.#start[c + 1]!; k++) {
            const tri = this.#items[k]!;
            if (this.#stamp[tri] === q) continue;
            this.#stamp[tri] = q;
            const point = closestOnTriangle(p, ...this.corners(tri));
            const distance = norm(sub(point, p));
            if (distance <= maxDist && (!best || distance < best.distance))
              best = { triangle: tri, point, distance };
          }
        }
    return best;
  }
}

/** The point of triangle a b c nearest to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/** `s` turned by `angleRad` about the axis through `origin` along unit `axis` (right hand). */
export function turnSurface(
  s: TriangleSurface,
  origin: Vec3,
  axis: Vec3,
  angleRad: number,
): TriangleSurface {
  const k = unit(axis);
  const c = Math.cos(angleRad);
  const sn = Math.sin(angleRad);
  const p = s.positions;
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const v: Vec3 = [p[i]! - origin[0], p[i + 1]! - origin[1], p[i + 2]! - origin[2]];
    // Rodrigues: v cos + (k × v) sin + k (k·v)(1 − cos).
    const kv = cross(k, v);
    const kd = dot(k, v) * (1 - c);
    out[i] = origin[0] + v[0] * c + kv[0] * sn + k[0] * kd;
    out[i + 1] = origin[1] + v[1] * c + kv[1] * sn + k[1] * kd;
    out[i + 2] = origin[2] + v[2] * c + kv[2] * sn + k[2] * kd;
  }
  return { ...s, positions: out };
}
