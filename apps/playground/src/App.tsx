import {
  ReferenceResolver,
  ReferenceError,
  type ReferenceOption,
} from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { captureArtifactReferences, validateArtifactReferenceHistory } from './artifact-references';
import type { PrivateVideoEntry } from './private-video/catalog';
import {
  NativeGraphSurface,
  relationProfile,
  isGraphDocument,
  validateGraph,
  type GraphDocument,
} from '@editor-platform/structured-graph';
import { DataGraphSurface } from '@editor-platform/structured-data-graph';
import {
  registerReferenceNative,
  referenceRegisteredRuntimeAdapter,
} from '../../react-ui-reference/src/generated-registry';
import { DesignReactSurface } from '@editor-platform/design-react';
import {
  referenceDesignRuntime,
  referenceDesignRegistrations,
  referenceDesignSettings,
} from '../../react-ui-reference/src/design-catalog';
import { lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { localImportCreationAdapter } from '@editor-platform/office-import-core/lifecycle';
import type { ImportContent } from '@editor-platform/office-import-ui';
import type { Artifact } from '@editor-platform/artifact-core';
import {
  TemplateGallery,
  TemplateStructurePanel,
  SaveTemplateDialog,
  ReusableLibrary,
  ReusableAnnotationDialog,
  TokenStyleLibrary,
  ReusableBatchDialog,
} from '@editor-platform/template-ui';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import {
  TemplateCatalog,
  builtinCatalog,
  LocalCatalog,
  applyInstantiation,
  applyLocalTemplate,
  validateNativeReusableDefinitions,
  localTemplateSnapshot,
  isStructureInstance,
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
  editorAnchor,
  threadsToAnnotations,
  type SharedEditorSession,
} from '@editor-platform/collaboration-adapters';
import type { Preview } from '@editor-platform/collaboration-core';
import {
  IconButton,
  Menu,
  Dialog,
  isTextInput,
  EditorInputsContext,
  EditorHistoryContext,
} from '@editor-platform/editor-ui';
import {
  Library,
  Save,
  History,
  Download,
  MoreHorizontal,
  MessageSquare,
  Undo2,
  Redo2,
  X,
} from 'lucide-react';
import {
  memo,
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
  contentHash,
  deepFreeze,
  deserializeArtifact,
  IndexedDBStorage,
  newId,
  serializeArtifact,
  type CompareResult,
} from '@editor-platform/artifact-core';
import {
  addAnnotation,
  command,
  isAnnotation,
  previewProposedCommands,
  EditorEventBus,
  EditorSession,
  EditorInputs,
  transaction,
  sameLocalRevision,
  type EditorCommand,
  type EditorExtensions,
  type ProposedCommands,
  type Region,
  type Selection,
  type ElementAddress,
} from '@editor-platform/editor-core';
import {
  DocumentSurface,
  captureDocumentReferences,
  documentDiff,
  exportHtml,
  exportMarkdown,
  importMarkdown,
  isDocument,
  anchorDocumentSelection,
} from '@editor-platform/document';
import {
  DataSurface,
  dataDiff,
  displayCell,
  importCsv,
  isStructuredData,
  validateData,
  type StructuredData,
  type DataView,
  defaultView,
  CsvExportDialog,
} from '@editor-platform/structured-data';
import {
  FileSurface,
  ReviewSurface,
  isFile,
  isReview,
  reviewDiff,
  reviewRevision,
  reviewAddressRevision,
  assertReviewSelection,
  remapReviewAnnotation,
  remapFileAnnotation,
  type ReviewVisibleSource,
} from '@editor-platform/review-surfaces';
import {
  downloadFile,
  anchorState,
  downloadText,
  kinds,
  makeArtifact,
  createLocalSession,
  mockExternalRuntime,
  validContent,
  type Content,
  type Kind,
  type StoredArtifact,
} from './model';
import { WhiteboardSurface, isWhiteboard, whiteboardDiff } from '@editor-platform/whiteboard';
import { isDesign, designDiff } from '@editor-platform/design';
import { SlideSurface, isDeck, slideDiff } from '@editor-platform/slide';
import { ReactUiSurface } from '@editor-platform/react-ui';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  convertDesignToReact,
  designReactSourceHash,
  applyDesignReactDocumentRegeneration,
  retainDesignPublications,
} from '@editor-platform/design-react-core';
import {
  createReferenceDocument,
  referenceRuntimeAdapter,
  referenceTextRevision,
  referenceEnvironmentRevision,
} from '../../react-ui-reference/src/catalog';
type NativeContent = Exclude<Content, ReactUiDocument | GraphDocument>;
function nativeContent(content: Content): NativeContent {
  if (isGraphDocument(content)) throw new Error('Graph has no template/reuse adapter');
  if (validContent('react-ui', content))
    throw new Error('React UI uses its Host registrations, not native reusable definitions');
  return content as NativeContent;
}
function nativeShared(
  session: SharedEditorSession<Content> | undefined,
): SharedEditorSession<NativeContent> | undefined {
  if (session && String(session.codec.domain) === 'react-ui')
    throw new Error('React UI uses its own domain operations');
  return session as SharedEditorSession<NativeContent> | undefined;
}
function nativeRecord(record: StoredArtifact): Artifact<NativeContent> {
  nativeContent(record.draft.content);
  return record as Artifact<NativeContent>;
}
const OfficeImportDialog = lazy(() =>
  import('@editor-platform/office-import-ui').then((m) => ({ default: m.OfficeImportDialog })),
);
const storage = new IndexedDBStorage<StoredArtifact>();
const personalTemplates = new LocalCatalog();
const templateCatalog = new TemplateCatalog([builtinCatalog(), personalTemplates]);
export const editorEvents = new EditorEventBus();
const referenceReactExamples = [
  { name: 'Product page', document: createReferenceDocument('product') },
  { name: 'Contact form', document: createReferenceDocument('form') },
  { name: 'Host tokens', document: createReferenceDocument('tokens') },
];
const MemoDataSurface = memo(DataSurface);
const MemoDesignSurface = memo(function ReferenceDesignSurface(
  props: import('react').ComponentProps<typeof DesignReactSurface>,
) {
  const runtime = useMemo(() => referenceDesignRuntime(props.content), [props.content]);
  const registrations = useMemo(() => referenceDesignRegistrations(props.content), [props.content]);
  return <DesignReactSurface {...props} runtime={runtime} registrations={registrations} />;
});
const MemoWhiteboardSurface = memo(WhiteboardSurface);
function checkedContent(content: unknown) {
  return {
    graph: isGraphDocument(content) ? content : undefined,
    reactUi: validContent('react-ui', content) ? (content as ReactUiDocument) : undefined,
    document: isDocument(content) ? content : undefined,
    data: isStructuredData(content) ? content : undefined,
    review: isReview(content) ? content : undefined,
    file: isFile(content) ? content : undefined,
    whiteboard: isWhiteboard(content) ? content : undefined,
    design: isDesign(content) ? content : undefined,
    slide: isDeck(content) ? content : undefined,
  };
}
export interface SharedPlaygroundConnection {
  session: SharedEditorSession<Content>;
  record: StoredArtifact;
  peerUrl: string;
  requestProposal(): Promise<string>;
  leave(): void;
  hostActions?: { label: string; run(): void | Promise<void> }[];
}
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
  const [authoring, setAuthoring] = useState<{
    artifactId: string;
    domain: Domain;
    content: NativeContent;
    ids: string[];
    slideSelection?: { pageId: string; elementId: string }[];
    reuse: boolean;
    privateSettings?: PrivateViewSettings;
    session?: SharedEditorSession<Content>;
  }>();
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
  const referenceNotifications = useRef(new Set<(id: string) => void>());
  const referenceReturn = useRef<ElementAddress | undefined>(undefined);
  const referenceNavigation = useRef<
    (sourceId: string, elementId: string, pageId?: string) => void
  >(() => {});
  const references = useMemo(
    () =>
      new ReferenceResolver(
        {
          async list() {
            const options: ReferenceOption[] = [];
            for (const a of referenceSavedRecords.current.values()) {
              const content = a.versions.at(-1)?.content;
              if (isStructuredData(content)) {
                const views = [{ id: 'default', name: 'Default view' }, ...(content.views ?? [])];
                for (const view of views)
                  for (const kind of ['table', 'chart'])
                    options.push({
                      label: `${a.name} · ${view.name} · ${kind}`,
                      source: {
                        artifactId: a.id,
                        domain: 'data',
                        target: { kind, viewId: view.id },
                      },
                    });
              } else if (isGraphDocument(content))
                options.push({
                  label: `${a.name} · Graph`,
                  source: {
                    artifactId: a.id,
                    domain: 'structured-graph',
                    target: { kind: 'graph', viewId: content.id },
                  },
                });
            }
            return options;
          },
          async read(source) {
            const a = referenceSavedRecords.current.get(source.artifactId);
            if (!a || a.kind !== source.domain)
              throw new ReferenceError('missing-source', '保存済みの参照元が見つかりません。');
            const version = a.versions.at(-1);
            if (!version)
              throw new ReferenceError('missing-source', '参照元をversionとして保存してください。');
            return {
              artifactId: a.id,
              domain: a.kind,
              versionId: version.versionId,
              revision: a.versions.length,
              contentHash: version.contentHash,
              content: version.content,
              dependencies: isGraphDocument(version.content)
                ? [
                    {
                      id: `profile:${relationProfile.id}:${relationProfile.version}`,
                      content: relationProfile,
                      contentHash: await contentHash(relationProfile),
                    },
                  ]
                : [],
            };
          },
          subscribe(listener) {
            referenceNotifications.current.add(listener);
            return () => {
              referenceNotifications.current.delete(listener);
            };
          },
          open(source, elementId, pageId) {
            referenceNavigation.current(source.artifactId, elementId, pageId);
          },
        },
        nativeReferenceAdapters,
        activeId,
      ),
    [activeId],
  );

  const inputs = useMemo(() => new EditorInputs(), [activeId]);
  const inputStatus = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<Kind>('document');
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
  const [proposal, setProposal] = useState<{
    value: ProposedCommands<Content>;
    base: string;
    preview: Content;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState(false);
  const proposalDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (proposal && proposalDialog.current && !proposalDialog.current.open)
      proposalDialog.current.showModal();
  }, [proposal]);
  const sessions = useRef(new Map<string, EditorSession<Content>>());
  const writeQueue = useRef(Promise.resolve());
  const privateTransition = useRef(false);
  const failedWrites = useRef(new Set<string>());
  const submittingComments = useRef(new Set<string>());
  // Retain identities across uncertain/failed delivery; retry must not duplicate a thread.
  const commentAttempts = useRef(
    new Map<
      string,
      {
        key: string;
        annotation?: ReturnType<typeof addAnnotation>;
        session?: SharedEditorSession<Content>;
        operationId?: string;
        threadIds?: string[];
        retryProposal?: { id: string; token: string };
      }
    >(),
  );
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
            if (!validContent(a.kind, a.draft.content)) throw new Error('Invalid stored content');
            if (a.versions.some((v) => !validContent(a.kind, v.content)))
              throw new Error('Invalid stored version');
            if (a.kind === 'structured-graph') {
              for (const v of a.versions)
                if ((await contentHash(v.content)) !== v.contentHash)
                  throw new Error('Stored Graph version hash mismatch');
            }
            a.versions.forEach(deepFreeze);
            await validateArtifactReferenceHistory(a, references);
            opened.set(a.id, createLocalSession(a.draft.content));
            referenceSavedRecords.current.set(a.id, a);
          } catch (e) {
            failures[a.id] = String(e);
          }
        }
        if (!mounted) return;
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
  // Session results are caller-owned snapshots. The Host adopts this result rather
  // than defensively cloning the entire draft a second time before IndexedDB clones it.
  function editedDraft(record: StoredArtifact, content: Content): StoredArtifact {
    return { ...record, draft: { ...record.draft, content, updatedAt: new Date().toISOString() } };
  }
  function persist(record: StoredArtifact) {
    const next = recordsRef.current.some((a) => a.id === record.id)
      ? recordsRef.current.map((a) => (a.id === record.id ? record : a))
      : [...recordsRef.current, record];
    recordsRef.current = next;
    setRecords(next);
    setStatus('Saving locally…');
    const generation = ++saveGeneration.current;
    const completion = writeQueue.current
      .then(() => storage.put(record))
      .then(() => {
        const priorSource = referenceSavedRecords.current.get(record.id);
        referenceSavedRecords.current.set(record.id, record);
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
    if (!flushInputs()) return;
    if (shared) throw new Error('参照元へ移動する前に共有接続を終了してください。');
    if (!recordsRef.current.some((a) => a.id === sourceId))
      throw new Error('参照元が見つかりません。');
    referenceReturn.current = { artifactId: activeId, elementId, pageId };
    activate(sourceId);
  };
  function returnFromReference() {
    if (!flushInputs() || !referenceReturn.current) return;
    const target = referenceReturn.current;
    activate(target.artifactId);
    setRevealAddress(target);
    referenceReturn.current = undefined;
  }
  function assertReferenceCaptureCurrent(id: string, content: Content, writing = false) {
    if (
      (writing && currentTarget.current.readOnly) ||
      currentTarget.current.activeId !== id ||
      recordsRef.current.find((a) => a.id === id)?.draft.content !== content ||
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
    const a = makeArtifact(nextKind, records.filter((r) => r.kind === nextKind).length + 1);
    sessions.current.set(a.id, createLocalSession(a.draft.content));
    persist(a);
    activate(a.id);
  }
  function execute<T extends Content>(cmd: EditorCommand<T>) {
    if (!active || readOnly) return false;
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
    if (!active || !session || readOnly) return;
    let privateHistory = false;
    flushSync(() => {
      privateHistory = inputs.history(direction);
    });
    if (privateHistory) return;
    if (sharedSession) {
      void sharedSession.history(direction).catch((e) => setError(String(e)));
      return;
    }
    persist({
      ...editedDraft(active, (session as EditorSession<Content>)[direction]()),
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
    if (!flushInputs()) return;
    const saved = sharedSession
      ? active
      : recordsRef.current.find((record) => record.id === active.id)!;
    if (sharedSession) {
      setBusy(true);
      try {
        await sharedSession.save(reason || 'Manual save');
        setReason('');
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (
      isGraphDocument(saved.draft.content) &&
      validateGraph(saved.draft.content, relationProfile).length
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
      const captured = await captureArtifactReferences(saved.draft.content, references);
      assertReferenceCaptureCurrent(saved.id, saved.draft.content, true);
      const committed = await commitVersion(
        { ...saved, draft: { ...saved.draft, content: captured } },
        'local-user',
        reason || 'Manual save',
      );
      assertReferenceCaptureCurrent(saved.id, saved.draft.content, true);
      const latest = recordsRef.current.find((a) => a.id === active.id)!;
      const result = {
        ...committed,
        name: latest.name,
        annotations: latest.annotations,
        draft: { ...latest.draft, baseVersionId: committed.draft.baseVersionId },
      };
      if (!(await persist(result)))
        throw new Error('Versionを保存できませんでした。参照更新は通知されていません。');
      setReason('');
      editorEvents.emit('version', {
        artifactId: result.id,
        versionId: result.versions.at(-1)!.versionId,
      });
    } catch (e) {
      setError((e as Error).message);
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
    if (!active || readOnly) return false;
    if (isReview(active.draft.content)) {
      try {
        assertReviewSelection(
          active.draft.content,
          targetSelection.addresses,
          visibleReviewSource.current?.artifactId === active.id
            ? visibleReviewSource.current.source
            : undefined,
          active.id,
        );
      } catch (error) {
        setError(String(error instanceof Error ? error.message : error));
        return false;
      }
    }
    const key = JSON.stringify([targetSelection, body.trim()]);
    const previous = commentAttempts.current.get(active.id);
    if (sharedSession) {
      return sharedSession
        .flush()
        .then(async () => {
          const acknowledge = async (operationId: string) => {
            await sharedSession.flush();
            const receipt = sharedSession.client.receipts.get(operationId);
            if (!receipt)
              throw new Error(
                'Comment delivery is unconfirmed. Retry to reconcile the same operation.',
              );
            if (receipt.status !== 'accepted') throw new Error(receipt.message);
            commentAttempts.current.delete(active.id);
          };
          if (previous?.operationId) {
            if (previous.session !== sharedSession)
              throw new Error('Reconcile the previous comment in its original shared session.');
            const receipt = sharedSession.client.receipts.get(previous.operationId);
            if (receipt?.status === 'rejected') {
              // Retry the retained operation, not newly generated thread IDs. The
              // session's proposal path owns authority checks, history and removal
              // of this one retained entry only after accepted synchronization.
              const index = sharedSession.rejected.findIndex(
                (edit) => edit.operation.operationId === previous.operationId,
              );
              if (index >= 0) {
                if (!previous.retryProposal) {
                  const { id, preview } = await sharedSession.previewRetained(index);
                  previous.retryProposal = { id, token: preview.token };
                }
                const retry = previous.retryProposal;
                try {
                  await sharedSession.applyProposal(retry.id, retry.token);
                } catch (error) {
                  // An explicit rejection permits a fresh preview next time.
                  // An uncertain outcome must replay the same idempotent proposal.
                  const result = sharedSession.lastReceipt;
                  if (
                    result?.operationId === `proposal:${retry.id}` &&
                    result.status === 'rejected'
                  )
                    previous.retryProposal = undefined;
                  throw error;
                }
              } else if (
                !previous.threadIds?.length ||
                !previous.threadIds.every((id) =>
                  sharedSession.confirmed.threads.some((t) => t.id === id),
                )
              ) {
                // Explicit discard is different from successful retained replay.
                commentAttempts.current.delete(active.id);
                throw new Error(
                  'Previous retained comment was discarded. Your draft is retained; submit it separately.',
                );
              }
              commentAttempts.current.delete(active.id);
            } else {
              await acknowledge(previous.operationId);
            }
            if (previous.key !== key)
              throw new Error(
                'Previous comment confirmed. Your changed draft is retained; submit it separately.',
              );
            setComment((current) => (current === body ? '' : current));
            return true;
          }
          if (sharedSession.pendingCount)
            throw new Error('Confirm pending text before anchoring a comment');
          const actions = targetSelection.addresses.flatMap((address) => {
            const id = newId('thread'),
              createdAt = new Date().toISOString();
            const anchor =
              sharedSession.codec.domain === 'document'
                ? {
                    type: 'text' as const,
                    from: sharedSession.text('text').state.selection.from,
                    to: sharedSession.text('text').state.selection.to,
                  }
                : editorAnchor(sharedSession.codec.domain, sharedSession.content, address);
            return [
              { type: 'thread.create', target: id, payload: { anchor, createdAt } },
              {
                type: 'thread.reply',
                target: id,
                payload: { id: newId('comment'), text: body.trim(), createdAt },
              },
            ];
          });
          const operation = sharedSession.actions(actions);
          commentAttempts.current.set(active.id, {
            key,
            session: sharedSession,
            operationId: operation.operationId,
            threadIds: actions
              .filter((action) => action.type === 'thread.create')
              .map((action) => action.target),
          });
          await acknowledge(operation.operationId);
          setComment((current) => (current === body ? '' : current));
          return true;
        })
        .catch((e) => {
          setError(String(e));
          return false;
        });
    }
    try {
      const annotation = previous?.annotation
        ? {
            ...previous.annotation,
            comments: previous.annotation.comments.map((item, index) =>
              index === 0 ? { ...item, body: body.trim() } : item,
            ),
          }
        : addAnnotation(
            isDocument(active.draft.content)
              ? anchorDocumentSelection(active.draft.content, targetSelection)
              : targetSelection,
            body,
            'local-user',
          );
      const latest = recordsRef.current.find((record) => record.id === active.id);
      if (!latest) throw new Error('Comment artifact is no longer available');
      if (
        previous?.annotation &&
        JSON.stringify(JSON.parse(previous.key)[0]) !== JSON.stringify(targetSelection)
      )
        throw new Error('Retry the unsaved comment at its original anchor.');
      commentAttempts.current.set(active.id, { key, annotation });
      const annotations = latest.annotations.some((item) => item.id === annotation.id)
        ? latest.annotations.map((item) => (item.id === annotation.id ? annotation : item))
        : [...latest.annotations, annotation];
      if (!(await persist({ ...latest, annotations }))) return false;
      commentAttempts.current.delete(active.id);
      editorEvents.emit('annotation', annotation);
      setComment((current) => (current === body ? '' : current));
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  async function importFile(file: File) {
    if (!flushInputs()) return;
    try {
      if (file.size > 16_000_000) throw new Error('Import files must be smaller than 16 MB');
      const text = await file.text();
      let record: StoredArtifact;
      let nativeName: string | undefined;
      let importedArtifactId: string | undefined;
      if (/\.md$/i.test(file.name)) {
        record = makeArtifact('document', 1);
        record.draft.content = importMarkdown(text);
      } else if (/\.csv$/i.test(file.name)) {
        record = makeArtifact('data', 1);
        record.draft.content = importCsv(text);
      } else {
        const value: unknown = JSON.parse(text);
        if (isStructuredData(value)) {
          record = makeArtifact('data', 1);
          record.draft.content = value;
        } else if (isDesign(value)) {
          // React bundles retain ordinary native Design content as native.json.
          record = makeArtifact('design', 1);
          record.draft.content = value;
        } else {
          const artifact = deserializeArtifact(text);
          nativeName = artifact.name;
          importedArtifactId = artifact.id;
          if (
            !validContent(artifact.kind, artifact.draft.content) ||
            artifact.versions.some((v) => !validContent(artifact.kind, v.content))
          )
            throw new Error('Invalid domain content');
          for (const version of artifact.versions)
            if ((await contentHash(version.content)) !== version.contentHash)
              throw new Error('Version content hash mismatch');
          const id = newId('artifact');
          record = {
            ...artifact,
            id,
            draft: { ...artifact.draft, content: artifact.draft.content as Content },
            versions: artifact.versions.map((v) => ({
              ...v,
              artifactId: id,
              content: v.content as Content,
            })),
            annotations: [],
          };
          const raw = value as { annotations?: unknown };
          if (raw.annotations !== undefined) {
            if (!Array.isArray(raw.annotations) || !raw.annotations.every(isAnnotation))
              throw new Error('Invalid annotations');
            record.annotations = raw.annotations.map((annotation) => ({
              ...annotation,
              anchor: {
                ...annotation.anchor,
                addresses: annotation.anchor.addresses.map((address) => ({
                  ...address,
                  artifactId: address.artifactId === artifact.id ? id : address.artifactId,
                })),
              },
            }));
          }
        }
      }
      if (record.kind !== 'react-ui' && record.kind !== 'structured-graph')
        await validateNativeReusableDefinitions(
          record.kind as Domain,
          nativeContent(record.draft.content),
        );
      for (const version of record.versions)
        if (record.kind !== 'react-ui' && record.kind !== 'structured-graph')
          await validateNativeReusableDefinitions(
            record.kind as Domain,
            nativeContent(version.content),
          );
      // Reference sources retain exported IDs; check self-addresses in that original scope.
      await validateArtifactReferenceHistory(
        { ...record, id: importedArtifactId ?? record.id },
        references,
      );
      record.name = nativeName ?? file.name.replace(/\.(md|csv|json)$/i, '');
      record.provenance = {
        source: 'imported',
        format: file.name.split('.').pop(),
        importedAt: new Date().toISOString(),
      };
      if (!flushInputs()) return;
      sessions.current.set(record.id, createLocalSession(record.draft.content));
      persist(record);
      activate(record.id);
      setError('');
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  }
  function flushInputs() {
    try {
      flushSync(() => inputs.flush());
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
        downloadText(
          `${current.name}.artifact.json`,
          serializeArtifact({ ...current, draft: { ...current.draft, content: captured } }),
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
      const value = mockExternalRuntime(
        {
          artifact: { artifactId: active.id, versionId: active.draft.baseVersionId },
          liveRevision: sessions.current.get(active.id)!.revision,
          selection,
          operation: 'uppercase',
          input: null,
        },
        active.draft.content,
      );
      const preview = previewProposedCommands(active.draft.content, value).content;
      setProposal({ value, base: canonicalJson(active.draft.content), preview });
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
    setProposal(null);
  }
  function compare(): CompareResult {
    if (!active) return { changes: [] };
    const a = active.versions.find((v) => v.versionId === beforeId) ?? active.versions.at(-2);
    const b = active.versions.find((v) => v.versionId === afterId) ?? active.versions.at(-1);
    if (!a || !b) return { changes: [] };
    if (isDocument(a.content) && isDocument(b.content)) return documentDiff(a.content, b.content);
    if (isStructuredData(a.content) && isStructuredData(b.content))
      return dataDiff(a.content, b.content);
    if (isReview(a.content) && isReview(b.content)) return reviewDiff(a.content, b.content);
    if (isWhiteboard(a.content) && isWhiteboard(b.content))
      return whiteboardDiff(a.content, b.content);
    if (isDesign(a.content) && isDesign(b.content)) return designDiff(a.content, b.content);
    if (isDeck(a.content) && isDeck(b.content)) return slideDiff(a.content, b.content);
    return {
      changes:
        canonicalJson(a.content) === canonicalJson(b.content)
          ? []
          : [
              {
                elementId: active.id,
                path: 'content',
                kind: 'changed',
                before: isFile(a.content)
                  ? `${a.content.name}: ${a.content.mime} (${a.content.size} bytes)`
                  : canonicalJson(a.content),
                after: isFile(b.content)
                  ? `${b.content.name}: ${b.content.mime} (${b.content.size} bytes)`
                  : canonicalJson(b.content),
              },
            ],
    };
  }
  const content = sharedPreview?.preview.after ?? active?.draft.content;
  const exportContent = sharedSession?.confirmed.content ?? content;
  // Storage/connection status changes do not change the native content. Keep
  // validation and the heavy surfaces tied to their actual content/permission inputs.
  const rendered = useMemo(() => checkedContent(content), [content]);
  const exported = useMemo(
    () => (exportContent === content ? rendered : checkedContent(exportContent)),
    [exportContent, content, rendered],
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
                      <IconButton
                        icon={Undo2}
                        label="Undo"
                        shortcut="Ctrl/⌘ Z"
                        disabled={(!session?.canUndo && !inputStatus.canUndo) || readOnly}
                        reason="No editable earlier state"
                        onClick={() => history('undo')}
                      />
                      <IconButton
                        icon={Redo2}
                        label="Redo"
                        shortcut="Ctrl/⌘ Shift Z"
                        disabled={(!session?.canRedo && !inputStatus.canRedo) || readOnly}
                        reason="No later state"
                        onClick={() => history('redo')}
                      />
                      <IconButton
                        icon={Save}
                        label="Save version"
                        shortcut="Ctrl/⌘ S"
                        disabled={busy || readOnly}
                        onClick={() => setSaveOpen(true)}
                      />
                      <Menu label="History and compare" icon={History} align="right">
                        <div role="tablist" aria-label="Artifact views">
                          {(['Editor', 'History', 'Compare'] as const).map((tab) => (
                            <button
                              role="tab"
                              key={tab}
                              aria-selected={view === tab}
                              onClick={() => {
                                changeView(tab);
                                if (tab !== 'Editor') setInspector(false);
                                setBeforeId('');
                                setAfterId('');
                              }}
                            >
                              {tab}
                              {tab === 'History' ? ` (${active.versions.length})` : ''}
                            </button>
                          ))}
                        </div>
                      </Menu>
                      <Menu label="Export artifact" icon={Download} align="right">
                        <button onClick={nativeExport}>Export JSON</button>
                        {exported.document && (
                          <>
                            <button onClick={() => void documentTextExport('markdown')}>
                              Export Markdown
                            </button>
                            <button onClick={() => void documentTextExport('html')}>
                              Export HTML
                            </button>
                          </>
                        )}
                        {exported.data && (
                          <button
                            onClick={() => {
                              if (flushInputs()) setCsvExportOpen(true);
                            }}
                          >
                            Export CSV
                          </button>
                        )}
                        {exported.file && (
                          <button onClick={() => downloadFile(exported.file!)}>
                            Download file
                          </button>
                        )}
                      </Menu>
                      <Menu label="More artifact actions" icon={MoreHorizontal} align="right">
                        <div className="mobile-history-actions">
                          <button
                            aria-label="Undo"
                            disabled={(!session?.canUndo && !inputStatus.canUndo) || readOnly}
                            onClick={() => history('undo')}
                          >
                            Undo
                          </button>
                          <button
                            aria-label="Redo"
                            disabled={(!session?.canRedo && !inputStatus.canRedo) || readOnly}
                            onClick={() => history('redo')}
                          >
                            Redo
                          </button>
                        </div>
                        {active.kind !== 'react-ui' && active.kind !== 'structured-graph' && (
                          <button onClick={() => setStyleLibraryOpen(true)}>
                            トークン・スタイル
                          </button>
                        )}
                        {['design', 'document', 'slide', 'whiteboard', 'data'].includes(
                          active.kind,
                        ) && (
                          <>
                            <button disabled={readOnly} onClick={() => startAuthoring(true)}>
                              再利用部品として保存
                            </button>
                            <button onClick={() => setReusableOpen('library')}>
                              部品ライブラリ
                            </button>
                            <button onClick={() => setReusableOpen('inspect')}>
                              部品の入力・表示
                            </button>
                            <button onClick={() => setReuseBatchOpen(true)}>
                              複数の成果物の部品を更新
                            </button>
                          </>
                        )}
                        {['review', 'file'].includes(active.kind) && (
                          <>
                            <button onClick={() => startAuthoring(true)}>表示設定を保存</button>
                            <button onClick={() => setReusableOpen('library')}>
                              表示設定ライブラリ
                            </button>
                          </>
                        )}
                        {!['review', 'file', 'react-ui', 'structured-graph'].includes(
                          active.kind,
                        ) && (
                          <button disabled={readOnly} onClick={() => setTemplateKind('fragment')}>
                            部分テンプレートを挿入
                          </button>
                        )}
                        {'reuse' in active.draft.content &&
                          active.draft.content.reuse?.instances.some(isStructureInstance) && (
                            <button disabled={readOnly} onClick={() => setStructureOpen(true)}>
                              項目数・配置を変更
                            </button>
                          )}
                        <button
                          disabled={
                            active.kind === 'react-ui' || active.kind === 'structured-graph'
                          }
                          onClick={() => setTemplateKind('preset')}
                        >
                          スタイル・表示プリセット
                        </button>
                        {!['review', 'file', 'react-ui', 'structured-graph'].includes(
                          active.kind,
                        ) && (
                          <button disabled={readOnly} onClick={() => startAuthoring(false)}>
                            テンプレートとして保存
                          </button>
                        )}
                        {!shared && onStartShared && active.kind !== 'structured-graph' && (
                          <button
                            onClick={() => {
                              if (!flushInputs()) return;
                              const current = recordsRef.current.find(
                                (record) => record.id === active.id,
                              );
                              if (current)
                                void onStartShared(current).catch((e) => setError(String(e)));
                            }}
                          >
                            Open collaboratively
                          </button>
                        )}
                        {shared && (
                          <>
                            <a href={shared.peerUrl} target="_blank" rel="noreferrer">
                              Open peer editor
                            </a>
                            <button
                              disabled={
                                readOnly || active.kind === 'review' || active.kind === 'file'
                              }
                              title={
                                active.kind === 'review' || active.kind === 'file'
                                  ? 'This surface uses shared annotations instead of content proposals'
                                  : undefined
                              }
                              onClick={() => {
                                void shared
                                  .requestProposal()
                                  .then(async (id) => {
                                    setSharedPreview({
                                      id,
                                      preview: await shared.session.adapter.previewProposal(id),
                                    });
                                  })
                                  .catch((e) => setError(String(e)));
                              }}
                            >
                              Agent proposal demo
                            </button>
                            <button
                              onClick={() => {
                                void shared.session.reconnect().catch((e) => setError(String(e)));
                              }}
                            >
                              Reconnect shared session
                            </button>
                            <button
                              onClick={() =>
                                downloadText(
                                  `${active.name}.session-checkpoint.json`,
                                  JSON.stringify(shared.session.checkpoint()),
                                  'application/json',
                                )
                              }
                            >
                              Export pending checkpoint
                            </button>
                            <button
                              disabled={!shared.session.pendingCount}
                              onClick={() => shared.session.discardUnsubmitted()}
                            >
                              Cancel unsubmitted edits
                            </button>
                            {shared.session.rejected.length > 0 && (
                              <>
                                <button
                                  onClick={() => {
                                    void shared.session
                                      .previewRetained()
                                      .then(setSharedPreview)
                                      .catch((e) => setError(String(e)));
                                  }}
                                >
                                  Preview retained edit again
                                </button>
                                <button
                                  onClick={() => {
                                    try {
                                      shared.session.retryText();
                                    } catch (e) {
                                      setError(String(e));
                                    }
                                  }}
                                >
                                  Retry retained text
                                </button>
                                <button
                                  onClick={() => {
                                    try {
                                      shared.session.discardRetained();
                                    } catch (e) {
                                      setError(String(e));
                                    }
                                  }}
                                >
                                  Discard retained input
                                </button>
                              </>
                            )}
                            <button
                              onClick={async () => {
                                if (!flushInputs()) return;
                                try {
                                  await shared.session.flush();
                                  if (shared.session.pendingCount || shared.session.rejected.length)
                                    throw new Error(
                                      '変更の確認が完了してから共有セッションを終了してください。',
                                    );
                                  shared.session.close();
                                  shared.leave();
                                } catch (e) {
                                  setError(String(e));
                                }
                              }}
                            >
                              Leave shared session
                            </button>
                            {shared.hostActions?.map((action) => (
                              <button
                                key={action.label}
                                onClick={() => {
                                  void Promise.resolve(action.run()).catch((e) =>
                                    setError(String(e)),
                                  );
                                }}
                              >
                                {action.label}
                              </button>
                            ))}
                          </>
                        )}

                        <button
                          disabled={active.kind === 'structured-graph'}
                          aria-expanded={inspector}
                          onClick={() => setInspector(!inspector)}
                        >
                          <MessageSquare size={16} />
                          Comments ({active.annotations.length})
                        </button>
                        <label>
                          <input
                            type="checkbox"
                            checked={readOnly}
                            onChange={(e) => setReadOnly(e.target.checked)}
                          />{' '}
                          Read only
                        </label>
                        {!shared && isDocument(content) && (
                          <button disabled={readOnly} onClick={requestProposal}>
                            External proposal demo
                          </button>
                        )}
                        {extensions.toolbar?.map((action) => (
                          <button key={action.id} onClick={() => action.run(selection)}>
                            {action.label}
                          </button>
                        ))}
                      </Menu>
                    </>
                  )}
                </header>
                {csvExportOpen && active && isStructuredData(active.draft.content) && (
                  <CsvExportDialog
                    name={active.name}
                    data={active.draft.content}
                    view={
                      dataViews[active.id] ??
                      active.draft.content.views?.[0] ??
                      defaultView(active.draft.content)
                    }
                    onClose={() => setCsvExportOpen(false)}
                    capture={() => {
                      if (!flushInputs()) throw new Error('入力を確定してから出力してください。');
                      exportGuard?.();
                      const latest = readCanonicalRecord(active.id).draft.content;
                      if (!latest || !isStructuredData(latest))
                        throw new Error('Data source changed');
                      return {
                        data: latest,
                        view:
                          dataViewsRef.current[active.id] ??
                          latest.views?.[0] ??
                          defaultView(latest),
                      };
                    }}
                  />
                )}
                {officeImportOpen && (
                  <Suspense fallback={<p role="status">Office importを読み込んでいます…</p>}>
                    <OfficeImportDialog
                      onClose={() => setOfficeImportOpen(false)}
                      creation={localImportCreationAdapter<ImportContent>(
                        {
                          putIfAbsent: async (value) => {
                            if (!officeCreationAllowed.current || !flushInputs())
                              throw new Error(
                                'Host does not permit creation while inputs are pending',
                              );
                            return (await storage.putIfAbsent({
                              ...value,
                              annotations: [],
                            } as StoredArtifact)) as Artifact<ImportContent>;
                          },
                        },
                        () => officeCreationAllowed.current,
                      )}
                      onCreated={async (artifact) => {
                        const record = { ...artifact, annotations: [] } as StoredArtifact;
                        sessions.current.set(record.id, createLocalSession(record.draft.content));
                        persist(record);
                        activate(record.id);
                      }}
                    />
                  </Suspense>
                )}
                {templateKind && (
                  <TemplateGallery
                    catalog={templateCatalog}
                    local={personalTemplates}
                    kind={templateKind}
                    readOnly={templateKind === 'whole' ? !!shared : readOnly}
                    target={
                      templateKind !== 'whole' && active
                        ? {
                            artifactId: active.id,
                            domain: active.kind as Domain,
                            content: nativeContent(active.draft.content),
                            ids: selection.addresses.map((a) => a.elementId),
                            afterId: selection.addresses.find(
                              (a) =>
                                ('slides' in active.draft.content &&
                                  active.draft.content.slides.some((p) => p.id === a.elementId)) ||
                                ('blocks' in active.draft.content &&
                                  active.draft.content.blocks.some((b) => b.id === a.elementId)),
                            )?.elementId,
                            shared: nativeShared(sharedSession),
                          }
                        : undefined
                    }
                    onClose={() => setTemplateKind(undefined)}
                    agentInputs={async (definition) => structuredClone(definition.sample)}
                    onCreate={async (prepared) => {
                      if (!flushInputs()) throw new Error('入力を確定してから作成してください。');
                      if (shared)
                        throw new Error(
                          'Leave the shared session before creating another artifact',
                        );
                      const artifact = await applyInstantiation(prepared, {
                        list: async () =>
                          (await storage.list())
                            .filter((r) => r.kind !== 'react-ui' && r.kind !== 'structured-graph')
                            .map(nativeRecord),
                        get: async (id) => {
                          const record = await storage.get(id);
                          return record &&
                            record.kind !== 'react-ui' &&
                            record.kind !== 'structured-graph'
                            ? nativeRecord(record)
                            : undefined;
                        },
                        put: async (value) => storage.put({ ...value, annotations: [] }),
                        putIfAbsent: async (value) =>
                          nativeRecord(await storage.putIfAbsent({ ...value, annotations: [] })),
                        remove: (id) => storage.remove(id),
                      });
                      const record = { ...artifact, annotations: [] } as StoredArtifact;
                      sessions.current.set(record.id, createLocalSession(record.draft.content));
                      persist(record);
                      activate(record.id);
                    }}
                    onApply={async (prepared) => {
                      if (!active || prepared.proposal.artifactId !== active.id || readOnly)
                        throw new Error('Target changed or is read only');
                      if (!sharedSession) {
                        const current = sessions.current.get(active.id)!;
                        const next = current.execute(
                          command(
                            'template.apply',
                            prepared.proposal.summary,
                            (value) => applyLocalTemplate(prepared, nativeContent(value)),
                            {
                              origin: 'proposal',
                              transactionId: prepared.id,
                              proposalId: prepared.id,
                            },
                          ),
                        );
                        persist({ ...editedDraft(active, next), annotations: active.annotations });
                      }
                      if (prepared.insertedIds[0]) {
                        select(prepared.insertedIds[0]);
                        setRevealAddress({
                          artifactId: active.id,
                          elementId: prepared.insertedIds[0],
                        });
                      }
                    }}
                    onViewSettings={(_domain, settings) => {
                      if (!active) return;
                      editPrivateSettings(active.id, settings);
                    }}
                  />
                )}
                {structureOpen &&
                  active &&
                  active.kind !== 'react-ui' &&
                  active.kind !== 'structured-graph' && (
                    <TemplateStructurePanel
                      catalog={templateCatalog}
                      local={personalTemplates}
                      readOnly={readOnly}
                      onClose={() => setStructureOpen(false)}
                      target={{
                        artifactId: active.id,
                        domain: active.kind as Domain,
                        content: nativeContent(active.draft.content),
                        ids: selection.addresses.map((a) => a.elementId),
                        shared: nativeShared(sharedSession),
                      }}
                      onApply={(prepared) => {
                        if (prepared.proposal.artifactId !== active.id || readOnly)
                          throw new Error('Target changed or is read only');
                        if (!sharedSession) {
                          const next = sessions.current.get(active.id)!.execute(
                            command(
                              'template.structure',
                              prepared.proposal.summary,
                              (value) => applyLocalTemplate(prepared, nativeContent(value)),
                              {
                                origin: 'proposal',
                                transactionId: prepared.id,
                                proposalId: prepared.id,
                              },
                            ),
                          );
                          persist({
                            ...editedDraft(active, next),
                            annotations: active.annotations,
                          });
                        }
                      }}
                    />
                  )}
                {authoring && active?.id === authoring.artifactId && (
                  <SaveTemplateDialog
                    reuse={authoring.reuse}
                    privateSettings={authoring.privateSettings}
                    domain={authoring.domain}
                    content={authoring.content}
                    ids={authoring.ids}
                    slideSelection={authoring.slideSelection}
                    catalog={personalTemplates}
                    onClose={() => setAuthoring(undefined)}
                    onSaved={() => setStatus('Template saved locally')}
                    onComponentSaved={() => setStatus('Reusable component published locally')}
                  />
                )}
                {styleLibraryOpen && active && active.kind !== 'structured-graph' && (
                  <TokenStyleLibrary
                    domain={active.kind as Domain}
                    catalog={templateCatalog}
                    writeCatalog={personalTemplates}
                    readOnly={readOnly}
                    onClose={() => setStyleLibraryOpen(false)}
                  />
                )}
                {reuseBatchOpen && (
                  <ReusableBatchDialog
                    catalog={templateCatalog}
                    readOnly={readOnly}
                    artifacts={[
                      ...records.filter(
                        (r) =>
                          r.id !== active?.id &&
                          r.kind !== 'react-ui' &&
                          r.kind !== 'structured-graph',
                      ),
                      ...(active && active.kind !== 'react-ui' && active.kind !== 'structured-graph'
                        ? [active]
                        : []),
                    ].map((r) => ({
                      id: r.id,
                      name: r.name,
                      domain: r.kind as Domain,
                      content: nativeContent(r.draft.content),
                    }))}
                    basis={reuseBatchBasis}
                    onApply={applyReuseBatch}
                    onClose={() => setReuseBatchOpen(false)}
                  />
                )}
                {reusableOpen && active && active.kind !== 'structured-graph' && (
                  <ReusableLibrary
                    catalog={templateCatalog}
                    writeCatalog={personalTemplates}
                    readOnly={readOnly}
                    inspect={reusableOpen === 'inspect'}
                    privateSettings={templateViewSettings[active.id]}
                    onPrivateSettings={(settings, expected) =>
                      savePrivateSettings(active.id, settings, expected)
                    }
                    onClose={() => setReusableOpen(undefined)}
                    target={{
                      artifactId: active.id,
                      domain: active.kind as Domain,
                      content: nativeContent(active.draft.content),
                      ids: selection.addresses.map((a) => a.elementId),
                      shared: nativeShared(sharedSession),
                    }}
                    onApply={(prepared) => {
                      if (!active || prepared.proposal.artifactId !== active.id || readOnly)
                        throw new Error('Target changed or is read only');
                      if (!sharedSession) {
                        const next = sessions.current.get(active.id)!.execute(
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
                        persist({ ...editedDraft(active, next), annotations: active.annotations });
                      }
                      if (prepared.insertedIds[0]) select(prepared.insertedIds[0]);
                    }}
                  />
                )}
                {reusableAnnotation && active && reusableAnnotation.artifactId === active.id && (
                  <ReusableAnnotationDialog
                    target={{
                      artifactId: active.id,
                      domain: active.kind as Domain,
                      content: nativeContent(active.draft.content),
                      ids: [reusableAnnotation.elementId],
                      shared: nativeShared(sharedSession),
                    }}
                    settings={templateViewSettings[active.id] ?? {}}
                    address={reusableAnnotation}
                    readOnly={readOnly}
                    onClose={() => setReusableAnnotation(undefined)}
                    onApply={(prepared) => {
                      if (prepared.source.artifactId !== active.id || readOnly)
                        throw new Error('Target changed or is read only');
                      if (!sharedSession) {
                        const current = recordsRef.current.find((a) => a.id === active.id);
                        if (!current) throw new Error('Artifact no longer exists');
                        applyLocalTemplate(
                          prepared.application,
                          nativeContent(current.draft.content),
                        );
                        if (!current.annotations.some((a) => a.id === prepared.annotation.id)) {
                          persist({
                            ...current,
                            annotations: [...current.annotations, prepared.annotation],
                          });
                          editorEvents.emit('annotation', prepared.annotation);
                        }
                      }
                      setStatus('Annotation created from display settings');
                    }}
                  />
                )}
                {saveOpen && (
                  <Dialog title="Save immutable version" onClose={() => setSaveOpen(false)}>
                    <p>
                      {shared
                        ? 'Save an immutable version of confirmed shared content. Pending input must be confirmed first.'
                        : 'Draft changes save automatically on this browser. A version keeps an immutable snapshot.'}
                    </p>
                    <label>
                      Version note
                      <input
                        aria-label="Version reason"
                        placeholder="Optional description"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy}
                      onClick={() => {
                        void saveVersion();
                        setSaveOpen(false);
                      }}
                    >
                      Save version
                    </button>
                  </Dialog>
                )}
                {navOpen && (
                  <button
                    className="library-backdrop"
                    aria-label="Close library"
                    onClick={() => setNavOpen(false)}
                  />
                )}
                <aside className={`library ${navOpen ? 'open' : ''}`} aria-label="Artifact library">
                  <div className="library-heading">
                    <h1>Library</h1>
                    <IconButton
                      icon={X}
                      label="Close library panel"
                      onClick={() => setNavOpen(false)}
                    />
                    <span>{records.length}</span>
                  </div>
                  <label className="create-type">
                    Artifact type
                    <select
                      aria-label="Artifact type"
                      value={kind}
                      onChange={(e) => setKind(e.target.value as Kind)}
                    >
                      {Object.entries(kinds).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary new-artifact"
                    onClick={() => create(kind)}
                    disabled={!loaded}
                  >
                    ＋ New artifact
                  </button>
                  <button disabled={!loaded || !!shared} onClick={() => setTemplateKind('whole')}>
                    テンプレートから作成
                  </button>
                  {active &&
                    ['design', 'document', 'slide', 'whiteboard', 'data'].includes(active.kind) && (
                      <button onClick={() => setReusableOpen('library')}>部品ライブラリ</button>
                    )}
                  <button
                    disabled={!loaded || !!shared || readOnly}
                    onClick={() => setOfficeImportOpen(true)}
                  >
                    Officeから新規作成
                  </button>
                  {!shared && onOpenPrivateEditor && (
                    <section aria-label="Private Video projects">
                      <button disabled={!loaded || busy} onClick={() => void openPrivateEditor()}>
                        New Video project (private)
                      </button>
                      {privateEntries.map((entry) => (
                        <button
                          key={entry.id}
                          data-private-project={entry.id}
                          disabled={!loaded || busy}
                          onClick={() => void openPrivateEditor(entry.id)}
                        >
                          {entry.name}
                        </button>
                      ))}
                    </section>
                  )}
                  {!shared && onOpenPrivateM2 && (
                    <section aria-label="Private Video M2 projects">
                      <button
                        disabled={!loaded || busy}
                        aria-label="Video（複数素材・音声編集）"
                        onClick={() => void openPrivateEditor(undefined, true)}
                      >
                        Video（複数素材・音声編集）
                      </button>
                      {privateM2Entries.map((entry) => (
                        <button
                          key={entry.id}
                          data-private-m2-project={entry.id}
                          disabled={!loaded || busy}
                          onClick={() => void openPrivateEditor(entry.id, true)}
                        >
                          {entry.name}
                        </button>
                      ))}
                    </section>
                  )}
                  <nav aria-label="Artifacts">
                    {records.map((a) => (
                      <button
                        key={a.id}
                        aria-current={a.id === activeId ? 'page' : undefined}
                        onClick={() => activate(a.id)}
                      >
                        <span className="artifact-icon">{kinds[a.kind as Kind]?.icon}</span>
                        <span>
                          {a.name}
                          <small>
                            {kinds[a.kind as Kind]?.label} · {a.versions.length} versions
                          </small>
                        </span>
                      </button>
                    ))}
                  </nav>
                  <label className="import-control">
                    ↑ Import artifact
                    <input
                      type="file"
                      aria-label="Import artifact"
                      accept=".md,.csv,.json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importFile(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <p className="library-note">
                    Local-first workspace
                    <br />
                    Your artifacts stay in this browser.
                  </p>
                </aside>
                <main className="workspace">
                  {Object.entries(loadErrors).map(([id, message]) => {
                    const retained = records.find((a) => a.id === id);
                    return (
                      retained && (
                        <div role="alert" className="error-banner" key={id}>
                          <span>
                            {retained.name}: {message}. Stored record is retained; other artifacts
                            remain available.
                          </span>
                          <button
                            onClick={() =>
                              downloadText(
                                `${retained.name}.json`,
                                serializeArtifact(retained),
                                'application/json',
                              )
                            }
                          >
                            Export retained {retained.name}
                          </button>
                        </div>
                      )
                    );
                  })}
                  {(error || sharedSession?.error) && (
                    <div className="error-banner" role="alert">
                      <span>{error || sharedSession?.error}</span>
                      {failedWrites.current.size > 0 && (
                        <button
                          onClick={() => {
                            for (const id of failedWrites.current) {
                              const record = recordsRef.current.find((r) => r.id === id);
                              if (record) persist(record);
                            }
                          }}
                        >
                          Retry local save
                        </button>
                      )}
                      <button aria-label="Dismiss error" onClick={() => setError('')}>
                        ×
                      </button>
                    </div>
                  )}
                  {!active ? (
                    <div className="welcome">
                      <span className="eyebrow">YOUR WORK, IN ITS OWN FORMAT</span>
                      <h2>
                        A space to make
                        <br />
                        and make sense.
                      </h2>
                      <p>
                        Write a document, explore a dataset, or review a change.
                        <br />
                        Every artifact has a history. Every surface speaks the same language.
                      </p>
                      <button className="primary" onClick={() => setTemplateKind('whole')}>
                        テンプレートを探す
                      </button>
                      <div className="welcome-tools">
                        {!shared && onOpenPrivateEditor && (
                          <button
                            aria-label="New Video project (private)"
                            disabled={!loaded || busy}
                            onClick={() => void openPrivateEditor()}
                          >
                            <strong>New Video project (private)</strong>
                            <small>Local Video review integration</small>
                          </button>
                        )}
                        {!shared && onOpenPrivateM2 && (
                          <button
                            disabled={!loaded || busy}
                            aria-label="Video（複数素材・音声編集）"
                            onClick={() => void openPrivateEditor(undefined, true)}
                          >
                            <strong>Video（複数素材・音声編集）</strong>
                            <small>Private local validation</small>
                          </button>
                        )}
                        {Object.entries(kinds).map(([k, v]) => (
                          <button
                            key={k}
                            aria-label={`New ${v.label}`}
                            onClick={() => create(k as Kind)}
                          >
                            <span>{v.icon}</span>
                            <strong>New {v.label}</strong>
                            <small>{v.description}</small>
                          </button>
                        ))}
                      </div>
                    </div>
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
                            <>
                              {rendered.graph && (
                                <NativeGraphSurface
                                  key={active.id}
                                  content={rendered.graph}
                                  profile={relationProfile}
                                  sourceRevision={canonicalJson(
                                    (session as EditorSession<Content>).revision,
                                  )}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  selectedId={selection.addresses[0]?.elementId}
                                  readOnly={readOnly}
                                />
                              )}
                              {rendered.reactUi && (
                                <ReactUiSurface
                                  screenReferences={[
                                    {
                                      namespace: 'reference-host',
                                      screenId: active.id,
                                      stateId: 'draft',
                                    },
                                  ]}
                                  key={active.id}
                                  content={rendered.reactUi}
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  selectedId={selection.addresses[0]?.elementId}
                                  runtime={referenceRegisteredRuntimeAdapter}
                                  examples={referenceReactExamples}
                                  revisions={[
                                    {
                                      component: referenceTextRevision,
                                      propMap: { text: 'content' },
                                      slotMap: {},
                                    },
                                    {
                                      environment: referenceEnvironmentRevision,
                                      propMap: {},
                                      slotMap: {},
                                    },
                                  ]}
                                  beforeExport={exportGuard}
                                />
                              )}
                              {rendered.document && (
                                <DocumentSurface
                                  references={sharedSession ? undefined : references}
                                  focusReferenceId={revealAddress?.elementId}
                                  key={
                                    sharedPreview
                                      ? `preview:${sharedPreview.id}:${sharedPreview.preview.token}`
                                      : active.id
                                  }
                                  textEngine={
                                    sharedPreview ? undefined : sharedSession?.text('text')
                                  }
                                  content={rendered.document}
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  selectedId={selection.addresses[0]?.elementId}
                                  annotations={active.annotations}
                                  focusAddress={revealAddress}
                                />
                              )}{' '}
                              {rendered.data && (
                                <MemoDataSurface
                                  key={active.id}
                                  content={rendered.data}
                                  initialView={
                                    dataViews[active.id] &&
                                    isStructuredData({
                                      ...rendered.data,
                                      views: [dataViews[active.id]],
                                    })
                                      ? {
                                          ...dataViews[active.id],
                                          widgets:
                                            rendered.data.views?.find(
                                              (view) => view.id === dataViews[active.id].id,
                                            )?.widgets ?? defaultView(rendered.data).widgets,
                                        }
                                      : undefined
                                  }
                                  onViewChange={dataViewChanged}
                                  renderGraph={
                                    shared
                                      ? undefined
                                      : (props) => (
                                          <DataGraphSurface
                                            {...props}
                                            sourceRevision={canonicalJson(
                                              (session as EditorSession<Content>).revision,
                                            )}
                                          />
                                        )
                                  }
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                />
                              )}{' '}
                              {rendered.review && (
                                <ReviewSurface
                                  onViewSettingsChange={(patch) =>
                                    editPrivateSettings(active.id, patch)
                                  }
                                  viewSettings={
                                    templateViewSettings[active.id] as {
                                      split?: boolean;
                                      wrap?: boolean;
                                    }
                                  }
                                  key={active.id}
                                  content={rendered.review}
                                  onSelectionClear={() => select([])}
                                  onVisibleSourceChange={(source) => {
                                    visibleReviewSource.current = { artifactId: active.id, source };
                                  }}
                                  resolveAnnotationSource={async (address) => {
                                    const region = address.region;
                                    if (region?.type !== 'lines') return undefined;
                                    const record = recordsRef.current.find(
                                      (record) => record.id === active.id,
                                    );
                                    for (const version of record?.versions ?? [])
                                      if (isReview(version.content)) {
                                        const file = version.content.files.find(
                                          (file) => file.id === address.elementId,
                                        );
                                        const side = region.side ?? 'new';
                                        if (
                                          file &&
                                          reviewRevision(file, side) ===
                                            reviewAddressRevision(address)
                                        )
                                          return {
                                            name: file.name,
                                            revisionId: reviewRevision(file, side),
                                            side,
                                            text: side === 'old' ? file.oldText : file.newText,
                                          };
                                      }
                                    return undefined;
                                  }}
                                  onRemapAnnotation={(id, region, fileId) => {
                                    if (readOnly) return;
                                    const latest = recordsRef.current.find(
                                      (record) => record.id === active.id,
                                    )!;
                                    if (!isReview(latest.draft.content)) return;
                                    const addresses = [
                                      { artifactId: active.id, elementId: fileId, region },
                                    ];
                                    try {
                                      assertReviewSelection(
                                        latest.draft.content,
                                        addresses,
                                        visibleReviewSource.current?.source,
                                        active.id,
                                      );
                                      persist({
                                        ...latest,
                                        annotations: latest.annotations.map((annotation) =>
                                          annotation.id === id
                                            ? remapReviewAnnotation(annotation, addresses[0])
                                            : annotation,
                                        ),
                                      });
                                    } catch (error) {
                                      setError(String(error));
                                    }
                                  }}
                                  readOnly={readOnly || !!sharedSession}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  annotations={active.annotations}
                                  focusAddress={revealAddress}
                                />
                              )}{' '}
                              {rendered.file && (
                                <FileSurface
                                  onViewSettingsChange={(patch) =>
                                    editPrivateSettings(active.id, patch)
                                  }
                                  viewSettings={
                                    templateViewSettings[active.id] as {
                                      fit?: 'page' | 'width' | 'actual';
                                      zoom?: number;
                                    }
                                  }
                                  key={active.id}
                                  content={rendered.file}
                                  onSelectionClear={() => select([])}
                                  onOpenAsNew={async (source) => {
                                    if (readOnly || sharedSession || !flushInputs())
                                      throw new Error(
                                        '現在は新しい成果物を作成できません。入力・権限を確認してください。',
                                      );
                                    const artifact = makeArtifact(
                                      'file',
                                      records.filter((record) => record.kind === 'file').length + 1,
                                    );
                                    artifact.name = source.name;
                                    artifact.draft.content = source;
                                    const stored = await storage.putIfAbsent(artifact);
                                    sessions.current.set(
                                      stored.id,
                                      createLocalSession(stored.draft.content),
                                    );
                                    persist(stored);
                                    activate(stored.id);
                                  }}
                                  onRemapAnnotation={(id, fileId, region) => {
                                    if (readOnly) return;
                                    const latest = recordsRef.current.find(
                                      (record) => record.id === active.id,
                                    )!;
                                    if (
                                      !isFile(latest.draft.content) ||
                                      latest.draft.content.id !== fileId ||
                                      !selection.addresses.some(
                                        (address) =>
                                          address.elementId === fileId &&
                                          canonicalJson(address.region) === canonicalJson(region),
                                      )
                                    ) {
                                      setError('現在の原本で対象を選び直してください。');
                                      return;
                                    }
                                    try {
                                      persist({
                                        ...latest,
                                        annotations: latest.annotations.map((annotation) =>
                                          annotation.id === id
                                            ? remapFileAnnotation(annotation, {
                                                artifactId: active.id,
                                                elementId: fileId,
                                                region,
                                              })
                                            : annotation,
                                        ),
                                      });
                                    } catch (error) {
                                      setError(
                                        String(error instanceof Error ? error.message : error),
                                      );
                                    }
                                  }}
                                  readOnly={readOnly || !!sharedSession}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  annotations={active.annotations}
                                  focusAddress={revealAddress}
                                />
                              )}{' '}
                              {rendered.whiteboard && (
                                <MemoWhiteboardSurface
                                  references={sharedSession ? undefined : references}
                                  focusReferenceId={revealAddress?.elementId}
                                  key={active.id}
                                  layout={whiteboardLayout}
                                  content={rendered.whiteboard}
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                />
                              )}{' '}
                              {rendered.design && (
                                <MemoDesignSurface
                                  references={sharedSession ? undefined : references}
                                  focusReferenceId={revealAddress?.elementId}
                                  key={active.id}
                                  prototype={{
                                    artifactId: active.id,
                                    annotations: active.annotations,
                                    onCreateAnnotation: readOnly
                                      ? undefined
                                      : async (address, body) => {
                                          if (!(await addComment({ addresses: [address] }, body)))
                                            throw new Error('Comment could not be created');
                                        },
                                    onFlowComplete: (event) => {
                                      setStatus(`Prototype flow completed: ${event.flowId}`);
                                    },
                                  }}
                                  content={rendered.design}
                                  runtime={referenceRuntimeAdapter}
                                  revisions={[
                                    {
                                      component: referenceTextRevision,
                                      propMap: { text: 'content' },
                                      slotMap: {},
                                    },
                                  ]}
                                  registerGenerated={(source) => {
                                    if (readOnly || sharedSession || !flushInputs())
                                      throw new Error(
                                        'Register from a writable local Design artifact with confirmed inputs',
                                      );
                                    const document = registerReferenceNative(source);
                                    if (
                                      surfaceExecute(
                                        retainDesignPublications(convertDesignToReact(source)),
                                      ) === false
                                    )
                                      throw new Error('Native publication was rejected');
                                    const artifact = makeArtifact(
                                      'react-ui',
                                      records.filter((r) => r.kind === 'react-ui').length + 1,
                                    );
                                    artifact.draft.content = document;
                                    artifact.designReactConversion = {
                                      sourceArtifactId: active.id,
                                      sourceHash: designReactSourceHash(source),
                                      basis: clone(document),
                                    };
                                    sessions.current.set(artifact.id, createLocalSession(document));
                                    persist(artifact);
                                    activate(artifact.id);
                                  }}
                                  regenerationTargets={records
                                    .filter(
                                      (record) =>
                                        record.kind === 'react-ui' &&
                                        record.designReactConversion?.sourceArtifactId ===
                                          active.id,
                                    )
                                    .map((record) => ({
                                      id: record.id,
                                      name: record.name,
                                      basis: record.designReactConversion!.basis,
                                      document: record.draft.content as ReactUiDocument,
                                    }))}
                                  applyRegeneration={(id, sourceHash, review) => {
                                    if (readOnly || sharedSession)
                                      throw new Error(
                                        'Apply regeneration from a writable local artifact; shared targets require their authority session',
                                      );
                                    const target = recordsRef.current.find(
                                      (record) => record.id === id,
                                    );
                                    if (
                                      !target?.designReactConversion ||
                                      reuseHash(target.designReactConversion.basis) !==
                                        review.from ||
                                      target.designReactConversion.sourceArtifactId !== active.id ||
                                      !isDesign(active.draft.content) ||
                                      designReactSourceHash(active.draft.content) !== sourceHash
                                    )
                                      throw new Error(
                                        'Conversion source/target changed after review',
                                      );
                                    const next = convertDesignToReact(active.draft.content);
                                    if (next.diagnostics.length)
                                      throw new Error(
                                        'Resolve native conversion diagnostics first',
                                      );
                                    registerReferenceNative(active.draft.content);
                                    surfaceExecute(retainDesignPublications(next));
                                    const targetSession = sessions.current.get(id)!;
                                    const result = targetSession.executeView(
                                      applyDesignReactDocumentRegeneration(
                                        review,
                                      ) as EditorCommand<Content>,
                                    );
                                    persist({
                                      ...editedDraft(target, result),
                                      designReactConversion: {
                                        sourceArtifactId: active.id,
                                        sourceHash,
                                        basis: clone(next.document),
                                      },
                                    });
                                  }}
                                  registrations={referenceDesignSettings.registrations}
                                  settings={referenceDesignSettings}
                                  publicationReadOnlyReason={
                                    sharedSession
                                      ? '共有Hostはnative React公開設定を受け付けません。編集可能なローカル成果物で設定してください。'
                                      : undefined
                                  }
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                />
                              )}{' '}
                              {rendered.slide && (
                                <SlideSurface
                                  references={sharedSession ? undefined : references}
                                  focusReferenceId={revealAddress?.elementId}
                                  focusAddress={revealAddress}
                                  key={active.id}
                                  content={rendered.slide}
                                  readOnly={readOnly}
                                  execute={surfaceExecute}
                                  select={surfaceSelect}
                                  dataSnapshots={records
                                    .filter((a) => isStructuredData(a.draft.content))
                                    .map((a) => {
                                      const data = a.draft.content as StructuredData,
                                        c =
                                          data.columns.find((c) => c.type === 'formula') ??
                                          data.columns.find((c) => c.type === 'number');
                                      return {
                                        label: a.name,
                                        labels: data.rows.map((r) =>
                                          String(r.values[data.columns[0]?.id] ?? ''),
                                        ),
                                        values: data.rows.map((r) =>
                                          c ? Number(displayCell(data, r, c)) || 0 : 0,
                                        ),
                                        capturedAt: new Date().toISOString(),
                                      };
                                    })}
                                />
                              )}
                            </>
                          )}
                          {view === 'History' && (
                            <section className="history-view">
                              <h2>Version history</h2>
                              <p className="muted">
                                Committed snapshots are immutable. Editing continues in a separate
                                draft.
                              </p>
                              {active.versions.length === 0 ? (
                                <p className="empty">Save your first version to begin a history.</p>
                              ) : (
                                active.versions.map((v, i) => (
                                  <article key={v.versionId}>
                                    <span className="version-number">{i + 1}</span>
                                    <div>
                                      <h3>{v.reason ?? 'Saved version'}</h3>
                                      <p>
                                        {new Date(v.createdAt).toLocaleString()} · {v.createdBy}
                                      </p>
                                      <code title={v.contentHash}>
                                        SHA-256 {v.contentHash.slice(0, 16)}…
                                      </code>
                                    </div>
                                    <button
                                      onClick={() => {
                                        if (sharedSession) {
                                          void sharedSession
                                            .restore(v.versionId)
                                            .catch((e) => setError(String(e)));
                                          setView('Editor');
                                          return;
                                        }
                                        execute(
                                          command(
                                            'artifact.restore',
                                            'Restore version to draft',
                                            () => clone(v.content),
                                          ),
                                        );
                                        setView('Editor');
                                      }}
                                    >
                                      Restore to draft
                                    </button>
                                  </article>
                                ))
                              )}
                            </section>
                          )}
                          {view === 'Compare' && (
                            <section className="compare-view">
                              <h2>Compare versions</h2>
                              {active.versions.length < 2 ? (
                                <p className="empty">
                                  Save at least two versions to compare their content.
                                </p>
                              ) : (
                                <>
                                  <div className="compare-controls">
                                    <label>
                                      Before
                                      <select
                                        aria-label="Before version"
                                        value={beforeId || active.versions.at(-2)!.versionId}
                                        onChange={(e) => setBeforeId(e.target.value)}
                                      >
                                        {active.versions.map((v, i) => (
                                          <option key={v.versionId} value={v.versionId}>
                                            Version {i + 1} · {v.reason}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <span>→</span>
                                    <label>
                                      After
                                      <select
                                        aria-label="After version"
                                        value={afterId || active.versions.at(-1)!.versionId}
                                        onChange={(e) => setAfterId(e.target.value)}
                                      >
                                        {active.versions.map((v, i) => (
                                          <option key={v.versionId} value={v.versionId}>
                                            Version {i + 1} · {v.reason}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  </div>
                                  <p>{compare().changes.length} changes</p>
                                  {compare().changes.map((change, i) => (
                                    <article className={`change ${change.kind}`} key={i}>
                                      <header>
                                        <strong>{change.kind}</strong>
                                        <span>{change.path}</span>
                                      </header>
                                      <div className="text-pair">
                                        <pre>{change.before ?? '—'}</pre>
                                        <pre>{change.after ?? '—'}</pre>
                                      </div>
                                    </article>
                                  ))}
                                  {compare().changes.length === 0 && (
                                    <p className="empty">These versions have identical content.</p>
                                  )}
                                </>
                              )}
                            </section>
                          )}
                        </div>
                        {sharedPreview && shared && (
                          <aside className="inspector" aria-label="Shared proposal preview">
                            <h2>Proposal preview</h2>
                            <p>
                              The canvas shows the proposed result. Apply checks its dependencies
                              again.
                            </p>
                            <p>{sharedPreview.preview.changedKeys.length} changed resources</p>
                            <button
                              onClick={() => {
                                void (async () => {
                                  const request = ++sharedProposalRequest.current;
                                  const id = await shared.requestProposal();
                                  const preview = await shared.session.adapter.previewProposal(id);
                                  if (request !== sharedProposalRequest.current) {
                                    await shared.session.adapter.cancelProposal(id);
                                    return;
                                  }
                                  await shared.session.adapter.cancelProposal(sharedPreview.id);
                                  if (request !== sharedProposalRequest.current) {
                                    await shared.session.adapter.cancelProposal(id);
                                    return;
                                  }
                                  setSharedPreview({ id, preview });
                                  setError('');
                                })().catch((e) => setError(String(e)));
                              }}
                            >
                              Request revised proposal
                            </button>
                            <button
                              onClick={() => {
                                void shared.session
                                  .applyProposal(sharedPreview.id, sharedPreview.preview.token)
                                  .then(() => setSharedPreview(undefined))
                                  .catch((e) => setError(String(e)));
                              }}
                            >
                              Apply shared proposal
                            </button>
                            <button
                              onClick={() => {
                                void shared.session.adapter
                                  .previewProposal(sharedPreview.id)
                                  .then((preview) =>
                                    setSharedPreview({ ...sharedPreview, preview }),
                                  )
                                  .catch((e) => setError(String(e)));
                              }}
                            >
                              Refresh preview
                            </button>
                            <button
                              onClick={() => {
                                sharedProposalRequest.current++;
                                setSharedPreview(undefined);
                                void shared.session.adapter
                                  .cancelProposal(sharedPreview.id, true)
                                  .catch((e) => setError(String(e)));
                              }}
                            >
                              Reject shared proposal
                            </button>
                            <button
                              onClick={() => {
                                sharedProposalRequest.current++;
                                setSharedPreview(undefined);
                                void shared.session.adapter
                                  .cancelProposal(sharedPreview.id)
                                  .catch((e) => setError(String(e)));
                              }}
                            >
                              Cancel shared proposal
                            </button>
                          </aside>
                        )}
                        {inspector && active.kind !== 'structured-graph' && (
                          <aside className="inspector" aria-label="Comments inspector">
                            <div className="ep-dialog-heading">
                              <h2>Comments & annotations</h2>
                              <IconButton
                                icon={X}
                                label="Close comments"
                                onClick={() => setInspector(false)}
                              />
                            </div>
                            <p className="selection-label">
                              {isReview(active.draft.content) &&
                                selection.addresses.map((address) => {
                                  const file = isReview(active.draft.content)
                                    ? active.draft.content.files.find(
                                        (file) => file.id === address.elementId,
                                      )
                                    : undefined;
                                  return (
                                    <span key={address.elementId}>
                                      {file?.name} ·{' '}
                                      {address.region?.type === 'lines'
                                        ? address.region.revisionId
                                        : ''}{' '}
                                      ·{' '}
                                    </span>
                                  );
                                })}
                              {selection.addresses.length
                                ? `${selection.addresses.length} element selected${selection.addresses[0].region ? ` · ${selection.addresses[0].region.type}` : ''}`
                                : 'Select an element to anchor a comment.'}
                            </p>
                            <label>
                              Comment
                              <textarea
                                aria-label="Comment"
                                rows={3}
                                placeholder="Leave a note on this selection…"
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                              />
                            </label>
                            <button
                              className="primary"
                              disabled={readOnly || !selection.addresses.length || !comment.trim()}
                              onClick={() => addComment()}
                            >
                              Add comment
                            </button>
                            {['review', 'file'].includes(active.kind) &&
                              templateViewSettings[active.id]?.$annotation && (
                                <button
                                  disabled={readOnly || selection.addresses.length !== 1}
                                  onClick={() =>
                                    setReusableAnnotation(clone(selection.addresses[0]))
                                  }
                                >
                                  設定から注釈を作成
                                </button>
                              )}
                            <label className="resolved-toggle">
                              <input
                                type="checkbox"
                                checked={showResolved}
                                onChange={(e) => setShowResolved(e.target.checked)}
                              />{' '}
                              Show resolved
                            </label>
                            {active.annotations
                              .filter((a) => showResolved || !a.resolved)
                              .map((a) => (
                                <article
                                  className={`comment-thread ${a.resolved ? 'resolved' : ''}`}
                                  key={a.id}
                                  style={
                                    a.color
                                      ? { borderLeft: `4px solid ${a.color}`, paddingLeft: 8 }
                                      : undefined
                                  }
                                >
                                  <small>
                                    {a.anchor.addresses[0].region?.type ?? 'element'} ·{' '}
                                    {a.resolved ? 'Resolved' : 'Open'} ·{' '}
                                    {anchorState(content, a.anchor.addresses[0])}
                                  </small>
                                  <button
                                    disabled={
                                      anchorState(content, a.anchor.addresses[0]) !== 'Current'
                                    }
                                    onClick={() => {
                                      setRevealAddress({ ...a.anchor.addresses[0] });
                                      setSelection(a.anchor);
                                      setView('Editor');
                                    }}
                                  >
                                    Jump to annotation
                                  </button>
                                  {a.anchor.addresses[0].region?.type === 'lines' && (
                                    <small>
                                      {a.anchor.addresses[0].region.side ?? 'text'} · lines{' '}
                                      {a.anchor.addresses[0].region.start}–
                                      {a.anchor.addresses[0].region.end}
                                    </small>
                                  )}
                                  {a.comments.map((c) => (
                                    <div key={c.id}>
                                      <strong>{c.author}</strong>
                                      <p>{c.body}</p>
                                      <time>{new Date(c.createdAt).toLocaleString()}</time>
                                    </div>
                                  ))}
                                  <button
                                    disabled={readOnly}
                                    onClick={() => {
                                      if (sharedSession) {
                                        try {
                                          sharedSession.actions([
                                            {
                                              type: 'thread.resolve',
                                              target: a.id,
                                              payload: { value: !a.resolved },
                                            },
                                          ]);
                                        } catch (e) {
                                          setError(String(e));
                                        }
                                        return;
                                      }
                                      const updated = { ...a, resolved: !a.resolved };
                                      persist({
                                        ...active,
                                        annotations: active.annotations.map((t) =>
                                          t.id === a.id ? updated : t,
                                        ),
                                      });
                                      editorEvents.emit('annotation', updated);
                                    }}
                                  >
                                    {a.resolved ? 'Reopen' : 'Resolve'}
                                  </button>
                                  <details>
                                    <summary>Reply</summary>
                                    <form
                                      onSubmit={(e) => {
                                        e.preventDefault();
                                        const form = e.currentTarget;
                                        const body = String(
                                          new FormData(form).get('reply') ?? '',
                                        ).trim();
                                        if (!body || readOnly) return;
                                        if (sharedSession) {
                                          try {
                                            sharedSession.actions([
                                              {
                                                type: 'thread.reply',
                                                target: a.id,
                                                payload: {
                                                  id: newId('comment'),
                                                  text: body,
                                                  createdAt: new Date().toISOString(),
                                                },
                                              },
                                            ]);
                                            form.reset();
                                          } catch (e) {
                                            setError(String(e));
                                          }
                                          return;
                                        }
                                        const updated = {
                                          ...a,
                                          comments: [
                                            ...a.comments,
                                            {
                                              id: newId('comment'),
                                              body,
                                              author: 'local-user',
                                              createdAt: new Date().toISOString(),
                                            },
                                          ],
                                        };
                                        persist({
                                          ...active,
                                          annotations: active.annotations.map((t) =>
                                            t.id === a.id ? updated : t,
                                          ),
                                        });
                                        editorEvents.emit('annotation', updated);
                                        form.reset();
                                      }}
                                    >
                                      <input aria-label="Reply text" name="reply" required />
                                      <button>Post reply</button>
                                    </form>
                                  </details>
                                </article>
                              ))}
                            {inspectorSlot}
                          </aside>
                        )}
                      </div>
                    </>
                  )}
                </main>
                {proposal && (
                  <dialog
                    ref={proposalDialog}
                    onCancel={() => setProposal(null)}
                    aria-label="External proposal preview"
                    className="proposal-dialog"
                    tabIndex={-1}
                  >
                    <span className="eyebrow">EXTERNAL CHANGE PROPOSAL</span>
                    <h2>{proposal.value.summary}</h2>
                    <p>{proposal.value.source}</p>
                    <p className="muted">
                      Preview only. Applying creates one undoable transaction.
                    </p>
                    <div className="text-pair">
                      <section>
                        <h3>Current draft</h3>
                        <pre>
                          {content && isDocument(content)
                            ? exportMarkdown(content)
                            : canonicalJson(content)}
                        </pre>
                      </section>
                      <section>
                        <h3>Proposed draft</h3>
                        <pre>
                          {isDocument(proposal.preview)
                            ? exportMarkdown(proposal.preview)
                            : canonicalJson(proposal.preview)}
                        </pre>
                      </section>
                    </div>
                    <footer>
                      <button autoFocus onClick={() => setProposal(null)}>
                        Reject proposal
                      </button>
                      <button className="primary" onClick={applyProposal}>
                        Apply proposal
                      </button>
                    </footer>
                  </dialog>
                )}
              </div>
            </CanvasTextContext.Provider>
          </CanvasPresenceContext.Provider>
        </OfficeExportHost>
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
