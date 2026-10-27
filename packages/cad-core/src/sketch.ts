import { deBoor, fullSpline } from './bspline';
/**
 * Constrained sketches (docs/cad/r1-modeling.md, 拘束付きsketch（F2）): the stored form, constraint
 * residuals, the solver with degrees of freedom and redundancy, and closed regions. Pure functions:
 * the same sketch and parameter values always give the same coordinates.
 */
import { resolveAngle, resolveLength, type ParameterValues } from './graph';
import {
  cadLimits,
  cadTolerance,
  type Angle,
  type CadPlane,
  type Length,
  type Quaternion,
  type Vec3,
} from './model';
import type { CadTopologyRef } from './topology';

/**
 * Sketch elements. A point's coordinates and a circle's radius live in `CadSketch.solved`; an arc
 * runs from `start` to `end` around `center`, counter-clockwise unless `clockwise`. A spline
 * (docs/cad/r2a-freeform.md, 曲線) is a non-rational B-spline whose control points `poles` are
 * sketch points; its knots are uniform, clamped to pass through the first and last pole, or
 * periodic when `closed` (then it is a loop by itself, as a circle is). It adds no unknowns: its
 * shape follows its poles. Construction elements take part in constraints but never in a region.
 */
export type CadSketchEntity =
  | { type: 'point'; id: string }
  | { type: 'line'; id: string; start: string; end: string; construction?: boolean }
  | {
      type: 'arc';
      id: string;
      center: string;
      start: string;
      end: string;
      clockwise: boolean;
      construction?: boolean;
    }
  | { type: 'circle'; id: string; center: string; construction?: boolean }
  | {
      type: 'spline';
      id: string;
      poles: string[];
      degree: 2 | 3 | 5;
      closed?: boolean;
      construction?: boolean;
    };
type Rule<T extends string, X> = { id: string; type: T } & X;
/**
 * Geometric and dimensional constraints. `a`/`b` name points, lines or curves (arcs and circles)
 * as the type needs; `tangent` takes a line and a curve or two curves. Distances are unsigned;
 * `angle` turns line `a` counter-clockwise onto line `b`.
 */
export type CadSketchConstraint =
  | Rule<'coincident', { a: string; b: string }>
  | Rule<'horizontal' | 'vertical', { line: string }>
  | Rule<'parallel' | 'perpendicular' | 'tangent' | 'equal', { a: string; b: string }>
  | Rule<'midpoint' | 'pointOnLine', { point: string; line: string }>
  | Rule<'pointOnCurve', { point: string; curve: string }>
  | Rule<'symmetric', { a: string; b: string; line: string }>
  | Rule<'fix', { point: string; at: [Length, Length] }>
  | Rule<
      'distance' | 'horizontalDistance' | 'verticalDistance',
      { a: string; b: string; value: Length }
    >
  | Rule<'pointLineDistance', { point: string; line: string; value: Length }>
  | Rule<'angle', { a: string; b: string; value: Angle }>
  | Rule<'radius' | 'diameter', { curve: string; value: Length }>;
export type CadSketchConstraintType = CadSketchConstraint['type'];
/** A datum plane, or a planar face of a feature's output moved `offset` along its normal. */
export type CadSketchPlane = CadPlane | { face: CadTopologyRef; offset: Length };
export interface CadSketch {
  id: string;
  name: string;
  plane: CadSketchPlane;
  entities: CadSketchEntity[];
  constraints: CadSketchConstraint[];
  /**
   * The last solved coordinates, part of the source: `[u, v]` for each point and `[radius, 0]`
   * for each circle, keyed by element ID. Evaluation reads only these.
   */
  solved: Record<string, [number, number]>;
}
/** A closed area: element IDs of one outer loop and 0–64 holes, each loop a chain or one circle. */
export interface CadSketchRegion {
  outer: string[];
  holes: string[][];
}

export const cadSketchLimits = Object.freeze({
  sketches: 64,
  entities: 1024,
  constraints: 2048,
  holes: 64,
  iterations: 100,
  /** Control points of one spline (and at least its degree + 1). */
  splinePoles: [4, 256] as const,
  splineDegrees: [2, 3, 5] as const,
});

/**
 * A spline's knots as OCCT takes them (distinct values and multiplicities): uniform, clamped
 * (end multiplicity degree + 1) for an open spline, all simple for a periodic one.
 */
export function splineKnots(
  poles: number,
  degree: number,
  closed: boolean,
): { knots: number[]; mults: number[] } {
  if (closed) {
    const knots = Array.from({ length: poles + 1 }, (_, i) => i);
    return { knots, mults: knots.map(() => 1) };
  }
  const knots = Array.from({ length: poles - degree + 1 }, (_, i) => i);
  return {
    knots,
    mults: knots.map((_, i) => (i === 0 || i === knots.length - 1 ? degree + 1 : 1)),
  };
}
/** Samples per knot span: the polygon that self-intersection and overlap checks use. */
const splineSamplesPerSpan = 8;
/**
 * Points along a spline (de Boor): `perSpan` per knot span from start to end, the ends exactly
 * the first and last pole for an open spline; a closed one ends where it starts.
 */
export function splinePoints(
  poles: readonly (readonly [number, number])[],
  degree: number,
  closed: boolean,
  perSpan = splineSamplesPerSpan,
): [number, number][] {
  const n = poles.length;
  const p = degree;
  const { cps, knots } = fullSpline(p, closed, poles);
  const spans = closed ? n : n - p;
  const out: [number, number][] = [];
  for (let k = 0; k <= spans * perSpan; k++) {
    const t = k / perSpan;
    // The span: knots[sp] <= t < knots[sp + 1] (the last span includes its end).
    const sp = p + Math.min(Math.floor(t), spans - 1);
    out.push(deBoor(cps, knots, p, sp, t));
  }
  if (!closed) {
    out[0] = [...poles[0]!] as [number, number];
    out[out.length - 1] = [...poles[n - 1]!] as [number, number];
  } else out[out.length - 1] = out[0]!;
  return out;
}
/** Residual tolerances of a stored solution; the solver converges an order tighter. */
export const sketchTolerance = Object.freeze({
  length: cadTolerance.linearToleranceMm,
  angle: cadTolerance.angularToleranceRad,
});
const solveTolerance = { length: sketchTolerance.length / 10, angle: sketchTolerance.angle / 10 };

/** A refused sketch: the code and the constraint or element (`constraints[i]`, `entities[i]`). */
export class CadSketchError extends Error {
  constructor(
    readonly code: string,
    readonly sketchId: string,
    readonly at?: string,
  ) {
    super(code);
  }
}

