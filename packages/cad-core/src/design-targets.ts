/**
 * PD1 (docs/cad/product-design.md, PD1 設計の目標値): a document's design targets. Each target
 * names one measured value (a parameter, a body's size along an axis, the distance between two
 * groups of bodies, a mass, a volume, an area or a proportion indicator), the band it must fall in
 * and, as plain text, the requirement it comes from (PD-U2). The targets are stored in the
 * document; the values are measured from the current evaluation and display meshes and never
 * stored. A value that cannot be measured now is reported as unknown with its reason, never as a
 * pass.
 */
import { meshClearance } from '@editor-platform/geometry-core/clearance';
import type { CadBodyEvaluation } from './coordinator';
import { parameterValues } from './graph';
import { bodyMass, type CadMassResult } from './mass';
import type { CadDocument } from './model';
import { resolveSpring, springEstimate, springProblem, type CadSpringEstimate } from './spring';
import {
  cadProportionMetrics,
  measureProportions,
  type CadProportionMesh,
  type CadProportionMetric,
} from './proportions';
import { cadStackBandSlackMm, cadToleranceStacks, type CadStackResult } from './tolerance-stacks';

export type CadDesignAxis = 'x' | 'y' | 'z';
export type CadDesignMeasure =
  /** A parameter's value (mm, rad or a count). */
  | { kind: 'parameter'; parameterId: string }
  /** The size of the bodies' box together along one axis (mm). */
  | { kind: 'extent'; bodyIds: string[]; axis: CadDesignAxis }
  /** The shortest distance between the bodies `a` and the bodies `b` (mm, on the meshes). */
  | { kind: 'distance'; a: string[]; b: string[] }
  /**
   * The bodies' mass (kg). Without `bodyIds`, the whole document with everything it places (as
   * the assembly's mass panel weighs it).
   */
  | { kind: 'mass'; bodyIds?: string[] }
  /** The solids' volume (mm³) or the bodies' area (mm²), summed. */
  | { kind: 'volume'; bodyIds: string[] }
  | { kind: 'area'; bodyIds: string[] }
  /** One of the proportion indicators (CLF3), with the document's proportion setup. */
  | { kind: 'proportion'; metric: CadProportionMetric }
  /** PD5: one value of a spring feature's textbook estimate (`spring.ts`). */
  | { kind: 'spring'; featureId: string; quantity: CadSpringQuantity }
  /** PD3: one number of a tolerance stack of the document (mm, or a fraction of runs). */
  | { kind: 'tolerance-stack'; stackId: string; value: CadDesignStackValue };
/** Which number of a stack: its nominal, a method's ends, or the Monte Carlo outside fraction. */
export type CadDesignStackValue =
  | 'nominal'
  | 'worst-min'
  | 'worst-max'
  | 'rss-min'
  | 'rss-max'
  | 'mc-min'
  | 'mc-max'
  | 'mc-outside';
export const cadDesignStackValues: readonly CadDesignStackValue[] = Object.freeze([
  'nominal',
  'worst-min',
  'worst-max',
  'rss-min',
  'rss-max',
  'mc-min',
  'mc-max',
  'mc-outside',
]);
export type CadDesignMeasureKind = CadDesignMeasure['kind'];
export interface CadDesignTarget {
  id: string;
  name: string;
  /** The requirement it comes from, as written in the project (e.g. `RQ-03`); plain text. */
  requirement?: string;
  measure: CadDesignMeasure;
  /** The band (either end may be open, not both), in the measure's unit. */
  min?: number;
  max?: number;
}
export const cadDesignTargetLimits = Object.freeze({
  targets: 256,
  bodiesPerList: 64,
  requirementLength: 128,
  /** Any band end within ±this. */
  bandLimit: 1e12,
});
export const cadDesignMeasureKinds: readonly CadDesignMeasureKind[] = Object.freeze([
  'parameter',
  'extent',
  'distance',
  'mass',
  'volume',
  'area',
  'proportion',
  'spring',
  'tolerance-stack',
]);
export type CadDesignUnit =
  | 'mm'
  | 'rad'
  | 'count'
  | 'kg'
  | 'mm3'
  | 'mm2'
  | 'ratio'
  | 'deg'
  | 'N/mm'
  | 'N·mm/rad'
  | 'N'
  | 'N·mm'
  | 'MPa'
  | 'turns'
  | 'h';

