import { clone, newId } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  addColumn,
  displayCell,
  importCsv,
  parseCell,
  parseCsvText,
  pruneViewFields,
  validateData,
  type Column,
  type CsvImportOptions,
  type DataRow,
  type StructuredData,
} from './model';
import { rasterizeSvg } from '@editor-platform/canvas-ui';
import { chartSvg } from './charts';
import {
  defaultView,
  viewRows,
  type AggregateFunction,
  type ChartConfig,
  type DataProjection,
  type DataView,
} from './views';

export const projections: DataProjection[] = [
  'Grid',
  'Form',
  'Kanban',
  'Chart',
  'Dashboard',
  'Timeline',
  'Roadmap',
  'Calendar',
  'Summary',
];
export const aggregates: AggregateFunction[] = ['sum', 'average', 'count', 'min', 'max'];
export const projectionChoices = (graph: boolean) => [
  ...projections,
  ...(graph ? ['Graph' as const] : []),
];

export interface CsvDraft extends CsvImportOptions {
  source: string;
  data: StructuredData;
  name: string;
}
export interface CsvDiagnostic {
  row: number;
  column: number;
  name: string;
  raw: string;
  message: string;
}

export function initialDataView(data: StructuredData, initialView?: DataView): DataView {
  return initialView
    ? pruneViewFields(
        clone(initialView),
        data.columns.map((column) => column.id),
      )
    : data.views?.[0]
      ? clone(data.views[0])
      : defaultView(data);
}

export function csvValidationErrors(csv: CsvDraft, csvHeader: boolean): CsvDiagnostic[] {
  return validateData(csv.data).map((error) => ({
    row: csv.data.rows.findIndex((row) => row.id === error.rowId) + (csvHeader ? 2 : 1),
    column: csv.data.columns.findIndex((column) => column.id === error.columnId) + 1,
    name: csv.data.columns.find((column) => column.id === error.columnId)?.name ?? '',
    raw: String(csv.data.rows.find((row) => row.id === error.rowId)?.values[error.columnId] ?? ''),
    message: error.message,
  }));
}

export function csvWithHeader(csv: CsvDraft, header: boolean): CsvDraft {
  const count = parseCsvText(csv.source, csv)[0]?.length ?? 1;
  return {
    ...csv,
    data: importCsv(
      header
        ? csv.source
        : Array.from({ length: count }, (_, i) => `Column ${i + 1}`).join(',') + '\n' + csv.source,
      csv,
    ),
  };
}

/** Changing guard decoding preserves the types already selected in the preview. */
export function csvWithFormulaGuard(
  csv: CsvDraft,
  decodeFormulaGuard: boolean,
  csvHeader: boolean,
): CsvDraft {
  const parsed = parseCsvText(csv.source, { decodeFormulaGuard });
  const names = new Set<string>();
  const columns = csv.data.columns.map((column, index) => {
    // Match importCsv's trimmed, nonempty, unique header names after decoding.
    let name = (csvHeader ? parsed[0]?.[index]?.trim() : '') || `Column ${index + 1}`;
    while (names.has(name)) name += ' (copy)';
    names.add(name);
    return { ...column, name };
  });
  const rawRows = parsed.slice(csvHeader ? 1 : 0);
  return {
    ...csv,
    decodeFormulaGuard,
    data: {
      ...csv.data,
      columns,
      rows: csv.data.rows.map((row, index) => ({
        ...row,
        values: Object.fromEntries(
          columns.map((column, i) => [column.id, parseCell(rawRows[index]?.[i] ?? '', column)]),
        ),
      })),
    },
  };
}

export function retypeCsvColumn(
  csv: CsvDraft,
  c: Column,
  type: Column['type'],
  csvHeader: boolean,
): CsvDraft {
  const original = parseCsvText(csv.source, csv).slice(csvHeader ? 1 : 0);
  const columnIndex = csv.data.columns.findIndex((v) => v.id === c.id);
  return {
    ...csv,
    data: {
      ...csv.data,
      columns: csv.data.columns.map((v) => (v.id === c.id ? { ...v, type } : v)),
      rows: csv.data.rows.map((r, index) => ({
        ...r,
        values: {
          ...r.values,
          [c.id]: parseCell(original[index]?.[columnIndex] ?? '', {
            ...c,
            type,
          }),
        },
      })),
    },
  };
}

export function dataGroups(data: StructuredData, rows: DataRow[], view: DataView) {
  const groupColumn = data.columns.find(
    (c) => c.id === (view.groupBy || data.columns.find((c) => c.type === 'select')?.id),
  );
  const groupNames = groupColumn
    ? [
        ...new Set([
          ...(groupColumn.options ?? []),
          ...rows.map((r) => displayCell(data, r, groupColumn) || '(empty)'),
          '(empty)',
        ]),
      ]
    : ['All records'];
  const groupRows = (name: string) =>
    rows.filter(
      (r) =>
        (groupColumn ? displayCell(data, r, groupColumn) || '(empty)' : 'All records') === name,
    );
  return { groupColumn, groupNames, groupRows };
}
export type DataGroups = ReturnType<typeof dataGroups>;

export const groupValue = (name: string) => (name === '(empty)' ? null : name);

export function timelineFields(data: StructuredData) {
  const names = new Set(data.columns.map((column) => column.name));
  const name = (base: string) => {
    let next = base;
    let index = 2;
    while (names.has(next)) next = `${base} ${index++}`;
    names.add(next);
    return next;
  };
  const start: Column = {
    id: newId('col'),
    name: name('Start date'),
    type: 'date',
  };
  const end: Column = { id: newId('col'), name: name('End date'), type: 'date' };
  return {
    start,
    end,
    command: command<StructuredData>(
      'data.timeline-fields',
      'Add timeline date fields',
      (current) => addColumn(end).apply(addColumn(start).apply(current)),
    ),
  };
}

export function dashboardWidget(
  type: 'metric' | 'chart' | 'table',
  numeric: Column[],
  chart: ChartConfig,
) {
  const id = newId('widget');
  return {
    id,
    type,
    title: `${type[0].toUpperCase() + type.slice(1)}`,
    columnId: numeric.at(-1)?.id,
    aggregate: 'sum' as const,
    chart: clone(chart),
  };
}

export function swapWidget<T>(widgets: T[], i: number) {
  const next = [...widgets];
  [next[i - 1], next[i]] = [next[i], next[i - 1]];
  return next;
}

export const toggled = (ids: string[], id: string, on: boolean) =>
  on ? [...ids, id] : ids.filter((v) => v !== id);

export const dataChartSvg = (snapshot: { data: StructuredData; view: DataView }) =>
  chartSvg(
    snapshot.data,
    viewRows(snapshot.data, snapshot.view),
    snapshot.view.chart,
    900,
    430,
    snapshot.view.accent,
  );
export const svgBlob = (source: string) => new Blob([source], { type: 'image/svg+xml' });
export const pngBlob = async (source: string) =>
  new Blob([(await rasterizeSvg(source, 900, 430)) as Uint8Array<ArrayBuffer>], {
    type: 'image/png',
  });
