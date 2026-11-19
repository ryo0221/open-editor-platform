import { describe, expect, it } from 'vitest';
import { measureDesignTargets } from './design-targets';
import { compareCad } from './diff';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';
import type { CadPmiAsset } from './pmi';
import { f152CenterDistance } from './product-design-fixtures';
import {
  cadToleranceStacks,
  toleranceStackReport,
  toleranceStackResult,
  type CadStackContributor,
  type CadStackInput,
  type CadToleranceStack,
} from './tolerance-stacks';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
/** F152 without its design target, with these stacks (none: without the key). */
const withStacks = (stacks?: unknown[], extra: Partial<CadDocument> = {}): CadDocument => {
  const doc: CadDocument = { ...f152CenterDistance(), ...extra };
  delete doc.designTargets;
  if (stacks) doc.toleranceStacks = stacks as CadToleranceStack[];
  else delete doc.toleranceStacks;
  return doc;
};
const param = (doc: CadDocument, name: string) => doc.parameters.find((p) => p.name === name)!.id;
const contributor = (
  doc: CadDocument,
  name: string,
  lower: number,
  upper: number,
  sign: 1 | -1 = 1,
  distribution: CadStackContributor['distribution'] = 'normal',
): CadStackContributor => ({
  id: `c-${name.replace(/\W/g, '')}`,
  name,
  source: { kind: 'parameter', parameterId: param(doc, name), lower, upper },
  sign,
  distribution,
});

