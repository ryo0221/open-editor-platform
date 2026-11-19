import type {
  DrawingAnnotation,
  DrawingDimension,
  DrawingDocument,
  DrawingLeader,
  DrawingRef,
  DrawingSymbol,
  DrawingView,
  Vec2,
} from './model';
import type { DrawingEdgeFeature, Vec3 } from './project';
import type { DrawingItem } from './sheet';
import type { DrawingViewGraphics, DrawingViewState } from './svg';
import { drawingSymbolItems } from './annotation-symbols';
import { drawingBalloonItems, drawingPartRowOf, drawingPartsListGraphics } from './parts';
import { drawingPmiResolve, drawingPmiSymbol, drawingPmiText } from './pmi';

/**
 * DW3 (docs/cad/drawing-editor.md, 寸法): dimensions and leaders on the paper, measured on the
 * 3D shape a view's derived graphics carry (its kept B-rep edges and their circles). A length
 * that does not lie square to the view is drawn as its projected length and says so. A ref whose
 * edge the view no longer has is unresolved: drawn in red where it was, never dropped.
 */
/**
 * `datum-missing`: a tolerance frame names a datum letter the drawing has no datum for.
 * `ambiguous` (DW3c): a ref's edge name names several edges of a newer version.
 * `updated`, `expired` (DW3c-2b): an imported PMI item changed, or is gone or stale.
 */
export type DrawingAnnotationStatus =
  | 'ok'
  | 'pending'
  | 'unresolved'
  | 'ambiguous'
  | 'updated'
  | 'expired'
  | 'parallel'
  | 'datum-missing';

export interface DrawingAnnotationGraphics {
  items: DrawingItem[];
  status: DrawingAnnotationStatus;
  /** The value measured (mm, or degrees for an angle), when there is one. */
  value?: number;
  /** The value is a projected length or angle, not the true one. */
  projected?: boolean;
  bounds?: [Vec2, Vec2];
}

type Frame = NonNullable<DrawingViewGraphics['frame']>;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit2 = (a: Vec2): Vec2 => {
  const l = len2(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};

/** A value as a drawing writes it: up to two decimals, no trailing zeros. */
export function drawingDimensionValue(v: number, digits = 2): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(Object.is(r, -0) ? 0 : r);
}

/** The edge a ref names among a view's features (`drawingResolveRef`'s edge, when one). */
export function drawingFeatureOf(
  features: readonly DrawingEdgeFeature[] | undefined,
  ref: DrawingRef,
): DrawingEdgeFeature | undefined {
  return drawingResolveRef(features, ref).feature;
}

/** How a ref stands in a view (DW3c, 寸法のアンカー). */
export type DrawingRefState = 'ok' | 'ambiguous' | 'unresolved';
export interface DrawingRefResolution {
  state: DrawingRefState;
  /** The edge it measures, when `ok`. */
  feature?: DrawingEdgeFeature;
  /** When `ambiguous`: the edges of its name, to choose from. */
  candidates: DrawingEdgeFeature[];
}

const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p, i) => p === b[i]);
const near3 = (a: Vec3, b: Vec3) => len3(sub(a, b)) <= 1e-6 * Math.max(1, len3(a), len3(b)) + 1e-9;
/** The nearest point (model mm) of an edge's kept pieces, or its straight line, to `p`. */
export function drawingNearestOnFeature(f: DrawingEdgeFeature, p: Vec3): Vec3 {
  const runs = f.runs?.length ? f.runs : [[f.start, f.end]];
  let best: Vec3 = f.start;
  let dist = Infinity;
  for (const run of runs)
    for (let k = 0; k < run.length; k++) {
      const a = run[k]!;
      const b = run[k + 1] ?? a;
      const d = sub(b, a);
      const l2 = dot(d, d);
      const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
      const q: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
      const e = len3(sub(p, q));
      if (e < dist) [best, dist] = [q, e];
    }
  return best;
}
/** Whether the ref's stored point is where it was on this edge: the shape there is unchanged. */
function stillThere(f: DrawingEdgeFeature, ref: DrawingRef): boolean {
  const at =
    ref.point === 'start'
      ? f.start
      : ref.point === 'end'
        ? f.end
        : ref.point === 'center'
          ? f.circle?.c
          : drawingNearestOnFeature(f, ref.model);
  return !!at && near3(at, ref.model);
}

/**
 * DW3c (docs/cad/drawing-editor.md, 寸法のアンカー): the edge a ref measures in a view. A named
 * ref follows its name: the one edge of that name in the placement, else, of several, the one
 * still where it was picked (the same version); several otherwise are ambiguous, none
 * unresolved. A ref without a name (imported geometry) follows its edge index.
 */
