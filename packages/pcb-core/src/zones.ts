import { pcbCopperGroups, pcbCopperItems, pcbItemContacts, polygonDistance } from './connectivity';
import { arcPolygon, padPolygon } from './geometry';
import type { PcbDocument, PcbLoop, PcbNetClass, PcbZone, Vec2 } from './model';
import { pcbPadNets } from './nets';
import { componentPads } from './placement';
import {
  scanbeamBoolean,
  trapezoidArea,
  trapezoidIndex,
  trapezoidIslands,
  trapezoidPolygon,
  type PcbTaggedPolygon,
  type PcbTrapezoid,
} from './scanbeam';

/**
 * Zone fills (PB4b): the copper a zone pours, derived and never stored. The one function
 * `pcbZoneFills` is used by the screen, DRC (PB5) and Gerber (PB6), so all three see the same
 * copper. Steps, as in the plan:
 * 1. the zone's outline, inside the board less the edge clearance, outside every cut-out and
 *    its edge clearance;
 * 2. less unplated and mounting holes grown by the hole clearance (or their keep-out);
 * 3. less other nets' copper on the layer (pads, tracks, vias, and the outline of a zone of
 *    another net that fills first) grown by the larger of the zone's and that net's clearance;
 * 4. the zone net's pads join by four spokes across a thermal gap (or solid); tracks and vias
 *    of the net join solid;
 * 5. islands that touch none of the net's copper are dropped.
 * Arcs become chords no more than 0.005 mm off; grown shapes are drawn around (never inside)
 * the true shape, so the gap is never short of the clearance.
 */

export interface PcbZoneFill {
  zone: string;
  net: string;
  layer: string;
  /** The copper as trapezoids between heights (see `scanbeamBoolean`). */
  trapezoids: PcbTrapezoid[];
  /** The island of each trapezoid (kept islands only). */
  islands: number[];
  areaMm2: number;
}

/** Chord tolerance for arcs and grown shapes. */
export const pcbArcToleranceMm = 0.005;

/** Pieces for a full turn of radius r so a chord strays at most `pcbArcToleranceMm`. */
function circlePieces(r: number): number {
  if (r <= pcbArcToleranceMm) return 8;
  const step = 4 * Math.asin(Math.sqrt(Math.min(1, pcbArcToleranceMm / (2 * r))));
  return Math.min(128, Math.max(8, Math.ceil((2 * Math.PI) / step)));
}

/** A disc grown to enclose the true circle (the polygon's edges touch it from outside). */
export function discPolygon(c: Vec2, r: number): Vec2[] {
  const n = circlePieces(r);
  const R = r / Math.cos(Math.PI / n);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
  }
  return out;
}

/** A segment grown by r on every side (a stadium), counter-clockwise, enclosing the true one. */
export function capsulePolygon(a: Vec2, b: Vec2, r: number): Vec2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return discPolygon(a, r);
  const n = Math.max(4, Math.ceil(circlePieces(r) / 2));
  const R = r / Math.cos(Math.PI / (2 * n));
  const base = Math.atan2(dy, dx) - Math.PI / 2;
  const out: Vec2[] = [];
  // Half circle about b (from its right side round its far end), then about a.
  for (const [c, start] of [
    [b, base],
    [a, base + Math.PI],
  ] as const) {
    out.push([c[0] + r * Math.cos(start), c[1] + r * Math.sin(start)]);
    for (let i = 0; i < n; i++) {
      const t = start + (Math.PI * (i + 0.5)) / n;
      out.push([c[0] + R * Math.cos(t), c[1] + R * Math.sin(t)]);
    }
    out.push([c[0] + r * Math.cos(start + Math.PI), c[1] + r * Math.sin(start + Math.PI)]);
  }
  return out;
}

/** The convex hull, counter-clockwise (pads are convex; sampling may add collinear points). */
function hull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * A convex polygon grown by r: each edge pushed out, corners rounded. The corner arcs are
 * drawn around the true arc.
 */
