import { PlaygroundFictionMap } from '../fiction-map/host';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { designPageReviewHost } from './design-page-review';
import { readMangaWorkspace, writeMangaWorkspace } from './manga-workspace';
import {
  novelNotationRules,
  readNovelChapters,
  readNovelGoal,
  readNovelWorkspace,
  writeNovelGoal,
  writeNovelWorkspace,
} from './novel-workspace';
import { isEstimate } from '@editor-platform/estimate-core';
import { PlaygroundEstimate } from './estimate-host';
import { isAnalysis } from '@editor-platform/analysis-core';
import { PlaygroundAnalysis } from './analysis-host';
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ComponentProps,
  type MutableRefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type {
  EditorCommand,
  EditorInputs,
  EditorSession,
  ElementAddress,
  ProposedCommands,
  Region,
  Selection,
} from '@editor-platform/editor-core';
import { AnimationDesignImportPanel } from '@editor-platform/animation-adapters/design-ui';
import { AnimationHostSurface as AnimationSurface } from '@editor-platform/animation/host';
import {
  readAnimationHostContent,
  readAnimation2,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import { NativeGraphSurface, relationProfile } from '@editor-platform/structured-graph';
import type { BimDocument } from '@editor-platform/bim-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import type { SimulationDocument } from '@editor-platform/simulation-core';
import type { ConstructionDocument } from '@editor-platform/construction-core';
import type { PcbDocument } from '@editor-platform/pcb-core';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import type { LadderDocument } from '@editor-platform/ladder-core';
import type { CosimDocument } from '@editor-platform/cosim-core';
import type { CadDocument } from '@editor-platform/cad-core';
import { DataGraphSurface } from '@editor-platform/structured-data-graph';
import { DesignReactSurface } from '@editor-platform/design-react';
import {
  convertDesignToReact,
  designReactSourceHash,
  applyDesignReactDocumentRegeneration,
  retainDesignPublications,
} from '@editor-platform/design-react-core';
import {
  DataSurface,
  isStructuredData,
  defaultView,
  type DataView,
  type StructuredData,
} from '@editor-platform/structured-data';
import {
  FileSurface,
  ReviewSurface,
  isFile,
  isReview,
  assertReviewSelection,
  remapReviewAnnotation,
  remapFileAnnotation,
  type ReviewVisibleSource,
} from '@editor-platform/review-surfaces';
import { isDesign, isDesignWithPaths } from '@editor-platform/design';
import {
  ReactUiSurface,
  reactUiExportKinds,
  type ReactUiExportKind,
} from '@editor-platform/react-ui';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { reuseHash } from '@editor-platform/reuse-core';
import type { InputValue, PrivateViewSettings } from '@editor-platform/templates';
import {
  registerReferenceNative,
  referenceRegisteredRuntimeAdapter,
} from '../../../react-ui-reference/src/generated-registry';
import {
  referenceDesignRuntime,
  referenceDesignRegistrations,
  referenceDesignSettings,
  referenceDependencyDesignSettings,
} from '../../../react-ui-reference/src/design-catalog';
import {
  createReferenceDocument,
  referenceRuntimeAdapter,
  referenceTextRevision,
  referenceEnvironmentRevision,
} from '../../../react-ui-reference/src/catalog';
import { GeoSurface } from '../geo/surface';
import type { GeoDocument } from '@editor-platform/geo-core';
import { isGraphDocument } from '@editor-platform/structured-graph';
import { DocumentSurface, isDocument, type DocumentContent } from '@editor-platform/document';
import { composeDocumentSequence } from '@editor-platform/document/sequence';
import { WhiteboardSurface, isWhiteboard } from '@editor-platform/whiteboard';
import { SlideSurface, isDeck } from '@editor-platform/slide';
import { isSchedule, type ScheduleDocument } from '@editor-platform/schedule/model';
import { ScheduleSurface } from '@editor-platform/schedule/view';
import { dataTimelineOptions, scheduleLaneHost } from '@editor-platform/reference-adapters';
import type { savedAnimationCatalog } from '../animation-library';
import type { Preview } from '@editor-platform/collaboration-core';
import {
  createLocalSession,
  makeArtifact,
  validContent,
  type Content,
  type StoredArtifact,
} from '../model';
import { editedDraft, storage } from './records';
import {
  designFrameSources,
  reviewAnnotationSource,
  slideAnimationSources,
  slideDataSnapshots,
} from './surface-sources';
import { graphProfileFor } from './graph-templates';
import { DesignInkTools, type DesignInkToolsControl } from './design-ink-tools';
import { MangaArtTools } from 'virtual:playground-manga-tools';

const referenceReactExamples = [
  { name: 'Product page', document: createReferenceDocument('product') },
  { name: 'Contact form', document: createReferenceDocument('form') },
  { name: '製品ページ（日本語）', document: createReferenceDocument('product', 'ja') },
  { name: 'お問い合わせ（日本語）', document: createReferenceDocument('form', 'ja') },
  { name: 'Host tokens', document: createReferenceDocument('tokens') },
];
const MemoDataSurface = memo(DataSurface);
const MemoDesignSurface = memo(function ReferenceDesignSurface(
  props: ComponentProps<typeof DesignReactSurface>,
) {
  // Playground replaces native content on edits. Keep that immutable snapshot stable
  // across pending-input/status renders so a pointer gesture retains its revision.
  const content = useMemo(() => deepFreeze(clone(props.content)), [props.content]);
  const runtime = useMemo(() => referenceDesignRuntime(content), [content]);
  const settings =
    new URLSearchParams(location.search).get('design-dependencies') === '1'
      ? referenceDependencyDesignSettings
      : props.settings;
  const registrations = useMemo(() => referenceDesignRegistrations(props.content), [props.content]);
  return (
    <DesignReactSurface
      {...props}
      content={content}
      settings={settings}
      runtime={runtime}
      registrations={registrations}
    />
  );
});
const MemoWhiteboardSurface = memo(WhiteboardSurface);
// Three.js and the kernel adapter load only when a CAD artifact opens.
const CadHost = lazy(() => import('../cad/host'));
// The building Surface and its kernel Worker load only when a building opens.
const BimHost = lazy(() => import('../bim/host'));
const CharacterHost = lazy(() => import('../character/host'));
const SimulationHost = lazy(() => import('../simulation/host'));
const ConstructionHost = lazy(() => import('../construction/host'));
const PcbHost = lazy(() => import('../pcb/host'));
const SchematicHost = lazy(() => import('../schematic/host'));
const LadderHost = lazy(() => import('../ladder/host'));
const CosimHost = lazy(() => import('../cosim/host'));

export function checkedContent(content: unknown, kind: string | undefined) {
  return {
    estimate: kind === 'estimate' && isEstimate(content) ? content : undefined,
    analysis: kind === 'analysis' && isAnalysis(content) ? content : undefined,
    animation:
      kind === 'animation' && validContent('animation', content)
        ? (content as AnimationHostContent)
        : undefined,
    fictionMap:
      kind === 'fiction-map' && validContent('fiction-map', content)
        ? (content as FictionMapContent)
        : undefined,
    geo: kind === 'geo' && validContent('geo', content) ? (content as GeoDocument) : undefined,
    graph: kind === 'structured-graph' && isGraphDocument(content) ? content : undefined,
    reactUi:
      kind === 'react-ui' && validContent('react-ui', content)
        ? (content as ReactUiDocument)
        : undefined,
    document: kind === 'document' && isDocument(content) ? content : undefined,
    data: kind === 'data' && isStructuredData(content) ? content : undefined,
    review: kind === 'review' && isReview(content) ? content : undefined,
    file: kind === 'file' && isFile(content) ? content : undefined,
    whiteboard: kind === 'whiteboard' && isWhiteboard(content) ? content : undefined,
    design: kind === 'design' && isDesignWithPaths(content) ? content : undefined,
    slide: kind === 'slide' && isDeck(content) ? content : undefined,
    schedule: kind === 'schedule' && isSchedule(content) ? content : undefined,
    cad: kind === 'cad' && validContent('cad', content) ? (content as CadDocument) : undefined,
    bim: kind === 'bim' && validContent('bim', content) ? (content as BimDocument) : undefined,
    character:
      kind === 'character' && validContent('character', content)
        ? (content as CharacterDocument)
        : undefined,
    simulation:
      kind === 'simulation' && validContent('simulation', content)
        ? (content as SimulationDocument)
        : undefined,
    construction:
      kind === 'construction' && validContent('construction', content)
        ? (content as ConstructionDocument)
        : undefined,
    pcb: kind === 'pcb' && validContent('pcb', content) ? (content as PcbDocument) : undefined,
    schematic:
      kind === 'schematic' && validContent('schematic', content)
        ? (content as SchematicDocument)
        : undefined,
    ladder:
      kind === 'ladder' && validContent('ladder', content)
        ? (content as LadderDocument)
        : undefined,
    cosim:
      kind === 'cosim' && validContent('cosim', content) ? (content as CosimDocument) : undefined,
  };
}
export type RenderedContent = ReturnType<typeof checkedContent>;

type SurfaceExecute = <T extends Content>(cmd: EditorCommand<T>) => boolean;
type SurfaceSelect = (ids: string | string[], region?: Region, pageId?: string) => void;

/** Playground Host state and actions each native surface binds to. */
export interface SurfaceHost {
  active: StoredArtifact;
  records: StoredArtifact[];
  recordsRef: MutableRefObject<StoredArtifact[]>;
  savedRecords: MutableRefObject<Map<string, StoredArtifact>>;
  sessions: MutableRefObject<Map<string, EditorSession<Content>>>;
  session: EditorSession<Content> | SharedEditorSession<Content> | undefined;
  sharedSession: SharedEditorSession<Content> | undefined;
  /** Shared connections render graphs without the local data-graph bridge. */
  shared: boolean;
  sharedPreview: { id: string; preview: Preview<Content> } | undefined;
  inputs: EditorInputs;
  readOnly: boolean;
  busy: boolean;
  selection: Selection;
  revealAddress: ElementAddress | undefined;
  references: ReferenceResolver;
  loadErrors: Record<string, string>;
  animationCatalog: ReturnType<typeof savedAnimationCatalog>;
  dataViews: Record<string, DataView>;
  templateViewSettings: Record<string, Record<string, InputValue>>;
  visibleReviewSource: MutableRefObject<
    { artifactId: string; source: ReviewVisibleSource } | undefined
  >;
  referenceNavigation: MutableRefObject<
    (sourceId: string, elementId: string, pageId?: string) => boolean
  >;
  whiteboardLayout: { viewKey: string };
  canvasText: ((id: string) => ReturnType<SharedEditorSession<Content>['text']>) | undefined;
  exportGuard: (() => void) | undefined;
  previewBlocked: boolean;
  execute: SurfaceExecute;
  select: SurfaceSelect;
  /** The current-render select, used where the surface clears selection directly. */
  selectNow: SurfaceSelect;
  persist(record: StoredArtifact): unknown;
  activate(id: string): void;
  flushInputs(): boolean;
  history(direction: 'undo' | 'redo'): void;
  saveVersion(): Promise<void>;
  /** Shows Host-built commands in the proposal review; the author applies or rejects them. */
  reviewProposal(value: ProposedCommands<Content>): void;
  addComment(selection: Selection, body: string): Promise<boolean | undefined>;
  dataViewChanged(view: DataView): void;
  editPrivateSettings(id: string, patch: PrivateViewSettings): void;
  setRevealAddress(address: ElementAddress): void;
  setError(message: string): void;
  setStatus(message: string): void;
}

function latestRecord(host: SurfaceHost, id = host.active.id) {
  return host.recordsRef.current.find((record) => record.id === id);
}

function GeoHost({ host }: { host: SurfaceHost }) {
  const { active, savedRecords, readOnly } = host;
  return (
    <GeoSurface
      artifact={active}
      session={host.session as EditorSession<Content>}
      inputs={host.inputs}
      readOnly={readOnly}
      records={[...savedRecords.current.values()]}
      saved={() => {
        const a = savedRecords.current.get(active.id);
        if (!a) throw Error('Geo artifact not saved');
        return a;
      }}
      execute={(cmd, resources, dataInputs) => {
        if (readOnly) return false;
        try {
          const s = host.sessions.current.get(active.id)!,
            a = latestRecord(host)!;
          const next = s.executeView(cmd as EditorCommand<Content>);
          host.persist({
            ...editedDraft(a, next),
            ...(resources ? { geoResources: resources } : {}),
            ...(dataInputs ? { geoDataInputs: dataInputs } : {}),
          });
          return true;
        } catch (e) {
          host.setError(String(e));
          return false;
        }
      }}
      history={host.history}
      save={host.saveVersion}
    />
  );
}

function AnimationLibrary({ host }: { host: SurfaceHost }) {
  const { sharedSession, session } = host;
  return (
    <>
      {host.animationCatalog.unavailable.map((entry, index) => (
        <p role="note" key={index}>
          {entry.label}: {entry.reason}
        </p>
      ))}
      <AnimationDesignImportPanel
        sources={designFrameSources([...host.savedRecords.current.values()])}
        inputs={host.inputs}
        readOnly={host.readOnly || host.busy}
        read={() => readAnimation2(sharedSession?.viewContent ?? session!.content)}
        execute={(command) => host.execute(command as EditorCommand<Content>)}
      />
    </>
  );
}

function AnimationHost({ host, content }: { host: SurfaceHost; content: AnimationHostContent }) {
  const { active, sharedSession, session, inputs, exportGuard } = host;
  return (
    <AnimationSurface
      artifactId={active.id}
      saving={host.busy}
      sources={host.animationCatalog.sources}
      content={content}
      beforeCapture={() => {
        flushSync(() => inputs.flush());
        exportGuard?.();
      }}
      canExport={() =>
        !sharedSession ||
        (!sharedSession.pendingCount && !sharedSession.rejected.length && !host.previewBlocked)
      }
      select={(ids, compositionId) => host.select([...ids], undefined, compositionId)}
      focusId={host.revealAddress?.elementId}
      library={content.schemaVersion === 2 ? <AnimationLibrary host={host} /> : undefined}
      session={session as EditorSession<AnimationHostContent>}
      inputs={inputs}
      read={() => readAnimationHostContent(sharedSession?.viewContent ?? session!.content)}
      textBridge={host.canvasText}
      readOnly={host.readOnly}
      execute={(cmd) =>
        host.execute<AnimationHostContent>({
          ...cmd,
          apply: (content) => readAnimationHostContent(cmd.apply(content)),
        })
      }
      history={host.history}
      onError={(error) => host.setError(String(error))}
    />
  );
}

/** Restores a saved view preference only while it still validates against the data. */
function retainedDataView(data: StructuredData, view: DataView | undefined) {
  if (!view || !isStructuredData({ ...data, views: [view] })) return undefined;
  return {
    ...view,
    widgets:
      data.views?.find((saved) => saved.id === view.id)?.widgets ?? defaultView(data).widgets,
  };
}

function DataHost({ host, content }: { host: SurfaceHost; content: StructuredData }) {
  const { session } = host;
  return (
    <MemoDataSurface
      content={content}
      initialView={retainedDataView(content, host.dataViews[host.active.id])}
      onViewChange={host.dataViewChanged}
      renderGraph={
        host.shared
          ? undefined
          : (props) => (
              <DataGraphSurface
                {...props}
                sourceRevision={canonicalJson((session as EditorSession<Content>).revision)}
              />
            )
      }
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
    />
  );
}

function ScheduleHost({ host, content }: { host: SurfaceHost; content: ScheduleDocument }) {
  const { references, savedRecords } = host;
  // Lanes read saved Data versions only; drafts are never referenced.
  const lanes = useMemo(
    () =>
      scheduleLaneHost(references, async () =>
        dataTimelineOptions(
          [...savedRecords.current.values()]
            .filter((record) => record.kind === 'data' && record.versions.length)
            .map((record) => ({
              id: record.id,
              name: record.name,
              content: record.versions.at(-1)!.content,
            })),
        ),
      ),
    [references, savedRecords],
  );
  return (
    <ScheduleSurface
      content={content}
      execute={host.execute}
      readOnly={host.readOnly}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      focusAddress={host.revealAddress}
      lanes={host.shared ? undefined : lanes}
    />
  );
}

function ReviewHost({
  host,
  content,
}: {
  host: SurfaceHost;
  content: NonNullable<RenderedContent['review']>;
}) {
  const { active, readOnly } = host;
  return (
    <ReviewSurface
      onViewSettingsChange={(patch) => host.editPrivateSettings(active.id, patch)}
      viewSettings={host.templateViewSettings[active.id] as { split?: boolean; wrap?: boolean }}
      content={content}
      onSelectionClear={() => host.selectNow([])}
      onVisibleSourceChange={(source) => {
        host.visibleReviewSource.current = { artifactId: active.id, source };
      }}
      resolveAnnotationSource={async (address) =>
        reviewAnnotationSource(latestRecord(host), address)
      }
      onRemapAnnotation={(id, region, fileId) => {
        if (readOnly) return;
        const latest = latestRecord(host)!;
        if (!isReview(latest.draft.content)) return;
        const addresses = [{ artifactId: active.id, elementId: fileId, region }];
        try {
          assertReviewSelection(
            latest.draft.content,
            addresses,
            host.visibleReviewSource.current?.source,
            active.id,
          );
          host.persist({
            ...latest,
            annotations: latest.annotations.map((annotation) =>
              annotation.id === id ? remapReviewAnnotation(annotation, addresses[0]) : annotation,
            ),
          });
        } catch (error) {
          host.setError(String(error));
        }
      }}
      readOnly={readOnly || !!host.sharedSession}
      canComment={!readOnly}
      onAddComment={(body) => host.addComment(host.selection, body)}
      execute={host.execute}
      select={host.select}
      annotations={active.annotations}
      focusAddress={host.revealAddress}
    />
  );
}

function FileHost({
  host,
  content,
}: {
  host: SurfaceHost;
  content: NonNullable<RenderedContent['file']>;
}) {
  const { active, readOnly } = host;
  return (
    <FileSurface
      onViewSettingsChange={(patch) => host.editPrivateSettings(active.id, patch)}
      viewSettings={
        host.templateViewSettings[active.id] as {
          fit?: 'page' | 'width' | 'actual';
          zoom?: number;
        }
      }
      content={content}
      onSelectionClear={() => host.selectNow([])}
      onOpenAsNew={async (source) => {
        if (readOnly || host.sharedSession || !host.flushInputs())
          throw new Error('現在は新しい成果物を作成できません。入力・権限を確認してください。');
        const artifact = makeArtifact(
          'file',
          host.records.filter((record) => record.kind === 'file').length + 1,
        );
        artifact.name = source.name;
        artifact.draft.content = source;
        const stored = await storage.putIfAbsent(artifact);
        host.sessions.current.set(stored.id, createLocalSession(stored.draft.content));
        host.persist(stored);
        host.activate(stored.id);
      }}
      onRemapAnnotation={(id, fileId, region) => {
        if (readOnly) return;
        const latest = latestRecord(host)!;
        if (
          !isFile(latest.draft.content) ||
          latest.draft.content.id !== fileId ||
          !host.selection.addresses.some(
            (address) =>
              address.elementId === fileId &&
              canonicalJson(address.region) === canonicalJson(region),
          )
        ) {
          host.setError('現在の原本で対象を選び直してください。');
          return;
        }
        try {
          host.persist({
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
          host.setError(String(error instanceof Error ? error.message : error));
        }
      }}
      readOnly={readOnly || !!host.sharedSession}
      execute={host.execute}
      select={host.select}
      annotations={active.annotations}
      focusAddress={host.revealAddress}
    />
  );
}

/** Registers a Design frame as a new native React UI artifact linked to its source. */
function registerGeneratedReact(
  host: SurfaceHost,
  source: Parameters<typeof convertDesignToReact>[0],
) {
  if (host.readOnly || host.sharedSession || !host.flushInputs())
    throw new Error('Register from a writable local Design artifact with confirmed inputs');
  const document = registerReferenceNative(source);
  if (host.execute(retainDesignPublications(convertDesignToReact(source))) === false)
    throw new Error('Native publication was rejected');
  const artifact = makeArtifact(
    'react-ui',
    host.records.filter((r) => r.kind === 'react-ui').length + 1,
  );
  artifact.draft.content = document;
  artifact.designReactConversion = {
    sourceArtifactId: host.active.id,
    sourceHash: designReactSourceHash(source),
    basis: clone(document),
  };
  host.sessions.current.set(artifact.id, createLocalSession(document));
  host.persist(artifact);
  host.activate(artifact.id);
}

type DesignProps = ComponentProps<typeof DesignReactSurface>;

/** Applies a reviewed regeneration only while source and target still match that review. */
function applyReactRegeneration(
  host: SurfaceHost,
  ...[id, sourceHash, review]: Parameters<NonNullable<DesignProps['applyRegeneration']>>
) {
  const { active } = host;
  if (host.readOnly || host.sharedSession)
    throw new Error(
      'Apply regeneration from a writable local artifact; shared targets require their authority session',
    );
  const target = latestRecord(host, id);
  if (
    !target?.designReactConversion ||
    reuseHash(target.designReactConversion.basis) !== review.from ||
    target.designReactConversion.sourceArtifactId !== active.id ||
    !isDesign(active.draft.content) ||
    designReactSourceHash(active.draft.content) !== sourceHash
  )
    throw new Error('Conversion source/target changed after review');
  const next = convertDesignToReact(active.draft.content);
  if (next.diagnostics.length) throw new Error('Resolve native conversion diagnostics first');
  registerReferenceNative(active.draft.content);
  host.execute(retainDesignPublications(next));
  const targetSession = host.sessions.current.get(id)!;
  const result = targetSession.executeView(
    applyDesignReactDocumentRegeneration(review) as EditorCommand<Content>,
  );
  host.persist({
    ...editedDraft(target, result),
    designReactConversion: {
      sourceArtifactId: active.id,
      sourceHash,
      basis: clone(next.document),
    },
  });
}

function DesignHost({
  host,
  content,
}: {
  host: SurfaceHost;
  content: NonNullable<RenderedContent['design']>;
}) {
  const { active, readOnly, sharedSession } = host;
  const latest = useRef(host);
  latest.current = host;
  const [workspaceChoice, setWorkspaceChoice] = useState<{
    id: string;
    workspace: 'design' | 'manga';
  }>();
  const workspace =
    workspaceChoice?.id === active.id ? workspaceChoice.workspace : readMangaWorkspace(active.id);
  const [inkFocus, setInkFocus] = useState<{ artifactId: string; id: string }>();
  const inkTools = useRef<DesignInkToolsControl>(null);
  const [rasterSelection, setRasterSelection] = useState<
    import('./design-ink-proposal').InkContext['rasterSelection'] & { artifactId: string }
  >();
  return (
    <div className="playground-design-workspace">
      {!host.shared && (
        <DesignInkTools
          control={inkTools}
          key={active.id}
          host={host}
          rasterSelection={rasterSelection}
          onChoose={(id) => setInkFocus({ artifactId: active.id, id })}
        />
      )}
      {!host.shared && MangaArtTools && (
        <Suspense fallback={<p role="status">作画サンプルを読み込み中です。</p>}>
          <MangaArtTools key={active.id} host={host} />
        </Suspense>
      )}
      <MemoDesignSurface
        extension={
          !host.shared
            ? {
                toolbar: () => (
                  <button
                    className="design-ink-open"
                    onClick={(event) => inkTools.current?.open(event.currentTarget)}
                  >
                    作画ツールを開く
                  </button>
                ),
              }
            : undefined
        }
        workspace={workspace}
        onWorkspaceRequest={(workspace) => {
          setWorkspaceChoice({ id: active.id, workspace });
          writeMangaWorkspace(active.id, workspace);
        }}
        pageReview={host.shared ? undefined : designPageReviewHost(latest, active.id)}
        mangaReadOnlyReason={
          host.shared ? '共有セッションでは漫画のページ編集に対応していません。' : undefined
        }
        inkInput={!host.shared}
        rasterInput={!host.shared}
        onRasterSelection={(selection) =>
          setRasterSelection({ ...selection, artifactId: active.id })
        }
        focusRequest={inkFocus?.artifactId === active.id ? inkFocus : undefined}
        references={sharedSession ? undefined : host.references}
        focusReferenceId={host.revealAddress?.elementId}
        prototype={{
          artifactId: active.id,
          annotations: active.annotations,
          onCreateAnnotation: readOnly
            ? undefined
            : async (address, body) => {
                if (!(await host.addComment({ addresses: [address] }, body)))
                  throw new Error('Comment could not be created');
              },
          onFlowComplete: (event) => {
            host.setStatus(`Prototype flow completed: ${event.flowId}`);
          },
        }}
        content={content}
        runtime={referenceRuntimeAdapter}
        revisions={[
          { component: referenceTextRevision, propMap: { text: 'content' }, slotMap: {} },
        ]}
        registerGenerated={(source) => registerGeneratedReact(host, source)}
        regenerationTargets={host.records
          .filter(
            (record) =>
              record.kind === 'react-ui' &&
              record.designReactConversion?.sourceArtifactId === active.id,
          )
          .map((record) => ({
            id: record.id,
            name: record.name,
            basis: record.designReactConversion!.basis,
            document: record.draft.content as ReactUiDocument,
          }))}
        applyRegeneration={(...args) => applyReactRegeneration(host, ...args)}
        registrations={referenceDesignSettings.registrations}
        settings={referenceDesignSettings}
        publicationReadOnlyReason={
          sharedSession
            ? '共有Hostはnative React公開設定を受け付けません。編集可能なローカル成果物で設定してください。'
            : undefined
        }
        readOnly={readOnly || (host.shared && workspace === 'manga')}
        execute={host.execute}
        select={host.select}
      />
    </div>
  );
}

function SlideHost({
  host,
  content,
}: {
  host: SurfaceHost;
  content: NonNullable<RenderedContent['slide']>;
}) {
  const { sharedSession, revealAddress } = host;
  return (
    <SlideSurface
      animationSources={
        !sharedSession ? slideAnimationSources([...host.savedRecords.current.values()]) : undefined
      }
      openAnimation={
        !sharedSession
          ? (source, objectId, pageId) => {
              const original = latestRecord(host, source.artifactId);
              if (
                !original ||
                original.kind !== 'animation' ||
                host.loadErrors[original.id] ||
                !host.sessions.current.has(original.id)
              )
                throw Error(
                  '元の Animation が見つかりません。保持した版のプレビューは利用できます。',
                );
              if (host.referenceNavigation.current(source.artifactId, objectId, pageId))
                host.setRevealAddress({
                  artifactId: source.artifactId,
                  elementId: source.compositionId,
                });
            }
          : undefined
      }
      references={sharedSession ? undefined : host.references}
      focusReferenceId={revealAddress?.elementId}
      focusAddress={revealAddress}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      dataSnapshots={slideDataSnapshots(host.records)}
    />
  );
}

/** `?react-ui-exports=none` or a comma list (`tsx,composition`) stands in for a Host
 * without every export destination (#801). Absent, every export is shown. */
function playgroundReactUiExports(): false | ReactUiExportKind[] | undefined {
  const value = new URLSearchParams(location.search).get('react-ui-exports');
  if (value === null) return undefined;
  if (value === 'none') return false;
  return value
    .split(',')
    .filter((kind): kind is ReactUiExportKind => reactUiExportKinds.includes(kind as never));
}
function ReactUiHost({ host, content }: { host: SurfaceHost; content: ReactUiDocument }) {
  const exports = useMemo(playgroundReactUiExports, []);
  return (
    <ReactUiSurface
      exports={exports}
      screenReferences={[
        { namespace: 'reference-host', screenId: host.active.id, stateId: 'draft' },
      ]}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      runtime={referenceRegisteredRuntimeAdapter}
      examples={referenceReactExamples}
      revisions={[
        { component: referenceTextRevision, propMap: { text: 'content' }, slotMap: {} },
        { environment: referenceEnvironmentRevision, propMap: {}, slotMap: {} },
      ]}
      beforeExport={host.exportGuard}
    />
  );
}

function DocumentHost({
  host,
  content,
}: {
  host: SurfaceHost;
  content: NonNullable<RenderedContent['document']>;
}) {
  const { active, sharedSession, sharedPreview, revealAddress } = host;
  const novel = useNovel(host);
  return (
    <DocumentSurface
      {...novel}
      references={sharedSession ? undefined : host.references}
      focusReferenceId={revealAddress?.elementId}
      textEngine={sharedPreview ? undefined : sharedSession?.text('text')}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      annotations={active.annotations}
      focusAddress={revealAddress}
    />
  );
}

/** Novel demo chapters open in the novel workspace; ordinary Documents keep their chrome. */
function useNovel(host: SurfaceHost): Partial<ComponentProps<typeof DocumentSurface>> {
  const { active, records } = host;
  const chapterIds = host.shared ? undefined : readNovelChapters(active.id);
  const [choice, setChoice] = useState<{ id: string; workspace: 'document' | 'novel' }>();
  const workspace = choice?.id === active.id ? choice.workspace : readNovelWorkspace(active.id);
  // The character goal is Host view state per chapter, like the workspace choice.
  const [goalChoice, setGoalChoice] = useState<{ id: string; goal: number | undefined }>();
  const goal = goalChoice?.id === active.id ? goalChoice.goal : readNovelGoal(active.id);
  // 通読 composes the saved version of every chapter in the Host's order; drafts stay out.
  const chapters = chapterIds?.map((id) => records.find((r) => r.id === id));
  const savedKey = chapters?.map((c) => `${c?.id}@${c?.draft.baseVersionId}`).join(',');
  const [reading, setReading] = useState<{
    key: string;
    content?: DocumentContent;
    problem?: string;
  }>();
  useEffect(() => {
    if (!chapters || !savedKey || workspace !== 'novel') return;
    let live = true;
    const missing = chapters.findIndex((c) => !c?.draft.baseVersionId);
    if (missing >= 0) {
      setReading({
        key: savedKey,
        problem: `通読を作れません: 第${missing + 1}章が見つからないか、保存されていません。`,
      });
      return;
    }
    composeDocumentSequence(
      chapters.map((c) => ({
        artifact: c as import('@editor-platform/artifact-core').Artifact<DocumentContent>,
        versionId: c!.draft.baseVersionId!,
      })),
      { references: host.references },
    ).then(
      (result) =>
        live &&
        setReading(
          result.content
            ? { key: savedKey, content: result.content }
            : {
                key: savedKey,
                problem: `通読を作れません: ${result.manifest.diagnostics
                  .filter((d) => d.severity === 'error')
                  .map((d) => d.message)
                  .join(' / ')}`,
              },
        ),
      (error) => live && setReading({ key: savedKey, problem: `通読を作れません: ${error}` }),
    );
    return () => {
      live = false;
    };
    // savedKey names every input that changes the read-through.
  }, [savedKey, workspace, host.references]);
  if (!chapterIds) return {};
  const current = reading?.key === savedKey ? reading : undefined;
  return {
    workspace,
    onWorkspaceRequest: (next) => {
      setChoice({ id: active.id, workspace: next });
      writeNovelWorkspace(active.id, next);
    },
    novel: {
      notationRules: novelNotationRules,
      goal,
      onGoalChange: (next) => {
        setGoalChoice({ id: active.id, goal: next });
        writeNovelGoal(active.id, next);
      },
      ...(current?.content
        ? {
            reading: {
              content: current.content,
              label: `保存した${chapterIds.length}章を章順に結合した通読です。`,
            },
          }
        : { readingUnavailable: current?.problem ?? '通読を準備しています。' }),
      onNotationProposal: ({ command, findings }) => {
        const session = host.sessions.current.get(active.id);
        if (!session || !active.draft.baseVersionId || !host.flushInputs()) return;
        host.reviewProposal({
          id: crypto.randomUUID(),
          baseLocalRevision: session.revision,
          reads: {
            target: { artifactId: active.id, versionId: active.draft.baseVersionId },
            references: [],
          },
          source: 'Playground notation dictionary',
          summary: `表記の直し（${findings.length}件）`,
          commands: [command as EditorCommand<Content>],
        });
      },
    },
  };
}

function ModelSurfaces({ host, rendered }: { host: SurfaceHost; rendered: RenderedContent }) {
  const { active, session, sharedSession, sharedPreview, readOnly } = host;
  const selectedId = host.selection.addresses[0]?.elementId;
  return (
    <>
      {rendered.estimate && !sharedSession && session && (
        <PlaygroundEstimate key={active.id} host={host} />
      )}
      {rendered.analysis && !sharedSession && session && (
        <PlaygroundAnalysis key={active.id} host={host} />
      )}
      {rendered.graph && (
        <NativeGraphSurface
          key={active.id}
          content={rendered.graph}
          profile={graphProfileFor(rendered.graph) ?? relationProfile}
          sourceRevision={canonicalJson((session as EditorSession<Content>).revision)}
          execute={host.execute}
          select={host.select}
          selectedId={selectedId}
          readOnly={readOnly}
        />
      )}
      {rendered.reactUi && <ReactUiHost key={active.id} host={host} content={rendered.reactUi} />}
      {rendered.fictionMap && !sharedSession && session && (
        <PlaygroundFictionMap key={active.id} host={host} />
      )}
      {rendered.geo && !sharedSession && session && <GeoHost key={active.id} host={host} />}
      {rendered.cad && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading 3D CAD…</p>}>
          <CadHost
            key={active.id}
            artifact={active}
            session={host.sessions.current.get(active.id) as unknown as EditorSession<CadDocument>}
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            record={() => latestRecord(host)}
            persistRecord={async (record) => (await host.persist(record)) !== false}
            createRecord={async (record) => {
              // CR3e: a part made from a body is a new Artifact beside this one, not opened.
              host.sessions.current.set(record.id, createLocalSession(record.draft.content));
              return (await host.persist(record)) !== false;
            }}
            records={() => host.recordsRef.current}
            openArtifact={(id) => host.activate(id)}
          />
        </Suspense>
      )}
      {rendered.bim && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Building…</p>}>
          <BimHost
            key={active.id}
            artifact={active}
            session={host.sessions.current.get(active.id) as unknown as EditorSession<BimDocument>}
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            record={() => latestRecord(host)}
            persistRecord={async (record) => (await host.persist(record)) !== false}
            records={() => host.recordsRef.current}
          />
        </Suspense>
      )}
      {rendered.character && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Character…</p>}>
          <CharacterHost
            key={active.id}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<CharacterDocument>
            }
            readOnly={readOnly}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            record={() => latestRecord(host)}
            persistRecord={async (record) => (await host.persist(record)) !== false}
            records={() => host.recordsRef.current}
            history={host.history}
          />
        </Suspense>
      )}
      {rendered.simulation && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Structural analysis…</p>}>
          <SimulationHost
            key={active.id}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<SimulationDocument>
            }
            readOnly={readOnly}
            inputs={host.inputs}
            record={() => latestRecord(host)}
            records={() => host.recordsRef.current}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            persistRecord={async (record) => (await host.persist(record)) !== false}
          />
        </Suspense>
      )}
      {rendered.construction && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Construction schedule…</p>}>
          <ConstructionHost
            key={active.id}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<ConstructionDocument>
            }
            readOnly={readOnly}
            inputs={host.inputs}
            record={() => latestRecord(host)}
            records={() => host.recordsRef.current}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            persistRecord={async (record) => (await host.persist(record)) !== false}
          />
        </Suspense>
      )}
      {rendered.pcb && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Circuit board…</p>}>
          <PcbHost
            key={active.id}
            artifact={active}
            session={host.sessions.current.get(active.id) as unknown as EditorSession<PcbDocument>}
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
            records={() => host.recordsRef.current}
          />
        </Suspense>
      )}
      {rendered.schematic && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Schematic…</p>}>
          <SchematicHost
            key={active.id}
            artifact={active}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<SchematicDocument>
            }
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
          />
        </Suspense>
      )}
      {rendered.ladder && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Ladder…</p>}>
          <LadderHost
            key={active.id}
            artifact={active}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<LadderDocument>
            }
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
          />
        </Suspense>
      )}
      {rendered.cosim && !sharedSession && session && (
        <Suspense fallback={<p className="empty-state">Loading Co-simulation…</p>}>
          <CosimHost
            key={active.id}
            artifact={active}
            records={() => host.recordsRef.current}
            session={
              host.sessions.current.get(active.id) as unknown as EditorSession<CosimDocument>
            }
            readOnly={readOnly}
            inputs={host.inputs}
            persist={(content) => {
              const latest = latestRecord(host);
              if (latest) host.persist(editedDraft(latest, content));
            }}
          />
        </Suspense>
      )}
      {rendered.animation && (sharedSession || session) && (
        <AnimationHost key={active.id} host={host} content={rendered.animation} />
      )}
      {rendered.document && (
        <DocumentHost
          key={
            sharedPreview ? `preview:${sharedPreview.id}:${sharedPreview.preview.token}` : active.id
          }
          host={host}
          content={rendered.document}
        />
      )}
    </>
  );
}

