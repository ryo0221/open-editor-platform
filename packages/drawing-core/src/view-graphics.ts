import {
  drawingIsBuildingView,
  drawingScaleFactor,
  type DrawingCadView,
  type DrawingDocument,
  type DrawingView,
  type Vec2,
} from './model';
import {
  drawingSectionFrame,
  drawingViewAxes,
  type DrawingAnchor,
  type DrawingCut,
  type DrawingProjectedView,
  type DrawingViewFrame,
} from './project';
import type { DrawingItem } from './sheet';
import type { DrawingViewGraphics } from './svg';

/** A projected line on the paper with its anchor: what a dimension snaps to (DW3). */
export interface DrawingPaperLine {
  points: Vec2[];
  hidden: boolean;
  center: boolean;
  anchor: DrawingAnchor;
}
export interface DrawingCadViewResult extends DrawingViewGraphics {
  lines: DrawingPaperLine[];
}

/**
 * What a CAD view projects (DW2, DW2b): the source and bodies, the view frame, a section's cut,
 * a detail's circle of its parent's plane. A section or detail takes its parent's source and
 * bodies; a detail its parent's frame and cut too.
 */
export interface DrawingViewSpec {
  sourceId: string;
  only: string[];
  frame: DrawingViewFrame;
  cut?: DrawingCut;
  hidden: boolean;
  centers: boolean;
  clip?: { center: Vec2; radius: number };
}
export function drawingViewSpec(
  doc: DrawingDocument,
  view: DrawingView,
): DrawingViewSpec | { code: string } {
  if (view.kind === 'cad-projection')
    return {
      sourceId: view.sourceId,
      only: view.only,
      frame: drawingViewAxes(view.direction),
      hidden: view.hiddenLines,
      centers: view.centerLines,
    };
  // A building's view is drawn by the Host from the building version, not projected (DW5a).
  if (drawingIsBuildingView(view)) return { code: 'view-kind' };
  const parent = doc.views.find((v) => v.id === view.parentId);
  if (!parent) return { code: 'view-parent' };
  if (view.kind === 'cad-section') {
    if (parent.kind !== 'cad-projection') return { code: 'view-parent-kind' };
    const { frame, cut } = drawingSectionFrame(drawingViewAxes(parent.direction), view.line);
    return {
      sourceId: view.sourceId,
      only: parent.only,
      frame,
      cut,
      hidden: view.hiddenLines,
      centers: view.centerLines,
    };
  }
  if (parent.kind === 'cad-detail' || drawingIsBuildingView(parent))
    return { code: 'view-parent-kind' };
  const base = drawingViewSpec(doc, parent);
  if ('code' in base) return base;
  return { ...base, clip: { center: view.center, radius: view.radius } };
}

/** Hatching (JIS B 0001 ハッチング): thin lines; neighbouring bodies turn or space theirs apart. */
const hatchPatterns: { angle: number; spacing: number }[] = [
  { angle: 45, spacing: 2.5 },
  { angle: 135, spacing: 2.5 },
  { angle: 45, spacing: 1.5 },
  { angle: 135, spacing: 1.5 },
  { angle: 30, spacing: 2.5 },
  { angle: 60, spacing: 2.5 },
];

/**
 * DW2: a CAD view's projection placed on the paper. A projection's or section's `at` is the centre
 * of the projected box of the whole shape (hidden parts and a section's removed part included), so
 * views of one shape at one scale line up as third-angle projection wants when their `at` share x
 * (front over top) or y (front beside a side view). A detail's `at` is its circle's centre; only
 * what lies in the circle is drawn.
 */
