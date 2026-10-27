import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  GraphBinding,
  GraphSession,
  createRelationGraph,
  graphCommand,
  graphLimits,
  guardGraphCommand,
  isGraphDocument,
  relationProfile,
  validateGraph,
  type GraphAdapter,
  type GraphDocument,
  type GraphIntent,
  type GraphProfile,
} from './headless';
import {
  computeGraphScene,
  graphDraftTarget,
  graphDropSection,
  graphNodeDropIntents,
  graphSummaryEdgeId,
  graphSummaryTarget,
  retainedDeletedDrafts,
} from './view-model';
import { previewGraphDefinition } from './definition';
import { prepareGraphAttributeDraft, type GraphAttributeDraft } from './attribute-draft';

/** env > zone > (leaf), with a read-only "locked" Section type. */
function sectionProfile(): GraphProfile {
  const p = clone(relationProfile);
  const named = { schema: { name: { type: 'string' as const } }, ui: { labelField: 'name' } };
  p.sections = {
    env: { ...named, contains: { sections: ['zone', 'locked'] } },
    zone: { ...named, contains: { nodes: ['entity'], sections: [] } },
    locked: { ...named, readOnly: true },
    any: named,
  };
  p.nodes.fixed = { ...clone(p.nodes.entity), readOnly: true };
  return p;
}
const box = (x: number, y: number, width = 600, height = 400) => ({ x, y, width, height });
/** Production (env) > Backend (zone) holding resource-a; resource-b stays outside. */
function sectionGraph(): GraphDocument {
  const g = createRelationGraph();
  g.sections = [
    { id: 'prod', type: 'env', attributes: { name: 'Production' } },
    { id: 'backend', type: 'zone', attributes: { name: 'Backend' }, parentId: 'prod' },
  ];
  g.presentation.sections = { prod: box(0, 0, 900, 600), backend: box(20, 40) };
  g.nodes[0].sectionId = 'backend';
  return g;
}
const run = (g: GraphDocument, intents: GraphIntent[], profile = sectionProfile()) =>
  graphCommand(profile, intents).apply(g);