export type CadDesignTargetsOperation = {
  type: 'setDesignTargets';
  /** The whole list; empty removes it. */
  targets: CadDesignTarget[];
};
export function applyDesignTargetsOperation(next: CadDocument, op: CadDesignTargetsOperation) {
  const before = JSON.stringify(next.designTargets ?? []);
  if (before === JSON.stringify(op.targets)) throw new Error('design-targets-unchanged');
  if (op.targets.length) next.designTargets = structuredClone(op.targets);
  else delete next.designTargets;
  return next;
}

const bodyLists = (m: CadDesignMeasure): string[][] =>
  m.kind === 'distance'
    ? [m.a, m.b]
    : m.kind === 'extent' || m.kind === 'volume' || m.kind === 'area'
      ? [m.bodyIds]
      : m.kind === 'mass' && m.bodyIds
        ? [m.bodyIds]
        : [];

/**
 * A removed body leaves every target's lists, a removed parameter its target and a removed spring
 * feature (PD5) its target. A target left
 * with an empty list (or without its parameter) goes with it: it no longer measures what it said.
 */
export function pruneDesignTargets(
  doc: CadDocument,
  removedBodies: ReadonlySet<string>,
  removedParameters: ReadonlySet<string> = new Set(),
) {
  if (!doc.designTargets) return;
  const kept: CadDesignTarget[] = [];
  const springs = new Set(doc.features.flatMap((f) => (f.type === 'spring' ? [f.id] : [])));
  for (const t of doc.designTargets) {
    const m = t.measure;
    // PD5: a spring target goes with its spring feature.
    if (m.kind === 'spring') {
      if (springs.has(m.featureId)) kept.push(t);
      continue;
    }
    if (m.kind === 'parameter') {
      if (!removedParameters.has(m.parameterId)) kept.push(t);
      continue;
    }
    const lists = bodyLists(m);
    if (!lists.some((l) => l.some((id) => removedBodies.has(id)))) {
      kept.push(t);
      continue;
    }
    const drop = (l: string[]) => l.filter((id) => !removedBodies.has(id));
    // Lists are only on these kinds (a proportion has none, so it never reaches here).
    const measure: CadDesignMeasure =
      m.kind === 'distance'
        ? { ...m, a: drop(m.a), b: drop(m.b) }
        : m.kind === 'extent' || m.kind === 'volume' || m.kind === 'area' || m.kind === 'mass'
          ? { ...m, bodyIds: drop(m.bodyIds!) }
          : m;
    if (bodyLists(measure).every((l) => l.length)) kept.push({ ...t, measure });
  }
  if (kept.length) doc.designTargets = kept;
  else delete doc.designTargets;
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export interface DesignTargetsCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): boolean;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `designTargets`: 1–256 targets with distinct IDs, each a known measure over
 * distinct active bodies (or an existing parameter), a band with at least one finite end and
 * min ≤ max, and a short requirement text.
 */
