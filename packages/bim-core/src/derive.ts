import {
  add,
  arcOf,
  arcPoint,
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
  bimBodyLimits,
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
  type Vec3,
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
      /**
       * LR2: a leaning wall: its angle and its footprint at `zTop` (the same vertices and arcs
       * as `footprint`); the solid is ruled between the two.
       */
      lean?: number;
      footprintTop?: BimLoop;
    }
  | {
      kind: 'slab';
      boundary: BimLoop;
      holes: BimLoop[];
      zBottom: number;
      zTop: number;
      /**
       * TW5: a sloped top through `origin` at `zTop`, rising by `grade` per mm along the plan unit
       * `direction`; the bottom `zTop - zBottom` below it everywhere.
       */
      slope?: { origin: Vec2; direction: Vec2; grade: number };
    }
  | {
      kind: 'column';
      at: Vec2;
      rotationRad: number;
      profile: BimProfile;
      zBase: number;
      zTop: number;
      clipBy?: string;
      /** TW2: plan position of the top of a leaning column. Absent: straight above `at`. */
      topAt?: Vec2;
      /** TW5: the top section's scale (under 1). Absent: the same section. */
      topScale?: number;
    }
  | {
      kind: 'beam';
      start: Vec2;
      end: Vec2;
      zTop: number;
      profile: BimProfile;
      /** TW2: top height at the end of a sloping beam. Absent: level at `zTop`. */
      zTopEnd?: number;
    }
  | {
      /** TW2: the member's axis from `start` to `end` (x, y, z), its section centred on it. */
      kind: 'member';
      start: Vec3;
      end: Vec3;
      rotationRad: number;
      profile: BimProfile;
    }
  | {
      /**
       * LR3: a spiral ramp. Its top at angle `startAngle + t·sweep` (t from 0 to 1) is at
       * `zStart + t·(zEnd − zStart)` across the ring, and it is `thickness` deep vertically.
       */
      kind: 'ramp';
      center: Vec2;
      innerRadius: number;
      outerRadius: number;
      startAngle: number;
      sweep: number;
      zStart: number;
      zEnd: number;
      thickness: number;
      /** LS4: plan regions cut upright through every turn over them (counter-clockwise). */
      openings?: BimLoop[];
    }
  | {
      /**
       * LS5: a railing along a ramp's edge: as a ramp's shape, the band between the radii,
       * its top `thickness` (the railing's height) above the ramp's top.
       */
      kind: 'railing';
      center: Vec2;
      innerRadius: number;
      outerRadius: number;
      startAngle: number;
      sweep: number;
      zStart: number;
      zEnd: number;
      thickness: number;
    }
  | {
      /**
       * LS6: a straight flight. `profile` is its side, counter-clockwise in (along the flight
       * from `at`, up from `zBase`); the solid is it swept `width` across, centred on the line
       * from `at` along `directionRad`.
       */
      kind: 'stair';
      at: Vec2;
      directionRad: number;
      zBase: number;
      width: number;
      profile: Vec2[];
      risers: number;
      riser: number;
      tread: number;
      waist: number;
    }
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
  | { kind: 'space'; boundary: BimLoop; holes: BimLoop[]; zBase: number; zTop: number }
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
    case 'pipe': {
      const inner = p.diameterMm - 2 * p.wallMm;
      return (Math.PI * (p.diameterMm * p.diameterMm - inner * inner)) / 4;
    }
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
  /** GV2b: the rules this building's people set. */
  readonly body;
  constructor(readonly doc: BimDocument) {
    this.body = bimBodyLimits(doc);
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
  /** `heights`: each span's stopping wall from its base to its top (FU3a), in the same order. */
  zones: { start: number; end: number; spans: [number, number][]; heights: [number, number][] };
  arc?: ReturnType<typeof arcOf>;
  /** LR2: the wall's lean (rad); 0 when upright. */
  lean: number;
}

/**
 * A wall's frame: its axis and faces in plan. LR2: a leaning wall's at height `z` (its base by
 * default): the axis moved to the right by (z − base)·tan(lean), an arc's radially (its centre
 * and angles kept), and the faces as far apart as the thickness square to them, ÷ cos(lean).
 */
