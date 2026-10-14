import './styles.css';
import { CanvasSpatialQuery } from './spatial-query';
import { CanvasTextEditor, CanvasTextContext } from './text-editor';
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
import { isDeepFrozen, clone, canonicalJson } from '@editor-platform/artifact-core';
import {
  descendantIds,
  drawingPrimitives,
  intersectsRotated,
  resizedRotatedBounds,
  screenToWorld,
  selectedRoots,
  snapBounds,
  transformGeometry,
  unionBounds,
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
        {drawingPrimitives(drawing, id).map((node, index) =>
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
  const [preview, setPreview] = useState<Map<string, { bounds: Bounds; rotation: number }>>();
  const [marquee, setMarquee] = useState<Bounds>();
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; value: number }[]>([]);
  const [path, setPath] = useState<Point[]>([]);
  const [editing, setEditing] = useState<{
    id: string;
    text: string;
    runs?: TextRun[];
    caret: Point;
    expanded?: boolean;
  }>();
  const spaceHeld = useRef(false);
  const drag = useRef<{
    mode: string;
    start: Point;
    world: Point;
    ids: string[];
    box: Bounds;
    pan: Point;
    zoom: number;
    handle: string;
    angle: number;
    rotation: number;
    path: Point[];
    shift: boolean;
    moved?: boolean;
  } | null>(null);
  const boundsToFit =
    fitBounds ??
    (space === 'infinite'
      ? unionBounds(targets.filter((t) => !t.hidden).map((t) => t.bounds))
      : { x: 0, y: 0, width, height });
  const fit = () => {
    const current = viewRef.current,
      box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const z = Math.max(
      space === 'infinite' ? 0.001 : 0.05,
      Math.min(8, (box.width - 48) / boundsToFit.width, (box.height - 48) / boundsToFit.height),
    );
    setter.current({
      ...current,
      zoom: z,
      pan: {
        x: (box.width - boundsToFit.width * z) / 2 - boundsToFit.x * z,
        y: (box.height - boundsToFit.height * z) / 2 - boundsToFit.y * z,
      },
      fit: true,
    });
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const svg = ref.current!;
    const resize = new ResizeObserver(() => {
      const box = svg.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
      if (viewRef.current.fit) fitRef.current();
    });
    resize.observe(svg);
    return () => resize.disconnect();
  }, [width, height]);
  useEffect(() => {
    if (view.fit) fit();
  }, [
    view.fit,
    width,
    height,
    boundsToFit.x,
    boundsToFit.y,
    boundsToFit.width,
    boundsToFit.height,
  ]);
  useEffect(() => {
    const svg = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current,
        rect = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const zoom = Math.min(
            8,
            Math.max(space === 'infinite' ? 0.001 : 0.05, v.zoom * Math.exp(-e.deltaY * 0.005)),
          ),
          world = screenToWorld(
            { x: e.clientX, y: e.clientY },
            { x: rect.x, y: rect.y },
            v.pan,
            v.zoom,
          );
        setter.current({
          ...v,
          zoom,
          fit: false,
          pan: { x: e.clientX - rect.x - world.x * zoom, y: e.clientY - rect.y - world.y * zoom },
        });
      } else
        setter.current({ ...v, fit: false, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } });
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, []);
  const world = (e: { clientX: number; clientY: number }) => {
    const rect = ref.current!.getBoundingClientRect();
    return screenToWorld(
      { x: e.clientX, y: e.clientY },
      { x: rect.x, y: rect.y },
      viewRef.current.pan,
      viewRef.current.zoom,
    );
  };
  function begin(e: React.PointerEvent, mode: string, ids: string[], handle = '') {
    if (editing || (readOnly && mode !== 'pan')) return;
    e.preventDefault();
    e.stopPropagation();
    ref.current?.focus();
    const point = world(e);
    const roots = selectedRoots(targets, ids),
      box = unionBounds(roots.map((t) => t.bounds));
    drag.current = {
      mode,
      start: { x: e.clientX, y: e.clientY },
      world: point,
      ids,
      box,
      pan: { ...view.pan },
      zoom: view.zoom,
      handle,
      angle: Math.atan2(point.y - box.y - box.height / 2, point.x - box.x - box.width / 2),
      rotation: roots.length === 1 ? (roots[0].rotation ?? 0) : 0,
      path: [point],
      shift: e.shiftKey,
    };
    // Capture on the object wrapper even though its handler is delegated. Native
    // click/double-click targets follow pointer capture; capturing on the SVG
    // would lose the object that should enter text/group editing on double-click.
    const object =
      e.target instanceof Element ? e.target.closest<SVGGElement>('[data-canvas-target]') : null;
    (object ?? e.currentTarget).setPointerCapture(e.pointerId);
  }
  const cancel = () => {
    if (drag.current?.mode === 'pan') setView({ ...view, pan: drag.current.pan });
    drag.current = null;
    setPreview(undefined);
    setMarquee(undefined);
    setGuides([]);
    setPath([]);
  };
  function move(e: React.PointerEvent, commit = false) {
    const d = drag.current;
    if (!d) return;
    // A click/double-click selects or opens text; it must not snap/normalize geometry.
    if (['move', 'resize', 'rotate'].includes(d.mode)) {
      d.moved ||= Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) >= 3;
      if (!d.moved) {
        if (commit) {
          drag.current = null;
          setPreview(undefined);
          setGuides([]);
        }
        return;
      }
    }
    const point = world(e),
      dx = point.x - d.world.x,
      dy = point.y - d.world.y;
    let change: TransformDelta = { dx, dy, dw: 0, dh: 0 };
    if (d.mode === 'pan') {
      setView({
        ...view,
        fit: false,
        pan: { x: d.pan.x + e.clientX - d.start.x, y: d.pan.y + e.clientY - d.start.y },
      });
    } else if (d.mode === 'pen') {
      d.path.push(point);
      setPath([...d.path]);
      if (commit && d.path.length > 1) onFreehand?.(d.path);
    } else if (d.mode === 'marquee' || d.mode === 'insert') {
      const b = {
        x: Math.min(d.world.x, point.x),
        y: Math.min(d.world.y, point.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
      if (e.shiftKey && d.mode === 'insert') b.height = b.width;
      setMarquee(b);
      if (commit) {
        if (d.mode === 'insert')
          onInsert?.(b.width < 3 ? { x: point.x, y: point.y, width: 180, height: 120 } : b);
        else
          onSelect(
            b.width + b.height < 4
              ? []
              : [
                  ...new Set([
                    ...(d.shift ? selected : []),
                    ...spatial.current!.query(targets, b).map((t) => t.id),
                  ]),
                ],
          );
      }
    } else {
      if (d.mode === 'resize') {
        const b = resizedRotatedBounds(d.box, d.rotation, d.handle, dx, dy, e.shiftKey);
        change = {
          dx: b.x - d.box.x,
          dy: b.y - d.box.y,
          dw: b.width - d.box.width,
          dh: b.height - d.box.height,
        };
      } else if (d.mode === 'rotate') {
        let angle =
          ((Math.atan2(point.y - d.box.y - d.box.height / 2, point.x - d.box.x - d.box.width / 2) -
            d.angle) *
            180) /
          Math.PI;
        if (e.shiftKey) angle = Math.round(angle / 15) * 15;
        change = { dx: 0, dy: 0, dw: 0, dh: 0, rotation: angle };
      } else if (view.snap && !e.altKey) {
        const all = descendantIds(targets, d.ids);
        const snapped = snapBounds(
          { ...d.box, x: d.box.x + dx, y: d.box.y + dy },
          targets.filter((t) => !all.has(t.id) && !t.hidden).map((t) => t.bounds),
          6 / view.zoom,
          view.grid ? 10 : 0,
        );
        change.dx = snapped.bounds.x - d.box.x;
        change.dy = snapped.bounds.y - d.box.y;
        setGuides(snapped.guides);
      }
      try {
        if (commit) {
          if (Object.values(change).some((v) => Math.abs(v) > 0.01)) onTransform(d.ids, change);
        } else
          setPreview(
            (previewTransform ?? ((ids, delta) => transformGeometry(targets, ids, delta)))(
              d.ids,
              change,
            ),
          );
      } catch {
        /* domain command reports locked selections; no partial preview */
      }
    }
    if (commit) {
      drag.current = null;
      setPreview(undefined);
      setMarquee(undefined);
      setGuides([]);
      setPath([]);
    }
  }
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
  const selectionRoots = selectedRoots(visible, selected);
  const selectionRotation =
    selectionRoots.length === 1
      ? (preview?.get(selectionRoots[0].id)?.rotation ?? selectionRoots[0].rotation ?? 0)
      : 0;
  const box = unionBounds(selectionRoots.map((t) => preview?.get(t.id)?.bounds ?? t.bounds));
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const viewportBounds = {
    x: -view.pan.x / view.zoom,
    y: -view.pan.y / view.zoom,
    width: size.width / view.zoom,
    height: size.height / view.zoom,
  };
  const backgroundBounds = space === 'infinite' ? viewportBounds : { x: 0, y: 0, width, height };
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
            onImage?.(
              file,
              space === 'infinite'
                ? {
                    x: (size.width / 2 - view.pan.x) / view.zoom,
                    y: (size.height / 2 - view.pan.y) / view.zoom,
                  }
                : { x: width / 2 - 100, y: height / 2 - 80 },
            );
          }
        }}
        onContextMenu={(e) => {
          if (onContext) {
            e.preventDefault();
            onContext({ x: e.clientX, y: e.clientY });
          }
        }}
        onDoubleClick={(e) => {
          const t = eventTarget(e.target);
          if (!t) return;
          e.stopPropagation();
          const partId = (e.target as Element)
            .closest('[data-canvas-text-target]')
            ?.getAttribute('data-canvas-text-target');
          const point = world(e);
          const part =
            t.textParts?.find((p) => p.id === partId) ??
            [...(t.textParts ?? [])]
              .reverse()
              .find((p) =>
                intersectsRotated({ ...point, width: 0, height: 0 }, p.bounds, p.rotation),
              );
          if (part && !readOnly && !t.locked) {
            setEditing({
              id: part.id,
              text: part.text,
              runs: clone(part.runs),
              caret: { x: e.clientX, y: e.clientY },
            });
            return;
          }
          const parent = targets.find((p) => p.id === t.parentId && p.container);
          if (parent && groupScope !== parent.id) {
            setGroupScope(parent.id);
            onSelect([t.id]);
            return;
          }
          if (t.container) {
            setGroupScope(t.id);
            onSelect([]);
            return;
          }
          if (t.editableText && !readOnly && !t.locked)
            setEditing({
              id: t.id,
              text: t.text ?? '',
              runs: clone(t.runs),
              caret: { x: e.clientX, y: e.clientY },
            });
          else onAction?.('enter-group');
        }}
        onPointerDown={(e) => {
          if (!isTextInput(e.target)) ref.current?.focus();
          const t = eventTarget(e.target);
          if (t && !insertion && !freehand) {
            if (view.panMode || spaceHeld.current || e.button === 1) {
              begin(e, 'pan', []);
              return;
            }
            e.stopPropagation();
            const parent = targets.find((p) => p.id === t.parentId);
            let target = parent?.container && parent.id !== groupScope ? parent : t;
            let ancestor = targets.find((p) => p.id === target.parentId && p.container);
            while (ancestor && ancestor.id !== groupScope) {
              target = ancestor;
              ancestor = targets.find((p) => p.id === target.parentId && p.container);
            }
            const ids = e.shiftKey
              ? selected.includes(target.id)
                ? selected.filter((id) => id !== target.id)
                : [...selected, target.id]
              : selected.includes(target.id)
                ? selected
                : [target.id];
            onSelect(ids);
            if (!readOnly && !t.locked) begin(e, 'move', ids);

            return;
          }
          begin(
            e,
            view.panMode || spaceHeld.current || e.button === 1
              ? 'pan'
              : freehand
                ? 'pen'
                : insertion
                  ? 'insert'
                  : 'marquee',
            [],
          );
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
        onKeyDown={(e) => {
          if (isTextInput(e.target) || e.nativeEvent.isComposing) return;
          if (
            history &&
            !readOnly &&
            (e.ctrlKey || e.metaKey) &&
            ['z', 'y'].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey || e.key.toLowerCase() === 'y') history.redo();
            else history.undo();
            return;
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            setGroupScope(undefined);
            cancel();
            setEditing(undefined);
            return;
          }
          if (e.key === ' ') {
            spaceHeld.current = true;
            e.preventDefault();
            return;
          }
          if (e.shiftKey && (e.key === '1' || e.key === '!')) {
            fit();
            return;
          }
          if (['PageUp', 'PageDown'].includes(e.key)) {
            e.preventDefault();
            onPage?.(e.key === 'PageUp' ? -1 : 1);
            return;
          }
          if (readOnly) return;
          if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            onSelect(targets.filter((t) => !t.hidden && !t.locked).map((t) => t.id));
            return;
          }
          if ((e.metaKey || e.ctrlKey) && ['c', 'x', 'v', 'd', 'g'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            onAction?.(
              (
                {
                  c: 'copy',
                  x: 'cut',
                  v: 'paste',
                  d: 'duplicate',
                  g: e.shiftKey ? 'ungroup' : 'group',
                } as Record<string, string>
              )[e.key.toLowerCase()],
            );
            return;
          }
          if (['Delete', 'Backspace'].includes(e.key)) {
            e.preventDefault();
            onDelete();
          }
          if (e.key.startsWith('Arrow') && selected.length) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            onTransform(selected, {
              dx: e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
              dy: e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
              dw: 0,
              dh: 0,
            });
          }
        }}
      >
        <g transform={`translate(${view.pan.x} ${view.pan.y}) scale(${view.zoom})`}>
          <rect {...backgroundBounds} fill={background} data-space={space} />
          {view.grid && (
            <>
              <defs>
                <pattern
                  id={`${label.replaceAll(' ', '')}-dots`}
                  width="20"
                  height="20"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="1" cy="1" r=".6" fill="#ccd2dc" />
                </pattern>
              </defs>
              <rect {...backgroundBounds} fill={`url(#${label.replaceAll(' ', '')}-dots)`} />
            </>
          )}
          {typeof underlay === 'function'
            ? underlay(targets.map((t) => ({ ...t, ...preview?.get(t.id) })))
            : underlay}
          {visible.map((t) => (
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
          {typeof overlay === 'function'
            ? overlay(targets.map((t) => ({ ...t, ...preview?.get(t.id) })))
            : overlay}
          {presences.map((presence) => {
            const target = targets.find((t) => t.id === presence.elementId);
            return target ? (
              <g key={presence.clientId} pointerEvents="none" data-presence={presence.name}>
                <rect
                  {...target.bounds}
                  fill="none"
                  stroke="#8b5cf6"
                  strokeWidth={2 / view.zoom}
                  strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`}
                />
                <text
                  x={target.bounds.x}
                  y={target.bounds.y - 5 / view.zoom}
                  fill="#6d28d9"
                  fontSize={12 / view.zoom}
                >
                  {presence.name}
                </text>
              </g>
            ) : null;
          })}
          {selected.length > 0 && !readOnly && !editing && (
            <g
              className="selection-overlay"
              transform={`rotate(${selectionRotation} ${box.x + box.width / 2} ${box.y + box.height / 2})`}
            >
              <rect
                {...box}
                fill="none"
                stroke="#3267c8"
                strokeWidth={1 / view.zoom}
                pointerEvents="none"
              />
              {handles.map((handle) => {
                const x = handle.includes('w')
                    ? box.x
                    : handle.includes('e')
                      ? box.x + box.width
                      : box.x + box.width / 2,
                  y = handle.includes('n')
                    ? box.y
                    : handle.includes('s')
                      ? box.y + box.height
                      : box.y + box.height / 2,
                  sz = 8 / view.zoom;
                return (
                  <rect
                    key={handle}
                    role="button"
                    aria-label={`Resize ${handle === 'se' && selected.length === 1 ? targets.find((t) => t.id === selected[0])?.label : handle}`}
                    x={x - sz / 2}
                    y={y - sz / 2}
                    width={sz}
                    height={sz}
                    fill="white"
                    stroke="#3267c8"
                    strokeWidth={1 / view.zoom}
                    style={{ cursor: `${handle}-resize` }}
                    onPointerDown={(e) => begin(e, 'resize', selected, handle)}
                  />
                );
              })}
              {selected.every((id) => targets.find((t) => t.id === id)?.rotatable !== false) && (
                <>
                  <line
                    x1={box.x + box.width / 2}
                    x2={box.x + box.width / 2}
                    y1={box.y}
                    y2={box.y - 24 / view.zoom}
                    stroke="#3267c8"
                    strokeWidth={1 / view.zoom}
                    pointerEvents="none"
                  />
                  <circle
                    role="button"
                    aria-label="Rotate selection"
                    cx={box.x + box.width / 2}
                    cy={box.y - 26 / view.zoom}
                    r={5 / view.zoom}
                    fill="white"
                    stroke="#3267c8"
                    strokeWidth={1 / view.zoom}
                    onPointerDown={(e) => begin(e, 'rotate', selected)}
                  />
                </>
              )}
            </g>
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
          {guides.map((g, i) => (
            <line
              key={i}
              x1={g.axis === 'x' ? g.value : -10000}
              x2={g.axis === 'x' ? g.value : 10000}
              y1={g.axis === 'y' ? g.value : -10000}
              y2={g.axis === 'y' ? g.value : 10000}
              stroke="#d45092"
              strokeWidth={1 / view.zoom}
              pointerEvents="none"
            />
          ))}
          {path.length > 0 && (
            <path
              d={path.map((v, i) => `${i ? 'L' : 'M'}${v.x} ${v.y}`).join(' ')}
              fill="none"
              stroke="#3267c8"
              strokeWidth={3}
            />
          )}
        </g>
        {editing &&
          (() => {
            const root = targets.find((t) => t.id === editing.id);
            const t =
              root ?? targets.flatMap((t) => t.textParts ?? []).find((t) => t.id === editing.id);
            if (!t) return null;
            const original = t.textDrawing ?? {
              id: t.id,
              kind: 'text' as const,
              bounds: t.bounds,
              text: t.text,
              runs: t.runs,
              typography: t.typography,
              fill: '#253044',
            };
            const expandedBox = {
              x: 16,
              y: 56,
              width: Math.max(120, Math.min(640, size.width - 32)),
              height: Math.max(120, Math.min(360, size.height - 96)),
            };
            const drawing: Drawing = {
              ...original,
              bounds: editing.expanded ? expandedBox : t.bounds,
              typography: editing.expanded
                ? { ...original.typography, overflow: 'expand', verticalAlign: 'top' }
                : original.typography,
              text: editing.text,
              runs: editing.runs,
            };
            const anchor = {
              x: Math.max(8, Math.min(size.width - 300, view.pan.x + t.bounds.x * view.zoom)),
              y: Math.max(8, view.pan.y + t.bounds.y * view.zoom - 40),
            };
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
                  className={
                    editing.expanded ? 'ep-canvas-text-expanded' : 'ep-canvas-text-in-place'
                  }
                >
                  <CanvasTextContext.Provider value={root ? textBridge : undefined}>
                    <CanvasTextEditor
                      elementId={editing.id}
                      text={editing.text}
                      runs={editing.runs}
                      style={original.typography}
                      drawing={drawing}
                      caret={editing.caret}
                      toolsContainer={stage.current}
                      toolsPosition={editing.expanded ? { x: 16, y: 16 } : anchor}
                      expanded={editing.expanded}
                      onExpand={() => setEditing({ ...editing, expanded: !editing.expanded })}
                      stale={
                        canonicalJson([t.text, t.runs ?? null]) !==
                        canonicalJson([editing.text, editing.runs ?? null])
                      }
                      readOnly={readOnly}
                      onCommit={(text, runs) => {
                        if (
                          onEditText?.(editing.id, text, runs, {
                            text: editing.text,
                            runs: editing.runs,
                          }) === false
                        )
                          return false;
                        setEditing(undefined);
                        ref.current?.focus();
                      }}
                      onCancel={() => {
                        setEditing(undefined);
                        ref.current?.focus();
                      }}
                    />
                  </CanvasTextContext.Provider>
                </foreignObject>
              </g>
            );
          })()}
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