export function drawingCadViewGraphics(
  view: Pick<DrawingCadView, 'at' | 'scale'> & { hiddenLines?: boolean; centerLines?: boolean },
  projection: DrawingProjectedView,
  clip?: { center: Vec2; radius: number },
): DrawingCadViewResult {
  const k = drawingScaleFactor(view.scale);
  const [[x0, y0], [x1, y1]] = projection.bounds;
  const center: Vec2 = clip ? clip.center : [(x0 + x1) / 2, (y0 + y1) / 2];
  const [cx, cy] = center;
  const paper = (p: Vec2): Vec2 => [view.at[0] + (p[0] - cx) * k, view.at[1] + (p[1] - cy) * k];
  const circle = clip ? { c: view.at, r: clip.radius * k } : undefined;
  const cut = (pts: Vec2[]) => (circle ? clipToCircle(pts, circle.c, circle.r) : [pts]);
  const lines: DrawingPaperLine[] = [];
  for (const l of projection.lines)
    if (!l.hidden || view.hiddenLines !== false)
      for (const points of cut(l.points.map(paper)))
        lines.push({ points, hidden: l.hidden, center: false, anchor: l.anchor });
  if (view.centerLines !== false)
    for (const l of projection.centers)
      for (const points of cut(l.points.map(paper)))
        lines.push({ points, hidden: false, center: true, anchor: l.anchor });
  const edgeKey = (a: { path: string[]; bodyId: string; edge?: number }) =>
    `${a.path.join('/')}|${a.bodyId}|${a.edge}`;
  const drawn = new Set<string>();
  for (const l of lines)
    if (!l.center && l.anchor.kind === 'edge' && l.points.length >= 2) drawn.add(edgeKey(l.anchor));
  const items: DrawingItem[] = [];
  // Hatching first, under the outlines.
  projection.cuts.forEach((region, i) => {
    const pattern = hatchPatterns[i % hatchPatterns.length]!;
    const loops = region.loops.map((l) => l.map(paper));
    // A detail sweeps its circle only (Codex on #1207).
    const segs = hatch(loops, pattern.angle, pattern.spacing, circle);
    const points: number[] = [];
    for (const [a, b] of segs)
      for (const piece of cut([a, b]))
        if (piece.length >= 2) points.push(...piece[0]!, ...piece[piece.length - 1]!);
    if (points.length) items.push({ type: 'segments', points, cls: 'hatch' });
  });
  // One polyline per line (a dashed line's pattern runs along it); visible lines last so they
  // draw on top.
  for (const pick of [
    (l: DrawingPaperLine) => l.center,
    (l: DrawingPaperLine) => !l.center && l.hidden,
    (l: DrawingPaperLine) => !l.center && !l.hidden,
  ])
    for (const l of lines)
      if (pick(l))
        items.push({
          type: 'polyline',
          points: l.points,
          closed: false,
          cls: l.center ? 'center' : l.hidden ? 'hidden' : 'thick',
        });
  let bx0: number;
  let bx1: number;
  let by0: number;
  let by1: number;
  if (circle) {
    // The detail's boundary (a thin circle), and its extent.
    items.push({ type: 'circle', center: circle.c, radius: circle.r, cls: 'thin' });
    bx0 = circle.c[0] - circle.r;
    bx1 = circle.c[0] + circle.r;
    by0 = circle.c[1] - circle.r;
    by1 = circle.c[1] + circle.r;
  } else {
    bx0 = view.at[0] - ((x1 - x0) / 2) * k;
    bx1 = view.at[0] + ((x1 - x0) / 2) * k;
    by0 = view.at[1] - ((y1 - y0) / 2) * k;
    by1 = view.at[1] + ((y1 - y0) / 2) * k;
    for (const l of lines)
      for (const p of l.points) {
        bx0 = Math.min(bx0, p[0]);
        bx1 = Math.max(bx1, p[0]);
        by0 = Math.min(by0, p[1]);
        by1 = Math.max(by1, p[1]);
      }
  }
  return {
    items,
    lines,
    bounds: [
      [bx0, by0],
      [bx1, by1],
    ],
    frame: {
      center,
      origin: view.at,
      scale: k,
      box: projection.bounds,
      depth: projection.depth,
      axes: projection.axes,
      ...(circle ? { clipRadius: circle.r } : {}),
    },
    // Every kept edge still resolves a dimension; only the edges the view draws can be picked
    // (a detail leaves out what is outside its circle; Codex on #1211).
    features: projection.features.map((f) =>
      drawn.has(edgeKey(f.anchor)) ? f : { ...f, pickable: false },
    ),
  };
}

/**
 * Hatch lines over loops (paper mm), filled even–odd: parallel lines at `angle` degrees,
 * `spacing` mm apart, on a grid fixed to the paper so neighbouring regions' lines meet.
 */
export function hatch(
  loops: Vec2[][],
  angle: number,
  spacing: number,
  /** Only the lines over this circle are swept (they still run to the loops' edges). */
  within?: { c: Vec2; r: number },
): [Vec2, Vec2][] {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Rotated so the hatch lines run along x'.
  const rot = loops.map((l) => l.map(([x, y]): Vec2 => [x * c + y * s, -x * s + y * c]));
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of rot)
    for (const p of l) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
  if (within) {
    const cy = -within.c[0] * s + within.c[1] * c;
    lo = Math.max(lo, cy - within.r);
    hi = Math.min(hi, cy + within.r);
  }
  const out: [Vec2, Vec2][] = [];
  if (!(hi > lo)) return out;
  if ((hi - lo) / spacing > 20_000) return out;
  for (let k = Math.ceil(lo / spacing); k * spacing <= hi; k++) {
    const y = k * spacing;
    const xs: number[] = [];
    for (const l of rot)
      for (let i = 0; i < l.length; i++) {
        const a = l[i]!;
        const b = l[(i + 1) % l.length]!;
        if (a[1] > y === b[1] > y) continue;
        xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = xs[i]!;
      const xb = xs[i + 1]!;
      if (xb - xa < 1e-6) continue;
      out.push([
        [xa * c - y * s, xa * s + y * c],
        [xb * c - y * s, xb * s + y * c],
      ]);
    }
  }
  return out;
}

