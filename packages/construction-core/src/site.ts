/**
 * CS2 (docs/cad/construction-site.md): the site around the building. Its boundary, the ground
 * surveyed as points (a TIN is made over them), earthworks that cut or fill the ground while a
 * task runs, and temporary works (scaffolding, hoarding, gates, yards, site offices) that stand
 * from one task to another. Plan coordinates and heights are in mm, in the BIM version's frame.
 * Pure data and arithmetic: no React, no kernel.
 */
import Delaunator from 'delaunator';
import { dayString, utcDay } from '@editor-platform/time-axis';
import { parseCsvRows } from './csv';
import type { ConstructionDiagnostic, ConstructionDocument } from './model';
import { taskSpan, type ConstructionSchedule } from './schedule';
import { validateCranes, type Crane, type Lift } from './crane';
import { validateSiteLoads, type SiteLoad } from './frame';
import { validateTraffic, type SiteHours, type SiteRoute, type SiteZone } from './traffic';

export type Plan = [number, number];
export type Point3 = [number, number, number];

/** Cut lowers the ground to `levelZ`; fill raises it. */
export type EarthworkKind = 'cut' | 'fill';
export const earthworkKinds: readonly EarthworkKind[] = Object.freeze(['cut', 'fill']);

export interface Earthwork {
  id: string;
  name: string;
  kind: EarthworkKind;
  /** The level area (bottom of a cut, top of a fill), a simple polygon in plan. */
  outline: Plan[];
  /** Height of the level area (mm). */
  levelZ: number;
  /**
   * Side slope as horizontal run per unit of height (0.5 = "1 : 0.5"); 0 is a vertical side
   * (shored). The side runs outward from the outline until it meets the ground.
   */
  slope: number;
  /** The task that does the work: the ground moves evenly over its days. */
  taskId: string;
}

export type TemporaryKind = 'scaffold' | 'hoarding' | 'gate' | 'yard' | 'office';
export const temporaryKinds: readonly TemporaryKind[] = Object.freeze([
  'scaffold',
  'hoarding',
  'gate',
  'yard',
  'office',
]);

export interface TemporaryWork {
  id: string;
  name: string;
  kind: TemporaryKind;
  /** Footprint, a simple polygon in plan. */
  outline: Plan[];
  /** Height above its base (mm). */
  height: number;
  /** Base height (mm); the ground under its first corner when absent. */
  baseZ?: number;
  /** Put up when this task starts. */
  fromTaskId: string;
  /** Taken down when this task finishes; stands to the end without one. */
  untilTaskId?: string;
}

export interface ConstructionSite {
  /** The site boundary, a simple polygon in plan. */
  boundary: Plan[];
  /** Surveyed ground points (x, y, z); empty is flat ground at z = 0. */
  terrain: Point3[];
  earthworks: Earthwork[];
  temporaries: TemporaryWork[];
  /** CS3: the cranes on site (absent: none). */
  cranes?: Crane[];
  /** CS3: the lifts the cranes make (absent: none). */
  lifts?: Lift[];
  /** CS4: loads laid on slabs while a task runs (materials stocked, absent: none). */
  loads?: SiteLoad[];
  /** CS5: the ways workers and trucks take (absent: none). */
  routes?: SiteRoute[];
  /** CS5: danger zones drawn by hand (absent: none; lifts and cuts give their own). */
  zones?: SiteZone[];
  /** CS5: the working day (08:00–17:00 when absent). */
  hours?: SiteHours;
}

export const siteLimits = Object.freeze({
  boundaryPoints: 1000,
  outlinePoints: 200,
  terrainPoints: 10_000,
  earthworks: 200,
  temporaries: 500,
  /** |x|, |y|, |z| in mm: 100 km. */
  coordinate: 1e8,
  maxSlope: 10,
  maxHeight: 1e6,
});

export const emptySite = (): ConstructionSite => ({
  boundary: [],
  terrain: [],
  earthworks: [],
  temporaries: [],
});

// ---------------------------------------------------------------------------------------------
// Plan geometry

