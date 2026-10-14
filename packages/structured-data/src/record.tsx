import { pinDataCommand } from './session';
import { useEffect, useState, useRef, useContext } from 'react';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { canonicalJson } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import { type StructuredData, type DataRow, displayCell, parseCell, validateData } from './model';
import { setCells } from './views';
import { ValueInput } from './grid';
import { type RecordDraft } from './record-draft';
export type { RecordDraft } from './record-draft';
export function RecordForm({
  data,
  row,
  readOnly,
  apply,
  select,
  onDone,
  drafts,
}: {
  data: StructuredData;
  row: DataRow;
  readOnly: boolean;
  apply: (cmd: EditorCommand<StructuredData>) => boolean;
  select: (columnId: string) => void;
  onDone?: () => void;
  drafts?: Map<string, RecordDraft>;
}) {
  const inputs = useContext(EditorInputsContext);
  const composing = useRef(false);
  const [base, setBase] = useState(drafts?.get(row.id)?.base ?? canonicalJson(row)),
    [draft, setDraft] = useState<Record<string, string>>(
      () =>
        drafts?.get(row.id)?.values ??
        Object.fromEntries(data.columns.map((c) => [c.id, displayCell(data, row, c)])),
    ),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState(''),
    [columnsBase, setColumnsBase] = useState(
      drafts?.get(row.id)?.columns ?? canonicalJson(data.columns),
    );
  const baseline = useRef(
    drafts?.get(row.id)?.baseline ??
      Object.fromEntries(data.columns.map((c) => [c.id, displayCell(data, row, c)])),
  );
  useEffect(() => {
    if (
      (base !== canonicalJson(row) || columnsBase !== canonicalJson(data.columns)) &&
      (canonicalJson(draft) === canonicalJson(baseline.current) ||
        data.columns.every((c) => draft[c.id] === displayCell(data, row, c)))
    ) {
      const values = Object.fromEntries(data.columns.map((c) => [c.id, displayCell(data, row, c)]));
      baseline.current = values;
      setDraft(values);
      setBase(canonicalJson(row));
      setColumnsBase(canonicalJson(data.columns));
    }
  }, [row, data, base, columnsBase, draft]);
  const next = {
      ...row,
      values: {
        ...row.values,
        ...Object.fromEntries(
          data.columns
            .filter((c) => c.type !== 'formula' && !c.readOnly)
            .map((c) => [c.id, parseCell(draft[c.id] ?? displayCell(data, row, c), c)]),
        ),
      },
    },
    errors = validateData({ ...data, rows: data.rows.map((r) => (r.id === row.id ? next : r)) }, [
      next,
    ]),
    changed = canonicalJson(row.values) !== canonicalJson(next.values);
  function retain(values = draft) {
    if (composing.current || canonicalJson(values) !== canonicalJson(baseline.current))
      drafts?.set(row.id, {
        base,
        values,
        columns: columnsBase,
        baseline: baseline.current,
        composing: composing.current,
      });
    else drafts?.delete(row.id);
    inputs?.changed();
  }
  function reset() {
    drafts?.delete(row.id);
    inputs?.changed();
    setDraft(Object.fromEntries(data.columns.map((c) => [c.id, displayCell(data, row, c)])));
    setSubmitted(false);
    setError('');
    setBase(canonicalJson(row));
    setColumnsBase(canonicalJson(data.columns));
    baseline.current = Object.fromEntries(
      data.columns.map((c) => [c.id, displayCell(data, row, c)]),
    );
  }
  return (
    <form
      className="ep-record-form"
      onCompositionStart={() => {
        composing.current = true;
        retain();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        retain();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly) return;
        if (composing.current) return;
        setSubmitted(true);
        if (errors.length) {
          document
            .getElementById(`field-${row.id}-${errors[0].columnId}`)
            ?.querySelector<HTMLElement>('input,select')
            ?.focus();
          return;
        }
        if (base !== canonicalJson(row) || columnsBase !== canonicalJson(data.columns)) {
          setError(
            'This record changed while the form was open. Cancel to reload its current values.',
          );
          return;
        }
        if (
          apply(
            pinDataCommand(
              setCells(
                data.columns
                  .filter((c) => c.type !== 'formula' && !c.readOnly)
                  .map((c) => ({ rowId: row.id, columnId: c.id, value: next.values[c.id] })),
                'Save record',
              ),
              { rowId: row.id, row: base, columns: columnsBase },
            ),
          )
        ) {
          setBase(canonicalJson(next));
          setColumnsBase(canonicalJson(data.columns));
          baseline.current = { ...draft };
          drafts?.delete(row.id);
          inputs?.changed();
          onDone?.();
        }
      }}
    >
      <h2>{String(row.values[data.columns[0]?.id] ?? 'Record')}</h2>
      <p className="ep-muted">
        {changed ? 'Unsaved form changes' : 'Values from the shared dataset'}
      </p>
      <div className="ep-record-fields">
        {data.columns.map((c) => (
          <label
            key={c.id}
            id={`field-${row.id}-${c.id}`}
            className="ep-field"
            onFocus={() => select(c.id)}
          >
            {c.name}
            {c.required ? ' *' : ''}
            <ValueInput
              data={{ ...data, rows: data.rows.map((r) => (r.id === row.id ? next : r)) }}
              row={next}
              column={c}
              value={draft[c.id] ?? ''}
              label={`Record ${c.name}`}
              readOnly={readOnly}
              onChange={(value) => {
                const next = { ...draft, [c.id]: value };
                retain(next);
                setDraft(next);
              }}
            />
            {submitted &&
              errors
                .filter((e) => e.columnId === c.id)
                .map((e) => (
                  <span key={e.message} className="ep-field-error">
                    {e.message}
                  </span>
                ))}
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="ep-error">
          {error}
        </p>
      )}
      <div className="ep-record-actions">
        <button type="submit" disabled={readOnly || !changed}>
          Save record
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            onDone?.();
          }}
        >
          Cancel changes
        </button>
      </div>
    </form>
  );
}
