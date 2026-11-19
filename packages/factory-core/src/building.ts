/**
 * FT4 (docs/cad/factory-twin.md): the factory in its building. The building is a saved BIM
 * version that is only looked at: its walls and columns are checked against the boxes the
 * objects take on the floor and the lanes the vehicles drive. The floor of the factory is the
 * building's z = 0.
 */
import {
  BimContext,
  bimProfileLoops,
  bimWallOpeningLoop,
  bimWallOpeningRise,
  bimSectionAxes,
  deriveBim,
  pointInPolygon,
  polygonsTouch,
  sampleLoop,
  type BimDocument,
  type Vec2,
} from '@editor-platform/bim-core';
import type {
  FactoryDiagnostic,
  FactoryDocument,
  FactoryObject,
  FactoryObjectKind,
  FactoryPlacement,
  FactorySize,
} from './model';

/** The size of each kind of object when it has none of its own, in mm (FT4). */
export const factoryDefaultSizes: Readonly<Record<FactoryObjectKind, FactorySize>> = Object.freeze({
  source: { widthMm: 1200, depthMm: 1200, heightMm: 1000 },
  station: { widthMm: 2400, depthMm: 1600, heightMm: 2000 },
  parallel: { widthMm: 2400, depthMm: 1600, heightMm: 2000 },
  assembly: { widthMm: 3000, depthMm: 2000, heightMm: 2000 },
  buffer: { widthMm: 1600, depthMm: 1200, heightMm: 1200 },
  conveyor: { widthMm: 3000, depthMm: 800, heightMm: 900 },
  drain: { widthMm: 1200, depthMm: 1200, heightMm: 1000 },
});
/** The lane a vehicle needs when its fleet gives none, in mm. */
export const factoryDefaultLaneMm = 1000;

/** The object's own size, or its kind's; a conveyor is as long as its `lengthMm`. */
export function factoryObjectSize(o: FactoryObject): FactorySize {
  if (o.size) return o.size;
  const d = factoryDefaultSizes[o.kind];
  return o.kind === 'conveyor' ? { ...d, widthMm: o.lengthMm } : d;
}

/** The four corners of the object's box on the floor (anticlockwise), centred on `at`. */
export function factoryFootprint(o: FactoryObject, at: FactoryPlacement): Vec2[] {
  const { widthMm: w, depthMm: d } = factoryObjectSize(o);
  const a = ((at.angle ?? 0) * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, y]): Vec2 => [at.x + x! * c - y! * s, at.y + x! * s + y! * c]);
}

/** A band `width` mm wide around the line from `a` to `b` (anticlockwise). */
function lane(a: Vec2, b: Vec2, width: number): Vec2[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const n: Vec2 = [(-(b[1] - a[1]) / len) * (width / 2), ((b[0] - a[0]) / len) * (width / 2)];
  return [
    [a[0] - n[0], a[1] - n[1]],
    [b[0] - n[0], b[1] - n[1]],
    [b[0] + n[0], b[1] + n[1]],
    [a[0] + n[0], a[1] + n[1]],
  ];
}

/** A plan obstacle of the building: what it covers, how high, and where it may be passed. */
export interface FactoryObstacle {
  elementId: string;
  kind: 'wall' | 'column';
  outline: Vec2[];
  zBase: number;
  zTop: number;
  /**
   * A leaning wall's or column's outline at `zTop` (the same vertices as `outline`): its section
   * at a height between is interpolated (the solid is ruled).
   */
  outlineTop?: Vec2[];
  /** Door-like openings from the floor: plan regions (at the base, and at `zTop` for a leaning
   * wall) and their heights above the floor. */
  passages: { outline: Vec2[]; outlineTop?: Vec2[]; heightMm: number }[];
  /** A hollow column's voids (box and pipe profiles), the full height: nothing there to meet. */
  holes?: { outline: Vec2[]; outlineTop?: Vec2[] }[];
  /**
   * Beside a leaning column's tilted cap: a convex region the column lies within over these
   * heights (the caps cut it off). The outlines are then its sides' section, not cut off: what
   * meets the column meets both.
   */
  within?: Vec2[];
}

/** How far a sampled arc may fall inside the true one (mm). */
export const factoryArcToleranceMm = 2;

/** A loop with its arcs in straight pieces no more than `factoryArcToleranceMm` inside them. */
type Loop = Parameters<typeof sampleLoop>[0];
/**
 * Pieces per arc for `loops` sampled alike (a base and its top keep the same vertices, so their
 * sections between interpolate), fine enough for every one of them.
 */
