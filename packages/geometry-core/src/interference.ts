/**
 * MR3 static interference on tessellated meshes (docs/cad/mecha-design.md, MR3（干渉の検査）).
 * Pure: bodies are triangle meshes in their own coordinates with a pose; the result lists the
 * pairs that penetrate, contain one another, or cannot be judged. Accurate only to the meshes'
 * tessellation: it is a check, not an exact Boolean.
 *
 * - Broad phase: world boxes of the posed bodies. Nothing is left out because two bodies are
 *   joined: only the caller's explicit allowances remove a pair or a region.
 * - Crossing: triangle pairs found through a BVH over each mesh in its own coordinates (built
 *   once per mesh object, so a new pose needs no new tree), tested exactly with a contact
 *   tolerance: faces that only touch (coplanar, or meeting along an edge) do not interfere.
 * - Containment: each body's mesh is split into shells by edge connectivity (vertices welded by
 *   position first, as a kernel's per-face meshes repeat them). A closed shell is inside the
 *   other body when a ray from one of its vertices crosses the other body's closed shells an odd
 *   number of times, both ways round. A solid's mesh with an open shell (a mesh hole) cannot be
 *   judged: such a pair is `unknown`, never reported clear. A sheet's mesh (`sheet`) contains
 *   nothing and its open shells are not holes.
 */

export type InterferenceVec3 = [number, number, number];
/** A unit quaternion `[x, y, z, w]` and a translation (mm), as CAD poses are stored. */
export interface InterferencePose {
  rotation: [number, number, number, number];
  translationMm: InterferenceVec3;
}
export interface InterferenceMesh {
  /** x, y, z per vertex, in the body's own coordinates (mm). */
  positions: ArrayLike<number>;
  /** Three vertex indices per triangle. */
  indices: ArrayLike<number>;
  /**
   * A sheet's surface (no volume): its open shells are not holes and it contains nothing. Any
   * other mesh is a solid's: an open shell in it is a mesh hole.
   */
  sheet?: boolean;
}
export interface InterferenceBody {
  id: string;
  meshes: readonly InterferenceMesh[];
  pose: InterferencePose;
  /**
   * Bodies of one group (one part's separate bodies, each its own volume) are not checked
   * against each other, and allowances name the group instead of the body.
   */
  group?: string;
}
export type InterferenceRegion =
  /** The whole pair is allowed. */
  | { kind: 'pair' }
  /**
   * Only what lies wholly inside this world sphere is allowed: where triangles cross (their
   * shared segment), and what of each shell lies inside the other body (a contained shell's
   * vertices; a crossing shell's inside vertices, probes and vertices on the other's surface).
   */
  | { kind: 'sphere'; centerMm: InterferenceVec3; radiusMm: number };
export interface InterferenceAllowance {
  a: string;
  b: string;
  region: InterferenceRegion;
}
export interface InterferenceFinding {
  a: string;
  b: string;
  /** `intersect` (surfaces cross), `contain` (a closed shell is inside the other), `unknown`. */
  kind: 'intersect' | 'contain' | 'unknown';
  /** A rough penetration depth (mm): the largest of the crossing triangles' or contained shells'. */
  depthMm: number;
  /** Crossing triangle pairs not allowed. */
  crossings: number;
  /** Closed shells inside the other body, not allowed. */
  contained: number;
  /** For `unknown`: which body could not be judged. */
  unknownBody?: string;
}
export type InterferenceResult =
  | { status: 'ok'; findings: InterferenceFinding[]; pairs: number; triangles: number }
  | { status: 'refused'; code: 'interference-limit'; triangles: number; pairs: number };

/** Safety limits (not performance claims, MR-U7). */
export const interferenceLimits = Object.freeze({
  triangles: 2_000_000,
  candidatePairs: 10_000,
});
/** Surfaces closer than this (mm) touch; they do not interfere. */
export const interferenceContactMm = 1e-3;
/** Vertices closer than this (mm) are one vertex when shells are found. */
const weldMm = 1e-4;

type Box = [number, number, number, number, number, number];

const rotate = (q: InterferencePose['rotation'], v: InterferenceVec3): InterferenceVec3 => {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
};
const conj = (q: InterferencePose['rotation']): InterferencePose['rotation'] => [
  -q[0],
  -q[1],
  -q[2],
  q[3],
];
const toWorld = (p: InterferencePose, v: InterferenceVec3): InterferenceVec3 => {
  const r = rotate(p.rotation, v);
  return [r[0] + p.translationMm[0], r[1] + p.translationMm[1], r[2] + p.translationMm[2]];
};
const toLocal = (p: InterferencePose, v: InterferenceVec3): InterferenceVec3 =>
  rotate(conj(p.rotation), [
    v[0] - p.translationMm[0],
    v[1] - p.translationMm[1],
    v[2] - p.translationMm[2],
  ]);

