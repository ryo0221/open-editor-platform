import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  contentHash,
  createArtifact,
  deepFreeze,
  serializeArtifact,
  updateDraft,
  MemoryStorage,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  GraphSession,
  createRelationGraph,
  relationProfile,
  graphCommand,
  guardGraphCommand,
  validateGraph,
  isGraphDocument,
  isGraphProfile,
  isGraphJson,
  graphLimits,
  parseGraphIntents,
  readGraphArtifact,
  type GraphDocument,
  type GraphIntent,
} from './headless';
const rename = (value = 'Renamed'): GraphIntent => ({
  type: 'set-attribute',
  scope: 'node',
  id: 'resource-a',
  path: ['name'],
  value,
});
function expectUnchanged(session: GraphSession, action: () => unknown) {
  const before = session.content,
    revision = session.revision,
    undo = session.canUndo;
  expect(action).toThrow();
  expect(session.content).toEqual(before);
  expect(session.revision).toEqual(revision);
  expect(session.canUndo).toBe(undo);
}
describe('Structured Graph pure model and commands', () => {
  it('validates a non-Workflow profile and keeps all IDs and unrelated fields', () => {
    const content = createRelationGraph(),
      input = deepFreeze(clone(content));
    const next = graphCommand(relationProfile, [rename()]).apply(input);
    expect(next.nodes[0].attributes.name).toBe('Renamed');
    expect(input).toEqual(content);
    expect(next.nodes[1]).toEqual(content.nodes[1]);
    expect(next.edges).toEqual(content.edges);
    expect(next.nodes[0].attributes.details).toEqual(content.nodes[0].attributes.details);
    expect(isGraphDocument(next)).toBe(true);
    expect(isGraphProfile(relationProfile)).toBe(true);
  });
  it('supports graph, node, edge and nested/array typed attributes', () => {
    const g = createRelationGraph();
    const next = graphCommand(relationProfile, [
      { type: 'set-attribute', scope: 'graph', id: g.id, path: ['title'], value: 'Map' },
      { type: 'set-attribute', scope: 'edge', id: 'relation-a-b', path: ['weight'], value: 2 },
      {
        type: 'set-attribute',
        scope: 'node',
        id: 'resource-a',
        path: ['details', 'description'],
        value: 'Detail',
      },
      {
        type: 'set-attribute',
        scope: 'node',
        id: 'resource-a',
        path: ['tags'],
        value: ['first', 'second'],
      },
    ]).apply(g);
    expect(next.attributes.title).toBe('Map');
    expect(next.edges[0].attributes.weight).toBe(2);
    expect(next.nodes[0].attributes.details).toEqual({ description: 'Detail' });
    expect(next.nodes[0].attributes.tags).toEqual(['first', 'second']);
  });
  it('one atomic batch fails without a partial edit or history', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile);
    expectUnchanged(session, () =>
      session.execute([
        rename(),
        { type: 'reconnect-edge', id: 'relation-a-b', from: 'resource-a', to: 'missing' },
      ]),
    );
    expectUnchanged(session, () =>
      session.execute([rename(), { type: 'move-node', id: 'missing', position: { x: 2, y: 3 } }]),
    );
  });
  it('allows declared cycles, self and parallel relationships with separate IDs', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile);
    session.execute([
      {
        type: 'add-edge',
        edge: { id: 'self', type: 'related', from: 'resource-a', to: 'resource-a', attributes: {} },
      },
      {
        type: 'add-edge',
        edge: {
          id: 'parallel',
          type: 'related',
          from: 'resource-a',
          to: 'resource-b',
          attributes: {},
        },
      },
      {
        type: 'add-edge',
        edge: {
          id: 'reverse',
          type: 'related',
          from: 'resource-b',
          to: 'resource-a',
          attributes: {},
        },
      },
    ]);
    expect(session.content.edges.map((e) => e.id)).toEqual([
      'relation-a-b',
      'self',
      'parallel',
      'reverse',
    ]);
    session.undo();
    expect(session.content.edges).toHaveLength(1);
    session.redo();
    expect(session.content.edges).toHaveLength(4);
  });
  it.each(['allowSelf', 'allowParallel', 'allowCycles'] as const)(
    'enforces declared %s constraints',
    (key) => {
      const profile = clone(relationProfile);
      profile.edges.related.connection = { [key]: false };
      const session = new GraphSession(createRelationGraph(), profile);
      const edge =
        key === 'allowSelf'
          ? { id: 'other', type: 'related', from: 'resource-a', to: 'resource-a', attributes: {} }
          : key === 'allowParallel'
            ? { id: 'other', type: 'related', from: 'resource-a', to: 'resource-b', attributes: {} }
            : {
                id: 'other',
                type: 'related',
                from: 'resource-b',
                to: 'resource-a',
                attributes: {},
              };
      expectUnchanged(session, () => session.execute([{ type: 'add-edge', edge }]));
    },
  );
  it.each(['maxIncoming', 'maxOutgoing'] as const)('enforces %s', (key) => {
    const profile = clone(relationProfile);
    profile.edges.related.connection = { [key]: 1 };
    const session = new GraphSession(createRelationGraph(), profile);
    expectUnchanged(session, () =>
      session.execute([
        {
          type: 'add-edge',
          edge: {
            id: 'second',
            type: 'related',
            from: 'resource-a',
            to: 'resource-b',
            attributes: {},
          },
        },
      ]),
    );
  });
  it('requires explicit cascade, deletes references atomically and Undo restores exact content', () => {
    const g = createRelationGraph(),
      session = new GraphSession(g, relationProfile);
    expectUnchanged(session, () =>
      session.execute([{ type: 'delete-node', id: 'resource-a', cascade: false }]),
    );
    session.execute([{ type: 'delete-node', id: 'resource-a', cascade: true }]);
    expect(session.content.nodes).toHaveLength(1);
    expect(session.content.edges).toHaveLength(0);
    expect(session.content.layout['resource-a']).toBeUndefined();
    expect(session.undo()).toEqual(g);
  });
  it('treats missing required values as diagnostics but refuses present invalid typed values', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile);
    session.execute([
      { type: 'remove-attribute', scope: 'node', id: 'resource-a', path: ['name'] },
    ]);
    expect(
      validateGraph(session.content, relationProfile).find((d) => d.code === 'required')?.blocking,
    ).toBe(false);
    expectUnchanged(session, () =>
      session.execute([
        { type: 'set-attribute', scope: 'node', id: 'resource-a', path: ['score'], value: 'bad' },
      ]),
    );
    expectUnchanged(session, () =>
      session.execute([
        {
          type: 'set-attribute',
          scope: 'node',
          id: 'resource-a',
          path: ['category'],
          value: 'unknown',
        },
      ]),
    );
  });
  it('moves layout as one undoable edit and leaves semantic graph data unchanged', () => {
    const g = createRelationGraph(),
      session = new GraphSession(g, relationProfile);
    session.execute([{ type: 'move-node', id: 'resource-a', position: { x: -10, y: 100 } }]);
    expect({ ...session.content, layout: g.layout }).toEqual(g);
    expect(session.undo()).toEqual(g);
    expect(session.canUndo).toBe(false);
  });
  it('returns caller-owned content and blocks global readOnly on commands, proposals and history', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile),
      proposal = session.preview([rename()]).proposal;
    session.content.nodes[0].attributes.name = 'Outside';
    expect(session.content.nodes[0].attributes.name).toBe('Research');
    session.readOnly = true;
    expectUnchanged(session, () => session.execute([rename()]));
    expectUnchanged(session, () =>
      session.executeCommand(
        command('bad', 'Bad', (c) => ({ ...c, attributes: { title: 'Changed' } })),
      ),
    );
    expectUnchanged(session, () => session.apply(proposal));
    expectUnchanged(session, () => session.undo());
    expectUnchanged(session, () => session.redo());
  });
  it('guards readonly fields including nested array members against trusted arbitrary commands', () => {
    const p = clone(relationProfile);
    p.nodes.entity.schema.name.readOnly = true;
    p.nodes.entity.schema.details.properties!.description.readOnly = true;
    const session = new GraphSession(createRelationGraph(), p);
    expectUnchanged(session, () => session.execute([rename()]));
    expectUnchanged(session, () =>
      session.executeCommand(
        command('bad', 'Bad', (g) => {
          g.nodes[0].attributes.details = { description: 'changed' };
          return g;
        }),
      ),
    );
  });
  it('guards readonly node layout, type creation and readonly edge deletion through headless paths', () => {
    const p = clone(relationProfile);
    p.nodes.entity.readOnly = true;
    p.edges.related.readOnly = true;
    const session = new GraphSession(createRelationGraph(), p);
    expectUnchanged(session, () =>
      session.execute([{ type: 'move-node', id: 'resource-a', position: { x: 1, y: 2 } }]),
    );
    expectUnchanged(session, () =>
      session.execute([
        {
          type: 'add-node',
          node: { id: 'extra', type: 'entity', attributes: { name: 'Extra' } },
          position: { x: 1, y: 2 },
        },
      ]),
    );
    expectUnchanged(session, () => session.execute([{ type: 'delete-edge', id: 'relation-a-b' }]));
  });
  it('preview is pure; reject is discard; stale and permission changes refuse apply; valid batch one Undo', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile),
      before = session.content,
      revision = session.revision;
    const preview = session.preview([
      rename(),
      { type: 'set-attribute', scope: 'graph', id: before.id, path: ['notes'], value: 'Proposal' },
    ]);
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
    session.apply(preview.proposal);
    expect(session.undo()).toEqual(before);
    expect(session.canUndo).toBe(false);
    expectUnchanged(session, () => session.apply(preview.proposal));
  });
  it('rejects stale fingerprints even in pure commands', () => {
    const g = createRelationGraph(),
      cmd = graphCommand(relationProfile, [rename()], canonicalJson(g));
    g.attributes.notes = 'External update';
    expect(() => cmd.apply(g)).toThrow('Stale');
  });
});
describe('untrusted Graph input and schema budgets', () => {
  const invalids: [string, (g: GraphDocument) => void][] = [
    [
      'unknown schema',
      (g) => {
        Object.assign(g, { schemaVersion: 99 });
      },
    ],
    [
      'duplicate IDs',
      (g) => {
        g.nodes[1].id = g.nodes[0].id;
      },
    ],
    [
      'graph ID collision',
      (g) => {
        g.nodes[0].id = g.id;
      },
    ],
    [
      'dangling reference',
      (g) => {
        g.edges[0].to = 'missing';
      },
    ],
    [
      'NaN',
      (g) => {
        g.layout['resource-a'].x = NaN;
      },
    ],
    [
      'coordinate bound',
      (g) => {
        g.layout['resource-a'].x = graphLimits.coordinate + 1;
      },
    ],
    [
      'orphan layout',
      (g) => {
        g.layout.unknown = { x: 1, y: 2 };
      },
    ],
    [
      'unknown node type',
      (g) => {
        g.nodes[0].type = 'unknown';
      },
    ],
    [
      'large string',
      (g) => {
        g.attributes.notes = 'a'.repeat(graphLimits.stringLength + 1);
      },
    ],
    [
      'node count',
      (g) => {
        g.nodes = Array.from({ length: 1001 }, (_, i) => ({
          id: `n${i}`,
          type: 'entity',
          attributes: {},
        }));
        g.edges = [];
        g.layout = {};
      },
    ],
    [
      'attribute size',
      (g) => {
        g.attributes = Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`key${i}`, 'a'.repeat(16000)]),
        );
      },
    ],
  ];
  it.each(invalids)('rejects %s', (_name, change) => {
    const g = createRelationGraph();
    change(g);
    expect(() => new GraphSession(g, relationProfile)).toThrow();
  });
  it('accepts coordinate boundary and refuses unknown Profile ID/version', () => {
    const g = createRelationGraph();
    g.layout['resource-a'] = { x: graphLimits.coordinate, y: -graphLimits.coordinate };
    expect(new GraphSession(g, relationProfile).content.layout).toEqual(g.layout);
    g.profile.version = 2;
    expect(() => new GraphSession(g, relationProfile)).toThrow('Profile');
  });
  it.each([() => {}, undefined, Infinity, new Date(), new Map(), JSON.parse('{"__proto__":{}}')])(
    'does not accept executable or non-JSON values',
    (v) => {
      expect(isGraphJson(v)).toBe(false);
    },
  );
  it('rejects accessors without invoking them, cycles, holes and excessive nesting', () => {
    let calls = 0;
    const object = Object.defineProperty({}, 'run', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expect(isGraphJson(object)).toBe(false);
    expect(calls).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isGraphJson(cycle)).toBe(false);
    expect(isGraphJson(new Array(2))).toBe(false);
    let value: unknown = 'x';
    for (let i = 0; i < 15; i++) value = { child: value };
    expect(isGraphJson(value)).toBe(false);
  });
  it.each([
    { ...relationProfile, run: 'code' },
    {
      ...relationProfile,
      graph: { schema: { x: { type: 'string', $ref: 'https://example.test' } } },
    },
    { ...relationProfile, nodes: { x: { schema: { x: { type: 'enum', enum: [] } } } } },
  ])('rejects unsupported Profile fields/schema extensions', (p) => {
    expect(isGraphProfile(p)).toBe(false);
  });
  it.each(
    [
      [],
      [{ type: 'execute', code: 'run()' }],
      [{ type: 'delete-node', id: 'resource-a' }],
      [{ type: 'move-node', id: 'resource-a', position: { x: 1, y: 2 }, unexpected: true }],
    ].map((value) => ({ value })),
  )('refuses undeclared or malformed intents', ({ value }) => {
    expect(() => parseGraphIntents(value)).toThrow();
  });
  it('handles text containing HTML/code as data and retains undeclared attributes', () => {
    const g = createRelationGraph();
    g.nodes[0].attributes.unshown = {
      code: '<script>throw Error()</script>',
      url: 'https://example.test',
    };
    const next = guardGraphCommand(
      graphCommand(relationProfile, [rename('<img onerror="run()">')]),
      relationProfile,
    ).apply(g);
    expect(next.nodes[0].attributes.unshown).toEqual(g.nodes[0].attributes.unshown);
  });
});
describe('native Graph persistence', () => {
  it('roundtrips retained immutable versions, restores through a new edit, and keeps old hashes', async () => {
    let a = createArtifact('structured-graph', 'Graph', createRelationGraph());
    a = await commitVersion(a, 'actor', 'v1');
    const old = clone(a.versions[0]);
    const session = new GraphSession(a.draft.content, relationProfile);
    session.execute([rename()]);
    a = await commitVersion(updateDraft(a, session.content), 'actor', 'v2');
    const text = serializeArtifact(a),
      restored = await readGraphArtifact(text, () => relationProfile);
    expect(restored).toEqual(a);
    session.executeCommand(command('restore', 'Restore', () => clone(old.content)));
    expect(session.content).toEqual(old.content);
    expect(a.versions[0]).toEqual(old);
    expect(await contentHash(old.content)).toBe(old.contentHash);
  });
  it('refuses corruption in any retained version, unknown profiles and hash mismatch before storage', async () => {
    const storage = new MemoryStorage();
    let a = createArtifact('structured-graph', 'Graph', createRelationGraph());
    a = await commitVersion(a, null, null);
    const importAndStore = async (text: string) => {
      const value = await readGraphArtifact(text, () => relationProfile);
      await storage.put(value);
    };
    const bad = clone(a);
    bad.versions[0].content.edges[0].to = 'missing';
    await expect(importAndStore(serializeArtifact(bad))).rejects.toThrow();
    expect(await storage.list()).toEqual([]);
    const hash = clone(a);
    hash.versions[0].content.attributes.title = 'Tampered';
    await expect(importAndStore(serializeArtifact(hash))).rejects.toThrow('hash');
    await expect(readGraphArtifact(serializeArtifact(a), () => undefined)).rejects.toThrow(
      'Profile',
    );
  });
});
it('native content excludes private camera/panel state and undeclared entity fields', () => {
  const g = createRelationGraph();
  expect(isGraphDocument({ ...g, camera: { x: 1, y: 2 } })).toBe(false);
  const unknown = clone(g);
  Object.assign(unknown.nodes[0], { onClick: 'code string' });
  expect(isGraphDocument(unknown)).toBe(false);
});

