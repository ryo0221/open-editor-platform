import { type CSSProperties } from 'react';
import { displayCell, type StructuredData, type DataRow, type Column } from './model';
import { summarize, type DataView } from './views';

export interface CellAddress {
  rowId: string;
  columnId: string;
}
export interface GridBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export type GridEntry =
  | { row: DataRow; index: number }
  | { group: string; count: number; sum: number | null };
export interface GridColumnSlot {
  column: Column;
  index: number;
  gap: number;
}

// Column IDs may match Object.prototype names; inherited entries are not saved widths.
export const columnWidth = (view: DataView, c: Column) =>
  Object.hasOwn(view.widths, c.id) ? (view.widths[c.id] ?? 160) : 160;

export function gridSelection(
  rowIds: string[],
  colIds: string[],
  at: CellAddress | null,
  base: CellAddress | null,
) {
  const ri = at ? Math.max(0, rowIds.indexOf(at.rowId)) : 0,
    ci = at ? Math.max(0, colIds.indexOf(at.columnId)) : 0,
    ar = base ? Math.max(0, rowIds.indexOf(base.rowId)) : ri,
    ac = base ? Math.max(0, colIds.indexOf(base.columnId)) : ci,
    bounds: GridBounds = {
      top: Math.min(ri, ar),
      bottom: Math.max(ri, ar),
      left: Math.min(ci, ac),
      right: Math.max(ci, ac),
    };
  return { ri, ci, bounds };
}

function groupRowsBy(data: StructuredData, rows: DataRow[], groupColumn: Column) {
  const groupedRows = new Map<string, DataRow[]>();
  for (const row of rows) {
    const key = displayCell(data, row, groupColumn) || '(empty)';
    const bucket = groupedRows.get(key) ?? [];
    bucket.push(row);
    groupedRows.set(key, bucket);
  }
  return groupedRows;
}

export function gridEntries(data: StructuredData, rows: DataRow[], view: DataView) {
  const groupColumn = data.columns.find((c) => c.id === view.groupBy),
    entries: GridEntry[] = [];
  const groupedRows = groupColumn
    ? groupRowsBy(data, rows, groupColumn)
    : new Map<string, DataRow[]>();
  rows.forEach((row, index) => {
    if (groupColumn) {
      const name = displayCell(data, row, groupColumn) || '(empty)',
        previous = index ? displayCell(data, rows[index - 1], groupColumn) || '(empty)' : null;
      if (name !== previous) {
        const members = groupedRows.get(name)!;
        entries.push({
          group: name,
          count: members.length,
          sum: summarize(data, members, view.summary.columnId, view.summary.aggregate),
        });
      }
    }
    entries.push({ row, index });
  });
  return entries;
}

export function entryWindow(count: number, height: number, scroll: number) {
  const start = Math.max(
      0,
      Math.min(Math.max(0, count - Math.ceil(height / 36)), Math.floor((scroll - 36) / 36) - 6),
    ),
    end = Math.min(count, start + Math.ceil(height / 36) + 14);
  return { start, end };
}

// Retain the full model and keyboard column order; only mount the horizontal
// viewport plus overscan. Frozen columns and a private in-progress editor stay
// mounted. Margins preserve omitted column widths in the normal flex flow.
export function gridColumnWindow(
  columns: Column[],
  width: (c: Column) => number,
  frozen: number,
  editingColumnId: string | undefined,
  scrollLeft: number,
  viewportWidth: number,
): GridColumnSlot[] {
  let offset = 0,
    renderedEnd = 0;
  return columns.flatMap((column, index) => {
    const left = offset,
      right = left + width(column);
    offset = right;
    if (
      index >= frozen &&
      column.id !== editingColumnId &&
      (44 + right < scrollLeft - 320 || 44 + left > scrollLeft + viewportWidth + 320)
    )
      return [];
    const gap = left - renderedEnd;
    renderedEnd = right;
    return [{ column, index, gap }];
  });
}

export function stickyColumn(
  i: number,
  frozen: number,
  columns: Column[],
  width: (c: Column) => number,
): CSSProperties {
  return i < frozen
    ? {
        position: 'sticky',
        left: 44 + columns.slice(0, i).reduce((n, c) => n + width(c), 0),
        zIndex: 2,
      }
    : {};
}

export function scrollGridCell(
  el: HTMLDivElement | null,
  entries: GridEntry[],
  r: number,
  c: number,
  height: number,
  columns: Column[],
  frozenCount: number,
  width: (c: Column) => number,
) {
  const top = entries.findIndex((entry) => 'row' in entry && entry.index === r) * 36;
  if (top < (el?.scrollTop ?? 0)) el!.scrollTop = top;
  else if (top + 72 > (el?.scrollTop ?? 0) + height) el!.scrollTop = top + 72 - height;
  const grid = el!,
    left = 44 + columns.slice(0, c).reduce((sum, column) => sum + width(column), 0);
  const frozen = 44 + columns.slice(0, frozenCount).reduce((sum, column) => sum + width(column), 0);
  if (c >= frozenCount) {
    if (left < grid.scrollLeft + frozen) grid.scrollLeft = left - frozen;
    else if (left + width(columns[c]) > grid.scrollLeft + grid.clientWidth)
      grid.scrollLeft = left + width(columns[c]) - grid.clientWidth;
  }
}

export const clampWidth = (value: number) => Math.max(80, Math.min(600, value));

export function rangeCells(rowIds: string[], columnIds: string[]) {
  return rowIds.flatMap((rowId) => columnIds.map((columnId) => ({ rowId, columnId, value: null })));
}

export function fillDownCells(data: StructuredData, selectedRows: string[], columnIds: string[]) {
  const first = data.rows.find((r) => r.id === selectedRows[0])!;
  return selectedRows.slice(1).flatMap((rowId) =>
    columnIds.map((columnId) => ({
      rowId,
      columnId,
      value: first.values[columnId] ?? null,
    })),
  );
}

export function gridCellClass(
  selected: boolean,
  focused: boolean,
  editingHere: boolean,
  column: Column,
) {
  return `ep-grid-cell ${selected ? 'selected' : ''} ${focused ? 'active' : ''} ${editingHere ? 'editing' : ''} ${column.type === 'formula' ? 'computed' : ''}`;
}