function piecesPerArc(...loops: (Loop | undefined)[]): number {
  let per = 16;
  for (const loop of loops) if (loop) per = Math.max(per, arcPieces(loop));
  return Math.min(per, 2048);
}
function arcPieces(loop: Loop): number {
  let per = 16;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    const b = Math.abs(p[2] ?? 0);
    if (!b) continue;
    const theta = 4 * Math.atan(b);
    const r = Math.hypot(q[0] - p[0], q[1] - p[1]) / (2 * Math.sin(theta / 2));
    if (!(r > factoryArcToleranceMm)) continue;
    per = Math.max(per, Math.ceil(theta / (2 * Math.acos(1 - factoryArcToleranceMm / r))));
  }
  return per;
}
function fine(loop: Loop, per = piecesPerArc(loop)): Vec2[] {
  return sampleLoop(loop, per);
}

/** The walls and columns of the building that stand on its floor (they reach z = 0 or below). */
export function factoryObstacles(bim: BimDocument): FactoryObstacle[] {
  const derived = deriveBim(bim);
  const ctx = new BimContext(bim);
  const out: FactoryObstacle[] = [];
  for (const e of bim.elements) {
    const s = derived.shapes.get(e.id);
    if (!s) continue;
    if (s.kind === 'wall' && e.kind === 'wall') {
      if (s.zTop <= 0) continue;
      // Base and top sampled alike, so the sections between keep their vertices.
      const per = piecesPerArc(s.footprint, s.footprintTop);
      out.push({
        elementId: e.id,
        kind: 'wall',
        outline: fine(s.footprint, per),
        ...(s.footprintTop ? { outlineTop: fine(s.footprintTop, per) } : {}),
        zBase: s.zBase,
        zTop: s.zTop,
        // An opening counts when its sill is at the wall's lowest occupied height (the floor, or
        // the base of a wall raised above it: below that nothing stands in the way).
        // A leaning wall's openings are measured along its face: their rise is less.
        passages: s.openings
          .map((o) => ({ o, rise: bimWallOpeningRise(e, o.sillMm, o.heightMm) }))
          .filter(({ rise }) => s.zBase + rise[0] <= Math.max(0, s.zBase))
          .map(({ o, rise }) => {
            const base = bimWallOpeningLoop(ctx, e, o.alongMm, o.widthMm);
            const top = s.footprintTop
              ? bimWallOpeningLoop(ctx, e, o.alongMm, o.widthMm, s.zTop - s.zBase)
              : undefined;
            const n = piecesPerArc(base, top);
            return {
              outline: fine(base, n),
              ...(top ? { outlineTop: fine(top, n) } : {}),
              heightMm: s.zBase + rise[1],
            };
          }),
      });
    } else if (s.kind === 'column') {
      // Its sides, extended past the caps, form a ruled prism: each profile vertex runs along a
      // straight line, so the horizontal cut at any height has the same vertices, moving
      // linearly with height. Between the highest point of the base cap and the lowest of the
      // top cap (caps are square to the axis, so a leaning column's tilt) that cut is the
      // column's own. Beside a tilted cap (and for a column too short to have sides all round)
      // it is checked in thin upright slabs clipped to the caps (below). Voids are the prism's own (nothing
      // of the column is inside them at any height).
      const loops = bimProfileLoops(s.profile);
      const scale = s.topScale ?? 1;
      const ax = bimSectionAxes(s);
      const c = (scale - 1) / ax.length;
      const vec = (p: Vec2) => [0, 1, 2].map((i) => ax.x[i]! * p[0] + ax.y[i]! * p[1]);
      const point = (p: Vec2, w: number) => {
        const v = vec(p);
        return [0, 1, 2].map((i) => ax.origin[i]! + ax.z[i]! * w + (1 + c * w) * v[i]!);
      };
      /** Where the side line of each profile point (linear in w) meets the height `z`. */
      const cutOf = (loop: Vec2[], z: number): Vec2[] | undefined => {
        const out: Vec2[] = [];
        for (const p of loop) {
          const v = vec(p);
          const dz = ax.z[2]! + c * v[2]!;
          if (Math.abs(dz) < 1e-9) return undefined;
          const w = (z - ax.origin[2]! - v[2]!) / dz;
          const q = point(p, w);
          out.push([q[0]!, q[1]!]);
        }
        return out;
      };
      const section = fine(loops.outer);
      const base3 = section.map((p) => point(p, 0));
      const top3 = section.map((p) => point(p, ax.length));
      const zs = (pts: number[][]) => pts.map((p) => p[2]!);
      const z0 = Math.min(...zs(base3), ...zs(top3));
      const z1 = Math.max(...zs(base3), ...zs(top3));
      const zb = Math.max(...zs(base3));
      const zt = Math.min(...zs(top3));
      if (z1 <= 0) continue;
      const voids = (from: number, to: number) =>
        loops.holes.flatMap((h) => {
          const f = fine(h);
          const [hl, hh] = [cutOf(f, from), cutOf(f, to)];
          return hl && hh ? [{ outline: hl, ...(to > from ? { outlineTop: hh } : {}) }] : [];
        });
      const add = (o: Omit<FactoryObstacle, 'elementId' | 'kind' | 'passages'>) => {
        if (o.zTop <= 0 || o.zTop <= o.zBase) return;
        const holes = o.holes?.length ? { holes: o.holes } : {};
        out.push({ elementId: e.id, kind: 'column', ...o, passages: [], ...holes });
      };
      const flat = (pts: (number[] | Vec2)[]) => convexHull(pts.map((p): Vec2 => [p[0]!, p[1]!]));
      const swept = !!s.topAt || scale !== 1;
      const lo = cutOf(section, zb);
      const hi = cutOf(section, zt);
      /**
       * Beside a tilted cap: the column in thin upright slabs (every 100 mm from the floor up,
       * at most 48), each the hull of what lies in it: the side cut at its two heights clipped
       * to the caps (the caps cut a horizontal plane along a line), and the cap corners between.
       * The column part in a slab lies inside that hull, which follows the caps' slope.
       */
      const along = (q: Vec2, z: number) =>
        (q[0] - ax.origin[0]!) * ax.z[0]! +
        (q[1] - ax.origin[1]!) * ax.z[1]! +
        (z - ax.origin[2]!) * ax.z[2]!;
      const clipped = (z: number): Vec2[] | undefined => {
        const cut = cutOf(section, z);
        if (!cut) return undefined;
        return clipHalfPlane(
          clipHalfPlane(cut, (q) => along(q, z)),
          (q) => ax.length - along(q, z),
        );
      };
      const slabs = (from: number, to: number) => {
        from = Math.max(0, from);
        if (to - from <= 1e-6) return true;
        const n = Math.min(48, Math.max(1, Math.ceil((to - from) / 100)));
        const at = Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
        const cuts = at.map(clipped);
        if (cuts.some((c) => !c)) return false;
        for (let i = 0; i < n; i++) {
          const [a, b] = [at[i]!, at[i + 1]!];
          const corners = [...base3, ...top3].filter((q) => q[2]! >= a && q[2]! <= b);
          const pts = [...cuts[i]!, ...cuts[i + 1]!, ...corners];
          if (pts.length < 3) continue;
          // The sides' section keeps the profile's recesses (an H, channel or L); the hull keeps
          // the caps' slope.
          add({
            outline: cutOf(section, a)!,
            outlineTop: cutOf(section, b)!,
            zBase: a,
            zTop: b,
            holes: voids(a, b),
            within: flat(pts),
          });
        }
        return true;
      };
      if (zt - zb > 1e-6 && lo && hi) {
        add({
          outline: lo,
          ...(swept ? { outlineTop: hi } : {}),
          zBase: zb,
          zTop: zt,
          holes: voids(zb, zt),
        });
        if (zb - z0 > 1e-6 && !slabs(z0, zb))
          add({ outline: flat([...base3, ...lo]), zBase: z0, zTop: zb, holes: voids(z0, zb) });
        if (z1 - zt > 1e-6 && !slabs(zt, z1))
          add({ outline: flat([...top3, ...hi]), zBase: zt, zTop: z1, holes: voids(zt, z1) });
      } else if (!slabs(z0, z1)) {
        add({ outline: flat([...base3, ...top3]), zBase: z0, zTop: z1, holes: voids(z0, z1) });
      }
    }
  }
  return out;
}