describe('Section structure', () => {
  it('accepts nested Sections with bounds and explicit membership', () => {
    const g = sectionGraph();
    expect(isGraphDocument(g)).toBe(true);
    expect(validateGraph(g, sectionProfile()).filter((d) => d.blocking)).toEqual([]);
  });

  it.each([
    ['a missing parent', (g: GraphDocument) => (g.sections[1].parentId = 'gone')],
    ['a membership in a missing Section', (g: GraphDocument) => (g.nodes[1].sectionId = 'gone')],
    ['a parent loop', (g: GraphDocument) => Object.assign(g.sections[0], { parentId: 'backend' })],
    ['a Section without bounds', (g: GraphDocument) => delete g.presentation.sections.backend],
    ['bounds without a Section', (g: GraphDocument) => (g.presentation.sections.x = box(0, 0))],
    ['a frame under 40px', (g: GraphDocument) => (g.presentation.sections.prod.width = 39)],
    [
      'a frame over 200,000px',
      (g: GraphDocument) => (g.presentation.sections.prod.height = 2e5 + 1),
    ],
    [
      'an unknown frame field',
      (g: GraphDocument) => Object.assign(g.presentation.sections.prod, { r: 1 }),
    ],
    [
      'an unknown Section field',
      (g: GraphDocument) => Object.assign(g.sections[0], { collapsed: true }),
    ],
    ['a duplicate ID', (g: GraphDocument) => (g.sections[1].id = 'resource-a')],
  ])('refuses %s', (_, change) => {
    const g = sectionGraph();
    change(g);
    expect(isGraphDocument(g)).toBe(false);
  });

  it('limits nesting to 8 levels and the count to 500', () => {
    const g = createRelationGraph();
    for (let i = 0; i < 9; i++) {
      g.sections.push({
        id: `s${i}`,
        type: 'any',
        attributes: {},
        ...(i ? { parentId: `s${i - 1}` } : {}),
      });
      g.presentation.sections[`s${i}`] = box(0, 0);
    }
    expect(isGraphDocument(g)).toBe(false);
    g.sections.pop();
    delete g.presentation.sections.s8;
    expect(isGraphDocument(g)).toBe(true);
    const many = createRelationGraph();
    for (let i = 0; i <= graphLimits.sections; i++) {
      many.sections.push({ id: `m${i}`, type: 'any', attributes: {} });
      many.presentation.sections[`m${i}`] = box(0, 0);
    }
    expect(isGraphDocument(many)).toBe(false);
  });

  it('checks Section types and contains: omitted allows any, [] allows none, a list names types', () => {
    const p = sectionProfile(),
      codes = (g: GraphDocument) =>
        validateGraph(g, p)
          .filter((d) => d.blocking)
          .map((d) => `${d.elementId}:${d.code}`);
    const g = sectionGraph();
    // zone lists entity only: a person is refused.
    g.nodes.push({ id: 'p', type: 'person', attributes: { name: 'Ana' }, sectionId: 'backend' });
    expect(codes(g)).toEqual(['p:section-contains']);
    // env omits nodes: anything may sit directly in it.
    g.nodes.at(-1)!.sectionId = 'prod';
    expect(codes(g)).toEqual([]);
    // zone has sections: [] so nothing nests in it; env lists zone and locked only.
    g.sections.push({ id: 'inner', type: 'zone', attributes: {}, parentId: 'backend' });
    g.presentation.sections.inner = box(30, 60);
    g.sections.push({ id: 'free', type: 'any', attributes: {}, parentId: 'prod' });
    g.presentation.sections.free = box(30, 60);
    g.sections.push({ id: 'odd', type: 'unknown', attributes: {} });
    g.presentation.sections.odd = box(0, 0);
    expect(codes(g).sort()).toEqual(
      ['free:section-contains', 'inner:section-contains', 'odd:section-type'].sort(),
    );
  });

  it('warns, without blocking or fixing, when a member is drawn outside its Section', () => {
    const g = sectionGraph();
    g.presentation.nodes['resource-a'] = { x: 2000, y: 2000 };
    const warning = validateGraph(g, sectionProfile()).find((d) => d.code === 'outside-section');
    expect(warning).toMatchObject({
      elementId: 'resource-a',
      blocking: false,
      severity: 'warning',
    });
  });
});

