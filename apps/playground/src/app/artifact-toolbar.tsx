import { Save, History, Download, MoreHorizontal, MessageSquare, Undo2, Redo2 } from 'lucide-react';
import { IconButton, Menu } from '@editor-platform/editor-ui';
import { isStructureInstance } from '@editor-platform/templates';
import type { ExtensionAction, Selection } from '@editor-platform/editor-core';
import type { SharedPlaygroundConnection } from './types';
import type { SharedPreviewState } from './proposal-views';
import { downloadText, hasUnsupportedSharedAnimation, type StoredArtifact } from '../model';

export type ArtifactView = 'Editor' | 'History' | 'Compare';

/** Library dialogs opened from the overflow menu. */
export type ArtifactMenuAction =
  | 'style-library'
  | 'save-reusable'
  | 'reusable-library'
  | 'reusable-inspect'
  | 'reuse-batch'
  | 'save-view-settings'
  | 'view-settings-library'
  | 'fragment-template'
  | 'structure'
  | 'preset'
  | 'save-template';

const reusableKinds = ['design', 'document', 'slide', 'whiteboard', 'data'];
const templateExcludedKinds = [
  'review',
  'file',
  'react-ui',
  'structured-graph',
  'geo',
  'animation',
  'schedule',
  'cad',
];
const nonNativeKinds = ['react-ui', 'structured-graph', 'geo', 'animation', 'schedule', 'cad'];

export interface HistoryControls {
  undoDisabled: boolean;
  redoDisabled: boolean;
  undo(): void;
  redo(): void;
}

export function ViewTabs({
  view,
  versionCount,
  onSelect,
}: {
  view: ArtifactView;
  versionCount: number;
  onSelect(view: ArtifactView): void;
}) {
  return (
    <Menu label="History and compare" icon={History} align="right">
      <div role="tablist" aria-label="Artifact views">
        {(['Editor', 'History', 'Compare'] as const).map((tab) => (
          <button role="tab" key={tab} aria-selected={view === tab} onClick={() => onSelect(tab)}>
            {tab}
            {tab === 'History' ? ` (${versionCount})` : ''}
          </button>
        ))}
      </div>
    </Menu>
  );
}

export function ExportMenu({
  documentText,
  csv,
  onJson,
  onDocumentText,
  onCsv,
  onDownloadFile,
}: {
  documentText: boolean;
  csv: boolean;
  onJson(): void;
  onDocumentText(format: 'markdown' | 'html'): void;
  onCsv(): void;
  onDownloadFile?(): void;
}) {
  return (
    <Menu label="Export artifact" icon={Download} align="right">
      <button onClick={onJson}>Export JSON</button>
      {documentText && (
        <>
          <button onClick={() => onDocumentText('markdown')}>Export Markdown</button>
          <button onClick={() => onDocumentText('html')}>Export HTML</button>
        </>
      )}
      {csv && <button onClick={onCsv}>Export CSV</button>}
      {onDownloadFile && <button onClick={onDownloadFile}>Download file</button>}
    </Menu>
  );
}

function ReuseMenuItems({
  active,
  readOnly,
  nativeReuseSupported,
  onAction,
}: {
  active: StoredArtifact;
  readOnly: boolean;
  nativeReuseSupported: boolean;
  onAction(action: ArtifactMenuAction): void;
}) {
  const nativeKind = !nonNativeKinds.includes(active.kind);
  const templateKind = nativeReuseSupported && !templateExcludedKinds.includes(active.kind);
  const content = active.draft.content;
  return (
    <>
      {nativeKind && nativeReuseSupported && (
        <button onClick={() => onAction('style-library')}>トークン・スタイル</button>
      )}
      {nativeReuseSupported && reusableKinds.includes(active.kind) && (
        <>
          <button disabled={readOnly} onClick={() => onAction('save-reusable')}>
            再利用部品として保存
          </button>
          <button onClick={() => onAction('reusable-library')}>部品ライブラリ</button>
          <button onClick={() => onAction('reusable-inspect')}>部品の入力・表示</button>
          <button onClick={() => onAction('reuse-batch')}>複数の成果物の部品を更新</button>
        </>
      )}
      {['review', 'file'].includes(active.kind) && (
        <>
          <button onClick={() => onAction('save-view-settings')}>表示設定を保存</button>
          <button onClick={() => onAction('view-settings-library')}>表示設定ライブラリ</button>
        </>
      )}
      {templateKind && (
        <button disabled={readOnly} onClick={() => onAction('fragment-template')}>
          部分テンプレートを挿入
        </button>
      )}
      {'reuse' in content && content.reuse?.instances.some(isStructureInstance) && (
        <button disabled={readOnly} onClick={() => onAction('structure')}>
          項目数・配置を変更
        </button>
      )}
      <button disabled={!nativeKind || !nativeReuseSupported} onClick={() => onAction('preset')}>
        スタイル・表示プリセット
      </button>
      {templateKind && (
        <button disabled={readOnly} onClick={() => onAction('save-template')}>
          テンプレートとして保存
        </button>
      )}
    </>
  );
}

