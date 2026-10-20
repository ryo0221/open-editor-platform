import { assertReferenceItems } from '@editor-platform/artifact-references';
import {
  ReferenceWarnings,
  useReferenceItems,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { lazy, Suspense, useContext, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { EditorExportGuardContext, EditorInputsContext } from '@editor-platform/editor-ui';
import './styles.css';
import { flushSync } from 'react-dom';
import { FileText } from 'lucide-react';
import { deepFreeze, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import type { PlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import {
  AnimationChoiceDialog,
  AnimationPreviewDialog,
  type SlideAnimationProps,
} from './animation';
import {
  type EditorCommand,
  type ShapeKind,
  type Bounds,
  type Region,
  type ElementAddress,
} from '@editor-platform/editor-core';
import { EditorLayout, type EditorLayoutProps } from '@editor-platform/editor-ui';
import {
  CanvasStage,
  DrawingView,
  initialCanvasView,
  type CanvasView,
  type CanvasTarget,
} from '@editor-platform/canvas-ui';
import {
  updateObject,
  patchObjects,
  transformObjects,
  slidePaintOrder,
  slideDrawing,
  isDeck,
  hasSlideReuse,
  placeSlideAnimation,
  replaceSlideAnimation,
  type Slide,
  type SlideContent,
  type SlideObject,
  type ChartSnapshot,
} from './model';
import { objectActions, pageActions } from './view-actions';
import { exportSlides } from './view-export';
import { SlideInspector } from './view-inspector';
import { SlideNavigator } from './view-navigator';
import { SlidePresentation } from './view-presentation';
import type { SlideEditing } from './view-shared';
import { animationReuseReason, SlideStatus, SlideToolbar } from './view-toolbar';
const SlidePptxDialog = lazy(() =>
  import('@editor-platform/office-export-ui/slide').then((m) => ({ default: m.SlidePptxDialog })),
);
type SlideCanvasTarget = SlideObject & CanvasTarget;
const canvasTargets = new WeakMap<SlideObject, { index: number; target: SlideCanvasTarget }>();
function canvasTarget(object: SlideObject, index: number): SlideCanvasTarget {
  const immutable = isDeepFrozen(object),
    cached = immutable ? canvasTargets.get(object) : undefined;
  if (cached?.index === index) return cached.target;
  const target: SlideCanvasTarget = {
    ...object,
    textDrawing: slideDrawing(object),
    parentId: object.groupId,
    label: `${object.type} object ${index + 1}`,
    editableText: object.type === 'text' || object.type === 'shape',
    hitBox: object.type === 'text',
    container: object.type === 'group',
  };
  if (immutable) canvasTargets.set(object, { index, target: deepFreeze(target) });
  return target;
}
// The target carries the native fields as well as transient drag geometry, so
// this renderer does not close over a changing Slide or an object lookup table.
function renderCanvasTarget(target: CanvasTarget) {
  return <DrawingView drawing={slideDrawing(target as SlideCanvasTarget)} />;
}
export interface SlideSurfaceProps extends ReferenceSurfaceProps, SlideAnimationProps {
  content: SlideContent;
  execute: (cmd: EditorCommand<SlideContent>) => void | boolean;
  select: (ids: string | string[], region?: Region, pageId?: string) => void;
  dataSnapshots?: ChartSnapshot[];
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  focusAddress?: ElementAddress;
}
/** Selects the slide containing a newly focused element address (or the addressed slide). */
function useFocusAddress(
  focusAddress: ElementAddress | undefined,
  slides: Slide[],
  setActiveId: (id: string) => void,
  setSelected: (ids: string[]) => void,
) {
  const lastFocus = useRef<ElementAddress | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusAddress || lastFocus.current === focusAddress) return;
    const page = slides.find(
      (p) =>
        (!focusAddress.pageId || p.id === focusAddress.pageId) &&
        (p.id === focusAddress.elementId || p.objects.some((o) => o.id === focusAddress.elementId)),
    );
    if (!page) return;
    lastFocus.current = focusAddress;
    setActiveId(page.id);
    setSelected(page.id === focusAddress.elementId ? [] : [focusAddress.elementId]);
  }, [focusAddress, slides]);
}
/** Reference projections of every slide's objects, grouped by page and object ID. */
function useProjectedObjects(
  content: SlideContent,
  references: ReferenceSurfaceProps['references'],
) {
  const projectedObjects = useReferenceItems(
    content.slides.flatMap((s) => s.objects),
    references,
  );
  let projectionOffset = 0;
  return new Map(
    content.slides.map((page) => {
      const items = projectedObjects.slice(
        projectionOffset,
        projectionOffset + page.objects.length,
      );
      projectionOffset += page.objects.length;
      return [page.id, new Map(items.map((o) => [o.id, o]))];
    }),
  );
}
/** Layer callbacks with stable identities that always call the latest surface actions. */
function useStableLayerActions(actions: {
  choose(next: string[]): void;
  patch(id: string, patch: Partial<SlideObject>): void;
}) {
  const layerActions = useRef(actions);
  useLayoutEffect(() => {
    layerActions.current = actions;
  });
  return useMemo(
    () => ({
      choose: (next: string[]) => layerActions.current.choose(next),
      patch: (id: string, patch: Partial<SlideObject>) => layerActions.current.patch(id, patch),
    }),
    [],
  );
}
/** Validates the command result before the Host executes it; reports failures on the surface. */
function checkedApply(
  content: SlideContent,
  readOnly: boolean,
  execute: SlideSurfaceProps['execute'],
  setError: (message: string) => void,
) {
  return (cmd: EditorCommand<SlideContent>) => {
    if (readOnly) return false;
    const checked: EditorCommand<SlideContent> = {
      ...cmd,
      apply(current) {
        const next = cmd.apply(current);
        // isDeck also refuses an over-budget reference closure; report that limit first.
        if (
          Array.isArray(next?.slides) &&
          next.slides.every((page) => Array.isArray(page?.objects))
        )
          assertReferenceItems(next.slides.flatMap((page) => page.objects));
        if (!isDeck(next)) throw Error('Invalid Slide content or retained Animation');
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
}
/** A ref that always holds the value of the latest render. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
/** Toolbar insertion and reference-capture choices. */
function useSlideTools() {
  const [reference, setReference] = useState('selection'),
    [inserting, setInserting] = useState<ShapeKind>(),
    [repeat, setRepeat] = useState(false);
  return { reference, setReference, inserting, setInserting, repeat, setRepeat };
}
/** Navigator tab and dragged slide, kept by the surface across navigator renders. */
function useNavigatorState() {
  const [tab, setTab] = useState<'pages' | 'layers'>('pages'),
    dragged = useRef('');
  return { tab, setTab, dragged };
}
/** Open state of the animation, PPTX export and presentation overlays. */
function useSlideOverlays() {
  const [pptxOpen, setPptxOpen] = useState(false);
  const [animationChoice, setAnimationChoice] = useState<AnimationChoiceState>();
  const [animationPreview, setAnimationPreview] = useState<PlayableAnimationEmbed>();
  const [presenting, setPresenting] = useState(false),
    [presentIndex, setPresentIndex] = useState(0);
  return {
    pptxOpen,
    setPptxOpen,
    animationChoice,
    setAnimationChoice,
    animationPreview,
    setAnimationPreview,
    presenting,
    setPresenting,
    presentIndex,
    setPresentIndex,
  };
}
type SlideOverlayState = ReturnType<typeof useSlideOverlays>;
/** Raster/PDF export and the saved-animation chooser of the surface toolbar and inspector. */
function surfaceCommands(
  { slide, references, setError }: SlideEditing,
  context: {
    guardExport: (() => void) | undefined;
    inputs: Parameters<typeof exportSlides>[2];
    exportState: Parameters<typeof exportSlides>[0];
    animationSources: SlideAnimationProps['animationSources'];
    setAnimationChoice(choice: AnimationChoiceState): void;
  },
) {
  const { guardExport, inputs, exportState, animationSources } = context;
  async function output(format: 'svg' | 'png' | 'pdf', scope: string, scale: number) {
    try {
      guardExport?.();
      await exportSlides(exportState, references, inputs, format, scope, scale);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const chooseAnimation = (current?: SlideObject) => {
    if (!animationSources) return;
    try {
      flushSync(() => inputs?.flush());
      if (hasSlideReuse(exportState.current.content)) throw Error(animationReuseReason);
      if (!slide) throw Error('先にスライドを作成してください。');
      context.setAnimationChoice({
        pageId: slide.id,
        ...(current ? { objectId: current.id, current: current.animation } : {}),
      });
    } catch (error) {
      setError(String(error));
    }
  };
  return { output, chooseAnimation };
}
interface AnimationChoiceState {
  pageId: string;
  objectId?: string;
  current?: PlayableAnimationEmbed;
}
export function SlideSurface({
  references,
  content,
  execute,
  select,
  dataSnapshots = [],
  readOnly = false,
  layout,
  focusAddress,
  animationSources,
  openAnimation,
}: SlideSurfaceProps) {
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const overlays = useSlideOverlays();
  const [activeId, setActiveId] = useState(content.slides[0]?.id ?? ''),
    [selected, setSelected] = useState<string[]>([]),
    [pages, setPages] = useState<string[]>([]),
    [view, setView] = useState<CanvasView>(initialCanvasView),
    [error, setError] = useState(''),
    tools = useSlideTools(),
    navigator = useNavigatorState();
  useFocusAddress(focusAddress, content.slides, setActiveId, setSelected);
  const clipboard = useRef<SlideObject[]>([]);
  const slide = content.slides.find((s) => s.id === activeId) ?? content.slides[0],
    index = content.slides.indexOf(slide),
    objects = slide?.objects ?? [],
    ids = selected.filter((id) => objects.some((o) => o.id === id)),
    chosen = objects.filter((o) => ids.includes(o.id));
  const projectedByPage = useProjectedObjects(content, references);
  const exportState = useLatest({ content, slide, pages, references });
  const apply = checkedApply(content, readOnly, execute, setError);
  const choose = (next: string[], pageId = slide?.id) => {
    setSelected(next);
    select(next, undefined, pageId);
  };
  const editing: SlideEditing = {
    content,
    slide,
    ids,
    readOnly,
    references,
    apply,
    choose,
    setError,
  };
  const stableLayerActions = useStableLayerActions({
    choose,
    patch: (id, patch) => slide && apply(patchObjects(slide.id, [id], patch)),
  });
  const { flushSlideInputs, navigate, addSlide } = pageActions(
    editing,
    inputs,
    () => exportState.current.content,
    setActiveId,
  );
  const { add, image, action, geometry } = objectActions(editing, chosen, clipboard);
  const { output, chooseAnimation } = surfaceCommands(editing, {
    guardExport,
    inputs,
    exportState,
    animationSources,
    setAnimationChoice: overlays.setAnimationChoice,
  });
  const toolbar = (
    <SlideToolbar
      editing={editing}
      onChooseAnimation={animationSources && (() => chooseAnimation())}
      dataSnapshots={dataSnapshots}
      {...tools}
      onAdd={add}
      onImage={(f) => void image(f)}
      onAction={action}
      onAddSlide={addSlide}
      onPresent={() => {
        overlays.setPresentIndex(index);
        overlays.setPresenting(true);
      }}
      onExport={(f, s, z) => void output(f, s, z)}
      onPptx={() => overlays.setPptxOpen(true)}
    />
  );
  const left = (
    <SlideNavigator
      editing={editing}
      objects={objects}
      pages={pages}
      setPages={setPages}
      setActiveId={setActiveId}
      navigate={navigate}
      flushInputs={flushSlideInputs}
      onAddSlide={addSlide}
      {...navigator}
      layerActions={stableLayerActions}
    />
  );
  const inspector = (
    <SlideInspector
      editing={editing}
      chosen={chosen}
      onGeometry={geometry}
      onChooseAnimation={animationSources && chooseAnimation}
      onPreviewAnimation={overlays.setAnimationPreview}
      openAnimation={openAnimation}
    />
  );
  return (
    <>
      <EditorLayout
        viewKey="slide"
        leftLabel="Slide navigator"
        inspectorLabel="Slide inspector"
        toolbar={toolbar}
        left={left}
        inspector={inspector}
        status={
          <SlideStatus
            index={index}
            count={content.slides.length}
            selected={ids.length}
            view={view}
            setView={setView}
            navigate={navigate}
          />
        }
        {...layout}
      >
        <SlideStage
          editing={editing}
          error={error}
          view={view}
          setView={setView}
          projected={slide && projectedByPage.get(slide.id)}
          onAction={action}
          onImage={(f, p) => void image(f, { ...p, width: 320, height: 220 })}
          onPage={(delta) => navigate(index + delta)}
          tools={tools}
          onAdd={add}
        />
      </EditorLayout>
      <SlideOverlays
        editing={editing}
        animationSources={animationSources}
        overlays={overlays}
        pages={pages}
        setActiveId={setActiveId}
      />
    </>
  );
}
/** Reference warnings, the surface error and the current slide's canvas. */
function SlideStage({
  error,
  tools,
  onAdd,
  ...props
}: Omit<Parameters<typeof SlideCanvas>[0], 'slide' | 'inserting' | 'onInsert'> & {
  error: string;
  tools: ReturnType<typeof useSlideTools>;
  onAdd: ReturnType<typeof objectActions>['add'];
}) {
  const { editing } = props;
  const onInsert = (bounds: Bounds) => {
    onAdd('shape', { shape: tools.inserting, bounds });
    if (!tools.repeat) tools.setInserting(undefined);
  };
  return (
    <>
      <ReferenceWarnings items={editing.slide?.objects ?? []} resolver={editing.references} />
      {error && (
        <div role="alert" className="surface-error">
          {error}
          <button onClick={() => editing.setError('')}>Dismiss</button>
        </div>
      )}
      {editing.slide ? (
        <SlideCanvas
          {...props}
          slide={editing.slide}
          inserting={tools.inserting}
          onInsert={onInsert}
        />
      ) : (
        <div className="empty">
          <FileText size={40} />
          <p>Add a blank slide or choose a layout to start.</p>
        </div>
      )}
    </>
  );
}
/** Animation, PPTX export and presentation dialogs over the editor. */
function SlideOverlays({
  overlays: props,
  editing,
  animationSources,
  pages,
  setActiveId,
}: {
  overlays: SlideOverlayState;
  editing: SlideEditing;
  animationSources: SlideAnimationProps['animationSources'];
  pages: string[];
  setActiveId(id: string): void;
}) {
  const { animationChoice, animationPreview } = props;
  return (
    <>
      {animationChoice && animationSources && (
        <AnimationChoice
          editing={editing}
          sources={animationSources}
          choice={animationChoice}
          close={() => props.setAnimationChoice(undefined)}
        />
      )}
      {animationPreview && (
        <AnimationPreviewDialog
          animation={animationPreview}
          close={() => props.setAnimationPreview(undefined)}
        />
      )}
      {props.pptxOpen && (
        <PptxExport
          editing={editing}
          pages={pages}
          setActiveId={setActiveId}
          close={() => props.setPptxOpen(false)}
        />
      )}
      {props.presenting && (
        <SlidePresentation
          editing={editing}
          presentIndex={props.presentIndex}
          setPresentIndex={props.setPresentIndex}
          close={() => props.setPresenting(false)}
        />
      )}
    </>
  );
}
function SlideCanvas({
  editing,
  slide,
  view,
  setView,
  projected,
  onAction,
  onImage,
  onPage,
  inserting,
  onInsert,
}: {
  editing: SlideEditing;
  slide: Slide;
  view: CanvasView;
  setView(view: CanvasView): void;
  projected: Map<string, SlideObject> | undefined;
  onAction(action: string, value?: number): void;
  onImage(file: File, point: { x: number; y: number }): void;
  onPage(delta: number): void;
  inserting: ShapeKind | undefined;
  onInsert(bounds: Bounds): void;
}) {
  const { content, apply } = editing;
  const objectIndex = useMemo(
    () => new Map(slide.objects.map((object, index) => [object.id, { object, index }])),
    [slide.objects],
  );
  const targets = slidePaintOrder(slide).map((o) => {
    const src = (projected?.get(o.id) ?? o).src;
    return canvasTarget(src === o.src ? o : { ...o, src }, objectIndex.get(o.id)!.index);
  });
  return (
    <CanvasStage
      label="Slide canvas"
      width={content.width}
      height={content.height}
      background={slide.background}
      hideControls
      view={view}
      onViewChange={setView}
      selected={editing.ids}
      targets={targets}
      onSelect={editing.choose}
      onTransform={(ids, delta) => apply(transformObjects(slide.id, ids, delta))}
      onDelete={() => onAction('delete')}
      onAction={onAction}
      onEditText={(id, text, runs) => apply(updateObject(slide.id, id, { text, runs }))}
      onImage={onImage}
      onPage={onPage}
      readOnly={editing.readOnly}
      insertion={!!inserting}
      onInsert={onInsert}
      render={renderCanvasTarget}
    />
  );
}
function AnimationChoice({
  editing,
  sources,
  choice,
  close,
}: {
  editing: SlideEditing;
  sources: NonNullable<SlideAnimationProps['animationSources']>;
  choice: AnimationChoiceState;
  close(): void;
}) {
  return (
    <AnimationChoiceDialog
      sources={sources}
      current={choice.current}
      close={close}
      apply={(animation) => {
        const id = choice.objectId ?? newId('animation');
        const cmd = choice.current
          ? replaceSlideAnimation(choice.pageId, id, choice.current, animation)
          : placeSlideAnimation(choice.pageId, animation, id);
        if (!editing.apply(cmd)) return false;
        editing.choose([id], choice.pageId);
        return true;
      }}
    />
  );
}
function PptxExport({
  editing,
  pages,
  setActiveId,
  close,
}: {
  editing: SlideEditing;
  pages: string[];
  setActiveId(id: string): void;
  close(): void;
}) {
  const { content } = editing;
  return (
    <Suspense fallback={<p role="status">Opening PPTX export…</p>}>
      <SlidePptxDialog
        content={content}
        selectedPageIds={pages}
        onClose={close}
        onNavigate={(address) => {
          if (!content.slides.some((s) => s.id === address.slideId)) return;
          setActiveId(address.slideId!);
          editing.choose(address.elementId ? [address.elementId] : [], address.slideId);
        }}
      />
    </Suspense>
  );
}
