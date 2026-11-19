import { runFactory, type FactoryRunResult } from './engine';
import {
  FactoryValidationError,
  type FactoryDistribution,
  type FactoryDocument,
  type FactoryExperiment,
  type FactoryFactor,
} from './model';
import { validateFactory } from './validation';

/**
 * FT5 (docs/cad/factory-twin.md): experiments. One model, run again and again: with other seeds
 * (replications) and with other values of a few parameters (a full table of combinations). The
 * results are compared by their means with a 95% confidence interval. Pure: the Playground runs
 * it in a Worker and stops it by ending the Worker.
 */

/** The numbers kept from each run (the comparison table's columns). */
export type FactoryExperimentMetric =
  | 'throughputPerHour'
  | 'produced'
  | 'leadTimeMeanMs'
  | 'leadTimeP95Ms'
  | 'wipMean'
  | 'deadlock';
export const factoryExperimentMetrics: readonly FactoryExperimentMetric[] = Object.freeze([
  'throughputPerHour',
  'produced',
  'leadTimeMeanMs',
  'leadTimeP95Ms',
  'wipMean',
  'deadlock',
]);

/** One run of an experiment. */
export interface FactoryExperimentRun {
  /** Index into `factoryExperimentCombinations`. */
  combination: number;
  /** 0-based; the seed is `run.seed + replication` (mod 2³²). */
  replication: number;
  seed: number;
  /** Absent when the run failed (`error`). `deadlock` is 1 when vehicles locked each other. */
  values?: Record<FactoryExperimentMetric, number>;
  /** The object most often the bottleneck, if any. */
  bottleneck?: string;
  /** The code of a run that could not finish (such as `event-limit`). */
  error?: string;
}

/** Mean and 95% confidence interval of one metric over a combination's runs. */
export interface FactoryExperimentStat {
  n: number;
  mean: number;
  /** Sample standard deviation (0 with one run). */
  sd: number;
  /** Half the width of the 95% interval (Student t); absent with fewer than two runs. */
  halfWidth?: number;
}

export interface FactoryExperimentSummary {
  combination: number;
  /** The value of each factor, in factor order. */
  values: number[];
  /** Runs finished (with or without an error). */
  runs: number;
  failed: number;
  stats: Record<FactoryExperimentMetric, FactoryExperimentStat>;
  /** The object most often the top bottleneck over the runs (ties: the first seen). */
  bottleneck?: string;
}

/** The experiment of the document, or a plain repetition of it (5 runs) without one. */
export const factoryExperimentOf = (doc: FactoryDocument): FactoryExperiment =>
  doc.experiment ?? { replications: 5, factors: [] };

/** Every combination of the factors' values, the last factor changing fastest. */
export function factoryExperimentCombinations(experiment: FactoryExperiment): number[][] {
  let out: number[][] = [[]];
  for (const f of experiment.factors) out = out.flatMap((c) => f.values.map((v) => [...c, v]));
  return out;
}

/** The number of runs: combinations × replications. */
export const factoryExperimentSize = (experiment: FactoryExperiment) =>
  factoryExperimentCombinations(experiment).length * experiment.replications;

const scaled = (d: FactoryDistribution, percent: number): FactoryDistribution => {
  const s = (v: number) => Math.round((v * percent) / 100);
  switch (d.type) {
    case 'const':
      return { type: 'const', value: s(d.value) };
    case 'uniform':
      return { type: 'uniform', min: s(d.min), max: s(d.max) };
    case 'triangular':
      return { type: 'triangular', min: s(d.min), mode: s(d.mode), max: s(d.max) };
    case 'normal':
      return {
        type: 'normal',
        mean: s(d.mean),
        sd: s(d.sd),
        ...(d.min !== undefined ? { min: s(d.min) } : {}),
        ...(d.max !== undefined ? { max: s(d.max) } : {}),
      };
    case 'lognormal':
      return { type: 'lognormal', mean: s(d.mean), sd: s(d.sd) };
    case 'exponential':
      return { type: 'exponential', mean: s(d.mean) };
    case 'empirical':
      return {
        type: 'empirical',
        values: d.values.map((v) => ({ value: s(v.value), weight: v.weight })),
      };
  }
};

