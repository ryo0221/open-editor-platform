import { guardDataCommand } from './session';
import { prepareRecordDrafts, RecordDraftError } from './record-draft';
import { useContext } from 'react';
import { EditorExportGuardContext, EditorInputsContext } from '@editor-platform/editor-ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Plus,
  Columns3,
  Filter,
  Download,
  Upload,
  Save,
  ChevronLeft,
  ChevronRight,
  Trash2,
  ArrowUp,
  Search,
} from 'lucide-react';
import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand, type Region } from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Menu,
  Section,
  CommitInput,
  Dialog,
  useEditorInput,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import { downloadBlob, rasterizeSvg } from '@editor-platform/canvas-ui';
import {
  addColumn,
  makeRow,
  removeColumn,
  columnTypes,
  displayCell,
  parseCell,
  validateData,
  importCsv,
  parseCsvText,
  pruneViewFields,
  type StructuredData,
  type Column,
} from './model';
import {
  defaultView,
  reconcileDataView,
  viewRows,
  summarize,
  formatCell,
  saveView,
  setCells,
  insertRows,
  deleteRows,
  reorderRow,
  reorderColumn,
  updateColumn,
  previewColumn,
  readableFormula,
  type DataView,
  type DataProjection,
  type ChartConfig,
  type AggregateFunction,
} from './views';
import { DataGrid, type CellAddress } from './grid';
import { RecordForm, type RecordDraft } from './record';
import { Timeline } from './timeline';
import { chartSvg } from './charts';
import { DataChart } from './chart-view';
import { CsvExportDialog } from './csv-export-ui';
import { previewCsvAppend } from './csv-transfer';
import './styles.css';
export type { DataProjection } from './views';
const projections: DataProjection[] = [
  'Grid',
  'Form',
  'Kanban',
  'Chart',
  'Dashboard',
  'Timeline',
  'Roadmap',
  'Summary',
];
const aggregates: AggregateFunction[] = ['sum', 'average', 'count', 'min', 'max'];
export interface DataSurfaceProps {
  content: StructuredData;
  execute: (c: EditorCommand<StructuredData>) => void | boolean;
  /** Optional independent projection; Data owns records, commands and history. */
  initialView?: DataView;
  onViewChange?: (view: DataView) => void;
  onViewDraftChange?: (state: { dirty: boolean; canUndo: boolean; canRedo: boolean }) => void;
  renderGraph?: (props: {
    content: StructuredData;
    execute: (c: EditorCommand<StructuredData>) => void | boolean;
    select: (id: string, region?: Region) => void;
    readOnly: boolean;
    visibleRowIds: string[];
    openSource: (rowId?: string) => void;
    openDefinition: (columnId?: string) => void;
  }) => ReactNode;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  layout?: Pick<EditorLayoutProps, 'viewKey' | 'panels' | 'defaultPanels' | 'onPanelsChange'>;
}
function Pick({
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
function ChartSettings({
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
function FieldSettings({
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
    ['number', 'formula'].includes(draft.type) &&
    (!decimalDraft.trim() ||
      !Number.isInteger(Number(decimalDraft)) ||
      Number(decimalDraft) < 0 ||
      Number(decimalDraft) > 8)
      ? 'Decimal placesは0から8までの整数を入力してください。'
      : '';
  const original = useRef(canonicalJson(field));
  const patch = (v: Partial<Column>) => {
    setSubmitError('');
    setDraft({ ...draft, ...v });
  };
  let preview: ReturnType<typeof previewColumn> | undefined,
    error = '';
  try {
    if (decimalError) throw new Error(decimalError);
    preview = previewColumn(data, field.id, draft);
  } catch (e) {
    error = (e as Error).message;
  }
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
  return (
    <form
      ref={root}
      onCompositionStart={() => {
        composing.current = true;
        setComposition(true);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setComposition(false);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!composition && !error && !preview?.errors.length) {
          try {
            if (prepare()() === false)
              setSubmitError('Hostが定義変更を拒否しました。入力を保持しています。');
          } catch (error) {
            setSubmitError(String(error instanceof Error ? error.message : error));
          }
        }
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
        {draft.type === 'formula' ? (
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
        )}
        {['number', 'formula'].includes(draft.type) && (
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
                ref={decimalInput}
                aria-label="Decimal places"
                value={decimalDraft}
                type="number"
                min={0}
                max={8}
                step={1}
                onChange={(event) => {
                  const value = event.target.value;
                  setDecimalDraft(value);
                  setSubmitError('');
                  if (
                    value.trim() &&
                    Number.isInteger(Number(value)) &&
                    Number(value) >= 0 &&
                    Number(value) <= 8
                  )
                    patch({ decimals: Number(value) });
                }}
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
        )}
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
export function DataSurface({
  content: data,
  execute,
  select,
  readOnly = false,
  layout,
  renderGraph,
  initialView,
  onViewChange,
  onViewDraftChange,
}: DataSurfaceProps) {
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const formDrafts = useRef(new Map<string, RecordDraft>());
  const [view, setView] = useState<DataView>(() =>
      initialView
        ? pruneViewFields(
            clone(initialView),
            data.columns.map((column) => column.id),
          )
        : data.views?.[0]
          ? clone(data.views[0])
          : defaultView(data),
    ),
    [active, setActive] = useState<CellAddress | null>(null),
    [fieldId, setFieldId] = useState(''),
    [fieldDialog, setFieldDialog] = useState(''),
    [error, setError] = useState(''),
    [addField, setAddField] = useState(false),
    [newField, setNewField] = useState<Column>(() => ({
      id: newId('col'),
      name: '',
      type: 'text',
    })),
    [rowCount, setRowCount] = useState(1),
    [recordDialog, setRecordDialog] = useState<string | null>(null),
    [csv, setCsv] = useState<{ source: string; data: StructuredData; name: string } | null>(null),
    [csvAppend, setCsvAppend] = useState(true),
    [csvHeader, setCsvHeader] = useState(true),
    [widgetId, setWidgetId] = useState('');
  const [csvExport, setCsvExport] = useState(false);
  const [csvTargets, setCsvTargets] = useState<Record<number, string>>({});
  const current = useRef({ data, view });
  current.current = { data, view };
  const viewEdit = useRef<{ base: DataView; past: DataView[]; future: DataView[] }>({
    base: clone(view),
    past: [],
    future: [],
  });
  const columnSignature = data.columns.map((column) => column.id).join('\0');
  const previousViews = useRef(data.views);
  useEffect(() => {
    const old = previousViews.current;
    previousViews.current = data.views;
    setView((current) => {
      const previous = old?.find((view) => view.id === current.id);
      const updated = reconcileDataView(
        current,
        previous,
        data.views?.find((view) => view.id === current.id),
      );
      if (
        previous &&
        canonicalJson(current.widgets) === canonicalJson(previous.widgets) &&
        canonicalJson(updated.widgets) !== canonicalJson(current.widgets)
      )
        viewEdit.current = { base: clone(updated), past: [], future: [] };
      return updated;
    });
  }, [data.views]);
  useEffect(() => {
    setView((current) =>
      pruneViewFields(
        current,
        data.columns.map((column) => column.id),
      ),
    );
  }, [columnSignature]);
  const appendPreview = useMemo(
    () =>
      csv && csvAppend
        ? previewCsvAppend(
            data,
            csv.source,
            csvHeader,
            csvTargets,
            csv.data.rows.map((row) => row.id),
          )
        : undefined,
    [data, csv, csvAppend, csvHeader, csvTargets],
  );
  const csvErrors = useMemo(
    () =>
      appendPreview
        ? appendPreview.diagnostics
        : csv
          ? validateData(csv.data).map((error) => ({
              row: csv.data.rows.findIndex((row) => row.id === error.rowId) + (csvHeader ? 2 : 1),
              column: csv.data.columns.findIndex((column) => column.id === error.columnId) + 1,
              name: csv.data.columns.find((column) => column.id === error.columnId)?.name ?? '',
              raw: String(
                csv.data.rows.find((row) => row.id === error.rowId)?.values[error.columnId] ?? '',
              ),
              message: error.message,
            }))
          : [],
    [appendPreview, csv, csvHeader],
  );
  const viewDirty = canonicalJson(view.widgets) !== canonicalJson(viewEdit.current.base.widgets);
  const patch = (patch: Partial<DataView>) => {
    if (
      patch.widgets &&
      canonicalJson(patch.widgets) !== canonicalJson(current.current.view.widgets)
    ) {
      viewEdit.current.past.push(clone(current.current.view));
      viewEdit.current.past = viewEdit.current.past.slice(-100);
      viewEdit.current.future = [];
    }
    const next = { ...current.current.view, ...patch };
    current.current.view = next;
    setView(next);
  };
  function viewHistory(direction: 'undo' | 'redo') {
    const source = direction === 'undo' ? viewEdit.current.past : viewEdit.current.future;
    const target = direction === 'undo' ? viewEdit.current.future : viewEdit.current.past;
    const next = source.pop();
    if (!next) return false;
    target.push(clone(current.current.view));
    current.current.view = { ...current.current.view, widgets: clone(next.widgets) };
    setView(current.current.view);
    return true;
  }
  function acceptViewDraft(next: DataView) {
    viewEdit.current = { base: clone(next), past: [], future: [] };
  }
  useEditorInput({
    label: 'Dashboardの未保存ビュー',
    read: () => ({
      dirty:
        canonicalJson(current.current.view.widgets) !==
        canonicalJson(viewEdit.current.base.widgets),
      canUndo: !!viewEdit.current.past.length,
      canRedo: !!viewEdit.current.future.length,
    }),
    prepare: () => {
      if (readOnly)
        throw new Error('ビューを編集できません。破棄または編集権限を確認してください。');
      const fixed = clone(current.current.view);
      return () => {
        if (!apply(saveView(fixed))) return false;
        acceptViewDraft(fixed);
      };
    },
    history: viewHistory,
    focus: () => document.querySelector<HTMLButtonElement>('[data-view-draft]')?.focus(),
  });
  useEffect(() => {
    onViewChange?.(clone(view));
  }, [view, onViewChange]);
  useEffect(() => {
    onViewDraftChange?.({
      dirty: viewDirty,
      canUndo: !!viewEdit.current.past.length,
      canRedo: !!viewEdit.current.future.length,
    });
  }, [view, viewDirty, onViewDraftChange]);
  const rows = useMemo(() => viewRows(data, view), [data, view]),
    columns = data.columns.filter((c) => !view.hidden.includes(c.id)),
    field = data.columns.find((c) => c.id === fieldId),
    record = data.rows.find((r) => r.id === active?.rowId) ?? rows[0],
    recordIndex = record ? rows.findIndex((r) => r.id === record.id) : -1,
    groupColumn = data.columns.find(
      (c) => c.id === (view.groupBy || data.columns.find((c) => c.type === 'select')?.id),
    ),
    widget = view.widgets.find((w) => w.id === widgetId),
    numeric = data.columns.filter((c) => ['number', 'formula'].includes(c.type)),
    dates = data.columns.filter((c) => c.type === 'date');
  function apply(cmd: EditorCommand<StructuredData>) {
    if (readOnly) {
      setError('This surface is read only');
      return false;
    }
    try {
      const guarded = guardDataCommand(cmd, () => !readOnly);
      guarded.apply(data);
      if (execute(guarded) === false) return false;
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  function focusRow(id: string) {
    if ([...formDrafts.current.values()].some((draft) => draft.composing)) {
      setError('入力変換を確定してから別のレコードを選択してください。');
      return;
    }
    setActive({ rowId: id, columnId: active?.columnId ?? columns[0]?.id ?? '' });
    select(id);
  }
  const invalidRecord = useRef<string | undefined>(undefined);
  useEditorInput({
    label: 'Data Form',
    read: () => ({
      dirty: formDrafts.current.size > 0,
      composing: [...formDrafts.current.values()].some((draft) => draft.composing),
    }),
    prepare: () => {
      if (readOnly) throw new Error('このHostではデータを編集できません。');
      const snapshot = new Map(formDrafts.current);
      let edit: EditorCommand<StructuredData>;
      try {
        edit = prepareRecordDrafts(data, snapshot);
      } catch (error) {
        invalidRecord.current = error instanceof RecordDraftError ? error.rowId : undefined;
        throw error;
      }
      return () => {
        if (!apply(edit)) return false;
        formDrafts.current.clear();
      };
    },
    focus: () => {
      const id = invalidRecord.current ?? formDrafts.current.keys().next().value;
      if (id) {
        // Failure recovery must reveal the buffer without recursively flushing it.
        patch({ projection: 'Form' });
        focusRow(id);
        setTimeout(
          () =>
            document
              .querySelector<HTMLElement>('.ep-record-form input, .ep-record-form select')
              ?.focus(),
          0,
        );
      }
    },
  });
  function addRecords(count: number) {
    const created = Array.from({ length: count }, () => makeRow(data));
    if (apply(insertRows(created)) && created[0]) focusRow(created[0].id);
  }
  function changeProjection(projection: DataProjection) {
    try {
      inputs?.flush();
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
      return false;
    }
    patch({ projection });
    setFieldId('');
    setWidgetId('');
    return true;
  }
  const groupNames = groupColumn
    ? [
        ...new Set([
          ...(groupColumn.options ?? []),
          ...rows.map((r) => displayCell(data, r, groupColumn) || '(empty)'),
          '(empty)',
        ]),
      ]
    : ['All records'];
  const groupRows = (name: string) =>
    rows.filter(
      (r) =>
        (groupColumn ? displayCell(data, r, groupColumn) || '(empty)' : 'All records') === name,
    );
  async function exportVisual(format: 'svg' | 'png') {
    try {
      guardExport?.();
      const snapshot = current.current;
      const source = chartSvg(
        snapshot.data,
        viewRows(snapshot.data, snapshot.view),
        snapshot.view.chart,
        900,
        430,
        snapshot.view.accent,
      );
      downloadBlob(
        `data-chart.${format}`,
        format === 'svg'
          ? new Blob([source], { type: 'image/svg+xml' })
          : new Blob([(await rasterizeSvg(source, 900, 430)) as Uint8Array<ArrayBuffer>], {
              type: 'image/png',
            }),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function exportData() {
    try {
      guardExport?.();
      inputs?.flush();
      setCsvExport(true);
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    }
  }
  async function openCsv(file: File) {
    try {
      if (file.size > 16_000_000) throw new Error('Use a CSV smaller than 16 MB');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      setCsv({ source, data: importCsv(source), name: file.name });
      setCsvTargets({});
      setCsvHeader(true);
      setCsvAppend(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function commitCsv() {
    if (!csv) return;
    if (csvAppend) {
      const preview = previewCsvAppend(
        data,
        csv.source,
        csvHeader,
        csvTargets,
        csv.data.rows.map((row) => row.id),
      );
      if (preview.diagnostics.length) {
        setError('Resolve all row/field diagnostics before importing');
        return;
      }
      const added = preview.rows;
      if (apply(insertRows(added))) setCsv(null);
    } else {
      const next = clone(csv.data);
      if (validateData(next).length) {
        setError('Resolve the import validation errors first');
        return;
      }
      if (apply(command('data.import-csv', 'Replace dataset from CSV', () => next))) {
        setView(defaultView(next));
        setActive(null);
        setCsv(null);
      }
    }
  }
  const left = (
    <>
      <Section title="Projections">
        {[...projections, ...(renderGraph ? ['Graph' as const] : [])].map((p) => (
          <button
            key={p}
            className={`ep-view-item ${view.projection === p ? 'active' : ''}`}
            onClick={() => changeProjection(p)}
          >
            {p}
          </button>
        ))}
      </Section>
      <Section title="Named views">
        {(data.views ?? []).map((v) => (
          <button
            className="ep-view-item"
            key={v.id}
            onClick={() => {
              try {
                inputs?.flush();
              } catch (error) {
                setError(String(error));
                return;
              }
              acceptViewDraft(v);
              setView(clone(v));
              setFieldId('');
            }}
          >
            {v.name}
          </button>
        ))}
        <CommitInput label="View name" value={view.name} onCommit={(name) => patch({ name })} />
        <CommitInput
          label="View accent"
          type="color"
          value={view.accent ?? '#5269c8'}
          onCommit={(accent) => patch({ accent })}
        />
        <div className="ep-inline">
          <button
            disabled={readOnly || !view.name.trim()}
            onClick={() => {
              if (apply(saveView(view))) acceptViewDraft(view);
            }}
          >
            Save view
          </button>
          <button
            disabled={readOnly}
            onClick={() => {
              const next = { ...clone(view), id: newId('view'), name: `${view.name} copy` };
              if (apply(saveView(next))) {
                acceptViewDraft(next);
                setView(next);
              }
            }}
          >
            Save as
          </button>
        </div>
      </Section>
      {(viewDirty || viewEdit.current.past.length > 0 || viewEdit.current.future.length > 0) && (
        <Section title="Unsaved view changes">
          <p role="status">
            {viewDirty
              ? 'Dashboard構成が未保存です。保存/閉じる時は名前付きビューへ確定します。'
              : 'ビュー編集を取り消しました。'}
          </p>
          <button
            data-view-draft
            disabled={!viewEdit.current.past.length}
            onClick={() => viewHistory('undo')}
          >
            Undo view edit
          </button>
          <button disabled={!viewEdit.current.future.length} onClick={() => viewHistory('redo')}>
            Redo view edit
          </button>
          <button
            onClick={() => {
              const next = { ...view, widgets: clone(viewEdit.current.base.widgets) };
              acceptViewDraft(next);
              setView(next);
            }}
          >
            Discard view changes
          </button>
        </Section>
      )}
      <Section title="Fields">
        {data.columns.map((c, i) => (
          <div className="ep-field-row" key={c.id}>
            <button className={fieldId === c.id ? 'active' : ''} onClick={() => setFieldId(c.id)}>
              {c.name}
            </button>
            <button
              aria-label={`Hide ${c.name}`}
              aria-pressed={view.hidden.includes(c.id)}
              onClick={() =>
                patch({
                  hidden: view.hidden.includes(c.id)
                    ? view.hidden.filter((id) => id !== c.id)
                    : [...view.hidden, c.id],
                })
              }
            >
              {view.hidden.includes(c.id) ? 'Show' : 'Hide'}
            </button>
            <IconButton
              icon={ArrowUp}
              label={`Move ${c.name} left`}
              disabled={readOnly || i === 0}
              onClick={() => apply(reorderColumn(c.id, data.columns[i - 1]?.id ?? null))}
            />
          </div>
        ))}
      </Section>
    </>
  );
  const query = (
    <>
      <Section title="Filter and sort">
        <label className="ep-field">
          Match
          <select
            aria-label="Filter combination"
            value={view.filterMode}
            onChange={(e) => patch({ filterMode: e.target.value as 'and' | 'or' })}
          >
            <option value="and">All conditions (AND)</option>
            <option value="or">Any condition (OR)</option>
          </select>
        </label>
        {view.filters.map((f, i) => (
          <div className="ep-filter-rule" key={f.id}>
            <Pick
              label={`Filter ${i + 1} field`}
              value={f.columnId}
              columns={data.columns}
              onChange={(columnId) =>
                patch({
                  filters: view.filters.map((v) => (v.id === f.id ? { ...v, columnId } : v)),
                })
              }
            />
            <select
              aria-label={`Filter ${i + 1} operator`}
              value={f.operator}
              onChange={(e) =>
                patch({
                  filters: view.filters.map((v) =>
                    v.id === f.id ? { ...v, operator: e.target.value as typeof f.operator } : v,
                  ),
                })
              }
            >
              {['contains', 'equals', 'not-equals', 'greater', 'less', 'empty', 'not-empty'].map(
                (op) => (
                  <option key={op}>{op}</option>
                ),
              )}
            </select>
            <input
              aria-label={`Filter ${i + 1} value`}
              value={f.value}
              onChange={(e) =>
                patch({
                  filters: view.filters.map((v) =>
                    v.id === f.id ? { ...v, value: e.target.value } : v,
                  ),
                })
              }
            />
            <button onClick={() => patch({ filters: view.filters.filter((v) => v.id !== f.id) })}>
              Remove filter {i + 1}
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            patch({
              filters: [
                ...view.filters,
                {
                  id: newId('filter'),
                  columnId: data.columns[0]?.id ?? '',
                  operator: 'contains',
                  value: '',
                },
              ],
            })
          }
        >
          Add filter
        </button>
        {view.sorts.map((s, i) => (
          <div className="ep-filter-rule" key={i}>
            <Pick
              label={`Sort ${i + 1} field`}
              value={s.columnId}
              columns={data.columns}
              onChange={(columnId) =>
                patch({ sorts: view.sorts.map((v, j) => (j === i ? { ...v, columnId } : v)) })
              }
            />
            <select
              aria-label={`Sort ${i + 1} direction`}
              value={s.descending ? 'desc' : 'asc'}
              onChange={(e) =>
                patch({
                  sorts: view.sorts.map((v, j) =>
                    j === i ? { ...v, descending: e.target.value === 'desc' } : v,
                  ),
                })
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button onClick={() => patch({ sorts: view.sorts.filter((_, j) => j !== i) })}>
              Remove sort {i + 1}
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            patch({
              sorts: [...view.sorts, { columnId: data.columns[0]?.id ?? '', descending: false }],
            })
          }
        >
          Add sort
        </button>
        <Pick
          label="Group field"
          value={view.groupBy}
          columns={data.columns}
          onChange={(groupBy) => patch({ groupBy })}
        />
        <button onClick={() => patch({ search: '', filters: [], sorts: [], groupBy: '' })}>
          Clear filters and sort
        </button>
      </Section>
    </>
  );
  const inspector = field ? (
    <Section title="Field settings">
      <FieldSettings
        key={field.id + field.type + field.name}
        data={data}
        field={field}
        readOnly={readOnly}
        onSave={(next) => apply(updateColumn(field.id, next))}
        onDelete={() => {
          if (apply(removeColumn(field.id))) setFieldId('');
        }}
      />
      <button onClick={() => setFieldId('')}>Back to view settings</button>
    </Section>
  ) : (
    <>
      {view.projection === 'Chart' && (
        <Section title="Chart">
          <ChartSettings data={data} value={view.chart} onChange={(chart) => patch({ chart })} />
        </Section>
      )}
      {view.projection === 'Dashboard' && (
        <Section title="Dashboard">
          {(['metric', 'chart', 'table'] as const).map((type) => (
            <button
              key={type}
              onClick={() => {
                const id = newId('widget');
                patch({
                  widgets: [
                    ...view.widgets,
                    {
                      id,
                      type,
                      title: `${type[0].toUpperCase() + type.slice(1)}`,
                      columnId: numeric.at(-1)?.id,
                      aggregate: 'sum',
                      chart: clone(view.chart),
                    },
                  ],
                });
                setWidgetId(id);
              }}
            >
              Add {type} widget
            </button>
          ))}
          {widget && (
            <>
              <label className="ep-field">
                Widget title
                <input
                  aria-label="Widget title"
                  value={widget.title}
                  onChange={(event) =>
                    patch({
                      widgets: view.widgets.map((w) =>
                        w.id === widget.id ? { ...w, title: event.target.value } : w,
                      ),
                    })
                  }
                />
              </label>
              {widget.type === 'chart' ? (
                <ChartSettings
                  data={data}
                  value={widget.chart ?? view.chart}
                  onChange={(chart) =>
                    patch({
                      widgets: view.widgets.map((w) => (w.id === widget.id ? { ...w, chart } : w)),
                    })
                  }
                />
              ) : widget.type === 'metric' ? (
                <>
                  <Pick
                    label="Metric field"
                    columns={numeric}
                    value={widget.columnId ?? ''}
                    onChange={(columnId) =>
                      patch({
                        widgets: view.widgets.map((w) =>
                          w.id === widget.id ? { ...w, columnId } : w,
                        ),
                      })
                    }
                  />
                  <label className="ep-field">
                    Metric function
                    <select
                      aria-label="Metric function"
                      value={widget.aggregate ?? 'sum'}
                      onChange={(e) =>
                        patch({
                          widgets: view.widgets.map((w) =>
                            w.id === widget.id
                              ? { ...w, aggregate: e.target.value as AggregateFunction }
                              : w,
                          ),
                        })
                      }
                    >
                      {aggregates.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
            </>
          )}
        </Section>
      )}
      {['Timeline', 'Roadmap'].includes(view.projection) && (
        <Section title="Timeline">
          {dates.length < 2 && (
            <>
              <p>
                開始日・終了日にはdate型の列が必要です。列を追加し、各レコードの日付を入力してください。
              </p>
              <button
                disabled={readOnly}
                onClick={() => {
                  const names = new Set(data.columns.map((column) => column.name));
                  const name = (base: string) => {
                    let next = base;
                    let index = 2;
                    while (names.has(next)) next = `${base} ${index++}`;
                    names.add(next);
                    return next;
                  };
                  const start: Column = {
                    id: newId('col'),
                    name: name('Start date'),
                    type: 'date',
                  };
                  const end: Column = { id: newId('col'), name: name('End date'), type: 'date' };
                  if (
                    apply(
                      command('data.timeline-fields', 'Add timeline date fields', (current) =>
                        addColumn(end).apply(addColumn(start).apply(current)),
                      ),
                    )
                  )
                    patch({ timeline: { ...view.timeline, start: start.id, end: end.id } });
                }}
              >
                Add start and end date fields
              </button>
            </>
          )}
          {view.timeline.start && view.timeline.end && (
            <p>
              バー横のレコード名から開始日・終了日を入力できます。同じ列はGrid/Formにも表示されます。
            </p>
          )}
          <Pick
            label="Start field"
            columns={dates}
            value={view.timeline.start}
            onChange={(start) => patch({ timeline: { ...view.timeline, start } })}
          />
          <Pick
            label="End field"
            columns={dates}
            value={view.timeline.end}
            onChange={(end) => patch({ timeline: { ...view.timeline, end } })}
          />
          <Pick
            label="Timeline group"
            columns={data.columns}
            value={view.timeline.group}
            onChange={(group) => patch({ timeline: { ...view.timeline, group } })}
          />
          <label className="ep-field">
            Time scale
            <select
              aria-label="Time scale"
              value={view.timeline.scale}
              onChange={(e) =>
                patch({
                  timeline: { ...view.timeline, scale: e.target.value as 'day' | 'week' | 'month' },
                })
              }
            >
              {['day', 'week', 'month'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <CommitInput
            label="Range start"
            type="date"
            value={view.timeline.from}
            onCommit={(from) => patch({ timeline: { ...view.timeline, from } })}
          />
          <CommitInput
            label="Range end"
            type="date"
            value={view.timeline.to}
            onCommit={(to) => patch({ timeline: { ...view.timeline, to } })}
          />
        </Section>
      )}
      {view.projection === 'Summary' && (
        <Section title="Summary">
          <Pick
            label="Summary field"
            columns={numeric}
            value={view.summary.columnId}
            onChange={(columnId) => patch({ summary: { ...view.summary, columnId } })}
          />
          <label className="ep-field">
            Summary function
            <select
              aria-label="Summary function"
              value={view.summary.aggregate}
              onChange={(e) =>
                patch({
                  summary: { ...view.summary, aggregate: e.target.value as AggregateFunction },
                })
              }
            >
              {aggregates.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        </Section>
      )}
      {view.projection === 'Kanban' && (
        <Section title="Kanban">
          <Pick
            label="Kanban group"
            value={view.groupBy || groupColumn?.id || ''}
            columns={data.columns.filter((c) => c.type === 'select' || c.type === 'text')}
            onChange={(groupBy) => patch({ groupBy })}
          />
          {data.columns.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={view.cardFields.includes(c.id)}
                onChange={(e) =>
                  patch({
                    cardFields: e.target.checked
                      ? [...view.cardFields, c.id]
                      : view.cardFields.filter((id) => id !== c.id),
                  })
                }
              />{' '}
              {c.name}
            </label>
          ))}
        </Section>
      )}
      {query}
      <Section title="Grid">
        <CommitInput
          label="Frozen columns"
          value={view.frozen}
          type="number"
          min={0}
          max={Math.max(0, columns.length)}
          onCommit={(v) => patch({ frozen: Number(v) })}
        />
      </Section>
    </>
  );
  let surface: ReactNode;
  if (view.projection === 'Grid')
    surface = (
      <DataGrid
        data={data}
        rows={rows}
        columns={columns}
        view={view}
        onView={patch}
        apply={apply}
        select={select}
        onField={setFieldId}
        readOnly={readOnly}
        active={active}
        onActive={setActive}
        onError={setError}
      />
    );
  else if (view.projection === 'Graph')
    surface = renderGraph ? (
      renderGraph({
        content: data,
        execute: (cmd) => apply(cmd),
        select: (id, region) => {
          setActive({
            rowId: id,
            columnId:
              region?.type === 'cell'
                ? region.columnId
                : (active?.columnId ?? columns[0]?.id ?? ''),
          });
          select(id, region);
        },
        readOnly,
        visibleRowIds: rows.map((r) => r.id),
        openSource: (rowId) => {
          if (!changeProjection('Form')) return;
          if (rowId) focusRow(rowId);
        },
        openDefinition: (columnId) => {
          if (!changeProjection('Grid')) return;
          setFieldDialog(columnId ?? data.columns[0]?.id ?? '');
        },
      })
    ) : (
      <p role="alert">
        This Host has not registered a Graph projection. The original Data is retained.
      </p>
    );
  else if (view.projection === 'Form')
    surface = record ? (
      <div className="ep-data-scroll">
        <div className="ep-record-nav">
          <IconButton
            icon={ChevronLeft}
            label="Previous record"
            disabled={recordIndex <= 0}
            onClick={() => focusRow(rows[recordIndex - 1].id)}
          />
          <span>
            {recordIndex + 1} / {rows.length}
          </span>
          <IconButton
            icon={ChevronRight}
            label="Next record"
            disabled={recordIndex >= rows.length - 1}
            onClick={() => focusRow(rows[recordIndex + 1].id)}
          />
        </div>
        <RecordForm
          key={record.id}
          data={data}
          row={record}
          drafts={formDrafts.current}
          readOnly={readOnly}
          apply={apply}
          select={(columnId) => select(record.id, { type: 'cell', columnId })}
        />
      </div>
    ) : (
      <div className="ep-data-empty">Add a record to open the form.</div>
    );
  else if (view.projection === 'Chart')
    surface = (
      <div className="ep-data-scroll">
        <DataChart data={data} rows={rows} config={view.chart} accent={view.accent} />
      </div>
    );
  else if (view.projection === 'Kanban')
    surface = (
      <div className="ep-kanban">
        {groupNames.map((name) => (
          <section
            className="ep-kanban-column"
            key={name}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('application/x-data-row');
              if (id && groupColumn)
                apply(
                  setCells(
                    [
                      {
                        rowId: id,
                        columnId: groupColumn.id,
                        value: name === '(empty)' ? null : name,
                      },
                    ],
                    'Move card',
                  ),
                );
            }}
          >
            <h3>
              {name}
              <span>{groupRows(name).length}</span>
            </h3>
            {groupRows(name).map((row, i) => {
              const title = String(row.values[data.columns[0]?.id] ?? 'Record');
              return (
                <article
                  key={row.id}
                  className="ep-kanban-card"
                  draggable={!readOnly}
                  onDragStart={(e) => e.dataTransfer.setData('application/x-data-row', row.id)}
                >
                  <button
                    className="ep-card-title"
                    onClick={() => {
                      focusRow(row.id);
                      setRecordDialog(row.id);
                    }}
                  >
                    {title}
                  </button>
                  {view.cardFields
                    .filter((id) => id !== data.columns[0]?.id)
                    .map((id) => {
                      const c = data.columns.find((c) => c.id === id);
                      return c ? (
                        <p key={id}>
                          <span>{c.name}</span>
                          {formatCell(data, row, c)}
                        </p>
                      ) : null;
                    })}
                  <div className="ep-card-actions">
                    <label>
                      Move to
                      <select
                        aria-label={`Move ${title} to`}
                        disabled={readOnly || !groupColumn}
                        value={name}
                        onChange={(e) => {
                          if (groupColumn)
                            apply(
                              setCells(
                                [
                                  {
                                    rowId: row.id,
                                    columnId: groupColumn.id,
                                    value: e.target.value === '(empty)' ? null : e.target.value,
                                  },
                                ],
                                'Move card',
                              ),
                            );
                        }}
                      >
                        {groupNames.map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <IconButton
                      icon={ArrowUp}
                      label={`Move ${title} up`}
                      disabled={readOnly || i === 0}
                      onClick={() => apply(reorderRow(row.id, groupRows(name)[i - 1].id))}
                    />
                  </div>
                </article>
              );
            })}
            <button
              disabled={readOnly}
              onClick={() => {
                const row = makeRow(data);
                if (groupColumn) row.values[groupColumn.id] = name === '(empty)' ? null : name;
                if (apply(insertRows([row]))) setRecordDialog(row.id);
              }}
            >
              Add card
            </button>
          </section>
        ))}
      </div>
    );
  else if (view.projection === 'Timeline' || view.projection === 'Roadmap')
    surface = (
      <div className="ep-data-scroll">
        <Timeline
          data={data}
          rows={rows}
          config={view.timeline}
          apply={apply}
          readOnly={readOnly}
          onSelect={focusRow}
        />
      </div>
    );
  else if (view.projection === 'Summary') {
    const groups = view.groupBy ? groupNames : ['All records'];
    surface = (
      <div className="ep-data-scroll">
        <h2>Summary</h2>
        <p>
          {rows.length} of {data.rows.length} records · {view.filters.length} filter conditions ·
          empty numeric values excluded
        </p>
        <table className="ep-summary">
          <thead>
            <tr>
              <th>Group</th>
              <th>Records</th>
              <th>{view.summary.aggregate}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((name) => {
              const items = view.groupBy ? groupRows(name) : rows;
              return (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{items.length}</td>
                  <td>
                    {summarize(
                      data,
                      items,
                      view.summary.columnId,
                      view.summary.aggregate,
                    )?.toLocaleString() ?? '—'}
                  </td>
                </tr>
              );
            })}
            <tr>
              <th>Total</th>
              <td>{rows.length}</td>
              <td>
                {summarize(
                  data,
                  rows,
                  view.summary.columnId,
                  view.summary.aggregate,
                )?.toLocaleString() ?? '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  } else
    surface = (
      <div className="ep-data-scroll">
        <div className="ep-dashboard">
          {view.widgets.map((w, i) => (
            <section
              key={w.id}
              className={`ep-widget ${widgetId === w.id ? 'selected' : ''}`}
              onClick={() => setWidgetId(w.id)}
            >
              <header>
                <h3>{w.title}</h3>
                <IconButton
                  icon={ArrowUp}
                  label={`Move widget ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => {
                    const widgets = [...view.widgets];
                    [widgets[i - 1], widgets[i]] = [widgets[i], widgets[i - 1]];
                    patch({ widgets });
                  }}
                />
                <IconButton
                  icon={Trash2}
                  label={`Delete widget ${i + 1}`}
                  onClick={() => patch({ widgets: view.widgets.filter((v) => v.id !== w.id) })}
                />
              </header>
              {w.type === 'metric' ? (
                <>
                  <output aria-label={w.title}>
                    {summarize(
                      data,
                      rows,
                      w.columnId ?? '',
                      w.aggregate ?? 'sum',
                    )?.toLocaleString() ?? '—'}
                  </output>
                  <p>
                    {w.aggregate} · {rows.length} records
                  </p>
                </>
              ) : w.type === 'chart' ? (
                <DataChart
                  data={data}
                  rows={rows}
                  config={w.chart ?? view.chart}
                  width={600}
                  height={340}
                  accent={view.accent}
                />
              ) : (
                <div className="ep-widget-table">
                  <table>
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c.id}>{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 20).map((r) => (
                        <tr key={r.id}>
                          {columns.map((c) => (
                            <td key={c.id}>{formatCell(data, r, c)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p>
                    First {Math.min(20, rows.length)} of {rows.length} records
                  </p>
                </div>
              )}
            </section>
          ))}
        </div>
        {!view.widgets.length && (
          <p className="ep-data-empty">
            Add a metric, chart or table from the inspector. Widgets read this dataset.
          </p>
        )}
      </div>
    );
  return (
    <EditorLayout
      {...layout}
      viewKey={layout?.viewKey ?? 'data'}
      leftLabel="Data navigator"
      inspectorLabel="Data inspector"
      left={left}
      inspector={inspector}
      status={
        <>
          <span>
            {rows.length} / {data.rows.length} records · {columns.length} visible fields
          </span>
          <span className="ep-spacer" />
          {view.search || view.filters.length ? (
            <button onClick={() => patch({ search: '', filters: [] })}>Filtered · Clear</button>
          ) : (
            <span>All records</span>
          )}
          <span>{readOnly ? 'Read only' : view.projection}</span>
        </>
      }
      toolbar={
        <>
          <select
            aria-label="Data projection"
            value={view.projection}
            onChange={(e) => changeProjection(e.target.value as DataProjection)}
          >
            {[...projections, ...(renderGraph ? ['Graph' as const] : [])].map((p) => (
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
              onCommit={(v) => setRowCount(Number(v))}
            />
            <button disabled={readOnly} onClick={() => addRecords(rowCount)}>
              Add {rowCount} record{rowCount === 1 ? '' : 's'}
            </button>
          </Menu>
          <IconButton
            icon={Columns3}
            label="Add field"
            disabled={readOnly}
            onClick={() => {
              setNewField({ id: newId('col'), name: '', type: 'text' });
              setAddField(true);
            }}
          />
          <Menu label="Sort and filter" icon={Filter}>
            {query}
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
          <IconButton
            icon={Save}
            label="Save named view"
            disabled={readOnly}
            onClick={() => {
              if (apply(saveView(view))) acceptViewDraft(view);
            }}
          />
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
      }
    >
      <div className="ep-data-body">
        {error && (
          <div role="alert" className="ep-error">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {[...formDrafts.current]
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
                  formDrafts.current.delete(id);
                  inputs?.changed();
                  setError('');
                }}
              >
                Discard deleted record input
              </button>
            </details>
          ))}
        {surface}
      </div>
      {addField && (
        <Dialog title="Add field" onClose={() => setAddField(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const c = {
                ...newField,
                ...(newField.type === 'select'
                  ? { options: (newField.options ?? []).filter(Boolean) }
                  : {}),
              };
              const cmd = addColumn(c);
              try {
                const next = cmd.apply(data),
                  errors = validateData(next).filter((v) => v.columnId === c.id);
                if (errors.length) {
                  setError(errors[0].message);
                  return;
                }
                if (apply(cmd)) {
                  setFieldId(c.id);
                  setAddField(false);
                }
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label className="ep-field">
              Field name
              <input
                aria-label="New field name"
                value={newField.name}
                autoFocus
                onChange={(e) => setNewField({ ...newField, name: e.target.value })}
              />
            </label>
            <label className="ep-field">
              Type
              <select
                aria-label="New field type"
                value={newField.type}
                onChange={(e) =>
                  setNewField({ ...newField, type: e.target.value as Column['type'] })
                }
              >
                {columnTypes.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {newField.type === 'formula' ? (
              <label className="ep-field">
                Formula
                <input
                  aria-label="New field formula"
                  value={newField.formula ?? ''}
                  onChange={(e) => setNewField({ ...newField, formula: e.target.value })}
                />
              </label>
            ) : (
              <label className="ep-field">
                Default
                <input
                  aria-label="New field default"
                  value={String(newField.defaultValue ?? '')}
                  onChange={(e) =>
                    setNewField({ ...newField, defaultValue: parseCell(e.target.value, newField) })
                  }
                />
              </label>
            )}
            {newField.type === 'select' && (
              <label className="ep-field">
                Options
                <input
                  aria-label="New field options"
                  value={newField.options?.join(',') ?? ''}
                  onChange={(e) =>
                    setNewField({
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
                onChange={(e) => setNewField({ ...newField, required: e.target.checked })}
              />{' '}
              Required
            </label>
            {error && <p className="ep-field-error">{error}</p>}
            <button disabled={!newField.name.trim() || readOnly}>Create field</button>
          </form>
        </Dialog>
      )}
      {recordDialog && data.rows.some((r) => r.id === recordDialog) && (
        <Dialog title="Record details" onClose={() => setRecordDialog(null)}>
          <RecordForm
            key={recordDialog}
            drafts={formDrafts.current}
            data={data}
            row={data.rows.find((r) => r.id === recordDialog)!}
            readOnly={readOnly}
            apply={apply}
            select={(columnId) => select(recordDialog, { type: 'cell', columnId })}
            onDone={() => setRecordDialog(null)}
          />
          <button
            disabled={readOnly}
            onClick={() => {
              if (apply(deleteRows([recordDialog]))) setRecordDialog(null);
            }}
          >
            Delete record
          </button>
        </Dialog>
      )}
      {fieldDialog && data.columns.some((column) => column.id === fieldDialog) && (
        <Dialog title="データ定義 · Field settings" onClose={() => setFieldDialog('')}>
          <p>所有元: Structured Data · 値の編集はForm、項目名・型の編集はこの定義画面です。</p>
          <FieldSettings
            key={fieldDialog}
            data={data}
            field={data.columns.find((column) => column.id === fieldDialog)!}
            readOnly={readOnly}
            onSave={(field) => {
              if (!apply(updateColumn(field.id, field))) return false;
              setFieldDialog('');
              return true;
            }}
            onDelete={() => {
              if (apply(removeColumn(fieldDialog))) setFieldDialog('');
            }}
          />
        </Dialog>
      )}
      {csvExport && (
        <CsvExportDialog
          data={data}
          view={view}
          onClose={() => setCsvExport(false)}
          capture={() => {
            guardExport?.();
            inputs?.flush();
            return current.current;
          }}
        />
      )}
      {csv && (
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
                const count = parseCsvText(csv.source)[0]?.length ?? 1;
                setCsv({
                  ...csv,
                  data: importCsv(
                    header
                      ? csv.source
                      : Array.from({ length: count }, (_, i) => `Column ${i + 1}`).join(',') +
                          '\n' +
                          csv.source,
                  ),
                });
              }}
            />{' '}
            First row is a header
          </label>
          <label>
            <input
              type="checkbox"
              checked={csvAppend}
              onChange={(e) => setCsvAppend(e.target.checked)}
            />{' '}
            Append to matching fields
          </label>
          <div className="ep-csv-preview">
            <table>
              <thead>
                <tr>
                  {csv.data.columns.map((c) => (
                    <th key={c.id}>
                      {c.name}
                      {csvAppend ? (
                        <>
                          <select
                            aria-label={`Append target ${c.name}`}
                            value={appendPreview?.columns[csv.data.columns.indexOf(c)]?.id ?? ''}
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
                          <p>
                            {appendPreview?.columns[csv.data.columns.indexOf(c)]?.type} ·{' '}
                            {appendPreview?.columns[csv.data.columns.indexOf(c)]?.id} ·{' '}
                            {appendPreview?.columns[csv.data.columns.indexOf(c)]?.options?.join(
                              ', ',
                            )}
                            {appendPreview?.columns[csv.data.columns.indexOf(c)]?.type ===
                            'relation'
                              ? ' · existing record IDs'
                              : ''}
                          </p>
                        </>
                      ) : (
                        <select
                          aria-label={`Import type ${c.name}`}
                          value={c.type}
                          onChange={(e) => {
                            const type = e.target.value as Column['type'];
                            const original = parseCsvText(csv.source).slice(csvHeader ? 1 : 0);
                            const columnIndex = csv.data.columns.findIndex((v) => v.id === c.id);
                            setCsv({
                              ...csv,
                              data: {
                                ...csv.data,
                                columns: csv.data.columns.map((v) =>
                                  v.id === c.id ? { ...v, type } : v,
                                ),
                                rows: csv.data.rows.map((r, index) => ({
                                  ...r,
                                  values: {
                                    ...r.values,
                                    [c.id]: parseCell(original[index]?.[columnIndex] ?? '', {
                                      ...c,
                                      type,
                                    }),
                                  },
                                })),
                              },
                            });
                          }}
                        >
                          {['text', 'number', 'boolean', 'date'].map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {csv.data.rows.slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    {csv.data.columns.map((c) => (
                      <td key={c.id}>
                        {csvAppend
                          ? parseCsvText(csv.source)[
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
          {csvErrors.length > 0 && (
            <div className="ep-field-error" role="status">
              {csvErrors.length} invalid values in the preview.
              <ul>
                {csvErrors.map((error, index) => (
                  <li key={index}>
                    Row {error.row}, field {error.column} {error.name} · value{' '}
                    {JSON.stringify(error.raw)}: {error.message}.
                    CSVまたは列対応を修正してください。
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
          <button disabled={readOnly || csvErrors.length > 0} onClick={commitCsv}>
            Import records
          </button>
        </Dialog>
      )}
    </EditorLayout>
  );
}
