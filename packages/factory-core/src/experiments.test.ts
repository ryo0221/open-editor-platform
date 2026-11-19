import { describe, expect, it } from 'vitest';
import {
  applyFactoryFactors,
  applyFactoryOperation,
  f170SmallLine,
  f172SmallLineExperiment,
  factoryExperimentCombinations,
  factoryExperimentSize,
  factoryStat,
  newFactory,
  runFactory,
  runFactoryExperiment,
  studentT975,
  summarizeFactoryExperiment,
  validateFactory,
  writeFactoryExperimentCsv,
  writeFactoryExperimentRunsCsv,
  type FactoryDocument,
  type FactoryExperiment,
} from './index';

const H = 3_600_000;
const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });

/** Source every 1 s → station a → buffer → AGVs over 20 m → station b → drain (as TS-2658). */
function agvLine(): FactoryDocument {
  const doc = newFactory('agv');
  doc.paths = {
    nodes: [
      { id: 'p-a', x: 0, y: 0 },
      { id: 'p-b', x: 20_000, y: 0 },
      { id: 'p-c', x: 20_000, y: 20_000 },
    ],
    segments: [
      { id: 's-ab', from: 'p-a', to: 'p-b' },
      { id: 's-bc', from: 'p-b', to: 'p-c' },
      { id: 's-ca', from: 'p-c', to: 'p-a' },
    ],
  };
  doc.fleets = [
    {
      id: 'agv',
      name: 'AGVs',
      count: 1,
      speedMmS: 1000,
      loadMs: 5000,
      unloadMs: 5000,
      homeNodeId: 'p-a',
    },
  ];
  doc.workerPools = [{ id: 'crew', name: 'Crew', count: 1, skills: [], walkSpeedMmS: 1000 }];
  doc.objects = [
    {
      id: 'in',
      name: 'in',
      kind: 'source',
      interval: c(1),
      mix: [{ productId: 'part', weight: 1 }],
    },
    { id: 'a', name: 'a', kind: 'station', processTime: c(10), pathNodeId: 'p-a' },
    { id: 'buf', name: 'buf', kind: 'buffer', capacity: 20, pathNodeId: 'p-a' },
    { id: 'b', name: 'b', kind: 'station', processTime: c(10), pathNodeId: 'p-b' },
    { id: 'out', name: 'out', kind: 'drain' },
  ];
  doc.links = [
    { id: 'l1', from: 'in', to: 'a' },
    { id: 'l1b', from: 'a', to: 'buf' },
    { id: 'l2', from: 'buf', to: 'b', transport: { fleetId: 'agv' } },
    { id: 'l3', from: 'b', to: 'out' },
  ];
  doc.run = { durationMs: H, seed: 2 };
  return doc;
}

