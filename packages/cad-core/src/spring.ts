/**
 * PD5 (docs/cad/product-design.md, PD5 ばね): a spring as a feature, and its textbook estimates.
 *
 * Shapes. A coil spring (`form: 'coil'`, compression, extension or torsion) is its round wire
 * swept along a helix: `coils` turns at a constant `pitch` about +Z, the wire's centre starting
 * at (D/2, 0, d/2), so the spring stands on z = 0 and its free length is coils · pitch + d. Ends
 * are cut square to the wire (not closed or ground), and a torsion spring's legs and an extension
 * spring's hooks are not drawn. A spiral spring (`form: 'spiral'`, a mainspring or a hairspring)
 * is a flat strip `thickness` thick (radially) and `height` high (+Z) along an Archimedean spiral
 * whose inner face starts at `innerRadius` on +X and moves out `pitch` each turn, counter-clockwise
 * seen from +Z: one sketch region extruded once (as a spur gear is), so no Boolean.
 *
 * Estimates (PD-U5) are the textbook formulas only: spring rate, the force or torque and the
 * stress at a working deflection or angle, a compression spring's solid length, a mainspring's
 * turns in its barrel and its running time from the hours one barrel turn lasts. Fatigue,
 * friction, end effects, hooks and legs, and a hairspring's isochronism are out of scope; the
 * numbers are guides for sizing, never a check of the spring's life.
 */
import type { Angle, CadDocument, CadFeature, Length, Position3, Quaternion } from './model';
import { resolveAngle, resolveLength, type ParameterValues } from './graph';
import { type CadSketch, type CadSketchEntity, type CadSketchRegion } from './sketch';

export type CadCoilSpringUse = 'compression' | 'extension' | 'torsion';
export type CadSpiralSpringUse = 'mainspring' | 'hairspring';
export type CadSpringUse = CadCoilSpringUse | CadSpiralSpringUse;
/** Elastic moduli (MPa = N/mm²). Shear is needed by compression and extension springs. */
export interface CadSpringMaterial {
  youngsModulusMpa: number;
  shearModulusMpa?: number;
}
export interface CadCoilSpringArgs {
  form: 'coil';
  use: CadCoilSpringUse;
  /** Wire diameter d. */
  wireDiameter: Length;
  /** Mean coil diameter D (wire centre to wire centre across the axis). */
  meanDiameter: Length;
  /** Axial distance from one turn to the next. */
  pitch: Length;
  /** Turns drawn (1–100, fractions allowed). */
  coils: number;
  /** Turns that spring (more than 0, at most `coils`): the rate's n. */
  activeCoils: number;
  hand: 'right' | 'left';
  material: CadSpringMaterial;
  /** Compression or extension: the working deflection from the free length. */
  deflection?: Length;
  /** Torsion: the working angle turned from rest. */
  angle?: Angle;
  /** Extension: the initial tension of a close-wound spring (N, ≥ 0). */
  initialTensionN?: number;
  /** The axis' foot; the axis is +Z turned by `orientation`. */
  origin: Position3;
  orientation: Quaternion;
}
/** A mainspring's barrel: the drum's inner radius and the arbor's (core) radius. */
export interface CadSpringBarrel {
  innerRadius: Length;
  arborRadius: Length;
  /** How long one turn of the barrel lasts (h), entered or taken from the train. */
  hoursPerTurn?: number;
}
export interface CadSpiralSpringArgs {
  form: 'spiral';
  use: CadSpiralSpringUse;
  /** Strip thickness t (radial). */
  thickness: Length;
  /** Strip height b (along +Z). */
  height: Length;
  /** Radius of the strip's inner face where it starts (on +X). */
  innerRadius: Length;
  /** Radial step per turn (more than the thickness). */
  pitch: Length;
  /** Turns drawn (0.5–30, fractions allowed). */
  turns: number;
  material: CadSpringMaterial;
  /** The working angle wound from rest (a hairspring's amplitude, or a mainspring without barrel). */
  angle?: Angle;
  /** Mainspring only. */
  barrel?: CadSpringBarrel;
  /** The spiral's centre on its bottom face; the axis is +Z turned by `orientation`. */
  origin: Position3;
  orientation: Quaternion;
}
export type CadSpringArgs = CadCoilSpringArgs | CadSpiralSpringArgs;
export type CadSpringFeature = Extract<CadFeature, { type: 'spring' }>;

