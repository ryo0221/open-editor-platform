import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CanvasStage,
  initialCanvasView,
  type CanvasTarget,
  type CanvasView,
} from '@editor-platform/canvas-ui';
import { PathHandles } from '@editor-platform/canvas-ui/path-handles';
import { EditorSession, command, type TransformDelta } from '@editor-platform/editor-core';

declare global {
  interface Window {
    r0ProbeResize(direction: string): void;
  }
}

// The fixture is a throwaway local domain projection, NOT a fiction-map native schema.
type XY = { x: number; y: number };
type Feature = {
  id: string;
  kind: 'point' | 'line' | 'polygon';
  points: XY[];
  hidden?: boolean;
  locked?: boolean;
};
type Content = { features: Feature[] };
// Test setup only; no native kind, persistence adapter or production registration.
const setup = JSON.parse(sessionStorage.getItem('r0-fixture') ?? '{}') as {
  content?: Content;
  view?: Partial<CanvasView>;
  virtualize?: boolean;
};
const initial: Content = {
  features: [
    { id: 'city', kind: 'point', points: [{ x: 110, y: 105 }] },
    {
      id: 'river',
      kind: 'line',
      points: [
        { x: 75, y: 270 },
        { x: 235, y: 270 },
      ],
    },
    {
      id: 'concave',
      kind: 'polygon',
      points: [
        { x: 280, y: 80 },
        { x: 460, y: 80 },
        { x: 460, y: 110 },
        { x: 320, y: 110 },
        { x: 320, y: 225 },
        { x: 280, y: 225 },
        { x: 280, y: 80 },
      ],
    },
    {
      id: 'lower',
      kind: 'polygon',
      points: [
        { x: 520, y: 110 },
        { x: 650, y: 110 },
        { x: 650, y: 230 },
        { x: 520, y: 230 },
        { x: 520, y: 110 },
      ],
    },
    {
      id: 'upper',
      kind: 'polygon',
      points: [
        { x: 570, y: 155 },
        { x: 700, y: 155 },
        { x: 700, y: 260 },
        { x: 570, y: 260 },
        { x: 570, y: 155 },
      ],
    },
  ],
};
function aabb(feature: Feature) {
  const xs = feature.points.map((p) => p.x),
    ys = feature.points.map((p) => p.y);
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) - minX),
    height: Math.max(1, Math.max(...ys) - minY),
  };
}
function Probe() {
  const session = useRef(new EditorSession<Content>(setup.content ?? initial));
  // Canvas cancellation is UI-only. Keep the Host command precondition, and
  // leave PathHandles revision/disabled ownership separate.
  const objectGestureRevision = useRef<
    { pointerId: number; startedAt: number; sequence: number } | undefined
  >(undefined);
  useEffect(() => {
    // Bubble phase runs after Canvas's synchronous commit, even outside this Host.
    // Capture release alone is not an operation end: commit also releases capture.
    const end = (event: PointerEvent) => {
      const started = objectGestureRevision.current;
      if (started?.pointerId === event.pointerId && event.timeStamp >= started.startedAt)
        objectGestureRevision.current = undefined;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      objectGestureRevision.current = undefined;
    };
  }, []);
  const [, refresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [pointMode, setPointMode] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const [reverseOrder, setReverseOrder] = useState(false);
  const [virtualize, setVirtualize] = useState(setup.virtualize ?? false);
  const [view, setView] = useState<CanvasView>({
    ...initialCanvasView,
    fit: false,
    snap: false,
    grid: false,
    pan: { x: 30, y: 30 },
    ...setup.view,
  });
  const [vertexPreview, setVertexPreview] = useState<{ id: string; index: number; point: XY }>();
  const transformRequests = useRef(0);
  const [error, setError] = useState('');
  const content = session.current.content;
  const byId = new Map(content.features.map((f) => [f.id, f]));
  const active = selected.length === 1 ? byId.get(selected[0]) : undefined;
  const targets: CanvasTarget[] = content.features.map((f) => ({
    id: f.id,
    label: f.id,
    bounds: aabb(f),
    hidden: f.hidden,
    locked: f.locked,
    // Conservative paint extent includes the label; selection remains geometry AABB.
    paintBounds: {
      ...aabb(f),
      y: aabb(f).y - 24,
      width: Math.max(160, aabb(f).width),
      height: aabb(f).height + 36,
    },
    rotatable: false,
    resizable: false,
    // Neither hitBounds nor hitBox: a transparent AABB must not become a click target.
  }));
  if (reverseOrder) targets.reverse();
  function commit(label: string, updater: (current: Content) => Content) {
    if (readonly) {
      setError('Read only');
      return;
    }
    try {
      session.current.execute(command('fixture-' + label, label, updater));
      setError('');
      refresh((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  }
  function transform(ids: string[], delta: TransformDelta) {
    transformRequests.current++;
    if (
      objectGestureRevision.current !== undefined &&
      objectGestureRevision.current.sequence !== session.current.revision.sequence
    ) {
      setError('Stale gesture');
      return;
    }
    if (ids.some((id) => byId.get(id)?.locked)) {
      setError('Locked feature');
      return;
    }
    if (
      Math.abs(delta.dw) > 0.001 ||
      Math.abs(delta.dh) > 0.001 ||
      Math.abs(delta.rotation ?? 0) > 0.001
    ) {
      setError('Resize and rotation are not supported for map features');
      return;
    }
    if (!delta.dx && !delta.dy) return;
    commit('move', (current) => ({
      features: current.features.map((f) =>
        ids.includes(f.id)
          ? { ...f, points: f.points.map((p) => ({ x: p.x + delta.dx, y: p.y + delta.dy })) }
          : f,
      ),
    }));
  }
  // Public-domain boundary probe: UI capability is never authorization.
  window.r0ProbeResize = (direction) =>
    transform(selected, {
      dx: direction.includes('w') ? -6 : 0,
      dy: direction.includes('n') ? -4 : 0,
      dw: /[ew]/.test(direction) ? 6 : 0,
      dh: /[ns]/.test(direction) ? 4 : 0,
    });
  // The domain remains defensive about unsupported requests.
  // Keep native geometry unchanged, and never project a resize as a translation.
  function previewTransform(ids: string[], delta: TransformDelta) {
    if (ids.some((id) => byId.get(id)?.locked)) throw new Error('Locked feature');
    const isTranslation =
      Math.abs(delta.dw) <= 0.001 &&
      Math.abs(delta.dh) <= 0.001 &&
      Math.abs(delta.rotation ?? 0) <= 0.001;
    return new Map(
      targets
        .filter((target) => ids.includes(target.id))
        .map(
          (target) =>
            [
              target.id,
              {
                bounds: isTranslation
                  ? {
                      ...target.bounds,
                      x: target.bounds.x + delta.dx,
                      y: target.bounds.y + delta.dy,
                    }
                  : target.bounds,
                rotation: target.rotation ?? 0,
              },
            ] as const,
        ),
    );
  }
  function renderShape(target: CanvasTarget) {
    const f = byId.get(target.id)!;
    const original = aabb(f);
    const dx = target.bounds.x - original.x,
      dy = target.bounds.y - original.y;
    const points = f.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (f.kind === 'point')
      return (
        <circle
          data-testid={'shape-' + f.id}
          cx={points[0].x}
          cy={points[0].y}
          r={9}
          fill="#284e9a"
        />
      );
    if (f.kind === 'line')
      return (
        <polyline
          data-testid={'shape-' + f.id}
          points={points.map((p) => p.x + ',' + p.y).join(' ')}
          fill="none"
          stroke="#1b7c8e"
          strokeWidth={7}
          strokeLinecap="round"
        />
      );
    return (
      <polygon
        data-testid={'shape-' + f.id}
        points={points.map((p) => p.x + ',' + p.y).join(' ')}
        fill={f.id === 'upper' ? '#cc7b49' : '#7ba3a3'}
        fillOpacity={0.7}
        stroke="#234a5d"
        strokeWidth={2}
      />
    );
  }
  function renderFeature(target: CanvasTarget) {
    return (
      <g>
        {renderShape(target)}
        <text
          data-testid={'label-' + target.id}
          x={target.bounds.x + 20}
          y={target.bounds.y - 10}
          fontSize={12}
        >
          {target.label}
        </text>
      </g>
    );
  }
  const vertexOverlay =
    pointMode && active?.kind === 'polygon' ? (
      <PathHandles
        points={active.points.slice(0, -1).map((p, index) => ({
          id: String(index),
          x:
            vertexPreview?.id === active.id && vertexPreview.index === index
              ? vertexPreview.point.x
              : p.x,
          y:
            vertexPreview?.id === active.id && vertexPreview.index === index
              ? vertexPreview.point.y
              : p.y,
          label: 'Vertex ' + index,
          kind: 'anchor' as const,
        }))}
        zoom={view.zoom}
        selected={vertexPreview?.index.toString()}
        revision={session.current.revision.sequence}
        disabled={readonly || active.locked}
        select={() => true}
        begin={() => !readonly && !active.locked}
        preview={(id, point) => setVertexPreview({ id: active.id, index: Number(id), point })}
        commit={(id, point) => {
          if (active.locked) return;
          const featureId = active.id,
            index = Number(id);
          setVertexPreview(undefined);
          commit('vertex', (current) => ({
            features: current.features.map((f) => {
              if (f.id !== featureId) return f;
              const pts = f.points.map((p) => ({ ...p }));
              pts[index] = point;
              if (index === 0) pts[pts.length - 1] = { ...point };
              return { ...f, points: pts };
            }),
          }));
        }}
        cancel={() => setVertexPreview(undefined)}
        keyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) setVertexPreview(undefined);
        }}
      />
    ) : undefined;
  return (
    <main>
      <div>
        <button
          disabled={readonly || !session.current.canUndo}
          onClick={() => {
            session.current.undo();
            refresh((n) => n + 1);
          }}
        >
          Undo
        </button>
        <button
          disabled={readonly || !session.current.canRedo}
          onClick={() => {
            session.current.redo();
            refresh((n) => n + 1);
          }}
        >
          Redo
        </button>
        <button
          onClick={() => {
            setPointMode((v) => !v);
            setVertexPreview(undefined);
          }}
        >
          Toggle vertex mode
        </button>
        <button
          onClick={() => {
            setSelected(['concave']);
            setPointMode(false);
          }}
        >
          Select concave
        </button>
        <button
          onClick={() => {
            commit('visibility', (current) => ({
              features: current.features.map((f) =>
                f.id === 'concave' ? { ...f, hidden: !f.hidden } : f,
              ),
            }));
          }}
        >
          Toggle hidden concave
        </button>
        <button onClick={() => setReverseOrder((v) => !v)}>Reverse paint order</button>
        <button
          onClick={() =>
            commit('visibility', (current) => ({
              features: current.features.map((f) =>
                f.id === 'upper' ? { ...f, hidden: !f.hidden } : f,
              ),
            }))
          }
        >
          Toggle hidden upper
        </button>
        <button
          onClick={() =>
            commit('lock', (current) => ({
              features: current.features.map((f) =>
                f.id === 'concave' ? { ...f, locked: !f.locked } : f,
              ),
            }))
          }
        >
          Toggle locked concave
        </button>
        <button
          onClick={() =>
            commit('external', (current) => ({
              features: current.features.map((f) =>
                f.id === 'river'
                  ? { ...f, points: f.points.map((p) => ({ ...p, y: p.y + 5 })) }
                  : f,
              ),
            }))
          }
        >
          External revision
        </button>
        <label>
          Virtualize
          <input
            type="checkbox"
            checked={virtualize}
            onChange={(e) => setVirtualize(e.target.checked)}
          />
        </label>
        <label>
          Read only
          <input
            type="checkbox"
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
          />
        </label>
      </div>
      <div
        style={{ width: '100%', height: 460, position: 'relative' }}
        data-testid="stage-host"
        onPointerDownCapture={(e) => {
          // Point gestures own separate revision checks and can stop propagation.
          objectGestureRevision.current = pointMode
            ? undefined
            : {
                pointerId: e.pointerId,
                startedAt: e.timeStamp,
                sequence: session.current.revision.sequence,
              };
        }}
      >
        <CanvasStage
          label="R0 map probe"
          space="infinite"
          width={850}
          height={450}
          minZoom={1e-12}
          virtualize={virtualize}
          targets={targets}
          selected={selected}
          onSelect={setSelected}
          readOnly={readonly}
          objectRevision={`${session.current.revision.sessionId}:${session.current.revision.sequence}`}
          view={view}
          onViewChange={setView}
          onTransform={transform}
          previewTransform={previewTransform}
          onDelete={() => setError('Delete not supported')}
          inputOwner={pointMode ? 'point' : 'object'}
          onPointKeyDown={(e) => {
            if (e.key === 'Escape') setVertexPreview(undefined);
          }}
          overlay={
            <>
              {vertexOverlay}
              <foreignObject x={20} y={350} width={220} height={35}>
                <input aria-label="Fixture text input" readOnly={readonly} />
              </foreignObject>
            </>
          }
          render={renderFeature}
        />
      </div>
      <output data-testid="transform-requests">{transformRequests.current}</output>
      <output data-testid="selection">{selected.join(',')}</output>
      <output data-testid="revision">{session.current.revision.sequence}</output>
      <output data-testid="error">{error}</output>
      <output data-testid="native">{JSON.stringify(content)}</output>
      <output data-testid="camera">{JSON.stringify(view)}</output>
      <output data-testid="vertex-preview">
        {vertexPreview ? JSON.stringify(vertexPreview) : ''}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Probe />);
