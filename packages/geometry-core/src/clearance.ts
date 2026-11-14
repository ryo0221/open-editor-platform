/**
 * CR7c (docs/cad/car-design.md, CR7c): the clearance between two groups of posed meshes, the
 * shortest distance between their triangles and the two points it runs between (e.g. a tyre and
 * its wheel well). Pure. Like the interference check it reads the display meshes, so it is as
 * precise as their tessellation. Triangles that cross give 0 (the groups interfere).
 *
 * Both groups are moved into world coordinates and given a BVH each; the two trees are walked
 * nearest boxes first, skipping any pair of boxes farther apart than the best distance so far.
 */
import {
  buildBvh,
  trianglesPenetrate,
  type Bvh,
  type InterferenceMesh,
  type InterferencePose,
  type InterferenceVec3,
} from './interference';

export interface ClearancePiece {
  meshes: readonly InterferenceMesh[];
  pose: InterferencePose;
}
export interface ClearanceResult {
  distanceMm: number;
  /** The closest point on the first group and on the second (world, mm). */
  a: InterferenceVec3;
  b: InterferenceVec3;
  /** Triangles of each group read. */
  triangles: [number, number];
}
export const clearanceLimits = Object.freeze({ triangles: 2_000_000 });

type V = InterferenceVec3;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (a: V, b: V) => {
  const d = sub(a, b);
  return dot(d, d);
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function rotate(q: InterferencePose['rotation'], v: V): V {
  const [x, y, z, w] = q;
  const t: V = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

/** One group's triangles in world coordinates. */
function soup(pieces: readonly ClearancePiece[]) {
  let nv = 0;
  let nt = 0;
  for (const p of pieces)
    for (const m of p.meshes) {
      nv += m.positions.length / 3;
      nt += m.indices.length / 3;
    }
  const v = new Float64Array(nv * 3);
  const t = new Uint32Array(nt * 3);
  let ov = 0;
  let ot = 0;
  for (const p of pieces)
    for (const m of p.meshes) {
      const base = ov;
      for (let i = 0; i < m.positions.length / 3; i++) {
        const w = add(
          rotate(p.pose.rotation, [
            m.positions[3 * i]!,
            m.positions[3 * i + 1]!,
            m.positions[3 * i + 2]!,
          ]),
          p.pose.translationMm,
        );
        v.set(w, 3 * ov++);
      }
      for (let i = 0; i < m.indices.length; i++) t[ot++] = base + m.indices[i]!;
    }
  return { v, t };
}

/** The point of triangle abc closest to p (Ericson 5.1.5). */
export function closestOnTriangle(p: V, a: V, b: V, c: V): V {
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
  const den = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)));
}

/** The closest points of segments p1q1 and p2q2 (Ericson 5.1.9). */
export function closestOnSegments(p1: V, q1: V, p2: V, q2: V): [V, V] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-18 && e <= 1e-18) return [p1, p2];
  if (a <= 1e-18) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-18) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-18 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

/** The closest points of two triangles (0 apart when they cross). */
export function closestOnTriangles(ta: readonly V[], tb: readonly V[]): [V, V, number] {
  const seg: V[] = [];
  if (trianglesPenetrate(ta, tb, 0, seg) >= 0) return [seg[0]!, seg[0]!, 0];
  let best: [V, V, number] = [ta[0]!, tb[0]!, Infinity];
  const take = (a: V, b: V) => {
    const d = dist2(a, b);
    if (d < best[2]) best = [a, b, d];
  };
  for (const p of ta) take(p, closestOnTriangle(p, tb[0]!, tb[1]!, tb[2]!));
  for (const p of tb) take(closestOnTriangle(p, ta[0]!, ta[1]!, ta[2]!), p);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const [a, b] = closestOnSegments(ta[i]!, ta[(i + 1) % 3]!, tb[j]!, tb[(j + 1) % 3]!);
      take(a, b);
    }
  return [best[0], best[1], Math.sqrt(best[2])];
}

const boxGap2 = (x: Float64Array, i: number, y: Float64Array, j: number) => {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const g = Math.max(x[6 * i + k]! - y[6 * j + k + 3]!, y[6 * j + k]! - x[6 * i + k + 3]!, 0);
    s += g * g;
  }
  return s;
};

/**
 * The clearance between group `a` and group `b`, or undefined when either has no triangles.
 * Refuses (throws `clearance-limit`) past `clearanceLimits.triangles` in all.
 */
export function meshClearance(
  a: readonly ClearancePiece[],
  b: readonly ClearancePiece[],
): ClearanceResult | undefined {
  // Counted from the input before any copy into world coordinates (copies are not shared).
  const count = (g: readonly ClearancePiece[]) =>
    g.reduce((n, p) => p.meshes.reduce((m, x) => m + x.indices.length / 3, n), 0);
  const na = count(a);
  const nb = count(b);
  if (!na || !nb) return undefined;
  if (na + nb > clearanceLimits.triangles) throw new Error('clearance-limit');
  const A = soup(a);
  const B = soup(b);
  const ba: Bvh = buildBvh(A.v, A.t);
  const bb: Bvh = buildBvh(B.v, B.t);
  const tri = (s: { v: Float64Array; t: Uint32Array }, i: number): V[] =>
    [0, 1, 2].map((k) => {
      const p = s.t[3 * i + k]! * 3;
      return [s.v[p]!, s.v[p + 1]!, s.v[p + 2]!] as V;
    });
  let best = Infinity;
  let pa: V = [0, 0, 0];
  let pb: V = [0, 0, 0];
  // Pairs of nodes, nearest first (a small binary heap on the boxes' squared gap).
  const heap: [number, number, number][] = [[boxGap2(ba.boxes, 0, bb.boxes, 0), 0, 0]];
  const push = (e: [number, number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const leaf = (bvh: Bvh, n: number) => bvh.left[n]! < 0;
  const size = (bvh: Bvh, n: number) => {
    const o = 6 * n;
    return (
      bvh.boxes[o + 3]! -
      bvh.boxes[o]! +
      bvh.boxes[o + 4]! -
      bvh.boxes[o + 1]! +
      bvh.boxes[o + 5]! -
      bvh.boxes[o + 2]!
    );
  };
  while (heap.length) {
    const [gap, i, j] = pop();
    if (gap >= best * best) break;
    const li = leaf(ba, i);
    const lj = leaf(bb, j);
    if (li && lj) {
      const si = -1 - ba.left[i]!;
      const sj = -1 - bb.left[j]!;
      for (let x = si; x < si + ba.count[i]!; x++) {
        const ta = tri(A, ba.order[x]!);
        for (let y = sj; y < sj + bb.count[j]!; y++) {
          const [p, q, d] = closestOnTriangles(ta, tri(B, bb.order[y]!));
          if (d < best) [best, pa, pb] = [d, p, q];
        }
      }
      if (best === 0) break;
      continue;
    }
    // Open the larger node (or the only inner one).
    if (!li && (lj || size(ba, i) >= size(bb, j)))
      for (const c of [ba.left[i]!, ba.right[i]!]) push([boxGap2(ba.boxes, c, bb.boxes, j), c, j]);
    else
      for (const c of [bb.left[j]!, bb.right[j]!]) push([boxGap2(ba.boxes, i, bb.boxes, c), i, c]);
  }
  return { distanceMm: best, a: pa, b: pb, triangles: [na, nb] };
}