describe('Section intents', () => {
  it('creates a Section around a node in one edit and names it through attributes', () => {
    const initial = createRelationGraph(),
      session = new GraphSession(clone(initial), sectionProfile());
    session.execute([
      {
        type: 'add-section',
        section: { id: 'g', type: 'env', attributes: { name: 'Prod' } },
        bounds: box(0, 0),
      },
      { type: 'set-node-section', id: 'resource-a', sectionId: 'g' },
    ]);
    expect(session.content.nodes[0].sectionId).toBe('g');
    session.execute([
      { type: 'set-attribute', scope: 'section', id: 'g', path: ['name'], value: 'Live' },
    ]);
    expect(session.content.sections[0].attributes.name).toBe('Live');
    session.undo();
    session.undo();
    expect(session.content).toEqual(initial);
  });

  it('moves a Section with its nested Sections and members by the same offset', () => {
    const g = sectionGraph();
    g.nodes.push({ id: 'unplaced', type: 'entity', attributes: { name: 'U' }, sectionId: 'prod' });
    const next = run(g, [{ type: 'move-section', id: 'prod', position: { x: 100, y: 50 } }]);
    expect(next.presentation.sections.prod).toMatchObject({ x: 100, y: 50 });
    expect(next.presentation.sections.backend).toMatchObject({ x: 120, y: 90 });
    expect(next.presentation.nodes['resource-a']).toEqual({ x: 140, y: 110 });
    // A member drawn at its default position keeps that offset too.
    expect(next.presentation.nodes.unplaced).toEqual({ x: 40 + 260 * 2 + 100, y: 40 + 50 });
    // Outside members and membership are unchanged.
    expect(next.presentation.nodes['resource-b']).toEqual(g.presentation.nodes['resource-b']);
    expect(next.nodes.map((n) => n.sectionId)).toEqual(g.nodes.map((n) => n.sectionId));
  });

  it('keeps membership explicit: resizing and moving nodes never change it', () => {
    const g = sectionGraph();
    let next = run(g, [{ type: 'resize-section', id: 'backend', bounds: box(20, 40, 50, 50) }]);
    expect(next.nodes[0].sectionId).toBe('backend');
    expect(next.presentation.nodes).toEqual(g.presentation.nodes);
    next = run(next, [{ type: 'move-node', id: 'resource-a', position: { x: 5000, y: 5000 } }]);
    expect(next.nodes[0].sectionId).toBe('backend');
    next = run(next, [{ type: 'set-node-section', id: 'resource-a', sectionId: null }]);
    expect(next.nodes[0]).not.toHaveProperty('sectionId');
    expect(next.presentation.nodes['resource-a']).toEqual({ x: 5000, y: 5000 });
  });

  it('deletes a Section by moving its direct members up to its parent; nodes and edges stay', () => {
    const g = sectionGraph();
    g.sections.push({ id: 'leaf', type: 'any', attributes: {}, parentId: 'backend' });
    g.presentation.sections.leaf = box(30, 60);
    const p = sectionProfile();
    p.sections.zone.contains = { nodes: ['entity'] };
    // Promotion still meets contains: env does not list "any", so the batch is refused.
    expect(() => graphCommand(p, [{ type: 'delete-section', id: 'backend' }]).apply(g)).toThrow(
      /not allowed/,
    );
    delete p.sections.env.contains;
    let next = graphCommand(p, [{ type: 'delete-section', id: 'backend' }]).apply(g);
    expect(next.sections.map((s) => [s.id, s.parentId])).toEqual([
      ['prod', undefined],
      ['leaf', 'prod'],
    ]);
    expect(next.nodes[0].sectionId).toBe('prod');
    expect(next.presentation.sections).not.toHaveProperty('backend');
    expect(next.edges).toEqual(g.edges);
    next = graphCommand(p, [{ type: 'delete-section', id: 'prod' }]).apply(next);
    expect(next.nodes[0]).not.toHaveProperty('sectionId');
    expect(next.sections[0]).not.toHaveProperty('parentId');
  });

  it('refuses a parent loop and nesting past 8 levels with a reason', () => {
    const g = sectionGraph();
    expect(() => run(g, [{ type: 'set-section-parent', id: 'prod', parentId: 'backend' }])).toThrow(
      /inside itself/,
    );
    const deep = createRelationGraph();
    for (let i = 0; i < 8; i++) {
      deep.sections.push({
        id: `s${i}`,
        type: 'any',
        attributes: {},
        ...(i ? { parentId: `s${i - 1}` } : {}),
      });
      deep.presentation.sections[`s${i}`] = box(0, 0);
    }
    deep.sections.push({ id: 'x', type: 'any', attributes: {} });
    deep.presentation.sections.x = box(0, 0);
    expect(() => run(deep, [{ type: 'set-section-parent', id: 'x', parentId: 's7' }])).toThrow(
      /at most 8 levels/,
    );
    expect(() =>
      run(deep, [
        {
          type: 'add-section',
          section: { id: 'y', type: 'any', attributes: {}, parentId: 's7' },
          bounds: box(0, 0),
        },
      ]),
    ).toThrow(/at most 8 levels/);
  });

  it('sets and clears a Section style; contains violations refuse the whole batch', () => {
    const g = sectionGraph();
    const styled = run(g, [{ type: 'set-section-style', id: 'prod', style: { fill: '#dbeafe' } }]);
    expect(styled.presentation.sections.prod.style).toEqual({ fill: '#dbeafe' });
    expect(
      run(styled, [{ type: 'set-section-style', id: 'prod', style: null }]).presentation.sections
        .prod,
    ).not.toHaveProperty('style');
    g.nodes.push({ id: 'p', type: 'person', attributes: { name: 'Ana' } });
    expect(() =>
      run(g, [
        { type: 'set-attribute', scope: 'node', id: 'p', path: ['name'], value: 'Bo' },
        { type: 'set-node-section', id: 'p', sectionId: 'backend' },
      ]),
    ).toThrow(/not allowed/);
  });

  it('refuses unknown Section intent fields and invalid bounds', () => {
    const g = sectionGraph();
    for (const bad of [
      { type: 'move-section', id: 'prod', position: { x: 1, y: 1 }, extra: 1 },
      { type: 'resize-section', id: 'prod', bounds: { x: 0, y: 0, width: 10, height: 50 } },
      {
        type: 'add-section',
        section: { id: 's', type: 'any', attributes: {}, open: true },
        bounds: box(0, 0),
      },
      { type: 'set-node-section', id: 'resource-a' },
    ])
      expect(() => graphCommand(sectionProfile(), [bad])).toThrow();
    expect(() => run(g, [{ type: 'delete-section', id: 'gone' }])).toThrow(/missing/);
  });
});