// TS-2675: FT5 experiments (repetitions, factor tables, confidence intervals).
describe('FT5 experiments (TS-2675)', () => {
  it('builds the full table, last factor fastest, and sets every kind of factor on a copy', () => {
    const e: FactoryExperiment = {
      replications: 3,
      factors: [
        { kind: 'fleet-count', targetId: 'agv', values: [1, 2] },
        { kind: 'buffer-capacity', targetId: 'buf', values: [5, 10, 20] },
      ],
    };
    expect(factoryExperimentCombinations(e)).toEqual([
      [1, 5],
      [1, 10],
      [1, 20],
      [2, 5],
      [2, 10],
      [2, 20],
    ]);
    expect(factoryExperimentSize(e)).toBe(18);
    expect(factoryExperimentCombinations({ replications: 4, factors: [] })).toEqual([[]]);

    const doc = agvLine();
    doc.objects[1] = {
      id: 'a',
      name: 'a',
      kind: 'station',
      pathNodeId: 'p-a',
      processTime: { type: 'normal', mean: 10_000, sd: 1000, min: 8000, max: 12_000 },
      productTimes: [
        { productId: 'part', time: { type: 'triangular', min: 1000, mode: 2000, max: 3000 } },
      ],
    };
    const before = structuredClone(doc);
    const v = applyFactoryFactors(
      doc,
      [
        { kind: 'fleet-count', targetId: 'agv', values: [] },
        { kind: 'pool-count', targetId: 'crew', values: [] },
        { kind: 'buffer-capacity', targetId: 'buf', values: [] },
        { kind: 'time-scale', targetId: 'a', values: [] },
      ],
      [3, 4, 7, 150],
    );
    expect(doc).toEqual(before);
    expect(v.fleets![0]!.count).toBe(3);
    expect(v.workerPools![0]!.count).toBe(4);
    expect(v.objects.find((o) => o.id === 'buf')).toMatchObject({ capacity: 7 });
    expect(v.objects[1]).toMatchObject({
      processTime: { type: 'normal', mean: 15_000, sd: 1500, min: 12_000, max: 18_000 },
      productTimes: [{ time: { type: 'triangular', min: 1500, mode: 3000, max: 4500 } }],
    });
    const cell = applyFactoryFactors(
      f170SmallLine(),
      [{ kind: 'parallel-count', targetId: 'machining', values: [] }],
      [4],
    );
    expect(cell.objects.find((o) => o.id === 'machining')).toMatchObject({ count: 4 });
  });

  it('runs replications round the combinations with the same seeds, as single runs would', () => {
    const doc = agvLine();
    doc.run.seed = 0xffffffff;
    doc.experiment = {
      replications: 2,
      factors: [{ kind: 'fleet-count', targetId: 'agv', values: [1, 2] }],
    };
    const runs = [...runFactoryExperiment(doc)];
    expect(runs.map((r) => [r.combination, r.replication, r.seed])).toEqual([
      [0, 0, 0xffffffff],
      [1, 0, 0xffffffff],
      [0, 1, 0],
      [1, 1, 0],
    ]);
    const two = applyFactoryFactors(doc, doc.experiment.factors, [2]);
    expect(runs[1]!.values!.produced).toBe(runFactory(two, { seed: 0xffffffff }).produced);
    // More vehicles carry more parts (TS-2658's AGV line).
    expect(runs[1]!.values!.throughputPerHour).toBeGreaterThan(
      runs[0]!.values!.throughputPerHour * 1.5,
    );
    // Without an experiment the model is repeated five times.
    delete doc.experiment;
    expect([...runFactoryExperiment(doc)].map((r) => r.replication)).toEqual([0, 1, 2, 3, 4]);
  });

  it('F172: a third machine moves the bottleneck and lifts throughput beyond the 95% intervals', () => {
    const doc = f172SmallLineExperiment();
    expect(validateFactory(doc)).toEqual([]);
    const runs = [...runFactoryExperiment(doc)];
    expect(runs).toHaveLength(80);
    expect(runs.every((r) => r.values && !r.error)).toBe(true);
    const rows = summarizeFactoryExperiment(doc.experiment!, runs);
    const row = (m: number, t: number, b: number) =>
      rows.find((r) => r.values.join() === [m, t, b].join())!;
    const two = row(2, 100, 5).stats.throughputPerHour;
    const three = row(3, 80, 5).stats.throughputPerHour;
    expect(two.n).toBe(10);
    expect(two.halfWidth).toBeGreaterThan(0);
    expect(three.mean - three.halfWidth!).toBeGreaterThan((two.mean + two.halfWidth!) * 1.1);
    expect(row(2, 100, 5).bottleneck).toBe('machining');
    expect(row(3, 100, 5).bottleneck).toBe('test');
    // A faster test with three machines leaves the assembly as the bottleneck.
    expect(row(3, 80, 5).bottleneck).toBe('assembly');
    // The buffer's size does not change throughput here, only how many parts wait.
    expect(row(3, 100, 1).stats.throughputPerHour.mean).toBe(
      row(3, 100, 5).stats.throughputPerHour.mean,
    );
    expect(row(3, 100, 5).stats.wipMean.mean).toBeGreaterThan(row(3, 100, 1).stats.wipMean.mean);
  });

  it('gives Student t intervals', () => {
    expect(studentT975(1)).toBeCloseTo(12.706, 3);
    expect(studentT975(9)).toBeCloseTo(2.262, 3);
    expect(studentT975(30)).toBeCloseTo(2.042, 3);
    expect(studentT975(31)).toBeCloseTo(2.0395, 3);
    expect(studentT975(99)).toBeCloseTo(1.9842, 3);
    expect(studentT975(0)).toBeNaN();
    const s = factoryStat([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.sd).toBeCloseTo(2.13809, 4);
    expect(s.halfWidth).toBeCloseTo((2.365 * 2.13809) / Math.sqrt(8), 4);
    expect(factoryStat([3])).toEqual({ n: 1, mean: 3, sd: 0 });
    expect(factoryStat([])).toEqual({ n: 0, mean: 0, sd: 0 });
  });

  it('keeps failed runs with their code and leaves them out of the statistics', () => {
    const doc = f170SmallLine();
    doc.experiment = { replications: 2, factors: [] };
    const runs = [...runFactoryExperiment(doc, { maxEvents: 100 })];
    expect(runs.map((r) => r.error)).toEqual(['event-limit', 'event-limit']);
    const [row] = summarizeFactoryExperiment(doc.experiment, runs);
    expect(row).toMatchObject({ runs: 2, failed: 2 });
    expect(row!.stats.produced.n).toBe(0);
    expect(writeFactoryExperimentCsv(doc.experiment, runs).split('\r\n')[1]).toMatch(/^2,2,,,,/);
    // An invalid document throws before any run.
    doc.experiment = { replications: 0, factors: [] };
    expect(() => runFactoryExperiment(doc).next()).toThrow(/replications/);
  });

  it('writes the comparison table and the runs as CSV', () => {
    const doc = f170SmallLine();
    doc.run.durationMs = H;
    doc.experiment = {
      replications: 2,
      factors: [{ kind: 'time-scale', targetId: 'test', values: [50, 100] }],
    };
    const runs = [...runFactoryExperiment(doc)];
    const table = writeFactoryExperimentCsv(doc.experiment, runs).trimEnd().split('\r\n');
    const header = table[0]!.split(',');
    expect(header.slice(0, 6)).toEqual([
      'time-scale:test',
      'runs',
      'failed',
      'throughputPerHour_mean',
      'throughputPerHour_ci95_low',
      'throughputPerHour_ci95_high',
    ]);
    expect(header.at(-1)).toBe('bottleneck');
    expect(table).toHaveLength(3);
    const first = table[1]!.split(',');
    const mean = Number(first[3]);
    expect(first[0]).toBe('50');
    expect(Number(first[4])).toBeLessThanOrEqual(mean);
    expect(Number(first[5])).toBeGreaterThanOrEqual(mean);
    const all = writeFactoryExperimentRunsCsv(doc.experiment, runs).trimEnd().split('\r\n');
    expect(all[0]).toBe(
      'time-scale:test,replication,seed,throughputPerHour,produced,leadTimeMeanMs,leadTimeP95Ms,wipMean,deadlock,bottleneck,error',
    );
    expect(all.slice(1).map((l) => l.split(',').slice(0, 3).join())).toEqual([
      '50,0,1',
      '50,1,2',
      '100,0,1',
      '100,1,2',
    ]);
    // With one run per combination the interval columns stay empty.
    const one = writeFactoryExperimentCsv({ ...doc.experiment, replications: 1 }, runs.slice(0, 2));
    expect(one.split('\r\n')[1]).toMatch(/^50,1,0,[0-9.]+,,,0,/);
    // Names with commas are quoted.
    const quoted = writeFactoryExperimentRunsCsv(
      { replications: 1, factors: [{ kind: 'time-scale', targetId: 'a,b', values: [100] }] },
      [],
    );
    expect(quoted.startsWith('"time-scale:a,b",')).toBe(true);
  });

  it('refuses experiments that do not fit the model and drops factors whose target goes', () => {
    const base = f170SmallLine();
    const refused = (experiment: unknown) =>
      validateFactory({ ...base, experiment }).map((d) => d.code);
    expect(refused({ replications: 101, factors: [] })).toContain('replications');
    expect(refused({ replications: 0, factors: [] })).toContain('replications');
    expect(refused({ replications: 1 })).toContain('missing');
    expect(refused({ replications: 1, factors: [], extra: 1 })).toContain('unknown-key');
    expect(
      refused({ replications: 1, factors: [{ kind: 'speed', targetId: 'test', values: [1] }] }),
    ).toContain('factor');
    // A buffer factor on a station, a fleet the model does not have.
    expect(
      refused({
        replications: 1,
        factors: [{ kind: 'buffer-capacity', targetId: 'test', values: [1] }],
      }),
    ).toContain('factor-target');
    expect(
      refused({
        replications: 1,
        factors: [{ kind: 'fleet-count', targetId: 'agv', values: [1] }],
      }),
    ).toContain('factor-target');
    // A target that is not a string is reported, not thrown on.
    expect(
      refused({
        replications: 1,
        factors: [{ kind: 'time-scale', targetId: { toString: 0 }, values: [1] }],
      }),
    ).toContain('factor-target');
    expect(
      refused({
        replications: 1,
        factors: [{ kind: 'time-scale', targetId: 'test', values: [100, 100] }],
      }),
    ).toContain('duplicate');
    expect(
      refused({
        replications: 1,
        factors: [
          { kind: 'time-scale', targetId: 'test', values: [100] },
          { kind: 'time-scale', targetId: 'test', values: [90] },
        ],
      }),
    ).toContain('duplicate');
    for (const values of [[0], [1001], [1.5], [], Array.from({ length: 21 }, (_, i) => i + 1)])
      expect(
        refused({ replications: 1, factors: [{ kind: 'time-scale', targetId: 'test', values }] }),
      ).toContain('factor-values');
    // 15 × 14 = 210 combinations (limit 200); 200 are fine.
    const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
    const table = (a: number, b: number) => ({
      replications: 100,
      factors: [
        { kind: 'time-scale', targetId: 'test', values: n(a) },
        { kind: 'buffer-capacity', targetId: 'buffer-1', values: n(b) },
      ],
    });
    expect(refused(table(15, 14))).toContain('limit-exceeded');
    expect(refused(table(20, 10))).toEqual([]);

    const doc = applyFactoryOperation(base, {
      type: 'setExperiment',
      experiment: {
        replications: 3,
        factors: [
          { kind: 'buffer-capacity', targetId: 'buffer-1', values: [1, 5] },
          { kind: 'time-scale', targetId: 'test', values: [90] },
        ],
      },
    });
    expect(() =>
      applyFactoryOperation(doc, {
        type: 'setExperiment',
        experiment: {
          replications: 3,
          factors: [{ kind: 'parallel-count', targetId: 'test', values: [2] }],
        },
      }),
    ).toThrow(/fitting target/);
    const gone = applyFactoryOperation(doc, { type: 'removeObject', id: 'buffer-1' });
    expect(gone.experiment!.factors.map((f) => f.targetId)).toEqual(['test']);
    // A station turned into a buffer no longer has times to scale.
    const turned = applyFactoryOperation(doc, {
      type: 'putObject',
      object: { id: 'test', name: 'Test', kind: 'buffer', capacity: 3 },
    });
    expect(turned.experiment!.factors.map((f) => f.targetId)).toEqual(['buffer-1']);
    expect(applyFactoryOperation(doc, { type: 'setExperiment', experiment: null }).experiment).toBe(
      undefined,
    );
  });
});
