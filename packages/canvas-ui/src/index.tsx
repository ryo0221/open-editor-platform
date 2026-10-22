import './styles.css';
import { CanvasSpatialQuery } from './spatial-query';
import { CanvasTextEditor, CanvasTextContext } from './text-editor';
import { useCanvasFit, useCanvasWheel } from './stage-hooks';
import { stageDoubleClick, stageDrag, stageKeyDown, stagePointerDown } from './stage-input';
import {
  paintedTargets,
  pastePosition,
  selectionFrame,
  stageBoundsToFit,
  stageViewport,
  textEditingLayout,
  type GeometryPreview,
  type SnapGuide,
  type StageDrag,
  type StageEditing,
} from './stage-model';
import {
  CanvasGrid,
  FreehandPath,
  PresenceMarkers,
  SelectionOverlay,
  SnapGuides,
} from './stage-overlays';
import {
  useId,
  memo,
  createElement,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Hand, Minus, Plus, Scan, MousePointer2, Grid3X3 } from 'lucide-react';
import { IconButton, isTextInput, EditorHistoryContext } from '@editor-platform/editor-ui';
import { isDeepFrozen, canonicalJson } from '@editor-platform/artifact-core';
import {
  drawingPrimitives,
  screenToWorld,
  type Bounds,
  type Drawing,
  type GeometryItem,
  type Point,
  type SvgPrimitive,
  type TransformDelta,
  type TextStyle,
  type TextRun,
} from '@editor-platform/editor-core';
export * from './legacy';
export * from './visual-controls';
export * from './export';
export type { Bounds };
export const CanvasPresenceContext = createContext<
  { elementId: string; name: string; clientId: string }[]