export function drawingResolveRef(
  features: readonly DrawingEdgeFeature[] | undefined,
  ref: DrawingRef,
): DrawingRefResolution {
  const here = (features ?? []).filter(
    (f) => f.anchor.bodyId === ref.bodyId && samePath(f.anchor.path, ref.path),
  );
  const byIndex = here.find((f) => f.anchor.edge === ref.edge);
  // A centre needs a circle: an edge that is no longer one has no centre to measure from, so
  // the old one is not kept as if it were still there (Codex on #1278).
  const ok = (feature: DrawingEdgeFeature): DrawingRefResolution =>
    ref.point === 'center' && !feature.circle
      ? { state: 'unresolved', candidates: [] }
      : { state: 'ok', feature, candidates: [] };
  if (ref.name === undefined)
    return byIndex ? ok(byIndex) : { state: 'unresolved', candidates: [] };
  const named = here.filter((f) => f.name === ref.name);
  if (!named.length) return { state: 'unresolved', candidates: [] };
  // One B-rep edge may come as several pieces: candidates are edges, not pieces.
  const edges = new Set(named.map((f) => f.anchor.edge));
  const there = named.filter((f) => stillThere(f, ref));
  if (edges.size === 1) return ok(there[0] ?? named[0]!);
  // The edge it was picked on, unchanged there (the same version, or one that kept the place).
  const own = there.find((f) => f.anchor.edge === ref.edge);
  if (own) return ok(own);
  const thereEdges = new Set(there.map((f) => f.anchor.edge));
  if (thereEdges.size === 1) return ok(there[0]!);
  const firsts = [...edges].map((e) => named.find((f) => f.anchor.edge === e)!);
  return { state: 'ambiguous', candidates: firsts };
}

/** A ref taken over by another edge of its view (a candidate, or one picked again; DW3c). */
export function drawingRefOn(ref: DrawingRef, f: DrawingEdgeFeature): DrawingRef {
  const model =
    ref.point === 'start'
      ? f.start
      : ref.point === 'end'
        ? f.end
        : ref.point === 'center'
          ? (f.circle?.c ?? f.start)
          : drawingNearestOnFeature(f, ref.model);
  return {
    path: [...f.anchor.path],
    bodyId: f.anchor.bodyId,
    edge: f.anchor.edge,
    point: ref.point,
    model: [...model],
    ...(f.name !== undefined ? { name: f.name } : {}),
  };
}

/** A ref's model point on its feature (the stored point when unresolved). */
export function drawingRefPoint(ref: DrawingRef, f: DrawingEdgeFeature | undefined): Vec3 {
  if (!f) return ref.model;
  if (ref.point === 'start') return f.start;
  if (ref.point === 'end') return f.end;
  if (ref.point === 'center') return f.circle?.c ?? ref.model;
  // A point on the edge: the nearest on the edge as it is now, which a newer version may have
  // moved (Codex on #1217).
  return drawingNearestOnFeature(f, ref.model);
}

/** Paper mm of a model point in a view placed at `at`. */
export function drawingPaperOf(frame: Frame, at: Vec2, p: Vec3): Vec2 {
  const x = dot(p, frame.axes.right);
  const y = dot(p, frame.axes.up);
  return [at[0] + (x - frame.center[0]) * frame.scale, at[1] + (y - frame.center[1]) * frame.scale];
}

const ARROW = 3;
function arrow(tip: Vec2, dir: Vec2, cls: 'dimension' | 'error'): DrawingItem {
  const d = unit2(dir);
  const n: Vec2 = [-d[1], d[0]];
  const b = sub2(tip, mul2(d, ARROW));
  return {
    type: 'polyline',
    points: [tip, add2(b, mul2(n, 0.6)), sub2(b, mul2(n, 0.6))],
    closed: true,
    cls,
    fill: true,
  };
}
const segment = (a: Vec2, b: Vec2, cls: 'dimension' | 'error'): DrawingItem => ({
  type: 'line',
  a,
  b,
  cls,
});
/** Text upright: an angle in (−90°, 90°]. */
const upright = (t: number) => {
  let r = t;
  while (r > Math.PI / 2 + 1e-9) r -= Math.PI;
  while (r <= -Math.PI / 2 + 1e-9) r += Math.PI;
  return r;
};