// PD3 (docs/cad/product-design.md, PD3 公差の積み上げ). ST-756, TS-2518..2520.
describe('PD3 tolerance stacks: the three methods', () => {
  it('adds the signed contributors by the worst case and the RSS (TS-2518)', () => {
    const doc = f152CenterDistance();
    const [r] = cadToleranceStacks(doc);
    expect(r!.status).toBe('ok');
    // 4 − (−4) + 0 − 0.
    expect(r!.nominal).toBeCloseTo(8, 12);
    // Every end together: ±(4 × 0.005).
    expect(r!.worst!.min).toBeCloseTo(7.98, 12);
    expect(r!.worst!.max).toBeCloseTo(8.02, 12);
    // On the band's ends, which a sum's rounding never flips.
    expect(r!.worst!.status).toBe('pass');
    // RSS: two normals with σ = 0.01/6 and two uniforms with σ² = 0.01²/12.
    const half = 3 * Math.sqrt(2 * (0.01 / 6) ** 2 + (2 * 0.01 ** 2) / 12);
    expect(r!.rss!.min).toBeCloseTo(8 - half, 12);
    expect(r!.rss!.max).toBeCloseTo(8 + half, 12);
    expect(r!.rss!.status).toBe('pass');
    // Shares of the variance: the uniform plays weigh 3× a normal hole each.
    const shares = Object.fromEntries(r!.contributors.map((c) => [c.id, c.share]));
    expect(shares['hole-a']).toBeCloseTo(0.125, 12);
    expect(shares['play-a']).toBeCloseTo(0.375, 12);
    expect(r!.contributors.reduce((a, c) => a + c.share!, 0)).toBeCloseTo(1, 12);
  });

  it('takes an asymmetric tolerance with its sign, and fails a band it leaves (TS-2518)', () => {
    const base = f152CenterDistance();
    const s: CadToleranceStack = {
      id: 's',
      name: 'Gap',
      contributors: [
        contributor(base, 'Hole B x', 0, 0.1),
        contributor(base, 'Hole A x', -0.02, 0, -1, 'uniform'),
      ],
      min: 8,
      max: 8.1,
    };
    const r = toleranceStackResult(withStacks([s]), s);
    // B 4 +0.1/0; minus A (−4 −0.02/0): 8 to 8.12.
    expect(r.worst).toMatchObject({ status: 'fail' });
    expect(r.worst!.min).toBeCloseTo(8, 12);
    expect(r.worst!.max).toBeCloseTo(8.12, 12);
    // The mean moves to the tolerances' middles: 8.05 + 0.01.
    expect((r.rss!.min + r.rss!.max) / 2).toBeCloseTo(8.06, 12);
    // A stack without a band gives the numbers and no pass or fail.
    const free = toleranceStackResult(withStacks([s]), { ...s, min: undefined, max: undefined });
    expect(free.worst!.status).toBeUndefined();
    expect(free.monteCarlo!.status).toBeUndefined();
    expect(free.monteCarlo!.outside).toBe(0);
  });

  it('runs the Monte Carlo with a fixed seed: the same numbers each time (TS-2519)', () => {
    const doc = f152CenterDistance();
    const s = doc.toleranceStacks![0]!;
    const a = toleranceStackResult(doc, s).monteCarlo!;
    const b = toleranceStackResult(doc, s).monteCarlo!;
    expect(b).toEqual(a);
    expect(a.runs).toBe(100_000);
    expect(a.seed).toBe(152);
    // Near the RSS: the mean at 8, σ = √(Σσᵢ²).
    const sigma = Math.sqrt(2 * (0.01 / 6) ** 2 + (2 * 0.01 ** 2) / 12);
    expect(a.mean).toBeCloseTo(8, 4);
    expect(Math.abs(a.sigma / sigma - 1)).toBeLessThan(0.01);
    // Never past the worst case, and inside it here: no run leaves 8 ±0.02.
    expect(a.min).toBeGreaterThanOrEqual(7.98 - 1e-9);
    expect(a.max).toBeLessThanOrEqual(8.02 + 1e-9);
    expect(a.outside).toBe(0);
    expect(a.status).toBe('pass');
    // Another seed, other runs.
    const c = toleranceStackResult(doc, { ...s, seed: 7 }).monteCarlo!;
    expect(c.mean).not.toBe(a.mean);
    expect(c.seed).toBe(7);
    // The defaults: 10,000 runs with seed 1.
    const d = toleranceStackResult(doc, { ...s, runs: undefined, seed: undefined }).monteCarlo!;
    expect([d.runs, d.seed]).toEqual([10_000, 1]);
    // A large dimension with a small tolerance keeps its σ (1,000,000 mm ±0.001 mm, normal).
    const big = withStacks([]);
    big.parameters = [...big.parameters, { id: 'p-big', name: 'Big', type: 'length', value: 1e6 }];
    const far = toleranceStackResult(big, {
      id: 'big',
      name: 'Big',
      contributors: [
        {
          id: 'c',
          name: 'Big',
          source: { kind: 'parameter', parameterId: 'p-big', lower: -0.001, upper: 0.001 },
          sign: 1,
          distribution: 'normal',
        },
      ],
    }).monteCarlo!;
    expect(Math.abs(far.sigma / (0.002 / 6) - 1)).toBeLessThan(0.03);
    expect(far.sigma).toBeLessThanOrEqual(far.max - far.min);
    // One run: σ 0.
    expect(toleranceStackResult(doc, { ...s, runs: 1 }).monteCarlo!.sigma).toBe(0);
  });

  it('counts the runs outside the band and passes by the allowed fraction (TS-2519)', () => {
    const doc = f152CenterDistance();
    const s = { ...doc.toleranceStacks![0]!, min: 7.995, max: 8.005 };
    const r = toleranceStackResult(doc, s);
    expect(r.worst!.status).toBe('fail');
    // ±0.005 is about 1.06σ: some 29 % of the runs leave it.
    const mc = r.monteCarlo!;
    expect(mc.outsideFraction).toBeGreaterThan(0.25);
    expect(mc.outsideFraction).toBeLessThan(0.33);
    expect(mc.outside).toBe(Math.round(mc.outsideFraction * mc.runs));
    expect(mc.status).toBe('fail');
    expect(toleranceStackResult(doc, { ...s, maxOutside: 0.5 }).monteCarlo!.status).toBe('pass');
    // Uniform draws stay inside their tolerance: a band on the worst case is never left.
    const u = f152CenterDistance();
    const only = {
      ...u.toleranceStacks![0]!,
      contributors: u.toleranceStacks![0]!.contributors.map((x) => ({
        ...x,
        distribution: 'uniform' as const,
      })),
      maxOutside: 0,
    };
    expect(toleranceStackResult(u, only).monteCarlo).toMatchObject({ outside: 0, status: 'pass' });
  });
});

