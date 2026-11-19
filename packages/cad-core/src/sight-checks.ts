/**
 * PD7 (docs/cad/product-design.md, PD7 見え方の検査): a document's sight checks. Each one names
 * eye points (or a light's point) and what is looked at, and measures one of three values on the
 * display meshes:
 *
 * - `obstruction`: on a horizontal arc around the eyes, the angle the named bodies hide from
 *   every eye at once (both eyes when there are two, as a pillar hides what neither eye sees);
 *   each eye's own hidden angle and the hidden stretches are reported too.
 * - `visibleFraction`: the share (by the area an eye sees, area × |cos|) of the target bodies'
 *   surface facing the eyes that a line from an eye reaches without meeting an opaque body;
 *   bodies listed as clear (a crystal, a windscreen) let the line through. A point counts when
 *   any eye sees it.
 * - `visibleAngle`: from a point (a lamp), how far a ray can turn from its forward direction
 *   (left, right, up or down) before an opaque body stops it.
 *
 * These are geometric checks only (PD-U6): they are named after what they measure, not after any
 * rule, and they are as precise as the meshes' tessellation and the angular step, both of which
 * are reported. The checks are stored in the document; the values are measured and never stored.
 */
import type { CadDocument, Vec3 } from './model';
import type { CadProportionMesh } from './proportions';

export type CadSightToward = 'left' | 'right' | 'up' | 'down';
export type CadSightMeasure =
  | {
      kind: 'obstruction';
      /** One or two eye points (mm). */
      eyes: Vec3[];
      /** The direction the arc's 0° looks at, and the up direction the arc turns about. */
      forward: Vec3;
      up: Vec3;
      /** The arc (degrees, positive to the left of `forward` about `up`), from < to. */
      fromDeg: number;
      toDeg: number;
      /** The bodies that may hide part of the arc (e.g. the A-pillars). */
      bodyIds: string[];
      /** The angular step (degrees); absent: the default. */
      stepDeg?: number;
    }
  | {
      kind: 'visibleFraction';
      eyes: Vec3[];
      /** The bodies looked at (e.g. the balance seen through the crystal). */
      targetIds: string[];
      /** Bodies a line of sight passes through (clear glass); absent: none. */
      clearIds?: string[];
    }
  | {
      kind: 'visibleAngle';
      /** The point the rays start from (e.g. a lamp's centre, mm). */
      from: Vec3;
      forward: Vec3;
      up: Vec3;
      toward: CadSightToward;
      /** How far to turn at most (degrees); absent: 90. */
      limitDeg?: number;
      /** Bodies the rays pass through (the lamp's own lens and housing); absent: none. */
      clearIds?: string[];
      stepDeg?: number;
    };
export type CadSightMeasureKind = CadSightMeasure['kind'];
export interface CadSightCheck {
  id: string;
  name: string;
  /** The requirement it comes from, as written in the project; plain text (PD-U2). */
  requirement?: string;
  measure: CadSightMeasure;
  /** The band (either end may be open, not both): degrees, or a share 0–1 for a fraction. */
  min?: number;
  max?: number;
}
export const cadSightMeasureKinds: readonly CadSightMeasureKind[] = Object.freeze([
  'obstruction',
  'visibleFraction',
  'visibleAngle',
]);
export const cadSightLimits = Object.freeze({
  checks: 64,
  bodiesPerList: 64,
  eyes: 2,
  requirementLength: 128,
  /** Any coordinate within ±this (mm). */
  coordinate: 1e7,
  defaultStepDeg: 0.1,
  minStepDeg: 0.01,
  maxStepDeg: 5,
  /** Rays along one arc or turn (per eye). */
  steps: 20_000,
  defaultLimitDeg: 90,
  maxLimitDeg: 180,
  /** Target triangles a fraction samples, and triangles one check casts against. */
  samples: 50_000,
  triangles: 2_000_000,
});
export type CadSightUnit = 'deg' | 'ratio';
export const sightUnit = (m: CadSightMeasure): CadSightUnit =>
  m.kind === 'visibleFraction' ? 'ratio' : 'deg';

export type CadSightChecksOperation = {
  type: 'setSightChecks';
  /** The whole list; empty removes it. */
  checks: CadSightCheck[];
};
export function applySightChecksOperation(next: CadDocument, op: CadSightChecksOperation) {
  if (JSON.stringify(next.sightChecks ?? []) === JSON.stringify(op.checks))
    throw new Error('sight-checks-unchanged');
  if (op.checks.length) next.sightChecks = structuredClone(op.checks);
  else delete next.sightChecks;
  return next;
}

