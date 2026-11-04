/** Independent native Graph fixture: fractional pointer coordinates and section membership. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GraphSurface,
  GraphSession,
  createGraph,
  type GraphProfile,
} from '@editor-platform/structured-graph';

const profile: GraphProfile = {
  schemaVersion: 2,
  id: 'fractional-drag',
  version: 1,
  graph: { schema: {} },
  sections: { group: { schema: { name: { type: 'string' } }, ui: { labelField: 'name' } } },
  nodes: {
    item: {
      schema: { name: { type: 'string' } },
      ui: { labelField: 'name', shape: 'rounded-rectangle' },
    },
  },
  edges: { after: { schema: {}, ui: { label: '後に' } } },
};
const content = createGraph({ id: profile.id, version: profile.version }, 'fractional-drag');
const groups = [[1, 2, 3], [4, 5], [6], [7]];
for (const [column, ids] of groups.entries()) {
  const id = `g${column + 1}`;
  content.sections.push({ id, type: 'group', attributes: { name: `Group ${column + 1}` } });
  content.presentation.sections[id] = { x: column * 220, y: 0, width: 200, height: 352 };
  for (const [row, number] of ids.entries()) {
    const nodeId = `n${number}`;
    content.nodes.push({
      id: nodeId,
      type: 'item',
      attributes: { name: `Item ${number}` },
      sectionId: id,
    });
    content.presentation.nodes[nodeId] = { x: column * 220 + 20, y: row * 94 + 50 };
  }
}
for (let n = 2; n <= 7; n++)
  content.edges.push({
    id: `e${n}`,
    type: 'after',
    from: `n${n}`,
    to: `n${n - 1}`,
    attributes: {},
  });

function Host() {
  const [session] = useState(() => new GraphSession(content, profile));
  const [graph, setGraph] = useState(session.content);
  const [selected, select] = useState<string>();
  const [edits, setEdits] = useState(0);
  const width = Number(new URLSearchParams(location.search).get('width') || 960);
  return (
    <main>
      <div style={{ width, height: 520 }}>
        <GraphSurface
          content={graph}
          profile={profile}
          stamp={session.stamp}
          selectedId={selected}
          select={select}
          showInspector={!!selected}
          initialView="fit"
          sectionDropOutside="keep"
          nodeSize={{ width: 160, height: 64 }}
          onEdit={(intents, stamp) => {
            setGraph(session.execute(intents, stamp));
            setEdits((n) => n + 1);
            return true;
          }}
        />
      </div>
      <button
        onClick={() => {
          session.undo();
          setGraph(session.content);
        }}
      >
        Host Undo
      </button>
      <output data-testid="edits">{edits}</output>
      <output data-testid="source">{JSON.stringify(graph)}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
