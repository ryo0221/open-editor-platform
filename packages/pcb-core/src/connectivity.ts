import {
  arcPolygon,
  edgeDistance,
  edgesTouch,
  loopEdges,
  loopsTouch,
  loopWithin,
  padPolygon,
  pointInLoop,
  pointInPolygon,
  type LoopEdge,
} from './geometry';
import { pcbCopperLayerNames, type PcbDocument, type Vec2 } from './model';
import { componentPads } from './placement';

/**
 * Copper connectivity (PB4): which pads, tracks and vias touch on a shared copper layer.
 * Tracks are capsules (segment + half width), vias discs on every layer, pads their copper
 * outline (a polygon holding the true arcs, 0.005 mm). Zones join in PB4b. Shorts between nets are DRC's (PB5).
 */
export interface PcbCopperItem {
  kind: 'pad' | 'track' | 'via';
  /** Pad: `component\u0000pad`; track and via: their ID. */
  key: string;
  net?: string;
  layers: string[];
  /** Capsule axis (a point twice for a disc) and radius, or a polygon for a pad. */
  a?: Vec2;
  b?: Vec2;
  r?: number;
  polygon?: Vec2[];
  /**
   * A pad's outline from inside (`arcPolygon(…, 'within')`) and its true sides. Contact is
   * decided on the true outline: the inner polygon meeting proves contact, the enclosing one
   * not meeting proves none, and only the cases between are measured exactly along the arcs.
   */
  contact?: Vec2[];
  edges?: LoopEdge[];
  box: [number, number, number, number];
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const d = sub(b, a);
  const l = dot(d, d);
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / l));
  return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t);
}
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/** Distance between closed segments ab and cd. */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    pointSegment(a, c, d),
    pointSegment(b, c, d),
    pointSegment(c, a, b),
    pointSegment(d, a, b),
  );
}
/** Distance from segment ab to a polygon's region (0 inside). */
export function segmentPolygonDistance(a: Vec2, b: Vec2, poly: Vec2[]): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++)
    best = Math.min(best, segmentDistance(a, b, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/** Distance between two polygons' regions (0 when they overlap or one holds the other). */
export function polygonDistance(p: Vec2[], q: Vec2[]): number {
  if (pointInPolygon(p[0], q) || pointInPolygon(q[0], p)) return 0;
  let best = Infinity;
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++) {
      best = Math.min(
        best,
        segmentDistance(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length]),
      );
      if (best === 0) return 0;
    }
  return best;
}
/** A lower bound of the gap between two boxes. */
export function boxGap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const dx = Math.max(0, b[0] - a[2], a[0] - b[2]);
  const dy = Math.max(0, b[1] - a[3], a[1] - b[3]);
  return Math.hypot(dx, dy);
}
/**
 * The gap between two copper items' shapes (0 when they touch or overlap); layers ignored.
 * When their boxes are already `limit` apart, that lower bound is returned instead.
 */
export function pcbCopperGap(x: PcbCopperItem, y: PcbCopperItem, limit = Infinity): number {
  const bound = boxGap(x.box, y.box);
  if (bound >= limit) return bound;
  if (x.polygon && y.polygon) return polygonDistance(x.polygon, y.polygon);
  if (x.polygon || y.polygon) {
    const [poly, cap] = x.polygon ? [x.polygon, y] : [y.polygon!, x];
    return Math.max(0, segmentPolygonDistance(cap.a!, cap.b!, poly) - cap.r!);
  }
  return Math.max(0, segmentDistance(x.a!, x.b!, y.a!, y.b!) - x.r! - y.r!);
}
/** The gap from a copper item's shape to a polygon (0 when they touch). */
export function pcbItemPolygonGap(it: PcbCopperItem, poly: Vec2[]): number {
  if (it.polygon) return polygonDistance(it.polygon, poly);
  return Math.max(0, segmentPolygonDistance(it.a!, it.b!, poly) - it.r!);
}

/** Whether two loops' areas meet (sides touch, or one holds the other), exact along arcs. */
function loopsMeet(a: LoopEdge[], b: LoopEdge[]): boolean {
  return loopsTouch(a, b) || loopWithin(a, b) || loopWithin(b, a);
}
/** Distance from segment ab to a loop's area (0 inside), exact along arcs. */
function segmentLoopGap(a: Vec2, b: Vec2, loop: LoopEdge[]): number {
  if (pointInLoop(a, loop) || pointInLoop(b, loop)) return 0;
  const point = a[0] === b[0] && a[1] === b[1];
  if (!point && loop.some((e) => edgesTouch({ p: a, q: b }, e))) return 0;
  let best = Infinity;
  for (const e of loop) {
    best = Math.min(best, edgeDistance(a, e), edgeDistance(b, e));
    if (point) continue;
    best = Math.min(best, pointSegment(e.p, a, b), pointSegment(e.q, a, b));
    // Between the insides of a side and an arc: the segment's point nearest the centre.
    if (e.arc) {
      const d = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(e.arc.center, a), d) / dot(d, d)));
      best = Math.min(best, edgeDistance([a[0] + d[0] * t, a[1] + d[1] * t], e));
    }
  }
  return best;
}