/** The part of a polygon where `f` (linear) is at least 0 (Sutherland–Hodgman). */
function clipHalfPlane(poly: Vec2[], f: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const [fa, fb] = [f(a), f(b)];
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** The convex hull of points, counter-clockwise (monotone chain). */
function convexHull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: Vec2[]) => {
    const h: Vec2[] = [];
    for (const q of pts) {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}

/** The outline `base` → `top` (same vertices) at the fraction `k` of the way up. */
function between(base: Vec2[], top: Vec2[] | undefined, k: number): Vec2[] {
  if (!top || top.length !== base.length || k <= 0) return base;
  return base.map(([x, y], i): Vec2 => [x + (top[i]![0] - x) * k, y + (top[i]![1] - y) * k]);
}

/**
 * Whether a box standing on the floor up to `h` meets the obstacle: its sections at the bottom
 * and top of that span, and the band each side sweeps between them (a leaning solid is ruled, so
 * each side moves along a straight line; a curved footprint keeps its hollow).
 */
function sweptOverlap(box: Vec2[], o: FactoryObstacle, h: number): boolean {
  const ks = slices(o, h);
  const k0 = ks[0]!;
  const k1 = ks[ks.length - 1]!;
  const lo = between(o.outline, o.outlineTop, k0);
  if (factoryPolygonsOverlap(box, lo)) return true;
  if (k1 === k0) return false;
  const hi = between(o.outline, o.outlineTop, k1);
  if (factoryPolygonsOverlap(box, hi)) return true;
  for (let i = 0; i < lo.length; i++) {
    const j = (i + 1) % lo.length;
    if (factoryPolygonsOverlap(box, [lo[i]!, lo[j]!, hi[j]!, hi[i]!])) return true;
  }
  return false;
}

/**
 * The heights at which an obstacle is checked between the floor and `h`: one for an upright
 * one, and every 250 mm (at most 17) for a leaning one, whose section moves with height. Each
 * comes with its fraction of the way from `zBase` to `zTop`.
 */
/** The spans between consecutive `slices` (one, flat, for an upright obstacle). */
function spans(o: FactoryObstacle, h: number): (readonly [number, number])[] {
  const ks = slices(o, h);
  return ks.length > 1
    ? ks.slice(1).map((k, j) => [ks[j]!, k] as const)
    : [[ks[0]!, ks[0]!] as const];
}

function slices(o: FactoryObstacle, h: number): number[] {
  const lo = Math.max(0, o.zBase);
  const hi = Math.min(h, o.zTop);
  const k = (z: number) => (o.zTop > o.zBase ? (z - o.zBase) / (o.zTop - o.zBase) : 0);
  if (!o.outlineTop || hi <= lo) return [k(lo)];
  const n = Math.min(16, Math.max(1, Math.ceil((hi - lo) / 250)));
  return Array.from({ length: n + 1 }, (_, i) => k(lo + ((hi - lo) * i) / n));
}

/** Whether two polygons overlap: their sides touch or cross, or one holds the other. */
export function factoryPolygonsOverlap(a: Vec2[], b: Vec2[]): boolean {
  return (
    polygonsTouch(a, b) ||
    (!!a[0] && pointInPolygon(a[0], b)) ||
    (!!b[0] && pointInPolygon(b[0], a))
  );
}

/**
 * Whether `shape` (convex) lies wholly in one of a hollow column's voids at every height from the
 * floor to `h`: anything that meets the column's wall otherwise clashes. A void is convex and
 * moves along the axis and scales linearly with height, so each of its sides' half-planes moves
 * linearly too: a corner inside at the lowest and the highest height is inside at every height
 * between (the section and the void are compared at the same height, never as swept unions).
 */
function inVoid(shape: Vec2[], o: FactoryObstacle, h: number): boolean {
  if (!o.holes) return false;
  const k = (z: number) => (o.zTop > o.zBase ? (z - o.zBase) / (o.zTop - o.zBase) : 0);
  const ends = [k(Math.max(0, o.zBase)), k(Math.min(h, o.zTop))];
  return o.holes.some((v) =>
    ends.every((k) => {
      const at = between(v.outline, v.outlineTop, k);
      return shape.every((p) => within(p, at));
    }),
  );
}

/**
 * Whether `p` lies in `outline` or within `tol` mm of its sides (any simple polygon, convex or
 * not: an arc wall's opening is an annular sector).
 */
function within(p: Vec2, outline: Vec2[], tol = 1): boolean {
  if (pointInPolygon(p, outline)) return true;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = dx * dx + dy * dy;
    const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    if (Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy) <= tol) return true;
  }
  return false;
}

