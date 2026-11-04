import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  GraphSession,
  arrangeGraph,
  createRelationGraph,
  graphCommand,
  graphEndpointKind,
  isGraphDocument,
  isGraphProfile,
  relationProfile,
  validateGraph,
  type GraphDocument,
  type GraphIntent,
  type GraphProfile,
} from './headless';
import { computeGraphScene, findEndpointTarget } from './view-model';
import { formatGraphDiagnostic } from './diagnostics';

/** `link` may end at env and zone Sections; `plain` declares no Section ends. */
function profile(): GraphProfile {
  const p = clone(relationProfile);
  const named = { schema: { name: { type: 'string' as const } }, ui: { labelField: 'name' } };
  p.sections = { env: named, zone: named, other: named };
  p.edges = {
    link: {
      schema: {},
      connection: { fromSections: ['env', 'zone'], toSections: ['env', 'zone'] },
    },
    plain: { schema: {} },
  };
  return p;
}
const box = (x: number, y: number, width = 600, height = 400) => ({ x, y, width, height });
/** Production (env) > Backend (zone) holding resource-a; resource-b outside, to the right. */
function graph(): GraphDocument {
  const g = createRelationGraph();
  g.sections = [
    { id: 'prod', type: 'env', attributes: { name: 'Production' } },
    { id: 'backend', type: 'zone', attributes: { name: 'Backend' }, parentId: 'prod' },
  ];
  g.presentation.sections = { prod: box(0, 0, 700, 500), backend: box(20, 40, 400, 300) };
  g.nodes[0].sectionId = 'backend';
  g.presentation.nodes = { 'resource-a': { x: 60, y: 120 }, 'resource-b': { x: 1000, y: 160 } };
  g.edges = [{ id: 'b-backend', type: 'link', from: 'resource-b', to: 'backend', attributes: {} }];
  return g;
}
const run = (g: GraphDocument, intents: GraphIntent[], p = profile()) =>
  graphCommand(p, intents).apply(g);
const blocking = (g: GraphDocument, p = profile()) => validateGraph(g, p).filter((d) => d.blocking);

