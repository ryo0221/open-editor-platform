import { useState } from 'react';
import { Dialog, T, useWording } from '@editor-platform/editor-ui';
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
  const t = useWording();
  const [error, setError] = useState('');
  const preview = prepareCsvExport(data, scope, view);
  return (
    <Dialog exportScope title="CSV export scope" onClose={onClose}>
      <label>
        <T>Rows</T>
        <select
          aria-label="CSV rows scope"
          value={scope.rowsScope}
          onChange={(event) =>
            setScope({ ...scope, rowsScope: event.target.value as CsvExportScope['rowsScope'] })
          }
        >
          <option value="all">{t('All records')}</option>
          <option value="filtered" disabled={!view}>
            {t('Filtered records')}
          </option>
        </select>
      </label>
      <label>
        <T>Columns</T>
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
          <option value="all">{t('All fields (including hidden)')}</option>
          <option value="visible" disabled={!view}>
            {t('Visible fields only')}
          </option>
        </select>
      </label>
      <p role="status">
        {t('{0} records', preview.rowCount)} · {t('{0} fields', preview.columnCount)} ·{' '}
        {t('{0} rows', t(scope.rowsScope))} / {t('{0} columns', t(scope.columnsScope))}
      </p>
      <p>{t('列順はデータの列順です。日本語・改行・引用符をUTF-8 / CRLFで出力します。')}</p>
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
        <T>Download CSV</T>
      </button>
      <button onClick={onClose}>
        <T>Cancel CSV export</T>
      </button>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
