/**
 * CR3a (docs/cad/car-design.md, 86M5): a chain of sketch elements moved sideways by a distance in
 * its plane, as new elements. Lines stay lines and arcs stay arcs about the same centre; a spline
 * is sampled, moved along its normal and fitted again as a spline of its degree. Neighbours are
 * extended (or cut back) to where they meet, so a corner stays a corner; where two moved
 * neighbours no longer meet on the outside of a corner, an arc about the corner joins them. A
 * result that crosses itself, loses an element or turns a loop inside out is refused
 * (`sketch-offset-self-intersects`). Pure: the same sketch, elements and distance always give the
 * same result.
 */
import { deBoor, fullSpline } from './bspline';
import { cadLimits } from './model';
import {
  cadSketchLimits,
  CadSketchError,
  sketchElement,
  sketchElementPoints,
  sketchPath,
  splinePoints,
  splineSelfIntersects,
  splineThrough,
  type CadSketch,
  type CadSketchEntity,
  type SketchPathGeometry,
} from './sketch';

type Pt = [number, number];

export const cadSketchOffsetLimits = Object.freeze({
  /** The distance's size (mm); its sign picks the side. */
  distanceMm: [0.1, 200] as const,
  /** How far a fitted spline may stray from the exact offset curve (mm). */
  fitMm: 0.01,
  /** Samples per knot span of a spline, for its offset curve. */
  samplesPerSpan: 64,
  /** A corner is looked for within this many times the distance of the original corner. */
  cornerReach: 50,
});

/**
 * One element of an offset. Neighbours share end points exactly (`to` of one is `from` of the
 * next, and of the first in a closed chain). `center` names an existing point of the sketch: the
 * centre of the arc or circle it was moved from, or the corner an added joining arc goes round.
 */
type PieceShape =
  | { type: 'line'; from: Pt; to: Pt; construction: boolean }
  | { type: 'arc'; center: string; from: Pt; to: Pt; clockwise: boolean; construction: boolean }
  | { type: 'spline'; poles: Pt[]; degree: 2 | 3 | 5; construction: boolean }
  | { type: 'circle'; center: string; radius: number; construction: boolean }
  | { type: 'closedSpline'; poles: Pt[]; degree: 2 | 3 | 5; construction: boolean };
export type SketchOffsetPiece = PieceShape & {
  /** The element it was moved from, or the corner point a joining arc goes round. */
  source: string;
};
export interface SketchOffset {
  pieces: SketchOffsetPiece[];
  /** The last piece ends where the first starts. */
  closed: boolean;
}

/** One selected element in chain order, walked from `from` to `to`. */
interface Link {
  id: string;
  forward: boolean;
}

/**
 * The selected elements in chain order: lines, arcs and open splines joined end to end at shared
 * point IDs, without a branch or a gap, open or closed; or one circle or closed spline alone. An
 * open chain runs the way its first selected element runs; a closed one starts there.
 */
