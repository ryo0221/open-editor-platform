import { createTypeScriptSpatialIndex } from '@editor-platform/spatial-index';
import {
  boxGap,
  pcbCopperGap,
  pcbCopperItems,
  pcbItemPolygonGap,
  polygonDistance,
  segmentDistance,
  segmentPolygonDistance,
  type PcbCopperItem,
} from './connectivity';
import { pointInPolygon } from './geometry';
import type { PcbDocument, Vec2 } from './model';
import { pcbRatsnest } from './nets';
import { componentPads, componentTransform, pcbPlacementProblems } from './placement';
import { trapezoidIndex, trapezoidPolygon, type PcbTrapezoid } from './scanbeam';
import { pcbLoopPolygon, pcbZoneFills, type PcbZoneFill } from './zones';

/**
 * Design rule check (PB5). Copper becomes per-layer capsules, discs and polygons (pads), plus
 * the zone fills from `pcbZoneFills` — the same copper the screen and Gerber use. Neighbours
 * are found with `@editor-platform/spatial-index`; only nearby shapes are measured. Rules come
 * from the document: net class clearances, and the board's edge and hole clearances, smallest
 * track, drill and annular ring.
 */
export const pcbDrcRules = [
  'short',
  'clearance',
  'edge-clearance',
  'hole-clearance',
  'track-width',
  'drill-size',
  'annular-ring',
  'unconnected',
  'silk-over-pad',
  'courtyard-overlap',
  'part-outside-board',
  'part-over-hole',
] as const;
export type PcbDrcRule = (typeof pcbDrcRules)[number];

export interface PcbDrcViolation {
  rule: PcbDrcRule;
  severity: 'error' | 'warning';
  /** IDs of the things involved: parts (for pads), tracks, vias, zones, holes. */
  items: string[];
  /** Where to look. */
  at: Vec2;
  layer?: string;
  distanceMm?: number;
  requiredMm?: number;
}

/** Measured gaps are compared to rules with this slack (1 nm). */
const slack = 1e-6;
/** Shown distances are rounded to 1 µm. */
const um = (v: number) => Math.round(v * 1000) / 1000 + 0;

interface Shape {
  item: PcbCopperItem;
  /** The thing a user picks: the part for a pad. */
  owner: string;
  label: string;
}

const centreOf = (it: PcbCopperItem): Vec2 =>
  it.polygon
    ? [
        it.polygon.reduce((s, p) => s + p[0], 0) / it.polygon.length,
        it.polygon.reduce((s, p) => s + p[1], 0) / it.polygon.length,
      ]
    : [(it.a![0] + it.b![0]) / 2, (it.a![1] + it.b![1]) / 2];
const between = (a: Vec2, b: Vec2): Vec2 => [um((a[0] + b[0]) / 2), um((a[1] + b[1]) / 2)];
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l));
  return [a[0] + dx * t, a[1] + dy * t];
}
/** The closest points of segments ab and cd (their crossing when they cross). */
function closestPair(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [Vec2, Vec2] {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (den !== 0) {
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const x: Vec2 = [a[0] + r[0] * t, a[1] + r[1] * t];
      return [x, x];
    }
  }
  const pairs: [Vec2, Vec2][] = [
    [a, closestOnSegment(a, c, d)],
    [b, closestOnSegment(b, c, d)],
    [closestOnSegment(c, a, b), c],
    [closestOnSegment(d, a, b), d],
  ];
  let best = pairs[0];
  let bd = Infinity;
  for (const q of pairs) {
    const dd = Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]);
    if (dd < bd) {
      bd = dd;
      best = q;
    }
  }
  return best;
}
/** A shape's skeleton: a capsule's axis, or a polygon's sides. */
const skeleton = (it: { polygon?: Vec2[]; a?: Vec2; b?: Vec2 }): [Vec2, Vec2][] =>
  it.polygon
    ? it.polygon.map((p, i, all): [Vec2, Vec2] => [p, all[(i + 1) % all.length]])
    : [[it.a!, it.b!]];