/** Twice the signed area (positive counter-clockwise). */
export function signedArea2(poly: readonly Plan[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a;
}
export const polygonArea = (poly: readonly Plan[]) => Math.abs(signedArea2(poly)) / 2;

export function insidePolygon(poly: readonly Plan[], [x, y]: Plan): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Triangles of a simple polygon (ear clipping), as index triples into it, counter-clockwise in
 * plan whatever the polygon's own orientation.
 */
export function triangulatePolygon(poly: readonly Plan[]): number[] {
  const ccw = signedArea2(poly) > 0;
  const left = poly.map((_, i) => i);
  if (!ccw) left.reverse();
  const out: number[] = [];
  const turn = (a: number, b: number, c: number) => cross(poly[a]!, poly[b]!, poly[c]!);
  let guard = 0;
  while (left.length > 3 && guard++ < poly.length * poly.length) {
    let cut = false;
    for (let k = 0; k < left.length; k++) {
      const a = left[(k + left.length - 1) % left.length]!;
      const b = left[k]!;
      const c = left[(k + 1) % left.length]!;
      if (turn(a, b, c) <= 0) continue;
      // An ear holds no other corner (on its edges counts as inside).
      const blocked = left.some(
        (q) =>
          q !== a &&
          q !== b &&
          q !== c &&
          turn(a, b, q) >= 0 &&
          turn(b, c, q) >= 0 &&
          turn(c, a, q) >= 0,
      );
      if (blocked) continue;
      out.push(a, b, c);
      left.splice(k, 1);
      cut = true;
      break;
    }
    // Collinear corners left over: drop one.
    if (!cut) left.splice(0, 1);
  }
  if (left.length === 3 && turn(left[0]!, left[1]!, left[2]!) > 0) out.push(...left);
  return out;
}

/** Distance from a point to the polygon's edges. */
export function distanceToEdges(poly: readonly Plan[], [x, y]: Plan): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const cross = (o: Plan, a: Plan, b: Plan) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** `p` on segment a–b, given that the three are on one line. */
const within = (a: Plan, b: Plan, p: Plan) =>
  Math.min(a[0], b[0]) <= p[0] &&
  p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] &&
  p[1] <= Math.max(a[1], b[1]);
/** Segments a–b and c–d meet: crossing, touching at a point or overlapping. */
function segmentsMeet(a: Plan, b: Plan, c: Plan, d: Plan) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  return (
    (d1 === 0 && within(c, d, a)) ||
    (d2 === 0 && within(c, d, b)) ||
    (d3 === 0 && within(a, b, c)) ||
    (d4 === 0 && within(a, b, d))
  );
}
/**
 * At least 3 corners, no zero area, no repeated corner; edges that are not neighbours do not
 * meet (not crossing, touching or overlapping), and neighbours do not fold back on each other.
 */
export function simplePolygon(poly: readonly Plan[]): boolean {
  if (poly.length < 3 || signedArea2(poly) === 0) return false;
  const keys = new Set(poly.map(([x, y]) => `${x},${y}`));
  if (keys.size !== poly.length) return false;
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n]!;
    const b = poly[i]!;
    const c = poly[(i + 1) % n]!;
    // Folding back: the next edge runs back along the previous one.
    if (cross(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0)
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Validation (called by validateConstruction for `site`)

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, limit: number = siteLimits.coordinate): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const plan = (v: unknown): v is Plan =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);

