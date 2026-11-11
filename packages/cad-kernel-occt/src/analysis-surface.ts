/**
 * R3c-2a / R3d-2: the analysis surface of a body, after the kernel's triangulation has been read
 * (evaluator `analysisSurfaceOf`). Pure: the shape is reached only through `surfaceAt` and
 * `curveAt`, so the refinement and the mid points are tested without the kernel.
 */
import type { CadAnalysisSurface } from './protocol';

export type Xyz = [number, number, number];

/** One surface triangle: joined point indices wound outward, its face, its corners' UV. */
export interface RawTriangle {
  v: [number, number, number];
  face: number;
  /** The face's surface parameters at each corner, or null when the face has none. */
  uv: [[number, number], [number, number], [number, number]] | null;
}

export interface RawSurface {
  points: number[];
  triangles: RawTriangle[];
  shapeFaces: number;
  /** Per shape edge: its joined points in order and their curve parameters (null without). */
  chains: { nodes: number[]; params: number[] | null }[];
  /** The point on face `face`'s surface at (u, v), or undefined when there is no surface. */
  surfaceAt(face: number, u: number, v: number): Xyz | undefined;
  /** The point on shape edge `edge`'s curve at t, or undefined when there is no curve. */
  curveAt(edge: number, t: number): Xyz | undefined;
  /**
   * The (u, v) of point `p` on face `face`'s surface, found from `start` (a nearby UV on the same
   * side of any seam), or undefined when it does not converge onto the point.
   */
  uvAt(face: number, p: Xyz, start: [number, number]): [number, number] | undefined;
}

export interface SurfaceSizing {
  /** The longest a surface triangle edge may be (mm); Infinity keeps the kernel's triangles. */
  maxEdgeMm: number;
  /** Smaller limits on some faces (mm); an edge between faces takes the smaller one. */
  faces?: ReadonlyMap<number, number>;
  /** The most triangles the result may have. */
  maxTriangles: number;
  /**
   * R3e-3: a graded size from the shape edges' own spacing. Every chain point starts at the length
   * of its shortest chain segment, every other point at the face's size; the size then grows by
   * `slope` × distance along the surface edges (the smallest wins), never below `minMm` (the
   * volume mesh's smallest size: finer surface triangles would only make more of them). An edge longer than the smaller
   * size at its ends is split, so the faces' triangles shrink towards finely divided edges instead
   * of fanning out thin. A new point takes the smaller end's size grown over half the edge. Absent: sizes only.
   */
  graded?: { slope: number; minMm: number };
  /**
   * CR5e-2: a smaller size around points (x, y, z each): `sizeMm` within `radiusMm` of a point,
   * growing by the distance beyond (the smallest of this and the face's size wins).
   */
  near?: { points: readonly number[]; radiusMm: number; sizeMm: number };
  /**
   * CR5e: split only the chain segments of these faces that are longer than their size, without
   * longest-edge propagation (the inner edges are left to flips and the full refinement).
   */
  chainsOf?: ReadonlySet<number>;
  /** CR5e: split each edge longer than its size once, without propagation (a pass). */
  once?: boolean;
  /**
   * CR5e: a shell's surface (a sheet or a midsurface), meshed face by face: the chains split to
   * the sizes, points seeded inside each face on a lattice of its size, Delaunay flips; the
   * bisection then only keeps the sizes. Absent (a solid's surface), the bisection alone.
   */
  seed?: boolean;
}

export class AnalysisSurfaceLimit extends Error {
  constructor() {
    super('analysis surface over its triangle limit');
    this.name = 'AnalysisSurfaceLimit';
  }
}

const span = 2 ** 26;
const dot3 = (u: Xyz, v: Xyz) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
/** The (unnormalised) normal of triangle x, y, z. */
const normalOf = (x: Xyz, y: Xyz, z: Xyz): Xyz => {
  const u = [y[0] - x[0], y[1] - x[1], y[2] - x[2]],
    v = [z[0] - x[0], z[1] - x[1], z[2] - x[2]];
  return [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
};
const keyOf = (a: number, b: number) => (a < b ? a * span + b : b * span + a);

/** A max-heap of edges by length; stale entries are skipped when popped. */
class EdgeHeap {
  private items: { len: number; a: number; b: number }[] = [];
  push(len: number, a: number, b: number) {
    const it = this.items;
    it.push({ len, a, b });
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!(it[p]!.len < it[i]!.len)) break;
      [it[p], it[i]] = [it[i]!, it[p]!];
      i = p;
    }
  }
  pop() {
    const it = this.items;
    const top = it[0];
    const last = it.pop()!;
    if (it.length) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < it.length && it[l]!.len > it[m]!.len) m = l;
        if (r < it.length && it[r]!.len > it[m]!.len) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i]!, it[m]!];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

/** The longest an edge from a to b on a face may be (mm). */
export type EdgeLimit = (face: number, a: Xyz, b: Xyz) => number;
/** The slope a point size grows by beyond its radius (CR5e-2). */
const nearSlope = 1;
/**
 * CR5e-2: the size at a position from `sizing.near` (Infinity far from every point), looked up in
 * a hash of cells as wide as the distance at which the size reaches `cap` (nothing farther counts).
 */
export function nearSize(
  near: SurfaceSizing['near'],
  cap: number,
): ((x: number, y: number, z: number) => number) | undefined {
  if (!near?.points.length || !(near.sizeMm < cap)) return undefined;
  const { points, radiusMm, sizeMm } = near;
  const reach = Number.isFinite(cap) ? radiusMm + (cap - sizeMm) / nearSlope : Infinity;
  const cell = Number.isFinite(reach) ? Math.max(reach, 1e-6) : Infinity;
  const cells = new Map<string, number[]>();
  const keyAt = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const at = (v: number) => (Number.isFinite(cell) ? Math.floor(v / cell) : 0);
  for (let p = 0; p < points.length / 3; p++) {
    const k = keyAt(at(points[3 * p]!), at(points[3 * p + 1]!), at(points[3 * p + 2]!));
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(p);
  }
  return (x, y, z) => {
    let best = Infinity;
    const [i, j, k] = [at(x), at(y), at(z)];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++)
          for (const p of cells.get(keyAt(i + di, j + dj, k + dk)) ?? []) {
            const d = Math.hypot(
              x - points[3 * p]!,
              y - points[3 * p + 1]!,
              z - points[3 * p + 2]!,
            );
            best = Math.min(best, sizeMm + nearSlope * Math.max(0, d - radiusMm));
          }
    return best;
  };
}

