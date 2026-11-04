import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorSession } from '@editor-platform/editor-core';
import { FictionMapSurface } from '@editor-platform/fiction-map/surface';
import '@editor-platform/fiction-map/styles.css';
import {
  commitFictionMapChange,
  createFictionMap,
  prepareFictionMapChange,
  redoFictionMap,
  serializeFictionMap,
  undoFictionMap,
  validateFictionMap,
  type FictionMapBase,
  type FictionMapContent,
  type FictionMapPermission,
} from '@editor-platform/fiction-map/model';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { CanvasView } from '@editor-platform/canvas-ui';
function initial(): FictionMapContent {
  const result = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      unit: { name: 'map-unit' },
      yAxis: new URLSearchParams(location.search).get('axis') === 'up' ? 'up' : 'down',
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400 },
    },
    layers: [
      { id: 'terrain', name: 'Terrain', purpose: 'terrain', visibleByDefault: true },
      { id: 'places', name: 'Places', purpose: 'settlement', visibleByDefault: true },
    ],
    features: [
      {
        id: 'region',
        name: 'Cape',
        layerId: 'terrain',
        featureKind: 'region',
        geometry: {
          type: 'polygon',
          outer: [
            [50, 60],
            [260, 60],
            [260, 120],
            [120, 120],
            [120, 260],
            [50, 260],
            [50, 60],
          ],
        },
        worldEntityRef: { namespace: 'world', entityId: 'cape' },
      },
      {
        id: 'overlap',
        name: 'Harbor',
        layerId: 'terrain',
        featureKind: 'region',
        geometry: {
          type: 'polygon',
          outer: [
            [70, 80],
            [150, 80],
            [150, 150],
            [70, 150],
            [70, 80],
          ],
        },
        style: { color: '#ad7a22' },
      },
      {
        id: 'road',
        name: 'North road',
        layerId: 'terrain',
        featureKind: 'path',
        geometry: {
          type: 'polyline',
          coordinates: [
            [320, 80],
            [520, 80],
            [520, 200],
          ],
        },
        style: { color: '#954b42', lineWidth: 8 },
      },
      {
        id: 'town',
        name: 'Port',
        layerId: 'places',
        featureKind: 'place',
        geometry: { type: 'point', coordinates: [340, 260] },
        worldEntityRef: { namespace: 'world', entityId: 'port' },
      },
    ],
    namedViews: [],
  });
  if (!result.ok) throw Error(result.diagnostic.code);
  return result.value;
}
function Host() {
  const [initialState] = useState(() => {
    const content = initial();
    const session = new EditorSession(content);
    return { session, base: { content, revision: session.revision } };
  });
  const session = useRef(initialState.session),
    [base, setBase] = useState<FictionMapBase>(initialState.base);
  const [readOnly, setReadOnly] = useState(false),
    [locked, setLocked] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [view, setView] = useState<CanvasView>(),
    [, rerender] = useState(0),
    [last, setLast] = useState('Ready');
  const current = useRef({ base, readOnly, locked });
  current.current = { base, readOnly, locked };
  const gate: FictionMapPermission = (before, after) =>
    !current.current.readOnly &&
    !current.current.locked.some(
      (id) =>
        canonicalJson(before.features.find((f) => f.id === id) ?? null) !==
        canonicalJson(after.features.find((f) => f.id === id) ?? null),
    );
  function adopt<T extends FictionMapBase & { changed: boolean }>(
    result: { ok: true; value: T } | { ok: false; diagnostic: { code: string } },
  ) {
    if (result.ok) {
      current.current = { ...current.current, base: result.value };
      setBase(result.value);
      setLast(result.value.changed ? 'Changed' : 'No change');
    } else setLast(result.diagnostic.code);
  }
  const native = serializeFictionMap(base.content);
  if (!native.ok) throw Error(native.diagnostic.code);
  return (
    <main>
      <header>
        <h1>Fiction Map</h1>
        <p>Independent local Surface · no Playground or storage integration</p>
      </header>
      <details className="host-controls">
        <summary>Host test controls</summary>
        <label>
          <input
            aria-label="Host read only"
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read only
        </label>
        <button onClick={() => setLocked(locked.length ? [] : [...selected])}>
          Toggle selected lock
        </button>
        <button onClick={() => rerender((n) => n + 1)}>Same revision render</button>
        <button
          onClick={() =>
            setView((v) => (v ? { ...v, fit: false, pan: { x: v.pan.x + 5, y: v.pan.y + 3 } } : v))
          }
        >
          Camera update
        </button>
        <button onClick={() => setSelected(['overlap'])}>Select Harbor from Host</button>
        <button
          onClick={() => {
            const b = current.current.base;
            const prep = prepareFictionMapChange(b, {
              create: [
                {
                  id: 'horizontal',
                  name: 'Horizontal',
                  featureKind: 'path',
                  layerId: 'terrain',
                  geometry: {
                    type: 'polyline',
                    coordinates: [
                      [300, 300],
                      [460, 300],
                    ],
                  },
                },
                {
                  id: 'vertical',
                  name: 'Vertical',
                  featureKind: 'path',
                  layerId: 'terrain',
                  geometry: {
                    type: 'polyline',
                    coordinates: [
                      [550, 220],
                      [550, 340],
                    ],
                  },
                },
              ],
            });
            if (prep.ok) adopt(commitFictionMapChange(session.current, prep.value, gate));
          }}
        >
          Add axis paths
        </button>
        <button onClick={() => setSelected(base.content.features.map((f) => f.id))}>
          Select all from Host
        </button>
        <button
          onClick={() => {
            const b = current.current.base,
              f = b.content.features.find((f) => f.id === 'town');
            if (!f) return;
            const prep = prepareFictionMapChange(b, {
              update: [
                {
                  ...f,
                  name: 'External port',
                  geometry: { type: 'point', coordinates: [380, 280] },
                },
              ],
            });
            if (prep.ok) adopt(commitFictionMapChange(session.current, prep.value, () => true));
          }}
        >
          External native update
        </button>
        <button
          onClick={() => {
            session.current = new EditorSession(base.content);
            setBase({ content: base.content, revision: session.current.revision });
          }}
        >
          Replace session
        </button>
        <output data-testid="host-status">{last}</output>
      </details>
      <FictionMapSurface
        base={base}
        selected={selected}
        onSelectionChange={setSelected}
        view={view}
        onViewChange={setView}
        readOnly={readOnly}
        lockedFeatureIds={locked}
        canUndo={session.current.canUndo}
        canRedo={session.current.canRedo}
        onCommit={(prepared) => {
          const result = commitFictionMapChange(session.current, prepared, gate);
          adopt(result);
          return result;
        }}
        onUndo={() => {
          const result = undoFictionMap(session.current, gate);
          adopt(result);
          return result;
        }}
        onRedo={() => {
          const result = redoFictionMap(session.current, gate);
          adopt(result);
          return result;
        }}
      />
      <details className="host-diagnostics">
        <summary>Native diagnostics</summary>
        <pre data-testid="native">{native.value}</pre>
        <pre data-testid="revision">{JSON.stringify(base.revision)}</pre>
        <pre data-testid="view">{JSON.stringify(view)}</pre>
        <pre data-testid="selection">{JSON.stringify(selected)}</pre>
        <pre data-testid="history">
          {JSON.stringify({ undo: session.current.canUndo, redo: session.current.canRedo })}
        </pre>
      </details>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
const style = document.createElement('style');
style.textContent =
  'body{margin:0;background:#e8eff2;color:#183341;font-family:system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:16px}main>header{display:flex;align-items:baseline;flex-wrap:wrap;gap:16px}h1{font-size:24px;margin:4px 0}main>header p{font-size:13px}.host-controls,.host-diagnostics{margin:12px 0;padding:8px;background:white;border-radius:6px}.host-controls button{margin:4px;padding:5px}.host-diagnostics pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}@media(max-width:700px){main{padding:8px}}';
document.head.append(style);