describe('PD3 tolerance stacks: stale contributors', () => {
  const plate = (deviation?: { lower: number; upper: number }): CadPmiAsset => ({
    version: 1,
    items: [
      {
        id: 'pmi-1',
        kind: 'dimension',
        type: 'Location_LinearDistance',
        values: [8],
        targets: [{ shape: 'face', index: 1 }],
        ...(deviation ? { deviation } : {}),
      },
      {
        id: 'pmi-2',
        kind: 'dimension',
        type: 'Size_Angular',
        values: [90],
        deviation: { lower: -1, upper: 1 },
        targets: [{ shape: 'face', index: 2 }],
      },
      {
        id: 'pmi-3',
        kind: 'dimension',
        type: 'Size_Diameter',
        values: [2.1, 2],
        targets: [{ shape: 'face', index: 3 }],
      },
      {
        id: 'pmi-4',
        kind: 'dimension',
        type: 'Size_Diameter',
        values: [2],
        qualifier: 'max',
        deviation: { lower: 0, upper: 0.1 },
        targets: [{ shape: 'face', index: 3 }],
      },
      {
        id: 'pmi-5',
        kind: 'geometric-tolerance',
        type: 'Position',
        value: 0.01,
        modifiers: [],
        references: [],
        targets: [{ shape: 'face', index: 4 }],
      },
    ],
  });
  const pmiStack = (doc: CadDocument, itemId: string): CadToleranceStack => ({
    id: 'p',
    name: 'From PMI',
    contributors: [
      {
        id: 'x',
        name: 'Plate',
        source: { kind: 'pmi', bodyId: doc.bodies[0]!.id, itemId },
        sign: 1,
        distribution: 'normal',
      },
    ],
  });

  it('reads a PMI dimension with its tolerance, a range by its middle (TS-2520)', () => {
    const doc = f152CenterDistance();
    const asset = plate({ lower: -0.01, upper: 0.02 });
    const at = (itemId: string, items?: Map<string, { current: true }>) =>
      toleranceStackResult(doc, pmiStack(doc, itemId), { pmi: () => ({ asset, items }) });
    const r = at('pmi-1');
    expect(r.status).toBe('ok');
    expect(r.contributors[0]).toMatchObject({ nominal: 8, lower: -0.01, upper: 0.02 });
    expect(r.worst!.min).toBeCloseTo(7.99, 12);
    expect(r.worst!.max).toBeCloseTo(8.02, 12);
    // 2.0–2.1: 2.05 ±0.05.
    const range = at('pmi-3').contributors[0]!;
    expect(range.nominal).toBeCloseTo(2.05, 12);
    expect(range.lower).toBeCloseTo(-0.05, 12);
    expect(range.upper).toBeCloseTo(0.05, 12);
    // Current past a change of the shape (PMI-4a).
    expect(at('pmi-1', new Map([['pmi-1', { current: true }]])).status).toBe('ok');
  });

  it('is stale, with no numbers, when a contributor no longer resolves (TS-2520)', () => {
    const doc = f152CenterDistance();
    const reason = (itemId: string, pmi?: CadStackInput['pmi']) => {
      const r = toleranceStackResult(doc, pmiStack(doc, itemId), pmi ? { pmi } : {});
      expect(r.status).toBe('stale');
      expect(r.worst).toBeUndefined();
      expect(r.monteCarlo).toBeUndefined();
      return r.contributors[0]!.reason;
    };
    const asset = plate({ lower: -0.01, upper: 0.01 });
    expect(reason('pmi-1')).toBe('stack-pmi-missing');
    expect(reason('pmi-9', () => ({ asset }))).toBe('stack-pmi-missing');
    expect(
      reason('pmi-1', () => ({
        asset,
        items: new Map([['pmi-1', { current: false, reason: 'target' } as const]]),
      })),
    ).toBe('stack-pmi-stale');
    expect(reason('pmi-2', () => ({ asset }))).toBe('stack-pmi-kind');
    expect(reason('pmi-5', () => ({ asset }))).toBe('stack-pmi-kind');
    expect(reason('pmi-4', () => ({ asset }))).toBe('stack-pmi-tolerance');
    expect(reason('pmi-1', () => ({ asset: plate() }))).toBe('stack-pmi-tolerance');
    // A deleted body: stale.
    const gone = pmiStack(doc, 'pmi-1');
    (gone.contributors[0]!.source as { bodyId: string }).bodyId = 'body-gone';
    expect(
      toleranceStackResult(doc, gone, { pmi: () => ({ asset }) }).contributors[0]!.reason,
    ).toBe('stack-pmi-missing');

    // A parameter deleted from the document: the stack stays, stale, and the document is valid.
    const holeB = param(doc, 'Hole B x');
    const after = applyCadOperation(doc, { type: 'deleteClosure', ids: [holeB], cascade: true });
    expect(after.toleranceStacks).toHaveLength(1);
    expect(codes(after)).toEqual([]);
    const r = cadToleranceStacks(after)[0]!;
    expect(r.status).toBe('stale');
    expect(r.contributors.find((c) => c.id === 'hole-b')!.reason).toBe('stack-parameter-missing');
    // The others keep their resolved values for the reader.
    expect(r.contributors.find((c) => c.id === 'hole-a')).toMatchObject({ nominal: -4 });
  });
});