/** One body's triangles in its own coordinates, welded, with shells and a BVH. */
interface Prepared {
  /** x, y, z per welded vertex. */
  v: Float64Array;
  /** Three welded vertex indices per triangle. */
  t: Uint32Array;
  /** Shell index per triangle. */
  shellOf: Uint32Array;
  shells: { closed: boolean; sheet: boolean; vertices: number[] }[];
  bvh: Bvh;
  box: Box;
}

/** A BVH over triangles: nodes as boxes, leaves as ranges of `order`. */
interface Bvh {
  boxes: Float64Array;
  /** Per node: left child, or −1 − first item for a leaf. */
  left: Int32Array;
  right: Int32Array;
  count: Int32Array;
  order: Uint32Array;
}
const leafSize = 8;

function triBox(v: Float64Array, t: Uint32Array, i: number, out: Box) {
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  for (let k = 0; k < 3; k++) {
    const p = t[3 * i + k]! * 3;
    for (let a = 0; a < 3; a++) {
      const x = v[p + a]!;
      if (x < out[a]!) out[a] = x;
      if (x > out[a + 3]!) out[a + 3] = x;
    }
  }
  return out;
}

function buildBvh(v: Float64Array, t: Uint32Array): Bvh {
  const n = t.length / 3;
  const order = new Uint32Array(n);
  const centers = new Float64Array(n * 3);
  const tb = new Float64Array(n * 6);
  const b: Box = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    order[i] = i;
    triBox(v, t, i, b);
    for (let a = 0; a < 6; a++) tb[6 * i + a] = b[a]!;
    for (let a = 0; a < 3; a++) centers[3 * i + a] = (b[a]! + b[a + 3]!) / 2;
  }
  const boxes: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const count: number[] = [];
  const build = (start: number, end: number): number => {
    const node = left.length;
    left.push(0);
    right.push(0);
    count.push(0);
    const box: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const o = order[i]! * 6;
      for (let a = 0; a < 3; a++) {
        if (tb[o + a]! < box[a]!) box[a] = tb[o + a]!;
        if (tb[o + a + 3]! > box[a + 3]!) box[a + 3] = tb[o + a + 3]!;
      }
    }
    boxes.push(...box);
    if (end - start <= leafSize) {
      left[node] = -1 - start;
      count[node] = end - start;
      return node;
    }
    // Split on the longest axis at the median centre.
    const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
    const part = Array.from(order.subarray(start, end)).sort(
      (p, q) => centers[3 * p + axis]! - centers[3 * q + axis]!,
    );
    order.set(part, start);
    const mid = (start + end) >> 1;
    left[node] = build(start, mid);
    right[node] = build(mid, end);
    return node;
  };
  if (n) build(0, n);
  return {
    boxes: Float64Array.from(boxes),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    count: Int32Array.from(count),
    order,
  };
}

/** Triangles whose boxes overlap `box` (grown by `pad`). */
function queryBox(bvh: Bvh, box: Box, pad: number, out: number[]) {
  if (!bvh.left.length) return out;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const o = node * 6;
    const nb = bvh.boxes;
    if (
      nb[o]! > box[3] + pad ||
      nb[o + 3]! < box[0] - pad ||
      nb[o + 1]! > box[4] + pad ||
      nb[o + 4]! < box[1] - pad ||
      nb[o + 2]! > box[5] + pad ||
      nb[o + 5]! < box[2] - pad
    )
      continue;
    const l = bvh.left[node]!;
    if (l < 0) {
      const start = -1 - l;
      for (let i = start; i < start + bvh.count[node]!; i++) out.push(bvh.order[i]!);
    } else stack.push(l, bvh.right[node]!);
  }
  return out;
}

/** Triangles whose boxes a ray (origin, direction) passes through. */
function queryRay(bvh: Bvh, o: InterferenceVec3, d: InterferenceVec3, out: number[]) {
  if (!bvh.left.length) return out;
  const inv = d.map((x) => 1 / x);
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const b = node * 6;
    let lo = 0;
    let hi = Infinity;
    for (let a = 0; a < 3; a++) {
      let t0 = (bvh.boxes[b + a]! - o[a]!) * inv[a]!;
      let t1 = (bvh.boxes[b + a + 3]! - o[a]!) * inv[a]!;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
    }
    if (lo > hi + 1e-9) continue;
    const l = bvh.left[node]!;
    if (l < 0) {
      const start = -1 - l;
      for (let i = start; i < start + bvh.count[node]!; i++) out.push(bvh.order[i]!);
    } else stack.push(l, bvh.right[node]!);
  }
  return out;
}

const prepared = new WeakMap<readonly InterferenceMesh[], Prepared>();

