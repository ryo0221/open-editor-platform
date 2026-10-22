import { type CSSProperties } from 'react';
import { type DataRow } from './model';
import { formatCell, tsv, deleteRows, reorderRow, type DataView } from './views';
import { clampWidth, gridCellClass, type GridColumnSlot } from './grid-model';
import { type DataGridController, type DataGridProps } from './grid-hooks';
import { ValueInput } from './grid-input';

export function GridHeader({
  grid,
  view,
  onView,
  onField,
}: {
  grid: DataGridController;
  view: DataView;
  onView: DataGridProps['onView'];
  onField: DataGridProps['onField'];
}) {
  const { width, sticky } = grid;
  return (
    <div className="ep-grid-header" role="row" style={{ width: grid.totalWidth }}>
      <div className="ep-row-number" role="columnheader">
        #
      </div>
      {grid.columnWindow.map(({ column: c, index: i, gap }) => (
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
                    [c.id]: clampWidth(width(c) + (e.key === 'ArrowRight' ? 10 : -10)),
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
                    [c.id]: clampWidth(
                      Number(e.currentTarget.dataset.width) +
                        e.clientX -
                        Number(e.currentTarget.dataset.start),
                    ),
                  },
                });
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function GridGroupRow({
  entry,
  totalWidth,
  aggregate,
}: {
  entry: { group: string; count: number; sum: number | null };
  totalWidth: number;
  aggregate: string;
}) {
  return (
    <div className="ep-grid-group" style={{ width: totalWidth }}>
      {/* prettier-ignore */}
      <span>
        {entry.group} · {entry.count} records · {aggregate}:{' '}
        {entry.sum?.toLocaleString() ?? '—'}
      </span>
    </div>
  );
}

function GridCell({
  grid,
  props,
  row,
  r,
  slot: { column, index: c, gap },
}: {
  grid: DataGridController;
  props: DataGridProps;
  row: DataRow;
  r: number;
  slot: GridColumnSlot;
}) {
  const { data, rows, columns } = props;
  const { bounds, at, editing, root } = grid;
  const selected = r >= bounds.top && r <= bounds.bottom && c >= bounds.left && c <= bounds.right,
    focused = row.id === at?.rowId && column.id === at.columnId,
    editingHere = editing?.address.rowId === row.id && editing.address.columnId === column.id;
  const style: CSSProperties = { width: grid.width(column), ...grid.sticky(c), marginLeft: gap };
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-colindex={c + 2}
      aria-label={`${column.name} · record ${r + 1}`}
      data-row-id={row.id}
      data-column-id={column.id}
      className={gridCellClass(selected, focused, editingHere, column)}
      style={style}
      onMouseDown={(e) => {
        if (editingHere) return;
        e.preventDefault();
        if (editing && !grid.commit()) return;
        grid.choose(r, c, e.shiftKey);
      }}
      onDoubleClick={() => grid.edit()}
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
          onChange={(value) => grid.setEditing({ ...editing, value })}
          onBlur={() => grid.commit()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              grid.committing.current = true;
              grid.setEditing(null);
              root.current?.focus();
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              if (grid.commit()) {
                grid.choose(
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
}

export function GridRow({
  grid,
  props,
  row,
  r,
}: {
  grid: DataGridController;
  props: DataGridProps;
  row: DataRow;
  r: number;
}) {
  const { view, columns, readOnly, apply } = props;
  const { bounds, rowAnchor } = grid;
  return (
    <div
      role="row"
      aria-selected={!!rowAnchor && r >= bounds.top && r <= bounds.bottom}
      aria-rowindex={r + 2}
      style={{ width: grid.totalWidth }}
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
          grid.setRowAnchor(first);
          grid.setAnchor({ rowId: first, columnId: columns[0].id });
          props.onActive({ rowId: row.id, columnId: columns.at(-1)!.id });
          props.select(row.id);
          grid.root.current?.focus();
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
      {grid.columnWindow.map((slot) => (
        <GridCell key={slot.column.id} grid={grid} props={props} row={row} r={r} slot={slot} />
      ))}
    </div>
  );
}

export function GridCellMenu({
  grid,
  props,
  context,
}: {
  grid: DataGridController;
  props: DataGridProps;
  context: { x: number; y: number };
}) {
  const { data, readOnly, apply } = props;
  const { selectedRows, selectedColumns, locked, setContext } = grid;
  return (
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
          grid.clear();
          setContext(null);
        }}
      >
        Clear range
      </button>
      <button
        role="menuitem"
        disabled={locked || selectedRows.length < 2}
        onClick={() => {
          grid.fill();
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
  );
}