/**
 * Whether a copper item meets a polygon (a fill trapezoid): pads by their true outline (see
 * `PcbCopperItem.contact`), tracks and vias as capsules.
 */
export function pcbItemContacts(it: PcbCopperItem, poly: Vec2[]): boolean {
  if (!it.polygon) return segmentPolygonDistance(it.a!, it.b!, poly) <= it.r! + 1e-9;
  if (it.contact && polygonDistance(it.contact, poly) <= 1e-9) return true;
  if (polygonDistance(it.polygon, poly) > 1e-9) return false;
  return !it.edges || loopsMeet(it.edges, loopEdges(poly));
}

const touchSlack = 1e-6;
function touch(x: PcbCopperItem, y: PcbCopperItem): boolean {
  if (!x.layers.some((l) => y.layers.includes(l))) return false;
  // Pads that overlap or touch.
  if (x.polygon && y.polygon) {
    if (x.contact && y.contact && polygonDistance(x.contact, y.contact) <= touchSlack) return true;
    if (polygonDistance(x.polygon, y.polygon) > touchSlack) return false;
    return !x.edges || !y.edges || loopsMeet(x.edges, y.edges);
  }
  if (x.polygon || y.polygon) {
    const [pad, cap] = x.polygon ? [x, y] : [y, x];
    const reach = cap.r! + touchSlack;
    if (pad.contact && segmentPolygonDistance(cap.a!, cap.b!, pad.contact) <= reach) return true;
    if (segmentPolygonDistance(cap.a!, cap.b!, pad.polygon!) > reach) return false;
    return !pad.edges || segmentLoopGap(cap.a!, cap.b!, pad.edges) <= reach;
  }
  return segmentDistance(x.a!, x.b!, y.a!, y.b!) <= x.r! + y.r! + touchSlack;
}

export function pcbCopperItems(doc: PcbDocument): PcbCopperItem[] {
  const all = pcbCopperLayerNames(doc.board.copperLayers);
  const items: PcbCopperItem[] = [];
  const padNet = new Map<string, string>();
  for (const n of doc.nets) for (const [c, p] of n.pins) padNet.set(`${c}\u0000${p}`, n.id);
  for (const c of doc.components)
    for (const p of componentPads(doc, c)) {
      if (!p.layers.length) continue;
      const polygon = padPolygon(p.loop);
      const xs = polygon.map((v) => v[0]);
      const ys = polygon.map((v) => v[1]);
      const key = `${c.id}\u0000${p.pad.number}`;
      items.push({
        kind: 'pad',
        key,
        net: padNet.get(key),
        layers: p.layers,
        polygon,
        contact: arcPolygon(p.loop, 'within'),
        edges: loopEdges(p.loop),
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    }
  const capsule = (a: Vec2, b: Vec2, r: number): PcbCopperItem['box'] => [
    Math.min(a[0], b[0]) - r,
    Math.min(a[1], b[1]) - r,
    Math.max(a[0], b[0]) + r,
    Math.max(a[1], b[1]) + r,
  ];
  for (const t of doc.tracks)
    items.push({
      kind: 'track',
      key: t.id,
      net: t.net,
      layers: [t.layer],
      a: t.from,
      b: t.to,
      r: t.widthMm / 2,
      box: capsule(t.from, t.to, t.widthMm / 2),
    });
  for (const v of doc.vias)
    items.push({
      kind: 'via',
      key: v.id,
      net: v.net,
      layers: all,
      a: v.at,
      b: v.at,
      r: v.diameterMm / 2,
      box: capsule(v.at, v.at, v.diameterMm / 2),
    });
  return items;
}

/**
 * Groups of touching copper: the group number of every item, by key. Items are swept by x so
 * only boxes that overlap are compared.
 */
export function pcbCopperGroups(
  doc: PcbDocument,
  items = pcbCopperItems(doc),
): Map<string, number> {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const order = items.map((_, i) => i).sort((i, j) => items[i].box[0] - items[j].box[0]);
  for (let k = 0; k < order.length; k++) {
    const x = items[order[k]];
    for (let m = k + 1; m < order.length; m++) {
      const y = items[order[m]];
      if (y.box[0] > x.box[2] + touchSlack) break;
      if (y.box[1] > x.box[3] + touchSlack || y.box[3] < x.box[1] - touchSlack) continue;
      if (find(order[k]) === find(order[m])) continue;
      if (touch(x, y)) parent[find(order[k])] = find(order[m]);
    }
  }
  return new Map(items.map((it, i) => [it.key, find(i)]));
}
