/**
 * PD3 (docs/cad/product-design.md, PD3 公差の積み上げ): a document's tolerance stacks. A stack
 * adds signed contributors, each a named length parameter (with the tolerance written on the
 * stack) or a PMI dimension an import kept (with the tolerance it carries), and gives the
 * resulting dimension three ways: the worst case, the root sum of squares and a Monte Carlo run
 * with a fixed seed (at most 100,000 runs). The stacks are stored in the document; the numbers
 * are worked out from the current parameters and PMI and never stored. A stack whose contributor
 * no longer resolves (its parameter or PMI item is gone or stale) is reported stale, with no
 * numbers, the way PMI-4a reports a stale item.
 */
import { parameterValues } from './graph';
import type { CadDocument } from './model';
import type { CadPmiAsset, CadPmiItemState } from './pmi';

export type CadStackDistribution = 'normal' | 'uniform';
export type CadStackSource =
  /** A length parameter's value with the tolerance written here (mm, lower ≤ upper). */
  | { kind: 'parameter'; parameterId: string; lower: number; upper: number }
  /** A PMI dimension of a body's import (PMI-2): its value and its tolerance. */
  | { kind: 'pmi'; bodyId: string; itemId: string };
export interface CadStackContributor {
  id: string;
  name: string;
  source: CadStackSource;
  /** +1 adds the dimension, -1 subtracts it. */
  sign: 1 | -1;
  /**
   * How the dimension varies inside its tolerance in the Monte Carlo run and the RSS: `normal`
   * with ±3σ on the tolerance's ends (its mean at the middle), `uniform` evenly between them.
   */
  distribution: CadStackDistribution;
}
export interface CadToleranceStack {
  id: string;
  name: string;
  /** The requirement it comes from, as written in the project (PD-U2); plain text. */
  requirement?: string;
  contributors: CadStackContributor[];
  /** The band the resulting dimension must fall in (mm); either end or none. */
  min?: number;
  max?: number;
  /** Monte Carlo runs, 1–100,000 (default 10,000). */
  runs?: number;
  /** The Monte Carlo seed, an unsigned 32-bit integer (default 1). */
  seed?: number;
  /**
   * The Monte Carlo pass: at most this fraction of runs outside the band (default 0.0027, what
   * ±3σ of a normal result leaves outside).
   */
  maxOutside?: number;
}
export const cadToleranceStackLimits = Object.freeze({
  stacks: 64,
  contributors: 64,
  runs: 100_000,
  defaultRuns: 10_000,
  defaultSeed: 1,
  defaultMaxOutside: 0.0027,
  /** Runs × contributors over all the stacks of a document. */
  work: 10_000_000,
  /** A tolerance end within ±this (mm). */
  deviation: 1000,
  /** A band end within ±this (mm). */
  band: 1e6,
  requirementLength: 128,
});
/** Band ends are compared with this slack (mm), so that a sum's rounding never flips a result. */
export const cadStackBandSlackMm = 1e-9;

export type CadToleranceStacksOperation = {
  type: 'setToleranceStacks';
  /** The whole list; empty removes it. */
  stacks: CadToleranceStack[];
};
/**
 * Sets the stacks. A design target (PD1) measuring a stack that is no longer there goes with it,
 * as a target goes with its body.
 */
export function applyToleranceStacksOperation(next: CadDocument, op: CadToleranceStacksOperation) {
  if (JSON.stringify(next.toleranceStacks ?? []) === JSON.stringify(op.stacks))
    throw new Error('tolerance-stacks-unchanged');
  if (op.stacks.length) next.toleranceStacks = structuredClone(op.stacks);
  else delete next.toleranceStacks;
  if (next.designTargets) {
    const ids = new Set(op.stacks.map((s) => s.id));
    const kept = next.designTargets.filter(
      (t) => t.measure.kind !== 'tolerance-stack' || ids.has(t.measure.stackId),
    );
    if (kept.length) next.designTargets = kept;
    else delete next.designTargets;
  }
  return next;
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export interface ToleranceStacksCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): boolean;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `toleranceStacks`: 1–64 stacks with distinct IDs, each with 1–64 contributors of
 * distinct IDs, a band with min ≤ max, runs, seed and outside fraction in range, and the work of
 * all the Monte Carlo runs together within its limit. A contributor's parameter, body or PMI item
 * is only checked to be an ID: when it is gone the stack is stale (shown, not refused), so that
 * deleting a parameter never makes the document invalid. A parameter that is there must be a
 * length.
 */