function wallFrame(ctx: BimContext, wall: BimWall, path: string, z?: number): WallFrame {
  let s = ctx.point(wall.start, `${path}.start`);
  let e = ctx.point(wall.end, `${path}.end`);
  if (distance(s, e) < bimTolerance) throw new DeriveError('wall-degenerate', path);
  const lean = wall.lean ?? 0;
  const thickness = layersThickness(ctx.types.get(wall.typeId)!);
  const width = thickness / Math.cos(lean);
  const [leftOff, rightOff] =
    wall.location === 'center'
      ? [width / 2, -width / 2]
      : wall.location === 'left'
        ? [0, -width]
        : [width, 0];
  const zBase = ctx.height(wall.base, `${path}.base`);
  const zTop = ctx.top(zBase, wall.top, `${path}.top`);
  if (zTop <= zBase + bimTolerance) throw new DeriveError('level-order', `${path}.top`);
  if (lean && z !== undefined && z !== zBase) {
    const d = (z - zBase) * Math.tan(lean);
    if (!wall.bulge) {
      const right = scale(left(unit(sub(e, s))), -d);
      s = add(s, right);
      e = add(e, right);
    } else {
      // Right of travel is away from the centre on a counter-clockwise arc.
      const arc = arcOf(s, e, wall.bulge);
      const r = arc.radius + Math.sign(arc.sweep) * d;
      if (!(r > bimTolerance)) throw new DeriveError('wall-degenerate', path);
      const radial = (p: Vec2) => add(arc.center, scale(unit(sub(p, arc.center)), r));
      [s, e] = [radial(s), radial(e)];
    }
  }
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
    zones: { start: 0, end: 0, spans: [], heights: [] },
    lean,
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

/** How a join met its walls: an L (which ends) or a T (which wall stops, at which end). */
type JoinFit =
  | { kind: 'L'; ea: WallEnd; eb: WallEnd }
  | { kind: 'T'; through: string; stop: string; end: WallEnd };

function applyJoin(
  frames: Map<string, WallFrame>,
  join: BimWallJoin,
  path: string,
  used: Set<string>,
  points: { p: Vec2; lo: number; hi: number }[],
  /** LR2: the fit found at the base, for leaning walls taken at another height. */
  fit?: JoinFit,
): JoinFit {
  const [a, b] = join.walls.map((id) => frames.get(id)!) as [WallFrame, WallFrame];
  const ends = ['start', 'end'] as const;
  // L: an end of each wall at the same point. T: an end of one wall inside the other's axis.
  let shape: { kind: 'L'; ea: 'start' | 'end'; eb: 'start' | 'end' } | undefined =
    fit?.kind === 'L' ? fit : undefined;
  if (!fit)
    for (const ea of ends)
      for (const eb of ends)
        if (distance(endPoint(a, ea), endPoint(b, eb)) <= bimTolerance)
          shape = { kind: 'L', ea, eb };
  // An arc wall joins only at an end, by its tangent there (OH-U3): no T.
  if ((a.arc || b.arc) && !shape) throw new DeriveError('join-unsupported', path);
  const ua = endAxis(a, shape?.ea).u;
  const ub = endAxis(b, shape?.eb).u;
  if (Math.abs(cross(ua, ub)) < 1e-9) throw new DeriveError('join-failed', path);
  let tee: { through: WallFrame; stop: WallFrame; end: 'start' | 'end' } | undefined =
    fit?.kind === 'T'
      ? { through: frames.get(fit.through)!, stop: frames.get(fit.stop)!, end: fit.end }
      : undefined;
  if (!shape && !tee)
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
    return { kind: 'T', through: tee.through.wall.id, stop: tee.stop.wall.id, end: tee.end };
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
    return shape!;
  }
  const through = join.through === b.wall.id ? b : a;
  if (join.through !== undefined && join.through !== a.wall.id && join.through !== b.wall.id)
    throw new DeriveError('join-through', `${path}.through`);
  const stop = through === a ? b : a;
  const throughEnd = through === a ? ea : eb;
  const stopEnd = through === a ? eb : ea;
  butt(through, stop, stopEnd, throughEnd, path);
  return shape!;
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
  through.zones.heights.push([stop.zBase, stop.zTop]);
}

/**
 * LR2: whether a leaning wall's base and top footprints have the same edges (straight or arc,
 * in the same order) and every arc keeps its angles about the wall's centre, so the ruled
 * solid between them is what its faces are (planes and cones), and Simpson's rule exact.
 */
function leanRuled(f: WallFrame, base: BimLoop, top: BimLoop) {
  if (base.length !== top.length) return false;
  return base.every((v, i) => {
    const w = top[i]!;
    if (!!v[2] !== !!w[2]) return false;
    if (!v[2]) return true;
    if (Math.abs(v[2] - w[2]!) > 1e-9) return false;
    const c = f.arc!.center;
    const a = Math.atan2(v[1] - c[1], v[0] - c[0]);
    const b = Math.atan2(w[1] - c[1], w[0] - c[0]);
    return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= 1e-9;
  });
}
/**
 * LS-U1: whether the footprint solved at mid-height is within 1 mm (`within`) of the ruled solid's
 * there:
 * its vertices and its edges' middles (an arc's on the arc) halfway between the base's and the
 * top's.
 */
function nearRuled(base: BimLoop, mid: BimLoop, top: BimLoop, within = 1) {
  if (base.length !== mid.length || top.length !== mid.length) return false;
  const middle = (l: BimLoop, i: number): Vec2 => {
    const v = l[i]!;
    const w = l[(i + 1) % l.length]!;
    return v[2]
      ? arcPoint(arcOf([v[0], v[1]], [w[0], w[1]], v[2]), 0.5)
      : [(v[0] + w[0]) / 2, (v[1] + w[1]) / 2];
  };
  const near = (p: Vec2, a: Vec2, b: Vec2) =>
    Math.hypot(p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2) <= within;
  return mid.every(
    (v, i) =>
      near([v[0], v[1]], [base[i]![0], base[i]![1]], [top[i]![0], top[i]![1]]) &&
      near(middle(mid, i), middle(base, i), middle(top, i)),
  );
}
const loopsEqual = (a: BimLoop, b: BimLoop) =>
  a.length === b.length &&
  a.every(
    (v, i) =>
      Math.abs(v[0] - b[i]![0]) <= 1e-9 &&
      Math.abs(v[1] - b[i]![1]) <= 1e-9 &&
      Math.abs((v[2] ?? 0) - (b[i]![2] ?? 0)) <= 1e-12,
  );