// Forward-mode derivatives: a value and its partial derivatives by variable index.
type Grad = Map<number, number> | null;
class D {
  constructor(
    readonly v: number,
    readonly g: Grad,
  ) {}
}
const ZERO = new D(0, null);
function comb(a: D, ca: number, b: D, cb: number, v: number): D {
  if (!a.g && !b.g) return new D(v, null);
  const g = new Map<number, number>();
  if (a.g) for (const [i, d] of a.g) g.set(i, ca * d);
  if (b.g) for (const [i, d] of b.g) g.set(i, (g.get(i) ?? 0) + cb * d);
  return new D(v, g);
}
const add = (a: D, b: D) => comb(a, 1, b, 1, a.v + b.v);
const sub = (a: D, b: D) => comb(a, 1, b, -1, a.v - b.v);
const mul = (a: D, b: D) => comb(a, b.v, b, a.v, a.v * b.v);
const div = (a: D, b: D) => comb(a, 1 / b.v, b, -a.v / (b.v * b.v), a.v / b.v);
const scale = (a: D, k: number) => comb(a, k, ZERO, 0, a.v * k);
const minus = (a: D, k: number) => comb(a, 1, ZERO, 0, a.v - k);
function sqrt(a: D) {
  const v = Math.sqrt(Math.max(0, a.v));
  return comb(a, v > 0 ? 0.5 / v : 0, ZERO, 0, v);
}
const abs = (a: D) => comb(a, a.v < 0 ? -1 : 1, ZERO, 0, Math.abs(a.v));
function atan2(y: D, x: D) {
  const r2 = x.v * x.v + y.v * y.v || 1;
  return comb(y, x.v / r2, x, -y.v / r2, Math.atan2(y.v, x.v));
}
type V = [D, D];
const vsub = (a: V, b: V): V => [sub(a[0], b[0]), sub(a[1], b[1])];
const vmid = (a: V, b: V): V => [scale(add(a[0], b[0]), 0.5), scale(add(a[1], b[1]), 0.5)];
const cross = (a: V, b: V) => sub(mul(a[0], b[1]), mul(a[1], b[0]));
const dot = (a: V, b: V) => add(mul(a[0], b[0]), mul(a[1], b[1]));
const norm = (a: V) => sqrt(dot(a, a));
/** sin or cos of the angle between two directions: a dimensionless (angle-class) residual. */
const unitCross = (a: V, b: V) => div(cross(a, b), mul(norm(a), norm(b)));
const unitDot = (a: V, b: V) => div(dot(a, b), mul(norm(a), norm(b)));
const wrap = (r: number) => r - 2 * Math.PI * Math.round(r / (2 * Math.PI));

type Kind = 'length' | 'angle';
interface Row {
  kind: Kind;
  /** `constraints[i]` or `entities[i]` (an arc's equal radii). */
  at: string;
  vars: number[];
  f: (x: (i: number) => D) => D;
  /** A degenerate way of meeting the row (concentric tangent circles), refused when met. */
  degenerate?: (x: (i: number) => D) => boolean;
}
/** Variables: two per point (u, v), one per circle (radius), in element order. */
interface System {
  vars: Map<string, number>;
  count: number;
  rows: Row[];
}

/** Keys `solved` must have exactly: every point and circle. */
export const sketchSolvedKeys = (s: Pick<CadSketch, 'entities'>) =>
  s.entities.filter((e) => e.type === 'point' || e.type === 'circle').map((e) => e.id);

/**
 * The residual rows of a structurally valid sketch, dimensions resolved with `params`. Throws
 * `sketch-reference` for an element of the wrong kind (validation reports it first).
 */
function system(s: CadSketch, params: ParameterValues): System {
  const vars = new Map<string, number>();
  let count = 0;
  for (const e of s.entities)
    if (e.type === 'point') {
      vars.set(e.id, count);
      count += 2;
    } else if (e.type === 'circle') vars.set(e.id, count++);
  const ents = new Map(s.entities.map((e) => [e.id, e]));
  const bad = (): never => {
    throw new Error('sketch-reference');
  };
  const ent = (id: string, ...types: CadSketchEntity['type'][]) => {
    const e = ents.get(id);
    return e && types.includes(e.type) ? e : bad();
  };
  const pv = (id: string) => (ent(id, 'point'), vars.get(id)!);
  const pt = (id: string) => {
    const i = pv(id);
    return { vars: [i, i + 1], get: (x: (i: number) => D): V => [x(i), x(i + 1)] };
  };
  const line = (id: string) => {
    const l = ent(id, 'line') as Extract<CadSketchEntity, { type: 'line' }>;
    const [a, b] = [pt(l.start), pt(l.end)];
    return {
      e: l,
      vars: [...a.vars, ...b.vars],
      s: a.get,
      t: b.get,
      dir: (x: (i: number) => D) => vsub(b.get(x), a.get(x)),
    };
  };
  const curve = (id: string) => {
    const e = ent(id, 'arc', 'circle') as Extract<CadSketchEntity, { type: 'arc' | 'circle' }>;
    const c = pt(e.center);
    if (e.type === 'circle') {
      const r = vars.get(e.id)!;
      return { e, vars: [...c.vars, r], c: c.get, r: (x: (i: number) => D) => x(r) };
    }
    const st = pt(e.start);
    return {
      e,
      vars: [...c.vars, ...st.vars, ...pt(e.end).vars],
      c: c.get,
      r: (x: (i: number) => D) => norm(vsub(st.get(x), c.get(x))),
    };
  };
  const rows: Row[] = [];
  const push = (
    kind: Kind,
    at: string,
    vs: number[],
    f: Row['f'],
    degenerate?: Row['degenerate'],
  ) => rows.push({ kind, at, vars: [...new Set(vs)], f, ...(degenerate ? { degenerate } : {}) });
  // An arc's equal radii, once per centre and pair of ends: two arcs that complete each other's
  // circle share one equation.
  const intrinsic = new Set<string>();
  s.entities.forEach((e, i) => {
    if (e.type !== 'arc') return;
    const key = JSON.stringify([e.center, ...[e.start, e.end].sort()]);
    if (intrinsic.has(key)) return;
    intrinsic.add(key);
    const [c, a, b] = [pt(e.center), pt(e.start), pt(e.end)];
    push('length', `entities[${i}]`, [...c.vars, ...a.vars, ...b.vars], (x) =>
      sub(norm(vsub(b.get(x), c.get(x))), norm(vsub(a.get(x), c.get(x)))),
    );
  });
  const len = (l: Length) => resolveLength(l, params);
  s.constraints.forEach((k, i) => {
    const at = `constraints[${i}]`;
    switch (k.type) {
      case 'coincident': {
        const [a, b] = [pt(k.a), pt(k.b)];
        for (const j of [0, 1])
          push('length', at, [...a.vars, ...b.vars], (x) => sub(a.get(x)[j], b.get(x)[j]));
        return;
      }
      case 'horizontal':
      case 'vertical': {
        const l = line(k.line);
        const j = k.type === 'horizontal' ? 1 : 0;
        return push('length', at, l.vars, (x) => l.dir(x)[j]);
      }
      case 'parallel':
      case 'perpendicular': {
        const [a, b] = [line(k.a), line(k.b)];
        const f = k.type === 'parallel' ? unitCross : unitDot;
        return push('angle', at, [...a.vars, ...b.vars], (x) => f(a.dir(x), b.dir(x)));
      }
      case 'equal': {
        const first = ent(k.a, 'line', 'arc', 'circle');
        if (first.type === 'line') {
          const [a, b] = [line(k.a), line(k.b)];
          return push('length', at, [...a.vars, ...b.vars], (x) =>
            sub(norm(a.dir(x)), norm(b.dir(x))),
          );
        }
        const [a, b] = [curve(k.a), curve(k.b)];
        return push('length', at, [...a.vars, ...b.vars], (x) => sub(a.r(x), b.r(x)));
      }
      case 'tangent': {
        const [ea, eb] = [ent(k.a, 'line', 'arc', 'circle'), ent(k.b, 'line', 'arc', 'circle')];
        if (ea.type === 'line' && eb.type === 'line') bad();
        const [lid, cid] = eb.type === 'line' ? [k.b, k.a] : [k.a, k.b];
        if (ents.get(lid)!.type === 'line') {
          const [l, c] = [line(lid), curve(cid)];
          const ends = c.e.type === 'arc' ? [c.e.start, c.e.end] : [];
          const shared = [l.e.start, l.e.end].find((p) => ends.includes(p));
          if (shared !== undefined) {
            // At a shared end point the radius there is perpendicular to the line.
            const [p, q] = [pt(shared), pt(shared === l.e.start ? l.e.end : l.e.start)];
            return push('angle', at, [...l.vars, ...c.vars], (x) =>
              unitDot(vsub(c.c(x), p.get(x)), vsub(q.get(x), p.get(x))),
            );
          }
          return push('length', at, [...l.vars, ...c.vars], (x) =>
            sub(abs(div(cross(l.dir(x), vsub(c.c(x), l.s(x))), norm(l.dir(x)))), c.r(x)),
          );
        }
        const [a, b] = [curve(k.a), curve(k.b)];
        const ends = (e: typeof a.e) => (e.type === 'arc' ? [e.start, e.end] : []);
        const shared = ends(a.e).find((p) => ends(b.e).includes(p));
        if (shared !== undefined) {
          // Two arcs meeting at a point: both centres lie on the normal there.
          const p = pt(shared);
          return push('angle', at, [...a.vars, ...b.vars], (x) =>
            unitCross(vsub(a.c(x), p.get(x)), vsub(b.c(x), p.get(x))),
          );
        }
        // Concentric circles of one radius meet `inside` everywhere, never at one point.
        return push(
          'length',
          at,
          [...a.vars, ...b.vars],
          (x) => {
            const d = norm(vsub(b.c(x), a.c(x)));
            const outside = sub(d, add(a.r(x), b.r(x)));
            const inside = sub(d, abs(sub(a.r(x), b.r(x))));
            return Math.abs(outside.v) <= Math.abs(inside.v) ? outside : inside;
          },
          (x) => norm(vsub(b.c(x), a.c(x))).v < cadLimits.minDimensionMm,
        );
      }
      case 'midpoint': {
        const [p, l] = [pt(k.point), line(k.line)];
        for (const j of [0, 1])
          push('length', at, [...p.vars, ...l.vars], (x) =>
            sub(p.get(x)[j], vmid(l.s(x), l.t(x))[j]),
          );
        return;
      }
      case 'pointOnLine': {
        const [p, l] = [pt(k.point), line(k.line)];
        return push('length', at, [...p.vars, ...l.vars], (x) =>
          div(cross(l.dir(x), vsub(p.get(x), l.s(x))), norm(l.dir(x))),
        );
      }
      case 'pointOnCurve': {
        const [p, c] = [pt(k.point), curve(k.curve)];
        return push('length', at, [...p.vars, ...c.vars], (x) =>
          sub(norm(vsub(p.get(x), c.c(x))), c.r(x)),
        );
      }
      case 'symmetric': {
        const [a, b, l] = [pt(k.a), pt(k.b), line(k.line)];
        const vs = [...a.vars, ...b.vars, ...l.vars];
        push('length', at, vs, (x) =>
          div(cross(l.dir(x), vsub(vmid(a.get(x), b.get(x)), l.s(x))), norm(l.dir(x))),
        );
        return push('length', at, vs, (x) =>
          div(dot(vsub(b.get(x), a.get(x)), l.dir(x)), norm(l.dir(x))),
        );
      }
      case 'fix': {
        const p = pt(k.point);
        const target = [len(k.at[0]), len(k.at[1])];
        for (const j of [0, 1]) push('length', at, p.vars, (x) => minus(p.get(x)[j], target[j]));
        return;
      }
      case 'distance':
      case 'horizontalDistance':
      case 'verticalDistance': {
        const [a, b] = [pt(k.a), pt(k.b)];
        const v = len(k.value);
        const j = k.type === 'horizontalDistance' ? 0 : 1;
        return push('length', at, [...a.vars, ...b.vars], (x) => {
          const d = vsub(b.get(x), a.get(x));
          return minus(k.type === 'distance' ? norm(d) : abs(d[j]), v);
        });
      }
      case 'pointLineDistance': {
        const [p, l] = [pt(k.point), line(k.line)];
        const v = len(k.value);
        return push('length', at, [...p.vars, ...l.vars], (x) =>
          minus(abs(div(cross(l.dir(x), vsub(p.get(x), l.s(x))), norm(l.dir(x)))), v),
        );
      }
      case 'angle': {
        const [a, b] = [line(k.a), line(k.b)];
        const v = resolveAngle(k.value, params);
        return push('angle', at, [...a.vars, ...b.vars], (x) => {
          const t = atan2(cross(a.dir(x), b.dir(x)), dot(a.dir(x), b.dir(x)));
          return minus(t, t.v - wrap(t.v - v));
        });
      }
      case 'radius':
      case 'diameter': {
        const c = curve(k.curve);
        const v = len(k.value);
        return push('length', at, c.vars, (x) =>
          minus(k.type === 'radius' ? c.r(x) : scale(c.r(x), 2), v),
        );
      }
    }
  });
  return { vars, count, rows };
}

