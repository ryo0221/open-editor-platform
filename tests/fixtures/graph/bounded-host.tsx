/** Independent public-API browser fixture for trusted Host Profile variants. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  GraphSurface,
  createGraph,
  graphCommand,
  type GraphProfile,
} from '@editor-platform/structured-graph';
const base: GraphProfile = {
  schemaVersion: 2,
  sections: {},
  id: 'bounded-ui',
  version: 1,
  graph: { schema: {} },
  nodes: {
    item: {
      schema: {
        name: { type: 'string', maxLength: 3, required: true },
        negative: { type: 'number', maximum: -1, required: true },
        bounded: { type: 'number', minimum: -10, maximum: -5 },
        positive: { type: 'number', minimum: 2, maximum: 4 },
        requiredObject: {
          type: 'object',
          required: true,
          properties: { count: { type: 'number', minimum: 1 } },
        },
        optional: { type: 'string', maxLength: 0 },
      },
      ui: { label: 'Item', labelField: 'name' },
    },
  },
  edges: {
    related: {
      schema: {},
      ui: { label: 'Related' },
      connection: { from: ['item'], to: ['item'], allowSelf: true },
    },
  },
};
function Host() {
  const [session] = useState(() => new EditorSession(createGraph(base)));
  const [readOnly, setReadOnly] = useState(false),
    [selected, select] = useState<string>();
  const [, refresh] = useState(0);
  const profile = { ...base, graph: { ...base.graph, readOnly } };
  const changed = () => refresh((n) => n + 1);
  return (
    <main>
      <h1>Independent bounded Graph Host</h1>
      <label>
        <input
          aria-label="Profile read only"
          type="checkbox"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
        />
        Profile read only
      </label>
      <button
        disabled={readOnly || !session.canUndo}
        onClick={() => {
          session.undo();
          changed();
        }}
      >
        Host Undo
      </button>
      <button
        disabled={readOnly || !session.canRedo}
        onClick={() => {
          session.redo();
          changed();
        }}
      >
        Host Redo
      </button>
      <GraphSurface
        content={session.content}
        profile={profile}
        stamp={canonicalJson({ revision: session.revision, profile })}
        select={select}
        selectedId={selected}
        onEdit={(intents) => {
          session.execute(graphCommand(profile, intents, canonicalJson(session.content)));
          changed();
        }}
      />
      <pre data-testid="bounded-source">{JSON.stringify(session.content)}</pre>
      <pre data-testid="bounded-revision">{JSON.stringify(session.revision)}</pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
