import { validNativeReuse, type ReuseState } from '@editor-platform/reuse-core';
import type { DataView } from './views';
import {
  describeChanges,
  isDeepFrozen,
  newId,
  type Change,
  type CompareResult,
} from '@editor-platform/artifact-core';
import { command, immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { columnSchemaCommand } from './schema-command';
export type ColumnType = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'relation' | 'formula';
export type Cell = string | number | boolean | null;
export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  required?: boolean;
  defaultValue?: Cell;
  options?: string[];
  formula?: string;
  readOnly?: boolean;
  format?: 'decimal' | 'currency' | 'percent' | 'iso-date';
  decimals?: number;
  currency?: string;
}
export interface DataRow {
  id: string;
  values: Record<string, Cell>;
}
export interface DataGraphView {
  schemaVersion: 1;
  labelColumnId: string | null;
  positions: Record<string, { x: number; y: number }>;
}
export interface StructuredData {
  /** Explicit graph display settings, never a copy of records or relations. */
  graphView?: DataGraphView;
  reuse?: ReuseState;
  schemaVersion: 1 | 2;
  views?: DataView[];
  columns: Column[];
  rows: DataRow[];
}
export interface ValidationError {
  rowId: string;
  columnId: string;
  message: string;
}
export const columnTypes: ColumnType[] = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'relation',
  'formula',
];
export function createData(): StructuredData {
  return {
    schemaVersion: 2,
    columns: [
      { id: newId('col'), name: 'Name', type: 'text', required: true, defaultValue: 'New record' },
      {
        id: newId('col'),
        name: 'Status',
        type: 'select',
        options: ['Planned', 'Active', 'Done'],
        defaultValue: 'Planned',
      },
      { id: newId('col'), name: 'Quantity', type: 'number', defaultValue: 1 },
      { id: newId('col'), name: 'Price', type: 'number', defaultValue: 10 },
      { id: newId('col'), name: 'Total', type: 'formula', formula: 'Quantity * Price' },
    ],
    rows: [],
  };
}
export function makeRow(data: StructuredData, id = newId('row')): DataRow {
  return {
    id,
    values: Object.fromEntries(
      data.columns
        .filter((c) => c.type !== 'formula')
        .map((c) => [c.id, c.defaultValue ?? (c.type === 'boolean' ? false : null)]),
    ),
  };
}
export const addRow = (): EditorCommand<StructuredData> => {
  const id = newId('row');
  return command('data.insert-row', 'Add record', (d) => ({
    ...d,
    rows: [...d.rows, makeRow(d, id)],
  }));
};
export const removeRow = (id: string): EditorCommand<StructuredData> =>
  command('data.delete-row', 'Delete record', (d) => ({
    ...d,
    rows: d.rows.filter((r) => r.id !== id),
    ...(d.graphView
      ? {
          graphView: {
            ...d.graphView,
            positions: Object.fromEntries(
              Object.entries(d.graphView.positions).filter(([key]) => key !== id),
            ),
          },
        }
      : {}),
  }));
export const setCell = (
  rowId: string,
  columnId: string,
  value: Cell,
): EditorCommand<StructuredData> =>
  immutableCommand('data.update-cell', 'Edit cell', (d) => ({
    ...d,
    rows: d.rows.map((r) =>
      r.id === rowId ? { ...r, values: { ...r.values, [columnId]: value } } : r,
    ),
  }));
export const addColumn = (column: Column): EditorCommand<StructuredData> =>
  command('data.insert-column', 'Add column', (d) => {
    if (
      !column.name.trim() ||
      d.columns.some((c) => c.name.toLowerCase() === column.name.toLowerCase())
    )
      throw new Error('Column names must be unique and nonempty');
    return {
      ...d,
      columns: [...d.columns, column],
      ...(d.graphView && !d.columns.length
        ? { graphView: { ...d.graphView, labelColumnId: column.id } }
        : {}),
      rows: d.rows.map((r) => ({
        ...r,
        values: { ...r.values, [column.id]: column.defaultValue ?? null },
      })),
    };
  });
