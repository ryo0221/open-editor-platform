import type { DrawingPmiLive } from './pmi';
import type { DrawingDirection, Vec2 } from './model';

/**
 * DW2 (docs/cad/drawing-editor.md, 寸法のアンカー): the orthographic projection of triangulated
 * bodies with their B-rep edges, in pure TypeScript. Every line keeps an anchor: the placement
 * path of its body (an assembly's occurrence IDs, empty in a part) and what of the shape it is
 * (an edge of the body's topology, the silhouette of a face, or a circle's axis). Visibility is
 * decided per sample by the triangles in front of it, so hidden lines are exact up to the
 * triangulation's deflection, which the caller fixes (never the display's level of detail).
 */

export type Vec3 = [number, number, number];

/** One body in model space (placed), with its triangles and its B-rep edges. */
export interface DrawingMeshBody {
  /** Occurrence IDs from the assembly's root to this body's part (empty for a part drawing). */
  path: string[];
  bodyId: string;
  /** x, y, z per node (mm, model space, placed). */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Per triangle, its face's index in the body's topology (or −1). */
  faces: ArrayLike<number>;
  /**
   * Per B-rep edge (topology index), its polyline: x, y, z per point, and its persistent name
   * (the CAD topology name as canonical JSON; none for imported geometry), which a dimension
   * follows to a newer version (DW3c).
   */
  edges: { index: number; points: ArrayLike<number>; name?: string }[];
  /** DW3c-2b: the body's PMI items (the Host's; the projection does not read them). */
  pmi?: DrawingPmiLive[];
  /**
   * An open sheet, not a solid: a section draws where its plane cuts it, but no filled (hatched)
   * face, and that cut hides nothing behind it (Codex on #1278).
   */
  sheet?: boolean;
}

export type DrawingAnchor =
  | { kind: 'edge'; path: string[]; bodyId: string; edge: number }
  /** The outline of a curved face seen edge-on (no B-rep edge lies there). */
  | { kind: 'silhouette'; path: string[]; bodyId: string; face: number }
  /** The axis of a circular edge seen side-on, or the centre cross of one seen face-on. */
  | { kind: 'axis'; path: string[]; bodyId: string; edge: number }
  /** Where a section's plane cuts a face of the body (DW2b). */
  | { kind: 'section'; path: string[]; bodyId: string; face: number };

/** How a view looks at the model: into the scene, and the paper's up and right (unit, square). */
export interface DrawingViewFrame {
  direction: Vec3;
  up: Vec3;
  right: Vec3;
}
/** A section's plane: material on the viewer's side of it is taken away (DW2b). */
export interface DrawingCut {
  /** A point of the plane (model mm). */
  point: Vec3;
  /** The plane's normal, into the scene (the kept material lies on this side). */
  normal: Vec3;
}
/** The faces a section cuts in one body: closed loops in the view plane, filled even–odd. */
export interface DrawingCutRegion {
  path: string[];
  bodyId: string;
  loops: Vec2[][];
}

/** A stable key of an anchor (the same shape seen in one view). */
export const drawingAnchorKey = (a: DrawingAnchor) =>
  `${a.path.join('/')}|${a.bodyId}|${a.kind}|${a.kind === 'silhouette' || a.kind === 'section' ? a.face : a.edge}`;

/**
 * What a dimension measures on a B-rep edge a view shows (DW3): its ends as kept (a section cuts
 * them), and its circle when it lies on one. Model mm, so values are measured in 3D.
 */
export interface DrawingEdgeFeature {
  anchor: Extract<DrawingAnchor, { kind: 'edge' }>;
  start: Vec3;
  end: Vec3;
  /** Whether the edge is straight (every point on the line through its ends). */
  straight: boolean;
  circle?: { c: Vec3; n: Vec3; r: number };
  /** A circle's or arc's kept pieces (model mm): where it can be picked (Codex on #1211). */
  runs?: Vec3[][];
  /** False when the view draws none of it (it still resolves a dimension, but is not picked). */
  pickable?: boolean;
  /** The edge's persistent name (DW3c), when its body has one. */
  name?: string;
}

export interface DrawingProjectedLine {
  /** View-plane points (model mm): x along `right`, y along `up`. */
  points: Vec2[];
  hidden: boolean;
  anchor: DrawingAnchor;
}
export interface DrawingProjectedView {
  lines: DrawingProjectedLine[];
  /** Centre lines (`axis` anchors): a circle's cross, or the axis through coaxial circles. */
  centers: DrawingProjectedLine[];
  /** A section's cut faces, per body (none without a cut). */
  cuts: DrawingCutRegion[];
  /**
   * The projected box of every node (the material a section takes away included): what the
   * view's placement centres on, so a section lines up with its parent like a projection does.
   */
  bounds: [Vec2, Vec2];
  /** The nodes' range along the view, towards the viewer (model mm): how deep the shape is. */
  depth: Vec2;
  /** The view frame the projection was made in. */
  axes: DrawingViewFrame;
  /** The B-rep edges the view keeps, for dimensions (DW3). */
  features: DrawingEdgeFeature[];
}