describe('read-only Sections and descendants', () => {
  /** prod (env) > vault (locked) holding the read-only node "fixed". */
  function lockedGraph() {
    const g = sectionGraph();
    g.sections.push({
      id: 'vault',
      type: 'locked',
      attributes: { name: 'Vault' },
      parentId: 'prod',
    });
    g.presentation.sections.vault = box(300, 300, 200, 200);
    g.nodes.push({ id: 'fixed', type: 'fixed', attributes: { name: 'F' }, sectionId: 'vault' });
    g.presentation.nodes.fixed = { x: 320, y: 320 };
    return g;
  }
  it.each([
    [
      'moving a parent of a read-only Section',
      [{ type: 'move-section', id: 'prod', position: { x: 9, y: 9 } }],
    ],
    ['deleting a parent whose child is read only', [{ type: 'delete-section', id: 'prod' }]],
    [
      'putting a node into a read-only Section',
      [{ type: 'set-node-section', id: 'resource-b', sectionId: 'vault' }],
    ],
    [
      'taking a node out of a read-only Section',
      [{ type: 'set-node-section', id: 'fixed', sectionId: null }],
    ],
    ['resizing a read-only Section', [{ type: 'resize-section', id: 'vault', bounds: box(0, 0) }]],
    [
      'renaming a read-only Section',
      [{ type: 'set-attribute', scope: 'section', id: 'vault', path: ['name'], value: 'X' }],
    ],
    ['deleting a read-only Section', [{ type: 'delete-section', id: 'vault' }]],
  ] as [string, GraphIntent[]][])('refuses %s as one batch', (_, intents) => {
    const session = new GraphSession(lockedGraph(), sectionProfile());
    session.execute([
      { type: 'set-attribute', scope: 'section', id: 'prod', path: ['name'], value: 'Before' },
    ]);
    const before = canonicalJson(session.content),
      revision = session.revision;
    expect(() =>
      session.execute([
        { type: 'set-attribute', scope: 'section', id: 'backend', path: ['name'], value: 'Y' },
        ...intents,
      ]),
    ).toThrow();
    expect(canonicalJson(session.content)).toBe(before);
    expect(session.revision).toEqual(revision);
  });

  it('applies the same rule to an arbitrary trusted command', () => {
    const g = lockedGraph();
    const sneaky = command<GraphDocument>('x', 'x', (current) => {
      const next = clone(current);
      next.presentation.nodes.fixed = { x: 0, y: 0 };
      next.presentation.sections.vault = { ...next.presentation.sections.vault, x: 0 };
      return next;
    });
    expect(() => guardGraphCommand(sneaky, sectionProfile()).apply(g)).toThrow(/read only/);
  });
});

