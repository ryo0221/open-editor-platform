import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  CanvasStage,
  initialCanvasView,
  type CanvasTarget,
  type CanvasView,
} from '@editor-platform/canvas-ui';
import { PathHandles } from '@editor-platform/canvas-ui/path-handles';
import { EditorHistoryContext } from '@editor-platform/editor-ui';
import {
  EditorSession,
  command,
  transformGeometry,
  type GeometryItem,
  type TransformDelta,
} from '@editor-platform/editor-core';

type Item = GeometryItem & { kind?: 'group' | 'frame'; text?: string };
type Content = { items: Item[] };
export type Controls = {
  resizeA?: boolean;
  resizeB?: boolean;
  resizeChild?: boolean;
  rotateA: boolean;
  readOnly: boolean;
  lockedA: boolean;
  point: boolean;
  optIn: boolean;
  selected: string[];
  aggregateChildren: boolean;
};
export interface R2Probe {
  set(patch: Partial<Controls>): void;
  token(value: unknown): void;
  advance(): void;
  camera(patch: Partial<CanvasView>): void;
  rerender(): void;
  external(remove?: boolean): void;
  previewInvalidates(mode: 'resize' | 'revision' | 'both'): void;
  releaseInvalidates(mode: 'resize' | 'revision'): void;
  undo(): void;
  redo(): void;
  snapshot(): {
    native: Content;
    revision: number;
    requests: number;
    commits: number;
    canUndo: boolean;
    canRedo: boolean;
    selected: string[];
    view: CanvasView;
    sets: number;
    releases: number;
    active: number;
    pointPreview: boolean;
    error: string;
  };
}
declare global {
  interface Window {
    r2Probe: R2Probe;
  }
}
// Test-only capture observation; no callback or instrumentation added to CanvasStage.
const captured: { target: Element; id: number }[] = [];
let sets = 0,
  releases = 0,
  releaseHook: (() => void) | undefined,
  previewHook: (() => void) | undefined;
