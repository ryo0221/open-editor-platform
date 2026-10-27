import { it, expect } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { estimateFixture } from './fixtures';
import { assertEstimate } from './validate';
import {
  makeEstimateBasis,
  evaluateEstimate,
  calculateEstimate,
  calculationDifference,
} from './evaluate';
import { verifyEstimate, replaceEstimate } from './commands';
import { retainPriceData, priceValue } from './sources';
const evaluate = (d = estimateFixture()) => evaluateEstimate(makeEstimateBasis(d));
it('ES01/02 uses exact manual quantities, explicit line rounding and unit conversion', () => {
  const d = estimateFixture(),
    before = JSON.stringify(d);
  expect(evaluate(d).total).toBe('1350');
  expect(JSON.stringify(d)).toBe(before);
  d.currency = { code: 'USD', minorDigits: 2 };
  d.quantities = [d.quantities[0]];
  d.rates = [d.rates[0]];
  d.lines = [d.lines[0]];
  d.rates[0].currency = 'USD';
  d.quantities[0].value = '3';
  d.rates[0].unitPrice = '0.335';
  expect(evaluate(d).total).toBe('1.01');
  d.quantities[0].unit = 'mm';
  d.quantities[0].value = '3000';
  d.rates[0].perUnit = 'm';
  expect(evaluate(d).lines[0]).toMatchObject({
    adoptedQuantity: '3',
    unroundedCost: '1.005',
    cost: '1.01',
  });
  d.rates[0].perUnit = 'm2';
  expect(evaluate(d)).toMatchObject({ total: null, subtotal: '0' });
  expect(evaluate(d).diagnostics[0].code).toBe('unit-mismatch');
});
it('ES03 distinguishes missing, zero with reason, pending, exclusions and allocation gaps/duplicates', async () => {
  const d = estimateFixture();
  d.rates[1].unitPrice = null;
  expect(evaluate(d)).toMatchObject({ subtotal: '1200', total: null });
  await expect(calculateEstimate(d, 'blocked')).rejects.toThrow('incomplete-estimate');
  d.rates[1].unitPrice = '0';
  d.rates[1].evidence = '';
  expect(() => assertEstimate(d)).toThrow('reason-required');
  d.rates[1].evidence = '無償支給';
  expect(evaluate(d).total).toBe('1200');
  d.lines[1].bindings[0].allocationRatio = '0.5';
  expect(evaluate(d).diagnostics[0].code).toBe('under-allocation');
  d.lines.push({ ...structuredClone(d.lines[1]), id: 'duplicate' });
  expect(evaluate(d).total).toBe('1200');
  d.lines[2].bindings[0].allocationRatio = '1';
  expect(evaluate(d).diagnostics[0].code).toBe('over-allocation');
  d.lines.splice(1);
  expect(evaluate(d).diagnostics[0].code).toBe('unallocated-quantity');
  d.quantities[1].inclusion = 'exclude';
  d.quantities[1].exclusionReason = '別途支給・見積対象外';
  expect(evaluate(d).total).toBe('1200');
});
it('ES04 applies waste, purchase rounding and named-line adjustments without compounding or negative totals', () => {
  const d = estimateFixture();
  d.lines[1].wasteRatio = '0.1';
  d.lines[1].purchaseRounding = { scale: 0, rounding: 'ceil' };
  d.adjustments = [
    {
      id: 'tax',
      name: '利用者指定調整',
      kind: 'percent',
      value: '0.1',
      basisLineIds: ['line-panel', 'line-bolt'],
      reason: '試算用',
    },
    {
      id: 'discount',
      name: '値引き',
      kind: 'fixed',
      value: '-10',
      basisLineIds: [],
      reason: '架空の値引き',
    },
  ];
  expect(evaluate(d)).toMatchObject({ subtotal: '1375', total: '1503' });
  d.adjustments[0].basisLineIds = ['discount'];
  expect(() => assertEstimate(d)).toThrow('invalid-adjustment-basis');
  d.adjustments = [
    {
      id: 'negative',
      name: '値引き',
      kind: 'fixed',
      value: '-2000',
      basisLineIds: [],
      reason: '過剰値引き',
    },
  ];
  expect(evaluate(d).diagnostics[0].code).toBe('negative-total');
});
it('ES02 rejects invalid decimals, ratios, units, schema, currency and overflow', () => {
  for (const value of ['-1', '1e3', '-0', 'NaN', '1.00', '0.1234567890123']) {
    const d = estimateFixture();
    d.quantities[0].value = value;
    expect(() => assertEstimate(d)).toThrow();
  }
  const d = estimateFixture();
  d.currency.minorDigits = 5;
  expect(() => assertEstimate(d)).toThrow('invalid-currency');
  d.currency.minorDigits = 0;
  d.lines[0].wasteRatio = '1.01';
  expect(() => assertEstimate(d)).toThrow('invalid-ratio');
  d.lines[0].wasteRatio = '0';
  d.quantities[0].value = '9999999999999999999999999999999999';
  expect(() => evaluate(d)).toThrow('numeric-overflow');
  expect(() => assertEstimate({ ...estimateFixture(), workPlan: {} })).toThrow(
    'unknown-or-missing-property',
  );
});
it('ES05/10 replays every retained calculation and rejects forged flags, hashes and source prices', async () => {
  const d = estimateFixture();
  d.calculations = [await calculateEstimate(d, 'prior')];
  await verifyEstimate(d);
  const previous = JSON.stringify(d.calculations[0]);
  d.quantities[1].override = { value: '9', reason: '手入力の条件変更' };
  d.rates[1].override = { value: '30', reason: '架空の価格改定' };
  d.calculations.push(await calculateEstimate(d, 'new'));
  expect(d.calculations[1].result.total).toBe('1470');
  expect(
    calculationDifference(d.calculations[0], d.calculations[1]).find((v) => v.id === 'line-bolt')
      ?.delta,
  ).toBe('120');
  expect(JSON.stringify(d.calculations[0])).toBe(previous);
  await verifyEstimate(d);
  d.calculations[0].result.total = '1';
  d.calculations[0].resultHash = await contentHash(d.calculations[0].result);
  await expect(verifyEstimate(d)).rejects.toThrow('unverified-result');
});
it('ES10 keeps saved Data price pins and manual overrides separate, verifies source bytes, and rejects formula', async () => {
  const d = estimateFixture(),
    native = {
      schemaVersion: 2,
      columns: [{ id: 'price', name: 'Price', type: 'text' }],
      rows: [{ id: 'r1', values: { price: '1200' } }],
    };
  const source = await retainPriceData(
    {
      domain: 'data',
      artifactId: 'prices',
      versionId: 'v1',
      contentHash: await contentHash(native),
    },
    native,
  );
  d.retainedSources = [source];
  d.rates[0].source = { snapshotKey: source.key, rowId: 'r1', fieldId: 'price' };
  d.calculations = [await calculateEstimate(d, 'source-run')];
  await verifyEstimate(d);
  d.rates[0].override = { value: '1100', reason: '交渉価格（架空）' };
  expect(evaluate(d).total).toBe('1250');
  await verifyEstimate(d);
  d.rates[0].unitPrice = '1';
  await expect(verifyEstimate(d)).rejects.toThrow('price-source-mismatch');
  expect(() =>
    priceValue(
      { ...native, columns: [{ ...native.columns[0], type: 'formula', formula: '1' }] },
      'r1',
      'price',
    ),
  ).toThrow();
});
it('ES07 guards delayed command application, stale input and immutable calculations', async () => {
  const d = estimateFixture();
  d.calculations = [await calculateEstimate(d, 'old')];
  let canEdit = true;
  const guard = { canEdit: () => canEdit, canRead: () => true, inputsReady: () => true };
  const next = structuredClone(d);
  next.title = 'New';
  const command = replaceEstimate(d, next, guard);
  canEdit = false;
  expect(() => command.apply(d)).toThrow('read-only');
  canEdit = true;
  expect(() => command.apply({ ...d, title: 'Other' })).toThrow('stale-estimate');
  next.calculations[0].id = 'old';
  next.calculations[0].result.total = '1';
  expect(() => replaceEstimate(d, next, guard)).toThrow('immutable-calculation');
});
it('ES01 scenarios have explicit reasoned overrides and stable deterministic calculations', async () => {
  const d = estimateFixture();
  d.scenarios = [
    {
      id: 'higher',
      name: '改定案',
      quantities: [{ id: 'bolt', value: '9', reason: '数量変更' }],
      rates: [],
      waste: [],
      workRules: [],
    },
  ];
  const a = await calculateEstimate(d, 'first', 'higher'),
    b = await calculateEstimate(d, 'second', 'higher');
  expect(a.result.total).toBe('1425');
  expect(a.basisHash).toBe(b.basisHash);
  expect(a.resultHash).toBe(b.resultHash);
  expect(d.quantities[1].value).toBe('6');
});
it('ES14 explains simultaneous quantity and rate changes after line rounding: 75 + 45 = 120', async () => {
  const { explainCalculationDifference } = await import('./evaluate');
  const d = estimateFixture(),
    before = await calculateEstimate(d, 'old');
  d.quantities.find((q) => q.id === 'bolt')!.value = '9';
  d.rates.find((r) => r.id === 'bolt-price')!.unitPrice = '30';
  const after = await calculateEstimate(d, 'new');
  expect(
    explainCalculationDifference(before, after).find((l) => l.id === 'line-bolt'),
  ).toMatchObject({ delta: '120', quantityDelta: '75', rateDelta: '45', otherDelta: '0' });
});
