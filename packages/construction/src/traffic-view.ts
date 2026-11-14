import {
  blockyFigure,
  occupantFigure,
  poseAt,
  type CharacterFixture,
} from '@editor-platform/character-core';
import type { Hazard, HazardKind, Plan, SiteRoute, Trip } from '@editor-platform/construction-core';
import type { ViewMesh, ViewSolid } from '@editor-platform/geometry-view';
import { beamBox } from './crane-view';
import { sitePickPrefix } from './site-view';

type Bounds = [[number, number, number], [number, number, number]];
type Part = { positions: number[]; indices: number[] };

/** CS5b: pick IDs of the traffic's solids (site solids: never a building element). */
export const siteRouteId = (id: string) => `${sitePickPrefix}route:${id}`;
export const siteHazardId = (id: string) => `${sitePickPrefix}hazard:${id}`;
export const siteMoverId = (k: number) => `${sitePickPrefix}mover:${k}`;

/** How each kind of danger is drawn: a red-family fence along its outline. */
export const hazardLooks: Record<HazardKind, string> = {
  zone: '#ef4444',
  load: '#dc2626',
  slew: '#f97316',
  edge: '#a855f7',
};
export const routeLooks = { worker: '#0284c7', truck: '#475569' } as const;

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function meshOf(parts: Part[]): ViewMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of parts) {
    const first = positions.length / 3;
    positions.push(...p.positions);
    for (const i of p.indices) indices.push(i + first);
  }
  const normals = new Array<number>(positions.length).fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k]! * 3, indices[k + 1]! * 3, indices[k + 2]! * 3];
    const e1 = [0, 1, 2].map((i) => positions[b + i]! - positions[a + i]!);
    const e2 = [0, 1, 2].map((i) => positions[c + i]! - positions[a + i]!);
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    for (const v of [a, b, c]) for (let i = 0; i < 3; i++) normals[v + i]! += n[i]!;
  }
  for (let k = 0; k < normals.length; k += 3) {
    const l = Math.hypot(normals[k]!, normals[k + 1]!, normals[k + 2]!) || 1;
    for (let i = 0; i < 3; i++) normals[k + i]! /= l;
  }
  return {
    origin: [0, 0, 0],
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function boundsOf(meshes: ViewMesh[]): Bounds {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes)
    for (let k = 0; k < m.positions.length; k += 3)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, m.positions[k + i]!);
        hi[i] = Math.max(hi[i]!, m.positions[k + i]!);
      }
  return [lo, hi];
}

/** Longest piece of a strip or fence between two heights of the ground (mm). */
export const ribbonStep = 2000;

/** A polyline laid on the ground as boxes `w` wide and `h` high (closed: back to its start). */
function ribbon(
  points: readonly Plan[],
  ground: (p: Plan) => number,
  w: number,
  h: number,
  closed: boolean,
): Part[] {
  const out: Part[] = [];
  const n = points.length;
  for (let k = 0; k + (closed ? 0 : 1) < n; k++) {
    const p = points[k]!;
    const q = points[(k + 1) % n]!;
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1) continue;
    // In pieces of at most `ribbonStep`, each on the ground at its ends: over a cut, a fill or a
    // break in the ground between the points the strip follows the ground.
    const m = Math.ceil(l / ribbonStep);
    let a: Plan = p;
    for (let i = 1; i <= m; i++) {
      const b: Plan =
        i === m ? q : [p[0] + ((q[0] - p[0]) * i) / m, p[1] + ((q[1] - p[1]) * i) / m];
      out.push(beamBox([a[0], a[1], ground(a) + h / 2], [b[0], b[1], ground(b) + h / 2], w, h));
      a = b;
    }
  }
  return out;
}

/**
 * A danger as a fence along its outline: strong while in force at the time shown, faint when it
 * is in force at another time of the day.
 */
export function hazardSolid(
  h: Hazard,
  ground: (p: Plan) => number,
  now: boolean,
  selected = false,
): ViewSolid | undefined {
  const parts = ribbon(h.outline, ground, 200, now ? 1200 : 400, true);
  if (!parts.length) return undefined;
  const mesh = meshOf(parts);
  return {
    meshes: [{ mesh, color: hazardLooks[h.kind], opacity: now ? 0.85 : 0.25, sheet: false }],
    bounds: boundsOf([mesh]),
    instances: [{ path: [siteHazardId(h.id)], matrix: identity, selected }],
  };
}

/** A route as a strip on the ground. */
export function routeSolid(
  r: SiteRoute,
  ground: (p: Plan) => number,
  selected = false,
): ViewSolid | undefined {
  const parts = ribbon(r.path, ground, r.kind === 'truck' ? 600 : 250, 60, false);
  if (!parts.length) return undefined;
  const mesh = meshOf(parts);
  return {
    meshes: [{ mesh, color: routeLooks[r.kind], opacity: 0.9, sheet: false }],
    bounds: boundsOf([mesh]),
    instances: [{ path: [siteRouteId(r.id)], matrix: identity, selected }],
  };
}