export function sketchOffsetChain(
  s: CadSketch,
  ids: readonly string[],
): { links: Link[]; closed: boolean } | undefined {
  const unique = [...new Set(ids)];
  if (!unique.length) return undefined;
  const entities = unique.map((id) => s.entities.find((e) => e.id === id));
  if (entities.some((e) => !e || e.type === 'point')) return undefined;
  const alone = entities.filter((e) => e!.type === 'circle' || (e!.type === 'spline' && e!.closed));
  if (alone.length)
    return unique.length === 1
      ? { links: [{ id: unique[0]!, forward: true }], closed: true }
      : undefined;
  const ends = new Map<string, [string, string]>();
  for (const e of entities) {
    if (e!.type === 'line' || e!.type === 'arc') ends.set(e!.id, [e!.start, e!.end]);
    else if (e!.type === 'spline') ends.set(e!.id, [e!.poles[0]!, e!.poles.at(-1)!]);
  }
  const at = new Map<string, string[]>();
  for (const [id, pair] of ends) for (const p of pair) at.set(p, [...(at.get(p) ?? []), id]);
  if ([...at.values()].some((x) => x.length > 2)) return undefined;
  if ([...ends.values()].some(([a, b]) => a === b)) return undefined;
  const loose = [...at.entries()].filter(([, x]) => x.length === 1).map(([p]) => p);
  if (loose.length !== 0 && loose.length !== 2) return undefined;
  const closed = loose.length === 0;
  const walk = (start: string, first: string): Link[] => {
    const links: Link[] = [];
    let point = start;
    let id: string | undefined = first;
    while (id && links.length < ends.size) {
      const [a, b] = ends.get(id)!;
      const forward = a === point;
      links.push({ id, forward });
      point = forward ? b : a;
      id = at.get(point)!.find((x) => x !== id);
      if (closed && id === first) break;
    }
    return links;
  };
  const head = unique[0]!;
  let links: Link[];
  if (closed) links = walk(ends.get(head)![0], head);
  else {
    const p = loose[0]!;
    links = walk(p, at.get(p)![0]!);
    const own = links.find((l) => l.id === head)!;
    if (own && !own.forward)
      links = links.reverse().map((l) => ({ id: l.id, forward: !l.forward }));
  }
  if (links.length !== ends.size) return undefined;
  // The selected chain itself must not cross or touch itself.
  if (links.length > 1 || !closed) {
    const g = sketchPath(
      s,
      links.map((l) => l.id),
      closed ? 'allow' : 'refuse',
    );
    if ('code' in g) return undefined;
  }
  return { links, closed };
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const addv = (a: Pt, b: Pt, k = 1): Pt => [a[0] + k * b[0], a[1] + k * b[1]];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const dist = (a: Pt, b: Pt) => len(sub(a, b));
const unit = (a: Pt): Pt => {
  const l = len(a);
  return [a[0] / l, a[1] / l];
};
const left = (a: Pt): Pt => [-a[1], a[0]];
const crossv = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dotv = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const turn = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const polygonArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [p, q] = [pts[i]!, pts[(i + 1) % pts.length]!];
    a += (p[0] * q[1] - p[1] * q[0]) / 2;
  }
  return a;
};

/**
 * An element moved sideways along its walk. `shift` is the signed distance to the left of the
 * walk. Each knows its moved ends and the directions there, and how to meet a neighbour.
 */
type Moved =
  | { type: 'line'; id: string; from: Pt; to: Pt; dir: Pt; construction: boolean }
  | {
      type: 'arc';
      id: string;
      center: string;
      c: Pt;
      r: number;
      /** Signed sweep along the walk, counter-clockwise positive. */
      sweep: number;
      from: Pt;
      to: Pt;
      construction: boolean;
    }
  | {
      type: 'spline';
      id: string;
      degree: 2 | 3 | 5;
      poles: number;
      /** The moved curve, sampled along the walk. */
      pts: Pt[];
      from: Pt;
      to: Pt;
      construction: boolean;
    };
const startDir = (m: Moved): Pt =>
  m.type === 'line'
    ? m.dir
    : m.type === 'arc'
      ? unit(m.sweep > 0 ? left(sub(m.from, m.c)) : left(sub(m.c, m.from)))
      : unit(sub(m.pts[1]!, m.pts[0]!));
const endDir = (m: Moved): Pt =>
  m.type === 'line'
    ? m.dir
    : m.type === 'arc'
      ? unit(m.sweep > 0 ? left(sub(m.to, m.c)) : left(sub(m.c, m.to)))
      : unit(sub(m.pts.at(-1)!, m.pts.at(-2)!));

/** A spline's point at `t` (0 to its number of knot spans), its knots built once. */
function curveAt(poles: readonly Pt[], degree: number, closed: boolean) {
  const { cps, knots } = fullSpline(degree, closed, poles);
  const spans = closed ? poles.length : poles.length - degree;
  return (t: number): Pt => {
    const u = closed ? turnSpan(t, spans) : Math.max(0, Math.min(spans, t));
    return deBoor(cps, knots, degree, degree + Math.min(Math.floor(u), spans - 1), u);
  };
}

/**
 * The moved samples of a spline, along the walk, `shift` to its left: 64 per knot span, doubled
 * (to 4,096) until each chord strays from the moved curve by a tenth of the fit at most.
 */
