import { createEstimateReferenceAdapter } from '@editor-platform/estimate/references';
import { playgroundEstimateQuantities } from './app/estimate-bim';
import { createAnalysisReferenceAdapter } from '@editor-platform/analysis/references';
import { verifyPlaygroundEstimate as verifyEstimateArtifact } from './app/estimate-bim';
import { verifyAnalysisArtifact } from '@editor-platform/analysis/host';
import { serializeHostNativeArtifact } from '@editor-platform/editor-host';
import { savedAnimationCatalog } from './animation-library';
import { validateGeoRecord } from './geo/resources';
import {
  assertCadNativeFits,
  mergeCadResources,
  portableCadRecord,
  validateCadRecord,
} from './cad/resources';
import { assertBimNativeFits, portableBimRecord, validateBimParts } from './bim/parts';
import { assertCadContentFits } from './cad/native-size';
import { mergeCadParts } from './cad/parts';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { artifactReferenceItems, captureArtifactReferences } from './artifact-references';
import type { PrivateVideoEntry } from './private-video/catalog';
import { relationProfile, isGraphDocument, validateGraph } from '@editor-platform/structured-graph';
import { flushSync } from 'react-dom';
import type { ScheduleDocument } from '@editor-platform/schedule/model';
import type { CadDocument } from '@editor-platform/cad-core';
import { stepScheduleHistory } from '@editor-platform/schedule/history';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import {
  applyLocalTemplate,
  localTemplateSnapshot,
  previewSharedTemplate,
  applySharedTemplate,
  editPrivateViewSettings,
  type PrivateViewSettings,
  type TemplateKind,
  type Domain,
  type InputValue,
  type PreparedApplication,
} from '@editor-platform/templates';
import { CanvasTextContext, CanvasPresenceContext } from '@editor-platform/canvas-ui';
import {
  threadsToAnnotations,
  type SharedEditorSession,
} from '@editor-platform/collaboration-adapters';
import type { Preview } from '@editor-platform/collaboration-core';
import {
  IconButton,
  isTextInput,
  EditorInputsContext,
  EditorHistoryContext,
} from '@editor-platform/editor-ui';
import { Library } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  canonicalJson,
  clone,
  commitVersion,
  newId,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import {
  command,
  reviewProposedCommands,
  EditorEventBus,
  EditorSession,
  EditorInputs,
  transaction,
  sameLocalRevision,
  type EditorCommand,
  type EditorExtensions,
  type Region,
  type Selection,
  type ElementAddress,
  type Annotation,
} from '@editor-platform/editor-core';
import {
  captureDocumentReferences,
  exportHtml,
  exportMarkdown,
  isDocument,
} from '@editor-platform/document';
import {
  isStructuredData,
  validateData,
  type DataView,
  defaultView,
} from '@editor-platform/structured-data';
import { type ReviewVisibleSource } from '@editor-platform/review-surfaces';
import {
  downloadFile,
  downloadText,
  makeArtifact,
  createLocalSession,
  type Content,
  type Kind,
  type StoredArtifact,
} from './model';
import { hasSlideAnimations } from '@editor-platform/slide';
import {
  type ArtifactMenuAction,
  ExportMenu,
  HistoryButtons,
  MoreActionsMenu,
  ViewTabs,
} from './app/artifact-toolbar';
import { CommentsInspector, replyToThread, toggleThreadResolved } from './app/comments-inspector';
import {
  ErrorBanner,
  LibraryPanel,
  LoadErrorBanners,
  WelcomePanel,
  type PrivateVideoLaunchers,
} from './app/library-panel';
import { ProposalDialog, SharedProposalInspector, type LocalProposal } from './app/proposal-views';
import { mockProposal, proposalAdapter, proposalSupported } from './app/proposal-runtime';
import { CompareView, HistoryView, compareVersions } from './app/version-views';
import { editedDraft, openStoredRecord, storage } from './app/records';
import { deliverComment as deliverCommentTo, type CommentAttempt } from './app/comment-delivery';
import { readIfcImport, readImportFiles } from './app/import-artifact';
import type { BimIfcImportReport } from '@editor-platform/bim/ifc-import';
import { savedRecordReferences } from './app/reference-source';
import {
  ArtifactDialogs,
  SaveVersionDialog,
  type DialogHost,
  type OpenDialogs,
  type TemplateAuthoring,
} from './app/artifact-dialogs';
import { nativeContent, nativeShared } from './app/native';
import { EditorSurfaces, checkedContent, type SurfaceHost } from './app/editor-surfaces';
import type { SharedPlaygroundConnection } from './app/types';
import { graphProfileFor, type GraphTemplateId } from './app/graph-templates';
export const editorEvents = new EditorEventBus();
export type { SharedPlaygroundConnection };
export interface PlaygroundProps {
  privateEntries?: PrivateVideoEntry[];
  privateM2Entries?: PrivateVideoEntry[];
  onOpenPrivateM2?(id?: string): void;
  onOpenPrivateEditor?(id?: string): void;
  extensions?: EditorExtensions;
  inspectorSlot?: ReactNode;
  shared?: SharedPlaygroundConnection;
  onStartShared?(record: StoredArtifact): Promise<void>;
}
const BimIfcLossDialog = lazy(() =>
  import('@editor-platform/bim/ifc-import').then((m) => ({ default: m.BimIfcLossDialog })),
);

