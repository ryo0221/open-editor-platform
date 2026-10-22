import { Plus, Columns3, Filter, Download, Upload, Save, Search } from 'lucide-react';
import { CommitInput, IconButton, Menu } from '@editor-platform/editor-ui';
import { type StructuredData } from './model';
import { type DataProjection, type DataView } from './views';
import { projectionChoices } from './view-model';
import { QuerySection } from './view-query';

export function DataStatus({
  data,
  view,
  patch,
  readOnly,
  visibleRows,
  visibleColumns,
}: {
  data: StructuredData;
  view: DataView;
  patch: (patch: Partial<DataView>) => void;
  readOnly: boolean;
  visibleRows: number;
  visibleColumns: number;
}) {
  return (
    <>
      <span>
        {visibleRows} / {data.rows.length} records · {visibleColumns} visible fields
      </span>
      <span className="ep-spacer" />
      {view.search || view.filters.length ? (
        <button onClick={() => patch({ search: '', filters: [] })}>Filtered · Clear</button>
      ) : (
        <span>All records</span>
      )}
      <span>{readOnly ? 'Read only' : view.projection}</span>
    </>
  );
}

export function DataToolbar({
  data,
  view,
  patch,
  readOnly,
  graph,
  rowCount,
  onRowCount,
  changeProjection,
  addRecords,
  onAddField,
  onSaveView,
  exportData,
  exportVisual,
  openCsv,
}: {
  data: StructuredData;
  view: DataView;
  patch: (patch: Partial<DataView>) => void;
  readOnly: boolean;
  graph: boolean;
  rowCount: number;
  onRowCount: (count: number) => void;
  changeProjection: (projection: DataProjection) => boolean;
  addRecords: (count: number) => void;
  onAddField: () => void;
  onSaveView: () => void;
  exportData: () => void;
  exportVisual: (format: 'svg' | 'png') => Promise<void>;
  openCsv: (file: File) => Promise<void>;
}) {
  return (
    <>
      <select
        aria-label="Data projection"
        value={view.projection}
        onChange={(e) => changeProjection(e.target.value as DataProjection)}
      >
        {projectionChoices(graph).map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <Menu label="Add records" icon={Plus}>
        <CommitInput
          label="Number of records"
          value={rowCount}
          type="number"
          min={1}
          max={5000}
          onCommit={(v) => onRowCount(Number(v))}
        />
        <button disabled={readOnly} onClick={() => addRecords(rowCount)}>
          Add {rowCount} record{rowCount === 1 ? '' : 's'}
        </button>
      </Menu>
      <IconButton icon={Columns3} label="Add field" disabled={readOnly} onClick={onAddField} />
      <Menu label="Sort and filter" icon={Filter}>
        <QuerySection data={data} view={view} patch={patch} />
      </Menu>
      <label className="ep-data-search">
        <Search size={16} />
        <input
          aria-label="Search records"
          placeholder="Search records"
          value={view.search}
          onChange={(e) => patch({ search: e.target.value })}
        />
      </label>
      <IconButton icon={Save} label="Save named view" disabled={readOnly} onClick={onSaveView} />
      <Menu label="Export data" icon={Download}>
        <button onClick={exportData}>Export CSV</button>
        {view.projection === 'Chart' && (
          <>
            <button onClick={() => void exportVisual('svg')}>Export chart SVG</button>
            <button onClick={() => void exportVisual('png')}>Export chart PNG</button>
          </>
        )}
      </Menu>
      <label className="ep-upload" title="Import CSV">
        <Upload size={19} />
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Import CSV file"
          disabled={readOnly}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openCsv(f);
            e.target.value = '';
          }}
        />
      </label>
    </>
  );
}
