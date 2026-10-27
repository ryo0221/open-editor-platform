import type { StructuredData } from '@editor-platform/structured-data/model';
import { CalculationError } from '@editor-platform/calculation-core';
import type { Calculation } from './types';
/** Only call after verifyEstimate / verifiedCalculation. Exact decimals stay text. */
export function estimateData(calculation: Calculation): StructuredData {
  if (calculation.result.total === null) throw new CalculationError('incomplete-estimate');
  const columns = [
    ['name', '費目'],
    ['category', '区分'],
    ['quantity', '請求数量'],
    ['unit', '単位'],
    ['price', '単価'],
    ['currency', '通貨'],
    ['cost', '金額'],
    ['basis', '計算根拠hash'],
  ].map(([id, name]) => ({ id, name, type: 'text' as const }));
  const rows = calculation.result.lines.map((l) => ({
    id: JSON.stringify(['line', l.id]),
    values: {
      name: l.name,
      category: l.category,
      quantity: l.billableQuantity,
      unit: l.unit,
      price: l.unitPrice,
      currency: l.currency,
      cost: l.cost,
      basis: calculation.basisHash,
    },
  }));
  for (const a of calculation.result.adjustments)
    rows.push({
      id: JSON.stringify(['adjustment', a.id]),
      values: {
        name: calculation.basis.adjustments.find((v) => v.id === a.id)!.name,
        category: '調整',
        quantity: '',
        unit: '',
        price: '',
        currency: calculation.basis.currency.code,
        cost: a.value,
        basis: calculation.basisHash,
      },
    });
  rows.push({
    id: JSON.stringify(['total', calculation.id]),
    values: {
      name: '見積合計',
      category: '合計',
      quantity: '',
      unit: '',
      price: '',
      currency: calculation.basis.currency.code,
      cost: calculation.result.total,
      basis: calculation.basisHash,
    },
  });
  return { schemaVersion: 2, columns, rows };
}
export function estimateCsv(calculation: Calculation) {
  const data = estimateData(calculation),
    safe = (v: string) => (/^[=+@\-\t\r]/.test(v) ? "'" + v : v);
  const quote = (v: string) => '"' + v.replace(/"/g, '""') + '"';
  const csv =
    [
      data.columns.map((c) => quote(safe(c.name))),
      ...data.rows.map((r) =>
        data.columns.map((c) =>
          quote(
            ['quantity', 'price', 'cost'].includes(c.id)
              ? String(r.values[c.id])
              : safe(String(r.values[c.id])),
          ),
        ),
      ),
    ]
      .map((row) => row.join(','))
      .join('\r\n') + '\r\n';
  return {
    csv,
    manifest: {
      kind: 'static-estimate-copy',
      currency: calculation.basis.currency,
      rounding: calculation.basis.rounding,
      calculationId: calculation.id,
      basisHash: calculation.basisHash,
      decimal: 'exact base-10 text',
      inputsAndPriorCalculations: 'native JSON only',
    },
  };
}
