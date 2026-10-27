import { assertWork } from './work';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  assertJson,
  record,
  identifier,
  textValue,
  decimal,
  compare,
  unitInfo,
  assertPin,
  pinKey,
  CalculationError,
} from '@editor-platform/calculation-core';
import {
  LIMITS,
  type EstimateDocument,
  type EstimateRecipe,
  type EstimateBasis,
  type EstimateResult,
  type Quantity,
  type Rate,
  type Line,
  type Adjustment,
} from './types';
const fail = (code: string): never => {
  throw new CalculationError(code);
};
export function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('collection-limit');
  return value as unknown[];
}
export function ids(value: unknown, max: number): string[] {
  const values = list(value, max);
  values.forEach(identifier);
  if (new Set(values).size !== values.length) fail('duplicate-id');
  return values as string[];
}
function unique(values: { id: string }[]) {
  ids(
    values.map((v) => v.id),
    values.length,
  );
}
export function amount(value: unknown, signed = false): asserts value is string {
  if (typeof value !== 'string') fail('invalid-decimal');
  const d = decimal(value as string);
  if (!signed && d.coefficient < 0n) fail('negative-amount');
}
function ratio(v: unknown, signed = false) {
  amount(v, signed);
  if (
    compare(decimal(v), decimal(signed ? '-1' : '0')) < 0 ||
    compare(decimal(v), decimal('1')) > 0
  )
    fail('invalid-ratio');
}
function unit(v: unknown) {
  identifier(v);
  const info = unitInfo(v);
  if (Object.keys(info.dimensions).some((d) => d.startsWith('currency:')))
    fail('quantity-currency-unit');
}
function rounding(v: unknown) {
  if (!['half-even', 'half-up', 'floor', 'ceil'].includes(String(v))) fail('invalid-rounding');
}
function reason(v: unknown) {
  textValue(v);
  if (!v.trim()) fail('reason-required');
}
function override(v: unknown) {
  const r = record(v, ['value', 'reason']);
  amount(r.value);
  reason(r.reason);
}
function inclusion(v: unknown, r: unknown) {
  if (!['include', 'exclude', 'pending'].includes(String(v))) fail('invalid-inclusion');
  textValue(r);
  if (v === 'exclude') reason(r);
}
export function assertRecipe(value: unknown): asserts value is EstimateRecipe {
  const v = value as Record<string, unknown>;
  const c = record(v.currency, ['code', 'minorDigits']);
  if (
    typeof c.code !== 'string' ||
    !/^[A-Z]{3}$/.test(c.code) ||
    !Number.isInteger(c.minorDigits) ||
    Number(c.minorDigits) < 0 ||
    Number(c.minorDigits) > 4
  )
    fail('invalid-currency');
  rounding(v.rounding);
  const quantities = list(v.quantities, LIMITS.quantities);
  for (const x of quantities) {
    const q = record(
      x,
      ['id', 'name', 'unit', 'value', 'quality', 'evidence', 'inclusion', 'exclusionReason'],
      ['override', 'source'],
    );
    identifier(q.id);
    textValue(q.name);
    unit(q.unit);
    if (q.value !== null) amount(q.value);
    if (!['manual', 'cad', 'analytic', 'kernel'].includes(String(q.quality)))
      fail('unsupported-quantity-source');
    if (q.quality === 'manual') {
      if (q.source !== undefined) fail('manual-source-conflict');
    } else {
      const source = record(q.source, [
        'snapshotKey',
        'identity',
        'metric',
        'scope',
        'coverage',
        'extractionBasis',
      ]);
      identifier(source.snapshotKey);
      identifier(source.identity);
      identifier(source.metric);
      identifier(source.extractionBasis);
      if (source.scope !== 'whole') fail('unsupported-quantity-scope');
      ids(source.coverage, 10000);
      if (!(source.coverage as string[]).length) fail('empty-coverage');
    }
    reason(q.evidence);
    if (q.override !== undefined) override(q.override);
    inclusion(q.inclusion, q.exclusionReason);
  }
  const rates = list(v.rates, LIMITS.rates);
  for (const x of rates) {
    const r = record(
      x,
      ['id', 'name', 'unitPrice', 'perUnit', 'currency', 'evidence'],
      ['override', 'source'],
    );
    identifier(r.id);
    textValue(r.name);
    unit(r.perUnit);
    textValue(r.evidence);
    if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) fail('invalid-currency');
    if (r.unitPrice !== null) {
      amount(r.unitPrice);
      if (r.unitPrice === '0') reason(r.evidence);
    }
    if (r.override !== undefined) override(r.override);
    if (r.source !== undefined) {
      const s = record(r.source, ['snapshotKey', 'rowId', 'fieldId']);
      Object.values(s).forEach(identifier);
    }
  }
  const rateIds = new Set((rates as Rate[]).map((r) => r.id));
  const quantityIds = new Set((quantities as Quantity[]).map((q) => q.id));
  const lines = list(v.lines, LIMITS.lines);
  const lineIds = new Set((lines as Line[]).map((l) => l?.id));
  for (const x of lines) {
    const l = record(
      x,
      [
        'id',
        'name',
        'category',
        'note',
        'bindings',
        'rateId',
        'wasteRatio',
        'inclusion',
        'exclusionReason',
      ],
      ['purchaseRounding'],
    );
    identifier(l.id);
    textValue(l.name);
    identifier(l.category);
    textValue(l.note);
    ratio(l.wasteRatio);
    inclusion(l.inclusion, l.exclusionReason);
    if (l.rateId !== null) {
      identifier(l.rateId);
      if (!rateIds.has(l.rateId)) fail('missing-rate');
    }
    const bindings = list(l.bindings, LIMITS.quantities);
    for (const b of bindings) {
      const r = record(b, ['quantityId', 'allocationRatio']);
      identifier(r.quantityId);
      ratio(r.allocationRatio);
      if (!quantityIds.has(r.quantityId)) fail('missing-quantity');
    }
    ids(
      (bindings as Line['bindings']).map((b) => b.quantityId),
      LIMITS.quantities,
    );
    if (l.purchaseRounding !== undefined) {
      const r = record(l.purchaseRounding, ['scale', 'rounding']);
      if (!Number.isInteger(r.scale) || Number(r.scale) < 0 || Number(r.scale) > 12)
        fail('invalid-scale');
      rounding(r.rounding);
    }
  }
  const adjustments = list(v.adjustments, LIMITS.adjustments);
  for (const x of adjustments) {
    const a = record(x, ['id', 'name', 'kind', 'value', 'basisLineIds', 'reason']);
    identifier(a.id);
    textValue(a.name);
    reason(a.reason);
    if (!['fixed', 'percent'].includes(String(a.kind))) fail('unknown-adjustment');
    amount(a.value, true);
    if (a.kind === 'percent') ratio(a.value, true);
    const targets = ids(a.basisLineIds, LIMITS.lines);
    if (a.kind === 'percent' && !targets.length) fail('missing-adjustment-basis');
    if (targets.some((id) => !lineIds.has(id))) fail('invalid-adjustment-basis');
  }
  assertWork(
    v.workRules,
    v.workPlan ?? {
      projectStartDate: '2000-01-01',
      calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
      tasks: [],
      dependencies: [],
    },
  );
  if (
    v.workPlan &&
    (v.workPlan as import('./work').WorkPlan).tasks.some((t) => !lineIds.has(t.lineId))
  )
    fail('missing-work-line');
  unique(quantities as Quantity[]);
  unique(rates as Rate[]);
  unique(lines as Line[]);
  unique(adjustments as Adjustment[]);
}
export function assertBasis(value: unknown): asserts value is EstimateBasis {
  const b = record(
    value,
    [
      'engine',
      'scenarioId',
      'sources',
      'currency',
      'rounding',
      'quantities',
      'rates',
      'lines',
      'adjustments',
      'workRules',
    ],
    ['workPlan'],
  );
  identifier(b.engine);
  if (b.scenarioId !== null) identifier(b.scenarioId);
  ids(b.sources, LIMITS.sources);
  assertRecipe(b);
}
function assertResult(value: unknown): asserts value is EstimateResult {
  const r = record(value, ['lines', 'adjustments', 'subtotal', 'total', 'diagnostics'], ['work']);
  if (r.work !== undefined)
    for (const task of list(r.work, 1000)) {
      const t = record(task, [
        'id',
        'name',
        'lineId',
        'effortHours',
        'durationWorkdays',
        'start',
        'finishExclusive',
        'lastWorkingDate',
        'kind',
      ]);
      identifier(t.id);
      identifier(t.lineId);
      textValue(t.name);
      amount(t.effortHours);
      if (
        !Number.isInteger(t.durationWorkdays) ||
        Number(t.durationWorkdays) < 0 ||
        Number(t.durationWorkdays) > 3653 ||
        !['task', 'milestone'].includes(String(t.kind))
      )
        fail('invalid-work-result');
      for (const key of ['start', 'finishExclusive', 'lastWorkingDate'])
        if (typeof t[key] !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(t[key] as string))
          fail('invalid-work-date');
    }
  amount(r.subtotal);
  if (r.total !== null) amount(r.total);
  for (const x of list(r.lines, LIMITS.lines)) {
    const l = record(x, [
      'id',
      'name',
      'category',
      'unit',
      'currency',
      'adoptedQuantity',
      'billableQuantity',
      'unitPrice',
      'unroundedCost',
      'cost',
    ]);
    identifier(l.id);
    textValue(l.name);
    identifier(l.category);
    unit(l.unit);
    identifier(l.currency);
    for (const key of ['adoptedQuantity', 'billableQuantity', 'unitPrice', 'unroundedCost', 'cost'])
      amount(l[key]);
  }
  for (const x of list(r.adjustments, LIMITS.adjustments)) {
    const a = record(x, ['id', 'value']);
    identifier(a.id);
    amount(a.value, true);
  }
  for (const x of list(r.diagnostics, 10000)) {
    const d = record(x, ['code', 'id', 'message', 'target']);
    if (!['quantity', 'line', 'adjustment', 'work', 'document'].includes(String(d.target)))
      fail('invalid-diagnostic-target');
    identifier(d.code);
    identifier(d.id);
    textValue(d.message);
  }
}
export function assertEstimate(value: unknown): asserts value is EstimateDocument {
  assertJson(value, LIMITS.bytes);
  const d = record(
    value,
    [
      'schemaVersion',
      'domain',
      'title',
      'description',
      'currency',
      'rounding',
      'quantities',
      'rates',
      'lines',
      'adjustments',
      'scenarios',
      'calculations',
      'retainedSources',
      'workRules',
    ],
    ['workPlan'],
  );
  if (d.schemaVersion !== 1 || d.domain !== 'estimate') fail('unsupported-estimate-schema');
  textValue(d.title);
  textValue(d.description);
  assertRecipe(d);
  const sources = list(d.retainedSources, LIMITS.sources),
    keys: string[] = [],
    versions = new Map<string, string>();
  for (const item of sources) {
    const s = record(item, ['key', 'pin', 'nativeContent', 'dependencies']);
    assertPin(s.pin);
    if (s.key !== pinKey(s.pin)) fail('source-key-mismatch');
    keys.push(s.key as string);
    ids(s.dependencies, LIMITS.sources);
    if (s.pin.domain === 'data' && (s.dependencies as string[]).length)
      fail('unsupported-source-dependencies');
    const identity = canonicalJson([s.pin.domain, s.pin.artifactId, s.pin.versionId]);
    if (versions.has(identity) && versions.get(identity) !== s.pin.contentHash)
      fail('source-version-conflict');
    versions.set(identity, s.pin.contentHash);
  }
  ids(keys, LIMITS.sources);
  for (const item of sources) {
    const source = item as { key: string; dependencies: string[] };
    if (source.dependencies.some((key) => !keys.includes(key) || key === source.key))
      fail('missing-source-dependency');
  }
  const checkQuantities = (quantities: Quantity[]) => {
    for (const q of quantities)
      if (q.source && !keys.includes(q.source.snapshotKey)) fail('missing-quantity-source');
  };
  checkQuantities(d.quantities);
  const checkSources = (rates: Rate[]) => {
    for (const r of rates)
      if (r.source && !keys.includes(r.source.snapshotKey)) fail('missing-source');
  };
  checkSources(d.rates);
  const scenarios = list(d.scenarios, LIMITS.scenarios);
  for (const x of scenarios) {
    const s = record(x, ['id', 'name', 'quantities', 'rates', 'waste', 'workRules']);
    identifier(s.id);
    textValue(s.name);
    const workOverrides = list(s.workRules, LIMITS.lines);
    const mergedRules = structuredClone(d.workRules);
    for (const override of workOverrides) {
      const rule = override as { id: string };
      const target = mergedRules.find((r) => r.id === rule?.id);
      if (!target) fail('missing-scenario-target');
      Object.assign(target!, override);
    }
    unique(workOverrides as { id: string }[]);
    assertWork(s.workRules, {
      projectStartDate: '2026-01-01',
      calendar: { weekdays: [1], exceptions: [] },
      tasks: [],
      dependencies: [],
    });
    for (const [key, source] of [
      ['quantities', d.quantities],
      ['rates', d.rates],
      ['waste', d.lines],
    ] as const) {
      const overrides = list(s[key], key === 'quantities' ? LIMITS.quantities : LIMITS.lines);
      for (const item of overrides) {
        const o = record(item, key === 'waste' ? ['id', 'value'] : ['id', 'value', 'reason']);
        identifier(o.id);
        amount(o.value);
        if (key === 'waste') ratio(o.value);
        else reason(o.reason);
        if (!source.some((v) => v.id === o.id)) fail('missing-scenario-target');
      }
      unique(overrides as { id: string }[]);
    }
  }
  unique(scenarios as { id: string }[]);
  const calculations = list(d.calculations, LIMITS.calculations);
  for (const x of calculations) {
    const c = record(x, ['id', 'basis', 'basisHash', 'result', 'resultHash']);
    identifier(c.id);
    assertBasis(c.basis);
    checkSources(c.basis.rates);
    checkQuantities(c.basis.quantities);
    if (c.basis.sources.some((k) => !keys.includes(k))) fail('missing-source');
    for (const hash of [c.basisHash, c.resultHash])
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('invalid-hash');
    assertResult(c.result);
    if (c.result.total === null || c.result.diagnostics.length) fail('incomplete-calculation');
  }
  unique(calculations as { id: string }[]);
}
export function isEstimate(value: unknown): value is EstimateDocument {
  try {
    assertEstimate(value);
    return true;
  } catch {
    return false;
  }
}