export function validateDesignTargets(
  c: DesignTargetsCheck,
  list: unknown,
  active: ReadonlySet<string>,
  parameters: ReadonlySet<string>,
  stacks: ReadonlySet<string> = new Set(),
  springs: ReadonlySet<string> = new Set(),
) {
  const path = '$.designTargets';
  const L = cadDesignTargetLimits;
  if (!Array.isArray(list) || !list.length || list.length > L.targets)
    return void c.error('design-targets', path);
  const ids = new Set<string>();
  list.forEach((t, i) => {
    const at = `${path}[${i}]`;
    if (!record(t)) return c.error('design-target', at);
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
      c.error('design-target-requirement', `${at}.requirement`);
    for (const k of ['min', 'max'] as const)
      if (Object.hasOwn(t, k) && !(finite(t[k]) && Math.abs(t[k] as number) <= L.bandLimit))
        c.error('design-target-band', `${at}.${k}`);
    if (!Object.hasOwn(t, 'min') && !Object.hasOwn(t, 'max'))
      c.error('design-target-band', `${at}`);
    if (finite(t.min) && finite(t.max) && t.min > t.max) c.error('design-target-band', `${at}.max`);
    checkMeasure(c, t.measure, `${at}.measure`, active, parameters, stacks, springs);
  });
}
function checkMeasure(
  c: DesignTargetsCheck,
  m: unknown,
  at: string,
  active: ReadonlySet<string>,
  parameters: ReadonlySet<string>,
  stacks: ReadonlySet<string>,
  springs: ReadonlySet<string>,
) {
  if (!record(m) || typeof m.kind !== 'string' || !cadDesignMeasureKinds.includes(m.kind as never))
    return void c.error('design-target-measure', at);
  const bodies = (v: unknown, p: string) => {
    if (!Array.isArray(v) || !v.length || v.length > cadDesignTargetLimits.bodiesPerList)
      return void c.error('design-target-bodies', p);
    const seen = new Set<unknown>();
    v.forEach((id, j) => {
      if (typeof id !== 'string' || !active.has(id))
        return c.error('design-target-body', `${p}[${j}]`);
      if (seen.has(id)) return c.error('design-target-body-twice', `${p}[${j}]`);
      seen.add(id);
    });
  };
  switch (m.kind as CadDesignMeasureKind) {
    case 'parameter':
      c.keys(m, ['kind', 'parameterId'], at);
      if (typeof m.parameterId !== 'string' || !parameters.has(m.parameterId))
        c.error('design-target-parameter', `${at}.parameterId`);
      return;
    case 'extent':
      c.keys(m, ['kind', 'bodyIds', 'axis'], at);
      bodies(m.bodyIds, `${at}.bodyIds`);
      if (m.axis !== 'x' && m.axis !== 'y' && m.axis !== 'z')
        c.error('design-target-axis', `${at}.axis`);
      return;
    case 'distance': {
      c.keys(m, ['kind', 'a', 'b'], at);
      bodies(m.a, `${at}.a`);
      bodies(m.b, `${at}.b`);
      const b = m.b;
      if (Array.isArray(m.a) && Array.isArray(b) && m.a.some((id) => b.includes(id)))
        c.error('design-target-distance-same', at);
      return;
    }
    case 'mass':
      c.keys(m, ['kind'], at, ['bodyIds']);
      if (Object.hasOwn(m, 'bodyIds')) bodies(m.bodyIds, `${at}.bodyIds`);
      return;
    case 'volume':
    case 'area':
      c.keys(m, ['kind', 'bodyIds'], at);
      bodies(m.bodyIds, `${at}.bodyIds`);
      return;
    case 'proportion':
      c.keys(m, ['kind', 'metric'], at);
      if (typeof m.metric !== 'string' || !Object.hasOwn(cadProportionMetrics, m.metric))
        c.error('design-target-metric', `${at}.metric`);
      return;
    case 'spring':
      c.keys(m, ['kind', 'featureId', 'quantity'], at);
      if (typeof m.featureId !== 'string' || !springs.has(m.featureId))
        c.error('design-target-spring', `${at}.featureId`);
      if (typeof m.quantity !== 'string' || !cadSpringQuantities.includes(m.quantity as never))
        c.error('design-target-spring-quantity', `${at}.quantity`);
      return;
    case 'tolerance-stack':
      c.keys(m, ['kind', 'stackId', 'value'], at);
      if (typeof m.stackId !== 'string' || !stacks.has(m.stackId))
        c.error('design-target-stack', `${at}.stackId`);
      if (typeof m.value !== 'string' || !cadDesignStackValues.includes(m.value as never))
        c.error('design-target-stack-value', `${at}.value`);
      return;
  }
}

/** Why a value is not measured now. */
export type CadDesignUnknown =
  /** The document's own evaluation is not at hand (evaluating, failed, or another build's). */
  | 'design-not-evaluated'
  /** A body named has no display mesh (or no evaluation) in it. */
  | 'design-body-missing'
  /** A mass left out bodies (no density, a sheet without a thickness, a part not readable). */
  | 'design-mass-left-out'
  /** A volume of a sheet. */
  | 'design-volume-sheet'
  /** A proportion without a proportion setup, or one whose roles give no value. */
  | 'design-proportion-missing'
  /** The meshes are too large to measure a distance on. */
  | 'design-distance-limit'
  /** PD5: the spring's arguments do not give a spring now (`springProblem`). */
  | 'design-spring-invalid'
  /** PD5: the quantity is not one this spring has (a run time without hours per barrel turn). */
  | 'design-spring-quantity'
  /** PD3: the stack is stale (a contributor no longer resolves). */
  | 'design-stack-stale';
