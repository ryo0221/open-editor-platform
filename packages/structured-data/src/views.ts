import { newId, clone, canonicalJson } from '@editor-platform/artifact-core';
import { dayString } from '@editor-platform/time-axis';
import { command, immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { columnSchemaCommand } from './schema-command';
import {
  cellValue,
  displayCell,
  parseCell,
  validateData,
  makeRow,
  type StructuredData,
  type DataRow,
  type Column,
  type Cell,
} from './model';
export type DataProjection =
  | 'Grid'
  | 'Form'
  | 'Kanban'
  | 'Chart'
  | 'Dashboard'
  | 'Timeline'
  | 'Roadmap'
  | 'Calendar'
  | 'Summary'
  | 'Graph';
export type AggregateFunction = 'count' | 'sum' | 'average' | 'min' | 'max';
export interface FilterRule {
  id: string;
  columnId: string;
  operator: 'contains' | 'equals' | 'not-equals' | 'greater' | 'less' | 'empty' | 'not-empty';
  value: string;
}
export interface ChartConfig {
  type: 'bar' | 'line' | 'pie';
  x: string;
  y: string;
  series?: string;
  aggregate: AggregateFunction;
  sort: 'label' | 'ascending' | 'descending';
  legend: boolean;
  labels: boolean;
  format: 'number' | 'percent' | 'currency';
}
export interface TimelineConfig {
  start: string;
  end: string;
  group: string;
  scale: 'day' | 'week' | 'month';
  from: string;
  to: string;
}
export interface DashboardWidget {
  id: string;
  type: 'metric' | 'chart' | 'table';
  title: string;
  columnId?: string;
  aggregate?: AggregateFunction;
  chart?: ChartConfig;
}
export interface DataView {
  accent?: string;
  id: string;
  name: string;
  projection: DataProjection;
  search: string;
  sorts: { columnId: string; descending: boolean }[];
  filters: FilterRule[];
  filterMode: 'and' | 'or';
  groupBy: string;
  hidden: string[];
  widths: Record<string, number>;
  frozen: number;
  chart: ChartConfig;
  timeline: TimelineConfig;
  summary: { columnId: string; aggregate: AggregateFunction };
  cardFields: string[];
  widgets: DashboardWidget[];
}
/** Adopt saved-view changes without overwriting private unsaved filters or layout. */
export function reconcileDataView(
  current: DataView,
  previous?: DataView,
  next?: DataView,
): DataView {
  if (!previous || !next || current.id !== next.id || previous.id !== next.id) return current;
  const result = { ...current };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<
    keyof DataView
  >) {
    if (key === 'id' || canonicalJson(current[key]) !== canonicalJson(previous[key])) continue;
    if (next[key] === undefined) delete result[key];
    else Object.assign(result, { [key]: clone(next[key]) });
  }
  return result;
}
export function defaultView(data: StructuredData): DataView {
  const label = data.columns.find((c) => c.type === 'text')?.id ?? data.columns[0]?.id ?? '',
    numeric = data.columns.filter((c) => ['number', 'formula'].includes(c.type)).at(-1)?.id ?? '',
    group = data.columns.find((c) => c.type === 'select')?.id ?? '',
    dates = data.columns.filter((c) => c.type === 'date');
  return {
    id: newId('view'),
    name: 'Default view',
    projection: 'Grid',
    search: '',
    sorts: [],
    filters: [],
    filterMode: 'and',
    groupBy: '',
    hidden: [],
    widths: {},
    frozen: 1,
    chart: {
      type: 'bar',
      x: group || label,
      y: numeric,
      aggregate: 'sum',
      sort: 'label',
      legend: true,
      labels: true,
      format: 'number',
    },
    timeline: {
      start: dates[0]?.id ?? '',
      end: dates[1]?.id ?? dates[0]?.id ?? '',
      group,
      scale: 'week',
      from: '',
      to: '',
    },
    summary: { columnId: numeric, aggregate: 'sum' },
    cardFields: [label, numeric].filter(Boolean),
    widgets: [],
  };
}
function value(data: StructuredData, row: DataRow, id: string): Cell {
  const c = data.columns.find((c) => c.id === id);
  if (!c) return null;
  try {
    return cellValue(data, row, c);
  } catch {
    return null;
  }
}
export function viewRows(
  data: StructuredData,
  view: Pick<DataView, 'search' | 'sorts' | 'filters' | 'filterMode'> &
    Partial<Pick<DataView, 'groupBy'>>,
): DataRow[] {
  const matches = (row: DataRow, f: FilterRule) => {
    const v = value(data, row, f.columnId);
    switch (f.operator) {
      case 'empty':
        return v === null || v === '';
      case 'not-empty':
        return v !== null && v !== '';
      case 'equals':
        return String(v ?? '').toLocaleLowerCase() === f.value.toLocaleLowerCase();
      case 'not-equals':
        return String(v ?? '').toLocaleLowerCase() !== f.value.toLocaleLowerCase();
      case 'greater':
        return v !== null && Number(v) > Number(f.value);
      case 'less':
        return v !== null && Number(v) < Number(f.value);
      default:
        return String(v ?? '')
          .toLocaleLowerCase()
          .includes(f.value.toLocaleLowerCase());
    }
  };
  const rows = data.rows.filter(
    (row) =>
      (!view.search ||
        data.columns.some((c) =>
          displayCell(data, row, c).toLocaleLowerCase().includes(view.search.toLocaleLowerCase()),
        )) &&
      (!view.filters.length ||
        (view.filterMode === 'or'
          ? view.filters.some((f) => matches(row, f))
          : view.filters.every((f) => matches(row, f)))),
  );
  if (view.sorts.length)
    rows.sort((a, b) => {
      for (const s of view.sorts) {
        const x = value(data, a, s.columnId),
          y = value(data, b, s.columnId);
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const cmp =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y), undefined, { numeric: true });
        if (cmp) return cmp * (s.descending ? -1 : 1);
      }
      return 0;
    });
  if (view.groupBy) {
    const groups = new Map<string, DataRow[]>();
    for (const row of rows) {
      const key = String(value(data, row, view.groupBy) ?? '(empty)');
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].flat();
  }
  return rows;
}
export function summarize(
  data: StructuredData,
  rows: DataRow[],
  id: string,
  fn: AggregateFunction,
): number | null {
  if (fn === 'count') return rows.length;
  const numbers = rows
    .map((r) => value(data, r, id))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!numbers.length) return null;
  const sum = numbers.reduce((a, b) => a + b, 0);
  return fn === 'sum'
    ? sum
    : fn === 'average'
      ? sum / numbers.length
      : fn === 'min'
        ? Math.min(...numbers)
        : Math.max(...numbers);
}
export function formatCell(data: StructuredData, row: DataRow, c: Column): string {
  const v = value(data, row, c.id);
  if (v === null) return displayCell(data, row, c) === '#ERROR' ? '#ERROR' : '—';
  if (typeof v === 'number' && c.format) {
    if (c.format === 'currency')
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: c.currency ?? 'USD',
        maximumFractionDigits: c.decimals ?? 2,
      }).format(v);
    if (c.format === 'percent')
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: c.decimals ?? 1,
      }).format(v);
    if (c.format === 'decimal')
      return v.toLocaleString(undefined, {
        minimumFractionDigits: c.decimals ?? 2,
        maximumFractionDigits: c.decimals ?? 2,
      });
  }
  return String(v);
}
export interface CellEdit {
  rowId: string;
  columnId: string;
  value: Cell;
}
export function setCells(
  edits: CellEdit[],
  label = 'Edit cells',
  newRows: DataRow[] = [],
): EditorCommand<StructuredData> {
  const payload = clone(edits),
    created = clone(newRows);
  return immutableCommand('data.cells', label, (data) => {
    if (created.some((r) => data.rows.some((old) => old.id === r.id)))
      throw new Error('A new row ID already exists');
    const rows = [...data.rows, ...created],
      byRow = new Map(rows.map((r) => [r.id, r])),
      columns = new Map(data.columns.map((c) => [c.id, c])),
      patches = new Map<string, Record<string, Cell>>();
    for (const edit of payload) {
      if (!byRow.has(edit.rowId)) throw new Error('A target record was deleted');
      const c = columns.get(edit.columnId);
      if (!c) throw new Error('A target field was deleted');
      if (c.type === 'formula' || c.readOnly) throw new Error(`${c.name} is read only`);
      patches.set(edit.rowId, { ...patches.get(edit.rowId), [edit.columnId]: edit.value });
    }
    const next = {
      ...data,
      schemaVersion: 2 as const,
      rows: rows.map((r) =>
        patches.has(r.id) ? { ...r, values: { ...r.values, ...patches.get(r.id) } } : r,
      ),
    };
    const affected = next.rows.filter(
        (r) => patches.has(r.id) || created.some((c) => c.id === r.id),
      ),
      errors = validateData(next, affected);
    if (errors.length) {
      const first = errors[0];
      throw new Error(
        `${columns.get(first.columnId)?.name}: ${first.message} (${errors.length} invalid field${errors.length === 1 ? '' : 's'})`,
      );
    }
    return next;
  });
}
export function parseTsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    text = '',
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        text += '"';
        i++;
      } else if (quoted || text === '') quoted = !quoted;
      else text += ch;
    } else if (!quoted && ch === '\t') {
      row.push(text);
      text = '';
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(text);
      rows.push(row);
      row = [];
      text = '';
    } else text += ch;
  }
  if (quoted) throw new Error('Unclosed TSV quote');
  if (text || row.length) {
    row.push(text);
    rows.push(row);
  }
  return rows;
}
export function tsv(data: StructuredData, rowIds: string[], columnIds: string[]): string {
  return rowIds
    .map((id) => {
      const row = data.rows.find((r) => r.id === id);
      if (!row) return '';
      return columnIds
        .map((id) => {
          const c = data.columns.find((c) => c.id === id),
            text = c ? displayCell(data, row, c) : '';
          return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join('\t');
    })
    .join('\n');
}
export function pasteCells(
  data: StructuredData,
  rowIds: string[],
  columnIds: string[],
  rowIndex: number,
  columnIndex: number,
  source: string,
  allowAppend: boolean,
): EditorCommand<StructuredData> {
  const input = parseTsv(source);
  if (!input.length) throw new Error('Clipboard is empty');
  if (input.some((r) => r.length > columnIds.length - columnIndex))
    throw new Error('Paste has more columns than the visible target range');
  const ids = [...rowIds],
    created: DataRow[] = [];
  while (ids.length < rowIndex + input.length) {
    if (!allowAppend)
      throw new Error('Paste needs more rows. Clear sort/filter before adding records.');
    const r = makeRow(data);
    ids.push(r.id);
    created.push(r);
  }
  const edits: CellEdit[] = [];
  input.forEach((row, r) =>
    row.forEach((text, c) => {
      const column = data.columns.find((v) => v.id === columnIds[columnIndex + c]);
      if (!column) throw new Error('Target field is missing');
      if (column.type === 'formula' && text === '') return;
      edits.push({ rowId: ids[rowIndex + r], columnId: column.id, value: parseCell(text, column) });
    }),
  );
  return setCells(edits, 'Paste cells', created);
}
export const insertRows = (rows: DataRow[]) => {
  const fixed = clone(rows);
  return command<StructuredData>('data.insert-rows', 'Add records', (d) => {
    if (fixed.some((r) => d.rows.some((v) => v.id === r.id))) throw new Error('Duplicate row ID');
    return { ...d, rows: [...d.rows, ...fixed] };
  });
};
export function deleteRows(ids: string[]) {
  const selected = new Set(ids);
  return command<StructuredData>('data.delete-rows', 'Delete records', (d) => ({
    ...d,
    ...(d.graphView
      ? {
          graphView: {
            ...d.graphView,
            positions: Object.fromEntries(
              Object.entries(d.graphView.positions).filter(([id]) => !selected.has(id)),
            ),
          },
        }
      : {}),
    rows: d.rows
      .filter((r) => !selected.has(r.id))
      .map((r) => ({
        ...r,
        values: Object.fromEntries(
          Object.entries(r.values).map(([id, value]) => [
            id,
            d.columns.find((c) => c.id === id)?.type === 'relation' && selected.has(String(value))
              ? null
              : value,
          ]),
        ),
      })),
  }));
}
export function reorderRow(id: string, beforeId: string | null) {
  return command<StructuredData>('data.reorder-row', 'Move record', (d) => {
    const row = d.rows.find((r) => r.id === id);
    if (!row) throw new Error('Record is missing');
    const rows = d.rows.filter((r) => r.id !== id),
      index = beforeId === null ? rows.length : rows.findIndex((r) => r.id === beforeId);
    if (index < 0) throw new Error('Target record is missing');
    rows.splice(index, 0, row);
    return { ...d, rows };
  });
}
export function freezeFormulaReferences(data: StructuredData, formula: string): string {
  return formula.replace(/\[[^\]]+\]|[A-Za-z_][A-Za-z_0-9]*/g, (token) => {
    const name = token.replace(/^\[|\]$/g, ''),
      c = data.columns.find((c) => c.id === name || c.name === name);
    return c ? `[${c.id}]` : token;
  });
}
export function readableFormula(data: StructuredData, formula: string): string {
  return formula.replace(/\[([^\]]+)\]/g, (_match, id) => {
    const c = data.columns.find((c) => c.id === id);
    return c ? `[${c.name}]` : `[${id}]`;
  });
}
export function previewColumn(
  data: StructuredData,
  id: string,
  patch: Partial<Column>,
): { content: StructuredData; errors: { rowId: string; message: string }[]; changed: number } {
  const original = data.columns.find((c) => c.id === id);
  if (!original) throw new Error('Field is missing');
  const updated = { ...original, ...patch, id };
  if (
    !updated.name.trim() ||
    data.columns.some(
      (c) => c.id !== id && c.name.toLocaleLowerCase() === updated.name.toLocaleLowerCase(),
    )
  )
    throw new Error('Field names must be unique and nonempty');
  const columns = data.columns.map((c) => {
    const frozen =
      c.type === 'formula' ? { ...c, formula: freezeFormulaReferences(data, c.formula ?? '') } : c;
    return c.id === id
      ? {
          ...updated,
          ...(updated.type === 'formula'
            ? { formula: freezeFormulaReferences(data, updated.formula ?? '') }
            : {}),
        }
      : frozen;
  });
  let changed = 0;
  const rows = data.rows.map((r) => {
    if (original.type === updated.type) return r;
    const before =
        original.type === 'formula' ? cellValue(data, r, original) : (r.values[id] ?? null),
      after = updated.type === 'formula' ? before : parseCell(String(before ?? ''), updated);
    if (after !== before) changed++;
    return { ...r, values: { ...r.values, [id]: after } };
  });
  const previousErrors = new Set(
    validateData(data).map((e) => `${e.rowId}:${e.columnId}:${e.message}`),
  );
  const content = { ...data, schemaVersion: 2 as const, columns, rows },
    errors = validateData(content)
      .filter(
        (e) => e.columnId === id || !previousErrors.has(`${e.rowId}:${e.columnId}:${e.message}`),
      )
      .map((e) => ({
        rowId: e.rowId,
        message: `${columns.find((c) => c.id === e.columnId)?.name}: ${e.message}`,
      }));
  return { content, errors, changed };
}
export function updateColumn(id: string, patch: Partial<Column>) {
  const fixed = clone(patch);
  return columnSchemaCommand(
    id,
    'update',
    command<StructuredData>('data.update-column', 'Update field', (d) => {
      const result = previewColumn(d, id, fixed);
      if (result.errors.length)
        throw new Error(
          `${result.errors.length} records cannot be converted: ${result.errors[0].message}`,
        );
      return result.content;
    }),
  );
}
export function reorderColumn(id: string, beforeId: string | null) {
  return command<StructuredData>('data.reorder-column', 'Reorder field', (d) => {
    const column = d.columns.find((c) => c.id === id);
    if (!column) throw new Error('Field is missing');
    const columns = d.columns.filter((c) => c.id !== id),
      index = beforeId === null ? columns.length : columns.findIndex((c) => c.id === beforeId);
    if (index < 0) throw new Error('Target field is missing');
    columns.splice(index, 0, column);
    return { ...d, columns };
  });
}
export function saveView(view: DataView) {
  const fixed = clone(view);
  return command<StructuredData>('data.save-view', 'Save named view', (d) => ({
    ...d,
    schemaVersion: 2,
    views: [...(d.views ?? []).filter((v) => v.id !== fixed.id), fixed],
  }));
}
// The calendar-day axis is shared with Schedule (packages/time-axis).
export { utcDay, dayString } from '@editor-platform/time-axis';
export function moveDates(
  data: StructuredData,
  rowId: string,
  config: TimelineConfig,
  startDay: number,
  endDay: number,
) {
  if (endDay < startDay) throw new Error('End date must not precede start date');
  if (
    !data.columns.some((c) => c.id === config.start && c.type === 'date') ||
    !data.columns.some((c) => c.id === config.end && c.type === 'date')
  )
    throw new Error('Choose start and end date fields');
  return setCells(
    [
      { rowId, columnId: config.start, value: dayString(startDay) },
      { rowId, columnId: config.end, value: dayString(endDay) },
    ],
    'Change dates',
  );
}