/**
 * A removed body leaves every check's lists. A check left without the bodies it hides with or
 * looks at goes with it (it no longer measures what it said); an emptied clear list is dropped.
 */
export function pruneSightChecks(doc: CadDocument, removed: ReadonlySet<string>) {
  if (!doc.sightChecks) return;
  const drop = (l: readonly string[]) => l.filter((id) => !removed.has(id));
  const kept: CadSightCheck[] = [];
  for (const c of doc.sightChecks) {
    const m = c.measure;
    if (m.kind === 'obstruction') {
      const bodyIds = drop(m.bodyIds);
      if (bodyIds.length) kept.push({ ...c, measure: { ...m, bodyIds } });
      continue;
    }
    const clear = m.clearIds ? drop(m.clearIds) : [];
    const { clearIds: _gone, ...rest } = m;
    const withClear = clear.length ? { ...rest, clearIds: clear } : rest;
    if (m.kind === 'visibleFraction') {
      const targetIds = drop(m.targetIds);
      if (targetIds.length) kept.push({ ...c, measure: { ...(withClear as typeof m), targetIds } });
      continue;
    }
    kept.push({ ...c, measure: withClear as typeof m });
  }
  if (kept.length) doc.sightChecks = kept;
  else delete doc.sightChecks;
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((x) => finite(x) && Math.abs(x) <= cadSightLimits.coordinate);
const len3 = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export interface SightChecksCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): boolean;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `sightChecks`: 1–64 checks with distinct IDs, each a known measure with finite
 * points, a forward and an up that are not along each other, an arc or turn within the step
 * limits, distinct active bodies (a body never both looked at and clear), and a band with at
 * least one end (a fraction's within 0–1).
 */
export function validateSightChecks(
  c: SightChecksCheck,
  list: unknown,
  active: ReadonlySet<string>,
) {
  const path = '$.sightChecks';
  const L = cadSightLimits;
  if (!Array.isArray(list) || !list.length || list.length > L.checks)
    return void c.error('sight-checks', path);
  const ids = new Set<string>();
  list.forEach((t, i) => {
    const at = `${path}[${i}]`;
    if (!record(t)) return c.error('sight-check', at);
    c.keys(t, ['id', 'name', 'measure'], at, ['requirement', 'min', 'max']);
    if (c.id(t.id, `${at}.id`)) {
      if (ids.has(t.id as string)) c.error('duplicate-id', `${at}.id`);
      ids.add(t.id as string);
    }
    c.name(t.name, `${at}.name`);
    if (
      Object.hasOwn(t, 'requirement') &&
      (typeof t.requirement !== 'string' ||
        !t.requirement.trim() ||
        t.requirement.length > L.requirementLength)
    )
      c.error('sight-check-requirement', `${at}.requirement`);
    const ratio = record(t.measure) && t.measure.kind === 'visibleFraction';
    for (const k of ['min', 'max'] as const)
      if (
        Object.hasOwn(t, k) &&
        !(finite(t[k]) && (ratio ? t[k] >= 0 && t[k] <= 1 : Math.abs(t[k] as number) <= 360))
      )
        c.error('sight-check-band', `${at}.${k}`);
    if (!Object.hasOwn(t, 'min') && !Object.hasOwn(t, 'max')) c.error('sight-check-band', at);
    if (finite(t.min) && finite(t.max) && t.min > t.max) c.error('sight-check-band', `${at}.max`);
    checkMeasure(c, t.measure, `${at}.measure`, active);
  });
}
function checkMeasure(c: SightChecksCheck, m: unknown, at: string, active: ReadonlySet<string>) {
  const L = cadSightLimits;
  if (!record(m) || typeof m.kind !== 'string' || !cadSightMeasureKinds.includes(m.kind as never))
    return void c.error('sight-check-measure', at);
  const bodies = (v: unknown, p: string) => {
    if (!Array.isArray(v) || !v.length || v.length > L.bodiesPerList)
      return void c.error('sight-check-bodies', p);
    const seen = new Set<unknown>();
    v.forEach((id, j) => {
      if (typeof id !== 'string' || !active.has(id))
        return c.error('sight-check-body', `${p}[${j}]`);
      if (seen.has(id)) return c.error('sight-check-body-twice', `${p}[${j}]`);
      seen.add(id);
    });
  };
  const eyes = (v: unknown, p: string) => {
    if (!Array.isArray(v) || !v.length || v.length > L.eyes)
      return void c.error('sight-check-eyes', p);
    v.forEach((e, j) => {
      if (!vec3(e)) c.error('sight-check-point', `${p}[${j}]`);
    });
  };
  const frame = () => {
    const ok = (v: unknown, k: string) => {
      if (!vec3(v) || len3(v) < 1e-9) return void c.error('sight-check-direction', `${at}.${k}`);
      return true;
    };
    if (ok(m.forward, 'forward') && ok(m.up, 'up')) {
      const f = m.forward as Vec3;
      const u = m.up as Vec3;
      if (len3(cross3(f, u)) <= 1e-6 * len3(f) * len3(u))
        c.error('sight-check-direction', `${at}.up`);
    }
  };
  const step = (span: number) => {
    if (!Object.hasOwn(m, 'stepDeg')) return;
    const s = m.stepDeg;
    if (!finite(s) || s < L.minStepDeg || s > L.maxStepDeg)
      return void c.error('sight-check-step', `${at}.stepDeg`);
    if (Number.isFinite(span) && Math.ceil(span / s - 1e-9) > L.steps)
      c.error('sight-check-step', `${at}.stepDeg`);
  };
  switch (m.kind as CadSightMeasureKind) {
    case 'obstruction': {
      c.keys(m, ['kind', 'eyes', 'forward', 'up', 'fromDeg', 'toDeg', 'bodyIds'], at, ['stepDeg']);
      eyes(m.eyes, `${at}.eyes`);
      frame();
      const arcOk =
        finite(m.fromDeg) &&
        finite(m.toDeg) &&
        m.fromDeg >= -180 &&
        m.toDeg <= 180 &&
        m.fromDeg < m.toDeg;
      if (!arcOk) c.error('sight-check-arc', `${at}.toDeg`);
      step(arcOk ? (m.toDeg as number) - (m.fromDeg as number) : NaN);
      bodies(m.bodyIds, `${at}.bodyIds`);
      return;
    }
    case 'visibleFraction': {
      c.keys(m, ['kind', 'eyes', 'targetIds'], at, ['clearIds']);
      eyes(m.eyes, `${at}.eyes`);
      bodies(m.targetIds, `${at}.targetIds`);
      if (Object.hasOwn(m, 'clearIds')) {
        bodies(m.clearIds, `${at}.clearIds`);
        const t = m.targetIds;
        if (
          Array.isArray(m.clearIds) &&
          Array.isArray(t) &&
          m.clearIds.some((id) => t.includes(id))
        )
          c.error('sight-check-clear-target', `${at}.clearIds`);
      }
      return;
    }
    case 'visibleAngle': {
      c.keys(m, ['kind', 'from', 'forward', 'up', 'toward'], at, [
        'limitDeg',
        'clearIds',
        'stepDeg',
      ]);
      if (!vec3(m.from)) c.error('sight-check-point', `${at}.from`);
      frame();
      if (!['left', 'right', 'up', 'down'].includes(m.toward as string))
        c.error('sight-check-toward', `${at}.toward`);
      let limit: number = L.defaultLimitDeg;
      if (Object.hasOwn(m, 'limitDeg')) {
        if (!finite(m.limitDeg) || m.limitDeg <= 0 || m.limitDeg > L.maxLimitDeg) {
          c.error('sight-check-limit', `${at}.limitDeg`);
          limit = NaN;
        } else limit = m.limitDeg;
      }
      step(limit);
      if (Object.hasOwn(m, 'clearIds')) bodies(m.clearIds, `${at}.clearIds`);
      return;
    }
  }
}

/** Why a value is not measured now. */
export type CadSightUnknown =
  /** The document's own evaluation and display meshes are not at hand. */
  | 'sight-not-evaluated'
  /** A body named has no display mesh. */
  | 'sight-body-missing'
  /** Too many target triangles or triangles to cast against. */
  | 'sight-limit'
  /** No part of the targets faces an eye (an eye inside a target, or a target with no area). */
  | 'sight-target-hidden';
export interface CadSightResult {
  id: string;
  unit: CadSightUnit;
  /** Absent when unknown. */
  value?: number;
  status: 'pass' | 'fail' | 'unknown';
  reason?: CadSightUnknown;
  /** Each eye's own value (obstruction: its hidden angle; fraction: its share). */
  perEye?: number[];
  /** Obstruction: the stretches hidden from every eye ([from, to] degrees on the arc). */
  hidden?: [number, number][];
  /** The angular step used (the arc or turn split into equal steps no wider than asked). */
  stepDeg?: number;
  /** The rays cast, the target triangles sampled, and the triangles cast against. */
  rays?: number;
  samples?: number;
  triangles?: number;
}
export interface CadSightInput {
  /** This document's own display meshes in world mm (absent: not evaluated with its own build). */
  meshes?: readonly CadProportionMesh[];
}

/**
 * A uniform grid of triangles for "does this ray meet a triangle before distance t" — the only
 * question the checks ask. Each cell lists the triangles whose box touches it; a ray walks the
 * cells it crosses (3D DDA) and tests each triangle once (Möller–Trumbore).
 */
export class SightGrid {
  readonly triangles: number;
  readonly #v: Float64Array;
  readonly #min: Vec3;
  readonly #cell: Vec3;
  readonly #res: [number, number, number];
  readonly #start: Uint32Array;
  readonly #items: Uint32Array;
  readonly #stamp: Uint32Array;
  #ray = 0;

  constructor(v: Float64Array) {
    const n = (this.triangles = v.length / 9);
    this.#v = v;
    this.#stamp = new Uint32Array(n);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i++) {
      const k = i % 3;
      if (v[i]! < min[k]!) min[k] = v[i]!;
      if (v[i]! > max[k]!) max[k] = v[i]!;
    }
    if (!n) {
      this.#min = [0, 0, 0];
      this.#cell = [1, 1, 1];
      this.#res = [1, 1, 1];
      this.#start = new Uint32Array(2);
      this.#items = new Uint32Array(0);
      return;
    }
    const ext = [0, 1, 2].map((k) => max[k]! - min[k]!);
    const big = Math.max(...ext, 1e-6);
    const pad = big * 1e-6;
    for (let k = 0; k < 3; k++) {
      min[k] -= pad;
      ext[k] = ext[k]! + 2 * pad;
    }
    // About two cells a triangle, at most 256 a side: a flat or thin set keeps few layers.
    const wanted = Math.min(2 * n, 2_000_000);
    const floor = ext.map((e) => Math.max(e, big / 256));
    const size = Math.cbrt((floor[0]! * floor[1]! * floor[2]!) / wanted);
    const res = ext.map((e) => Math.max(1, Math.min(256, Math.ceil(e / size)))) as [
      number,
      number,
      number,
    ];
    this.#min = min;
    this.#res = res;
    this.#cell = [ext[0]! / res[0], ext[1]! / res[1], ext[2]! / res[2]];
    const cells = res[0] * res[1] * res[2];
    const count = new Uint32Array(cells + 1);
    const span = (t: number, fill?: (cell: number) => void) => {
      const lo = [0, 0, 0];
      const hi = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const a = v[t * 9 + k]!;
        const b = v[t * 9 + 3 + k]!;
        const c = v[t * 9 + 6 + k]!;
        lo[k] = this.#index(k, Math.min(a, b, c));
        hi[k] = this.#index(k, Math.max(a, b, c));
      }
      let total = 0;
      for (let z = lo[2]!; z <= hi[2]!; z++)
        for (let y = lo[1]!; y <= hi[1]!; y++)
          for (let x = lo[0]!; x <= hi[0]!; x++) {
            const cell = (z * res[1] + y) * res[0] + x;
            if (fill) fill(cell);
            else count[cell + 1]!++;
            total++;
          }
      return total;
    };
    for (let t = 0; t < n; t++) span(t);
    for (let i = 0; i < cells; i++) count[i + 1] = count[i + 1]! + count[i]!;
    this.#start = count;
    this.#items = new Uint32Array(count[cells]!);
    const at = count.slice(0, cells);
    for (let t = 0; t < n; t++) span(t, (cell) => (this.#items[at[cell]!++] = t));
  }

  #index(k: number, x: number) {
    const i = Math.floor((x - this.#min[k]!) / this.#cell[k]!);
    return Math.max(0, Math.min(this.#res[k]! - 1, i));
  }

  /** Whether the ray `o + t·d` (d of unit length) meets a triangle for tMin < t < tMax. */
  blocked(o: Vec3, d: Vec3, tMax: number, skip = -1, tMin = 1e-6): boolean {
    return this.#walk(o, d, tMax, skip, tMin);
  }

  /**
   * Whether a point is inside the closed surface the triangles make: an odd number of surface
   * crossings along a ray. Hits at the same distance (a ray through an edge or corner shared by
   * several triangles) are one crossing, and three rays in unrelated directions vote, so one
   * that grazes the surface cannot decide alone.
   */
  inside(o: Vec3): boolean {
    const dirs: Vec3[] = [
      [0.5773, 0.5779, 0.5769],
      [-0.6411, 0.2387, 0.7293],
      [0.3119, -0.8467, -0.4311],
    ];
    let votes = 0;
    for (const v of dirs) {
      const l = len3(v);
      const hits: number[] = [];
      this.#walk(o, [v[0] / l, v[1] / l, v[2] / l], Infinity, -1, 0, (h) => void hits.push(h));
      hits.sort((a, b) => a - b);
      let crossings = 0;
      for (let i = 0; i < hits.length; i++)
        if (i === 0 || hits[i]! - hits[i - 1]! > 1e-9 * Math.max(1, hits[i]!)) crossings++;
      if (crossings % 2 === 1) votes++;
    }
    return votes >= 2;
  }

  /** Walks the ray's cells; stops at the first hit unless `each` takes every hit. */
  #walk(
    o: Vec3,
    d: Vec3,
    tMax: number,
    skip: number,
    tMin: number,
    each?: (t: number) => void,
  ): boolean {
    if (!this.triangles) return false;
    const res = this.#res;
    // The ray's stretch inside the grid's box.
    let t0 = tMin;
    let t1 = tMax;
    for (let k = 0; k < 3; k++) {
      const lo = this.#min[k]!;
      const hi = lo + this.#cell[k]! * res[k]!;
      if (Math.abs(d[k]!) < 1e-300) {
        if (o[k]! < lo || o[k]! > hi) return false;
        continue;
      }
      let a = (lo - o[k]!) / d[k]!;
      let b = (hi - o[k]!) / d[k]!;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    const stamp = ++this.#ray;
    if (stamp === 0xffffffff) {
      this.#stamp.fill(0);
      this.#ray = 1;
    }
    const p = [0, 1, 2].map((k) => o[k]! + d[k]! * t0);
    const cell = [0, 1, 2].map((k) => this.#index(k, p[k]!));
    const step = [0, 0, 0];
    const next = [Infinity, Infinity, Infinity];
    const delta = [Infinity, Infinity, Infinity];
    for (let k = 0; k < 3; k++) {
      if (d[k]! > 0) {
        step[k] = 1;
        next[k] = (this.#min[k]! + (cell[k]! + 1) * this.#cell[k]! - o[k]!) / d[k]!;
        delta[k] = this.#cell[k]! / d[k]!;
      } else if (d[k]! < 0) {
        step[k] = -1;
        next[k] = (this.#min[k]! + cell[k]! * this.#cell[k]! - o[k]!) / d[k]!;
        delta[k] = -this.#cell[k]! / d[k]!;
      }
    }
    for (;;) {
      const c = (cell[2]! * res[1] + cell[1]!) * res[0] + cell[0]!;
      for (let i = this.#start[c]!; i < this.#start[c + 1]!; i++) {
        const t = this.#items[i]!;
        if (t === skip || this.#stamp[t] === stamp) continue;
        this.#stamp[t] = stamp;
        const h = this.#hit(t, o, d);
        if (h > tMin && h < tMax) {
          if (!each) return true;
          each(h);
        }
      }
      const k = next[0]! < next[1]! ? (next[0]! < next[2]! ? 0 : 2) : next[1]! < next[2]! ? 1 : 2;
      if (next[k]! > t1) return false;
      cell[k] = cell[k]! + step[k]!;
      if (cell[k]! < 0 || cell[k]! >= res[k]!) return false;
      next[k] = next[k]! + delta[k]!;
    }
  }

  /** The distance along the ray to triangle t (Möller–Trumbore), or NaN when it misses. */
  #hit(t: number, o: Vec3, d: Vec3) {
    const v = this.#v;
    const b = t * 9;
    const e1x = v[b + 3]! - v[b]!;
    const e1y = v[b + 4]! - v[b + 1]!;
    const e1z = v[b + 5]! - v[b + 2]!;
    const e2x = v[b + 6]! - v[b]!;
    const e2y = v[b + 7]! - v[b + 1]!;
    const e2z = v[b + 8]! - v[b + 2]!;
    const px = d[1]! * e2z - d[2]! * e2y;
    const py = d[2]! * e2x - d[0]! * e2z;
    const pz = d[0]! * e2y - d[1]! * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    const scale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
    if (Math.abs(det) <= 1e-12 * scale) return NaN;
    const inv = 1 / det;
    const sx = o[0]! - v[b]!;
    const sy = o[1]! - v[b + 1]!;
    const sz = o[2]! - v[b + 2]!;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return NaN;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const w = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
    if (w < 0 || u + w > 1) return NaN;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }
}

/** The triangles of the meshes as one flat array (nine numbers a triangle). */
function triangles(meshes: readonly CadProportionMesh[]) {
  let n = 0;
  for (const m of meshes) n += m.indices ? Math.floor(m.indices.length / 3) : 0;
  const v = new Float64Array(n * 9);
  let o = 0;
  for (const m of meshes) {
    if (!m.indices) continue;
    for (let i = 0; i + 2 < m.indices.length; i += 3)
      for (let j = 0; j < 3; j++) {
        const p = m.indices[i + j]! * 3;
        v[o++] = m.points[p]!;
        v[o++] = m.points[p + 1]!;
        v[o++] = m.points[p + 2]!;
      }
  }
  return v;
}

const unit3 = (v: Vec3): Vec3 => {
  const l = len3(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Forward made square to up, and the left (up × forward). */
function frameOf(forward: Vec3, up: Vec3) {
  const u = unit3(up);
  const d = forward[0] * u[0] + forward[1] * u[1] + forward[2] * u[2];
  const f = unit3([forward[0] - d * u[0], forward[1] - d * u[1], forward[2] - d * u[2]]);
  return { f, u, l: cross3(u, f) };
}
/** Forward kept as given (a lamp's aim), and up made square to it, and the left. */
function aimOf(forward: Vec3, up: Vec3) {
  const f = unit3(forward);
  const d = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
  const u = unit3([up[0] - d * f[0], up[1] - d * f[1], up[2] - d * f[2]]);
  return { f, u, l: cross3(u, f) };
}
/** Point keys of a mesh's corners (to 1e-6 mm), so faces with their own nodes still join. */
const key = (v: Float64Array, i: number) =>
  `${Math.round(v[i]! * 1e6)},${Math.round(v[i + 1]! * 1e6)},${Math.round(v[i + 2]! * 1e6)}`;
/**
 * Whether the triangles close up (every edge shared by an even number of them): only a closed
 * surface has an inside. An open sheet does not.
 */
function closed(v: Float64Array) {
  const edges = new Map<string, number>();
  for (let t = 0; t < v.length / 9; t++) {
    const k = [key(v, t * 9), key(v, t * 9 + 3), key(v, t * 9 + 6)];
    for (const [a, b] of [
      [k[0]!, k[1]!],
      [k[1]!, k[2]!],
      [k[2]!, k[0]!],
    ] as const) {
      if (a === b) continue;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  return edges.size > 0 && [...edges.values()].every((n) => n % 2 === 0);
}
const turn = (a: Vec3, b: Vec3, deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * a[0] + s * b[0], c * a[1] + s * b[1], c * a[2] + s * b[2]];
};
/** The arc split into equal steps no wider than asked, each sampled at its middle. */
const steps = (span: number, stepDeg: number) => {
  const n = Math.max(1, Math.ceil(span / stepDeg - 1e-9));
  return { n, w: span / n };
};

/**
 * PD7: each check's value and whether it is inside its band, on the display meshes (as precise
 * as their tessellation and the angular step, which the result reports).
 */
export function measureSightChecks(doc: CadDocument, input: CadSightInput): CadSightResult[] {
  const checks = doc.sightChecks ?? [];
  if (!checks.length) return [];
  const L = cadSightLimits;
  const byBody = new Map<string, CadProportionMesh[]>();
  for (const m of input.meshes ?? []) byBody.set(m.bodyId, [...(byBody.get(m.bodyId) ?? []), m]);
  const meshesOf = (ids: readonly string[]) => ids.flatMap((id) => byBody.get(id) ?? []);
  // A line of sight is stopped by any opaque body: one without meshes would let it through, so
  // the fraction and the angle need every active body's meshes (the obstruction names its own).
  const allMeshed = doc.bodies.every((b) => b.state !== 'active' || byBody.has(b.id));
  const others = (skip: ReadonlySet<string>) =>
    [...byBody].flatMap(([id, m]) => (skip.has(id) ? [] : m));
  const count = (ms: readonly CadProportionMesh[]) =>
    ms.reduce((s, m) => s + (m.indices ? Math.floor(m.indices.length / 3) : 0), 0);
  type Value = Omit<CadSightResult, 'id' | 'unit' | 'status'> & { value: number };
  const one = (m: CadSightMeasure): Value | { reason: CadSightUnknown } => {
    if (!input.meshes) return { reason: 'sight-not-evaluated' };
    switch (m.kind) {
      case 'obstruction': {
        if (!m.bodyIds.every((id) => byBody.has(id))) return { reason: 'sight-body-missing' };
        const ms = meshesOf(m.bodyIds);
        if (count(ms) > L.triangles) return { reason: 'sight-limit' };
        const grid = new SightGrid(triangles(ms));
        const { f, u, l } = frameOf(m.forward, m.up);
        void u;
        const stepDeg = m.stepDeg ?? L.defaultStepDeg;
        const { n, w } = steps(m.toDeg - m.fromDeg, stepDeg);
        // Steps are counted and multiplied once: a sum of steps would drift past the arc.
        const perEyeSteps = m.eyes.map(() => 0);
        const runs: [number, number][] = [];
        let all = 0;
        for (let i = 0; i < n; i++) {
          const a = m.fromDeg + (i + 0.5) * w;
          const d = turn(f, l, a);
          let every = true;
          m.eyes.forEach((e, k) => {
            if (grid.blocked(e, d, Infinity)) perEyeSteps[k]!++;
            else every = false;
          });
          if (!every) continue;
          all++;
          const last = runs[runs.length - 1];
          if (last && last[1] === i) last[1] = i + 1;
          else runs.push([i, i + 1]);
        }
        const angle = (k: number) => (k === n ? m.toDeg : m.fromDeg + k * w);
        return {
          value: all === n ? m.toDeg - m.fromDeg : all * w,
          perEye: perEyeSteps.map((k) => (k === n ? m.toDeg - m.fromDeg : k * w)),
          hidden: runs.map(([a, b]) => [angle(a), angle(b)]),
          stepDeg: w,
          rays: n * m.eyes.length,
          triangles: grid.triangles,
        };
      }
      case 'visibleFraction': {
        if (!m.targetIds.every((id) => byBody.has(id)) || !allMeshed)
          return { reason: 'sight-body-missing' };
        const clear = new Set([...(m.clearIds ?? []), ...m.targetIds]);
        const target = meshesOf(m.targetIds);
        const opaque = others(clear);
        const nt = count(target);
        if (nt > L.samples || count(opaque) > L.triangles) return { reason: 'sight-limit' };
        const tv = triangles(target);
        const own = new SightGrid(tv);
        const block = new SightGrid(triangles(opaque));
        // An eye inside a target sees only its inside: that eye faces none of it.
        // Only a closed target body has an inside; an open sheet is seen from either side.
        const shells = m.targetIds.flatMap((id) => {
          const v = triangles(byBody.get(id)!);
          return closed(v) ? [new SightGrid(v)] : [];
        });
        const outside = m.eyes.map((e) => !shells.some((g) => g.inside(e)));
        const perEyeSeen = m.eyes.map(() => 0);
        const perEyeFacing = m.eyes.map(() => 0);
        let facing = 0;
        let seen = 0;
        for (let t = 0; t < nt; t++) {
          const b = t * 9;
          const c: Vec3 = [
            (tv[b]! + tv[b + 3]! + tv[b + 6]!) / 3,
            (tv[b + 1]! + tv[b + 4]! + tv[b + 7]!) / 3,
            (tv[b + 2]! + tv[b + 5]! + tv[b + 8]!) / 3,
          ];
          const normal = cross3(
            [tv[b + 3]! - tv[b]!, tv[b + 4]! - tv[b + 1]!, tv[b + 5]! - tv[b + 2]!],
            [tv[b + 6]! - tv[b]!, tv[b + 7]! - tv[b + 1]!, tv[b + 8]! - tv[b + 2]!],
          );
          const twice = len3(normal);
          if (!(twice > 0)) continue;
          // Each eye weighs a triangle by its area as that eye sees it (area × |cos|): one seen
          // edge-on adds nothing; an open sheet counts from either side.
          // Together: one weight a triangle (the largest any eye gives it), counted as seen when
          // any eye sees it, so adding an eye never lowers the share.
          let facingMost = 0;
          let anySeen = false;
          m.eyes.forEach((e, k) => {
            if (!outside[k]) return;
            const r: Vec3 = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
            const dist = len3(r);
            if (!(dist > 1e-9)) return;
            const d: Vec3 = [r[0] / dist, r[1] / dist, r[2] / dist];
            const cos = Math.abs(normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2]) / twice;
            if (cos < 1e-9) return;
            const area = (twice / 2) * cos;
            // Hidden by the target itself: the far side, not counted either way.
            const end = dist * (1 - 1e-9) - 1e-6;
            if (own.blocked(e, d, end, t, 0)) return;
            facingMost = Math.max(facingMost, area);
            perEyeFacing[k]! += area;
            if (block.blocked(e, d, end, -1, 0)) return;
            anySeen = true;
            perEyeSeen[k]! += area;
          });
          facing += facingMost;
          if (anySeen) seen += facingMost;
        }
        if (!(facing > 0)) return { reason: 'sight-target-hidden' };
        return {
          value: seen / facing,
          perEye: perEyeSeen.map((s, k) => (perEyeFacing[k]! > 0 ? s / perEyeFacing[k]! : 0)),
          rays: nt * m.eyes.length,
          samples: nt,
          triangles: block.triangles,
        };
      }
      case 'visibleAngle': {
        const clearIds = m.clearIds ?? [];
        if (!clearIds.every((id) => byBody.has(id)) || !allMeshed)
          return { reason: 'sight-body-missing' };
        const opaque = others(new Set(clearIds));
        if (count(opaque) > L.triangles) return { reason: 'sight-limit' };
        const grid = new SightGrid(triangles(opaque));
        // The light's aim stays as given; up is squared to it.
        const { f, u, l } = aimOf(m.forward, m.up);
        const side: Vec3 =
          m.toward === 'left'
            ? l
            : m.toward === 'right'
              ? [-l[0], -l[1], -l[2]]
              : m.toward === 'up'
                ? u
                : [-u[0], -u[1], -u[2]];
        const limit = m.limitDeg ?? L.defaultLimitDeg;
        const { n, w } = steps(limit, m.stepDeg ?? L.defaultStepDeg);
        // Rays at 0, w, 2w … limit: the first one stopped ends the clear turn.
        let value = limit;
        let rays = 0;
        for (let i = 0; i <= n; i++) {
          rays++;
          if (grid.blocked(m.from, turn(f, side, i * w), Infinity)) {
            value = Math.max(0, (i - 1) * w);
            break;
          }
        }
        return { value, stepDeg: w, rays, triangles: grid.triangles };
      }
    }
  };
  return checks.map((c) => {
    const unit = sightUnit(c.measure);
    const r = one(c.measure);
    if ('reason' in r) return { id: c.id, unit, status: 'unknown', reason: r.reason };
    const inside =
      (c.min === undefined || r.value >= c.min) && (c.max === undefined || r.value <= c.max);
    return { id: c.id, unit, status: inside ? 'pass' : 'fail', ...r };
  });
}

/** The checks and their results as one JSON-ready record (for a project's verification). */
export function sightCheckReport(
  doc: CadDocument,
  results: readonly CadSightResult[],
  documentName?: string,
) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const checks = (doc.sightChecks ?? []).map((c) => {
    const { id: _id, ...r } = byId.get(c.id) ?? {
      id: c.id,
      unit: sightUnit(c.measure),
      status: 'unknown' as const,
    };
    return {
      id: c.id,
      name: c.name,
      ...(c.requirement ? { requirement: c.requirement } : {}),
      measure: c.measure,
      ...(c.min !== undefined ? { min: c.min } : {}),
      ...(c.max !== undefined ? { max: c.max } : {}),
      ...r,
    };
  });
  const count = (s: string) => checks.filter((t) => t.status === s).length;
  return {
    format: 'editor-platform/cad-sight-checks@1',
    ...(documentName ? { document: documentName } : {}),
    /** What the values are measured on: the display meshes, with the angular step per check. */
    basis: 'display-meshes',
    summary: { pass: count('pass'), fail: count('fail'), unknown: count('unknown') },
    checks,
  };
}
