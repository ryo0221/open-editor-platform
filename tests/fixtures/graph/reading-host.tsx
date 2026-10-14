/** Fictional public-API Host: no Playground state, CSS or product model. */
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import {
  GraphSurface,
  createGraph,
  graphCommand,
  type GraphProfile,
  type GraphSurfaceProps,
  type GraphNode,
} from '@editor-platform/structured-graph';

const colors = ['#b91c1c', '#1d4ed8', '#15803d', '#7e22ce', '#a16207', '#0e7490', '#be185d'];
const profile: GraphProfile = {
  schemaVersion: 1,
  id: 'reading-fixture',
  version: 1,
  graph: { schema: { name: { type: 'string' } } },
  nodes: {
    item: {
      schema: { name: { type: 'string', required: true } },
      ui: { label: 'Item', labelField: 'name' },
    },
  },
  edges: Object.fromEntries(
    colors.map((color, i) => [
      `relation${i}`,
      {
        schema: {},
        ui: { label: `Relation ${i}`, edgeStyle: { color, dash: i % 2 ? [6, 4] : [] } },
      },
    ]),
  ),
};
const graph = createGraph({ id: profile.id, version: profile.version }, 'reading-graph');
graph.attributes.name = 'Reading fixture';
graph.nodes = Array.from(
  { length: 13 },
  (_, i): GraphNode => ({
    id: `n${i}`,
    type: 'item',
    attributes:
      i === 11
        ? {}
        : {
            name:
              i === 0
                ? '段階の表のどのマスも、ストーリーとつながってから進むための長いノードラベル全文'
                : `Item ${i}`,
          },
  }),
);
graph.layout = Object.fromEntries(
  graph.nodes.map((node, i) => [
    node.id,
    { x: i % 2 ? 1100 : -100, y: 50 + Math.floor(i / 2) * 230 },
  ]),
);
for (let from = 0; from < 12; from += 2)
  for (let to = 1; to < 12; to += 2)
    for (let j = 0; j < 3; j++)
      graph.edges.push({
        id: `e${from}-${to}-${j}`,
        type: `relation${(from + to + j) % 7}`,
        from: `n${from}`,
        to: `n${to}`,
        attributes: {},
      });