export function validateSite(
  site: unknown,
  taskIds: ReadonlySet<string>,
  isId: (v: unknown) => v is string,
  isText: (v: unknown) => v is string,
  tasks: ReadonlyMap<string, { action: string; elementIds: readonly string[] }> = new Map(),
): ConstructionDiagnostic[] {
  const out: ConstructionDiagnostic[] = [];
  const bad = (code: string, path: string, message = code) => out.push({ code, path, message });
  const only = (v: Rec, keys: string[], path: string) => {
    for (const k of Object.keys(v))
      if (!keys.includes(k)) out.push({ code: 'unknown-key', path: `${path}.${k}`, message: k });
  };
  if (!record(site)) return [{ code: 'site', path: '$.site', message: 'not an object' }];
  only(
    site,
    [
      'boundary',
      'terrain',
      'earthworks',
      'temporaries',
      'cranes',
      'lifts',
      'loads',
      'routes',
      'zones',
      'hours',
    ],
    '$.site',
  );
  const polygon = (v: unknown, max: number, path: string, required: boolean) => {
    if (!Array.isArray(v) || v.length > max)
      return bad('limit-exceeded', path, `at most ${max} corners`);
    if (!v.every(plan)) return bad('coordinate', path, 'corners are [x, y] in mm');
    if (!v.length && !required) return;
    if (!simplePolygon(v)) bad('polygon', path, 'not a simple polygon');
  };
  polygon(site.boundary, siteLimits.boundaryPoints, '$.site.boundary', false);
  const terrain = site.terrain;
  if (!Array.isArray(terrain) || terrain.length > siteLimits.terrainPoints)
    bad('limit-exceeded', '$.site.terrain', `at most ${siteLimits.terrainPoints} points`);
  else {
    const seen = new Set<string>();
    terrain.forEach((p, i) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => finite(c)))
        return bad('coordinate', `$.site.terrain[${i}]`, 'points are [x, y, z] in mm');
      const key = `${p[0]},${p[1]}`;
      if (seen.has(key)) bad('terrain', `$.site.terrain[${i}]`, `two heights at ${key}`);
      seen.add(key);
    });
    if (!out.length && terrain.length && !tin(terrain as Point3[]))
      bad('terrain', '$.site.terrain', 'at least 3 points not on one line');
  }
  const ids = new Set<string>();
  const id = (v: unknown, path: string) => {
    if (!isId(v)) return bad('id', path);
    if (ids.has(v)) bad('duplicate-id', path, `${v} is used twice`);
    ids.add(v);
  };
  const task = (v: unknown, path: string) => {
    if (!isId(v)) bad('id', path);
    else if (!taskIds.has(v)) bad('task-missing', path, v);
  };
  const works = site.earthworks;
  if (!Array.isArray(works) || works.length > siteLimits.earthworks)
    bad('limit-exceeded', '$.site.earthworks', `at most ${siteLimits.earthworks}`);
  else
    works.forEach((w, i) => {
      const p = `$.site.earthworks[${i}]`;
      if (!record(w)) return bad('earthwork', p);
      only(w, ['id', 'name', 'kind', 'outline', 'levelZ', 'slope', 'taskId'], p);
      id(w.id, `${p}.id`);
      if (!isText(w.name)) bad('name', `${p}.name`);
      if (!earthworkKinds.includes(w.kind as never)) bad('kind', `${p}.kind`);
      polygon(w.outline, siteLimits.outlinePoints, `${p}.outline`, true);
      if (!finite(w.levelZ)) bad('coordinate', `${p}.levelZ`);
      if (!(finite(w.slope) && w.slope >= 0 && w.slope <= siteLimits.maxSlope))
        bad('slope', `${p}.slope`, `0 to ${siteLimits.maxSlope}`);
      task(w.taskId, `${p}.taskId`);
    });
  const temps = site.temporaries;
  if (!Array.isArray(temps) || temps.length > siteLimits.temporaries)
    bad('limit-exceeded', '$.site.temporaries', `at most ${siteLimits.temporaries}`);
  else
    temps.forEach((t, i) => {
      const p = `$.site.temporaries[${i}]`;
      if (!record(t)) return bad('temporary', p);
      only(t, ['id', 'name', 'kind', 'outline', 'height', 'baseZ', 'fromTaskId', 'untilTaskId'], p);
      id(t.id, `${p}.id`);
      if (!isText(t.name)) bad('name', `${p}.name`);
      if (!temporaryKinds.includes(t.kind as never)) bad('kind', `${p}.kind`);
      polygon(t.outline, siteLimits.outlinePoints, `${p}.outline`, true);
      if (!(finite(t.height, siteLimits.maxHeight) && t.height > 0))
        bad('height', `${p}.height`, 'above 0');
      if (t.baseZ !== undefined && !finite(t.baseZ)) bad('coordinate', `${p}.baseZ`);
      task(t.fromTaskId, `${p}.fromTaskId`);
      if (t.untilTaskId !== undefined) task(t.untilTaskId, `${p}.untilTaskId`);
    });
  out.push(...validateCranes(site.cranes, site.lifts, tasks, ids, isId, isText));
  out.push(...validateSiteLoads(site.loads, tasks, ids, isId, isText));
  out.push(
    ...validateTraffic(
      site.routes,
      site.zones,
      site.hours,
      taskIds,
      ids,
      isId,
      isText,
      simplePolygon,
    ),
  );
  return out;
}

/** Task IDs the site refers to: such a task cannot be removed. */
export function siteTaskRefs(site: ConstructionSite | undefined): Set<string> {
  const refs = new Set<string>();
  for (const w of site?.earthworks ?? []) refs.add(w.taskId);
  for (const t of [...(site?.temporaries ?? []), ...(site?.cranes ?? [])]) {
    refs.add(t.fromTaskId);
    if (t.untilTaskId) refs.add(t.untilTaskId);
  }
  for (const l of [
    ...(site?.lifts ?? []),
    ...(site?.loads ?? []),
    ...(site?.routes ?? []),
    ...(site?.zones ?? []),
  ])
    refs.add(l.taskId);
  return refs;
}

// ---------------------------------------------------------------------------------------------
// Terrain: a TIN over the surveyed points

export interface Terrain {
  /** Ground height at a plan point: in the TIN by its triangle, outside by the nearest point. */
  heightAt(p: Plan): number;
  /** The survey's plan bounds, or undefined for flat ground. */
  bounds: [Plan, Plan] | undefined;
  /** Triangles (indices into the points), 3 per triangle. */
  triangles: Uint32Array;
  points: readonly Point3[];
}

/** The Delaunay TIN, or undefined when the points span no area. */
function tin(points: readonly Point3[]) {
  if (points.length < 3) return undefined;
  const d = Delaunator.from(
    points as Point3[],
    (p) => p[0],
    (p) => p[1],
  );
  return d.triangles.length ? d.triangles : undefined;
}