/** The view frame of a standard direction: into the scene, the drawing's up and right. */
export function drawingViewAxes(view: DrawingDirection): DrawingViewFrame {
  const s3 = 1 / Math.sqrt(3);
  const frames: Record<DrawingDirection, [Vec3, Vec3]> = {
    front: [
      [0, 1, 0],
      [0, 0, 1],
    ],
    rear: [
      [0, -1, 0],
      [0, 0, 1],
    ],
    top: [
      [0, 0, -1],
      [0, 1, 0],
    ],
    bottom: [
      [0, 0, 1],
      [0, -1, 0],
    ],
    right: [
      [-1, 0, 0],
      [0, 0, 1],
    ],
    left: [
      [1, 0, 0],
      [0, 0, 1],
    ],
    // From the front, right and above: the model's z stays upright on the paper.
    iso: [
      [-s3, s3, -s3],
      [0, 0, 1],
    ],
  };
  const [direction, rawUp] = frames[view];
  const z: Vec3 = [-direction[0], -direction[1], -direction[2]];
  // Up made normal to the direction, then right = up × towards-viewer.
  const k = dot(rawUp, z);
  const up = unit([rawUp[0] - k * z[0], rawUp[1] - k * z[1], rawUp[2] - k * z[2]]);
  return { direction, up, right: cross(up, z) };
}

/**
 * A section of a view seen square (DW2b): the plane through the cutting `line` (the parent's view
 * plane, model mm) square to the paper, seen along the arrows to the right of `line[0]` →
 * `line[1]`. The section keeps its parent's up unless it looks along it (a horizontal cutting
 * line); then it is seen like a plan (looking down) or a view from below, with the parent's depth
 * as its up, as the standard views are.
 */
export function drawingSectionFrame(
  parent: DrawingViewFrame,
  line: readonly [Vec2, Vec2],
): { frame: DrawingViewFrame; cut: DrawingCut } {
  const [a, b] = line;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const n2: Vec2 = [dy / l, -dx / l];
  const direction = unit([
    n2[0] * parent.right[0] + n2[1] * parent.up[0],
    n2[0] * parent.right[1] + n2[1] * parent.up[1],
    n2[0] * parent.right[2] + n2[1] * parent.up[2],
  ]);
  const along = dot(parent.up, direction);
  let up: Vec3;
  if (Math.abs(along) < 0.7) {
    up = unit([
      parent.up[0] - along * direction[0],
      parent.up[1] - along * direction[1],
      parent.up[2] - along * direction[2],
    ]);
  } else {
    const k = -Math.sign(along);
    const raw: Vec3 = [k * parent.direction[0], k * parent.direction[1], k * parent.direction[2]];
    const m = dot(raw, direction);
    up = unit([raw[0] - m * direction[0], raw[1] - m * direction[1], raw[2] - m * direction[2]]);
  }
  const z: Vec3 = [-direction[0], -direction[1], -direction[2]];
  const point: Vec3 = [
    a[0] * parent.right[0] + a[1] * parent.up[0],
    a[0] * parent.right[1] + a[1] * parent.up[1],
    a[0] * parent.right[2] + a[1] * parent.up[2],
  ];
  return { frame: { direction, up, right: cross(up, z) }, cut: { point, normal: direction } };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1] + 0,
  a[2] * b[0] - a[0] * b[2] + 0,
  a[0] * b[1] - a[1] * b[0] + 0,
];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l + 0, a[1] / l + 0, a[2] / l + 0];
};

export const drawingProjectionLimits = Object.freeze({
  triangles: 2_000_000,
  /** Samples tested for visibility in one view. */
  samples: 4_000_000,
  /** Lines (visible, hidden, centre and cut outlines) in one view. */
  lines: 200_000,
});

export class DrawingProjectionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Tri {
  // Projected corners (view x, y) and depths (towards the viewer).
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
  az: number;
  bz: number;
  cz: number;
}

export interface DrawingProjectOptions {
  step: number;
  hidden: boolean;
  centers: boolean;
  cut?: DrawingCut;
  /**
   * Only the lines over this box of the view plane are drawn (a detail view's circle): pieces
   * of lines off it are not tested for visibility.
   */
  window?: [Vec2, Vec2];
}

/**
 * Projects bodies along `direction`. `step` is the longest piece (model mm) a line is cut into for
 * the visibility test (the caller passes about 0.25 mm on paper over the view's scale).
 */
