import { useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import { columnTypes, parseCell, type StructuredData, type Column } from './model';
import { previewColumn, readableFormula, type ChartConfig, type AggregateFunction } from './views';
import { aggregates } from './view-model';

export function Pick({
  label,
  value,
  onChange,
  columns,
  empty = 'None',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  columns: Column[];
  empty?: string;
}) {
  return (
    <label className="ep-field">
      {label}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ChartSettings({
  data,
  value,
  onChange,
}: {
  data: StructuredData;
  value: ChartConfig;
  onChange: (value: ChartConfig) => void;
}) {
  const patch = (p: Partial<ChartConfig>) => onChange({ ...value, ...p });
  return (
    <>
      <label className="ep-field">
        Chart type
        <select
          aria-label="Chart type"
          value={value.type}
          onChange={(e) => patch({ type: e.target.value as ChartConfig['type'] })}
        >
          {['bar', 'line', 'pie'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <Pick label="X field" value={value.x} columns={data.columns} onChange={(x) => patch({ x })} />
      <Pick
        label="Y field"
        value={value.y}
        columns={data.columns.filter((c) => c.type === 'number' || c.type === 'formula')}
        onChange={(y) => patch({ y })}
      />
      <Pick
        label="Series field"
        value={value.series ?? ''}
        columns={data.columns.filter((c) => ['text', 'select', 'boolean'].includes(c.type))}
        onChange={(series) => patch({ series })}
      />
      <label className="ep-field">
        Aggregation
        <select
          aria-label="Chart aggregation"
          value={value.aggregate}
          onChange={(e) => patch({ aggregate: e.target.value as AggregateFunction })}
        >
          {aggregates.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="ep-field">
        Chart order
        <select
          aria-label="Chart order"
          value={value.sort}
          onChange={(e) => patch({ sort: e.target.value as ChartConfig['sort'] })}
        >
          {['label', 'ascending', 'descending'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="ep-field">
        Axis format
        <select
          aria-label="Axis format"
          value={value.format}
          onChange={(e) => patch({ format: e.target.value as ChartConfig['format'] })}
        >
          {['number', 'currency', 'percent'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.legend}
          onChange={(e) => patch({ legend: e.target.checked })}
        />{' '}
        Show legend
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.labels}
          onChange={(e) => patch({ labels: e.target.checked })}
        />{' '}
        Show values
      </label>
    </>
  );
}

const isDecimalPlaces = (value: string) =>
  !!value.trim() && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 8;

function fieldPreview(
  data: StructuredData,
  field: Column,
  draft: Column,
  decimalError: string,
): { preview?: ReturnType<typeof previewColumn>; error: string } {
  try {
    if (decimalError) throw new Error(decimalError);
    return { preview: previewColumn(data, field.id, draft), error: '' };
  } catch (e) {
    return { preview: undefined, error: (e as Error).message };
  }
}

function useFieldSettingsDraft({
  data,
  field,
  onSave,
  readOnly,
}: {
  data: StructuredData;
  field: Column;
  onSave: (field: Column) => boolean;
  readOnly: boolean;
}) {
  const root = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const [composition, setComposition] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [draft, setDraft] = useState<Column>(() => ({
    ...field,
    formula: field.formula ? readableFormula(data, field.formula) : '',
  }));
  const baseline = useRef(canonicalJson(draft));
  const [decimalDraft, setDecimalDraft] = useState(String(field.decimals ?? 2));
  const baselineDecimals = useRef(decimalDraft);
  const decimalInput = useRef<HTMLInputElement>(null);
  const decimalError =
    ['number', 'formula'].includes(draft.type) && !isDecimalPlaces(decimalDraft)
      ? 'Decimal placesは0から8までの整数を入力してください。'
      : '';
  const original = useRef(canonicalJson(field));
  const patch = (v: Partial<Column>) => {
    setSubmitError('');
    setDraft({ ...draft, ...v });
  };
  const { preview, error } = fieldPreview(data, field, draft, decimalError);
  function prepare() {
    if (readOnly) throw new Error('このHostでは項目定義を編集できません。');
    if (canonicalJson(field) !== original.current)
      throw new Error('項目定義が変更されました。入力を保持して現在の定義を確認してください。');
    if (error || !preview || preview.errors.length)
      throw new Error(error || preview?.errors[0]?.message || '変換プレビューを確認してください。');
    const converted = preview.content.columns.find((column) => column.id === field.id)!;
    return () => {
      if (!onSave(draft)) return false;
      baseline.current = canonicalJson(draft);
      baselineDecimals.current = decimalDraft;
      original.current = canonicalJson(converted);
    };
  }
  useEditorInput({
    label: `項目定義 ${field.name}`,
    read: () => ({
      dirty: canonicalJson(draft) !== baseline.current || decimalDraft !== baselineDecimals.current,
      composing: composing.current,
    }),
    prepare,
    focus: () => {
      if (decimalError) decimalInput.current?.focus();
      else root.current?.querySelector<HTMLElement>('input,select')?.focus();
    },
  });
  function setComposing(value: boolean) {
    composing.current = value;
    setComposition(value);
  }
  function submit() {
    if (!composition && !error && !preview?.errors.length) {
      try {
        if (prepare()() === false)
          setSubmitError('Hostが定義変更を拒否しました。入力を保持しています。');
      } catch (error) {
        setSubmitError(String(error instanceof Error ? error.message : error));
      }
    }
  }
  function changeDecimals(value: string) {
    setDecimalDraft(value);
    setSubmitError('');
    if (isDecimalPlaces(value)) patch({ decimals: Number(value) });
  }
  return {
    root,
    draft,
    patch,
    preview,
    error,
    submitError,
    decimalDraft,
    decimalInput,
    setComposing,
    submit,
    changeDecimals,
  };
}
type FieldDraft = ReturnType<typeof useFieldSettingsDraft>;

function FieldValueSettings({ data, f }: { data: StructuredData; f: FieldDraft }) {
  const { draft, patch } = f;
  return draft.type === 'formula' ? (
    <>
      <label className="ep-field">
        Formula
        <textarea
          aria-label="Field formula"
          value={draft.formula ?? ''}
          onChange={(e) => patch({ formula: e.target.value })}
        />
      </label>
      <Pick
        label="Insert formula reference"
        columns={data.columns.filter((c) => c.id !== draft.id)}
        value=""
        onChange={(id) => {
          const c = data.columns.find((c) => c.id === id);
          if (c) patch({ formula: (draft.formula ?? '') + `[${c.name}]` });
        }}
      />
    </>
  ) : (
    <label className="ep-field">
      Default value
      <input
        aria-label="Field default"
        value={String(draft.defaultValue ?? '')}
        onChange={(e) => patch({ defaultValue: parseCell(e.target.value, draft) })}
      />
    </label>
  );
}

function NumberFormatSettings({ f }: { f: FieldDraft }) {
  const { draft, patch } = f;
  return (
    <>
      <label className="ep-field">
        Number format
        <select
          aria-label="Number format"
          value={draft.format ?? ''}
          onChange={(e) => patch({ format: e.target.value as Column['format'] })}
        >
          <option value="">General</option>
          <option value="decimal">Decimal</option>
          <option value="currency">Currency</option>
          <option value="percent">Percent</option>
        </select>
      </label>
      <label className="ep-field">
        Decimal places
        <input
          ref={f.decimalInput}
          aria-label="Decimal places"
          value={f.decimalDraft}
          type="number"
          min={0}
          max={8}
          step={1}
          onChange={(event) => f.changeDecimals(event.target.value)}
        />
      </label>
      {draft.format === 'currency' && (
        <label className="ep-field">
          Currency
          <select
            aria-label="Currency"
            value={draft.currency ?? 'USD'}
            onChange={(e) => patch({ currency: e.target.value })}
          >
            {['USD', 'JPY', 'EUR', 'GBP'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function FieldPreviewMessages({ f }: { f: FieldDraft }) {
  const { error, submitError, preview } = f;
  return (
    <>
      {error && <p className="ep-field-error">{error}</p>}
      {submitError && <p role="alert">{submitError}</p>}
      {preview && (
        <p className="ep-muted">
          {preview.changed} values will convert · {preview.errors.length} invalid records
        </p>
      )}
      {preview?.errors.slice(0, 5).map((e) => (
        <p className="ep-field-error" key={e.rowId}>
          {e.message}
        </p>
      ))}
    </>
  );
}

export function FieldSettings({
  data,
  field,
  onSave,
  onDelete,
  readOnly,
}: {
  data: StructuredData;
  field: Column;
  onSave: (field: Column) => boolean;
  onDelete: () => void;
  readOnly: boolean;
}) {
  const f = useFieldSettingsDraft({ data, field, onSave, readOnly });
  const { draft, patch, error, preview } = f;
  return (
    <form
      ref={f.root}
      onCompositionStart={() => f.setComposing(true)}
      onCompositionEnd={() => f.setComposing(false)}
      onSubmit={(e) => {
        e.preventDefault();
        f.submit();
      }}
    >
      <fieldset disabled={readOnly}>
        <label className="ep-field">
          Field name
          <input
            aria-label="Field name"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label className="ep-field">
          Field type
          <select
            aria-label="Field type"
            value={draft.type}
            onChange={(e) => patch({ type: e.target.value as Column['type'] })}
          >
            {columnTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={!!draft.required}
            onChange={(e) => patch({ required: e.target.checked })}
          />{' '}
          Required field
        </label>
        <label>
          <input
            type="checkbox"
            checked={!!draft.readOnly}
            onChange={(e) => patch({ readOnly: e.target.checked })}
          />{' '}
          Read only field
        </label>
        {draft.type === 'select' && (
          <label className="ep-field">
            Options (one per line)
            <textarea
              aria-label="Field options"
              rows={5}
              value={draft.options?.join('\n') ?? ''}
              onChange={(e) => patch({ options: e.target.value.split('\n') })}
            />
          </label>
        )}
        <FieldValueSettings data={data} f={f} />
        {['number', 'formula'].includes(draft.type) && <NumberFormatSettings f={f} />}
        <FieldPreviewMessages f={f} />
        <button disabled={!!error || !!preview?.errors.length} type="submit">
          Apply field settings
        </button>
        <button type="button" onClick={onDelete}>
          Delete field
        </button>
      </fieldset>
    </form>
  );
}
