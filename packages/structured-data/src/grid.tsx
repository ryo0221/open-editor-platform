import { deleteRows, pasteCells, tsv } from './views';
import { useDataGrid, type DataGridProps } from './grid-hooks';
import { handleGridKeyDown } from './grid-keys';
import { GridCellMenu, GridGroupRow, GridHeader, GridRow } from './grid-parts';
export type { CellAddress } from './grid-model';
export { ValueInput } from './grid-input';
export function DataGrid(props: DataGridProps) {
  const { data, rows, columns, view, onView, apply, onField, readOnly, onActive, onError } = props;
  const grid = useDataGrid(props);
  const { editing, selectedRows, selectedColumns, entries, start, end, totalWidth, context } = grid;
  return (
    <div
      className="ep-data-grid"
      role="grid"
      aria-label="Data grid"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 1}
      tabIndex={0}
      ref={grid.root}
      onScroll={(e) => {
        grid.setScroll(e.currentTarget.scrollTop);
        grid.setScrollLeft(e.currentTarget.scrollLeft);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        grid.setContext({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) =>
        handleGridKeyDown(e, {
          ...grid,
          editing: !!editing,
          readOnly,
          rows,
          columns,
          onError,
          onActive,
          deleteSelectedRows: () => apply(deleteRows(selectedRows)),
        })
      }
      onCopy={(e) => {
        if (editing) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', tsv(data, selectedRows, selectedColumns));
      }}
      onCut={(e) => {
        if (editing || grid.locked) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', tsv(data, selectedRows, selectedColumns));
        grid.clear();
      }}
      onPaste={(e) => {
        if (editing || readOnly) return;
        e.preventDefault();
        try {
          apply(
            pasteCells(
              data,
              grid.rowIds,
              grid.colIds,
              grid.ri,
              grid.ci,
              e.clipboardData.getData('text/plain'),
              !view.search && !view.filters.length && !view.sorts.length,
            ),
          );
        } catch (error) {
          onError((error as Error).message);
        }
      }}
    >
      <GridHeader grid={grid} view={view} onView={onView} onField={onField} />
      <div style={{ height: start * 36, width: totalWidth }} />
      {entries
        .slice(start, end)
        .map((entry) =>
          'group' in entry ? (
            <GridGroupRow
              key={`group:${entry.group}`}
              entry={entry}
              totalWidth={totalWidth}
              aggregate={view.summary.aggregate}
            />
          ) : (
            <GridRow key={entry.row.id} grid={grid} props={props} row={entry.row} r={entry.index} />
          ),
        )}
      <div style={{ height: (entries.length - end) * 36, width: totalWidth }} />
      {!rows.length && (
        <div className="ep-data-empty">No records. Add records or paste TSV into this grid.</div>
      )}
      {context && <GridCellMenu grid={grid} props={props} context={context} />}
    </div>
  );
}