function Host() {
  const query = new URLSearchParams(location.search);
  const [inputs] = useState(() => new EditorInputs());
  const inputState = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [flushResult, setFlushResult] = useState('');
  const [session, setSession] = useState(() => {
    const content = structuredClone(graph);
    if (query.has('default-labels')) {
      const names = [
        '長い日本語のノード名を省略せず全体として読める表示を確認します。'.repeat(8),
        'A long English label must wrap at words and remain completely visible in the default host. '.repeat(
          8,
        ),
        'W'.repeat(180),
        Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: explicit line break`).join('\n'),
      ];
      content.nodes = names.map((name, i) => ({ id: `n${i}`, type: 'item', attributes: { name } }));
      content.layout = {
        n0: { x: 0, y: 0 },
        n1: { x: 600, y: 0 },
        n2: { x: 0, y: 1200 },
        n3: { x: 600, y: 1200 },
      };
      content.edges = [
        { id: 'labels01', type: 'relation0', from: 'n0', to: 'n1', attributes: {} },
        { id: 'labels23', type: 'relation1', from: 'n2', to: 'n3', attributes: {} },
      ];
    }
    if (query.has('default-overlap')) content.layout.n1 = { x: 0, y: 200 };
    if (query.has('switch-camera')) content.layout.n12 = { x: 2400, y: 3000 };
    if (query.has('loop-fit')) {
      content.nodes = content.nodes.slice(0, 1);
      content.layout = { n0: { x: 0, y: 0 } };
      content.edges = query.has('fresh')
        ? [{ id: 'loop', type: 'relation0', from: 'n0', to: 'n0', attributes: {} }]
        : [];
    }
    if (query.has('fit-unmeasurable')) {
      content.nodes = content.nodes.slice(0, 3);
      content.layout = {
        n0: { x: 0, y: 0 },
        n1: { x: query.get('fit-unmeasurable') === 'refused' ? 0 : 800, y: 0 },
        n2: { x: 3000, y: 1200 },
      };
      content.edges = [{ id: 'probe', type: 'relation0', from: 'n0', to: 'n1', attributes: {} }];
    }
    if (query.has('wide-label')) {
      content.nodes = content.nodes.slice(0, 2);
      content.layout = { n0: { x: 0, y: 0 }, n1: { x: 800, y: 0 } };
      content.edges = [{ id: 'wide', type: 'relation0', from: 'n0', to: 'n1', attributes: {} }];
    }
    return new EditorSession(content);
  });
  const [selected, select] = useState<string>();
  const [hostReadOnly, setReadOnly] = useState(true),
    [profileReadOnly, setProfileReadOnly] = useState(false);
  const [showInspector, setInspector] = useState(true),
    [highlight, setHighlight] = useState(true),
    [refit, setRefit] = useState(true),
    [sizes, setSizes] = useState(!query.has('wide-label') && !query.has('default-labels'));
  const [nodeFilter, setNodeFilter] = useState(query.has('hidden') ? 'none' : 'all'),
    [edgeFilter, setEdgeFilter] = useState('all');
  const [, refresh] = useState(0);
  const [initialView] = useState<GraphSurfaceProps['initialView']>(() =>
    query.get('view') === 'origin'
      ? 'origin'
      : query.get('view') === 'legacy'
        ? undefined
        : query.get('view') === 'custom'
          ? { x: 30, y: 45, zoom: 0.75 }
          : 'fit',
  );
  const currentProfile = {
    ...profile,
    graph: { ...profile.graph, readOnly: profileReadOnly },
    ...(query.has('wide-label') || query.has('loop-fit') || query.has('fit-unmeasurable')
      ? {
          edges: {
            ...profile.edges,
            relation0: {
              ...profile.edges.relation0,
              ui: {
                label:
                  query.get('fit-unmeasurable') === 'space'
                    ? '   '
                    : query.get('fit-unmeasurable') === 'zero'
                      ? '\u200b'
                      : query.get('fit-unmeasurable') === 'empty'
                        ? ''
                        : 'W'.repeat(60),
              },
            },
          },
        }
      : {}),
  };
  return (
    <main>
      <h1>Independent reading Graph Host</h1>
      <div className="host-controls">
        {[
          ['Host read only', hostReadOnly, setReadOnly],
          ['Profile read only', profileReadOnly, setProfileReadOnly],
          ['Show Inspector', showInspector, setInspector],
          ['Highlight neighbors', highlight, setHighlight],
          ['Refit filters', refit, setRefit],
          ['Custom node sizes', sizes, setSizes],
        ].map(([label, checked, set]) => (
          <label key={String(label)}>
            <input
              type="checkbox"
              checked={checked as boolean}
              onChange={(e) => (set as (checked: boolean) => void)(e.target.checked)}
            />
            {String(label)}
          </label>
        ))}
        <label>
          Node filter
          <select
            aria-label="Node filter"
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
          >
            <option value="all">All nodes</option>
            <option value="pair">One pair</option>
            <option value="none">No nodes</option>
          </select>
        </label>
        <label>
          Edge filter
          <select
            aria-label="Edge filter"
            value={edgeFilter}
            onChange={(e) => setEdgeFilter(e.target.value)}
          >
            <option value="all">All relations</option>
            <option value="relation0">Relation 0</option>
            <option value="none">No relations</option>
          </select>
        </label>
        <button
          disabled={!session.canUndo || hostReadOnly || profileReadOnly}
          onClick={() => {
            session.undo();
            refresh((n) => n + 1);
          }}
        >
          Host Undo
        </button>
        <button onClick={() => refresh((n) => n + 1)}>Host rerender</button>
        <button
          onClick={() => {
            const next = { ...structuredClone(session.content), id: 'reading-graph-b' };
            if (query.has('loop-fit'))
              next.edges = [
                { id: 'loop', type: 'relation0', from: 'n0', to: 'n0', attributes: {} },
              ];
            setSession(new EditorSession(next));
            select(undefined);
          }}
        >
          Switch graph
        </button>
      </div>
      {query.has('inputs') && (
        <>
          <output data-testid="input-state">{JSON.stringify(inputState)}</output>
          <button
            onClick={() => {
              try {
                inputs.flush();
                setFlushResult('saved');
              } catch (error) {
                setFlushResult(String(error));
              }
            }}
          >
            Save boundary
          </button>
          <output data-testid="flush-result">{flushResult}</output>
        </>
      )}
      <EditorInputsContext.Provider value={query.has('inputs') ? inputs : undefined}>
        <div className="host-surface">
          <GraphSurface
            content={session.content}
            profile={currentProfile}
            stamp={canonicalJson({ revision: session.revision, profile: currentProfile })}
            readOnly={hostReadOnly}
            showInspector={showInspector}
            initialView={initialView}
            fitOnFilterChange={refit}
            highlightAdjacent={highlight}
            visibleNodeIds={
              nodeFilter === 'all' ? undefined : nodeFilter === 'pair' ? ['n0', 'n1'] : []
            }
            visibleEdgeTypes={
              edgeFilter === 'all' ? undefined : edgeFilter === 'none' ? [] : [edgeFilter]
            }
            nodeSize={
              sizes
                ? (node) =>
                    node.id === 'n0' ? { width: 320, height: 140 } : { width: 240, height: 100 }
                : undefined
            }
            selectedId={selected}
            select={select}
            sourceActions={{ owner: 'Reading fixture', onEditDefinition: () => false }}
            onEdit={(intents) => {
              if (hostReadOnly || profileReadOnly) return false;
              session.execute(graphCommand(currentProfile, intents));
              refresh((n) => n + 1);
            }}
          />
        </div>
        <output data-testid="reading-selection">{selected ?? ''}</output>
        <output data-testid="reading-revision">
          {JSON.stringify(session.revision)}:{String(session.canUndo)}
        </output>
      </EditorInputsContext.Provider>
      <pre data-testid="reading-source">{canonicalJson(session.content)}</pre>
    </main>
  );
}
const css = document.createElement('style');
css.textContent =
  'body{margin:0;font:14px system-ui}main{padding:8px;max-width:1400px;margin:auto}h1{font-size:18px;margin:0 0 8px}.host-controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.host-controls label{display:flex;align-items:center;gap:4px}.host-surface{height:640px}pre{overflow-wrap:anywhere;white-space:pre-wrap}';
document.head.append(css);
createRoot(document.getElementById('root')!).render(<Host />);
