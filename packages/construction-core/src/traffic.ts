/**
 * CS5 (docs/cad/construction-site.md): people and vehicles on the site. Workers and trucks follow
 * routes (polylines on the ground at a speed, setting off at times of the working day while a task
 * runs); danger zones are drawn by hand or follow from the plan (under each lift's load and inside
 * its crane's slewing circle while it lifts, along the top edge of an open cut). Each trip is
 * followed through the day and every time it comes into a zone is listed by date and time; the
 * trucks through each gate are counted by day. Pure data and arithmetic: no React, no kernel.
 */
import { dayString, utcDay } from '@editor-platform/time-axis';
import { craneReach, craneStands, liftTimes, type Crane } from './crane';
import type { ConstructionDiagnostic, ConstructionDocument } from './model';
import { taskPhase, taskSpan, type ConstructionSchedule } from './schedule';
import {
  distanceToEdges,
  insidePolygon,
  siteLimits,
  type Earthwork,
  type Plan,
  type Point3,
  type Terrain,
} from './site';

export type RouteKind = 'worker' | 'truck';
export const routeKinds: readonly RouteKind[] = Object.freeze(['worker', 'truck']);

export interface SiteRoute {
  id: string;
  name: string;
  kind: RouteKind;
  /** The way on the ground, in plan (mm): 2 points or more. */
  path: Plan[];
  /** km/h. */
  speedKmh: number;
  /** Taken on every working day this task runs. */
  taskId: string;
  /** When each trip sets off ("HH:MM"), in order. */
  departures: string[];
  /** Each trip comes back along the way once it reaches the end. */
  returns?: boolean;
}

export interface SiteZone {
  id: string;
  name: string;
  /** The zone in plan, a simple polygon (mm). */
  outline: Plan[];
  /** In force while this task runs. */
  taskId: string;
  /** Only between these times of the day ("HH:MM"); all the working day when absent. */
  hours?: [string, string];
}

/** The working day, "HH:MM" to "HH:MM": 08:00–17:00 when absent. */
export interface SiteHours {
  start: string;
  end: string;
}

export const trafficLimits = Object.freeze({
  routes: 200,
  zones: 500,
  departures: 200,
  pathPoints: 200,
  /** km/h. */
  maxSpeed: 100,
});

/** How far a person or a truck keeps from a danger to be clear of it (mm). */
export const hazardMargin = { worker: 1000, truck: 2000 } as const;
/** How long each lift takes, of the working day (min). */
export const liftMinutes = 20;
/** The working day when the site gives none. */
export const defaultHours: SiteHours = { start: '08:00', end: '17:00' };