/** Welds, finds shells and builds the BVH of one body's meshes (cached per `meshes` array). */
function prepare(meshes: readonly InterferenceMesh[]): Prepared {
  const hit = prepared.get(meshes);
  if (hit) return hit;
  // Vertices by grid cell of the weld size: one closer than it to a vertex in its cell or a
  // neighbouring one is that vertex, wherever a rounding boundary falls between them.
  const cells = new Map<string, number[]>();
  const verts: number[] = [];
  const tris: number[] = [];
  const sheetTri: boolean[] = [];
  for (const m of meshes) {
    const local: number[] = [];
    for (let i = 0; i < m.positions.length / 3; i++) {
      const x = m.positions[3 * i]!;
      const y = m.positions[3 * i + 1]!;
      const z = m.positions[3 * i + 2]!;
      const [cx, cy, cz] = [Math.floor(x / weldMm), Math.floor(y / weldMm), Math.floor(z / weldMm)];
      let id: number | undefined;
      for (let dx = -1; dx <= 1 && id === undefined; dx++)
        for (let dy = -1; dy <= 1 && id === undefined; dy++)
          for (let dz = -1; dz <= 1 && id === undefined; dz++)
            id = cells
              .get(`${cx + dx},${cy + dy},${cz + dz}`)
              ?.find(
                (j) =>
                  Math.hypot(verts[3 * j]! - x, verts[3 * j + 1]! - y, verts[3 * j + 2]! - z) <=
                  weldMm,
              );
      if (id === undefined) {
        id = verts.length / 3;
        const k = `${cx},${cy},${cz}`;
        const list = cells.get(k);
        if (list) list.push(id);
        else cells.set(k, [id]);
        verts.push(x, y, z);
      }
      local.push(id);
    }
    for (let i = 0; i + 2 < m.indices.length; i += 3) {
      const a = local[m.indices[i]!]!;
      const b = local[m.indices[i + 1]!]!;
      const c = local[m.indices[i + 2]!]!;
      // A triangle collapsed by welding has no area: it bounds nothing.
      if (a === b || b === c || a === c) continue;
      tris.push(a, b, c);
      sheetTri.push(!!m.sheet);
    }
  }
  const v = Float64Array.from(verts);
  const t = Uint32Array.from(tris);
  const n = t.length / 3;
  // Shells: triangles joined through shared edges (union-find over edges). Sheet and solid
  // triangles never join: a sheet sharing an edge with a solid must not open the solid's shell.
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const edges = new Map<string, { first: number; uses: number }>();
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const p = t[3 * i + k]!;
      const q = t[3 * i + ((k + 1) % 3)]!;
      const e = `${sheetTri[i] ? 's' : 'v'}${p < q ? `${p},${q}` : `${q},${p}`}`;
      const seen = edges.get(e);
      if (!seen) edges.set(e, { first: i, uses: 1 });
      else {
        seen.uses++;
        const [ra, rb] = [find(seen.first), find(i)];
        if (ra !== rb) parent[ra] = rb;
      }
    }
  const shellIndex = new Map<number, number>();
  const shellOf = new Uint32Array(n);
  const shells: Prepared['shells'] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let s = shellIndex.get(r);
    if (s === undefined) {
      s = shells.length;
      shellIndex.set(r, s);
      shells.push({ closed: true, sheet: true, vertices: [] });
    }
    shellOf[i] = s;
    if (!sheetTri[i]) shells[s]!.sheet = false;
  }
  // A shell is closed when each of its edges is used by an even number of its triangles (two
  // for a manifold surface; more where solids of one body meet along an edge).
  for (const { first, uses } of edges.values())
    if (uses % 2) shells[shellOf[first]!]!.closed = false;
  const inShell = shells.map(() => new Set<number>());
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) inShell[shellOf[i]!]!.add(t[3 * i + k]!);
  inShell.forEach((s, i) => (shells[i]!.vertices = [...s]));
  const box: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length / 3; i++)
    for (let a = 0; a < 3; a++) {
      if (v[3 * i + a]! < box[a]!) box[a] = v[3 * i + a]!;
      if (v[3 * i + a]! > box[a + 3]!) box[a + 3] = v[3 * i + a]!;
    }
  const out: Prepared = { v, t, shellOf, shells, bvh: buildBvh(v, t), box };
  prepared.set(meshes, out);
  return out;
}

const vertex = (p: Prepared, i: number): InterferenceVec3 => [
  p.v[3 * i]!,
  p.v[3 * i + 1]!,
  p.v[3 * i + 2]!,
];
const sub = (a: InterferenceVec3, b: InterferenceVec3): InterferenceVec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: InterferenceVec3, b: InterferenceVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: InterferenceVec3, b: InterferenceVec3): InterferenceVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: InterferenceVec3) => Math.hypot(a[0], a[1], a[2]);

/** The world box of a posed body (its local box's eight corners). */
function worldBox(p: Prepared, pose: InterferencePose): Box {
  const out: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  if (!Number.isFinite(p.box[0])) return out;
  for (let c = 0; c < 8; c++) {
    const w = toWorld(pose, [
      c & 1 ? p.box[3] : p.box[0],
      c & 2 ? p.box[4] : p.box[1],
      c & 4 ? p.box[5] : p.box[2],
    ]);
    for (let a = 0; a < 3; a++) {
      if (w[a]! < out[a]!) out[a] = w[a]!;
      if (w[a]! > out[a + 3]!) out[a + 3] = w[a]!;
    }
  }
  return out;
}

