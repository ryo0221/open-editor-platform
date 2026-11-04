import { triangulateFace } from './display';
import type { EpmMesh } from './epm';
import type { EditInput } from './edit';
import { edgeKey, editFail, halfEdgeTo, meshTopology, nextHalfEdge } from './topology';

/**
 * UV unwrapping (C4). A mesh is cut into charts along its seams and borders; each chart is
 * flattened by least squares conformal maps (LSCM), scaled to its area in millimetres (so every
 * chart has the same texel density) and packed into the unit square. Seams are not stored on
 * their own: an edge is a seam where the UVs on its two sides differ, so an unwrapped mesh keeps
 * its seams through every edit that keeps the UVs (`uvSeams`).
 */

const EPS = 1e-6;

/** The edges (as `edgeKey`s) whose UVs differ on their two sides. None without UVs. */
export function uvSeams(input: EditInput): number[] {
  const { mesh, topology: t } = input;
  const uv = mesh.uvs;
  if (!uv) return [];
  const same = (a: number, b: number) =>
    Math.abs(uv[2 * a]! - uv[2 * b]!) <= EPS && Math.abs(uv[2 * a + 1]! - uv[2 * b + 1]!) <= EPS;
  const out: number[] = [];
  for (let h = 0; h < mesh.faceIndices.length; h++) {
    const tw = t.twin[h]!;
    if (tw < h) continue; // a border (-1) or seen from the other side
    // h runs a→b; its twin b→a. Corner h (a) meets the twin's next corner (a), and h's next
    // corner (b) meets the twin's own (b).
    if (!same(h, nextHalfEdge(t, tw)) || !same(nextHalfEdge(t, h), tw))
      out.push(edgeKey(mesh.faceIndices[h]!, halfEdgeTo(mesh, t, h)));
  }
  return out;
}

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n).map((_, i) => i);
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]!]!;
      x = p[x]!;
    }
    return x;
  }
  union(a: number, b: number) {
    const x = this.find(a),
      y = this.find(b);
    if (x !== y) this.parent[x] = y;
  }
}

/** Limits of unwrapping: the edit limit (200,000 vertices) applies through `EditInput`. */
export const unwrapLimits = Object.freeze({ iterations: 20_000 });

/**
 * New UVs for every face corner: the mesh cut along `seams` (edge keys; borders always cut),
 * each chart flattened by LSCM with its two farthest boundary vertices pinned, scaled to its 3D
 * area and turned to its smallest bounding box, then all charts packed without overlap into [0, 1]² with a margin. Everything else of the mesh
 * is kept. Refuses (`degenerate`) a chart with no seam or border (a closed surface cannot lie
 * flat), and one whose faces all have no area.
 */
export function unwrapMesh(input: EditInput, seams: Iterable<number>): EpmMesh {
  const { mesh, topology: t } = input;
  const corners = mesh.faceIndices.length;
  const faces = mesh.faceSizes.length;
  const cut = new Set(seams);
  const charts = new UnionFind(faces);
  const wedges = new UnionFind(corners);
  const open = new Uint8Array(corners); // the corner's edge (h → next) is cut
  for (let h = 0; h < corners; h++) {
    const tw = t.twin[h]!;
    const key = edgeKey(mesh.faceIndices[h]!, halfEdgeTo(mesh, t, h));
    if (tw < 0 || cut.has(key)) {
      open[h] = 1;
      continue;
    }
    if (tw < h) continue;
    charts.union(t.halfEdgeFace[h]!, t.halfEdgeFace[tw]!);
    wedges.union(h, nextHalfEdge(t, tw));
    wedges.union(nextHalfEdge(t, h), tw);
  }
  // Group faces by chart, in first-face order.
  const byChart = new Map<number, number[]>();
  for (let f = 0; f < faces; f++) {
    const c = charts.find(f);
    const list = byChart.get(c);
    if (list) list.push(f);
    else byChart.set(c, [f]);
  }
  const uvs = new Float32Array(corners * 2);
  const placed: Chart[] = [];
  for (const list of byChart.values()) placed.push(flattenChart(mesh, t, list, wedges, open));
  pack(placed);
  for (const c of placed)
    for (const [corner, w] of c.cornerWedge) {
      uvs[2 * corner] = c.uv[2 * w]!;
      uvs[2 * corner + 1] = c.uv[2 * w + 1]!;
    }
  return { ...mesh, uvs };
}