export const removeColumn = (id: string): EditorCommand<StructuredData> =>
  columnSchemaCommand(
    id,
    'remove',
    command('data.delete-column', 'Delete column', (d) => {
      const column = d.columns.find((c) => c.id === id);
      if (!column) throw new Error('Field is missing');
      const dependent = d.columns.filter(
        (c) =>
          c.id !== id &&
          c.type === 'formula' &&
          (c.formula?.match(/\[[^\]]+\]|[A-Za-z_][A-Za-z_0-9]*/g) ?? []).some((token) => {
            const ref = token.startsWith('[') ? token.slice(1, -1) : token;
            return ref === id || ref === column.name;
          }),
      );
      if (dependent.length)
        throw new Error(
          `Update dependent formulas before deleting this field: ${dependent.map((c) => c.name).join(', ')}`,
        );
      const columns = d.columns.filter((c) => c.id !== id);
      return {
        ...d,
        columns,
        ...(d.graphView
          ? {
              graphView: columns.length
                ? {
                    ...d.graphView,
                    labelColumnId:
                      d.graphView.labelColumnId === id ? columns[0].id : d.graphView.labelColumnId,
                  }
                : { ...d.graphView, labelColumnId: null },
            }
          : {}),
        ...(d.views
          ? {
              views: d.views.map((view) =>
                pruneViewFields(
                  view,
                  columns.map((c) => c.id),
                ),
              ),
            }
          : {}),
        rows: d.rows.map((r) => ({
          ...r,
          values: Object.fromEntries(Object.entries(r.values).filter(([k]) => k !== id)),
        })),
      };
    }),
  );