export function grownConvex(points: Vec2[], r: number): Vec2[] {
  const h = hull(points);
  if (r <= 0 || h.length < 3) return h;
  const n = h.length;
  const normal = (i: number): Vec2 => {
    const a = h[i];
    const b = h[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  const pieces = circlePieces(r);
  const step = (2 * Math.PI) / pieces;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const v = h[i];
    const n0 = normal((i + n - 1) % n);
    const n1 = normal(i);
    const a0 = Math.atan2(n0[1], n0[0]);
    let turn = Math.atan2(n1[1], n1[0]) - a0;
    while (turn < 0) turn += 2 * Math.PI;
    while (turn >= 2 * Math.PI) turn -= 2 * Math.PI;
    out.push([v[0] + r * n0[0], v[1] + r * n0[1]]);
    // At least one corner point outside the arc: a chord between the two pushed edges would
    // cut inside the true offset.
    const k = Math.max(1, Math.ceil(turn / step));
    if (turn > 1e-9) {
      const R = r / Math.cos(turn / k / 2);
      for (let j = 0; j < k; j++) {
        const t = a0 + (turn * (j + 0.5)) / k;
        out.push([v[0] + R * Math.cos(t), v[1] + R * Math.sin(t)]);
      }
    }
    out.push([v[0] + r * n1[0], v[1] + r * n1[1]]);
  }
  return out;
}

/** A rectangle centred on c, `len` along angle a and `w` across. */
function bar(c: Vec2, a: number, len: number, w: number): Vec2[] {
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const v: Vec2 = [-u[1], u[0]];
  const p = (s: number, t: number): Vec2 => [
    c[0] + u[0] * s + v[0] * t,
    c[1] + u[1] * s + v[1] * t,
  ];
  return [p(-len / 2, -w / 2), p(len / 2, -w / 2), p(len / 2, w / 2), p(-len / 2, w / 2)];
}

/**
 * A loop as a polygon within 0.005 mm of it: `within` for an area copper may fill (the board,
 * a zone), `around` for one it must keep out of (a cut-out, another zone). See `arcPolygon`.
 */
export function pcbLoopPolygon(loop: PcbLoop, side: 'within' | 'around' = 'within'): Vec2[] {
  return arcPolygon(loop, side === 'around' ? 'around' : 'within', pcbArcToleranceMm);
}

/** A loop's edges grown into capsules (the band within r of its boundary). */
function boundaryBand(poly: Vec2[], r: number): Vec2[][] {
  return poly.map((p, i) => capsulePolygon(p, poly[(i + 1) % poly.length], r));
}

type Box = [number, number, number, number];
const boxOf = (pts: Vec2[], grow = 0): Box => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
};
const boxesMeet = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

const ZONE = 0;
const BOARD = 1;
const CUT = 2;

/** The zones in fill order: higher priority first, then document order. */
export function pcbZoneOrder(doc: PcbDocument): PcbZone[] {
  return doc.zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => b.z.priority - a.z.priority || a.i - b.i)
    .map((x) => x.z);
}