interface Chart {
  /** Corner → local wedge index. */
  cornerWedge: Map<number, number>;
  /** u, v per local wedge (mm, then packed). */
  uv: Float64Array;
}

function flattenChart(
  mesh: EpmMesh,
  t: EditInput['topology'],
  faces: number[],
  wedges: UnionFind,
  open: Uint8Array,
): Chart {
  const p = mesh.positions;
  const local = new Map<number, number>(); // wedge root → local index
  const cornerWedge = new Map<number, number>();
  const wedgeVertex: number[] = [];
  let bordered = false;
  const rim: number[] = []; // corners whose edge is on the chart's boundary
  for (const f of faces) {
    const s = t.faceStart[f]!,
      n = t.faceSizes[f]!;
    for (let k = 0; k < n; k++) {
      const c = s + k;
      if (open[c]) {
        bordered = true;
        rim.push(c, s + ((k + 1) % n));
      }
      const root = wedges.find(c);
      let w = local.get(root);
      if (w === undefined) {
        w = wedgeVertex.length;
        local.set(root, w);
        wedgeVertex.push(mesh.faceIndices[c]!);
      }
      cornerWedge.set(c, w);
    }
  }
  if (!bordered)
    editFail(
      'degenerate',
      `the faces around face ${faces[0]} close up with no seam: mark a seam to unwrap them`,
    );
  const n = wedgeVertex.length;
  const P = (w: number) => {
    const v = 3 * wedgeVertex[w]!;
    return [p[v]!, p[v + 1]!, p[v + 2]!] as const;
  };
  // Rows of the conformal energy: two per triangle, three wedges (u, v) each.
  const rows: { w: [number, number, number]; re: number[]; im: number[]; area: number }[] = [];
  let area3 = 0;
  const normal = [0, 0, 0];
  for (const f of faces) {
    const s = t.faceStart[f]!,
      size = t.faceSizes[f]!;
    const tri = triangulateFace(mesh, s, size);
    for (let i = 0; i < tri.length; i += 3) {
      const w = [0, 1, 2].map((j) => cornerWedge.get(s + tri[i + j]!)!) as [number, number, number];
      const [a, b, c] = w.map(P);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const twice = Math.hypot(nx, ny, nz);
      const l1 = Math.hypot(e1[0]!, e1[1]!, e1[2]!);
      if (!(twice > 1e-12) || !(l1 > 1e-12)) continue;
      area3 += twice / 2;
      normal[0] += nx;
      normal[1] += ny;
      normal[2] += nz;
      // The triangle in its own plane: a at 0, b on +x.
      const x = [e1[0]! / l1, e1[1]! / l1, e1[2]! / l1];
      const y = [
        (ny * x[2]! - nz * x[1]!) / twice,
        (nz * x[0]! - nx * x[2]!) / twice,
        (nx * x[1]! - ny * x[0]!) / twice,
      ];
      const q = [
        [0, 0],
        [l1, 0],
        [
          e2[0]! * x[0]! + e2[1]! * x[1]! + e2[2]! * x[2]!,
          e2[0]! * y[0]! + e2[1]! * y[1]! + e2[2]! * y[2]!,
        ],
      ];
      const sd = Math.sqrt(twice);
      // W_j = q_{j+2} − q_{j+1}: Σ W_j U_j is 0 for the triangle's own shape (no distortion).
      const W = [0, 1, 2].map((j) => {
        const k = (j + 1) % 3,
          l = (j + 2) % 3;
        return [(q[l]![0]! - q[k]![0]!) / sd, (q[l]![1]! - q[k]![1]!) / sd];
      });
      rows.push({
        w,
        area: twice / 2,
        re: W.flatMap(([r, i]) => [r!, -i!]),
        im: W.flatMap(([r, i]) => [i!, r!]),
      });
    }
  }
  if (!rows.length) editFail('degenerate', `the faces around face ${faces[0]} have no area`);
  // Pins: the two boundary wedges farthest apart (two sweeps), at (0, 0) and (their distance,
  // 0). An interior pin (the apex of a pyramid) would fold the chart over itself.
  const boundary = [...new Set(rim.map((c) => cornerWedge.get(c)!))];
  const far = (from: number) => {
    const o = P(from);
    let best = from,
      d = -1;
    for (const w of boundary) {
      const q = P(w);
      const e = Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]);
      if (e > d) {
        d = e;
        best = w;
      }
    }
    return [best, d] as const;
  };
  const [pa] = far(boundary[0]!);
  const [pb, dist] = far(pa);
  const uv = new Float64Array(2 * n);
  const pinned = new Uint8Array(2 * n);
  // A start near the answer: the chart projected onto its mean plane, pa at 0 and pb on +u.
  // (Exact for a flat chart; conjugate gradients converge much sooner from it.)
  {
    const nl = Math.hypot(normal[0]!, normal[1]!, normal[2]!) || 1;
    const N = normal.map((c) => c / nl);
    const A = P(pa),
      B = P(pb);
    let ax = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const along = ax[0]! * N[0]! + ax[1]! * N[1]! + ax[2]! * N[2]!;
    ax = ax.map((c, i) => c - along * N[i]!);
    const al = Math.hypot(ax[0]!, ax[1]!, ax[2]!);
    if (al > 1e-12) {
      const X = ax.map((c) => c / al);
      const Y = [
        N[1]! * X[2]! - N[2]! * X[1]!,
        N[2]! * X[0]! - N[0]! * X[2]!,
        N[0]! * X[1]! - N[1]! * X[0]!,
      ];
      // Scaled so that pb's start lies on its pin.
      const k = dist / al;
      for (let w = 0; w < n; w++) {
        const q = P(w);
        const d = [q[0] - A[0], q[1] - A[1], q[2] - A[2]];
        uv[2 * w] = k * (d[0]! * X[0]! + d[1]! * X[1]! + d[2]! * X[2]!);
        uv[2 * w + 1] = k * (d[0]! * Y[0]! + d[1]! * Y[1]! + d[2]! * Y[2]!);
      }
    }
  }
  uv[2 * pa] = uv[2 * pa + 1] = 0;
  uv[2 * pb] = dist;
  uv[2 * pb + 1] = 0;
  for (const w of [pa, pb]) pinned[2 * w] = pinned[2 * w + 1] = 1;
  if (pa !== pb) solve(rows, uv, pinned);
  // Mirrored (a negative area): flip u. Then scale the chart to its area in millimetres.
  let areaUv = 0;
  for (const r of rows) {
    const [a, b, c] = r.w;
    areaUv +=
      ((uv[2 * b]! - uv[2 * a]!) * (uv[2 * c + 1]! - uv[2 * a + 1]!) -
        (uv[2 * c]! - uv[2 * a]!) * (uv[2 * b + 1]! - uv[2 * a + 1]!)) /
      2;
  }
  // Too few seams can leave the chart collapsed onto a line (no area): refuse it.
  if (!(Math.abs(areaUv) > 1e-6 * area3)) collapsed(faces[0]!);
  if (areaUv < 0) for (let w = 0; w < n; w++) uv[2 * w] = -uv[2 * w]!;
  const scale = Math.sqrt(area3 / Math.abs(areaUv));
  for (let i = 0; i < uv.length; i++) uv[i] = uv[i]! * scale;
  if (!uv.every(Number.isFinite)) editFail('degenerate', `face ${faces[0]} could not be flattened`);
  // Every triangle keeps an area and the chart's orientation: a partly collapsed or folded
  // result is no use as texture coordinates.
  for (const r of rows) {
    const [a, b, c] = r.w;
    const at =
      ((uv[2 * b]! - uv[2 * a]!) * (uv[2 * c + 1]! - uv[2 * a + 1]!) -
        (uv[2 * c]! - uv[2 * a]!) * (uv[2 * b + 1]! - uv[2 * a + 1]!)) /
      2;
    if (!(at > 1e-6 * r.area)) collapsed(faces[0]!);
  }
  alignChart(
    uv,
    rim.map((c) => cornerWedge.get(c)!),
  );
  return { cornerWedge, uv };
}