export function validateToleranceStacks(
  c: ToleranceStacksCheck,
  list: unknown,
  parameters: ReadonlyMap<string, string>,
  /** Whether a value is an ID (the document's rule), for references that are not checked to exist. */
  isId: (v: unknown) => boolean,
) {
  const path = '$.toleranceStacks';
  const L = cadToleranceStackLimits;
  if (!Array.isArray(list) || !list.length || list.length > L.stacks)
    return void c.error('tolerance-stacks', path);
  const ids = new Set<string>();
  let work = 0;
  list.forEach((s, i) => {
    const at = `${path}[${i}]`;
    if (!record(s)) return c.error('tolerance-stack', at);
    c.keys(s, ['id', 'name', 'contributors'], at, [
      'requirement',
      'min',
      'max',
      'runs',
      'seed',
      'maxOutside',
    ]);
    if (c.id(s.id, `${at}.id`)) {
      if (ids.has(s.id as string)) c.error('duplicate-id', `${at}.id`);
      ids.add(s.id as string);
    }
    c.name(s.name, `${at}.name`);
    if (
      Object.hasOwn(s, 'requirement') &&
      (typeof s.requirement !== 'string' ||
        !s.requirement.trim() ||
        s.requirement.length > L.requirementLength)
    )
      c.error('tolerance-stack-requirement', `${at}.requirement`);
    for (const k of ['min', 'max'] as const)
      if (Object.hasOwn(s, k) && !(finite(s[k]) && Math.abs(s[k] as number) <= L.band))
        c.error('tolerance-stack-band', `${at}.${k}`);
    if (finite(s.min) && finite(s.max) && s.min > s.max)
      c.error('tolerance-stack-band', `${at}.max`);
    if (
      Object.hasOwn(s, 'runs') &&
      !(Number.isInteger(s.runs) && (s.runs as number) >= 1 && (s.runs as number) <= L.runs)
    )
      c.error('tolerance-stack-runs', `${at}.runs`);
    if (
      Object.hasOwn(s, 'seed') &&
      !(Number.isInteger(s.seed) && (s.seed as number) >= 0 && (s.seed as number) <= 0xffffffff)
    )
      c.error('tolerance-stack-seed', `${at}.seed`);
    if (
      Object.hasOwn(s, 'maxOutside') &&
      !(finite(s.maxOutside) && s.maxOutside >= 0 && s.maxOutside <= 1)
    )
      c.error('tolerance-stack-outside', `${at}.maxOutside`);
    const cs = s.contributors;
    if (!Array.isArray(cs) || !cs.length || cs.length > L.contributors)
      return c.error('tolerance-stack-contributors', `${at}.contributors`);
    const runs = Number.isInteger(s.runs) ? (s.runs as number) : L.defaultRuns;
    work += Math.min(runs, L.runs) * cs.length;
    const own = new Set<string>();
    cs.forEach((x, j) => checkContributor(c, x, `${at}.contributors[${j}]`, own, parameters, isId));
  });
  if (work > L.work) c.error('tolerance-stacks-work', path);
}
function checkContributor(
  c: ToleranceStacksCheck,
  x: unknown,
  at: string,
  ids: Set<string>,
  parameters: ReadonlyMap<string, string>,
  isId: (v: unknown) => boolean,
) {
  const L = cadToleranceStackLimits;
  if (!record(x)) return void c.error('tolerance-stack-contributor', at);
  c.keys(x, ['id', 'name', 'source', 'sign', 'distribution'], at);
  if (c.id(x.id, `${at}.id`)) {
    if (ids.has(x.id as string)) c.error('duplicate-id', `${at}.id`);
    ids.add(x.id as string);
  }
  c.name(x.name, `${at}.name`);
  if (x.sign !== 1 && x.sign !== -1) c.error('tolerance-stack-sign', `${at}.sign`);
  if (x.distribution !== 'normal' && x.distribution !== 'uniform')
    c.error('tolerance-stack-distribution', `${at}.distribution`);
  const s = x.source;
  const sp = `${at}.source`;
  if (!record(s) || (s.kind !== 'parameter' && s.kind !== 'pmi'))
    return void c.error('tolerance-stack-source', sp);
  if (s.kind === 'parameter') {
    c.keys(s, ['kind', 'parameterId', 'lower', 'upper'], sp);
    if (!isId(s.parameterId)) c.error('id', `${sp}.parameterId`);
    else {
      const type = parameters.get(s.parameterId as string);
      if (type !== undefined && type !== 'length')
        c.error('tolerance-stack-parameter-unit', `${sp}.parameterId`);
    }
    for (const k of ['lower', 'upper'] as const)
      if (!(finite(s[k]) && Math.abs(s[k] as number) <= L.deviation))
        c.error('tolerance-stack-deviation', `${sp}.${k}`);
    if (finite(s.lower) && finite(s.upper) && s.lower > s.upper)
      c.error('tolerance-stack-deviation', `${sp}.upper`);
  } else {
    c.keys(s, ['kind', 'bodyId', 'itemId'], sp);
    if (!isId(s.bodyId)) c.error('id', `${sp}.bodyId`);
    if (typeof s.itemId !== 'string' || !/^pmi-[1-9][0-9]*$/.test(s.itemId))
      c.error('tolerance-stack-pmi-item', `${sp}.itemId`);
  }
}