export const cadSpringLimits = Object.freeze({
  coils: [1, 100] as const,
  turns: [0.5, 30] as const,
  /** Any modulus within this band (MPa): from soft plastics to tungsten carbide. */
  modulusMpa: [100, 1_000_000] as const,
  initialTensionN: 1e6,
  hoursPerTurn: 10_000,
  /** A working angle, either way of zero: up to 100 turns (a mainspring wound many turns). */
  maxAngleRad: 200 * Math.PI,
  /** Spring index D/d at least this (the wire must not cross the axis). */
  minIndex: 2,
  /** The gap between neighbouring turns, at least this share of the wire or strip. */
  minGapShare: 0.02,
  /** Bézier pieces per spiral turn and per helix turn. */
  spiralPointsPerTurn: 8,
  helixPiecesPerTurn: 4,
});

/** Resolved values (mm, rad, MPa). */
export type CoilSpringSpec = {
  form: 'coil';
  use: CadCoilSpringUse;
  wireDiameter: number;
  meanDiameter: number;
  pitch: number;
  coils: number;
  activeCoils: number;
  hand: 'right' | 'left';
  youngsModulusMpa: number;
  shearModulusMpa?: number;
  deflection?: number;
  angle?: number;
  initialTensionN?: number;
};
export type SpiralSpringSpec = {
  form: 'spiral';
  use: CadSpiralSpringUse;
  thickness: number;
  height: number;
  innerRadius: number;
  pitch: number;
  turns: number;
  youngsModulusMpa: number;
  angle?: number;
  barrel?: { innerRadius: number; arborRadius: number; hoursPerTurn?: number };
};
export type SpringSpec = CoilSpringSpec | SpiralSpringSpec;

export function resolveSpring(a: CadSpringArgs, params: ParameterValues): SpringSpec {
  const len = (l: Length) => resolveLength(l, params);
  if (a.form === 'coil')
    return {
      form: 'coil',
      use: a.use,
      wireDiameter: len(a.wireDiameter),
      meanDiameter: len(a.meanDiameter),
      pitch: len(a.pitch),
      coils: a.coils,
      activeCoils: a.activeCoils,
      hand: a.hand,
      youngsModulusMpa: a.material.youngsModulusMpa,
      ...(a.material.shearModulusMpa !== undefined && {
        shearModulusMpa: a.material.shearModulusMpa,
      }),
      ...(a.deflection && { deflection: len(a.deflection) }),
      ...(a.angle && { angle: resolveAngle(a.angle, params) }),
      ...(a.initialTensionN !== undefined && { initialTensionN: a.initialTensionN }),
    };
  return {
    form: 'spiral',
    use: a.use,
    thickness: len(a.thickness),
    height: len(a.height),
    innerRadius: len(a.innerRadius),
    pitch: len(a.pitch),
    turns: a.turns,
    youngsModulusMpa: a.material.youngsModulusMpa,
    ...(a.angle && { angle: resolveAngle(a.angle, params) }),
    ...(a.barrel && {
      barrel: {
        innerRadius: len(a.barrel.innerRadius),
        arborRadius: len(a.barrel.arborRadius),
        ...(a.barrel.hoursPerTurn !== undefined && { hoursPerTurn: a.barrel.hoursPerTurn }),
      },
    }),
  };
}

export type CadSpringProblemCode =
  /** D/d below 2: the wire would reach the axis. */
  | 'spring-index'
  /** Neighbouring turns of the wire (or the strip) touch or overlap. */
  | 'spring-coils-touch'
  /** More active turns than turns drawn. */
  | 'spring-active-coils'
  /** A compression spring's working deflection reaches its solid length. */
  | 'spring-deflection-solid'
  /** The barrel's arbor is not inside its drum. */
  | 'spring-barrel'
  /** The strip does not fit between the arbor and the drum. */
  | 'spring-barrel-full';
export interface CadSpringProblem {
  code: CadSpringProblemCode;
  /** The argument it is about, under the feature's `args`. */
  path: string;
}

/** The angle a coil's wire leans at against the plane square to the axis (rad). */
export const coilHelixAngle = (s: Pick<CoilSpringSpec, 'pitch' | 'meanDiameter'>) =>
  Math.atan2(s.pitch, Math.PI * s.meanDiameter);
