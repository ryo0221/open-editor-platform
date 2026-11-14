/**
 * CS3 (docs/cad/construction-site.md): cranes and the lifts they make. A crane is a parametric
 * object (CS-U4): a tower crane (a mast and a level jib that slews, a trolley running along it)
 * or a mobile crane (a boom from a pivot; the hook radius sets the boom angle). Each lift carries
 * one BIM element from a pick point to where the element stands, while the task that builds it
 * runs: hoist, slew and trolley, lower.
 *
 * The checks: the pick or place radius outside the crane's reach, the load over the load chart at
 * that radius (the mass from the BIM materials' densities), the load or the jib hitting what
 * stands on the lift's day, and two cranes whose slewing circles overlap while both stand.
 * Lengths in mm, masses in kg. Pure data and arithmetic: no React, no kernel.
 */
import type { ConstructionDiagnostic, ConstructionDocument } from './model';
import { taskSpan, WorkingDays, siteOnDay, type ConstructionSchedule } from './schedule';
import { dayString } from '@editor-platform/time-axis';
import type { Plan, Point3 } from './site';

export type CraneKind = 'tower' | 'mobile';
export const craneKinds: readonly CraneKind[] = Object.freeze(['tower', 'mobile']);

/** One row of a load chart: up to `radius`, the crane lifts `capacityKg`. */
export interface LoadChartRow {
  radius: number;
  capacityKg: number;
}

export interface Crane {
  id: string;
  name: string;
  kind: CraneKind;
  /** The slewing centre in plan. */
  base: Plan;
  /** Height of the crane's base (mm); the ground there when absent. */
  baseZ?: number;
  /**
   * Tower: the jib's height above the base. Mobile: the boom pivot's height above the base.
   */
  height: number;
  /** Tower: the jib's length. Mobile: the boom's length. */
  jibLength: number;
  /** The smallest hook radius (the trolley's inner stop, the boom's steepest angle). */
  minRadius: number;
  /**
   * Radii ascending, capacities not rising. The hook reaches up to the last radius; between rows
   * the crane lifts what the next row out allows (the safe side).
   */
  loadChart: LoadChartRow[];
  /** Put up when this task starts. */
  fromTaskId: string;
  /** Taken down when this task finishes; stands to the end without one. */
  untilTaskId?: string;
  /**
   * CS4: the crane's own mass with its counterweight (kg), for the reaction on its foundation.
   * Absent, the reaction is the load's only.
   */
  massKg?: number;
}

export interface Lift {
  id: string;
  craneId: string;
  /** The task that builds the element: the lift is made on one of its days. */
  taskId: string;
  /** The element lifted, one of the task's elements. */
  elementId: string;
  /** Where the load lies before the lift: the centre of its underside (mm). */
  pick: Point3;
}

export const craneLimits = Object.freeze({
  cranes: 20,
  lifts: 5000,
  chartRows: 50,
  /** Mast, jib or boom: 500 m at most. */
  maxLength: 500_000,
  maxCapacityKg: 2_000_000,
});

/** The hook block hangs this far below the jib (or the boom tip) at its highest (mm). */
export const hookClearance = 2000;
/** The load travels this far above the highest thing standing near its way (mm). */
export const travelClearance = 1000;
/** Cross-section of the tower crane's mast and jib, for drawing and the clash check (mm). */
export const mastWidth = 1600;
export const jibDepth = 1200;
/** A mobile crane's carrier (square in plan, mm) and the pivot over it. */
export const carrierWidth = 3000;
/** The tower crane's counter-jib, as a share of the jib. */
export const counterJibShare = 0.3;

// ---------------------------------------------------------------------------------------------
// Reach and capacity

/** The furthest hook radius. */
export const craneReach = (c: Crane) => c.loadChart[c.loadChart.length - 1]?.radius ?? 0;

/** What the crane lifts at radius `r` (kg), 0 outside its reach. */
export function capacityAt(c: Crane, r: number): number {
  if (r < c.minRadius - 1e-6) return 0;
  for (const row of c.loadChart) if (r <= row.radius + 1e-6) return row.capacityKg;
  return 0;
}

/** Height of the crane's base: its own, or the ground at the slewing centre. */
export const craneBaseZ = (c: Crane, ground: (p: Plan) => number) => c.baseZ ?? ground(c.base);

/** The highest the hook goes at radius `r` (the hook point, under the jib or the boom tip). */
export function hookTop(c: Crane, baseZ: number, r: number): number {
  if (c.kind === 'tower') return baseZ + c.height - hookClearance;
  const rise = Math.sqrt(Math.max(0, c.jibLength * c.jibLength - r * r));
  return baseZ + c.height + rise - hookClearance;
}