/** LR2: the loop whose vertices are `t` of the way from `a`'s to `b`'s, with `a`'s arcs. */
function loopBetween(a: BimLoop, b: BimLoop, t: number): BimLoop {
  return a.map((v, i) => {
    const w = b[i]!;
    const p: Vec2 = [v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t];
    return v[2] ? [p[0], p[1], v[2]] : p;
  });
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

/** FU3a: the heights above a wall's base of an opening's sill and head, measured along the face. */
const bimWallOpeningRiseOf = (lean: number, sillMm: number, heightMm: number) =>
  [sillMm * Math.cos(lean), (sillMm + heightMm) * Math.cos(lean)] as const;

/**
 * Volume an opening cuts from a wall, exact for arc walls. FU3a: through a leaning wall the cut
 * is as thick as the wall square to its faces; on a cone its plan area grows in step with the
 * height, so the area at its middle height times the height is exact.
 */
function openingVolume(f: WallFrame, o: BimWallOpeningShape) {
  if (!f.arc) return o.widthMm * f.thickness * o.heightMm;
  const towardCenter = Math.sign(f.arc.sweep);
  const rise = (o.sillMm + o.heightMm / 2) * Math.cos(f.lean);
  const mid =
    f.arc.radius + towardCenter * (rise * Math.tan(f.lean) - (f.leftOff + f.rightOff) / 2);
  return (o.widthMm / f.arc.radius) * f.thickness * mid * o.heightMm;
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
  /** LR2: the joins applied, by wall, to solve a leaning wall's again at other heights. */
  const joinsOf = new Map<string, { join: BimWallJoin; path: string; fit: JoinFit }[]>();
  /**
   * LS2: the walls whose plan changes with height: the leaning ones and the upright ones joined
   * to them (an upright wall's faces stay; its ends follow the leaning faces they meet).
   */
  const moving = new Set<string>();
  doc.joins.forEach((j, i) => {
    if (!j.walls.every((w) => frames.has(w))) return;
    const path = `$.joins[${i}]`;
    try {
      const fit = applyJoin(frames, j, path, used, points);
      for (const w of j.walls) joinsOf.set(w, [...(joinsOf.get(w) ?? []), { join: j, path, fit }]);
      if (j.walls.some((w) => frames.get(w)!.lean !== 0)) for (const w of j.walls) moving.add(w);
    } catch (err) {
      fail(err, j.id, path);
    }
  });
  for (const f of frames.values()) if (f.lean) moving.add(f.wall.id);
  /**
   * LR2: a leaning wall's footprint at height z: its joins solved again with it and the walls
   * it joins taken at z.
   */
  const footprintAt = (f: WallFrame, z: number) => {
    const at = new Map<string, WallFrame>();
    const frameAt = (id: string) => {
      const w = frames.get(id)!;
      at.set(id, wallFrame(ctx, w.wall, w.path, z));
    };
    frameAt(f.wall.id);
    const joins = joinsOf.get(f.wall.id) ?? [];
    for (const { join } of joins) for (const w of join.walls) if (!at.has(w)) frameAt(w);
    for (const { join, path, fit } of joins) {
      applyJoin(at, join, path, new Set(), [], fit);
      // A T found at the base must still meet the through wall at z: the stop's face points
      // within the through wall's length there, not off its end. Only where the stop is: a
      // taller through wall's top does not ask a lower stop's extension (Codex).
      const stopped = frames.get(fit.kind === 'T' ? fit.stop : f.wall.id)!;
      if (
        fit.kind === 'T' &&
        z >= stopped.zBase - bimTolerance &&
        z <= stopped.zTop + bimTolerance
      ) {
        const through = at.get(fit.through)!;
        const stop = at.get(fit.stop)!;
        if (
          stop.ends[fit.end].some((p) => {
            const t = axial(through, p);
            return t < -bimTolerance || t > through.length + bimTolerance;
          })
        )
          throw new DeriveError('wall-lean-join', path);
      }
    }
    const frame = at.get(f.wall.id)!;
    // Each face keeps a positive length at z too: a join may not trim it past its other end.
    if (
      [0, 1].some(
        (k) => axial(frame, frame.ends.end[k]) - axial(frame, frame.ends.start[k]) <= bimTolerance,
      )
    )
      throw new DeriveError('join-failed', f.path);
    return { frame, footprint: wallFootprint(frame) };
  };
  const footprints = new Map<string, BimLoop>();
  /**
   * The walls ruled between a base and a top footprint. `ruled`: its faces are what the ruled
   * solid's are (planes, cones, cylinders kept at their angles), so Simpson's rule is exact;
   * otherwise (LS-U1) within 1 mm of them at mid-height, and the kernel measures it.
   */
  const leanFootprints = new Map<string, { top: BimLoop; mid: WallFrame; ruled: boolean }>();
  for (const f of frames.values()) {
    let fp = wallFootprint(f);
    if (moving.has(f.wall.id)) {
      // The base, middle and top footprints; the solid is ruled between base and top: each
      // vertex moves straight and each face arc keeps its centre and angles (LR-U2), or LS2 the
      // footprint solved at mid-height is within 1 mm of the ruled one's (LS-U1).
      try {
        const base = footprintAt(f, f.zBase);
        const top = footprintAt(f, f.zTop);
        const mid = footprintAt(f, (f.zBase + f.zTop) / 2);
        // Exact when the faces keep their angles and the vertices move straight (a straight wall
        // meeting a cone does not: its corners follow a curve).
        const ruled =
          leanRuled(f, base.footprint, top.footprint) &&
          nearRuled(base.footprint, mid.footprint, top.footprint, 1e-6);
        if (!ruled && !nearRuled(base.footprint, mid.footprint, top.footprint))
          throw new DeriveError('wall-lean-join', f.path);
        if (!loopWithinLimit(top.footprint)) throw new DeriveError('coordinate', f.path);
        fp = base.footprint;
        // An upright wall whose joins do not change with height stays a prism.
        if (f.lean || !loopsEqual(base.footprint, top.footprint))
          leanFootprints.set(f.wall.id, { top: top.footprint, mid: mid.frame, ruled });
      } catch (err) {
        fail(err, f.wall.id, f.path);
        continue;
      }
    }
    // Each face must keep a positive length: a join may not trim a wall past its other end. An
    // arc wall's faces stay within a half circle (|bulge| ≤ 1), as a building's arcs do, and its
    // joined faces may not cross each other (they can meet twice, OH-U3).
    const inverted = [0, 1].some(
      (k) => axial(f, f.ends.end[k]) - axial(f, f.ends.start[k]) <= bimTolerance,
    );
    // LR2: a leaning wall's top must stay a simple outline too (a join may not cross it there),
    // and its arcs within a half circle (Codex: a join can open them past it at the top).
    const top = leanFootprints.get(f.wall.id)?.top;
    const tooLong = [fp, top ?? []].some((l) => l.some((v) => Math.abs(v[2] ?? 0) > 1 + 1e-9));
    const isSimple = (l: BimLoop) => (f.arc ? loopSimple(l) : polygonSimple(loopPolygon(l)));
    const simple = isSimple(fp) && (!top || isSimple(top));
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
        // FU3a: a leaning wall's sill and height run along its face (FU-U4).
        const height = (f.zTop - f.zBase) / Math.cos(f.lean);
        if (
          o.alongMm < -bimTolerance ||
          o.alongMm + o.widthMm > f.length + bimTolerance ||
          o.sillMm < -bimTolerance ||
          o.sillMm + o.heightMm > height + bimTolerance
        )
          throw new DeriveError('opening-outside-host', path);
        const lo = o.alongMm;
        const hi = o.alongMm + o.widthMm;
        // Upright, the joins are the same at every height; leaning, only where the opening is
        // (below), not at the base (Codex). LS2: so with an upright wall joined to a leaning one.
        const moves = moving.has(e.hostId);
        if (
          !moves &&
          (lo < f.zones.start - bimTolerance ||
            hi > f.length - f.zones.end + bimTolerance ||
            f.zones.spans.some(([a, b]) => lo < b - bimTolerance && hi > a + bimTolerance))
        )
          throw new DeriveError('opening-in-join', path);
        // FU3a: a leaning wall's joins reach further in as it rises (leaning in), so the opening
        // stays out of them over its whole height: measured on the wall at heights from its sill
        // to its head, an arc's at the same angles. A T-join's contact moves along the wall as both
        // lean, so between two heights its span sweeps the hull of the two (Codex).
        if (moves) {
          const [r0, r1] = bimWallOpeningRiseOf(f.lean, o.sillMm, o.heightMm);
          const steps = 8;
          // A stopping wall shorter than the opening holds it only up to its top (Codex): its
          // ends are heights to measure at too, and its span counts only within them.
          const z0 = f.zBase + r0;
          const z1 = f.zBase + r1;
          const zs = [
            ...Array.from({ length: steps + 1 }, (_, i) => z0 + ((z1 - z0) * i) / steps),
            ...f.zones.heights.flat().filter((z) => z > z0 && z < z1),
          ].sort((a, b) => a - b);
          let last: ([number, number] | undefined)[] | undefined;
          for (const z of zs) {
            const g = footprintAt(f, z).frame;
            const k = f.arc && g.arc ? f.arc.radius / g.arc.radius : 1;
            const start = Math.max(0, ...g.ends.start.map((p) => axial(g, p))) * k;
            const end =
              (g.length - Math.max(0, ...g.ends.end.map((p) => g.length - axial(g, p)))) * k;
            // In the order of the joins at every height, so each is swept with itself (Codex).
            const spans = g.zones.spans.map(([a, b], j): [number, number] | undefined => {
              const [zb, zt] = g.zones.heights[j]!;
              return z < zb - bimTolerance || z > zt + bimTolerance ? undefined : [a * k, b * k];
            });
            const swept = spans.map((s, j): [number, number] | undefined => {
              const p = last && last.length === spans.length ? last[j] : undefined;
              return s && p ? [Math.min(s[0], p[0]), Math.max(s[1], p[1])] : s;
            });
            if (
              lo < start - bimTolerance ||
              hi > end + bimTolerance ||
              swept.some((s) => s && lo < s[1] - bimTolerance && hi > s[0] + bimTolerance)
            )
              throw new DeriveError('opening-in-join', path);
            last = spans;
          }
        }
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

  // LS5: railings after the rest, from their host ramp's shape.
  for (const pass of [false, true])
    for (const e of doc.elements) {
      if ((e.kind === 'railing') !== pass) continue;
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
        const openingsVolume = openings.reduce((n, o) => n + openingVolume(f, o), 0);
        const lean = leanFootprints.get(e.id);
        shapes.set(e.id, {
          kind: 'wall',
          footprint,
          zBase: f.zBase,
          zTop: f.zTop,
          openings,
          ...(e.clipBy ? { clipBy: e.clipBy } : {}),
          ...(lean ? { ...(f.lean ? { lean: f.lean } : {}), footprintTop: lean.top } : {}),
        });
        // LR2: a leaning wall's faces run up the slope: its length at mid-height × the slant
        // height. That length is the axis's, grown or shrunk as the joined faces are between the
        // base and mid-height (a mitred ring that leans out is longer up the wall).
        const faces = (w: WallFrame) =>
          ([0, 1] as const).reduce<number>(
            (n, k) => n + (axial(w, w.ends.end[k]) - axial(w, w.ends.start[k])) / 2,
            0,
          );
        const sideArea = lean
          ? ((f.length + faces(lean.mid) - faces(f)) * height) / Math.cos(f.lean)
          : f.length * height;
        const values: Record<string, number> = {
          length: f.length,
          height,
          width: f.thickness,
          footprintArea: footArea,
          grossSideArea: sideArea,
          openingArea,
          netSideArea: sideArea - openingArea,
        };
        // LS-U1: a wall ruled only to within 1 mm is the kernel's to measure.
        const measured = !e.clipBy && (!lean || lean.ruled);
        if (measured) {
          // LR2: the plan area changes as a square of the height; Simpson's rule is exact.
          const volume = lean
            ? (height / 6) *
              (footArea + 4 * loopArea(loopBetween(footprint, lean.top, 0.5)) + loopArea(lean.top))
            : footArea * height;
          values.grossVolume = volume;
          values.netVolume = volume - openingsVolume;
        }
        quantities.set(e.id, { source: measured ? 'analytic' : 'kernel', values });
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
        checkVoids(outer, voids);
        const thickness = layersThickness(ctx.types.get(e.typeId)!);
        const zTop = ctx.height(e.top, `${path}.top`);
        const gross = Math.abs(loopArea(e.boundary));
        const area = gross - voids.reduce((n, v) => n + Math.abs(loopArea(v.loop)), 0);
        // TW5: a sloped top, square to the edge, up to the boundary's farthest point.
        let slope: { origin: Vec2; direction: Vec2; grade: number } | undefined;
        if (e.slope) {
          const zEnd = ctx.height(e.slope.endTop, `${path}.slope.endTop`);
          const a = e.boundary[e.slope.edge]!;
          const b = e.boundary[(e.slope.edge + 1) % e.boundary.length]!;
          const origin: Vec2 = [a[0], a[1]];
          const normal = left(unit(sub([b[0], b[1]], origin)));
          // How far the boundary reaches from the edge's line along d (exact on arcs).
          const reach = (d: Vec2) => dot(sub(loopExtreme(e.boundary, scale(d, -1)), origin), d);
          const r1 = reach(normal);
          const r2 = reach(scale(normal, -1));
          const direction = r1 >= r2 ? normal : scale(normal, -1);
          const run = Math.max(r1, r2);
          if (!(run > bimTolerance))
            throw new DeriveError('slope-degenerate', `${path}.slope.edge`);
          withinLimit(zEnd - thickness, `${path}.slope.endTop`);
          if (Math.abs(zEnd - zTop) > bimTolerance) {
            const grade = (zEnd - zTop) / run;
            slope = { origin, direction, grade };
            // A concave boundary may reach behind the edge's line, where the plane runs on past
            // `top`: its heights there stay within the limit too.
            const behind = Math.max(0, Math.min(r1, r2));
            const zBehind = zTop - grade * behind;
            withinLimit(zBehind, `${path}.slope.endTop`);
            withinLimit(zBehind - thickness, `${path}.slope.endTop`);
            // The kernel builds it from one upright prism over its whole rise (with 10 mm to
            // spare each way), which must stay within the limit as a single extrusion too.
            const rise = Math.max(zTop, zEnd, zBehind) - Math.min(zTop, zEnd, zBehind) + thickness;
            if (!(rise + 20 <= bimLimits.coordinateMm))
              throw new DeriveError('coordinate', `${path}.slope.endTop`);
          }
        }
        shapes.set(e.id, {
          kind: 'slab',
          boundary: ccw(e.boundary),
          holes: voids.map((v) => ccw(v.loop)),
          zBottom: withinLimit(zTop - thickness, `${path}.top`),
          zTop,
          ...(slope ? { slope } : {}),
        });
        // A sloped slab's areas stay in plan, and its volume is the plan area times the vertical
        // thickness; its top face's own area is the plan area over the slope's cosine.
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            grossArea: gross,
            netArea: area,
            perimeter: loopPerimeter(e.boundary),
            depth: thickness,
            grossVolume: gross * thickness,
            netVolume: area * thickness,
            ...(slope ? { slopedArea: area * Math.hypot(1, slope.grade) } : {}),
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
        const topAt = e.topAt ? ctx.point(e.topAt, `${path}.topAt`) : undefined;
        if (topAt) planWithinLimit([topAt], profileReach(t.profile), `${path}.topAt`);
        const leans = topAt !== undefined && distance(at, topAt) > bimTolerance;
        const k = e.topScale ?? 1;
        const tapers = k < 1 - 1e-9;
        shapes.set(e.id, {
          kind: 'column',
          at,
          rotationRad: e.rotationRad,
          profile: t.profile,
          zBase,
          zTop,
          ...(e.clipBy ? { clipBy: e.clipBy } : {}),
          ...(leans ? { topAt } : {}),
          ...(tapers ? { topScale: k } : {}),
        });
        const a = profileArea(t.profile);
        // TW2: a leaning column's length runs along its axis.
        const length = Math.hypot(zTop - zBase, leans ? distance(at, topAt) : 0);
        // TW5: the base's section; similar sections scaled linearly by k hold A·L·(1 + k + k²)/3.
        const values: Record<string, number> = { length, crossSectionArea: a };
        if (!e.clipBy) values.netVolume = (a * length * (1 + k + k * k)) / 3;
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
        const zTopEnd = e.endTop ? ctx.height(e.endTop, `${path}.endTop`) : undefined;
        if (zTopEnd !== undefined) withinLimit(zTopEnd - profileDepth(t.profile), `${path}.endTop`);
        const slopes = zTopEnd !== undefined && Math.abs(zTopEnd - zTop) > bimTolerance;
        shapes.set(e.id, {
          kind: 'beam',
          start: s,
          end: en,
          zTop,
          profile: t.profile,
          ...(slopes ? { zTopEnd } : {}),
        });
        const a = profileArea(t.profile);
        // TW2: a sloping beam's length runs along its axis.
        const len = Math.hypot(distance(s, en), slopes ? zTopEnd - zTop : 0);
        quantities.set(e.id, {
          source: 'analytic',
          values: { length: len, crossSectionArea: a, netVolume: a * len },
        });
        return;
      }
      case 'member': {
        const t = ctx.types.get(e.typeId)! as Extract<BimType, { profile: unknown }>;
        const [start, end] = (['start', 'end'] as const).map((k): Vec3 => {
          const xy = ctx.point(e[k].at, `${path}.${k}.at`);
          planWithinLimit([xy], profileReach(t.profile), `${path}.${k}.at`);
          const z = ctx.height(e[k].height, `${path}.${k}.height`);
          withinLimit(Math.abs(z) + profileReach(t.profile), `${path}.${k}.height`);
          return [xy[0], xy[1], z];
        });
        const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
        if (length < bimTolerance) throw new DeriveError('member-degenerate', path);
        shapes.set(e.id, {
          kind: 'member',
          start,
          end,
          rotationRad: e.rotationRad,
          profile: t.profile,
        });
        const a = profileArea(t.profile);
        quantities.set(e.id, {
          source: 'analytic',
          values: { length, crossSectionArea: a, netVolume: a * length },
        });
        return;
      }
      case 'ramp': {
        const center = ctx.point(e.center, `${path}.center`);
        const [r, R] = [e.innerRadiusMm, e.outerRadiusMm];
        planWithinLimit([center], R, `${path}.center`);
        const thickness = layersThickness(ctx.types.get(e.typeId)!);
        const zStart = ctx.height(e.base, `${path}.base`);
        const zEnd = ctx.height(e.top, `${path}.top`);
        for (const [z, k] of [
          [zStart, 'base'],
          [zEnd, 'top'],
        ] as const) {
          withinLimit(z, `${path}.${k}`);
          withinLimit(z - thickness, `${path}.${k}`);
        }
        const turns = Math.abs(e.sweepRad) / (2 * Math.PI);
        // From one turn on, a turn must rise more than the thickness, or the ramp meets itself
        // (at one turn exactly, its end over its start).
        if (turns >= 1 - 1e-12 && Math.abs(zEnd - zStart) / turns <= thickness + bimTolerance)
          throw new DeriveError('ramp-shape', `${path}.top`);
        // LS4: openings cut upright through every turn over them, each wholly on the ramp.
        const openings = (slabOpenings.get(e.id) ?? []).map((o) => {
          const at = `${pathOf(o.id)}.slab.boundary`;
          checkLoop(o.loop, at);
          return { loop: ccw(o.loop), turns: rampCover(center, r, R, e, o.loop, at) };
        });
        openings.forEach((o, i) => {
          const edges = loopEdges(o.loop);
          for (const q of openings.slice(0, i)) {
            const other = loopEdges(q.loop);
            if (loopsTouch(other, edges) || loopWithin(other, edges) || loopWithin(edges, other))
              throw new DeriveError('opening-overlap', `${pathOf(slabOpenings.get(e.id)![i]!.id)}`);
          }
        });
        // The kernel cuts openings with upright prisms over the whole rise (10 mm to spare each
        // way), each a single extrusion within the limit (Codex).
        if (
          openings.length &&
          !(Math.abs(zEnd - zStart) + thickness + 20 <= bimLimits.coordinateMm)
        )
          throw new DeriveError('coordinate', `${path}.top`);
        shapes.set(e.id, {
          kind: 'ramp',
          center,
          innerRadius: r,
          outerRadius: R,
          startAngle: e.startAngleRad,
          sweep: e.sweepRad,
          zStart,
          zEnd,
          thickness,
          ...(openings.length ? { openings: openings.map((o) => o.loop) } : {}),
        });
        // In plan a ring sector; vertically as thick throughout, so the volume is exact. The top
        // is a helicoid rising p per radian: its area is |sweep|·∫ √(ρ² + p²) dρ from r to R.
        const sweep = Math.abs(e.sweepRad);
        const p = (zEnd - zStart) / sweep;
        const planArea = (sweep / 2) * (R * R - r * r);
        const F = (q: number) => {
          const h = Math.hypot(q, p);
          return (q * h + p * p * Math.log(q + h)) / 2;
        };
        const rc = (r + R) / 2;
        // LS4 (Codex): an opening takes its patch of the helicoid from each turn it passes
        // through. Over a plan region the helicoid's area is ∬ √(ρ² + p²)/ρ dA = ∮ G(ρ) dθ, G
        // the integral of √(s² + p²) from 0 to ρ (the region does not go round the centre).
        const G = (q: number) => (p ? F(q) - F(0) : (q * q) / 2);
        const patch = (loop: BimLoop) => {
          let sum = 0;
          for (const ed of loopEdges(loop)) {
            const arc = ed.arc;
            // A point of the edge at t, about the centre, and its derivative.
            const at = (t: number): [Vec2, Vec2] => {
              if (!arc) return [sub(add(ed.p, scale(sub(ed.q, ed.p), t)), center), sub(ed.q, ed.p)];
              const a = arc.startAngle + arc.sweep * t;
              const k = arc.radius * arc.sweep;
              return [sub(arcPoint(arc, t), center), [-k * Math.sin(a), k * Math.cos(a)]];
            };
            const n = arc ? 64 : 16;
            for (let k = 0; k < n; k++)
              for (const [x, wt] of gauss5) {
                const [q, dq] = at((k + (x + 1) / 2) / n);
                const rr = dot(q, q);
                // dθ = (x dy − y dx) / ρ².
                sum += (G(Math.sqrt(rr)) * ((q[0] * dq[1] - q[1] * dq[0]) / rr) * wt) / (2 * n);
              }
          }
          return Math.abs(sum);
        };
        const removed = openings.reduce((n, o) => n + patch(o.loop) * o.turns, 0);
        const topArea = sweep * (F(R) - F(r));
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            length: sweep * Math.hypot(rc, p),
            ringWidth: R - r,
            thickness,
            rise: zEnd - zStart,
            planArea,
            topArea: topArea - removed,
            // LS4: an opening takes its area × the thickness from each turn it passes through.
            ...(openings.length
              ? {
                  openingArea: openings.reduce((n, o) => n + loopArea(o.loop) * o.turns, 0),
                  grossTopArea: topArea,
                  grossVolume: planArea * thickness,
                }
              : {}),
            netVolume:
              (planArea - openings.reduce((n, o) => n + loopArea(o.loop) * o.turns, 0)) * thickness,
          },
        });
        return;
      }
      case 'railing': {
        // LS5: a band along the ramp's inner or outer edge, standing on its top.
        const host = shapes.get(e.hostId);
        if (host?.kind !== 'ramp') throw new DeriveError('railing-host', `${path}.hostId`);
        const t = layersThickness(ctx.types.get(e.typeId)!);
        const [r, R] = [host.innerRadius, host.outerRadius];
        if (t >= R - r - bimTolerance) throw new DeriveError('railing-shape', `${path}.typeId`);
        const [r0, r1] = e.side === 'inner' ? [r, r + t] : [R - t, R];
        const h = e.heightMm;
        for (const z of [host.zStart, host.zEnd]) withinLimit(z + h, `${path}.heightMm`);
        // Over a ramp of a turn or more, the railing must stay below the turn above (Codex): its
        // top under that turn's underside, a turn's rise less the ramp's thickness higher.
        const turns = Math.abs(host.sweep) / (2 * Math.PI);
        const perTurn = Math.abs(host.zEnd - host.zStart) / turns;
        if (turns >= 1 - 1e-12 && h >= perTurn - host.thickness - bimTolerance)
          throw new DeriveError('railing-shape', `${path}.heightMm`);
        shapes.set(e.id, {
          kind: 'railing',
          center: host.center,
          innerRadius: r0,
          outerRadius: r1,
          startAngle: host.startAngle,
          sweep: host.sweep,
          zStart: host.zStart + h,
          zEnd: host.zEnd + h,
          thickness: h,
        });
        // As high throughout, so the volume is exact; the length along the band's middle.
        const sweep = Math.abs(host.sweep);
        const p = (host.zEnd - host.zStart) / sweep;
        const length = sweep * Math.hypot((r0 + r1) / 2, p);
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            length,
            height: h,
            width: t,
            // Each face is a cylinder's strip as high throughout (Codex): sweep × radius × height,
            // whatever the rise; the mean of the two.
            sideArea: sweep * ((r0 + r1) / 2) * h,
            netVolume: (sweep / 2) * (r1 * r1 - r0 * r0) * h,
          },
        });
        return;
      }
      case 'stair': {
        const at = ctx.point(e.start, `${path}.start`);
        const zBase = withinLimit(ctx.height(e.base, `${path}.base`), `${path}.base`);
        const zTop = withinLimit(ctx.height(e.top, `${path}.top`), `${path}.top`);
        const shape = bimStairProfile(
          e.risers,
          (zTop - zBase) / e.risers,
          e.treadMm,
          layersThickness(ctx.types.get(e.typeId)!),
          ctx.body.stair.riserMm,
        );
        if (shape === 'riser') throw new DeriveError('stair-riser', `${path}.top`);
        if (shape === 'waist') throw new DeriveError('stair-shape', `${path}.typeId`);
        const d: Vec2 = [Math.cos(e.directionRad), Math.sin(e.directionRad)];
        const run = (e.risers - 1) * e.treadMm;
        const n: Vec2 = [-d[1], d[0]];
        planWithinLimit(
          [-1, 1].flatMap((k) => [
            add(at, scale(n, (k * e.widthMm) / 2)),
            add(add(at, scale(d, run)), scale(n, (k * e.widthMm) / 2)),
          ]),
          0,
          `${path}.start`,
        );
        shapes.set(e.id, {
          kind: 'stair',
          at,
          directionRad: e.directionRad,
          zBase,
          width: e.widthMm,
          profile: shape.profile,
          risers: e.risers,
          riser: (zTop - zBase) / e.risers,
          tread: e.treadMm,
          waist: shape.waist,
        });
        // A prism: its side's area across its width, exact. The treads are level.
        const side = Math.abs(loopArea(shape.profile));
        quantities.set(e.id, {
          source: 'analytic',
          values: {
            length: run,
            flightWidth: e.widthMm,
            height: zTop - zBase,
            numberOfRisers: e.risers,
            riserHeight: (zTop - zBase) / e.risers,
            treadLength: e.treadMm,
            treadArea: run * e.widthMm,
            sideArea: side,
            netVolume: side * e.widthMm,
          },
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
        // TW1: holes as a slab's (inside, apart); the area and volume leave them out.
        const holes = e.holes ?? [];
        checkVoids(
          loopEdges(e.boundary),
          holes.map((h, i) => ({ loop: h, path: `${path}.holes[${i}]`, opening: false })),
        );
        const area =
          Math.abs(loopArea(e.boundary)) - holes.reduce((n, h) => n + Math.abs(loopArea(h)), 0);
        shapes.set(e.id, {
          kind: 'space',
          boundary: ccw(e.boundary),
          holes: holes.map(ccw),
          zBase,
          zTop,
        });
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
  'diameterMm' in p ? p.diameterMm / 2 : Math.hypot(p.widthMm, p.depthMm) / 2;
/** A section's vertical extent when it runs horizontally (a beam). */
const profileDepth = (p: BimProfile) => ('diameterMm' in p ? p.diameterMm : p.depthMm);

/**
 * Voids of a slab or a space (holes, and a slab's openings): each a valid loop inside the
 * outer loop, apart from the others.
 */
function checkVoids(
  outer: LoopEdge[],
  voids: readonly { loop: BimLoop; path: string; opening: boolean }[],
) {
  const placed: LoopEdge[][] = [];
  for (const v of voids) {
    checkLoop(v.loop, v.path);
    const edges = loopEdges(v.loop);
    if (!loopInside(edges, outer))
      throw new DeriveError(v.opening ? 'opening-outside-host' : 'hole-outside', v.path);
    if (placed.some((p) => loopsTouch(p, edges) || loopWithin(p, edges) || loopWithin(edges, p)))
      throw new DeriveError(v.opening ? 'opening-overlap' : 'hole-overlap', v.path);
    placed.push(edges);
  }
}

/**
 * LS4: how many turns of a spiral ramp an opening's plan region passes through. It must lie
 * between the radii, not round the centre, and on each turn either wholly on the ramp or wholly
 * off it (not across its start or end): else `opening-outside-host`.
 */
/**
 * LS6: a straight flight's side, counter-clockwise in (along, up) from the foot of its first
 * riser: along the floor to where the waist's underside (the line through the nosings lowered
 * by the waist square to it) meets it, up that underside to the flight's end, up the end to the
 * last tread, then down the steps. The last riser is the upper floor's edge. 'riser' when the
 * risers are out of range; 'waist' when the underside would cut a step's inner corner (a waist
 * thinner than the riser square to the pitch) or meets the floor past the end.
 */
export function bimStairProfile(
  risers: number,
  riser: number,
  tread: number,
  waist: number,
  /** GV2b: the building's riser range (`bimBodyLimits(doc).stair.riserMm`). */
  riserMm: readonly [number, number] = bimLimits.stair.riserMm as [number, number],
): { profile: Vec2[]; waist: number } | 'riser' | 'waist' {
  const [lo, hi] = riserMm;
  if (!(riser >= lo - bimTolerance && riser <= hi + bimTolerance)) return 'riser';
  const slope = riser / tread;
  const drop = waist * Math.hypot(1, slope);
  const run = (risers - 1) * tread;
  // The underside z = riser + slope·u − drop meets the floor at `foot`.
  const foot = (drop - riser) / slope;
  // The underside must clear the steps' inner corners (Codex): a drop of one riser passes
  // through them all.
  if (!(drop > riser + bimTolerance) || !(foot < run - bimTolerance)) return 'waist';
  const profile: Vec2[] = [[0, 0]];
  if (foot > bimTolerance) profile.push([foot, 0]);
  const end = risers * riser - drop;
  if (end < (risers - 1) * riser - bimTolerance) profile.push([run, end]);
  for (let k = risers - 1; k >= 1; k--)
    profile.push([k * tread, k * riser], [(k - 1) * tread, k * riser]);
  return { profile, waist };
}

/** Five-point Gauss–Legendre nodes on [−1, 1] and their weights. */
const gauss5: [number, number][] = [
  [0, 128 / 225],
  ...[-1, 1].flatMap((sg): [number, number][] => [
    [(sg * Math.sqrt(5 - 2 * Math.sqrt(10 / 7))) / 3, (322 + 13 * Math.sqrt(70)) / 900],
    [(sg * Math.sqrt(5 + 2 * Math.sqrt(10 / 7))) / 3, (322 - 13 * Math.sqrt(70)) / 900],
  ]),
];

function rampCover(
  center: Vec2,
  r: number,
  R: number,
  ramp: { startAngleRad: number; sweepRad: number },
  loop: BimLoop,
  path: string,
): number {
  const outside = () => new DeriveError('opening-outside-host', path);
  // The loop's points in order: each arc's samples, with (Codex) its exact nearest and furthest
  // points from the centre and the points where a line from the centre touches it (its extreme
  // angles round the centre) where they lie on it.
  const pts: Vec2[] = [];
  loop.forEach((v, i) => {
    const w = loop[(i + 1) % loop.length]!;
    const p: Vec2 = [v[0], v[1]];
    pts.push(p);
    if (!v[2]) return;
    const arc = arcOf(p, [w[0], w[1]], v[2]);
    const ts = Array.from({ length: 63 }, (_, k) => (k + 1) / 64);
    const away = sub(arc.center, center);
    const d = Math.hypot(away[0], away[1]);
    if (d > 0) {
      const base = Math.atan2(away[1], away[0]);
      const extremes = [base, base + Math.PI];
      if (d > arc.radius) {
        const off = Math.acos(-arc.radius / d);
        extremes.push(base + off, base - off);
      }
      for (const angle of extremes) {
        // Its parameter: the turn from the arc's start in the arc's direction, over the sweep.
        const turn = 2 * Math.PI;
        const ahead = (((angle - arc.startAngle) % turn) + turn) % turn;
        const t = (arc.sweep > 0 ? ahead : ahead - turn) / arc.sweep;
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    for (const t of ts.sort((a, b) => a - b)) pts.push(arcPoint(arc, t));
  });
  // Radii: a straight edge comes nearest the centre between its ends.
  let lo = Infinity;
  let hi = 0;
  loop.forEach((v, i) => {
    const w = loop[(i + 1) % loop.length]!;
    if (v[2]) return;
    const d = sub([w[0], w[1]], [v[0], v[1]]);
    const t = Math.max(0, Math.min(1, dot(sub(center, [v[0], v[1]]), d) / dot(d, d)));
    lo = Math.min(lo, distance(center, add([v[0], v[1]], scale(d, t))));
  });
  for (const p of pts) {
    const rho = distance(center, p);
    lo = Math.min(lo, rho);
    hi = Math.max(hi, rho);
  }
  if (lo < r - bimTolerance || hi > R + bimTolerance) throw outside();
  // Angles round the centre, unwrapped along the loop; a loop round the centre is refused.
  const angles: number[] = [];
  for (const p of [...pts, pts[0]!]) {
    const a = Math.atan2(p[1] - center[1], p[0] - center[0]);
    const last = angles[angles.length - 1];
    angles.push(last === undefined ? a : last + Math.atan2(Math.sin(a - last), Math.cos(a - last)));
  }
  if (Math.abs(angles[angles.length - 1]! - angles[0]!) > Math.PI) throw outside();
  const a0 = Math.min(...angles);
  const a1 = Math.max(...angles);
  const from = Math.min(ramp.startAngleRad, ramp.startAngleRad + ramp.sweepRad);
  const to = Math.max(ramp.startAngleRad, ramp.startAngleRad + ramp.sweepRad);
  const eps = 1e-9;
  let turns = 0;
  for (
    let m = Math.floor((from - a1) / (2 * Math.PI)) - 1;
    m <= Math.ceil((to - a0) / (2 * Math.PI)) + 1;
    m++
  ) {
    const [b0, b1] = [a0 + 2 * Math.PI * m, a1 + 2 * Math.PI * m];
    if (b0 >= from - eps && b1 <= to + eps) turns++;
    else if (b1 > from + eps && b0 < to - eps) throw outside();
  }
  if (!turns) throw outside();
  return turns;
}

function checkLoop(loop: BimLoop, path: string) {
  if (!loopWithinLimit(loop)) throw new DeriveError('coordinate', path);
  if (loopEdges(loop).some((e) => e.arc && !(e.arc.radius <= bimLimits.arcRadiusMm)))
    throw new DeriveError('arc-too-flat', path);
  if (!loopSimple(loop)) throw new DeriveError('loop-self-intersection', path);
}
const ccw = (loop: BimLoop) => (loopArea(loop) < 0 ? reverseLoop(loop) : loop);
