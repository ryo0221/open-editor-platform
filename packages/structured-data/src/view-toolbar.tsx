import { Plus, Columns3, Filter, Download, Upload, Save, Search } from 'lucide-react';
import { CommitInput, IconButton, Menu, T, useWording } from '@editor-platform/editor-ui';
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
  const wording = useWording();
  return (
    <>
      <span>
        {wording('{0} / {1} records', visibleRows, data.rows.length)} ·{' '}
        {wording('{0} visible fields', visibleColumns)}
      </span>
      <span className="ep-spacer" />
      {view.search || view.filters.length ? (
        <button onClick={() => patch({ search: '', filters: [] })}>
          <T>Filtered · Clear</T>
        </button>
      ) : (
        <span>
          <T>All records</T>
        </span>
      )}
      <span>{wording(readOnly ? 'Read only' : view.projection)}</span>
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
  const wording = useWording();
  return (
    <>
      <select
        aria-label="Data projection"
        value={view.projection}
        onChange={(e) => changeProjection(e.target.value as DataProjection)}
      >
        {projectionChoices(graph).map((p) => (
          <option key={p} value={p}>
            {wording(p)}
          </option>
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
          {wording(rowCount === 1 ? 'Add {0} record' : 'Add {0} records', rowCount)}
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
          placeholder={wording('Search records')}
          value={view.search}
          onChange={(e) => patch({ search: e.target.value })}
        />
      </label>
      <IconButton icon={Save} label="Save named view" disabled={readOnly} onClick={onSaveView} />
      <Menu label="Export data" icon={Download}>
        <button onClick={exportData}>
          <T>Export CSV</T>
        </button>
        {view.projection === 'Chart' && (
          <>
            <button onClick={() => void exportVisual('svg')}>
              <T>Export chart SVG</T>
            </button>
            <button onClick={() => void exportVisual('png')}>
              <T>Export chart PNG</T>
            </button>
          </>
        )}
      </Menu>
      <label className="ep-upload" title={wording('Import CSV')}>
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
