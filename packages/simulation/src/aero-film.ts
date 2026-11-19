import {
  simulationLimits,
  type SimulationLoad,
  type SimulationTarget,
} from '@editor-platform/simulation-core';
import type { AeroRunFields } from './aero-view';

/**
 * VS12c (docs/cad/vehicle-simulation.md, VS11・VS12): the Host wind tunnel's heat transfer
 * coefficient on the faces of a heat analysis, one way (VS-U9). The tunnel's surface keeps the
 * topology face of each triangle (`AeroRunFields.faces`); a face's film is the area mean over its
 * triangles of the triangle's mean of its points' values. A face the tunnel has no triangle on
 * takes the empirical film and is listed. The browser tunnel gives no coefficient. Films in
 * mW/(mm²·K) (= kW/(m²·K)); the Host writes W/(m²·K).
 */

/** W/(m²·K) to mW/(mm²·K). */
export const filmFromSi = (h: number) => h * 1e-3;

export interface AeroFilm {
  /** mW/(mm²·K). */
  film: number;
  /** The tunnel triangles' area (mm²). */
  area: number;
  triangles: number;
  /** Their area-weighted centroid (mm) and outward normal (unit; short where they turn). */
  centroid: [number, number, number];
  normal: [number, number, number];
}

interface Sum {
  hA: number;
  area: number;
  triangles: number;
  c: number[];
  n: number[];
}

const need = (fields: AeroRunFields) => {
  if (!fields.htc) throw new RangeError('aero-film: the run has no heat transfer (a Host run has)');
  return fields.htc;
};