// ---------------------------------------------------------------------------------------------
// Validation (called by validateSite)

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, limit = 1e8): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

export function validateCranes(
  cranes: unknown,
  lifts: unknown,
  tasks: ReadonlyMap<string, { action: string; elementIds: readonly string[] }>,
  usedIds: Set<string>,
  isId: (v: unknown) => v is string,
  isText: (v: unknown) => v is string,
): ConstructionDiagnostic[] {
  const out: ConstructionDiagnostic[] = [];
  const bad = (code: string, path: string, message = code) => out.push({ code, path, message });
  const only = (v: Rec, keys: string[], path: string) => {
    for (const k of Object.keys(v)) if (!keys.includes(k)) bad('unknown-key', `${path}.${k}`, k);
  };
  const id = (v: unknown, path: string) => {
    if (!isId(v)) return bad('id', path);
    if (usedIds.has(v)) bad('duplicate-id', path, `${v} is used twice`);
    usedIds.add(v);
  };
  const task = (v: unknown, path: string) => {
    if (!isId(v)) bad('id', path);
    else if (!tasks.has(v)) bad('task-missing', path, v);
  };
  const length = (v: unknown, path: string, min = 0) => {
    if (!(finite(v, craneLimits.maxLength) && v > min)) bad('length', path, `above ${min} mm`);
  };
  const craneIds = new Set<string>();
  if (cranes !== undefined) {
    if (!Array.isArray(cranes) || cranes.length > craneLimits.cranes)
      bad('limit-exceeded', '$.site.cranes', `at most ${craneLimits.cranes}`);
    else
      cranes.forEach((c, i) => {
        const p = `$.site.cranes[${i}]`;
        if (!record(c)) return bad('crane', p);
        only(
          c,
          [
            'id',
            'name',
            'kind',
            'base',
            'baseZ',
            'height',
            'jibLength',
            'minRadius',
            'loadChart',
            'fromTaskId',
            'untilTaskId',
            'massKg',
          ],
          p,
        );
        if (
          c.massKg !== undefined &&
          !(finite(c.massKg, craneLimits.maxCapacityKg * 10) && c.massKg > 0)
        )
          bad('mass', `${p}.massKg`, 'above 0 kg');
        id(c.id, `${p}.id`);
        if (isId(c.id)) craneIds.add(c.id);
        if (!isText(c.name)) bad('name', `${p}.name`);
        if (!craneKinds.includes(c.kind as never)) bad('kind', `${p}.kind`);
        if (!(Array.isArray(c.base) && c.base.length === 2 && c.base.every((x) => finite(x))))
          bad('coordinate', `${p}.base`, 'the base is [x, y] in mm');
        if (c.baseZ !== undefined && !finite(c.baseZ)) bad('coordinate', `${p}.baseZ`);
        length(c.height, `${p}.height`);
        length(c.jibLength, `${p}.jibLength`);
        if (!(finite(c.minRadius, craneLimits.maxLength) && c.minRadius >= 0))
          bad('length', `${p}.minRadius`, '0 mm or more');
        const chart = c.loadChart;
        const cp = `${p}.loadChart`;
        if (!Array.isArray(chart) || !chart.length || chart.length > craneLimits.chartRows)
          bad('load-chart', cp, `1 to ${craneLimits.chartRows} rows`);
        else {
          let last: LoadChartRow | undefined;
          chart.forEach((row, k) => {
            const rp = `${cp}[${k}]`;
            if (!record(row)) return bad('load-chart', rp);
            only(row, ['radius', 'capacityKg'], rp);
            if (!(finite(row.radius, craneLimits.maxLength) && row.radius > 0))
              return bad('load-chart', `${rp}.radius`, 'above 0 mm');
            if (!(finite(row.capacityKg, craneLimits.maxCapacityKg) && row.capacityKg > 0))
              return bad('load-chart', `${rp}.capacityKg`, 'above 0 kg');
            if (last && row.radius <= last.radius)
              bad('load-chart', `${rp}.radius`, 'radii go up row by row');
            if (last && row.capacityKg > last.capacityKg)
              bad('load-chart', `${rp}.capacityKg`, 'capacities do not go up with the radius');
            last = row as unknown as LoadChartRow;
          });
          if (last && typeof c.minRadius === 'number' && c.minRadius >= last.radius)
            bad('length', `${p}.minRadius`, 'below the last radius of the load chart');
          if (last && typeof c.jibLength === 'number') {
            // A tower crane's trolley runs along the jib; a boom's tip must stay above the pivot.
            const ok = c.kind === 'tower' ? last.radius <= c.jibLength : last.radius < c.jibLength;
            if (!ok)
              bad(
                'load-chart',
                `${cp}[${chart.length - 1}].radius`,
                c.kind === 'tower' ? 'beyond the jib' : 'not inside the boom length',
              );
          }
        }
        task(c.fromTaskId, `${p}.fromTaskId`);
        if (c.untilTaskId !== undefined) task(c.untilTaskId, `${p}.untilTaskId`);
      });
  }
  if (lifts !== undefined) {
    if (!Array.isArray(lifts) || lifts.length > craneLimits.lifts)
      bad('limit-exceeded', '$.site.lifts', `at most ${craneLimits.lifts}`);
    else {
      const lifted = new Set<string>();
      lifts.forEach((l, i) => {
        const p = `$.site.lifts[${i}]`;
        if (!record(l)) return bad('lift', p);
        only(l, ['id', 'craneId', 'taskId', 'elementId', 'pick'], p);
        id(l.id, `${p}.id`);
        if (!isId(l.craneId) || !craneIds.has(l.craneId))
          bad('crane-missing', `${p}.craneId`, isId(l.craneId) ? l.craneId : 'not an ID');
        task(l.taskId, `${p}.taskId`);
        const t = isId(l.taskId) ? tasks.get(l.taskId) : undefined;
        if (t && t.action !== 'construct')
          bad('lift-task', `${p}.taskId`, 'a lift belongs to a task that builds');
        if (!isId(l.elementId)) bad('id', `${p}.elementId`);
        else {
          if (t && !t.elementIds.includes(l.elementId))
            bad(
              'lift-element',
              `${p}.elementId`,
              `${l.elementId} is not one of the task's elements`,
            );
          if (lifted.has(l.elementId))
            bad('lift-element', `${p}.elementId`, `${l.elementId} is lifted twice`);
          lifted.add(l.elementId);
        }
        if (!(Array.isArray(l.pick) && l.pick.length === 3 && l.pick.every((x) => finite(x))))
          bad('coordinate', `${p}.pick`, 'the pick point is [x, y, z] in mm');
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// When each lift is made

export interface LiftTime {
  liftId: string;
  /** The day (YYYY-MM-DD). */
  day: string;
  /** Order of the lift over the whole schedule (0-based): earlier lifts stand when it is made. */
  order: number;
}

/**
 * The lifts of each task are spread evenly over its working days, in document order; on one day
 * they are made in that order too (tasks by document order).
 */
export function liftTimes(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
): Map<string, LiftTime> {
  const lifts = doc.site?.lifts ?? [];
  const byTask = new Map<string, string[]>();
  for (const l of lifts) byTask.set(l.taskId, [...(byTask.get(l.taskId) ?? []), l.id]);
  // Counted from the task's own start: actual dates may come before the document's start.
  const daysBetween = (start: string, finish: string) => {
    const working = new WorkingDays({ startDate: start, calendar: doc.calendar });
    const days: string[] = [];
    for (let n = 0; ; n++) {
      const d = working.day(n);
      if (d === null) break;
      const s = dayString(d);
      if (s > finish) break;
      if (s >= start) days.push(s);
    }
    return days.length ? days : [start];
  };
  const taskOrder = new Map(doc.tasks.map((t, i) => [t.id, i]));
  const items: { liftId: string; day: string; task: number; k: number }[] = [];
  for (const [taskId, ids] of byTask) {
    const task = doc.tasks.find((t) => t.id === taskId);
    const planned = schedule.byId.get(taskId);
    if (!task || !planned) continue;
    const span = taskSpan(task, planned);
    const days = daysBetween(span.start, span.finish);
    ids.forEach((liftId, k) =>
      items.push({
        liftId,
        day: days[Math.floor((k * days.length) / ids.length)]!,
        task: taskOrder.get(taskId)!,
        k,
      }),
    );
  }
  items.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.task - b.task || a.k - b.k));
  return new Map(items.map((x, order) => [x.liftId, { liftId: x.liftId, day: x.day, order }]));
}

/** Whether a crane stands on a day: from its first task's start to its last task's finish. */
export function craneStands(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  crane: Crane,
  day: string,
): boolean {
  const span = (id: string) => {
    const task = doc.tasks.find((t) => t.id === id);
    const planned = schedule.byId.get(id);
    return task && planned ? taskSpan(task, planned) : undefined;
  };
  const from = span(crane.fromTaskId);
  if (!from || day < from.start) return false;
  const until = crane.untilTaskId ? span(crane.untilTaskId) : undefined;
  return !until || day <= until.finish;
}

// ---------------------------------------------------------------------------------------------
// The lift's motion

export type Box = [Point3, Point3];

/** What the clash check and the motion need of the building: each element's body. */
export interface LiftBody {
  /** World bounds of the element as it stands. */
  bounds: Box;
  /** World triangles, 9 numbers each; the bounds alone are used without them. */
  triangles?: ArrayLike<number>;
}

export interface CraneState {
  /** Slew angle (radians, from +x counter-clockwise). */
  slew: number;
  /** Hook radius. */
  radius: number;
  /** The hook point (the top centre of the load). */
  hook: Point3;
}

export interface LiftMotion {
  /** Pick and place: the hook point over each, at the load's top. */
  pickHook: Point3;
  placeHook: Point3;
  pickRadius: number;
  placeRadius: number;
  /** Height the load's top travels at. */
  travelZ: number;
  /** Offset from the hook point to the load box's corners (the load hangs centred under it). */
  load: Box;
  /** Where the crane is at `u` (0 … 1 over the lift: hoist, slew and trolley, lower). */
  at(u: number): CraneState;
  /** Phase boundaries in `u`: hoisting ends at [0], slewing at [1]. */
  phases: [number, number];
}

const atan2 = (p: Plan, c: Plan) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const hypot = (p: Plan, c: Plan) => Math.hypot(p[0] - c[0], p[1] - c[1]);

/**
 * The lift's motion. The load's top goes up from the pick to `travelZ` (the highest of what
 * stands near the way plus `travelClearance`, at most the hook's top), slews the short way round
 * while the radius changes evenly, and comes down onto the element's place.
 */
export function liftMotion(
  crane: Crane,
  baseZ: number,
  lift: Lift,
  body: LiftBody,
  obstacleTop: number,
): LiftMotion {
  const [lo, hi] = body.bounds;
  const height = hi[2] - lo[2];
  const centre: Plan = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const load: Box = [
    [lo[0] - centre[0], lo[1] - centre[1], -height],
    [hi[0] - centre[0], hi[1] - centre[1], 0],
  ];
  const pickHook: Point3 = [lift.pick[0], lift.pick[1], lift.pick[2] + height];
  const placeHook: Point3 = [centre[0], centre[1], hi[2]];
  const pickRadius = hypot([pickHook[0], pickHook[1]], crane.base);
  const placeRadius = hypot(centre, crane.base);
  const top = Math.min(hookTop(crane, baseZ, pickRadius), hookTop(crane, baseZ, placeRadius));
  const travelZ = Math.min(
    top,
    Math.max(obstacleTop + travelClearance + height, pickHook[2], placeHook[2]),
  );
  const a0 = atan2([pickHook[0], pickHook[1]], crane.base);
  let da = atan2(centre, crane.base) - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  // The phases take time by distance: hoisting, the hook's arc, lowering.
  const up = Math.max(0, travelZ - pickHook[2]);
  const down = Math.max(0, travelZ - placeHook[2]);
  const across =
    Math.abs(da) * Math.max(pickRadius, placeRadius) + Math.abs(placeRadius - pickRadius);
  const total = up + across + down || 1;
  const p1 = up / total;
  const p2 = (up + across) / total;
  const at = (u: number): CraneState => {
    const t = Math.min(1, Math.max(0, u));
    let s = 0;
    let z: number;
    if (t <= p1) z = p1 ? pickHook[2] + (travelZ - pickHook[2]) * (t / p1) : travelZ;
    else if (t <= p2) {
      s = p2 > p1 ? (t - p1) / (p2 - p1) : 1;
      z = travelZ;
    } else {
      s = 1;
      z = p2 < 1 ? travelZ + (placeHook[2] - travelZ) * ((t - p2) / (1 - p2)) : placeHook[2];
    }
    if (t >= 1) z = placeHook[2];
    const slew = a0 + da * s;
    const radius = pickRadius + (placeRadius - pickRadius) * s;
    return {
      slew,
      radius,
      hook: [crane.base[0] + radius * Math.cos(slew), crane.base[1] + radius * Math.sin(slew), z],
    };
  };
  return { pickHook, placeHook, pickRadius, placeRadius, travelZ, load, at, phases: [p1, p2] };
}

// ---------------------------------------------------------------------------------------------
// Box and triangle tests

export const boxesMeet = (a: Box, b: Box) =>
  a[0][0] <= b[1][0] &&
  b[0][0] <= a[1][0] &&
  a[0][1] <= b[1][1] &&
  b[0][1] <= a[1][1] &&
  a[0][2] <= b[1][2] &&
  b[0][2] <= a[1][2];

/** Triangle (9 numbers from `t[k]`) and box overlap, by the separating axis test. */
export function triangleMeetsBox(t: ArrayLike<number>, k: number, box: Box): boolean {
  const c = [0, 1, 2].map((i) => (box[0][i]! + box[1][i]!) / 2);
  const h = [0, 1, 2].map((i) => (box[1][i]! - box[0][i]!) / 2);
  const v = [0, 1, 2].map((j) => [0, 1, 2].map((i) => t[k + j * 3 + i]! - c[i]!));
  const [v0, v1, v2] = v as [number[], number[], number[]];
  // The box's own axes.
  for (let i = 0; i < 3; i++) {
    const lo = Math.min(v0[i]!, v1[i]!, v2[i]!);
    const hi = Math.max(v0[i]!, v1[i]!, v2[i]!);
    if (lo > h[i]! || hi < -h[i]!) return false;
  }
  const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const cross = (a: number[], b: number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const edges = [sub(v1, v0), sub(v2, v1), sub(v0, v2)];
  const separates = (axis: number[]) => {
    const r = h[0]! * Math.abs(axis[0]!) + h[1]! * Math.abs(axis[1]!) + h[2]! * Math.abs(axis[2]!);
    const p = [dot(v0, axis), dot(v1, axis), dot(v2, axis)];
    return Math.min(...p) > r || Math.max(...p) < -r;
  };
  // The triangle's plane.
  const n = cross(edges[0]!, edges[1]!);
  if (separates(n)) return false;
  // Edge × box axis.
  for (const e of edges)
    for (const a of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]) {
      const axis = cross(e, a);
      if (axis.some((x) => x !== 0) && separates(axis)) return false;
    }
  return true;
}

/**
 * Whether `p` lies inside the closed mesh `t`: the crossings of a ray from it (skewed off the
 * axes, so it misses edges and corners) are odd.
 */
function insideMesh(t: ArrayLike<number>, p: Point3): boolean {
  const d = [1, 0.000731, 0.000419];
  let crossings = 0;
  for (let k = 0; k + 8 < t.length; k += 9) {
    // Möller–Trumbore.
    const e1 = [t[k + 3]! - t[k]!, t[k + 4]! - t[k + 1]!, t[k + 5]! - t[k + 2]!];
    const e2 = [t[k + 6]! - t[k]!, t[k + 7]! - t[k + 1]!, t[k + 8]! - t[k + 2]!];
    const h = [
      d[1]! * e2[2]! - d[2]! * e2[1]!,
      d[2]! * e2[0]! - d[0]! * e2[2]!,
      d[0]! * e2[1]! - d[1]! * e2[0]!,
    ];
    const a = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(a) < 1e-12) continue;
    const s = [p[0] - t[k]!, p[1] - t[k + 1]!, p[2] - t[k + 2]!];
    const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / a;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1]! * e1[2]! - s[2]! * e1[1]!,
      s[2]! * e1[0]! - s[0]! * e1[2]!,
      s[0]! * e1[1]! - s[1]! * e1[0]!,
    ];
    const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / a;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / a > 0) crossings++;
  }
  return crossings % 2 === 1;
}