/**
 * Splits surface edges longer than their size, the longest first, until none is (R3d-2b). Splitting
 * an edge splits both its triangles, so the surface stays closed and conforming; the longest edge
 * of the whole surface is the longest of both its triangles, so angles stay bounded (longest-edge
 * bisection). The new point is on the shape: on the edge's curve at the middle of its parameters
 * for a shape edge (inserted into its chain), else on the face's surface at the middle of the
 * triangle edge's UV. Without a curve or a surface, the straight middle.
 */
export function refineSurface(raw: RawSurface, sizing: SurfaceSizing): number {
  const { points, triangles, chains } = raw;
  const faceSize = (f: number) => Math.min(sizing.maxEdgeMm, sizing.faces?.get(f) ?? Infinity);
  if (
    !Number.isFinite(sizing.maxEdgeMm) &&
    !sizing.faces?.size &&
    !sizing.graded &&
    !sizing.near?.points.length
  )
    return 0;
  const near = nearSize(sizing.near, Math.max(sizing.maxEdgeMm, ...(sizing.faces?.values() ?? [])));
  let splits = 0;
  /** Joined edge → the triangles that use it (two on a closed surface). */
  const users = new Map<number, number[]>();
  /** Joined edge → the shape edge whose chain it is a segment of. */
  const chainOf = new Map<number, number>();
  chains.forEach((c, k) => {
    for (let i = 1; i < c.nodes.length; i++) chainOf.set(keyOf(c.nodes[i - 1]!, c.nodes[i]!), k);
  });
  const lenOf = (a: number, b: number) =>
    Math.hypot(
      points[3 * a]! - points[3 * b]!,
      points[3 * a + 1]! - points[3 * b + 1]!,
      points[3 * a + 2]! - points[3 * b + 2]!,
    );
  const heap = new EdgeHeap();
  /**
   * Edges to split whatever their size, because a shorter edge of one of their triangles needs
   * splitting (longest-edge propagation): splitting only the short edge would leave a thin fan.
   */
  const forced = new Set<number>();
  const limitOf = (k: number) => {
    const own = Math.min(...users.get(k)!.map((t) => faceSize(triangles[t]!.face)));
    if (!near) return own;
    // The size at the edge's middle (CR5e-2).
    const [a, b] = [Math.floor(k / span), k % span];
    return Math.min(
      own,
      near(
        (points[3 * a]! + points[3 * b]!) / 2,
        (points[3 * a + 1]! + points[3 * b + 1]!) / 2,
        (points[3 * a + 2]! + points[3 * b + 2]!) / 2,
      ),
    );
  };
  /** The graded size at each point (R3e-3), or none. */
  const h: number[] = [];
  if (sizing.graded) {
    const n = points.length / 3;
    for (let i = 0; i < n; i++) h.push(Infinity);
    for (const t of triangles) for (const x of t.v) h[x] = Math.min(h[x]!, faceSize(t.face));
    for (const c of chains)
      for (let i = 1; i < c.nodes.length; i++) {
        const [a, b] = [c.nodes[i - 1]!, c.nodes[i]!];
        const l = Math.max(lenOf(a, b), sizing.graded.minMm);
        h[a] = Math.min(h[a]!, l);
        h[b] = Math.min(h[b]!, l);
      }
    // Grow by the slope along the surface's edges (Dijkstra from every point at once).
    const near = new Map<number, number[]>();
    for (const t of triangles)
      for (let j = 0; j < 3; j++) {
        const [a, b] = [t.v[j]!, t.v[(j + 1) % 3]!];
        (near.get(a) ?? near.set(a, []).get(a)!).push(b);
      }
    const heap = new EdgeHeap(); // a max-heap: keyed by −size
    for (let i = 0; i < n; i++) if (Number.isFinite(h[i]!)) heap.push(-h[i]!, i, i);
    while (heap.size) {
      const { len, a } = heap.pop()!;
      if (-len !== h[a]) continue;
      for (const b of near.get(a) ?? []) {
        const grown = h[a]! + sizing.graded.slope * lenOf(a, b);
        if (grown < h[b]!) {
          h[b] = grown;
          heap.push(-grown, b, b);
        }
      }
    }
  }
  const thin = (a: number, b: number, len: number) =>
    !!sizing.graded && len > Math.min(h[a] ?? Infinity, h[b] ?? Infinity) * (1 + 1e-9);
  const consider = (a: number, b: number) => {
    const k = keyOf(a, b);
    if (
      sizing.chainsOf &&
      !(chainOf.has(k) && users.get(k)!.some((t) => sizing.chainsOf!.has(triangles[t]!.face)))
    )
      return;
    const len = lenOf(a, b);
    if (len > limitOf(k) || forced.has(k) || thin(a, b, len)) heap.push(len, a, b);
  };
  const addUse = (t: number) => {
    const { v } = triangles[t]!;
    for (let j = 0; j < 3; j++) {
      const k = keyOf(v[j]!, v[(j + 1) % 3]!);
      const list = users.get(k);
      if (list) list.push(t);
      else users.set(k, [t]);
    }
  };
  const dropUse = (t: number) => {
    const { v } = triangles[t]!;
    for (let j = 0; j < 3; j++) {
      const k = keyOf(v[j]!, v[(j + 1) % 3]!);
      const list = users.get(k)!.filter((x) => x !== t);
      if (list.length) users.set(k, list);
      else users.delete(k);
    }
  };
  triangles.forEach((_, t) => addUse(t));
  for (const k of users.keys()) consider(Math.floor(k / span), k % span);
  while (heap.size) {
    const { a, b, len } = heap.pop()!;
    const k = keyOf(a, b);
    // An entry is stale when its edge was split since.
    if (!users.has(k) || lenOf(a, b) !== len) continue;
    // Longest-edge propagation: a triangle of this edge with a longer edge has that split first,
    // and this edge comes back after it; the longest edge of the path is split first (Rivara).
    let longer: [number, number] | undefined;
    for (const t of sizing.chainsOf || sizing.once ? [] : users.get(k)!) {
      const { v } = triangles[t]!;
      for (let j = 0; j < 3; j++) {
        const [x, y] = [v[j]!, v[(j + 1) % 3]!];
        const l = lenOf(x, y);
        if (l > len && (!longer || l > lenOf(longer[0], longer[1]))) longer = [x, y];
      }
    }
    if (longer) {
      forced.add(keyOf(longer[0], longer[1]));
      heap.push(lenOf(longer[0], longer[1]), longer[0], longer[1]);
      heap.push(len, a, b);
      continue;
    }
    forced.delete(k);
    const around = users.get(k)!.slice();
    if (triangles.length + around.length > sizing.maxTriangles) throw new AnalysisSurfaceLimit();
    const m = points.length / 3;
    const straight = [0, 1, 2].map((d) => (points[3 * a + d]! + points[3 * b + d]!) / 2) as Xyz;
    /**
     * A candidate point is kept only when it is near the edge (within half its length of the
     * middle, as for the mid points) and every split half faces the way its triangle did; else
     * the next candidate, and last the straight middle, which always keeps both. A pole's UV has
     * an arbitrary longitude, so its UV middle can be far from the edge (#795).
     */
    const accept = (q: Xyz) => {
      const off = Math.hypot(q[0] - straight[0], q[1] - straight[1], q[2] - straight[2]);
      if (!(off <= 0.5 * len)) return false;
      for (const t of users.get(k)!) {
        const { v } = triangles[t]!;
        let j = 0;
        while (!(keyOf(v[j]!, v[(j + 1) % 3]!) === k)) j++;
        const P = (n: number): Xyz => [points[3 * n]!, points[3 * n + 1]!, points[3 * n + 2]!];
        const [x, y, z] = [P(v[j]!), P(v[(j + 1) % 3]!), P(v[(j + 2) % 3]!)];
        const before = normalOf(x, y, z);
        if (!(dot3(normalOf(x, q, z), before) > 0 && dot3(normalOf(q, y, z), before) > 0))
          return false;
      }
      return true;
    };
    let p: Xyz | undefined;
    /** The triangle whose middle UV gave p on its face's surface, if one did. */
    let giver = -1;
    const edge = chainOf.get(k);
    let chainAt = -1;
    if (edge !== undefined) {
      const c = chains[edge]!;
      for (let i = 1; i < c.nodes.length && chainAt < 0; i++)
        if (keyOf(c.nodes[i - 1]!, c.nodes[i]!) === k) chainAt = i;
      if (c.params) {
        const q = raw.curveAt(edge, (c.params[chainAt - 1]! + c.params[chainAt]!) / 2);
        if (q && accept(q)) p = q;
      }
    } else {
      for (const t of around) {
        const T = triangles[t]!;
        if (!T.uv) continue;
        const ia = T.v.indexOf(a),
          ib = T.v.indexOf(b);
        const q = raw.surfaceAt(
          T.face,
          (T.uv[ia]![0] + T.uv[ib]![0]) / 2,
          (T.uv[ia]![1] + T.uv[ib]![1]) / 2,
        );
        if (q && accept(q)) {
          p = q;
          giver = t;
          break;
        }
      }
    }
    p ??= straight;
    points.push(...p);
    // At most the slope's growth from the nearer end (half the edge away).
    if (sizing.graded)
      h[m] = Math.min(h[a] ?? Infinity, h[b] ?? Infinity) + (sizing.graded.slope * len) / 2;
    if (edge !== undefined) {
      const c = chains[edge]!;
      c.nodes.splice(chainAt, 0, m);
      if (c.params) c.params.splice(chainAt, 0, (c.params[chainAt - 1]! + c.params[chainAt]!) / 2);
      chainOf.delete(k);
      chainOf.set(keyOf(c.nodes[chainAt - 1]!, m), edge);
      chainOf.set(keyOf(m, c.nodes[chainAt + 1]!), edge);
    }
    for (const t of around) {
      const T = triangles[t]!;
      dropUse(t);
      // T is (x, y, z) with the split edge x→y somewhere in its cyclic order.
      let j = 0;
      while (!(keyOf(T.v[j]!, T.v[(j + 1) % 3]!) === k)) j++;
      const x = T.v[j]!,
        y = T.v[(j + 1) % 3]!,
        z = T.v[(j + 2) % 3]!;
      const uvx = T.uv?.[j],
        uvy = T.uv?.[(j + 1) % 3],
        uvz = T.uv?.[(j + 2) % 3];
      // The new point's UV on this triangle's face: the middle when the point is the surface's at
      // the middle; else (a point on a curve) found from the middle, on this triangle's side.
      const middle: [number, number] | undefined =
        uvx && uvy ? [(uvx[0] + uvy[0]) / 2, (uvx[1] + uvy[1]) / 2] : undefined;
      const uvm = middle && t !== giver ? (raw.uvAt(T.face, p, middle) ?? middle) : middle;
      triangles[t] = {
        v: [x, m, z],
        face: T.face,
        uv: T.uv ? [uvx!, uvm!, uvz!] : null,
      };
      triangles.push({ v: [m, y, z], face: T.face, uv: T.uv ? [uvm!, uvy!, uvz!] : null });
      addUse(t);
      addUse(triangles.length - 1);
    }
    splits++;
    if (sizing.once) continue;
    for (const t of around) {
      const T = triangles[t]!;
      consider(T.v[0], T.v[1]);
      consider(T.v[1], T.v[2]);
      consider(T.v[2], T.v[0]);
    }
    for (let t = triangles.length - around.length; t < triangles.length; t++) {
      const T = triangles[t]!;
      consider(T.v[0], T.v[1]);
      consider(T.v[1], T.v[2]);
    }
  }
  return splits;
}

