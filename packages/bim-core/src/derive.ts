import {
  add,
  arcOf,
  cross,
  distance,
  dot,
  left,
  lineIntersection,
  loopArea,
  loopEdges,
  loopEdgesSimple,
  loopInside,
  loopPerimeter,
  loopsTouch,
  loopWithin,
  polygonSimple,
  sampleLoop,
  type LoopEdge,
  scale,
  sub,
  unit,
} from './geometry';
import {
  bimLimits,
  bimTolerance,
  type BimDiagnostic,
  type BimDocument,
  type BimElement,
  type BimGridAxis,
  type BimLevelHeight,
  type BimLoop,
  type BimPoint,
  type BimProfile,
  type BimRoofShape,
  type BimTop,
  type BimType,
  type BimWall,
  type BimWallJoin,
  type Vec2,
} from './model';

/**
 * Derived shapes and quantities, computed from the document alone (no kernel). They are the common
 * source of display, drawings and IFC (docs/cad/r2c-architecture.md, 派生形状と数量).
 */

export interface BimWallOpeningShape {
  /** The opening element, door or window that makes it. */
  elementId: string;
  alongMm: number;
  sillMm: number;
  widthMm: number;
  heightMm: number;
}
export type BimShape =
  | {
      kind: 'wall';
      /** Plan footprint after joins (counter-clockwise). */
      footprint: BimLoop;
      zBase: number;
      zTop: number;
      openings: BimWallOpeningShape[];
      clipBy?: string;
    }
  | { kind: 'slab'; boundary: BimLoop; holes: BimLoop[]; zBottom: number; zTop: number }
  | {
      kind: 'column';
      at: Vec2;
      rotationRad: number;
      profile: BimProfile;
      zBase: number;
      zTop: number;
      clipBy?: string;
    }
  | { kind: 'beam'; start: Vec2; end: Vec2; zTop: number; profile: BimProfile }
  | {
      kind: 'roof';
      form: BimRoofShape['form'];
      boundary: BimLoop;
      /** The underside at the eaves. */
      zBase: number;
      /** One plane for flat and mono-pitch roofs, two for gable, four for hip. */
      faces: BimRoofFace[];
      thicknessMm: number;
    }
  | { kind: 'space'; boundary: BimLoop; zBase: number; zTop: number }
  | { kind: 'part'; at: Vec2; rotationRad: number; zBase: number }
  /** Openings, doors and windows: their shape is a void in the host. */
  | { kind: 'void'; hostId: string };

/**
 * A plane of a roof's underside: its height at a plan point is
 * `zBase + slope·dot(p − origin, direction)`. The underside is the lowest of the planes, which
 * over `region` (a counter-clockwise polygon; absent on a one-plane roof: the whole boundary)
 * is this one. The top is each plane raised by the thickness across it.
 */
export interface BimRoofFace {
  origin: Vec2;
  direction: Vec2;
  slope: number;
  region?: Vec2[];
}

/** Base quantities in mm, mm² and mm³. `source: 'kernel'` means the kernel must measure them. */
export interface BimQuantities {
  source: 'analytic' | 'kernel' | 'none';
  values: Record<string, number>;
}
export interface BimDerived {
  shapes: Map<string, BimShape>;
  quantities: Map<string, BimQuantities>;
  diagnostics: BimDiagnostic[];
}

export const profileArea = (p: BimProfile): number => {
  switch (p.shape) {
    case 'rect':
      return p.widthMm * p.depthMm;
    case 'circle':
      return (Math.PI * p.diameterMm * p.diameterMm) / 4;
    case 'h':
    case 'channel':
      return 2 * p.widthMm * p.flangeMm + (p.depthMm - 2 * p.flangeMm) * p.webMm;
    case 'l':
      return p.thicknessMm * (p.widthMm + p.depthMm - p.thicknessMm);
    case 'box':
      return p.widthMm * p.depthMm - (p.widthMm - 2 * p.wallMm) * (p.depthMm - 2 * p.wallMm);
  }
};
export const layersThickness = (t: BimType) =>
  'layers' in t ? t.layers.reduce((n, l) => n + l.thicknessMm, 0) : 0;

class DeriveError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(code);
  }
}

/**
 * The wall a butt join runs through: the given one, else the wall a T meets, else the first.
 * Miter joins have none.
 */
export function bimJoinThrough(doc: BimDocument, join: BimWallJoin): string | undefined {
  if (join.kind !== 'butt') return undefined;
  if (join.through !== undefined) return join.through;
  const ctx = new BimContext(doc);
  const [a, b] = join.walls.map((id) => {
    const w = ctx.elements.get(id) as BimWall;
    return { id, s: ctx.point(w.start, ''), e: ctx.point(w.end, '') };
  });
  const touches = [a.s, a.e].some((p) => [b.s, b.e].some((q) => distance(p, q) <= bimTolerance));
  if (!touches)
    for (const [through, stop] of [
      [b, a],
      [a, b],
    ]) {
      const u = unit(sub(through.e, through.s));
      const inside = (p: Vec2) => {
        const t = dot(sub(p, through.s), u);
        return (
          Math.abs(cross(u, sub(p, through.s))) <= bimTolerance &&
          t > bimTolerance &&
          t < distance(through.s, through.e) - bimTolerance
        );
      };
      if (inside(stop.s) || inside(stop.e)) return through.id;
    }
  return a.id;
}

function withinLimit(z: number, path: string) {
  if (!(Math.abs(z) <= bimLimits.coordinateMm)) throw new DeriveError('coordinate', path);
  return z;
}

