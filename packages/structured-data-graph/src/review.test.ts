import { expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  createArtifact,
  commitVersion,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import {
  removeColumn,
  addColumn,
  setCell,
  validateData,
  isStructuredData,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { DataSession, assertDataIntegrity } from '@editor-platform/structured-data/session';
import { guardDataCommand } from '@editor-platform/structured-data/session';
import { updateColumn, setCells } from '@editor-platform/structured-data/views';
import { command } from '@editor-platform/editor-core';
import { GraphBinding, isGraphDocument } from '@editor-platform/structured-graph/model';
import {
  createDataGraphFixture,
  createDataGraphNode,
  dataGraphAdapter,
  dataNodeId,
  dataRowId,
  dataEdgeId,
  dataFieldId,
} from './adapter';
function host(source = createDataGraphFixture()) {
  const session = new DataSession(source);
  const binding = new GraphBinding({
    adapter: dataGraphAdapter,
    sourceId: 'data',
    read: () => ({
      content: session.content,
      revision: canonicalJson(session.revision),
      readOnly: false,
    }),
    execute: (cmd) => {
      session.execute(cmd);
    },
  });
  return { session, binding };
}
it('initializes a first-column graph label atomically and preserves it during moves, versions and Undo', async () => {
  const empty: StructuredData = {
    schemaVersion: 2,
    columns: [],
    rows: [{ id: 'row', values: {} }],
    graphView: { schemaVersion: 1, labelColumnId: null, positions: { row: { x: 11, y: 22 } } },
  };
  const { session, binding } = host(empty);
  session.execute(
    addColumn({ id: 'label', name: 'Label', type: 'text', defaultValue: 'Retained' }),
  );
  const added = session.content;
  expect(added.graphView).toEqual({ ...empty.graphView, labelColumnId: 'label' });
  expect(isStructuredData(added)).toBe(true);
  const legacy = clone(added);
  legacy.graphView!.labelColumnId = null;
  expect(isStructuredData(legacy)).toBe(true);
  const legacyHost = host(legacy);
  expect(legacyHost.binding.project().profile.nodes.record.ui?.labelField).toBe(
    dataFieldId('label'),
  );
  expect(legacyHost.session.content).toEqual(legacy);
  binding.apply(
    [{ type: 'move-node', id: dataNodeId('row'), position: { x: 33, y: 44 } }],
    binding.project().stamp,
  );
  expect(session.content.graphView?.labelColumnId).toBe('label');
  expect(session.content.rows).toEqual(added.rows);
  const saved = await commitVersion(
    createArtifact('data', 'Label', session.content),
    'test',
    'Move',
  );
  expect(JSON.parse(serializeArtifact(saved)).draft.content).toEqual(session.content);
  expect(session.undo()).toEqual(added);
  expect(session.undo()).toEqual(empty);
  expect(session.redo()).toEqual(added);
  session.execute(addColumn({ id: 'second', name: 'Second', type: 'text' }));
  expect(session.content.graphView?.labelColumnId).toBe('label');
  session.execute(removeColumn('label'));
  expect(session.content.graphView?.labelColumnId).toBe('second');
  session.execute(removeColumn('second'));
  expect(session.content.graphView?.labelColumnId).toBeNull();
  expect(isStructuredData(session.content)).toBe(true);
});
it('reads, diagnoses and repairs legacy references without introducing new invalid references', () => {
  const original = createDataGraphFixture();
  original.rows[0].values.related = 'legacy-missing';
  original.rows[1].values.related = 'another-legacy-missing';
  const { session, binding } = host(original);
  expect(session.content).toEqual(original);
  expect(validateData(session.content).filter((d) => d.columnId === 'related')).toHaveLength(2);
  expect(() => binding.project()).toThrow('existing record');
  session.execute(setCell('research', 'name', 'Retained draft edit'));
  expect(session.content.rows[0].values.related).toBe('legacy-missing');
  expect(() => session.execute(setCell('delivery', 'related', 'new-missing'))).toThrow(
    'existing record',
  );
  session.execute(setCell('research', 'related', 'delivery'));
  expect(session.content.rows[1].values.related).toBe('another-legacy-missing');
  session.execute(setCell('planning', 'related', null));
  expect(() => assertDataIntegrity(session.content)).not.toThrow();
  expect(binding.project().graph.edges[0].to).toBe(dataNodeId('delivery'));
  session.undo();
  expect(session.content.rows[1].values.related).toBe('another-legacy-missing');
  expect(original.rows[0].values.related).toBe('legacy-missing');
});
it('explicitly locks, renames, unlocks and deletes a field without allowing value writes during unlock', () => {
  const { session, binding } = host(),
    initial = session.content;
  session.execute(guardDataCommand(updateColumn('name', { readOnly: true })));
  const locked = session.content,
    revision = session.revision;
  for (const cmd of [
    setCell('research', 'name', 'Headless'),
    setCells([{ rowId: 'research', columnId: 'name', value: 'Grid/Form' }]),
    command('data.update-column', 'Forged unlock and edit', (d: StructuredData) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === 'name' ? { ...c, readOnly: false } : c)),
      rows: d.rows.map((r) =>
        r.id === 'research' ? { ...r, values: { ...r.values, name: 'Bypass' } } : r,
      ),
    })),
  ])
    expect(() => session.execute(cmd)).toThrow('read only');
  expect(() =>
    binding.apply(
      [
        {
          type: 'set-attribute',
          scope: 'node',
          id: dataNodeId('research'),
          path: ['name'],
          value: 'Graph',
        },
      ],
      binding.project().stamp,
    ),
  ).toThrow('read only');
  expect(session.content).toEqual(locked);
  expect(session.revision).toEqual(revision);
  session.execute(updateColumn('name', { name: 'Renamed' }));
  expect(session.content.rows).toEqual(locked.rows);
  session.readOnly = true;
  expect(() => session.execute(updateColumn('name', { readOnly: false }))).toThrow('read only');
  session.readOnly = false;
  session.execute(guardDataCommand(updateColumn('name', { readOnly: false })));
  session.execute(setCell('research', 'name', 'Unlocked edit'));
  session.undo();
  session.undo();
  expect(session.content.columns.find((c) => c.id === 'name')?.readOnly).toBe(true);
  session.undo();
  session.undo();
  expect(session.content).toEqual(initial);
  session.execute(updateColumn('name', { readOnly: true }));
  const beforeDelete = session.content;
  session.execute(removeColumn('name'));
  expect(session.content.columns.some((c) => c.id === 'name')).toBe(false);
  expect(session.undo()).toEqual(beforeDelete);
});
it('retains positions after the last column is removed and edits zero-column rows', async () => {
  const d = createDataGraphFixture();
  d.rows.forEach((r) => {
    r.values.related = null;
  });
  d.graphView = {
    schemaVersion: 1,
    labelColumnId: 'name',
    positions: { research: { x: 11, y: 22 } },
  };
  const { session, binding } = host(d);
  for (const c of d.columns) session.execute(removeColumn(c.id));
  expect(session.content.graphView).toEqual({ ...d.graphView, labelColumnId: null });
  binding.apply(
    [{ type: 'move-node', id: dataNodeId('research'), position: { x: 33, y: 44 } }],
    binding.project().stamp,
  );
  binding.apply(
    [
      {
        type: 'add-node',
        node: createDataGraphNode(session.content, 'new-row'),
        position: { x: 1, y: 2 },
      },
    ],
    binding.project().stamp,
  );
  expect(session.content.rows.at(-1)).toEqual({ id: 'new-row', values: {} });
  expect(session.content.graphView?.labelColumnId).toBeNull();
  expect(isStructuredData(session.content)).toBe(true);
  const saved = await commitVersion(
    createArtifact('data', 'Empty columns', session.content),
    'test',
    'Zero columns',
  );
  expect(JSON.parse(serializeArtifact(saved)).draft.content).toEqual(session.content);
  session.undo();
  session.undo();
  expect(session.content.graphView?.positions.research).toEqual({ x: 11, y: 22 });
});
it.each([null, undefined, ''])(
  'projects unset relation %s without rewriting it on unrelated edits',
  (empty) => {
    const d = createDataGraphFixture();
    if (empty === undefined) delete d.rows[0].values.related;
    else d.rows[0].values.related = empty;
    const before = clone(d),
      { session, binding } = host(d);
    expect(binding.project().graph.edges).toHaveLength(0);
    expect(binding.project().graph.nodes[0].attributes.related).toBeNull();
    binding.apply(
      [
        {
          type: 'set-attribute',
          scope: 'node',
          id: dataNodeId('research'),
          path: ['name'],
          value: 'Changed',
        },
      ],
      binding.project().stamp,
    );
    expect(Object.hasOwn(session.content.rows[0].values, 'related')).toBe(
      Object.hasOwn(before.rows[0].values, 'related'),
    );
    expect(session.content.rows[0].values.related).toBe(empty);
    binding.apply(
      [
        {
          type: 'add-edge',
          edge: {
            id: dataEdgeId('research', 'related'),
            type: 'related',
            from: dataNodeId('research'),
            to: dataNodeId('planning'),
            attributes: {},
          },
        },
      ],
      binding.project().stamp,
    );
    expect(session.content.rows[0].values.related).toBe('planning');
    binding.apply(
      [{ type: 'delete-edge', id: dataEdgeId('research', 'related') }],
      binding.project().stamp,
    );
    expect(session.content.rows[0].values.related).toBeNull();
  },
);
it('maps empty, boundary, huge Unicode and surrogate IDs stably without changing canonical IDs', () => {
  const d = createDataGraphFixture();
  const ids = ['', 'x'.repeat(507), 'x'.repeat(508), '🔥'.repeat(17000), '\ud800'.repeat(700)];
  d.rows = ids.map((id, i) => ({
    id,
    values: {
      name: `Record ${i}`,
      category: 'Topic',
      active: false,
      related: i === 0 ? ids[3] : null,
    },
  }));
  const { session, binding } = host(d),
    graph = binding.project().graph;
  expect(isGraphDocument(graph)).toBe(true);
  expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(ids.length);
  for (const id of ids) {
    expect(dataNodeId(id).length).toBeLessThanOrEqual(512);
    expect(dataRowId(dataNodeId(id), d)).toBe(id);
    expect(dataEdgeId(id, 'related').length).toBeLessThanOrEqual(512);
  }
  expect(graph.nodes[0].attributes.related).toBe(dataNodeId(ids[3]));
  binding.apply(
    [
      {
        type: 'set-attribute',
        scope: 'node',
        id: dataNodeId(ids[3]),
        path: ['name'],
        value: 'Long ID edited',
      },
      { type: 'move-node', id: dataNodeId(''), position: { x: 31, y: 32 } },
    ],
    binding.project().stamp,
  );
  expect(session.content.rows.map((r) => r.id)).toEqual(ids);
  expect(session.content.rows[3].values.name).toBe('Long ID edited');
  expect(session.content.graphView?.positions['']).toEqual({ x: 31, y: 32 });
  const reordered = { ...session.content, rows: [...session.content.rows].reverse() };
  expect(dataGraphAdapter.project(reordered).nodes.map((n) => n.id)).toEqual(
    [...graph.nodes.map((n) => n.id)].reverse(),
  );
  const before = session.content;
  expect(() =>
    binding.apply(
      [
        {
          type: 'add-edge',
          edge: {
            id: dataEdgeId(ids[1], 'related'),
            type: 'related',
            from: dataNodeId(ids[1]),
            to: dataNodeId(''),
            attributes: {},
          },
        },
      ],
      binding.project().stamp,
    ),
  ).toThrow('empty record ID');
  expect(session.content).toEqual(before);
});