export function drawingItemsBounds(items: readonly DrawingItem[]): [Vec2, Vec2] | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (p: Vec2, r = 0) => {
    x0 = Math.min(x0, p[0] - r);
    y0 = Math.min(y0, p[1] - r);
    x1 = Math.max(x1, p[0] + r);
    y1 = Math.max(y1, p[1] + r);
  };
  for (const it of items) {
    if (it.type === 'line') {
      take(it.a);
      take(it.b);
    } else if (it.type === 'polyline') it.points.forEach((p) => take(p));
    else if (it.type === 'circle' || it.type === 'arc') take(it.center, it.radius);
    else if (it.type === 'text') {
      const w = [...it.text].length * it.heightMm * 0.7;
      const r = it.rotation ?? 0;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const x = it.anchor === 'middle' ? -w / 2 : it.anchor === 'end' ? -w : 0;
      for (const [dx, dy] of [
        [x, 0],
        [x + w, 0],
        [x, it.heightMm],
        [x + w, it.heightMm],
      ] as const)
        take([it.at[0] + dx * c - dy * s, it.at[1] + dx * s + dy * c]);
    } else if (it.type === 'segments')
      for (let i = 0; i + 1 < it.points.length; i += 2) take([it.points[i]!, it.points[i + 1]!]);
  }
  return Number.isFinite(x0)
    ? [
        [x0, y0],
        [x1, y1],
      ]
    : undefined;
}

/** A linear dimension between paper points pa and pb, its line through `at` along `u`. */
function linear(
  pa: Vec2,
  pb: Vec2,
  u: Vec2,
  at: Vec2,
  label: string,
  heightMm: number,
  cls: 'dimension' | 'error',
): DrawingItem[] {
  const n: Vec2 = [-u[1], u[0]];
  const out: DrawingItem[] = [];
  // The dimension line's offset from each point, along n.
  const ends = [pa, pb].map((p) => {
    const o = (at[0] - p[0]) * n[0] + (at[1] - p[1]) * n[1];
    const s = Math.sign(o) || 1;
    // Extension lines: 1 mm off the shape, 2 mm past the dimension line (JIS B 0001 style).
    if (Math.abs(o) > 1) out.push(segment(add2(p, mul2(n, s)), add2(p, mul2(n, o + 2 * s)), cls));
    return add2(p, mul2(n, o));
  }) as [Vec2, Vec2];
  const [a, b] = ends;
  out.push(segment(a, b, cls));
  const d = sub2(b, a);
  const span = len2(d);
  // Arrows inside when there is room, else outside pointing in.
  if (span >= 2 * ARROW + 1) {
    out.push(arrow(a, mul2(d, -1), cls), arrow(b, d, cls));
  } else {
    const e = unit2(d);
    out.push(segment(sub2(a, mul2(e, ARROW + 2)), a, cls));
    out.push(segment(b, add2(b, mul2(e, ARROW + 2)), cls));
    out.push(arrow(a, e, cls), arrow(b, mul2(e, -1), cls));
  }
  const mid = mul2(add2(a, b), 0.5);
  const rot = upright(Math.atan2(d[1], d[0]));
  const up: Vec2 = [-Math.sin(rot), Math.cos(rot)];
  out.push({
    type: 'text',
    at: add2(mid, mul2(up, 1)),
    text: label,
    heightMm,
    anchor: 'middle',
    ...(rot ? { rotation: rot } : {}),
    ...(cls === 'error' ? { error: true } : {}),
  });
  return out;
}

/** The dimension's text: its value (or hand-written text) and tolerance. */
function labelOf(a: DrawingDimension, value: string): string {
  const main = a.text || value;
  return a.tolerance ? `${main} ${a.tolerance}` : main;
}

/** A dimension's or leader's items on the paper, and whether its refs resolve in its view. */
export function drawingAnnotationGraphics(
  doc: DrawingDocument,
  a: DrawingAnnotation,
  views: ReadonlyMap<string, DrawingViewState>,
): DrawingAnnotationGraphics {
  if (a.kind === 'note') return { items: [], status: 'ok' };
  if (a.kind === 'leader' && !a.ref) return leaderItems(a, a.target, a.at, 'dimension');
  if (a.kind === 'symbol' && !a.ref) return symbolGraphics(doc, views, a, a.target, a.at, true);
  // DW4: a table on the paper, from its view's parts (no frame needed).
  if (a.kind === 'parts-list')
    return drawingPartsListGraphics(
      a,
      doc.views.some((v) => v.id === a.viewId) ? views.get(a.viewId) : undefined,
    );
  const view = doc.views.find((v) => v.id === a.viewId);
  const state = view ? views.get(view.id) : undefined;
  if (!view || state?.status !== 'ready' || !state.graphics.frame)
    return { items: [], status: state?.status === 'failed' || !view ? 'unresolved' : 'pending' };
  const g = state.graphics;
  const frame = g.frame!;
  const at = add2(view.at, a.at);
  if (a.kind === 'pmi') return pmiGraphics(doc, views, a, g.pmi, frame, view.at, at);
  if (a.kind === 'balloon') {
    const r0 = drawingResolveRef(g.features, a.ref);
    const f = r0.feature;
    const p = drawingPaperOf(frame, view.at, drawingRefPoint(a.ref, f));
    const r = drawingBalloonItems(a, p, at, drawingPartRowOf(g.parts, f ? f.anchor : a.ref), !!f);
    return f ? r : { ...r, status: r0.state };
  }
  if (a.kind === 'leader') {
    const r0 = drawingResolveRef(g.features, a.ref!);
    const f = r0.feature;
    const p = drawingPaperOf(frame, view.at, drawingRefPoint(a.ref!, f));
    const r = leaderItems(a, p, at, f ? 'dimension' : 'error');
    return { ...r, status: f ? 'ok' : r0.state };
  }
  if (a.kind === 'symbol') {
    const r0 = drawingResolveRef(g.features, a.ref!);
    const f = r0.feature;
    const p = drawingPaperOf(frame, view.at, drawingRefPoint(a.ref!, f));
    const r = symbolGraphics(doc, views, a, p, at, !!f);
    return r.status === 'unresolved' ? { ...r, status: r0.state } : r;
  }
  const states = a.refs.map((r) => drawingResolveRef(g.features, r).state);
  const r = dimensionItems(a, view, frame, g.features ?? [], at);
  // A ref of several edges is ambiguous, not gone (it is drawn in red where it was all the same).
  return r.status === 'unresolved' && !states.includes('unresolved') && states.includes('ambiguous')
    ? { ...r, status: 'ambiguous' }
    : r;
}