export function pruneViewFields(view: DataView, ids: string[]): DataView {
  const keep = new Set(ids),
    ref = (id: string) => (keep.has(id) ? id : '');
  const chart = (c: DataView['chart']) => ({
    ...c,
    x: ref(c.x),
    y: ref(c.y),
    series: c.series ? ref(c.series) : undefined,
  });
  return {
    ...view,
    sorts: view.sorts.filter((s) => keep.has(s.columnId)),
    filters: view.filters.filter((f) => keep.has(f.columnId)),
    groupBy: ref(view.groupBy),
    hidden: view.hidden.filter((id) => keep.has(id)),
    cardFields: view.cardFields.filter((id) => keep.has(id)),
    widths: Object.fromEntries(Object.entries(view.widths).filter(([id]) => keep.has(id))),
    chart: chart(view.chart),
    timeline: {
      ...view.timeline,
      start: ref(view.timeline.start),
      end: ref(view.timeline.end),
      group: ref(view.timeline.group),
    },
    summary: { ...view.summary, columnId: ref(view.summary.columnId) },
    widgets: view.widgets.map((w) => ({
      ...w,
      ...(w.columnId ? { columnId: ref(w.columnId) } : {}),
      ...(w.chart ? { chart: chart(w.chart) } : {}),
    })),
  };
}
export function parseCell(text: string, column: Column): Cell {
  if (!text.trim()) return null;
  if (column.type === 'number') return Number.isFinite(Number(text)) ? Number(text) : text;
  if (column.type === 'boolean')
    return text.toLowerCase() === 'true' ? true : text.toLowerCase() === 'false' ? false : text;
  return text;
}
function expression(source: string, resolve: (name: string) => number): number {
  const tokens: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?|\.[0-9]+|\[[^\]]+\]|[A-Za-z_][A-Za-z_0-9]*|[()+*/-])\s*/gy;
  let offset = 0;
  while (offset < source.length) {
    re.lastIndex = offset;
    const m = re.exec(source);
    if (!m)
      throw new Error(
        `Formula error at character ${offset + 1}: expected a number, field or + − * / ( )`,
      );
    tokens.push(m[1]);
    offset = re.lastIndex;
  }
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++];
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (t === '(') {
      const v = sum();
      if (tokens[i++] !== ')') throw new Error('Missing closing parenthesis');
      return v;
    }
    if (!t) throw new Error('Incomplete formula');
    if (/^(\d|\.)/.test(t)) return Number(t);
    if (/^(?:[A-Za-z_]|\[)/.test(t)) return resolve(t.replace(/^\[|\]$/g, ''));
    throw new Error('Invalid formula');
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++],
        rhs = atom();
      if (op === '/' && rhs === 0) throw new Error('Division by zero');
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++],
        rhs = product();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  };
  const value = sum();
  if (i !== tokens.length || !Number.isFinite(value)) throw new Error('Invalid numeric result');
  return value;
}
type Evaluated = { value: Cell } | { error: Error };
// Formula results depend only on the row and the column definitions. Each
// evaluation memoizes per column, and immutable inputs share results across
// calls, so references are evaluated once instead of once per path.
const evaluatedByColumns = new WeakMap<Column[], WeakMap<DataRow, Map<string, Evaluated>>>();
const columnLookups = new WeakMap<Column[], Map<string, Column>>();
function columnLookup(columns: Column[]): Map<string, Column> {
  let lookup = columnLookups.get(columns);
  if (lookup) return lookup;
  lookup = new Map();
  // Same precedence as columns.find((c) => c.name === name || c.id === name).
  for (const c of columns) {
    if (!lookup.has(c.name)) lookup.set(c.name, c);
    if (!lookup.has(c.id)) lookup.set(c.id, c);
  }
  if (isDeepFrozen(columns)) columnLookups.set(columns, lookup);
  return lookup;
}
function evaluatedCells(data: StructuredData, row: DataRow): Map<string, Evaluated> {
  if (!isDeepFrozen(data.columns) || !isDeepFrozen(row)) return new Map();
  let rows = evaluatedByColumns.get(data.columns);
  if (!rows) evaluatedByColumns.set(data.columns, (rows = new WeakMap()));
  let cells = rows.get(row);
  if (!cells) rows.set(row, (cells = new Map()));
  return cells;
}
function evaluate(
  data: StructuredData,
  row: DataRow,
  column: Column,
  lookup: Map<string, Column>,
  memo: Map<string, Evaluated>,
  visiting: Set<string>,
): Cell {
  if (column.type !== 'formula') return row.values[column.id] ?? null;
  const known = memo.get(column.id);
  if (known) {
    if ('error' in known) throw known.error;
    return known.value;
  }
  if (visiting.has(column.id)) throw new Error('Circular formula');
  visiting.add(column.id);
  let result: Evaluated;
  try {
    result = {
      value: expression(column.formula ?? '', (name) => {
        const ref = lookup.get(name);
        if (!ref) throw new Error(`Unknown column: ${name}`);
        const value = evaluate(data, row, ref, lookup, memo, visiting);
        if (value === null) return 0;
        if (typeof value !== 'number') throw new Error(`${name} is not numeric`);
        return value;
      }),
    };
  } catch (e) {
    result = { error: e as Error };
  } finally {
    visiting.delete(column.id);
  }
  memo.set(column.id, result);
  if ('error' in result) throw result.error;
  return result.value;
}
export function cellValue(data: StructuredData, row: DataRow, column: Column): Cell {
  if (column.type !== 'formula') return row.values[column.id] ?? null;
  return evaluate(
    data,
    row,
    column,
    columnLookup(data.columns),
    evaluatedCells(data, row),
    new Set(),
  );
}
export function displayCell(data: StructuredData, row: DataRow, column: Column): string {
  try {
    return String(cellValue(data, row, column) ?? '');
  } catch {
    return '#ERROR';
  }
}
// Row values/formulas depend on their row and column definitions. Relations also
// depend on the complete row set, so they always take the full validation path.
const validRowsByColumns = new WeakMap<Column[], WeakSet<DataRow>>();
const invalidDate = (value: Cell) =>
  !/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
  Number.isNaN(Date.parse(String(value))) ||
  new Date(String(value)).toISOString().slice(0, 10) !== value;