function movedSpline(
  poles: Pt[],
  degree: number,
  closed: boolean,
  forward: boolean,
  shift: number,
): Pt[] {
  const spans = closed ? poles.length : poles.length - degree;
  const point = curveAt(poles, degree, closed);
  const h = 1e-6;
  const sample = (t: number): [Pt, Pt] => {
    const [t0, t1] = closed ? [t - h, t + h] : [Math.max(0, t - h), Math.min(spans, t + h)];
    const d = sub(point(t1), point(t0));
    const l = len(d);
    if (!(l > 0)) throw new CadSketchError('sketch-offset-self-intersects', '');
    // The left of the curve's own direction; a walk against it has the other left.
    const p = point(t);
    return [p, addv(p, left([d[0] / l, d[1] / l]), forward ? shift : -shift)];
  };
  for (let per = cadSketchOffsetLimits.samplesPerSpan; ; per *= 2) {
    const n = spans * per;
    const out: Pt[] = [];
    const src: Pt[] = [];
    for (let i = 0; i <= (closed ? n - 1 : n); i++) {
      const [p, q] = sample((spans * i) / n);
      src.push(p);
      out.push(q);
    }
    // Moved further than the curve's radius on its inner side, the moved curve runs backwards
    // (a swallowtail, or a loop that has passed through its collapse): refused.
    const m = closed ? out.length : out.length - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % out.length;
      if (dotv(sub(out[j]!, out[i]!), sub(src[j]!, src[i]!)) <= 0)
        throw new CadSketchError('sketch-offset-self-intersects', '');
    }
    // A chord's sagitta is about a quarter of the middle point's distance from its neighbours'.
    let worst = 0;
    for (let i = 1; i + 1 < out.length; i++)
      worst = Math.max(worst, segmentDistance(out[i - 1]!, out[i + 1]!, out[i]!) / 4);
    if (worst <= cadSketchOffsetLimits.fitMm / 10 || per >= 4096)
      return forward ? out : out.reverse();
  }
}
const turnSpan = (t: number, spans: number) => ((t % spans) + spans) % spans;

/** Cumulative lengths along a polyline. */
function lengths(pts: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  return out;
}
/** The point at arc length `d` along a polyline with cumulative lengths `cum`. */
function along(pts: Pt[], cum: number[], d: number): Pt {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi]! - cum[lo]!;
  const f = span > 0 ? (d - cum[lo]!) / span : 0;
  return addv(pts[lo]!, sub(pts[hi]!, pts[lo]!), f);
}
function segmentDistance(a: Pt, b: Pt, p: Pt): number {
  const d = sub(b, a);
  const l2 = dotv(d, d);
  const t = l2 ? Math.max(0, Math.min(1, dotv(sub(p, a), d) / l2)) : 0;
  return dist(p, addv(a, d, t));
}

/**
 * A spline of `degree` through a polyline (open from its first to its last point, or closed):
 * as few poles as fit it within `fitMm`, from `start` poles doubling to 256. The points the fit
 * passes through sit at the poles' Greville abscissae by arc length.
 */
function fitSpline(pts: Pt[], degree: 2 | 3 | 5, closed: boolean, start: number): Pt[] {
  const ring = closed ? [...pts, pts[0]!] : pts;
  const cum = lengths(ring);
  const total = cum.at(-1)!;
  const max = cadSketchLimits.splinePoles[1];
  let n = Math.max(start, degree + 1, 4);
  for (;;) {
    const spans = closed ? n : n - degree;
    const greville = (i: number) => {
      if (closed) return turnSpan(i - (degree - 1) / 2, n) / n;
      // Clamped uniform knots: 0 (×degree+1), 1, …, spans (×degree+1).
      let sum = 0;
      for (let k = i + 1; k <= i + degree; k++) sum += Math.min(Math.max(k - degree, 0), spans);
      return sum / degree / spans;
    };
    const through = Array.from({ length: n }, (_, i) => along(ring, cum, greville(i) * total));
    if (!closed) {
      through[0] = [...pts[0]!];
      through[n - 1] = [...pts.at(-1)!];
    }
    const poles = splineThrough(through, degree, closed);
    const fitted = curveAt(poles, degree, closed);
    // The fitted curve's samples against the polyline, near the same arc length.
    let worst = 0;
    const samples = spans * 16;
    let cursor = 0;
    const step = Math.ceil(ring.length / samples);
    for (let k = 0; k <= samples; k++) {
      const q = fitted((spans * k) / samples);
      let best = Infinity;
      let bestAt = cursor;
      const lo = Math.max(1, cursor - step - 64);
      const hi = Math.min(ring.length - 1, cursor + 4 * step + 64);
      for (let i = lo; i <= hi; i++) {
        const d = segmentDistance(ring[i - 1]!, ring[i]!, q);
        if (d < best) {
          best = d;
          bestAt = i;
        }
      }
      cursor = bestAt;
      worst = Math.max(worst, best);
    }
    if (worst <= cadSketchOffsetLimits.fitMm) return poles;
    if (n >= max) throw new CadSketchError('sketch-offset-fit', '');
    n = Math.min(max, n * 2);
  }
}

