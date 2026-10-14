import { useState } from 'react';
import { flushSync } from 'react-dom';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { clone } from '@editor-platform/artifact-core';
import {
  CommitInput,
  EditorInputsContext,
  EditorExportGuardContext,
} from '@editor-platform/editor-ui';
import {
  DataSurface,
  defaultView,
  setCells,
  type StructuredData,
} from '@editor-platform/structured-data';
import {
  GraphSurface,
  createRelationGraph,
  relationProfile,
} from '@editor-platform/structured-graph';

export function DataOutputHost() {
  const [inputs] = useState(() => new EditorInputs());
  const [session] = useState(() => {
    const data: StructuredData = {
      schemaVersion: 2,
      columns: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' },
      ],
      rows: [
        { id: 'first', values: { name: 'Visible A', value: 10 } },
        { id: 'second', values: { name: 'Hidden B', value: 20 } },
      ],
    };
    const view = defaultView(data);
    view.projection = 'Chart';
    view.filters = [{ id: 'filter', columnId: 'name', operator: 'contains', value: 'Visible' }];
    view.accent = '#5269c8';
    data.views = [view];
    return new EditorSession(data);
  });
  const [, refresh] = useState(0);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorExportGuardContext.Provider value={() => flushSync(() => inputs.flush())}>
        <CommitInput
          label="Host record value"
          type="number"
          min={0}
          value={String(session.content.rows[1].values.value)}
          onCommit={(value) => {
            session.execute(
              setCells([
                { rowId: 'second', columnId: 'value', value: Number(value) },
                { rowId: 'second', columnId: 'name', value: 'Visible B' },
              ]),
            );
            refresh((n) => n + 1);
          }}
        />
        <div style={{ height: 650 }}>
          <DataSurface
            content={session.content}
            execute={(command) => {
              session.execute(command);
              refresh((n) => n + 1);
              return true;
            }}
            select={() => {}}
          />
        </div>
        <pre data-testid="data-output-source">{JSON.stringify(session.content)}</pre>
      </EditorExportGuardContext.Provider>
    </EditorInputsContext.Provider>
  );
}

export function ScalarGraphHost() {
  const [selected, setSelected] = useState('zero');
  const profile = clone(relationProfile),
    graph = createRelationGraph();
  profile.edges = {
    weight: {
      schema: { label: { type: 'number' } },
      ui: { label: 'Weight', labelField: 'label' },
      connection: { allowParallel: true },
    },
    status: {
      schema: { label: { type: 'boolean' } },
      ui: { label: 'Status', labelField: 'label' },
      connection: { allowParallel: true },
    },
    text: {
      schema: { label: { type: 'string' } },
      ui: { label: 'Text', labelField: 'label' },
      connection: { allowParallel: true },
    },
  };
  const edges = [
    { id: 'zero', type: 'weight', from: 'resource-a', to: 'resource-b', attributes: { label: 0 } },
    {
      id: 'false',
      type: 'status',
      from: 'resource-a',
      to: 'resource-b',
      attributes: { label: false },
    },
    {
      id: 'named',
      type: 'text',
      from: 'resource-a',
      to: 'resource-b',
      attributes: { label: 'Named' },
    },
    { id: 'blank', type: 'text', from: 'resource-a', to: 'resource-b', attributes: { label: ' ' } },
    { id: 'null', type: 'text', from: 'resource-a', to: 'resource-b', attributes: { label: null } },
  ] as typeof graph.edges;
  graph.edges = edges.filter((edge) => edge.id === selected);
  return (
    <>
      <label>
        Host label case
        <select
          aria-label="Host label case"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {edges.map((edge) => (
            <option key={edge.id}>{edge.id}</option>
          ))}
        </select>
      </label>
      <div style={{ height: 650 }}>
        <GraphSurface
          content={graph}
          profile={profile}
          stamp={selected}
          select={() => {}}
          onEdit={() => false}
          readOnly
        />
      </div>
    </>
  );
}