it('checks exact cycle components at the declared node/edge bounds without per-edge traversals', () => {
  const graph = createRelationGraph(),
    profile = clone(relationProfile);
  profile.edges.related.connection = { allowCycles: false };
  graph.nodes = Array.from({ length: 1000 }, (_, i) => ({
    id: `n${i}`,
    type: 'entity',
    attributes: { name: `Node ${i}` },
  }));
  graph.edges = [];
  graph.layout = {};
  for (let jump = 1; jump <= 5 && graph.edges.length < 4000; jump++)
    for (let i = 0; i + jump < 1000 && graph.edges.length < 4000; i++)
      graph.edges.push({
        id: `e${graph.edges.length}`,
        type: 'related',
        from: `n${i}`,
        to: `n${i + jump}`,
        attributes: {},
      });
  expect(graph.edges).toHaveLength(4000);
  expect(validateGraph(graph, profile)).toEqual([]);
  graph.edges[3999] = { id: 'closing', type: 'related', from: 'n999', to: 'n0', attributes: {} };
  const cycles = validateGraph(graph, profile).filter((d) => d.code === 'cycle');
  expect(cycles.some((d) => d.elementId === 'closing')).toBe(true);
  expect(cycles.length).toBe(4000);
  graph.nodes = graph.nodes.slice(0, 3);
  graph.edges = [
    { id: 'ab', type: 'related', from: 'n0', to: 'n1', attributes: {} },
    { id: 'ba', type: 'related', from: 'n1', to: 'n0', attributes: {} },
    { id: 'branch', type: 'related', from: 'n1', to: 'n2', attributes: {} },
  ];
  expect(
    validateGraph(graph, profile)
      .filter((d) => d.code === 'cycle')
      .map((d) => d.elementId),
  ).toEqual(['ab', 'ba']);
});
it('rejects undeclared layout position fields before native import or proposal adoption', async () => {
  const graph = createRelationGraph();
  const artifact = createArtifact('structured-graph', 'Untrusted position', graph);
  Object.assign(artifact.draft.content.layout['resource-a'], {
    metadata: 'Must not silently disappear',
  });
  expect(isGraphDocument(artifact.draft.content)).toBe(false);
  await expect(
    readGraphArtifact(serializeArtifact(artifact), () => relationProfile),
  ).rejects.toThrow();
  const session = new GraphSession(graph, relationProfile);
  expect(() =>
    session.execute([
      { type: 'move-node', id: 'resource-a', position: { x: 1, y: 2, metadata: 'Unsupported' } },
    ]),
  ).toThrow();
  expect(session.content).toEqual(graph);
  expect(session.canUndo).toBe(false);
});
