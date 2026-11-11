/**
 * WM1a (docs/cad/watch-design.md): an external spur gear as a closed sketch region. The tooth
 * outline is exact where it can be (root and tip circles are arcs, the flank below the base circle
 * is a radial line) and each involute flank is one cubic spline through points of the involute.
 * The bore and the spoke windows are holes of the same region, so one extrusion makes the body
 * without a Boolean.
 *
 * WM1b: `cycloidal` is the clock and watch tooth: radial flanks below the pitch circle and an
 * epicycloid above it, rolled by a circle half the mating gear's pitch radius (so the mating
 * gear's own flanks, made the same way, are radial). A tip that the epicycloids close before the
 * addendum is an ogival point, as watch wheels have.
 */
import type { Angle, CadFeature, Count, Length, Position3, Quaternion } from './model';
import { resolveAngle, resolveCount, resolveLength, type ParameterValues } from './graph';
import {
  splineThrough,
  type CadSketch,
  type CadSketchEntity,
  type CadSketchRegion,
} from './sketch';

/** Spokes of a wheel: `count` straight arms of `width` from the hub to the rim. */
export interface CadGearSpokes {
  count: Count;
  /** Ring kept inside the root circle. */
  rim: Length;
  /** Ring kept round the bore (or the centre without a bore). */
  hub: Length;
  width: Length;
}
export interface CadSpurGearArgs {
  module: Length;
  teeth: Count;
  /** `involute` (WM1a) or the clock and watch `cycloidal` tooth (WM1b). */
  profile: 'involute' | 'cycloidal';
  /** Involute only (and required there). */
  pressureAngle?: Angle;
  /** Involute only (and required there): profile shift coefficient x (× module). */
  profileShift?: number;
  /** Cycloidal only (and required there): teeth of the gear it meshes with. */
  matingTeeth?: Count;
  /** Cycloidal only (and required there): tooth thickness at the pitch circle, × circular pitch. */
  toothThickness?: number;
  /** Addendum and dedendum coefficients (× module). */
  addendum: number;
  dedendum: number;
  faceWidth: Length;
  /** Bore diameter; 0 mm for none. */
  bore: Length;
  spokes?: CadGearSpokes;
  /** Gear centre on its back face; the axis is +Z turned by `orientation`. */
  origin: Position3;
  orientation: Quaternion;
}
/** Resolved values, mm and rad. */
type GearSpecBase = {
  module: number;
  teeth: number;
  addendum: number;
  dedendum: number;
  bore: number;
  spokes?: { count: number; rim: number; hub: number; width: number };
};
export type InvoluteGearSpec = GearSpecBase & {
  profile?: 'involute';
  pressureAngle: number;
  profileShift: number;
};
export type CycloidalGearSpec = GearSpecBase & {
  profile: 'cycloidal';
  matingTeeth: number;
  toothThickness: number;
};
export type SpurGearSpec = InvoluteGearSpec | CycloidalGearSpec;

export const cadGearLimits = Object.freeze({
  moduleMm: [0.02, 10] as const,
  teeth: [6, 400] as const,
  pressureAngleRad: [(14.5 * Math.PI) / 180, (30 * Math.PI) / 180] as const,
  profileShift: [-1, 1] as const,
  addendum: [0.5, 1.5] as const,
  dedendum: [0.8, 2] as const,
  /** Cycloidal (watch) teeth run longer and thinner than involute ones. */
  cycloidalAddendum: [0.3, 2] as const,
  cycloidalDedendum: [0.8, 2.5] as const,
  toothThickness: [0.25, 0.6] as const,
  spokes: [3, 12] as const,
  /** Points each involute or epicycloid flank's spline passes through. */
  flankPoints: 7,
  /** A tooth tip narrower than this share of the module is refused as pointed. */
  minTipThickness: 0.1,
});

const inv = (a: number) => Math.tan(a) - a;

export function resolveSpurGear(a: CadSpurGearArgs, params: ParameterValues): SpurGearSpec {
  const s = a.spokes;
  const common = {
    module: resolveLength(a.module, params),
    teeth: resolveCount(a.teeth, params),
    addendum: a.addendum,
    dedendum: a.dedendum,
    bore: resolveLength(a.bore, params),
    ...(s && {
      spokes: {
        count: resolveCount(s.count, params),
        rim: resolveLength(s.rim, params),
        hub: resolveLength(s.hub, params),
        width: resolveLength(s.width, params),
      },
    }),
  };
  return a.profile === 'cycloidal'
    ? {
        ...common,
        profile: 'cycloidal',
        matingTeeth: resolveCount(a.matingTeeth!, params),
        toothThickness: a.toothThickness!,
      }
    : {
        ...common,
        profile: 'involute',
        pressureAngle: resolveAngle(a.pressureAngle!, params),
        profileShift: a.profileShift!,
      };
}