function dimensionItems(
  a: DrawingDimension,
  view: DrawingView,
  frame: Frame,
  features: readonly DrawingEdgeFeature[],
  at: Vec2,
): DrawingAnnotationGraphics {
  const fs = a.refs.map((r) => drawingFeatureOf(features, r));
  const missing = fs.some((f) => !f);
  const cls = missing ? 'error' : 'dimension';
  const paper = (p: Vec3) => drawingPaperOf(frame, view.at, p);
  const dir = frame.axes.direction;
  const done = (
    items: DrawingItem[],
    extra: Partial<DrawingAnnotationGraphics> = {},
  ): DrawingAnnotationGraphics => ({
    items,
    status: missing ? 'unresolved' : 'ok',
    bounds: drawingItemsBounds(items),
    ...extra,
  });
  const marked = (v: string, projected: boolean) => (projected ? `${v}（投影）` : v);

  if (a.type === 'horizontal' || a.type === 'vertical' || a.type === 'aligned') {
    const [A, B] = a.refs.map((r, i) => drawingRefPoint(r, fs[i])) as [Vec3, Vec3];
    const pa = paper(A);
    const pb = paper(B);
    const d3 = sub(B, A);
    let value: number;
    let u: Vec2;
    let projected = false;
    if (a.type === 'horizontal') {
      value = Math.abs(dot(d3, frame.axes.right));
      u = [1, 0];
    } else if (a.type === 'vertical') {
      value = Math.abs(dot(d3, frame.axes.up));
      u = [0, 1];
    } else {
      const flat = Math.hypot(dot(d3, frame.axes.right), dot(d3, frame.axes.up));
      const true3 = len3(d3);
      projected = Math.abs(true3 - flat) > 1e-6 * Math.max(true3, 1);
      value = projected ? flat : true3;
      u = unit2(sub2(pb, pa));
    }
    const label = labelOf(a, marked(drawingDimensionValue(value), projected));
    return done(linear(pa, pb, u, at, label, a.heightMm, cls), { value, projected });
  }

  if (a.type === 'diameter' || a.type === 'radius') {
    const f = fs[0];
    const circle = f?.circle;
    if (!circle) {
      // Unresolved, or the edge is no circle: the text alone, in red, where it goes.
      const items: DrawingItem[] = [
        {
          type: 'text',
          at,
          text: labelOf(a, a.type === 'diameter' ? 'Ø?' : 'R?'),
          heightMm: a.heightMm,
          anchor: 'start',
          error: true,
        },
      ];
      return { items, status: 'unresolved', bounds: drawingItemsBounds(items) };
    }
    const value = a.type === 'diameter' ? 2 * circle.r : circle.r;
    const label = labelOf(a, `${a.type === 'diameter' ? 'Ø' : 'R'}${drawingDimensionValue(value)}`);
    const cp = paper(circle.c);
    const along = Math.abs(dot(circle.n, dir));
    const out: DrawingItem[] = [];
    if (along > 0.999) {
      // Seen face-on: through the centre towards the text.
      const rp = circle.r * frame.scale;
      let u = unit2(sub2(at, cp));
      let p2 = add2(cp, mul2(u, rp));
      // An arc: the arrow goes on the arc where it is nearest the text's way, and the line
      // turns from there to the text (Codex on #1211).
      let bent = false;
      if (f.runs?.length) {
        const [on, , d] = nearestOnRuns(p2, f.runs, paper);
        if (d > rp * 1e-3 + 1e-3) {
          u = unit2(sub2(on, cp));
          p2 = add2(cp, mul2(u, rp));
          bent = true;
        }
      }
      const p1 = a.type === 'diameter' ? sub2(cp, mul2(u, rp)) : cp;
      out.push(segment(p1, p2, cls), arrow(p2, u, cls));
      if (a.type === 'diameter') out.push(arrow(p1, mul2(u, -1), cls));
      if (bent || len2(sub2(at, cp)) > rp) out.push(segment(p2, at, cls));
      const w = [...label].length * a.heightMm * 0.7;
      const right = u[0] >= 0;
      out.push(segment(at, add2(at, [right ? w : -w, 0]), cls));
      out.push({
        type: 'text',
        at: add2(at, [right ? 0 : -w, 1]),
        text: label,
        heightMm: a.heightMm,
        anchor: 'start',
      });
      return done(out, { value });
    }
    // Seen at a slant or side-on: across the circle's apparent width.
    const w3 = cross(circle.n, dir);
    const l = len3(w3) || 1;
    const w: Vec3 = [w3[0] / l, w3[1] / l, w3[2] / l];
    const e1 = paper([
      circle.c[0] + w[0] * circle.r,
      circle.c[1] + w[1] * circle.r,
      circle.c[2] + w[2] * circle.r,
    ]);
    const e0 =
      a.type === 'diameter'
        ? paper([
            circle.c[0] - w[0] * circle.r,
            circle.c[1] - w[1] * circle.r,
            circle.c[2] - w[2] * circle.r,
          ])
        : cp;
    return done(linear(e0, e1, unit2(sub2(e1, e0)), at, label, a.heightMm, cls), { value });
  }

  // An angle between two straight edges.
  const [f1, f2] = fs;
  if (!f1 || !f2 || !f1.straight || !f2.straight) {
    const items: DrawingItem[] = [
      {
        type: 'text',
        at,
        text: labelOf(a, '?°'),
        heightMm: a.heightMm,
        anchor: 'middle',
        error: true,
      },
    ];
    return { items, status: 'unresolved', bounds: drawingItemsBounds(items) };
  }
  const a1 = paper(f1.start);
  const b1 = paper(f1.end);
  const a2 = paper(f2.start);
  const b2 = paper(f2.end);
  const d1 = unit2(sub2(b1, a1));
  const d2 = unit2(sub2(b2, a2));
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return { items: [], status: 'parallel' };
  const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
  const V = add2(a1, mul2(d1, t));
  const toA = sub2(at, V);
  const rad = Math.max(len2(toA), 4);
  const ang = (v: Vec2) => Math.atan2(v[1], v[0]);
  const ta = ang(toA);
  // The two rays (signs of d1, d2) whose angle holds the text's direction.
  // `swapped`: the arc starts on the second edge (Codex on #1211).
  let best: { s1: number; s2: number; start: number; span: number; swapped: boolean } | undefined;
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      const r1 = ang(mul2(d1, s1));
      const r2 = ang(mul2(d2, s2));
      let span = r2 - r1;
      while (span < 0) span += 2 * Math.PI;
      let start = r1;
      let swapped = false;
      if (span > Math.PI) {
        start = r2;
        span = 2 * Math.PI - span;
        swapped = true;
      }
      let rel = ta - start;
      while (rel < 0) rel += 2 * Math.PI;
      if (rel <= span + 1e-9 && (!best || span < best.span))
        best = { s1, s2, start, span, swapped };
    }
  const pick = best!;
  const e1 = sub(f1.end, f1.start);
  const e2 = sub(f2.end, f2.start);
  const flat = Math.abs(dot(e1, dir)) < 1e-6 * len3(e1) && Math.abs(dot(e2, dir)) < 1e-6 * len3(e2);
  const true3 =
    (Math.acos(
      Math.max(-1, Math.min(1, (pick.s1 * pick.s2 * dot(e1, e2)) / (len3(e1) * len3(e2)))),
    ) *
      180) /
    Math.PI;
  const projected = !flat;
  const value = flat ? true3 : (pick.span * 180) / Math.PI;
  const label = labelOf(a, marked(`${drawingDimensionValue(value, 1)}°`, projected));
  const out: DrawingItem[] = [];
  const end = pick.start + pick.span;
  out.push({ type: 'arc', center: V, radius: rad, start: pick.start, end, cls });
  const p0 = add2(V, mul2([Math.cos(pick.start), Math.sin(pick.start)], rad));
  const p1 = add2(V, mul2([Math.cos(end), Math.sin(end)], rad));
  out.push(arrow(p0, [Math.sin(pick.start), -Math.cos(pick.start)], cls));
  out.push(arrow(p1, [-Math.sin(end), Math.cos(end)], cls));
  // Extension lines from the edges out to the arc.
  const seg1: [Vec2, Vec2] = [a1, b1];
  const seg2: [Vec2, Vec2] = [a2, b2];
  for (const [p, seg] of [
    [p0, pick.swapped ? seg2 : seg1],
    [p1, pick.swapped ? seg1 : seg2],
  ] as const) {
    const ray = unit2(sub2(p, V));
    const reach = Math.max(...seg.map((q) => (q[0] - V[0]) * ray[0] + (q[1] - V[1]) * ray[1]));
    if (rad > reach + 1)
      out.push(segment(add2(V, mul2(ray, reach + 1)), add2(p, mul2(ray, 2)), cls));
  }
  const mid = pick.start + pick.span / 2;
  out.push({
    type: 'text',
    at: add2(V, mul2([Math.cos(mid), Math.sin(mid)], rad + 1.5)),
    text: label,
    heightMm: a.heightMm,
    anchor: 'middle',
    ...(cls === 'error' ? { error: true } : {}),
  });
  return done(out, { value, projected });
}