export interface CadDesignTargetResult {
  id: string;
  unit: CadDesignUnit;
  /** Absent when unknown. */
  value?: number;
  status: 'pass' | 'fail' | 'unknown';
  /** With `unknown`. */
  reason?: CadDesignUnknown;
}
export interface CadDesignMeasureInput {
  /** This document's own body evaluations (absent: not evaluated with its own build). */
  bodies?: Record<string, CadBodyEvaluation>;
  /** This document's own display meshes in world mm (the standard meshes, not an LOD). */
  meshes?: readonly CadProportionMesh[];
  /** The whole document's mass (with what it places), for a mass without bodies. */
  mass?: CadMassResult;
  /** PD3: the document's stack results (absent: worked out here, without PMI). */
  stacks?: readonly CadStackResult[];
}

export function designUnit(doc: CadDocument, m: CadDesignMeasure): CadDesignUnit {
  switch (m.kind) {
    case 'parameter': {
      const type = doc.parameters.find((p) => p.id === m.parameterId)?.type;
      return type === 'angle' ? 'rad' : type === 'count' ? 'count' : 'mm';
    }
    case 'extent':
    case 'distance':
      return 'mm';
    case 'mass':
      return 'kg';
    case 'volume':
      return 'mm3';
    case 'area':
      return 'mm2';
    case 'proportion':
      return cadProportionMetrics[m.metric].unit;
    case 'spring':
      return springQuantityUnit(doc, m);
    case 'tolerance-stack':
      return m.value === 'mc-outside' ? 'ratio' : 'mm';
  }
}

/**
 * PD1: each target's value and whether it is inside its band. Distances and extents are read on
 * the display meshes (as precise as their tessellation, like the clearance check); masses,
 * volumes and areas on the evaluation; a parameter from the document itself.
 */