/** The heading (rad, from +x) a trip moves in at `t` (minutes), from where it is a moment on. */
export function tripHeading(trip: Trip, t: number): number {
  const dt = Math.min(0.02, (trip.end - trip.start) / 50) || 0.01;
  const [a, b] = t + dt <= trip.end ? [trip.at(t), trip.at(t + dt)] : [trip.at(t - dt), trip.at(t)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

let figure: CharacterFixture | undefined;
/** The blocky figure (F-C1), made once. */
const walkerFigure = () => (figure ??= blockyFigure());

/**
 * A worker walking: the blocky figure's own `walk` action (one stride a second), turned to face
 * its way. The figure stands on +z and faces −y in its own space.
 */
export function walkerMesh(seconds: number): ViewMesh {
  const { doc, meshes } = walkerFigure();
  const walk = doc.actions.find((a) => a.id === 'walk') ?? null;
  const tick = walk ? (((seconds % 1) + 1) % 1) * walk.duration : 0;
  const posed = occupantFigure(doc, meshes, poseAt(doc, walk, tick), {
    headBone: 'head',
    hipBone: 'hip',
  });
  const parts: Part[] = posed.figure.map((m) => ({
    positions: Array.from(m.positions),
    indices: Array.from(m.indices),
  }));
  return meshOf(parts);
}

/**
 * Where each moving trip is at `t` (minutes of the day), as solids: walkers and trucks. The
 * walkers' stride follows `gait` seconds when given (real time while time plays fast), else `t`.
 */
export function moverSolids(
  trips: readonly Trip[],
  t: number,
  ground: (p: Plan) => number,
  gait?: number,
): ViewSolid[] {
  const out: ViewSolid[] = [];
  let walker: ViewMesh | undefined;
  trips.forEach((trip, k) => {
    if (t < trip.start || t > trip.end) return;
    const p = trip.at(t);
    const z = ground(p);
    const a = tripHeading(trip, t);
    if (trip.kind === 'truck') {
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const mesh = meshOf([
        beamBox(
          [p[0] - c * 4000, p[1] - s * 4000, z + 1600],
          [p[0] + c * 4000, p[1] + s * 4000, z + 1600],
          2500,
          2600,
        ),
      ]);
      out.push({
        meshes: [{ mesh, color: '#e2e8f0', opacity: 1, sheet: false }],
        bounds: boundsOf([mesh]),
        instances: [{ path: [siteMoverId(k)], matrix: identity, selected: false }],
      });
      return;
    }
    walker ??= walkerMesh(gait ?? t * 60);
    // Face −y to the heading: turn by heading + 90°.
    const r = a + Math.PI / 2;
    const [c, s] = [Math.cos(r), Math.sin(r)];
    const matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, p[0], p[1], z, 1];
    const [lo, hi] = boundsOf([walker]);
    const reach = Math.max(Math.abs(lo[0]), Math.abs(lo[1]), Math.abs(hi[0]), Math.abs(hi[1]));
    out.push({
      meshes: [{ mesh: walker, color: '#f59e0b', opacity: 1, sheet: false }],
      bounds: [
        [p[0] - reach, p[1] - reach, z + lo[2]],
        [p[0] + reach, p[1] + reach, z + hi[2]],
      ],
      instances: [{ path: [siteMoverId(k)], matrix, selected: false }],
    });
  });
  return out;
}

/**
 * One step of Play from `clock` by `dt` minutes: on through a trip, else on to the next departure
 * (the minutes when no one moves are skipped). It never passes `end`, the working day's end: there
 * (or when no trip is left) it stops.
 */
export function playStep(
  clock: number,
  dt: number,
  trips: readonly Pick<Trip, 'start' | 'end'>[],
  end: number,
): { clock: number; done: boolean } {
  // A clock already past the end (the hours were shortened) goes back to it.
  if (clock >= end) return { clock: end, done: true };
  let t = clock + dt;
  if (!trips.some((trip) => t >= trip.start && t <= trip.end)) {
    const next = trips.map((trip) => trip.start).filter((s) => s > clock);
    if (!next.length) return { clock: Math.min(end, t), done: true };
    t = Math.max(t, Math.min(...next));
  }
  return t >= end ? { clock: end, done: true } : { clock: t, done: false };
}

/** A new route's way: from `start` (the gate) to `to` (the site's middle), 10 m along x if they meet. */
export function newRoutePath(start: Plan, to: Plan): [Plan, Plan] {
  return to[0] === start[0] && to[1] === start[1]
    ? [start, [start[0] + 10000, start[1]]]
    : [start, to];
}

/** The clock kept within the working day (when the hours change under it). */
export const clockInDay = (clock: number, [start, end]: readonly [number, number]) =>
  Math.min(end, Math.max(start, clock));
