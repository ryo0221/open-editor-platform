import { isStructuredData, validateData } from '@editor-platform/structured-data/model';
import {
  assertJson,
  decimal,
  numberDecimal,
  inspectSavedSource,
  pinKey,
  CalculationError,
  type SourcePin,
} from '@editor-platform/calculation-core';
import type { RetainedSource, Rate } from './types';
export function priceData(value: unknown) {
  assertJson(value);
  if (!isStructuredData(value) || validateData(value).length)
    throw new CalculationError('invalid-price-data');
  if (value.reuse) throw new CalculationError('unsupported-source-reuse');
  if (value.rows.length > 10000 || value.columns.length > 50)
    throw new CalculationError('source-limit');
  return value;
}
export function priceValue(native: unknown, rowId: string, fieldId: string): string | null {
  const data = priceData(native),
    column = data.columns.find((c) => c.id === fieldId),
    row = data.rows.find((r) => r.id === rowId);
  if (!column || !row || !Object.hasOwn(row.values, fieldId))
    throw new CalculationError('missing-price-cell');
  if (column.type !== 'number' && column.type !== 'text')
    throw new CalculationError(
      column.type === 'formula' ? 'unsupported-source-formula' : 'unsupported-price-column',
    );
  const value = row.values[fieldId];
  if (value === null) return null;
  const text =
    column.type === 'number' && typeof value === 'number'
      ? numberDecimal(value)
      : typeof value === 'string'
        ? value
        : null;
  if (text === null) throw new CalculationError('invalid-price');
  if (decimal(text).coefficient < 0n) throw new CalculationError('negative-price');
  return text;
}
export async function retainPriceData(pin: SourcePin, native: unknown): Promise<RetainedSource> {
  if (pin.domain !== 'data') throw new CalculationError('unsupported-price-source');
  priceData(native);
  await inspectSavedSource(pin, native, isStructuredData);
  return {
    key: pinKey(pin),
    pin: structuredClone(pin),
    nativeContent: structuredClone(native),
    dependencies: [],
  };
}
export function assertRateSources(rates: Rate[], sources: RetainedSource[]) {
  for (const rate of rates)
    if (rate.source) {
      const source = sources.find((s) => s.key === rate.source!.snapshotKey);
      if (
        !source ||
        priceValue(source.nativeContent, rate.source.rowId, rate.source.fieldId) !== rate.unitPrice
      )
        throw new CalculationError('price-source-mismatch', rate.id);
    }
}