/**
 * Whether `box` meets the body (its triangles, or its bounds without them). A box wholly inside
 * a closed body meets none of its triangles: its centre is then found inside.
 */
export function bodyMeetsBox(body: LiftBody, box: Box): boolean {
  if (!boxesMeet(body.bounds, box)) return false;
  const t = body.triangles;
  if (!t) return true;
  for (let k = 0; k + 8 < t.length; k += 9) if (triangleMeetsBox(t, k, box)) return true;
  const c: Point3 = [0, 1, 2].map((i) => (box[0][i]! + box[1][i]!) / 2) as Point3;
  return insideMesh(t, c);
}

/**
 * The parts of the crane that move or stand, as boxes, for the clash check: the jib (tower:
 * level, from the counter-jib's end to the tip; mobile: the boom from the pivot to its tip, cut
 * into pieces) and, for the tower crane, the mast.
 */
export function craneBoxes(
  crane: Crane,
  baseZ: number,
  state: CraneState,
): { mast?: Box; jib: Box[] } {
  const [bx, by] = crane.base;
  const dir: Plan = [Math.cos(state.slew), Math.sin(state.slew)];
  const along = (from: Point3, to: Point3, size: number, step: number) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const n = Math.max(1, Math.ceil(len / step));
    const boxes: Box[] = [];
    for (let i = 0; i < n; i++) {
      const a = from.map((x, j) => x + ((to[j]! - x) * i) / n) as Point3;
      const b = from.map((x, j) => x + ((to[j]! - x) * (i + 1)) / n) as Point3;
      boxes.push([
        [
          Math.min(a[0], b[0]) - size / 2,
          Math.min(a[1], b[1]) - size / 2,
          Math.min(a[2], b[2]) - size / 2,
        ],
        [
          Math.max(a[0], b[0]) + size / 2,
          Math.max(a[1], b[1]) + size / 2,
          Math.max(a[2], b[2]) + size / 2,
        ],
      ]);
    }
    return boxes;
  };
  if (crane.kind === 'tower') {
    const z = baseZ + crane.height;
    const tail = crane.jibLength * counterJibShare;
    return {
      mast: [
        [bx - mastWidth / 2, by - mastWidth / 2, baseZ],
        [bx + mastWidth / 2, by + mastWidth / 2, z],
      ],
      jib: along(
        [bx - dir[0] * tail, by - dir[1] * tail, z + jibDepth / 2],
        [bx + dir[0] * crane.jibLength, by + dir[1] * crane.jibLength, z + jibDepth / 2],
        jibDepth,
        1000,
      ),
    };
  }
  const pivotZ = baseZ + crane.height;
  const rise = Math.sqrt(Math.max(0, crane.jibLength ** 2 - state.radius ** 2));
  return {
    jib: along(
      [bx, by, pivotZ],
      [bx + dir[0] * state.radius, by + dir[1] * state.radius, pivotZ + rise],
      jibDepth,
      1000,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Checks

export interface CraneWorld {
  /** Bodies of the BIM elements by ID (those the evaluation built). */
  bodies: ReadonlyMap<string, LiftBody>;
  /** Mass of an element: kg, or why it is not known. */
  mass(elementId: string): { kg: number } | { reason: string };
  /** Ground height in plan (the earthworks as on the lift's day are not followed). */
  ground(p: Plan): number;
}

/** How finely the lift's way is checked: a step of the hook at most (mm). */
const clashStep = 500;

/** The load clears what it meets by a few mm of tolerance (its box is shrunk by this, mm). */
const clashTolerance = 5;

/**
 * What a lift sees: the crane's base height, what stands while it is made (built or existing
 * elements, and those lifted before it) and its motion. `cache` shares work across lifts.
 */
export function liftScene(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: CraneWorld,
  lift: Lift,
  crane: Crane,
  body: LiftBody,
  time: LiftTime,
  cache: {
    lifted?: Map<string, number>;
    days?: Map<string, ReturnType<typeof siteOnDay>>;
  } = {},
): { baseZ: number; standing: [string, LiftBody][]; motion: LiftMotion } {
  const baseZ = craneBaseZ(crane, world.ground);
  const lifted =
    cache.lifted ??
    (() => {
      const times = liftTimes(doc, schedule);
      return new Map(
        (doc.site?.lifts ?? []).map((l) => [l.elementId, times.get(l.id)?.order ?? Infinity]),
      );
    })();
  let day = cache.days?.get(time.day);
  if (!day) {
    day = siteOnDay(doc, schedule, time.day);
    cache.days?.set(time.day, day);
  }
  const standing: [string, LiftBody][] = [];
  for (const [id, b] of world.bodies) {
    if (id === lift.elementId) continue;
    const state = day.states.get(id) ?? 'existing';
    // Lifted earlier and still being built; a later removal still takes it away.
    const before = state === 'building' && (lifted.get(id) ?? Infinity) < time.order;
    if (
      state === 'built' ||
      state === 'existing' ||
      state === 'removing' ||
      state === 'temporary' ||
      before
    )
      standing.push([id, b]);
  }
  const top = Math.max(-Infinity, ...standing.map(([, b]) => b.bounds[1][2]));
  const motion = liftMotion(crane, baseZ, lift, body, Number.isFinite(top) ? top : baseZ);
  return { baseZ, standing, motion };
}

/**
 * Everything wrong with the cranes and lifts. Lifts are checked in their order; a lift whose
 * crane is missing, or whose element has no body, is reported and skipped.
 */
export function checkCranes(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: CraneWorld,
): ConstructionDiagnostic[] {
  const site = doc.site;
  const cranes = site?.cranes ?? [];
  const lifts = site?.lifts ?? [];
  const out: ConstructionDiagnostic[] = [];
  const cranesById = new Map(cranes.map((c) => [c.id, c]));
  const times = liftTimes(doc, schedule);
  const lifted = new Map(lifts.map((l) => [l.elementId, times.get(l.id)?.order ?? Infinity]));
  const days = new Map<string, ReturnType<typeof siteOnDay>>();
  lifts.forEach((lift, i) => {
    const p = `$.site.lifts[${i}]`;
    const crane = cranesById.get(lift.craneId);
    const time = times.get(lift.id);
    if (!crane || !time) return;
    const name = `${lift.id} (${lift.elementId})`;
    const say = (code: string, message: string) => out.push({ code, path: p, message });
    if (!craneStands(doc, schedule, crane, time.day))
      say('crane-not-standing', `${name}: ${crane.name || crane.id} is not up on ${time.day}`);
    const body = world.bodies.get(lift.elementId);
    if (!body) return say('element-missing', `${name}: the element has no body to lift`);
    const { baseZ, standing, motion } = liftScene(doc, schedule, world, lift, crane, body, time, {
      lifted,
      days,
    });
    // Reach and the load chart.
    const reach = craneReach(crane);
    for (const [where, r] of [
      ['pick', motion.pickRadius],
      ['place', motion.placeRadius],
    ] as const)
      if (r > reach + 1e-6 || r < crane.minRadius - 1e-6)
        say(
          'out-of-reach',
          `${name}: the ${where} is ${(r / 1000).toFixed(1)} m out; ${crane.name || crane.id} reaches ${(crane.minRadius / 1000).toFixed(1)}–${(reach / 1000).toFixed(1)} m`,
        );
    const mass = world.mass(lift.elementId);
    if ('reason' in mass) say('mass-unknown', `${name}: the mass is not known (${mass.reason})`);
    else {
      const r = Math.max(motion.pickRadius, motion.placeRadius);
      const cap = capacityAt(crane, r);
      if (cap > 0 && mass.kg > cap)
        say(
          'overload',
          `${name}: ${Math.round(mass.kg).toLocaleString('en-US')} kg at ${(r / 1000).toFixed(1)} m; ${crane.name || crane.id} lifts ${cap.toLocaleString('en-US')} kg there`,
        );
    }
    if (motion.placeHook[2] > motion.travelZ + 1e-6 || motion.pickHook[2] > motion.travelZ + 1e-6)
      say('hook-height', `${name}: the hook does not reach that high`);
    // Clash: the load along its way and the jib while it slews. The load's own supports (what
    // its place touches, no higher than its top) are left out while it is lowered onto them: a
    // load lowered by h then only meets them where it meets them in place. Anything rising above
    // the load's top at its place is still checked all the way down.
    const placed: Box = [
      [body.bounds[0][0] - 1, body.bounds[0][1] - 1, body.bounds[0][2] - 1],
      [body.bounds[1][0] + 1, body.bounds[1][1] + 1, body.bounds[1][2] + 1],
    ];
    const supports = new Set(
      standing
        .filter(([, b]) => boxesMeet(b.bounds, placed) && b.bounds[1][2] <= placed[1][2])
        .map(([id]) => id),
    );
    // Everything standing, in one box: most of the way (above the frame) meets nothing.
    const all: Box | undefined = standing.length
      ? [
          [0, 1, 2].map((k) => Math.min(...standing.map(([, b]) => b.bounds[0][k]!))) as Point3,
          [0, 1, 2].map((k) => Math.max(...standing.map(([, b]) => b.bounds[1][k]!))) as Point3,
        ]
      : undefined;
    const meets = (box: Box, skip?: (id: string) => boolean) => {
      if (!all || !boxesMeet(all, box)) return [];
      return standing.filter(([id, b]) => !skip?.(id) && bodyMeetsBox(b, box)).map(([id]) => id);
    };
    const s0 = motion.at(motion.phases[0]);
    const s1 = motion.at(motion.phases[1]);
    // Each phase is sampled by its own moving geometry, so a long hoist leaves the slew its
    // share: up and down by the hook's travel, the slew by the jib's (or boom's) tip.
    const arc =
      Math.abs(s1.slew - s0.slew) *
        Math.max(motion.pickRadius, motion.placeRadius, crane.jibLength) +
      Math.abs(motion.placeRadius - motion.pickRadius);
    const lengths = [
      Math.abs(motion.travelZ - motion.pickHook[2]),
      arc,
      Math.abs(motion.travelZ - motion.placeHook[2]),
    ];
    const bounds = [0, motion.phases[0], motion.phases[1], 1];
    const us: number[] = [0];
    for (let ph = 0; ph < 3; ph++) {
      const a = bounds[ph]!;
      const b = bounds[ph + 1]!;
      if (b <= a) continue;
      const m = Math.min(2000, Math.max(4, Math.ceil(lengths[ph]! / clashStep)));
      const pts = Array.from({ length: m + 1 }, (_, k) => a + ((b - a) * k) / m);
      // The slew: halved further wherever the jib's (or boom's) tip moves more than a step
      // between samples (a mobile boom near its length rises fast as its radius changes).
      if (ph === 1) {
        const tip = (u: number): Point3 => {
          const st = motion.at(u);
          const r = crane.kind === 'tower' ? crane.jibLength : st.radius;
          const rise =
            crane.kind === 'tower' ? 0 : Math.sqrt(Math.max(0, crane.jibLength ** 2 - r ** 2));
          return [r * Math.cos(st.slew), r * Math.sin(st.slew), rise];
        };
        const apart = (x: number, y: number) => {
          const [p, q] = [tip(x), tip(y)];
          return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > clashStep;
        };
        for (let k = 0; k + 1 < pts.length && pts.length < 4000; )
          if (pts[k + 1]! - pts[k]! > 1e-12 && apart(pts[k]!, pts[k + 1]!))
            pts.splice(k + 1, 0, (pts[k]! + pts[k + 1]!) / 2);
          else k++;
      }
      us.push(...pts.slice(1));
    }
    const hit = new Set<string>();
    let jibHit: string | undefined;
    const t = clashTolerance;
    const loadAt = (hook: Point3): Box => [
      [
        hook[0] + motion.load[0][0] + t,
        hook[1] + motion.load[0][1] + t,
        hook[2] + motion.load[0][2] + t,
      ],
      [
        hook[0] + motion.load[1][0] - t,
        hook[1] + motion.load[1][1] - t,
        hook[2] + motion.load[1][2] - t,
      ],
    ];
    let previous: Box | undefined;
    for (let k = 0; k < us.length; k++) {
      const u = us[k]!;
      const s = motion.at(u);
      const lowering = u > motion.phases[1];
      // The way the load swept since the last sample, as one box: nothing narrower than a
      // step slips between two samples.
      const here = loadAt(s.hook);
      const box: Box = previous
        ? [
            [0, 1, 2].map((i) => Math.min(here[0][i]!, previous![0][i]!)) as Point3,
            [0, 1, 2].map((i) => Math.max(here[1][i]!, previous![1][i]!)) as Point3,
          ]
        : here;
      previous = here;
      for (const id of meets(box, (id) => hit.has(id) || (lowering && supports.has(id))))
        hit.add(id);
      // The jib moves only while slewing (and the boom with the radius): its ends are enough.
      if (
        !jibHit &&
        (k === 0 || k === us.length - 1 || (u >= motion.phases[0] && u <= motion.phases[1]))
      ) {
        const parts = craneBoxes(crane, baseZ, s);
        for (const jb of [...parts.jib, ...(parts.mast ? [parts.mast] : [])]) {
          const found = meets(jb)[0];
          if (found) {
            jibHit = found;
            break;
          }
        }
      }
    }
    if (hit.size)
      say(
        'load-clash',
        `${name}: the load hits ${[...hit].slice(0, 5).join(', ')}${hit.size > 5 ? ' …' : ''}`,
      );
    if (jibHit) say('jib-clash', `${name}: ${crane.name || crane.id} hits ${jibHit}`);
  });
  // Slewing circles that overlap while both cranes stand.
  for (let i = 0; i < cranes.length; i++)
    for (let j = i + 1; j < cranes.length; j++) {
      const a = cranes[i]!;
      const b = cranes[j]!;
      const sweep = (c: Crane) =>
        // A mobile crane's boom sweeps no farther (level) than its farthest chart radius.
        c.kind === 'tower' ? c.jibLength : craneReach(c);
      const gap = hypot(a.base, b.base);
      if (gap >= sweep(a) + sweep(b)) continue;
      // Both stand on some day exactly when both stand on the later of their first days.
      const first = (c: Crane) => {
        const task = doc.tasks.find((t) => t.id === c.fromTaskId);
        const planned = schedule.byId.get(c.fromTaskId);
        return task && planned ? taskSpan(task, planned).start : undefined;
      };
      const fa = first(a);
      const fb = first(b);
      if (!fa || !fb) continue;
      const day = fa > fb ? fa : fb;
      const both = craneStands(doc, schedule, a, day) && craneStands(doc, schedule, b, day);
      if (!both) continue;
      const za = craneBaseZ(a, world.ground) + a.height;
      const zb = craneBaseZ(b, world.ground) + b.height;
      out.push({
        code: 'slew-overlap',
        path: `$.site.cranes[${j}]`,
        message: `${a.name || a.id} and ${b.name || b.id} slew over the same ground (jibs ${(Math.abs(za - zb) / 1000).toFixed(1)} m apart in height)`,
      });
    }
  return out;
}