describe('adapters and Sections', () => {
  type Source = { graph: GraphDocument };
  const adapter = (
    sections: boolean,
    mode: 'source' | 'sidecar' = 'source',
  ): GraphAdapter<Source> => ({
    id: 'test',
    version: 1,
    presentationMode: mode,
    sections,
    profile: () => sectionProfile(),
    project: (s) => clone(s.graph),
    prepare: (_s, intents) => ({
      type: 'test.edit',
      label: 'Edit',
      apply: (current) => ({ graph: graphCommand(sectionProfile(), intents).apply(current.graph) }),
    }),
  });
  function bind(sections: boolean) {
    let source: Source = { graph: sectionGraph() },
      revision = 1;
    const b = new GraphBinding<Source>({
      adapter: adapter(sections),
      sourceId: 'src',
      read: () => ({ content: source, revision: String(revision), readOnly: false }),
      execute: (cmd) => {
        source = cmd.apply(source);
        revision++;
      },
    });
    return { b, get: () => source };
  }
  it('lets a source adapter that declares sections save them in one command', () => {
    const { b, get } = bind(true);
    b.apply([{ type: 'move-section', id: 'prod', position: { x: 10, y: 10 } }], b.project().stamp);
    expect(get().graph.presentation.sections.prod).toMatchObject({ x: 10, y: 10 });
  });
  it('refuses Section intents, including Section attributes, where the source cannot hold them', () => {
    const { b, get } = bind(false),
      before = canonicalJson(get());
    for (const intents of [
      [{ type: 'delete-section', id: 'prod' }],
      [{ type: 'set-attribute', scope: 'section', id: 'prod', path: ['name'], value: 'X' }],
    ] as GraphIntent[][])
      expect(() => b.apply(intents, b.project().stamp)).toThrow(/cannot represent Graph sections/);
    expect(canonicalJson(get())).toBe(before);
  });
  it('refuses sections with a sidecar when the binding is created', () => {
    expect(
      () =>
        new GraphBinding<Source>({
          adapter: adapter(true, 'sidecar'),
          sourceId: 'src',
          read: () => ({ content: { graph: sectionGraph() }, revision: '1', readOnly: false }),
          execute: () => undefined,
        }),
    ).toThrow(/sections need/);
  });
});