export default function App({
  privateEntries = [],
  privateM2Entries = [],
  onOpenPrivateM2,
  onOpenPrivateEditor,
  extensions = {},
  inspectorSlot,
  shared,
  onStartShared,
}: PlaygroundProps) {
  const [, renderShared] = useState(0);
  const [structureOpen, setStructureOpen] = useState(false);
  const [templateKind, setTemplateKind] = useState<TemplateKind>();
  const [authoring, setAuthoring] = useState<TemplateAuthoring>();
  const [reusableOpen, setReusableOpen] = useState<'library' | 'inspect'>();
  const [styleLibraryOpen, setStyleLibraryOpen] = useState(false);
  const [reuseBatchOpen, setReuseBatchOpen] = useState(false);
  const [reusableAnnotation, setReusableAnnotation] = useState<ElementAddress>();
  const [templateViewSettings, setTemplateViewSettings] = useState<
    Record<string, Record<string, InputValue>>
  >(() => {
    try {
      return JSON.parse(localStorage.getItem('ep-template-view-settings') ?? '{}');
    } catch {
      return {};
    }
  });
  const privateViewsRef = useRef(templateViewSettings);
  privateViewsRef.current = templateViewSettings;
  function savePrivateSettings(id: string, settings: PrivateViewSettings, expected?: string) {
    const current = privateViewsRef.current;
    if (expected !== undefined && canonicalJson(current[id] ?? {}) !== expected)
      throw new Error('表示設定が変更されました。もう一度プレビューしてください。');
    const next = { ...current, [id]: clone(settings) };
    localStorage.setItem('ep-template-view-settings', JSON.stringify(next));
    privateViewsRef.current = next;
    setTemplateViewSettings(next);
  }
  function editPrivateSettings(id: string, patch: PrivateViewSettings) {
    try {
      savePrivateSettings(id, editPrivateViewSettings(privateViewsRef.current[id] ?? {}, patch));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const [sharedPreview, setSharedPreview] = useState<{ id: string; preview: Preview<Content> }>();
  const sharedSession = shared?.session;
  const sharedProposalRequest = useRef(0);
  useEffect(() => {
    if (!sharedSession) return;
    sharedSession.onChange = () => renderShared((n) => n + 1);
    return () => {
      sharedSession.onChange = () => {};
    };
  }, [sharedSession]);
  const [records, setRecords] = useState<StoredArtifact[]>([]);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const recordsRef = useRef(records);
  const [activeId, setActiveId] = useState('');
  const referenceSavedRecords = useRef(new Map<string, StoredArtifact>());
  const [animationCatalogEpoch, setAnimationCatalogEpoch] = useState(0);
  const referenceNotifications = useRef(new Set<(id: string) => void>());
  const referenceReturn = useRef<ElementAddress | undefined>(undefined);
  const referenceNavigation = useRef<
    (sourceId: string, elementId: string, pageId?: string) => boolean
  >(() => false);
  const references = useMemo(
    () =>
      new ReferenceResolver(
        savedRecordReferences({
          saved: referenceSavedRecords,
          notifications: referenceNotifications,
          navigation: referenceNavigation,
        }),
        [
          ...nativeReferenceAdapters,
          createAnalysisReferenceAdapter(),
          createEstimateReferenceAdapter({ verification: playgroundEstimateQuantities }),
        ],
        activeId,
      ),
    [activeId],
  );

  const inputs = useMemo(() => new EditorInputs(), [activeId]);
  const inputStatus = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<Kind>('document');
  const [graphTemplate, setGraphTemplate] = useState<GraphTemplateId>('relations');
  const [navOpen, setNavOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [localReadOnly, setReadOnly] = useState(false);
  const readOnly = localReadOnly || !!sharedSession?.readOnly || !!sharedPreview;
  const reuseBatchAccess = useRef({ readOnly, sharedSession });
  reuseBatchAccess.current = { readOnly, sharedSession };
  const reuseBatchReceipts = useRef(
    new Map<
      string,
      {
        fingerprint: string;
        localApplied?: boolean;
        session?: SharedEditorSession<Content>;
        token?: string;
      }
    >(),
  );
  const saveGeneration = useRef(0);
  const [view, setView] = useState<'Editor' | 'History' | 'Compare'>('Editor');
  const [selection, setSelection] = useState<Selection>({ addresses: [] });
  const [revealAddress, setRevealAddress] = useState<ElementAddress>();
  const savingVersion = useRef(false);
  const [comment, setComment] = useState('');
  const visibleReviewSource = useRef<
    { artifactId: string; source: ReviewVisibleSource } | undefined
  >(undefined);
  const [csvExportOpen, setCsvExportOpen] = useState(false);
  const [dataViews, setDataViews] = useState<Record<string, DataView>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('ep-data-view-state') ?? '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  });
  const dataViewsRef = useRef(dataViews);
  dataViewsRef.current = dataViews;
  const dataViewChanged = useMemo(
    () => (view: DataView) => {
      if (!activeId) return;
      setDataViews((current) => {
        if (canonicalJson(current[activeId]) === canonicalJson(view)) return current;
        const next = { ...current, [activeId]: clone(view) };
        const retained = Object.fromEntries(
          Object.entries(next).map(([id, preference]) => {
            const content = recordsRef.current.find((record) => record.id === id)?.draft.content;
            const widgets = isStructuredData(content)
              ? (content.views?.find((saved) => saved.id === preference.id)?.widgets ??
                defaultView(content).widgets)
              : [];
            return [id, { ...preference, widgets }];
          }),
        );
        try {
          localStorage.setItem('ep-data-view-state', JSON.stringify(retained));
        } catch {
          /* In-session preferences remain available when Host storage is full. */
        }
        return next;
      });
    },
    [activeId],
  );
  const [inspector, setInspector] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const [status, setStatus] = useState('Loading library…');
  const [officeImportOpen, setOfficeImportOpen] = useState(false);
  const officeCreationAllowed = useRef(false);
  officeCreationAllowed.current = !shared && !readOnly;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('');
  const [proposal, setProposal] = useState<LocalProposal | null>(null);
  /** An IFC import waiting for the user to see what it loses. */
  const [ifcLoss, setIfcLoss] = useState<{ file: File; report: BimIfcImportReport }>();
  const [contextMenu, setContextMenu] = useState(false);
  const sessions = useRef(new Map<string, EditorSession<Content>>());
  const writeQueue = useRef(Promise.resolve());
  const privateTransition = useRef(false);
  const failedWrites = useRef(new Set<string>());
  const submittingComments = useRef(new Set<string>());
  const commentAttempts = useRef(new Map<string, CommentAttempt>());

  const localActive = records.find((a) => a.id === activeId);
  const active =
    shared && sharedSession
      ? {
          ...shared.record,
          draft: {
            ...shared.record.draft,
            content: sharedSession.viewContent,
            baseVersionId: sharedSession.savedVersions.at(-1)?.version.versionId ?? null,
          },
          versions: sharedSession.savedVersions.map((v) => v.version),
          annotations: sharedSession.annotations,
        }
      : localActive && !loadErrors[localActive.id]
        ? localActive
        : undefined;
  const session = sharedSession ?? (active ? sessions.current.get(active.id) : undefined);
  const currentTarget = useRef({
    activeId: active?.id ?? activeId,
    shared,
    inputs,
    selection,
    preview: !!sharedPreview,
    readOnly,
  });
  useLayoutEffect(() => {
    currentTarget.current = {
      activeId: active?.id ?? activeId,
      shared,
      inputs,
      selection,
      preview: !!sharedPreview,
      readOnly,
    };
  });
  useEffect(() => {
    if (
      authoring &&
      (active?.id !== authoring.artifactId ||
        sharedSession !== authoring.session ||
        (readOnly && !['review', 'file'].includes(authoring.domain)))
    )
      setAuthoring(undefined);
  }, [authoring, active?.id, sharedSession, readOnly]);
  useEffect(() => {
    let mounted = true;
    void storage
      .list()
      .then(async (values) => {
        const opened = new Map<string, EditorSession<Content>>(),
          failures: Record<string, string> = {};
        for (const a of values) {
          try {
            opened.set(a.id, await openStoredRecord(a, references));
            referenceSavedRecords.current.set(a.id, a);
          } catch (e) {
            failures[a.id] = String(e);
          }
        }
        if (!mounted) return;
        setAnimationCatalogEpoch((epoch) => epoch + 1);
        setRecords(values);
        recordsRef.current = values;
        sessions.current = opened;
        setLoadErrors(failures);
        let preferred: string | null = null;
        try {
          preferred = localStorage.getItem('ep-active-artifact');
        } catch {
          /* private view preference */
        }
        setActiveId(
          preferred && opened.has(preferred) ? preferred : (opened.keys().next().value ?? ''),
        );
        setLoaded(true);
        setStatus('Saved locally');
      })
      .catch((e) => {
        setLoaded(true);
        setError(`Unable to open local storage: ${String(e)}`);
      });
    return () => {
      mounted = false;
    };
  }, []);
  /** `stored` is for a record already written, e.g. as part of an atomic import. */
  function persist(record: StoredArtifact, stored = false) {
    const next = recordsRef.current.some((a) => a.id === record.id)
      ? recordsRef.current.map((a) => (a.id === record.id ? record : a))
      : [...recordsRef.current, record];
    recordsRef.current = next;
    setRecords(next);
    setStatus('Saving locally…');
    const generation = ++saveGeneration.current;
    const completion = writeQueue.current
      .then(() => {
        serializeHostNativeArtifact(record);
        return stored ? undefined : storage.put(record);
      })
      .then(() => {
        const priorSource = referenceSavedRecords.current.get(record.id);
        referenceSavedRecords.current.set(record.id, record);
        if (
          record.kind === 'animation' &&
          (priorSource?.name !== record.name || priorSource?.versions !== record.versions)
        )
          setAnimationCatalogEpoch((epoch) => epoch + 1);
        if (priorSource?.versions.at(-1)?.versionId !== record.versions.at(-1)?.versionId)
          for (const notify of referenceNotifications.current) notify(record.id);
        failedWrites.current.delete(record.id);
        if (generation === saveGeneration.current)
          setStatus(failedWrites.current.size ? 'Not saved' : 'Saved locally');
        if (!failedWrites.current.size)
          setError((message) => (message.startsWith('Local save failed:') ? '' : message));
        return true;
      })
      .catch((e) => {
        failedWrites.current.add(record.id);
        setError(`Local save failed: ${String(e)}. Export your artifact to preserve it.`);
        setStatus('Not saved');
        return false;
      });
    writeQueue.current = completion.then(() => {});
    return completion;
  }
  async function openPrivateEditor(id?: string, m2 = false) {
    const open = m2 ? onOpenPrivateM2 : onOpenPrivateEditor;
    if (!open || shared || busy || savingVersion.current || !loaded || privateTransition.current)
      return;
    privateTransition.current = true;
    if (!flushInputs()) {
      privateTransition.current = false;
      return;
    }
    const target = currentTarget.current;
    const generation = saveGeneration.current;
    const queue = writeQueue.current;
    let inputChanged = false;
    const stop = inputs.subscribe(() => {
      inputChanged = true;
    });
    setBusy(true);
    try {
      await queue;
      const current = currentTarget.current;
      const pending = inputs.getSnapshot();
      if (
        inputChanged ||
        pending.dirty ||
        pending.composing ||
        generation !== saveGeneration.current ||
        queue !== writeQueue.current ||
        current.activeId !== target.activeId ||
        current.inputs !== inputs ||
        current.shared !== target.shared ||
        current.preview !== target.preview
      )
        throw new Error(
          'Editor changed while waiting to switch. Your draft and pending input are retained; finish saving and try again.',
        );
      if (failedWrites.current.size)
        throw new Error('Resolve the local save error before switching Editors');
      open(id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      stop();
      privateTransition.current = false;
      setBusy(false);
    }
  }
  async function reuseBatchBasis(id: string) {
    const current = reuseBatchAccess.current;
    if (current.sharedSession?.confirmed.artifactId === id) {
      if (current.sharedSession.pendingCount) throw new Error('入力の同期完了を待ってください。');
      return {
        state: {
          ...current.sharedSession.confirmed,
          content: nativeContent(current.sharedSession.confirmed.content),
        },
        identity: current.sharedSession.adapter.identity,
      };
    }
    const record = recordsRef.current.find((r) => r.id === id);
    if (!record) throw new Error('成果物が見つかりません。');
    return {
      state: localTemplateSnapshot(
        record.id,
        record.kind as Domain,
        nativeContent(record.draft.content),
      ),
      identity: { actorId: 'local', clientId: 'local', sessionId: 'local' },
    };
  }
  async function applyReuseBatch(prepared: PreparedApplication) {
    const access = reuseBatchAccess.current;
    if (access.readOnly) throw new Error('Read only');
    const id = prepared.proposal.artifactId,
      fingerprint = canonicalJson(prepared.proposal);
    const old = reuseBatchReceipts.current.get(prepared.id);
    if (old && old.fingerprint !== fingerprint) throw new Error('更新要求の内容が一致しません。');
    const receipt = old ?? { fingerprint };
    reuseBatchReceipts.current.set(prepared.id, receipt);
    const sharedTarget =
      access.sharedSession?.confirmed.artifactId === id ? access.sharedSession : undefined;
    if (receipt.session && receipt.session !== sharedTarget)
      throw new Error('共有接続が変わりました。対象の成果物で更新結果を確認してください。');
    if (sharedTarget) {
      if (receipt.localApplied)
        throw new Error('適用後に共有接続が変わりました。結果を確認してください。');
      receipt.session = sharedTarget;
      if (!receipt.token)
        receipt.token = (await previewSharedTemplate(prepared, nativeShared(sharedTarget)!)).token;
      try {
        await applySharedTemplate(prepared, nativeShared(sharedTarget)!, receipt.token);
      } catch (error) {
        if (
          sharedTarget.lastReceipt?.operationId === `proposal:${prepared.id}` &&
          sharedTarget.lastReceipt.status === 'rejected'
        )
          delete receipt.token;
        throw error;
      }
      return;
    }
    const record = recordsRef.current.find((r) => r.id === id),
      session = sessions.current.get(id);
    if (!record || !session) throw new Error('成果物が見つかりません。');
    if (!receipt.localApplied) {
      const next = session.execute(
        command(
          'reuse.apply',
          prepared.proposal.summary,
          (value) => applyLocalTemplate(prepared, nativeContent(value)),
          {
            origin: 'proposal',
            transactionId: prepared.id,
            proposalId: prepared.id,
          },
        ),
      );
      receipt.localApplied = true;
      persist({ ...editedDraft(record, next), annotations: record.annotations });
    } else if (failedWrites.current.has(id)) persist(record);
    await writeQueue.current;
    if (failedWrites.current.has(id))
      throw new Error(
        '変更はメモリ内へ適用済みですが保存に失敗しました。再試行は保存だけを行います。',
      );
  }
  function activate(id: string) {
    if (!flushInputs()) return;
    if (shared) {
      setError('Leave the shared session before switching artifacts.');
      return;
    }
    // A notice about the previous artifact does not follow; a failed local save keeps its retry.
    if (id !== activeId)
      setError((message) => (message.startsWith('Local save failed:') ? message : ''));
    setActiveId(id);
    try {
      localStorage.setItem('ep-active-artifact', id);
    } catch {
      /* private view preference */
    }
    setSelection({ addresses: [] });
    setRevealAddress(undefined);
    setView('Editor');
    setProposal(null);
    setNavOpen(false);
    setInspector(false);
    editorEvents.emit('artifact', { artifactId: id });
  }
  referenceNavigation.current = (sourceId, elementId, pageId) => {
    if (!flushInputs()) return false;
    if (shared) throw new Error('参照元へ移動する前に共有接続を終了してください。');
    const source = recordsRef.current.find((a) => a.id === sourceId);
    if (!source) throw new Error('参照元が見つかりません。');
    if (isStructuredData(source.draft.content)) {
      const content = source.draft.content;
      setDataViews((current) => {
        const previous = current[sourceId];
        const view =
          previous && isStructuredData({ ...content, views: [previous] })
            ? previous
            : (content.views?.[0] ?? defaultView(content));
        // Editing a source starts at its cells; saved views and native history stay canonical.
        return { ...current, [sourceId]: { ...clone(view), projection: 'Grid' } };
      });
    }
    referenceReturn.current = { artifactId: activeId, elementId, pageId };
    activate(sourceId);
    return true;
  };
  function returnFromReference() {
    if (!flushInputs() || !referenceReturn.current) return;
    const target = referenceReturn.current;
    activate(target.artifactId);
    setRevealAddress(target);
    referenceReturn.current = undefined;
  }
  function assertReferenceCaptureCurrent(
    id: string,
    content: Content,
    writing = false,
    allowNativeChanges = false,
  ) {
    if (
      (writing && currentTarget.current.readOnly) ||
      currentTarget.current.activeId !== id ||
      (!allowNativeChanges &&
        recordsRef.current.find((a) => a.id === id)?.draft.content !== content) ||
      inputs.getSnapshot().dirty ||
      inputs.getSnapshot().composing
    )
      throw new Error(
        '取得中に成果物または入力が変わりました。入力を保持しています。再実行してください。',
      );
  }
  function create(nextKind: Kind) {
    if (!flushInputs()) return;
    if (shared) {
      setError('Leave the shared session before creating another artifact.');
      return;
    }
    const a = makeArtifact(
      nextKind,
      records.filter((r) => r.kind === nextKind).length + 1,
      nextKind === 'structured-graph' ? graphTemplate : undefined,
    );
    sessions.current.set(a.id, createLocalSession(a.draft.content));
    persist(a);
    activate(a.id);
  }
  function execute<T extends Content>(cmd: EditorCommand<T>) {
    if (!active || readOnly || (active.kind === 'animation' && (savingVersion.current || busy)))
      return false;
    try {
      if (sharedSession) {
        sharedSession.executeView(cmd as EditorCommand<Content>);
        editorEvents.emit('command', { artifactId: active.id, type: cmd.type, label: cmd.label });
        return true;
      }
      const s = sessions.current.get(active.id)!;
      const content = s.executeView(cmd as EditorCommand<Content>);
      persist({ ...editedDraft(active, content), annotations: active.annotations });
      editorEvents.emit('command', { artifactId: active.id, type: cmd.type, label: cmd.label });
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  function history(direction: 'undo' | 'redo') {
    if (
      !active ||
      !session ||
      readOnly ||
      (active.kind === 'animation' && (savingVersion.current || busy))
    )
      return;
    const pending = inputs.getSnapshot();
    if (active.kind === 'animation' && (pending.dirty || pending.composing)) {
      setError('Animation の入力を適用またはキャンセルしてから履歴を操作してください。');
      return;
    }
    let privateHistory = false;
    flushSync(() => {
      privateHistory = inputs.history(direction);
    });
    if (privateHistory) return;
    if (sharedSession) {
      void sharedSession.history(direction).catch((e) => setError(String(e)));
      return;
    }
    const local = session as EditorSession<Content>;
    let content: Content;
    if (active.kind === 'schedule') {
      // Removing a Schedule event while details hold refused text could lose it: refused.
      const step = stepScheduleHistory(
        local as unknown as EditorSession<ScheduleDocument>,
        direction,
        local.content as unknown as ScheduleDocument,
        pending,
      );
      if ('refused' in step) return setError(step.refused);
      content = step.content as unknown as Content;
    } else if (active.kind === 'cad') {
      // CAD Undo/Redo is admitted like an edit: the native file must still import (CAD23).
      // The history entry itself is checked, so content counted before is not encoded again.
      const record = recordsRef.current.find((r) => r.id === active.id) ?? active;
      try {
        const candidate = local.peekHistory(direction);
        if (candidate !== undefined)
          assertCadContentFits(
            record,
            candidate as unknown as CadDocument,
            direction === 'undo' ? 'Undoする' : 'Redoする',
          );
        content = local[direction]();
      } catch (e) {
        return setError((e as Error).message);
      }
    } else
      content =
        active.kind === 'react-ui'
          ? local[direction === 'undo' ? 'undoView' : 'redoView']()
          : local[direction]();
    persist({
      ...editedDraft(active, content),
      annotations: active.annotations,
    });
    editorEvents.emit('command', { artifactId: active.id, type: direction, label: direction });
  }
  function select(ids: string | string[], region?: Region, pageId?: string) {
    if (!active) return;
    const next: Selection = {
      addresses: (typeof ids === 'string' ? [ids] : ids).map((elementId) => ({
        artifactId: active.id,
        elementId,
        ...(pageId ? { pageId } : {}),
        ...(region ? { region } : {}),
      })),
    };
    sharedSession?.select(next);
    setSelection((current) => (canonicalJson(current) === canonicalJson(next) ? current : next));
    editorEvents.emit('selection', next);
    next.addresses.forEach((address) => extensions.externalReference?.(address));
  }
  async function saveVersion() {
    if (!active || savingVersion.current || readOnly) return;
    if (!flushInputs({ keepEditor: true })) return;
    const saved = sharedSession
      ? active
      : recordsRef.current.find((record) => record.id === active.id)!;
    if (sharedSession) {
      savingVersion.current = true;
      setBusy(true);
      try {
        await sharedSession.save(reason || 'Manual save');
        setReason('');
      } catch (e) {
        setError(String(e));
      } finally {
        savingVersion.current = false;
        setBusy(false);
      }
      return;
    }
    if (
      isGraphDocument(saved.draft.content) &&
      // Warnings such as a node drawn outside its Section do not block a version.
      validateGraph(
        saved.draft.content,
        graphProfileFor(saved.draft.content) ?? relationProfile,
      ).some((d) => d.severity !== 'warning')
    ) {
      setError('Fix Graph diagnostics before saving a version. Your draft is retained.');
      return;
    }
    if (isStructuredData(saved.draft.content) && validateData(saved.draft.content).length) {
      setError('Fix data validation errors before saving a version. Your draft is retained.');
      return;
    }
    setBusy(true);
    savingVersion.current = true;
    try {
      await verifyEstimateArtifact(saved);
      await verifyAnalysisArtifact(saved);
      if (saved.kind === 'geo') await validateGeoRecord(saved);
      // A version may only name CAD assets the record keeps.
      if (saved.kind === 'cad') await validateCadRecord(portableCadRecord(saved));
      // A building's version may only place CAD versions the record keeps.
      if (saved.kind === 'bim') validateBimParts(portableBimRecord(saved));
      const captured = await captureArtifactReferences(saved.draft.content, references);
      // Plain native versions can commit their owned capture while later native edits remain
      // in the draft. References and Geo resource admission retain strict identity checks.
      const plainCapture =
        saved.kind !== 'geo' &&
        !artifactReferenceItems(saved.draft.content).some((item) => item.reference);
      assertReferenceCaptureCurrent(saved.id, saved.draft.content, true, plainCapture);
      const committed = await commitVersion(
        { ...saved, draft: { ...saved.draft, content: captured } },
        'local-user',
        reason || 'Manual save',
      );
      assertReferenceCaptureCurrent(saved.id, saved.draft.content, true, plainCapture);
      const latest = recordsRef.current.find((a) => a.id === active.id)!;
      const result = {
        ...committed,
        name: latest.name,
        annotations: latest.annotations,
        // CAD assets staged while the version was saved stay: the record only gains them.
        ...mergeCadResources(saved, latest),
        ...mergeCadParts(saved, latest),
        draft: { ...latest.draft, baseVersionId: committed.draft.baseVersionId },
      };
      // A rejected capacity candidate must not enter local immutable history.
      serializeHostNativeArtifact(result);
      assertCadNativeFits(result, 'version');
      assertBimNativeFits(result, 'version');
      if (!(await persist(result)))
        throw new Error('Versionを保存できませんでした。参照更新は通知されていません。');
      setError('');
      setReason('');
      editorEvents.emit('version', {
        artifactId: result.id,
        versionId: result.versions.at(-1)!.versionId,
      });
    } catch (e) {
      setError((e as Error).message);
      setStatus('Not saved');
    } finally {
      savingVersion.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveVersion();
      }
      if (['z', 'y'].includes(e.key.toLowerCase()) && !readOnly) {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        history(e.shiftKey || e.key.toLowerCase() === 'y' ? 'redo' : 'undo');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  async function addComment(targetSelection = selection, body = comment) {
    if (!active || submittingComments.current.has(active.id)) return false;
    const id = active.id;
    submittingComments.current.add(id);
    try {
      return await deliverComment(targetSelection, body);
    } finally {
      submittingComments.current.delete(id);
    }
  }
  async function deliverComment(targetSelection: typeof selection, body: string) {
    if (!active) return false;
    return deliverCommentTo(
      {
        active,
        readOnly,
        sharedSession,
        visibleReviewSource,
        attempts: commentAttempts,
        recordsRef,
        persist,
        emitAnnotation: (annotation) => editorEvents.emit('annotation', annotation),
        clearComment: (body) => setComment((current) => (current === body ? '' : current)),
        setError,
      },
      targetSelection,
      body,
    );
  }
  async function importFiles(files: File[]) {
    if (files.some((f) => /\.ifc$/i.test(f.name))) return importIfc(files);
    if (!flushInputs()) return;
    try {
      const imported = await readImportFiles(files, {
        exists: (id) => recordsRef.current.some((r) => r.id === id),
        references,
      });
      if (!flushInputs()) return;
      await adoptImported(imported);
    } catch (e) {
      setNavOpen(false);
      setError(`Import failed: ${(e as Error).message}`);
    }
  }
  /** An IFC file becomes a new building; a lossy one waits for the user's confirmation. */
  async function importIfc(files: File[], acceptLoss = false) {
    setIfcLoss(undefined);
    if (!flushInputs()) return;
    try {
      if (files.length !== 1) throw new Error('Import an IFC file on its own');
      const result = await readIfcImport(files[0]!, {
        records: () => recordsRef.current,
        acceptLoss,
      });
      if (result.status === 'needs-confirmation')
        return setIfcLoss({ file: files[0]!, report: result.report });
      if (!flushInputs()) return;
      await adoptImported([result.record]);
    } catch (e) {
      setNavOpen(false);
      setError(`Import failed: ${(e as Error).message}`);
    }
  }
  async function adoptImported(imported: StoredArtifact[]) {
    // One transaction for the whole import: a failed write keeps none of its records.
    const write = writeQueue.current.then(() => storage.putAll(imported));
    writeQueue.current = write.catch(() => {});
    await write;
    for (const record of imported) {
      sessions.current.set(record.id, createLocalSession(record.draft.content));
      persist(record, true);
    }
    activate(imported[0].id);
    setError('');
  }
  /** `keepEditor`: a save that leaves the editor open; settling work (a CAD evaluation) may finish after it. */
  function flushInputs(options: { keepEditor?: boolean } = {}) {
    try {
      flushSync(() => inputs.flush(options));
      return true;
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
      return false;
    }
  }
  function changeView(next: 'Editor' | 'History' | 'Compare') {
    if (flushInputs()) setView(next);
  }
  function readCanonicalRecord(id = activeId): StoredArtifact {
    const target = currentTarget.current;
    if (target.activeId !== id) throw new Error('操作中に成果物が切り替わりました。');
    const connection = target.shared;
    if (connection) {
      const session = connection.session;
      if (session.pendingCount || session.rejected.length || target.preview)
        throw new Error('変更の確認が完了してから保存・書き出しを開始してください。');
      if (session.confirmed.artifactId !== id) throw new Error('共有の成果物が切り替わりました。');
      return {
        ...connection.record,
        draft: { ...connection.record.draft, content: session.confirmed.content },
      };
    }
    const current = recordsRef.current.find((record) => record.id === id);
    if (!current) throw new Error('成果物が見つかりません。');
    return current;
  }
  function startAuthoring(reuse: boolean) {
    if (!active || (readOnly && !['review', 'file'].includes(active.kind)) || !flushInputs())
      return;
    try {
      const record = readCanonicalRecord(active.id);
      setAuthoring({
        artifactId: record.id,
        domain: record.kind as Domain,
        content: clone(nativeContent(record.draft.content)),
        ids: currentTarget.current.selection.addresses
          .filter((address) => address.artifactId === record.id)
          .map((address) => address.elementId),
        slideSelection: currentTarget.current.selection.addresses
          .filter((address) => address.artifactId === record.id && address.pageId)
          .map((address) => ({ pageId: address.pageId!, elementId: address.elementId })),
        reuse,
        privateSettings: clone(privateViewsRef.current[record.id]),
        session: currentTarget.current.shared?.session,
      });
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    }
  }
  async function documentTextExport(format: 'markdown' | 'html') {
    if (!active || !flushInputs()) return;
    try {
      await sharedSession?.flush();
      if (
        currentTarget.current.shared?.session !== sharedSession ||
        currentTarget.current.inputs !== inputs
      )
        throw new Error('操作中に成果物または共有接続が切り替わりました。');
      if (inputs.getSnapshot().dirty || inputs.getSnapshot().composing)
        throw new Error(
          '待機中に入力が変更されました。入力を確定して書き出しをやり直してください。',
        );
      const current = readCanonicalRecord(active.id);
      if (!isDocument(current.draft.content)) throw new Error('Document content is unavailable');
      const document = await captureDocumentReferences(
        current.draft.content,
        references,
        format === 'markdown',
      );
      if (!sharedSession) assertReferenceCaptureCurrent(current.id, current.draft.content);
      downloadText(
        `${current.name}.${format === 'markdown' ? 'md' : 'html'}`,
        format === 'markdown' ? exportMarkdown(document) : exportHtml(document),
        format === 'markdown' ? 'text/markdown' : 'text/html',
      );
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    }
  }
  async function nativeExport() {
    if (!flushInputs()) return;
    if (active && sharedSession) {
      try {
        await sharedSession.flush();
      } catch (error) {
        setError(String(error));
        return;
      }
      if (sharedSession.pendingCount) {
        setError('変更の確認が完了してから書き出してください。');
        return;
      }
      const confirmedRecord: StoredArtifact = {
        ...active,
        draft: { ...active.draft, content: sharedSession.confirmed.content },
        annotations: threadsToAnnotations(
          active.id,
          sharedSession.confirmed.content,
          sharedSession.confirmed.threads,
        ),
      };
      downloadText(
        `${active.name}.artifact.json`,
        serializeArtifact(confirmedRecord),
        'application/json',
      );
      return;
    }
    if (active) {
      const current = recordsRef.current.find((record) => record.id === active.id)!;
      try {
        const captured = await captureArtifactReferences(current.draft.content, references);
        assertReferenceCaptureCurrent(current.id, current.draft.content);
        const exported = { ...current, draft: { ...current.draft, content: captured } };
        assertCadNativeFits(exported, 'export');
        assertBimNativeFits(exported, 'export');
        downloadText(
          `${current.name}.artifact.json`,
          serializeArtifact(portableBimRecord(portableCadRecord(exported))),
          'application/json',
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  function requestProposal() {
    if (!active) return;
    try {
      if (!active.draft.baseVersionId)
        throw new Error('Save a version before requesting an external proposal');
      const liveRevision = sessions.current.get(active.id)!.revision;
      const value = mockProposal(
        {
          artifact: { artifactId: active.id, versionId: active.draft.baseVersionId },
          liveRevision,
          selection,
          operation: 'external-demo',
          input: null,
        },
        active.draft.content,
      );
      const review = reviewProposedCommands(
        {
          content: active.draft.content,
          base: {
            artifactId: active.id,
            versionId: active.draft.baseVersionId,
            revision: liveRevision,
          },
        },
        value,
        proposalAdapter(active.draft.content),
      );
      setProposal({ value, base: canonicalJson(active.draft.content), review });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function applyProposal() {
    if (!proposal || !active || readOnly) return;
    if (
      proposal.base !== canonicalJson(active.draft.content) ||
      (proposal.value.baseLocalRevision &&
        !sameLocalRevision(
          proposal.value.baseLocalRevision,
          sessions.current.get(active.id)!.revision,
        ))
    ) {
      setError('The draft changed. Reject this stale proposal and request a new one.');
      return;
    }
    execute(
      transaction(proposal.value.summary, proposal.value.commands, {
        origin: 'proposal',
        transactionId: newId('transaction'),
        proposalId: proposal.value.id,
      }),
    );
    // Select what changed so the Surface highlights it.
    if (proposal.review.status === 'ready' && proposal.review.elementIds.length)
      select(proposal.review.elementIds);
    setProposal(null);
  }
  const content = sharedPreview?.preview.after ?? active?.draft.content;
  const exportContent = sharedSession?.confirmed.content ?? content;
  // Storage/connection status changes do not change the native content. Keep
  // validation and the heavy surfaces tied to their actual content/permission inputs.
  const rendered = useMemo(() => checkedContent(content, active?.kind), [content, active?.kind]);
  const nativeReuseSupported =
    !rendered.animation && !(rendered.slide && hasSlideAnimations(rendered.slide));
  const animationHistoryPending =
    active?.kind === 'animation' && !!(inputStatus.dirty || inputStatus.composing);
  const exported = useMemo(
    () => (exportContent === content ? rendered : checkedContent(exportContent, active?.kind)),
    [exportContent, content, rendered, active?.kind],
  );
  const currentActions = useRef({ execute, select });
  useLayoutEffect(() => {
    currentActions.current = { execute, select };
  });
  const surfaceExecute = useMemo(
    () =>
      <T extends Content>(cmd: EditorCommand<T>) =>
        currentActions.current.execute(cmd),
    [],
  );
  const surfaceSelect = useMemo(
    () => (ids: string | string[], region?: Region, pageId?: string) =>
      currentActions.current.select(ids, region, pageId),
    [],
  );
  const whiteboardLayout = useMemo(() => ({ viewKey: `whiteboard:${active?.id}` }), [active?.id]);
  const previewBlocked = !!sharedPreview;
  const exportGuard = useMemo(
    () =>
      sharedSession
        ? () => {
            if (sharedSession.pendingCount || sharedSession.rejected.length || previewBlocked)
              throw new Error(
                'Confirm or resolve pending edits before exporting this view. Export JSON uses confirmed content; a checkpoint retains pending input.',
              );
          }
        : undefined,
    [sharedSession, previewBlocked],
  );
  const presenceKey = JSON.stringify(
    sharedSession?.presences.flatMap((p) =>
      p.anchor && !p.anchor.orphan && 'elementId' in p.anchor
        ? [{ elementId: p.anchor.elementId, name: p.name, clientId: p.clientId }]
        : [],
    ) ?? [],
  );
  const canvasPresences = useMemo(
    () => JSON.parse(presenceKey) as { elementId: string; name: string; clientId: string }[],
    [presenceKey],
  );
  const canvasText = useMemo(
    () => (sharedSession ? (id: string) => sharedSession.text(id) : undefined),
    [sharedSession],
  );
  const animationCatalog = useMemo(
    () =>
      active?.kind === 'animation'
        ? savedAnimationCatalog([...referenceSavedRecords.current.values()])
        : { sources: [], unavailable: [] },
    [active?.kind, animationCatalogEpoch],
  );
  const historyControls = {
    undoDisabled:
      (!session?.canUndo && !inputStatus.canUndo) || readOnly || animationHistoryPending,
    redoDisabled:
      (!session?.canRedo && !inputStatus.canRedo) || readOnly || animationHistoryPending,
    undo: () => history('undo'),
    redo: () => history('redo'),
  };
  const menuActions: Record<ArtifactMenuAction, () => void> = {
    'style-library': () => setStyleLibraryOpen(true),
    'save-reusable': () => startAuthoring(true),
    'reusable-library': () => setReusableOpen('library'),
    'reusable-inspect': () => setReusableOpen('inspect'),
    'reuse-batch': () => setReuseBatchOpen(true),
    'save-view-settings': () => startAuthoring(true),
    'view-settings-library': () => setReusableOpen('library'),
    'fragment-template': () => setTemplateKind('fragment'),
    structure: () => setStructureOpen(true),
    preset: () => setTemplateKind('preset'),
    'save-template': () => startAuthoring(false),
  };
  const menuAction = (action: ArtifactMenuAction) => menuActions[action]();
  const privateVideo: PrivateVideoLaunchers = {
    openEditor: (id, m2) => void openPrivateEditor(id, m2),
    entries: privateEntries,
    m2Entries: privateM2Entries,
    showEditor: !shared && !!onOpenPrivateEditor,
    showM2: !shared && !!onOpenPrivateM2,
  };
  const surfaceHost: SurfaceHost | undefined = active && {
    active,
    records,
    recordsRef,
    savedRecords: referenceSavedRecords,
    sessions,
    session,
    sharedSession,
    shared: !!shared,
    sharedPreview,
    inputs,
    readOnly,
    busy,
    selection,
    revealAddress,
    references,
    loadErrors,
    animationCatalog,
    dataViews,
    templateViewSettings,
    visibleReviewSource,
    referenceNavigation,
    whiteboardLayout,
    canvasText,
    exportGuard,
    previewBlocked,
    execute: surfaceExecute,
    select: surfaceSelect,
    selectNow: select,
    persist,
    activate,
    flushInputs,
    history,
    saveVersion,
    addComment,
    dataViewChanged,
    editPrivateSettings,
    setRevealAddress,
    setError,
    setStatus,
  };
  const dialogHost: DialogHost = {
    active,
    records,
    recordsRef,
    sessions,
    sharedSession,
    shared: !!shared,
    readOnly,
    nativeReuseSupported,
    selection,
    dataViews,
    dataViewsRef,
    templateViewSettings,
    officeCreationAllowed,
    exportGuard,
    readCanonicalRecord,
    flushInputs,
    persist,
    activate,
    select,
    setRevealAddress,
    setStatus,
    emitAnnotation: (annotation) => editorEvents.emit('annotation', annotation),
    savePrivateSettings,
    editPrivateSettings,
    reuseBatchBasis,
    applyReuseBatch,
  };
  const openDialogs: OpenDialogs = {
    csvExport: csvExportOpen,
    officeImport: officeImportOpen,
    templateKind,
    structure: structureOpen,
    authoring,
    styleLibrary: styleLibraryOpen,
    reuseBatch: reuseBatchOpen,
    reusable: reusableOpen,
    reusableAnnotation,
  };
  const dialogClosers: Record<keyof OpenDialogs, () => void> = {
    csvExport: () => setCsvExportOpen(false),
    officeImport: () => setOfficeImportOpen(false),
    templateKind: () => setTemplateKind(undefined),
    structure: () => setStructureOpen(false),
    authoring: () => setAuthoring(undefined),
    styleLibrary: () => setStyleLibraryOpen(false),
    reuseBatch: () => setReuseBatchOpen(false),
    reusable: () => setReusableOpen(undefined),
    reusableAnnotation: () => setReusableAnnotation(undefined),
  };
  const closeDialog = (dialog: keyof OpenDialogs) => dialogClosers[dialog]();
  const threadContext = active && {
    active,
    sharedSession,
    persist,
    emitAnnotation: (annotation: Annotation) => editorEvents.emit('annotation', annotation),
    setError,
  };
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorHistoryContext.Provider
        value={{ undo: () => history('undo'), redo: () => history('redo') }}
      >
        <OfficeExportHost
          guard={() => {
            flushSync(() => inputs.flush());
            exportGuard?.();
          }}
          capture={() => {
            if (!active) throw Error('Open an artifact before exporting');
            const current = readCanonicalRecord(active.id);
            return sharedSession
              ? {
                  content: current.draft.content,
                  basis: {
                    kind: 'confirmed',
                    artifactId: sharedSession.confirmed.artifactId,
                    revision: sharedSession.confirmed.revision,
                  },
                  name: current.name,
                }
              : {
                  content: nativeContent(current.draft.content),
                  basis: { kind: 'local-draft', artifactId: active.id },
                  name: current.name,
                };
          }}
        >
          <CanvasPresenceContext.Provider value={canvasPresences}>
            <CanvasTextContext.Provider value={canvasText}>
              <div
                className="app"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setNavOpen(false);
                    setProposal(null);
                    setContextMenu(false);
                  }
                }}
              >
                <header className="app-header">
                  <IconButton
                    icon={Library}
                    label="Toggle library"
                    aria-expanded={navOpen}
                    onClick={() => setNavOpen(!navOpen)}
                  />
                  {referenceReturn.current && referenceReturn.current.artifactId !== activeId && (
                    <button type="button" onClick={returnFromReference}>
                      埋め込み先に戻る
                    </button>
                  )}
                  {active ? (
                    <input
                      className="artifact-title"
                      aria-label="Artifact name"
                      value={active.name}
                      readOnly={readOnly || !!shared}
                      onChange={(e) => persist({ ...active, name: e.target.value })}
                    />
                  ) : (
                    <strong>Editor Platform</strong>
                  )}
                  <span role="status" className="save-status">
                    {sharedSession?.status ?? status}
                    {!!(inputStatus.dirty || inputStatus.composing) && ' · 未確定の入力があります'}
                    {sharedSession && sharedSession.presences.length > 0 && (
                      <span aria-label="Other editors">
                        {' '}
                        · {sharedSession.presences.map((p) => p.name).join(', ')}
                      </span>
                    )}
                  </span>
                  {active && (
                    <>
                      <HistoryButtons
                        history={historyControls}
                        busy={busy}
                        readOnly={readOnly}
                        onSave={() => setSaveOpen(true)}
                      />
                      <ViewTabs
                        view={view}
                        versionCount={active.versions.length}
                        onSelect={(tab) => {
                          changeView(tab);
                          if (tab !== 'Editor') setInspector(false);
                          setBeforeId('');
                          setAfterId('');
                        }}
                      />
                      <ExportMenu
                        documentText={!!exported.document}
                        csv={!!exported.data}
                        onJson={nativeExport}
                        onDocumentText={(format) => void documentTextExport(format)}
                        onCsv={() => {
                          if (flushInputs()) setCsvExportOpen(true);
                        }}
                        onDownloadFile={
                          exported.file ? () => downloadFile(exported.file!) : undefined
                        }
                      />
                      <MoreActionsMenu
                        active={active}
                        history={historyControls}
                        readOnly={readOnly}
                        nativeReuseSupported={nativeReuseSupported}
                        shared={shared}
                        inspector={inspector}
                        selection={selection}
                        toolbar={extensions.toolbar}
                        externalProposal={
                          !shared && proposalSupported(content) ? requestProposal : undefined
                        }
                        flushInputs={flushInputs}
                        onAction={menuAction}
                        onStartShared={
                          onStartShared
                            ? () => {
                                if (!flushInputs()) return;
                                const current = recordsRef.current.find(
                                  (record) => record.id === active.id,
                                );
                                if (current)
                                  void onStartShared(current).catch((e) =>
                                    setError(e instanceof Error ? e.message : String(e)),
                                  );
                              }
                            : undefined
                        }
                        onToggleInspector={() => setInspector(!inspector)}
                        onReadOnlyChange={(checked) => {
                          // Switching to read-only replaces text inputs: commit or keep them first.
                          if (
                            (active.kind === 'animation' || active.kind === 'schedule') &&
                            !flushInputs()
                          )
                            return;
                          setReadOnly(checked);
                        }}
                        setPreview={setSharedPreview}
                        setError={setError}
                      />
                    </>
                  )}
                </header>
                <ArtifactDialogs host={dialogHost} open={openDialogs} onClose={closeDialog} />
                {saveOpen && (
                  <SaveVersionDialog
                    shared={!!shared}
                    busy={busy}
                    reason={reason}
                    onReasonChange={setReason}
                    onSave={() => void saveVersion()}
                    onClose={() => setSaveOpen(false)}
                  />
                )}
                {navOpen && (
                  <button
                    className="library-backdrop"
                    aria-label="Close library"
                    onClick={() => setNavOpen(false)}
                  />
                )}
                <LibraryPanel
                  open={navOpen}
                  records={records}
                  activeId={activeId}
                  activeKind={active?.kind}
                  kind={kind}
                  loaded={loaded}
                  busy={busy}
                  shared={!!shared}
                  readOnly={readOnly}
                  nativeReuseSupported={nativeReuseSupported}
                  privateVideo={privateVideo}
                  onClose={() => setNavOpen(false)}
                  onKindChange={setKind}
                  graphTemplate={graphTemplate}
                  onGraphTemplateChange={setGraphTemplate}
                  onCreate={create}
                  onCreateFromTemplate={() => setTemplateKind('whole')}
                  onOpenReusableLibrary={() => setReusableOpen('library')}
                  onOfficeImport={() => setOfficeImportOpen(true)}
                  onActivate={activate}
                  onImportFiles={(files) => void importFiles(files)}
                />
                <main className="workspace">
                  <LoadErrorBanners records={records} loadErrors={loadErrors} />
                  {(error || sharedSession?.error) && (
                    <ErrorBanner
                      message={error || sharedSession?.error || ''}
                      canRetrySave={failedWrites.current.size > 0}
                      onRetrySave={() => {
                        for (const id of failedWrites.current) {
                          const record = recordsRef.current.find((r) => r.id === id);
                          if (record) persist(record);
                        }
                      }}
                      onDismiss={() => setError('')}
                    />
                  )}
                  {!active ? (
                    <WelcomePanel
                      loaded={loaded}
                      busy={busy}
                      privateVideo={privateVideo}
                      onFindTemplates={() => setTemplateKind('whole')}
                      onCreate={create}
                    />
                  ) : (
                    <>
                      <div className={`editing-area ${inspector ? 'with-inspector' : ''}`}>
                        <div
                          className={`surface-container ${readOnly ? 'read-only' : ''}`}
                          onContextMenu={(e) => {
                            if (extensions.contextMenu?.length) {
                              e.preventDefault();
                              setContextMenu(true);
                            }
                          }}
                        >
                          {contextMenu && (
                            <div role="menu" className="context-menu">
                              {extensions.contextMenu?.map((action) => (
                                <button
                                  role="menuitem"
                                  key={action.id}
                                  onClick={() => {
                                    action.run(selection);
                                    setContextMenu(false);
                                  }}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          )}
                          {view === 'Editor' && content && (
                            <EditorSurfaces
                              key={active.id}
                              host={surfaceHost!}
                              rendered={rendered}
                            />
                          )}
                          {view === 'History' && (
                            <HistoryView
                              versions={active.versions}
                              onRestore={(v) => {
                                if (sharedSession) {
                                  void sharedSession
                                    .restore(v.versionId)
                                    .catch((e) => setError(String(e)));
                                  setView('Editor');
                                  return;
                                }
                                execute(
                                  command('artifact.restore', 'Restore version to draft', () => {
                                    if (active.kind === 'cad')
                                      assertCadContentFits(
                                        recordsRef.current.find((r) => r.id === active.id) ??
                                          active,
                                        v.content as unknown as CadDocument,
                                        'この版に戻す',
                                      );
                                    return clone(v.content);
                                  }),
                                );
                                setView('Editor');
                              }}
                            />
                          )}
                          {view === 'Compare' && (
                            <CompareView
                              versions={active.versions}
                              beforeId={beforeId}
                              afterId={afterId}
                              onBeforeChange={setBeforeId}
                              onAfterChange={setAfterId}
                              compare={() => compareVersions(active, beforeId, afterId)}
                            />
                          )}
                        </div>
                        {sharedPreview && shared && (
                          <SharedProposalInspector
                            shared={shared}
                            preview={sharedPreview}
                            request={sharedProposalRequest}
                            setPreview={setSharedPreview}
                            setError={setError}
                          />
                        )}
                        {inspector &&
                          active.kind !== 'animation' &&
                          active.kind !== 'structured-graph' &&
                          active.kind !== 'analysis' &&
                          active.kind !== 'estimate' &&
                          active.kind !== 'geo' &&
                          active.kind !== 'cad' &&
                          active.kind !== 'bim' && (
                            <CommentsInspector
                              active={active}
                              content={content}
                              selection={selection}
                              comment={comment}
                              readOnly={readOnly}
                              showResolved={showResolved}
                              canAnnotateFromSettings={
                                ['review', 'file'].includes(active.kind) &&
                                !!templateViewSettings[active.id]?.$annotation
                              }
                              onCommentChange={setComment}
                              onShowResolvedChange={setShowResolved}
                              onAddComment={() => addComment()}
                              onAnnotateFromSettings={() =>
                                setReusableAnnotation(clone(selection.addresses[0]))
                              }
                              onClose={() => setInspector(false)}
                              onJump={(a) => {
                                setRevealAddress({ ...a.anchor.addresses[0] });
                                setSelection(a.anchor);
                                setView('Editor');
                              }}
                              onToggleResolved={(a) => toggleThreadResolved(threadContext!, a)}
                              onReply={(a, body) => replyToThread(threadContext!, a, body)}
                            >
                              {inspectorSlot}
                            </CommentsInspector>
                          )}
                      </div>
                    </>
                  )}
                </main>
                {ifcLoss && (
                  <Suspense fallback={null}>
                    <BimIfcLossDialog
                      fileName={ifcLoss.file.name}
                      report={ifcLoss.report}
                      onImport={() => void importIfc([ifcLoss.file], true)}
                      onCancel={() => setIfcLoss(undefined)}
                    />
                  </Suspense>
                )}
                {proposal && (
                  <ProposalDialog
                    proposal={proposal}
                    content={content}
                    onReject={() => setProposal(null)}
                    onApply={applyProposal}
                  />
                )}
              </div>
            </CanvasTextContext.Provider>
          </CanvasPresenceContext.Provider>
        </OfficeExportHost>
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