/** The runs of a polyline inside a circle. */
export function clipToCircle(points: Vec2[], c: Vec2, r: number): Vec2[][] {
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  const inside = (p: Vec2) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const fx = a[0] - c[0];
    const fy = a[1] - c[1];
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-18 || disc <= 0) {
      if (A < 1e-18 && inside(a) && run.length === 0) run.push(a);
      if (run.length >= 2) out.push(run);
      run = [];
      continue;
    }
    const q = Math.sqrt(disc);
    const t0 = Math.max(0, (-B - q) / (2 * A));
    const t1 = Math.min(1, (-B + q) / (2 * A));
    if (t0 >= t1) {
      if (run.length >= 2) out.push(run);
      run = [];
      continue;
    }
    const p0: Vec2 = [a[0] + dx * t0, a[1] + dy * t0];
    const p1: Vec2 = [a[0] + dx * t1, a[1] + dy * t1];
    if (t0 > 0 || !run.length) {
      if (run.length >= 2) out.push(run);
      run = [p0];
    }
    run.push(p1);
    if (t1 < 1) {
      out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out;
}

/**
 * Where three views of a shape go on a sheet (third angle: top above the front, right side to
 * its right; first angle swaps them), centred in `area`, with `gap` paper mm between them. Sizes
 * are the projected boxes in model mm (front, top, right).
 */
export function drawingThreeViewLayout(
  sizes: { front: Vec2; top: Vec2; right: Vec2 },
  scale: DrawingCadView['scale'],
  area: { x: number; y: number; width: number; height: number },
  projection: 'third-angle' | 'first-angle',
  gap = 20,
): { front: Vec2; top: Vec2; right: Vec2 } {
  const k = drawingScaleFactor(scale);
  const fw = sizes.front[0] * k;
  const fh = sizes.front[1] * k;
  const th = sizes.top[1] * k;
  const rw = sizes.right[0] * k;
  const width = fw + gap + rw;
  const height = fh + gap + th;
  const left = area.x + (area.width - width) / 2;
  const bottom = area.y + (area.height - height) / 2;
  const third = projection === 'third-angle';
  const frontY = third ? bottom + fh / 2 : bottom + th + gap + fh / 2;
  const frontX = third ? left + fw / 2 : left + rw + gap + fw / 2;
  return {
    front: [frontX, frontY],
    top: [frontX, third ? frontY + fh / 2 + gap + th / 2 : frontY - fh / 2 - gap - th / 2],
    right: [third ? frontX + fw / 2 + gap + rw / 2 : frontX - fw / 2 - gap - rw / 2, frontY],
  };
}

/** The largest standard scale at which three views of these sizes fit the area. */
export function drawingFitScale(
  sizes: { front: Vec2; top: Vec2; right: Vec2 },
  area: { width: number; height: number },
  gap = 20,
): DrawingCadView['scale'] {
  const order = [
    '50:1',
    '20:1',
    '10:1',
    '5:1',
    '2:1',
    '1:1',
    '1:2',
    '1:5',
    '1:10',
    '1:20',
    '1:50',
    '1:100',
    '1:200',
    '1:500',
    '1:1000',
    '1:2000',
    '1:5000',
  ] as const;
  for (const s of order) {
    const k = drawingScaleFactor(s);
    const w = (sizes.front[0] + sizes.right[0]) * k + gap;
    const h = (sizes.front[1] + sizes.top[1]) * k + gap;
    // Room for the labels under the views.
    if (w <= area.width && h + 20 <= area.height) return s;
  }
  return '1:5000';
}

/** The size (model mm) a model box projects to in a view: right extent, up extent. */
export function drawingProjectedSize(
  box: [[number, number, number], [number, number, number]],
  direction: DrawingCadView['direction'],
): Vec2 {
  const { right, up } = drawingViewAxes(direction);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const p = [box[c & 1][0], box[(c >> 1) & 1][1], box[(c >> 2) & 1][2]];
    const x = p[0]! * right[0] + p[1]! * right[1] + p[2]! * right[2];
    const y = p[0]! * up[0] + p[1]! * up[1] + p[2]! * up[2];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return [x1 - x0, y1 - y0];
}