function valueMessage(data: StructuredData, c: Column, value: Cell) {
  let message = '';
  if (c.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
    message = 'Enter a number';
  if (c.type === 'boolean' && typeof value !== 'boolean') message = 'Enter true or false';
  if (c.type === 'date' && invalidDate(value)) message = 'Enter a valid date (YYYY-MM-DD)';
  if (c.type === 'select' && !c.options?.includes(String(value)))
    message = 'Choose a listed option';
  if (c.type === 'relation' && !data.rows.some((r) => r.id === value))
    message = 'Choose an existing record';
  if (c.type === 'text' && typeof value !== 'string') message = 'Enter text';
  return message;
}
function cellMessage(data: StructuredData, c: Column, value: Cell) {
  const empty = value === null || value === '';
  if (empty && c.required) return 'Required field';
  return empty ? '' : valueMessage(data, c, value);
}
export function validateData(data: StructuredData, rows: DataRow[] = data.rows): ValidationError[] {
  const errors: ValidationError[] = [];
  let validRows: WeakSet<DataRow> | undefined;
  if (isDeepFrozen(data.columns) && !data.columns.some((c) => c.type === 'relation')) {
    validRows = validRowsByColumns.get(data.columns);
    if (!validRows) validRowsByColumns.set(data.columns, (validRows = new WeakSet()));
  }
  for (const row of rows) {
    if (validRows?.has(row)) continue;
    const before = errors.length;
    for (const c of data.columns) {
      let value: Cell;
      try {
        value = cellValue(data, row, c);
      } catch (e) {
        errors.push({ rowId: row.id, columnId: c.id, message: (e as Error).message });
        continue;
      }
      const message = cellMessage(data, c, value);
      if (message) errors.push({ rowId: row.id, columnId: c.id, message });
    }
    if (validRows && errors.length === before && isDeepFrozen(row)) validRows.add(row);
  }
  return errors;
}
export function projectRows(
  data: StructuredData,
  query: { filter?: string; sort?: string; descending?: boolean } = {},
): DataRow[] {
  const rows = data.rows.filter(
    (r) =>
      !query.filter ||
      data.columns.some((c) =>
        displayCell(data, r, c).toLowerCase().includes(query.filter!.toLowerCase()),
      ),
  );
  const column = data.columns.find((c) => c.id === query.sort);
  if (column)
    rows.sort((a, b) => {
      const aa = displayCell(data, a, column),
        bb = displayCell(data, b, column);
      const cmp = ['number', 'formula'].includes(column.type)
        ? Number(aa) - Number(bb)
        : aa.localeCompare(bb);
      return cmp * (query.descending ? -1 : 1);
    });
  return rows;
}
export function groupRows(
  data: StructuredData,
  rows: DataRow[],
  columnId: string,
): Map<string, DataRow[]> {
  const result = new Map<string, DataRow[]>(),
    c = data.columns.find((c) => c.id === columnId);
  for (const row of rows) {
    const key = c ? displayCell(data, row, c) || '(empty)' : 'All records';
    result.set(key, [...(result.get(key) ?? []), row]);
  }
  return result;
}
export function aggregate(
  data: StructuredData,
  rows: DataRow[],
  columnId: string,
): { count: number; sum: number; average: number } {
  const c = data.columns.find((c) => c.id === columnId);
  const values = c
    ? rows
        .map((r) => {
          try {
            return cellValue(data, r, c);
          } catch {
            return null;
          }
        })
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: rows.length, sum, average: values.length ? sum / values.length : 0 };
}
/**
 * True for text a spreadsheet would read as a formula (leading =, +, -, @, tab or
 * CR, after any BOM, which readers take as the encoding mark), or for text that
 * already starts with apostrophes before such a prefix. Plain numbers such as -5
 * are not guarded.
 */
function needsCsvGuard(value: string): boolean {
  return (
    /^'*\uFEFF*[=+\-@\t\r]/.test(value) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)
  );
}
/**
 * Encode one exported CSV field. Guarded text is prefixed with one apostrophe so
 * spreadsheets keep it as text. Decoding requires explicit import opt-in.
 */