/** Gap from a circle line (centre c, radius r) to a polygon's region: 0 when they meet. */
function ringGap(c: Vec2, r: number, poly: Vec2[]): number {
  let best = Infinity;
  let nearest = Infinity;
  for (const [a, b] of skeleton({ polygon: poly })) {
    const q = closestOnSegment(c, a, b);
    const lo = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const hi = Math.max(Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(b[0] - c[0], b[1] - c[1]));
    nearest = Math.min(nearest, lo);
    best = Math.min(best, lo > r ? lo - r : hi < r ? r - hi : 0);
  }
  // The whole circle inside the polygon: every side is beyond it, yet the line lies on copper.
  if (nearest > r && pointInPolygon(c, poly)) return 0;
  return best;
}
/** Where two shapes come closest: the middle of their nearest points (for a finding's marker). */
function nearestPoint(
  x: { polygon?: Vec2[]; a?: Vec2; b?: Vec2 },
  y: { polygon?: Vec2[]; a?: Vec2; b?: Vec2 },
): Vec2 {
  let best: [Vec2, Vec2] | undefined;
  let bd = Infinity;
  for (const [a, b] of skeleton(x))
    for (const [c, d] of skeleton(y)) {
      const q = closestPair(a, b, c, d);
      const dd = Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]);
      if (dd < bd) {
        bd = dd;
        best = q;
      }
    }
  return between(best![0], best![1]);
}
const trapezoidBox = (t: PcbTrapezoid): [number, number, number, number] => [
  Math.min(t.xl0, t.xl1),
  t.y0,
  Math.max(t.xr0, t.xr1),
  t.y1,
];
/** Trapezoids of a fill near a box. */
function fillIndex(fill: PcbZoneFill) {
  const near = trapezoidIndex(fill.trapezoids);
  return (box: [number, number, number, number]) => near(box).map((i) => fill.trapezoids[i]);
}