const shiftOf = (g: SpurGearSpec) => (g.profile === 'cycloidal' ? 0 : g.profileShift);
/** The gear's circles (mm). A cycloidal gear's base circle is its pitch circle (radial below). */
export function spurGearRadii(g: SpurGearSpec) {
  const pitch = (g.module * g.teeth) / 2;
  const x = shiftOf(g);
  return {
    pitch,
    base: g.profile === 'cycloidal' ? pitch : pitch * Math.cos(g.pressureAngle),
    tip: pitch + (g.addendum + x) * g.module,
    root: pitch - (g.dedendum - x) * g.module,
  };
}
/** A cycloidal tooth's epicycloid: rolling radius, and the point and parameter at radius r. */
function epicycloid(g: CycloidalGearSpec) {
  const R = (g.module * g.teeth) / 2;
  const rg = (g.module * g.matingTeeth) / 4;
  const at = (t: number): [number, number] => {
    const k = (R + rg) / rg;
    return [
      (R + rg) * Math.cos(t) - rg * Math.cos(k * t),
      (R + rg) * Math.sin(t) - rg * Math.sin(k * t),
    ];
  };
  // |e(t)|² = (R + rg)² + rg² − 2 rg (R + rg) cos(t R / rg); t within the first lobe.
  const tAt = (r: number) => {
    const c = ((R + rg) ** 2 + rg * rg - r * r) / (2 * rg * (R + rg));
    return (rg / R) * Math.acos(Math.max(-1, Math.min(1, c)));
  };
  /** Polar angle the curve turns through from the pitch point to radius r. */
  const turn = (r: number) => {
    const [x, y] = at(tAt(r));
    return Math.atan2(y, x);
  };
  return { R, rg, at, tAt, turn, max: R + 2 * rg };
}
/**
 * Half the tooth's angular thickness at radius r (rad), r at or above the base circle (up to
 * where the flanks end, `spurGearFlankEnd`).
 */
export function spurGearHalfAngle(g: SpurGearSpec, r: number): number {
  const { base } = spurGearRadii(g);
  if (g.profile === 'cycloidal') {
    const half = (Math.PI * g.toothThickness) / g.teeth;
    return r <= base ? half : half - epicycloid(g).turn(r);
  }
  const half =
    (Math.PI / 2 + 2 * g.profileShift * Math.tan(g.pressureAngle)) / g.teeth + inv(g.pressureAngle);
  return r <= base ? half : half - inv(Math.acos(base / r));
}
/**
 * Where the flanks end: the tip circle, or (cycloidal) the lower radius where the two epicycloids
 * meet on the tooth's centre line, an ogival point.
 */
export function spurGearFlankEnd(g: SpurGearSpec): { radius: number; pointed: boolean } {
  const { tip, base } = spurGearRadii(g);
  if (g.profile !== 'cycloidal') return { radius: tip, pointed: false };
  const reach = Math.min(tip, epicycloid(g).max * (1 - 1e-9));
  const half = spurGearHalfAngle(g, reach);
  if (half * 2 * reach >= cadGearLimits.minTipThickness * g.module)
    return { radius: reach, pointed: false };
  // Too thin to keep a land: an ogival point where the flanks close, or at the reach when they
  // stay just apart there (the last points then turn onto the centre line).
  if (half > 0) return { radius: reach, pointed: true };
  let [lo, hi] = [base, reach];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (spurGearHalfAngle(g, mid) > 0) lo = mid;
    else hi = mid;
  }
  return { radius: lo, pointed: true };
}