/**
 * The mesher's input: flat arrays, and the curved mid points (R3d-2a), by surface edge: on the
 * shape edge's curve for a chain segment, else on the face's surface at the middle of the triangle
 * edge's UV. Kept only where the point leaves the chord (planar faces give none) and stays within
 * half the chord's length of its middle, so a parameter jump (a pole) never makes one.
 */
export function finishSurface(
  raw: RawSurface,
): Omit<CadAnalysisSurface, 'history' | 'measures' | 'bodyTopology'> {
  const { points, triangles, chains } = raw;
  const curved = new Map<number, { a: number; b: number; p: Xyz }>();
  const offChord = (a: number, b: number, p: Xyz) => {
    const m = [0, 1, 2].map((d) => (points[3 * a + d]! + points[3 * b + d]!) / 2);
    const chord = Math.hypot(...[0, 1, 2].map((d) => points[3 * a + d]! - points[3 * b + d]!));
    const off = Math.hypot(...[0, 1, 2].map((d) => p[d]! - m[d]!));
    return off > 1e-9 * chord && off <= 0.5 * chord ? off : undefined;
  };
  for (const T of triangles) {
    if (!T.uv) continue;
    for (let j = 0; j < 3; j++) {
      const u = T.v[j]!,
        v = T.v[(j + 1) % 3]!;
      const a = T.uv[j]!,
        b = T.uv[(j + 1) % 3]!;
      const p = raw.surfaceAt(T.face, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (!p) continue;
      const off = offChord(u, v, p);
      const kept = curved.get(keyOf(u, v));
      // Two triangles may give the edge different parameters (a pole): the nearer point wins.
      if (off !== undefined && (!kept || off < offChord(u, v, kept.p)!))
        curved.set(keyOf(u, v), { a: Math.min(u, v), b: Math.max(u, v), p });
    }
  }
  // A shape edge's mid points lie on its curve, whatever its faces' surfaces give.
  chains.forEach((c, k) => {
    for (let i = 1; i < c.nodes.length; i++) {
      const u = c.nodes[i - 1]!,
        v = c.nodes[i]!;
      curved.delete(keyOf(u, v));
      if (!c.params) continue;
      const p = raw.curveAt(k, (c.params[i - 1]! + c.params[i]!) / 2);
      if (p && offChord(u, v, p) !== undefined)
        curved.set(keyOf(u, v), { a: Math.min(u, v), b: Math.max(u, v), p });
    }
  });
  const list = [...curved.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]);
  const offsets = [0];
  for (const c of chains) offsets.push(offsets[offsets.length - 1]! + c.nodes.length);
  return {
    points: new Float64Array(points),
    triangles: new Uint32Array(triangles.flatMap((t) => t.v)),
    faces: new Uint32Array(triangles.map((t) => t.face)),
    shapeFaces: raw.shapeFaces,
    shapeEdges: chains.length,
    edges: {
      offsets: new Uint32Array(offsets),
      nodes: new Uint32Array(chains.flatMap((c) => c.nodes)),
    },
    midpoints: {
      pairs: new Uint32Array(list.flatMap((m) => [m.a, m.b])),
      points: new Float64Array(list.flatMap((m) => m.p)),
    },
  };
}

