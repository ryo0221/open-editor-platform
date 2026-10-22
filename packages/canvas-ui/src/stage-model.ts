import {
  descendantIds,
  intersectsRotated,
  resizedRotatedBounds,
  screenToWorld,
  selectedRoots,
  snapBounds,
  unionBounds,
  type Bounds,
  type Drawing,
  type Point,
  type TextRun,
  type TransformDelta,
} from '@editor-platform/editor-core';
import type { CanvasTarget, CanvasView } from './index';

export type GeometryPreview = Map<string, { bounds: Bounds; rotation: number }>;
export type SnapGuide = { axis: 'x' | 'y'; value: number };
export interface StageEditing {
  id: string;
  text: string;
  runs?: TextRun[];
  caret: Point;
  expanded?: boolean;
}
export interface StageDrag {
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
}
type Size = { width: number; height: number };
type Space = 'page' | 'infinite';

export const selectionHandles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function minimumZoom(space: Space) {
  return space === 'infinite' ? 0.001 : 0.05;
}

export function fitCanvasView(
  current: CanvasView,
  box: Size,
  bounds: Bounds,
  space: Space,
): CanvasView {
  const z = Math.max(
    minimumZoom(space),
    Math.min(8, (box.width - 48) / bounds.width, (box.height - 48) / bounds.height),
  );
  return {
    ...current,
    zoom: z,
    pan: {
      x: (box.width - bounds.width * z) / 2 - bounds.x * z,
      y: (box.height - bounds.height * z) / 2 - bounds.y * z,
    },
    fit: true,
  };
}

export function wheelCanvasView(
  v: CanvasView,
  e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaX' | 'deltaY' | 'clientX' | 'clientY'>,
  rect: { x: number; y: number },
  space: Space,
): CanvasView {
  if (e.ctrlKey || e.metaKey) {
    const zoom = Math.min(8, Math.max(minimumZoom(space), v.zoom * Math.exp(-e.deltaY * 0.005))),
      world = screenToWorld(
        { x: e.clientX, y: e.clientY },
        { x: rect.x, y: rect.y },
        v.pan,
        v.zoom,
      );
    return {
      ...v,
      zoom,
      fit: false,
      pan: { x: e.clientX - rect.x - world.x * zoom, y: e.clientY - rect.y - world.y * zoom },
    };
  }
  return { ...v, fit: false, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } };
}

export function stageBoundsToFit(
  fitBounds: Bounds | undefined,
  space: Space,
  targets: CanvasTarget[],
  width: number,
  height: number,
) {
  return (
    fitBounds ??
    (space === 'infinite'
      ? unionBounds(targets.filter((t) => !t.hidden).map((t) => t.bounds))
      : { x: 0, y: 0, width, height })
  );
}

export function stageViewport(view: CanvasView, size: Size) {
  const viewportBounds = {
    x: -view.pan.x / view.zoom,
    y: -view.pan.y / view.zoom,
    width: size.width / view.zoom,
    height: size.height / view.zoom,
  };
  const overscan = 128 / view.zoom;
  const paintViewport = {
    x: viewportBounds.x - overscan,
    y: viewportBounds.y - overscan,
    width: viewportBounds.width + 2 * overscan,
    height: viewportBounds.height + 2 * overscan,
  };
  return { viewportBounds, paintViewport };
}

function transformedBy(target: CanvasTarget, preview: GeometryPreview | undefined) {
  // Domain previews may include unchanged elements. Retain only geometry
  // that actually moved, including descendants changed by Frame layout.
  const geometry = preview?.get(target.id);
  return (
    geometry &&
    (geometry.bounds.x !== target.bounds.x ||
      geometry.bounds.y !== target.bounds.y ||
      geometry.bounds.width !== target.bounds.width ||
      geometry.bounds.height !== target.bounds.height ||
      geometry.rotation !== (target.rotation ?? 0))
  );
}

/** Culls bounded offscreen drawings, keeping selected, moved and edited targets painted. */
export function paintedTargets(
  visible: CanvasTarget[],
  options: {
    preview?: GeometryPreview;
    selected: string[];
    editing?: StageEditing;
    paintViewport: Bounds;
  },
) {
  const { preview, selected, editing, paintViewport } = options;
  return visible.filter(
    (target) =>
      !target.paintBounds ||
      selected.includes(target.id) ||
      transformedBy(target, preview) ||
      editing?.id === target.id ||
      target.textParts?.some((part) => part.id === editing?.id) ||
      intersectsRotated(paintViewport, target.paintBounds),
  );
}

export function selectionFrame(
  visible: CanvasTarget[],
  selected: string[],
  preview: GeometryPreview | undefined,
) {
  const selectionRoots = selectedRoots(visible, selected);
  const rotation =
    selectionRoots.length === 1
      ? (preview?.get(selectionRoots[0].id)?.rotation ?? selectionRoots[0].rotation ?? 0)
      : 0;
  const box = unionBounds(selectionRoots.map((t) => preview?.get(t.id)?.bounds ?? t.bounds));
  return { rotation, box };
}

export function handleAnchor(handle: string, box: Bounds) {
  return {
    x: handle.includes('w')
      ? box.x
      : handle.includes('e')
        ? box.x + box.width
        : box.x + box.width / 2,
    y: handle.includes('n')
      ? box.y
      : handle.includes('s')
        ? box.y + box.height
        : box.y + box.height / 2,
  };
}

