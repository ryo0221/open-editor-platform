import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  GraphBinding,
  GraphSession,
  createRelationGraph,
  fitGraphRoutesToShapes,
  graphCommand,
  graphLabelColor,
  graphNodeShapes,
  graphShapeContains,
  graphShapeContentBox,
  graphShapeEndpoint,
  graphShapeHeight,
  graphShapeMetrics,
  graphShapePolygon,
  isGraphDocument,
  isGraphProfile,
  parseGraphIntents,
  relationProfile,
  resolveGraphNodeLook,
  routeGraphEdge,
  separateGraphRoutes,
  assertGraphDocument,
  assertGraphProfile,
  type GraphAdapter,
  type GraphDocument,
  type GraphNodeShape,
  type GraphProfile,
  type PresentationSidecar,
} from './headless';

const box = { x: 100, y: 50, width: 200, height: 100 };
const sides = [
  { name: 'top', inward: { x: 0, y: 1 }, port: (f: number) => ({ x: 200 + f * 200, y: 50 }) },
  { name: 'bottom', inward: { x: 0, y: -1 }, port: (f: number) => ({ x: 200 + f * 200, y: 150 }) },
  { name: 'left', inward: { x: 1, y: 0 }, port: (f: number) => ({ x: 100, y: 100 + f * 100 }) },
  { name: 'right', inward: { x: -1, y: 0 }, port: (f: number) => ({ x: 300, y: 100 + f * 100 }) },
] as const;
const onOutline = (shape: GraphNodeShape, p: { x: number; y: number }) => {
  const polygon = graphShapePolygon(shape, box);
  return polygon.some((a, i) => {
    const b = polygon[(i + 1) % polygon.length],
      cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x),
      length = Math.hypot(b.x - a.x, b.y - a.y);
    const within =
      Math.min(a.x, b.x) - 1e-6 <= p.x &&
      p.x <= Math.max(a.x, b.x) + 1e-6 &&
      Math.min(a.y, b.y) - 1e-6 <= p.y &&
      p.y <= Math.max(a.y, b.y) + 1e-6;
    return within && Math.abs(cross) / (length || 1) < 1e-6;
  });
};

