import { type Region, type EditorCommand, type EditorInputs } from '@editor-platform/editor-core';
import { Dialog } from '@editor-platform/editor-ui';
import {
  addColumn,
  columnTypes,
  displayCell,
  parseCell,
  parseCsvText,
  removeColumn,
  validateData,
  type Column,
  type StructuredData,
} from './model';
import { deleteRows, updateColumn } from './views';
import { RecordForm, type RecordDraft } from './record';
import { FieldSettings } from './view-fields';
import { csvWithFormulaGuard, csvWithHeader, retypeCsvColumn } from './view-model';
import type { CsvImport } from './view-hooks';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;

export function DeletedRecordDrafts({
  data,
  drafts,
  inputs,
  onError,
}: {
  data: StructuredData;
  drafts: Map<string, RecordDraft>;
  inputs: EditorInputs | undefined;
  onError: (error: string) => void;
}) {
  return [...drafts]
    .filter(([id]) => !data.rows.some((row) => row.id === id))
    .map(([id, draft]) => (
      <details key={id}>
        <summary>削除されたレコードの未確定入力があります</summary>
        <textarea
          aria-label="Retained deleted record input"
          readOnly
          value={JSON.stringify(draft.values, null, 2)}
        />
        <button
          onClick={() => {
            drafts.delete(id);
            inputs?.changed();
            onError('');
          }}
        >
          Discard deleted record input
        </button>
      </details>
    ));
}

function NewFieldValueInput({
  newField,
  onNewField,
}: {
  newField: Column;
  onNewField: (field: Column) => void;
}) {
  return newField.type === 'formula' ? (
    <label className="ep-field">
      Formula
      <input
        aria-label="New field formula"
        value={newField.formula ?? ''}
        onChange={(e) => onNewField({ ...newField, formula: e.target.value })}
      />
    </label>
  ) : (
    <label className="ep-field">
      Default
      <input
        aria-label="New field default"
        value={String(newField.defaultValue ?? '')}
        onChange={(e) =>
          onNewField({ ...newField, defaultValue: parseCell(e.target.value, newField) })
        }
      />
    </label>
  );
}