/**
 * Turns a flat chart (in place) so that its bounding box is smallest among the directions of
 * its boundary edges: a quad face lies square to the texture's axes instead of along its
 * diagonal (where the pins put it), and the charts pack tighter. Turning keeps angles and areas.
 * `rim` is the boundary as wedge pairs (from, to).
 */
function alignChart(uv: Float64Array, rim: number[]) {
  const points = [...new Set(rim)];
  // Candidate directions: the longest boundary edges, at most 256 of them.
  const edges: { angle: number; length: number }[] = [];
  for (let i = 0; i < rim.length; i += 2) {
    const a = rim[i]!,
      b = rim[i + 1]!;
    const dx = uv[2 * b]! - uv[2 * a]!,
      dy = uv[2 * b + 1]! - uv[2 * a + 1]!;
    const length = Math.hypot(dx, dy);
    if (length > 0) edges.push({ angle: Math.atan2(dy, dx), length });
  }
  if (!edges.length) return;
  edges.sort((x, y) => y.length - x.length);
  const box = (angle: number) => {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const w of points) {
      const u = uv[2 * w]!,
        v = uv[2 * w + 1]!;
      const x = c * u + s * v,
        y = -s * u + c * v;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return (x1 - x0) * (y1 - y0);
  };
  let best = 0,
    area = box(0);
  for (const { angle } of edges.slice(0, 256)) {
    const a = box(angle);
    // A clearly smaller box only: near-ties keep the earlier (longer edge's) direction.
    if (a < area * (1 - 1e-9)) {
      area = a;
      best = angle;
    }
  }
  if (best === 0) return;
  const c = Math.cos(best),
    s = Math.sin(best);
  for (let w = 0; w < uv.length / 2; w++) {
    const u = uv[2 * w]!,
      v = uv[2 * w + 1]!;
    uv[2 * w] = c * u + s * v;
    uv[2 * w + 1] = -s * u + c * v;
  }
}