export function measureDesignTargets(
  doc: CadDocument,
  input: CadDesignMeasureInput,
): CadDesignTargetResult[] {
  const targets = doc.designTargets ?? [];
  if (!targets.length) return [];
  const values = parameterValues(doc);
  const byBody = new Map<string, CadProportionMesh[]>();
  for (const m of input.meshes ?? []) byBody.set(m.bodyId, [...(byBody.get(m.bodyId) ?? []), m]);
  const proportions =
    doc.proportions && input.meshes ? measureProportions(doc.proportions, input.meshes) : undefined;
  let stacks: Map<string, CadStackResult> | undefined;
  const stackResult = (id: string) =>
    (stacks ??= new Map(
      (input.stacks ?? cadToleranceStacks(doc)).map((r) => [r.id, r] as const),
    )).get(id);
  const meshed = (ids: readonly string[]) => ids.every((id) => byBody.has(id));
  const evaluated = (ids: readonly string[]) => ids.every((id) => input.bodies?.[id]);
  const one = (
    m: CadDesignMeasure,
  ): { value: number } | { reason: CadDesignUnknown } | undefined => {
    switch (m.kind) {
      case 'parameter': {
        const v = values.get(m.parameterId);
        return v ? { value: v.value } : undefined;
      }
      case 'extent': {
        if (!input.meshes) return { reason: 'design-not-evaluated' };
        if (!meshed(m.bodyIds)) return { reason: 'design-body-missing' };
        const k = { x: 0, y: 1, z: 2 }[m.axis];
        let lo = Infinity;
        let hi = -Infinity;
        for (const id of m.bodyIds)
          for (const mesh of byBody.get(id)!)
            for (let i = k; i < mesh.points.length; i += 3) {
              lo = Math.min(lo, mesh.points[i]!);
              hi = Math.max(hi, mesh.points[i]!);
            }
        return hi >= lo ? { value: hi - lo } : { reason: 'design-body-missing' };
      }
      case 'distance': {
        if (!input.meshes) return { reason: 'design-not-evaluated' };
        if (!meshed(m.a) || !meshed(m.b)) return { reason: 'design-body-missing' };
        const pose = {
          rotation: [0, 0, 0, 1] as [number, number, number, number],
          translationMm: [0, 0, 0] as [number, number, number],
        };
        const piece = (ids: readonly string[]) => [
          {
            meshes: ids.flatMap((id) =>
              byBody
                .get(id)!
                .flatMap((x) => (x.indices ? [{ positions: x.points, indices: x.indices }] : [])),
            ),
            pose,
          },
        ];
        try {
          const r = meshClearance(piece(m.a), piece(m.b));
          return r ? { value: r.distanceMm } : { reason: 'design-body-missing' };
        } catch {
          return { reason: 'design-distance-limit' };
        }
      }
      case 'mass': {
        if (!m.bodyIds) {
          if (!input.mass) return { reason: 'design-not-evaluated' };
          return input.mass.leftOut.length
            ? { reason: 'design-mass-left-out' }
            : { value: input.mass.massKg };
        }
        if (!input.bodies) return { reason: 'design-not-evaluated' };
        let kg = 0;
        for (const id of m.bodyIds) {
          const body = doc.bodies.find((b) => b.id === id);
          if (!body || !input.bodies[id]) return { reason: 'design-body-missing' };
          const r = bodyMass(body, input.bodies[id], doc.partProperties.material);
          if ('code' in r)
            return {
              reason:
                r.code === 'mass-not-evaluated' ? 'design-body-missing' : 'design-mass-left-out',
            };
          kg += r.massKg;
        }
        return { value: kg };
      }
      case 'volume':
      case 'area': {
        if (!input.bodies) return { reason: 'design-not-evaluated' };
        if (!evaluated(m.bodyIds)) return { reason: 'design-body-missing' };
        let sum = 0;
        for (const id of m.bodyIds) {
          const e = input.bodies[id]!;
          if (m.kind === 'area') sum += e.areaMm2;
          else if (e.kind === 'solid') sum += e.volumeMm3;
          else return { reason: 'design-volume-sheet' };
        }
        return { value: sum };
      }
      case 'proportion': {
        if (!doc.proportions) return { reason: 'design-proportion-missing' };
        if (!proportions) return { reason: 'design-not-evaluated' };
        const v = proportions.find((p) => p.metric === m.metric)?.value;
        return v === undefined ? { reason: 'design-proportion-missing' } : { value: v };
      }
      case 'spring': {
        const f = doc.features.find((x) => x.id === m.featureId);
        if (f?.type !== 'spring') return { reason: 'design-spring-invalid' };
        let spec;
        try {
          spec = resolveSpring(f.args, values);
        } catch {
          return { reason: 'design-spring-invalid' };
        }
        if (springProblem(spec)) return { reason: 'design-spring-invalid' };
        const v = springQuantity(springEstimate(spec), m.quantity);
        return v === undefined ? { reason: 'design-spring-quantity' } : { value: v };
      }
      case 'tolerance-stack': {
        const r = stackResult(m.stackId);
        if (!r || r.status !== 'ok') return { reason: 'design-stack-stale' };
        const value =
          m.value === 'nominal'
            ? r.nominal
            : m.value === 'worst-min'
              ? r.worst?.min
              : m.value === 'worst-max'
                ? r.worst?.max
                : m.value === 'rss-min'
                  ? r.rss?.min
                  : m.value === 'rss-max'
                    ? r.rss?.max
                    : m.value === 'mc-min'
                      ? r.monteCarlo?.min
                      : m.value === 'mc-max'
                        ? r.monteCarlo?.max
                        : r.monteCarlo?.outsideFraction;
        return value === undefined ? { reason: 'design-stack-stale' } : { value };
      }
    }
  };
  return targets.map((t) => {
    const unit = designUnit(doc, t.measure);
    const r = one(t.measure) ?? { reason: 'design-not-evaluated' as const };
    if ('reason' in r) return { id: t.id, unit, status: 'unknown', reason: r.reason };
    // A stack's lengths are compared with the stack's own rounding slack, so a target on a
    // stack and the stack's band agree at an inclusive end.
    const slack =
      t.measure.kind === 'tolerance-stack' && t.measure.value !== 'mc-outside'
        ? cadStackBandSlackMm
        : 0;
    const inside =
      (t.min === undefined || r.value >= t.min - slack) &&
      (t.max === undefined || r.value <= t.max + slack);
    return { id: t.id, unit, value: r.value, status: inside ? 'pass' : 'fail' };
  });
}