/**
 * Whether two triangles penetrate: each crosses the other's plane strictly (beyond the contact
 * tolerance on both sides), and their spans on the planes' common line overlap by more than the
 * tolerance. Returns a rough depth (the shallower side of the deeper triangle), or −1; `segment`
 * receives where they cross (the two ends of the shared span on the common line).
 */
export function trianglesPenetrate(
  a: readonly InterferenceVec3[],
  b: readonly InterferenceVec3[],
  eps = interferenceContactMm,
  segment?: InterferenceVec3[],
): number {
  const na = cross(sub(a[1]!, a[0]!), sub(a[2]!, a[0]!));
  const nb = cross(sub(b[1]!, b[0]!), sub(b[2]!, b[0]!));
  const la = norm(na);
  const lb = norm(nb);
  if (la < 1e-12 || lb < 1e-12) return -1;
  const ua: InterferenceVec3 = [na[0] / la, na[1] / la, na[2] / la];
  const ub: InterferenceVec3 = [nb[0] / lb, nb[1] / lb, nb[2] / lb];
  const db = a.map((p) => dot(ub, sub(p, b[0]!)));
  const da = b.map((p) => dot(ua, sub(p, a[0]!)));
  const crosses = (d: number[]) => Math.max(...d) > eps && Math.min(...d) < -eps;
  if (!crosses(db) || !crosses(da)) return -1;
  // The common line's direction; spans of each triangle on it, from its edges crossing the
  // other's plane.
  const dir = cross(ua, ub);
  const ld = norm(dir);
  if (ld < 1e-12) return -1;
  const span = (tri: readonly InterferenceVec3[], d: number[]) => {
    let lo = Infinity;
    let hi = -Infinity;
    let pl: InterferenceVec3 = [0, 0, 0];
    let ph: InterferenceVec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = d[i]!;
      const dj = d[j]!;
      const add = (p: InterferenceVec3) => {
        const s = dot(dir, p) / ld;
        if (s < lo) [lo, pl] = [s, p];
        if (s > hi) [hi, ph] = [s, p];
      };
      if (Math.abs(di) <= 0) add(tri[i]!);
      if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
        const t = di / (di - dj);
        const p = tri[i]!;
        const q = tri[j]!;
        add([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
      }
    }
    return [lo, hi, pl, ph] as const;
  };
  const [a0, a1, al, ah] = span(a, db);
  const [b0, b1, bl, bh] = span(b, da);
  if (Math.min(a1, b1) - Math.max(a0, b0) <= eps) return -1;
  if (segment) {
    // Both spans lie on the common line: the shared one runs from the later start to the
    // earlier end.
    segment[0] = a0 >= b0 ? al : bl;
    segment[1] = a1 <= b1 ? ah : bh;
  }
  const depth = (d: number[]) => Math.min(Math.max(...d), -Math.min(...d));
  return Math.max(depth(db), depth(da));
}

/** The smallest side of the box around some points (0 for none): a rough overlap depth. */
function smallestExtent(points: readonly InterferenceVec3[]): number {
  if (!points.length) return 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const w of points)
    for (let a = 0; a < 3; a++) {
      if (w[a]! < lo[a]!) lo[a] = w[a]!;
      if (w[a]! > hi[a]!) hi[a] = w[a]!;
    }
  return Math.min(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

/**
 * The vertices on the other's surface that bound what was found inside: those of the shell's
 * triangles that have an inside vertex or gave a sample. Surface contact elsewhere (a broad face
 * resting on the other, away from the overlap) bounds nothing. Undecided vertices always count.
 */
function bounding(
  p: Prepared,
  shell: number,
  insideIds: readonly number[],
  tris: readonly number[],
  boundary: readonly { v: number; world: InterferenceVec3; surface: boolean }[],
): InterferenceVec3[] {
  const inside = new Set(insideIds);
  const near = new Set<number>();
  const sampled = new Set(tris);
  for (let i = 0; i < p.t.length / 3; i++) {
    if (p.shellOf[i] !== shell) continue;
    const a = p.t[3 * i]!;
    const b = p.t[3 * i + 1]!;
    const c = p.t[3 * i + 2]!;
    if (sampled.has(i) || inside.has(a) || inside.has(b) || inside.has(c)) {
      near.add(a);
      near.add(b);
      near.add(c);
    }
  }
  return boundary.filter((q) => !q.surface || near.has(q.v)).map((q) => q.world);
}

/**
 * The overlap depth from separate pieces of evidence, roughly: pieces whose boxes meet are one
 * overlap, measured by its box's smallest side; the deepest overlap counts. Disconnected
 * overlaps are not measured across the space between them.
 */
function overlapDepth(pieces: readonly InterferenceVec3[][]): number {
  const boxes = pieces
    .filter((q) => q.length)
    .map((q) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const w of q)
        for (let a = 0; a < 3; a++) {
          if (w[a]! < b[a]!) b[a] = w[a]!;
          if (w[a]! > b[a + 3]!) b[a + 3] = w[a]!;
        }
      return b;
    });
  const e = interferenceContactMm;
  // Merge boxes that meet until none do.
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const x = boxes[i]!;
        const y = boxes[j]!;
        if ([0, 1, 2].every((a) => x[a]! <= y[a + 3]! + e && y[a]! <= x[a + 3]! + e)) {
          for (let a = 0; a < 3; a++) {
            x[a] = Math.min(x[a]!, y[a]!);
            x[a + 3] = Math.max(x[a + 3]!, y[a + 3]!);
          }
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
  }
  let depth = 0;
  for (const b of boxes)
    depth = Math.max(depth, Math.min(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!));
  return depth;
}