/** Points where a line through `p` along `d` crosses a circle. */
function lineCircle(p: Pt, d: Pt, c: Pt, r: number): Pt[] {
  const u = unit(d);
  const t0 = dotv(sub(c, p), u);
  const foot = addv(p, u, t0);
  const h = dist(foot, c);
  if (h > r) return [];
  const half = Math.sqrt(Math.max(0, r * r - h * h));
  return [addv(foot, u, -half), addv(foot, u, half)];
}
function circleCircle(a: Pt, ra: number, b: Pt, rb: number): Pt[] {
  const d = dist(a, b);
  if (d <= 0 || d > ra + rb || d < Math.abs(ra - rb)) return [];
  const x = (d * d + ra * ra - rb * rb) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - x * x));
  const u = unit(sub(b, a));
  const base = addv(a, u, x);
  return [addv(base, left(u), h), addv(base, left(u), -h)];
}
function segmentLine(a: Pt, b: Pt, p: Pt, d: Pt): Pt | undefined {
  const r = sub(b, a);
  const den = crossv(r, d);
  if (Math.abs(den) <= 1e-15 * len(r) * len(d)) return undefined;
  const t = crossv(sub(p, a), d) / den;
  return t >= 0 && t <= 1 ? addv(a, r, t) : undefined;
}
function segmentSegment(a: Pt, b: Pt, c: Pt, e: Pt): Pt | undefined {
  const r = sub(b, a);
  const q = sub(e, c);
  const den = crossv(r, q);
  if (Math.abs(den) <= 1e-15 * len(r) * len(q)) return undefined;
  const w = sub(c, a);
  const t = crossv(w, q) / den;
  const u = crossv(w, r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? addv(a, r, t) : undefined;
}
function segmentCircle(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const l = dist(a, b);
  if (!(l > 0)) return [];
  return lineCircle(a, sub(b, a), c, r).filter(
    (p) => dotv(sub(p, a), sub(b, a)) >= 0 && dotv(sub(p, b), sub(a, b)) >= 0,
  );
}

/** A moved element as something to meet: a full line, a full circle, or a polyline with rays. */
type Carrier =
  | { type: 'line'; p: Pt; d: Pt }
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'polyline'; pts: Pt[] };
function carrier(m: Moved, reach: number): Carrier {
  if (m.type === 'line') return { type: 'line', p: m.from, d: m.dir };
  if (m.type === 'arc') return { type: 'circle', c: m.c, r: m.r };
  // A spline extends along its end tangents (the corner may lie beyond its end).
  const pts = [addv(m.from, startDir(m), -reach), ...m.pts, addv(m.to, endDir(m), reach)];
  return { type: 'polyline', pts };
}
function meet(x: Carrier, y: Carrier, near: Pt, reach: number): Pt[] {
  if (x.type === 'polyline' || y.type === 'polyline') {
    const [poly, other] = (x.type === 'polyline' ? [x, y] : [y, x]) as [
      Extract<Carrier, { type: 'polyline' }>,
      Carrier,
    ];
    const close = (a: Pt, b: Pt) => segmentDistance(a, b, near) <= reach;
    const out: Pt[] = [];
    const segs = (pts: Pt[]) =>
      pts.slice(1).flatMap((b, i) => (close(pts[i]!, b) ? [[pts[i]!, b] as const] : []));
    const mine = segs(poly.pts);
    if (other.type === 'line') {
      for (const [a, b] of mine) {
        const hit = segmentLine(a, b, other.p, other.d);
        if (hit) out.push(hit);
      }
    } else if (other.type === 'circle') {
      for (const [a, b] of mine) out.push(...segmentCircle(a, b, other.c, other.r));
    } else {
      const theirs = segs(other.pts);
      for (const [a, b] of mine)
        for (const [c, e] of theirs) {
          const hit = segmentSegment(a, b, c, e);
          if (hit) out.push(hit);
        }
    }
    return out;
  }
  if (x.type === 'line' && y.type === 'line') {
    const den = crossv(x.d, y.d);
    if (Math.abs(den) <= 1e-12) return [];
    const t = crossv(sub(y.p, x.p), y.d) / den;
    return [addv(x.p, x.d, t)];
  }
  if (x.type === 'line' && y.type === 'circle') return lineCircle(x.p, x.d, y.c, y.r);
  if (x.type === 'circle' && y.type === 'line') return lineCircle(y.p, y.d, x.c, x.r);
  const [a, b] = [x, y] as Extract<Carrier, { type: 'circle' }>[];
  return circleCircle(a.c, a.r, b.c, b.r);
}

