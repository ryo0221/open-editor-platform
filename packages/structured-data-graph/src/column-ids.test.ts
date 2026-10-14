import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { type StructuredData, isStructuredData } from '@editor-platform/structured-data/model';
import { DataSession } from '@editor-platform/structured-data/session';
import { updateColumn, reorderColumn } from '@editor-platform/structured-data/views';
import {
  GraphBinding,
  isGraphProfile,
  isGraphDocument,
} from '@editor-platform/structured-graph/model';
import { dataGraphAdapter, dataFieldId, dataColumnId, dataNodeId, dataEdgeId } from './adapter';
it.each([
  '',
  'constructor',
  'prototype',
  '__proto__',
  'x'.repeat(512),
  'x'.repeat(513),
  '🔥'.repeat(17000),
  '\ud800'.repeat(700),
  'field:constructor',
  'field-hash:reserved',
])('edits and reconnects arbitrary column IDs without changing native IDs (%#)', (id) => {
  const relation = `field:${id}`;
  const original: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id, name: 'Name', type: 'text' },
      { id: relation, name: 'Related', type: 'relation' },
    ],
    rows: [
      {
        id: 'a',
        values: Object.fromEntries([
          [id, 'Alpha'],
          [relation, 'b'],
          ['unshown', 'Retain'],
        ]),
      },
      {
        id: 'b',
        values: Object.fromEntries([
          [id, 'Beta'],
          [relation, null],
        ]),
      },
    ],
    graphView: { schemaVersion: 1, labelColumnId: id, positions: {} },
  };
  expect(isStructuredData(original)).toBe(true);
  const session = new DataSession(original);
  const binding = new GraphBinding({
    adapter: dataGraphAdapter,
    sourceId: 'columns',
    read: () => ({
      content: session.content,
      revision: canonicalJson(session.revision),
      readOnly: false,
    }),
    execute: (cmd) => {
      session.execute(cmd);
    },
  });
  const view = binding.project();
  expect(isGraphProfile(view.profile)).toBe(true);
  expect(isGraphDocument(view.graph)).toBe(true);
  expect(dataFieldId(id)).not.toBe(dataFieldId(relation));
  expect(dataFieldId(id).length).toBeLessThanOrEqual(512);
  expect(view.profile.nodes.record.ui?.labelField).toBe(dataFieldId(id));
  expect(dataColumnId(view.graph.edges[0].type, original)).toBe(relation);
  binding.apply(
    [
      {
        type: 'set-attribute',
        scope: 'node',
        id: dataNodeId('a'),
        path: [dataFieldId(id)],
        value: 'Edited',
      },
    ],
    view.stamp,
  );
  binding.apply(
    [
      {
        type: 'reconnect-edge',
        id: dataEdgeId('a', relation),
        from: dataNodeId('a'),
        to: dataNodeId('a'),
      },
    ],
    binding.project().stamp,
  );
  expect(session.content.rows[0].values[id]).toBe('Edited');
  expect(session.content.rows[0].values[relation]).toBe('a');
  expect(session.content.rows[0].values.unshown).toBe('Retain');
  expect(session.content.columns.map((c) => c.id)).toEqual([id, relation]);
  expect(session.content.graphView?.labelColumnId).toBe(id);
  session.undo();
  session.undo();
  expect(session.content).toEqual(original);
  session.execute(updateColumn(id, { name: 'Renamed' }));
  session.execute(reorderColumn(relation, id));
  expect(dataColumnId(dataFieldId(id), session.content)).toBe(id);
  expect(binding.project().graph.edges[0].id).toBe(view.graph.edges[0].id);
  expect(binding.project().graph.nodes[0].attributes[dataFieldId(id)]).toBe('Alpha');
  session.undo();
  session.undo();
  expect(session.content).toEqual(original);
});
it('keeps hashed-column namespaces collision-free and maps formula diagnostics to projected fields', () => {
  const id = 'x'.repeat(513),
    projected = dataFieldId(id);
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id, name: 'Long field', type: 'text' },
      { id: projected, name: 'Literal hash', type: 'text' },
      { id: 'constructor', name: 'Computed', type: 'formula', formula: '[missing]' },
    ],
    rows: [{ id: 'a', values: { [id]: 'First', [projected]: 'Second' } }],
  };
  expect(new Set(data.columns.map((c) => dataFieldId(c.id))).size).toBe(3);
  expect(dataColumnId(projected, data)).toBe(id);
  expect(dataColumnId(dataFieldId(projected), data)).toBe(projected);
  expect(dataGraphAdapter.diagnostics?.(data)?.[0].path).toEqual([dataFieldId('constructor')]);
});
it('deduplicates projected enum options while preserving canonical options, IDs, hidden values and Undo', () => {
  const original: StructuredData = {
    schemaVersion: 2,
    columns: [
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: ['Planned', 'Planned', 'Done', 'Done'],
      },
    ],
    rows: [{ id: 'record', values: { status: 'Planned', hidden: 'Keep' } }],
  };
  const session = new DataSession(original),
    binding = new GraphBinding({
      adapter: dataGraphAdapter,
      sourceId: 'duplicates',
      read: () => ({
        content: session.content,
        revision: canonicalJson(session.revision),
        readOnly: false,
      }),
      execute: (cmd) => {
        session.execute(cmd);
      },
    });
  const view = binding.project();
  expect(view.profile.nodes.record.schema.status.enum).toEqual(['Planned', 'Done']);
  binding.apply(
    [
      {
        type: 'set-attribute',
        scope: 'node',
        id: dataNodeId('record'),
        path: ['status'],
        value: 'Done',
      },
    ],
    view.stamp,
  );
  expect(session.content.columns).toEqual(original.columns);
  expect(session.content.rows[0].values).toEqual({ status: 'Done', hidden: 'Keep' });
  expect(session.undo()).toEqual(original);
});