/** Free length (axial, with the wire's ends cut square): coils · pitch + d. */
export const coilFreeLength = (s: CoilSpringSpec) => s.coils * s.pitch + s.wireDiameter;
/** Solid length: every turn on the next, (coils + 1) · d. */
export const coilSolidLength = (s: CoilSpringSpec) => (s.coils + 1) * s.wireDiameter;

/** The spring's geometry and its working values, or the first thing wrong with them. */
export function springProblem(s: SpringSpec): CadSpringProblem | undefined {
  if (s.form === 'coil') {
    const d = s.wireDiameter;
    if (s.meanDiameter / d < cadSpringLimits.minIndex)
      return { code: 'spring-index', path: 'meanDiameter' };
    // The wire is round square to its own run, so it is d / cos λ tall along the axis.
    const gap = s.pitch - d / Math.cos(coilHelixAngle(s));
    if (gap < cadSpringLimits.minGapShare * d) return { code: 'spring-coils-touch', path: 'pitch' };
    if (s.activeCoils > s.coils) return { code: 'spring-active-coils', path: 'activeCoils' };
    if (
      s.use === 'compression' &&
      s.deflection !== undefined &&
      s.deflection >= coilFreeLength(s) - coilSolidLength(s)
    )
      return { code: 'spring-deflection-solid', path: 'deflection' };
    return;
  }
  if (s.pitch - s.thickness < cadSpringLimits.minGapShare * s.thickness)
    return { code: 'spring-coils-touch', path: 'pitch' };
  const b = s.barrel;
  if (b) {
    if (b.arborRadius >= b.innerRadius)
      return { code: 'spring-barrel', path: 'barrel.arborRadius' };
    const area = (spiralStripLength(s) * s.thickness) / Math.PI;
    if (area >= b.innerRadius ** 2 - b.arborRadius ** 2)
      return { code: 'spring-barrel-full', path: 'barrel.innerRadius' };
  }
  return;
}

/** The spiral's centre line: radius at angle θ (rad, from +X). */
const spiralRadius = (s: SpiralSpringSpec, theta: number) =>
  s.innerRadius + s.thickness / 2 + (s.pitch * theta) / (2 * Math.PI);
/** Length of the strip along its centre line (mm), by Simpson's rule (exact to ~1e-9). */
export function spiralStripLength(s: SpiralSpringSpec): number {
  const end = 2 * Math.PI * s.turns;
  const dr = s.pitch / (2 * Math.PI);
  const f = (t: number) => Math.hypot(spiralRadius(s, t), dr);
  const n = 2 * Math.ceil(s.turns * 64);
  const h = end / n;
  let sum = f(0) + f(end);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * h);
  return (sum * h) / 3;
}

/**
 * The spiral strip as one closed sketch region in its own plane: the inner and outer faces as
 * chains of cubic Bézier pieces (8 a turn, each a 4-pole spline matching the spiral's points and
 * tangents at its ends, within 10⁻³ of its radius), joined by straight ends. Pieces are named
 * `inner<i>` and `outer<i>` from the start, the ends `start` (inner end) and `end` (outer end).
 */
export function spiralSpringSketch(
  s: SpiralSpringSpec,
  id = 'spring',
): { sketch: CadSketch; region: CadSketchRegion } {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketchEntity[] = [];
  const end = 2 * Math.PI * s.turns;
  const n = Math.max(4, Math.ceil(s.turns * cadSpringLimits.spiralPointsPerTurn - 1e-9));
  const dr = s.pitch / (2 * Math.PI);
  const point = (pid: string, p: [number, number]) => {
    solved[pid] = p;
    entities.push({ type: 'point', id: pid });
    return pid;
  };
  const curve = (name: 'inner' | 'outer', off: number) => {
    const at = (t: number): [number, number] => {
      const r = spiralRadius(s, t) + off;
      return [r * Math.cos(t), r * Math.sin(t)];
    };
    const tangent = (t: number): [number, number] => {
      const r = spiralRadius(s, t) + off;
      return [dr * Math.cos(t) - r * Math.sin(t), dr * Math.sin(t) + r * Math.cos(t)];
    };
    const ids: string[] = [];
    let last = point(`${name}p0`, at(0));
    for (let i = 0; i < n; i++) {
      const [t, u] = [(end * i) / n, (end * (i + 1)) / n];
      const k = (u - t) / 3;
      const [p, q, dp, dq] = [at(t), at(u), tangent(t), tangent(u)];
      const a = point(`${name}c${i}a`, [p[0] + k * dp[0], p[1] + k * dp[1]]);
      const b = point(`${name}c${i}b`, [q[0] - k * dq[0], q[1] - k * dq[1]]);
      const next = point(`${name}p${i + 1}`, q);
      entities.push({ type: 'spline', id: `${name}${i}`, poles: [last, a, b, next], degree: 3 });
      ids.push(`${name}${i}`);
      last = next;
    }
    return ids;
  };
  const inner = curve('inner', -s.thickness / 2);
  const outer = curve('outer', s.thickness / 2);
  entities.push(
    { type: 'line', id: 'end', start: `innerp${n}`, end: `outerp${n}` },
    { type: 'line', id: 'start', start: 'outerp0', end: 'innerp0' },
  );
  return {
    sketch: {
      id,
      name: 'Spring',
      plane: {
        origin: [{ literalMm: 0 }, { literalMm: 0 }, { literalMm: 0 }],
        orientation: [0, 0, 0, 1],
      },
      entities,
      constraints: [],
      solved,
    } as CadSketch,
    region: { outer: [...inner, 'end', ...[...outer].reverse(), 'start'], holes: [] },
  };
}