/** Every zone's fill, in fill order. */
export function pcbZoneFills(doc: PcbDocument): PcbZoneFill[] {
  if (!doc.zones.length) return [];
  const padNets = pcbPadNets(doc);
  const classOf = new Map<string, PcbNetClass>();
  for (const n of doc.nets) {
    const k = doc.netClasses.find((c) => c.id === n.class);
    if (k) classOf.set(n.id, k);
  }
  const clearanceOf = (net: string | undefined) =>
    (net && classOf.get(net)?.clearanceMm) || doc.netClasses[0]?.clearanceMm || 0;
  const board = pcbLoopPolygon(doc.board.outline, 'within');
  const cutouts = doc.board.cutouts.map((k) => pcbLoopPolygon(k, 'around'));
  const pads = doc.components.flatMap((c) =>
    componentPads(doc, c).map((p) => ({
      ...p,
      polygon: padPolygon(p.loop),
      net: padNets.get(`${c.id}\u0000${p.pad.number}`),
      angle: ((c.rotationDeg + (c.side === 'bottom' ? -1 : 1) * p.pad.rotationDeg) * Math.PI) / 180,
    })),
  );
  const order = pcbZoneOrder(doc);
  const raw = order.map((zone, rank) => {
    const outline = pcbLoopPolygon(zone.outline, 'within');
    const reach = Math.max(zone.clearanceMm, ...doc.netClasses.map((k) => k.clearanceMm)) + 1;
    const zbox = boxOf(outline, reach);
    const polys: PcbTaggedPolygon[] = [
      { set: ZONE, points: outline },
      { set: BOARD, points: board },
    ];
    const cut = (points: Vec2[]) => {
      if (boxesMeet(boxOf(points), zbox)) polys.push({ set: CUT, points });
    };
    const edge = doc.board.edgeClearanceMm;
    // 1. The board's edge and cut-outs.
    boundaryBand(board, edge).forEach(cut);
    for (const k of cutouts) {
      cut(k);
      boundaryBand(k, edge).forEach(cut);
    }
    // 2. Mounting holes and unplated holes.
    const hole = doc.board.holeClearanceMm;
    for (const h of doc.holes)
      cut(discPolygon(h.at, Math.max(h.drillMm / 2 + hole, h.keepoutMm / 2)));
    // The zone's own clearance, its net's class and the other net's class: the largest.
    const own = Math.max(zone.clearanceMm, clearanceOf(zone.net));
    const gapOf = (net: string | undefined) => Math.max(own, clearanceOf(net));
    // 3. Other nets' copper on the layer; 4. the net's own pads.
    for (const p of pads) {
      if (p.pad.type === 'npth') {
        cut(discPolygon(p.at, (p.pad.drillMm ?? Math.min(...p.pad.size)) / 2 + hole));
        continue;
      }
      if (!p.layers.includes(zone.layer)) continue;
      if (p.net !== zone.net) {
        cut(grownConvex(p.polygon, gapOf(p.net)));
        continue;
      }
      if (zone.padConnection === 'solid') continue;
      // The relief of this pad alone: its gap ring less its own two spokes.
      const ring = grownConvex(p.polygon, zone.thermalGapMm);
      if (!boxesMeet(boxOf(ring), zbox)) continue;
      const box = boxOf(p.polygon);
      const span = 2 * (Math.hypot(box[2] - box[0], box[3] - box[1]) + zone.thermalGapMm) + 0.1;
      const relief = scanbeamBoolean(
        [
          { set: 0, points: ring },
          { set: 1, points: bar(p.at, p.angle, span, zone.spokeWidthMm) },
          { set: 1, points: bar(p.at, p.angle + Math.PI / 2, span, zone.spokeWidthMm) },
        ],
        2,
        (k) => k[0] > 0 && k[1] <= 0,
      );
      for (const t of relief) polys.push({ set: CUT, points: trapezoidPolygon(t) });
    }
    for (const t of doc.tracks)
      if (t.layer === zone.layer && t.net !== zone.net)
        cut(capsulePolygon(t.from, t.to, t.widthMm / 2 + gapOf(t.net)));
    for (const v of doc.vias)
      if (v.net !== zone.net) cut(discPolygon(v.at, v.diameterMm / 2 + gapOf(v.net)));
    // A zone of another net that fills first keeps its outline (and the gap) to itself; the
    // gap is the larger of both zones' and that net's class clearance.
    for (const other of order.slice(0, rank)) {
      if (other.layer !== zone.layer || other.net === zone.net) continue;
      const o = pcbLoopPolygon(other.outline, 'around');
      const g = Math.max(gapOf(other.net), other.clearanceMm);
      cut(o);
      boundaryBand(o, g).forEach(cut);
    }
    const all = scanbeamBoolean(polys, 3, (k) => k[ZONE] > 0 && k[BOARD] > 0 && k[CUT] <= 0);
    return { zone, all, island: trapezoidIslands(all), near: trapezoidIndex(all) };
  });

  // Islands across zones: one numbering, and same-net zones on a layer that touch are one.
  const offsets: number[] = [];
  let total = 0;
  for (const r of raw) {
    offsets.push(total);
    total += r.all.length;
  }
  const parent = Array.from({ length: total }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a: number, b: number) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[x] = y;
  };
  raw.forEach((r, f) => r.island.forEach((root, i) => join(offsets[f] + i, offsets[f] + root)));
  for (let a = 0; a < raw.length; a++)
    for (let b = a + 1; b < raw.length; b++) {
      const [A, B] = [raw[a], raw[b]];
      if (A.zone.net !== B.zone.net || A.zone.layer !== B.zone.layer) continue;
      A.all.forEach((t, i) => {
        const poly = trapezoidPolygon(t);
        for (const j of B.near(trapezoidBox(t)))
          if (polygonDistance(poly, trapezoidPolygon(B.all[j])) <= 1e-9)
            join(offsets[a] + i, offsets[b] + j);
      });
    }
  // 5. Keep islands that touch the net's copper on the layer (a pad, a track anywhere along
  // it, a via), or touch such an island of another zone of the net.
  const items = pcbCopperItems(doc);
  const anchored = new Set<number>();
  raw.forEach((r, f) => {
    for (const it of items) {
      if (it.net !== r.zone.net || !it.layers.includes(r.zone.layer)) continue;
      for (const i of r.near(it.box))
        if (pcbItemContacts(it, trapezoidPolygon(r.all[i]))) anchored.add(find(offsets[f] + i));
    }
  });
  return raw.map((r, f) => {
    const trapezoids: PcbTrapezoid[] = [];
    const islands: number[] = [];
    r.all.forEach((t, i) => {
      const root = find(offsets[f] + i);
      if (!anchored.has(root)) return;
      trapezoids.push(t);
      islands.push(root);
    });
    return {
      zone: r.zone.id,
      net: r.zone.net,
      layer: r.zone.layer,
      trapezoids,
      islands,
      areaMm2: trapezoidArea(trapezoids),
    };
  });
}

