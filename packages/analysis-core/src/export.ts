import type { StructuredData } from '@editor-platform/structured-data/model';
import type { Table } from './types';
import { assertTable } from './validate';
/** Decimal stays text in ordinary Data. This is an independent static copy. */
export function resultData(table: Table): StructuredData {
  assertTable(table);
  return {
    schemaVersion: 2,
    columns: table.fields.map((f) => ({
      id: f.id,
      name: f.label + (f.type.kind === 'decimal' ? ` [${f.type.unit}]` : ''),
      type: f.type.kind === 'decimal' ? 'text' : f.type.kind,
    })),
    rows: structuredClone(table.rows),
  };
}
export function resultCsv(table: Table) {
  assertTable(table);
  const escape = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const safe = (value: string) => (/^[=+@\-\t\r]/.test(value) ? "'" + value : value);
  const lines = [
    table.fields.map((f) => escape(safe(f.label))),
    ...table.rows.map((r) =>
      table.fields.map((f) => {
        const v = r.values[f.id];
        return v === null ? '' : escape(f.type.kind === 'decimal' ? String(v) : safe(String(v)));
      }),
    ),
  ];
  return {
    csv: lines.map((r) => r.join(',')).join('\r\n') + '\r\n',
    manifest: {
      kind: 'static-analysis-copy',
      decimal: 'exact base-10 text',
      null: 'unquoted empty cell',
      emptyString: 'quoted empty string',
      fields: table.fields,
    },
  };
}