/**
 * A coil's wire centre line as a clamped cubic B-spline: one Bézier piece per quarter turn (the
 * last one shorter), each the standard circle-arc piece in plan with z rising as its angle does at the ends. It stays
 * within 3·10⁻⁴ · D/2 of the exact helix across the axis and 10⁻³ · pitch along it. `tangent` is the unit direction at its start.
 */
export function coilSpringPath(s: CoilSpringSpec): {
  poles: [number, number, number][];
  knots: number[];
  mults: number[];
  tangent: [number, number, number];
} {
  const R = s.meanDiameter / 2;
  const hand = s.hand === 'right' ? 1 : -1;
  const rise = s.pitch / (2 * Math.PI);
  const end = 2 * Math.PI * s.coils;
  const quarter = (2 * Math.PI) / cadSpringLimits.helixPiecesPerTurn;
  const pieces = Math.ceil(end / quarter - 1e-9);
  const at = (t: number): [number, number, number] => [
    R * Math.cos(t),
    hand * R * Math.sin(t),
    s.wireDiameter / 2 + rise * t,
  ];
  const plan = (t: number): [number, number] => [-Math.sin(t), hand * Math.cos(t)];
  const poles: [number, number, number][] = [at(0)];
  for (let i = 0; i < pieces; i++) {
    const t = i * quarter;
    const u = Math.min(end, (i + 1) * quarter);
    const step = u - t;
    const c = (4 / 3) * Math.tan(step / 4);
    const k = c * R;
    const [p, q] = [at(t), at(u)];
    const [dp, dq] = [plan(t), plan(u)];
    // z follows the plan's angle: its control points rise as the angle does at the piece's ends.
    const dz = rise * c;
    poles.push(
      [p[0] + k * dp[0], p[1] + k * dp[1], p[2] + dz],
      [q[0] - k * dq[0], q[1] - k * dq[1], q[2] - dz],
      q,
    );
  }
  const knots = Array.from({ length: pieces + 1 }, (_, i) => i);
  const mults = knots.map((_, i) => (i === 0 || i === pieces ? 4 : 3));
  const T: [number, number, number] = [0, hand * R, rise];
  const l = Math.hypot(...T);
  return { poles, knots, mults, tangent: [T[0] / l, T[1] / l, T[2] / l] };
}

