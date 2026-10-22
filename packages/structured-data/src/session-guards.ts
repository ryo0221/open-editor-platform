import { canonicalJson } from '@editor-platform/artifact-core';
import { makeRow, type Column, type DataRow, type StructuredData } from './model';
import { type columnSchemaIntent } from './schema-command';

type SchemaIntent = ReturnType<typeof columnSchemaIntent>;

const sameValue = (a: DataRow['values'], b: DataRow['values'], columnId: string) =>
  Object.hasOwn(a, columnId) === Object.hasOwn(b, columnId) &&
  canonicalJson(a[columnId]) === canonicalJson(b[columnId]);

/** New records must keep read-only defaults and must not author formula values. */
export function assertAddedRowDefaults(current: StructuredData, next: StructuredData) {
  const existingIds = new Set(current.rows.map((r) => r.id)),
    added = next.rows.filter((r) => !existingIds.has(r.id));
  if (!added.length) return;
  const previous = new Map(current.columns.map((c) => [c.id, c])),
    protectedColumns = next.columns.map((column) => {
      const original = previous.get(column.id);
      return original?.readOnly || original?.type === 'formula' ? original : column;
    }),
    defaults = makeRow({ ...next, columns: protectedColumns }, 'defaults').values;
  for (const column of protectedColumns.filter((c) => c.readOnly || c.type === 'formula'))
    for (const row of added)
      if (!sameValue(row.values, defaults, column.id))
        throw new Error(
          `${column.name}: New records must retain read-only defaults and omit formula values`,
        );
}

function assertReadOnlySchema(
  column: Column,
  updated: Column | undefined,
  schemaIntent: SchemaIntent,
) {
  if (
    column.readOnly &&
    canonicalJson(updated) !== canonicalJson(column) &&
    !(schemaIntent?.columnId === column.id && schemaIntent.kind === (updated ? 'update' : 'remove'))
  )
    throw new Error(`${column.name} is read only`);
}

function assertRelationField(column: Column, updated: Column | undefined, current: StructuredData) {
  if (
    column.type === 'relation' &&
    (!updated || updated.type !== 'relation') &&
    current.rows.some(
      (r) =>
        r.values[column.id] !== undefined &&
        r.values[column.id] !== null &&
        r.values[column.id] !== '',
    )
  )
    throw new Error('Disconnect relations before changing or deleting their field');
}

function removesColumnValue(
  column: Column,
  updated: Column | undefined,
  target: DataRow,
  schemaIntent: SchemaIntent,
) {
  return (
    schemaIntent?.columnId === column.id &&
    schemaIntent.kind === 'remove' &&
    !updated &&
    !Object.hasOwn(target.values, column.id)
  );
}

function convertsFormula(column: Column, updated: Column | undefined, schemaIntent: SchemaIntent) {
  return (
    schemaIntent?.columnId === column.id &&
    schemaIntent.kind === 'update' &&
    column.type === 'formula' &&
    !column.readOnly &&
    updated &&
    updated.type !== 'formula' &&
    !updated.readOnly
  );
}

function assertProtectedValues(
  column: Column,
  updated: Column | undefined,
  current: StructuredData,
  next: StructuredData,
  schemaIntent: SchemaIntent,
) {
  if (!(column.readOnly || column.type === 'formula')) return;
  for (const row of current.rows) {
    const target = next.rows.find((r) => r.id === row.id);
    if (
      target &&
      !sameValue(target.values, row.values, column.id) &&
      !removesColumnValue(column, updated, target, schemaIntent) &&
      !convertsFormula(column, updated, schemaIntent)
    )
      throw new Error(`${column.name} is read only`);
  }
}

/** Read-only fields, relation fields and computed values change only through schema intents. */
export function assertColumnChanges(
  current: StructuredData,
  next: StructuredData,
  schemaIntent: SchemaIntent,
) {
  for (const column of current.columns) {
    const updated = next.columns.find((c) => c.id === column.id);
    assertReadOnlySchema(column, updated, schemaIntent);
    assertRelationField(column, updated, current);
    assertProtectedValues(column, updated, current, next, schemaIntent);
  }
}

// A required relation cannot silently become empty during cascade deletion.
export function assertRequiredRelations(current: StructuredData, next: StructuredData) {
  for (const column of next.columns.filter((c) => c.type === 'relation' && c.required))
    for (const row of next.rows) {
      const original = current.rows.find((r) => r.id === row.id)?.values[column.id];
      if (original && !row.values[column.id])
        throw new Error(`${column.name}: Required relation cannot be removed`);
    }
}