const collapsed = (face: number): never =>
  editFail(
    'degenerate',
    `the faces around face ${face} could not be flattened: mark more seams to unwrap them`,
  );

/**
 * Least squares for the free unknowns of `x` (pinned ones stay): the normal equations
 * AᵀA x = −Aᵀ(A x_pinned), by conjugate gradients with a Jacobi preconditioner.
 */
function solve(
  rows: { w: [number, number, number]; re: number[]; im: number[] }[],
  x: Float64Array,
  pinned: Uint8Array,
) {
  const m = x.length;
  // Flat rows: 6 columns (−1 where pinned) and 12 coefficients (real part, then imaginary).
  const R = rows.length;
  const col = new Int32Array(R * 6);
  const pin = new Int32Array(R * 6);
  const coef = new Float64Array(R * 12);
  rows.forEach((r, i) => {
    for (let k = 0; k < 6; k++) {
      const c = 2 * r.w[k >> 1]! + (k & 1);
      col[6 * i + k] = pinned[c] ? -1 : c;
      pin[6 * i + k] = c;
      coef[12 * i + k] = r.re[k]!;
      coef[12 * i + 6 + k] = r.im[k]!;
    }
  });
  /** out = Aᵀ A v over the free unknowns (pinned columns read as 0). */
  const normal = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let i = 0; i < R; i++) {
      const o = 6 * i,
        q = 12 * i;
      let sr = 0,
        si = 0;
      for (let k = 0; k < 6; k++) {
        const c = col[o + k]!;
        if (c < 0) continue;
        sr += coef[q + k]! * v[c]!;
        si += coef[q + 6 + k]! * v[c]!;
      }
      for (let k = 0; k < 6; k++) {
        const c = col[o + k]!;
        if (c >= 0) out[c] = out[c]! + coef[q + k]! * sr + coef[q + 6 + k]! * si;
      }
    }
  };
  // b = −Aᵀ A x_pinned, and the diagonal of AᵀA for the preconditioner.
  const b = new Float64Array(m);
  const diag = new Float64Array(m);
  for (let i = 0; i < R; i++) {
    const o = 6 * i,
      q = 12 * i;
    let sr = 0,
      si = 0;
    for (let k = 0; k < 6; k++) {
      if (col[o + k]! >= 0) continue;
      const c = pin[o + k]!;
      sr += coef[q + k]! * x[c]!;
      si += coef[q + 6 + k]! * x[c]!;
    }
    for (let k = 0; k < 6; k++) {
      const c = col[o + k]!;
      if (c < 0) continue;
      b[c] = b[c]! - coef[q + k]! * sr - coef[q + 6 + k]! * si;
      diag[c] = diag[c]! + coef[q + k]! ** 2 + coef[q + 6 + k]! ** 2;
    }
  }
  // The free unknowns start where `x` has them; r = b − AᵀA v.
  const v = new Float64Array(m);
  for (let i = 0; i < m; i++) if (!pinned[i]) v[i] = x[i]!;
  const r = new Float64Array(m);
  normal(v, r);
  for (let i = 0; i < m; i++) r[i] = b[i]! - r[i]!;
  const z = new Float64Array(m);
  const precondition = () => {
    for (let i = 0; i < m; i++) z[i] = pinned[i] || !(diag[i]! > 0) ? 0 : r[i]! / diag[i]!;
  };
  precondition();
  const d = z.slice();
  const Ad = new Float64Array(m);
  let rz = dot(r, z);
  const tol = 1e-14 * Math.max(dot(b, b), 1e-30);
  for (let it = 0; it < unwrapLimits.iterations && dot(r, r) > tol; it++) {
    normal(d, Ad);
    const alpha = rz / dot(d, Ad);
    if (!Number.isFinite(alpha)) break;
    for (let i = 0; i < m; i++) {
      v[i] = v[i]! + alpha * d[i]!;
      r[i] = r[i]! - alpha * Ad[i]!;
    }
    precondition();
    const next = dot(r, z);
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < m; i++) d[i] = z[i]! + beta * d[i]!;
  }
  for (let i = 0; i < m; i++) if (!pinned[i]) x[i] = v[i]!;
}
const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/**
 * Packs the charts into [0, 1]²: shelves of charts sorted tallest first in a strip about as
 * wide as the charts' total area is deep, a margin between them, then one uniform scale (texel
 * density stays the same across charts).
 */