/** Where along a polyline (as a length from its start, rays included) the point `p` lies. */
function locate(pts: Pt[], cum: number[], p: Pt): number {
  let best = Infinity;
  let at = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = segmentDistance(pts[i - 1]!, pts[i]!, p);
    if (d < best) {
      best = d;
      const seg = sub(pts[i]!, pts[i - 1]!);
      const l = len(seg);
      at = cum[i - 1]! + (l ? Math.max(0, Math.min(l, dotv(sub(p, pts[i - 1]!), seg) / l)) : 0);
    }
  }
  return at;
}

/** The offset's pieces, before the whole result is checked (`sketchWithOffset`). */
function offsetPieces(s: CadSketch, ids: readonly string[], distance: number): SketchOffset {
  const [lo, hi] = cadSketchOffsetLimits.distanceMm;
  if (!(Math.abs(distance) >= lo && Math.abs(distance) <= hi))
    throw new CadSketchError('sketch-offset-distance', s.id);
  const chain = sketchOffsetChain(s, ids);
  if (!chain) throw new CadSketchError('sketch-offset-chain', s.id);
  const refuse = () => new CadSketchError('sketch-offset-self-intersects', s.id);
  const min = cadLimits.minDimensionMm;
  const entity = (id: string) => s.entities.find((e) => e.id === id)!;
  const construction = (id: string) => !!(entity(id) as { construction?: boolean }).construction;

  // A loop alone: a circle grows by the distance, a closed spline moves outward.
  const [only] = chain.links;
  const lone = entity(only!.id);
  if (lone.type === 'circle') {
    const radius = s.solved[lone.id]![0] + distance;
    if (!(radius >= min)) throw refuse();
    return {
      pieces: [
        {
          type: 'circle',
          center: lone.center,
          radius,
          construction: construction(lone.id),
          source: lone.id,
        },
      ],
      closed: true,
    };
  }
  if (lone.type === 'spline' && lone.closed) {
    const poles = lone.poles.map((p) => s.solved[p] as Pt);
    const g = sketchElement(s, lone.id)!;
    const ccw = polygonArea((g as { pts: Pt[] }).pts) > 0;
    const pts = movedSpline(poles, lone.degree, true, true, ccw ? -distance : distance);
    if (Math.sign(polygonArea(pts)) !== (ccw ? 1 : -1)) throw refuse();
    const fitted = fitSpline(pts, lone.degree, true, poles.length);
    const piece: SketchOffsetPiece = {
      type: 'closedSpline',
      poles: fitted,
      degree: lone.degree,
      construction: construction(lone.id),
      source: lone.id,
    };
    if (splineSelfIntersects(closedGeometry(fitted, lone.degree))) throw refuse();
    return { pieces: [piece], closed: true };
  }

  // Which way is left: out of a closed chain for a positive distance.
  let shift = distance;
  if (chain.closed) {
    const ring = chain.links.flatMap((l) => walkPoints(s, l));
    if (polygonArea(ring) > 0) shift = -distance;
  }

  const moved: Moved[] = chain.links.map((l) => moveLink(s, l, shift, construction(l.id)));
  const reach = cadSketchOffsetLimits.cornerReach * Math.abs(distance);
  // Each joint's corner: where the moved neighbours meet nearest the original joint.
  type Joint = { at: Pt } | { arc: { center: string; clockwise: boolean } };
  const joints: (Joint & { at?: Pt })[] = [];
  const count = chain.closed ? moved.length : moved.length - 1;
  for (let i = 0; i < count; i++) {
    const [x, y] = [moved[i]!, moved[(i + 1) % moved.length]!];
    const link = chain.links[i]!;
    const pid = jointPoint(s, link);
    const p = s.solved[pid] as Pt;
    if (dist(x.to, y.from) <= Math.max(min, 1e-9 * Math.abs(distance))) {
      joints.push({ at: [(x.to[0] + y.from[0]) / 2, (x.to[1] + y.from[1]) / 2] });
      continue;
    }
    const hits = meet(carrier(x, reach), carrier(y, reach), p, reach)
      .filter((q) => dist(q, p) <= reach)
      .sort((a, b) => dist(a, p) - dist(b, p));
    const turnSign = Math.sign(crossv(endDir(x), startDir(y)));
    // Outside a corner (moved away from the way it turns) the moved ends part; inside, they cross.
    const outside = turnSign * Math.sign(shift) < 0;
    if (hits[0]) joints.push({ at: hits[0] });
    else if (outside) joints.push({ arc: { center: pid, clockwise: turnSign < 0 } });
    else throw refuse();
  }

  const pieces: SketchOffsetPiece[] = [];
  moved.forEach((m, i) => {
    const before = i === 0 ? (chain.closed ? joints.at(-1) : undefined) : joints[i - 1];
    const after = joints[i];
    const from: Pt = before && 'at' in before ? before.at! : m.from;
    const to: Pt = after && 'at' in after ? after.at! : m.to;
    pieces.push({ ...trimmed(m, from, to, refuse), source: m.id });
    if (after && 'arc' in after) {
      const next = moved[(i + 1) % moved.length]!;
      pieces.push({
        type: 'arc',
        center: after.arc.center,
        from: to,
        to: next.from,
        clockwise: after.arc.clockwise,
        construction: m.construction,
        source: after.arc.center,
      });
    }
  });
  // Neighbours share their ends exactly.
  for (let i = 0; i < pieces.length; i++) {
    const next = pieces[(i + 1) % pieces.length]!;
    if (i === pieces.length - 1 && !chain.closed) break;
    setFrom(next, pieceTo(pieces[i]!));
  }
  return { pieces, closed: chain.closed };
}