/** Flat variable values from `solved`; throws `sketch-solution-mismatch` on a missing key. */
function initial(s: CadSketch, sys: System): number[] {
  const x = new Array<number>(sys.count).fill(0);
  for (const [id, i] of sys.vars) {
    const v = Object.hasOwn(s.solved, id) ? s.solved[id] : undefined;
    if (!v) throw new CadSketchError('sketch-solution-mismatch', s.id, `solved.${id}`);
    x[i] = v[0];
    if (s.entities.find((e) => e.id === id)!.type === 'point') x[i + 1] = v[1];
  }
  return x;
}
function store(s: CadSketch, sys: System, x: number[]): Record<string, [number, number]> {
  const solved: Record<string, [number, number]> = {};
  for (const e of s.entities) {
    const i = sys.vars.get(e.id);
    if (i === undefined) continue;
    // −0 and 0 are one coordinate: the stored source stays canonical.
    const c = (n: number) => (Object.is(n, -0) ? 0 : n);
    solved[e.id] = e.type === 'point' ? [c(x[i]), c(x[i + 1])] : [c(x[i]), 0];
  }
  return solved;
}

/**
 * Rows whose residual at the stored coordinates exceeds the stored-solution tolerance
 * (docs/cad/r1-modeling.md, 保存座標の検証). The sketch is never solved here.
 */
export function sketchMismatches(s: CadSketch, params: ParameterValues): string[] {
  const sys = system(s, params);
  const x = initial(s, sys);
  const at = new Set<string>();
  for (const r of sys.rows) {
    const value = (i: number) => new D(x[i], null);
    const v = r.f(value).v;
    if (!(Math.abs(v) <= sketchTolerance[r.kind]) || r.degenerate?.(value)) at.add(r.at);
  }
  return [...at];
}

/** Union-find components of the rows: each is solved and ranked on its own. */
function components(sys: System) {
  const parent = [...Array(sys.count).keys()];
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const r of sys.rows) for (const v of r.vars.slice(1)) parent[root(v)] = root(r.vars[0]);
  const groups = new Map<number, { vars: Set<number>; rows: Row[] }>();
  for (const r of sys.rows) {
    const g = groups.get(root(r.vars[0])) ?? { vars: new Set(), rows: [] };
    for (const v of r.vars) g.vars.add(v);
    g.rows.push(r);
    groups.set(root(r.vars[0]), g);
  }
  return [...groups.values()].map((g) => ({
    vars: [...g.vars].sort((a, b) => a - b),
    rows: g.rows,
  }));
}

function evaluate(rows: Row[], cols: number[], x: number[], jacobian: boolean) {
  const col = new Map(cols.map((v, j) => [v, j]));
  const r = new Float64Array(rows.length);
  const J = jacobian ? new Float64Array(rows.length * cols.length) : undefined;
  rows.forEach((row, i) => {
    const d = row.f((v) => new D(x[v], jacobian ? new Map([[v, 1]]) : null));
    r[i] = d.v;
    if (J && d.g) for (const [v, g] of d.g) J[i * cols.length + col.get(v)!] += g;
  });
  return { r, J };
}
const converged = (rows: Row[], r: Float64Array) =>
  rows.every((row, i) => Math.abs(r[i]) <= solveTolerance[row.kind]);

/** Cholesky solve of the symmetric positive definite `A` (n×n); `undefined` if it is not. */
function cholesky(A: Float64Array, b: Float64Array, n: number): Float64Array | undefined {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * y[k];
    y[i] = s / L[i * n + i];
  }
  return y;
}

/**
 * Levenberg–Marquardt from `x` over one component, at most `cadSketchLimits.iterations` steps
 * (accepted or not). Updates `x` in place; returns whether every row met the solve tolerance.
 */