const setCapture = Element.prototype.setPointerCapture;
const releaseCapture = Element.prototype.releasePointerCapture;
Element.prototype.setPointerCapture = function (id: number) {
  sets++;
  captured.push({ target: this, id });
  setCapture.call(this, id);
};
Element.prototype.releasePointerCapture = function (id: number) {
  releases++;
  releaseCapture.call(this, id);
  const hook = releaseHook;
  releaseHook = undefined;
  hook?.();
};
const initial: Content = {
  items: [
    { id: 'a', bounds: { x: 60, y: 60, width: 110, height: 90 }, text: 'Editable text' },
    { id: 'b', bounds: { x: 210, y: 70, width: 70, height: 80 } },
    { id: 'group', kind: 'group', bounds: { x: 340, y: 60, width: 150, height: 120 } },
    { id: 'child', parentId: 'group', bounds: { x: 360, y: 80, width: 40, height: 30 } },
    { id: 'frame', kind: 'frame', bounds: { x: 520, y: 60, width: 150, height: 120 } },
    { id: 'frame-child', parentId: 'frame', bounds: { x: 540, y: 80, width: 40, height: 30 } },
  ],
};
function project(items: Item[], ids: string[], delta: TransformDelta) {
  const result = transformGeometry(items, ids, delta);
  if (ids.includes('frame')) {
    // Domain Frame layout retains child size; Group uses normal subtree scaling.
    const parent = items.find((i) => i.id === 'frame')!,
      next = result.get('frame')!;
    for (const child of items.filter((i) => i.parentId === 'frame'))
      result.set(child.id, {
        bounds: {
          ...child.bounds,
          x: child.bounds.x + next.bounds.x - parent.bounds.x,
          y: child.bounds.y + next.bounds.y - parent.bounds.y,
        },
        rotation: child.rotation ?? 0,
      });
  }
  return result;
}
function Probe() {
  const session = useRef(new EditorSession(initial));
  const sequence = useRef(0),
    requests = useRef(0),
    commits = useRef(0),
    gestureRevision = useRef<
      { pointerId: number; startedAt: number; sequence: number } | undefined
    >(undefined);
  useEffect(() => {
    // Bubble phase runs after Canvas's synchronous commit, even outside this Host.
    // Capture release alone is not an operation end: commit also releases capture.
    const end = (event: PointerEvent) => {
      const started = gestureRevision.current;
      if (started?.pointerId === event.pointerId && event.timeStamp >= started.startedAt)
        gestureRevision.current = undefined;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      gestureRevision.current = undefined;
    };
  }, []);
  const [, redraw] = useState(0);
  const [token, setToken] = useState<unknown>('rev:0');
  const [controls, setControls] = useState<Controls>({
    rotateA: true,
    readOnly: false,
    lockedA: false,
    point: false,
    optIn: true,
    selected: ['a'],
    aggregateChildren: false,
  });
  const [view, setView] = useState<CanvasView>({
    ...initialCanvasView,
    fit: false,
    snap: false,
    grid: false,
    pan: { x: 10, y: 10 },
  });
  const [pointPreview, setPointPreview] = useState<{ x: number; y: number }>();
  const [error, setError] = useState('');
  const content = session.current.content;
  const advance = () => setToken('rev:' + ++sequence.current);
  const update = (patch: Partial<Controls>) =>
    flushSync(() => setControls((c) => ({ ...c, ...patch })));
  const history = (redo: boolean) => {
    if (controls.readOnly) return;
    if (redo) session.current.redo();
    else session.current.undo();
    advance();
    redraw((n) => n + 1);
  };
  function execute(label: string, fn: (c: Content) => Content) {
    session.current.execute(command('r2-' + label, label, fn));
    advance();
    redraw((n) => n + 1);
    setError('');
  }
  function transform(ids: string[], delta: TransformDelta) {
    requests.current++;
    if (
      controls.readOnly ||
      (controls.lockedA && ids.includes('a')) ||
      (gestureRevision.current !== undefined &&
        gestureRevision.current.sequence !== session.current.revision.sequence)
    ) {
      setError('Host precondition rejected');
      return;
    }
    if (
      (delta.dw || delta.dh) &&
      ids.some((id) => targets.find((t) => t.id === id)?.resizable === false)
    ) {
      setError('Domain resize rejected');
      return;
    }
    commits.current++;
    execute('transform', (c) => {
      const changed = project(c.items, ids, delta);
      return { items: c.items.map((i) => ({ ...i, ...changed.get(i.id) })) };
    });
  }
  const targets: CanvasTarget[] = content.items.map((i) => ({
    ...i,
    label: i.id,
    container: !!i.kind,
    text: i.text,
    editableText: i.id === 'a',
    locked: i.id === 'a' && controls.lockedA,
    rotatable: i.id === 'a' ? controls.rotateA : true,
    resizable:
      i.id === 'a'
        ? controls.resizeA
        : i.id === 'b'
          ? controls.resizeB
          : i.id === 'child' || i.id === 'frame-child'
            ? controls.resizeChild
            : controls.aggregateChildren && controls.resizeChild === false
              ? false
              : undefined,
  }));
  const invalidate = (mode: 'resize' | 'revision' | 'both') =>
    flushSync(() => {
      if (mode !== 'revision') setControls((c) => ({ ...c, resizeA: false }));
      if (mode !== 'resize') advance();
    });
  window.r2Probe = {
    set: update,
    token: (value) => flushSync(() => setToken(() => value)),
    advance: () => invalidate('revision'),
    camera: (patch) => flushSync(() => setView((v) => ({ ...v, ...patch }))),
    rerender: () => flushSync(() => redraw((n) => n + 1)),
    external: (remove) =>
      flushSync(() =>
        execute('external', (c) => ({
          items: remove
            ? c.items.filter((i) => i.id !== 'a')
            : c.items.map((i) =>
                i.id === 'a'
                  ? { ...i, bounds: { ...i.bounds, x: i.bounds.x + 9, y: i.bounds.y + 3 } }
                  : i,
              ),
        })),
      ),
    previewInvalidates: (mode) => {
      previewHook = () => invalidate(mode);
    },
    releaseInvalidates: (mode) => {
      releaseHook = () => invalidate(mode);
    },
    undo: () => flushSync(() => history(false)),
    redo: () => flushSync(() => history(true)),
    snapshot: () => ({
      native: session.current.content,
      revision: session.current.revision.sequence,
      requests: requests.current,
      commits: commits.current,
      canUndo: session.current.canUndo,
      canRedo: session.current.canRedo,
      selected: controls.selected,
      view,
      sets,
      releases,
      active: captured.filter(({ target, id }) => target.hasPointerCapture(id)).length,
      pointPreview: !!pointPreview,
      error,
    }),
  };
  const a = content.items.find((i) => i.id === 'a');
  return (
    <main>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button onClick={() => update({ selected: ['a'] })}>Select a</button>
        <button onClick={() => update({ selected: ['a', 'b'] })}>Select pair</button>
        <button onClick={() => update({ resizeA: false })}>Disable resize</button>
        <button onClick={() => invalidate('revision')}>Invalidate</button>
        <button
          onClick={() => history(false)}
          disabled={controls.readOnly || !session.current.canUndo}
        >
          Undo
        </button>
        <button
          onClick={() => history(true)}
          disabled={controls.readOnly || !session.current.canRedo}
        >
          Redo
        </button>
        <input aria-label="Host text" defaultValue="keep focus" />
      </div>
      <EditorHistoryContext.Provider
        value={{ undo: () => history(false), redo: () => history(true) }}
      >
        <div
          style={{ height: 360, width: '100%' }}
          data-testid="stage-host"
          onPointerDownCapture={(e) => {
            // Point gestures own separate revision checks and can stop propagation.
            gestureRevision.current = controls.point
              ? undefined
              : {
                  pointerId: e.pointerId,
                  startedAt: e.timeStamp,
                  sequence: session.current.revision.sequence,
                };
          }}
        >
          <CanvasStage
            label="R2 object probe"
            targets={targets}
            selected={controls.selected}
            onSelect={(selected) => setControls((c) => ({ ...c, selected }))}
            onTransform={transform}
            objectRevision={controls.optIn ? token : undefined}
            readOnly={controls.readOnly}
            inputOwner={controls.point ? 'point' : 'object'}
            view={view}
            onViewChange={setView}
            space="infinite"
            previewTransform={(ids, delta) => {
              const result = project(content.items, ids, delta);
              const hook = previewHook;
              previewHook = undefined;
              hook?.();
              return result;
            }}
            onDelete={() => setError('Delete boundary reached')}
            onEditText={(id, text) => {
              if (controls.readOnly || controls.lockedA) return false;
              execute('text', (c) => ({
                items: c.items.map((i) => (i.id === id ? { ...i, text } : i)),
              }));
            }}
            render={(t) => (
              <g
                transform={`rotate(${t.rotation ?? 0} ${t.bounds.x + t.bounds.width / 2} ${t.bounds.y + t.bounds.height / 2})`}
              >
                <rect
                  data-testid={'paint-' + t.id}
                  data-rotation={t.rotation ?? 0}
                  {...t.bounds}
                  fill={t.container ? '#cad9ec' : '#86b7be'}
                  stroke="#274764"
                />
                <text x={t.bounds.x + 10} y={t.bounds.y + 20} pointerEvents="none">
                  {t.label}
                </text>
              </g>
            )}
            overlay={
              controls.point && a ? (
                <PathHandles
                  points={[
                    {
                      id: 'vertex',
                      label: 'R2 vertex',
                      kind: 'anchor',
                      ...(pointPreview ?? { x: a.bounds.x, y: a.bounds.y }),
                    },
                  ]}
                  zoom={view.zoom}
                  revision={session.current.revision.sequence}
                  disabled={controls.readOnly || controls.lockedA}
                  select={() => true}
                  begin={() => true}
                  preview={(_id, p) => setPointPreview(p)}
                  cancel={() => setPointPreview(undefined)}
                  commit={(_id, p) => {
                    setPointPreview(undefined);
                    execute('point', (c) => ({
                      items: c.items.map((i) =>
                        i.id === 'a' ? { ...i, bounds: { ...i.bounds, x: p.x, y: p.y } } : i,
                      ),
                    }));
                  }}
                />
              ) : undefined
            }
          />
        </div>
      </EditorHistoryContext.Provider>
      <output data-testid="native">{JSON.stringify(content)}</output>
      <output data-testid="error">{error}</output>
      <output data-testid="point-preview">
        {pointPreview ? JSON.stringify(pointPreview) : ''}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Probe />);
