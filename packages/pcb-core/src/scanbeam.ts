import type { Vec2 } from './model';

/**
 * A 2D polygon Boolean by scanbeams (PB4b, PCB-U4). Polygons are tagged with a set number;
 * the plane is cut into horizontal beams at every vertex and every crossing of two edges, so
 * inside a beam no edges cross and the area between two neighbouring edges is a trapezoid.
 * Walking a beam from left to right keeps a winding count per set; `inside` decides from the
 * counts whether a trapezoid belongs to the result. Every polygon is turned counter-clockwise,
 * so a positive count is "inside the union of that set's polygons".
 */

/** A trapezoid of the result: between heights `y0 < y1`, left and right edges at both heights. */
export interface PcbTrapezoid {
  y0: number;
  y1: number;
  xl0: number;
  xr0: number;
  xl1: number;
  xr1: number;
}

export interface PcbTaggedPolygon {
  set: number;
  points: Vec2[];
}

interface Edge {
  set: number;
  /** +1 when crossing it left to right enters the polygon. */
  wind: number;
  ya: number;
  yb: number;
  xa: number;
  /** dx/dy. */
  slope: number;
  /** x at the current beam's bottom (scratch). */
  x: number;
}

const xAt = (e: Edge, y: number) => e.xa + (y - e.ya) * e.slope;

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** Heights closer than this are one height (0.1 nm; the model's tolerance is 1 nm). */
const yEps = 1e-10;
/** Edges this close at a beam's bottom meet there (after a crossing, rounding leaves them apart). */
const xEps = 1e-9;

export function scanbeamBoolean(
  polygons: PcbTaggedPolygon[],
  sets: number,
  inside: (counts: Int32Array) => boolean,
): PcbTrapezoid[] {
  const edges: Edge[] = [];
  const ys: number[] = [];
  for (const poly of polygons) {
    if (poly.points.length < 3) continue;
    const pts = signedArea(poly.points) < 0 ? [...poly.points].reverse() : poly.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (Math.abs(a[1] - b[1]) <= yEps) continue;
      // Counter-clockwise: an edge going down is a left side (entering from the left).
      const down = b[1] < a[1];
      const [lo, hi] = down ? [b, a] : [a, b];
      edges.push({
        set: poly.set,
        wind: down ? 1 : -1,
        ya: lo[1],
        yb: hi[1],
        xa: lo[0],
        slope: (hi[0] - lo[0]) / (hi[1] - lo[1]),
        x: 0,
      });
      ys.push(lo[1], hi[1]);
    }
  }
  if (!edges.length) return [];
  ys.sort((a, b) => a - b);
  const events: number[] = [];
  for (const y of ys) if (!events.length || y - events[events.length - 1] > yEps) events.push(y);
  edges.sort((a, b) => a.ya - b.ya);

  const out: PcbTrapezoid[] = [];
  // A trapezoid between the same two edges as one of the beam below grows instead of a new one.
  let open = new Map<Edge, { t: PcbTrapezoid; right: Edge }>();
  const counts = new Int32Array(sets);
  const active: Edge[] = [];
  let next = 0;
  let k = 0;
  let y0 = events[0];
  while (k < events.length - 1) {
    const yEvent = events[k + 1];
    // Edges starting at or below y0 join; those ended at y0 leave.
    while (next < edges.length && edges[next].ya <= y0 + yEps) active.push(edges[next++]);
    let kept = 0;
    for (const e of active) if (e.yb > y0 + yEps) active[kept++] = e;
    active.length = kept;
    // Order at the bottom (then by the top), and cut the beam at the first crossing.
    let y1 = yEvent;
    for (const e of active) e.x = xAt(e, y0);
    // The order changes little from beam to beam: insertion sort is near linear here.
    for (let i = 1; i < active.length; i++) {
      const e = active[i];
      let j = i - 1;
      // Edges that meet at the bottom (to rounding) are ordered by where they go.
      while (
        j >= 0 &&
        (active[j].x > e.x + xEps ||
          (Math.abs(active[j].x - e.x) <= xEps && active[j].slope > e.slope))
      ) {
        active[j + 1] = active[j];
        j--;
      }
      active[j + 1] = e;
    }
    for (let i = 0; i + 1 < active.length; i++) {
      const a = active[i];
      const b = active[i + 1];
      if (a.slope <= b.slope) continue;
      // a is left at y0 and leans right faster: they meet where the gap closes.
      const gap = b.x - a.x;
      const yc = y0 + gap / (a.slope - b.slope);
      if (yc > y0 + yEps && yc < y1) y1 = yc;
    }
    let inArea = false;
    let left: Edge | undefined;
    const nextOpen = new Map<Edge, { t: PcbTrapezoid; right: Edge }>();
    counts.fill(0);
    for (const e of active) {
      counts[e.set] += e.wind;
      const now = inside(counts);
      if (now && !inArea) left = e;
      else if (!now && inArea && left) {
        const below = open.get(left);
        if (below && below.right === e && below.t.y1 === y0) {
          below.t.y1 = y1;
          below.t.xl1 = xAt(left, y1);
          below.t.xr1 = xAt(e, y1);
          nextOpen.set(left, below);
        } else {
          const t = {
            y0,
            y1,
            xl0: xAt(left, y0),
            xr0: xAt(e, y0),
            xl1: xAt(left, y1),
            xr1: xAt(e, y1),
          };
          if (t.xr0 - t.xl0 > yEps || t.xr1 - t.xl1 > yEps) {
            out.push(t);
            nextOpen.set(left, { t, right: e });
          }
        }
      }
      inArea = now;
    }
    open = nextOpen;
    if (y1 >= yEvent - yEps) {
      k++;
      y0 = yEvent;
    } else y0 = y1;
  }
  return out;
}