/**
 * FT4: where objects and vehicle lanes run into the building's walls and columns. An object's box
 * (from the floor to its height) must not touch one; a lane (`widthMm` of its widest fleet) may
 * cross a wall only through a door-like opening it fits through, in width and in height (the
 * vehicles' height is taken as 2,000 mm). Objects without `at` are not checked.
 */
export function checkFactoryBuilding(
  doc: FactoryDocument,
  bim: BimDocument,
  obstacles = factoryObstacles(bim),
): FactoryDiagnostic[] {
  const out: FactoryDiagnostic[] = [];
  doc.objects.forEach((o, i) => {
    if (!o.at) return;
    const box = factoryFootprint(o, o.at);
    const h = factoryObjectSize(o).heightMm;
    // An element may be several obstacles (a leaning column's bands): reported once.
    const met = new Set<string>();
    for (const b of obstacles) {
      if (met.has(b.elementId)) continue;
      if (b.zBase >= h || b.zTop <= 0) continue;
      if (!sweptOverlap(box, b, h)) continue;
      if (b.within && !factoryPolygonsOverlap(box, b.within)) continue;
      if (inVoid(box, b, h)) continue;
      met.add(b.elementId);
      out.push({
        code: 'object-clash',
        path: `$.objects.${i}`,
        message: `${o.name || o.id} runs into ${b.kind} ${b.elementId}`,
      });
    }
  });
  const nodes = new Map((doc.paths?.nodes ?? []).map((n) => [n.id, n]));
  const width =
    Math.max(0, ...(doc.fleets ?? []).map((f) => f.widthMm ?? factoryDefaultLaneMm)) ||
    factoryDefaultLaneMm;
  const vehicleHeight = 2000;
  (doc.paths?.segments ?? []).forEach((g, i) => {
    const a = nodes.get(g.from);
    const b = nodes.get(g.to);
    if (!a || !b) return;
    const band = lane([a.x, a.y], [b.x, b.y], width);
    const met = new Set<string>();
    for (const o of obstacles) {
      if (met.has(o.elementId)) continue;
      if (o.zBase >= vehicleHeight || o.zTop <= 0) continue;
      // Between every two heights the vehicle takes, where the lane meets the wall's swept
      // section it must pass through an opening tall enough, swept the same way.
      const blocked = spans(o, vehicleHeight).some(([k0, k1]) => {
        const wall = pieces(o.outline, o.outlineTop, k0, k1);
        if (!wall.some((w) => factoryPolygonsOverlap(band, w))) return false;
        if (o.within && !factoryPolygonsOverlap(band, o.within)) return false;
        return !o.passages.some(
          (p) =>
            // Clear up to the vehicle's height, or the wall's top where that is lower.
            p.heightMm >= Math.min(vehicleHeight, o.zTop) &&
            passesThrough(band, wall, pieces(p.outline, p.outlineTop, k0, k1)),
        );
      });
      if (!blocked || inVoid(band, o, vehicleHeight)) continue;
      met.add(o.elementId);
      out.push({
        code: 'path-clash',
        path: `$.paths.segments.${i}`,
        message: `${g.id} runs into ${o.kind} ${o.elementId}`,
      });
    }
  });
  return out;
}