/** Lookups for one document. Callers have checked IDs and references structurally. */
export class BimContext {
  readonly levels;
  readonly grids;
  readonly types;
  readonly elements;
  readonly sortedLevels;
  constructor(readonly doc: BimDocument) {
    this.levels = new Map(doc.levels.map((l) => [l.id, l]));
    this.grids = new Map(doc.grids.map((g) => [g.id, g]));
    this.types = new Map(doc.types.map((t) => [t.id, t]));
    this.elements = new Map(doc.elements.map((e) => [e.id, e]));
    this.sortedLevels = [...doc.levels].sort((a, b) => a.elevationMm - b.elevationMm);
  }
  /** A resolved elevation; sums of valid parts may still leave the coordinate limit. */
  height(h: BimLevelHeight, path = '') {
    return withinLimit(this.levels.get(h.level)!.elevationMm + h.offsetMm, path);
  }
  top(base: number, top: BimTop, path = '') {
    return 'heightMm' in top ? withinLimit(base + top.heightMm, path) : this.height(top, path);
  }
  /** The level directly above `levelId`, if any. */
  levelAbove(levelId: string) {
    const i = this.sortedLevels.findIndex((l) => l.id === levelId);
    return this.sortedLevels[i + 1];
  }
  point(p: BimPoint, path: string): Vec2 {
    if ('xy' in p) return p.xy;
    const [a, b] = p.grid.map((id) => this.grids.get(id)!) as [BimGridAxis, BimGridAxis];
    const hit = lineIntersection(a.start, sub(a.end, a.start), b.start, sub(b.end, b.start));
    if (!hit || a.id === b.id) throw new DeriveError('grid-no-intersection', path);
    // Nearly parallel axes meet far away: the model's coordinate limit holds there too.
    if (hit.some((c) => !(Math.abs(c) <= bimLimits.coordinateMm)))
      throw new DeriveError('coordinate', path);
    return hit;
  }
}

interface WallFrame {
  wall: BimWall;
  path: string;
  s: Vec2;
  e: Vec2;
  /** Straight walls only. */
  u: Vec2;
  n: Vec2;
  length: number;
  thickness: number;
  leftOff: number;
  rightOff: number;
  zBase: number;
  zTop: number;
  /** Face points at each end: [left, right]. */
  ends: { start: [Vec2, Vec2]; end: [Vec2, Vec2] };
  /** Axial extents near each end that joins changed; openings must stay out of them. */
  zones: { start: number; end: number; spans: [number, number][] };
  arc?: ReturnType<typeof arcOf>;
}

function wallFrame(ctx: BimContext, wall: BimWall, path: string): WallFrame {
  const s = ctx.point(wall.start, `${path}.start`);
  const e = ctx.point(wall.end, `${path}.end`);
  if (distance(s, e) < bimTolerance) throw new DeriveError('wall-degenerate', path);
  const thickness = layersThickness(ctx.types.get(wall.typeId)!);
  const [leftOff, rightOff] =
    wall.location === 'center'
      ? [thickness / 2, -thickness / 2]
      : wall.location === 'left'
        ? [0, -thickness]
        : [thickness, 0];
  const zBase = ctx.height(wall.base, `${path}.base`);
  const zTop = ctx.top(zBase, wall.top, `${path}.top`);
  if (zTop <= zBase + bimTolerance) throw new DeriveError('level-order', `${path}.top`);
  const u = unit(sub(e, s));
  const n = left(u);
  const at = (p: Vec2): [Vec2, Vec2] => [add(p, scale(n, leftOff)), add(p, scale(n, rightOff))];
  const frame: WallFrame = {
    wall,
    path,
    s,
    e,
    u,
    n,
    length: distance(s, e),
    thickness,
    leftOff,
    rightOff,
    zBase,
    zTop,
    ends: { start: at(s), end: at(e) },
    zones: { start: 0, end: 0, spans: [] },
  };
  if (wall.bulge) {
    const arc = arcOf(s, e, wall.bulge);
    if (!(arc.radius <= bimLimits.arcRadiusMm)) throw new DeriveError('arc-too-flat', path);
    // An arc wall's faces are concentric arcs; offsets are measured to the left of travel.
    const towardCenter = Math.sign(arc.sweep);
    const radiusAt = (off: number) => arc.radius - towardCenter * off;
    if (radiusAt(leftOff) <= bimTolerance || radiusAt(rightOff) <= bimTolerance)
      throw new DeriveError('wall-degenerate', path);
    const radial = (p: Vec2, off: number) =>
      add(arc.center, scale(unit(sub(p, arc.center)), radiusAt(off)));
    frame.arc = arc;
    frame.length = arc.radius * Math.abs(arc.sweep);
    frame.ends = {
      start: [radial(s, leftOff), radial(s, rightOff)],
      end: [radial(e, leftOff), radial(e, rightOff)],
    };
  }
  return frame;
}

type WallEnd = 'start' | 'end';
const endPoint = (f: WallFrame, end: WallEnd) => (end === 'start' ? f.s : f.e);
/**
 * The wall's axis at an end as a straight wall's: a point on it, the direction of travel and
 * its left normal. An arc wall's is its tangent at that end (OH-U3): a join picks faces and the
 * wall that runs through by it as for a straight wall, then puts the corners where the faces
 * themselves meet.
 */
