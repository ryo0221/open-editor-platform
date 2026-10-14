/** Independent public-API Host. Experimental backend activation precedes mounting. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson } from '@editor-platform/artifact-core';
import { createDesign, makeDesignElement, DesignSurface } from '@editor-platform/design';
import {
  createWhiteboard,
  makeWhiteboardNode,
  WhiteboardSurface,
} from '@editor-platform/whiteboard';
import { createSpatialIndex } from '@editor-platform/spatial-index';
import { initializeSpatialWasm } from '@editor-platform/spatial-index/experimental';
import './style.css';

const mode = new URLSearchParams(location.search).get('backend') ?? 'typescript';
async function start() {
  if (mode === 'unavailable')
    Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true });
  if (mode !== 'typescript')
    await initializeSpatialWasm(async () => {
      if (mode === 'broken') return new Uint8Array([0, 1, 2]);
      return (await fetch('/experimental-spatial.wasm')).arrayBuffer();
    });
  const probe = createSpatialIndex([]),
    backend = probe.backend;
  probe.dispose();
  const geometry = Array.from({ length: 5 }, (_, i) => ({
    id: `shape-${i}`,
    bounds: { x: 60 + i * 90, y: 60, width: 60, height: 80 },
    rotation: i === 1 ? 35 : 0,
    locked: i === 3,
    hidden: i === 4,
  }));
  const design = {
    ...createDesign(),
    elements: geometry.map((g, i) => ({
      ...makeDesignElement('rectangle', i),
      ...g,
      name: g.id,
    })),
  };
  const board = {
    ...createWhiteboard(),
    nodes: geometry.map((g, i) => ({
      ...makeWhiteboardNode('rectangle', i),
      ...g,
      text: g.id,
    })),
  };
  function Host() {
    const [readOnly, setReadOnly] = useState(false);
    const [kind, setKind] = useState('design'),
      [selected, select] = useState<string[]>([]);
    const [mounted, setMounted] = useState(true);
    const layout = { hideToolbar: true, defaultPanels: { left: false, right: false } };
    return (
      <main>
        <h1>Spatial selection Host</h1>
        <output data-testid="backend">{backend}</output>
        <label>
          <input
            type="checkbox"
            aria-label="Read only"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />{' '}
          Read only
        </label>
        <label>
          Surface{' '}
          <select
            aria-label="Surface"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              select([]);
            }}
          >
            <option value="design">Design</option>
            <option value="whiteboard">Whiteboard</option>
          </select>
        </label>
        <button onClick={() => setMounted(!mounted)}>Toggle mount</button>
        <output data-testid="selection">{selected.join(',')}</output>
        <div className="host-surface">
          {mounted &&
            (kind === 'design' ? (
              <DesignSurface
                content={design}
                execute={() => false}
                select={select}
                readOnly={readOnly}
                layout={layout}
              />
            ) : (
              <WhiteboardSurface
                content={board}
                execute={() => false}
                select={select}
                readOnly={readOnly}
                layout={layout}
              />
            ))}
        </div>
        <pre data-testid="source">{canonicalJson(kind === 'design' ? design : board)}</pre>
      </main>
    );
  }
  createRoot(document.getElementById('root')!).render(<Host />);
}
void start();