function levenbergMarquardt(rows: Row[], cols: number[], x: number[]): boolean {
  const n = cols.length;
  const m = rows.length;
  let { r, J } = evaluate(rows, cols, x, true);
  let cost = r.reduce((a, v) => a + v * v, 0);
  let lambda = -1;
  for (let it = 0; it < cadSketchLimits.iterations; it++) {
    if (converged(rows, r)) return true;
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++)
      for (let a = 0; a < n; a++) {
        const ja = J![i * n + a];
        if (!ja) continue;
        g[a] -= ja * r[i];
        for (let b = 0; b <= a; b++) A[a * n + b] += ja * J![i * n + b];
      }
    let maxDiag = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) A[b * n + a] = A[a * n + b];
      maxDiag = Math.max(maxDiag, A[a * n + a]);
    }
    // Levenberg damping (λI) keeps the step short in directions the constraints leave free, so
    // an under-constrained sketch moves as little as it must; the floor keeps A definite.
    if (lambda < 0) lambda = 1e-3 * (maxDiag || 1);
    const damp = Math.max(lambda, 1e-10 * (maxDiag || 1));
    for (let a = 0; a < n; a++) A[a * n + a] += damp;
    const step = cholesky(A, g, n);
    if (!step) {
      lambda *= 10;
      continue;
    }
    const trial = [...x];
    cols.forEach((v, j) => (trial[v] += step[j]));
    const next = evaluate(rows, cols, trial, true);
    const nextCost = next.r.reduce((a, v) => a + v * v, 0);
    if (nextCost < cost || converged(rows, next.r)) {
      cols.forEach((v) => (x[v] = trial[v]));
      ({ r, J } = next);
      cost = nextCost;
      lambda = Math.max(lambda / 3, 1e-300);
    } else lambda *= 4;
  }
  return converged(rows, r);
}

/**
 * Rank of the rows' Jacobian by modified Gram–Schmidt over normalized rows, in row order: the
 * first row that adds no direction names the redundant constraint.
 */
function rank(rows: Row[], J: Float64Array, n: number): { rank: number; dependent?: string } {
  const basis: Float64Array[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = J.slice(i * n, (i + 1) * n);
    const length = Math.hypot(...v);
    if (length > 0) for (let a = 0; a < n; a++) v[a] /= length;
    for (let pass = 0; pass < 2 && length > 0; pass++)
      for (const q of basis) {
        let d = 0;
        for (let a = 0; a < n; a++) d += v[a] * q[a];
        for (let a = 0; a < n; a++) v[a] -= d * q[a];
      }
    const rest = length > 0 ? Math.hypot(...v) : 0;
    if (rest < 1e-8) return { rank: basis.length, dependent: rows[i].at };
    for (let a = 0; a < n; a++) v[a] /= rest;
    basis.push(v);
  }
  return { rank: basis.length };
}

export interface SketchSolution {
  solved: Record<string, [number, number]>;
  /** Degrees of freedom left (0 is fully constrained). */
  dof: number;
}
/**
 * Solves a structurally valid sketch from its current `solved` (docs/cad/r1-modeling.md, Solver).
 * Refuses with `CadSketchError`: `sketch-redundant-constraint` (satisfied but adds nothing),
 * `sketch-conflicting-constraint` (cannot be met with the others), `sketch-not-converged` or
 * `sketch-degenerate` (met only degenerately: concentric tangent circles), each naming the
 * constraint (`at`).
 */
export function solveSketch(s: CadSketch, params: ParameterValues): SketchSolution {
  let sys: System;
  try {
    sys = system(s, params);
  } catch (e) {
    throw new CadSketchError(e instanceof Error ? e.message : 'sketch-reference', s.id);
  }
  const x = initial(s, sys);
  let dof = sys.count;
  for (const c of components(sys)) {
    const ok = levenbergMarquardt(c.rows, c.vars, x);
    const { r, J } = evaluate(c.rows, c.vars, x, true);
    const ranked = rank(c.rows, J!, c.vars.length);
    if (ranked.dependent)
      throw new CadSketchError(
        ok ? 'sketch-redundant-constraint' : 'sketch-conflicting-constraint',
        s.id,
        ranked.dependent,
      );
    if (!ok) {
      let worst = 0;
      c.rows.forEach((row, i) => {
        const w = c.rows[worst];
        if (Math.abs(r[i]) / solveTolerance[row.kind] > Math.abs(r[worst]) / solveTolerance[w.kind])
          worst = i;
      });
      throw new CadSketchError('sketch-not-converged', s.id, c.rows[worst].at);
    }
    const value = (i: number) => new D(x[i], null);
    const degenerate = c.rows.find((row) => row.degenerate?.(value));
    if (degenerate) throw new CadSketchError('sketch-degenerate', s.id, degenerate.at);
    dof -= ranked.rank;
  }
  if (x.some((v) => !(Math.abs(v) <= cadLimits.coordinateMm)))
    throw new CadSketchError('coordinate-range', s.id);
  return { solved: store(s, sys, x), dof };
}
/** Degrees of freedom at the stored coordinates, and the first redundant row if any. */
export function sketchFreedom(
  s: CadSketch,
  params: ParameterValues,
): { dof: number; dependent?: string } {
  const sys = system(s, params);
  const x = initial(s, sys);
  let dof = sys.count;
  for (const c of components(sys)) {
    const ranked = rank(c.rows, evaluate(c.rows, c.vars, x, true).J!, c.vars.length);
    if (ranked.dependent) return { dof: dof - ranked.rank, dependent: ranked.dependent };
    dof -= ranked.rank;
  }
  return { dof };
}

// Regions: exact element intersection and winding over the stored coordinates.
type Pt = [number, number];
type Element =
  | { type: 'line'; id: string; ends: [string, string]; a: Pt; b: Pt }
  | {
      type: 'arc';
      id: string;
      ends: [string, string];
      c: Pt;
      r: number;
      start: number;
      /** Signed sweep from `start`, counter-clockwise positive, 0 < |sweep| < 2π. */
      sweep: number;
      a: Pt;
      b: Pt;
    }
  | { type: 'circle'; id: string; ends: []; c: Pt; r: number }
  | {
      type: 'spline';
      id: string;
      ends: [string, string];
      degree: number;
      poles: Pt[];
      /** The sampled polygon from `a` to `b` (splinePoints). */
      pts: Pt[];
      a: Pt;
      b: Pt;
    }
  /** A periodic spline: a loop by itself, as a circle is. */
  | { type: 'closedSpline'; id: string; ends: []; degree: number; poles: Pt[]; pts: Pt[] };
/** Elements that form a loop alone: they have no end points. */
type LoopElement = Extract<Element, { type: 'circle' | 'closedSpline' }>;
type ChainElement = Exclude<Element, LoopElement>;
const loopAlone = (e: Element): e is LoopElement =>
  e.type === 'circle' || e.type === 'closedSpline';