/** The area and the mean of `htc` over triangle `t`. */
function triangle(fields: AeroRunFields, htc: Float64Array, t: number) {
  const p = fields.points;
  const [a, b, c] = [0, 1, 2].map((k) => fields.triangles[3 * t + k]!);
  const u = [0, 1, 2].map((k) => p[3 * b! + k]! - p[3 * a! + k]!);
  const v = [0, 1, 2].map((k) => p[3 * c! + k]! - p[3 * a! + k]!);
  const n = [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
  return {
    area: 0.5 * Math.hypot(n[0]!, n[1]!, n[2]!),
    normal: n,
    centroid: [0, 1, 2].map((k) => (p[3 * a! + k]! + p[3 * b! + k]! + p[3 * c! + k]!) / 3),
    h: (htc[a!]! + htc[b!]! + htc[c!]!) / 3,
  };
}

const add = (to: Map<number, Sum>, key: number, tri: ReturnType<typeof triangle>) => {
  const e = to.get(key) ?? { hA: 0, area: 0, triangles: 0, c: [0, 0, 0], n: [0, 0, 0] };
  e.hA += tri.h * tri.area;
  e.area += tri.area;
  e.triangles++;
  for (let k = 0; k < 3; k++) {
    e.c[k]! += tri.centroid[k]! * tri.area;
    // The cross product is twice the area along the normal.
    e.n[k]! += tri.normal[k]! / 2;
  }
  to.set(key, e);
};

const films = (sums: Map<number, Sum>) =>
  new Map<number, AeroFilm>(
    [...sums]
      .filter(([, e]) => e.area > 0)
      .map(([k, e]) => [
        k,
        {
          film: filmFromSi(e.hA / e.area),
          area: e.area,
          triangles: e.triangles,
          centroid: e.c.map((x) => x / e.area) as [number, number, number],
          normal: e.n.map((x) => x / e.area) as [number, number, number],
        },
      ]),
  );

/** Each topology face of body `bodyId` the tunnel has triangles on, with its film. */
export function aeroFaceFilms(fields: AeroRunFields, bodyId: string): Map<number, AeroFilm> {
  const htc = need(fields);
  if (!fields.faces || !fields.bodies)
    throw new RangeError('aero-film: the run keeps no faces (run the tunnel again)');
  const at = fields.bodies.ids.indexOf(bodyId);
  if (at < 0) throw new RangeError(`aero-film: ${bodyId} was not in the tunnel`);
  let first = 0;
  for (let i = 0; i < at; i++) first += fields.bodies.triangles[i]!;
  const sums = new Map<number, Sum>();
  for (let t = first; t < first + fields.bodies.triangles[at]!; t++) {
    const face = fields.faces[t]!;
    if (face >= 0) add(sums, face, triangle(fields, htc, t));
  }
  return films(sums);
}

/** A box of the vehicle frame: [min, size] (mm). */
export interface AeroBox {
  min: readonly number[];
  size: readonly number[];
}

/**
 * The film over the tunnel's triangles whose centroid is inside `box` (all bodies), those whose
 * outward normal is within 60° of `facing` when it is given (a unit vector).
 */
export function aeroRegionFilm(
  fields: AeroRunFields,
  box: AeroBox,
  facing?: readonly [number, number, number],
): AeroFilm {
  const htc = need(fields);
  const sums = new Map<number, Sum>();
  for (let t = 0; t < fields.triangles.length / 3; t++) {
    const tri = triangle(fields, htc, t);
    const { area, centroid, normal } = tri;
    if (!centroid.every((x, k) => x >= box.min[k]! && x <= box.min[k]! + box.size[k]!)) continue;
    if (facing && !(normal.reduce((a, x, k) => a + x * facing[k]!, 0) >= 0.5 * 2 * area)) continue;
    add(sums, 0, tri);
  }
  const f = films(sums).get(0);
  if (!f) throw new RangeError('aero-film: no tunnel triangle in the box');
  return f;
}

export interface AeroConvection {
  loads: Extract<SimulationLoad, { kind: 'convection' }>[];
  /** Each face's film and where it is from. */
  faces: { face: number; film: number; from: 'aero' | 'empirical' }[];
  /** The faces the tunnel has no triangle on (they take the empirical film). */
  fallback: number[];
}

/**
 * Convection loads on `faces` from the tunnel's films (`aeroFaceFilms`), `empirical(face)` where
 * the tunnel has none. Faces whose films are within `ratio` (default 5 %) of each other share one
 * load at their area mean, so a body of many faces stays within `maxLoads` (default 16): the ratio
 * (at least 1) widens until it does. A group of more faces than a load holds
 * (`simulationLimits.targetsPerItem`) is split into loads of the same coefficient, and those
 * count towards `maxLoads`; faces too many for `maxLoads` full loads are refused (Codex on #1288).
 * `target(face)` is the face's target; ids are `${id}-1`, `${id}-2`, …
 */
export function aeroConvection(
  faces: readonly number[],
  aero: ReadonlyMap<number, AeroFilm>,
  empirical: (face: number) => number,
  target: (face: number) => SimulationTarget,
  o: {
    id: string;
    name: string;
    ambient: number;
    /** The face's area (mm², the topology table's), to weight a shared load's coefficient. */
    area: (face: number) => number;
    ratio?: number;
    maxLoads?: number;
  },
): AeroConvection {
  const each = faces.map((face) => {
    const a = aero.get(face);
    return a
      ? { face, film: a.film, from: 'aero' as const }
      : { face, film: empirical(face), from: 'empirical' as const };
  });
  for (const f of each)
    if (!(f.film > 0) || !Number.isFinite(f.film))
      throw new RangeError(`aero-film: face ${f.face} has no positive film`);
  const maxLoads = o.maxLoads ?? 16;
  if (!(maxLoads >= 1)) throw new RangeError('aero-film: maxLoads must be at least 1');
  let ratio = o.ratio ?? 1.05;
  if (!(ratio >= 1) || !Number.isFinite(ratio))
    throw new RangeError('aero-film: ratio must be a finite number of at least 1');
  const per = simulationLimits.targetsPerItem;
  if (Math.ceil(each.length / per) > maxLoads)
    throw new RangeError(
      `aero-film: ${each.length} faces need more than ${maxLoads} loads of ${per} faces`,
    );
  const area = o.area;
  const sorted = [...each].sort((a, b) => a.film - b.film);
  const chunks = (gs: (typeof each)[]) => gs.reduce((a, g) => a + Math.ceil(g.length / per), 0);
  let groups: (typeof each)[] = [];
  for (;;) {
    groups = [];
    for (const f of sorted) {
      const g = groups.at(-1);
      if (g && f.film <= g[0]!.film * ratio) g.push(f);
      else groups.push([f]);
    }
    // One group splits into the fewest loads, so the check above ends this.
    if (chunks(groups) <= maxLoads) break;
    ratio *= 1.5;
  }
  const loads = groups
    .flatMap((g) => {
      const w = g.reduce((a, f) => a + area(f.face), 0);
      const coefficient = g.reduce((a, f) => a + f.film * area(f.face), 0) / w;
      return Array.from({ length: Math.ceil(g.length / per) }, (_, k) => ({
        faces: g.slice(k * per, (k + 1) * per),
        coefficient,
      }));
    })
    .map((c, i) => ({
      id: `${o.id}-${i + 1}`,
      name: `${o.name} ${i + 1}`,
      kind: 'convection' as const,
      targets: c.faces.map((f) => target(f.face)),
      coefficient: c.coefficient,
      ambient: o.ambient,
    }));
  return {
    loads,
    faces: each,
    fallback: each.filter((f) => f.from === 'empirical').map((f) => f.face),
  };
}