/** Twice the signed area of a triangle in a face's parameters. */
const uvArea = (w: readonly (readonly [number, number])[]) =>
  (w[1]![0] - w[0]![0]) * (w[2]![1] - w[0]![1]) - (w[2]![0] - w[0]![0]) * (w[1]![1] - w[0]![1]);

/** The angle at corner b of triangle a, b, c (radians). */
const cornerAngle = (a: Xyz, b: Xyz, c: Xyz) => {
  const u: Xyz = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const w: Xyz = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const cos = dot3(u, w) / (Math.hypot(...u) * Math.hypot(...w));
  return Math.acos(Math.max(-1, Math.min(1, cos)));
};
const unit = (v: Xyz): Xyz => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * R3e-3: Delaunay edge flips inside each face (docs/cad/r3-analysis.md, meshingと品質). The
 * kernel's triangulation of a face joins its boundary points in thin fans; the volume mesher keeps
 * the surface, so its slivers become slivers of the solid. An edge between two triangles of the same
 * face, not on a shape edge's chain, is flipped when the angles opposite it add up to more than π
 * (the Delaunay test, in 3D), provided both new triangles face the way the old ones did and bend no
 * more than `maxBendRad` from each other (or no more than the old pair did). Points do not move, so
 * the surface keeps its points on the shape and its face of every triangle. Returns the flips made.
 */