const endAxis = (f: WallFrame, end?: WallEnd): { s: Vec2; u: Vec2; n: Vec2 } => {
  if (!f.arc || !end) return { s: f.s, u: f.u, n: f.n };
  const p = endPoint(f, end);
  const r = unit(sub(p, f.arc.center));
  const u: Vec2 = f.arc.sweep > 0 ? left(r) : [r[1], -r[0]];
  return { s: p, u, n: left(u) };
};
/** The face lines of a wall at an end: [left, right] as point and direction. */
const faceLines = (f: WallFrame, end?: WallEnd): [Vec2, Vec2][] => {
  const a = endAxis(f, end);
  return [
    [add(a.s, scale(a.n, f.leftOff)), a.u],
    [add(a.s, scale(a.n, f.rightOff)), a.u],
  ];
};
/** Unit vector from the given end into the wall. */
const into = (f: WallFrame, end: WallEnd) => {
  const { u } = endAxis(f, end);
  return end === 'start' ? u : scale(u, -1);
};
/** Index of the face of `f` at `end` that lies furthest along `dir` (0 left, 1 right). */
const faceToward = (f: WallFrame, dir: Vec2, end?: WallEnd) => {
  const { n } = endAxis(f, end);
  return dot(scale(n, f.leftOff), dir) >= dot(scale(n, f.rightOff), dir) ? 0 : 1;
};
/** How far along the axis from the start `p` lies (an arc wall's: along its arc). */
const axial = (f: WallFrame, p: Vec2) => {
  if (!f.arc) return dot(sub(p, f.s), f.u);
  const sign = Math.sign(f.arc.sweep);
  return f.arc.radius * turn(sign * (angleOf(f, p) - f.arc.startAngle));
};
const angleOf = (f: WallFrame, p: Vec2) =>
  Math.atan2(p[1] - f.arc!.center[1], p[0] - f.arc!.center[0]);