/** What a spring's estimate holds; every value is the textbook one (PD-U5). */
export interface CadSpringEstimate {
  form: 'coil' | 'spiral';
  use: CadSpringUse;
  /** Compression and extension: N/mm. Torsion and spiral: N·mm/rad. */
  rate: number;
  rateUnit: 'N/mm' | 'N·mm/rad';
  /** Coil: D/d and the stress correction (Wahl's for a coil in torsion, bending's for a torsion spring). */
  springIndex?: number;
  stressFactor?: number;
  /** Coil: free and solid length (mm); compression: the deflection to solid. */
  freeLengthMm?: number;
  solidLengthMm?: number;
  maxDeflectionMm?: number;
  /** Spiral: the strip's length along its centre line (mm). */
  stripLengthMm?: number;
  /** At the working deflection or angle, when one is given. */
  working?: {
    deflectionMm?: number;
    angleRad?: number;
    forceN?: number;
    torqueNmm?: number;
    stressMpa: number;
  };
  /** Compression: closed to solid. */
  solid?: { forceN: number; stressMpa: number };
  /** A mainspring in its barrel. */
  barrel?: {
    /** Turns of the strip on the arbor fully wound, and against the drum let down. */
    woundTurns: number;
    letDownTurns: number;
    /** Turns the barrel gives from let down to fully wound. */
    usableTurns: number;
    /** The strip's share of the space between arbor and drum (0.5 gives the most turns). */
    fill: number;
    /** Fully wound (linear in the turns: friction ignored). */
    fullTorqueNmm: number;
    fullStressMpa: number;
    /** usableTurns × hoursPerTurn, when the hours per barrel turn are known. */
    runHours?: number;
    hoursPerTurn?: number;
  };
}

/**
 * PD5: the textbook estimate of a valid spring (`springProblem` is undefined).
 *
 * - Compression and extension: k = G d⁴ / (8 D³ n); τ = K_W · 8 F D / (π d³) with Wahl's
 *   K_W = (4C − 1)/(4C − 4) + 0.615/C; an extension spring's F = F₀ + k δ.
 * - Torsion: k = E d⁴ / (64 D n) per radian (legs ignored); σ = K_i · 32 M / (π d³) with
 *   K_i = (4C² − C − 1) / (4C (C − 1)) on the coil's inside.
 * - Spiral: k = E b t³ / (12 L) per radian; σ = 6 M / (b t²). A mainspring in its barrel (radius
 *   R, arbor r) wound tight on the arbor has (√(r² + Lt/π) − r)/t turns and let down against the
 *   drum (R − √(R² − Lt/π))/t; the barrel turns their difference.
 */
export function springEstimate(s: SpringSpec, hoursPerTurn?: number): CadSpringEstimate {
  if (s.form === 'coil') {
    const { wireDiameter: d, meanDiameter: D, activeCoils: n } = s;
    const C = D / d;
    if (s.use === 'torsion') {
      const E = s.youngsModulusMpa;
      const rate = (E * d ** 4) / (64 * D * n);
      const Ki = (4 * C * C - C - 1) / (4 * C * (C - 1));
      const stress = (M: number) => (Ki * 32 * M) / (Math.PI * d ** 3);
      const M = s.angle !== undefined ? rate * s.angle : undefined;
      return {
        form: 'coil',
        use: s.use,
        rate,
        rateUnit: 'N·mm/rad',
        springIndex: C,
        stressFactor: Ki,
        freeLengthMm: coilFreeLength(s),
        ...(M !== undefined && {
          working: { angleRad: s.angle!, torqueNmm: M, stressMpa: stress(M) },
        }),
      };
    }
    const G = s.shearModulusMpa!;
    const rate = (G * d ** 4) / (8 * D ** 3 * n);
    const Kw = (4 * C - 1) / (4 * C - 4) + 0.615 / C;
    const stress = (F: number) => (Kw * 8 * F * D) / (Math.PI * d ** 3);
    const F0 = s.use === 'extension' ? (s.initialTensionN ?? 0) : 0;
    const free = coilFreeLength(s);
    const out: CadSpringEstimate = {
      form: 'coil',
      use: s.use,
      rate,
      rateUnit: 'N/mm',
      springIndex: C,
      stressFactor: Kw,
      freeLengthMm: free,
    };
    if (s.deflection !== undefined) {
      const F = F0 + rate * s.deflection;
      out.working = { deflectionMm: s.deflection, forceN: F, stressMpa: stress(F) };
    }
    if (s.use === 'compression') {
      const solid = coilSolidLength(s);
      const F = rate * (free - solid);
      out.solidLengthMm = solid;
      out.maxDeflectionMm = free - solid;
      out.solid = { forceN: F, stressMpa: stress(F) };
    }
    return out;
  }
  const { thickness: t, height: b } = s;
  const L = spiralStripLength(s);
  const rate = (s.youngsModulusMpa * b * t ** 3) / (12 * L);
  const stress = (M: number) => (6 * M) / (b * t * t);
  const out: CadSpringEstimate = {
    form: 'spiral',
    use: s.use,
    rate,
    rateUnit: 'N·mm/rad',
    stripLengthMm: L,
  };
  if (s.angle !== undefined) {
    const M = rate * s.angle;
    out.working = { angleRad: s.angle, torqueNmm: M, stressMpa: stress(M) };
  }
  const barrel = s.barrel;
  if (barrel) {
    const { innerRadius: R, arborRadius: r } = barrel;
    const a = (L * t) / Math.PI;
    const wound = (Math.sqrt(r * r + a) - r) / t;
    const down = (R - Math.sqrt(R * R - a)) / t;
    const usable = wound - down;
    const M = rate * 2 * Math.PI * usable;
    const hours = hoursPerTurn ?? barrel.hoursPerTurn;
    out.barrel = {
      woundTurns: wound,
      letDownTurns: down,
      usableTurns: usable,
      fill: a / (R * R - r * r),
      fullTorqueNmm: M,
      fullStressMpa: stress(M),
      ...(hours !== undefined && { runHours: usable * hours, hoursPerTurn: hours }),
    };
  }
  return out;
}