describe('Section review fixes', () => {
  const scene = (g: GraphDocument, extra: Partial<Parameters<typeof computeGraphScene>[0]>) =>
    computeGraphScene({
      graph: g,
      profile: sectionProfile(),
      nodeHeights: new Map(),
      labelSizes: new Map(),
      readOnly: false,
      ...extra,
    });

  it('applies the Host node filter to the real ends before summarising a collapsed Section', () => {
    const g = sectionGraph();
    // Only the outside node passes the filter: its connection to the hidden member stays hidden.
    const filtered = scene(g, { collapsed: new Set(['backend']), visibleNodeIds: ['resource-b'] });
    expect(filtered.visibleEdges).toEqual([]);
    const all = scene(g, { collapsed: new Set(['backend']) });
    expect(all.visibleEdges.map((e) => [e.from, e.to])).toEqual([['backend', 'resource-b']]);
  });

  it('never gives a summary line the ID of a saved edge', () => {
    const g = sectionGraph();
    const taken = graphSummaryEdgeId('backend', 'resource-b', 'related');
    g.edges.push({
      id: taken,
      type: 'related',
      from: 'resource-b',
      to: 'resource-b',
      attributes: {},
    });
    expect(isGraphDocument(g)).toBe(true);
    const lines = scene(g, { collapsed: new Set(['backend']) });
    const ids = lines.visibleEdges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(taken);
    const summary = lines.visibleEdges.find((e) => e.id !== taken)!;
    expect(lines.sections.summaries.get(summary.id)?.count).toBe(1);
    expect(lines.sections.summaries.has(taken)).toBe(false);
  });

  it('selects the collapsed Section from a summary line in either direction', () => {
    const g = sectionGraph();
    g.edges[0] = { ...g.edges[0], from: 'resource-b', to: 'resource-a' };
    const lines = scene(g, { collapsed: new Set(['backend']) });
    const [incoming] = lines.visibleEdges;
    expect([incoming.from, incoming.to]).toEqual(['resource-b', 'backend']);
    expect(graphSummaryTarget(incoming, lines.sections.collapsedBoxes)).toBe('backend');
    const outgoing = scene(sectionGraph(), { collapsed: new Set(['backend']) }).visibleEdges[0];
    expect(graphSummaryTarget(outgoing, lines.sections.collapsedBoxes)).toBe('backend');
  });

  it('keeps Section input drafts on the normal preparation path', () => {
    const g = sectionGraph(),
      p = sectionProfile();
    const draft: GraphAttributeDraft = {
      id: 'backend',
      scope: 'section',
      original: g.sections[1].attributes,
      schema: p.sections.zone.schema,
      values: { name: 'API' },
    };
    const target = graphDraftTarget(draft, 'backend', g, p)!;
    expect(target.type).toBe(p.sections.zone);
    expect(prepareGraphAttributeDraft(draft, target.attributes, target.type.schema)).toEqual([
      { type: 'set-attribute', scope: 'section', id: 'backend', path: ['name'], value: 'API' },
    ]);
    const drafts = new Map([['backend', draft]]);
    expect(retainedDeletedDrafts(drafts, g)).toEqual([]);
    const gone = run(g, [{ type: 'delete-section', id: 'backend' }]);
    expect(graphDraftTarget(draft, 'backend', gone, p)).toBeUndefined();
    expect(retainedDeletedDrafts(drafts, gone).map(([id]) => id)).toEqual(['backend']);
  });

  it('previews a Section type definition against the Section map', () => {
    const g = sectionGraph(),
      p = sectionProfile();
    g.sections[1].attributes.name = 42 as unknown as string;
    const preview = previewGraphDefinition(
      { graph: g, profile: p },
      {
        scope: 'section',
        type: 'zone',
        definition: { ...p.sections.zone, schema: { name: { type: 'string' } } },
      },
    );
    expect(preview.changedIds).toEqual(['backend']);
    expect(preview.graph.sections[1].attributes.name).toBe('42');
    expect(preview.profile.edges).toEqual(p.edges);
    expect(() =>
      previewGraphDefinition(
        { graph: g, profile: p },
        { scope: 'section', type: 'related', definition: p.sections.zone },
      ),
    ).toThrow('Choose an existing Graph type');
  });
});

