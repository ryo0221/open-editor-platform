/**
 * CR7a (docs/cad/car-design.md, A3): mass and centre of mass. A body weighs its volume (a solid)
 * or its area times its thickness (a sheet) times its density; an assembly adds up every
 * occurrence's bodies at their world poses, nested ones included (a component the BOM leaves out
 * still weighs). Pure: the evaluations come from the caller. Bodies without a mass, a sheet
 * without a thickness, and versions not evaluated yet are listed as left out, never counted as 0.
 */
import {
  expandAssembly,
  occurrenceAccess,
  rotateVector,
  type CadPartLookup,
  type CadSolvedPose,
} from './assembly';
import type { CadBodyEvaluation } from './coordinator';
import type { CadBody, CadDocument, Vec3 } from './model';

export type CadMassGap =
  | 'mass-missing'
  | 'mass-thickness-missing'
  | 'mass-not-evaluated'
  /** A placed part (or the sub-assembly holding it) this person may no longer read. */
  | 'mass-no-access'
  /** A placed version whose content is not in the retained closure (or failed its check). */
  | 'mass-part-missing'
  /**
   * A placed version that failed to evaluate, e.g. a sub-assembly whose saved poses do not match
   * its joints: what it places is left out with it.
   */
  | 'mass-part-failed'
  /**
   * A placed version evaluated only for reference (another build) or not at all here: its joints
   * and poses were not checked, so neither it nor what it places is weighed.
   */
  | 'mass-part-unavailable';
export interface CadMassItem {
  /** Component IDs from the assembly down (`[]`: this document's own bodies). */
  path: string[];
  bodyId: string;
  name: string;
  massKg: number;
  /** In the assembly's coordinates (mm). */
  centroidMm: Vec3;
}
export interface CadMassLeftOut {
  path: string[];
  /** `''` for an occurrence left out whole (no access, no content): its bodies are not named. */
  bodyId: string;
  /** The body's name, or the part's for an occurrence left out whole. */
  name: string;
  code: CadMassGap;
}
export interface CadMassResult {
  massKg: number;
  /** Absent while nothing weighs. */
  centroidMm?: Vec3;
  items: CadMassItem[];
  leftOut: CadMassLeftOut[];
}

/** kg per (kg/m³ × mm³). */
const perMm3 = 1e-9;

/** One body's mass and centre in its own document, or why it has none. */
export function bodyMass(
  body: CadBody,
  evaluation: CadBodyEvaluation | undefined,
): { massKg: number; centroidMm: Vec3 } | { code: CadMassGap } {
  if (!body.mass) return { code: 'mass-missing' };
  if (!evaluation?.centroidMm) return { code: 'mass-not-evaluated' };
  const { densityKgM3, thicknessMm } = body.mass;
  if (evaluation.kind === 'sheet') {
    if (thicknessMm === undefined) return { code: 'mass-thickness-missing' };
    return {
      massKg: evaluation.areaMm2 * thicknessMm * densityKgM3 * perMm3,
      centroidMm: evaluation.centroidMm,
    };
  }
  return { massKg: evaluation.volumeMm3 * densityKgM3 * perMm3, centroidMm: evaluation.centroidMm };
}

const place = (pose: CadSolvedPose, p: Vec3): Vec3 => {
  const r = rotateVector(pose.rotation, p);
  return [r[0] + pose.translationMm[0], r[1] + pose.translationMm[1], r[2] + pose.translationMm[2]];
};

/** The weighted centre of `items` (undefined when they weigh nothing). */
export function centreOf(items: readonly Pick<CadMassItem, 'massKg' | 'centroidMm'>[]) {
  const m = items.reduce((t, i) => t + i.massKg, 0);
  if (!(m > 0)) return undefined;
  const c: Vec3 = [0, 0, 0];
  for (const i of items) for (let k = 0; k < 3; k++) c[k]! += (i.massKg * i.centroidMm[k]!) / m;
  return c;
}

/**
 * The mass of `doc` and everything it places. `own` is this document's body evaluations;
 * `versions` each placed version's (by content hash), as the assembly evaluation reports them.
 * `access` is the Host's current read access to a part's Artifact: an occurrence it denies (or
 * one inside a denied sub-assembly) weighs nothing and only its part's name is listed, even when
 * the same version is placed readably elsewhere.
 */