export function csvField(value: string): string {
  const safe = needsCsvGuard(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
/** Decode one parsed CSV field written by csvField, so exports round-trip. */
export function csvText(field: string): string {
  return field.startsWith("'") && needsCsvGuard(field.slice(1)) ? field.slice(1) : field;
}
export interface CsvImportOptions {
  /** Only opt in for unchanged CSV produced by this editor's guarded exporter. */
  decodeFormulaGuard?: boolean;
}
/** Generic CSV preserves literal apostrophes. A BOM is only an encoding mark. */
export function parseCsvText(source: string, options: CsvImportOptions = {}): string[][] {
  const rows = parseCsv(source.replace(/^\uFEFF/, ''));
  return options.decodeFormulaGuard ? rows.map((row) => row.map(csvText)) : rows;
}
export function exportCsv(data: StructuredData): string {
  return (
    [
      data.columns.map((c) => c.name),
      ...data.rows.map((r) => data.columns.map((c) => displayCell(data, r, c))),
    ]
      .map((r) => r.map(csvField).join(','))
      .join('\r\n') + '\r\n'
  );
}
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
export function importCsv(source: string, options: CsvImportOptions = {}): StructuredData {
  const [header, ...rows] = parseCsvText(source, options);
  if (!header?.length) throw new Error('CSV requires a header');
  const names = new Set<string>();
  const columns: Column[] = header.map((raw, index) => {
    let name = raw.trim() || `Column ${index + 1}`;
    while (names.has(name)) name += ' (copy)';
    names.add(name);
    const values = rows.map((r) => r[index]).filter((v) => v !== undefined && v !== '');
    const type: ColumnType =
      values.length && values.every((v) => /^(true|false)$/i.test(v))
        ? 'boolean'
        : values.length &&
            values.every((v) => Number.isFinite(Number(v)) && !/^[+-]?0\d/.test(v.trim()))
          ? 'number'
          : 'text';
    return { id: newId('col'), name, type };
  });
  return {
    schemaVersion: 1,
    columns,
    rows: rows.map((r) => ({
      id: newId('row'),
      values: Object.fromEntries(columns.map((c, i) => [c.id, parseCell(r[i] ?? '', c)])),
    })),
  };
}
function rowDiff(a: StructuredData, b: StructuredData, changes: Change[]) {
  const describeRow = (data: StructuredData, row: DataRow) =>
    data.columns.map((c) => `${c.name}: ${displayCell(data, row, c)}`).join('\n');
  for (const old of a.rows) {
    const next = b.rows.find((r) => r.id === old.id);
    if (!next)
      changes.push({
        elementId: old.id,
        path: 'row',
        kind: 'removed',
        before: describeRow(a, old),
      });
    else
      for (const c of b.columns) {
        const before = old.values[c.id],
          after = next.values[c.id];
        if (before !== after)
          changes.push({
            elementId: old.id,
            path: `${String(next.values[b.columns[0]?.id] ?? 'Record')} / ${c.name}`,
            kind: 'changed',
            before: String(before ?? ''),
            after: String(after ?? ''),
          });
      }
  }
  for (const row of b.rows)
    if (!a.rows.some((r) => r.id === row.id))
      changes.push({
        elementId: row.id,
        path: 'row',
        kind: 'added',
        after: describeRow(b, row),
      });
}
function describeView(data: StructuredData, view: NonNullable<StructuredData['views']>[number]) {
  const field = (id: string) => data.columns.find((c) => c.id === id)?.name ?? (id || 'none');
  return `${view.name} / ${view.projection}\nSearch: ${view.search}\nGroup: ${field(view.groupBy)}\nSort: ${view.sorts.map((s) => `${field(s.columnId)} ${s.descending ? 'descending' : 'ascending'}`).join(', ')}\nFilters (${view.filterMode}): ${view.filters.map((f) => `${field(f.columnId)} ${f.operator} ${f.value}`).join('; ')}\nChart: ${view.chart.type}, ${field(view.chart.x)} / ${field(view.chart.y)}, ${view.chart.aggregate}\nTimeline: ${field(view.timeline.start)} – ${field(view.timeline.end)}\nSummary: ${view.summary.aggregate} ${field(view.summary.columnId)}\nWidgets: ${view.widgets.map((w) => `${w.type}: ${w.title}`).join(', ')}`;
}
function graphViewDiff(a: StructuredData, b: StructuredData, changes: Change[]) {
  const oldGraph = a.graphView,
    nextGraph = b.graphView;
  if (!!oldGraph !== !!nextGraph)
    changes.push({
      elementId: 'data-graph-view',
      path: 'Graph view settings',
      kind: nextGraph ? 'added' : 'removed',
      ...(oldGraph ? { before: 'Explicit graph layout' } : { after: 'Explicit graph layout' }),
    });
  const fieldName = (data: StructuredData, id: string | null | undefined) =>
    id == null ? 'No label field' : (data.columns.find((c) => c.id === id)?.name ?? id);
  if ((oldGraph?.labelColumnId ?? null) !== (nextGraph?.labelColumnId ?? null))
    changes.push({
      elementId: 'data-graph-view',
      path: 'Graph label field',
      kind: 'changed',
      before: fieldName(a, oldGraph?.labelColumnId),
      after: fieldName(b, nextGraph?.labelColumnId),
    });
  graphPositionDiff(oldGraph, nextGraph, changes);
}
function graphPositionDiff(
  oldGraph: StructuredData['graphView'],
  nextGraph: StructuredData['graphView'],
  changes: Change[],
) {
  const beforePositions = oldGraph?.positions ?? {},
    afterPositions = nextGraph?.positions ?? {};
  for (const id of new Set([...Object.keys(beforePositions), ...Object.keys(afterPositions)])) {
    const before = Object.hasOwn(beforePositions, id) ? beforePositions[id] : undefined,
      after = Object.hasOwn(afterPositions, id) ? afterPositions[id] : undefined;
    if (before?.x === after?.x && before?.y === after?.y) continue;
    changes.push({
      elementId: id,
      path: 'Graph position',
      kind: before ? (after ? 'changed' : 'removed') : 'added',
      ...(before ? { before: `x: ${before.x}, y: ${before.y}` } : {}),
      ...(after ? { after: `x: ${after.x}, y: ${after.y}` } : {}),
    });
  }
}
export function dataDiff(a: StructuredData, b: StructuredData): CompareResult {
  const changes: Change[] = describeChanges(
    a.columns,
    b.columns,
    (c) => `Field: ${c.name}`,
    (c) =>
      `${c.name} (${c.type})\n${c.required ? 'Required' : 'Optional'}\n${c.formula ? `Formula: ${c.formula}` : ''}${c.options ? `Options: ${c.options.join(', ')}` : ''}`,
  );
  rowDiff(a, b, changes);
  changes.push(
    ...describeChanges(
      a.views ?? [],
      b.views ?? [],
      (view) => `Named view: ${view.name}`,
      (view, side) => describeView(side === 'before' ? a : b, view),
    ),
  );
  graphViewDiff(a, b, changes);
  return { changes };
}
const validRowStructures = new WeakSet<object>();
function validRowStructure(row: DataRow): boolean {
  if (row && validRowStructures.has(row)) return true;
  const valid = !!(
    row &&
    typeof row.id === 'string' &&
    row.values &&
    typeof row.values === 'object' &&
    Object.values(row.values).every(
      (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
    )
  );
  if (valid && isDeepFrozen(row)) validRowStructures.add(row);
  return valid;
}
const validDataStructures = new WeakSet<object>();
const validColumnStructures = new WeakSet<object>();
const validRowCollections = new WeakSet<object>();
function validColumns(columns: Column[]): boolean {
  if (validColumnStructures.has(columns)) return true;
  const valid =
    new Set(columns.map((c) => c?.id)).size === columns.length &&
    new Set(columns.map((c) => c?.name)).size === columns.length &&
    columns.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.name === 'string' &&
        (c.readOnly === undefined || typeof c.readOnly === 'boolean') &&
        (c.decimals === undefined ||
          (Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 8)) &&
        (c.format === undefined ||
          ['', 'decimal', 'currency', 'percent', 'iso-date'].includes(c.format)) &&
        (c.currency === undefined || ['USD', 'EUR', 'GBP', 'JPY'].includes(c.currency)) &&
        columnTypes.includes(c.type) &&
        (c.formula === undefined || typeof c.formula === 'string') &&
        (c.options === undefined ||
          (Array.isArray(c.options) && c.options.every((o) => typeof o === 'string'))),
    );
  if (valid && isDeepFrozen(columns)) validColumnStructures.add(columns);
  return valid;
}
function validRows(rows: DataRow[]): boolean {
  if (validRowCollections.has(rows)) return true;
  const ids = new Set<string>();
  for (const row of rows) {
    if (!validRowStructure(row) || ids.has(row.id)) return false;
    ids.add(row.id);
  }
  if (isDeepFrozen(rows)) validRowCollections.add(rows);
  return true;
}
export function isStructuredData(value: unknown): value is StructuredData {
  if (!value || typeof value !== 'object') return false;
  if (validDataStructures.has(value)) return true;
  const d = value as StructuredData;
  const valid =
    (d.schemaVersion === 1 || d.schemaVersion === 2) &&
    Array.isArray(d.columns) &&
    Array.isArray(d.rows) &&
    validNativeReuse(d.reuse, 'data') &&
    (d.views === undefined || (Array.isArray(d.views) && d.views.every(validView))) &&
    validColumns(d.columns) &&
    validRows(d.rows) &&
    (d.graphView === undefined || validDataGraphView(d.graphView, d));
  // Only structurally certified immutable data can reuse a result. Mutable import
  // input and shallow freezes are checked on every call; new rows/columns/views
  // get their own validation even when other branches are shared.
  if (valid && isDeepFrozen(d)) validDataStructures.add(d);
  return valid;
}

function validView(v: DataView): boolean {
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((s) => typeof s === 'string');
  const chart = (c: DataView['chart']) =>
    !!c &&
    ['bar', 'line', 'pie'].includes(c.type) &&
    typeof c.x === 'string' &&
    typeof c.y === 'string' &&
    (c.series === undefined || typeof c.series === 'string') &&
    ['sum', 'count', 'average', 'min', 'max'].includes(c.aggregate) &&
    ['label', 'ascending', 'descending'].includes(c.sort) &&
    typeof c.legend === 'boolean' &&
    typeof c.labels === 'boolean' &&
    ['number', 'percent', 'currency'].includes(c.format);
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.accent === undefined || /^#[a-f0-9]{6}$/i.test(v.accent)) &&
    [
      'Grid',
      'Form',
      'Chart',
      'Kanban',
      'Dashboard',
      'Timeline',
      'Roadmap',
      'Summary',
      'Graph',
    ].includes(v.projection) &&
    typeof v.search === 'string' &&
    ['and', 'or'].includes(v.filterMode) &&
    typeof v.groupBy === 'string' &&
    strings(v.hidden) &&
    strings(v.cardFields) &&
    !!v.widths &&
    Object.values(v.widths).every((n) => Number.isFinite(n) && n >= 80 && n <= 600) &&
    Number.isInteger(v.frozen) &&
    v.frozen >= 0 &&
    Array.isArray(v.sorts) &&
    v.sorts.every(
      (s) => s && typeof s.columnId === 'string' && typeof s.descending === 'boolean',
    ) &&
    Array.isArray(v.filters) &&
    v.filters.every(
      (f) =>
        f &&
        typeof f.id === 'string' &&
        typeof f.columnId === 'string' &&
        typeof f.value === 'string' &&
        ['contains', 'equals', 'not-equals', 'greater', 'less', 'empty', 'not-empty'].includes(
          f.operator,
        ),
    ) &&
    chart(v.chart) &&
    !!v.timeline &&
    ['start', 'end', 'group', 'from', 'to'].every(
      (k) => typeof v.timeline[k as keyof DataView['timeline']] === 'string',
    ) &&
    ['day', 'week', 'month'].includes(v.timeline.scale) &&
    !!v.summary &&
    typeof v.summary.columnId === 'string' &&
    ['sum', 'count', 'average', 'min', 'max'].includes(v.summary.aggregate) &&
    Array.isArray(v.widgets) &&
    v.widgets.every(
      (w) =>
        w &&
        typeof w.id === 'string' &&
        typeof w.title === 'string' &&
        ['metric', 'chart', 'table'].includes(w.type) &&
        (w.chart === undefined || chart(w.chart)),
    )
  );
}

function validDataGraphView(view: DataGraphView, data: StructuredData): boolean {
  return (
    !!view &&
    Object.keys(view).every((key) =>
      ['schemaVersion', 'labelColumnId', 'positions'].includes(key),
    ) &&
    view.schemaVersion === 1 &&
    (view.labelColumnId === null ||
      (typeof view.labelColumnId === 'string' &&
        data.columns.some((c) => c.id === view.labelColumnId))) &&
    !!view.positions &&
    typeof view.positions === 'object' &&
    !Array.isArray(view.positions) &&
    Object.entries(view.positions).every(
      ([id, p]) =>
        data.rows.some((r) => r.id === id) &&
        !!p &&
        typeof p === 'object' &&
        !Array.isArray(p) &&
        Object.keys(p).length === 2 &&
        ['x', 'y'].every(
          (k) =>
            typeof p[k as 'x' | 'y'] === 'number' &&
            Number.isFinite(p[k as 'x' | 'y']) &&
            Math.abs(p[k as 'x' | 'y']) <= 100_000,
        ),
    )
  );
}