// ST-757, TS-2521..2523, TS-2525.
describe('PD3 tolerance stacks in the document', () => {
  it('sets, refuses the same list, removes when empty, diffs (TS-2521)', () => {
    const doc = f152CenterDistance();
    const stacks = doc.toleranceStacks!;
    const bare = withStacks();
    const set = applyCadOperation(bare, { type: 'setToleranceStacks', stacks });
    expect(set.toleranceStacks).toEqual(stacks);
    expect(compareCad(bare, set).map((c) => c.elementId)).toEqual(['toleranceStacks']);
    expect(() => applyCadOperation(set, { type: 'setToleranceStacks', stacks })).toThrow(
      'tolerance-stacks-unchanged',
    );
    const empty = applyCadOperation(set, { type: 'setToleranceStacks', stacks: [] });
    expect(Object.hasOwn(empty, 'toleranceStacks')).toBe(false);
    // A design target on a removed stack goes with it.
    const dropped = applyCadOperation(doc, { type: 'setToleranceStacks', stacks: [] });
    expect(dropped.designTargets).toBeUndefined();
    expect(codes(dropped)).toEqual([]);
  });

  it('refuses malformed stacks with their codes (TS-2521)', () => {
    const doc = f152CenterDistance();
    const s = doc.toleranceStacks![0]!;
    const x = s.contributors[0]!;
    const angle = { id: 'p-angle', name: 'Angle', type: 'angle' as const, value: 1 };
    const bad = (stack: unknown, extra: Partial<CadDocument> = {}) =>
      codes(withStacks([stack], extra));
    expect(codes(withStacks([]))).toContain('tolerance-stacks@$.toleranceStacks');
    expect(bad({ ...s, min: 9, max: 8 })).toContain(
      'tolerance-stack-band@$.toleranceStacks[0].max',
    );
    expect(bad({ ...s, runs: 100_001 })).toContain(
      'tolerance-stack-runs@$.toleranceStacks[0].runs',
    );
    expect(bad({ ...s, runs: 1.5 })).toContain('tolerance-stack-runs@$.toleranceStacks[0].runs');
    expect(bad({ ...s, seed: -1 })).toContain('tolerance-stack-seed@$.toleranceStacks[0].seed');
    expect(bad({ ...s, maxOutside: 2 })).toContain(
      'tolerance-stack-outside@$.toleranceStacks[0].maxOutside',
    );
    expect(bad({ ...s, requirement: ' ' })).toContain(
      'tolerance-stack-requirement@$.toleranceStacks[0].requirement',
    );
    expect(bad({ ...s, contributors: [] })).toContain(
      'tolerance-stack-contributors@$.toleranceStacks[0].contributors',
    );
    expect(bad({ ...s, contributors: [x, x] })).toContain(
      'duplicate-id@$.toleranceStacks[0].contributors[1].id',
    );
    const at = '$.toleranceStacks[0].contributors[0]';
    expect(bad({ ...s, contributors: [{ ...x, sign: 0 }] })).toContain(
      `tolerance-stack-sign@${at}.sign`,
    );
    expect(bad({ ...s, contributors: [{ ...x, distribution: 'beta' }] })).toContain(
      `tolerance-stack-distribution@${at}.distribution`,
    );
    expect(
      bad({ ...s, contributors: [{ ...x, source: { ...x.source, lower: 0.1, upper: 0 } }] }),
    ).toContain(`tolerance-stack-deviation@${at}.source.upper`);
    expect(bad({ ...s, contributors: [{ ...x, source: { ...x.source, upper: 2000 } }] })).toContain(
      `tolerance-stack-deviation@${at}.source.upper`,
    );
    expect(
      bad(
        {
          ...s,
          contributors: [{ ...x, source: { ...x.source, parameterId: angle.id } }],
        },
        { parameters: [...doc.parameters, angle] },
      ),
    ).toContain(`tolerance-stack-parameter-unit@${at}.source.parameterId`);
    expect(bad({ ...s, contributors: [{ ...x, source: { kind: 'note' } }] })).toContain(
      `tolerance-stack-source@${at}.source`,
    );
    expect(
      bad({
        ...s,
        contributors: [{ ...x, source: { kind: 'pmi', bodyId: 'b', itemId: 'face-1' } }],
      }),
    ).toContain(`tolerance-stack-pmi-item@${at}.source.itemId`);
    // 64 contributors × 100,000 runs twice is past the document's work.
    const wide = {
      ...s,
      runs: 100_000,
      contributors: Array.from({ length: 64 }, (_, i) => ({ ...x, id: `c${i}` })),
    };
    expect(codes(withStacks([wide, { ...wide, id: 'other' }]))).toContain(
      'tolerance-stacks-work@$.toleranceStacks',
    );
    // A design target on a stack that is not there.
    const noStacks: CadDocument = { ...doc };
    delete noStacks.toleranceStacks;
    expect(codes(noStacks)).toContain('design-target-stack@$.designTargets[0].measure.stackId');
    expect(
      codes({
        ...doc,
        designTargets: [
          {
            ...doc.designTargets![0]!,
            measure: { kind: 'tolerance-stack', stackId: 'center-distance', value: 'median' },
          },
        ],
      }),
    ).toContain('design-target-stack-value@$.designTargets[0].measure.value');
  });

  it('F152 validates, its stack and its target as written (TS-2522)', () => {
    const doc = f152CenterDistance();
    expect(codes(doc)).toEqual([]);
    expect(doc.toleranceStacks![0]!.contributors.map((c) => c.distribution)).toEqual([
      'normal',
      'normal',
      'uniform',
      'uniform',
    ]);
    const [r] = cadToleranceStacks(doc);
    expect([r!.worst!.status, r!.rss!.status, r!.monteCarlo!.status]).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('lets a design target read a stack: pass, fail, unknown when stale (TS-2523)', () => {
    const doc = f152CenterDistance();
    const [t] = measureDesignTargets(doc, {});
    expect(t).toMatchObject({ id: 'center-distance-min', unit: 'mm', status: 'pass' });
    expect(t!.value).toBeCloseTo(7.98, 12);
    // Wider holes: the worst case drops below 7.98.
    const wide = structuredClone(doc);
    for (const x of wide.toleranceStacks![0]!.contributors)
      x.source = { ...x.source, lower: -0.01, upper: 0.01 } as typeof x.source;
    expect(measureDesignTargets(wide, {})[0]).toMatchObject({ status: 'fail' });
    // The outside fraction, as a ratio.
    const outside = structuredClone(doc);
    outside.designTargets = [
      {
        id: 'mc',
        name: 'Runs outside',
        measure: { kind: 'tolerance-stack', stackId: 'center-distance', value: 'mc-outside' },
        max: 0.001,
      },
    ];
    expect(measureDesignTargets(outside, {})[0]).toMatchObject({
      unit: 'ratio',
      value: 0,
      status: 'pass',
    });
    // The results the panel worked out with the PMI are used as they are.
    const stale = cadToleranceStacks(doc).map((r) => ({ ...r, status: 'stale' as const }));
    expect(measureDesignTargets(doc, { stacks: stale })[0]).toMatchObject({
      status: 'unknown',
      reason: 'design-stack-stale',
    });
  });

  it('lets a target agree with its stack at an inclusive end despite rounding (TS-2523)', () => {
    // 0.1 + 0.2 adds up to 0.30000000000000004: the stack passes a 0.3 maximum by its slack, and
    // a target on the stack's worst-case maximum with the same 0.3 passes too.
    const doc = withStacks([]);
    doc.parameters.push(
      { id: 'pa', name: 'A', type: 'length', value: 0.1 },
      { id: 'pb', name: 'B', type: 'length', value: 0.2 },
    );
    doc.toleranceStacks = [
      {
        id: 'sum',
        name: 'Sum',
        contributors: [contributor(doc, 'A', 0, 0), contributor(doc, 'B', 0, 0)],
        max: 0.3,
      },
    ];
    const [r] = cadToleranceStacks(doc);
    expect(r!.worst!.max).toBeGreaterThan(0.3);
    expect(r!.worst!.status).toBe('pass');
    doc.designTargets = [
      {
        id: 'sum-max',
        name: 'Sum, worst case',
        measure: { kind: 'tolerance-stack', stackId: 'sum', value: 'worst-max' },
        max: 0.3,
      },
    ];
    expect(measureDesignTargets(doc, {})[0]).toMatchObject({ status: 'pass' });
    // Past the slack it still fails.
    doc.designTargets[0]!.max = 0.3 - 1e-6;
    expect(measureDesignTargets(doc, {})[0]).toMatchObject({ status: 'fail' });
  });

  it('exports the stacks with their three results as JSON (TS-2525)', () => {
    const doc = f152CenterDistance();
    const report = toleranceStackReport(doc, cadToleranceStacks(doc), 'F152');
    expect(report.format).toBe('editor-platform/cad-tolerance-stacks@1');
    expect(report.document).toBe('F152');
    const [s] = report.stacks;
    expect(s).toMatchObject({
      id: 'center-distance',
      requirement: 'RQ-11',
      min: 7.98,
      max: 8.02,
      unit: 'mm',
      status: 'ok',
      worst: { status: 'pass' },
      rss: { status: 'pass' },
      monteCarlo: { runs: 100_000, seed: 152, maxOutside: 0.0027, status: 'pass' },
    });
    expect(s!.contributors[0]).toMatchObject({ id: 'hole-b', sign: 1, nominal: 4 });
    expect(s!.contributors[0]!.share).toBeCloseTo(0.125, 12);
    // Round-trips as JSON.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    // A stale stack has no numbers in it.
    const stale = toleranceStackReport(
      doc,
      cadToleranceStacks(doc).map((r) => ({ ...r, status: 'stale' as const })),
    );
    expect(stale.stacks[0]).not.toHaveProperty('worst');
  });
});