const eps: number = cadTolerance.linearToleranceMm;
const at = (c: Pt, r: number, t: number): Pt => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const turn = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** The element's geometry from `solved`, or `undefined` for a point or a missing element. */
export function sketchElement(s: CadSketch, id: string): Element | undefined {
  const e = s.entities.find((x) => x.id === id);
  const p = (pid: string): Pt => s.solved[pid] as Pt;
  if (!e || e.type === 'point') return;
  if (e.type === 'line')
    return { type: 'line', id, ends: [e.start, e.end], a: p(e.start), b: p(e.end) };
  if (e.type === 'circle')
    return { type: 'circle', id, ends: [], c: p(e.center), r: s.solved[e.id][0] };
  if (e.type === 'spline') {
    const poles = e.poles.map(p);
    const pts = splinePoints(poles, e.degree, !!e.closed);
    if (e.closed) return { type: 'closedSpline', id, ends: [], degree: e.degree, poles, pts };
    const ends: [string, string] = [e.poles[0]!, e.poles[e.poles.length - 1]!];
    return { type: 'spline', id, ends, degree: e.degree, poles, pts, a: pts[0]!, b: pts.at(-1)! };
  }
  const [c, a, b] = [p(e.center), p(e.start), p(e.end)];
  const start = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const end = Math.atan2(b[1] - c[1], b[0] - c[0]);
  const sweep = e.clockwise ? -turn(start - end) : turn(end - start);
  return { type: 'arc', id, ends: [e.start, e.end], c, r: dist(a, c), start, sweep, a, b };
}
function onArc(e: Element, p: Pt, tol = eps): boolean {
  if (e.type !== 'arc') return true;
  const t = turn((Math.atan2(p[1] - e.c[1], p[0] - e.c[0]) - e.start) * Math.sign(e.sweep));
  const slack = tol / e.r;
  return t <= Math.abs(e.sweep) + slack || t >= 2 * Math.PI - slack;
}
/** Distance from `p` to the segment `a`–`b`. */
function segmentDistance(a: Pt, b: Pt, p: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}
/**
 * A polygon along the element: exact for a line, sampled for curves (65 points per arc, 129 per
 * circle, a spline's polygon from `splinePoints`).
 */
