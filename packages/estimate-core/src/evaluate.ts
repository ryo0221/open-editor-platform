import { calculateWork } from './work';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import {
  decimal,
  add,
  multiply,
  subtract,
  compare,
  convert,
  quantize,
  formatDecimal,
  assertPersistable,
  CalculationError,
  type Decimal,
} from '@editor-platform/calculation-core';
import { assertEstimate, assertBasis } from './validate';
import {
  ENGINE,
  type EstimateDocument,
  type EstimateBasis,
  type EstimateResult,
  type Calculation,
} from './types';
const zero = () => decimal('0');
const saved = (d: Decimal) => {
  assertPersistable(d);
  return formatDecimal(d);
};
export function makeEstimateBasis(
  document: EstimateDocument,
  scenarioId: string | null = null,
): EstimateBasis {
  assertEstimate(document);
  const { currency, rounding, quantities, rates, lines, adjustments, workRules, workPlan } =
    structuredClone(document);
  if (scenarioId !== null) {
    const scenario = document.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) throw new CalculationError('missing-scenario');
    for (const o of scenario.quantities)
      quantities.find((q) => q.id === o.id)!.override = { value: o.value, reason: o.reason };
    for (const o of scenario.rates)
      rates.find((r) => r.id === o.id)!.override = { value: o.value, reason: o.reason };
    for (const rule of scenario.workRules)
      Object.assign(workRules.find((r) => r.id === rule.id)!, rule);
    for (const o of scenario.waste) lines.find((l) => l.id === o.id)!.wasteRatio = o.value;
  }
  return {
    engine: ENGINE,
    scenarioId,
    currency,
    rounding,
    quantities,
    rates,
    lines,
    adjustments,
    workRules,
    ...(workPlan ? { workPlan } : {}),
    sources: [
      ...new Set(
        [...rates, ...quantities].flatMap((r) => (r.source ? [r.source.snapshotKey] : [])),
      ),
    ].sort(),
  };
}
/** Blocked drafts have a labelled subtotal, never a complete total or an adoptable calculation. */
export function evaluateEstimate(basis: EstimateBasis): EstimateResult {
  assertBasis(basis);
  if (basis.engine !== ENGINE) throw new CalculationError('unsupported-engine');
  const result: EstimateResult = {
    lines: [],
    adjustments: [],
    subtotal: '0',
    total: null,
    diagnostics: [],
  };
  const diagnostic = (
    code: string,
    id: string,
    message: string,
    target: EstimateResult['diagnostics'][number]['target'] = 'line',
  ) => result.diagnostics.push({ code, id, message, target });
  const quantityMap = new Map(basis.quantities.map((q) => [q.id, q]));
  const allocations = new Map<string, { quantityId: string; amount: Decimal }>();
  for (const line of basis.lines)
    if (line.inclusion === 'include')
      for (const b of line.bindings) {
        const key = canonicalJson([line.category, b.quantityId]);
        const current = allocations.get(key)?.amount ?? zero();
        allocations.set(key, {
          quantityId: b.quantityId,
          amount: add(current, decimal(b.allocationRatio)),
        });
      }
  const coverage = new Map<string, Decimal>();
  for (const line of basis.lines)
    if (line.inclusion === 'include') {
      for (const binding of line.bindings) {
        const q = quantityMap.get(binding.quantityId)!;
        if (q.inclusion !== 'include' || !q.source) continue;
        for (const cell of q.source.coverage) {
          const key = canonicalJson([line.category, cell]);
          const total = add(coverage.get(key) ?? zero(), decimal(binding.allocationRatio));
          coverage.set(key, total);
          if (compare(total, decimal('1')) > 0)
            diagnostic(
              'duplicate-coverage',
              q.id,
              '同じ区分で親子または同一配置を重複計上しています。',
              'quantity',
            );
        }
      }
    }
  for (const [key, allocation] of allocations) {
    const n = compare(allocation.amount, decimal('1'));
    if (n > 0)
      diagnostic(
        'over-allocation',
        allocation.quantityId,
        `同じ費目区分で配賦が1を超えています: ${key}`,
        'quantity',
      );
    else if (n < 0)
      diagnostic(
        'under-allocation',
        allocation.quantityId,
        `同じ費目区分に未配賦があります: ${key}`,
        'quantity',
      );
  }
  const allocatedIds = new Set([...allocations.values()].map((a) => a.quantityId));
  const rateMap = new Map(basis.rates.map((r) => [r.id, r]));
  for (const q of basis.quantities) {
    if (q.inclusion === 'pending')
      diagnostic('pending-quantity', q.id, '数量の採用・除外を決めてください。', 'quantity');
    if (q.inclusion === 'include' && !allocatedIds.has(q.id))
      diagnostic(
        'unallocated-quantity',
        q.id,
        '数量を費目へ配賦するか、理由付きで除外してください。',
        'quantity',
      );
  }
  for (const line of [...basis.lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (line.inclusion === 'exclude') continue;
    if (line.inclusion === 'pending') {
      diagnostic('pending-line', line.id, '費目の採用・除外を決めてください。');
      continue;
    }
    const rate = rateMap.get(line.rateId ?? '');
    if (!rate || (rate.override?.value ?? rate.unitPrice) === null) {
      diagnostic('missing-price', line.id, '単価が未入力です。0円とは区別します。');
      continue;
    }
    if (rate.currency !== basis.currency.code) {
      diagnostic('currency-mismatch', line.id, '異なる通貨は合算できません。');
      continue;
    }
    if (!line.bindings.length) {
      diagnostic('missing-quantity', line.id, '数量を対応付けてください。');
      continue;
    }
    let quantity = zero(),
      blocked = false;
    for (const binding of line.bindings) {
      const q = quantityMap.get(binding.quantityId)!;
      const value = q.override?.value ?? q.value;
      if (q.inclusion !== 'include' || value === null) {
        diagnostic('unavailable-quantity', line.id, '未入力・未採用・除外された数量です。');
        blocked = true;
        continue;
      }
      try {
        quantity = add(
          quantity,
          multiply(convert(decimal(value), q.unit, rate.perUnit), decimal(binding.allocationRatio)),
        );
      } catch (e) {
        if (!(e instanceof CalculationError) || e.code !== 'unit-mismatch') throw e;
        diagnostic('unit-mismatch', line.id, '数量と単価の単位の次元が一致しません。');
        blocked = true;
      }
    }
    if (blocked) continue;
    let billable = multiply(quantity, add(decimal('1'), decimal(line.wasteRatio)));
    if (line.purchaseRounding)
      billable = quantize(billable, line.purchaseRounding.scale, line.purchaseRounding.rounding);
    const unitPrice = rate.override?.value ?? rate.unitPrice!;
    const raw = multiply(billable, decimal(unitPrice));
    const cost = quantize(raw, basis.currency.minorDigits, basis.rounding);
    result.lines.push({
      id: line.id,
      name: line.name,
      category: line.category,
      unit: rate.perUnit,
      currency: rate.currency,
      adoptedQuantity: saved(quantity),
      billableQuantity: saved(billable),
      unitPrice,
      unroundedCost: saved(raw),
      cost: saved(cost),
    });
  }
  let subtotal = zero();
  for (const line of result.lines) subtotal = add(subtotal, decimal(line.cost));
  result.subtotal = saved(subtotal);
  let total = subtotal;
  const resultMap = new Map(result.lines.map((l) => [l.id, l]));
  for (const a of [...basis.adjustments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    let adjustment = decimal(a.value);
    if (a.kind === 'percent') {
      let base = zero();
      let blocked = false;
      for (const id of a.basisLineIds) {
        const l = resultMap.get(id);
        if (!l) blocked = true;
        else base = add(base, decimal(l.cost));
      }
      if (blocked) {
        diagnostic(
          'incomplete-adjustment-basis',
          a.id,
          '調整額の対象費目に未計算・除外があります。',
          'adjustment',
        );
        continue;
      }
      adjustment = multiply(base, adjustment);
    }
    const rounded = quantize(adjustment, basis.currency.minorDigits, basis.rounding);
    result.adjustments.push({ id: a.id, value: saved(rounded) });
    total = add(total, rounded);
  }
  if (compare(total, zero()) < 0)
    diagnostic(
      'negative-total',
      'total',
      '調整後の合計が負になります。返金処理は非対応です。',
      'document',
    );
  if (!result.diagnostics.length && basis.workPlan) {
    try {
      result.work = calculateWork(basis.workRules, basis.workPlan, result.lines);
    } catch (error) {
      diagnostic(
        error instanceof CalculationError ? error.code : 'invalid-work-plan',
        'work-plan',
        String(error),
        'work',
      );
    }
  }
  if (!result.diagnostics.length) result.total = saved(total);
  return result;
}
export async function calculateEstimate(
  document: EstimateDocument,
  id: string,
  scenarioId: string | null = null,
): Promise<Calculation> {
  const basis = makeEstimateBasis(document, scenarioId),
    result = evaluateEstimate(basis);
  if (result.total === null)
    throw new CalculationError(
      'incomplete-estimate',
      result.diagnostics.map((d) => `${d.code}:${d.id}`).join(', '),
    );
  return {
    id,
    basis,
    basisHash: await contentHash(basis),
    result,
    resultHash: await contentHash(result),
  };
}
export function calculationDifference(before: Calculation, after: Calculation) {
  if (canonicalJson(before.basis.currency) !== canonicalJson(after.basis.currency))
    throw new CalculationError('currency-mismatch');
  const beforeMap = new Map(before.result.lines.map((l) => [l.id, l])),
    afterMap = new Map(after.result.lines.map((l) => [l.id, l]));
  return [...new Set([...before.result.lines, ...after.result.lines].map((l) => l.id))].map(
    (id) => {
      const a = beforeMap.get(id),
        b = afterMap.get(id);
      return {
        id,
        name: b?.name ?? a!.name,
        before: a ?? null,
        after: b ?? null,
        delta: saved(subtract(decimal(b?.cost ?? '0'), decimal(a?.cost ?? '0'))),
      };
    },
  );
}
/** Price/quantity deltas use rounded line costs, so the components sum to the exact difference. */
export function explainCalculationDifference(before: Calculation, after: Calculation) {
  const intermediate = structuredClone(after.basis);
  intermediate.rates = intermediate.rates.map((rate) => {
    const prior = before.basis.rates.find((r) => r.id === rate.id);
    return prior && prior.perUnit === rate.perUnit && prior.currency === rate.currency
      ? structuredClone(prior)
      : rate;
  });
  let middle: EstimateResult;
  try {
    middle = evaluateEstimate(intermediate);
  } catch (error) {
    return calculationDifference(before, after).map((change) => ({
      ...change,
      quantityDelta: null,
      rateDelta: null,
      otherDelta: null,
      diagnostic: `中間計算が成立しないため内訳は未算出: ${String(error)}`,
    }));
  }
  return calculationDifference(before, after).map((change) => {
    const a = before.basis.lines.find((l) => l.id === change.id),
      b = after.basis.lines.find((l) => l.id === change.id);
    const comparable =
      a &&
      b &&
      canonicalJson({
        bindings: a.bindings,
        rate: a.rateId,
        waste: a.wasteRatio,
        purchase: a.purchaseRounding ?? null,
        inclusion: a.inclusion,
      }) ===
        canonicalJson({
          bindings: b.bindings,
          rate: b.rateId,
          waste: b.wasteRatio,
          purchase: b.purchaseRounding ?? null,
          inclusion: b.inclusion,
        });
    const mid = middle.lines.find((l) => l.id === change.id);
    if (
      !comparable ||
      !mid ||
      !change.before ||
      !change.after ||
      change.before.unit !== change.after.unit
    )
      return { ...change, quantityDelta: '0', rateDelta: '0', otherDelta: change.delta };
    return {
      ...change,
      quantityDelta: saved(subtract(decimal(mid.cost), decimal(change.before.cost))),
      rateDelta: saved(subtract(decimal(change.after.cost), decimal(mid.cost))),
      otherDelta: '0',
    };
  });
}