describe('node shape geometry', () => {
  it.each(graphNodeShapes)(
    '%s stays inside its box and contains its centre and label box',
    (shape) => {
      for (const p of graphShapePolygon(shape, box)) {
        expect(p.x).toBeGreaterThanOrEqual(box.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(box.x + box.width + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(box.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(box.y + box.height + 1e-9);
      }
      expect(graphShapeContains(shape, box, { x: 200, y: 100 })).toBe(true);
      const content = graphShapeContentBox(shape, box);
      for (const corner of [
        { x: content.x + 1, y: content.y + 1 },
        { x: content.x + content.width - 1, y: content.y + content.height - 1 },
      ])
        expect(graphShapeContains(shape, box, corner)).toBe(true);
    },
  );

  it.each(graphNodeShapes)(
    '%s: every port in its range meets the outline going inward',
    (shape) => {
      const range = graphShapeMetrics(shape).portRange;
      for (const side of sides)
        for (const f of [-range, -range / 2, 0, range / 2, range]) {
          const port = side.port(Math.max(-0.44, Math.min(0.44, f))),
            end = graphShapeEndpoint(shape, box, port, side.inward);
          expect(onOutline(shape, end), `${side.name} ${f}`).toBe(true);
          // The end moves along the inward normal only, so routes stay orthogonal.
          if (side.inward.x === 0) expect(end.x).toBeCloseTo(port.x, 9);
          else expect(end.y).toBeCloseTo(port.y, 9);
        }
    },
  );

  it('ends ellipse, diamond, hexagon and cylinder connections on their curves and edges', () => {
    expect(graphShapeEndpoint('ellipse', box, { x: 300, y: 100 }, { x: -1, y: 0 })).toEqual({
      x: 300,
      y: 100,
    });
    const diamond = graphShapeEndpoint('diamond', box, { x: 250, y: 50 }, { x: 0, y: 1 });
    expect(diamond.x).toBe(250);
    expect(diamond.y).toBeCloseTo(75, 6);
    const hexagon = graphShapeEndpoint('hexagon', box, { x: 100, y: 75 }, { x: 1, y: 0 });
    expect(hexagon.x).toBeGreaterThan(100);
    // The cylinder's top is the upper arc of its cap: an off-centre port lands below the box top.
    const cylinder = graphShapeEndpoint('cylinder', box, { x: 280, y: 50 }, { x: 0, y: 1 });
    expect(cylinder.y).toBeGreaterThan(50);
    expect(cylinder.y).toBeLessThan(60);
    expect(graphShapeEndpoint('cylinder', box, { x: 200, y: 50 }, { x: 0, y: 1 }).y).toBeCloseTo(
      50,
      6,
    );
    expect(graphShapeEndpoint('rectangle', box, { x: 250, y: 50 }, { x: 0, y: 1 })).toEqual({
      x: 250,
      y: 50,
    });
  });

  it('does not count the bounding box corners of curved shapes as hits', () => {
    for (const shape of ['ellipse', 'diamond', 'hexagon', 'cloud', 'cylinder'] as const)
      expect(graphShapeContains(shape, box, { x: box.x + 1, y: box.y + 1 })).toBe(false);
    expect(graphShapeContains('rectangle', box, { x: box.x + 1, y: box.y + 1 })).toBe(true);
  });

  it('grows the height so the label fits the shape, never below 70px', () => {
    expect(graphShapeHeight('rectangle', 40)).toBe(70);
    expect(graphShapeHeight('rectangle', 120)).toBe(120);
    expect(graphShapeHeight('diamond', 60)).toBe(120);
    expect(graphShapeHeight('cylinder', 60)).toBe(90);
    expect(graphShapeHeight('ellipse', 71)).toBe(100);
  });

  it('chooses black or white label text with at least 4.5:1 contrast for every fill', () => {
    const luminance = (hex: string) => {
      const c = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    for (let v = 0; v < 256; v += 5) {
      const fill = `#${v.toString(16).padStart(2, '0').repeat(3)}`,
        a = luminance(fill),
        b = luminance(graphLabelColor(fill));
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect(graphLabelColor('#334155')).toBe('#ffffff');
    expect(graphLabelColor('#fff')).toBe('#000000');
  });

  it('separates parallel ports within the shape range and ends routes on the outline', () => {
    const a = { x: 0, y: 0, width: 200, height: 100 },
      b = { x: 500, y: 0, width: 200, height: 100 },
      ends = { source: a, target: b, sourceShape: 'diamond', targetShape: 'ellipse' } as const;
    const routes = new Map([
      ['e1', routeGraphEdge(a, b, [a, b])],
      ['e2', routeGraphEdge(a, b, [a, b])],
    ]);
    const endsMap = new Map([
      ['e1', ends],
      ['e2', ends],
    ]);
    const fitted = fitGraphRoutesToShapes(separateGraphRoutes(routes, endsMap, [a, b]), endsMap);
    for (const route of fitted.values()) {
      expect(Math.abs(route.source.y - 50)).toBeLessThanOrEqual(25 + 1e-9);
      expect(route.source.x).toBeLessThan(200);
      expect(route.target.x).toBeGreaterThan(500);
      expect(route.path.startsWith(`M${route.source.x},${route.source.y}`)).toBe(true);
      // Still orthogonal: each segment is horizontal or vertical.
      route.points.slice(1).forEach((p, i) => {
        const q = route.points[i];
        expect(p.x === q.x || p.y === q.y).toBe(true);
      });
    }
  });
});

describe('schema 2 presentation', () => {
  it('refuses schema 1 Graphs and Profiles with a reason instead of reading them', () => {
    const old = { ...clone(createRelationGraph()), schemaVersion: 1 } as Record<string, unknown>;
    delete old.presentation;
    delete old.sections;
    old.layout = {};
    expect(isGraphDocument(old)).toBe(false);
    expect(() => assertGraphDocument(old)).toThrow(/schema 1 is not supported/);
    const profile = { ...clone(relationProfile), schemaVersion: 1 } as Record<string, unknown>;
    delete profile.sections;
    expect(isGraphProfile(profile)).toBe(false);
    expect(() => assertGraphProfile(profile)).toThrow(/schema 1 is not supported/);
  });

  it.each([
    [
      'unknown shape',
      (g: GraphDocument) => Object.assign(g.presentation.nodes['resource-a'], { shape: 'star' }),
    ],
    [
      'CSS colour',
      (g: GraphDocument) =>
        Object.assign(g.presentation.nodes['resource-a'], { style: { fill: 'red' } }),
    ],
    [
      'URL paint',
      (g: GraphDocument) =>
        Object.assign(g.presentation.nodes['resource-a'], { style: { fill: 'url(#x)' } }),
    ],
    [
      'unknown style field',
      (g: GraphDocument) =>
        Object.assign(g.presentation.nodes['resource-a'], { style: { css: 'x' } }),
    ],
    [
      'stroke width',
      (g: GraphDocument) =>
        Object.assign(g.presentation.nodes['resource-a'], { style: { strokeWidth: 4 } }),
    ],
    [
      'long dash',
      (g: GraphDocument) =>
        Object.assign(g.presentation.nodes['resource-a'], { style: { dash: [65] } }),
    ],
    [
      'unknown presentation field',
      (g: GraphDocument) => Object.assign(g.presentation.nodes['resource-a'], { width: 10 }),
    ],
    [
      'missing node',
      (g: GraphDocument) => Object.assign(g.presentation.nodes, { gone: { x: 0, y: 0 } }),
    ],
    ['a Section', (g: GraphDocument) => g.sections.push({ id: 's', type: 'env', attributes: {} })],
    [
      'Section presentation',
      (g: GraphDocument) =>
        Object.assign(g.presentation.sections, { s: { x: 0, y: 0, width: 50, height: 50 } }),
    ],
    ['membership', (g: GraphDocument) => Object.assign(g.nodes[0], { sectionId: 's' })],
    ['unknown top-level field', (g: GraphDocument) => Object.assign(g, { layout: {} })],
  ])('refuses %s', (_, change) => {
    const g = clone(createRelationGraph());
    change(g);
    expect(isGraphDocument(g)).toBe(false);
  });

  it('validates Profile type defaults and Section types with their contains lists', () => {
    const p = clone(relationProfile);
    p.nodes.entity.ui = { ...p.nodes.entity.ui, shape: 'cylinder', style: { fill: '#dbeafe' } };
    expect(isGraphProfile(p)).toBe(true);
    expect(
      isGraphProfile({
        ...p,
        nodes: { ...p.nodes, entity: { ...p.nodes.entity, ui: { shape: 'star' } } },
      }),
    ).toBe(false);
    expect(
      isGraphProfile({
        ...p,
        edges: { related: { ...p.edges.related, ui: { shape: 'ellipse' } } },
      }),
    ).toBe(false);
    expect(isGraphProfile({ ...p, graph: { ...p.graph, ui: { style: { fill: '#fff' } } } })).toBe(
      false,
    );
    expect(isGraphProfile({ ...p, sections: { env: { schema: {} } } })).toBe(true);
    expect(
      isGraphProfile({
        ...p,
        sections: { env: { schema: {}, contains: { nodes: ['entity'], sections: [] } } },
      }),
    ).toBe(true);
    // contains may only name known types, once each.
    for (const contains of [{ nodes: ['missing'] }, { sections: ['env', 'env'] }, { edges: [] }])
      expect(isGraphProfile({ ...p, sections: { env: { schema: {}, contains } } })).toBe(false);
    expect(
      isGraphProfile({ ...p, sections: { env: { schema: {}, ui: { shape: 'ellipse' } } } }),
    ).toBe(false);
  });

  it('resolves node override, then type default, then rectangle, field by field', () => {
    const profile: GraphProfile = clone(relationProfile),
      g = createRelationGraph();
    profile.nodes.entity.ui = {
      ...profile.nodes.entity.ui,
      shape: 'cylinder',
      style: { fill: '#dbeafe', stroke: '#1d4ed8' },
    };
    expect(resolveGraphNodeLook(g, profile, g.nodes[0])).toEqual({
      shape: 'cylinder',
      style: { fill: '#dbeafe', stroke: '#1d4ed8' },
    });
    g.presentation.nodes['resource-a'] = {
      x: 1,
      y: 2,
      shape: 'diamond',
      style: { fill: '#fee2e2' },
    };
    expect(resolveGraphNodeLook(g, profile, g.nodes[0])).toEqual({
      shape: 'diamond',
      style: { fill: '#fee2e2', stroke: '#1d4ed8' },
    });
    expect(resolveGraphNodeLook(g, relationProfile, g.nodes[0]).shape).toBe('diamond');
    expect(resolveGraphNodeLook(createRelationGraph(), relationProfile, g.nodes[0])).toEqual({
      shape: 'rectangle',
      style: {},
    });
  });
});

describe('shape and style intents', () => {
  it('changes only presentation: type, attributes and edge IDs stay, and Undo restores', () => {
    const g = createRelationGraph(),
      session = new GraphSession(g, relationProfile);
    session.execute([
      { type: 'set-node-shape', id: 'resource-a', shape: 'ellipse' },
      { type: 'set-node-style', id: 'resource-a', style: { fill: '#dcfce7', dash: [6, 4] } },
    ]);
    const next = session.content;
    expect(next.presentation.nodes['resource-a']).toEqual({
      x: 40,
      y: 60,
      shape: 'ellipse',
      style: { fill: '#dcfce7', dash: [6, 4] },
    });
    expect(canonicalJson({ ...next, presentation: g.presentation })).toBe(canonicalJson(g));
    session.execute([{ type: 'move-node', id: 'resource-a', position: { x: 5, y: 6 } }]);
    expect(session.content.presentation.nodes['resource-a']).toMatchObject({
      x: 5,
      y: 6,
      shape: 'ellipse',
    });
    session.execute([
      { type: 'set-node-shape', id: 'resource-a', shape: null },
      { type: 'set-node-style', id: 'resource-a', style: null },
    ]);
    expect(session.content.presentation.nodes['resource-a']).toEqual({ x: 5, y: 6 });
    session.undo();
    session.undo();
    expect(session.undo()).toEqual(g);
  });

  it('keeps the default position when a node without one gets a shape', () => {
    const g = createRelationGraph();
    g.presentation.nodes = {};
    const next = graphCommand(relationProfile, [
      { type: 'set-node-shape', id: 'resource-b', shape: 'hexagon' },
    ]).apply(g);
    expect(next.presentation.nodes['resource-b']).toEqual({ x: 300, y: 40, shape: 'hexagon' });
  });

  it.each([
    [{ type: 'set-node-shape', id: 'resource-a', shape: 'star' }],
    [{ type: 'set-node-shape', id: 'resource-a' }],
    [{ type: 'set-node-style', id: 'resource-a', style: { fill: 'blue' } }],
    [{ type: 'set-node-style', id: 'resource-a', style: { fill: '#fff' }, extra: 1 }],
  ])('refuses malformed presentation intents %j', (intent) => {
    expect(() => parseGraphIntents([intent])).toThrow();
  });

  it('refuses a missing node, read-only node types and read-only Graphs atomically', () => {
    const profile = clone(relationProfile);
    profile.nodes.entity.readOnly = true;
    const g = createRelationGraph(),
      session = new GraphSession(g, profile);
    expect(() =>
      session.execute([
        { type: 'set-node-shape', id: 'resource-b', shape: 'cloud' },
        { type: 'set-node-shape', id: 'resource-a', shape: 'cloud' },
      ]),
    ).toThrow(/read only/);
    expect(session.content).toEqual(g);
    expect(session.canUndo).toBe(false);
    expect(() => session.execute([{ type: 'set-node-shape', id: 'gone', shape: 'cloud' }])).toThrow(
      /missing/,
    );
    const readOnly = new GraphSession(g, relationProfile);
    readOnly.readOnly = true;
    expect(() =>
      readOnly.execute([{ type: 'set-node-style', id: 'resource-a', style: { fill: '#fff' } }]),
    ).toThrow(/read only/);
  });

  it('previews a shape proposal without changing content and rejects it once stale', () => {
    const session = new GraphSession(createRelationGraph(), relationProfile),
      before = session.content;
    const { proposal, content } = session.preview([
      { type: 'set-node-shape', id: 'resource-a', shape: 'diamond' },
    ]);
    expect(content.presentation.nodes['resource-a'].shape).toBe('diamond');
    expect(session.content).toEqual(before);
    session.execute([{ type: 'move-node', id: 'resource-b', position: { x: 0, y: 0 } }]);
    expect(() => session.apply(proposal)).toThrow(/Stale/);
  });
});

interface Source {
  names: Record<string, string>;
}
const sourceProfile: GraphProfile = {
  schemaVersion: 2,
  id: 'names',
  version: 1,
  graph: { schema: {} },
  nodes: { item: { schema: { name: { type: 'string' } }, ui: { labelField: 'name' } } },
  edges: {},
  sections: {},
};
function binding(mode: GraphAdapter<Source>['presentationMode'], sections = false) {
  let content: Source = { names: { a: 'A', b: 'B' } },
    sidecar: PresentationSidecar | undefined;
  const adapter: GraphAdapter<Source> = {
    id: 'names',
    version: 1,
    presentationMode: mode,
    sections,
    profile: () => sourceProfile,
    project: (source, presentation) => ({
      schemaVersion: 2,
      id: 'names-graph',
      profile: { id: 'names', version: 1 },
      attributes: {},
      nodes: Object.entries(source.names).map(([id, name]) => ({
        id,
        type: 'item',
        attributes: { name },
      })),
      edges: [],
      sections: [],
      presentation: { nodes: clone(presentation ?? {}), sections: {} },
    }),
    prepare: (_source, intents) => ({
      type: 'test.edit-names',
      label: 'Edit names',
      apply: (current) => {
        const next = clone(current);
        for (const intent of intents)
          if (intent.type === 'set-attribute') next.names[intent.id] = String(intent.value);
          else if (intent.type === 'delete-node') delete next.names[intent.id];
          else throw new Error('Names cannot save presentation');
        return next;
      },
    }),
  };
  const b = new GraphBinding<Source>({
    adapter,
    sourceId: 'names',
    read: () => ({ content, revision: canonicalJson(content), readOnly: false }),
    execute: (cmd) => {
      content = cmd.apply(content);
    },
    getPresentation: () => sidecar,
    setPresentation: (value) => {
      sidecar = value;
    },
  });
  return {
    binding: b,
    get sidecar() {
      return sidecar;
    },
    get content() {
      return content;
    },
  };
}

describe('adapter presentation modes', () => {
  it('saves sidecar shapes and positions apart from the source and drops removed nodes', () => {
    const h = binding('sidecar');
    const { stamp } = h.binding.project();
    h.binding.apply(
      [
        { type: 'set-node-shape', id: 'a', shape: 'cylinder' },
        { type: 'move-node', id: 'b', position: { x: 9, y: 9 } },
      ],
      stamp,
    );
    expect(h.sidecar?.schemaVersion).toBe(2);
    expect(h.sidecar?.presentation.nodes.a).toEqual({ x: 40, y: 40, shape: 'cylinder' });
    expect(h.content).toEqual({ names: { a: 'A', b: 'B' } });
    expect(h.binding.project().graph.presentation.nodes.a.shape).toBe('cylinder');
    // A stale preview is refused once the sidecar changed.
    expect(() =>
      h.binding.apply([{ type: 'set-node-shape', id: 'a', shape: 'ellipse' }], stamp),
    ).toThrow(/Stale/);
    h.binding.apply([{ type: 'delete-node', id: 'a', cascade: true }], h.binding.project().stamp);
    expect(Object.keys(h.binding.project().graph.presentation.nodes)).toEqual(['b']);
  });

  it('refuses sidecar batches that mix presentation and semantic edits', () => {
    const h = binding('sidecar'),
      { stamp } = h.binding.project();
    expect(() =>
      h.binding.apply(
        [
          { type: 'set-node-shape', id: 'a', shape: 'cloud' },
          { type: 'set-attribute', scope: 'node', id: 'a', path: ['name'], value: 'X' },
        ],
        stamp,
      ),
    ).toThrow(/separate transactions/);
    expect(h.sidecar).toBeUndefined();
    expect(h.content.names.a).toBe('A');
  });

  it('refuses shapes for a none-mode source and Sections without a source mode', () => {
    const h = binding('none');
    expect(() =>
      h.binding.apply(
        [{ type: 'set-node-style', id: 'a', style: { fill: '#fff' } }],
        h.binding.project().stamp,
      ),
    ).toThrow(/cannot save node shapes/);
    expect(() => binding('sidecar', true)).toThrow(/sections need/i);
    expect(() => binding('none', true)).toThrow(/sections need/i);
    expect(() => binding('source', true)).not.toThrow();
  });

  it('refuses an old or malformed presentation sidecar', () => {
    const h = binding('sidecar'),
      { stamp } = h.binding.project();
    h.binding.apply([{ type: 'move-node', id: 'a', position: { x: 1, y: 1 } }], stamp);
    const saved = clone(h.sidecar!);
    for (const bad of [
      { ...saved, schemaVersion: 1 },
      { ...saved, presentation: { nodes: { a: { x: 1, y: 1, shape: 'star' } } } },
      { ...saved, presentation: { nodes: {}, sections: {} } },
      { ...saved, positions: {} },
    ]) {
      const other = new GraphBinding<Source>({
        ...h.binding.options,
        getPresentation: () => bad as PresentationSidecar,
      });
      expect(() => other.project()).toThrow(/presentation sidecar/);
    }
  });
});