/**
 * The chain `ids` of `s` moved `distance` mm sideways: to the left of an open chain as its first
 * selected element runs, out of a closed one (a negative distance: right, in). Throws
 * `CadSketchError`: `sketch-offset-chain` for a selection that is not one chain,
 * `sketch-offset-distance` for a distance out of range, `sketch-offset-self-intersects` for a
 * result that crosses or touches itself, loses or reverses an element or turns its loop the other
 * way, `sketch-offset-fit` for a spline that 256 poles cannot fit.
 */
export function sketchOffset(s: CadSketch, ids: readonly string[], distance: number): SketchOffset {
  return sketchWithOffset(s, ids, distance).offset;
}

/**
 * `sketchOffset` added to `s` as new elements without constraints, neighbours joined at new
 * shared points and an arc or circle about its source's centre point; `newId` names each new
 * point (`p`), line (`l`), arc (`a`), circle (`c`) and spline (`sp`), by default the first free
 * `<prefix><n>`. The result is checked as a chain (a construction one too). Returns the sketch,
 * the new elements' IDs in chain order and the offset.
 */
export function sketchWithOffset(
  s: CadSketch,
  ids: readonly string[],
  distance: number,
  newId: (s: CadSketch, prefix: string) => string = freeId,
): { sketch: CadSketch; ids: string[]; offset: SketchOffset } {
  const offset = offsetPieces(s, ids, distance);
  const original = s;
  const added: string[] = [];
  let first: string | undefined;
  let previous: string | undefined;
  const point = (at: [number, number]) => {
    const id = newId(s, 'p');
    s = {
      ...s,
      entities: [...s.entities, { type: 'point', id }],
      solved: { ...s.solved, [id]: [at[0], at[1]] },
    };
    return id;
  };
  const push = (e: CadSketchEntity) => {
    s = { ...s, entities: [...s.entities, e] };
    added.push(e.id);
  };
  const flag = (construction: boolean) => (construction ? { construction } : {});
  offset.pieces.forEach((p, i) => {
    if (p.type === 'circle') {
      const id = newId(s, 'c');
      push({ type: 'circle', id, center: p.center, ...flag(p.construction) });
      s = { ...s, solved: { ...s.solved, [id]: [p.radius, 0] } };
      return;
    }
    if (p.type === 'closedSpline') {
      const poles = p.poles.map(point);
      const id = newId(s, 'sp');
      push({ type: 'spline', id, poles, degree: p.degree, closed: true, ...flag(p.construction) });
      return;
    }
    const last = i === offset.pieces.length - 1;
    const ends = p.type === 'spline' ? [p.poles[0]!, p.poles.at(-1)!] : [p.from, p.to];
    const start = previous ?? point(ends[0]!);
    first ??= start;
    const inner = p.type === 'spline' ? p.poles.slice(1, -1).map(point) : [];
    const end = last && offset.closed ? first : point(ends[1]!);
    previous = end;
    if (p.type === 'line') {
      const id = newId(s, 'l');
      push({ type: 'line', id, start, end, ...flag(p.construction) });
    } else if (p.type === 'arc') {
      const id = newId(s, 'a');
      push({
        type: 'arc',
        id,
        center: p.center,
        start,
        end,
        clockwise: p.clockwise,
        ...flag(p.construction),
      });
    } else {
      const id = newId(s, 'sp');
      push({
        type: 'spline',
        id,
        poles: [start, ...inner, end],
        degree: p.degree,
        ...flag(p.construction),
      });
    }
  });
  const refuse = () => new CadSketchError('sketch-offset-self-intersects', s.id);
  for (const id of added) {
    const g = sketchElement(s, id);
    if (g && splineSelfIntersects(g)) throw refuse();
  }
  const chained = added.length > 1 || !offset.closed;
  // The chain's geometry alone (construction elements too, which a region would not take).
  const after = chained ? sketchPath(s, added, offset.closed ? 'allow' : 'refuse') : undefined;
  if (after && 'code' in after) throw refuse();
  if (after && offset.closed) {
    // The source loop in the same walk: the offset must turn the same way round.
    const links = sketchOffsetChain(original, ids)!.links.map((l) => l.id);
    const before = sketchPath(original, links, 'allow');
    if ('code' in before || Math.sign(pathArea(after)) !== Math.sign(pathArea(before)))
      throw refuse();
  }
  return { sketch: s, ids: added, offset };
}

