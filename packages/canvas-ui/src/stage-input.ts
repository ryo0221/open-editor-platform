import type React from 'react';
import type { RefObject } from 'react';
import { isTextInput } from '@editor-platform/editor-ui';
import { clone } from '@editor-platform/artifact-core';
import {
  transformGeometry,
  type Bounds,
  type Point,
  type TransformDelta,
} from '@editor-platform/editor-core';
import type { CanvasStageProps, CanvasTarget, CanvasView } from './index';
import type { CanvasSpatialQuery } from './spatial-query';
import {
  arrowDelta,
  backgroundDragMode,
  createDrag,
  dragStarted,
  marqueeBox,
  pressedSelection,
  scopedTarget,
  shortcutAction,
  textPartAt,
  transformChange,
  type GeometryPreview,
  type SnapGuide,
  type StageDrag,
  type StageEditing,
} from './stage-model';

type ClientPoint = { clientX: number; clientY: number };

export interface StageKeyContext {
  history?: { undo(): void; redo(): void };
  readOnly: boolean;
  selected: string[];
  targets: CanvasTarget[];
  spaceHeld: RefObject<boolean>;
  escape(): void;
  fit(): void;
  onPage?: (delta: number) => void;
  onSelect: (ids: string[]) => void;
  onAction?: (action: string) => void;
  onDelete: () => void;
  onTransform: (ids: string[], change: TransformDelta) => void;
}

function historyKey(e: React.KeyboardEvent, c: StageKeyContext) {
  if (
    !c.history ||
    c.readOnly ||
    !(e.ctrlKey || e.metaKey) ||
    !['z', 'y'].includes(e.key.toLowerCase())
  )
    return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey || e.key.toLowerCase() === 'y') c.history.redo();
  else c.history.undo();
  return true;
}

function navigationKey(e: React.KeyboardEvent, c: StageKeyContext) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    c.escape();
    return true;
  }
  if (e.key === ' ') {
    c.spaceHeld.current = true;
    e.preventDefault();
    return true;
  }
  if (e.shiftKey && (e.key === '1' || e.key === '!')) {
    c.fit();
    return true;
  }
  if (['PageUp', 'PageDown'].includes(e.key)) {
    e.preventDefault();
    c.onPage?.(e.key === 'PageUp' ? -1 : 1);
    return true;
  }
  return false;
}