function pack(charts: Chart[]) {
  const boxes = charts.map((c) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < c.uv.length; i += 2) {
      x0 = Math.min(x0, c.uv[i]!);
      x1 = Math.max(x1, c.uv[i]!);
      y0 = Math.min(y0, c.uv[i + 1]!);
      y1 = Math.max(y1, c.uv[i + 1]!);
    }
    return { c, x0, y0, w: x1 - x0, h: y1 - y0 };
  });
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
  const margin = Math.sqrt(Math.max(total, 1e-12)) * 0.02;
  // A loop, not Math.max(...): there can be more charts than a call takes arguments.
  let widest = Math.sqrt(total) * 1.1;
  for (const b of boxes) widest = Math.max(widest, b.w);
  const width = widest + margin;
  const order = [...boxes].sort((a, b) => b.h - a.h);
  let x = margin,
    y = margin,
    shelf = 0,
    usedW = 0;
  for (const b of order) {
    if (x > margin && x + b.w + margin > width) {
      x = margin;
      y += shelf + margin;
      shelf = 0;
    }
    const dx = x - b.x0,
      dy = y - b.y0;
    for (let i = 0; i < b.c.uv.length; i += 2) {
      b.c.uv[i] = b.c.uv[i]! + dx;
      b.c.uv[i + 1] = b.c.uv[i + 1]! + dy;
    }
    x += b.w + margin;
    usedW = Math.max(usedW, x);
    shelf = Math.max(shelf, b.h);
  }
  const usedH = y + shelf + margin;
  const s = 1 / Math.max(usedW, usedH, 1e-12);
  for (const c of charts) for (let i = 0; i < c.uv.length; i++) c.uv[i] = c.uv[i]! * s;
}