function CanvasSurfaces({ host, rendered }: { host: SurfaceHost; rendered: RenderedContent }) {
  const { active, sharedSession, readOnly, revealAddress } = host;
  const references = sharedSession ? undefined : host.references;
  return (
    <>
      {' '}
      {rendered.data && <DataHost key={active.id} host={host} content={rendered.data} />}{' '}
      {rendered.schedule && (
        <ScheduleHost key={active.id} host={host} content={rendered.schedule} />
      )}{' '}
      {rendered.review && <ReviewHost key={active.id} host={host} content={rendered.review} />}{' '}
      {rendered.file && <FileHost key={active.id} host={host} content={rendered.file} />}{' '}
      {rendered.whiteboard && (
        <MemoWhiteboardSurface
          references={references}
          focusReferenceId={revealAddress?.elementId}
          key={active.id}
          layout={host.whiteboardLayout}
          content={rendered.whiteboard}
          readOnly={readOnly}
          execute={host.execute}
          select={host.select}
        />
      )}{' '}
      {rendered.design && <DesignHost key={active.id} host={host} content={rendered.design} />}{' '}
      {rendered.slide && <SlideHost key={active.id} host={host} content={rendered.slide} />}
    </>
  );
}

/** The editor view: exactly one native surface renders for the validated content. */
export function EditorSurfaces({
  host,
  rendered,
}: {
  host: SurfaceHost;
  rendered: RenderedContent;
}) {
  return (
    <>
      <ModelSurfaces host={host} rendered={rendered} />
      <CanvasSurfaces host={host} rendered={rendered} />
    </>
  );
}