function editKey(e: React.KeyboardEvent, c: StageKeyContext) {
  const command = e.metaKey || e.ctrlKey;
  if (command && e.key === 'a') {
    e.preventDefault();
    c.onSelect(c.targets.filter((t) => !t.hidden && !t.locked).map((t) => t.id));
    return;
  }
  if (command && ['c', 'x', 'v', 'd', 'g'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    c.onAction?.(shortcutAction(e.key, e.shiftKey));
    return;
  }
  if (['Delete', 'Backspace'].includes(e.key)) {
    e.preventDefault();
    c.onDelete();
  }
  if (e.key.startsWith('Arrow') && c.selected.length) {
    e.preventDefault();
    c.onTransform(c.selected, arrowDelta(e.key, e.shiftKey));
  }
}

/** Canvas keyboard commands; native text inputs and IME composition keep their keys. */
export function stageKeyDown(e: React.KeyboardEvent, c: StageKeyContext) {
  if (isTextInput(e.target) || e.nativeEvent.isComposing) return;
  if (historyKey(e, c) || navigationKey(e, c)) return;
  if (c.readOnly) return;
  editKey(e, c);
}

export interface StageDoubleClickContext {
  hit?: CanvasTarget;
  point(): Point;
  readOnly: boolean;
  targets: CanvasTarget[];
  groupScope?: string;
  setEditing(editing: StageEditing): void;
  setGroupScope(id: string): void;
  onSelect: (ids: string[]) => void;
  onAction?: (action: string) => void;
}

/** Opens text editing, enters a group scope, or delegates to the domain on double-click. */
export function stageDoubleClick(e: React.MouseEvent, c: StageDoubleClickContext) {
  const t = c.hit;
  if (!t) return;
  e.stopPropagation();
  const partId = (e.target as Element)
    .closest('[data-canvas-text-target]')
    ?.getAttribute('data-canvas-text-target');
  const part = textPartAt(t, partId, c.point());
  const caret = { x: e.clientX, y: e.clientY };
  if (part && !c.readOnly && !t.locked) {
    c.setEditing({ id: part.id, text: part.text, runs: clone(part.runs), caret });
    return;
  }
  const parent = c.targets.find((p) => p.id === t.parentId && p.container);
  if (parent && c.groupScope !== parent.id) {
    c.setGroupScope(parent.id);
    c.onSelect([t.id]);
    return;
  }
  if (t.container) {
    c.setGroupScope(t.id);
    c.onSelect([]);
    return;
  }
  if (t.editableText && !c.readOnly && !t.locked)
    c.setEditing({ id: t.id, text: t.text ?? '', runs: clone(t.runs), caret });
  else c.onAction?.('enter-group');
}

export interface StageDragContext {
  drag: RefObject<StageDrag | null>;
  svg: RefObject<SVGSVGElement | null>;
  spatial: RefObject<CanvasSpatialQuery | undefined>;
  editing?: StageEditing;
  readOnly: boolean;
  view: CanvasView;
  targets: CanvasTarget[];
  selected: string[];
  world(e: ClientPoint): Point;
  setView(view: CanvasView): void;
  setPreview(preview: GeometryPreview | undefined): void;
  setMarquee(bounds: Bounds | undefined): void;
  setGuides(guides: SnapGuide[]): void;
  setPath(path: Point[]): void;
  onSelect: CanvasStageProps['onSelect'];
  onTransform: CanvasStageProps['onTransform'];
  previewTransform?: CanvasStageProps['previewTransform'];
  onInsert?: CanvasStageProps['onInsert'];
  onFreehand?: CanvasStageProps['onFreehand'];
}

/** Pointer drag lifecycle for pan, pen, marquee/insert and move/resize/rotate gestures. */
export function stageDrag(c: StageDragContext) {
  function reset() {
    c.drag.current = null;
    c.setPreview(undefined);
    c.setMarquee(undefined);
    c.setGuides([]);
    c.setPath([]);
  }
  function begin(e: React.PointerEvent, mode: string, ids: string[], handle = '') {
    if (c.editing || (c.readOnly && mode !== 'pan')) return;
    e.preventDefault();
    e.stopPropagation();
    c.svg.current?.focus({ preventScroll: true });
    c.drag.current = createDrag(c.targets, {
      mode,
      ids,
      handle,
      client: { x: e.clientX, y: e.clientY },
      point: c.world(e),
      view: c.view,
      shift: e.shiftKey,
    });
    // Capture on the object wrapper even though its handler is delegated. Native
    // click/double-click targets follow pointer capture; capturing on the SVG
    // would lose the object that should enter text/group editing on double-click.
    const object =
      e.target instanceof Element ? e.target.closest<SVGGElement>('[data-canvas-target]') : null;
    (object ?? e.currentTarget).setPointerCapture(e.pointerId);
  }
  function cancel() {
    if (c.drag.current?.mode === 'pan') c.setView({ ...c.view, pan: c.drag.current.pan });
    reset();
  }
  function marquee(d: StageDrag, point: Point, e: React.PointerEvent, commit: boolean) {
    const b = marqueeBox(d, point, e.shiftKey);
    c.setMarquee(b);
    if (!commit) return;
    if (d.mode === 'insert')
      c.onInsert?.(b.width < 3 ? { x: point.x, y: point.y, width: 180, height: 120 } : b);
    else
      c.onSelect(
        b.width + b.height < 4
          ? []
          : [
              ...new Set([
                ...(d.shift ? c.selected : []),
                ...c.spatial.current!.query(c.targets, b).map((t) => t.id),
              ]),
            ],
      );
  }
  function transform(d: StageDrag, point: Point, e: React.PointerEvent, commit: boolean) {
    const { change, guides } = transformChange(d, point, e, c.view, c.targets);
    if (guides) c.setGuides(guides);
    try {
      if (commit) {
        if (Object.values(change).some((v) => Math.abs(v) > 0.01)) c.onTransform(d.ids, change);
      } else
        c.setPreview(
          (c.previewTransform ?? ((ids, delta) => transformGeometry(c.targets, ids, delta)))(
            d.ids,
            change,
          ),
        );
    } catch {
      /* domain command reports locked selections; no partial preview */
    }
  }
  function move(e: React.PointerEvent, commit = false) {
    const d = c.drag.current;
    if (!d) return;
    if (!dragStarted(d, { x: e.clientX, y: e.clientY })) {
      if (commit) {
        c.drag.current = null;
        c.setPreview(undefined);
        c.setGuides([]);
      }
      return;
    }
    const point = c.world(e);
    if (d.mode === 'pan') {
      c.setView({
        ...c.view,
        fit: false,
        pan: { x: d.pan.x + e.clientX - d.start.x, y: d.pan.y + e.clientY - d.start.y },
      });
    } else if (d.mode === 'pen') {
      d.path.push(point);
      c.setPath([...d.path]);
      if (commit && d.path.length > 1) c.onFreehand?.(d.path);
    } else if (d.mode === 'marquee' || d.mode === 'insert') marquee(d, point, e, commit);
    else transform(d, point, e, commit);
    if (commit) reset();
  }
  return { begin, cancel, move };
}

export interface StagePointerDownContext {
  hit?: CanvasTarget;
  targets: CanvasTarget[];
  selected: string[];
  groupScope?: string;
  readOnly: boolean;
  panning: boolean;
  insertion?: boolean;
  freehand?: boolean;
  onSelect: (ids: string[]) => void;
  begin(e: React.PointerEvent, mode: string, ids: string[]): void;
}

/** Selects the scoped object under the pointer and starts the matching drag. */
export function stagePointerDown(e: React.PointerEvent, c: StagePointerDownContext) {
  const t = c.hit;
  if (t && !c.insertion && !c.freehand) {
    if (c.panning) {
      c.begin(e, 'pan', []);
      return;
    }
    e.stopPropagation();
    const target = scopedTarget(c.targets, t, c.groupScope);
    const ids = pressedSelection(c.selected, target.id, e.shiftKey);
    c.onSelect(ids);
    if (!c.readOnly && !t.locked) c.begin(e, 'move', ids);

    return;
  }
  c.begin(e, backgroundDragMode(c.panning, c.freehand, c.insertion), []);
}
