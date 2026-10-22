import { useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { type EditorCommand, type Region } from '@editor-platform/editor-core';
import {
  EditorExportGuardContext,
  EditorInputsContext,
  EditorLayout,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import { downloadBlob } from '@editor-platform/canvas-ui';
import {
  defaultView,
  insertRows,
  saveView,
  viewRows,
  type DataView,
  type DataProjection,
} from './views';
import { makeRow, type StructuredData, type Column } from './model';
import { guardDataCommand } from './session';
import { type CellAddress } from './grid';
import { type RecordDraft } from './record';
import { CsvExportDialog } from './csv-export-ui';
import { useCsvImport, useDataViewDraft, useRecordDraftInput } from './view-hooks';
import { dataChartSvg, dataGroups, pngBlob, svgBlob } from './view-model';
import { DataNavigator } from './view-navigator';
import { DataInspector } from './view-inspector';
import { dataProjection } from './view-projections';
import { DataStatus, DataToolbar } from './view-toolbar';
import {
  AddFieldDialog,
  CsvImportDialog,
  DeletedRecordDrafts,
  FieldDefinitionDialog,
  RecordDetailsDialog,
} from './view-dialogs';
import './styles.css';
export type { DataProjection } from './views';
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
  const [error, setError] = useState('');
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
  const draft = useDataViewDraft({
    data,
    initialView,
    readOnly,
    apply,
    onViewChange,
    onViewDraftChange,
  });
  const { view, setView, current, patch, acceptViewDraft } = draft;
  const [active, setActive] = useState<CellAddress | null>(null),
    [fieldId, setFieldId] = useState(''),
    [fieldDialog, setFieldDialog] = useState(''),
    [addField, setAddField] = useState(false),
    [newField, setNewField] = useState<Column>(() => ({
      id: newId('col'),
      name: '',
      type: 'text',
    })),
    [rowCount, setRowCount] = useState(1),
    [recordDialog, setRecordDialog] = useState<string | null>(null),
    [widgetId, setWidgetId] = useState('');
  const [csvExport, setCsvExport] = useState(false);
  const csvImport = useCsvImport(data);
  const rows = useMemo(() => viewRows(data, view), [data, view]),
    columns = data.columns.filter((c) => !view.hidden.includes(c.id)),
    field = data.columns.find((c) => c.id === fieldId),
    record = data.rows.find((r) => r.id === active?.rowId) ?? rows[0],
    recordIndex = record ? rows.findIndex((r) => r.id === record.id) : -1,
    widget = view.widgets.find((w) => w.id === widgetId),
    numeric = data.columns.filter((c) => ['number', 'formula'].includes(c.type)),
    dates = data.columns.filter((c) => c.type === 'date'),
    groups = dataGroups(data, rows, view);
  function focusRow(id: string) {
    if ([...formDrafts.current.values()].some((draft) => draft.composing)) {
      setError('入力変換を確定してから別のレコードを選択してください。');
      return;
    }
    setActive({ rowId: id, columnId: active?.columnId ?? columns[0]?.id ?? '' });
    select(id);
  }
  useRecordDraftInput({
    data,
    readOnly,
    drafts: formDrafts,
    apply,
    reveal: (projection, id) => {
      patch({ projection });
      focusRow(id);
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
  async function exportVisual(format: 'svg' | 'png') {
    try {
      guardExport?.();
      const source = dataChartSvg(current.current);
      downloadBlob(
        `data-chart.${format}`,
        format === 'svg' ? svgBlob(source) : await pngBlob(source),
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
  const saveNamedView = () => {
    if (apply(saveView(view))) acceptViewDraft(view);
  };
  return (
    <EditorLayout
      {...layout}
      viewKey={layout?.viewKey ?? 'data'}
      leftLabel="Data navigator"
      inspectorLabel="Data inspector"
      left={
        <DataNavigator
          data={data}
          draft={draft}
          readOnly={readOnly}
          graph={!!renderGraph}
          apply={apply}
          inputs={inputs}
          fieldId={fieldId}
          onField={setFieldId}
          onError={setError}
          changeProjection={changeProjection}
        />
      }
      inspector={
        <DataInspector
          data={data}
          view={view}
          patch={patch}
          readOnly={readOnly}
          apply={apply}
          field={field}
          onField={setFieldId}
          widget={widget}
          onWidget={setWidgetId}
          numeric={numeric}
          dates={dates}
          groupColumn={groups.groupColumn}
          visibleColumns={columns.length}
        />
      }
      status={
        <DataStatus
          data={data}
          view={view}
          patch={patch}
          readOnly={readOnly}
          visibleRows={rows.length}
          visibleColumns={columns.length}
        />
      }
      toolbar={
        <DataToolbar
          data={data}
          view={view}
          patch={patch}
          readOnly={readOnly}
          graph={!!renderGraph}
          rowCount={rowCount}
          onRowCount={setRowCount}
          changeProjection={changeProjection}
          addRecords={addRecords}
          onAddField={() => {
            setNewField({ id: newId('col'), name: '', type: 'text' });
            setAddField(true);
          }}
          onSaveView={saveNamedView}
          exportData={exportData}
          exportVisual={exportVisual}
          openCsv={(file) => csvImport.openCsv(file, setError)}
        />
      }
    >
      <div className="ep-data-body">
        {error && (
          <div role="alert" className="ep-error">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        <DeletedRecordDrafts
          data={data}
          drafts={formDrafts.current}
          inputs={inputs}
          onError={setError}
        />
        {dataProjection({
          data,
          view,
          patch,
          rows,
          columns,
          apply,
          select,
          readOnly,
          active,
          onActive: setActive,
          onError: setError,
          onField: setFieldId,
          onFieldDialog: setFieldDialog,
          onRecordDialog: setRecordDialog,
          renderGraph,
          changeProjection,
          focusRow,
          drafts: formDrafts.current,
          record,
          recordIndex,
          groups,
          widgetId,
          onWidget: setWidgetId,
        })}
      </div>
      {addField && (
        <AddFieldDialog
          data={data}
          newField={newField}
          onNewField={setNewField}
          readOnly={readOnly}
          error={error}
          onError={setError}
          apply={apply}
          onCreated={(id) => {
            setFieldId(id);
            setAddField(false);
          }}
          onClose={() => setAddField(false)}
        />
      )}
      {recordDialog && data.rows.some((r) => r.id === recordDialog) && (
        <RecordDetailsDialog
          data={data}
          rowId={recordDialog}
          drafts={formDrafts.current}
          readOnly={readOnly}
          apply={apply}
          select={select}
          onClose={() => setRecordDialog(null)}
        />
      )}
      {fieldDialog && data.columns.some((column) => column.id === fieldDialog) && (
        <FieldDefinitionDialog
          data={data}
          columnId={fieldDialog}
          readOnly={readOnly}
          apply={apply}
          onClose={() => setFieldDialog('')}
        />
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
      {csvImport.csv && (
        <CsvImportDialog
          data={data}
          imp={csvImport}
          readOnly={readOnly}
          error={error}
          onCommit={() =>
            csvImport.commitCsv(apply, setError, (next) => {
              setView(defaultView(next));
              setActive(null);
            })
          }
        />
      )}
    </EditorLayout>
  );
}