/** Minutes of a "HH:MM" time, or undefined when it is not one. */
export function clockMinutes(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
const pad = (n: number) => String(n).padStart(2, '0');
export const clockText = (minutes: number) => {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
/** "HH:MM:SS" of minutes of the day. */
export const clockSeconds = (minutes: number) => {
  const s = Math.max(0, Math.min(86399, Math.round(minutes * 60)));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= siteLimits.coordinate;
const plan = (v: unknown): v is Plan =>
  Array.isArray(v) && v.length === 2 && v.every((c) => finite(c));

/** Checks the site's routes, zones and hours (`ids` holds the site's IDs so far, and gets these). */
export function validateTraffic(
  routes: unknown,
  zones: unknown,
  hours: unknown,
  taskIds: ReadonlySet<string>,
  ids: Set<string>,
  isId: (v: unknown) => v is string,
  isText: (v: unknown) => v is string,
  simple: (poly: readonly Plan[]) => boolean,
): ConstructionDiagnostic[] {
  const out: ConstructionDiagnostic[] = [];
  const bad = (code: string, path: string, message = code) => out.push({ code, path, message });
  const only = (v: Rec, keys: string[], path: string) => {
    for (const k of Object.keys(v))
      if (!keys.includes(k)) out.push({ code: 'unknown-key', path: `${path}.${k}`, message: k });
  };
  const id = (v: unknown, path: string) => {
    if (!isId(v)) return bad('id', path);
    if (ids.has(v)) bad('duplicate-id', path, `${v} is used twice`);
    ids.add(v);
  };
  const task = (v: unknown, path: string) => {
    if (!isId(v)) bad('id', path);
    else if (!taskIds.has(v)) bad('task-missing', path, v);
  };
  const span = (v: unknown, path: string) => {
    if (!Array.isArray(v) || v.length !== 2) return bad('hours', path, '["HH:MM", "HH:MM"]');
    const [a, b] = v.map(clockMinutes);
    if (a === undefined || b === undefined || a >= b)
      bad('hours', path, 'two "HH:MM" times, the first earlier');
  };
  if (hours !== undefined) {
    if (!record(hours)) bad('hours', '$.site.hours');
    else {
      only(hours, ['start', 'end'], '$.site.hours');
      span([hours.start, hours.end], '$.site.hours');
    }
  }
  if (routes !== undefined) {
    if (!Array.isArray(routes) || routes.length > trafficLimits.routes)
      bad('limit-exceeded', '$.site.routes', `at most ${trafficLimits.routes}`);
    else
      routes.forEach((r, i) => {
        const p = `$.site.routes[${i}]`;
        if (!record(r)) return bad('route', p);
        only(r, ['id', 'name', 'kind', 'path', 'speedKmh', 'taskId', 'departures', 'returns'], p);
        id(r.id, `${p}.id`);
        if (!isText(r.name)) bad('name', `${p}.name`);
        if (!routeKinds.includes(r.kind as never)) bad('kind', `${p}.kind`);
        const path = r.path;
        if (!Array.isArray(path) || path.length < 2 || path.length > trafficLimits.pathPoints)
          bad('route', `${p}.path`, `2 to ${trafficLimits.pathPoints} points`);
        else if (!path.every(plan)) bad('coordinate', `${p}.path`, 'points are [x, y] in mm');
        else if (pathLength(path) <= 0) bad('route', `${p}.path`, 'the way has no length');
        if (
          !(
            typeof r.speedKmh === 'number' &&
            r.speedKmh > 0 &&
            r.speedKmh <= trafficLimits.maxSpeed
          )
        )
          bad('speed', `${p}.speedKmh`, `above 0, at most ${trafficLimits.maxSpeed} km/h`);
        task(r.taskId, `${p}.taskId`);
        const d = r.departures;
        if (!Array.isArray(d) || !d.length || d.length > trafficLimits.departures)
          bad('departures', `${p}.departures`, `1 to ${trafficLimits.departures} times`);
        else {
          const m = d.map(clockMinutes);
          if (m.some((x) => x === undefined))
            bad('departures', `${p}.departures`, 'times are "HH:MM"');
          else if (m.some((x, k) => k > 0 && x! <= m[k - 1]!))
            bad('departures', `${p}.departures`, 'in order, each once');
          else if (
            Array.isArray(path) &&
            path.length >= 2 &&
            path.every(plan) &&
            typeof r.speedKmh === 'number' &&
            r.speedKmh > 0
          ) {
            // A trip is kept within its day: the last one must be back (or there) by midnight.
            const one = pathLength(path as Plan[]) / perMinute(r.speedKmh);
            const last = m[m.length - 1]! + (r.returns === true ? 2 * one : one);
            if (last > 24 * 60)
              bad(
                'departures',
                `${p}.departures`,
                `the trip from ${d[d.length - 1]} runs past midnight`,
              );
          }
        }
        if (r.returns !== undefined && typeof r.returns !== 'boolean')
          bad('returns', `${p}.returns`);
      });
  }
  if (zones !== undefined) {
    if (!Array.isArray(zones) || zones.length > trafficLimits.zones)
      bad('limit-exceeded', '$.site.zones', `at most ${trafficLimits.zones}`);
    else
      zones.forEach((z, i) => {
        const p = `$.site.zones[${i}]`;
        if (!record(z)) return bad('zone', p);
        only(z, ['id', 'name', 'outline', 'taskId', 'hours'], p);
        id(z.id, `${p}.id`);
        if (!isText(z.name)) bad('name', `${p}.name`);
        const o = z.outline;
        if (!Array.isArray(o) || o.length < 3 || o.length > siteLimits.outlinePoints)
          bad('limit-exceeded', `${p}.outline`, `3 to ${siteLimits.outlinePoints} corners`);
        else if (!o.every(plan)) bad('coordinate', `${p}.outline`, 'corners are [x, y] in mm');
        else if (!simple(o as Plan[])) bad('polygon', `${p}.outline`, 'not a simple polygon');
        task(z.taskId, `${p}.taskId`);
        if (z.hours !== undefined) span(z.hours, `${p}.hours`);
      });
  }
  return out;
}

const pathLength = (path: readonly Plan[]) => {
  let len = 0;
  for (let k = 1; k < path.length; k++)
    len += Math.hypot(path[k]![0] - path[k - 1]![0], path[k]![1] - path[k - 1]![1]);
  return len;
};

/** The working day of the site, in minutes. */
export function siteHours(doc: ConstructionDocument): [number, number] {
  const h = doc.site?.hours ?? defaultHours;
  return [clockMinutes(h.start) ?? 480, clockMinutes(h.end) ?? 1020];
}

/** Whether `day` is a working day of the document's calendar. */
export function workingDay(doc: Pick<ConstructionDocument, 'calendar'>, day: string): boolean {
  const n = utcDay(day);
  if (n === null) return false;
  return (
    doc.calendar.workWeekdays.includes(((((n + 4) % 7) + 7) % 7) as never) &&
    !doc.calendar.holidays.includes(day)
  );
}

// ---------------------------------------------------------------------------------------------
// Trips

export interface Trip {
  routeId: string;
  kind: RouteKind;
  /** Minutes of the day it sets off and arrives (back, when it returns). */
  start: number;
  end: number;
  /** Where it is (plan, mm) at a time of the day within its trip. */
  at(minutes: number): Plan;
}

/** mm a minute at `kmh`. */
const perMinute = (kmh: number) => (kmh * 1e6) / 60;

/** A route's trip setting off at `start` (minutes of the day). */
export function routeTrip(route: SiteRoute, start: number): Trip {
  const len = pathLength(route.path);
  const one = len / perMinute(route.speedKmh);
  const cum = [0];
  for (let k = 1; k < route.path.length; k++)
    cum.push(
      cum[k - 1]! +
        Math.hypot(
          route.path[k]![0] - route.path[k - 1]![0],
          route.path[k]![1] - route.path[k - 1]![1],
        ),
    );
  const along = (s: number): Plan => {
    const d = Math.max(0, Math.min(len, s));
    let k = 1;
    while (k < cum.length - 1 && cum[k]! < d) k++;
    const [a, b] = [route.path[k - 1]!, route.path[k]!];
    const f = cum[k]! > cum[k - 1]! ? (d - cum[k - 1]!) / (cum[k]! - cum[k - 1]!) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const total = route.returns ? 2 * one : one;
  return {
    routeId: route.id,
    kind: route.kind,
    start,
    end: start + total,
    at: (t) => {
      const u = Math.max(0, Math.min(total, t - start));
      const s = u <= one ? u : 2 * one - u;
      return along(one > 0 ? (s / one) * len : 0);
    },
  };
}

/** The trips on `day`: each route's departures, while its task runs on a working day. */
export function tripsOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  day: string,
): Trip[] {
  if (!workingDay(doc, day)) return [];
  const out: Trip[] = [];
  for (const r of doc.site?.routes ?? []) {
    const task = doc.tasks.find((t) => t.id === r.taskId);
    const planned = schedule.byId.get(r.taskId);
    if (!task || !planned || taskPhase(task, planned, day) !== 'running') continue;
    for (const d of r.departures) out.push(routeTrip(r, clockMinutes(d)!));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Danger zones

export type HazardKind = 'zone' | 'load' | 'slew' | 'edge';

/** A danger in force on a day: a shape in plan between two times. */
export interface Hazard {
  id: string;
  kind: HazardKind;
  name: string;
  /** Minutes of the day. */
  from: number;
  to: number;
  /** Distance (mm) from the danger at a point of the plan: 0 inside. */
  distance(p: Plan): number;
  /** The shape, for drawing: a polygon in plan. */
  outline: Plan[];
}

const circle = (c: Plan, r: number, n = 48): Plan[] =>
  Array.from({ length: n }, (_, k) => [
    c[0] + r * Math.cos((2 * Math.PI * k) / n),
    c[1] + r * Math.sin((2 * Math.PI * k) / n),
  ]);

/** Distance from `p` to the segment a–b. */
function toSegment(p: Plan, a: Plan, b: Plan): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

const polygonDistance = (poly: readonly Plan[]) => (p: Plan) =>
  insidePolygon(poly, p) ? 0 : distanceToEdges(poly, p);

/** A load's plan box (centred on the hook), as given by the lift. */
export interface LoadFootprint {
  /** Half the load's size in plan, x and y (mm). */
  half: Plan;
}

/** The world the derived hazards need: the lifts' places and load sizes, and the ground. */
export interface HazardWorld {
  /** Where each lifted element is placed (plan centre) and half its plan size. */
  place(elementId: string): { centre: Plan; half: Plan } | undefined;
  terrain: Terrain;
}

/** The lifts made on `day`, in their order. */
function liftsOnDay(doc: ConstructionDocument, schedule: ConstructionSchedule, day: string) {
  const times = doc.site?.lifts?.length ? liftTimes(doc, schedule) : new Map();
  return (doc.site?.lifts ?? [])
    .filter((l) => times.get(l.id)?.day === day)
    .sort((a, b) => times.get(a.id)!.order - times.get(b.id)!.order);
}

/** How many lifts fit in a working day from `start` to `end` (minutes). */
const liftsInDay = (start: number, end: number) =>
  Math.max(0, Math.floor((end - start) / liftMinutes));

/** A day whose lifts do not all fit in the working day: those left over, by ID. */
export interface LiftOverflow {
  day: string;
  liftIds: string[];
}

/**
 * The days on which the lifts, `liftMinutes` each one after another, run past the end of the
 * working day. Their dangers are not drawn (they have no time in the day): the schedule needs more
 * days for those tasks, or longer hours.
 */
export function liftsPastDayEnd(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
): LiftOverflow[] {
  if (!doc.site?.lifts?.length) return [];
  const [start, end] = siteHours(doc);
  const fit = liftsInDay(start, end);
  const times = liftTimes(doc, schedule);
  const byDay = new Map<string, { id: string; order: number }[]>();
  for (const l of doc.site.lifts) {
    const t = times.get(l.id);
    if (t) byDay.set(t.day, [...(byDay.get(t.day) ?? []), { id: l.id, order: t.order }]);
  }
  return [...byDay]
    .filter(([, ls]) => ls.length > fit)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, ls]) => ({
      day,
      liftIds: ls
        .sort((a, b) => a.order - b.order)
        .slice(fit)
        .map((l) => l.id),
    }));
}

/**
 * The dangers in force on `day`: the site's own zones while their tasks run; under each lift's
 * load (its way from pick to place, widened by the load's half size) and its crane's slewing
 * circle while it lifts; along the top edge of each cut from the start of its work on.
 */
export function hazardsOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: HazardWorld,
  day: string,
): Hazard[] {
  const out: Hazard[] = [];
  const [dayStart, dayEnd] = siteHours(doc);
  const running = (taskId: string) => {
    const task = doc.tasks.find((t) => t.id === taskId);
    const planned = schedule.byId.get(taskId);
    return !!task && !!planned && taskPhase(task, planned, day) === 'running';
  };
  for (const z of doc.site?.zones ?? []) {
    if (!running(z.taskId)) continue;
    const [from, to] = z.hours ? z.hours.map((h) => clockMinutes(h)!) : [dayStart, dayEnd];
    out.push({
      id: z.id,
      kind: 'zone',
      name: z.name,
      from: from!,
      to: to!,
      distance: polygonDistance(z.outline),
      outline: z.outline,
    });
  }
  // Lifts: in their order on the day, one after another from the start of the working day. Those
  // that do not fit in the day are left out here and named by `liftsPastDayEnd`.
  const today = liftsOnDay(doc, schedule, day).slice(0, liftsInDay(dayStart, dayEnd));
  const cranes = new Map((doc.site?.cranes ?? []).map((c) => [c.id, c]));
  /** Each crane's lifting times: separate spells, joined only where they meet or overlap. */
  const slewing = new Map<string, [number, number][]>();
  today.forEach((l, k) => {
    const crane = cranes.get(l.craneId);
    const place = world.place(l.elementId);
    if (!crane || !place) return;
    const from = dayStart + k * liftMinutes;
    const to = from + liftMinutes;
    const way = slewPath(crane, [l.pick[0], l.pick[1]], place.centre);
    const r = Math.hypot(...place.half);
    out.push({
      id: l.id,
      kind: 'load',
      name: `Under the load of ${l.elementId}`,
      from,
      to,
      distance: (p) => {
        let d = Infinity;
        for (let i = 1; i < way.length; i++) d = Math.min(d, toSegment(p, way[i - 1]!, way[i]!));
        return Math.max(0, d - r - edgeTolerance);
      },
      outline: corridor(way, r),
    });
    const spells = slewing.get(crane.id) ?? [];
    const last = spells[spells.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else spells.push([from, to]);
    slewing.set(crane.id, spells);
  });
  for (const [id, spells] of slewing) {
    const crane = cranes.get(id)!;
    if (!craneStands(doc, schedule, crane, day)) continue;
    const reach = crane.kind === 'tower' ? crane.jibLength : craneReach(crane);
    // One danger for each spell (the same circle, so the same ID).
    for (const [from, to] of spells)
      out.push({
        id: `${id}:slew`,
        kind: 'slew',
        name: `${crane.name || crane.id} slewing`,
        from,
        to,
        distance: (p) =>
          Math.max(0, Math.hypot(p[0] - crane.base[0], p[1] - crane.base[1]) - reach),
        outline: circle(crane.base, reach),
      });
  }
  // Open cuts: from the start of their work on, the band out to the top of their side.
  for (const w of doc.site?.earthworks ?? []) {
    if (w.kind !== 'cut') continue;
    const task = doc.tasks.find((t) => t.id === w.taskId);
    const planned = schedule.byId.get(w.taskId);
    if (!task || !planned || day < taskSpan(task, planned).start) continue;
    const terrain = world.terrain;
    // The fence stands on the top edge, where the warnings measure from (the outline is the
    // floor of the cut).
    const edge = w.slope > 0 ? topEdge(w, terrain) : w.outline.slice();
    out.push({
      id: `${w.id}:edge`,
      kind: 'edge',
      name: `Edge of ${w.name || w.id}`,
      from: dayStart,
      to: dayEnd,
      distance: edgeDistance(w, terrain, edge),
      outline: edge,
    });
  }
  return out;
}

/**
 * Distance (mm) from `p` to a cut's open side: 0 inside the outline or over its side (where the
 * side, rising `1 / slope` a mm out from the outline, is still below the ground). Outside, the
 * nearest point of the side's top edge, where the side meets the ground: so rising ground beyond
 * the cut widens the band. `edge` is the cut's top edge, traced once (see `topEdge`).
 */
function edgeDistance(w: Earthwork, terrain: Terrain, edge: readonly Plan[]): (p: Plan) => number {
  return (p) => {
    if (insidePolygon(w.outline, p)) return 0;
    const [, d] = nearestOnOutline(w.outline, p);
    if (w.slope <= 0 || d === 0) return d;
    if (terrain.heightAt(p) - (w.levelZ + d / w.slope) > 0) return 0;
    let best = d;
    for (let i = 0; i < edge.length; i++)
      best = Math.min(best, toSegment(p, edge[i]!, edge[(i + 1) % edge.length]!));
    return Math.max(0, best - edgeTolerance);
  };
}

/** Plan step along the outline when tracing a cut's top edge (mm). */
const edgeStep = 250;
/**
 * How far (mm) the traced corners may fall inside the true round edge: their fans are fine enough
 * for it, and a distance is taken that much less, so it never reads clearer than it is.
 */
const edgeTolerance = 5;

/**
 * The top edge of a cut's side, as a closed polyline: from points along the outline (and fans of
 * directions round its corners), out to where the side meets the ground.
 */
function topEdge(w: Earthwork, terrain: Terrain): Plan[] {
  const poly = w.outline;
  const n = poly.length;
  // Outward normals by the outline's turn (counter-clockwise: the right side is out).
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1;
  const normal = (i: number): Plan => {
    const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(sign * (b[1] - a[1])) / l, (-sign * (b[0] - a[0])) / l];
  };
  // The survey's triangle edges (once each): the ground is planar between them.
  const seams: [Point3, Point3][] = [];
  {
    const seen = new Set<string>();
    const { points, triangles } = terrain;
    for (let t = 0; t < triangles.length; t += 3)
      for (let j = 0; j < 3; j++) {
        const [i0, i1] = [triangles[t + j]!, triangles[t + ((j + 1) % 3)]!];
        const key = i0 < i1 ? `${i0},${i1}` : `${i1},${i0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seams.push([points[i0]!, points[i1]!]);
      }
  }
  /** How far out from `q` along `u` the side meets the ground (its farthest meeting). */
  const out = (q: Plan, u: Plan): Plan => {
    const open = (e: number) =>
      terrain.heightAt([q[0] + u[0] * e, q[1] + u[1] * e]) - (w.levelZ + e / w.slope);
    // From `from` (ground above the side) out by doubling steps until the side is above the
    // ground (at most 1 km), then halve.
    const cross = (from: number) => {
      let [lo, hi] = [from, from + edgeStep];
      while (open(hi) > 0 && hi < 1e6) [lo, hi] = [hi, hi * 2];
      if (open(hi) > 0) return hi;
      while (hi - lo > 1) {
        const m = (lo + hi) / 2;
        if (open(m) > 0) lo = m;
        else hi = m;
      }
      return lo;
    };
    let e = open(0) > 0 ? cross(0) : 0;
    // Ground that dips under the side and rises above it again further out is cut too: between
    // two seams both ground and side are planar along the way, so the farthest seam with the
    // ground above the side starts the last stretch that is cut.
    let far = -1;
    for (const [p, r] of seams) {
      const d: Plan = [r[0] - p[0], r[1] - p[1]];
      const den = u[0] * d[1] - u[1] * d[0];
      if (!den) continue;
      const w0: Plan = [p[0] - q[0], p[1] - q[1]];
      const t = (w0[0] * d[1] - w0[1] * d[0]) / den;
      const f = (w0[0] * u[1] - w0[1] * u[0]) / den;
      if (f >= 0 && f <= 1 && t > e && t > far && open(t) > 0) far = t;
    }
    if (far > e) e = cross(far);
    return [q[0] + u[0] * e, q[1] + u[1] * e];
  };
  const edge: Plan[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
    const u = normal(i);
    // Round the corner at `a`, from the previous side's normal to this one's.
    const v = normal((i + n - 1) % n);
    const turn = Math.atan2(v[0] * u[1] - v[1] * u[0], v[0] * u[0] + v[1] * u[1]);
    if (turn * sign > 0) {
      const a0 = Math.atan2(v[1], v[0]);
      const dir = (t: number): Plan => [Math.cos(a0 + t), Math.sin(a0 + t)];
      // The fan's radius: its widest of both sides and the middle (with room for the ground).
      const r =
        Math.max(
          ...[0, turn / 2, turn].map((t) => {
            const q = out(a, dir(t));
            return Math.hypot(q[0] - a[0], q[1] - a[1]);
          }),
        ) *
          1.5 +
        edgeStep;
      // A chord of angle θ falls r (1 − cos θ/2) inside its arc: keep that within the tolerance.
      const chord = 2 * Math.acos(Math.max(-1, 1 - edgeTolerance / r));
      const steps = Math.min(3600, Math.ceil(Math.abs(turn) / chord));
      // On sloping ground the edge round a corner is no arc (its radius changes with the
      // direction): halve a step again while the edge at its middle, or a quarter either side,
      // falls more than half the tolerance off the chord.
      const off = (p: Plan, q: Plan, m: Plan) => {
        const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
        const l = Math.hypot(dx, dy);
        return l ? Math.abs((m[0] - p[0]) * dy - (m[1] - p[1]) * dx) / l : 0;
      };
      const refine = (t0: number, p0: Plan, t1: number, p1: Plan, depth: number) => {
        const tm = (t0 + t1) / 2;
        const pm = out(a, dir(tm));
        const near = [0.25, 0.75].map((f) => out(a, dir(t0 + (t1 - t0) * f)));
        if (
          depth < 12 &&
          Math.max(off(p0, p1, pm), ...near.map((m) => off(p0, p1, m))) > edgeTolerance / 2
        ) {
          refine(t0, p0, tm, pm, depth + 1);
          edge.push(pm);
          refine(tm, pm, t1, p1, depth + 1);
        }
      };
      let [t, p] = [0, out(a, dir(0))];
      for (let k = 1; k <= steps; k++) {
        const tk = (turn * k) / steps;
        const pk = out(a, dir(tk));
        refine(t, p, tk, pk, 0);
        if (k < steps) edge.push(pk);
        [t, p] = [tk, pk];
      }
    }
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(l / edgeStep));
    const at = new Set<number>();
    for (let k = 0; k < steps; k++) at.add(k / steps);
    // The side's face meets the ground in a line within each triangle of the survey, bending
    // only where it crosses a triangle's edge: follow it there too, so a ridge between two
    // steps is not cut off.
    const { points, triangles } = terrain;
    const face = (p: Point3) =>
      p[2] - (w.levelZ + ((p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1]) / w.slope);
    for (let t = 0; t < triangles.length; t += 3)
      for (let j = 0; j < 3; j++) {
        const [p, q] = [points[triangles[t + j]!]!, points[triangles[t + ((j + 1) % 3)]!]!];
        const [fp, fq] = [face(p), face(q)];
        if (fp === fq || fp > 0 === fq > 0) continue;
        const f = fp / (fp - fq);
        const x: Plan = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
        const along = ((x[0] - a[0]) * (b[0] - a[0]) + (x[1] - a[1]) * (b[1] - a[1])) / (l * l);
        if (along > 0 && along < 1 && (x[0] - a[0]) * u[0] + (x[1] - a[1]) * u[1] >= 0)
          at.add(along);
      }
    for (const s of [...at].sort((x, y) => x - y))
      edge.push(out([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s], u));
    edge.push(out(b, u));
  }
  return edge;
}

/** The point of a closed outline nearest `p`, and its distance. */
function nearestOnOutline(poly: readonly Plan[], p: Plan): [Plan, number] {
  let best: [Plan, number] = [poly[0]!, Infinity];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q: Plan = [a[0] + dx * t, a[1] + dy * t];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best[1]) best = [q, d];
  }
  return best;
}

/** The hook's way in plan, pick to place, slewing the short way round with the radius changing. */
function slewPath(crane: Crane, pick: Plan, place: Plan): Plan[] {
  const c = crane.base;
  const a0 = Math.atan2(pick[1] - c[1], pick[0] - c[0]);
  let da = Math.atan2(place[1] - c[1], place[0] - c[0]) - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const r0 = Math.hypot(pick[0] - c[0], pick[1] - c[1]);
  const r1 = Math.hypot(place[0] - c[0], place[1] - c[1]);
  // Steps fine enough that a chord falls at most `edgeTolerance` off the hook's way (the
  // distance under the load is then taken that much less): along s the way's second derivative
  // is 2 Δr Δa (across) − r Δa² (inwards), and a chord of a step h strays at most h² |P''| / 8.
  const curve = 2 * Math.abs((r1 - r0) * da) + Math.max(r0, r1) * da * da;
  const h = curve > 0 ? Math.sqrt((8 * edgeTolerance) / curve) : 1;
  const n = Math.max(2, Math.min(3600, Math.ceil(1 / h)));
  return Array.from({ length: n + 1 }, (_, k) => {
    const s = k / n;
    const r = r0 + (r1 - r0) * s;
    const a = a0 + da * s;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  });
}

/** A polyline widened by `r` on both sides, as one outline (for drawing). */
function corridor(way: readonly Plan[], r: number): Plan[] {
  // A lift straight up (pick over place): the load's round footprint there.
  const first = way[0]!;
  if (way.every((p) => p[0] === first[0] && p[1] === first[1])) return circle(first, r);
  const left: Plan[] = [];
  const right: Plan[] = [];
  way.forEach((p, k) => {
    const a = way[Math.max(0, k - 1)]!;
    const b = way[Math.min(way.length - 1, k + 1)]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n: Plan = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    left.push([p[0] + n[0] * r, p[1] + n[1] * r]);
    right.push([p[0] - n[0] * r, p[1] - n[1] * r]);
  });
  // Round caps over both ends: the load's footprint at the pick and at the place.
  const cap = (p: Plan, from: Plan): Plan[] => {
    const a0 = Math.atan2(from[1] - p[1], from[0] - p[0]);
    return Array.from({ length: 15 }, (_, k) => {
      const a = a0 - (Math.PI * (k + 1)) / 16;
      return [p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)];
    });
  };
  const end = way[way.length - 1]!;
  return [
    ...left,
    ...cap(end, left[left.length - 1]!),
    ...right.reverse(),
    ...cap(first, right[0]!),
  ];
}

// ---------------------------------------------------------------------------------------------
// Approaches

/** A trip coming into a danger zone: from when to when, and how close. */
export interface Approach {
  day: string;
  routeId: string;
  kind: RouteKind;
  /** The trip's departure ("HH:MM"). */
  departure: string;
  hazardId: string;
  hazardKind: HazardKind;
  hazardName: string;
  /** "HH:MM:SS" it comes within the margin, and leaves it. */
  from: string;
  to: string;
  /** The closest it comes (mm, 0 inside). */
  closest: number;
}

/** How finely a trip is followed: at most this far between samples (mm). */
const tripStep = 250;
/** The finest way (mm) looked at between two samples for a graze of the margin. */
const grazeStep = 5;
/** How finely (min) the times a trip comes within a margin and leaves it are found: a second. */
const crossStep = 1 / 60;

/**
 * Every time a trip on `day` comes within its margin (`hazardMargin`) of a danger in force then;
 * by time, then route.
 */
export function approachesOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: HazardWorld,
  day: string,
): Approach[] {
  const hazards = hazardsOnDay(doc, schedule, world, day);
  const routes = new Map((doc.site?.routes ?? []).map((r) => [r.id, r]));
  const out: (Approach & { t: number })[] = [];
  for (const trip of tripsOnDay(doc, schedule, day)) {
    const route = routes.get(trip.routeId)!;
    const margin = hazardMargin[trip.kind];
    const speed = perMinute(route.speedKmh);
    const travel = speed * (trip.end - trip.start);
    const n = Math.max(1, Math.ceil(travel / tripStep));
    for (const h of hazards) {
      if (h.to <= trip.start || h.from >= trip.end) continue;
      let open: { t: number; closest: number } | undefined;
      const close = (t: number) => {
        if (!open) return;
        out.push({
          day,
          routeId: trip.routeId,
          kind: trip.kind,
          departure: clockText(trip.start),
          hazardId: h.id,
          hazardKind: h.kind,
          hazardName: h.name,
          from: clockSeconds(open.t),
          to: clockSeconds(t),
          closest: Math.round(open.closest),
          t: open.t,
        });
        open = undefined;
      };
      // Followed only while the danger is in force, from its start (or the departure) to its
      // end (or the arrival): a short spell can't fall between two samples.
      const t0 = Math.max(trip.start, h.from);
      const t1 = Math.min(trip.end, h.to);
      const m = Math.max(1, Math.ceil((n * (t1 - t0)) / (trip.end - trip.start || 1)));
      const visit = (t: number, d: number) => {
        if (d <= margin) {
          if (!open) open = { t, closest: d };
          else open.closest = Math.min(open.closest, d);
        } else close(t);
      };
      // Between two clear samples the way may still graze the margin, and between two samples
      // inside it the way may still get out: the distance changes no faster than the trip
      // moves, so where that could happen within it, look between them (down to `grazeStep`).
      const between = (ta: number, da: number, tb: number, db: number) => {
        const way = speed * (tb - ta);
        // Where the two straddle the margin, look between them too, so the times it comes in
        // and goes out are found to `crossStep`, not to the samples.
        const crosses = da <= margin !== db <= margin;
        if (
          crosses
            ? tb - ta < crossStep
            : way < grazeStep ||
              (da <= margin
                ? // Both in: look between them unless the way can't get out there, nor come
                  // nearer than the closest found yet (by more than `grazeStep`).
                  (da + db + way) / 2 <= margin &&
                  Math.max(0, (da + db - way) / 2) >=
                    Math.min(open?.closest ?? Infinity, da, db) - grazeStep
                : (da + db - way) / 2 > margin)
        )
          return;
        const tm = (ta + tb) / 2;
        const dm = h.distance(trip.at(tm));
        between(ta, da, tm, dm);
        visit(tm, dm);
        between(tm, dm, tb, db);
      };
      let last: [number, number] | undefined;
      for (let k = 0; k <= m; k++) {
        const t = t0 + ((t1 - t0) * k) / m;
        const d = h.distance(trip.at(t));
        if (last) between(last[0], last[1], t, d);
        visit(t, d);
        last = [t, d];
      }
      close(t1);
    }
  }
  return out
    .sort((a, b) => a.t - b.t || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0))
    .map(({ t: _t, ...a }) => a);
}

/** Each gate's trips on a day: trucks and workers whose way starts or ends in it. */
export interface GateCount {
  gateId: string;
  trucks: number;
  workers: number;
}

/**
 * The trips through each gate standing on `day` (a trip that comes back counts once). A truck
 * route that touches no gate is named in `notes`.
 */
export function gateCounts(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  day: string,
): { counts: GateCount[]; notes: ConstructionDiagnostic[] } {
  const span = (id: string) => {
    const task = doc.tasks.find((t) => t.id === id);
    const planned = schedule.byId.get(id);
    return task && planned ? taskSpan(task, planned) : undefined;
  };
  const gates = (doc.site?.temporaries ?? []).filter((t) => {
    if (t.kind !== 'gate') return false;
    const from = span(t.fromTaskId);
    const until = t.untilTaskId ? span(t.untilTaskId) : undefined;
    return !!from && day >= from.start && (!until || day <= until.finish);
  });
  const counts = new Map(gates.map((g) => [g.id, { gateId: g.id, trucks: 0, workers: 0 }]));
  const notes: ConstructionDiagnostic[] = [];
  const routes = new Map((doc.site?.routes ?? []).map((r) => [r.id, r]));
  // The gate the end is in; else the nearest within 500 mm.
  const near = (p: Plan) => {
    const inside = gates.find((g) => insidePolygon(g.outline, p));
    if (inside) return inside;
    let best: [(typeof gates)[number] | undefined, number] = [undefined, 500];
    for (const g of gates) {
      const d = distanceToEdges(g.outline, p);
      if (d <= best[1]) best = [g, d];
    }
    return best[0];
  };
  const named = new Set<string>();
  for (const trip of tripsOnDay(doc, schedule, day)) {
    const r = routes.get(trip.routeId)!;
    // Each gate at either end counts the trip once (a way from one gate to another, both).
    const ends = [near(r.path[0]!), near(r.path[r.path.length - 1]!)];
    const through = [...new Set(ends.filter((g) => !!g))];
    if (!through.length) {
      if (r.kind === 'truck' && !named.has(r.id)) {
        named.add(r.id);
        notes.push({
          code: 'route-gate',
          path: r.id,
          message: `${r.name || r.id}: the truck's way starts and ends at no gate`,
        });
      }
      continue;
    }
    for (const gate of through) {
      const c = counts.get(gate!.id)!;
      if (r.kind === 'truck') c.trucks++;
      else c.workers++;
    }
  }
  return { counts: [...counts.values()], notes };
}

/** The working days from `first` to `last` (inclusive). */
export function workingDaysBetween(
  doc: Pick<ConstructionDocument, 'calendar'>,
  first: string,
  last: string,
): string[] {
  const a = utcDay(first);
  const b = utcDay(last);
  if (a === null || b === null) return [];
  const out: string[] = [];
  for (let n = a; n <= b; n++) {
    const d = dayString(n);
    if (workingDay(doc, d)) out.push(d);
  }
  return out;
}