describe('connections that end at a Section (#594)', () => {
  it('accepts a Section ID as an edge end and says which kind each end is', () => {
    const g = graph();
    expect(isGraphDocument(g)).toBe(true);
    expect(blocking(g)).toEqual([]);
    expect(graphEndpointKind(g, 'backend')).toBe('section');
    expect(graphEndpointKind(g, 'resource-b')).toBe('node');
    expect(graphEndpointKind(g, 'gone')).toBeUndefined();
    g.edges[0].to = 'gone';
    expect(isGraphDocument(g)).toBe(false);
  });

  it('allows Section ends only for the Section types the edge type lists', () => {
    const g = graph();
    // An edge type without fromSections/toSections (or without connection rules) refuses them.
    g.edges[0].type = 'plain';
    expect(blocking(g).map((d) => [d.elementId, d.code])).toEqual([
      ['b-backend', 'connection-section'],
    ]);
    expect(formatGraphDiagnostic(blocking(g)[0], g, profile(), 'ja')).toContain(
      'まとまりにつなげられません',
    );
    const p = profile();
    p.edges.link.connection!.toSections = ['env'];
    expect(blocking(graph(), p).map((d) => d.code)).toEqual(['connection-section']);
    p.edges.link.connection!.toSections = [];
    expect(blocking(graph(), p).map((d) => d.code)).toEqual(['connection-section']);
    // Node type rules keep applying to node ends only.
    const q = profile();
    q.edges.link.connection!.from = ['organization'];
    expect(blocking(graph(), q).map((d) => d.code)).toEqual(['connection-type']);
    q.edges.link.connection!.from = ['entity'];
    expect(blocking(graph(), q)).toEqual([]);
  });

  it('validates the Profile lists as known Section types', () => {
    const p = profile();
    expect(isGraphProfile(p)).toBe(true);
    p.edges.link.connection!.toSections = ['entity'];
    expect(isGraphProfile(p)).toBe(false);
    p.edges.link.connection!.toSections = ['zone', 'zone'];
    expect(isGraphProfile(p)).toBe(false);
    expect(isGraphProfile(relationProfile)).toBe(true);
  });

  it('applies self, parallel, degree and cycle rules to Section ends like node ends', () => {
    const p = profile();
    Object.assign(p.edges.link.connection!, {
      allowSelf: false,
      allowParallel: false,
      maxIncoming: 1,
      allowCycles: false,
    });
    const g = graph();
    g.edges.push({ id: 'self', type: 'link', from: 'prod', to: 'prod', attributes: {} });
    g.edges.push({ id: 'again', type: 'link', from: 'resource-b', to: 'backend', attributes: {} });
    g.edges.push({ id: 'back', type: 'link', from: 'backend', to: 'resource-b', attributes: {} });
    const codes = (id: string) =>
      blocking(g, p)
        .filter((d) => d.elementId === id)
        .map((d) => d.code);
    expect(codes('self')).toEqual(['self', 'cycle']);
    expect(codes('again')).toEqual(['parallel', 'degree', 'cycle']);
    expect(codes('back')).toEqual(['cycle']);
  });

  it('adds and reconnects a connection to a Section through intents, with Undo', () => {
    const initial = graph(),
      session = new GraphSession(clone(initial), profile());
    session.execute([
      {
        type: 'add-edge',
        edge: { id: 'prod-b', type: 'link', from: 'prod', to: 'resource-b', attributes: {} },
      },
    ]);
    session.execute([{ type: 'reconnect-edge', id: 'b-backend', from: 'resource-b', to: 'prod' }]);
    expect(session.content.edges.map((e) => [e.from, e.to])).toEqual([
      ['resource-b', 'prod'],
      ['prod', 'resource-b'],
    ]);
    expect(() =>
      session.execute([
        { type: 'reconnect-edge', id: 'b-backend', from: 'resource-b', to: 'missing' },
      ]),
    ).toThrow();
    session.undo();
    session.undo();
    expect(session.content).toEqual(initial);
  });

  it('refuses a connection the Profile does not allow at a Section, leaving the Graph unchanged', () => {
    const g = graph(),
      before = clone(g);
    expect(() =>
      run(g, [
        {
          type: 'add-edge',
          edge: { id: 'x', type: 'plain', from: 'resource-a', to: 'prod', attributes: {} },
        },
      ]),
    ).toThrow();
    expect(g).toEqual(before);
  });

  it('deletes a Section with its own connections only after an explicit cascade', () => {
    const g = graph();
    g.edges.push({ id: 'a-b', type: 'link', from: 'resource-a', to: 'resource-b', attributes: {} });
    expect(() => run(g, [{ type: 'delete-section', id: 'backend' }])).toThrow(
      'Section has connections; confirm cascade deletion',
    );
    expect(() => run(g, [{ type: 'delete-section', id: 'backend', cascade: false }])).toThrow(
      'confirm cascade',
    );
    const deleted = run(g, [{ type: 'delete-section', id: 'backend', cascade: true }]);
    // Edges of the members stay; only the edge that ended at the Section goes.
    expect(deleted.edges.map((e) => e.id)).toEqual(['a-b']);
    expect(deleted.nodes[0].sectionId).toBe('prod');
    // A Section without connections still deletes without the flag, as before.
    expect(run(deleted, [{ type: 'delete-section', id: 'prod' }]).sections).toEqual([]);
    expect(() =>
      graphCommand(profile(), [{ type: 'delete-section', id: 'prod', cascade: 'yes' }]),
    ).toThrow('Invalid cascade choice');
    const session = new GraphSession(clone(g), profile());
    session.execute([{ type: 'delete-section', id: 'backend', cascade: true }]);
    session.undo();
    expect(session.content).toEqual(g);
  });

  it('keeps the Section connections of a node when the node is deleted', () => {
    const g = graph();
    g.edges.push({ id: 'a-prod', type: 'link', from: 'resource-a', to: 'prod', attributes: {} });
    const next = run(g, [{ type: 'delete-node', id: 'resource-a', cascade: true }]);
    expect(next.edges.map((e) => e.id)).toEqual(['b-backend']);
  });
});

