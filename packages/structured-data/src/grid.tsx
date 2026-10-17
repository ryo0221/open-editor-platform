import { canonicalJson } from '@editor-platform/artifact-core';
import { pinDataCommand } from './session';
import { PropertyInput } from '@editor-platform/property-input';
import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { type EditorCommand, type Region } from '@editor-platform/editor-core';
import { displayCell, parseCell, type StructuredData, type DataRow, type Column } from './model';
import {
  formatCell,
  summarize,
  pasteCells,
  setCells,
  tsv,
  deleteRows,
  reorderRow,
  type DataView,
} from './views';
export interface CellAddress {
  rowId: string;
  columnId: string;
}
export function ValueInput({
  data,
  row,
  column,
  value,
  onChange,
  onKeyDown,
  onBlur,
  autoFocus = false,
  readOnly = false,
  label,
}: {
  data: StructuredData;
  row: DataRow;
  column: Column;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >;
  onBlur?: () => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  label?: string;
}) {
  const labelText =
    label ?? `${column.name} · ${String(row.values[data.columns[0]?.id] ?? 'record')}`;
  if (column.type === 'formula')
    return <output aria-label={labelText}>{displayCell(data, row, column)}</output>;
  const options =
    column.type === 'boolean'
      ? ['true', 'false'].map((v) => ({ value: v, label: v }))
      : column.type === 'select'
        ? column.options?.map((v) => ({ value: v, label: v }))
        : column.type === 'relation'
          ? data.rows.map((r) => ({
              value: r.id,
              label: String(r.values[data.columns[0]?.id] ?? r.id),
            }))
          : undefined;
  return (
    <PropertyInput
      label={labelText}
      value={value}
      onChange={onChange}
      type={
        options
          ? 'select'
          : column.type === 'date'
            ? 'date'
            : column.type === 'number'
              ? 'number'
              : 'text'
      }
      options={options}
      readOnly={readOnly || column.readOnly}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}
export function DataGrid({
  data,
  rows,
  columns,
  view,
  onView,
  apply,
  select,
  onField,
  readOnly,
  active,
  onActive,
  onError,
}: {
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
}) {
  const [anchor, setAnchor] = useState<CellAddress | null>(null),
    [rowAnchor, setRowAnchor] = useState<string>(),
    [editing, setEditing] = useState<{
      address: CellAddress;
      value: string;
      base: string;
      columns: string;
    } | null>(null),
    [scroll, setScroll] = useState(0),
    [scrollLeft, setScrollLeft] = useState(0),
    [height, setHeight] = useState(600),
    [viewportWidth, setViewportWidth] = useState(900),
    [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null),
    committing = useRef(false);
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
  const rowIds = rows.map((r) => r.id),
    colIds = columns.map((c) => c.id),
    at = active ?? (rows[0] && columns[0] ? { rowId: rows[0].id, columnId: columns[0].id } : null),
    base = anchor ?? at;
  const ri = at ? Math.max(0, rowIds.indexOf(at.rowId)) : 0,
    ci = at ? Math.max(0, colIds.indexOf(at.columnId)) : 0,
    ar = base ? Math.max(0, rowIds.indexOf(base.rowId)) : ri,
    ac = base ? Math.max(0, colIds.indexOf(base.columnId)) : ci,
    bounds = {
      top: Math.min(ri, ar),
      bottom: Math.max(ri, ar),
      left: Math.min(ci, ac),
      right: Math.max(ci, ac),
    };
  const selectedRows = rowIds.slice(bounds.top, bounds.bottom + 1),
    selectedColumns = colIds.slice(bounds.left, bounds.right + 1),
    locked =
      readOnly ||
      columns.slice(bounds.left, bounds.right + 1).some((c) => c.readOnly || c.type === 'formula');
  const groupColumn = data.columns.find((c) => c.id === view.groupBy),
    entries: (
      | { row: DataRow; index: number }
      | { group: string; count: number; sum: number | null }
    )[] = [];
  const groupedRows = new Map<string, DataRow[]>();
  if (groupColumn)
    for (const row of rows) {
      const key = displayCell(data, row, groupColumn) || '(empty)';
      const bucket = groupedRows.get(key) ?? [];
      bucket.push(row);
      groupedRows.set(key, bucket);
    }
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
  const start = Math.max(
      0,
      Math.min(
        Math.max(0, entries.length - Math.ceil(height / 36)),
        Math.floor((scroll - 36) / 36) - 6,
      ),
    ),
    end = Math.min(entries.length, start + Math.ceil(height / 36) + 14),
    // Column IDs may match Object.prototype names; inherited entries are not saved widths.
    width = (c: Column) => (Object.hasOwn(view.widths, c.id) ? (view.widths[c.id] ?? 160) : 160),
    totalWidth = 44 + columns.reduce((sum, c) => sum + width(c), 0);
  // Retain the full model and keyboard column order; only mount the horizontal
  // viewport plus overscan. Frozen columns and a private in-progress editor stay
  // mounted. Margins preserve omitted column widths in the normal flex flow.
  let offset = 0,
    renderedEnd = 0;
  const columnWindow = columns.flatMap((column, index) => {
    const left = offset,
      right = left + width(column);
    offset = right;
    if (
      index >= view.frozen &&
      column.id !== editing?.address.columnId &&
      (44 + right < scrollLeft - 320 || 44 + left > scrollLeft + viewportWidth + 320)
    )
      return [];
    const gap = left - renderedEnd;
    renderedEnd = right;
    return [{ column, index, gap }];
  });
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
      const top = entries.findIndex((entry) => 'row' in entry && entry.index === r) * 36;
      if (top < (root.current?.scrollTop ?? 0)) root.current!.scrollTop = top;
      else if (top + 72 > (root.current?.scrollTop ?? 0) + height)
        root.current!.scrollTop = top + 72 - height;
      const el = root.current!,
        left = 44 + columns.slice(0, c).reduce((sum, column) => sum + width(column), 0);
      const frozen =
        44 + columns.slice(0, view.frozen).reduce((sum, column) => sum + width(column), 0);
      if (c >= view.frozen) {
        if (left < el.scrollLeft + frozen) el.scrollLeft = left - frozen;
        else if (left + width(columns[c]) > el.scrollLeft + el.clientWidth)
          el.scrollLeft = left + width(columns[c]) - el.clientWidth;
      }
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
    apply(
      setCells(
        selectedRows.flatMap((rowId) =>
          selectedColumns.map((columnId) => ({ rowId, columnId, value: null })),
        ),
      ),
    );
  }
  function fill() {
    if (locked || selectedRows.length < 2) return;
    const first = data.rows.find((r) => r.id === selectedRows[0])!;
    apply(
      setCells(
        selectedRows.slice(1).flatMap((rowId) =>
          selectedColumns.map((columnId) => ({
            rowId,
            columnId,
            value: first.values[columnId] ?? null,
          })),
        ),
        'Fill down',
      ),
    );
  }
  const sticky = (i: number): CSSProperties =>
    i < view.frozen
      ? {
          position: 'sticky',
          left: 44 + columns.slice(0, i).reduce((n, c) => n + width(c), 0),
          zIndex: 2,
        }
      : {};
  return (
    <div
      className="ep-data-grid"
      role="grid"
      aria-label="Data grid"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 1}
      tabIndex={0}
      ref={root}
      onScroll={(e) => {
        setScroll(e.currentTarget.scrollTop);
        setScrollLeft(e.currentTarget.scrollLeft);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContext({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Escape') {
          setRowAnchor(undefined);
          setContext(null);
          setAnchor(at);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setRowAnchor(undefined);
          if (rows.length && columns.length) {
            setAnchor({ rowId: rows[0].id, columnId: columns[0].id });
            onActive({ rowId: rows.at(-1)!.id, columnId: columns.at(-1)!.id });
          }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          fill();
          return;
        }
        const moves: Record<string, [number, number]> = {
          ArrowUp: [-1, 0],
          ArrowDown: [1, 0],
          ArrowLeft: [0, -1],
          ArrowRight: [0, 1],
          Tab: [0, e.shiftKey ? -1 : 1],
        };
        if (moves[e.key]) {
          e.preventDefault();
          let r = ri + moves[e.key][0],
            c = ci + moves[e.key][1];
          if (e.key === 'Tab') {
            if (c >= columns.length) {
              r++;
              c = 0;
            }
            if (c < 0) {
              r--;
              c = columns.length - 1;
            }
          }
          choose(
            Math.max(0, Math.min(rows.length - 1, r)),
            Math.max(0, Math.min(columns.length - 1, c)),
            e.shiftKey && e.key !== 'Tab',
          );
          return;
        }
        if (['Enter', 'F2'].includes(e.key)) {
          e.preventDefault();
          edit();
          return;
        }
        if (['Delete', 'Backspace'].includes(e.key)) {
          e.preventDefault();
          if (rowAnchor && !readOnly) {
            apply(deleteRows(selectedRows));
            setRowAnchor(undefined);
          } else clear();
          return;
        }
        if (
          !readOnly &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.nativeEvent.isComposing &&
          e.key.length === 1
        ) {
          e.preventDefault();
          edit(e.key);
        }
      }}
      onCopy={(e) => {
        if (editing) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', tsv(data, selectedRows, selectedColumns));
      }}
      onCut={(e) => {
        if (editing || locked) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', tsv(data, selectedRows, selectedColumns));
        clear();
      }}
      onPaste={(e) => {
        if (editing || readOnly) return;
        e.preventDefault();
        try {
          apply(
            pasteCells(
              data,
              rowIds,
              colIds,
              ri,
              ci,
              e.clipboardData.getData('text/plain'),
              !view.search && !view.filters.length && !view.sorts.length,
            ),
          );
        } catch (error) {
          onError((error as Error).message);
        }
      }}
    >
      <div className="ep-grid-header" role="row" style={{ width: totalWidth }}>
        <div className="ep-row-number" role="columnheader">
          #
        </div>
        {columnWindow.map(({ column: c, index: i, gap }) => (
          <div
            role="columnheader"
            aria-colindex={i + 2}
            key={c.id}
            className="ep-grid-column"
            style={{ width: width(c), ...sticky(i), marginLeft: gap }}
          >
            <button aria-label={`Field ${c.name}`} onClick={() => onField(c.id)}>
              {c.type === 'formula' ? 'ƒ ' : ''}
              {c.name}
              {c.required ? ' *' : ''}
            </button>
            <div
              role="separator"
              aria-label={`Resize ${c.name}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
                  onView({
                    widths: {
                      ...view.widths,
                      [c.id]: Math.max(
                        80,
                        Math.min(600, width(c) + (e.key === 'ArrowRight' ? 10 : -10)),
                      ),
                    },
                  });
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.dataset.start = String(e.clientX);
                e.currentTarget.dataset.width = String(width(c));
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  onView({
                    widths: {
                      ...view.widths,
                      [c.id]: Math.max(
                        80,
                        Math.min(
                          600,
                          Number(e.currentTarget.dataset.width) +
                            e.clientX -
                            Number(e.currentTarget.dataset.start),
                        ),
                      ),
                    },
                  });
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ height: start * 36, width: totalWidth }} />
      {entries.slice(start, end).map((entry) => {
        if ('group' in entry)
          return (
            <div
              key={`group:${entry.group}`}
              className="ep-grid-group"
              style={{ width: totalWidth }}
            >
              <span>
                {entry.group} · {entry.count} records · {view.summary.aggregate}:{' '}
                {entry.sum?.toLocaleString() ?? '—'}
              </span>
            </div>
          );
        const { row, index: r } = entry;
        return (
          <div
            role="row"
            aria-selected={!!rowAnchor && r >= bounds.top && r <= bounds.bottom}
            key={row.id}
            aria-rowindex={r + 2}
            style={{ width: totalWidth }}
            className="ep-grid-row"
          >
            <button
              className="ep-row-number"
              role="rowheader"
              draggable={!readOnly && !view.sorts.length}
              aria-label={`Select record ${r + 1}`}
              onClick={(event) => {
                if (!columns.length) return;
                const first = event.shiftKey && rowAnchor ? rowAnchor : row.id;
                setRowAnchor(first);
                setAnchor({ rowId: first, columnId: columns[0].id });
                onActive({ rowId: row.id, columnId: columns.at(-1)!.id });
                select(row.id);
                root.current?.focus();
              }}
              onDragStart={(e) => e.dataTransfer.setData('application/x-data-row', row.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('application/x-data-row');
                if (id && !view.sorts.length) apply(reorderRow(id, row.id));
              }}
            >
              {r + 1}
            </button>
            {columnWindow.map(({ column, index: c, gap }) => {
              const selected =
                  r >= bounds.top && r <= bounds.bottom && c >= bounds.left && c <= bounds.right,
                focused = row.id === at?.rowId && column.id === at.columnId,
                editingHere =
                  editing?.address.rowId === row.id && editing.address.columnId === column.id;
              return (
                <div
                  role="gridcell"
                  aria-selected={selected}
                  aria-colindex={c + 2}
                  aria-label={`${column.name} · record ${r + 1}`}
                  key={column.id}
                  data-row-id={row.id}
                  data-column-id={column.id}
                  className={`ep-grid-cell ${selected ? 'selected' : ''} ${focused ? 'active' : ''} ${editingHere ? 'editing' : ''} ${column.type === 'formula' ? 'computed' : ''}`}
                  style={{ width: width(column), ...sticky(c), marginLeft: gap }}
                  onMouseDown={(e) => {
                    if (editingHere) return;
                    e.preventDefault();
                    if (editing && !commit()) return;
                    choose(r, c, e.shiftKey);
                  }}
                  onDoubleClick={() => edit()}
                  title={formatCell(data, row, column)}
                >
                  {editingHere ? (
                    <ValueInput
                      data={data}
                      row={row}
                      column={column}
                      label={`Edit ${column.name}`}
                      value={editing.value}
                      autoFocus
                      onChange={(value) => setEditing({ ...editing, value })}
                      onBlur={() => commit()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Escape') {
                          committing.current = true;
                          setEditing(null);
                          root.current?.focus();
                        }
                        if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          if (commit()) {
                            choose(
                              Math.min(rows.length - 1, r + (e.key === 'Enter' ? 1 : 0)),
                              Math.min(columns.length - 1, c + (e.key === 'Tab' ? 1 : 0)),
                            );
                            root.current?.focus();
                          }
                        }
                      }}
                    />
                  ) : (
                    formatCell(data, row, column)
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ height: (entries.length - end) * 36, width: totalWidth }} />
      {!rows.length && (
        <div className="ep-data-empty">No records. Add records or paste TSV into this grid.</div>
      )}
      {context && (
        <div
          role="menu"
          aria-label="Cell actions"
          className="ep-cell-menu"
          style={{
            left: Math.min(context.x, innerWidth - 220),
            top: Math.min(context.y, innerHeight - 190),
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(tsv(data, selectedRows, selectedColumns));
              setContext(null);
            }}
          >
            Copy range
          </button>
          <button
            role="menuitem"
            disabled={locked}
            onClick={() => {
              clear();
              setContext(null);
            }}
          >
            Clear range
          </button>
          <button
            role="menuitem"
            disabled={locked || selectedRows.length < 2}
            onClick={() => {
              fill();
              setContext(null);
            }}
          >
            Fill down
          </button>
          <button
            role="menuitem"
            disabled={readOnly}
            onClick={() => {
              apply(deleteRows(selectedRows));
              setContext(null);
            }}
          >
            Delete selected records
          </button>
          <button role="menuitem" onClick={() => setContext(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