/**
 * How far the UVs are from the surface's own shape, per triangle with area: `conformal` is the
 * largest ratio of the two stretches (1 keeps every angle), `area` the smallest and largest
 * area scale against the mesh's mean (1 keeps every texel the same size). For the CH40 check.
 */
export function uvDistortion(mesh: EpmMesh): { conformal: number; area: [number, number] } {
  const uv = mesh.uvs;
  if (!uv) return { conformal: Infinity, area: [0, Infinity] };
  const t = meshTopology(mesh);
  const p = mesh.positions;
  const tris: { a3: number; s1: number; s2: number }[] = [];
  let sum3 = 0,
    sumUv = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const s = t.faceStart[f]!;
    const tri = triangulateFace(mesh, s, t.faceSizes[f]!);
    for (let i = 0; i < tri.length; i += 3) {
      const c = [0, 1, 2].map((j) => s + tri[i + j]!);
      const P = c.map((k) => {
        const v = 3 * mesh.faceIndices[k]!;
        return [p[v]!, p[v + 1]!, p[v + 2]!];
      });
      const e1 = [0, 1, 2].map((d) => P[1]![d]! - P[0]![d]!);
      const e2 = [0, 1, 2].map((d) => P[2]![d]! - P[0]![d]!);
      const l1 = Math.hypot(...e1);
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const twice = Math.hypot(...n);
      if (!(twice > 1e-12) || !(l1 > 1e-12)) continue;
      // Local 2D: (x1, 0), (x2, y2).
      const x1 = l1,
        x2 = (e2[0]! * e1[0]! + e2[1]! * e1[1]! + e2[2]! * e1[2]!) / l1,
        y2 = twice / l1;
      const du1 = uv[2 * c[1]!]! - uv[2 * c[0]!]!,
        dv1 = uv[2 * c[1]! + 1]! - uv[2 * c[0]! + 1]!;
      const du2 = uv[2 * c[2]!]! - uv[2 * c[0]!]!,
        dv2 = uv[2 * c[2]! + 1]! - uv[2 * c[0]! + 1]!;
      // Jacobian of (x, y) → (u, v).
      const a = du1 / x1,
        b = (du2 - a * x2) / y2,
        cc = dv1 / x1,
        d = (dv2 - cc * x2) / y2;
      // Singular values of [[a, b], [cc, d]].
      const e = (a + d) / 2,
        ff = (a - d) / 2,
        g = (cc + b) / 2,
        h = (cc - b) / 2;
      const q = Math.hypot(e, h),
        r = Math.hypot(ff, g);
      const s1 = q + r,
        s2 = Math.abs(q - r);
      tris.push({ a3: twice / 2, s1, s2 });
      sum3 += twice / 2;
      sumUv += (s1 * s2 * twice) / 2;
    }
  }
  const mean = sum3 > 0 ? sumUv / sum3 : 0;
  let conformal = 1,
    lo = Infinity,
    hi = 0;
  for (const x of tris) {
    conformal = Math.max(conformal, x.s2 > 0 ? x.s1 / x.s2 : Infinity);
    const ratio = mean > 0 ? (x.s1 * x.s2) / mean : 0;
    lo = Math.min(lo, ratio);
    hi = Math.max(hi, ratio);
  }
  return { conformal, area: [lo, hi] };
}
