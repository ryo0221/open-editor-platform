import type { BimLoop, Vec2 } from './model';

/** Pure 2D helpers for plan loops. Arcs are exact for areas, lengths, simplicity and containment. */

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const length = (a: Vec2) => Math.hypot(a[0], a[1]);
export const distance = (a: Vec2, b: Vec2) => length(sub(a, b));
/** The vector turned 90° counter-clockwise. */
export const left = (a: Vec2): Vec2 => [-a[1], a[0]];
export const unit = (a: Vec2): Vec2 => scale(a, 1 / length(a));

/** Intersection of two infinite lines `p + t·d`, or undefined when parallel. */
export function lineIntersection(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | undefined {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12 * length(d) * length(e)) return undefined;
  const t = cross(sub(q, p), e) / den;
  return add(p, scale(d, t));
}

/** Circular arc from `p` to `q` with bulge `b` (tan of a quarter of the signed sweep). */
export function arcOf(p: Vec2, q: Vec2, b: number) {
  const sweep = 4 * Math.atan(b);
  const chord = sub(q, p);
  const c = length(chord);
  const radius = c / (2 * Math.abs(Math.sin(sweep / 2)));
  const mid = scale(add(p, q), 0.5);
  const center = add(mid, scale(left(unit(chord)), c / 2 / Math.tan(sweep / 2)));
  const startAngle = Math.atan2(p[1] - center[1], p[0] - center[0]);
  return { center, radius, sweep, startAngle };
}
export function arcPoint(arc: ReturnType<typeof arcOf>, t: number): Vec2 {
  const a = arc.startAngle + arc.sweep * t;
  return [arc.center[0] + arc.radius * Math.cos(a), arc.center[1] + arc.radius * Math.sin(a)];
}

const edge = (loop: BimLoop, i: number) => {
  const a = loop[i];
  const b = loop[(i + 1) % loop.length];
  return { p: [a[0], a[1]] as Vec2, q: [b[0], b[1]] as Vec2, bulge: a[2] ?? 0 };
};

/** Signed area, counter-clockwise positive, exact along arcs. */
export function loopArea(loop: BimLoop): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const { p, q, bulge } = edge(loop, i);
    area += cross(p, q) / 2;
    if (bulge) {
      const { radius, sweep } = arcOf(p, q, bulge);
      area += (radius * radius * (sweep - Math.sin(sweep))) / 2;
    }
  }
  return area;
}
export function loopPerimeter(loop: BimLoop): number {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const { p, q, bulge } = edge(loop, i);
    total += bulge ? arcOf(p, q, bulge).radius * Math.abs(4 * Math.atan(bulge)) : distance(p, q);
  }
  return total;
}
/** The loop as a polygon, each arc split into `perArc` straight pieces. */
export function sampleLoop(loop: BimLoop, perArc = 16): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const { p, q, bulge } = edge(loop, i);
    out.push(p);
    if (bulge) {
      const arc = arcOf(p, q, bulge);
      for (let k = 1; k < perArc; k++) out.push(arcPoint(arc, k / perArc));
    }
  }
  return out;
}

const bboxOf = (a: Vec2, b: Vec2) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
];
/** Whether closed segments ab and cd touch or cross. */
export function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps = 1e-9): boolean {
  const [ax0, ay0, ax1, ay1] = bboxOf(a, b);
  const [cx0, cy0, cx1, cy1] = bboxOf(c, d);
  if (ax1 < cx0 - eps || cx1 < ax0 - eps || ay1 < cy0 - eps || cy1 < ay0 - eps) return false;
  const o1 = cross(sub(b, a), sub(c, a));
  const o2 = cross(sub(b, a), sub(d, a));
  const o3 = cross(sub(d, c), sub(a, c));
  const o4 = cross(sub(d, c), sub(b, c));
  const s = (v: number) => (Math.abs(v) <= eps * (1 + Math.abs(v)) ? 0 : Math.sign(v));
  if (s(o1) * s(o2) < 0 && s(o3) * s(o4) < 0) return true;
  // Touching or collinear overlap: an endpoint on the other segment.
  const on = (p: Vec2, q: Vec2, r: Vec2, o: number) =>
    s(o) === 0 &&
    r[0] >= Math.min(p[0], q[0]) - eps &&
    r[0] <= Math.max(p[0], q[0]) + eps &&
    r[1] >= Math.min(p[1], q[1]) - eps &&
    r[1] <= Math.max(p[1], q[1]) + eps;
  return on(a, b, c, o1) || on(a, b, d, o2) || on(c, d, a, o3) || on(c, d, b, o4);
}