/** Signed area of a closed path's polygon in its walk (counter-clockwise positive). */
function pathArea(g: SketchPathGeometry): number {
  const pts = g.elements.flatMap((e, i) => {
    const p = sketchElementPoints(e);
    return (g.forward[i] ? p : [...p].reverse()).slice(0, -1);
  });
  return pts.reduce((a, p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return a + (p[0] * q[1] - p[1] * q[0]) / 2;
  }, 0);
}

function freeId(s: CadSketch, prefix: string): string {
  const used = new Set([...s.entities.map((e) => e.id), ...s.constraints.map((k) => k.id)]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const pieceTo = (p: SketchOffsetPiece): Pt =>
  p.type === 'spline' ? p.poles.at(-1)! : 'to' in p ? p.to : [0, 0];
function setFrom(p: SketchOffsetPiece, at: Pt) {
  if (p.type === 'spline') p.poles[0] = at;
  else if ('from' in p) p.from = at;
}

function closedGeometry(poles: Pt[], degree: number) {
  const pts = splinePoints(poles, degree, true);
  return { type: 'closedSpline', id: '', ends: [], degree, poles, pts } as unknown as Parameters<
    typeof splineSelfIntersects
  >[0];
}

/** The point a link ends at (the joint with the next link). */
function jointPoint(s: CadSketch, l: Link): string {
  const e = s.entities.find((x) => x.id === l.id)!;
  const [a, b] =
    e.type === 'line' || e.type === 'arc'
      ? [e.start, e.end]
      : e.type === 'spline'
        ? [e.poles[0]!, e.poles.at(-1)!]
        : ['', ''];
  return l.forward ? b : a;
}
/** Points along a link in walk order, without its last (the next link's first). */
function walkPoints(s: CadSketch, l: Link): Pt[] {
  const pts = sketchElementPoints(sketchElement(s, l.id)!);
  return (l.forward ? pts : [...pts].reverse()).slice(0, -1);
}

function moveLink(s: CadSketch, l: Link, shift: number, construction: boolean): Moved {
  const g = sketchElement(s, l.id)!;
  if (g.type === 'line') {
    const [a, b] = l.forward ? [g.a, g.b] : [g.b, g.a];
    const dir = unit(sub(b, a));
    const n = left(dir);
    return {
      type: 'line',
      id: l.id,
      from: addv(a, n, shift),
      to: addv(b, n, shift),
      dir,
      construction,
    };
  }
  if (g.type === 'arc') {
    const e = s.entities.find((x) => x.id === l.id) as { center: string };
    const sweep = l.forward ? g.sweep : -g.sweep;
    // Left of a counter-clockwise walk is towards the centre.
    const r = g.r - Math.sign(sweep) * shift;
    if (!(r >= cadLimits.minDimensionMm))
      throw new CadSketchError('sketch-offset-self-intersects', s.id);
    const [a, b] = l.forward ? [g.a, g.b] : [g.b, g.a];
    const onto = (p: Pt) => addv(g.c, unit(sub(p, g.c)), r);
    return {
      type: 'arc',
      id: l.id,
      center: e.center,
      c: g.c,
      r,
      sweep,
      from: onto(a),
      to: onto(b),
      construction,
    };
  }
  if (g.type === 'spline') {
    const pts = movedSpline(g.poles, g.degree, false, l.forward, shift);
    return {
      type: 'spline',
      id: l.id,
      degree: g.degree as 2 | 3 | 5,
      poles: g.poles.length,
      pts,
      from: pts[0]!,
      to: pts.at(-1)!,
      construction,
    };
  }
  throw new CadSketchError('sketch-offset-chain', s.id);
}

/** A moved element cut back or extended to run from `from` to `to`. */
function trimmed(m: Moved, from: Pt, to: Pt, refuse: () => Error): PieceShape {
  const min = cadLimits.minDimensionMm;
  if (m.type === 'line') {
    // It must still run its own way, with a length.
    if (!(dotv(sub(to, from), m.dir) >= min)) throw refuse();
    return { type: 'line', from, to, construction: m.construction };
  }
  if (m.type === 'arc') {
    const angle = (p: Pt) => Math.atan2(p[1] - m.c[1], p[0] - m.c[0]);
    const [a0, a1] = [angle(from), angle(to)];
    const sweep = m.sweep > 0 ? turn(a1 - a0) : -turn(a0 - a1);
    if (!(Math.abs(sweep) * m.r >= min) || Math.abs(sweep - m.sweep) >= Math.PI) throw refuse();
    return {
      type: 'arc',
      center: m.center,
      from,
      to,
      clockwise: m.sweep < 0,
      construction: m.construction,
    };
  }
  // A spline: the part of its moved curve (with its end tangents' rays) between the corners.
  const reach = Math.max(dist(from, m.from), dist(to, m.to)) * 2 + 1;
  const pts = [addv(m.from, startDir(m), -reach), ...m.pts, addv(m.to, endDir(m), reach)];
  const cum = lengths(pts);
  const [s0, s1] = [locate(pts, cum, from), locate(pts, cum, to)];
  if (!(s1 - s0 >= min)) throw refuse();
  const part: Pt[] = [from];
  for (let i = 0; i < pts.length; i++) if (cum[i]! > s0 && cum[i]! < s1) part.push(pts[i]!);
  part.push(to);
  const poles = fitSpline(part, m.degree, false, m.poles);
  poles[0] = from;
  poles[poles.length - 1] = to;
  return { type: 'spline', poles, degree: m.degree, construction: m.construction };
}