/** Why a contributor does not resolve now: its stack is stale. */
export type CadStackStale =
  /** The parameter is not in the document. */
  | 'stack-parameter-missing'
  /** The body carries no readable PMI, or its PMI has no such item. */
  | 'stack-pmi-missing'
  /** The PMI item is stale (PMI-4a: a target of it changed). */
  | 'stack-pmi-stale'
  /** The PMI item is not a length dimension (an angle, a tolerance, a datum). */
  | 'stack-pmi-kind'
  /** The PMI dimension has no tolerance, or one a stack cannot use (a min/max qualifier). */
  | 'stack-pmi-tolerance';
/** What a body's PMI is now: its asset and, past a change of its shape, its items' states. */
export interface CadStackPmi {
  asset?: CadPmiAsset;
  items?: ReadonlyMap<string, CadPmiItemState>;
}
export interface CadStackInput {
  /** A body's PMI (the editor's `bodyPmi`). Without it, PMI contributors are stale. */
  pmi?: (bodyId: string) => CadStackPmi | undefined;
}
export interface CadStackContributorResult {
  id: string;
  /** The resolved nominal and tolerance ends (mm); absent when stale. */
  nominal?: number;
  lower?: number;
  upper?: number;
  /** The contributor's share of the result's variance (0–1); absent when stale. */
  share?: number;
  reason?: CadStackStale;
}
export type CadStackBand = 'pass' | 'fail';
export interface CadStackRange {
  min: number;
  max: number;
  /** Absent when the stack has no band. */
  status?: CadStackBand;
}
export interface CadStackMonteCarlo {
  runs: number;
  seed: number;
  mean: number;
  /** The sample standard deviation (0 with one run). */
  sigma: number;
  min: number;
  max: number;
  /** Runs outside the band (0 without one) and their fraction. */
  outside: number;
  outsideFraction: number;
  status?: CadStackBand;
}
export interface CadStackResult {
  id: string;
  status: 'ok' | 'stale';
  contributors: CadStackContributorResult[];
  /** Absent when stale. */
  nominal?: number;
  worst?: CadStackRange;
  /** Mean ± 3·√(Σσᵢ²), each σ from the contributor's distribution. */
  rss?: CadStackRange;
  monteCarlo?: CadStackMonteCarlo;
}