export function flipSurface(
  raw: RawSurface,
  maxBendRad = (10 * Math.PI) / 180,
  sizeOf: EdgeLimit = () => Infinity,
): number {
  const { points, triangles, chains } = raw;
  const P = (n: number): Xyz => [points[3 * n]!, points[3 * n + 1]!, points[3 * n + 2]!];
  const onChain = new Set<number>();
  for (const c of chains)
    for (let i = 1; i < c.nodes.length; i++) onChain.add(keyOf(c.nodes[i - 1]!, c.nodes[i]!));
  const users = new Map<number, number[]>();
  const link = (t: number, add: boolean) => {
    const { v } = triangles[t]!;
    for (let j = 0; j < 3; j++) {
      const k = keyOf(v[j]!, v[(j + 1) % 3]!);
      const list = (users.get(k) ?? []).filter((x) => x !== t);
      if (add) list.push(t);
      if (list.length) users.set(k, list);
      else users.delete(k);
    }
  };
  triangles.forEach((_, t) => link(t, true));
  const queue = [...users.keys()];
  const queued = new Set(queue);
  const minCos = Math.cos(maxBendRad);
  let flips = 0;
  // Each flip strictly raises the sum of the triangles' smallest angles in the Delaunay sense, so it
  // ends; the bound only guards against a numerically cycling pair.
  let budget = 50 * triangles.length + 1000;
  while (queue.length && budget-- > 0) {
    const k = queue.pop()!;
    queued.delete(k);
    const pair = users.get(k);
    if (!pair || pair.length !== 2 || onChain.has(k)) continue;
    const [t1, t2] = pair as [number, number];
    const A = triangles[t1]!,
      B = triangles[t2]!;
    if (A.face !== B.face) continue;
    // A is (a, b, c) with the edge a→b; B runs b→a with d opposite.
    let i = 0;
    while (keyOf(A.v[i]!, A.v[(i + 1) % 3]!) !== k) i++;
    const a = A.v[i]!,
      b = A.v[(i + 1) % 3]!,
      c = A.v[(i + 2) % 3]!;
    let j = 0;
    while (keyOf(B.v[j]!, B.v[(j + 1) % 3]!) !== k) j++;
    if (B.v[j] !== b) continue; // not wound oppositely: leave it
    const d = B.v[(j + 2) % 3]!;
    if (c === d || users.has(keyOf(c, d))) continue;
    const [pa, pb, pc, pd] = [P(a), P(b), P(c), P(d)];
    if (!(cornerAngle(pa, pc, pb) + cornerAngle(pa, pd, pb) > Math.PI + 1e-9)) continue;
    const n1 = normalOf(pa, pb, pc),
      n2 = normalOf(pb, pa, pd);
    const m1 = normalOf(pc, pa, pd),
      m2 = normalOf(pd, pb, pc);
    if (!(dot3(m1, n1) > 0 && dot3(m1, n2) > 0 && dot3(m2, n1) > 0 && dot3(m2, n2) > 0)) continue;
    const bendOld = dot3(unit(n1), unit(n2));
    const bendNew = dot3(unit(m1), unit(m2));
    if (!(bendNew >= Math.min(minCos, bendOld))) continue;
    // The new edge must keep the face's size limit (the refinement's contract).
    if (Math.hypot(pc[0] - pd[0], pc[1] - pd[1], pc[2] - pd[2]) > sizeOf(A.face, pc, pd)) continue;
    const uvOf = (T: typeof A, n: number) => (T.uv ? T.uv[T.v.indexOf(n)]! : null);
    const uv = (x: number, y: number, z: number, from: [typeof A, typeof A, typeof A]) =>
      A.uv && B.uv
        ? ([uvOf(from[0], x), uvOf(from[1], y), uvOf(from[2], z)] as NonNullable<typeof A.uv>)
        : null;
    const uv1 = uv(c, a, d, [A, A, B]),
      uv2 = uv(d, b, c, [B, B, A]);
    // In the face's parameters the quad must be convex (the new triangles keep the old ones'
    // turn): on a thin curved strip the 3D tests alone let a flip fold it.
    if (uv1 && uv2 && A.uv && B.uv) {
      const s0 = Math.sign(uvArea(A.uv));
      if (
        s0 === 0 ||
        Math.sign(uvArea(B.uv)) !== s0 ||
        Math.sign(uvArea(uv1)) !== s0 ||
        Math.sign(uvArea(uv2)) !== s0
      )
        continue;
    }
    link(t1, false);
    link(t2, false);
    triangles[t1] = { v: [c, a, d], face: A.face, uv: uv1 };
    triangles[t2] = { v: [d, b, c], face: A.face, uv: uv2 };
    link(t1, true);
    link(t2, true);
    flips++;
    for (const [x, y] of [
      [c, a],
      [a, d],
      [d, b],
      [b, c],
    ] as const) {
      const q = keyOf(x, y);
      if (!queued.has(q)) {
        queued.add(q);
        queue.push(q);
      }
    }
  }
  return flips;
}

/**
 * R3e-3: moves each point inside a face (on no shape edge's chain, all its triangles of that face,
 * with UV) to the mean UV of its neighbours on the face's surface, when that raises the smallest
 * angle of its triangles and keeps them facing as before. Splitting edges of a fan can leave two
 * new points almost on top of each other, which no flip can separate. Returns the points moved.
 */
export function smoothSurface(
  raw: RawSurface,
  rounds = 3,
  sizeOf: EdgeLimit = () => Infinity,
): number {
  const { points, triangles, chains } = raw;
  const P = (n: number): Xyz => [points[3 * n]!, points[3 * n + 1]!, points[3 * n + 2]!];
  const fixed = new Set<number>();
  for (const c of chains) for (const n of c.nodes) fixed.add(n);
  const star = new Map<number, number[]>();
  triangles.forEach((t, i) => {
    for (const x of t.v) (star.get(x) ?? star.set(x, []).get(x)!).push(i);
  });
  const minAngle = (ts: number[], at: number, q: Xyz) => {
    let m = Math.PI;
    for (const i of ts) {
      const v = triangles[i]!.v.map((x) => (x === at ? q : P(x))) as [Xyz, Xyz, Xyz];
      for (let j = 0; j < 3; j++)
        m = Math.min(m, cornerAngle(v[(j + 2) % 3]!, v[j]!, v[(j + 1) % 3]!));
    }
    return m;
  };
  let moved = 0;
  for (let round = 0; round < rounds; round++) {
    for (const [x, ts] of star) {
      if (fixed.has(x)) continue;
      const face = triangles[ts[0]!]!.face;
      if (ts.some((i) => triangles[i]!.face !== face || !triangles[i]!.uv)) continue;
      const uvs = new Map<number, [number, number]>();
      let own: [number, number] | undefined;
      // A point whose UV differs between its triangles (a pole's arbitrary longitude) stays.
      let same = true;
      for (const i of ts) {
        const T = triangles[i]!;
        T.v.forEach((n, j) => {
          if (n !== x) uvs.set(n, T.uv![j]!);
          else if (!own) own = T.uv![j]!;
          else if (own[0] !== T.uv![j]![0] || own[1] !== T.uv![j]![1]) same = false;
        });
      }
      if (!own || !uvs.size || !same) continue;
      const u = [...uvs.values()].reduce((s, w) => s + w[0], 0) / uvs.size;
      const v = [...uvs.values()].reduce((s, w) => s + w[1], 0) / uvs.size;
      const q = raw.surfaceAt(face, u, v);
      if (!q) continue;
      const before = minAngle(ts, x, P(x));
      if (!(minAngle(ts, x, q) > before)) continue;
      // No edge of the star may grow past its size limit.
      if (
        [...uvs.keys()].some((n) => {
          const r = P(n);
          return Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]) > sizeOf(face, r, q);
        })
      )
        continue;
      const facing = ts.every((i) => {
        const tv = triangles[i]!.v;
        const old = normalOf(P(tv[0]), P(tv[1]), P(tv[2]));
        const w = tv.map((n) => (n === x ? q : P(n))) as [Xyz, Xyz, Xyz];
        return dot3(normalOf(...w), old) > 0;
      });
      if (!facing) continue;
      // In the face's parameters too: the move must not fold a triangle of the star over its
      // neighbour (on a thin curved strip, a fillet, the 3D facing test alone lets it).
      const unfolded = ts.every((i) => {
        const T = triangles[i]!;
        const old = uvArea(T.uv!);
        const now = uvArea(T.uv!.map((w, j) => (T.v[j] === x ? [u, v] : w)) as [number, number][]);
        return old !== 0 && Math.sign(now) === Math.sign(old);
      });
      if (!unfolded) continue;
      points[3 * x] = q[0];
      points[3 * x + 1] = q[1];
      points[3 * x + 2] = q[2];
      for (const i of ts) {
        const T = triangles[i]!;
        T.uv = T.uv!.map((w, j) => (T.v[j] === x ? [u, v] : w)) as NonNullable<RawTriangle['uv']>;
      }
      moved++;
    }
  }
  return moved;
}

