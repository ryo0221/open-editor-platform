import { createDocumentTextMetrics } from './text-metrics';
import {
  ReferenceTools,
  ReferenceInspector,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { useContext } from 'react';
import {
  EditorExportGuardContext,
  EditorInputsContext,
  EditorHistoryContext,
  EditorOfficeCapabilitiesContext,
} from '@editor-platform/editor-ui';
import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { type EditorState } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
import { canonicalJson, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import {
  type EditorCommand,
  type Region,
  type Annotation,
  type ElementAddress,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  Section,
  useEditorWorkspace,
  type EditorLayoutProps,
  type EditorWorkspaceProps,
  type EditorWorkspaceTransition,
} from '@editor-platform/editor-ui';
import { activeBlock, jumpToBlock } from './engine';
import { createLocalDocumentCommand, sameDocumentProjection } from './local-engine-command';
import { isVerticalDocument, type DocumentContent } from './model';
import { documentActions } from './view-actions';
import {
  DocumentDocxExport,
  DocumentFindBar,
  InsertBlockDialog,
  LinkDialog,
  RubyDialog,
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
import {
  NovelManuscriptPanel,
  NovelReading,
  NovelSceneList,
  type DocumentNovelOptions,
  type DocumentWorkspace,
} from './novel-workspace';
import {
  hasDocumentMark,
  pageStyle,
  type DocumentCallbacks,
  type DocumentTextBridge,
} from './view-model';
import { documentOutline, documentStatus, toolButtonFor } from './view-parts';
import { DocumentExportMenu, DocumentToolbar } from './view-toolbar';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import './styles.css';

export { blockLabels, type DocumentTextBridge } from './view-model';
export type { DocumentNovelOptions, DocumentWorkspace } from './novel-workspace';
export type DocumentWorkspaceTransition = EditorWorkspaceTransition<DocumentWorkspace>;

export interface DocumentSurfaceProps
  extends ReferenceSurfaceProps,
    EditorWorkspaceProps<DocumentWorkspace> {
  textEngine?: DocumentTextBridge;
  content: DocumentContent;
  execute: (command: EditorCommand<DocumentContent>) => void;
  select: (id: string, region?: Region) => void;
  selectedId?: string;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
  readOnly?: boolean;
  layout?: Pick<EditorLayoutProps, 'panels' | 'defaultPanels' | 'onPanelsChange' | 'viewKey'>;
  /** Host-owned inputs of the novel workspace. Passing it or `workspace` shows the switch. */
  novel?: DocumentNovelOptions;
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
  workspace,
  onWorkspaceRequest,
  onWorkspaceTransition,
  novel,
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
  const work = useEditorWorkspace<DocumentWorkspace>(
    'document',
    { workspace, onWorkspaceRequest, onWorkspaceTransition },
    inputs,
  );
  // The novel workspace is offered only when the Host opts in; ordinary Documents keep their chrome.
  const offerNovel = workspace !== undefined || novel !== undefined;
  // Withdrawing the opt-in always returns to the ordinary Document chrome.
  const novelShown = offerNovel && work.displayed === 'novel';
  const vertical = isVerticalDocument(content);
  // Upright digits are view decorations; recompute them when the manuscript setting flips.
  useEffect(() => view.current?.setProps({}), [vertical]);
  // 執筆/通読 inside the novel workspace uses the same pending rules as the workspace switch.
  const mode = useEditorWorkspace<'write' | 'read'>('write', {}, inputs);
  const reading = novelShown && mode.displayed === 'read' && !!novel?.reading;
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
    [rubyOpen, setRubyOpen] = useState(false),
    [ruby, setRuby] = useState(''),
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
    setRuby,
    setRubyOpen,
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
  const switchRow = (
    <div className="ep-workspace-switch" role="group" aria-label="Workspace">
      <button
        type="button"
        aria-pressed={novelShown}
        onClick={() => work.request(novelShown ? 'document' : 'novel')}
      >
        {novelShown ? 'Documentで詳細編集' : '小説ワークスペース'}
      </button>
      {novelShown && history && (
        <>
          <button onClick={() => history.undo()} aria-label="元に戻す" disabled={readOnly}>
            ↶
          </button>
          <button onClick={() => history.redo()} aria-label="やり直す" disabled={readOnly}>
            ↷
          </button>
        </>
      )}
      {novelShown && !reading && (
        <button
          type="button"
          disabled={readOnly}
          title="選んだ文字にルビ（読み）を付けます"
          // Keep the editor selection: the dialog reads it when it opens.
          onMouseDown={(event) => event.preventDefault()}
          onClick={actions.openRuby}
        >
          ルビ
        </button>
      )}
      {novelShown && !reading && (
        <button
          type="button"
          disabled={readOnly}
          aria-pressed={hasDocumentMark(engineState, 'emphasisDots')}
          title="選んだ文字に傍点を付けます。もう一度押すと外します"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => actions.mark('emphasisDots')}
        >
          傍点
        </button>
      )}
      {novelShown && !reading && (
        <button
          type="button"
          aria-pressed={vertical}
          disabled={readOnly}
          title="原稿の書字方向を切り替えます（Undoで戻せます）"
          onClick={() =>
            actions.pageSetting({ writingMode: vertical ? 'horizontal-tb' : 'vertical-rl' })
          }
        >
          縦書き
        </button>
      )}
      {novelShown && (
        <span role="group" aria-label="執筆と通読">
          <button type="button" aria-pressed={!reading} onClick={() => mode.request('write')}>
            執筆
          </button>
          <button
            type="button"
            aria-pressed={reading}
            disabled={!novel?.reading}
            title={
              novel?.reading
                ? undefined
                : (novel?.readingUnavailable ?? '保存した章を結合すると通読できます')
            }
            onClick={() => mode.request('read')}
          >
            通読
          </button>
        </span>
      )}
      {novelShown && !novel?.reading && novel?.readingUnavailable && (
        <span role="status" className="ep-novel-note">
          {novel.readingUnavailable}
        </span>
      )}
      {mode.pending && novelShown && <span role="status">{mode.reason}</span>}
      {work.pending && (
        <>
          <span role="status">{work.reason || '画面を切り替えています'}</span>
          <button onClick={() => work.request(work.displayed)}>切替を取り消す</button>
        </>
      )}
    </div>
  );
  // No wrapper: Hosts size the EditorLayout root directly, and the text engine mount must survive
  // a Host that starts or stops offering the novel workspace.
  return (
    <EditorLayout
      {...layout}
      viewKey={layout?.viewKey ?? 'document'}
      leftLabel={novelShown ? '章・シーン' : 'Document outline'}
      inspectorLabel={novelShown ? '原稿と照合' : 'Document inspector'}
      left={
        novelShown ? (
          <NovelSceneList
            content={content}
            options={novel}
            selectedId={selected?.id}
            choose={chooseOutline}
          />
        ) : (
          documentOutline(content.blocks, selected?.id, chooseOutline)
        )
      }
      inspector={
        <>
          {/* Stays mounted in the novel workspace so buffered source fields are never dropped. */}
          <div hidden={novelShown}>
            <DocumentInspector
              selected={selected}
              references={references}
              readOnly={readOnly}
              engineState={engineState}
              content={content}
              actions={actions}
              toolButton={toolButton}
            />
          </div>
          {novelShown && novel?.references}
          {novelShown && (
            <Section title="参照：地図・画像">
              <p>保存版を明示的に固定します。人物・場所の設定リンクとは別の画像参照です。</p>
              <ReferenceTools
                identity={selected?.id}
                resolver={references}
                readOnly={readOnly || reading}
                insert={(reference, src, label) =>
                  actions.insert('image', { reference, src, alt: label, width: 600 })
                }
              />
              {selected?.type === 'image' && !reading && (
                <ReferenceInspector
                  item={selected}
                  fitSupported={false}
                  resolver={references}
                  readOnly={readOnly}
                  patch={(patch) => actions.patchBlock(patch)}
                />
              )}
            </Section>
          )}
          {novelShown && (
            <NovelManuscriptPanel
              content={content}
              options={novel}
              readOnly={readOnly}
              choose={chooseOutline}
              annotations={annotations}
            />
          )}
        </>
      }
      status={documentStatus(textMetrics, content, readOnly)}
      toolbar={
        !novelShown && (
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
        )
      }
    >
      <div
        className="ep-document-column"
        {...(offerNovel
          ? {
              'data-workspace': novelShown ? 'novel' : 'document',
              ...bothEvents(work.events, mode.events),
            }
          : {})}
      >
        {offerNovel && switchRow}
        {reading && <NovelReading reading={novel!.reading!} references={references} />}
        {/* The text engine stays mounted (only hidden) while the saved read-through is shown. */}
        <div
          className="ep-document-scroll"
          hidden={reading}
          data-writing-mode={vertical ? 'vertical-rl' : undefined}
        >
          {findOpen && <DocumentFindBar finder={finder} readOnly={readOnly} />}
          {error && (
            <p role="alert" className="ep-error">
              {error}
            </p>
          )}
          <div
            className="ep-document-page"
            data-window-text={content.blocks.length > 200 || undefined}
            data-writing-mode={vertical ? 'vertical-rl' : undefined}
            style={pageStyle(content)}
          >
            <div ref={mount} />
          </div>
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
      {rubyOpen && <RubyDialog ruby={ruby} setRuby={setRuby} actions={actions} />}
    </EditorLayout>
  );
}

type CaptureEvents = Record<string, (event: never) => void>;
/** Both transitions observe the same drags and IME compositions. */
function bothEvents<T extends CaptureEvents>(a: T, b: T): T {
  return Object.fromEntries(
    Object.keys(a).map((key) => [key, (event: never) => (a[key](event), b[key](event))]),
  ) as T;
}
