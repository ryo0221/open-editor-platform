import { drawingNearestOnFeature, drawingPaperOf } from './dimensions';
import type { DrawingDimensionType, DrawingRef, DrawingRefPoint, Vec2 } from './model';
import type { DrawingEdgeFeature, Vec3 } from './project';
import type { DrawingViewGraphics } from './svg';

/**
 * DW4b (docs/cad/drawing-editor.md, 組立図; DW-U4): the dimensions a new part drawing starts
 * with: the outline (overall width and height, or the diameter of a round outline) and the
 * holes seen face-on (each size once, and their places from the outline's left and lower
 * edges). The rest is the designer's choice and is added by hand.
 */

/** A dimension to add: its type, refs and where its line goes (relative to the view's `at`). */
export interface DrawingDimensionCandidate {
  type: DrawingDimensionType;
  refs: DrawingRef[];
  at: Vec2;
}

export interface DrawingCandidateOptions {
  /** The overall size across the paper (horizontal) and up it (vertical). */
  width: boolean;
  height: boolean;
  /** Hole sizes and places. */
  holes: boolean;
  /** Where the stacked lines go: under or over the view, left or right of it. */
  below: boolean;
  left: boolean;
}

/** Hole places on one axis at most: past that the drawing would be the list, not a view. */
const MAX_PLACES = 6;
/** Paper mm from the view's box to its first dimension line, and between stacked lines. */
const FIRST = 10;
const STEP = 8;
/** Under a view: clear of its name and scale. */
const LABEL = 8;

const refOf = (f: DrawingEdgeFeature, point: DrawingRefPoint): DrawingRef => ({
  path: [...f.anchor.path],
  bodyId: f.anchor.bodyId,
  edge: f.anchor.edge,
  point,
  model: [...(point === 'end' ? f.end : point === 'center' ? f.circle!.c : f.start)],
  ...(f.name !== undefined ? { name: f.name } : {}),
});