>([]);
export interface CanvasTarget extends GeometryItem {
  label: string;
  /** Conservative world paint extent. Omit for unbounded/custom rendering. */
  paintBounds?: Bounds;
  text?: string;
  typography?: TextStyle;
  runs?: TextRun[];
  /** Exact native drawing used to share text fit/padding with the editor. */
  textDrawing?: Drawing;
  /** Private render hint for a text part within a compound native object. */
  editingTextId?: string;
  editableText?: boolean;
  hitBox?: boolean;
  container?: boolean;
  rotatable?: boolean;
  /** Domain-owned scoped text hits inside a native compound object. */
  textParts?: {
    id: string;
    drawingId: string;
    label: string;
    bounds: Bounds;
    rotation?: number;
    text: string;
    typography?: TextStyle;
    runs?: TextRun[];
    textDrawing?: Drawing;
  }[];
}
export interface CanvasView {
  zoom: number;
  pan: Point;
  fit: boolean;
  panMode: boolean;
  snap: boolean;
  grid: boolean;
}
export const initialCanvasView: CanvasView = {
  zoom: 1,
  pan: { x: 0, y: 0 },
  fit: true,
  panMode: false,
  snap: true,
  grid: true,
};
function svgReact(node: SvgPrimitive, key: number, onImageError?: () => void): ReactNode {
  const attrs: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(node.attrs))
    attrs[/^(data|aria)-/.test(k) ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
      v;
  return createElement(
    node.tag,
    { ...attrs, key, ...(node.tag === 'image' ? { onError: onImageError } : {}) },
    node.children?.map((child, i) =>
      typeof child === 'string' ? child : svgReact(child, i, onImageError),
    ),
  );
}
// Drawing projections are bounded plain data owned by the domain view. Comparing
// them directly avoids allocating two JSON strings for every unchanged object.
function sameDrawingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameDrawingValue(left[key], right[key]))
  );
}
const DrawingContents = memo(
  function DrawingContents({ drawing }: { drawing: Drawing }) {
    const id = useId().replaceAll(':', '');
    const [failedSource, setFailedSource] = useState<string>();
    if (drawing.kind === 'image' && drawing.src && failedSource === drawing.src) {
      const { x, y, width, height } = drawing.bounds;
      return (
        <g role="img" aria-label={`Image unavailable: ${drawing.alt ?? 'replace the image'}`}>
          <rect x={x} y={y} width={width} height={height} fill="#fff1f2" stroke="#be123c" />
          <text x={x + 8} y={y + Math.min(height / 2, 28)} fontSize={14} fill="#9f1239">
            Image unavailable — replace image
          </text>
        </g>
      );
    }
    return (
      <>
        {drawingPrimitives(drawing, id, { visibleTextOnly: true }).map((node, index) =>
          svgReact(node, index, () => setFailedSource(drawing.src)),
        )}
      </>
    );
  },
  (previous, next) => {
    // Domain projections are fresh objects even for unchanged elements. Compare their
    // bounded data before rebuilding text/SVG primitives during edits and pointer moves.
    return sameDrawingValue(previous.drawing, next.drawing);
  },
);
export const DrawingView = memo(
  function DrawingView({ drawing }: { drawing: Drawing }) {
    const { x, y } = drawing.bounds;
    // A move changes this translation, not every text span/path/image coordinate.
    // Frame clips use world coordinates too and must share the same local origin.
    // Size, rotation, clipping and content changes still rebuild the primitives.
    const local: Drawing = {
      ...drawing,
      bounds: { ...drawing.bounds, x: 0, y: 0 },
      ...(drawing.clipBounds
        ? {
            clipBounds: drawing.clipBounds.map((clip) => ({
              ...clip,
              x: clip.x - x,
              y: clip.y - y,
            })),
          }
        : {}),
    };
    return (
      <g transform={`translate(${x} ${y})`}>
        <DrawingContents drawing={local} />
      </g>
    );
  },
  (previous, next) => sameDrawingValue(previous.drawing, next.drawing),
);
export function CanvasControls({
  view,
  onChange,
  onFit,
  fitLabel = 'Fit page',
  minZoom = 0.05,
}: {
  view: CanvasView;
  onChange: (v: CanvasView) => void;
  onFit: () => void;
  fitLabel?: string;
  minZoom?: number;
}) {
  return (
    <>
      <IconButton
        icon={view.panMode ? Hand : MousePointer2}
        label="Pan canvas"
        shortcut="Space"
        aria-pressed={view.panMode}
        onClick={() => onChange({ ...view, panMode: !view.panMode })}
      />
      <IconButton
        icon={Minus}
        label="Zoom out"
        onClick={() => onChange({ ...view, fit: false, zoom: Math.max(minZoom, view.zoom / 1.2) })}
      />
      <select
        aria-label="Canvas zoom"
        value={String(view.zoom)}
        onChange={(e) => onChange({ ...view, fit: false, zoom: Number(e.target.value) })}
      >
        <option value={view.zoom}>{Number((view.zoom * 100).toFixed(1))}%</option>
        {[0.25, 0.5, 1, 2, 4]
          .filter((z) => z !== view.zoom)
          .map((z) => (
            <option key={z} value={z}>
              {z * 100}%
            </option>
          ))}
      </select>
      <IconButton
        icon={Plus}
        label="Zoom in"
        onClick={() => onChange({ ...view, fit: false, zoom: Math.min(8, view.zoom * 1.2) })}
      />
      <IconButton icon={Scan} label={fitLabel} shortcut="Shift+1" onClick={onFit} />
      <IconButton
        icon={Grid3X3}
        label="Snap and grid"
        aria-pressed={view.snap}
        onClick={() => onChange({ ...view, snap: !view.snap, grid: !view.grid })}
      />
    </>
  );
}
export interface CanvasStageProps {
  label: string;
  targets: CanvasTarget[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onTransform: (ids: string[], change: TransformDelta) => void;
  /** Domain-owned preview: Frame layout and Section resize must not use Group scaling. */
  previewTransform?: (
    ids: string[],
    change: TransformDelta,
  ) => Map<string, { bounds: Bounds; rotation: number }>;
  onDelete: () => void;
  render: (target: CanvasTarget) => ReactNode;
  underlay?: ReactNode | ((targets: CanvasTarget[]) => ReactNode);
  /** Domain interaction controls above painted objects, in the same world coordinates. */
  overlay?: ReactNode | ((targets: CanvasTarget[]) => ReactNode);
  readOnly?: boolean;
  width?: number;
  height?: number;
  background?: string;
  space?: 'page' | 'infinite';
  fitBounds?: Bounds;
  view?: CanvasView;
  onViewChange?: (view: CanvasView) => void;
  hideControls?: boolean;
  /** Cull only bounded offscreen drawings; all targets retain interaction semantics. */
  virtualize?: boolean;
  onEditText?: (
    id: string,
    text: string,
    runs: TextRun[],
    base?: { text: string; runs?: TextRun[] },
  ) => void | boolean;
  onAction?: (action: string) => void;
  onImage?: (file: File, position: Point) => void;
  onPage?: (delta: number) => void;
  onContext?: (position: Point) => void;
  onInsert?: (bounds: Bounds) => void;
  insertion?: boolean;
  onFreehand?: (points: Point[]) => void;
  freehand?: boolean;
}
const CanvasObject = memo(
  function CanvasObject({
    target,
    preview,
    selected,
    editing,
    render,
  }: {
    target: CanvasTarget;
    preview?: { bounds: Bounds; rotation: number };
    selected: boolean;
    editing: boolean;
    render: CanvasStageProps['render'];
  }) {
    const projected = { ...target, ...preview };
    return (
      <g
        role="button"
        aria-label={target.label}
        aria-description={
          target.text || target.textParts?.map((part) => part.text).join('\n') || undefined
        }
        aria-pressed={selected}
        tabIndex={-1}
        data-canvas-target={target.id}
      >
        {target.hitBox && <rect {...projected.bounds} fill="transparent" />}
        <g visibility={editing ? 'hidden' : undefined}>{render(projected)}</g>
      </g>
    );
  },
  // Hosts may reuse mutable target objects. Only an owned immutable projection
  // can safely skip rendering; a new render callback must always be honored.
  (before, after) =>
    isDeepFrozen(before.target) &&
    before.target === after.target &&
    before.preview === after.preview &&
    before.selected === after.selected &&
    before.editing === after.editing &&
    before.render === after.render,
);
function CanvasTextEditing(props: {
  editing: StageEditing;
  targets: CanvasTarget[];
  size: { width: number; height: number };
  view: CanvasView;
  readOnly: boolean;
  textBridge: React.ContextType<typeof CanvasTextContext>;
  toolsContainer: HTMLDivElement | null;
  setEditing(editing: StageEditing | undefined): void;
  onEditText: CanvasStageProps['onEditText'];
  onDone(): void;
}) {
  const { editing, targets, view, setEditing } = props;
  const root = targets.find((t) => t.id === editing.id);
  const t = root ?? targets.flatMap((t) => t.textParts ?? []).find((t) => t.id === editing.id);
  if (!t) return null;
  const { original, drawing, anchor } = textEditingLayout(t, editing, props.size, view);
  return (
    <g
      transform={
        editing.expanded
          ? undefined
          : `translate(${view.pan.x} ${view.pan.y}) scale(${view.zoom}) rotate(${t.rotation ?? 0} ${t.bounds.x + t.bounds.width / 2} ${t.bounds.y + t.bounds.height / 2})`
      }
    >
      {root && !editing.expanded && (
        <DrawingView
          drawing={{
            ...original,
            bounds: t.bounds,
            rotation: 0,
            text: '',
            runs: undefined,
          }}
        />
      )}
      <foreignObject
        {...drawing.bounds}
        className={editing.expanded ? 'ep-canvas-text-expanded' : 'ep-canvas-text-in-place'}
      >
        <CanvasTextContext.Provider value={root ? props.textBridge : undefined}>
          <CanvasTextEditor
            elementId={editing.id}
            text={editing.text}
            runs={editing.runs}
            style={original.typography}
            drawing={drawing}
            caret={editing.caret}
            toolsContainer={props.toolsContainer}
            toolsPosition={editing.expanded ? { x: 16, y: 16 } : anchor}
            expanded={editing.expanded}
            onExpand={() => setEditing({ ...editing, expanded: !editing.expanded })}
            stale={
              canonicalJson([t.text, t.runs ?? null]) !==
              canonicalJson([editing.text, editing.runs ?? null])
            }
            readOnly={props.readOnly}
            onCommit={(text, runs) => {
              if (
                props.onEditText?.(editing.id, text, runs, {
                  text: editing.text,
                  runs: editing.runs,
                }) === false
              )
                return false;
              setEditing(undefined);
              props.onDone();
            }}
            onCancel={() => {
              setEditing(undefined);
              props.onDone();
            }}
          />
        </CanvasTextContext.Provider>
      </foreignObject>
    </g>
  );
}
export function CanvasStage({
  label,
  targets,
  selected,
  onSelect,
  onTransform,
  previewTransform,
  onDelete,
  render,
  underlay,
  overlay,
  readOnly = false,
  width = 1000,
  height = 620,
  background = '#fff',
  space = 'page',
  fitBounds,
  view: externalView,
  onViewChange,
  hideControls,
  virtualize = false,
  onEditText,
  onAction,
  onImage,
  onPage,
  onContext,
  onInsert,
  insertion,
  onFreehand,
  freehand,
}: CanvasStageProps) {
  const spatial = useRef<CanvasSpatialQuery | undefined>(undefined);
  spatial.current ??= new CanvasSpatialQuery();
  useEffect(() => () => spatial.current?.dispose(), []);
  const presences = useContext(CanvasPresenceContext);
  const textBridge = useContext(CanvasTextContext);
  const history = useContext(EditorHistoryContext);
  const [groupScope, setGroupScope] = useState<string>();
  const [localView, setLocalView] = useState<CanvasView>(initialCanvasView),
    view = externalView ?? localView;
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = (next: CanvasView) => {
    setLocalView(next);
    onViewChange?.(next);
  };
  const setter = useRef(setView);
  setter.current = setView;
  const ref = useRef<SVGSVGElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const [preview, setPreview] = useState<GeometryPreview>();
  const [marquee, setMarquee] = useState<Bounds>();
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [path, setPath] = useState<Point[]>([]);
  const [editing, setEditing] = useState<StageEditing>();
  const spaceHeld = useRef(false);
  const drag = useRef<StageDrag | null>(null);
  const fit = useCanvasFit({
    svg: ref,
    viewRef,
    setter,
    space,
    fit: view.fit,
    width,
    height,
    bounds: stageBoundsToFit(fitBounds, space, targets, width, height),
    onSize: setSize,
  });
  useCanvasWheel(ref, viewRef, setter, space);
  const world = (e: { clientX: number; clientY: number }) => {
    const rect = ref.current!.getBoundingClientRect();
    return screenToWorld(
      { x: e.clientX, y: e.clientY },
      { x: rect.x, y: rect.y },
      viewRef.current.pan,
      viewRef.current.zoom,
    );
  };
  const { begin, cancel, move } = stageDrag({
    drag,
    svg: ref,
    spatial,
    editing,
    readOnly,
    view,
    targets,
    selected,
    world,
    setView,
    setPreview,
    setMarquee,
    setGuides,
    setPath,
    onSelect,
    onTransform,
    previewTransform,
    onInsert,
    onFreehand,
  });
  // Delegate object events to the SVG. Repeated geometry edits need not allocate
  // and install a pair of closures on every object; handlers resolve current data.
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const eventTarget = (node: EventTarget | null) => {
    const id =
      node instanceof Element
        ? node.closest('[data-canvas-target]')?.getAttribute('data-canvas-target')
        : null;
    return id ? targetById.get(id) : undefined;
  };
  const visible = targets.filter((t) => !t.hidden);
  const { rotation: selectionRotation, box } = selectionFrame(visible, selected, preview);
  const { viewportBounds, paintViewport } = stageViewport(view, size);
  const backgroundBounds = space === 'infinite' ? viewportBounds : { x: 0, y: 0, width, height };
  const rendered = virtualize
    ? paintedTargets(visible, { preview, selected, editing, paintViewport })
    : visible;
  const projected = () => targets.map((t) => ({ ...t, ...preview?.get(t.id) }));
  return (
    <div className="canvas-stage" ref={stage}>
      <svg
        ref={ref}
        className="editor-canvas"
        role="application"
        aria-label={label}
        tabIndex={0}
        viewBox={`0 0 ${size.width} ${size.height}`}
        onDragOver={(e) => {
          if (onImage) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!readOnly && e.dataTransfer.files[0]) onImage?.(e.dataTransfer.files[0], world(e));
        }}
        onPaste={(e) => {
          if (isTextInput(e.target)) return;
          const file = Array.from(e.clipboardData.items)
            .find((i) => i.type.startsWith('image/'))
            ?.getAsFile();
          if (file && !readOnly) {
            e.preventDefault();
            onImage?.(file, pastePosition(space, size, view, width, height));
          }
        }}
        onContextMenu={(e) => {
          if (onContext) {
            e.preventDefault();
            onContext({ x: e.clientX, y: e.clientY });
          }
        }}
        onDoubleClick={(e) =>
          stageDoubleClick(e, {
            hit: eventTarget(e.target),
            point: () => world(e),
            readOnly,
            targets,
            groupScope,
            setEditing,
            setGroupScope,
            onSelect,
            onAction,
          })
        }
        onPointerDown={(e) => {
          // Scrolling the canvas into view here would move the second click of a double-click.
          if (!isTextInput(e.target)) ref.current?.focus({ preventScroll: true });
          stagePointerDown(e, {
            hit: eventTarget(e.target),
            targets,
            selected,
            groupScope,
            readOnly,
            panning: view.panMode || spaceHeld.current || e.button === 1,
            insertion,
            freehand,
            onSelect,
            begin,
          });
        }}
        onPointerMove={(e) => move(e)}
        onPointerUp={(e) => move(e, true)}
        onPointerCancel={cancel}
        onKeyUp={(e) => {
          if (e.key === ' ') spaceHeld.current = false;
        }}
        onBlur={() => {
          spaceHeld.current = false;
        }}
        onKeyDown={(e) =>
          stageKeyDown(e, {
            history,
            readOnly,
            selected,
            targets,
            spaceHeld,
            escape: () => {
              setGroupScope(undefined);
              cancel();
              setEditing(undefined);
            },
            fit,
            onPage,
            onSelect,
            onAction,
            onDelete,
            onTransform,
          })
        }
      >
        <g transform={`translate(${view.pan.x} ${view.pan.y}) scale(${view.zoom})`}>
          <rect {...backgroundBounds} fill={background} data-space={space} />
          {view.grid && <CanvasGrid label={label} bounds={backgroundBounds} />}
          {typeof underlay === 'function' ? underlay(projected()) : underlay}
          {rendered.map((t) => (
            <CanvasObject
              key={t.id}
              target={
                editing && t.textParts?.some((part) => part.id === editing.id)
                  ? { ...t, editingTextId: editing.id }
                  : t
              }
              preview={preview?.get(t.id)}
              selected={selected.includes(t.id)}
              editing={editing?.id === t.id}
              render={render}
            />
          ))}
          {typeof overlay === 'function' ? overlay(projected()) : overlay}
          <PresenceMarkers presences={presences} targets={targets} zoom={view.zoom} />
          {selected.length > 0 && !readOnly && !editing && (
            <SelectionOverlay
              box={box}
              rotation={selectionRotation}
              zoom={view.zoom}
              selected={selected}
              targets={targets}
              onBegin={(e, mode, handle) => begin(e, mode, selected, handle)}
            />
          )}
          {marquee && (
            <rect
              {...marquee}
              fill="#3267c818"
              stroke="#3267c8"
              strokeWidth={1 / view.zoom}
              pointerEvents="none"
            />
          )}
          <SnapGuides guides={guides} zoom={view.zoom} />
          {path.length > 0 && <FreehandPath path={path} />}
        </g>
        {editing && (
          <CanvasTextEditing
            editing={editing}
            targets={targets}
            size={size}
            view={view}
            readOnly={readOnly}
            textBridge={textBridge}
            toolsContainer={stage.current}
            setEditing={setEditing}
            onEditText={onEditText}
            onDone={() => ref.current?.focus()}
          />
        )}
      </svg>
      {!hideControls && (
        <div className="canvas-navigation">
          <CanvasControls view={view} onChange={setView} onFit={fit} />
        </div>
      )}
    </div>
  );
}
export * from './layers';

export { CanvasTextContext, type CanvasTextBridge } from './text-editor';
