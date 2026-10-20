import { createDocumentTextMetrics } from './text-metrics';
import { type ReferenceSurfaceProps } from '@editor-platform/artifact-references/react';
import { useContext } from 'react';
import {
  EditorExportGuardContext,
  EditorInputsContext,
  EditorHistoryContext,
  EditorOfficeCapabilitiesContext,
} from '@editor-platform/editor-ui';
import { useRef, useState, useCallback, useMemo } from 'react';
import { type EditorState } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
import { canonicalJson, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import {
  type EditorCommand,
  type Region,
  type Annotation,
  type ElementAddress,
} from '@editor-platform/editor-core';
import { EditorLayout, type EditorLayoutProps } from '@editor-platform/editor-ui';
import { activeBlock, jumpToBlock } from './engine';
import { createLocalDocumentCommand, sameDocumentProjection } from './local-engine-command';
import { type DocumentContent } from './model';
import { documentActions } from './view-actions';
import {
  DocumentDocxExport,
  DocumentFindBar,
  InsertBlockDialog,
  LinkDialog,
  PrintPreviewDialog,
} from './view-dialogs';
import { useDocumentEditorView, type EmittedProjection, type TypingGroup } from './view-editor';
import {
  useAnnotationRefresh,
  useContentSync,
  useDocumentExport,
  useEmbeddedRefresh,
  useFindReplace,
  useFocusAddress,
  usePrintPreview,
  useReadOnlySync,
} from './view-hooks';
import { DocumentInspector } from './view-inspector';
import { pageStyle, type DocumentCallbacks, type DocumentTextBridge } from './view-model';
import { documentOutline, documentStatus, toolButtonFor } from './view-parts';
import { DocumentExportMenu, DocumentToolbar } from './view-toolbar';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import './styles.css';

export { blockLabels, type DocumentTextBridge } from './view-model';

export interface DocumentSurfaceProps extends ReferenceSurfaceProps {
  textEngine?: DocumentTextBridge;
  content: DocumentContent;
  execute: (command: EditorCommand<DocumentContent>) => void;
  select: (id: string, region?: Region) => void;
  selectedId?: string;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
  readOnly?: boolean;
  layout?: Pick<EditorLayoutProps, 'panels' | 'defaultPanels' | 'onPanelsChange' | 'viewKey'>;
}
export function DocumentSurface({
  references,
  content: hostContent,
  execute,
  select,
  selectedId,
  annotations = [],
  focusAddress,
  readOnly = false,
  layout,
  textEngine,
}: DocumentSurfaceProps) {
  const emitted = useRef<EmittedProjection>(null);
  const previousContent = emitted.current?.content;
  // A Host may return a mutable clone of the exact content just emitted. Compare
  // values before reusing our owned snapshot; identity alone never certifies a Host tree.
  const content =
    previousContent && sameDocumentProjection(previousContent, hostContent)
      ? previousContent
      : hostContent;
  const localDocumentCommand = useMemo(createLocalDocumentCommand, []);
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const history = useContext(EditorHistoryContext);
  const officeCapability = useContext(EditorOfficeCapabilitiesContext);
  const mount = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callbacks = useRef<DocumentCallbacks>({
      content,
      execute,
      select,
      readOnly,
      annotations,
      textEngine,
      references,
      history,
    });
  callbacks.current = {
    content,
    execute,
    select,
    readOnly,
    annotations,
    textEngine,
    references,
    history,
  };
  const embeddedViews = useRef(new Set<() => void>());
  const chooseOutline = useCallback((id: string) => {
    const editor = view.current;
    if (!editor) return;
    const tr = jumpToBlock(editor.state, id);
    editor.focus();
    if (tr) editor.dispatch(tr);
    callbacks.current.select(id);
  }, []);
  const [engineState, setEngineState] = useState<EditorState | null>(null),
    [error, setError] = useState(''),
    [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState('https://'),
    [insertOpen, setInsertOpen] = useState(false),
    [docxOpen, setDocxOpen] = useState(false);
  // Only blocks belong to the text engine. Retained definitions/page settings
  // must not rebuild its DOM or be serialized on every React render.
  const typing = useRef<TypingGroup>({ key: newId('typing'), time: 0, position: -1 });
  if (emitted.current === null)
    emitted.current = {
      blocks: isDeepFrozen(content.blocks) ? content.blocks : undefined,
      key: canonicalJson(content.blocks),
    };
  const selected = content.blocks.find(
    (b) => b.id === ((engineState ? activeBlock(engineState)?.id : undefined) ?? selectedId),
  );
  const actions = documentActions({
    view,
    callbacks,
    readOnly,
    selectedId,
    selected,
    execute,
    setError,
    setInsertOpen,
    setLink,
    setLinkOpen,
  });
  const finder = useFindReplace(view, engineState, readOnly, actions.dispatch);
  const { findOpen, setFindOpen } = finder;
  useDocumentEditorView({
    mount,
    view,
    callbacks,
    embeddedViews,
    typing,
    emitted,
    localDocumentCommand,
    setEngineState,
    setError,
    setFindOpen,
    setInsertOpen,
    actions,
    textEngine,
  });
  useEmbeddedRefresh(embeddedViews, references);
  useAnnotationRefresh(view, annotations);
  useFocusAddress(view, content, focusAddress);
  useContentSync({ view, emitted, typing, setEngineState }, content, readOnly, textEngine);
  useReadOnlySync(view, readOnly, textEngine);
  const capture = { callbacks, references, inputs, guardExport, setError };
  const { printPages, printPreview, closePrintPreview } = usePrintPreview(capture);
  const { exporting, exportFile } = useDocumentExport(capture);
  const toolButton = toolButtonFor(readOnly);
  const countText = useMemo(createDocumentTextMetrics, []);
  const textMetrics = countText(content.blocks);
  return (
    <EditorLayout
      {...layout}
      viewKey={layout?.viewKey ?? 'document'}
      leftLabel="Document outline"
      inspectorLabel="Document inspector"
      left={documentOutline(content.blocks, selected?.id, chooseOutline)}
      inspector={
        <DocumentInspector
          selected={selected}
          references={references}
          readOnly={readOnly}
          engineState={engineState}
          content={content}
          actions={actions}
          toolButton={toolButton}
        />
      }
      status={documentStatus(textMetrics, content, readOnly)}
      toolbar={
        <DocumentToolbar
          engineState={engineState}
          readOnly={readOnly}
          selectedId={selected?.id}
          references={references}
          actions={actions}
          toolButton={toolButton}
          findOpen={findOpen}
          setFindOpen={setFindOpen}
          setInsertOpen={setInsertOpen}
          exportMenu={
            <DocumentExportMenu
              docx={officeCapability.docx}
              docxReason={officeCapability.reason}
              exporting={exporting}
              printPreview={printPreview}
              openDocx={() => setDocxOpen(true)}
              exportFile={exportFile}
            />
          }
        />
      }
    >
      <div className="ep-document-scroll">
        {findOpen && <DocumentFindBar finder={finder} readOnly={readOnly} />}
        {error && (
          <p role="alert" className="ep-error">
            {error}
          </p>
        )}
        <div
          className="ep-document-page"
          data-window-text={content.blocks.length > 200 || undefined}
          style={pageStyle(content)}
        >
          <div ref={mount} />
        </div>
      </div>
      {docxOpen && (
        <DocumentDocxExport
          content={content}
          onClose={() => setDocxOpen(false)}
          onNavigate={(blockId) => {
            select(blockId);
            actions.navigate(blockId);
          }}
        />
      )}
      {printPages !== undefined && (
        <PrintPreviewDialog printPages={printPages} onClose={closePrintPreview} />
      )}
      {insertOpen && (
        <InsertBlockDialog
          onClose={() => {
            setInsertOpen(false);
            view.current?.focus();
          }}
          insert={actions.insert}
        />
      )}
      {linkOpen && <LinkDialog link={link} setLink={setLink} actions={actions} />}
    </EditorLayout>
  );
}