const flatTerrain: Terrain = {
  heightAt: () => 0,
  bounds: undefined,
  triangles: new Uint32Array(),
  points: [],
};

/** The ground of a site: a TIN over its points (flat at 0 without any). */
export function siteTerrain(site: Pick<ConstructionSite, 'terrain'> | undefined): Terrain {
  const points = site?.terrain ?? [];
  const triangles = points.length ? tin(points) : undefined;
  if (!triangles) return flatTerrain;
  let lo: Plan = [Infinity, Infinity];
  let hi: Plan = [-Infinity, -Infinity];
  for (const [x, y] of points) {
    lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
  }
  // Buckets of triangles by plan cell, so a height is found in a few triangles.
  const n = Math.max(1, Math.ceil(Math.sqrt(triangles.length / 3 / 2)));
  const cw = Math.max((hi[0] - lo[0]) / n, 1e-9);
  const ch = Math.max((hi[1] - lo[1]) / n, 1e-9);
  const cell = (v: number, o: number, s: number) =>
    Math.min(n - 1, Math.max(0, Math.floor((v - o) / s)));
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < triangles.length; t += 3) {
    const ps = [points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!];
    const x0 = cell(Math.min(...ps.map((p) => p[0])), lo[0], cw);
    const x1 = cell(Math.max(...ps.map((p) => p[0])), lo[0], cw);
    const y0 = cell(Math.min(...ps.map((p) => p[1])), lo[1], ch);
    const y1 = cell(Math.max(...ps.map((p) => p[1])), lo[1], ch);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) buckets[j * n + i]!.push(t);
  }
  const heightAt = ([x, y]: Plan): number => {
    if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1])
      for (const t of buckets[cell(y, lo[1], ch) * n + cell(x, lo[0], cw)]!) {
        const a = points[triangles[t]!]!;
        const b = points[triangles[t + 1]!]!;
        const c = points[triangles[t + 2]!]!;
        const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
        const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
        const l3 = 1 - l1 - l2;
        const e = -1e-9;
        if (l1 >= e && l2 >= e && l3 >= e) return l1 * a[2] + l2 * b[2] + l3 * c[2];
      }
    // Outside the survey: the nearest surveyed point's height.
    let best = Infinity;
    let z = 0;
    for (const p of points) {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < best) {
        best = d;
        z = p[2];
      }
    }
    return z;
  };
  return { heightAt, bounds: [lo, hi], triangles, points };
}

// ---------------------------------------------------------------------------------------------
// Earthworks

/**
 * The finished ground an earthwork leaves at a plan point, or undefined where it leaves the
 * ground as it was. Inside the outline: the level. Outside: the side slope until it meets the
 * ground.
 */
export function earthworkSurface(work: Earthwork, p: Plan, ground: number): number | undefined {
  const inside = insidePolygon(work.outline, p);
  const d = inside ? 0 : distanceToEdges(work.outline, p);
  if (!inside && work.slope === 0) return undefined;
  const rise = inside ? 0 : d / work.slope;
  if (work.kind === 'cut') {
    const z = work.levelZ + rise;
    return z < ground ? z : undefined;
  }
  const z = work.levelZ - rise;
  return z > ground ? z : undefined;
}

/** How far an earthwork has got by the end of a day: 0 before its task, 1 after it. */
export function earthworkProgress(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  work: Earthwork,
  day: string,
): number {
  const task = doc.tasks.find((t) => t.id === work.taskId);
  const planned = schedule.byId.get(work.taskId);
  if (!task || !planned) return 0;
  const span = taskSpan(task, planned);
  if (day < span.start) return 0;
  if (day >= span.finish || span.milestone) return 1;
  // Worked days only: the ground does not move on days off.
  const weekdays = new Set(doc.calendar.workWeekdays);
  const holidays = new Set(doc.calendar.holidays);
  const s = utcDay(span.start)!;
  const f = utcDay(span.finish)!;
  const today = utcDay(day)!;
  let total = 0;
  let done = 0;
  for (let d = s; d <= f; d++) {
    // 1970-01-01 (day 0) was a Thursday.
    const worked = weekdays.has((((d + 4) % 7) + 7) % 7) && !holidays.has(dayString(d));
    if (!worked) continue;
    total++;
    if (d <= today) done++;
  }
  // Actual dates may fall on days off only: then every day counts.
  if (!total) return (today - s + 1) / (f - s + 1);
  return done / total;
}

export interface EarthworkVolume {
  id: string;
  /** m³ of ground taken away (cut) or brought in (fill) when the work is done. */
  cut: number;
  fill: number;
}