const trapezoidBox = (t: PcbTrapezoid): Box => [
  Math.min(t.xl0, t.xl1),
  t.y0,
  Math.max(t.xr0, t.xr1),
  t.y1,
];

/** An SVG path of trapezoids, y flipped (board y up, screen y down). */
export function pcbTrapezoidPath(ts: PcbTrapezoid[], digits = 4): string {
  const f = (v: number) => +v.toFixed(digits);
  return ts
    .map(
      (t) =>
        `M${f(t.xl0)} ${f(-t.y0)}L${f(t.xr0)} ${f(-t.y0)}L${f(t.xr1)} ${f(-t.y1)}L${f(t.xl1)} ${f(-t.y1)}Z`,
    )
    .join('');
}

/**
 * Copper groups with zones: pads, tracks and vias that touch (see `pcbCopperGroups`), joined
 * further by the zone islands they touch. Island numbers are shared by all fills, so copper
 * joined through two overlapping zones of a net is one group.
 */
export function pcbConnectedGroups(
  doc: PcbDocument,
  fills: PcbZoneFill[] = pcbZoneFills(doc),
): Map<string, number> {
  const items = pcbCopperItems(doc);
  const groups = pcbCopperGroups(doc, items);
  if (!fills.length) return groups;
  const parent = new Map<number, number>();
  const find = (g: number): number => {
    let r = g;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(g, r);
    return r;
  };
  const byIsland = new Map<number, number>();
  for (const fill of fills) {
    const near = trapezoidIndex(fill.trapezoids);
    for (const it of items) {
      if (it.net !== fill.net || !it.layers.includes(fill.layer)) continue;
      const g = groups.get(it.key);
      if (g === undefined) continue;
      for (const i of near(it.box)) {
        if (!pcbItemContacts(it, trapezoidPolygon(fill.trapezoids[i]))) continue;
        const island = fill.islands[i];
        const first = byIsland.get(island);
        if (first === undefined) byIsland.set(island, g);
        else {
          const x = find(first);
          const y = find(g);
          if (x !== y) parent.set(x, y);
        }
      }
    }
  }
  const out = new Map<string, number>();
  for (const [k, g] of groups) out.set(k, find(g));
  return out;
}