function SharedSessionMenuItems({
  shared,
  active,
  readOnly,
  flushInputs,
  setPreview,
  setError,
}: {
  shared: SharedPlaygroundConnection;
  active: StoredArtifact;
  readOnly: boolean;
  flushInputs(): boolean;
  setPreview(preview: SharedPreviewState): void;
  setError(message: string): void;
}) {
  const fail = (e: unknown) => setError(String(e));
  const session = shared.session;
  const annotationSurface = active.kind === 'review' || active.kind === 'file';
  const attempt = (run: () => void) => () => {
    try {
      run();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <a href={shared.peerUrl} target="_blank" rel="noreferrer">
        Open peer editor
      </a>
      <button
        disabled={readOnly || annotationSurface}
        title={
          annotationSurface
            ? 'This surface uses shared annotations instead of content proposals'
            : undefined
        }
        onClick={() => {
          void shared
            .requestProposal()
            .then(async (id) => {
              setPreview({ id, preview: await session.adapter.previewProposal(id) });
            })
            .catch(fail);
        }}
      >
        Agent proposal demo
      </button>
      <button onClick={() => void session.reconnect().catch(fail)}>Reconnect shared session</button>
      <button
        onClick={() =>
          downloadText(
            `${active.name}.session-checkpoint.json`,
            JSON.stringify(session.checkpoint()),
            'application/json',
          )
        }
      >
        Export pending checkpoint
      </button>
      <button disabled={!session.pendingCount} onClick={() => session.discardUnsubmitted()}>
        Cancel unsubmitted edits
      </button>
      {session.rejected.length > 0 && (
        <>
          <button
            onClick={() => {
              void session.previewRetained().then(setPreview).catch(fail);
            }}
          >
            Preview retained edit again
          </button>
          <button onClick={attempt(() => session.retryText())}>Retry retained text</button>
          <button onClick={attempt(() => session.discardRetained())}>Discard retained input</button>
        </>
      )}
      <button
        onClick={async () => {
          if (!flushInputs()) return;
          try {
            await session.flush();
            if (session.pendingCount || session.rejected.length)
              throw new Error('変更の確認が完了してから共有セッションを終了してください。');
            session.close();
            shared.leave();
          } catch (e) {
            fail(e);
          }
        }}
      >
        Leave shared session
      </button>
      {shared.hostActions?.map((action) => (
        <button
          key={action.label}
          onClick={() => {
            void Promise.resolve(action.run()).catch(fail);
          }}
        >
          {action.label}
        </button>
      ))}
    </>
  );
}

export function MoreActionsMenu({
  active,
  history,
  readOnly,
  nativeReuseSupported,
  shared,
  inspector,
  selection,
  toolbar,
  externalProposal,
  flushInputs,
  onAction,
  onStartShared,
  onToggleInspector,
  onReadOnlyChange,
  setPreview,
  setError,
}: {
  active: StoredArtifact;
  history: HistoryControls;
  readOnly: boolean;
  nativeReuseSupported: boolean;
  shared: SharedPlaygroundConnection | undefined;
  inspector: boolean;
  selection: Selection;
  toolbar: ExtensionAction[] | undefined;
  /** Offers the local external proposal demo when set. */
  externalProposal?(): void;
  flushInputs(): boolean;
  onAction(action: ArtifactMenuAction): void;
  /** Starts a shared session; absent when the Host does not offer one. */
  onStartShared?(): void;
  onToggleInspector(): void;
  onReadOnlyChange(readOnly: boolean): void;
  setPreview(preview: SharedPreviewState): void;
  setError(message: string): void;
}) {
  const canStartShared =
    !shared &&
    onStartShared &&
    !hasUnsupportedSharedAnimation(active) &&
    active.kind !== 'structured-graph' &&
    active.kind !== 'geo' &&
    active.kind !== 'schedule' &&
    active.kind !== 'cad';
  return (
    <Menu label="More artifact actions" icon={MoreHorizontal} align="right">
      <div className="mobile-history-actions">
        <button aria-label="Undo" disabled={history.undoDisabled} onClick={history.undo}>
          Undo
        </button>
        <button aria-label="Redo" disabled={history.redoDisabled} onClick={history.redo}>
          Redo
        </button>
      </div>
      <ReuseMenuItems
        active={active}
        readOnly={readOnly}
        nativeReuseSupported={nativeReuseSupported}
        onAction={onAction}
      />
      {canStartShared && <button onClick={onStartShared}>Open collaboratively</button>}
      {shared && (
        <SharedSessionMenuItems
          shared={shared}
          active={active}
          readOnly={readOnly}
          flushInputs={flushInputs}
          setPreview={setPreview}
          setError={setError}
        />
      )}

      {active.kind !== 'animation' && (
        <button
          disabled={active.kind === 'structured-graph' || active.kind === 'cad'}
          aria-expanded={inspector}
          onClick={onToggleInspector}
        >
          <MessageSquare size={16} />
          Comments ({active.annotations.length})
        </button>
      )}
      <label>
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(e) => onReadOnlyChange(e.target.checked)}
        />{' '}
        Read only
      </label>
      {externalProposal && (
        <button disabled={readOnly} onClick={externalProposal}>
          External proposal demo
        </button>
      )}
      {toolbar?.map((action) => (
        <button key={action.id} onClick={() => action.run(selection)}>
          {action.label}
        </button>
      ))}
    </Menu>
  );
}

export function HistoryButtons({
  history,
  busy,
  readOnly,
  onSave,
}: {
  history: HistoryControls;
  busy: boolean;
  readOnly: boolean;
  onSave(): void;
}) {
  return (
    <>
      <IconButton
        icon={Undo2}
        label="Undo"
        shortcut="Ctrl/⌘ Z"
        disabled={history.undoDisabled}
        reason="No editable earlier state"
        onClick={history.undo}
      />
      <IconButton
        icon={Redo2}
        label="Redo"
        shortcut="Ctrl/⌘ Shift Z"
        disabled={history.redoDisabled}
        reason="No later state"
        onClick={history.redo}
      />
      <IconButton
        icon={Save}
        label="Save version"
        shortcut="Ctrl/⌘ S"
        disabled={busy || readOnly}
        onClick={onSave}
      />
    </>
  );
}