/**
 * PD5 (輪列の比): how long one turn of the barrel's joint lasts, from the assembly's gear train
 * (WM2 meshes and other angle couplings): `referenceHoursPerTurn` (1 for a centre wheel that
 * carries the minute hand) times the reference's turns per barrel turn. Couplings are followed
 * either way (a follower's turns are `ratio` × its driver's), so two joints that only share a
 * driver are joined too. Undefined when no chain of angle couplings joins the two.
 */
export function trainHoursPerTurn(
  doc: Pick<CadDocument, 'joints'>,
  barrelJoint: string,
  referenceJoint: string,
  referenceHoursPerTurn = 1,
): number | undefined {
  const angular = (k: string) => k === 'angle' || k === 'angle2' || k === 'angle3';
  const node = (joint: string, of: string) => `${joint}\u0000${of}`;
  // Each edge: turns of `to` per turn of the node it leaves.
  const edges = new Map<string, { to: string; ratio: number }[]>();
  const add = (from: string, to: string, ratio: number) =>
    edges.set(from, [...(edges.get(from) ?? []), { to, ratio }]);
  for (const j of doc.joints)
    for (const c of j.couplings ?? [])
      if (angular(c.of) && angular(c.from.of) && c.ratio) {
        const [driver, follower] = [node(c.from.joint, c.from.of), node(j.id, c.of)];
        add(driver, follower, c.ratio);
        add(follower, driver, 1 / c.ratio);
      }
  const start = node(barrelJoint, 'angle');
  const goal = node(referenceJoint, 'angle');
  // Turns of each node per barrel turn.
  const turns = new Map([[start, 1]]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === goal) return referenceHoursPerTurn * Math.abs(turns.get(at)!);
    for (const e of edges.get(at) ?? [])
      if (!turns.has(e.to)) {
        turns.set(e.to, turns.get(at)! * e.ratio);
        queue.push(e.to);
      }
  }
  return undefined;
}

const mm = (v: number) => ({ literalMm: v });
/** A compression spring of spring steel: 1 mm wire on 8 mm, 8 turns (6 active), 2 mm pitch. */
export const defaultCoilSpringArgs = (
  at: Pick<CadCoilSpringArgs, 'origin' | 'orientation'>,
): CadCoilSpringArgs => ({
  form: 'coil',
  use: 'compression',
  wireDiameter: mm(1),
  meanDiameter: mm(8),
  pitch: mm(2),
  coils: 8,
  activeCoils: 6,
  hand: 'right',
  material: { youngsModulusMpa: 206_000, shearModulusMpa: 79_000 },
  origin: at.origin,
  orientation: at.orientation,
});
/** A watch mainspring of spring steel in a 5.1 mm barrel (as F155's), 8 h a barrel turn. */
export const defaultSpiralSpringArgs = (
  at: Pick<CadSpiralSpringArgs, 'origin' | 'orientation'>,
): CadSpiralSpringArgs => ({
  form: 'spiral',
  use: 'mainspring',
  thickness: mm(0.1),
  height: mm(0.55),
  innerRadius: mm(1.8),
  pitch: mm(0.24),
  turns: 13,
  material: { youngsModulusMpa: 206_000 },
  barrel: { innerRadius: mm(5.1), arborRadius: mm(1.6), hoursPerTurn: 8 },
  origin: at.origin,
  orientation: at.orientation,
});
