import { canonicalJson } from '@editor-platform/artifact-core';
import { isStructuredData, validateData } from '@editor-platform/structured-data/model';
import {
  CalculationError,
  assertJson,
  assertValue,
  decimalType,
  numberDecimal,
  inspectSavedSource,
  pinKey,
  type SourcePin,
  type ScalarValue,
} from '@editor-platform/calculation-core';
import { LIMITS, type Table, type RetainedSource } from './types';
/** Only explicitly selected primitive columns are admitted. Formula evaluation is never borrowed. */
export function projectData(native: unknown, selectedColumnIds: readonly string[]): Table {
  assertJson(native);
  if (!isStructuredData(native) || validateData(native).length)
    throw new CalculationError('invalid-source-data');
  if (native.reuse) throw new CalculationError('unsupported-source-reuse');
  if (
    new Set(selectedColumnIds).size !== selectedColumnIds.length ||
    selectedColumnIds.length > LIMITS.fields ||
    native.rows.length > LIMITS.rows ||
    native.rows.length * selectedColumnIds.length > LIMITS.cells
  )
    throw new CalculationError('source-limit');
  const columns = selectedColumnIds.map((id) => {
    const column = native.columns.find((c) => c.id === id);
    if (!column) throw new CalculationError('missing-column', id);
    if (column.type === 'formula') throw new CalculationError('unsupported-source-formula', id);
    if (column.type === 'relation' || column.type === 'select')
      throw new CalculationError('explicit-primitive-mapping-required', id);
    return column;
  });
  const fields = columns.map((c) => ({
    id: c.id,
    label: c.name,
    type: c.type === 'number' ? decimalType() : { kind: c.type as 'text' | 'boolean' | 'date' },
  }));
  const rows = native.rows.map((row) => ({
    id: row.id,
    values: Object.fromEntries(
      columns.map((column, i) => {
        if (!Object.hasOwn(row.values, column.id))
          throw new CalculationError('missing-value', `${row.id}/${column.id}`);
        const original = row.values[column.id];
        const value =
          column.type === 'number' && original !== null
            ? typeof original === 'number'
              ? numberDecimal(original)
              : (() => {
                  throw new CalculationError('type-mismatch', column.id);
                })()
            : original;
        assertValue(value, fields[i].type);
        return [column.id, value as ScalarValue];
      }),
    ),
  }));
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new CalculationError('duplicate-row-id');
  return { fields, rows, diagnostics: [] };
}
export async function retainData(
  pin: SourcePin,
  native: unknown,
  selectedColumnIds: readonly string[],
): Promise<RetainedSource> {
  if (pin.domain !== 'data') throw new CalculationError('unsupported-source-domain');
  await inspectSavedSource(pin, native, isStructuredData);
  const table = projectData(native, selectedColumnIds);
  return {
    key: pinKey(pin),
    pin: structuredClone(pin),
    nativeContent: structuredClone(native),
    dependencies: [],
    table,
  };
}
export async function verifyRetainedSource(source: RetainedSource): Promise<void> {
  if (source.key !== pinKey(source.pin) || source.dependencies.length)
    throw new CalculationError('invalid-source-closure');
  const expected = await retainData(
    source.pin,
    source.nativeContent,
    source.table.fields.map((f) => f.id),
  );
  if (canonicalJson(expected.table) !== canonicalJson(source.table))
    throw new CalculationError('source-projection-mismatch');
}