/** Ranges and geometry: the first problem as `{ code, path }` (path relative to the args). */
export function spurGearProblem(g: SpurGearSpec): { code: string; path: string } | undefined {
  const L = cadGearLimits;
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
  if (!within(g.module, L.moduleMm)) return { code: 'gear-module', path: 'module' };
  if (!Number.isInteger(g.teeth) || !within(g.teeth, L.teeth))
    return { code: 'gear-teeth', path: 'teeth' };
  const cycloidal = g.profile === 'cycloidal';
  if (cycloidal) {
    if (!Number.isInteger(g.matingTeeth) || !within(g.matingTeeth, L.teeth))
      return { code: 'gear-mating-teeth', path: 'matingTeeth' };
    if (!Number.isFinite(g.toothThickness) || !within(g.toothThickness, L.toothThickness))
      return { code: 'gear-tooth-thickness', path: 'toothThickness' };
  } else {
    if (!within(g.pressureAngle, L.pressureAngleRad))
      return { code: 'gear-pressure-angle', path: 'pressureAngle' };
    if (!Number.isFinite(g.profileShift) || !within(g.profileShift, L.profileShift))
      return { code: 'gear-profile-shift', path: 'profileShift' };
  }
  if (
    !Number.isFinite(g.addendum) ||
    !within(g.addendum, cycloidal ? L.cycloidalAddendum : L.addendum)
  )
    return { code: 'gear-addendum', path: 'addendum' };
  if (
    !Number.isFinite(g.dedendum) ||
    !within(g.dedendum, cycloidal ? L.cycloidalDedendum : L.dedendum)
  )
    return { code: 'gear-dedendum', path: 'dedendum' };
  if (!cycloidal) {
    if (g.dedendum <= g.addendum) return { code: 'gear-dedendum', path: 'dedendum' };
    // A rack cutter undercuts the root below this many teeth (with the addendum it cuts with).
    const sin = Math.sin(g.pressureAngle);
    if (g.teeth < (2 * (g.addendum - g.profileShift)) / (sin * sin))
      return { code: 'gear-undercut', path: 'teeth' };
  }
  const { base, tip, root } = spurGearRadii(g);
  if (root <= 0) return { code: 'gear-root', path: 'dedendum' };
  if (!cycloidal && 2 * tip * spurGearHalfAngle(g, tip) < L.minTipThickness * g.module)
    return { code: 'gear-tip-pointed', path: 'profileShift' };
  // The gap at the root must stay open between neighbouring teeth.
  if (spurGearHalfAngle(g, Math.max(root, base)) >= Math.PI / g.teeth)
    return { code: 'gear-root', path: cycloidal ? 'toothThickness' : 'dedendum' };
  if (!(g.bore >= 0)) return { code: 'gear-bore', path: 'bore' };
  if (!g.spokes) {
    if (g.bore / 2 >= root - g.module) return { code: 'gear-bore', path: 'bore' };
    return;
  }
  const s = g.spokes;
  if (!Number.isInteger(s.count) || !within(s.count, L.spokes))
    return { code: 'gear-spokes', path: 'spokes.count' };
  const inner = g.bore / 2 + s.hub;
  const outer = root - s.rim;
  if (!(s.hub > 0) || !(s.rim > 0) || !(s.width > 0) || outer - inner < g.module / 2)
    return { code: 'gear-spokes-too-wide', path: 'spokes' };
  // Each window must stay open at the hub: the arms' half widths take less than its angle.
  if (2 * Math.asin(Math.min(1, s.width / 2 / inner)) >= (2 * Math.PI) / s.count - 1e-6)
    return { code: 'gear-spokes-too-wide', path: 'spokes.width' };
  return;
}

/**
 * The gear's outline as a sketch on its own plane (origin at the gear centre, tooth 0 centred on
 * +u) and the region to extrude. Call only for a spec without a `spurGearProblem`.
 */