describe('Dropping a node into a Section frame (#448)', () => {
  const sections = (g: GraphDocument, p: GraphProfile, collapsed?: Set<string>) =>
    computeGraphScene({
      graph: g,
      profile: p,
      nodeHeights: new Map(),
      labelSizes: new Map(),
      readOnly: false,
      collapsed,
    }).sections;
  const drop = (
    g: GraphDocument,
    id: string,
    position: { x: number; y: number },
    extra: { profile?: GraphProfile; collapsed?: Set<string>; outside?: 'clear' | 'keep' } = {},
  ) => {
    const profile = extra.profile ?? sectionProfile();
    return graphNodeDropIntents({
      graph: g,
      profile,
      sections: sections(g, profile, extra.collapsed),
      id,
      position,
      // A 0×0 node: the saved position is its centre.
      size: { width: 0, height: 0 },
      outside: extra.outside,
    });
  };

  it('joins the innermost frame in the same edit as the move', () => {
    const g = sectionGraph();
    const { intents, refused } = drop(g, 'resource-b', { x: 100, y: 100 });
    expect(refused).toBeUndefined();
    expect(intents).toEqual([
      { type: 'move-node', id: 'resource-b', position: { x: 100, y: 100 } },
      { type: 'set-node-section', id: 'resource-b', sectionId: 'backend' },
    ]);
    const next = run(g, intents);
    expect(next.nodes[1].sectionId).toBe('backend');
    expect(next.presentation.nodes['resource-b']).toMatchObject({ x: 100, y: 100 });
    // Outside the nested frame but inside its parent: the parent.
    const out = drop(g, 'resource-a', { x: 700, y: 500 });
    expect(out.intents[1]).toEqual({
      type: 'set-node-section',
      id: 'resource-a',
      sectionId: 'prod',
    });
  });

  it('leaves the Section outside every frame, or keeps it when the Host opts out', () => {
    const g = sectionGraph();
    const cleared = drop(g, 'resource-a', { x: 2000, y: 2000 });
    expect(cleared.intents[1]).toEqual({
      type: 'set-node-section',
      id: 'resource-a',
      sectionId: null,
    });
    expect(run(g, cleared.intents).nodes[0].sectionId).toBeUndefined();
    const kept = drop(g, 'resource-a', { x: 2000, y: 2000 }, { outside: 'keep' });
    expect(kept.intents).toEqual([
      { type: 'move-node', id: 'resource-a', position: { x: 2000, y: 2000 } },
    ]);
  });

  it('decides the frame by the node centre', () => {
    const g = sectionGraph(),
      p = sectionProfile();
    // The corner is inside Backend, the centre is not.
    const { intents } = graphNodeDropIntents({
      graph: g,
      profile: p,
      sections: sections(g, p),
      id: 'resource-b',
      position: { x: 600, y: 420 },
      size: { width: 200, height: 70 },
    });
    expect(intents[1]).toEqual({ type: 'set-node-section', id: 'resource-b', sectionId: 'prod' });
  });

  it('only moves within the same Section and skips collapsed frames', () => {
    const g = sectionGraph();
    expect(drop(g, 'resource-a', { x: 300, y: 300 }).intents).toHaveLength(1);
    const p = sectionProfile();
    expect(graphDropSection(g, sections(g, p, new Set(['backend'])), { x: 100, y: 100 })).toBe(
      'prod',
    );
    expect(graphDropSection(g, sections(g, p, new Set(['prod'])), { x: 100, y: 100 })).toBeNull();
  });

  it('moves without the membership a Profile or read-only Section refuses', () => {
    const p = sectionProfile();
    p.nodes.other = clone(p.nodes.entity);
    const g = sectionGraph();
    g.nodes.push({ id: 'other-a', type: 'other', attributes: { name: 'Other' } });
    const notAllowed = drop(g, 'other-a', { x: 100, y: 100 }, { profile: p });
    expect(notAllowed.target).toBe('backend');
    expect(notAllowed.refused).toBeDefined();
    expect(notAllowed.intents).toEqual([
      { type: 'move-node', id: 'other-a', position: { x: 100, y: 100 } },
    ]);

    g.sections.push({
      id: 'vault',
      type: 'locked',
      attributes: { name: 'Vault' },
      parentId: 'prod',
    });
    g.presentation.sections.vault = box(650, 40, 200, 200);
    const locked = drop(g, 'resource-b', { x: 700, y: 100 }, { profile: p });
    expect(locked.target).toBe('vault');
    expect(String(locked.refused)).toMatch(/read-only section/);
    expect(locked.intents).toHaveLength(1);
    // A member of the read-only Section cannot be dropped out of it either.
    g.nodes[1].sectionId = 'vault';
    g.presentation.nodes['resource-b'] = { x: 700, y: 100 };
    const leaving = drop(g, 'resource-b', { x: 100, y: 100 }, { profile: p });
    expect(leaving.refused).toBeDefined();
    expect(run(g, leaving.intents, p).nodes[1].sectionId).toBe('vault');
  });
});