/** A polygon (no repeated closing vertex) whose non-adjacent sides never touch. */
export function polygonSimple(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (distance(a, b) <= 1e-9) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsTouch(a, b, poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}
/** Whether two polygons' sides touch or cross anywhere. */
export function polygonsTouch(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segmentsTouch(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}
/** Point strictly inside a polygon (even-odd). Points on a side count as outside. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}
/** Polygon `inner` lies inside `outer` without touching it. */
export function polygonInside(inner: Vec2[], outer: Vec2[]): boolean {
  return !polygonsTouch(inner, outer) && pointInPolygon(inner[0], outer);
}

type Arc = ReturnType<typeof arcOf>;
/** A loop side: a segment, or an arc when `arc` is set. */
export interface LoopEdge {
  p: Vec2;
  q: Vec2;
  arc?: Arc;
}
export const loopEdges = (loop: BimLoop): LoopEdge[] =>
  loop.map((_, i) => {
    const { p, q, bulge } = edge(loop, i);
    return bulge ? { p, q, arc: arcOf(p, q, bulge) } : { p, q };
  });

/** Whether `x`, a point on the arc's circle, lies within its sweep. */
function onArc(x: Vec2, arc: Arc, eps: number): boolean {
  const turn = Math.atan2(x[1] - arc.center[1], x[0] - arc.center[0]) - arc.startAngle;
  const along = (((turn * Math.sign(arc.sweep)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const slack = eps / arc.radius;
  return along <= Math.abs(arc.sweep) + slack || along >= 2 * Math.PI - slack;
}
/** Points where segment ab meets a circle (a tangent counts once). */
function segmentCircle(a: Vec2, b: Vec2, arc: Arc, eps: number): Vec2[] {
  const d = sub(b, a);
  const len = length(d);
  const u = scale(d, 1 / len);
  const t0 = dot(sub(arc.center, a), u);
  const h = cross(u, sub(arc.center, a));
  if (Math.abs(h) > arc.radius + eps) return [];
  const half = Math.sqrt(Math.max(0, arc.radius * arc.radius - h * h));
  return [t0 - half, t0 + half]
    .filter((t) => t >= -eps && t <= len + eps)
    .map((t) => add(a, scale(u, t)));
}
/** Points where two circles meet; undefined when they coincide. */
function circleCircle(a: Arc, b: Arc, eps: number): Vec2[] | undefined {
  const d = distance(a.center, b.center);
  if (d <= eps) return Math.abs(a.radius - b.radius) <= eps ? undefined : [];
  if (d > a.radius + b.radius + eps || d < Math.abs(a.radius - b.radius) - eps) return [];
  const u = scale(sub(b.center, a.center), 1 / d);
  const along = (d * d + a.radius * a.radius - b.radius * b.radius) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.radius * a.radius - along * along));
  const foot = add(a.center, scale(u, along));
  return [add(foot, scale(left(u), h)), sub(foot, scale(left(u), h))];
}
/** Whether two loop sides touch or cross, exactly along arcs. */
export function edgesTouch(e: LoopEdge, f: LoopEdge, eps = 1e-9): boolean {
  if (!e.arc && !f.arc) return segmentsTouch(e.p, e.q, f.p, f.q, eps);
  if (!e.arc || !f.arc) {
    const [s, c] = e.arc ? [f, e] : [e, f];
    const tol = eps * (1 + c.arc!.radius);
    return segmentCircle(s.p, s.q, c.arc!, tol).some((x) => onArc(x, c.arc!, tol));
  }
  const tol = eps * (1 + Math.max(e.arc.radius, f.arc.radius));
  const points = circleCircle(e.arc, f.arc, tol);
  // On one circle the arcs overlap exactly when an end of one lies on the other.
  if (!points)
    return (
      [e.p, e.q].some((x) => onArc(x, f.arc!, tol)) || [f.p, f.q].some((x) => onArc(x, e.arc!, tol))
    );
  return points.some((x) => onArc(x, e.arc!, tol) && onArc(x, f.arc!, tol));
}
/**
 * Whether consecutive sides `e` (ending at the shared vertex) and `f` (starting there) meet
 * anywhere else. Through the shared vertex a line meets a circle, and two circles meet each
 * other, at most once more, so that second point is found directly.
 */
function adjacentTouch(e: LoopEdge, f: LoopEdge, eps = 1e-9): boolean {
  const v = e.q;
  const tol = (r = 0) => eps * (1 + r + distance(e.p, v) + distance(f.q, v));
  if (!e.arc && !f.arc) {
    const a = sub(e.p, v);
    const b = sub(f.q, v);
    return Math.abs(cross(unit(a), unit(b))) <= eps && dot(a, b) > 0;
  }
  if (!e.arc || !f.arc) {
    const [seg, arc, far] = e.arc ? [f, e.arc, f.q] : [e, f.arc!, e.p];
    const u = unit(sub(far, v));
    const t = 2 * dot(sub(arc.center, v), u);
    const len = distance(seg.p, seg.q);
    return (
      t > tol(arc.radius) &&
      t <= len + tol(arc.radius) &&
      onArc(add(v, scale(u, t)), arc, tol(arc.radius))
    );
  }
  const r = Math.max(e.arc.radius, f.arc.radius);
  const d = sub(f.arc.center, e.arc.center);
  if (length(d) <= tol(r)) return onArc(e.p, f.arc, tol(r)) || onArc(f.q, e.arc, tol(r));
  // The other common point is the shared vertex mirrored in the line of the centres.
  const w = unit(d);
  const rel = sub(v, e.arc.center);
  const x = add(e.arc.center, sub(scale(w, 2 * dot(rel, w)), rel));
  return distance(x, v) > tol(r) && onArc(x, e.arc, tol(r)) && onArc(x, f.arc, tol(r));
}
/** A loop whose sides meet only at their shared vertices, exactly along arcs. */
export function loopEdgesSimple(edges: LoopEdge[]): boolean {
  const n = edges.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    if (distance(edges[i].p, edges[i].q) <= 1e-9) return false;
    if (adjacentTouch(edges[i], edges[(i + 1) % n])) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (edgesTouch(edges[i], edges[j])) return false;
    }
  }
  return true;
}
/** Whether two loops' sides touch or cross anywhere. */
export function loopsTouch(a: LoopEdge[], b: LoopEdge[]): boolean {
  return a.some((e) => b.some((f) => edgesTouch(e, f)));
}
/**
 * Point strictly inside a loop (even-odd), exact along arcs: the polygon of the vertices,
 * toggled by each arc's circular segment between its chord and the arc.
 */
export function pointInLoop(x: Vec2, loop: LoopEdge[]): boolean {
  let inside = pointInPolygon(
    x,
    loop.map((e) => e.p),
  );
  for (const { p, q, arc } of loop) {
    if (!arc || distance(x, arc.center) >= arc.radius) continue;
    const side = Math.sign(cross(sub(q, p), sub(arcPoint(arc, 0.5), p)));
    if (Math.sign(cross(sub(q, p), sub(x, p))) === side) inside = !inside;
  }
  return inside;
}
/**
 * A point of `a` that lies on no arc chord of `b`, where `pointInLoop` cannot tell sides apart.
 * Loops that do not touch have all of `a` on the same side of `b`, so any point of `a` will do.
 */
function probe(a: LoopEdge[], b: LoopEdge[]): Vec2 {
  const chords = b.filter((e) => e.arc);
  const candidates = a.flatMap((e) => [
    e.p,
    e.arc ? arcPoint(e.arc, 0.5) : scale(add(e.p, e.q), 0.5),
  ]);
  const onChord = (x: Vec2) =>
    chords.some(
      ({ p, q }) =>
        Math.abs(cross(unit(sub(q, p)), sub(x, p))) <= 1e-9 * (1 + distance(p, q)) &&
        dot(sub(x, p), sub(x, q)) <= 0,
    );
  return candidates.find((x) => !onChord(x)) ?? candidates[0];
}
/** Whether loops that do not touch nest: `a` inside `b`. */
export const loopWithin = (a: LoopEdge[], b: LoopEdge[]) => pointInLoop(probe(a, b), b);
/** Loop `inner` lies inside `outer` without touching it. */
export function loopInside(inner: LoopEdge[], outer: LoopEdge[]): boolean {
  return !loopsTouch(inner, outer) && loopWithin(inner, outer);
}