/**
 * R3e-3: the analysis surface's triangles made fit for the volume mesher, which keeps them
 * (docs/cad/r3-analysis.md, meshingと品質: radius ratio ≥ 0.05, dihedral ≥ 2° for every
 * tetrahedron, so its surface triangles must not be slivers). Delaunay flips; the sizes; then, given the
 * volume mesh's smallest size (`minEdgeMm`), sizes graded from the shape edges' own spacing
 * (`graded.slope` 0.5) down to it; then rounds of smoothing and
 * flips. On the F02 plate at size 10 this takes the smallest surface angle from 0.7° to 5.3° and
 * the tetrahedra below the limits from 3 361 to none.
 */
/**
 * CR5e: points inside each face with UV, on a triangular lattice of 0.85 × the face's size in its
 * parameters (scaled by the face's mean stretch from UV to mm), each inserted into the triangle
 * holding it (split in three) unless it lies within 0.6 of the spacing of a point already there.
 * A point is kept only on the face's surface near its triangle, every new triangle facing the way
 * the old one did. Returns the points added.
 */
export function seedSurface(raw: RawSurface, sizing: SurfaceSizing): number {
  const { points, triangles } = raw;
  const P = (n: number): Xyz => [points[3 * n]!, points[3 * n + 1]!, points[3 * n + 2]!];
  const dist = (a: Xyz, b: Xyz) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const byFace = new Map<number, number[]>();
  triangles.forEach((t, i) => (byFace.get(t.face) ?? byFace.set(t.face, []).get(t.face)!).push(i));
  const onChain = new Set<number>();
  for (const c of raw.chains)
    for (let i = 1; i < c.nodes.length; i++) onChain.add(keyOf(c.nodes[i - 1]!, c.nodes[i]!));
  /** Edge → the triangles using it, kept through the insertions and flips. */
  const users = new Map<number, number[]>();
  const link = (t: number, add: boolean) => {
    const { v } = triangles[t]!;
    for (let j = 0; j < 3; j++) {
      const k = keyOf(v[j]!, v[(j + 1) % 3]!);
      const list = (users.get(k) ?? []).filter((x) => x !== t);
      if (add) list.push(t);
      if (list.length) users.set(k, list);
      else users.delete(k);
    }
  };
  triangles.forEach((_, t) => link(t, true));
  /** The face's mean stretch from UV to mm (set per face below). */
  let su = 1,
    sv = 1;
  const flat = (w: [number, number]): [number, number] => [w[0] * su, w[1] * sv];
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const angle2 = (p: [number, number], q: [number, number], r: [number, number]) => {
    const u = [p[0] - q[0], p[1] - q[1]],
      w = [r[0] - q[0], r[1] - q[1]];
    const cos =
      (u[0]! * w[0]! + u[1]! * w[1]!) / (Math.hypot(u[0]!, u[1]!) * Math.hypot(w[0]!, w[1]!));
    return Math.acos(Math.max(-1, Math.min(1, cos)));
  };
  /**
   * Lawson's flips from the edges given, in the face's parameters scaled to mm (a plane, a
   * cylinder or a sweep's strip is flat there, where a 3D test refuses flips across a bend): an
   * inner edge of one face whose two opposite angles add up past 180° is flipped when the quad is
   * convex there, and the pair's outer edges are looked at in turn.
   */
  const legalise = (stack: [number, number][]) => {
    let budget = 50 * triangles.length + 1000;
    while (stack.length && budget-- > 0) {
      const [a, b] = stack.pop()!;
      const k = keyOf(a, b);
      const two = users.get(k);
      if (onChain.has(k) || !two || two.length !== 2) continue;
      const [t1, t2] = two as [number, number];
      const T1 = triangles[t1]!,
        T2 = triangles[t2]!;
      if (T1.face !== T2.face || !T1.uv || !T2.uv) continue;
      // T1 as A → B → c; T2 then runs B → A → d.
      const i = T1.v.indexOf(a);
      const forward = T1.v[(i + 1) % 3] === b;
      const [A, B] = forward ? [a, b] : [b, a];
      const ia = T1.v.indexOf(A);
      const c = T1.v[(ia + 2) % 3]!;
      const d = T2.v.find((x) => x !== A && x !== B)!;
      if (c === d || users.has(keyOf(c, d))) continue;
      const uvOf = (T: RawTriangle, x: number) => T.uv![T.v.indexOf(x)]!;
      const [ua, ub, uc, ud] = [uvOf(T1, A), uvOf(T1, B), uvOf(T1, c), uvOf(T2, d)];
      // The two sides of a seam give one point two UVs: leave such a pair.
      const ua2 = uvOf(T2, A),
        ub2 = uvOf(T2, B);
      if (ua2[0] !== ua[0] || ua2[1] !== ua[1] || ub2[0] !== ub[0] || ub2[1] !== ub[1]) continue;
      const [fa, fb, fc, fd] = [flat(ua), flat(ub), flat(uc), flat(ud)];
      if (angle2(fa, fc, fb) + angle2(fb, fd, fa) <= Math.PI + 1e-12) continue;
      const s0 = Math.sign(orient(fa, fb, fc));
      if (
        s0 === 0 ||
        Math.sign(orient(fb, fa, fd)) !== s0 ||
        Math.sign(orient(fa, fd, fc)) !== s0 ||
        Math.sign(orient(fd, fb, fc)) !== s0
      )
        continue;
      link(t1, false);
      link(t2, false);
      triangles[t1] = { v: [A, d, c], face: T1.face, uv: [ua, ud, uc] };
      triangles[t2] = { v: [d, B, c], face: T1.face, uv: [ud, ub, uc] };
      link(t1, true);
      link(t2, true);
      stack.push([A, d], [d, B], [B, c], [c, A]);
    }
  };
  let added = 0;
  for (const [face, list] of byFace) {
    const size = Math.min(sizing.maxEdgeMm, sizing.faces?.get(face) ?? Infinity);
    if (!Number.isFinite(size) || list.some((i) => !triangles[i]!.uv)) continue;
    // The mean stretch |∂X/∂u|, |∂X/∂v| over the face, weighted by area.
    su = 0;
    sv = 0;
    let weight = 0;
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const i of list) {
      const T = triangles[i]!;
      const [a, b, c] = T.v.map(P) as [Xyz, Xyz, Xyz];
      const [p, q, r] = T.uv!;
      for (const w of T.uv!) {
        [u0, u1] = [Math.min(u0, w[0]), Math.max(u1, w[0])];
        [v0, v1] = [Math.min(v0, w[1]), Math.max(v1, w[1])];
      }
      const d1 = [q[0] - p[0], q[1] - p[1]],
        d2 = [r[0] - p[0], r[1] - p[1]];
      const det = d1[0]! * d2[1]! - d1[1]! * d2[0]!;
      if (!(Math.abs(det) > 0)) continue;
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      // J = [e1 e2] · inverse([d1 d2]).
      const ju = [0, 1, 2].map((k) => (e1[k]! * d2[1]! - e2[k]! * d1[1]!) / det);
      const jv = [0, 1, 2].map((k) => (-e1[k]! * d2[0]! + e2[k]! * d1[0]!) / det);
      const n = normalOf(a, b, c);
      const area = Math.hypot(n[0], n[1], n[2]) / 2;
      su += area * Math.hypot(ju[0]!, ju[1]!, ju[2]!);
      sv += area * Math.hypot(jv[0]!, jv[1]!, jv[2]!);
      weight += area;
    }
    if (!(weight > 0 && su > 0 && sv > 0)) continue;
    su /= weight;
    sv /= weight;
    // The face's triangles made Delaunay in its flat parameters first.
    legalise(
      list.flatMap((t) => {
        const { v } = triangles[t]!;
        return [
          [v[0], v[1]],
          [v[1], v[2]],
          [v[2], v[0]],
        ] as [number, number][];
      }),
    );
    // A little under the size, so the lattice's edges stay within it where the stretch varies.
    const step = 0.85 * size;
    const hu = step / su,
      hv = (step * Math.sqrt(3)) / 2 / sv;
    const rows = Math.floor((v1 - v0) / hv),
      cols = Math.floor((u1 - u0) / hu);
    if (rows < 1 && cols < 1) continue;
    // The points already on the face, hashed in cells of the size.
    const cell = new Map<string, Xyz[]>();
    const at = (x: Xyz) => x.map((c) => Math.floor(c / size)).join(',');
    const put = (x: Xyz) => (cell.get(at(x)) ?? cell.set(at(x), []).get(at(x))!).push(x);
    for (const i of list) for (const n of triangles[i]!.v) put(P(n));
    const crowded = (x: Xyz) => {
      const c = x.map((v) => Math.floor(v / size));
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++)
            for (const y of cell.get(`${c[0]! + i},${c[1]! + j},${c[2]! + k}`) ?? [])
              if (dist(x, y) < 0.6 * step) return true;
      return false;
    };
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const u = u0 + (u1 - u0 - cols * hu) / 2 + (i + (j % 2) / 2) * hu,
          v = v0 + (v1 - v0 - rows * hv) / 2 + j * hv;
        // The triangle holding (u, v) in its parameters.
        let at3 = -1,
          bary: number[] = [];
        for (let k = 0; k < list.length && at3 < 0; k++) {
          const [p, q, r] = triangles[list[k]!]!.uv!;
          const det = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
          if (det === 0) continue;
          const l1 = ((u - p[0]) * (r[1] - p[1]) - (v - p[1]) * (r[0] - p[0])) / det;
          const l2 = ((q[0] - p[0]) * (v - p[1]) - (q[1] - p[1]) * (u - p[0])) / det;
          if (l1 > 0 && l2 > 0 && l1 + l2 < 1) [at3, bary] = [list[k]!, [1 - l1 - l2, l1, l2]];
        }
        if (at3 < 0) continue;
        const T = triangles[at3]!;
        const q = raw.surfaceAt(face, u, v);
        if (!q || crowded(q)) continue;
        const corners = T.v.map(P) as [Xyz, Xyz, Xyz];
        const flat = [0, 1, 2].map((d) =>
          corners.reduce((s, x, k) => s + bary[k]! * x[d]!, 0),
        ) as Xyz;
        if (dist(q, flat) > 0.5 * size) continue;
        // Not on or next to an edge of its triangle: no part thinner than a tenth of the step.
        const near = [0, 1, 2].some((k) => {
          const [x, y] = [corners[k]!, corners[(k + 1) % 3]!];
          const n = normalOf(x, y, q);
          return Math.hypot(n[0], n[1], n[2]) / dist(x, y) < 0.1 * step;
        });
        if (near) continue;
        const before = normalOf(...corners);
        const parts: [number, number][] = [
          [0, 1],
          [1, 2],
          [2, 0],
        ];
        if (parts.some(([x, y]) => !(dot3(normalOf(corners[x]!, corners[y]!, q), before) > 0)))
          continue;
        // Codex on #1010: the limit counts the triangles a point adds, not the face's UV box.
        if (triangles.length + 2 > sizing.maxTriangles) throw new AnalysisSurfaceLimit();
        const m = points.length / 3;
        points.push(...q);
        put(q);
        const uv = T.uv!;
        const [x0, x1, x2] = T.v;
        link(at3, false);
        triangles[at3] = { v: [x0, x1, m], face, uv: [uv[0], uv[1], [u, v]] };
        triangles.push({ v: [x1, x2, m], face, uv: [uv[1], uv[2], [u, v]] });
        triangles.push({ v: [x2, x0, m], face, uv: [uv[2], uv[0], [u, v]] });
        for (const t of [at3, triangles.length - 2, triangles.length - 1]) link(t, true);
        list.push(triangles.length - 2, triangles.length - 1);
        legalise([
          [x0, x1],
          [x1, x2],
          [x2, x0],
        ]);
        added++;
      }
  }
  return added;
}