/** mulberry32: a small seeded generator, the same numbers for the same seed. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Resolved {
  nominal: number;
  lower: number;
  upper: number;
}
function resolve(
  doc: CadDocument,
  values: ReturnType<typeof parameterValues>,
  x: CadStackContributor,
  input: CadStackInput,
): Resolved | { reason: CadStackStale } {
  const s = x.source;
  if (s.kind === 'parameter') {
    const p = doc.parameters.find((q) => q.id === s.parameterId);
    const v = values.get(s.parameterId);
    if (!p || p.type !== 'length' || !v) return { reason: 'stack-parameter-missing' };
    return { nominal: v.value, lower: s.lower, upper: s.upper };
  }
  if (!doc.bodies.some((b) => b.id === s.bodyId)) return { reason: 'stack-pmi-missing' };
  const pmi = input.pmi?.(s.bodyId);
  const item = pmi?.asset?.items.find((i) => i.id === s.itemId);
  if (!item) return { reason: 'stack-pmi-missing' };
  const state = pmi!.items?.get(item.id);
  if (state && !state.current) return { reason: 'stack-pmi-stale' };
  if (item.kind !== 'dimension' || /Angular/.test(item.type)) return { reason: 'stack-pmi-kind' };
  if (item.qualifier) return { reason: 'stack-pmi-tolerance' };
  const v = item.values;
  if (v.length === 1 && item.deviation) {
    const d = item.deviation;
    return { nominal: v[0]!, lower: Math.min(d.lower, d.upper), upper: Math.max(d.lower, d.upper) };
  }
  // A range (e.g. 12.0–12.1): its middle with half the range either way.
  if (v.length === 2 && !item.deviation) {
    const lo = Math.min(v[0]!, v[1]!);
    const hi = Math.max(v[0]!, v[1]!);
    const mid = (lo + hi) / 2;
    return { nominal: mid, lower: lo - mid, upper: hi - mid };
  }
  return { reason: 'stack-pmi-tolerance' };
}

const band = (s: CadToleranceStack, lo: number, hi: number): CadStackBand | undefined =>
  s.min === undefined && s.max === undefined
    ? undefined
    : (s.min === undefined || lo >= s.min - cadStackBandSlackMm) &&
        (s.max === undefined || hi <= s.max + cadStackBandSlackMm)
      ? 'pass'
      : 'fail';

/** One stack's three results (or why it is stale). */
export function toleranceStackResult(
  doc: CadDocument,
  stack: CadToleranceStack,
  input: CadStackInput = {},
  values: ReturnType<typeof parameterValues> = parameterValues(doc),
): CadStackResult {
  const resolved = stack.contributors.map((x) => resolve(doc, values, x, input));
  if (resolved.some((r) => 'reason' in r))
    return {
      id: stack.id,
      status: 'stale',
      contributors: stack.contributors.map((x, i) => {
        const r = resolved[i]!;
        return 'reason' in r
          ? { id: x.id, reason: r.reason }
          : { id: x.id, nominal: r.nominal, lower: r.lower, upper: r.upper };
      }),
    };
  const rs = resolved as Resolved[];
  const cs = stack.contributors;
  let nominal = 0;
  let wMin = 0;
  let wMax = 0;
  let mean = 0;
  const variances = rs.map((r, i) => {
    const sign = cs[i]!.sign;
    const width = r.upper - r.lower;
    nominal += sign * r.nominal;
    wMin += sign * r.nominal + (sign > 0 ? r.lower : -r.upper);
    wMax += sign * r.nominal + (sign > 0 ? r.upper : -r.lower);
    mean += sign * (r.nominal + (r.lower + r.upper) / 2);
    return cs[i]!.distribution === 'normal' ? (width / 6) ** 2 : width ** 2 / 12;
  });
  const variance = variances.reduce((a, b) => a + b, 0);
  const half = 3 * Math.sqrt(variance);

  const L = cadToleranceStackLimits;
  const runs = stack.runs ?? L.defaultRuns;
  const seed = stack.seed ?? L.defaultSeed;
  const random = generator(seed);
  // Box–Muller, one normal from each pair of draws: (0, 1] keeps the logarithm finite.
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  // Deviations from the analytic mean, so that a large dimension with a small tolerance keeps
  // its σ (no cancellation between two nearly equal sums of squares).
  let sum = 0;
  let sumSq = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let outside = 0;
  const hasBand = stack.min !== undefined || stack.max !== undefined;
  for (let run = 0; run < runs; run++) {
    let y = 0;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]!;
      const x =
        cs[i]!.distribution === 'normal'
          ? r.nominal + (r.lower + r.upper) / 2 + ((r.upper - r.lower) / 6) * normal()
          : r.nominal + r.lower + (r.upper - r.lower) * random();
      y += cs[i]!.sign * x;
    }
    const d = y - mean;
    sum += d;
    sumSq += d * d;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    if (
      hasBand &&
      ((stack.min !== undefined && y < stack.min - cadStackBandSlackMm) ||
        (stack.max !== undefined && y > stack.max + cadStackBandSlackMm))
    )
      outside++;
  }
  const offset = sum / runs;
  const mcMean = mean + offset;
  const sigma =
    runs > 1 ? Math.sqrt(Math.max(0, (sumSq - runs * offset * offset) / (runs - 1))) : 0;
  const outsideFraction = outside / runs;
  const worstBand = band(stack, wMin, wMax);
  const rssBand = band(stack, mean - half, mean + half);
  return {
    id: stack.id,
    status: 'ok',
    contributors: cs.map((x, i) => ({
      id: x.id,
      nominal: rs[i]!.nominal,
      lower: rs[i]!.lower,
      upper: rs[i]!.upper,
      share: variance > 0 ? variances[i]! / variance : 0,
    })),
    nominal,
    worst: { min: wMin, max: wMax, ...(worstBand ? { status: worstBand } : {}) },
    rss: { min: mean - half, max: mean + half, ...(rssBand ? { status: rssBand } : {}) },
    monteCarlo: {
      runs,
      seed,
      mean: mcMean,
      sigma,
      min: lo,
      max: hi,
      outside,
      outsideFraction,
      ...(hasBand
        ? {
            status: outsideFraction <= (stack.maxOutside ?? L.defaultMaxOutside) ? 'pass' : 'fail',
          }
        : {}),
    },
  };
}

