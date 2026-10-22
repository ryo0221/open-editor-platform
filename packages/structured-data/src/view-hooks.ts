import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import { importCsv, pruneViewFields, validateData, type StructuredData } from './model';
import {
  insertRows,
  reconcileDataView,
  saveView,
  type DataProjection,
  type DataView,
} from './views';
import { previewCsvAppend } from './csv-transfer';
import { prepareRecordDrafts, RecordDraftError } from './record-draft';
import type { RecordDraft } from './record';
import { csvValidationErrors, initialDataView, type CsvDraft } from './view-model';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;
interface ViewEdit {
  base: DataView;
  past: DataView[];
  future: DataView[];
}
export interface DataSnapshot {
  data: StructuredData;
  view: DataView;
}

function useReconciledView(
  data: StructuredData,
  initialView: DataView | undefined,
): {
  view: DataView;
  setView: (view: DataView) => void;
  viewEdit: RefObject<ViewEdit>;
  current: RefObject<DataSnapshot>;
} {
  const [view, setView] = useState<DataView>(() => initialDataView(data, initialView));
  const current = useRef({ data, view });
  current.current = { data, view };
  const viewEdit = useRef<ViewEdit>({
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
  return { view, setView, viewEdit, current };
}

/** Owns the projection draft, its private view history and Host notifications. */
export function useDataViewDraft({
  data,
  initialView,
  readOnly,
  apply,
  onViewChange,
  onViewDraftChange,
}: {
  data: StructuredData;
  initialView?: DataView;
  readOnly: boolean;
  apply: Apply;
  onViewChange?: (view: DataView) => void;
  onViewDraftChange?: (state: { dirty: boolean; canUndo: boolean; canRedo: boolean }) => void;
}) {
  const { view, setView, viewEdit, current } = useReconciledView(data, initialView);
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
  return { view, setView, viewEdit, current, viewDirty, patch, viewHistory, acceptViewDraft };
}
export type DataViewDraft = ReturnType<typeof useDataViewDraft>;

/** Holds a CSV import preview until it is committed as one Data command. */
export function useCsvImport(data: StructuredData) {
  const [csv, setCsv] = useState<CsvDraft | null>(null),
    [csvAppend, setCsvAppend] = useState(true),
    [csvHeader, setCsvHeader] = useState(true),
    [csvTargets, setCsvTargets] = useState<Record<number, string>>({});
  const appendPreview = useMemo(
    () =>
      csv && csvAppend
        ? previewCsvAppend(
            data,
            csv.source,
            csvHeader,
            csvTargets,
            csv.data.rows.map((row) => row.id),
            csv,
          )
        : undefined,
    [data, csv, csvAppend, csvHeader, csvTargets],
  );
  const csvErrors = useMemo(
    () =>
      appendPreview ? appendPreview.diagnostics : csv ? csvValidationErrors(csv, csvHeader) : [],
    [appendPreview, csv, csvHeader],
  );
  async function openCsv(file: File, setError: (error: string) => void) {
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
  function commitCsv(
    apply: Apply,
    setError: (error: string) => void,
    onReplace: (next: StructuredData) => void,
  ) {
    if (!csv) return;
    if (csvAppend) {
      const preview = previewCsvAppend(
        data,
        csv.source,
        csvHeader,
        csvTargets,
        csv.data.rows.map((row) => row.id),
        csv,
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
        onReplace(next);
        setCsv(null);
      }
    }
  }
  return {
    csv,
    setCsv,
    csvAppend,
    setCsvAppend,
    csvHeader,
    setCsvHeader,
    csvTargets,
    setCsvTargets,
    appendPreview,
    csvErrors,
    openCsv,
    commitCsv,
  };
}
export type CsvImport = ReturnType<typeof useCsvImport>;

/** Registers retained Form drafts as one guarded input boundary. */
export function useRecordDraftInput({
  data,
  readOnly,
  drafts,
  apply,
  reveal,
}: {
  data: StructuredData;
  readOnly: boolean;
  drafts: RefObject<Map<string, RecordDraft>>;
  apply: Apply;
  reveal: (projection: DataProjection, rowId: string) => void;
}) {
  const invalidRecord = useRef<string | undefined>(undefined);
  useEditorInput({
    label: 'Data Form',
    read: () => ({
      dirty: drafts.current.size > 0,
      composing: [...drafts.current.values()].some((draft) => draft.composing),
    }),
    prepare: () => {
      if (readOnly) throw new Error('このHostではデータを編集できません。');
      const snapshot = new Map(drafts.current);
      let edit: EditorCommand<StructuredData>;
      try {
        edit = prepareRecordDrafts(data, snapshot);
      } catch (error) {
        invalidRecord.current = error instanceof RecordDraftError ? error.rowId : undefined;
        throw error;
      }
      return () => {
        if (!apply(edit)) return false;
        drafts.current.clear();
      };
    },
    focus: () => {
      const id = invalidRecord.current ?? drafts.current.keys().next().value;
      if (id) {
        // Failure recovery must reveal the buffer without recursively flushing it.
        reveal('Form', id);
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
}