/** The circles of a view seen face-on (round holes, bosses, a round outline). */
export function drawingFaceOnCircles(g: DrawingViewGraphics): DrawingEdgeFeature[] {
  const frame = g.frame;
  if (!frame) return [];
  const dir = frame.axes.direction;
  const seen = new Set<string>();
  return (g.features ?? []).filter((f) => {
    if (!f.circle || f.pickable === false) return false;
    // A whole circle (its ends meet), not an arc such as a rounded corner.
    const gap = Math.hypot(f.end[0] - f.start[0], f.end[1] - f.start[1], f.end[2] - f.start[2]);
    if (gap > f.circle.r * 0.05) return false;
    const n = f.circle.n;
    if (Math.abs(n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]) < 0.999) return false;
    // A hole's two rims (front and back faces) are one circle on the paper.
    const p = drawingPaperOf(frame, [0, 0], f.circle.c);
    const k = `${p[0].toFixed(2)} ${p[1].toFixed(2)} ${f.circle.r.toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A view's outline: its edge ends, its face-on circles and whether it is round itself. */
function outlineOf(
  g: DrawingViewGraphics,
  frame: NonNullable<DrawingViewGraphics['frame']>,
  viewAt: Vec2,
) {
  const paper = (p: readonly number[]) => drawingPaperOf(frame, viewAt, p as never);
  const straight = (g.features ?? []).filter((f) => f.straight && f.pickable !== false);
  const circles = drawingFaceOnCircles(g);
  // The extreme ends of straight edges, and rims' centres along the rim's axis (a shaft or disc
  // seen side-on has only its rims; Codex on #1232): the outline's sides and the datum for hole
  // places. A rim's centre is no extent across it, where the rim reaches its radius further.
  const rims = (g.features ?? []).filter((f) => f.circle && f.pickable !== false);
  const along = (f: DrawingEdgeFeature, a: Vec3): boolean => {
    const n = f.circle!.n;
    return Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) > 0.999;
  };
  // Where a curve reaches furthest across or up the paper (a capsule's ends' arcs reach past the
  // tangent points of its straight sides; Codex on #1232). On a circle or arc, the point at its
  // radius along the paper axis (when the arc runs through it); a curve of another kind, its
  // ends. A linear dimension measures between edge ends and centres only, so an outline that a
  // curve reaches past gets no overall size on that axis: the designer gives it.
  const curved = (g.features ?? []).filter((f) => !f.straight && f.pickable !== false);
  const reach = (f: DrawingEdgeFeature): Vec3[] => {
    const c = f.circle;
    if (!c) return [f.start, f.end];
    const runs = f.runs?.length ? f.runs : [[f.start, f.end]];
    // How far inside the circle its drawn chords run: a point that far from them is on the arc.
    let sag = 0;
    for (const run of runs)
      for (let k = 0; k + 1 < run.length; k++) {
        const m = run[k]!.map((v, i) => (v + run[k + 1]![i]!) / 2 - c.c[i]!);
        sag = Math.max(sag, c.r - Math.hypot(m[0]!, m[1]!, m[2]!));
      }
    const out: Vec3[] = [];
    for (const a of [frame.axes.right, frame.axes.up]) {
      const t = a[0] * c.n[0] + a[1] * c.n[1] + a[2] * c.n[2];
      const u = [a[0] - c.n[0] * t, a[1] - c.n[1] * t, a[2] - c.n[2] * t];
      const l = Math.hypot(u[0]!, u[1]!, u[2]!);
      if (l < 1e-6) continue;
      for (const s of [1, -1]) {
        const p: Vec3 = [
          c.c[0] + (s * c.r * u[0]!) / l,
          c.c[1] + (s * c.r * u[1]!) / l,
          c.c[2] + (s * c.r * u[2]!) / l,
        ];
        const q = drawingNearestOnFeature(f, p);
        if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= sag + 1e-6 * Math.max(1, c.r))
          out.push(p);
      }
    }
    return out;
  };
  const reached = curved.flatMap((f) => reach(f).map(paper));
  const ends: {
    f: DrawingEdgeFeature;
    point: DrawingRefPoint;
    p: Vec2;
    axes: [boolean, boolean];
  }[] = [
    ...straight.flatMap((f) =>
      (['start', 'end'] as const).map((point) => ({
        f,
        point,
        p: paper(point === 'start' ? f.start : f.end),
        axes: [true, true] as [boolean, boolean],
      })),
    ),
    ...rims.map((f) => ({
      f,
      point: 'center' as const,
      p: paper(f.circle!.c),
      axes: [along(f, frame.axes.right), along(f, frame.axes.up)] as [boolean, boolean],
    })),
  ];
  // The outline is round when every edge end lies within its largest face-on circle (not only
  // within the circle's square: a big hole in a square plate is no outline; Codex on #1232).
  const big = circles.reduce<DrawingEdgeFeature | undefined>(
    (a, b) => (!a || b.circle!.r > a.circle!.r ? b : a),
    undefined,
  );
  const round = (() => {
    if (!big) return false;
    const c = paper(big.circle!.c);
    const r = big.circle!.r * frame.scale + 0.5;
    const inside = (p: Vec2) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r;
    // Every curve's drawn points too: an ellipse's or a spline's outline has no straight end
    // and no rim centre, so a hole would pass for the outline (Codex on #1278).
    return (
      ends.every((e) => inside(e.p)) &&
      reached.every(inside) &&
      curved.every((f) =>
        (f.runs?.length ? f.runs.flat() : [f.start, f.end]).every((q) => inside(paper(q))),
      )
    );
  })();
  const extreme = (axis: 0 | 1, max: boolean) =>
    ends
      .filter((e) => e.axes[axis])
      .reduce<(typeof ends)[number] | undefined>((a, b) => {
        if (!a) return b;
        // The true extreme (a paper tolerance would pick an inner point on a slope at a small
        // scale; Codex on #1232). Level ends: the lowest (or leftmost) on the other axis.
        const d = b.p[axis] - a.p[axis];
        if (Math.abs(d) > 1e-9) return (max ? d > 0 : d < 0) ? b : a;
        return b.p[1 - axis]! < a.p[1 - axis]! ? b : a;
      }, undefined);
  const left = extreme(0, false);
  const rightEnd = extreme(0, true);
  const bottom = extreme(1, false);
  const topEnd = extreme(1, true);
  return { paper, rims, circles, reached, big, round, left, rightEnd, bottom, topEnd };
}

/**
 * The holes of a view: its face-on circles but a round outline's own (a shaft's end seen
 * face-on is no hole; Codex on #1232).
 */
export function drawingHoleCircles(g: DrawingViewGraphics): DrawingEdgeFeature[] {
  if (!g.frame) return [];
  const { circles, round, big } = outlineOf(g, g.frame, [0, 0]);
  return circles.filter((f) => !(round && f === big));
}

export function drawingCandidateDimensions(
  g: DrawingViewGraphics,
  viewAt: Vec2,
  o: DrawingCandidateOptions,
): DrawingDimensionCandidate[] {
  const frame = g.frame;
  if (!frame) return [];
  const { paper, rims, circles, reached, big, round, left, rightEnd, bottom, topEnd } = outlineOf(
    g,
    frame,
    viewAt,
  );
  const rel = (p: Vec2): Vec2 => [p[0] - viewAt[0], p[1] - viewAt[1]];
  const [[x0, y0], [x1, y1]] = g.bounds;

  const out: DrawingDimensionCandidate[] = [];
  let hRow = 0;
  let vRow = 0;
  const hLine = () => {
    const y = o.below ? y0 - LABEL - FIRST - STEP * hRow : y1 + FIRST + STEP * hRow;
    hRow++;
    return y;
  };
  const vLine = () => {
    const x = o.left ? x0 - FIRST - STEP * vRow : x1 + FIRST + STEP * vRow;
    vRow++;
    return x;
  };
  const holes = o.holes ? circles.filter((f) => !(round && f === big)) : [];

  // Hole places from the left and lower outline ends (or the round outline's centre).
  if (holes.length) {
    const datumX = round ? { f: big!, point: 'center' as const } : left;
    const datumY = round ? { f: big!, point: 'center' as const } : bottom;
    const place = (axis: 0 | 1) => {
      const datum = axis === 0 ? datumX : datumY;
      if (!datum) return;
      const d0 = paper(
        datum.point === 'center'
          ? datum.f.circle!.c
          : datum.point === 'end'
            ? datum.f.end
            : datum.f.start,
      );
      const at = new Set<string>([d0[axis].toFixed(2)]);
      const list = holes
        .map((f) => ({ f, p: paper(f.circle!.c) }))
        .sort((a, b) => Math.abs(a.p[axis] - d0[axis]) - Math.abs(b.p[axis] - d0[axis]));
      let n = 0;
      for (const { f, p } of list) {
        const k = p[axis].toFixed(2);
        if (at.has(k) || n >= MAX_PLACES) continue;
        at.add(k);
        n++;
        const line = axis === 0 ? hLine() : vLine();
        out.push({
          type: axis === 0 ? 'horizontal' : 'vertical',
          refs: [refOf(datum.f, datum.point), refOf(f, 'center')],
          at: rel(axis === 0 ? [(d0[0] + p[0]) / 2, line] : [line, (d0[1] + p[1]) / 2]),
        });
      }
    };
    place(0);
    place(1);
  }
  // The overall size, outermost.
  if (round && (o.width || o.height)) {
    const c = paper(big!.circle!.c);
    const r = big!.circle!.r * frame.scale;
    out.push({
      type: 'diameter',
      refs: [refOf(big!, 'edge')],
      at: rel([c[0] + r * 0.75 + 12, y1 + 8]),
    });
  } else {
    // Any real extent, however thin at the scale (Codex on #1232): only coincident ends are none.
    // A curve reaching past the ends on an axis: no size the ends can give (see `reach`).
    // A curve with no circle (an ellipse, a spline) gives its ends only, so the shape's own box
    // says whether something reaches past them (its nodes lie on the shape, so the box never
    // overstates it): then the ends would dimension a part of the outline as the whole (Codex on
    // #1278).
    const box = frame.box;
    const span = Math.max(box[1][0] - box[0][0], box[1][1] - box[0][1], 1e-6);
    const short = (axis: 0 | 1, lo: number, hi: number) =>
      (hi - lo) / frame.scale < box[1][axis] - box[0][axis] - Math.max(1e-4 * span, 1e-6);
    const past = (axis: 0 | 1, lo: number, hi: number) =>
      reached.some((p) => p[axis] < lo - 1e-6 || p[axis] > hi + 1e-6) || short(axis, lo, hi);
    const wide =
      !!left &&
      !!rightEnd &&
      rightEnd.p[0] - left.p[0] > 1e-6 &&
      !past(0, left.p[0], rightEnd.p[0]);
    const tall =
      !!bottom &&
      !!topEnd &&
      topEnd.p[1] - bottom.p[1] > 1e-6 &&
      !past(1, bottom.p[1], topEnd.p[1]);
    // A round part seen side-on: across it is its largest rim's diameter.
    const dir = frame.axes.direction;
    const side = rims
      .filter((f) => {
        const n = f.circle!.n;
        return Math.abs(n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]) < 1e-3;
      })
      .reduce<DrawingEdgeFeature | undefined>(
        (a, b) => (!a || b.circle!.r > a.circle!.r ? b : a),
        undefined,
      );
    if (side) {
      const c = paper(side.circle!.c);
      const n = side.circle!.n;
      // The rim's line on the paper runs across n: along x when n is up the paper.
      const nx = Math.abs(
        n[0] * frame.axes.right[0] + n[1] * frame.axes.right[1] + n[2] * frame.axes.right[2],
      );
      const across: 0 | 1 = nx > 0.5 ? 1 : 0;
      if (across === 0 && o.width && !wide)
        out.push({ type: 'diameter', refs: [refOf(side, 'edge')], at: rel([c[0], hLine()]) });
      if (across === 1 && o.height && !tall)
        out.push({ type: 'diameter', refs: [refOf(side, 'edge')], at: rel([vLine(), c[1]]) });
    }
    if (o.width && wide) {
      const y = hLine();
      out.push({
        type: 'horizontal',
        refs: [refOf(left.f, left.point), refOf(rightEnd.f, rightEnd.point)],
        at: rel([(left.p[0] + rightEnd.p[0]) / 2, y]),
      });
    }
    if (o.height && tall) {
      const x = vLine();
      out.push({
        type: 'vertical',
        refs: [refOf(bottom.f, bottom.point), refOf(topEnd.f, topEnd.point)],
        at: rel([x, (bottom.p[1] + topEnd.p[1]) / 2]),
      });
    }
  }
  // Each hole size once, its text off to the upper right of the first such hole.
  const sizes = new Set<string>();
  for (const f of holes) {
    const k = f.circle!.r.toFixed(3);
    if (sizes.has(k)) continue;
    sizes.add(k);
    const c = paper(f.circle!.c);
    const r = f.circle!.r * frame.scale;
    out.push({ type: 'diameter', refs: [refOf(f, 'edge')], at: rel([c[0] + r + 8, c[1] + r + 6]) });
  }
  return out;
}
