import {
  assertReferenceItems,
  referenceExportManifest,
} from '@editor-platform/artifact-references';
import {
  ReferenceTools,
  ReferenceWarnings,
  ReferenceInspector,
  useReferenceItems,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { lazy, memo, Suspense, useContext, useMemo, useLayoutEffect } from 'react';
import {
  EditorExportGuardContext,
  EditorOfficeCapabilitiesContext,
  EditorInputsContext,
} from '@editor-platform/editor-ui';
import './styles.css';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Plus,
  Presentation,
  ChevronLeft,
  ChevronRight,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  Table2,
  ChartColumn,
  LayoutTemplate,
  EyeOff,
  Layers,
  X,
  FileText,
  Repeat,
} from 'lucide-react';
import { deepFreeze, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import {
  command,
  unionBounds,
  type EditorCommand,
  type ShapeKind,
  type Bounds,
  type Region,
  type ElementAddress,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Menu,
  Section,
  CommitInput,
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
  VisualInspector,
  ExportMenu,
  exportPages,
  readImage,
  type CanvasView,
  type CanvasTarget,
} from '@editor-platform/canvas-ui';
import {
  arrangeObjects,
  alignObjects,
  insertObject,
  updateObject,
  updateSlide,
  deleteSlide,
  duplicateSlide,
  reorderSlide,
  resizeDeck,
  insertSlideLayout,
  patchObjects,
  copiedObjects,
  pasteObjects,
  transformObjects,
  exportSlideSvg,
  slidePaintOrder,
  slideDrawing,
  type SlideContent,
  type SlideObject,
  type SlideObjectType,
  type SlideLayout,
  type ChartSnapshot,
} from './model';
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
export interface SlideSurfaceProps extends ReferenceSurfaceProps {
  content: SlideContent;
  execute: (cmd: EditorCommand<SlideContent>) => void | boolean;
  select: (ids: string | string[], region?: Region, pageId?: string) => void;
  dataSnapshots?: ChartSnapshot[];
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  focusAddress?: ElementAddress;
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
}: SlideSurfaceProps) {
  const guardExport = useContext(EditorExportGuardContext);
  const officeCapability = useContext(EditorOfficeCapabilitiesContext);
  const inputs = useContext(EditorInputsContext);
  const [pptxOpen, setPptxOpen] = useState(false);
  const [activeId, setActiveId] = useState(content.slides[0]?.id ?? ''),
    [selected, setSelected] = useState<string[]>([]),
    [pages, setPages] = useState<string[]>([]),
    [view, setView] = useState<CanvasView>(initialCanvasView),
    [reference, setReference] = useState('selection'),
    [error, setError] = useState(''),
    [presenting, setPresenting] = useState(false),
    [presentIndex, setPresentIndex] = useState(0),
    [inserting, setInserting] = useState<ShapeKind>(),
    [repeat, setRepeat] = useState(false),
    [tab, setTab] = useState<'pages' | 'layers'>('pages');
  const lastFocus = useRef<ElementAddress | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusAddress || lastFocus.current === focusAddress) return;
    const page = content.slides.find(
      (p) =>
        (!focusAddress.pageId || p.id === focusAddress.pageId) &&
        (p.id === focusAddress.elementId || p.objects.some((o) => o.id === focusAddress.elementId)),
    );
    if (!page) return;
    lastFocus.current = focusAddress;
    setActiveId(page.id);
    setSelected(page.id === focusAddress.elementId ? [] : [focusAddress.elementId]);
  }, [focusAddress, content.slides]);
  const clipboard = useRef<SlideObject[]>([]),
    dragged = useRef('');
  const slide = content.slides.find((s) => s.id === activeId) ?? content.slides[0],
    index = content.slides.indexOf(slide),
    objects = slide?.objects ?? [],
    ids = selected.filter((id) => objects.some((o) => o.id === id)),
    chosen = objects.filter((o) => ids.includes(o.id));
  const projectedObjects = useReferenceItems(
    content.slides.flatMap((s) => s.objects),
    references,
  );
  let projectionOffset = 0;
  const projectedByPage = new Map(
    content.slides.map((page) => {
      const items = projectedObjects.slice(
        projectionOffset,
        projectionOffset + page.objects.length,
      );
      projectionOffset += page.objects.length;
      return [page.id, new Map(items.map((o) => [o.id, o]))];
    }),
  );
  const exportState = useRef({ content, slide, pages, references });
  exportState.current = { content, slide, pages, references };
  const objectIndex = useMemo(
    () => new Map(objects.map((object, index) => [object.id, { object, index }])),
    [objects],
  );
  const apply = (cmd: EditorCommand<SlideContent>) => {
    if (readOnly) return false;
    const checked: EditorCommand<SlideContent> = {
      ...cmd,
      apply(current) {
        const next = cmd.apply(current);
        assertReferenceItems(next.slides.flatMap((page) => page.objects));
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
  const choose = (next: string[], pageId = slide?.id) => {
    setSelected(next);
    select(next, undefined, pageId);
  };
  const layerActions = useRef({
    choose,
    patch: (id: string, patch: Partial<SlideObject>) =>
      slide && apply(patchObjects(slide.id, [id], patch)),
  });
  useLayoutEffect(() => {
    layerActions.current = {
      choose,
      patch: (id, patch) => slide && apply(patchObjects(slide.id, [id], patch)),
    };
  });
  const stableLayerActions = useMemo(
    () => ({
      choose: (next: string[]) => layerActions.current.choose(next),
      patch: (id: string, patch: Partial<SlideObject>) => layerActions.current.patch(id, patch),
    }),
    [],
  );
  function flushSlideInputs() {
    try {
      inputs?.flush();
      return true;
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
      return false;
    }
  }
  function navigate(n: number) {
    if (!flushSlideInputs()) return false;
    const target = content.slides[Math.max(0, Math.min(content.slides.length - 1, n))];
    if (target) {
      setActiveId(target.id);
      choose([]);
      document.getElementById(`thumb-${target.id}`)?.scrollIntoView({ block: 'nearest' });
    }
    return !!target;
  }
  function addSlide(layout: SlideLayout) {
    let ready = false;
    flushSync(() => {
      ready = flushSlideInputs();
    });
    if (!ready || readOnly) return;
    const current = exportState.current.content;
    const added = insertSlideLayout(layout).apply(current).slides.at(-1)!;
    if (
      apply(
        command(layout === 'blank' ? 'slide.insert' : 'slide.layout', 'Add slide', (content) => ({
          ...content,
          slides: [...content.slides, added],
        })),
      )
    ) {
      setActiveId(added.id);
      choose([]);
    }
  }
  function add(type: SlideObjectType, patch: Partial<SlideObject> = {}) {
    if (!slide || readOnly) return;
    const id = newId('object');
    apply(
      insertObject(slide.id, type, {
        id,
        bounds: {
          x: content.width / 2 - 130,
          y: content.height / 2 - 80,
          width: 260,
          height: type === 'text' ? 80 : 160,
        },
        ...patch,
      }),
    );
    choose([id]);
  }
  async function image(file: File, bounds?: Bounds) {
    try {
      add('image', { src: await readImage(file), alt: file.name, ...(bounds ? { bounds } : {}) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function action(action: string, value?: number) {
    if (!slide) return;
    if (action === 'copy' || action === 'cut') {
      clipboard.current = copiedObjects(slide, ids);
      if (action === 'cut') apply(arrangeObjects(slide.id, ids, 'delete'));
      return;
    }
    if (action === 'paste') {
      if (!clipboard.current.length) {
        setError('Copy elements in this editor first.');
        return;
      }
      apply(pasteObjects(slide.id, clipboard.current));
      return;
    }
    apply(arrangeObjects(slide.id, ids, action, value));
  }
  function geometry(patch: Partial<Bounds>) {
    if (!slide) return;
    const box = unionBounds(chosen.map((o) => o.bounds));
    apply(
      transformObjects(slide.id, ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  }
  async function output(format: 'svg' | 'png' | 'pdf', scope: string, scale: number) {
    try {
      guardExport?.();
      const initial = exportState.current;
      const content = initial.content;
      const { pages } = initial;
      let slides =
        format === 'pdf' || scope === 'all'
          ? content.slides
          : scope === 'selected'
            ? content.slides.filter((s) => pages.includes(s.id))
            : content.slides.filter((s) => s.id === initial.slide?.id);
      const visibleByPage = new Map(
        slides.map((s) => [
          s.id,
          new Set(
            slidePaintOrder(s)
              .filter((o) => !o.hidden)
              .map((o) => o.id),
          ),
        ]),
      );
      let exported = slides.flatMap((s) =>
        s.objects.filter((o) => visibleByPage.get(s.id)!.has(o.id)),
      );
      if (exported.some((o) => o.reference)) {
        if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
        exported = await references.capture(exported);
        if (exportState.current.references !== references)
          throw new Error('取得中に参照接続が変わりました。再実行してください。');
        if (
          exportState.current.content !== content ||
          inputs?.getSnapshot().dirty ||
          inputs?.getSnapshot().composing
        )
          throw new Error('取得中に入力が変わりました。再実行してください。');
        let offset = 0;
        slides = slides.map((s) => ({
          ...s,
          objects: s.objects.map((o) =>
            visibleByPage.get(s.id)!.has(o.id) ? exported[offset++] : o,
          ),
        }));
      }
      await exportPages(
        slides.filter(Boolean).map((s) => ({
          name: s.title,
          width: content.width,
          height: content.height,
          svg: exportSlideSvg(content, s),
        })),
        format,
        scale,
        'slide-deck',
        referenceExportManifest(exported),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const object = chosen.length === 1 ? chosen[0] : undefined;
  const toolbar = (
    <>
      <ReferenceTools
        identity={slide?.id}
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
      <InsertTools
        readOnly={readOnly}
        onShape={(s) => {
          add('shape', { shape: s });
          setInserting(undefined);
        }}
        onText={() => add('text')}
        onImage={(f) => void image(f)}
      />
      <Menu label="Slide insert options" icon={Plus}>
        <button
          disabled={readOnly}
          onClick={() =>
            add('table', {
              table: {
                rows: [
                  ['Heading', 'Value'],
                  ['', ''],
                  ['', ''],
                ],
                header: true,
              },
              bounds: { x: 100, y: 150, width: 760, height: 300 },
            })
          }
        >
          <Table2 size={18} />
          Insert table
        </button>
        <button
          disabled={readOnly}
          onClick={() => add('chart', { bounds: { x: 120, y: 140, width: 720, height: 320 } })}
        >
          <ChartColumn size={18} />
          Insert chart
        </button>
        <label className="ep-field">
          Draw a shape by dragging
          <select
            aria-label="Draw shape"
            value={inserting ?? ''}
            onChange={(e) => setInserting((e.target.value as ShapeKind) || undefined)}
          >
            <option value="">Selection tool</option>
            {[
              'rectangle',
              'rounded-rectangle',
              'ellipse',
              'triangle',
              'diamond',
              'arrow-right',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button aria-pressed={repeat} onClick={() => setRepeat(!repeat)}>
          <Repeat size={17} />
          Continuous creation
        </button>
        {dataSnapshots.map((d, i) => (
          <button key={i} onClick={() => add('chart', { chart: d })}>
            Insert snapshot: {d.label}
          </button>
        ))}
      </Menu>
      <span className="ep-divider" />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={action}
        onAlign={(mode) =>
          slide &&
          apply(
            alignObjects(
              slide.id,
              ids,
              mode,
              reference === 'page'
                ? { x: 0, y: 0, width: content.width, height: content.height }
                : undefined,
            ),
          )
        }
        reference={reference}
        onReference={setReference}
      />
      <EditMenu onAction={action} readOnly={readOnly} />
      <Menu label="Add slide layout" icon={LayoutTemplate}>
        {(
          [
            'blank',
            'title',
            'title-body',
            'two-column',
            'image-caption',
            'comparison',
            'chart',
          ] as SlideLayout[]
        ).map((l) => (
          <button key={l} disabled={readOnly} onClick={() => addSlide(l)}>
            {l}
          </button>
        ))}
      </Menu>
      <IconButton
        icon={Presentation}
        label="Present"
        disabled={!content.slides.length}
        onClick={() => {
          setPresentIndex(index);
          setPresenting(true);
        }}
      />
      <ExportMenu onExport={(f, s, z) => void output(f, s, z)}>
        <button
          disabled={!officeCapability.pptx}
          title={
            !officeCapability.pptx
              ? (officeCapability.reason ?? 'Hostはこの形式の出力を提供していません。')
              : undefined
          }
          onClick={() => setPptxOpen(true)}
        >
          Export PPTX
        </button>
      </ExportMenu>
    </>
  );
  const left = (
    <>
      <div className="navigator-tabs">
        <button aria-pressed={tab === 'pages'} onClick={() => setTab('pages')}>
          Slides
        </button>
        <button aria-pressed={tab === 'layers'} onClick={() => setTab('layers')}>
          Layers
        </button>
      </div>
      {tab === 'pages' ? (
        <>
          <IconButton
            icon={Plus}
            label="Add slide"
            disabled={readOnly}
            onClick={() => addSlide('blank')}
          />
          {content.slides.map((s, i) => (
            <div
              key={s.id}
              className="slide-thumb-row"
              draggable={!readOnly}
              onDragStart={() => {
                dragged.current = s.id;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                apply(
                  reorderSlide(
                    dragged.current,
                    i - content.slides.findIndex((p) => p.id === dragged.current),
                  ),
                );
              }}
            >
              <button
                id={`thumb-${s.id}`}
                className="slide-thumb"
                aria-label={`Slide ${i + 1}: ${s.title}`}
                aria-pressed={s.id === slide?.id}
                onClick={(e) => {
                  if (e.shiftKey)
                    setPages((p) =>
                      p.includes(s.id) ? p.filter((id) => id !== s.id) : [...p, s.id],
                    );
                  else if (navigate(i)) {
                    setPages([s.id]);
                  }
                }}
              >
                <span>
                  {i + 1}
                  {s.hidden && <EyeOff size={12} />} {pages.includes(s.id) && '✓'}
                </span>
                <svg viewBox={`0 0 ${content.width} ${content.height}`} aria-hidden="true">
                  <rect width={content.width} height={content.height} fill={s.background} />
                  {slidePaintOrder(s).map((o) => (
                    <DrawingView
                      key={o.id}
                      drawing={slideDrawing(
                        o.reference && references
                          ? { ...o, src: references.get(o.reference).projection?.src }
                          : o,
                      )}
                    />
                  ))}
                </svg>
                <small>{s.title}</small>
              </button>
              {s.id === slide?.id && (
                <div className="thumb-actions">
                  <IconButton
                    icon={ArrowUp}
                    label="Move slide up"
                    disabled={i === 0 || readOnly}
                    onClick={() => apply(reorderSlide(s.id, -1))}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label="Move slide down"
                    disabled={i === content.slides.length - 1 || readOnly}
                    onClick={() => apply(reorderSlide(s.id, 1))}
                  />
                  <IconButton
                    icon={Copy}
                    label="Duplicate slide"
                    disabled={readOnly}
                    onClick={() => {
                      if (!flushSlideInputs()) return;
                      const copyId = newId('slide');
                      if (apply(duplicateSlide(s.id, copyId))) {
                        setActiveId(copyId);
                        choose([]);
                      }
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    label="Delete slide"
                    disabled={readOnly}
                    onClick={() => {
                      if (flushSlideInputs() && apply(deleteSlide(s.id))) choose([]);
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </>
      ) : (
        <LayerList
          objects={objects}
          selected={ids}
          choose={stableLayerActions.choose}
          onPatch={stableLayerActions.patch}
        />
      )}
    </>
  );
  const inspector = (
    <>
      <ReferenceInspector
        item={object}
        pageId={slide?.id}
        resolver={references}
        readOnly={readOnly}
        patch={(patch) =>
          object &&
          apply(
            updateObject(slide.id, object.id, {
              ...patch,
              imageFit: (patch.reference ?? object.reference)?.fit === 'cover' ? 'fill' : 'fit',
            }),
          )
        }
      />
      <fieldset disabled={readOnly} className="inspector-fields">
        {slide && (
          <>
            <Section title="Page settings" open={!chosen.length}>
              <CommitInput
                label="Slide title"
                value={slide.title}
                onCommit={(title) => apply(updateSlide(slide.id, { title }))}
              />
              <label className="ep-field">
                Page size
                <select
                  aria-label="Slide size"
                  value={`${content.width}x${content.height}`}
                  onChange={(e) => {
                    const [width, height] = e.target.value.split('x').map(Number);
                    apply(resizeDeck(width, height));
                  }}
                >
                  <option value={`${content.width}x${content.height}`}>
                    {content.width} × {content.height}
                  </option>
                  <option value="960x540">16:9</option>
                  <option value="960x720">4:3</option>
                </select>
              </label>
              <div className="ep-fields">
                {(['width', 'height'] as const).map((k) => (
                  <CommitInput
                    key={k}
                    label={`Page ${k} (px)`}
                    type="number"
                    min={100}
                    max={6000}
                    value={content[k]}
                    onCommit={(v) =>
                      apply(
                        resizeDeck(
                          k === 'width' ? Number(v) : content.width,
                          k === 'height' ? Number(v) : content.height,
                        ),
                      )
                    }
                  />
                ))}
              </div>
              <p className="ep-muted">
                Changing page size keeps object positions and sizes. Content outside the page is
                clipped in presentation and export.
              </p>
              <CommitInput
                label="Slide background"
                value={slide.background}
                onCommit={(background) => apply(updateSlide(slide.id, { background }))}
              />
              <label>
                <input
                  type="checkbox"
                  checked={slide.hidden ?? false}
                  onChange={(e) => apply(updateSlide(slide.id, { hidden: e.target.checked }))}
                />{' '}
                Skip during presentation
              </label>
            </Section>
            <VisualInspector
              items={chosen.map(slideDrawing)}
              onPatch={(patch) => apply(patchObjects(slide.id, ids, patch))}
              onGeometry={geometry}
              onReplace={(f) => {
                void readImage(f)
                  .then((src) => apply(patchObjects(slide.id, ids, { src, reference: undefined })))
                  .catch((e) => setError(String(e)));
              }}
            />
            {object?.type === 'table' && object.table && (
              <TableInspector
                object={object}
                onChange={(table) => apply(updateObject(slide.id, object.id, { table }))}
              />
            )}
            {object?.type === 'chart' && object.chart && (
              <Section title="Chart data">
                <label className="ep-field">
                  Chart type
                  <select
                    aria-label="Chart type"
                    value={object.chart.type ?? 'bar'}
                    onChange={(e) =>
                      apply(
                        updateObject(slide.id, object.id, {
                          chart: {
                            ...object.chart!,
                            type: e.target.value as 'bar' | 'line' | 'pie',
                          },
                        }),
                      )
                    }
                  >
                    {['bar', 'line', 'pie'].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <ChartEditor
                  chart={object.chart}
                  onChange={(chart) => apply(updateObject(slide.id, object.id, { chart }))}
                />
                <p className="hint">
                  Imported charts are static snapshots. Edit these values explicitly; source data
                  changes do not alter this slide.
                </p>
              </Section>
            )}
            <Section title="Speaker notes" open={false}>
              <CommitInput
                label="Speaker notes"
                value={slide.notes ?? ''}
                onCommit={(notes) => apply(updateSlide(slide.id, { notes }))}
              />
            </Section>
          </>
        )}
      </fieldset>
    </>
  );
  const playable = content.slides.filter((s) => !s.hidden),
    present = playable[Math.min(presentIndex, playable.length - 1)];
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
          <>
            <IconButton
              icon={ChevronLeft}
              label="Previous slide"
              disabled={index <= 0}
              onClick={() => navigate(index - 1)}
            />
            <input
              aria-label="Current page"
              type="number"
              min={1}
              max={content.slides.length}
              value={index + 1}
              onChange={(e) => navigate(Number(e.target.value) - 1)}
            />
            <span>/ {content.slides.length}</span>
            <IconButton
              icon={ChevronRight}
              label="Next slide"
              disabled={index >= content.slides.length - 1}
              onClick={() => navigate(index + 1)}
            />
            <span className="ep-spacer" />
            <span>{ids.length} selected</span>
            <CanvasControls
              view={view}
              onChange={setView}
              onFit={() => setView({ ...view, fit: true })}
            />
          </>
        }
        {...layout}
      >
        <ReferenceWarnings items={objects} resolver={references} />
        {error && (
          <div role="alert" className="surface-error">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {slide ? (
          <CanvasStage
            label="Slide canvas"
            width={content.width}
            height={content.height}
            background={slide.background}
            hideControls
            view={view}
            onViewChange={setView}
            selected={ids}
            targets={slidePaintOrder(slide).map((o) => {
              const src = (projectedByPage.get(slide.id)?.get(o.id) ?? o).src;
              return canvasTarget(src === o.src ? o : { ...o, src }, objectIndex.get(o.id)!.index);
            })}
            onSelect={choose}
            onTransform={(ids, delta) => apply(transformObjects(slide.id, ids, delta))}
            onDelete={() => action('delete')}
            onAction={action}
            onEditText={(id, text, runs) => apply(updateObject(slide.id, id, { text, runs }))}
            onImage={(f, p) => void image(f, { ...p, width: 320, height: 220 })}
            onPage={(delta) => navigate(index + delta)}
            readOnly={readOnly}
            insertion={!!inserting}
            onInsert={(bounds) => {
              add('shape', { shape: inserting, bounds });
              if (!repeat) setInserting(undefined);
            }}
            render={renderCanvasTarget}
          />
        ) : (
          <div className="empty">
            <FileText size={40} />
            <p>Add a blank slide or choose a layout to start.</p>
          </div>
        )}
      </EditorLayout>
      {pptxOpen && (
        <Suspense fallback={<p role="status">Opening PPTX export…</p>}>
          <SlidePptxDialog
            content={content}
            selectedPageIds={pages}
            onClose={() => setPptxOpen(false)}
            onNavigate={(address) => {
              if (!content.slides.some((s) => s.id === address.slideId)) return;
              setActiveId(address.slideId!);
              choose(address.elementId ? [address.elementId] : [], address.slideId);
            }}
          />
        </Suspense>
      )}
      {presenting && (
        <div
          className="presenting"
          role="dialog"
          aria-label="Slide presentation"
          tabIndex={0}
          ref={(el) => el?.focus()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPresenting(false);
            if (['ArrowRight', 'PageDown'].includes(e.key))
              setPresentIndex((i) => Math.min(playable.length - 1, i + 1));
            if (['ArrowLeft', 'PageUp'].includes(e.key)) setPresentIndex((i) => Math.max(0, i - 1));
          }}
        >
          {present ? (
            <svg
              viewBox={`0 0 ${content.width} ${content.height}`}
              aria-label={`Presentation page ${presentIndex + 1}`}
            >
              <rect width={content.width} height={content.height} fill={present.background} />
              {slidePaintOrder(present).map((o) => (
                <DrawingView
                  key={o.id}
                  drawing={slideDrawing(
                    o.reference && references
                      ? { ...o, src: references.get(o.reference).projection?.src }
                      : o,
                  )}
                />
              ))}
            </svg>
          ) : (
            <p>No visible slides</p>
          )}
          <footer>
            <IconButton
              icon={ChevronLeft}
              label="Previous slide"
              disabled={presentIndex <= 0}
              onClick={() => setPresentIndex((i) => i - 1)}
            />
            <input
              aria-label="Presentation page"
              type="number"
              min={1}
              max={playable.length}
              value={presentIndex + 1}
              onChange={(e) =>
                setPresentIndex(
                  Math.min(playable.length - 1, Math.max(0, Number(e.target.value) - 1)),
                )
              }
            />
            <span>/ {playable.length}</span>
            <IconButton
              icon={ChevronRight}
              label="Next slide"
              disabled={presentIndex >= playable.length - 1}
              onClick={() => setPresentIndex((i) => i + 1)}
            />
            <IconButton icon={X} label="Exit presentation" onClick={() => setPresenting(false)} />
          </footer>
        </div>
      )}
    </>
  );
}
const LayerList = memo(
  function LayerList({
    objects,
    selected,
    choose,
    onPatch,
  }: {
    objects: SlideObject[];
    selected: string[];
    choose: (ids: string[]) => void;
    onPatch: (id: string, patch: Partial<SlideObject>) => void;
  }) {
    const [query, setQuery] = useState('');
    const byId = new Map(objects.map((object) => [object.id, object]));
    const search = query.toLowerCase();
    return (
      <>
        <input
          aria-label="Search layers"
          placeholder="Search layers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul
          className="layers"
          onClick={(event) => {
            const button =
              event.target instanceof Element
                ? event.target.closest('button[data-layer-action]')
                : null;
            const id = button?.closest('[data-layer-id]')?.getAttribute('data-layer-id');
            const object = id ? byId.get(id) : undefined;
            if (!object) return;
            const action = button?.getAttribute('data-layer-action');
            if (action === 'select')
              choose(event.shiftKey ? [...new Set([...selected, object.id])] : [object.id]);
            else if (action === 'lock') onPatch(object.id, { locked: !object.locked });
            else if (action === 'visibility') onPatch(object.id, { hidden: !object.hidden });
          }}
        >
          {objects
            .filter((o) => (o.text + o.type).toLowerCase().includes(search))
            .map((o, i) => (
              <LayerRow
                key={o.id}
                id={o.id}
                type={o.type}
                text={o.text || o.type}
                index={i}
                grouped={!!o.groupId}
                locked={!!o.locked}
                hidden={!!o.hidden}
                selected={selected.includes(o.id)}
              />
            ))}
        </ul>
      </>
    );
  },
  (before, after) =>
    isDeepFrozen(before.objects) &&
    isDeepFrozen(after.objects) &&
    before.choose === after.choose &&
    before.onPatch === after.onPatch &&
    before.selected.length === after.selected.length &&
    before.selected.every((id, index) => id === after.selected[index]) &&
    before.objects.length === after.objects.length &&
    before.objects.every((object, index) => {
      const next = after.objects[index];
      return (
        object.id === next.id &&
        object.type === next.type &&
        object.text === next.text &&
        object.groupId === next.groupId &&
        object.locked === next.locked &&
        object.hidden === next.hidden
      );
    }),
);
// Primitive props keep unchanged rows stable even when a native command must
// replace the containing array. Delegated actions above read the current state.
const LayerRow = memo(function LayerRow({
  id,
  type,
  text,
  index,
  grouped,
  locked,
  hidden,
  selected,
}: {
  id: string;
  type: SlideObjectType;
  text: string;
  index: number;
  grouped: boolean;
  locked: boolean;
  hidden: boolean;
  selected: boolean;
}) {
  return (
    <li data-layer-id={id} style={{ paddingLeft: grouped ? 14 : 0 }}>
      <button
        aria-label={`Select ${type} object ${index + 1}`}
        aria-pressed={selected}
        data-layer-action="select"
      >
        <Layers size={14} />
        {text}
      </button>
      <button aria-label={`Toggle lock ${index + 1}`} data-layer-action="lock">
        {locked ? 'Unlock' : 'Lock'}
      </button>
      <button aria-label={`Toggle visibility ${index + 1}`} data-layer-action="visibility">
        {hidden ? 'Show' : 'Hide'}
      </button>
    </li>
  );
});
function ChartEditor({
  chart,
  onChange,
}: {
  chart: ChartSnapshot;
  onChange: (c: ChartSnapshot) => void;
}) {
  const [draft, setDraft] = useState(
      chart.labels.map((label, i) => `${label}\t${chart.values[i]}`).join('\n'),
    ),
    [error, setError] = useState('');
  return (
    <>
      <CommitInput
        label="Chart title"
        value={chart.label}
        onCommit={(label) => onChange({ ...chart, label })}
      />
      <label className="ep-field">
        Label and value (tab-separated)
        <textarea
          aria-label="Chart data"
          rows={6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button
        onClick={() => {
          const rows = draft
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split('\t'));
          if (rows.some((r) => r.length !== 2 || !Number.isFinite(Number(r[1])))) {
            setError('Each row needs a label, a tab and a finite number.');
            return;
          }
          onChange({
            ...chart,
            labels: rows.map((r) => r[0]),
            values: rows.map((r) => Number(r[1])),
            capturedAt: new Date().toISOString(),
          });
          setError('');
        }}
      >
        Apply chart data
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function TableInspector({
  object,
  onChange,
}: {
  object: SlideObject;
  onChange: (table: NonNullable<SlideObject['table']>) => void;
}) {
  const table = object.table!,
    [row, setRow] = useState(0),
    [col, setCol] = useState(0),
    [rows, setRows] = useState(1),
    [cols, setCols] = useState(2);
  return (
    <Section title="Table">
      <div className="table-edit">
        {table.rows.map((r, ri) => (
          <div key={ri}>
            {r.map((v, ci) => (
              <CommitInput
                key={ci}
                label={`Cell ${ri + 1},${ci + 1}`}
                value={v}
                onCommit={(value) =>
                  onChange({
                    ...table,
                    rows: table.rows.map((r, i) =>
                      i === ri ? r.map((v, j) => (j === ci ? value : v)) : r,
                    ),
                  })
                }
              />
            ))}
          </div>
        ))}
      </div>
      <button
        onClick={() =>
          onChange({
            ...table,
            rows: [...table.rows, Array(table.rows[0].length).fill('')],
            rowHeights: undefined,
          })
        }
      >
        Add table row
      </button>
      <button
        onClick={() =>
          onChange({ ...table, rows: table.rows.map((r) => [...r, '']), columnWidths: undefined })
        }
      >
        Add table column
      </button>
      <div className="ep-fields">
        <CommitInput
          label="Table row"
          type="number"
          min={1}
          max={table.rows.length}
          value={row + 1}
          onCommit={(v) => setRow(Number(v) - 1)}
        />
        <CommitInput
          label="Table column"
          type="number"
          min={1}
          max={table.rows[0].length}
          value={col + 1}
          onCommit={(v) => setCol(Number(v) - 1)}
        />
        <CommitInput
          label="Merge rows"
          type="number"
          min={1}
          value={rows}
          onCommit={(v) => setRows(Number(v))}
        />
        <CommitInput
          label="Merge columns"
          type="number"
          min={1}
          value={cols}
          onCommit={(v) => setCols(Number(v))}
        />
      </div>
      <button
        disabled={table.rows.length <= 1}
        onClick={() =>
          onChange({
            ...table,
            rows: table.rows.filter((_, i) => i !== row),
            merges: [],
            rowHeights: undefined,
          })
        }
      >
        Delete table row
      </button>
      <button
        disabled={table.rows[0].length <= 1}
        onClick={() =>
          onChange({
            ...table,
            rows: table.rows.map((r) => r.filter((_, i) => i !== col)),
            merges: [],
            columnWidths: undefined,
          })
        }
      >
        Delete table column
      </button>
      <button
        onClick={() =>
          onChange({
            ...table,
            merges: [
              ...(table.merges ?? []).filter((m) => m.row !== row || m.col !== col),
              {
                row,
                col,
                rows: Math.min(rows, table.rows.length - row),
                cols: Math.min(cols, table.rows[0].length - col),
              },
            ],
          })
        }
      >
        Merge cells
      </button>
      <button
        onClick={() =>
          onChange({
            ...table,
            merges: (table.merges ?? []).filter((m) => m.row !== row || m.col !== col),
          })
        }
      >
        Split cell
      </button>
    </Section>
  );
}
