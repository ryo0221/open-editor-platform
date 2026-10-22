import { useState, useRef, useEffect, useContext, type RefObject } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorHistoryContext } from '@editor-platform/editor-ui';
import { type EditorCommand, type Region } from '@editor-platform/editor-core';
import { pinDataCommand } from './session';
import { displayCell, parseCell, type StructuredData, type DataRow, type Column } from './model';
import { setCells, type DataView } from './views';
import {
  columnWidth,
  entryWindow,
  fillDownCells,
  gridColumnWindow,
  gridEntries,
  gridSelection,
  rangeCells,
  scrollGridCell,
  stickyColumn,
  type CellAddress,
} from './grid-model';

export interface GridEditing {
  address: CellAddress;
  value: string;
  base: string;
  columns: string;
}
export interface DataGridProps {
  data: StructuredData;
  rows: DataRow[];
  columns: Column[];
  view: DataView;
  onView: (patch: Partial<DataView>) => void;
  apply: (cmd: EditorCommand<StructuredData>) => boolean;
  select: (id: string, region?: Region) => void;
  onField: (id: string) => void;
  readOnly: boolean;
  active: CellAddress | null;
  onActive: (address: CellAddress) => void;
  onError: (error: string) => void;
}

function useGridViewport(root: RefObject<HTMLDivElement | null>) {
  const [height, setHeight] = useState(600),
    [viewportWidth, setViewportWidth] = useState(900);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setViewportWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { height, viewportWidth };
}

function useGridLayout(
  { data, rows, columns, view }: DataGridProps,
  editing: GridEditing | null,
  scrollLeft: number,
  viewportWidth: number,
) {
  const entries = gridEntries(data, rows, view);
  const width = (c: Column) => columnWidth(view, c),
    totalWidth = 44 + columns.reduce((sum, c) => sum + width(c), 0);
  const columnWindow = gridColumnWindow(
    columns,
    width,
    view.frozen,
    editing?.address.columnId,
    scrollLeft,
    viewportWidth,
  );
  const sticky = (i: number) => stickyColumn(i, view.frozen, columns, width);
  return { entries, width, totalWidth, columnWindow, sticky };
}

/** Owns grid selection, viewport and in-progress cell editing for one projection. */
export function useDataGrid(props: DataGridProps) {
  const { data, rows, columns, view, apply, select, readOnly, active, onActive } = props;
  const history = useContext(EditorHistoryContext);
  const [anchor, setAnchor] = useState<CellAddress | null>(null),
    [rowAnchor, setRowAnchor] = useState<string>(),
    [editing, setEditing] = useState<GridEditing | null>(null),
    [scroll, setScroll] = useState(0),
    [scrollLeft, setScrollLeft] = useState(0),
    [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null),
    committing = useRef(false);
  const { height, viewportWidth } = useGridViewport(root);
  const rowIds = rows.map((r) => r.id),
    colIds = columns.map((c) => c.id),
    at = active ?? (rows[0] && columns[0] ? { rowId: rows[0].id, columnId: columns[0].id } : null),
    base = anchor ?? at;
  const { ri, ci, bounds } = gridSelection(rowIds, colIds, at, base);
  const selectedRows = rowIds.slice(bounds.top, bounds.bottom + 1),
    selectedColumns = colIds.slice(bounds.left, bounds.right + 1),
    locked =
      readOnly ||
      columns.slice(bounds.left, bounds.right + 1).some((c) => c.readOnly || c.type === 'formula');
  const layout = useGridLayout(props, editing, scrollLeft, viewportWidth);
  const { start, end } = entryWindow(layout.entries.length, height, scroll);
  function choose(r: number, c: number, extend = false, focus = true) {
    setRowAnchor(undefined);
    if (!rows[r] || !columns[c]) return;
    const address = { rowId: rows[r].id, columnId: columns[c].id };
    if (!extend) setAnchor(address);
    else if (!anchor && at) setAnchor(at);
    onActive(address);
    select(address.rowId, {
      type: 'cell',
      columnId: address.columnId,
      ...(extend && base ? { endRowId: base.rowId, endColumnId: base.columnId } : {}),
    });
    if (focus) {
      root.current?.focus();
      scrollGridCell(
        root.current,
        layout.entries,
        r,
        c,
        height,
        columns,
        view.frozen,
        layout.width,
      );
    }
  }
  function edit(initial?: string) {
    if (!at || readOnly) return;
    const column = data.columns.find((c) => c.id === at.columnId),
      row = data.rows.find((r) => r.id === at.rowId);
    if (!column || !row || column.type === 'formula' || column.readOnly) return;
    committing.current = false;
    setEditing({
      address: at,
      value: initial ?? displayCell(data, row, column),
      base: canonicalJson(row),
      columns: canonicalJson(data.columns),
    });
  }
  function commit() {
    if (!editing || committing.current) return true;
    const column = data.columns.find((c) => c.id === editing.address.columnId);
    if (!column) return false;
    committing.current = true;
    const result = apply(
      pinDataCommand(setCells([{ ...editing.address, value: parseCell(editing.value, column) }]), {
        rowId: editing.address.rowId,
        row: editing.base,
        columns: editing.columns,
      }),
    );
    if (result) setEditing(null);
    else committing.current = false;
    return result;
  }
  function clear() {
    if (locked) return;
    apply(setCells(rangeCells(selectedRows, selectedColumns)));
  }
  function fill() {
    if (locked || selectedRows.length < 2) return;
    apply(setCells(fillDownCells(data, selectedRows, selectedColumns), 'Fill down'));
  }
  return {
    history,
    anchor,
    setAnchor,
    rowAnchor,
    setRowAnchor,
    editing,
    setEditing,
    setScroll,
    setScrollLeft,
    context,
    setContext,
    root,
    committing,
    rowIds,
    colIds,
    at,
    ri,
    ci,
    bounds,
    selectedRows,
    selectedColumns,
    locked,
    ...layout,
    start,
    end,
    choose,
    edit,
    commit,
    clear,
    fill,
  };
}
export type DataGridController = ReturnType<typeof useDataGrid>;