/**
 * DW3c-2b: an imported PMI item, drawn as DW3b's frame or datum, or as a leader note: what the
 * item says now when it is current (an update is drawn and marked to be confirmed), what it said
 * in red when it expired. An expired item's leader goes nowhere: only its text is drawn.
 */
function pmiGraphics(
  doc: DrawingDocument,
  views: ReadonlyMap<string, DrawingViewState>,
  a: Extract<DrawingAnnotation, { kind: 'pmi' }>,
  live: Parameters<typeof drawingPmiResolve>[1],
  frame: Frame,
  viewAt: Vec2,
  at: Vec2,
): DrawingAnnotationGraphics {
  const r = drawingPmiResolve(a, live);
  if (r.state === 'pending') return { items: [], status: 'pending' };
  const expired = r.state === 'expired';
  const item = expired ? a.item : r.live!.item;
  const target = !expired && r.live?.target ? drawingPaperOf(frame, viewAt, r.live.target) : at;
  // An expired item is written as text, whatever it drew as: nothing points anywhere.
  const spec = expired ? undefined : drawingPmiSymbol(item);
  let g: DrawingAnnotationGraphics;
  if (spec) {
    const sym: DrawingSymbol = {
      id: a.id,
      sheetId: a.sheetId,
      kind: 'symbol',
      viewId: a.viewId,
      ref: null,
      target,
      at,
      symbol: spec,
      heightMm: a.heightMm,
    };
    g = symbolGraphics(doc, views, sym, target, at, true);
  } else {
    const leader: DrawingLeader = {
      id: a.id,
      sheetId: a.sheetId,
      kind: 'leader',
      viewId: a.viewId,
      ref: null,
      target,
      at,
      text: drawingPmiText(item),
      heightMm: a.heightMm,
    };
    g = leaderItems(leader, target, at, expired ? 'error' : 'dimension');
    // A leader to nowhere: the text alone.
    if (expired) g = { ...g, items: g.items.filter((i) => i.type === 'text') };
  }
  const status =
    r.state === 'expired'
      ? 'expired'
      : r.state === 'updated'
        ? 'updated'
        : g.status === 'datum-missing'
          ? 'datum-missing'
          : 'ok';
  return { ...g, status };
}