export function cadMass(
  doc: CadDocument,
  own: Record<string, CadBodyEvaluation> | undefined,
  lookup: CadPartLookup,
  versions:
    | Record<string, { state?: string; bodies?: Record<string, CadBodyEvaluation> }>
    | undefined,
  access: (artifactId: string) => boolean = () => true,
): CadMassResult {
  const items: CadMassItem[] = [];
  const leftOut: CadMassLeftOut[] = [];
  const add = (
    content: CadDocument,
    bodies: Record<string, CadBodyEvaluation> | undefined,
    path: string[],
    pose: CadSolvedPose | undefined,
  ) => {
    for (const body of content.bodies) {
      if (body.state !== 'active') continue;
      const m = bodyMass(body, bodies?.[body.id]);
      const base = { path, bodyId: body.id, name: body.name };
      if ('code' in m) leftOut.push({ ...base, code: m.code });
      else
        items.push({
          ...base,
          massKg: m.massKg,
          centroidMm: pose ? place(pose, m.centroidMm) : m.centroidMm,
        });
    }
  };
  add(doc, own, [], undefined);
  const { occurrences } = expandAssembly(doc, lookup);
  const allowed = occurrenceAccess(occurrences, access);
  // An occurrence left out whole is listed once; what it places is left out with it (its poses
  // inside a failed sub-assembly are the rejected stored ones, its bodies not to be named).
  const outside: string[][] = [];
  const within = (path: string[]) => outside.some((p) => p.every((s, k) => path[k] === s));
  occurrences.forEach((o, i) => {
    if (within(o.path)) return;
    const version = versions?.[o.part.source.contentHash];
    const code: CadMassGap | undefined = !allowed[i]
      ? 'mass-no-access'
      : !o.content
        ? 'mass-part-missing'
        : version?.state === 'failed'
          ? 'mass-part-failed'
          : version && version.state !== undefined && version.state !== 'available'
            ? 'mass-part-unavailable'
            : undefined;
    if (code) {
      outside.push(o.path);
      leftOut.push({ path: o.path, bodyId: '', name: o.part.name, code });
      return;
    }
    add(o.content!, version?.bodies, o.path, o.pose);
  });
  const massKg = items.reduce((t, i) => t + i.massKg, 0);
  const centroidMm = centreOf(items);
  return { massKg, ...(centroidMm ? { centroidMm } : {}), items, leftOut };
}

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length > 0 && prefix.every((s, i) => path[i] === s);

/** The weighted centre of what one component (and all it places) weighs. */
export function componentCentre(result: CadMassResult, path: readonly string[]) {
  return centreOf(result.items.filter((i) => startsWith(i.path, path)));
}

/**
 * The front/rear weight split: the centre of mass between the front and the rear axle (each the
 * centre of the components given, e.g. the two front wheels), along the line through them. A
 * centre outside the axles gives a share below 0 or above 1, as a lever would.
 */
export function axleSplit(
  result: CadMassResult,
  front: readonly (readonly string[])[],
  rear: readonly (readonly string[])[],
): { front: number; rear: number; wheelbaseMm: number } | { code: string } {
  if (!result.centroidMm) return { code: 'mass-empty' };
  const axle = (paths: readonly (readonly string[])[]) =>
    centreOf(result.items.filter((i) => paths.some((p) => startsWith(i.path, p))));
  const f = axle(front);
  const r = axle(rear);
  if (!f || !r) return { code: 'mass-axle-empty' };
  const d: Vec3 = [r[0] - f[0], r[1] - f[1], r[2] - f[2]];
  const wheelbaseMm = Math.hypot(...d);
  if (!(wheelbaseMm > 1)) return { code: 'mass-axle-same' };
  const c = result.centroidMm;
  // How far along front → rear the centre lies (0 at the front axle, 1 at the rear).
  const t = ((c[0] - f[0]) * d[0] + (c[1] - f[1]) * d[1] + (c[2] - f[2]) * d[2]) / wheelbaseMm ** 2;
  return { front: 1 - t, rear: t, wheelbaseMm };
}