/**
 * How far round an earthwork its side slope reaches through the ground near it: the outline's
 * box grown until the ground at its edge and inside it needs no wider slope (30 rounds at most).
 * Ground farther off may still be reached (see `earthworkReach`); this is where the work's own
 * resolution is kept.
 */
function earthworkNear(work: Earthwork, terrain: Terrain): number {
  const xs = work.outline.map((p) => p[0]);
  const ys = work.outline.map((p) => p[1]);
  const lo: Plan = [Math.min(...xs), Math.min(...ys)];
  const hi: Plan = [Math.max(...xs), Math.max(...ys)];
  const sign = work.kind === 'cut' ? 1 : -1;
  const relief = (z: number) => Math.max(0, sign * (z - work.levelZ));
  let grow = 0;
  for (let round = 0; round < 30; round++) {
    const a: Plan = [lo[0] - grow, lo[1] - grow];
    const b: Plan = [hi[0] + grow, hi[1] + grow];
    let r = 0;
    for (const p of work.outline) r = Math.max(r, relief(terrain.heightAt(p)));
    for (const p of terrain.points)
      if (p[0] >= a[0] && p[0] <= b[0] && p[1] >= a[1] && p[1] <= b[1])
        r = Math.max(r, relief(p[2]));
    for (let k = 0; k <= 64; k++) {
      const t = k / 64;
      for (const p of [
        [a[0] + t * (b[0] - a[0]), a[1]],
        [a[0] + t * (b[0] - a[0]), b[1]],
        [a[0], a[1] + t * (b[1] - a[1])],
        [b[0], a[1] + t * (b[1] - a[1])],
      ] as Plan[])
        r = Math.max(r, relief(terrain.heightAt(p)));
    }
    const next = work.slope * r;
    if (next <= grow * (1 + 1e-9)) break;
    grow = next;
  }
  return grow;
}

/**
 * The plan area an earthwork can touch: its outline's box grown by the widest side slope any
 * ground on the work's side of the level can hold within reach of the box.
 */
function earthworkReach(work: Earthwork, terrain: Terrain): [Plan, Plan] {
  const xs = work.outline.map((p) => p[0]);
  const ys = work.outline.map((p) => p[1]);
  const lo: Plan = [Math.min(...xs), Math.min(...ys)];
  const hi: Plan = [Math.max(...xs), Math.max(...ys)];
  // Only ground on the work's side of the level counts: above it for a cut, below for a fill.
  const sign = work.kind === 'cut' ? 1 : -1;
  const relief = (z: number) => Math.max(0, sign * (z - work.levelZ));
  // A point the side slope reaches lies nearer the box (no farther than from the outline) than
  // the slope times its ground's relief.
  const gap = (a: Plan, b: Plan) =>
    Math.hypot(Math.max(0, a[0] - hi[0], lo[0] - b[0]), Math.max(0, a[1] - hi[1], lo[1] - b[1]));
  const { points, triangles } = terrain;
  let grow = 0;
  if (!points.length) grow = work.slope * relief(terrain.heightAt(lo));
  // In the TIN the ground in a triangle is no higher (lower) than its corners.
  for (let t = 0; t < triangles.length; t += 3) {
    const ps = [points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!];
    const reach = work.slope * Math.max(...ps.map((p) => relief(p[2])));
    if (reach <= grow) continue;
    const a: Plan = [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1]))];
    const b: Plan = [Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))];
    if (gap(a, b) < reach) grow = reach;
  }
  // Outside the TIN the ground is a surveyed point's height: any of them may count there,
  // unless the TIN covers everything within that reach of the box.
  if (points.length) {
    let most = 0;
    for (const p of points) most = Math.max(most, work.slope * relief(p[2]));
    const covered = (p: Plan) => {
      for (let t = 0; t < triangles.length; t += 3) {
        const a = points[triangles[t]!]!;
        const b = points[triangles[t + 1]!]!;
        const c = points[triangles[t + 2]!]!;
        const side = (u: Point3, v: Point3) =>
          (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
        const s1 = side(a, b);
        const s2 = side(b, c);
        const s3 = side(c, a);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
      }
      return false;
    };
    if (
      most > grow &&
      !(
        [
          [lo[0] - most, lo[1] - most],
          [hi[0] + most, lo[1] - most],
          [hi[0] + most, hi[1] + most],
          [lo[0] - most, hi[1] + most],
        ] as Plan[]
      ).every(covered)
    )
      grow = most;
  }
  return [
    [lo[0] - grow, lo[1] - grow],
    [hi[0] + grow, hi[1] + grow],
  ];
}