/**
 * The datum letters the drawing shows: drawn by hand, and imported from PMI (DW3c-2b) as each
 * reads now (the letter of the version shown; an expired one is none; a pending one as imported).
 */
function drawingDatumLetters(doc: DrawingDocument, views: ReadonlyMap<string, DrawingViewState>) {
  const have = new Set<string>();
  for (const x of doc.annotations) {
    if (x.kind === 'symbol' && x.symbol.type === 'datum') have.add(x.symbol.letter);
    if (x.kind !== 'pmi' || x.item.kind !== 'datum') continue;
    const st = views.get(x.viewId);
    const r = drawingPmiResolve(x, st?.status === 'ready' ? st.graphics.pmi : undefined);
    const item = r.state === 'pending' ? x.item : r.state === 'expired' ? undefined : r.live!.item;
    if (item?.kind === 'datum') have.add(item.name);
  }
  return have;
}

/** A symbol's items and status: unresolved ref first, then datum letters with no datum. */
function symbolGraphics(
  doc: DrawingDocument,
  views: ReadonlyMap<string, DrawingViewState>,
  a: DrawingSymbol,
  target: Vec2,
  at: Vec2,
  resolved: boolean,
): DrawingAnnotationGraphics {
  const missing = new Set<string>();
  if (a.symbol.type === 'gdt') {
    const have = drawingDatumLetters(doc, views);
    for (const d of a.symbol.datums) if (!have.has(d)) missing.add(d);
  }
  const items = drawingSymbolItems(a, target, at, resolved ? 'dimension' : 'error', missing);
  return {
    items,
    status: !resolved ? 'unresolved' : missing.size ? 'datum-missing' : 'ok',
    bounds: drawingItemsBounds(items),
  };
}