/** An angle in (−π/2, 3π/2]: a turn along an arc of at most a half circle, a little either side. */
const turn = (a: number) => {
  const t = (((a + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return (t === 0 ? 2 * Math.PI : t) - Math.PI / 2;
};
/** A face of a wall: a line (point, direction) or, on an arc wall, a circle. */
type FaceCurve = { p: Vec2; d: Vec2 } | { c: Vec2; r: number };
const faceCurve = (f: WallFrame, k: number): FaceCurve => {
  if (!f.arc) return { p: faceLines(f)[k]![0], d: f.u };
  const off = k === 0 ? f.leftOff : f.rightOff;
  return { c: f.arc.center, r: f.arc.radius - Math.sign(f.arc.sweep) * off };
};
/**
 * Where two faces meet, the crossing nearest `near` (OH-U3: an arc wall's face is its circle, so
 * a joined corner lies on both walls' faces). Undefined when they do not meet.
 */
function meet(x: FaceCurve, y: FaceCurve, near: Vec2): Vec2 | undefined {
  const nearest = (ps: Vec2[]) =>
    ps.sort((a, b) => distance(a, near) - distance(b, near))[0] as Vec2 | undefined;
  if ('p' in x && 'p' in y) return lineIntersection(x.p, x.d, y.p, y.d);
  if ('c' in x && 'p' in y) return meet(y, x, near);
  if ('p' in x && 'c' in y) {
    const w = sub(x.p, y.c);
    const b = dot(w, x.d);
    const disc = b * b - (dot(w, w) - y.r * y.r);
    if (disc < 0) return undefined;
    return nearest([-1, 1].map((k) => add(x.p, scale(x.d, -b + k * Math.sqrt(disc)))));
  }
  const [a, b] = [x as { c: Vec2; r: number }, y as { c: Vec2; r: number }];
  const d = distance(a.c, b.c);
  if (d < bimTolerance || d > a.r + b.r || d < Math.abs(a.r - b.r)) return undefined;
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const u = unit(sub(b.c, a.c));
  const m = add(a.c, scale(u, along));
  return nearest([add(m, scale(left(u), h)), add(m, scale(left(u), -h))]);
}
/**
 * Moves an end's face points, found on its faces' tangent lines, onto where its faces meet
 * `other` (each point's crossing nearest it). A straight wall meeting a straight face is exact
 * already. Fails the join when a face does not reach it.
 */
function meetFaces(f: WallFrame, end: WallEnd, other: FaceCurve, path: string) {
  f.ends[end] = f.ends[end].map((near, k) => {
    const p = meet(faceCurve(f, k), other, near);
    if (!p) throw new DeriveError('join-failed', path);
    return p;
  }) as [Vec2, Vec2];
}

function applyJoin(
  frames: Map<string, WallFrame>,
  join: BimWallJoin,
  path: string,
  used: Set<string>,
  points: { p: Vec2; lo: number; hi: number }[],
) {
  const [a, b] = join.walls.map((id) => frames.get(id)!) as [WallFrame, WallFrame];
  const ends = ['start', 'end'] as const;
  // L: an end of each wall at the same point. T: an end of one wall inside the other's axis.
  let shape: { kind: 'L'; ea: 'start' | 'end'; eb: 'start' | 'end' } | undefined;
  for (const ea of ends)
    for (const eb of ends)
      if (distance(endPoint(a, ea), endPoint(b, eb)) <= bimTolerance) shape = { kind: 'L', ea, eb };
  // An arc wall joins only at an end, by its tangent there (OH-U3): no T.
  if ((a.arc || b.arc) && !shape) throw new DeriveError('join-unsupported', path);
  const ua = endAxis(a, shape?.ea).u;
  const ub = endAxis(b, shape?.eb).u;
  if (Math.abs(cross(ua, ub)) < 1e-9) throw new DeriveError('join-failed', path);
  let tee: { through: WallFrame; stop: WallFrame; end: 'start' | 'end' } | undefined;
  if (!shape)
    for (const [through, stop] of [
      [a, b],
      [b, a],
    ] as const)
      for (const end of ends) {
        const p = endPoint(stop, end);
        const t = axial(through, p);
        const off = Math.abs(dot(sub(p, through.s), through.n));
        if (off <= bimTolerance && t > bimTolerance && t < through.length - bimTolerance)
          tee = { through, stop, end };
      }
  if (!shape && !tee) throw new DeriveError('join-not-touching', path);
  const claim = (key: string) => {
    if (used.has(key)) throw new DeriveError('join-unsupported', path);
    used.add(key);
  };
  // A joined point: two joins at one plan point clash only where their walls overlap in height.
  const claimPoint = (p: Vec2, ws: WallFrame[]) => {
    const lo = Math.max(...ws.map((w) => w.zBase));
    const hi = Math.min(...ws.map((w) => w.zTop));
    if (
      points.some(
        (q) =>
          distance(q.p, p) <= bimTolerance && q.lo < hi - bimTolerance && lo < q.hi - bimTolerance,
      )
    )
      throw new DeriveError('join-unsupported', path);
    points.push({ p, lo, hi });
  };

  if (tee) {
    if (join.kind !== 'butt') throw new DeriveError('join-unsupported', path);
    if (join.through !== undefined && join.through !== tee.through.wall.id)
      throw new DeriveError('join-through', `${path}.through`);
    claim(`${tee.stop.wall.id}:${tee.end}`);
    claimPoint(endPoint(tee.stop, tee.end), [a, b]);
    butt(tee.through, tee.stop, tee.end, undefined, path);
    return;
  }
  const { ea, eb } = shape!;
  claim(`${a.wall.id}:${ea}`);
  claim(`${b.wall.id}:${eb}`);
  claimPoint(endPoint(a, ea), [a, b]);
  if (join.kind === 'miter') {
    if (Math.abs(a.zBase - b.zBase) > bimTolerance || Math.abs(a.zTop - b.zTop) > bimTolerance)
      throw new DeriveError('join-height-mismatch', path);
    if (Math.abs(a.thickness - b.thickness) > bimTolerance || a.wall.location !== b.wall.location)
      throw new DeriveError('join-thickness-mismatch', path);
    // Inner faces meet inner faces, outer faces meet outer faces.
    const la = faceLines(a, ea);
    const lb = faceLines(b, eb);
    const ia = faceToward(a, into(b, eb), ea);
    const ib = faceToward(b, into(a, ea), eb);
    const inner = lineIntersection(la[ia][0], la[ia][1], lb[ib][0], lb[ib][1])!;
    const outer = lineIntersection(la[1 - ia][0], la[1 - ia][1], lb[1 - ib][0], lb[1 - ib][1])!;
    const set = (f: WallFrame, end: 'start' | 'end', innerIdx: number) => {
      const pair: [Vec2, Vec2] = innerIdx === 0 ? [inner, outer] : [outer, inner];
      f.ends[end] = pair;
    };
    // On an arc wall, the corners are where the faces themselves meet (OH-U3).
    if (a.arc || b.arc) {
      const at = (i: number, j: number, near: Vec2) => {
        const p = meet(faceCurve(a, i), faceCurve(b, j), near);
        if (!p) throw new DeriveError('join-failed', path);
        return p;
      };
      const exact = [at(ia, ib, inner), at(1 - ia, 1 - ib, outer)] as const;
      set(a, ea, ia);
      set(b, eb, ib);
      for (const [f, e, i] of [
        [a, ea, ia],
        [b, eb, ib],
      ] as const)
        f.ends[e] = i === 0 ? [exact[0], exact[1]] : [exact[1], exact[0]];
    } else {
      set(a, ea, ia);
      set(b, eb, ib);
    }
    return;
  }
  const through = join.through === b.wall.id ? b : a;
  if (join.through !== undefined && join.through !== a.wall.id && join.through !== b.wall.id)
    throw new DeriveError('join-through', `${path}.through`);
  const stop = through === a ? b : a;
  const throughEnd = through === a ? ea : eb;
  const stopEnd = through === a ? eb : ea;
  butt(through, stop, stopEnd, throughEnd, path);
}

/** `stop` ends at the face of `through` facing it; an L's through wall runs to stop's far face. */
function butt(
  through: WallFrame,
  stop: WallFrame,
  stopEnd: 'start' | 'end',
  throughEnd: 'start' | 'end' | undefined,
  path: string,
) {
  if (through.zBase > stop.zBase + bimTolerance || through.zTop < stop.zTop - bimTolerance)
    throw new DeriveError('join-height-mismatch', path);
  // A T's through wall is straight; an L's walls are taken at their joined ends.
  const lt = faceLines(through, throughEnd);
  const ls = faceLines(stop, stopEnd);
  const nearFace = faceToward(through, into(stop, stopEnd), throughEnd);
  const near = lt[nearFace];
  stop.ends[stopEnd] = ls.map((l) => lineIntersection(l[0], l[1], near[0], near[1])!) as [
    Vec2,
    Vec2,
  ];
  // With an arc wall, each end lies where the faces themselves meet (OH-U3).
  if (stop.arc || through.arc) meetFaces(stop, stopEnd, faceCurve(through, nearFace), path);
  if (throughEnd) {
    const farFace = faceToward(stop, scale(into(through, throughEnd), -1), stopEnd);
    const far = ls[farFace];
    through.ends[throughEnd] = lt.map((l) => lineIntersection(l[0], l[1], far[0], far[1])!) as [
      Vec2,
      Vec2,
    ];
    if (stop.arc || through.arc) meetFaces(through, throughEnd, faceCurve(stop, farFace), path);
  }
  // The stopping wall meets the through wall over this stretch of its axis.
  const ts = stop.ends[stopEnd].map((p) => axial(through, p));
  through.zones.spans.push([Math.min(...ts), Math.max(...ts)]);
}

function wallFootprint(f: WallFrame): BimLoop {
  const [sl, sr] = f.ends.start;
  const [el, er] = f.ends.end;
  // Each face arc from its start point to its end point: a join may have moved them (OH-U3).
  const face = (p: Vec2, q: Vec2) => {
    const sign = Math.sign(f.arc!.sweep);
    return sign * Math.tan(turn(sign * (angleOf(f, q) - angleOf(f, p))) / 4);
  };
  // Left face, end, right face back, start: clockwise or counter-clockwise by the offsets.
  const loop: BimLoop = f.arc
    ? [
        [sl[0], sl[1], face(sl, el)],
        [el[0], el[1]],
        [er[0], er[1], -face(sr, er)],
        [sr[0], sr[1]],
      ]
    : [
        [sl[0], sl[1]],
        [el[0], el[1]],
        [er[0], er[1]],
        [sr[0], sr[1]],
      ];
  return loopArea(loop) < 0 ? reverseLoop(loop) : loop;
}
/** The same loop traversed the other way (bulges move to the other vertex and change sign). */
export function reverseLoop(loop: BimLoop): BimLoop {
  const n = loop.length;
  return loop.map((_, k) => {
    const v = loop[n - 1 - k];
    const prev = loop[(2 * n - 2 - k) % n];
    return prev[2] ? [v[0], v[1], -prev[2]] : [v[0], v[1]];
  });
}

/** Area of an opening's plan cut through a wall, exact for arc walls. */
function openingPlanArea(f: WallFrame, widthMm: number) {
  if (!f.arc) return widthMm * f.thickness;
  const towardCenter = Math.sign(f.arc.sweep);
  const r1 = f.arc.radius - towardCenter * f.leftOff;
  const r2 = f.arc.radius - towardCenter * f.rightOff;
  const angle = widthMm / f.arc.radius;
  return (angle * Math.abs(r1 * r1 - r2 * r2)) / 2;
}

const loopPolygon = (loop: BimLoop) => sampleLoop(loop);
/** A loop is simple (exact along arcs) and of non-zero area. */
export const loopSimple = (loop: BimLoop) =>
  Math.abs(loopArea(loop)) > bimTolerance && loopEdgesSimple(loopEdges(loop));

export function deriveBim(doc: BimDocument): BimDerived {
  const ctx = new BimContext(doc);
  const shapes = new Map<string, BimShape>();
  const quantities = new Map<string, BimQuantities>();
  const diagnostics: BimDiagnostic[] = [];
  const fail = (err: unknown, id: string | undefined, fallbackPath: string) => {
    if (!(err instanceof DeriveError)) throw err;
    diagnostics.push({ code: err.code, path: err.path || fallbackPath, severity: 'error', id });
  };
  const index = new Map(doc.elements.map((e, i) => [e.id, i]));
  const pathOf = (id: string) => `$.elements[${index.get(id)}]`;

  // Walls and joins first: openings and quantities depend on the joined footprints.
  const frames = new Map<string, WallFrame>();
  for (const e of doc.elements)
    if (e.kind === 'wall')
      try {
        frames.set(e.id, wallFrame(ctx, e, pathOf(e.id)));
      } catch (err) {
        fail(err, e.id, pathOf(e.id));
      }
  const used = new Set<string>();
  const points: { p: Vec2; lo: number; hi: number }[] = [];
  doc.joins.forEach((j, i) => {
    if (!j.walls.every((w) => frames.has(w))) return;
    try {
      applyJoin(frames, j, `$.joins[${i}]`, used, points);
    } catch (err) {
      fail(err, j.id, `$.joins[${i}]`);
    }
  });
  const footprints = new Map<string, BimLoop>();
  for (const f of frames.values()) {
    const fp = wallFootprint(f);
    // Each face must keep a positive length: a join may not trim a wall past its other end. An
    // arc wall's faces stay within a half circle (|bulge| ≤ 1), as a building's arcs do, and its
    // joined faces may not cross each other (they can meet twice, OH-U3).
    const inverted = [0, 1].some(
      (k) => axial(f, f.ends.end[k]) - axial(f, f.ends.start[k]) <= bimTolerance,
    );
    const tooLong = fp.some((v) => Math.abs(v[2] ?? 0) > 1 + 1e-9);
    const simple = f.arc ? loopSimple(fp) : polygonSimple(loopPolygon(fp));
    if (inverted || tooLong || !simple) {
      diagnostics.push({ code: 'join-failed', path: f.path, severity: 'error', id: f.wall.id });
      continue;
    }
    // An arc wall bulges past its ends; its faces must stay within the limit too.
    if (!loopWithinLimit(fp)) {
      diagnostics.push({ code: 'coordinate', path: f.path, severity: 'error', id: f.wall.id });
      continue;
    }
    footprints.set(f.wall.id, fp);
    // Join zones: how far each end's face points reach into the wall along its axis.
    f.zones.start = Math.max(0, ...f.ends.start.map((p) => axial(f, p)));
    f.zones.end = Math.max(0, ...f.ends.end.map((p) => f.length - axial(f, p)));
  }

  // Hosted openings, by host.
  const wallOpenings = new Map<string, BimWallOpeningShape[]>();
  const slabOpenings = new Map<string, { id: string; loop: BimLoop }[]>();
  for (const e of doc.elements) {
    if (e.kind !== 'opening' && e.kind !== 'door' && e.kind !== 'window') continue;
    const path = pathOf(e.id);
    try {
      if (e.kind === 'opening' && 'slab' in e) {
        const list = slabOpenings.get(e.hostId) ?? [];
        list.push({ id: e.id, loop: e.slab.boundary });
        slabOpenings.set(e.hostId, list);
      } else {
        const f = frames.get(e.hostId);
        if (!f) continue; // the host wall itself failed and is reported
        const t = ctx.types.get('typeId' in e ? e.typeId : '');
        const o: BimWallOpeningShape =
          e.kind === 'opening' && 'wall' in e
            ? { elementId: e.id, ...e.wall }
            : {
                elementId: e.id,
                alongMm: e.alongMm,
                sillMm: e.kind === 'window' ? e.sillMm : 0,
                widthMm: t && 'widthMm' in t ? t.widthMm : 0,
                heightMm: t && 'heightMm' in t ? t.heightMm : 0,
              };
        const height = f.zTop - f.zBase;
        if (
          o.alongMm < -bimTolerance ||
          o.alongMm + o.widthMm > f.length + bimTolerance ||
          o.sillMm < -bimTolerance ||
          o.sillMm + o.heightMm > height + bimTolerance
        )
          throw new DeriveError('opening-outside-host', path);
        const lo = o.alongMm;
        const hi = o.alongMm + o.widthMm;
        if (
          lo < f.zones.start - bimTolerance ||
          hi > f.length - f.zones.end + bimTolerance ||
          f.zones.spans.some(([a, b]) => lo < b - bimTolerance && hi > a + bimTolerance)
        )
          throw new DeriveError('opening-in-join', path);
        const list = wallOpenings.get(e.hostId) ?? [];
        const clash = list.some(
          (p) =>
            lo < p.alongMm + p.widthMm - bimTolerance &&
            hi > p.alongMm + bimTolerance &&
            o.sillMm < p.sillMm + p.heightMm - bimTolerance &&
            o.sillMm + o.heightMm > p.sillMm + bimTolerance,
        );
        if (clash) throw new DeriveError('opening-overlap', path);
        list.push(o);
        wallOpenings.set(e.hostId, list);
      }
      shapes.set(e.id, { kind: 'void', hostId: e.hostId });
      quantities.set(e.id, { source: 'none', values: {} });
    } catch (err) {
      fail(err, e.id, path);
    }
  }

  for (const e of doc.elements) {
    const path = pathOf(e.id);
    try {
      deriveElement(e, path);
    } catch (err) {
      fail(err, e.id, path);
    }
  }
  return { shapes, quantities, diagnostics };

  function deriveElement(e: BimElement, path: string) {
    switch (e.kind) {
      case 'wall': {
        const f = frames.get(e.id);
        const footprint = footprints.get(e.id);
        if (!f || !footprint) return;
        const openings = wallOpenings.get(e.id) ?? [];
        const height = f.zTop - f.zBase;
        const footArea = loopArea(footprint);
        const openingArea = openings.reduce((n, o) => n + o.widthMm * o.heightMm, 0);
        const openingVolume = openings.reduce(
          (n, o) => n + openingPlanArea(f, o.widthMm) * o.heightMm,
          0,
        );
        shapes.set(e.id, {
          kind: 'wall',
          footprint,
          zBase: f.zBase,
          zTop: f.zTop,
          openings,
          ...(e.clipBy ? { clipBy: e.clipBy } : {}),
        });
        const values: Record<string, number> = {
          length: f.length,
          height,
          width: f.thickness,
          footprintArea: footArea,
          grossSideArea: f.length * height,
          openingArea,
          netSideArea: f.length * height - openingArea,
        };
        if (!e.clipBy) {
          values.grossVolume = footArea * height;
          values.netVolume = footArea * height - openingVolume;
        }
        quantities.set(e.id, { source: e.clipBy ? 'kernel' : 'analytic', values });
        return;
      }
      case 'slab': {
        checkLoop(e.boundary, `${path}.boundary`);
        const outer = loopEdges(e.boundary);
        const voids = [
          ...e.holes.map((h, i) => ({ loop: h, path: `${path}.holes[${i}]`, opening: false })),
          ...(slabOpenings.get(e.id) ?? []).map((o) => ({
            loop: o.loop,
            path: `${pathOf(o.id)}.slab.boundary`,
            opening: true,
          })),
        ];
        const placed: LoopEdge[][] = [];
        for (const v of voids) {
          checkLoop(v.loop, v.path);
          const edges = loopEdges(v.loop);
          if (!loopInside(edges, outer))
            throw new DeriveError(v.opening ? 'opening-outside-host' : 'hole-outside', v.path);
          if (
            placed.some((p) => loopsTouch(p, edges) || loopWithin(p, edges) || loopWithin(edges, p))
          )
            throw new DeriveError(v.opening ? 'opening-overlap' : 'hole-overlap', v.path);
          placed.push(edges);
        }
        const thickness = layersThickness(ctx.types.get(e.typeId)!);
        const zTop = ctx.height(e.top, `${path}.top`);
        const gross = Math.abs(loopArea(e.boundary));
        const area = gross - voids.reduce((n, v) => n + Math.abs(loopArea(v.loop)), 0);
        shapes.set(e.id, {
          kind: 'slab',
          boundary: ccw(e.boundary),
          holes: voids.map((v) => ccw(v.loop)),
          zBottom: withinLimit(zTop - thickness, `${path}.top`),
          zTop,
        });
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            grossArea: gross,
            netArea: area,
            perimeter: loopPerimeter(e.boundary),
            depth: thickness,
            grossVolume: gross * thickness,
            netVolume: area * thickness,
          },
        });
        return;
      }
      case 'column': {
        const at = ctx.point(e.at, `${path}.at`);
        const zBase = ctx.height(e.base, `${path}.base`);
        const zTop = ctx.top(zBase, e.top, `${path}.top`);
        if (zTop <= zBase + bimTolerance) throw new DeriveError('level-order', `${path}.top`);
        const t = ctx.types.get(e.typeId)! as Extract<BimType, { profile: unknown }>;
        planWithinLimit([at], profileReach(t.profile), `${path}.at`);
        shapes.set(e.id, {
          kind: 'column',
          at,
          rotationRad: e.rotationRad,
          profile: t.profile,
          zBase,
          zTop,
          ...(e.clipBy ? { clipBy: e.clipBy } : {}),
        });
        const a = profileArea(t.profile);
        const values: Record<string, number> = { length: zTop - zBase, crossSectionArea: a };
        if (!e.clipBy) values.netVolume = a * (zTop - zBase);
        quantities.set(e.id, { source: e.clipBy ? 'kernel' : 'analytic', values });
        return;
      }
      case 'beam': {
        const s = ctx.point(e.start, `${path}.start`);
        const en = ctx.point(e.end, `${path}.end`);
        if (distance(s, en) < bimTolerance) throw new DeriveError('beam-degenerate', path);
        const t = ctx.types.get(e.typeId)! as Extract<BimType, { profile: unknown }>;
        planWithinLimit([s, en], profileReach(t.profile), path);
        const zTop = ctx.height(e.top, `${path}.top`);
        withinLimit(zTop - profileDepth(t.profile), `${path}.top`);
        shapes.set(e.id, {
          kind: 'beam',
          start: s,
          end: en,
          zTop,
          profile: t.profile,
        });
        const a = profileArea(t.profile);
        const len = distance(s, en);
        quantities.set(e.id, {
          source: 'analytic',
          values: { length: len, crossSectionArea: a, netVolume: a * len },
        });
        return;
      }
      case 'roof': {
        checkLoop(e.boundary, `${path}.boundary`);
        const thickness = layersThickness(ctx.types.get(e.typeId)!);
        const zBase = ctx.height(e.base, `${path}.base`);
        const projected = Math.abs(loopArea(e.boundary));
        const poly = loopPolygon(e.boundary);
        let faces: BimRoofFace[] = [{ origin: poly[0], direction: [1, 0], slope: 0 }];
        if (e.shape.form === 'mono') {
          const direction: Vec2 = [Math.cos(e.shape.directionRad), Math.sin(e.shape.directionRad)];
          // The underside is lowest at the boundary point furthest against the rise.
          faces = [
            {
              origin: loopExtreme(e.boundary, direction),
              direction,
              slope: Math.tan(e.shape.slopeRad),
            },
          ];
        } else if (e.shape.form === 'gable' || e.shape.form === 'hip')
          faces = pitchedFaces(e.boundary, e.shape, path);
        const slope = faces[0].slope;
        const cos = Math.cos(Math.atan(slope));
        // The highest point of the top face: the rise across each plane's part and the thickness.
        const rise = Math.max(
          ...faces.map((f) =>
            f.region
              ? Math.max(...f.region.map((p) => f.slope * dot(sub(p, f.origin), f.direction)))
              : f.slope *
                dot(sub(loopExtreme(e.boundary, scale(f.direction, -1)), f.origin), f.direction),
          ),
        );
        withinLimit(zBase + rise + thickness / cos, `${path}.shape`);
        shapes.set(e.id, {
          kind: 'roof',
          form: e.shape.form,
          boundary: ccw(e.boundary),
          zBase,
          faces,
          thicknessMm: thickness,
        });
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            projectedArea: projected,
            grossArea: projected / cos,
            depth: thickness,
            grossVolume: (projected * thickness) / cos,
          },
        });
        return;
      }
      case 'space': {
        checkLoop(e.boundary, `${path}.boundary`);
        const zBase = ctx.height(e.base, `${path}.base`);
        let zTop: number;
        if (e.top) zTop = ctx.top(zBase, e.top, `${path}.top`);
        else {
          const above = ctx.levelAbove(e.base.level);
          if (!above) throw new DeriveError('space-no-level-above', `${path}.base`);
          zTop = above.elevationMm;
        }
        if (zTop <= zBase + bimTolerance) throw new DeriveError('level-order', `${path}.top`);
        const area = Math.abs(loopArea(e.boundary));
        shapes.set(e.id, { kind: 'space', boundary: ccw(e.boundary), zBase, zTop });
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            netFloorArea: area,
            netPerimeter: loopPerimeter(e.boundary),
            height: zTop - zBase,
            netVolume: area * (zTop - zBase),
          },
        });
        return;
      }
      case 'part': {
        shapes.set(e.id, {
          kind: 'part',
          at: ctx.point(e.at, `${path}.at`),
          rotationRad: e.rotationRad,
          zBase: ctx.height(e.base, `${path}.base`),
        });
        quantities.set(e.id, { source: 'none', values: {} });
        return;
      }
      default:
        return; // openings, doors and windows were derived with their hosts
    }
  }
}

