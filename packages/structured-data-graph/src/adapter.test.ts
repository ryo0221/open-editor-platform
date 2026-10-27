import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  createArtifact,
  serializeArtifact,
  deserializeArtifact,
} from '@editor-platform/artifact-core';
import { command, transaction } from '@editor-platform/editor-core';
import {
  DataSession,
  guardDataCommand,
  assertDataIntegrity,
} from '@editor-platform/structured-data/session';
import { setCell, removeRow, removeColumn } from '@editor-platform/structured-data/model';
import {
  setCells,
  deleteRows,
  updateColumn,
  reorderRow,
  reorderColumn,
  defaultView,
  saveView,
} from '@editor-platform/structured-data/views';
import { GraphBinding, type GraphIntent } from '@editor-platform/structured-graph/model';
import {
  createDataGraphFixture,
  projectDataGraph,
  dataGraphProfile,
  prepareDataGraph,
  dataGraphAdapter,
  dataEdgeId,
  dataNodeId,
  createDataGraphNode,
} from './adapter';
function bind(data = createDataGraphFixture()) {
  const session = new DataSession(data);
  const binding = new GraphBinding({
    adapter: dataGraphAdapter,
    sourceId: 'data',
    read: () => ({
      content: session.content,
      revision: canonicalJson(session.revision),
      readOnly: session.readOnly,
    }),
    execute: (cmd) => {
      session.execute(cmd);
    },
  });
  return { session, binding };
}
const rename: GraphIntent = {
  type: 'set-attribute',
  scope: 'node',
  id: dataNodeId('research'),
  path: ['name'],
  value: 'Changed from Graph',
};
function refuse(session: DataSession, action: () => unknown) {
  const content = session.content,
    rev = session.revision,
    undo = session.canUndo;
  expect(action).toThrow();
  expect(session.content).toEqual(content);
  expect(session.revision).toEqual(rev);
  expect(session.canUndo).toBe(undo);
}
describe('one canonical Data session across Grid/Form/Graph', () => {
  it('refuses node shapes and styles: Data has nowhere to save them', () => {
    const { session, binding } = bind(),
      before = session.content,
      { stamp } = binding.project();
    for (const intent of [
      { type: 'set-node-shape', id: dataNodeId('research'), shape: 'ellipse' },
      { type: 'set-node-style', id: dataNodeId('research'), style: { fill: '#dbeafe' } },
    ] as GraphIntent[])
      expect(() => binding.apply([intent], stamp)).toThrow(/cannot save node shapes/);
    expect(session.content).toEqual(before);
    expect(session.canUndo).toBe(false);
    expect(binding.project().graph.presentation.nodes[dataNodeId('research')]).not.toHaveProperty(
      'shape',
    );
  });
  it('retargets either endpoint as one source transaction and refuses an occupied source', () => {
    const { session, binding } = bind(),
      original = session.content;
    binding.apply(
      [
        {
          type: 'reconnect-edge',
          id: dataEdgeId('research', 'related'),
          from: dataNodeId('delivery'),
          to: dataNodeId('planning'),
        },
      ],
      binding.project().stamp,
    );
    expect(session.content.rows[0].values.related).toBeNull();
    expect(session.content.rows[2].values.related).toBe('planning');
    expect(binding.project().graph.edges[0].id).toBe(dataEdgeId('delivery', 'related'));
    expect(session.undo()).toEqual(original);
    session.execute(setCells([{ rowId: 'delivery', columnId: 'related', value: 'research' }]));
    refuse(session, () =>
      binding.apply(
        [
          {
            type: 'reconnect-edge',
            id: dataEdgeId('research', 'related'),
            from: dataNodeId('delivery'),
            to: dataNodeId('planning'),
          },
        ],
        binding.project().stamp,
      ),
    );
  });
  it('keeps relation IDs as values and updates their labels when a target is renamed', () => {
    const { session, binding } = bind();
    const options = binding.project().profile.nodes.record.ui!.fields!.related.options!;
    expect(options.find((option) => option.value === dataNodeId('planning'))!.label).toBe(
      'Planning',
    );
    session.execute(setCells([{ rowId: 'planning', columnId: 'name', value: 'Renamed target' }]));
    const next = binding.project();
    expect(
      next.profile.nodes.record.ui!.fields!.related.options!.find(
        (option) => option.value === dataNodeId('planning'),
      )!.label,
    ).toBe('Renamed target');
    expect(next.graph.nodes[0].attributes.related).toBe(dataNodeId('planning'));
  });
  it('projects row/column identities with stable relation edge IDs without a Graph artifact', () => {
    const original = createDataGraphFixture(),
      graph = projectDataGraph(original);
    expect(graph.nodes.map((n) => n.id)).toEqual(original.rows.map((r) => dataNodeId(r.id)));
    expect(graph.edges[0]).toEqual({
      id: dataEdgeId('research', 'related'),
      type: 'related',
      from: dataNodeId('research'),
      to: dataNodeId('planning'),
      attributes: {},
    });
    expect(original).toEqual(createDataGraphFixture());
    expect(dataGraphProfile(original).nodes.record.ui?.order).toEqual(
      original.columns.map((c) => c.id),
    );
  });
  it('Grid rename → Graph retarget → Form Undo follows the same two history entries', () => {
    const { session, binding } = bind(),
      initial = session.content;
    session.execute(setCells([{ rowId: 'research', columnId: 'name', value: 'Grid rename' }]));
    const afterGrid = session.content;
    binding.apply(
      [
        {
          type: 'reconnect-edge',
          id: dataEdgeId('research', 'related'),
          from: dataNodeId('research'),
          to: dataNodeId('delivery'),
        },
      ],
      binding.project().stamp,
    );
    expect(binding.project().graph.nodes[0].attributes.name).toBe('Grid rename');
    expect(session.content.rows[0].values.related).toBe('delivery');
    expect(binding.project().graph.edges[0].id).toBe(dataEdgeId('research', 'related'));
    expect(session.undo()).toEqual(afterGrid);
    expect(binding.project().graph.edges[0].to).toBe(dataNodeId('planning'));
    expect(session.undo()).toEqual(initial);
    session.redo();
    session.redo();
    expect(binding.project().graph.edges[0].to).toBe(dataNodeId('delivery'));
  });
  it('Graph attributes and disconnect change only the original targeted cell', () => {
    const { session, binding } = bind(),
      initial = session.content;
    binding.apply([rename], binding.project().stamp);
    expect(session.content.rows[0].values.name).toBe('Changed from Graph');
    expect(session.content.rows[0].values['private-note']).toBe(
      initial.rows[0].values['private-note'],
    );
    expect(session.content.rows.slice(1)).toEqual(initial.rows.slice(1));
    binding.apply(
      [{ type: 'delete-edge', id: dataEdgeId('research', 'related') }],
      binding.project().stamp,
    );
    expect(session.content.rows[0].values.related).toBeNull();
    expect(binding.project().graph.edges).toHaveLength(0);
  });
  it('connects only one scalar relation with its stable cell identity', () => {
    const { session, binding } = bind();
    binding.apply(
      [
        {
          type: 'add-edge',
          edge: {
            id: dataEdgeId('planning', 'related'),
            type: 'related',
            from: dataNodeId('planning'),
            to: dataNodeId('research'),
            attributes: {},
          },
        },
      ],
      binding.project().stamp,
    );
    expect(session.content.rows[1].values.related).toBe('research');
    refuse(session, () =>
      binding.apply(
        [
          {
            type: 'add-edge',
            edge: {
              id: 'arbitrary-edge',
              type: 'related',
              from: dataNodeId('planning'),
              to: dataNodeId('delivery'),
              attributes: {},
            },
          },
        ],
        binding.project().stamp,
      ),
    );
  });
  it('sort, field rename/reorder and private filters keep identity and hidden-target relations', () => {
    const { session, binding } = bind();
    const before = binding.project().graph;
    session.execute(reorderRow('delivery', 'research'));
    session.execute(updateColumn('related', { name: 'Dependency' }));
    session.execute(reorderColumn('related', 'name'));
    expect(binding.project().graph.edges).toEqual(before.edges);
    expect(new Set(binding.project().graph.nodes.map((n) => n.id))).toEqual(
      new Set(before.nodes.map((n) => n.id)),
    );
    expect(session.content.rows.find((r) => r.id === 'research')!.values.related).toBe('planning');
    const view = defaultView(session.content);
    view.search = 'Research';
    view.projection = 'Graph';
    session.execute(saveView(view));
    expect(binding.project().graph.nodes).toHaveLength(3);
    expect(binding.project().graph.edges[0].to).toBe(dataNodeId('planning'));
  });
  it('layout is a persisted Data view setting, uses common Undo, and does not change values/order', () => {
    const { session, binding } = bind(),
      initial = session.content;
    binding.apply(
      [{ type: 'move-node', id: dataNodeId('research'), position: { x: 111, y: 222 } }],
      binding.project().stamp,
    );
    expect(session.content.rows).toEqual(initial.rows);
    expect(session.content.columns).toEqual(initial.columns);
    expect(session.content.graphView?.positions.research).toEqual({ x: 111, y: 222 });
    expect(session.undo()).toEqual(initial);
  });
  it('native Data save/reload preserves view settings, records, IDs and unshown values', async () => {
    const { session, binding } = bind();
    binding.apply(
      [{ type: 'move-node', id: dataNodeId('research'), position: { x: 11, y: 22 } }],
      binding.project().stamp,
    );
    const artifact = await commitVersion(
        createArtifact('data', 'Relations', session.content),
        null,
        null,
      ),
      roundtrip = deserializeArtifact(serializeArtifact(artifact));
    assertDataIntegrity(roundtrip.draft.content);
    const reloaded = new DataSession(roundtrip.draft.content);
    expect(reloaded.content).toEqual(session.content);
    expect(projectDataGraph(reloaded.content).presentation.nodes[dataNodeId('research')]).toEqual({
      x: 11,
      y: 22,
    });
  });
  it('target deletion explicitly clears related cells atomically, Undo restores both target and edge', () => {
    const { session, binding } = bind(),
      initial = session.content;
    binding.apply(
      [{ type: 'delete-node', id: dataNodeId('planning'), cascade: true }],
      binding.project().stamp,
    );
    expect(session.content.rows).toHaveLength(2);
    expect(session.content.rows[0].values.related).toBeNull();
    expect(session.content.graphView?.positions.planning).toBeUndefined();
    expect(session.undo()).toEqual(initial);
  });
  it('preview is canonical reprojection, pure and applies as one Undo transaction', () => {
    const { session, binding } = bind(),
      initial = session.content;
    const preview = binding.preview([
      rename,
      {
        type: 'set-attribute',
        scope: 'node',
        id: dataNodeId('research'),
        path: ['related'],
        value: dataNodeId('delivery'),
      },
    ]);
    expect(session.content).toEqual(initial);
    expect(session.canUndo).toBe(false);
    expect(preview.projection.graph.edges[0].to).toBe(dataNodeId('delivery'));
    binding.applyProposal(preview.proposal);
    expect(session.content.rows[0].values.name).toBe('Changed from Graph');
    expect(session.undo()).toEqual(initial);
    expect(session.canUndo).toBe(false);
  });
});
describe('common Data apply boundary, even when Graph is closed', () => {
  it.each(['Grid', 'Form', 'headless', 'proposal'])(
    'rejects a missing reference from %s and leaves all fields/history unchanged',
    (entry) => {
      const { session } = bind();
      const edits = [
        { rowId: 'research', columnId: 'name', value: 'Partial' },
        { rowId: 'research', columnId: 'related', value: 'absent' },
      ];
      refuse(session, () =>
        session.execute(
          entry === 'proposal'
            ? transaction('Proposal', [
                setCell('research', 'name', 'Partial'),
                setCell('research', 'related', 'absent'),
              ])
            : entry === 'headless'
              ? command('bypass', 'Bypass', (d) => {
                  d.rows[0].values.name = 'Partial';
                  d.rows[0].values.related = 'absent';
                  return d;
                })
              : setCells(edits),
        ),
      );
    },
  );
  it.each(['Grid', 'Form', 'headless', 'Graph', 'proposal'])(
    'enforces readonly source fields for %s',
    (entry) => {
      const data = createDataGraphFixture();
      data.columns[0].readOnly = true;
      const { session, binding } = bind(data);
      refuse(session, () =>
        entry === 'Graph'
          ? binding.apply([rename], binding.project().stamp)
          : session.execute(
              entry === 'headless'
                ? command('bypass', 'Bypass', (d) => {
                    d.rows[0].values.name = 'Changed';
                    return d;
                  })
                : entry === 'proposal'
                  ? transaction('Proposal', [setCell('research', 'name', 'Changed')])
                  : setCells([{ rowId: 'research', columnId: 'name', value: 'Changed' }]),
            ),
      );
    },
  );
  it('refuses multi-value/foreign references through an arbitrary command at the Data boundary', () => {
    const { session } = bind();
    refuse(session, () =>
      session.execute(
        command('bad', 'Bad', (d) => {
          Object.assign(d.rows[0].values, { related: ['planning', 'delivery'] });
          return d;
        }),
      ),
    );
    refuse(session, () => session.execute(setCell('research', 'related', 'other-dataset:row')));
  });
  it('refuses implicit dangling deletion and protected cascade; permits explicit ordinary cascade', () => {
    const { session } = bind();
    refuse(session, () => session.execute(removeRow('planning')));
    session.execute(deleteRows(['planning']));
    expect(session.content.rows[0].values.related).toBeNull();
    session.undo();
    const required = createDataGraphFixture();
    required.columns.find((c) => c.id === 'related')!.required = true;
    const r = new DataSession(required);
    refuse(r, () => r.execute(deleteRows(['planning'])));
    const protectedData = createDataGraphFixture();
    protectedData.columns.find((c) => c.id === 'related')!.readOnly = true;
    const locked = new DataSession(protectedData);
    refuse(locked, () => locked.execute(deleteRows(['planning'])));
  });
  it('requires explicit disconnection before relation field conversion/deletion and preserves identities on rename', () => {
    const { session } = bind();
    refuse(session, () => session.execute(removeColumn('related')));
    refuse(session, () => session.execute(updateColumn('related', { type: 'text' })));
    session.execute(setCell('research', 'related', null));
    session.execute(removeColumn('related'));
    expect(session.content.columns.some((c) => c.id === 'related')).toBe(false);
  });
  it('refuses stale projections/proposals after external edit, target deletion, adapter or Profile change', () => {
    const { session, binding } = bind(),
      stamp = binding.project().stamp,
      proposal = binding.preview([rename]).proposal;
    session.execute(setCell('delivery', 'name', 'External'));
    refuse(session, () => binding.apply([rename], stamp));
    refuse(session, () => binding.applyProposal(proposal));
    const projected = binding.project().stamp;
    session.execute(deleteRows(['planning']));
    refuse(session, () =>
      binding.apply(
        [
          {
            type: 'reconnect-edge',
            id: dataEdgeId('research', 'related'),
            from: dataNodeId('research'),
            to: dataNodeId('planning'),
          },
        ],
        projected,
      ),
    );
    const adapter = { ...dataGraphAdapter },
      local = new GraphBinding({
        adapter,
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
    const previous = local.project().stamp;
    adapter.version = 2;
    refuse(session, () => local.apply([rename], previous));
  });
  it('rechecks readOnly at execution rather than only preparation', () => {
    const { session, binding } = bind(),
      proposal = binding.preview([rename]).proposal;
    session.readOnly = true;
    refuse(session, () => binding.applyProposal(proposal));
    refuse(session, () => session.execute(setCell('research', 'name', 'Bad')));
    refuse(session, () => session.undo());
    expect(() =>
      guardDataCommand(setCell('research', 'name', 'Bad'), () => false).apply(session.content),
    ).toThrow('read only');
  });
  it('retains arbitrary unshown scalar cells and does not mutate its source during preparation', () => {
    const data = createDataGraphFixture();
    data.rows[0].values.extra = 'Hidden extension';
    const original = clone(data);
    const cmd = prepareDataGraph(data, [rename]);
    expect(data).toEqual(original);
    expect(cmd.apply(data).rows[0].values.extra).toBe('Hidden extension');
  });
  it('rejects unsupported inverse mappings rather than hiding Graph values in cells', () => {
    const { session, binding } = bind();
    refuse(session, () =>
      binding.apply(
        [
          {
            type: 'set-attribute',
            scope: 'graph',
            id: 'data-graph',
            path: ['unknown'],
            value: 'X',
          },
        ],
        binding.project().stamp,
      ),
    );
    refuse(session, () =>
      binding.apply(
        [
          {
            type: 'set-attribute',
            scope: 'node',
            id: dataNodeId('research'),
            path: ['name'],
            value: { nested: 'X' },
          },
        ],
        binding.project().stamp,
      ),
    );
  });
});
it('namespaces row and edge identities even when source IDs resemble the graph root or edge IDs', () => {
  const data = createDataGraphFixture();
  data.rows.push(
    {
      id: 'data-graph',
      values: { name: 'Root-like row', category: 'Topic', related: null, active: false },
    },
    {
      id: dataEdgeId('research', 'related'),
      values: { name: 'Edge-like row', category: 'Topic', related: null, active: false },
    },
  );
  const { binding, session } = bind(data),
    graph = binding.project().graph;
  expect(
    new Set([graph.id, ...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)]).size,
  ).toBe(7);
  binding.apply(
    [
      {
        type: 'set-attribute',
        scope: 'node',
        id: dataNodeId('data-graph'),
        path: ['name'],
        value: 'Preserved row identity',
      },
    ],
    binding.project().stamp,
  );
  expect(session.content.rows.find((r) => r.id === 'data-graph')?.values.name).toBe(
    'Preserved row identity',
  );
});
it('creating a record through Graph uses Data defaults and leaves the relation disconnected', () => {
  const { session, binding } = bind();
  const node = createDataGraphNode(session.content, 'added-row');
  binding.apply([{ type: 'add-node', node, position: { x: 1, y: 2 } }], binding.project().stamp);
  expect(session.content.rows.at(-1)?.values).toEqual({
    name: 'New record',
    category: 'Topic',
    related: null,
    active: false,
    'private-note': null,
  });
  expect(session.content.rows.at(-1)?.id).toBe('added-row');
});