function leaderItems(
  a: DrawingLeader,
  target: Vec2,
  at: Vec2,
  cls: 'dimension' | 'error',
): DrawingAnnotationGraphics {
  const lines = a.text.split('\n');
  const w = Math.max(...lines.map((l) => [...l].length)) * a.heightMm * 0.95;
  const right = target[0] <= at[0];
  // The shoulder under the first line of text, the leader from its near end to the target.
  const shoulder: Vec2 = [right ? at[0] - 1 : at[0] + w + 1, at[1] - 1];
  const out: DrawingItem[] = [
    segment(shoulder, [right ? at[0] + w : at[0] - 1, at[1] - 1], cls),
    segment(shoulder, target, cls),
    arrow(target, sub2(target, shoulder), cls),
  ];
  lines.forEach((t, i) =>
    out.push({
      type: 'text',
      at: [at[0], at[1] - i * a.heightMm * 1.6],
      text: t,
      heightMm: a.heightMm,
      anchor: 'start',
      ...(i === 0 ? { id: `note:${a.id}` } : {}),
      ...(cls === 'error' ? { error: true } : {}),
    }),
  );
  return {
    items: out,
    status: cls === 'error' ? 'unresolved' : 'ok',
    bounds: drawingItemsBounds(out),
  };
}

/** What a click snaps to (DW3): a point (an edge's end or a circle's centre), a circle, an edge. */
export type DrawingSnapKind = 'point' | 'circle' | 'line';
export interface DrawingSnap {
  viewId: string;
  ref: DrawingRef;
  /** Where it is on the paper. */
  paper: Vec2;
  distance: number;
}

/**
 * The nearest snap within `tolerance` paper mm of `p` on a sheet's ready CAD views: an edge's
 * end or a circle's centre (`point`), a circle (`circle`: its outline or centre), or a straight
 * edge (`line`).
 */
export function drawingSnap(
  doc: DrawingDocument,
  views: ReadonlyMap<string, DrawingViewState>,
  sheetId: string,
  p: Vec2,
  kind: DrawingSnapKind,
  tolerance: number,
): DrawingSnap | undefined {
  let best: DrawingSnap | undefined;
  const offer = (s: DrawingSnap) => {
    if (s.distance <= tolerance && (!best || s.distance < best.distance)) best = s;
  };
  for (const view of doc.views) {
    if (view.sheetId !== sheetId) continue;
    const st = views.get(view.id);
    if (st?.status !== 'ready' || !st.graphics.frame || !st.graphics.features) continue;
    const frame = st.graphics.frame;
    const paper = (q: Vec3) => drawingPaperOf(frame, view.at, q);
    // A detail: only what is in its circle is drawn, so only that is picked (Codex on #1211).
    const clip = frame.clipRadius;
    const inside = (q: Vec2) => clip === undefined || len2(sub2(q, view.at)) <= clip + 1e-6;
    if (!inside(p)) continue;
    /** The model point on a straight piece a–b (model A–B) nearest to p on the paper. */
    const along = (a: Vec2, b: Vec2, A: Vec3, B: Vec3): [Vec2, Vec3] => {
      const d = sub2(b, a);
      const l2 = d[0] * d[0] + d[1] * d[1];
      const t =
        l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
      return [
        add2(a, mul2(d, t)),
        [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t],
      ];
    };
    for (const f of st.graphics.features) {
      if (f.pickable === false) continue;
      const base = {
        path: f.anchor.path,
        bodyId: f.anchor.bodyId,
        edge: f.anchor.edge,
        ...(f.name !== undefined ? { name: f.name } : {}),
      };
      if (kind === 'point') {
        const pts: [DrawingRef['point'], Vec3][] = [
          ['start', f.start],
          ['end', f.end],
        ];
        if (f.circle) pts.push(['center', f.circle.c]);
        for (const [point, model] of pts) {
          const q = paper(model);
          if (!inside(q)) continue;
          offer({
            viewId: view.id,
            ref: { ...base, point, model },
            paper: q,
            distance: len2(sub2(q, p)),
          });
        }
      } else if (kind === 'circle' && f.circle) {
        const { c, n } = f.circle;
        const q = paper(c);
        const faceOn = Math.abs(dot(n, frame.axes.direction)) > 0.999;
        // The point kept is on the drawn circle or arc nearest the pick (a leader's arrow goes
        // there); a diameter or radius reads the circle itself. Face-on, its centre picks it too.
        const runs = f.runs ?? [];
        const [at, model, outline] = nearestOnRuns(p, runs, paper);
        const distance = faceOn ? Math.min(len2(sub2(q, p)), outline) : outline;
        if (!inside(at)) continue;
        offer({
          viewId: view.id,
          ref: { ...base, point: 'edge', model },
          paper: at,
          distance,
        });
      } else if (kind === 'line' && f.straight) {
        // The point on the edge nearest the pick (a leader's arrow goes there; Codex on #1211).
        const [at, model] = along(paper(f.start), paper(f.end), f.start, f.end);
        if (!inside(at)) continue;
        offer({
          viewId: view.id,
          ref: { ...base, point: 'edge', model },
          paper: at,
          distance: len2(sub2(p, at)),
        });
      }
    }
  }
  return best;
}

