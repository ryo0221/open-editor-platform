import { useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { downloadBlob } from '@editor-platform/canvas-ui';
import { prepareCsvExport, type CsvExportScope } from './csv-transfer';
import { type StructuredData } from './model';
import { type DataView } from './views';
export function CsvExportDialog({
  data,
  view,
  capture,
  name = 'records',
  onClose,
}: {
  data: StructuredData;
  view?: DataView;
  name?: string;
  capture(): { data: StructuredData; view?: DataView };
  onClose(): void;
}) {
  const [scope, setScope] = useState<CsvExportScope>({
    rowsScope: view ? 'filtered' : 'all',
    columnsScope: 'all',
  });
  const [error, setError] = useState('');
  const preview = prepareCsvExport(data, scope, view);
  return (
    <Dialog exportScope title="CSV export scope" onClose={onClose}>
      <label>
        Rows
        <select
          aria-label="CSV rows scope"
          value={scope.rowsScope}
          onChange={(event) =>
            setScope({ ...scope, rowsScope: event.target.value as CsvExportScope['rowsScope'] })
          }
        >
          <option value="all">All records</option>
          <option value="filtered" disabled={!view}>
            Filtered records
          </option>
        </select>
      </label>
      <label>
        Columns
        <select
          aria-label="CSV columns scope"
          value={scope.columnsScope}
          onChange={(event) =>
            setScope({
              ...scope,
              columnsScope: event.target.value as CsvExportScope['columnsScope'],
            })
          }
        >
          <option value="all">All fields (including hidden)</option>
          <option value="visible" disabled={!view}>
            Visible fields only
          </option>
        </select>
      </label>
      <p role="status">
        {preview.rowCount} records · {preview.columnCount} fields · {scope.rowsScope} rows /{' '}
        {scope.columnsScope} columns
      </p>
      <p>列順はデータの列順です。日本語・改行・引用符をUTF-8 / CRLFで出力します。</p>
      <button
        onClick={() => {
          try {
            const current = capture();
            const result = prepareCsvExport(current.data, scope, current.view);
            downloadBlob(`${name}.csv`, new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
            onClose();
          } catch (error) {
            setError(String(error instanceof Error ? error.message : error));
          }
        }}
      >
        Download CSV
      </button>
      <button onClick={onClose}>Cancel CSV export</button>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