/** The targets and their results as one JSON-ready record (for a project's verification). */
export function designTargetReport(
  doc: CadDocument,
  results: readonly CadDesignTargetResult[],
  documentName?: string,
) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const targets = (doc.designTargets ?? []).map((t) => {
    const r = byId.get(t.id);
    return {
      id: t.id,
      name: t.name,
      ...(t.requirement ? { requirement: t.requirement } : {}),
      measure: t.measure,
      ...(t.min !== undefined ? { min: t.min } : {}),
      ...(t.max !== undefined ? { max: t.max } : {}),
      unit: r?.unit ?? designUnit(doc, t.measure),
      ...(r?.value !== undefined ? { value: r.value } : {}),
      status: r?.status ?? 'unknown',
      ...(r?.reason ? { reason: r.reason } : {}),
    };
  });
  const count = (s: string) => targets.filter((t) => t.status === s).length;
  return {
    format: 'editor-platform/cad-design-targets@1',
    ...(documentName ? { document: documentName } : {}),
    summary: { pass: count('pass'), fail: count('fail'), unknown: count('unknown') },
    targets,
  };
}

/** PD5: the values of a spring's estimate a target can read. */
export type CadSpringQuantity =
  /** Spring rate: N/mm (compression, extension) or N·mm/rad (torsion, spiral). */
  | 'rate'
  /** At the working deflection: force (N); at the working angle: torque (N·mm); and the stress. */
  | 'workingForce'
  | 'workingTorque'
  | 'workingStress'
  /** Compression: closed to solid. */
  | 'solidLength'
  | 'solidStress'
  | 'freeLength'
  /** Spiral: the strip's length. */
  | 'stripLength'
  /** Mainspring in its barrel. */
  | 'usableTurns'
  | 'fullTorque'
  | 'fullStress'
  | 'runHours';
export const cadSpringQuantities: readonly CadSpringQuantity[] = Object.freeze([
  'rate',
  'workingForce',
  'workingTorque',
  'workingStress',
  'solidLength',
  'solidStress',
  'freeLength',
  'stripLength',
  'usableTurns',
  'fullTorque',
  'fullStress',
  'runHours',
]);
/** The quantity's value in an estimate, undefined when this spring has none. */
export function springQuantity(e: CadSpringEstimate, q: CadSpringQuantity): number | undefined {
  switch (q) {
    case 'rate':
      return e.rate;
    case 'workingForce':
      return e.working?.forceN;
    case 'workingTorque':
      return e.working?.torqueNmm;
    case 'workingStress':
      return e.working?.stressMpa;
    case 'solidLength':
      return e.solidLengthMm;
    case 'solidStress':
      return e.solid?.stressMpa;
    case 'freeLength':
      return e.freeLengthMm;
    case 'stripLength':
      return e.stripLengthMm;
    case 'usableTurns':
      return e.barrel?.usableTurns;
    case 'fullTorque':
      return e.barrel?.fullTorqueNmm;
    case 'fullStress':
      return e.barrel?.fullStressMpa;
    case 'runHours':
      return e.barrel?.runHours;
  }
}
function springQuantityUnit(
  doc: CadDocument,
  m: Extract<CadDesignMeasure, { kind: 'spring' }>,
): CadDesignUnit {
  switch (m.quantity) {
    case 'rate': {
      const f = doc.features.find((x) => x.id === m.featureId);
      return f?.type === 'spring' && f.args.form === 'coil' && f.args.use !== 'torsion'
        ? 'N/mm'
        : 'N·mm/rad';
    }
    case 'workingForce':
      return 'N';
    case 'workingTorque':
    case 'fullTorque':
      return 'N·mm';
    case 'workingStress':
    case 'solidStress':
    case 'fullStress':
      return 'MPa';
    case 'solidLength':
    case 'freeLength':
    case 'stripLength':
      return 'mm';
    case 'usableTurns':
      return 'turns';
    case 'runHours':
      return 'h';
  }
}