/**
 * Visits the samples where an earthwork moves the ground, each with the plan area (mm²) it
 * stands for. Two grids of one sample a cell: one over the ground near the work (see
 * `earthworkNear`), and one over the rest of the area it can touch (see `earthworkReach`), so
 * a wide conservative reach does not coarsen the work itself. Each has at least `cells` cells
 * a side, finer (up to 2,000) so that a cell stays within 1/100 of the outline's width.
 * `visit` returning true stops the walk.
 */
function sampleEarthwork(
  work: Earthwork,
  terrain: Terrain,
  cells: number,
  visit: (p: Plan, ground: number, surface: number, area: number) => boolean | void,
): void {
  const xs = work.outline.map((p) => p[0]);
  const ys = work.outline.map((p) => p[1]);
  // The outline's width: its plan box's smaller side, or 2·area / perimeter for a narrow
  // outline lying across its box (a long diagonal trench).
  let perimeter = 0;
  work.outline.forEach((a, k) => {
    const b = work.outline[(k + 1) % work.outline.length]!;
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
  const small = Math.min(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    (2 * polygonArea(work.outline)) / perimeter,
  );
  // Up to 2,000 cells a side, fewer for an outline of many corners (cost: cells × corners).
  const most = Math.max(cells, Math.min(2000, Math.floor(Math.sqrt(1e8 / work.outline.length))));
  const count = (span: number) => Math.min(most, Math.max(cells, Math.ceil(span / (small / 100))));
  const [far0, far1] = earthworkReach(work, terrain);
  const grow = earthworkNear(work, terrain);
  const near: [Plan, Plan] = [
    [Math.max(far0[0], Math.min(...xs) - grow), Math.max(far0[1], Math.min(...ys) - grow)],
    [Math.min(far1[0], Math.max(...xs) + grow), Math.min(far1[1], Math.max(...ys) + grow)],
  ];
  const inNear = (p: Plan) =>
    p[0] >= near[0][0] && p[0] < near[1][0] && p[1] >= near[0][1] && p[1] < near[1][1];
  const walk = ([lo, hi]: [Plan, Plan], skip: (p: Plan) => boolean, cap: number): boolean => {
    const nx = Math.min(cap, count(hi[0] - lo[0]));
    const ny = Math.min(cap, count(hi[1] - lo[1]));
    const dx = (hi[0] - lo[0]) / nx;
    const dy = (hi[1] - lo[1]) / ny;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        // One point a cell, placed by a low-discrepancy (R2) sequence rather than at the
        // centre, so edges lying along the grid's diagonals are not counted with a bias.
        const k = i * ny + j;
        const p: Plan = [
          lo[0] + (i + ((0.5 + k * 0.7548776662466927) % 1)) * dx,
          lo[1] + (j + ((0.5 + k * 0.5698402909980532) % 1)) * dy,
        ];
        if (skip(p)) continue;
        const g = terrain.heightAt(p);
        const z = earthworkSurface(work, p, g);
        if (z !== undefined && visit(p, g, z, dx * dy)) return true;
      }
    return false;
  };
  // The far grid counts only what lies outside the near box.
  if (walk(near, () => false, most)) return;
  const same =
    near[0][0] <= far0[0] &&
    near[0][1] <= far0[1] &&
    near[1][0] >= far1[0] &&
    near[1][1] >= far1[1];
  // Ground reached only far off is measured on a coarser grid (up to 600 cells a side).
  if (!same) walk([far0, far1], inNear, Math.max(cells, 600));
}

/**
 * Cut and fill of each earthwork when done, summed over the sample grid of `sampleEarthwork`.
 * Earthworks are taken one at a time on the surveyed ground.
 */
export function earthworkVolumes(
  site: ConstructionSite,
  terrain = siteTerrain(site),
  cells = 200,
): EarthworkVolume[] {
  return site.earthworks.map((work) => {
    let cut = 0;
    let fill = 0;
    sampleEarthwork(work, terrain, cells, (_p, g, z, area) => {
      if (z < g) cut += (g - z) * area;
      else fill += (z - g) * area;
    });
    // mm³ → m³
    return { id: work.id, cut: cut / 1e9, fill: fill / 1e9 };
  });
}

/** The ground height at a point on a day: each earthwork moved by its progress. */
export function groundOnDay(
  site: ConstructionSite,
  terrain: Terrain,
  progress: ReadonlyMap<string, number>,
  p: Plan,
): number {
  let z = terrain.heightAt(p);
  for (const work of site.earthworks) {
    const f = progress.get(work.id) ?? 0;
    if (f <= 0) continue;
    const target = earthworkSurface(work, p, z);
    if (target !== undefined) z += f * (target - z);
  }
  return z;
}

// ---------------------------------------------------------------------------------------------
// The site on a day

export interface SiteWorksDay {
  /** Earthwork ID → progress 0–1 at the end of the day. */
  progress: Map<string, number>;
  /** m³ moved by the end of the day, over every earthwork. */
  cut: number;
  fill: number;
  /** Temporary works standing that day, in document order. */
  standing: string[];
}

export function siteWorksOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  volumes: readonly EarthworkVolume[],
  day: string,
): SiteWorksDay {
  const site = doc.site ?? emptySite();
  const progress = new Map<string, number>();
  let cut = 0;
  let fill = 0;
  for (const work of site.earthworks) {
    const f = earthworkProgress(doc, schedule, work, day);
    progress.set(work.id, f);
    const v = volumes.find((x) => x.id === work.id);
    if (v) {
      cut += f * v.cut;
      fill += f * v.fill;
    }
  }
  const span = (id: string) => {
    const task = doc.tasks.find((t) => t.id === id);
    const planned = schedule.byId.get(id);
    return task && planned ? taskSpan(task, planned) : undefined;
  };
  const standing = site.temporaries
    .filter((t) => {
      const from = span(t.fromTaskId);
      if (!from || day < from.start) return false;
      const until = t.untilTaskId ? span(t.untilTaskId) : undefined;
      return !until || day <= until.finish;
    })
    .map((t) => t.id);
  return { progress, cut, fill, standing };
}