/**
 * CR5e: the faces narrower than their size (area over the longest shape edge bounding them),
 * each with the spacing of its finest long side (a chain longer than the size, by its mean
 * segment), when that is finer than the size.
 */
export function evenNarrowFaces(raw: RawSurface, sizing: SurfaceSizing): Map<number, number> {
  const { points, triangles, chains } = raw;
  const P = (n: number): Xyz => [points[3 * n]!, points[3 * n + 1]!, points[3 * n + 2]!];
  const area = new Map<number, number>();
  const edgeFaces = new Map<number, Set<number>>();
  for (const t of triangles) {
    const n = normalOf(P(t.v[0]), P(t.v[1]), P(t.v[2]));
    area.set(t.face, (area.get(t.face) ?? 0) + Math.hypot(n[0], n[1], n[2]) / 2);
    for (let j = 0; j < 3; j++) {
      const k = keyOf(t.v[j]!, t.v[(j + 1) % 3]!);
      (edgeFaces.get(k) ?? edgeFaces.set(k, new Set()).get(k)!).add(t.face);
    }
  }
  const sizeOf = (f: number) => Math.min(sizing.maxEdgeMm, sizing.faces?.get(f) ?? Infinity);
  const sides = new Map<number, { length: number; spacing: number }[]>();
  for (const c of chains) {
    if (c.nodes.length < 2) continue;
    let length = 0;
    const faces = new Set<number>();
    for (let i = 1; i < c.nodes.length; i++) {
      const [a, b] = [P(c.nodes[i - 1]!), P(c.nodes[i]!)];
      length += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      for (const f of edgeFaces.get(keyOf(c.nodes[i - 1]!, c.nodes[i]!)) ?? []) faces.add(f);
    }
    const spacing = length / (c.nodes.length - 1);
    for (const f of faces) (sides.get(f) ?? sides.set(f, []).get(f)!).push({ length, spacing });
  }
  const out = new Map<number, number>();
  for (const [f, list] of sides) {
    const size = sizeOf(f);
    const long = list.filter((x) => x.length > size);
    if (!long.length) continue;
    const width = (area.get(f) ?? 0) / Math.max(...long.map((x) => x.length));
    const finest = Math.min(...long.map((x) => x.spacing));
    if (width < size && finest < size * (1 - 1e-9)) out.set(f, finest * (1 + 1e-9));
  }
  return out;
}