/** The model with the factors set to `values` (in factor order). The input is not changed. */
export function applyFactoryFactors(
  doc: FactoryDocument,
  factors: readonly FactoryFactor[],
  values: readonly number[],
): FactoryDocument {
  const next = structuredClone(doc);
  delete next.experiment;
  factors.forEach((f, i) => {
    const v = values[i]!;
    if (f.kind === 'fleet-count') {
      const fleet = next.fleets?.find((x) => x.id === f.targetId);
      if (fleet) fleet.count = v;
      return;
    }
    if (f.kind === 'pool-count') {
      const pool = next.workerPools?.find((x) => x.id === f.targetId);
      if (pool) pool.count = v;
      return;
    }
    const o = next.objects.find((x) => x.id === f.targetId);
    if (!o) return;
    if (f.kind === 'buffer-capacity' && o.kind === 'buffer') o.capacity = v;
    else if (f.kind === 'parallel-count' && o.kind === 'parallel') o.count = v;
    else if (
      f.kind === 'time-scale' &&
      (o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly')
    ) {
      o.processTime = scaled(o.processTime, v);
      if (o.kind !== 'assembly' && o.productTimes)
        o.productTimes = o.productTimes.map((t) => ({ ...t, time: scaled(t.time, v) }));
    }
  });
  return next;
}

/** The numbers kept from one result. */
export function factoryExperimentValues(
  result: FactoryRunResult,
): Record<FactoryExperimentMetric, number> {
  return {
    throughputPerHour: result.throughputPerHour,
    produced: result.produced,
    leadTimeMeanMs: result.leadTime.meanMs,
    leadTimeP95Ms: result.leadTime.p95Ms,
    wipMean: result.wip.mean,
    deadlock: result.deadlock ? 1 : 0,
  };
}

/**
 * Runs the experiment one run at a time. Replications go round the combinations (all
 * combinations with the first seed, then all with the second, …), so a stopped experiment has
 * about as many runs of every combination. A run that fails (`event-limit`, a variant the model
 * refuses) is kept with its error code and left out of the statistics. An invalid document or
 * experiment throws before the first run.
 */
export function* runFactoryExperiment(
  doc: FactoryDocument,
  options: { maxEvents?: number } = {},
): Generator<FactoryExperimentRun, void, undefined> {
  const experiment = factoryExperimentOf(doc);
  const problems = validateFactory(doc);
  if (problems.length)
    throw new FactoryValidationError(problems[0]!.code, problems[0]!.message, problems);
  const combinations = factoryExperimentCombinations(experiment);
  const variants = combinations.map((values) =>
    applyFactoryFactors(doc, experiment.factors, values),
  );
  for (let replication = 0; replication < experiment.replications; replication++) {
    const seed = (doc.run.seed + replication) >>> 0;
    for (let combination = 0; combination < combinations.length; combination++) {
      try {
        const result = runFactory(variants[combination]!, {
          seed,
          ...(options.maxEvents ? { maxEvents: options.maxEvents } : {}),
        });
        yield {
          combination,
          replication,
          seed,
          values: factoryExperimentValues(result),
          ...(result.bottlenecks[0] && result.bottlenecks[0].share > 0
            ? { bottleneck: result.bottlenecks[0].id }
            : {}),
        };
      } catch (error) {
        yield {
          combination,
          replication,
          seed,
          error:
            error instanceof FactoryValidationError
              ? error.code
              : error instanceof Error
                ? error.message
                : 'failed',
        };
      }
    }
  }
}

/** Two-sided 95% quantiles of Student's t for 1–30 degrees of freedom. */
const t975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
/** The 97.5% quantile of Student's t (a table to 30, then the Cornish–Fisher series). */
export function studentT975(df: number): number {
  if (!(df >= 1)) return NaN;
  const n = Math.floor(df);
  if (n <= 30) return t975[n - 1]!;
  const z = 1.959963985;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * n) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * n ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * n ** 3)
  );
}