/** The distance from a point to a triangle (closest point by region, Ericson 5.1.5). */
function triangleDistance(
  p: InterferenceVec3,
  a: InterferenceVec3,
  b: InterferenceVec3,
  c: InterferenceVec3,
): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return norm(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return norm(bp);
  const at = (u: number, v: number) =>
    norm(
      sub(p, [
        a[0] + u * ab[0] + v * ac[0],
        a[1] + u * ab[1] + v * ac[1],
        a[2] + u * ab[2] + v * ac[2],
      ]),
    );
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return norm(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}

/**
 * Ray parity of a point against a body's closed shells, in that body's coordinates: `true`
 * inside, `false` outside, `surface` when the point lies on the surface (within contact),
 * `undefined` when every ray tried grazed an edge.
 */
function insideClosed(p: Prepared, point: InterferenceVec3): boolean | 'surface' | undefined {
  // Off every axis and diagonal, so a ray rarely runs along a mesh's edges or faces.
  const dirs: InterferenceVec3[] = [
    [0.57735, 0.57731, 0.57739],
    [-0.30151, 0.90453, 0.30157],
    [0.80178, -0.26726, 0.53452],
    [-0.43643, -0.21821, -0.87287],
  ];
  const tol = 1e-9;
  // On the surface: within contact of a triangle of a closed solid shell, measured directly,
  // as the triangles nearest the point may lie behind any ray from it.
  const near: number[] = [];
  queryBox(p.bvh, [...point, ...point] as Box, interferenceContactMm, near);
  for (const i of near) {
    const sh = p.shells[p.shellOf[i]!]!;
    if (!sh.closed || sh.sheet) continue;
    const t = [0, 1, 2].map((k) => vertex(p, p.t[3 * i + k]!)) as [
      InterferenceVec3,
      InterferenceVec3,
      InterferenceVec3,
    ];
    if (triangleDistance(point, ...t) <= interferenceContactMm) return 'surface';
  }
  for (const d of dirs) {
    const found: number[] = [];
    queryRay(p.bvh, point, d, found);
    let hits = 0;
    let clean = true;
    for (const i of found) {
      const sh = p.shells[p.shellOf[i]!]!;
      // Only closed solid shells bound a volume: a sheet has no inside, even when closed.
      if (!sh.closed || sh.sheet) continue;
      const v0 = vertex(p, p.t[3 * i]!);
      const v1 = vertex(p, p.t[3 * i + 1]!);
      const v2 = vertex(p, p.t[3 * i + 2]!);
      // Möller–Trumbore.
      const e1 = sub(v1, v0);
      const e2 = sub(v2, v0);
      const h = cross(d, e2);
      const det = dot(e1, h);
      const scale = norm(e1) * norm(e2);
      if (Math.abs(det) <= 1e-12 * scale) {
        // Parallel: only a problem when the ray runs in the triangle's plane.
        if (Math.abs(dot(cross(e1, e2), sub(point, v0))) <= tol * scale) clean = false;
        continue;
      }
      const f = 1 / det;
      const s = sub(point, v0);
      const u = f * dot(s, h);
      const q = cross(s, e1);
      const w = f * dot(d, q);
      const t = f * dot(e2, q);
      if (u < -tol || w < -tol || u + w > 1 + tol) continue;
      // The point on the surface (by its distance to the triangle's plane, not along the ray,
      // which runs at a slant), or the ray through an edge or vertex: try another ray.
      const n = cross(e1, e2);
      if (Math.abs(t * dot(d, n)) <= interferenceContactMm * norm(n)) {
        if (u >= -tol && w >= -tol && u + w <= 1 + tol) return 'surface';
      }
      if (t < 0) continue;
      if (u <= tol || w <= tol || u + w >= 1 - tol) {
        clean = false;
        break;
      }
      hits++;
    }
    if (clean) return hits % 2 === 1;
  }
  return undefined;
}

/**
 * Where a closed shell of `from` lies against `into`'s volume, from each of its vertices that is
 * within `into`'s box (by more than the contact tolerance): `out` when none is inside, `in` when
 * all are (a contained shell), `partly` when some are (it passes through `into`'s surface where
 * no triangle pair crosses strictly, e.g. along a mesh line lying on that surface), `unknown`
 * when none could be decided. A vertex on `into`'s surface decides nothing; it is returned in
 * `boundary`, as it bounds an overlap when one is found.
 */
function shellPlace(
  from: Prepared,
  fromPose: InterferencePose,
  shell: Prepared['shells'][number],
  into: Prepared,
  intoPose: InterferencePose,
  hole: boolean,
): {
  place: 'out' | 'in' | 'partly' | 'unknown';
  inside: InterferenceVec3[];
  insideIds: number[];
  boundary: { v: number; world: InterferenceVec3; surface: boolean }[];
} {
  const e = interferenceContactMm;
  const b = into.box;
  let outside = 0;
  let undecided = 0;
  const inside: InterferenceVec3[] = [];
  const insideIds: number[] = [];
  const boundary: { v: number; world: InterferenceVec3; surface: boolean }[] = [];
  for (const v of shell.vertices) {
    const world = toWorld(fromPose, vertex(from, v));
    const p = toLocal(intoPose, world);
    if (
      p[0] < b[0] - e ||
      p[1] < b[1] - e ||
      p[2] < b[2] - e ||
      p[0] > b[3] + e ||
      p[1] > b[4] + e ||
      p[2] > b[5] + e
    ) {
      outside++;
      continue;
    }
    const r = hole ? undefined : insideClosed(into, p);
    // On the surface: it bounds an overlap when one is found, and decides nothing (contact).
    if (r === 'surface') boundary.push({ v, world, surface: true });
    else if (r === undefined) {
      undecided++;
      boundary.push({ v, world, surface: false });
    } else if (r) {
      inside.push(world);
      insideIds.push(v);
    } else outside++;
  }
  const place = inside.length
    ? outside || undecided
      ? 'partly'
      : 'in'
    : undecided && !outside
      ? 'unknown'
      : 'out';
  return { place, inside, insideIds, boundary };
}

/**
 * How far a probe sits inside a shell's surface (mm): just beyond contact, so an overlap thicker
 * than it is found however thin (one up to it is contact).
 */
const probeMm = 2 * interferenceContactMm;
/**
 * Points of a closed shell's volume next to its surface that lie inside `into`'s volume too: per
 * triangle within `into`'s box, its centroid moved a probe's depth to each side, kept where it is
 * inside both. They find overlapping volumes whose surfaces only meet in coincident planes (two
 * identical boxes; boxes overlapping with flush sides), where no triangle pair crosses strictly
 * and no vertex lies strictly inside.
 */
function shellProbes(
  from: Prepared,
  fromPose: InterferencePose,
  shell: number,
  into: Prepared,
  intoPose: InterferencePose,
  tris: number[],
): InterferenceVec3[] {
  const out: InterferenceVec3[] = [];
  const b = into.box;
  for (let i = 0; i < from.t.length / 3; i++) {
    if (from.shellOf[i] !== shell) continue;
    const [v0, v1, v2] = [0, 1, 2].map((k) => vertex(from, from.t[3 * i + k]!)) as [
      InterferenceVec3,
      InterferenceVec3,
      InterferenceVec3,
    ];
    const n = cross(sub(v1, v0), sub(v2, v0));
    const ln = norm(n);
    if (ln < 1e-12) continue;
    const c: InterferenceVec3 = [
      (v0[0] + v1[0] + v2[0]) / 3,
      (v0[1] + v1[1] + v2[1]) / 3,
      (v0[2] + v1[2] + v2[2]) / 3,
    ];
    const lc = toLocal(intoPose, toWorld(fromPose, c));
    if (
      lc[0] < b[0] - probeMm ||
      lc[1] < b[1] - probeMm ||
      lc[2] < b[2] - probeMm ||
      lc[0] > b[3] + probeMm ||
      lc[1] > b[4] + probeMm ||
      lc[2] > b[5] + probeMm
    )
      continue;
    for (const side of [1, -1]) {
      const f = (side * probeMm) / ln;
      const q: InterferenceVec3 = [c[0] + f * n[0], c[1] + f * n[1], c[2] + f * n[2]];
      const world = toWorld(fromPose, q);
      if (insideClosed(into, toLocal(intoPose, world)) === true && insideClosed(from, q) === true) {
        out.push(world);
        tris.push(i);
        break;
      }
    }
  }
  return out;
}

/** A sheet shell's triangle centroids that lie inside `into`'s volume (world coordinates). */
function sheetSamples(
  from: Prepared,
  fromPose: InterferencePose,
  shell: number,
  into: Prepared,
  intoPose: InterferencePose,
  tris: number[],
): InterferenceVec3[] {
  const out: InterferenceVec3[] = [];
  const b = into.box;
  const e = interferenceContactMm;
  for (let i = 0; i < from.t.length / 3; i++) {
    if (from.shellOf[i] !== shell) continue;
    const c: InterferenceVec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = vertex(from, from.t[3 * i + k]!);
      for (let a = 0; a < 3; a++) c[a] = c[a]! + v[a]! / 3;
    }
    const world = toWorld(fromPose, c);
    const p = toLocal(intoPose, world);
    if (
      p[0] <= b[0] + e ||
      p[1] <= b[1] + e ||
      p[2] <= b[2] + e ||
      p[0] >= b[3] - e ||
      p[1] >= b[4] - e ||
      p[2] >= b[5] - e
    )
      continue;
    if (insideClosed(into, p) === true) {
      out.push(world);
      tris.push(i);
    }
  }
  return out;
}