export function sketchElementPoints(e: Element): Pt[] {
  if (e.type === 'line') return [e.a, e.b];
  if (e.type === 'spline' || e.type === 'closedSpline') return e.pts;
  if (e.type === 'arc')
    return Array.from({ length: 65 }, (_, i) => at(e.c, e.r, e.start + (e.sweep * i) / 64));
  return Array.from({ length: 129 }, (_, i) => at(e.c, e.r, (2 * Math.PI * i) / 128));
}
function distanceTo(e: Element, p: Pt): number {
  if (e.type === 'spline' || e.type === 'closedSpline') {
    let d = Infinity;
    for (let i = 1; i < e.pts.length; i++)
      d = Math.min(d, segmentDistance(e.pts[i - 1]!, e.pts[i]!, p));
    return d;
  }
  if (e.type === 'line') {
    const [dx, dy] = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return dist(p, [e.a[0] + t * dx, e.a[1] + t * dy]);
  }
  if (onArc(e, p, 0)) return Math.abs(dist(p, e.c) - e.r);
  return e.type === 'arc' ? Math.min(dist(p, e.a), dist(p, e.b)) : Math.abs(dist(p, e.c) - e.r);
}
/** Points where two elements meet, or `'overlap'` when they share a stretch of boundary. */
function meets(x: Element, y: Element): Pt[] | 'overlap' {
  if ([x, y].some((z) => z.type === 'spline' || z.type === 'closedSpline'))
    return polygonMeets(x, y);
  type Exact = Extract<Element, { type: 'line' | 'arc' | 'circle' }>;
  const [e, f] = [x as Exact, y as Exact];
  const out: Pt[] = [];
  const ends = (z: Exact): Pt[] => (z.type === 'circle' ? [] : [z.a, z.b]);
  for (const p of ends(e)) if (distanceTo(f, p) <= eps) out.push(p);
  for (const p of ends(f)) if (distanceTo(e, p) <= eps) out.push(p);
  if (e.type === 'line' && f.type === 'line') {
    const d1: Pt = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    const d2: Pt = [f.b[0] - f.a[0], f.b[1] - f.a[1]];
    const w: Pt = [f.a[0] - e.a[0], f.a[1] - e.a[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    const l1 = Math.hypot(...d1);
    if (Math.abs(den) <= 1e-12 * l1 * Math.hypot(...d2)) {
      // Parallel: overlapping when collinear and the projections share more than a point.
      if (Math.abs(d1[0] * w[1] - d1[1] * w[0]) / l1 > eps) return out;
      const proj = (p: Pt) => ((p[0] - e.a[0]) * d1[0] + (p[1] - e.a[1]) * d1[1]) / l1;
      const [u, v] = [proj(f.a), proj(f.b)].sort((a, b) => a - b);
      return Math.min(l1, v) - Math.max(0, u) > eps ? 'overlap' : out;
    }
    const t = (w[0] * d2[1] - w[1] * d2[0]) / den;
    const u = (w[0] * d1[1] - w[1] * d1[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push([e.a[0] + t * d1[0], e.a[1] + t * d1[1]]);
    return out;
  }
  if (e.type === 'line' || f.type === 'line') {
    const [l, c] = (e.type === 'line' ? [e, f] : [f, e]) as [
      Extract<Exact, { type: 'line' }>,
      Exclude<Exact, { type: 'line' }>,
    ];
    const d: Pt = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
    const L = Math.hypot(...d);
    const u: Pt = [d[0] / L, d[1] / L];
    const t0 = (c.c[0] - l.a[0]) * u[0] + (c.c[1] - l.a[1]) * u[1];
    const foot: Pt = [l.a[0] + t0 * u[0], l.a[1] + t0 * u[1]];
    const h = dist(foot, c.c);
    if (h > c.r + eps) return out;
    const half = Math.sqrt(Math.max(0, c.r * c.r - h * h));
    for (const t of [t0 - half, t0 + half])
      if (t >= 0 && t <= L) {
        const p: Pt = [l.a[0] + t * u[0], l.a[1] + t * u[1]];
        if (onArc(c, p)) out.push(p);
      }
    return out;
  }
  const [a, b] = [e, f] as Exclude<Exact, { type: 'line' }>[];
  const d = dist(a.c, b.c);
  if (d <= eps && Math.abs(a.r - b.r) <= eps) {
    // The same circle: overlapping unless the arcs only touch at end points.
    if (a.type === 'circle' || b.type === 'circle') return 'overlap';
    const within = (x: typeof a, p: Pt) => {
      if (x.type !== 'arc') return true;
      const t = turn((Math.atan2(p[1] - x.c[1], p[0] - x.c[0]) - x.start) * Math.sign(x.sweep));
      return t > eps / x.r && t < Math.abs(x.sweep) - eps / x.r;
    };
    const inner = (x: typeof a, y: typeof a & { type: 'arc' }) =>
      within(x, at(y.c, y.r, y.start + y.sweep / 2)) || within(x, y.a) || within(x, y.b);
    return inner(a, b) || inner(b, a) ? 'overlap' : out;
  }
  if (d > a.r + b.r + eps || d < Math.abs(a.r - b.r) - eps || d <= eps) return out;
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const ux = (b.c[0] - a.c[0]) / d;
  const uy = (b.c[1] - a.c[1]) / d;
  const base: Pt = [a.c[0] + along * ux, a.c[1] + along * uy];
  for (const sign of [-1, 1]) {
    const p: Pt = [base[0] - sign * h * uy, base[1] + sign * h * ux];
    if (onArc(a, p) && onArc(b, p)) out.push(p);
  }
  return out;
}

/** Where segments `a`–`b` and `c`–`d` cross or touch (within `eps`), or undefined. */
function segmentHit(a: Pt, b: Pt, c: Pt, d: Pt): Pt | undefined {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const q: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  const w: Pt = [c[0] - a[0], c[1] - a[1]];
  if (Math.abs(den) > 1e-12 * Math.hypot(...r) * Math.hypot(...q)) {
    const t = (w[0] * q[1] - w[1] * q[0]) / den;
    const u = (w[0] * r[1] - w[1] * r[0]) / den;
    const [lt, lu] = [eps / (Math.hypot(...r) || 1), eps / (Math.hypot(...q) || 1)];
    if (t >= -lt && t <= 1 + lt && u >= -lu && u <= 1 + lu)
      return [a[0] + t * r[0], a[1] + t * r[1]];
  }
  // Parallel or nearly: touching where an end lies on the other segment.
  for (const [p, x, y] of [
    [a, c, d],
    [b, c, d],
    [c, a, b],
    [d, a, b],
  ] as const)
    if (segmentDistance(x, y, p) <= eps) return p;
  return undefined;
}
const box = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    Math.min(...xs) - eps,
    Math.min(...ys) - eps,
    Math.max(...xs) + eps,
    Math.max(...ys) + eps,
  ];
};
const boxesMeet = (a: number[], b: number[]) =>
  a[0]! <= b[2]! && b[0]! <= a[2]! && a[1]! <= b[3]! && b[1]! <= a[3]!;
/**
 * Where two elements meet when one is a spline, on their polygons (docs/cad/r2a-freeform.md:
 * the sampled polygon decides). Where two ends coincide the shared end is reported, and the two
 * segments there meet anywhere else only when they run on from it in one direction (an overlap,
 * reported at the nearer of their other ends), so a joint is one point however the polygons turn.
 */
function polygonMeets(e: Element, f: Element): Pt[] {
  const [pe, pf] = [sketchElementPoints(e), sketchElementPoints(f)];
  if (!boxesMeet(box(pe), box(pf))) return [];
  const out: Pt[] = [];
  const endsOf = (x: Element, pts: Pt[]) =>
    loopAlone(x)
      ? []
      : [
          { p: pts[0]!, seg: 0, next: pts[1]! },
          { p: pts.at(-1)!, seg: pts.length - 2, next: pts.at(-2)! },
        ];
  const joints: { se: number; sf: number }[] = [];
  for (const x of endsOf(e, pe))
    for (const y of endsOf(f, pf))
      if (dist(x.p, y.p) <= eps) {
        out.push(x.p);
        joints.push({ se: x.seg, sf: y.seg });
        const fold = foldsBack(x.p, x.next, y.next);
        if (fold) out.push(fold);
      }
  for (let i = 1; i < pe.length; i++) {
    const sb = box([pe[i - 1]!, pe[i]!]);
    for (let j = 1; j < pf.length; j++) {
      if (joints.some((k) => k.se === i - 1 && k.sf === j - 1)) continue;
      if (!boxesMeet(sb, box([pf[j - 1]!, pf[j]!]))) continue;
      const hit = segmentHit(pe[i - 1]!, pe[i]!, pf[j - 1]!, pf[j]!);
      if (hit) out.push(hit);
    }
  }
  return out;
}
/**
 * Where two segments from a shared point `s` to `a` and to `b` meet beyond it: only when they
 * run on from it in one direction (an overlap), at the nearer of `a` and `b`.
 */
function foldsBack(s: Pt, a: Pt, b: Pt): Pt | undefined {
  const [u, v]: Pt[] = [
    [a[0] - s[0], a[1] - s[1]],
    [b[0] - s[0], b[1] - s[1]],
  ];
  const [lu, lv] = [Math.hypot(...u), Math.hypot(...v)];
  const cross = u[0] * v[1] - u[1] * v[0];
  if (u[0] * v[0] + u[1] * v[1] > 0 && Math.abs(cross) <= eps * Math.max(lu, lv))
    return lu < lv ? a : b;
  return undefined;
}
/**
 * Whether a spline's own polygon crosses or touches itself: segments apart meet nowhere, and
 * neighbouring ones (the last and first too, when closed) do not fold back over each other.
 */
export function splineSelfIntersects(e: Element): boolean {
  if (e.type !== 'spline' && e.type !== 'closedSpline') return false;
  const p = e.pts;
  const last = p.length - 2;
  for (let i = 1; i <= last; i++) if (foldsBack(p[i]!, p[i - 1]!, p[i + 1]!)) return true;
  if (e.type === 'closedSpline' && foldsBack(p[0]!, p[last]!, p[1]!)) return true;
  for (let i = 0; i <= last; i++) {
    const sb = box([p[i]!, p[i + 1]!]);
    for (let j = i + 2; j <= last; j++) {
      if (e.type === 'closedSpline' && i === 0 && j === last) continue;
      if (boxesMeet(sb, box([p[j]!, p[j + 1]!])) && segmentHit(p[i]!, p[i + 1]!, p[j]!, p[j + 1]!))
        return true;
    }
  }
  return false;
}

interface Loop {
  elements: Element[];
  /** Traversal direction of each element along the loop. */
  forward: boolean[];
}
/** Winding number of a loop around `p` (not on the loop). */
function winding(loop: Loop, p: Pt): number {
  if (loop.elements.length === 1 && loop.elements[0].type === 'circle') {
    const c = loop.elements[0];
    return dist(p, c.c) < c.r ? 1 : 0;
  }
  const chordAngle = (a: Pt, b: Pt) => {
    const [ax, ay, bx, by] = [a[0] - p[0], a[1] - p[1], b[0] - p[0], b[1] - p[1]];
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  };
  let total = 0;
  loop.elements.forEach((e, i) => {
    if (e.type === 'circle') return;
    if (e.type === 'spline' || e.type === 'closedSpline') {
      const pts = loop.forward[i] ? e.pts : [...e.pts].reverse();
      for (let k = 1; k < pts.length; k++) total += chordAngle(pts[k - 1]!, pts[k]!);
      return;
    }
    const [a, b] = loop.forward[i] ? [e.a, e.b] : [e.b, e.a];
    const [ax, ay, bx, by] = [a[0] - p[0], a[1] - p[1], b[0] - p[0], b[1] - p[1]];
    const chord = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (e.type !== 'arc') {
      total += chord;
      return;
    }
    // Arc = chord + a full turn when p lies between them (docs: the arc's circular segment).
    const sweep = loop.forward[i] ? e.sweep : -e.sweep;
    const m = at(e.c, e.r, e.start + e.sweep / 2);
    const side = (q: Pt) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    const inside = dist(p, e.c) < e.r;
    // On the chord itself (inside the circle, so between its ends) the arc turns half way round.
    if (inside && side(p) === 0) total += Math.sign(sweep) * Math.PI;
    else if (inside && Math.sign(side(p)) === Math.sign(side(m)))
      total += chord + Math.sign(sweep) * 2 * Math.PI;
    else total += chord;
  });
  return Math.round(total / (2 * Math.PI));
}
const samplePoint = (e: Element): Pt =>
  e.type === 'line'
    ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
    : e.type === 'arc'
      ? at(e.c, e.r, e.start + e.sweep / 2)
      : e.type === 'circle'
        ? [e.c[0] + e.r, e.c[1]]
        : e.pts[Math.floor(e.pts.length / 2)]!;

export interface SketchRegionGeometry {
  loops: { elements: Element[]; forward: boolean[] }[];
}
/**
 * Checks a region against a sketch whose `solved` is valid: element kinds, closed chains joined
 * by shared point IDs, no crossing, touching or shared stretch between any two elements except at
 * the shared end points of a chain, every hole inside the outer loop and outside the other holes.
 * Returns the loops, or the first problem as `{ code, path }` relative to the region.
 */
export function sketchRegion(
  s: CadSketch,
  region: CadSketchRegion,
): SketchRegionGeometry | { code: string; path: string } {
  const used = new Set<string>();
  const loops: Loop[] = [];
  const lists = [region.outer, ...region.holes];
  for (const [li, ids] of lists.entries()) {
    const lp = li === 0 ? 'outer' : `holes[${li - 1}]`;
    if (!Array.isArray(ids) || !ids.length) return { code: 'region-loop', path: lp };
    const elements: Element[] = [];
    for (const [i, id] of ids.entries()) {
      const e = s.entities.find((x) => x.id === id);
      if (!e || e.type === 'point' || e.construction || used.has(id))
        return { code: 'region-element', path: `${lp}[${i}]` };
      used.add(id);
      elements.push(sketchElement(s, id)!);
    }
    if (elements.some(loopAlone)) {
      if (elements.length !== 1) return { code: 'region-open', path: lp };
      loops.push({ elements, forward: [true] });
      continue;
    }
    // Walk the chain: each element starts where the last ended and the loop returns to its start.
    if (elements.length === 1) return { code: 'region-open', path: lp };
    const first = elements[0] as ChainElement;
    const next = elements[1] as ChainElement;
    const forward = [first.ends[1] === next.ends[0] || first.ends[1] === next.ends[1]];
    const origin = forward[0] ? first.ends[0] : first.ends[1];
    let end = forward[0] ? first.ends[1] : first.ends[0];
    const seen = new Set([origin]);
    for (let i = 1; i < elements.length; i++) {
      const e = elements[i] as ChainElement;
      const f = e.ends[0] === end;
      if (!f && e.ends[1] !== end) return { code: 'region-open', path: `${lp}[${i}]` };
      forward.push(f);
      if (seen.has(end)) return { code: 'region-self-intersection', path: `${lp}[${i}]` };
      seen.add(end);
      end = f ? e.ends[1] : e.ends[0];
    }
    if (end !== origin) return { code: 'region-open', path: lp };
    loops.push({ elements, forward });
  }
  const all = loops.flatMap((l, li) => l.elements.map((e, i) => ({ e, li, i })));
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const [x, y] = [all[i], all[j]];
      const hit = meets(x.e, y.e);
      const path = `${x.li === 0 ? 'outer' : `holes[${x.li - 1}]`}[${x.i}]`;
      // Only neighbours in one chain may meet, at the point they share; loops never touch.
      const shared =
        x.li === y.li
          ? (x.e.ends as string[])
              .filter((p) => (y.e.ends as string[]).includes(p))
              .map((p) => s.solved[p] as Pt)
          : [];
      if (hit === 'overlap' || hit.some((p) => !shared.some((q) => dist(p, q) <= eps)))
        return { code: x.li === y.li ? 'region-self-intersection' : 'region-overlap', path };
    }
  for (let h = 1; h < loops.length; h++) {
    const p = samplePoint(loops[h].elements[0]);
    if (!winding(loops[0], p)) return { code: 'region-hole-outside', path: `holes[${h - 1}]` };
    for (let k = 1; k < loops.length; k++)
      if (k !== h && winding(loops[k], p))
        return { code: 'region-hole-nested', path: `holes[${h - 1}]` };
  }
  return { loops };
}
/**
 * Signed area of a loop, counter-clockwise positive: the polygon of its end points plus, for each
 * arc, the circular segment between its chord and the arc (r²/2 · (θ − sin θ), θ its signed sweep
 * along the loop).
 */
export function loopArea(loop: SketchRegionGeometry['loops'][number]): number {
  const [only] = loop.elements;
  if (loop.elements.length === 1 && only?.type === 'circle') return Math.PI * only.r * only.r;
  let total = 0;
  loop.elements.forEach((e, i) => {
    if (e.type === 'circle') return;
    if (e.type === 'spline' || e.type === 'closedSpline') {
      // A spline's polygon (an approximation; the kernel measures the exact face).
      const pts = loop.forward[i] ? e.pts : [...e.pts].reverse();
      for (let k = 1; k < pts.length; k++)
        total += (pts[k - 1]![0] * pts[k]![1] - pts[k - 1]![1] * pts[k]![0]) / 2;
      return;
    }
    const [a, b] = loop.forward[i] ? [e.a, e.b] : [e.b, e.a];
    total += (a[0] * b[1] - a[1] * b[0]) / 2;
    if (e.type === 'arc') {
      const t = loop.forward[i] ? e.sweep : -e.sweep;
      total += ((e.r * e.r) / 2) * (t - Math.sin(t));
    }
  });
  return total;
}
/** The region's area: its outer loop less its holes. */
export const regionArea = (g: SketchRegionGeometry) =>
  g.loops.reduce((a, l, i) => a + (i ? -1 : 1) * Math.abs(loopArea(l)), 0);
/** The elements that join end to end (lines, arcs and open splines), not construction ones. */
function chainEdges(s: CadSketch): { id: string; start: string; end: string }[] {
  return s.entities.flatMap((e) => {
    if (e.type === 'point' || e.construction) return [];
    if (e.type === 'line' || e.type === 'arc') return [{ id: e.id, start: e.start, end: e.end }];
    if (e.type === 'spline' && !e.closed)
      return [{ id: e.id, start: e.poles[0]!, end: e.poles.at(-1)! }];
    return [];
  });
}
/**
 * The region a sketch's drawing closes, for sweeping it from Sketch mode: its closed loops
 * (chains of lines, arcs and open splines joined end to end at shared point IDs, with no branch,
 * and circles and closed splines),
 * the largest as the outer loop and those that fit inside it as holes. Construction elements are
 * left out. Undefined when no loop closes.
 */
export function sketchDefaultRegion(s: CadSketch): CadSketchRegion | undefined {
  const edges = chainEdges(s);
  const at = new Map<string, string[]>();
  for (const e of edges) for (const p of [e.start, e.end]) at.set(p, [...(at.get(p) ?? []), e.id]);
  const byId = new Map(edges.map((e) => [e.id, e]));
  const used = new Set<string>();
  const loops: string[][] = [];
  for (const first of edges) {
    if (used.has(first.id)) continue;
    const chain = [first.id];
    let point = first.end;
    let closed = false;
    for (;;) {
      if (point === first.start) {
        closed = true;
        break;
      }
      const next = (at.get(point) ?? []).filter((id) => id !== chain[chain.length - 1]);
      if (next.length !== 1 || chain.includes(next[0]!)) break;
      const e = byId.get(next[0]!)!;
      chain.push(e.id);
      point = e.start === point ? e.end : e.start;
    }
    if (closed && chain.every((id) => at.get(byId.get(id)!.start)!.length === 2)) {
      for (const id of chain) used.add(id);
      loops.push(chain);
    }
  }
  for (const e of s.entities)
    if ((e.type === 'circle' || (e.type === 'spline' && e.closed)) && !e.construction)
      loops.push([e.id]);
  const area = (loop: string[]) => {
    const g = sketchRegion(s, { outer: loop, holes: [] });
    return 'code' in g ? undefined : Math.abs(loopArea(g.loops[0]!));
  };
  const sized = loops.flatMap((l) => {
    const a = area(l);
    return a === undefined ? [] : [{ l, a }];
  });
  if (!sized.length) return undefined;
  sized.sort((x, y) => y.a - x.a);
  const outer = sized[0]!.l;
  const holes: string[][] = [];
  for (const { l } of sized.slice(1))
    if (!('code' in sketchRegion(s, { outer, holes: [...holes, l] }))) holes.push(l);
  return { outer, holes };
}
/** A sweep's path in order: each element and whether it runs from its start to its end. */
export interface SketchPathGeometry {
  elements: ChainElement[];
  forward: boolean[];
  /** The last element ends where the first starts (only when `closed` was allowed). */
  closed: boolean;
}
/**
 * Checks a sweep's path against a sketch whose `solved` is valid (docs/cad/r1-modeling.md,
 * Loft・sweep): lines and arcs (construction ones too), each once, every one starting where the
 * last ended, open, and never meeting itself except where neighbours join. A surface feature's
 * chain (docs/cad/r2a-freeform.md) may also be closed when `closed` is `'allow'`; then the last
 * and first elements join too. Returns the chain, or the first problem as `{ code, path }`
 * relative to the element list.
 */
export function sketchPath(
  s: CadSketch,
  ids: string[],
  closed: 'allow' | 'refuse' = 'refuse',
): SketchPathGeometry | { code: string; path: string } {
  const elements: ChainElement[] = [];
  for (const [i, id] of ids.entries()) {
    const e = sketchElement(s, id);
    if (!e || loopAlone(e) || elements.some((x) => x.id === id))
      return { code: 'sweep-path-element', path: `[${i}]` };
    elements.push(e);
  }
  if (!elements.length) return { code: 'sweep-path-element', path: '' };
  const forward: boolean[] = [];
  const second = elements[1];
  forward.push(!second || second.ends.includes(elements[0]!.ends[1]));
  const origin = forward[0] ? elements[0]!.ends[0] : elements[0]!.ends[1];
  let end = forward[0] ? elements[0]!.ends[1] : elements[0]!.ends[0];
  for (let i = 1; i < elements.length; i++) {
    const e = elements[i]!;
    const f = e.ends[0] === end;
    if (!f && e.ends[1] !== end) return { code: 'sweep-path-gap', path: `[${i}]` };
    forward.push(f);
    end = f ? e.ends[1] : e.ends[0];
  }
  const loop = end === origin;
  if (loop && (closed === 'refuse' || elements.length < 2))
    return { code: 'sweep-path-closed', path: '' };
  for (let i = 0; i < elements.length; i++)
    for (let j = i + 1; j < elements.length; j++) {
      const hit = meets(elements[i]!, elements[j]!);
      // Neighbours meet where they join (in a loop the last joins the first); nothing else meets.
      const joint = [
        ...(j === i + 1
          ? [s.solved[forward[i] ? elements[i]!.ends[1] : elements[i]!.ends[0]] as Pt]
          : []),
        ...(loop && i === 0 && j === elements.length - 1 ? [s.solved[origin] as Pt] : []),
      ];
      if (hit === 'overlap' || hit.some((p) => !joint.some((q) => dist(p, q) <= eps)))
        return { code: 'sweep-path-self-intersection', path: `[${j}]` };
    }
  return { elements, forward, closed: loop };
}
/**
 * Points along a path (ends of lines, 65 points along each arc, a spline's sampled polygon), for
 * side-of-axis checks.
 */
export function pathSamples(g: SketchPathGeometry): Pt[] {
  return g.elements.flatMap((e) => sketchElementPoints(e));
}
/**
 * K5a (docs/cad/complex-models.md): `count` points at equal distances along a path of lines and
 * arcs, from its start to its end (one point: the start), each with the angle of the path's
 * direction there (radians, counter-clockwise from +u). Undefined if the path has a spline.
 */
export function pathPlacements(
  g: SketchPathGeometry,
  count: number,
): { at: Pt; angle: number }[] | undefined {
  type Piece = { length: number; place: (d: number) => { at: Pt; angle: number } };
  const pieces: Piece[] = [];
  for (const [i, e] of g.elements.entries()) {
    const forward = g.forward[i]!;
    if (e.type === 'line') {
      const [a, b] = forward ? [e.a, e.b] : [e.b, e.a];
      const length = dist(a, b);
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      pieces.push({
        length,
        place: (d) => ({ at: [a[0] + Math.cos(angle) * d, a[1] + Math.sin(angle) * d], angle }),
      });
    } else if (e.type === 'arc') {
      const [start, sweep] = forward ? [e.start, e.sweep] : [e.start + e.sweep, -e.sweep];
      const length = e.r * Math.abs(sweep);
      pieces.push({
        length,
        place: (d) => {
          const t = start + Math.sign(sweep) * (d / e.r);
          return { at: at(e.c, e.r, t), angle: t + Math.sign(sweep) * (Math.PI / 2) };
        },
      });
    } else return undefined;
  }
  const total = pieces.reduce((sum, x) => sum + x.length, 0);
  return Array.from({ length: count }, (_, k) => {
    let d = count > 1 ? (total * k) / (count - 1) : 0;
    for (const [j, piece] of pieces.entries()) {
      if (d <= piece.length || j === pieces.length - 1)
        return piece.place(Math.min(d, piece.length));
      d -= piece.length;
    }
    throw new Error('empty path');
  });
}
/**
 * The path a sketch's drawing makes, for a sweep or a surface made from the Surface: its lines,
 * arcs and open splines that are not construction elements, when they form one open chain (or, with
 * `closed: 'allow'`, one loop), in chain order. Undefined otherwise.
 */
export function sketchDefaultPath(
  s: CadSketch,
  closed: 'allow' | 'refuse' = 'refuse',
): string[] | undefined {
  const edges = chainEdges(s);
  if (!edges.length) return undefined;
  const count = new Map<string, number>();
  for (const e of edges) for (const p of [e.start, e.end]) count.set(p, (count.get(p) ?? 0) + 1);
  const ends = edges.filter((e) => count.get(e.start) === 1 || count.get(e.end) === 1);
  // A chain from one of its two ends (a loop, where allowed, from its first edge); sketchPath
  // checks the rest.
  let point = ends[0]
    ? count.get(ends[0].start) === 1
      ? ends[0].start
      : ends[0].end
    : closed === 'allow'
      ? edges[0]!.start
      : undefined;
  const chain: string[] = [];
  while (point !== undefined && chain.length < edges.length) {
    const next = edges.find((e) => !chain.includes(e.id) && (e.start === point || e.end === point));
    if (!next) break;
    chain.push(next.id);
    point = next.start === point ? next.end : next.start;
  }
  if (chain.length !== edges.length) return undefined;
  return 'code' in sketchPath(s, chain, closed) ? undefined : chain;
}
/** Points where `side` (a linear function of u/v) is extreme over the region's boundary. */
export function regionExtremes(g: SketchRegionGeometry, normal: Pt): Pt[] {
  const out: Pt[] = [];
  for (const l of g.loops)
    for (const e of l.elements) {
      if (e.type === 'spline' || e.type === 'closedSpline') {
        out.push(...e.pts);
        continue;
      }
      if (e.type !== 'circle') out.push(e.a, e.b);
      if (e.type === 'line') continue;
      const t = Math.atan2(normal[1], normal[0]);
      for (const a of [t, t + Math.PI]) {
        const p = at(e.c, e.r, a);
        if (onArc(e, p, 0)) out.push(p);
      }
    }
  return out;
}

/**
 * The frame of a sketch attached to a planar face (docs/cad/r1-modeling.md, 依存関係と評価順):
 * normal `n` (the face's outward normal), origin the world origin projected onto the face's plane
 * and moved `offset` along `n`. `v` is the world Z axis projected onto the plane, so a side face
 * is drawn upright as seen from outside; on a face normal to Z, `u` is the world X axis instead.
 * It depends on the face's plane alone, never on its outline or the order of its vertices, so the
 * sketch's stored coordinates keep their meaning when the face changes size.
 */
export function attachFrame(
  point: Vec3,
  normal: Vec3,
  offset: number,
): { origin: Vec3; orientation: Quaternion } {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: Vec3): Vec3 => {
    const k = Math.hypot(...a);
    return [a[0] / k, a[1] / k, a[2] / k];
  };
  const n = unit(normal);
  const along = dot(point, n) + offset;
  const origin: Vec3 = [n[0] * along, n[1] * along, n[2] * along];
  const project = (a: Vec3): Vec3 => {
    const d = dot(a, n);
    return [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const up = project([0, 0, 1]);
  let u: Vec3;
  let v: Vec3;
  if (Math.hypot(...up) >= 1e-6) {
    v = unit(up);
    u = cross(v, n);
  } else {
    u = unit(project([1, 0, 0]));
    v = cross(n, u);
  }
  // The rotation whose columns are u, v, n, as a unit quaternion [x, y, z, w].
  const [m00, m10, m20] = u;
  const [m01, m11, m21] = v;
  const [m02, m12, m22] = n;
  const trace = m00 + m11 + m22;
  let q: Quaternion;
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / k, (m02 - m20) / k, (m10 - m01) / k, k / 4];
  } else if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [k / 4, (m01 + m10) / k, (m02 + m20) / k, (m21 - m12) / k];
  } else if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / k, k / 4, (m12 + m21) / k, (m02 - m20) / k];
  } else {
    const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / k, (m12 + m21) / k, k / 4, (m10 - m01) / k];
  }
  return { origin, orientation: q };
}