/**
 * The point of a polyline (model mm, in pieces) whose projection is nearest p on the paper: the
 * paper point, the model point and the distance.
 */
function nearestOnRuns(
  p: Vec2,
  runs: readonly (readonly Vec3[])[],
  paper: (q: Vec3) => Vec2,
): [Vec2, Vec3, number] {
  let best: [Vec2, Vec3, number] = [p, [0, 0, 0], Infinity];
  for (const run of runs) {
    let prev = run[0];
    if (!prev) continue;
    let pp = paper(prev);
    if (run.length === 1 && len2(sub2(p, pp)) < best[2]) best = [pp, prev, len2(sub2(p, pp))];
    for (let k = 1; k < run.length; k++) {
      const cur = run[k]!;
      const cp = paper(cur);
      const d = sub2(cp, pp);
      const l2 = d[0] * d[0] + d[1] * d[1];
      const s =
        l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - pp[0]) * d[0] + (p[1] - pp[1]) * d[1]) / l2)) : 0;
      const at = add2(pp, mul2(d, s));
      const dist = len2(sub2(p, at));
      if (dist < best[2])
        best = [
          at,
          [
            prev[0] + (cur[0] - prev[0]) * s,
            prev[1] + (cur[1] - prev[1]) * s,
            prev[2] + (cur[2] - prev[2]) * s,
          ],
          dist,
        ];
      prev = cur;
      pp = cp;
    }
  }
  return best;
}

/** One ref that does not resolve (DW3c, 曖昧・未解決の寸法の一覧). */
export interface DrawingAnchorIssue {
  annotationId: string;
  sheetId: string;
  viewId: string;
  /** The ref's index (a dimension's refs; 0 for a leader or symbol). */
  index: number;
  state: Exclude<DrawingRefState, 'ok'>;
  candidates: DrawingEdgeFeature[];
}

/**
 * Every ref of the drawing's annotations whose view is ready and that does not resolve, sheet by
 * sheet in annotation order. Refs of views still deriving or failed are left out (they are
 * pending, or the view says why).
 */
export function drawingAnchorIssues(
  doc: DrawingDocument,
  views: ReadonlyMap<string, DrawingViewState>,
): DrawingAnchorIssue[] {
  const out: DrawingAnchorIssue[] = [];
  for (const sheet of doc.sheets)
    for (const a of doc.annotations) {
      if (
        a.sheetId !== sheet.id ||
        a.kind === 'note' ||
        a.kind === 'pmi' ||
        a.kind === 'parts-list'
      )
        continue;
      const refs = a.kind === 'dimension' ? a.refs : a.ref ? [a.ref] : [];
      const st = views.get(a.viewId);
      if (!refs.length || st?.status !== 'ready' || !st.graphics.features) continue;
      refs.forEach((ref, index) => {
        const r = drawingResolveRef(st.graphics.features, ref);
        // An edge of the name that no longer suits the dimension (a circle that is now straight)
        // is as good as gone: it is listed to be picked again (Codex on #1217).
        const fits =
          a.kind !== 'dimension' ||
          !r.feature ||
          (a.type === 'diameter' || a.type === 'radius'
            ? !!r.feature.circle
            : a.type === 'angle'
              ? r.feature.straight
              : true);
        if (r.state === 'ok' && !fits)
          out.push({
            annotationId: a.id,
            sheetId: a.sheetId,
            viewId: a.viewId,
            index,
            state: 'unresolved',
            candidates: [],
          });
        else if (r.state !== 'ok')
          out.push({
            annotationId: a.id,
            sheetId: a.sheetId,
            viewId: a.viewId,
            index,
            state: r.state,
            candidates: r.candidates,
          });
      });
    }
  return out;
}