describe('drawing connections that end at a Section (#594)', () => {
  const scene = (g: GraphDocument, collapsed: string[] = [], visibleNodeIds?: string[]) =>
    computeGraphScene({
      graph: g,
      profile: profile(),
      nodeHeights: new Map(),
      labelSizes: new Map(),
      readOnly: false,
      collapsed: new Set(collapsed),
      visibleNodeIds,
      nodeSize: { width: 200, height: 70 },
    });

  it('routes to the open frame, avoiding nodes but not frames', () => {
    const s = scene(graph());
    expect(s.visibleEdges.map((e) => e.id)).toEqual(['b-backend']);
    const route = s.routes.get('b-backend')!;
    expect(route.path).not.toBe('');
    // The target port sits on the right side of Backend's frame (x 20 + 400).
    expect(route.target).toEqual({ x: 420, y: 190 });
    // The frame is not an obstacle and is not counted as a node box.
    expect(s.boxes).not.toHaveProperty('backend');
  });

  it('draws to a collapsed Section box, and to its holder when the Section is hidden', () => {
    const own = scene(graph(), ['backend']);
    expect(own.visibleEdges.map((e) => [e.id, e.from, e.to])).toEqual([
      ['b-backend', 'resource-b', 'backend'],
    ]);
    expect(own.sections.summaries.size).toBe(0);
    expect(own.routes.get('b-backend')!.target.x).toBe(
      own.boxes.backend.x + own.boxes.backend.width,
    );
    // Inside a collapsed parent, the connection becomes the parent's summary line.
    const hidden = scene(graph(), ['prod']);
    expect(hidden.visibleEdges.map((e) => [e.from, e.to])).toEqual([['resource-b', 'prod']]);
    expect([...hidden.sections.summaries.values()].map((x) => x.count)).toEqual([1]);
  });

  it('hides a connection between a collapsed Section and its own member', () => {
    const g = graph();
    g.edges = [{ id: 'own', type: 'link', from: 'backend', to: 'resource-a', attributes: {} }];
    expect(scene(g).visibleEdges.map((e) => e.id)).toEqual(['own']);
    expect(scene(g, ['backend']).visibleEdges).toEqual([]);
    expect(scene(g, ['prod']).visibleEdges).toEqual([]);
  });

  it('keeps Section ends through the Host node filter', () => {
    expect(scene(graph(), [], ['resource-b']).visibleEdges.map((e) => e.id)).toEqual(['b-backend']);
    expect(scene(graph(), [], ['resource-a']).visibleEdges).toEqual([]);
  });

  it('finds a node first, then a collapsed box, then the innermost open frame', () => {
    const g = graph(),
      s = scene(g);
    const target = (point: { x: number; y: number }, at = s) =>
      findEndpointTarget(point, at.visible, at.boxes, { graph: g, layout: at.sections });
    expect(target({ x: 100, y: 150 })).toBe('resource-a');
    expect(target({ x: 300, y: 300 })).toBe('backend');
    expect(target({ x: 600, y: 450 })).toBe('prod');
    expect(target({ x: 900, y: 900 })).toBeUndefined();
    const collapsed = scene(g, ['backend']);
    expect(target({ x: 30, y: 50 }, collapsed)).toBe('backend');
    expect(target({ x: 300, y: 300 }, collapsed)).toBe('prod');
    // Without Sections the lookup is the node lookup it was.
    expect(findEndpointTarget({ x: 300, y: 300 }, s.visible, s.boxes)).toBeUndefined();
  });

  it('lets Arrange diagram order a Section after the node that connects to it', () => {
    const g = graph();
    g.sections = [{ id: 'backend', type: 'zone', attributes: { name: 'Backend' } }];
    g.presentation.sections = { backend: box(0, 0) };
    const moved = graphCommand(profile(), arrangeGraph(g)).apply(g);
    expect(moved.presentation.sections.backend.x).toBeGreaterThan(
      moved.presentation.nodes['resource-b'].x,
    );
  });
});
