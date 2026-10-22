import {
  csvField,
  displayCell,
  makeRow,
  parseCell,
  parseCsvText,
  validateData,
  type CsvImportOptions,
  type DataRow,
  type StructuredData,
} from './model';
import { viewRows, type DataView } from './views';
export interface CsvExportScope {
  rowsScope: 'all' | 'filtered';
  columnsScope: 'all' | 'visible';
}
/** Values/formulas are evaluated against the full dataset before narrowing output columns. */
export function prepareCsvExport(data: StructuredData, scope: CsvExportScope, view?: DataView) {
  if ((scope.rowsScope === 'filtered' || scope.columnsScope === 'visible') && !view)
    throw new Error('Filtered rows and visible columns require the current view');
  const rows = scope.rowsScope === 'filtered' ? viewRows(data, view!) : data.rows;
  const columns = data.columns.filter(
    (column) => scope.columnsScope === 'all' || !view!.hidden.includes(column.id),
  );
  const csv =
    [
      columns.map((column) => column.name),
      ...rows.map((row) => columns.map((column) => displayCell(data, row, column))),
    ]
      .map((row) => row.map(csvField).join(','))
      .join('\r\n') + '\r\n';
  return {
    csv,
    rowCount: rows.length,
    columnCount: columns.length,
    rowIds: rows.map((row) => row.id),
    columnIds: columns.map((column) => column.id),
  };
}
export interface CsvImportDiagnostic {
  row: number;
  column: number;
  name: string;
  columnId?: string;
  raw: string;
  message: string;
}
/** Preview and apply share this exact target schema and raw-value conversion. */
export function previewCsvAppend(
  data: StructuredData,
  source: string,
  header = true,
  targets: Record<number, string> = {},
  rowIds: string[] = [],
  options: CsvImportOptions = {},
) {
  const parsed = parseCsvText(source, options);
  const names = header
    ? (parsed[0] ?? [])
    : (parsed[0] ?? []).map((_, index) => `Column ${index + 1}`);
  const rawRows = parsed.slice(header ? 1 : 0);
  const columns = names.map((name, index) =>
    data.columns.find(
      (column) =>
        column.id === targets[index] || (!Object.hasOwn(targets, index) && column.name === name),
    ),
  );
  const diagnostics: CsvImportDiagnostic[] = [];
  columns.forEach((column, index) => {
    if (!column)
      diagnostics.push({
        row: 0,
        column: index + 1,
        name: names[index],
        raw: '',
        message: 'Choose an existing target field',
      });
    else if (column.type === 'formula')
      diagnostics.push({
        row: 0,
        column: index + 1,
        name: column.name,
        columnId: column.id,
        raw: '',
        message: 'Formula fields are computed; choose an editable target field',
      });
    else if (column.readOnly)
      diagnostics.push({
        row: 0,
        column: index + 1,
        name: column.name,
        columnId: column.id,
        raw: '',
        message: 'Read-only fields cannot be imported; choose an editable target field',
      });
  });
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    if (column && seen.has(column.id))
      diagnostics.push({
        row: 0,
        column: index + 1,
        name: column.name,
        columnId: column.id,
        raw: '',
        message: 'A target field may only be mapped once',
      });
    if (column) seen.add(column.id);
  });
  const rows: DataRow[] = rawRows.map((raw, index) => {
    raw.slice(names.length).forEach((value, extra) => {
      diagnostics.push({
        row: index + (header ? 2 : 1),
        column: names.length + extra + 1,
        name: `Column ${names.length + extra + 1}`,
        raw: value,
        message: 'Row has more values than the declared source columns',
      });
    });
    const row = makeRow(data, rowIds[index]);
    columns.forEach((column, i) => {
      if (column && column.type !== 'formula' && !column.readOnly)
        row.values[column.id] = parseCell(raw[i] ?? '', column);
    });
    return row;
  });
  const candidate = { ...data, rows: [...data.rows, ...rows] };
  for (const error of validateData(candidate, rows)) {
    const row = rows.findIndex((row) => row.id === error.rowId);
    const column = data.columns.find((column) => column.id === error.columnId)!;
    const i = columns.findIndex((column) => column?.id === error.columnId);
    diagnostics.push({
      row: row + (header ? 2 : 1),
      column: i < 0 ? data.columns.indexOf(column) + 1 : i + 1,
      name: column.name,
      columnId: column.id,
      raw: i < 0 ? (column.formula ?? '') : (rawRows[row]?.[i] ?? ''),
      message: error.message,
    });
  }
  return { rows, columns, names, diagnostics };
}