/** PD3: every stack of the document, in order. */
export function cadToleranceStacks(doc: CadDocument, input: CadStackInput = {}): CadStackResult[] {
  const stacks = doc.toleranceStacks ?? [];
  if (!stacks.length) return [];
  const values = parameterValues(doc);
  return stacks.map((s) => toleranceStackResult(doc, s, input, values));
}

/** The stacks and their results as one JSON-ready record (for a project's verification). */
export function toleranceStackReport(
  doc: CadDocument,
  results: readonly CadStackResult[],
  documentName?: string,
) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const stacks = (doc.toleranceStacks ?? []).map((s) => {
    const r = byId.get(s.id);
    const L = cadToleranceStackLimits;
    return {
      id: s.id,
      name: s.name,
      ...(s.requirement ? { requirement: s.requirement } : {}),
      ...(s.min !== undefined ? { min: s.min } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}),
      unit: 'mm' as const,
      status: r?.status ?? 'stale',
      contributors: s.contributors.map((x) => ({
        ...x,
        ...(r?.contributors.find((c) => c.id === x.id) ?? {}),
      })),
      ...(r?.status === 'ok'
        ? {
            nominal: r.nominal,
            worst: r.worst,
            rss: r.rss,
            monteCarlo: { ...r.monteCarlo, maxOutside: s.maxOutside ?? L.defaultMaxOutside },
          }
        : {}),
    };
  });
  return {
    format: 'editor-platform/cad-tolerance-stacks@1',
    ...(documentName ? { document: documentName } : {}),
    stacks,
  };
}