/** Area of trapezoids. */
export function trapezoidArea(ts: PcbTrapezoid[]): number {
  let a = 0;
  for (const t of ts) a += ((t.xr0 - t.xl0 + (t.xr1 - t.xl1)) / 2) * (t.y1 - t.y0);
  return a;
}

/** Whether a point lies in one of the trapezoids (closed). */
export function trapezoidContains(t: PcbTrapezoid, p: Vec2, eps = 1e-9): boolean {
  if (p[1] < t.y0 - eps || p[1] > t.y1 + eps) return false;
  const s = t.y1 === t.y0 ? 0 : (p[1] - t.y0) / (t.y1 - t.y0);
  const xl = t.xl0 + (t.xl1 - t.xl0) * s;
  const xr = t.xr0 + (t.xr1 - t.xr0) * s;
  return p[0] >= xl - eps && p[0] <= xr + eps;
}

/**
 * Groups of touching trapezoids (islands): two trapezoids of neighbouring beams touch when
 * they share a stretch of the height between them. Returns the island of every trapezoid.
 */
export function trapezoidIslands(ts: PcbTrapezoid[], eps = 1e-9): number[] {
  const parent = ts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  // Tops and bottoms keyed by height.
  const key = (y: number) => Math.round(y / 1e-8);
  const bottoms = new Map<number, number[]>();
  ts.forEach((t, i) => {
    const k = key(t.y0);
    const list = bottoms.get(k);
    if (list) list.push(i);
    else bottoms.set(k, [i]);
  });
  const tops = new Map<number, number[]>();
  ts.forEach((t, i) => {
    const k = key(t.y1);
    const list = tops.get(k);
    if (list) list.push(i);
    else tops.set(k, [i]);
  });
  for (const [k, below] of tops) {
    const above = bottoms.get(k);
    if (!above) continue;
    const a = [...below].sort((i, j) => ts[i].xl1 - ts[j].xl1);
    const b = [...above].sort((i, j) => ts[i].xl0 - ts[j].xl0);
    let j = 0;
    for (const i of a) {
      const l = ts[i].xl1;
      const r = ts[i].xr1;
      while (j < b.length && ts[b[j]].xr0 < l + eps) j++;
      for (let m = j; m < b.length && ts[b[m]].xl0 < r - eps; m++) {
        const x = find(i);
        const y = find(b[m]);
        if (x !== y) parent[x] = y;
      }
    }
  }
  return ts.map((_, i) => find(i));
}

/** Finds the trapezoid holding a point, by rows of height: `(p) => index` or -1. */
export function trapezoidLocator(ts: PcbTrapezoid[], rows = 256): (p: Vec2) => number {
  if (!ts.length) return () => -1;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const t of ts) {
    y0 = Math.min(y0, t.y0);
    y1 = Math.max(y1, t.y1);
  }
  const h = Math.max((y1 - y0) / rows, 1e-6);
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / h)));
  const buckets: number[][] = Array.from({ length: rows }, () => []);
  ts.forEach((t, i) => {
    for (let r = row(t.y0); r <= row(t.y1); r++) buckets[r].push(i);
  });
  return (p) => {
    if (p[1] < y0 - 1e-9 || p[1] > y1 + 1e-9) return -1;
    for (const i of buckets[row(p[1])]) if (trapezoidContains(ts[i], p)) return i;
    return -1;
  };
}

/** The trapezoids whose boxes meet a box, by rows of height: `(box) => indices`. */
export function trapezoidIndex(
  ts: PcbTrapezoid[],
  rows = 256,
): (box: readonly [number, number, number, number]) => number[] {
  if (!ts.length) return () => [];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const t of ts) {
    y0 = Math.min(y0, t.y0);
    y1 = Math.max(y1, t.y1);
  }
  const h = Math.max((y1 - y0) / rows, 1e-6);
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / h)));
  const buckets: number[][] = Array.from({ length: rows }, () => []);
  ts.forEach((t, i) => {
    for (let r = row(t.y0); r <= row(t.y1); r++) buckets[r].push(i);
  });
  return (box) => {
    if (box[3] < y0 || box[1] > y1) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (let r = row(box[1]); r <= row(box[3]); r++)
      for (const i of buckets[r]) {
        if (seen.has(i)) continue;
        seen.add(i);
        const t = ts[i];
        if (t.y1 < box[1] || t.y0 > box[3]) continue;
        if (Math.max(t.xr0, t.xr1) < box[0] || Math.min(t.xl0, t.xl1) > box[2]) continue;
        out.push(i);
      }
    return out;
  };
}
/** A trapezoid as a counter-clockwise polygon. */
export const trapezoidPolygon = (t: PcbTrapezoid): Vec2[] => [
  [t.xl0, t.y0],
  [t.xr0, t.y0],
  [t.xr1, t.y1],
  [t.xl1, t.y1],
];