/** Whether any vertex of a shell lies within `into`'s box (beyond the contact tolerance). */
function reaches(
  from: Prepared,
  fromPose: InterferencePose,
  shell: Prepared['shells'][number],
  into: Prepared,
  intoPose: InterferencePose,
) {
  const e = interferenceContactMm;
  const b = into.box;
  return shell.vertices.some((v) => {
    const p = toLocal(intoPose, toWorld(fromPose, vertex(from, v)));
    return (
      p[0] > b[0] + e &&
      p[1] > b[1] + e &&
      p[2] > b[2] + e &&
      p[0] < b[3] - e &&
      p[1] < b[4] - e &&
      p[2] < b[5] - e
    );
  });
}

const inSphere = (r: Extract<InterferenceRegion, { kind: 'sphere' }>, p: InterferenceVec3) =>
  Math.hypot(p[0] - r.centerMm[0], p[1] - r.centerMm[1], p[2] - r.centerMm[2]) <= r.radiusMm;

/** Every pair of bodies whose surfaces cross, one inside the other, or that cannot be judged. */
export function checkInterference(
  bodies: readonly InterferenceBody[],
  allowances: readonly InterferenceAllowance[] = [],
): InterferenceResult {
  const ready = bodies.map((b) => {
    const triangles = b.meshes.reduce((n, m) => n + Math.floor(m.indices.length / 3), 0);
    return { body: b, triangles };
  });
  const triangles = ready.reduce((n, r) => n + r.triangles, 0);
  if (triangles > interferenceLimits.triangles)
    return { status: 'refused', code: 'interference-limit', triangles, pairs: 0 };
  const preps = bodies.map((b) => prepare(b.meshes));
  const boxes = bodies.map((b, i) => worldBox(preps[i]!, b.pose));
  const pad = interferenceContactMm;
  const candidates: [number, number][] = [];
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const g = bodies[i]!.group;
      if (g !== undefined && g === bodies[j]!.group) continue;
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (
        a[0] > b[3] - pad ||
        b[0] > a[3] - pad ||
        a[1] > b[4] - pad ||
        b[1] > a[4] - pad ||
        a[2] > b[5] - pad ||
        b[2] > a[5] - pad
      )
        continue;
      candidates.push([i, j]);
      if (candidates.length > interferenceLimits.candidatePairs)
        return {
          status: 'refused',
          code: 'interference-limit',
          triangles,
          pairs: candidates.length,
        };
    }
  const findings: InterferenceFinding[] = [];
  for (const [i, j] of candidates) {
    const A = bodies[i]!;
    const B = bodies[j]!;
    const [ga, gb] = [A.group ?? A.id, B.group ?? B.id];
    const allowed = allowances.filter(
      (x) => (x.a === ga && x.b === gb) || (x.a === gb && x.b === ga),
    );
    if (allowed.some((x) => x.region.kind === 'pair')) continue;
    const spheres = allowed.flatMap((x) => (x.region.kind === 'sphere' ? [x.region] : []));
    const pa = preps[i]!;
    const pb = preps[j]!;
    // Crossing: each triangle of the smaller body, in the larger's coordinates, against its BVH.
    const [S, L, ps, pl] = pa.t.length <= pb.t.length ? [A, B, pa, pb] : ([B, A, pb, pa] as const);
    let crossings = 0;
    let depthMm = 0;
    const crossed = [new Set<number>(), new Set<number>()]; // shells of A, of B that cross
    const found: number[] = [];
    const segment: InterferenceVec3[] = [];
    const tb: Box = [0, 0, 0, 0, 0, 0];
    for (let s = 0; s < ps.t.length / 3; s++) {
      const triS = [0, 1, 2].map((k) =>
        toLocal(L.pose, toWorld(S.pose, vertex(ps, ps.t[3 * s + k]!))),
      );
      for (let a = 0; a < 3; a++) {
        tb[a] = Math.min(triS[0]![a]!, triS[1]![a]!, triS[2]![a]!);
        tb[a + 3] = Math.max(triS[0]![a]!, triS[1]![a]!, triS[2]![a]!);
      }
      found.length = 0;
      queryBox(pl.bvh, tb, pad, found);
      for (const l of found) {
        const triL = [0, 1, 2].map((k) => vertex(pl, pl.t[3 * l + k]!));
        const d = trianglesPenetrate(triS, triL, interferenceContactMm, segment);
        if (d < 0) continue;
        const sIsA = S === A;
        crossed[sIsA ? 0 : 1]!.add(ps.shellOf[s]!);
        crossed[sIsA ? 1 : 0]!.add(pl.shellOf[l]!);
        if (spheres.length) {
          // Where the two cross must lie in the sphere (the overlap inside each body is held
          // to it below): not the whole triangles, which a kernel makes large on flat faces.
          const world = segment.map((p) => toWorld(L.pose, p));
          if (spheres.some((r) => world.every((p) => inSphere(r, p)))) continue;
        }
        crossings++;
        if (d > depthMm) depthMm = d;
      }
    }
    // Volumes, both ways, per closed shell: one inside the other (contained), or overlapping
    // where no triangle pair crosses strictly (vertices inside, or probes next to the surface
    // inside both). A sphere allows a shell's overlap only when all of it that was found (inside
    // vertices, probes, crossings, and the vertices on the other's surface that bound them) lies
    // inside the sphere.
    let contained = 0;
    let unknownBody: string | undefined;
    const sides = [
      [A, pa, B, pb, 0],
      [B, pb, A, pa, 1],
    ] as const;
    const settled = crossings > 0 && !spheres.length;
    // What overlaps without crossings to measure, from both sides: its smallest extent is the
    // depth, roughly.
    const overlap: InterferenceVec3[][] = [];
    for (const [X, px, Y, py, side] of sides) {
      // A solid with a mesh hole has no decidable inside.
      const hole = py.shells.some((s) => !s.closed && !s.sheet);
      px.shells.forEach((shell, k) => {
        const crossing = crossed[side]!.has(k);
        if (shell.sheet) {
          // A sheet has no inside, but it can pass through the other's volume where its
          // triangles cross none strictly (along the other's mesh lines): its vertices and
          // triangle centroids inside the other find that.
          if (settled) return;
          if (hole) {
            if (!crossing && reaches(px, X.pose, shell, py, Y.pose)) unknownBody ??= Y.id;
            return;
          }
          const placed = shellPlace(px, X.pose, shell, py, Y.pose, false);
          const tris: number[] = [];
          const found = [...placed.inside, ...sheetSamples(px, X.pose, k, py, Y.pose, tris)];
          if (!found.length && !crossing) return;
          const evidence = [...found, ...bounding(px, k, placed.insideIds, tris, placed.boundary)];
          if (spheres.some((r) => evidence.every((p) => inSphere(r, p)))) return;
          crossings++;
          overlap.push(evidence);
          return;
        }
        if (!shell.closed) {
          // A solid's open shell (a mesh hole) that reaches into the other's box and crosses
          // nothing: whether it is inside cannot be judged, so the pair is never clear.
          if (!crossing && !settled && reaches(px, X.pose, shell, py, Y.pose)) unknownBody ??= X.id;
          return;
        }
        if (settled && crossing) return;
        const { place, inside, insideIds, boundary } = shellPlace(
          px,
          X.pose,
          shell,
          py,
          Y.pose,
          hole,
        );
        const tris: number[] = [];
        const probes =
          hole || settled || place === 'in' ? [] : shellProbes(px, X.pose, k, py, Y.pose, tris);
        if (place === 'unknown' && !probes.length && !crossing) {
          unknownBody ??= Y.id;
          return;
        }
        if (!inside.length && !probes.length && !crossing) return;
        // Allowed only when everything found inside lies in a sphere: the whole shell when
        // contained.
        const world =
          place === 'in'
            ? shell.vertices.map((v) => toWorld(X.pose, vertex(px, v)))
            : [...inside, ...probes, ...bounding(px, k, insideIds, tris, boundary)];
        if (spheres.some((r) => world.every((p) => inSphere(r, p)))) return;
        if (place !== 'in') {
          // A crossing shell's crossings were counted already unless a sphere allowed them.
          if (!crossing || spheres.length) {
            crossings++;
            // Found without crossings to measure: measured below from both sides' evidence.
            overlap.push(world);
          }
          return;
        }
        contained++;
        // The contained shell's smallest extent: how far it would have to move out, roughly.
        depthMm = Math.max(depthMm, smallestExtent(world));
      });
    }
    depthMm = Math.max(depthMm, overlapDepth(overlap));
    if (crossings || contained)
      findings.push({
        a: A.id,
        b: B.id,
        kind: crossings ? 'intersect' : 'contain',
        depthMm,
        crossings,
        contained,
      });
    else if (unknownBody !== undefined)
      findings.push({
        a: A.id,
        b: B.id,
        kind: 'unknown',
        depthMm: 0,
        crossings: 0,
        contained: 0,
        unknownBody,
      });
  }
  return { status: 'ok', findings, pairs: candidates.length, triangles };
}