export function AddFieldDialog({
  data,
  newField,
  onNewField,
  readOnly,
  error,
  onError,
  apply,
  onCreated,
  onClose,
}: {
  data: StructuredData;
  newField: Column;
  onNewField: (field: Column) => void;
  readOnly: boolean;
  error: string;
  onError: (error: string) => void;
  apply: Apply;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  function create() {
    const c = {
      ...newField,
      ...(newField.type === 'select' ? { options: (newField.options ?? []).filter(Boolean) } : {}),
    };
    const cmd = addColumn(c);
    try {
      const next = cmd.apply(data),
        errors = validateData(next).filter((v) => v.columnId === c.id);
      if (errors.length) {
        onError(errors[0].message);
        return;
      }
      if (apply(cmd)) onCreated(c.id);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <Dialog title="Add field" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label className="ep-field">
          Field name
          <input
            aria-label="New field name"
            value={newField.name}
            autoFocus
            onChange={(e) => onNewField({ ...newField, name: e.target.value })}
          />
        </label>
        <label className="ep-field">
          Type
          <select
            aria-label="New field type"
            value={newField.type}
            onChange={(e) => onNewField({ ...newField, type: e.target.value as Column['type'] })}
          >
            {columnTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <NewFieldValueInput newField={newField} onNewField={onNewField} />
        {newField.type === 'select' && (
          <label className="ep-field">
            Options
            <input
              aria-label="New field options"
              value={newField.options?.join(',') ?? ''}
              onChange={(e) =>
                onNewField({
                  ...newField,
                  options: e.target.value.split(',').map((s) => s.trim()),
                })
              }
            />
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={!!newField.required}
            onChange={(e) => onNewField({ ...newField, required: e.target.checked })}
          />{' '}
          Required
        </label>
        {error && <p className="ep-field-error">{error}</p>}
        <button disabled={!newField.name.trim() || readOnly}>Create field</button>
      </form>
    </Dialog>
  );
}

export function RecordDetailsDialog({
  data,
  rowId,
  drafts,
  readOnly,
  apply,
  select,
  onClose,
}: {
  data: StructuredData;
  rowId: string;
  drafts: Map<string, RecordDraft>;
  readOnly: boolean;
  apply: Apply;
  select: (id: string, region?: Region) => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="Record details" onClose={onClose}>
      <RecordForm
        key={rowId}
        drafts={drafts}
        data={data}
        row={data.rows.find((r) => r.id === rowId)!}
        readOnly={readOnly}
        apply={apply}
        select={(columnId) => select(rowId, { type: 'cell', columnId })}
        onDone={onClose}
      />
      <button
        disabled={readOnly}
        onClick={() => {
          if (apply(deleteRows([rowId]))) onClose();
        }}
      >
        Delete record
      </button>
    </Dialog>
  );
}

export function FieldDefinitionDialog({
  data,
  columnId,
  readOnly,
  apply,
  onClose,
}: {
  data: StructuredData;
  columnId: string;
  readOnly: boolean;
  apply: Apply;
  onClose: () => void;
}) {
  return (
    <Dialog title="データ定義 · Field settings" onClose={onClose}>
      <p>所有元: Structured Data · 値の編集はForm、項目名・型の編集はこの定義画面です。</p>
      <FieldSettings
        key={columnId}
        data={data}
        field={data.columns.find((column) => column.id === columnId)!}
        readOnly={readOnly}
        onSave={(field) => {
          if (!apply(updateColumn(field.id, field))) return false;
          onClose();
          return true;
        }}
        onDelete={() => {
          if (apply(removeColumn(columnId))) onClose();
        }}
      />
    </Dialog>
  );
}

function CsvColumnHeader({ data, imp, c }: { data: StructuredData; imp: CsvImport; c: Column }) {
  const { csv, csvAppend, appendPreview, csvTargets, setCsvTargets, setCsv, csvHeader } = imp;
  if (!csv) return null;
  const index = csv.data.columns.indexOf(c);
  const target = appendPreview?.columns[index];
  return (
    <th>
      {c.name}
      {csvAppend ? (
        <>
          <select
            aria-label={`Append target ${c.name}`}
            value={target?.id ?? ''}
            onChange={(event) =>
              setCsvTargets({
                ...csvTargets,
                [csv.data.columns.indexOf(c)]: event.target.value,
              })
            }
          >
            <option value="">Choose target field</option>
            {data.columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name} ({column.type})
              </option>
            ))}
          </select>
          {/* prettier-ignore */}
          <p>
            {target?.type} ·{' '}
            {target?.id} ·{' '}
            {target?.options?.join(', ')}
            {target?.type === 'relation' ? ' · existing record IDs' : ''}
          </p>
        </>
      ) : (
        <select
          aria-label={`Import type ${c.name}`}
          value={c.type}
          onChange={(e) =>
            setCsv(retypeCsvColumn(csv, c, e.target.value as Column['type'], csvHeader))
          }
        >
          {['text', 'number', 'boolean', 'date'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      )}
    </th>
  );
}

function CsvPreviewTable({ data, imp }: { data: StructuredData; imp: CsvImport }) {
  const { csv, csvAppend, csvHeader } = imp;
  if (!csv) return null;
  return (
    <div className="ep-csv-preview">
      <table>
        <thead>
          <tr>
            {csv.data.columns.map((c) => (
              <CsvColumnHeader key={c.id} data={data} imp={imp} c={c} />
            ))}
          </tr>
        </thead>
        <tbody>
          {csv.data.rows.slice(0, 8).map((r) => (
            <tr key={r.id}>
              {csv.data.columns.map((c) => (
                <td key={c.id}>
                  {csvAppend
                    ? parseCsvText(csv.source, csv)[
                        csv.data.rows.indexOf(r) + (csvHeader ? 1 : 0)
                      ]?.[csv.data.columns.indexOf(c)]
                    : displayCell(csv.data, r, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CsvImportDialog({
  data,
  imp,
  readOnly,
  error,
  onCommit,
}: {
  data: StructuredData;
  imp: CsvImport;
  readOnly: boolean;
  error: string;
  onCommit: () => void;
}) {
  const { csv, setCsv, csvHeader, setCsvHeader, csvAppend, setCsvAppend, csvErrors } = imp;
  if (!csv) return null;
  return (
    <Dialog title="CSV import preview" onClose={() => setCsv(null)}>
      <p>
        {csv.name} · UTF-8 · {csv.data.rows.length} records · CRLF/LF supported
      </p>
      <label>
        <input
          type="checkbox"
          checked={csvHeader}
          onChange={(e) => {
            const header = e.target.checked;
            setCsvHeader(header);
            setCsv(csvWithHeader(csv, header));
          }}
        />{' '}
        First row is a header
      </label>
      <label>
        <input
          type="checkbox"
          checked={csv.decodeFormulaGuard ?? false}
          onChange={(e) => setCsv(csvWithFormulaGuard(csv, e.target.checked, csvHeader))}
        />{' '}
        Restore formula-like text from this editor’s CSV export
      </label>
      <p>
        Enable only for an unchanged export from this editor. Other CSV files keep apostrophes as
        written.
      </p>
      <label>
        <input
          type="checkbox"
          checked={csvAppend}
          onChange={(e) => setCsvAppend(e.target.checked)}
        />{' '}
        Append to matching fields
      </label>
      <CsvPreviewTable data={data} imp={imp} />
      {csvErrors.length > 0 && (
        <div className="ep-field-error" role="status">
          {csvErrors.length} invalid values in the preview.
          <ul>
            {csvErrors.map((error, index) => (
              <li key={index}>
                Row {error.row}, field {error.column} {error.name} · value{' '}
                {JSON.stringify(error.raw)}: {error.message}. CSVまたは列対応を修正してください。
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="ep-field-error">{error}</p>}
      <p>
        {csvAppend
          ? 'Existing records are retained.'
          : 'All current rows and fields will be replaced; Undo restores them.'}
      </p>
      <button disabled={readOnly || csvErrors.length > 0} onClick={onCommit}>
        Import records
      </button>
    </Dialog>
  );
}