/**
 * The planes of a gable or hip roof over a rectangle, each rising from one side (its eave) at
 * the same slope, with the part of the plan where it is the lowest.
 */
function pitchedFaces(
  boundary: BimLoop,
  shape: Extract<BimRoofShape, { form: 'gable' | 'hip' }>,
  path: string,
): BimRoofFace[] {
  const c = loopPolygon(ccw(boundary));
  const edges = c.map((p, i) => sub(c[(i + 1) % c.length], p));
  const lens = edges.map((d) => Math.hypot(...d));
  const rectangle =
    c.length === 4 &&
    boundary.every((v) => !v[2]) &&
    edges.every(
      (d, i) => Math.abs(dot(d, edges[(i + 1) % 4])) <= 1e-9 * lens[i] * lens[(i + 1) % 4],
    );
  if (!rectangle) throw new DeriveError('roof-shape', `${path}.boundary`);
  const inward = edges.map((d) => left(unit(d)));
  const slope = Math.tan(shape.slopeRad);
  let eaves: number[];
  let half: number;
  if (shape.form === 'gable') {
    const ridge: Vec2 = [Math.cos(shape.ridgeRad), Math.sin(shape.ridgeRad)];
    eaves = [0, 1, 2, 3].filter((i) => Math.abs(cross(unit(edges[i]), ridge)) <= 1e-9);
    if (eaves.length !== 2) throw new DeriveError('roof-ridge', `${path}.shape.ridgeRad`);
    half = lens[(eaves[0] + 1) % 4] / 2;
  } else {
    eaves = [0, 1, 2, 3];
    half = Math.min(...lens) / 2;
  }
  // A gable's part is the half to the ridge. A hip's: from its side to the points at `half`
  // from both sides at each corner (they meet on the short sides' middles).
  const inner = (i: number, corner: number): Vec2 =>
    shape.form === 'gable'
      ? add(c[corner], scale(inward[i], half))
      : add(c[corner], scale(add(inward[(corner + 3) % 4], inward[corner]), half));
  return eaves.map((i) => {
    const j = (i + 1) % 4;
    const region = [c[i], c[j], inner(i, j), inner(i, i)].filter(
      (p, k, all) => k === 0 || distance(p, all[k - 1]) > bimTolerance,
    );
    return { origin: c[i], direction: inward[i], slope, region };
  });
}