/**
 * The region an outline sweeps from fraction `k0` to `k1` of the way up: its sections there and
 * the band each side sweeps between them (one section when they are the same).
 */
function pieces(base: Vec2[], top: Vec2[] | undefined, k0: number, k1: number): Vec2[][] {
  const lo = between(base, top, k0);
  if (k1 === k0 || !top) return [lo];
  const hi = between(base, top, k1);
  return [
    lo,
    hi,
    ...lo.map((_, i): Vec2[] => {
      const j = (i + 1) % lo.length;
      return [lo[i]!, lo[j]!, hi[j]!, hi[i]!];
    }),
  ];
}

/**
 * Whether the part of `band` that overlaps the wall lies in the opening: the band's corners
 * inside the wall, the wall's corners inside the band, and where their sides cross, all in the
 * opening region (wall and opening each given as the pieces of their swept region).
 */
function passesThrough(band: Vec2[], wall: Vec2[][], opening: Vec2[][]): boolean {
  const pts: Vec2[] = band.filter((p) => wall.some((w) => within(p, w)));
  for (const w of wall) {
    for (const p of w) if (pointInPolygon(p, band)) pts.push(p);
    for (let i = 0; i < band.length; i++) {
      const p = band[i]!;
      const q = band[(i + 1) % band.length]!;
      for (let j = 0; j < w.length; j++) {
        const x = crossing(p, q, w[j]!, w[(j + 1) % w.length]!);
        if (x) pts.push(x);
      }
    }
  }
  return pts.length > 0 && pts.every((p) => opening.some((o) => within(p, o)));
}

function crossing(p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 | undefined {
  const r: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const s: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return undefined;
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den;
  const u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}
