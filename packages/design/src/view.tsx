import { MangaReading } from './manga-reading';
import { MangaSplitOverlay } from './manga-split';
import type { DesignDivisionOperation } from './division';
import { MangaReview, type DesignPageReviewHost } from './manga-review';
export type { DesignPageReviewHost } from './manga-review';
import { MangaPanel } from './manga-panel';
import { mangaEditingContext } from './manga-context';
import { mangaDialoguePlacement } from './manga-dialogue';
import { MangaBoundaryOverlay } from './manga-boundaries';
import { useDesignWorkspace, type DesignWorkspaceProps } from './workspace';
export type { DesignWorkspace, DesignWorkspaceTransition } from './workspace';
import { DesignPagePanel } from './page-panel';
import { designExportPaintBounds } from './paint-bounds';
import { designPathPoint } from './path';
import { useDesignPathEditor } from './path-editor';
import { useDesignStrokeInput } from './stroke-input';
import { designStrokeParent } from './stroke-path';
import { insertDesignPath, presetDesignPath } from './path-commands';
import { guardDesignCommand } from './model';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { assertReferenceItems } from '@editor-platform/artifact-references';
import {
  ReferenceTools,
  useReferenceItems,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { memo, useContext, useMemo, useImperativeHandle, type Ref, type ReactNode } from 'react';
import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import { ComponentPublicationDialog } from './component-publication-ui';
import { DesignInspector, type FramePresetRequest } from './view-inspector';
import {
  collectScopedTexts,
  exportDesignGraphics,
  DesignExportMenu,
  DesignNavigator,
  FramePresetDialog,
  instanceTextKey,
  designCanvasTargets,
  scopedTextChanged,
  targetDrawings,
} from './view-panels';
import { DesignPrototypeSurface, type DesignPrototypeSurfaceProps } from './prototype-view';
import { useEffect, useRef, useState } from 'react';
import { DesignRasterControls, type DesignRasterSelection } from './raster-editor';
export type { DesignRasterSelection } from './raster-editor';
import { Frame, Component, Scan } from 'lucide-react';
import { clone, newId, isDeepFrozen, deepFreeze } from '@editor-platform/artifact-core';
import {
  command,
  EditorInputs,
  descendantIds,
  unionBounds,
  type Bounds,
  type EditorCommand,
  type Region,
  type ShapeKind,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Dialog,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  CanvasStage,
  CanvasControls,
  DrawingView,
  initialCanvasView,
  InsertTools,
  ArrangeMenu,
  EditMenu,
  readImage,
  type CanvasView,
  type CanvasTarget,
} from '@editor-platform/canvas-ui';
import {
  alignElements,
  arrangeDesign,
  createComponent,
  designPreview,
  designPaintOrder,
  remapDesignElements,
  layoutDesign,
  makeDesignElement,
  overrideInstance,
  patchDesign,
  transformElements,
  type DesignContent,
  type DesignDrawing,
  type DesignElement,
  type DesignElementType,
} from './model';
import { createDesignRenderCache, designRenderSnapshot } from './render-cache';
const DesignDrawings = memo(function DesignDrawings({
  drawings,
  textParts = [],
}: {
  drawings: DesignDrawing[];
  textParts?: CanvasTarget['textParts'];
}) {
  return (
    <>
      {drawings.map((drawing, index) => (
        <g
          key={`${drawing.id}-${index}`}
          pointerEvents={drawing.panelBorderOf ? 'none' : undefined}
          data-canvas-text-target={
            textParts.find((p) => p.drawingId === instanceTextKey(drawing))?.id
          }
        >
          <DrawingView drawing={drawing} />
        </g>
      ))}
    </>
  );
});

export interface DesignExtensionContext {
  selected: string[];
  element?: DesignElement;
  apply(command: EditorCommand<DesignContent>): void;
  choose(ids: string[]): void;
}
export interface DesignSurfaceExtension {
  /** Host navigation remains usable while native edit fields are readonly. */
  workspaceReferences?(context: DesignExtensionContext): ReactNode;
  publicationDiagnostics?(
    candidate: DesignContent,
    componentId: string,
  ): { code: string; path: string; message: string }[];
  library?(context: DesignExtensionContext): ReactNode;
  inspector?(context: DesignExtensionContext): ReactNode;
  toolbar?(context: DesignExtensionContext): ReactNode;
  render?(element: DesignElement, bounds: Bounds): ReactNode;
  beforeGraphicExport?(ids: string[]): void;
  /** An opaque Host element paints its slot subtree once; the native tree stays editable. */
  canvasOwner?(element: DesignElement): string | undefined;
}
export interface DesignSurfaceProps extends ReferenceSurfaceProps, DesignWorkspaceProps {
  /** Opt-in uniform-width native stroke input. Pressure/eraser/brush engines are not provided. */
  inkInput?: boolean;
  pageReview?: DesignPageReviewHost;
  mangaReadOnlyReason?: string;
  /** Opt-in local embedded-PNG pixel editing. No pressure/shared raster engine. */
  rasterInput?: boolean;
  onRasterSelection?(selection: DesignRasterSelection): void;
  prototype?: Omit<DesignPrototypeSurfaceProps, 'content' | 'onClose'>;
  extension?: DesignSurfaceExtension;
  content: DesignContent;
  execute: (c: EditorCommand<DesignContent>) => void | boolean;
  publicationRequest?: string;
  focusRequest?: { id: string };
  publicationReadOnlyReason?: string;
  onPublicationClosed?: () => void;
  select: (ids: string[], region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
}
export function DesignSurface(props: DesignSurfaceProps) {
  // A Host render is a revision boundary even if it mutates the same input object.
  // Local camera/panel state lives below this boundary and retains that snapshot.
  const renderContent = isDeepFrozen(props.content)
    ? props.content
    : deepFreeze(clone(props.content));
  const hostInputs = useContext(EditorInputsContext);
  const ownInputs = useMemo(() => new EditorInputs(), []);
  return (
    <EditorInputsContext.Provider value={hostInputs ?? ownInputs}>
      <DesignSurfaceEditor {...props} renderContent={renderContent} />
    </EditorInputsContext.Provider>
  );
}
function DesignSurfaceEditor({
  pageReview,
  mangaReadOnlyReason,
  workspace,
  onWorkspaceRequest,
  onWorkspaceTransition,
  inkInput = false,
  rasterInput = false,
  onRasterSelection,
  references,
  focusReferenceId,
  content,
  execute,
  select,
  readOnly = false,
  layout,
  extension,
  publicationRequest,
  focusRequest,
  publicationReadOnlyReason,
  onPublicationClosed,
  prototype,
  renderContent,
}: DesignSurfaceProps & { renderContent: DesignContent }) {
  // Structured paths allow projected coordinates up to 1e12, beyond the
  // ordinary infinite canvas range. Keep camera controls and fitting consistent.
  const minZoom = content.schemaVersion >= 3 ? 1e-12 : 0.001;
  const prototypeControl = useRef<{ open(): void }>(null);
  const projectedElements = useReferenceItems(content.elements, references);
  const projectedById = new Map(projectedElements.map((e) => [e.id, e]));
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext)!;
  const work = useDesignWorkspace({ workspace, onWorkspaceRequest, onWorkspaceTransition }, inputs);
  const [divisionPreview, setDivisionPreview] = useState<DesignContent>();
  const [divisionReviewPending, setDivisionReviewPending] = useState(false);
  const [reading, setReading] = useState<{ mode: 'spread' | 'all'; pageId: string }>();
  const [drawSplit, setDrawSplit] = useState(false);
  useEffect(() => setDrawSplit(false), [work.displayed, readOnly]);
  const [splitRequest, setSplitRequest] = useState<{
    op: DesignDivisionOperation;
    base: DesignContent;
  }>();
  const displayContent =
    work.displayed === 'manga' ? (divisionPreview ?? renderContent) : renderContent;
  const previewReadOnly = readOnly || (work.displayed === 'manga' && divisionReviewPending);
  const displayElements = new Map(displayContent.elements.map((e) => [e.id, e]));
  const [publication, setPublication] = useState<string>();
  useEffect(() => {
    if (publicationRequest) setPublication(publicationRequest);
  }, [publicationRequest]);
  const renderCache = useMemo(createDesignRenderCache, []);
  const project = useMemo(
    () => designRenderSnapshot(displayContent, renderCache),
    [displayContent, renderCache],
  );
  const projectPointEdit = useMemo(() => {
    const visible = new Set(
      designPaintOrder(renderContent)
        .filter((e) => !e.hidden)
        .map((e) => e.id),
    );
    return (e: DesignElement) => (visible.has(e.id) ? project(e) : []);
  }, [renderContent, project]);
  const scopedTexts = useMemo(() => collectScopedTexts(content, project), [content, project]);
  const [selected, setSelected] = useState<string[]>([]),
    [view, setView] = useState<CanvasView>(initialCanvasView),
    [error, setError] = useState(''),
    [reference, setReference] = useState('selection'),
    [tab, setTab] = useState('layers'),
    [definition, setDefinition] = useState(false),
    [padding, setPadding] = useState(20),
    [transparent, setTransparent] = useState(true),
    [scale, setScale] = useState(1);
  const [preset, setPreset] = useState<FramePresetRequest>();
  const clipboard = useRef<DesignElement[]>([]),
    viewport = useRef<HTMLDivElement>(null);
  const ids = selected.filter((id) => content.elements.some((e) => e.id === id)),
    chosen = content.elements.filter((e) => ids.includes(e.id)),
    element = chosen.length === 1 ? chosen[0] : undefined;
  const [mangaPageId, setMangaPageId] = useState<string>();
  const mangaContext = useMemo(
    () => mangaEditingContext(renderContent, selected, mangaPageId),
    [renderContent, selected, mangaPageId],
  );
  const mangaParent = mangaContext.panel ?? mangaContext.frame;
  const mangaDialogue = mangaParent && mangaDialoguePlacement(mangaParent);
  useEffect(() => setMangaPageId(mangaContext.page?.frameId), [mangaContext.page?.frameId]);
  useEffect(() => {
    if (focusReferenceId) choose([focusReferenceId]);
  }, [focusReferenceId]);
  const exportState = useRef({ content, ids, padding, transparent, scale, extension, references });
  exportState.current = { content, ids, padding, transparent, scale, extension, references };
  const writableRef = useRef(!readOnly);
  writableRef.current = !readOnly;
  const pointBusy = useRef<() => boolean>(() => false);
  const apply = (cmd: EditorCommand<DesignContent>) => {
    if (readOnly) return false;
    if (pointBusy.current()) {
      setError('Finish or cancel the path gesture first');
      return false;
    }
    const checked: EditorCommand<DesignContent> = {
      ...cmd,
      apply(current) {
        const next = guardDesignCommand(cmd, () => writableRef.current).apply(current);
        assertReferenceItems(next.elements);
        return next;
      },
    };
    try {
      if (!checked.readonlyInput) checked.apply(content);
      if (execute(checked) === false) return false;
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const pathEditor = useDesignPathEditor({
    content: renderContent,
    element: element && renderContent.elements.find((e) => e.id === element.id),
    readOnly,
    zoom: view.zoom,
    project: projectPointEdit,
    apply,
    error: setError,
    fit: () => {
      if (!element?.path) return false;
      const drawing = projectPointEdit(element)[0],
        rect = viewport.current?.getBoundingClientRect();
      if (!drawing) {
        setError('Show the path and its parent frames before editing points.');
        return false;
      }
      if (!rect) return false;
      const points = element.path.subpaths
        .flatMap((s) => [
          ...s.anchors,
          ...s.segments.flatMap((e) => (e.type === 'cubic' ? [e.c1, e.c2] : [])),
        ])
        .map((p) => designPathPoint(element.path!, drawing, p));
      const box = unionBounds(points.map((p) => ({ ...p, width: 1, height: 1 })));
      const zoom = Math.max(
        minZoom,
        Math.min(
          8,
          (rect.width - 80) / Math.max(1, box.width),
          (rect.height - 80) / Math.max(1, box.height),
        ),
      );
      setView((v) => ({
        ...v,
        fit: false,
        zoom,
        pan: {
          x: rect.width / 2 - (box.x + box.width / 2) * zoom,
          y: rect.height / 2 - (box.y + box.height / 2) * zoom,
        },
      }));
      return true;
    },
  });
  const strokeInput = useDesignStrokeInput({
    enabled: inkInput,
    readOnly,
    blocked: pathEditor.editing,
    content: renderContent,
    zoom: view.zoom,
    parentId: designStrokeParent(content, element?.id),
    apply,
    created: (id) => choose([id]),
    error: setError,
  });
  pointBusy.current = () => pathEditor.busy() || strokeInput.busy();
  const choose = (ids: string[]) => {
    if (
      pathEditor.editing &&
      (ids.length !== selected.length || ids.some((id, i) => id !== selected[i])) &&
      !pathEditor.settle()
    )
      return;
    setSelected(ids);
    select(ids);
    setDefinition(false);
  };
  useEffect(() => {
    if (focusRequest && content.elements.some((element) => element.id === focusRequest.id)) {
      choose([focusRequest.id]);
    }
  }, [focusRequest, select]);
  function add(
    type: DesignElementType,
    patch: Partial<DesignElement> = {},
    mangaOwner?: DesignElement,
  ) {
    const parent = mangaOwner ?? (element?.type === 'frame' ? element : undefined);
    const rect = viewport.current?.getBoundingClientRect();
    const center = {
      x: rect ? (rect.width / 2 - view.pan.x) / view.zoom : 450,
      y: rect ? (rect.height / 2 - view.pan.y) / view.zoom : 280,
    };
    const item = { ...makeDesignElement(type, content.elements.length), ...patch };
    if (!patch.bounds)
      item.bounds = {
        ...item.bounds,
        x: parent ? parent.bounds.x + 24 : center.x - item.bounds.width / 2,
        y: parent ? parent.bounds.y + 24 : center.y - item.bounds.height / 2,
      };
    if (parent) item.parentId = parent.id;
    apply(
      command('design.insert', `Insert ${type}`, (d) =>
        layoutDesign({ ...d, elements: [...d.elements, item] }),
      ),
    );
    choose([item.id]);
  }
  async function image(file: File) {
    try {
      add('image', { src: await readImage(file), alt: file.name });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function action(a: string, value?: number) {
    if (content.pagination && ['copy', 'cut', 'paste'].includes(a)) {
      setError(
        'Element copy/cut/paste is not supported for paginated Design. Use Duplicate to preserve page reading order and image sources.',
      );
      return;
    }
    if (a === 'copy' || a === 'cut') {
      const all = descendantIds(content.elements, ids);
      clipboard.current = clone(content.elements.filter((e) => all.has(e.id)));
      if (a === 'cut') {
        try {
          // Prove that a valid remapped replacement fits before deleting the source.
          const removed = arrangeDesign(ids, 'delete').apply(content);
          const restored = {
            ...removed,
            elements: [...removed.elements, ...remapDesignElements(clipboard.current)],
          };
          guardDesignCommand(
            command('design.clipboard.preflight', 'Clipboard preflight', () => restored),
          ).apply(content);
          apply(arrangeDesign(ids, 'delete'));
        } catch (e) {
          setError((e as Error).message);
        }
      }
      return;
    }
    if (a === 'paste') {
      if (!clipboard.current.length) {
        setError('Copy elements in this editor first');
        return;
      }
      const duplicates = remapDesignElements(clipboard.current);
      apply(
        command('design.paste', 'Paste elements', (d) => ({
          ...d,
          schemaVersion:
            d.schemaVersion === 4 ? 4 : duplicates.some((e) => e.path) ? 3 : d.schemaVersion,
          elements: [...d.elements, ...duplicates],
        })),
      );
      choose(duplicates.filter((e) => !e.parentId).map((e) => e.id));
      return;
    }
    apply(arrangeDesign(ids, a, value));
  }
  function geometry(patch: Partial<Bounds>) {
    const box = unionBounds(chosen.map((e) => e.bounds));
    apply(
      transformElements(ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  }
  function fit(nextIds?: string[]) {
    const visibleElements = designPaintOrder(content).filter((e) => !extension?.canvasOwner?.(e));
    const roots = nextIds?.map((id) => {
      const element = content.elements.find((e) => e.id === id);
      return (element && extension?.canvasOwner?.(element)) || id;
    });
    const all = roots?.length
      ? descendantIds(visibleElements, roots)
      : new Set(visibleElements.map((e) => e.id));
    const box = unionBounds(
      visibleElements
        .filter((e) => all.has(e.id) && !e.hidden)
        .map((e) =>
          e.path ? designExportPaintBounds(project(e), e.bounds, e.rotation) : e.bounds,
        ),
    );
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.min((rect.width - 60) / box.width, (rect.height - 60) / box.height);
    setView({
      ...view,
      fit: !nextIds?.length,
      zoom: Math.max(minZoom, Math.min(8, zoom)),
      pan: {
        x: (rect.width - box.width * zoom) / 2 - box.x * zoom,
        y: (rect.height - box.height * zoom) / 2 - box.y * zoom,
      },
    });
  }
  async function output(format: 'svg' | 'png', scope: string) {
    try {
      guardExport?.();
      await exportDesignGraphics(format, scope, exportState, references, inputs);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const extensionContext = { selected: ids, element, apply, choose };
  const canvasOwners = new Map(content.elements.map((e) => [e.id, extension?.canvasOwner?.(e)]));
  const canvasSelection = [...new Set(ids.map((id) => canvasOwners.get(id) ?? id))];
  const inspector = (
    <>
      <div>{pathEditor.controls}</div>
      <DesignRasterControls
        enabled={rasterInput}
        content={renderContent}
        element={element}
        readOnly={readOnly}
        apply={apply}
        onSelection={onRasterSelection}
      />
      <DesignInspector
        manga={work.displayed === 'manga'}
        references={references}
        content={content}
        element={element}
        chosen={chosen}
        ids={ids}
        readOnly={previewReadOnly}
        apply={apply}
        geometry={geometry}
        setError={setError}
        extension={extension}
        extensionContext={extensionContext}
        setPreset={setPreset}
        definition={definition}
        setDefinition={setDefinition}
      />
    </>
  );
  const toolbar = (
    <>
      {strokeInput.controls}
      <ReferenceTools
        identity={ids.join(',')}
        resolver={references}
        readOnly={readOnly}
        insert={(reference, src, label) =>
          add('image', {
            reference,
            src,
            alt: label,
            imageFit: 'fit',
            bounds: { x: 80, y: 140, width: 700, height: 320 },
          })
        }
      />
      {(['line', 'cubic'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          disabled={readOnly}
          onClick={() => {
            const rect = viewport.current?.getBoundingClientRect();
            const path = presetDesignPath(kind);
            const parent = element?.type === 'frame' ? element : undefined;
            const insetX = parent ? Math.min(24, parent.bounds.width / 4) : 0;
            const insetY = parent ? Math.min(24, parent.bounds.height / 4) : 0;
            const width = parent
              ? Math.min(path.frame.width, parent.bounds.width - 2 * insetX)
              : path.frame.width;
            const height = parent
              ? Math.min(path.frame.height, parent.bounds.height - 2 * insetY)
              : path.frame.height;
            const insert = insertDesignPath(
              path,
              {
                x: parent
                  ? parent.bounds.x + insetX
                  : ((rect?.width ?? 800) / 2 - view.pan.x) / view.zoom - width / 2,
                y: parent
                  ? parent.bounds.y + insetY
                  : ((rect?.height ?? 600) / 2 - view.pan.y) / view.zoom - height / 2,
                width,
                height,
              },
              parent?.id,
              () => writableRef.current,
            );
            if (apply(insert)) choose([insert.elementId]);
          }}
        >
          Add {kind} path
        </button>
      ))}
      <InsertTools
        onShape={(shape: ShapeKind) => add('shape', { shape, text: '' })}
        onText={() => add('text')}
        onImage={(f) => void image(f)}
        readOnly={readOnly}
      />
      <IconButton icon={Frame} label="Add frame" onClick={() => add('frame')} disabled={readOnly} />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={action}
        onAlign={(mode) => {
          const parent = content.elements.find((e) => e.id === chosen[0]?.parentId);
          if (reference === 'page' && !parent) {
            setError('Select objects in a frame to align to a parent');
            return;
          }
          apply(alignElements(ids, mode, reference === 'page' ? parent?.bounds : undefined));
        }}
        reference={reference}
        onReference={setReference}
      />
      <EditMenu onAction={action} readOnly={readOnly} />
      <IconButton
        icon={Component}
        label="Make component"
        disabled={!ids.length || readOnly}
        reason="Select one or more elements"
        onClick={() => {
          const componentId = newId('component');
          if (apply(createComponent(ids, componentId))) setPublication(componentId);
        }}
      />
      <DesignExportMenu
        padding={padding}
        setPadding={setPadding}
        transparent={transparent}
        setTransparent={setTransparent}
        scale={scale}
        setScale={setScale}
        output={output}
      />
    </>
  );
  const left = (
    <DesignNavigator
      content={content}
      ids={ids}
      readOnly={readOnly}
      tab={tab}
      setTab={setTab}
      choose={choose}
      fit={fit}
      apply={apply}
      setPublication={setPublication}
    />
  );
  return (
    <div className="manga-workspace" data-workspace={work.displayed} {...work.events}>
      <DesignPrototypeController
        control={prototypeControl}
        content={{ ...content, elements: projectedElements }}
        prototype={prototype}
      />
      <EditorLayout
        viewKey="design"
        leftLabel={work.displayed === 'manga' ? '漫画のページ・コマ' : 'Design navigator'}
        inspectorLabel="Design inspector"
        toolbar={
          <>
            {work.controls}
            {work.displayed === 'design' && (
              <button
                onClick={() => prototypeControl.current?.open()}
                disabled={
                  !designPaintOrder(content).some(
                    (element) => element.type === 'frame' && !element.hidden,
                  )
                }
              >
                Open prototype
              </button>
            )}
            {work.displayed === 'manga' ? (
              <>
                <button
                  disabled={previewReadOnly || !mangaDialogue}
                  title={
                    mangaParent && !mangaDialogue
                      ? '台詞を配置するにはコマを広げてください'
                      : undefined
                  }
                  onClick={() =>
                    mangaDialogue && add('text', { ...mangaDialogue, text: '台詞' }, mangaParent)
                  }
                >
                  台詞を追加
                </button>
                {strokeInput.controls}
                <button disabled={!ids.length} onClick={() => fit(ids)}>
                  選択コマを表示
                </button>
              </>
            ) : (
              toolbar
            )}
            {extension?.toolbar?.(extensionContext)}
          </>
        }
        left={
          <>
            <div hidden={work.displayed !== 'manga'}>
              <MangaPanel
                onRead={(mode, pageId) => setReading({ mode, pageId })}
                splitRequest={splitRequest}
                onDrawSplit={() => setDrawSplit(true)}
                content={renderContent}
                selected={ids}
                currentPageId={mangaContext.page?.frameId}
                readOnly={readOnly}
                apply={apply}
                choose={choose}
                fit={fit}
                preview={(value) => {
                  setDivisionPreview(value);
                  setDivisionReviewPending(!!value);
                }}
              />
            </div>
            <div hidden={work.displayed === 'manga'}>
              <DesignPagePanel
                content={content}
                apply={apply}
                choose={choose}
                readOnly={readOnly}
              />
              {left}
            </div>
            {extension?.library?.(extensionContext)}
          </>
        }
        inspector={
          <>
            {extension?.workspaceReferences?.(extensionContext)}
            <div hidden={work.displayed !== 'manga'}>
              <MangaReview host={pageReview} content={renderContent} />
              {mangaReadOnlyReason && <p role="status">{mangaReadOnlyReason}</p>}
            </div>
            {inspector}
          </>
        }
        status={
          <>
            <span>
              {content.elements.length} elements · {ids.length} selected
            </span>
            <IconButton
              icon={Scan}
              label="Fit selection"
              disabled={!ids.length}
              onClick={() => fit(ids)}
            />
            <span className="ep-spacer" />
            <CanvasControls
              view={view}
              onChange={setView}
              onFit={() => fit()}
              fitLabel="Fit design"
              minZoom={minZoom}
            />
          </>
        }
        {...layout}
      >
        <div ref={viewport} style={{ height: '100%', position: 'relative' }}>
          {error && (
            <div className="surface-error" role="alert">
              {error}
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}
          <CanvasStage
            virtualize
            inputOwner={pathEditor.editing || strokeInput.active || drawSplit ? 'point' : 'object'}
            onPointKeyDown={strokeInput.active ? strokeInput.keyDown : pathEditor.keyDown}
            overlay={
              <>
                {work.displayed === 'manga' &&
                  drawSplit &&
                  !readOnly &&
                  !pathEditor.editing &&
                  !strokeInput.active && (
                    <MangaSplitOverlay
                      content={renderContent}
                      selected={ids}
                      currentPageId={mangaContext.page?.frameId}
                      zoom={view.zoom}
                      preview={setDivisionPreview}
                      propose={(op) => setSplitRequest({ op, base: renderContent })}
                      cancel={() => setDrawSplit(false)}
                    />
                  )}
                {pathEditor.overlay}
                {strokeInput.overlay}
                {work.displayed === 'manga' && (
                  <MangaBoundaryOverlay
                    content={renderContent}
                    displayContent={displayContent}
                    selected={ids}
                    currentPageId={mangaContext.page?.frameId}
                    zoom={view.zoom}
                    disabled={
                      previewReadOnly || strokeInput.active || pathEditor.editing || drawSplit
                    }
                    preview={setDivisionPreview}
                    apply={apply}
                  />
                )}
              </>
            }
            label="Design canvas"
            space="infinite"
            minZoom={minZoom}
            previewTransform={(ids, delta) => designPreview(content, ids, delta)}
            hideControls
            view={view}
            onViewChange={setView}
            selected={canvasSelection}
            targets={designCanvasTargets(
              displayContent,
              project,
              canvasOwners,
              scopedTexts,
              extension,
            )}
            onSelect={choose}
            readOnly={previewReadOnly}
            onTransform={(ids, delta) => apply(transformElements(ids, delta))}
            onDelete={() => action('delete')}
            onAction={action}
            onEditText={(id, text, runs, base) => {
              const part = scopedTexts.get(id);
              if (part && base && scopedTextChanged(part, base)) {
                setError(
                  `${id}: 編集開始後に文字または書式が変更されました。未確定の入力を保持しています。`,
                );
                return false;
              }
              setError('');
              return apply(
                part
                  ? overrideInstance(part.rootId, part.partIds, { text, runs })
                  : patchDesign([id], { text, runs }),
              );
            }}
            onImage={(f) => void image(f)}
            render={(target) => {
              const raw = displayElements.get(target.id)!;
              const external = extension?.render?.(raw, target.bounds);
              if (external) return external;
              return (
                <DesignDrawings
                  drawings={targetDrawings(
                    raw,
                    target,
                    project,
                    projectedById.get(raw.id)?.src,
                  ).map(pathEditor.project)}
                  textParts={target.textParts}
                />
              );
            }}
          />
          {work.displayed === 'manga' && reading && (
            <MangaReading
              content={renderContent}
              {...reading}
              close={() => setReading(undefined)}
            />
          )}
          {publication && content.components.some((component) => component.id === publication) && (
            <ComponentPublicationDialog
              key={publication}
              content={content}
              id={publication}
              readOnly={readOnly || !!publicationReadOnlyReason}
              readOnlyReason={publicationReadOnlyReason}
              apply={apply}
              diagnostics={extension?.publicationDiagnostics}
              onClose={() => {
                setPublication(undefined);
                onPublicationClosed?.();
              }}
            />
          )}
        </div>
      </EditorLayout>
      {preset && (
        <FramePresetDialog
          preset={preset}
          content={content}
          readOnly={readOnly}
          apply={apply}
          close={() => setPreset(undefined)}
        />
      )}
    </div>
  );
}

// Keep visibility outside both the expensive Surface and the mobile toolbar menu.
// Closing that menu must not unmount an active prototype or lose its navigation.
function DesignPrototypeController({
  control,
  content,
  prototype,
}: {
  control: Ref<{ open(): void }>;
  content: DesignContent;
  prototype?: DesignSurfaceProps['prototype'];
}) {
  const [prototyping, setPrototyping] = useState(false);
  useImperativeHandle(control, () => ({ open: () => setPrototyping(true) }), []);
  return prototyping ? (
    <div
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase()))
          event.stopPropagation();
      }}
    >
      <Dialog title="Design prototype" onClose={() => setPrototyping(false)}>
        <div style={{ height: 'min(72vh, 800px)', width: 'min(660px, calc(94vw - 48px))' }}>
          <DesignPrototypeSurface
            content={content}
            {...prototype}
            onClose={() => setPrototyping(false)}
          />
        </div>
      </Dialog>
    </div>
  ) : null;
}