export function improveSurface(
  raw: RawSurface,
  sizing: SurfaceSizing & { minEdgeMm?: number },
): void {
  flipSurface(raw);
  // CR5e: a shell's faces meshed one by one before the bisection: on a sheet's 3 mm bend 1200 mm
  // long, the bisection of the kernel's few long triangles fills the face with points (10 000
  // triangles where 250 do, slivers along its edges), and more where a 10 mm weld size meets 30.
  if (sizing.seed) {
    const all = new Set(Array.from({ length: raw.shapeFaces }, (_, f) => f));
    refineSurface(raw, { ...sizing, chainsOf: all });
    // A narrow face (a bend between a 10 mm weld flange and a 30 mm wall) takes its finer long
    // side's spacing on both long sides, so it is meshed in even rows across.
    const evened = evenNarrowFaces(raw, sizing);
    if (evened.size) {
      const faces = new Map(sizing.faces ?? []);
      for (const [f, h] of evened) faces.set(f, Math.min(h, faces.get(f) ?? Infinity));
      refineSurface(raw, { ...sizing, faces, chainsOf: new Set(evened.keys()) });
    }
    flipSurface(raw);
    seedSurface(raw, sizing);
    flipSurface(raw);
    // What the lattice leaves too long (a narrow face's lengthwise edges): passes of single
    // splits with flips between, so a split's long new edges are flipped away, not split in turn.
    for (let k = 0; k < 64 && refineSurface(raw, { ...sizing, once: true }); k++) flipSurface(raw);
  }
  // The sizes first, so the graded size is measured along edges no longer than them.
  refineSurface(raw, sizing);
  flipSurface(raw);
  if (sizing.minEdgeMm !== undefined) {
    refineSurface(raw, { ...sizing, graded: { slope: 0.5, minMm: sizing.minEdgeMm } });
    flipSurface(raw);
  }
  for (let k = 0; k < 8; k++) {
    if (!smoothSurface(raw, 2)) break;
    flipSurface(raw);
  }
  // Moves and flips may have lengthened edges: the sizes again (the request's contract), then
  // flips and moves that keep every edge within its face's size.
  // Codex on #1018: the point sizes too, at the edge's middle, as the refinement measures them.
  const near = nearSize(sizing.near, Math.max(sizing.maxEdgeMm, ...(sizing.faces?.values() ?? [])));
  const sizeOf: EdgeLimit = (f, a, b) =>
    Math.min(
      sizing.maxEdgeMm,
      sizing.faces?.get(f) ?? Infinity,
      near ? near((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2) : Infinity,
    );
  refineSurface(raw, sizing);
  flipSurface(raw, undefined, sizeOf);
  for (let k = 0; k < 4; k++) {
    if (!smoothSurface(raw, 2, sizeOf)) break;
    flipSurface(raw, undefined, sizeOf);
  }
}