export function pcbDrc(doc: PcbDocument, fills: PcbZoneFill[] = pcbZoneFills(doc)): PcbDrcResult {
  const out: PcbDrcViolation[] = [];
  const board = doc.board;
  const classOf = new Map(
    doc.nets.map((n) => [n.id, doc.netClasses.find((k) => k.id === n.class)]),
  );
  const clearance = (net: string | undefined) =>
    (net && classOf.get(net)?.clearanceMm) || doc.netClasses[0]?.clearanceMm || 0;
  const refOf = new Map(doc.components.map((c) => [c.id, c.ref]));
  const shapes: Shape[] = pcbCopperItems(doc).map((item) => {
    if (item.kind !== 'pad') return { item, owner: item.key, label: item.key };
    const [c, pad] = item.key.split('\u0000');
    return { item, owner: c, label: `${refOf.get(c) ?? c}.${pad}` };
  });

  // Copper to copper of other nets: shorts and clearances.
  const maxGap = Math.max(0, ...doc.netClasses.map((k) => k.clearanceMm));
  const index = createTypeScriptSpatialIndex(
    shapes.map(({ item: { box } }) => ({
      x: box[0] - maxGap,
      y: box[1] - maxGap,
      width: box[2] - box[0] + 2 * maxGap,
      height: box[3] - box[1] + 2 * maxGap,
    })),
  );
  const differ = (a: PcbCopperItem, b: PcbCopperItem) =>
    a.net === undefined || b.net === undefined || a.net !== b.net;
  shapes.forEach((x, i) => {
    const box = x.item.box;
    for (const j of index.query({
      x: box[0],
      y: box[1],
      width: box[2] - box[0],
      height: box[3] - box[1],
    })) {
      if (j <= i) continue;
      const y = shapes[j];
      if (!differ(x.item, y.item)) continue;
      // Pads of one part with no nets are the footprint's business, not a short.
      if (x.item.net === undefined && y.item.net === undefined && x.owner === y.owner) continue;
      const layer = x.item.layers.find((l) => y.item.layers.includes(l));
      if (!layer) continue;
      const required = Math.max(clearance(x.item.net), clearance(y.item.net));
      const gap = pcbCopperGap(x.item, y.item, required);
      if (gap >= required - slack) continue;
      out.push({
        rule: gap <= slack ? 'short' : 'clearance',
        severity: 'error',
        items: [...new Set([x.owner, y.owner])],
        at: nearestPoint(x.item, y.item),
        layer,
        distanceMm: um(gap),
        requiredMm: required,
      });
    }
  });
  index.dispose();

  // Zone fills to other nets' copper (by construction clear; checked all the same).
  const near = fills.map((f) => fillIndex(f));
  fills.forEach((fill, f) => {
    for (const s of shapes) {
      const it = s.item;
      if (it.net === fill.net || !it.layers.includes(fill.layer)) continue;
      const required = Math.max(
        clearance(it.net),
        clearance(fill.net),
        doc.zones.find((z) => z.id === fill.zone)?.clearanceMm ?? 0,
      );
      let gap = Infinity;
      let closest: PcbTrapezoid | undefined;
      for (const t of near[f]([
        it.box[0] - required,
        it.box[1] - required,
        it.box[2] + required,
        it.box[3] + required,
      ])) {
        if (boxGap(it.box, trapezoidBox(t)) >= Math.min(gap, required)) continue;
        const g = pcbItemPolygonGap(it, trapezoidPolygon(t));
        if (g < gap) {
          gap = g;
          closest = t;
        }
        if (gap <= slack) break;
      }
      if (gap < required - slack)
        out.push({
          rule: gap <= slack ? 'short' : 'clearance',
          severity: 'error',
          items: [fill.zone, s.owner],
          at: closest
            ? nearestPoint(it, { polygon: trapezoidPolygon(closest) })
            : [um(centreOf(it)[0]), um(centreOf(it)[1])],
          layer: fill.layer,
          distanceMm: um(gap),
          requiredMm: required,
        });
    }
  });

  // Fills of different nets on one layer (by construction apart; checked all the same).
  const zoneOf = new Map(doc.zones.map((z) => [z.id, z]));
  fills.forEach((fa, ia) =>
    fills.forEach((fb, ib) => {
      if (ib <= ia || fa.layer !== fb.layer || fa.net === fb.net) return;
      const required = Math.max(
        clearance(fa.net),
        clearance(fb.net),
        zoneOf.get(fa.zone)?.clearanceMm ?? 0,
        zoneOf.get(fb.zone)?.clearanceMm ?? 0,
      );
      let gap = Infinity;
      let pair: [PcbTrapezoid, PcbTrapezoid] | undefined;
      for (const t of fa.trapezoids) {
        const box = trapezoidBox(t);
        for (const u of near[ib]([
          box[0] - required,
          box[1] - required,
          box[2] + required,
          box[3] + required,
        ])) {
          if (boxGap(box, trapezoidBox(u)) >= Math.min(gap, required)) continue;
          const g = polygonDistance(trapezoidPolygon(t), trapezoidPolygon(u));
          if (g < gap) {
            gap = g;
            pair = [t, u];
          }
        }
        if (gap <= slack) break;
      }
      if (pair && gap < required - slack)
        out.push({
          rule: gap <= slack ? 'short' : 'clearance',
          severity: 'error',
          items: [fa.zone, fb.zone],
          at: nearestPoint(
            { polygon: trapezoidPolygon(pair[0]) },
            { polygon: trapezoidPolygon(pair[1]) },
          ),
          layer: fa.layer,
          distanceMm: um(gap),
          requiredMm: required,
        });
    }),
  );

  // The board's edge and cut-outs; mounting and unplated holes.
  // The same chords the fills were cut with.
  const outline = pcbLoopPolygon(board.outline, 'within');
  const cutouts = board.cutouts.map((k) => pcbLoopPolygon(k, 'around'));
  const edges: [Vec2, Vec2][] = [outline, ...cutouts].flatMap((poly) =>
    poly.map((p, i): [Vec2, Vec2] => [p, poly[(i + 1) % poly.length]]),
  );
  const edgeGap = (it: PcbCopperItem) => {
    const c = it.polygon ? it.polygon[0] : it.a!;
    const inside = pointInPolygon(c, outline) && !cutouts.some((k) => pointInPolygon(c, k));
    if (!inside) return 0;
    let best = Infinity;
    for (const [a, b] of edges)
      best = Math.min(
        best,
        it.polygon
          ? segmentPolygonDistance(a, b, it.polygon)
          : Math.max(0, segmentDistance(a, b, it.a!, it.b!) - it.r!),
      );
    return best;
  };
  for (const s of shapes) {
    const gap = edgeGap(s.item);
    if (gap < board.edgeClearanceMm - slack)
      out.push({
        rule: 'edge-clearance',
        severity: 'error',
        items: [s.owner],
        at: [um(centreOf(s.item)[0]), um(centreOf(s.item)[1])],
        layer: s.item.layers[0],
        distanceMm: um(gap),
        requiredMm: board.edgeClearanceMm,
      });
  }
  const holes: { id: string; at: Vec2; r: number; required: number }[] = [
    ...doc.holes.map((h) => ({
      id: h.id,
      at: h.at,
      r: h.drillMm / 2,
      // A keep-out larger than drill + clearance asks for more.
      required: Math.max(board.holeClearanceMm, h.keepoutMm / 2 - h.drillMm / 2),
    })),
    ...doc.components.flatMap((c) =>
      componentPads(doc, c)
        .filter((p) => p.pad.type === 'npth')
        .map((p) => ({
          id: c.id,
          at: p.at,
          r: (p.pad.drillMm ?? Math.min(...p.pad.size)) / 2,
          required: board.holeClearanceMm,
        })),
    ),
  ];
  for (const h of holes) {
    const disc: PcbCopperItem = {
      kind: 'via',
      key: h.id,
      layers: [],
      a: h.at,
      b: h.at,
      r: h.r,
      box: [h.at[0] - h.r, h.at[1] - h.r, h.at[0] + h.r, h.at[1] + h.r],
    };
    for (const s of shapes) {
      const it = s.item;
      if (it.box[0] > disc.box[2] + h.required || it.box[2] < disc.box[0] - h.required) continue;
      if (it.box[1] > disc.box[3] + h.required || it.box[3] < disc.box[1] - h.required) continue;
      const gap = pcbCopperGap(it, disc, h.required);
      if (gap < h.required - slack)
        out.push({
          rule: 'hole-clearance',
          severity: 'error',
          items: [...new Set([h.id, s.owner])],
          at: [um(h.at[0]), um(h.at[1])],
          layer: it.layers[0],
          distanceMm: um(gap),
          requiredMm: um(h.required),
        });
    }
  }
  // Fills against the edge and holes.
  fills.forEach((fill, f) => {
    const reach = Math.max(board.edgeClearanceMm, ...holes.map((h) => h.required));
    const flagged = new Set<string>();
    const check = (a: Vec2, b: Vec2, r: number, required: number, rule: PcbDrcRule, id: string) => {
      const box: [number, number, number, number] = [
        Math.min(a[0], b[0]) - r - reach,
        Math.min(a[1], b[1]) - r - reach,
        Math.max(a[0], b[0]) + r + reach,
        Math.max(a[1], b[1]) + r + reach,
      ];
      const reachBox: [number, number, number, number] = [
        Math.min(a[0], b[0]) - r,
        Math.min(a[1], b[1]) - r,
        Math.max(a[0], b[0]) + r,
        Math.max(a[1], b[1]) + r,
      ];
      for (const t of near[f](box)) {
        if (flagged.has(id)) return;
        if (boxGap(reachBox, trapezoidBox(t)) >= required) continue;
        const gap = Math.max(0, segmentPolygonDistance(a, b, trapezoidPolygon(t)) - r);
        if (gap < required - slack && !flagged.has(id)) {
          flagged.add(id);
          out.push({
            rule,
            severity: 'error',
            items: [fill.zone, ...(id.startsWith('edge') ? [] : [id])],
            at: between(a, b),
            layer: fill.layer,
            distanceMm: um(gap),
            requiredMm: um(required),
          });
        }
      }
    };
    edges.forEach(([a, b], i) =>
      check(a, b, 0, board.edgeClearanceMm, 'edge-clearance', `edge-${i}`),
    );
    for (const h of holes) check(h.at, h.at, h.r, h.required, 'hole-clearance', h.id);
  });

  // Sizes.
  // A track is at least the board's smallest width and its net class's width.
  for (const t of doc.tracks) {
    const width = Math.max(board.minTrackWidthMm, classOf.get(t.net)?.trackWidthMm ?? 0);
    if (t.widthMm < width - slack)
      out.push({
        rule: 'track-width',
        severity: 'error',
        items: [t.id],
        at: between(t.from, t.to),
        layer: t.layer,
        distanceMm: t.widthMm,
        requiredMm: width,
      });
  }
  const drill = (id: string, at: Vec2, d: number, ring: number | undefined) => {
    if (d < board.minDrillMm - slack)
      out.push({
        rule: 'drill-size',
        severity: 'error',
        items: [id],
        at: [um(at[0]), um(at[1])],
        distanceMm: d,
        requiredMm: board.minDrillMm,
      });
    if (ring !== undefined && ring < board.minAnnularRingMm - slack)
      out.push({
        rule: 'annular-ring',
        severity: 'error',
        items: [id],
        at: [um(at[0]), um(at[1])],
        distanceMm: um(ring),
        requiredMm: board.minAnnularRingMm,
      });
  };
  for (const v of doc.vias) drill(v.id, v.at, v.drillMm, (v.diameterMm - v.drillMm) / 2);
  for (const h of doc.holes) drill(h.id, h.at, h.drillMm, undefined);
  for (const c of doc.components)
    for (const p of componentPads(doc, c)) {
      if (p.pad.type === 'smd' || p.pad.drillMm === undefined) continue;
      drill(
        c.id,
        p.at,
        p.pad.drillMm,
        p.pad.type === 'thru' ? (Math.min(...p.pad.size) - p.pad.drillMm) / 2 : undefined,
      );
    }

  // Connections still missing.
  for (const l of pcbRatsnest(doc, fills))
    out.push({
      rule: 'unconnected',
      severity: 'error',
      items: [...new Set([l.a.component, l.b.component])],
      at: between(l.a.at, l.b.at),
    });

  // Silkscreen over exposed pads (any part's), on the same side.
  type Box = [number, number, number, number];
  const padsBySide = { top: [] as PcbCopperItem[], bottom: [] as PcbCopperItem[] };
  for (const s of shapes)
    if (s.item.kind === 'pad') {
      if (s.item.layers.includes('F.Cu')) padsBySide.top.push(s.item);
      if (s.item.layers.includes('B.Cu')) padsBySide.bottom.push(s.item);
    }
  const segBox = (a: Vec2, b: Vec2, r: number): Box => [
    Math.min(a[0], b[0]) - r,
    Math.min(a[1], b[1]) - r,
    Math.max(a[0], b[0]) + r,
    Math.max(a[1], b[1]) + r,
  ];
  for (const c of doc.components) {
    const fp = doc.footprints.find((x) => x.id === c.footprint);
    if (!fp) continue;
    const f = componentTransform(c);
    const pads = padsBySide[c.side];
    const hit = fp.silk.some((g) => {
      if (g.kind === 'line') {
        const a = f(g.from);
        const b = f(g.to);
        const box = segBox(a, b, g.widthMm / 2);
        return pads.some(
          (p) =>
            boxGap(box, p.box) <= 0 &&
            segmentPolygonDistance(a, b, p.polygon!) < g.widthMm / 2 - slack,
        );
      }
      const centre = f(g.center);
      const box = segBox(centre, centre, g.radiusMm + g.widthMm / 2);
      return pads.some((p) => {
        if (boxGap(box, p.box) > 0) return false;
        const poly = p.polygon!;
        // A filled circle is a disc of radius r + w/2; a ring is the band r ± w/2. Exact: the
        // pad's distance from the centre (0 inside) or from the circle line.
        if (g.filled)
          return segmentPolygonDistance(centre, centre, poly) < g.radiusMm + g.widthMm / 2 - slack;
        return ringGap(centre, g.radiusMm, poly) < g.widthMm / 2 - slack;
      });
    });
    if (hit) out.push({ rule: 'silk-over-pad', severity: 'warning', items: [c.id], at: c.at });
  }

  // Placement (PB2) as warnings.
  for (const p of pcbPlacementProblems(doc)) {
    const c = doc.components.find((x) => x.id === p.ids[0]);
    out.push({ rule: p.code, severity: 'warning', items: p.ids, at: c ? c.at : [0, 0] });
  }
  return { violations: out, errors: out.filter((v) => v.severity === 'error').length };
}

export interface PcbDrcResult {
  violations: PcbDrcViolation[];
  errors: number;
}