/**
 * Some point of segment a–b is `outside`. A concave boundary can pass between ends that are
 * both inside, so each piece between the points where the segment meets the boundary's edges
 * (or passes its corners) is tested at its middle as well as its ends.
 */
function segmentOutside(
  boundary: readonly Plan[],
  a: Plan,
  b: Plan,
  outside: (p: Plan) => boolean,
): boolean {
  if (outside(a) || outside(b)) return true;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return false;
  const ts: number[] = [];
  boundary.forEach((c, k) => {
    const d = boundary[(k + 1) % boundary.length]!;
    ts.push(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len);
    const ex = d[0] - c[0];
    const ey = d[1] - c[1];
    const den = dx * ey - dy * ex;
    if (den !== 0) ts.push(((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den);
  });
  const cuts = [0, ...ts.filter((t) => t > 0 && t < 1).sort((x, y) => x - y), 1];
  for (let k = 1; k < cuts.length; k++) {
    const m = (cuts[k - 1]! + cuts[k]!) / 2;
    if (outside([a[0] + m * dx, a[1] + m * dy])) return true;
    if (k < cuts.length - 1 && outside([a[0] + cuts[k]! * dx, a[1] + cuts[k]! * dy])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Checks

/**
 * What does not fit the site: temporary works or earthworks (with their side slopes) over the
 * boundary, temporary works taken down before they go up.
 */
export function checkSite(
  doc: ConstructionDocument,
  schedule?: ConstructionSchedule,
): ConstructionDiagnostic[] {
  const site = doc.site;
  if (!site) return [];
  const out: ConstructionDiagnostic[] = [];
  const boundary = site.boundary;
  // On the boundary counts as inside (hoarding along the edge).
  const outside = (p: Plan) =>
    boundary.length >= 3 && !insidePolygon(boundary, p) && distanceToEdges(boundary, p) > 1e-6;
  site.temporaries.forEach((t, i) => {
    if (
      boundary.length >= 3 &&
      t.outline.some((a, k) =>
        segmentOutside(boundary, a, t.outline[(k + 1) % t.outline.length]!, outside),
      )
    )
      out.push({
        code: 'outside-boundary',
        path: `$.site.temporaries[${i}].outline`,
        message: `${t.name || t.id} stands over the site boundary`,
      });
    // As the site stands day by day: actual dates over the plan.
    const span = (id: string | undefined) => {
      const task = id === undefined ? undefined : doc.tasks.find((x) => x.id === id);
      const planned = task && schedule?.byId.get(task.id);
      return task && planned ? taskSpan(task, planned) : undefined;
    };
    const from = span(t.fromTaskId);
    const until = span(t.untilTaskId);
    if (from && until && until.finish < from.start)
      out.push({
        code: 'removed-before-put-up',
        path: `$.site.temporaries[${i}].untilTaskId`,
        message: `${t.name || t.id} is taken down before it goes up`,
      });
  });
  if (boundary.length >= 3) {
    const terrain = siteTerrain(site);
    // Points just outside the boundary (1 mm out), every 100 mm at most (2,000 an edge at most):
    // ground the work moves there is outside the site; on the boundary itself is not.
    const along: Plan[] = [];
    const turn = signedArea2(boundary) > 0 ? 1 : -1;
    boundary.forEach((a, k) => {
      const b = boundary[(k + 1) % boundary.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const out: Plan = [(turn * (b[1] - a[1])) / len, (-turn * (b[0] - a[0])) / len];
      const n = Math.min(2000, Math.max(1, Math.ceil(len / 100)));
      for (let j = 0; j <= n; j++)
        along.push([
          a[0] + ((b[0] - a[0]) * j) / n + out[0],
          a[1] + ((b[1] - a[1]) * j) / n + out[1],
        ]);
    });
    const box: [Plan, Plan] = [
      [Math.min(...boundary.map((p) => p[0])), Math.min(...boundary.map((p) => p[1]))],
      [Math.max(...boundary.map((p) => p[0])), Math.max(...boundary.map((p) => p[1]))],
    ];
    // Where the work changes the ground (its own side of the level only).
    const moves = (w: Earthwork, p: Plan) =>
      earthworkSurface(w, p, terrain.heightAt(p)) !== undefined;
    site.earthworks.forEach((w, i) => {
      // Over: it moves ground at the boundary, at a corner outside it, or anywhere outside it
      // on the volume grid (ground it reaches past a strip it leaves alone).
      let over =
        w.outline.some((p) => outside(p) && moves(w, p)) ||
        along.some((p) => outside(p) && moves(w, p));
      if (!over)
        sampleEarthwork(w, terrain, 200, (p) => {
          const beyond =
            p[0] < box[0][0] || p[0] > box[1][0] || p[1] < box[0][1] || p[1] > box[1][1];
          return (over = beyond || outside(p));
        });
      if (over)
        out.push({
          code: 'outside-boundary',
          path: `$.site.earthworks[${i}].outline`,
          message: `${w.name || w.id} (with its side slopes) reaches over the site boundary`,
        });
    });
  }
  return out;
}

/** A building element's plan points: its body's vertices (or its box's corners). */
export interface SiteFootprint {
  id: string;
  name?: string;
  points: Iterable<Plan>;
  /** Plan edges of the body (projected mesh edges): checked between their ends too. */
  edges?: Iterable<readonly [Plan, Plan]>;
}

/**
 * Building elements standing over the site boundary (a point of the body, or of its edges,
 * more than 1 mm outside it). The building's shape comes from its evaluation, so the caller gives the points.
 */
export function checkBuildingInSite(
  site: ConstructionSite | undefined,
  elements: Iterable<SiteFootprint>,
): ConstructionDiagnostic[] {
  const boundary = site?.boundary ?? [];
  if (boundary.length < 3) return [];
  const out: ConstructionDiagnostic[] = [];
  const outside = (p: Plan) => !insidePolygon(boundary, p) && distanceToEdges(boundary, p) > 1;
  const over = (e: SiteFootprint) => {
    for (const p of e.points) if (outside(p)) return true;
    for (const [a, b] of e.edges ?? []) if (segmentOutside(boundary, a, b, outside)) return true;
    return false;
  };
  for (const e of elements)
    if (over(e))
      out.push({
        code: 'outside-boundary',
        path: `building:${e.id}`,
        message: `${e.name || e.id} (building) stands over the site boundary`,
      });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Terrain CSV

/** Survey points from CSV with a header `x,y,z` (mm, any column order, case ignored). */
export function readTerrainCsv(text: string): {
  points: Point3[];
  diagnostics: ConstructionDiagnostic[];
} {
  const diagnostics: ConstructionDiagnostic[] = [];
  const bad = (line: number, code: string, message: string) =>
    diagnostics.push({ code, path: `line ${line}`, message });
  const rows = parseCsvRows(text);
  if (!Array.isArray(rows)) {
    bad(rows.line, 'csv', rows.error);
    return { points: [], diagnostics };
  }
  const [header, ...body] = rows;
  const col = new Map((header ?? []).map((h, i) => [h.trim().toLowerCase(), i]));
  for (const c of ['x', 'y', 'z']) if (!col.has(c)) bad(1, 'csv-header', `no "${c}" column`);
  if (diagnostics.length) return { points: [], diagnostics };
  if (body.length > siteLimits.terrainPoints) {
    bad(2, 'limit-exceeded', `at most ${siteLimits.terrainPoints} points`);
    return { points: [], diagnostics };
  }
  const seen = new Set<string>();
  const points = body.map((r, k): Point3 => {
    const line = k + 2;
    const p = (['x', 'y', 'z'] as const).map((c) => {
      const v = (r[col.get(c)!] ?? '').trim();
      const n = /^[+-]?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!finite(n)) bad(line, 'coordinate', `${c} "${v}" is not a number of mm`);
      return n;
    }) as Point3;
    const key = `${p[0]},${p[1]}`;
    if (seen.has(key)) bad(line, 'terrain', `two heights at ${key}`);
    seen.add(key);
    return p;
  });
  if (!diagnostics.length && points.length && !tin(points))
    bad(2, 'terrain', 'at least 3 points not on one line');
  return { points: diagnostics.length ? [] : points, diagnostics };
}