/** The point of a loop lowest along `d` (a unit vector), exact on arcs. */
export function loopExtreme(loop: BimLoop, d: Vec2): Vec2 {
  let best: Vec2 = [loop[0][0], loop[0][1]];
  const consider = (p: Vec2) => {
    if (dot(p, d) < dot(best, d)) best = p;
  };
  loop.forEach((v, i) => {
    const p: Vec2 = [v[0], v[1]];
    consider(p);
    if (!v[2]) return;
    const next = loop[(i + 1) % loop.length];
    const arc = arcOf(p, [next[0], next[1]], v[2]);
    // The circle is lowest along d at the angle of −d; take it if the arc passes there.
    const target = Math.atan2(-d[1], -d[0]);
    const t =
      ((((target - arc.startAngle) * Math.sign(arc.sweep)) % (2 * Math.PI)) + 2 * Math.PI) %
      (2 * Math.PI);
    if (t <= Math.abs(arc.sweep)) consider(add(arc.center, scale([-d[0], -d[1]], arc.radius)));
  });
  return best;
}

/** Whether a loop stays within the coordinate limit along its arcs as well as at its vertices. */
const loopWithinLimit = (loop: BimLoop) =>
  (
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as Vec2[]
  ).every((d) => Math.abs(dot(loopExtreme(loop, d), d)) <= bimLimits.coordinateMm);
/** Plan points widened by `pad` (a section's half size) stay within the coordinate limit. */
function planWithinLimit(points: Vec2[], pad: number, path: string) {
  if (points.some((p) => p.some((c) => !(Math.abs(c) + pad <= bimLimits.coordinateMm))))
    throw new DeriveError('coordinate', path);
}
/** The largest distance from a section's centre to its outline. */
const profileReach = (p: BimProfile) =>
  p.shape === 'circle' ? p.diameterMm / 2 : Math.hypot(p.widthMm, p.depthMm) / 2;
/** A section's vertical extent when it runs horizontally (a beam). */
const profileDepth = (p: BimProfile) => (p.shape === 'circle' ? p.diameterMm : p.depthMm);

function checkLoop(loop: BimLoop, path: string) {
  if (!loopWithinLimit(loop)) throw new DeriveError('coordinate', path);
  if (loopEdges(loop).some((e) => e.arc && !(e.arc.radius <= bimLimits.arcRadiusMm)))
    throw new DeriveError('arc-too-flat', path);
  if (!loopSimple(loop)) throw new DeriveError('loop-self-intersection', path);
}
const ccw = (loop: BimLoop) => (loopArea(loop) < 0 ? reverseLoop(loop) : loop);