export function spurGearSketch(
  g: SpurGearSpec,
  id = 'gear',
): {
  sketch: CadSketch;
  region: CadSketchRegion;
} {
  const { base, root } = spurGearRadii(g);
  const end = spurGearFlankEnd(g);
  const tip = end.radius;
  const solved: Record<string, [number, number]> = { o: [0, 0] };
  const entities: CadSketchEntity[] = [{ type: 'point', id: 'o' }];
  const point = (pid: string, p: [number, number]) => {
    solved[pid] = p;
    entities.push({ type: 'point', id: pid });
    return pid;
  };
  const polar = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
  const outer: string[] = [];
  const start = Math.max(root, base);
  const n = cadGearLimits.flankPoints;
  const radii = Array.from({ length: n }, (_, i) => start + ((tip - start) * i) / (n - 1));
  const pitchAngle = (2 * Math.PI) / g.teeth;
  const flank = (k: number, side: 'l' | 'r') => {
    const c = k * pitchAngle;
    const sign = side === 'l' ? -1 : 1;
    const pts = radii.map((r, i) =>
      // A pointed (ogival) tip ends exactly on the centre line, shared by both flanks.
      end.pointed && i === n - 1 ? polar(r, c) : polar(r, c + sign * spurGearHalfAngle(g, r)),
    );
    const poles = splineThrough(pts, 3, false);
    const ids = poles.map((p, i) => {
      if (end.pointed && side === 'r' && i === poles.length - 1) return `t${k}l${n - 1}`;
      const pid = `t${k}${side}${i}`;
      return point(pid, i === 0 ? pts[0]! : i === poles.length - 1 ? pts.at(-1)! : p);
    });
    // Left flank runs root→tip, right flank tip→root, so the outline walks counter-clockwise.
    if (side === 'r') ids.reverse();
    return ids;
  };
  const halfStart = spurGearHalfAngle(g, start);
  for (let k = 0; k < g.teeth; k++) {
    const c = k * pitchAngle;
    const radial = root < base;
    if (radial) {
      const foot = point(`t${k}lf`, polar(root, c - halfStart));
      entities.push({ type: 'line', id: `t${k}lr`, start: foot, end: `t${k}l0` });
    }
    const left = flank(k, 'l');
    if (radial) outer.push(`t${k}lr`);
    entities.push({ type: 'spline', id: `t${k}l`, poles: left, degree: 3 });
    outer.push(`t${k}l`);
    const right = flank(k, 'r');
    if (!end.pointed) {
      entities.push({
        type: 'arc',
        id: `t${k}tip`,
        center: 'o',
        start: left.at(-1)!,
        end: right[0]!,
        clockwise: false,
      });
      outer.push(`t${k}tip`);
    }
    entities.push({ type: 'spline', id: `t${k}r`, poles: right, degree: 3 });
    outer.push(`t${k}r`);
    let last = right.at(-1)!;
    if (radial) {
      const foot = point(`t${k}rf`, polar(root, c + halfStart));
      entities.push({ type: 'line', id: `t${k}rr`, start: last, end: foot });
      outer.push(`t${k}rr`);
      last = foot;
    }
    const next = (k + 1) % g.teeth;
    entities.push({
      type: 'arc',
      id: `t${k}root`,
      center: 'o',
      start: last,
      end: radial ? `t${next}lf` : `t${next}l0`,
      clockwise: false,
    });
    outer.push(`t${k}root`);
  }
  const holes: string[][] = [];
  if (g.bore > 0) {
    entities.push({ type: 'circle', id: 'bore', center: 'o' });
    solved.bore = [g.bore / 2, 0];
    holes.push(['bore']);
  }
  const s = g.spokes;
  if (s) {
    const inner = g.bore / 2 + s.hub;
    const outerR = root - s.rim;
    const w = s.width / 2;
    // The point on the circle of radius r at distance w from the arm through angle a, on the side
    // of `sign` (+1 counter-clockwise).
    const side = (r: number, a: number, sign: number): [number, number] => {
      const t = Math.sqrt(r * r - w * w);
      return [t * Math.cos(a) - sign * w * Math.sin(a), t * Math.sin(a) + sign * w * Math.cos(a)];
    };
    for (let k = 0; k < s.count; k++) {
      const a0 = (k * 2 * Math.PI) / s.count;
      const a1 = a0 + (2 * Math.PI) / s.count;
      const p = (name: string, q: [number, number]) => point(`w${k}${name}`, q);
      const A = p('a', side(inner, a0, 1));
      const B = p('b', side(outerR, a0, 1));
      const C = p('c', side(outerR, a1, -1));
      const D = p('d', side(inner, a1, -1));
      entities.push(
        { type: 'line', id: `w${k}s0`, start: A, end: B },
        { type: 'arc', id: `w${k}o`, center: 'o', start: B, end: C, clockwise: false },
        { type: 'line', id: `w${k}s1`, start: C, end: D },
        { type: 'arc', id: `w${k}i`, center: 'o', start: A, end: D, clockwise: false },
      );
      holes.push([`w${k}s0`, `w${k}o`, `w${k}s1`, `w${k}i`]);
    }
  }
  return {
    sketch: {
      id,
      name: 'Gear',
      plane: {
        origin: [{ literalMm: 0 }, { literalMm: 0 }, { literalMm: 0 }],
        orientation: [0, 0, 0, 1],
      },
      entities,
      constraints: [],
      solved,
    } as CadSketch,
    region: { outer, holes },
  };
}

export type CadSpurGearFeature = Extract<CadFeature, { type: 'spurGear' }>;