/** Mean, standard deviation and 95% half-width of a sample. */
export function factoryStat(values: readonly number[]): FactoryExperimentStat {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { n, mean, sd: 0 };
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, halfWidth: (studentT975(n - 1) * sd) / Math.sqrt(n) };
}

/** One row per combination, in combination order (combinations without runs included). */
export function summarizeFactoryExperiment(
  experiment: FactoryExperiment,
  runs: readonly FactoryExperimentRun[],
): FactoryExperimentSummary[] {
  return factoryExperimentCombinations(experiment).map((values, combination) => {
    const mine = runs.filter((r) => r.combination === combination);
    const ok = mine.filter((r) => r.values);
    const stats = Object.fromEntries(
      factoryExperimentMetrics.map((m) => [m, factoryStat(ok.map((r) => r.values![m]))]),
    ) as Record<FactoryExperimentMetric, FactoryExperimentStat>;
    const counts = new Map<string, number>();
    for (const r of ok)
      if (r.bottleneck) counts.set(r.bottleneck, (counts.get(r.bottleneck) ?? 0) + 1);
    let bottleneck: string | undefined;
    for (const [id, c] of counts) if (!bottleneck || c > counts.get(bottleneck)!) bottleneck = id;
    return {
      combination,
      values,
      runs: mine.length,
      failed: mine.length - ok.length,
      stats,
      ...(bottleneck ? { bottleneck } : {}),
    };
  });
}

/** A factor's column name: `kind:targetId`. */
export const factoryFactorColumn = (f: FactoryFactor) => `${f.kind}:${f.targetId}`;

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Up to six significant decimals, no exponent for ordinary sizes. */
const num = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 1e6) / 1e6);
const csv = (rows: string[][]) => rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

/**
 * The comparison table as CSV: one row per combination with the factor values, the runs (and
 * failed runs), then for each metric its mean, the 95% interval's low and high ends (empty with
 * fewer than two runs) and the sample standard deviation, and the most frequent bottleneck.
 * Times in milliseconds.
 */
export function writeFactoryExperimentCsv(
  experiment: FactoryExperiment,
  runs: readonly FactoryExperimentRun[],
): string {
  const header = [
    ...experiment.factors.map(factoryFactorColumn),
    'runs',
    'failed',
    ...factoryExperimentMetrics.flatMap((m) => [
      `${m}_mean`,
      `${m}_ci95_low`,
      `${m}_ci95_high`,
      `${m}_sd`,
    ]),
    'bottleneck',
  ];
  const rows = summarizeFactoryExperiment(experiment, runs).map((s) => [
    ...s.values.map(String),
    String(s.runs),
    String(s.failed),
    ...factoryExperimentMetrics.flatMap((m) => {
      const st = s.stats[m];
      if (!st.n) return ['', '', '', ''];
      const h = st.halfWidth;
      return [
        num(st.mean),
        h === undefined ? '' : num(st.mean - h),
        h === undefined ? '' : num(st.mean + h),
        num(st.sd),
      ];
    }),
    s.bottleneck ?? '',
  ]);
  return csv([header, ...rows]);
}

/** Every run as CSV: factor values, replication, seed, the metrics, bottleneck and error. */
export function writeFactoryExperimentRunsCsv(
  experiment: FactoryExperiment,
  runs: readonly FactoryExperimentRun[],
): string {
  const combinations = factoryExperimentCombinations(experiment);
  const header = [
    ...experiment.factors.map(factoryFactorColumn),
    'replication',
    'seed',
    ...factoryExperimentMetrics,
    'bottleneck',
    'error',
  ];
  const rows = [...runs]
    .sort((a, b) => a.combination - b.combination || a.replication - b.replication)
    .map((r) => [
      ...(combinations[r.combination] ?? []).map(String),
      String(r.replication),
      String(r.seed),
      ...factoryExperimentMetrics.map((m) => num(r.values?.[m])),
      r.bottleneck ?? '',
      r.error ?? '',
    ]);
  return csv([header, ...rows]);
}