export function createDrag(
  targets: CanvasTarget[],
  options: {
    mode: string;
    ids: string[];
    handle: string;
    client: Point;
    point: Point;
    view: CanvasView;
    shift: boolean;
  },
): StageDrag {
  const { mode, ids, handle, point, view } = options;
  const roots = selectedRoots(targets, ids),
    box = unionBounds(roots.map((t) => t.bounds));
  return {
    mode,
    start: options.client,
    world: point,
    ids,
    box,
    pan: { ...view.pan },
    zoom: view.zoom,
    handle,
    angle: Math.atan2(point.y - box.y - box.height / 2, point.x - box.x - box.width / 2),
    rotation: roots.length === 1 ? (roots[0].rotation ?? 0) : 0,
    path: [point],
    shift: options.shift,
  };
}

/** A click/double-click selects or opens text; it must not snap/normalize geometry. */
export function dragStarted(d: StageDrag, client: Point) {
  if (!['move', 'resize', 'rotate'].includes(d.mode)) return true;
  d.moved ||= Math.hypot(client.x - d.start.x, client.y - d.start.y) >= 3;
  return d.moved;
}

export function marqueeBox(d: StageDrag, point: Point, shiftKey: boolean) {
  const dx = point.x - d.world.x,
    dy = point.y - d.world.y;
  const b = {
    x: Math.min(d.world.x, point.x),
    y: Math.min(d.world.y, point.y),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
  if (shiftKey && d.mode === 'insert') b.height = b.width;
  return b;
}

export function transformChange(
  d: StageDrag,
  point: Point,
  modifiers: { shiftKey: boolean; altKey: boolean },
  view: CanvasView,
  targets: CanvasTarget[],
): { change: TransformDelta; guides?: SnapGuide[] } {
  const dx = point.x - d.world.x,
    dy = point.y - d.world.y;
  if (d.mode === 'resize') {
    const b = resizedRotatedBounds(d.box, d.rotation, d.handle, dx, dy, modifiers.shiftKey);
    return {
      change: {
        dx: b.x - d.box.x,
        dy: b.y - d.box.y,
        dw: b.width - d.box.width,
        dh: b.height - d.box.height,
      },
    };
  }
  if (d.mode === 'rotate') {
    let angle =
      ((Math.atan2(point.y - d.box.y - d.box.height / 2, point.x - d.box.x - d.box.width / 2) -
        d.angle) *
        180) /
      Math.PI;
    if (modifiers.shiftKey) angle = Math.round(angle / 15) * 15;
    return { change: { dx: 0, dy: 0, dw: 0, dh: 0, rotation: angle } };
  }
  const change: TransformDelta = { dx, dy, dw: 0, dh: 0 };
  if (!view.snap || modifiers.altKey) return { change };
  const all = descendantIds(targets, d.ids);
  const snapped = snapBounds(
    { ...d.box, x: d.box.x + dx, y: d.box.y + dy },
    targets.filter((t) => !all.has(t.id) && !t.hidden).map((t) => t.bounds),
    6 / view.zoom,
    view.grid ? 10 : 0,
  );
  change.dx = snapped.bounds.x - d.box.x;
  change.dy = snapped.bounds.y - d.box.y;
  return { change, guides: snapped.guides };
}

/** Resolves the object a pointer press acts on within the current group scope. */
export function scopedTarget(
  targets: CanvasTarget[],
  hit: CanvasTarget,
  groupScope: string | undefined,
) {
  const parent = targets.find((p) => p.id === hit.parentId);
  let target = parent?.container && parent.id !== groupScope ? parent : hit;
  let ancestor = targets.find((p) => p.id === target.parentId && p.container);
  while (ancestor && ancestor.id !== groupScope) {
    target = ancestor;
    ancestor = targets.find((p) => p.id === target.parentId && p.container);
  }
  return target;
}

export function pressedSelection(selected: string[], id: string, shift: boolean) {
  return shift
    ? selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id]
    : selected.includes(id)
      ? selected
      : [id];
}

export function backgroundDragMode(panning: boolean, freehand?: boolean, insertion?: boolean) {
  return panning ? 'pan' : freehand ? 'pen' : insertion ? 'insert' : 'marquee';
}

export function textPartAt(target: CanvasTarget, partId: string | null | undefined, point: Point) {
  return (
    target.textParts?.find((p) => p.id === partId) ??
    [...(target.textParts ?? [])]
      .reverse()
      .find((p) => intersectsRotated({ ...point, width: 0, height: 0 }, p.bounds, p.rotation))
  );
}

export function pastePosition(
  space: Space,
  size: Size,
  view: CanvasView,
  width: number,
  height: number,
) {
  return space === 'infinite'
    ? {
        x: (size.width / 2 - view.pan.x) / view.zoom,
        y: (size.height / 2 - view.pan.y) / view.zoom,
      }
    : { x: width / 2 - 100, y: height / 2 - 80 };
}

const shortcutActions: Record<string, string> = {
  c: 'copy',
  x: 'cut',
  v: 'paste',
  d: 'duplicate',
};

export function shortcutAction(key: string, shift: boolean) {
  const lower = key.toLowerCase();
  return lower === 'g' ? (shift ? 'ungroup' : 'group') : shortcutActions[lower];
}

export function arrowDelta(key: string, shift: boolean): TransformDelta {
  const step = shift ? 10 : 1;
  return {
    dx: key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
    dy: key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0,
    dw: 0,
    dh: 0,
  };
}

type EditedText = Pick<
  CanvasTarget,
  'id' | 'bounds' | 'rotation' | 'text' | 'runs' | 'typography' | 'textDrawing'
>;

/** Projects the edited text (or text part) onto the in-place or expanded editor drawing. */
export function textEditingLayout(
  t: EditedText,
  editing: StageEditing,
  size: Size,
  view: CanvasView,
) {
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
  return { original, drawing, anchor };
}