export function drawingProject(
  bodies: readonly DrawingMeshBody[],
  view: DrawingDirection | DrawingViewFrame,
  options: DrawingProjectOptions,
): DrawingProjectedView {
  const axes = typeof view === 'string' ? drawingViewAxes(view) : view;
  const cut = options.cut;
  /** Signed distance of a model point from the cut plane: negative where material is taken. */
  const side = (x: number, y: number, w: number) =>
    cut
      ? (x - cut.point[0]) * cut.normal[0] +
        (y - cut.point[1]) * cut.normal[1] +
        (w - cut.point[2]) * cut.normal[2]
      : 0;
  const z: Vec3 = [-axes.direction[0], -axes.direction[1], -axes.direction[2]];
  const to2 = (x: number, y: number, w: number): Vec3 => [
    x * axes.right[0] + y * axes.right[1] + w * axes.right[2],
    x * axes.up[0] + y * axes.up[1] + w * axes.up[2],
    x * z[0] + y * z[1] + w * z[2],
  ];

  // Every triangle, projected; the box of every node.
  const tris: Tri[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let count = 0;
  for (const b of bodies) count += b.indices.length / 3;
  if (count > drawingProjectionLimits.triangles)
    throw new DrawingProjectionError('limit-triangles');
  /** Per body, the segments where the plane cuts its triangles, with the triangle's face. */
  /** Each end is on a mesh edge (its two nodes) or at a node (twice the same node). */
  const cutSegs: { face: number; seg: Vec3[]; ends: [number, number][] }[][] = bodies.map(() => []);
  const sides: Float64Array[] = [];
  const projected = bodies.map((b, bi) => {
    const n = b.positions.length / 3;
    const p = new Float64Array(n * 3);
    const sd = new Float64Array(n);
    sides.push(sd);
    for (let i = 0; i < n; i++) {
      sd[i] = side(b.positions[3 * i]!, b.positions[3 * i + 1]!, b.positions[3 * i + 2]!);
      const q = to2(b.positions[3 * i]!, b.positions[3 * i + 1]!, b.positions[3 * i + 2]!);
      p[3 * i] = q[0];
      p[3 * i + 1] = q[1];
      p[3 * i + 2] = q[2];
      if (q[0] < minX) minX = q[0];
      if (q[0] > maxX) maxX = q[0];
      if (q[1] < minY) minY = q[1];
      if (q[1] > maxY) maxY = q[1];
      if (q[2] < minZ) minZ = q[2];
      if (q[2] > maxZ) maxZ = q[2];
    }
    const at = (i: number): Vec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
    const push = (a: Vec3, b2: Vec3, c: Vec3) =>
      tris.push({
        ax: a[0],
        ay: a[1],
        az: a[2],
        bx: b2[0],
        by: b2[1],
        bz: b2[2],
        cx: c[0],
        cy: c[1],
        cz: c[2],
      });
    for (let t = 0; t + 2 < b.indices.length; t += 3) {
      const ids = [b.indices[t]!, b.indices[t + 1]!, b.indices[t + 2]!];
      const neg = ids.filter((i) => sd[i]! < 0).length;
      if (neg === 0) {
        push(at(ids[0]!), at(ids[1]!), at(ids[2]!));
        continue;
      }
      if (neg === 3) continue;
      // Cut by the plane: keep the polygon on the kept side, and the segment along the plane.
      const poly: Vec3[] = [];
      const cross2: Vec3[] = [];
      const ends: [number, number][] = [];
      for (let s = 0; s < 3; s++) {
        const u = ids[s]!;
        const v = ids[(s + 1) % 3]!;
        if (sd[u]! >= 0) poly.push(at(u));
        if (sd[u]! < 0 !== sd[v]! < 0) {
          const k = sd[u]! / (sd[u]! - sd[v]!);
          const pu = at(u);
          const pv = at(v);
          const q: Vec3 = [
            pu[0] + (pv[0] - pu[0]) * k,
            pu[1] + (pv[1] - pu[1]) * k,
            pu[2] + (pv[2] - pu[2]) * k,
          ];
          poly.push(q);
          cross2.push(q);
          // A crossing at a node (on the plane) is that node's; else the mesh edge's.
          ends.push(sd[v]! === 0 ? [v, v] : sd[u]! === 0 ? [u, u] : u < v ? [u, v] : [v, u]);
        }
      }
      for (let k = 1; k + 1 < poly.length; k++) push(poly[0]!, poly[k]!, poly[k + 1]!);
      if (cross2.length === 2) cutSegs[bi]!.push({ face: b.faces[t / 3]!, seg: cross2, ends });
    }
    return p;
  });
  if (!Number.isFinite(minX))
    return {
      lines: [],
      centers: [],
      cuts: [],
      bounds: [
        [0, 0],
        [0, 0],
      ],
      depth: [0, 0],
      axes,
      features: [],
    };
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const eps = Math.max(1e-4 * size, 0.005);

  // A section's cut faces: loops per body (filled even–odd), and in front of everything kept.
  const cuts: DrawingCutRegion[] = [];
  const cutDepth = cut ? to2(...cut.point)[2] : Infinity;
  const capBands: { y0: number; h: number; bands: number[][]; segs: number[] }[] = [];
  // Cut points join by the mesh's topology (the edge or node they lie on, nodes welded only
  // within float roundoff), never by a model-wide distance that would merge a thin wall's two
  // sides (Codex on #1207).
  const cutWeld = Math.min(eps / 16, Math.max(size * 2e-7, 1e-4));
  const cutKeys = bodies.map((b, bi) => {
    const node = (i: number) =>
      `${Math.round(b.positions[3 * i]! / cutWeld)},${Math.round(b.positions[3 * i + 1]! / cutWeld)},${Math.round(b.positions[3 * i + 2]! / cutWeld)}`;
    return cutSegs[bi]!.map(
      (c) =>
        c.ends.map(([u, v]) => {
          const a = node(u);
          const z = node(v);
          return a === z ? a : a < z ? `${a}|${z}` : `${z}|${a}`;
        }) as [string, string],
    );
  });
  bodies.forEach((b, bi) => {
    const list = cutSegs[bi]!;
    if (!list.length || b.sheet) return;
    const loops = chains(
      list.map((c) => c.seg),
      eps,
      cutKeys[bi],
    ).map((l) => l.map((q): Vec2 => [q[0], q[1]]));
    cuts.push({ path: b.path, bodyId: b.bodyId, loops });
    // Bands of y over the loops' segments, to test a point against them quickly.
    let y0 = Infinity;
    let y1 = -Infinity;
    const segs: number[] = [];
    for (const l of loops)
      for (let k = 0; k < l.length; k++) {
        const a = l[k]!;
        const c = l[(k + 1) % l.length]!;
        segs.push(a[0], a[1], c[0], c[1]);
        y0 = Math.min(y0, a[1]);
        y1 = Math.max(y1, a[1]);
      }
    const count = Math.max(1, Math.min(512, Math.ceil(segs.length / 16)));
    const h = (y1 - y0) / count || 1;
    const bands: number[][] = Array.from({ length: count }, () => []);
    for (let i = 0; i < segs.length; i += 4) {
      const lo = Math.floor((Math.min(segs[i + 1]!, segs[i + 3]!) - y0) / h);
      const hi = Math.floor((Math.max(segs[i + 1]!, segs[i + 3]!) - y0) / h);
      for (let j = Math.max(0, lo); j <= Math.min(count - 1, hi); j++) bands[j]!.push(i);
    }
    capBands.push({ y0, h, bands, segs });
  });
  /** Whether (x, y) lies on the material a section cuts (inside a body's loops, even–odd). */
  const onCap = (x: number, y: number) =>
    capBands.some(({ y0, h, bands, segs }) => {
      const band = bands[Math.floor((y - y0) / h)];
      if (!band) return false;
      let inside = false;
      for (const i of band) {
        const ay = segs[i + 1]!;
        const by = segs[i + 3]!;
        if (ay > y === by > y) continue;
        const ax = segs[i]!;
        const bx = segs[i + 2]!;
        if (ax + ((y - ay) * (bx - ax)) / (by - ay) > x) inside = !inside;
      }
      return inside;
    });

  // A uniform grid of triangle boxes over the view, about 4 triangles per cell.
  const cells = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(tris.length / 4))));
  const cw = (maxX - minX) / cells || 1;
  const ch = (maxY - minY) / cells || 1;
  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  const cell = (x: number, y: number) =>
    Math.min(cells - 1, Math.max(0, Math.floor((x - minX) / cw))) +
    cells * Math.min(cells - 1, Math.max(0, Math.floor((y - minY) / ch)));
  tris.forEach((t, i) => {
    const x0 = Math.min(t.ax, t.bx, t.cx);
    const x1 = Math.max(t.ax, t.bx, t.cx);
    const y0 = Math.min(t.ay, t.by, t.cy);
    const y1 = Math.max(t.ay, t.by, t.cy);
    // Seen edge-on: it hides nothing.
    const area = (t.bx - t.ax) * (t.cy - t.ay) - (t.cx - t.ax) * (t.by - t.ay);
    if (Math.abs(area) < 1e-12 * size * size) return;
    const c0 = cell(x0, y0);
    const c1 = cell(x1, y1);
    const i0 = c0 % cells;
    const j0 = Math.floor(c0 / cells);
    const i1 = c1 % cells;
    const j1 = Math.floor(c1 / cells);
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) grid[k + cells * j]!.push(i);
  });

  let samples = 0;
  /** True when a triangle lies in front of the point (x, y) at depth w. */
  const occluded = (x: number, y: number, w: number) => {
    if (++samples > drawingProjectionLimits.samples)
      throw new DrawingProjectionError('limit-samples');
    if (w < cutDepth - eps && onCap(x, y)) return true;
    for (const i of grid[cell(x, y)]!) {
      const t = tris[i]!;
      const d = (t.by - t.cy) * (t.ax - t.cx) + (t.cx - t.bx) * (t.ay - t.cy);
      const l1 = ((t.by - t.cy) * (x - t.cx) + (t.cx - t.bx) * (y - t.cy)) / d;
      const l2 = ((t.cy - t.ay) * (x - t.cx) + (t.ax - t.cx) * (y - t.cy)) / d;
      const l3 = 1 - l1 - l2;
      const e = -1e-9;
      if (l1 < e || l2 < e || l3 < e) continue;
      const depth = l1 * t.az + l2 * t.bz + l3 * t.cz;
      if (depth > w + eps) return true;
    }
    return false;
  };

  const lines: DrawingProjectedLine[] = [];
  /** Cuts a 3D polyline (view coordinates) into visible and hidden runs. */
  const emit = (pts: Vec3[], anchor: DrawingAnchor) => {
    let run: Vec2[] = [];
    let state: boolean | undefined;
    const flush = () => {
      if (run.length >= 2 && state !== undefined && (!state || options.hidden))
        lines.push({ points: run, hidden: state, anchor });
      run = [];
    };
    for (let s = 0; s + 1 < pts.length; s++) {
      let a = pts[s]!;
      let b = pts[s + 1]!;
      // Seen end-on: nothing to draw of this piece.
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      // A window (a detail): only the part over it is tested and drawn (Codex on #1207).
      const win = options.window;
      let tail = false;
      if (win) {
        const r = clipToBox(a, b, win);
        if (!r) {
          flush();
          state = undefined;
          continue;
        }
        if (r[0] > 0) {
          flush();
          state = undefined;
        }
        tail = r[1] < 1;
        const at = (t: number): Vec3 => [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        [a, b] = [at(r[0]), at(r[1])];
      }
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const pieces = Math.max(1, Math.ceil(len / options.step));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const tm = (t0 + t1) / 2;
        const hid = occluded(
          a[0] + (b[0] - a[0]) * tm,
          a[1] + (b[1] - a[1]) * tm,
          a[2] + (b[2] - a[2]) * tm,
        );
        if (hid === state) continue;
        // The visibility changes at this piece's start: the run so far ends there.
        const p0: Vec2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
        if (run.length) run.push(p0);
        flush();
        state = hid;
        run.push(p0);
      }
      // Only the polyline's own points (and where visibility changes) are kept, so a dashed
      // line's pattern runs along the whole line.
      run.push([b[0], b[1]]);
      if (tail) {
        flush();
        state = undefined;
      }
    }
    flush();
  };

  const centers: DrawingProjectedLine[] = [];
  const features: DrawingEdgeFeature[] = [];
  bodies.forEach((b, bi) => {
    const p = projected[bi]!;
    const base = { path: b.path, bodyId: b.bodyId };
    // The cut faces' outlines, per face cut: on the plane, in front of all that is kept.
    const byFace = new Map<number, { segs: Vec3[][]; keys: [string, string][] }>();
    cutSegs[bi]!.forEach((c, i) => {
      const f = byFace.get(c.face) ?? { segs: [], keys: [] };
      f.segs.push(c.seg);
      f.keys.push(cutKeys[bi]![i]!);
      byFace.set(c.face, f);
    });
    for (const [face, { segs: list, keys }] of byFace)
      for (const chain of chains(list, eps, keys))
        lines.push({
          points: chain.map((q): Vec2 => [q[0], q[1]]),
          hidden: false,
          anchor: { kind: 'section', ...base, face },
        });
    // B-rep edges. An edge seen end-on (a point) draws nothing.
    const circles: { edge: number; c: Vec3; n: Vec3; r: number }[] = [];
    for (const e of b.edges) {
      const model: Vec3[] = [];
      for (let i = 0; i + 2 < e.points.length; i += 3)
        model.push([e.points[i]!, e.points[i + 1]!, e.points[i + 2]!]);
      if (model.length < 2) continue;
      const runs = kept3(model, side);
      const anchor = { kind: 'edge' as const, ...base, edge: e.index };
      for (const run of runs)
        emit(
          run.map((q) => to2(...q)),
          anchor,
        );
      const c = circleOf(e.points);
      if (runs.length) {
        const start = runs[0]![0]!;
        const end = runs[runs.length - 1]!.at(-1)!;
        const straight = isStraight(model, eps);
        features.push({
          anchor,
          start,
          end,
          straight,
          ...(e.name !== undefined ? { name: e.name } : {}),
          // A circle or arc keeps what the view keeps of it: picks go on that alone. Any other
          // curve keeps it too, so a point on it resolves on the curve, not on the chord between
          // its ends (a closed ellipse's ends meet; Codex on #1278).
          ...(c ? { circle: c, runs } : straight ? {} : { runs }),
        });
      }
      // A section keeps the centre lines of the circles it keeps.
      if (options.centers && c && side(...c.c) >= -eps) circles.push({ edge: e.index, ...c });
    }
    // Silhouettes: mesh edges inside one face whose two triangles face opposite ways.
    const shared = new Map<string, number>();
    /**
     * Which way a triangle faces the viewer: the sign of its normal along the view, 0 when it is
     * seen edge-on (a strip of a curved face lying along the view).
     */
    const facing = (t: number) => {
      const i = b.indices[3 * t]! * 3;
      const j = b.indices[3 * t + 1]! * 3;
      const k = b.indices[3 * t + 2]! * 3;
      const ux = p[j]! - p[i]!;
      const uy = p[j + 1]! - p[i + 1]!;
      const uz = p[j + 2]! - p[i + 2]!;
      const vx = p[k]! - p[i]!;
      const vy = p[k + 1]! - p[i + 1]!;
      const vz = p[k + 2]! - p[i + 2]!;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
      return Math.abs(nz) > 1e-9 * len ? Math.sign(nz) : 0;
    };
    // Nodes within a hair of each other are one node: a periodic face's seam may repeat its
    // nodes with roundoff (Float32), and the two triangles beside it must still meet.
    const weld = eps / 16;
    const nodeKey = (i: number) =>
      `${Math.round(b.positions[3 * i]! / weld)},${Math.round(b.positions[3 * i + 1]! / weld)},${Math.round(b.positions[3 * i + 2]! / weld)}`;
    const segs = new Map<number, Vec3[][]>();
    for (let t = 0; 3 * t + 2 < b.indices.length; t++) {
      const f = b.faces[t]!;
      if (f < 0) continue;
      for (let s = 0; s < 3; s++) {
        const u = b.indices[3 * t + s]!;
        const v = b.indices[3 * t + ((s + 1) % 3)]!;
        const ku = nodeKey(u);
        const kv = nodeKey(v);
        const key = `${f}|${ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`}`;
        const other = shared.get(key);
        if (other === undefined) {
          shared.set(key, t);
          continue;
        }
        shared.delete(key);
        // The outline runs where the faces turn from the viewer to away; an edge-on strip
        // between them has the outline on both of its sides (seen as one line: the far one is
        // hidden under the near one and left out), so it never breaks the outline (Codex on #1203).
        const ft = facing(t);
        const fo = facing(other);
        if (ft * fo >= 0 && (ft === 0) === (fo === 0)) continue;
        // A section keeps the part of the outline on the kept side.
        const su = sides[bi]![u]!;
        const sv = sides[bi]![v]!;
        if (su < 0 && sv < 0) continue;
        let pu: Vec3 = [p[3 * u]!, p[3 * u + 1]!, p[3 * u + 2]!];
        let pv: Vec3 = [p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!];
        if (su < 0 || sv < 0) {
          const k = su / (su - sv);
          const q: Vec3 = [
            pu[0] + (pv[0] - pu[0]) * k,
            pu[1] + (pv[1] - pu[1]) * k,
            pu[2] + (pv[2] - pu[2]) * k,
          ];
          if (su < 0) pu = q;
          else pv = q;
        }
        const list = segs.get(f) ?? [];
        list.push([pu, pv]);
        segs.set(f, list);
      }
    }
    for (const [face, list] of segs)
      for (const chain of chains(list, eps)) emit(chain, { kind: 'silhouette', ...base, face });

    if (!options.centers) return;
    // Centre lines: a cross on each circle seen face-on; an axis through coaxial circles seen
    // side-on, over their whole length.
    const ext = 0.12;
    const done = new Set<number>();
    circles.forEach((c, i) => {
      const along = Math.abs(dot(c.n, z));
      const q = to2(...c.c);
      const anchor: DrawingAnchor = { kind: 'axis', ...base, edge: c.edge };
      if (along > 0.999) {
        const r = c.r * (1 + ext) + 1;
        centers.push({
          points: [
            [q[0] - r, q[1]],
            [q[0] + r, q[1]],
          ],
          hidden: false,
          anchor,
        });
        centers.push({
          points: [
            [q[0], q[1] - r],
            [q[0], q[1] + r],
          ],
          hidden: false,
          anchor,
        });
        return;
      }
      if (along > 1e-3 || done.has(i)) return;
      // Coaxial circles: centres on the same line along the normal.
      const group = circles.filter((o, j) => {
        if (Math.abs(Math.abs(dot(o.n, c.n)) - 1) > 1e-6) return false;
        const d: Vec3 = [o.c[0] - c.c[0], o.c[1] - c.c[1], o.c[2] - c.c[2]];
        const k = dot(d, c.n);
        const off = Math.hypot(d[0] - k * c.n[0], d[1] - k * c.n[1], d[2] - k * c.n[2]);
        if (off > eps) return false;
        done.add(j);
        return true;
      });
      const ks = group.map((o) => dot([o.c[0] - c.c[0], o.c[1] - c.c[1], o.c[2] - c.c[2]], c.n));
      const lo = Math.min(...ks);
      const hi = Math.max(...ks);
      if (hi - lo < eps) return;
      const r = Math.max(...group.map((o) => o.r));
      const pad = r * ext + 1;
      const a = to2(
        c.c[0] + (lo - pad) * c.n[0],
        c.c[1] + (lo - pad) * c.n[1],
        c.c[2] + (lo - pad) * c.n[2],
      );
      const e = to2(
        c.c[0] + (hi + pad) * c.n[0],
        c.c[1] + (hi + pad) * c.n[1],
        c.c[2] + (hi + pad) * c.n[2],
      );
      centers.push({
        points: [
          [a[0], a[1]],
          [e[0], e[1]],
        ],
        hidden: false,
        anchor,
      });
    });
  });
  // JIS B 0001: where lines coincide, the visible line is drawn, then the hidden line, then the
  // centre line; a coinciding line of lower priority (or the same line twice) is left out.
  // At most 0.5 mm on paper: a detail of a large shape keeps its short lines (Codex on #1207).
  const tol = Math.min(Math.max(options.step * 0.4, eps), options.step * 2);
  const kept = new Coverage(tol, minX, minY, maxX, maxY);
  const out: DrawingProjectedLine[] = [];
  // A section's cut outlines come first among the visible lines: an edge on one is left out.
  const passes = [
    (l: DrawingProjectedLine) => l.anchor.kind === 'section',
    (l: DrawingProjectedLine) => !l.hidden && l.anchor.kind !== 'section',
    (l: DrawingProjectedLine) => l.hidden,
  ];
  for (const pass of passes)
    for (const l of lines) {
      if (!pass(l)) continue;
      for (const run of kept.uncovered(l.points, options.step)) out.push({ ...l, points: run });
      kept.add(l.points);
    }
  const centerOut: DrawingProjectedLine[] = [];
  for (const l of centers) {
    for (const run of kept.uncovered(l.points, options.step)) centerOut.push({ ...l, points: run });
    kept.add(l.points);
  }
  if (out.length + centerOut.length > drawingProjectionLimits.lines)
    throw new DrawingProjectionError('limit-lines');
  return {
    lines: out,
    centers: centerOut,
    cuts,
    bounds: [
      [minX, minY],
      [maxX, maxY],
    ],
    depth: [minZ, maxZ],
    axes,
    features,
  };
}

/** The 2D segments of the lines drawn so far, in a grid, to find where a new line lies on them. */
class Coverage {
  private readonly cells = new Map<string, number[]>();
  private readonly segs: number[] = [];
  private readonly size: number;
  constructor(
    private readonly tol: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    this.size = Math.max((x1 - x0) / 256, (y1 - y0) / 256, tol * 4);
  }
  private key(i: number, j: number) {
    return `${i},${j}`;
  }
  add(points: Vec2[]) {
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k]!;
      const [bx, by] = points[k + 1]!;
      const id = this.segs.length / 4;
      this.segs.push(ax, ay, bx, by);
      const i0 = Math.floor((Math.min(ax, bx) - this.tol) / this.size);
      const i1 = Math.floor((Math.max(ax, bx) + this.tol) / this.size);
      const j0 = Math.floor((Math.min(ay, by) - this.tol) / this.size);
      const j1 = Math.floor((Math.max(ay, by) + this.tol) / this.size);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const c = this.key(i, j);
          const list = this.cells.get(c);
          if (list) list.push(id);
          else this.cells.set(c, [id]);
        }
    }
  }
  /** Whether a segment drawn so far runs along (ux, uy) through (x, y): a crossing is not. */
  private covered(x: number, y: number, ux: number, uy: number) {
    const list = this.cells.get(this.key(Math.floor(x / this.size), Math.floor(y / this.size)));
    if (!list) return false;
    for (const id of list) {
      const ax = this.segs[4 * id]!;
      const ay = this.segs[4 * id + 1]!;
      const dx = this.segs[4 * id + 2]! - ax;
      const dy = this.segs[4 * id + 3]! - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 > 0 && Math.abs(ux * dy - uy * dx) > 0.05 * Math.sqrt(l2)) continue;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= this.tol) return true;
    }
    return false;
  }
  /** The runs of a polyline that no line drawn so far covers (sampled every `step`). */
  uncovered(points: Vec2[], step: number): Vec2[][] {
    const out: Vec2[][] = [];
    let run: Vec2[] = [];
    let free: boolean | undefined;
    const flush = () => {
      if (free && run.length >= 2) {
        let len = 0;
        for (let k = 0; k + 1 < run.length; k++)
          len += Math.hypot(run[k + 1]![0] - run[k]![0], run[k + 1]![1] - run[k]![1]);
        if (len > this.tol * 2) out.push(run);
      }
      run = [];
    };
    for (let s = 0; s + 1 < points.length; s++) {
      const a = points[s]!;
      const b = points[s + 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-12) continue;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      const pieces = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < pieces; k++) {
        const tm = (k + 0.5) / pieces;
        const f = !this.covered(a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm, ux, uy);
        if (f === free) continue;
        const t0 = k / pieces;
        const p0: Vec2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
        if (run.length) run.push(p0);
        flush();
        free = f;
        run.push(p0);
      }
      run.push([b[0], b[1]]);
    }
    flush();
    return out;
  }
}

/** Whether every point of a polyline lies within `eps` of the line through its ends. */
function isStraight(points: Vec3[], eps: number): boolean {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  if (l < eps) return false;
  return points.every((p) => {
    const q: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    return Math.hypot(...cross(q, d)) / l <= eps;
  });
}

/** The part [t0, t1] of a segment over a box of the view plane (Liang–Barsky), or none. */
function clipToBox(a: Vec3, b: Vec3, box: [Vec2, Vec2]): [number, number] | undefined {
  let t0 = 0;
  let t1 = 1;
  for (const k of [0, 1] as const) {
    const d = b[k] - a[k];
    for (const [p, q] of [
      [-d, a[k] - box[0][k]],
      [d, box[1][k] - a[k]],
    ] as const) {
      if (Math.abs(p) < 1e-15) {
        if (q < 0) return undefined;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 < t1 ? [t0, t1] : undefined;
}

/** The runs of a model polyline on the kept side of a cut (all of it without one). */
function kept3(points: Vec3[], side: (x: number, y: number, w: number) => number): Vec3[][] {
  const out: Vec3[][] = [];
  let run: Vec3[] = [];
  let prev = side(...points[0]!);
  if (prev >= 0) run.push(points[0]!);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const s = side(...b);
    if (prev < 0 !== s < 0) {
      const k = prev / (prev - s);
      const q: Vec3 = [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
      ];
      run.push(q);
      if (s < 0) {
        out.push(run);
        run = [];
      }
    }
    if (s >= 0) run.push(b);
    prev = s;
  }
  out.push(run);
  return out.filter((r) => r.length >= 2);
}

/**
 * Joins two-point segments into polylines where their ends meet: ends with the same key (given,
 * or the point rounded to `eps`).
 */
function chains(segs: Vec3[][], eps: number, given?: [string, string][]): Vec3[][] {
  const keyAt = new Map<Vec3, string>();
  const key = (p: Vec3) =>
    keyAt.get(p) ?? `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)},${Math.round(p[2] / eps)}`;
  if (given)
    segs.forEach((s, i) => {
      keyAt.set(s[0]!, given[i]![0]);
      keyAt.set(s[1]!, given[i]![1]);
    });
  const ends = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of [s[0]!, s[1]!]) {
      const k = key(p);
      ends.set(k, [...(ends.get(k) ?? []), i]);
    }
  });
  const used = new Set<number>();
  const out: Vec3[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const line = [...segs[i]!];
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? line[line.length - 1]! : line[0]!;
        const next = (ends.get(key(end)) ?? []).find((j) => !used.has(j));
        if (next === undefined) break;
        used.add(next);
        const [a, b] = segs[next]!;
        const far = key(a!) === key(end) ? b! : a!;
        if (forward) line.push(far);
        else line.unshift(far);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * The circle an edge polyline lies on (a full circle or an arc of at least 90°), or none: its
 * centre, unit normal and radius, when every point is within 0.1% of the radius.
 */
export function circleOf(points: ArrayLike<number>): { c: Vec3; n: Vec3; r: number } | undefined {
  const n = points.length / 3;
  if (n < 5) return undefined;
  const at = (i: number): Vec3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
  const a = at(0);
  const b = at(Math.floor(n / 3));
  const c = at(Math.floor((2 * n) / 3));
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nn = cross(ab, ac);
  const l2 = dot(nn, nn);
  if (l2 < 1e-18) return undefined;
  // Circumcentre of a, b, c.
  const t1 = cross(nn, ab);
  const t2 = cross(ac, nn);
  const k1 = dot(ac, ac) / (2 * l2);
  const k2 = dot(ab, ab) / (2 * l2);
  const centre: Vec3 = [
    a[0] + t1[0] * k1 + t2[0] * k2,
    a[1] + t1[1] * k1 + t2[1] * k2,
    a[2] + t1[2] * k1 + t2[2] * k2,
  ];
  const r = Math.hypot(a[0] - centre[0], a[1] - centre[1], a[2] - centre[2]);
  const normal = unit(nn);
  for (let i = 0; i < n; i++) {
    const p = at(i);
    const d: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    if (Math.abs(Math.hypot(...d) - r) > 1e-3 * r + 1e-6) return undefined;
    if (Math.abs(dot(d, normal)) > 1e-3 * r + 1e-6) return undefined;
  }
  // At least a quarter turn: the first and last points make an angle of 90° or more at the centre,
  // or the polyline closes.
  const first: Vec3 = [a[0] - centre[0], a[1] - centre[1], a[2] - centre[2]];
  const lp = at(n - 1);
  const last: Vec3 = [lp[0] - centre[0], lp[1] - centre[1], lp[2] - centre[2]];
  const closed = Math.hypot(lp[0] - a[0], lp[1] - a[1], lp[2] - a[2]) < 1e-6 * (r + 1);
  if (!closed && dot(first, last) > 0 && n < 8) return undefined;
  return { c: centre, n: normal, r };
}
