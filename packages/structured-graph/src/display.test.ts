import { expect, it } from 'vitest';
import { placeMeasuredGraphEdgeLabels } from './display';
import { clone } from '@editor-platform/artifact-core';
import { fitGraphView, graphNodeSize, graphBoxesOverlap, placeGraphEdgeLabels } from './display';
import { routeGraphEdge, routeIntersects, separateGraphRoutes } from './routing';
import { isGraphProfile, validateGraph } from './profile';
import { createRelationGraph, relationProfile } from './reference';
import { graphEdgeText } from './view-model';
import { graphConnectionLabelField, prepareGraphConnection } from './view-connection';

it('fits negative coordinates and actual custom dimensions at desktop and mobile widths', () => {
  const boxes = [
    { x: -500, y: -80, width: 350, height: 180 },
    { x: 1800, y: 2400, width: 280, height: 120 },
  ];
  for (const viewport of [
    { width: 1100, height: 700 },
    { width: 390, height: 330 },
  ]) {
    const view = fitGraphView(boxes, viewport);
    for (const box of boxes) {
      expect(view.x + box.x * view.zoom).toBeGreaterThanOrEqual(19.999);
      expect(view.y + box.y * view.zoom).toBeGreaterThanOrEqual(19.999);
      expect(view.x + (box.x + box.width) * view.zoom).toBeLessThanOrEqual(viewport.width - 19.999);
      expect(view.y + (box.y + box.height) * view.zoom).toBeLessThanOrEqual(
        viewport.height - 19.999,
      );
    }
  }
  expect(fitGraphView([], { width: 390, height: 330 })).toEqual({ x: 0, y: 0, zoom: 1 });
});

it('uses actual dimensions for ports, obstacle avoidance and overlap refusal', () => {
  const a = { x: 0, y: 120, width: 320, height: 130 },
    b = { x: 1100, y: 120, width: 280, height: 100 };
  const obstacle = { x: 450, y: 50, width: 420, height: 260 };
  const route = routeGraphEdge(a, b, [a, b, obstacle]);
  expect(route.path).not.toBe('');
  expect(route.source.x).toBe(320);
  expect(route.target.x).toBe(1100);
  expect(
    route.points.some((p, i) => i > 0 && routeIntersects(route.points[i - 1], p, obstacle)),
  ).toBe(false);
  expect(routeGraphEdge(a, { ...b, x: 180 }, [a, { ...b, x: 180 }]).path).toBe('');
});

it('keeps dense parallel labels clear of each other and nodes, deferring excess labels', () => {
  const a = { x: 0, y: 0, width: 300, height: 120 },
    b = { x: 1100, y: 0, width: 300, height: 120 };
  const route = routeGraphEdge(a, b, [a, b]);
  const edges = Array.from({ length: 24 }, (_, i) => ({
    id: String(i),
    route,
    text: '関係名の長いラベル',
  }));
  const placements = placeGraphEdgeLabels(edges, [a, b]);
  const shown = [...placements.values()].filter((label) => !label.deferred);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(edges.length);
  shown.forEach((label, i) => {
    for (const box of [a, b, ...shown.slice(i + 1).map((label) => label.bounds)])
      expect(graphBoxesOverlap(label.bounds, box)).toBe(false);
  });
  expect(placeGraphEdgeLabels(edges, [a, b])).toEqual(placements);
});

it('falls back from invalid Host sizes without changing the legacy default', () => {
  expect(graphNodeSize({ width: 320, height: 140 })).toEqual({ width: 320, height: 140 });
  for (const size of [
    undefined,
    { width: NaN, height: 70 },
    { width: 200, height: -1 },
    { width: 4001, height: 70 },
  ])
    expect(graphNodeSize(size)).toEqual({ width: 200, height: 70 });
});

it('accepts declarative edge styles and rejects URLs, invalid dash values and wrong scopes', () => {
  const profile = clone(relationProfile);
  profile.edges.related.ui = { label: 'Related', edgeStyle: { color: '#135', dash: [8, 4] } };
  expect(isGraphProfile(profile)).toBe(true);
  for (const edgeStyle of [
    { color: 'url(https://example.test/style)' },
    { color: 'red' },
    { dash: [-1] },
    { dash: [0] },
    { dash: [65] },
    { dash: Array(9).fill(1) },
    { unknown: 1 },
  ])
    expect(
      isGraphProfile({
        ...profile,
        edges: { related: { ...profile.edges.related, ui: { edgeStyle } } },
      }),
    ).toBe(false);
  expect(
    isGraphProfile({ ...profile, graph: { schema: {}, ui: { edgeStyle: { color: '#123456' } } } }),
  ).toBe(false);
  expect(
    isGraphProfile({
      ...profile,
      nodes: { entity: { schema: {}, ui: { edgeStyle: { dash: [2] } } } },
    }),
  ).toBe(false);
});

it('uses measured wide/tall glyph bounds and defers a label that cannot fit the route gap', () => {
  const nodes = [
    { x: 0, y: 0, width: 200, height: 70 },
    { x: 800, y: 0, width: 200, height: 70 },
  ];
  const route = routeGraphEdge(nodes[0], nodes[1], nodes);
  const narrow = placeMeasuredGraphEdgeLabels(
    [{ id: 'edge', route, text: 'W'.repeat(60), size: { width: 450, height: 30 } }],
    nodes,
  ).get('edge')!;
  expect(narrow.deferred).toBe(false);
  expect(nodes.some((n) => graphBoxesOverlap(n, narrow.bounds))).toBe(false);
  const wide = placeMeasuredGraphEdgeLabels(
    [{ id: 'edge', route, text: 'W'.repeat(60), size: { width: 686, height: 34 } }],
    nodes,
  ).get('edge')!;
  expect(wide.deferred).toBe(true);
  expect(wide.bounds.width).toBe(686);
  expect(wide.bounds.height).toBe(34);
});

it('#378 Fit centres the whole drawing and enlarges it up to 2×', () => {
  const boxes = [
    { x: 100, y: 100, width: 200, height: 70 },
    { x: 500, y: 300, width: 200, height: 70 },
  ];
  const view = fitGraphView(boxes, { width: 1300, height: 860 });
  expect(view.zoom).toBe(2);
  // 600×270 drawn at 2× is 1200×540, centred in 1300×860.
  expect(view.x + 100 * view.zoom).toBe(50);
  expect(view.y + 100 * view.zoom).toBe(160);
});

it('#378 connections sharing a line into one node side get their own ports and lines', () => {
  const hub = { x: 500, y: 400, width: 200, height: 70 },
    left = { x: 300, y: 100, width: 200, height: 70 },
    right = { x: 700, y: 100, width: 200, height: 70 },
    nodes = [hub, left, right];
  const raw = new Map([
    ['l', routeGraphEdge(left, hub, nodes)],
    ['r', routeGraphEdge(right, hub, nodes)],
  ]);
  // Both routes end on the same trunk into the middle of the hub's top side.
  expect(raw.get('l')!.target).toEqual(raw.get('r')!.target);
  const routes = separateGraphRoutes(
    raw,
    new Map([
      ['l', { source: left, target: hub }],
      ['r', { source: right, target: hub }],
    ]),
    nodes,
  );
  const l = routes.get('l')!,
    r = routes.get('r')!;
  expect(l.target.y).toBe(hub.y);
  expect(r.target.y).toBe(hub.y);
  expect(l.target.x).toBeLessThan(r.target.x);
  for (const target of [l.target, r.target]) {
    expect(target.x).toBeGreaterThanOrEqual(hub.x + 6);
    expect(target.x).toBeLessThanOrEqual(hub.x + hub.width - 6);
  }
  for (const route of [l, r])
    expect(
      route.points.some(
        (p, i) => i > 0 && nodes.some((n) => routeIntersects(route.points[i - 1], p, n)),
      ),
    ).toBe(false);
  const labels = placeGraphEdgeLabels(
    [
      { id: 'l', route: l, text: '出資' },
      { id: 'r', route: r, text: '出資' },
    ],
    nodes,
  );
  expect(graphBoxesOverlap(labels.get('l')!.bounds, labels.get('r')!.bounds)).toBe(false);
  // Same input, same drawing.
  expect(
    separateGraphRoutes(
      raw,
      new Map([
        ['l', { source: left, target: hub }],
        ['r', { source: right, target: hub }],
      ]),
      nodes,
    ),
  ).toEqual(routes);
});

it('#378 a named connection shows its name alone and Connect nodes stores the typed name', () => {
  const profile = clone(relationProfile),
    edge = { id: 'e', type: 'related', from: 'a', to: 'b', attributes: { label: '出資' } };
  expect(graphEdgeText(profile, edge)).toBe('出資');
  expect(graphEdgeText(profile, { ...edge, attributes: {} })).toBe('Related');
  expect(graphConnectionLabelField(profile, 'related')).toBe('label');
  const graph = createRelationGraph();
  const intent = prepareGraphConnection({
    readOnly: false,
    connection: {
      base: 's',
      target: graph.id,
      dirty: true,
      type: 'related',
      from: 'resource-a',
      to: 'resource-b',
      label: ' 融資 ',
    },
    stamp: 's',
    id: graph.id,
    graph,
    profile,
    edgeId: () => 'new-edge',
  });
  expect(intent).toEqual({
    type: 'add-edge',
    edge: {
      id: 'new-edge',
      type: 'related',
      from: 'resource-a',
      to: 'resource-b',
      attributes: { label: '融資' },
    },
  });
  // An open IME composition in the name blocks both the form and a Host flush.
  expect(() =>
    prepareGraphConnection({
      readOnly: false,
      connection: {
        base: 's',
        target: graph.id,
        dirty: true,
        type: 'related',
        from: 'resource-a',
        to: 'resource-b',
        label: '融',
        composing: true,
      },
      stamp: 's',
      id: graph.id,
      graph,
      profile,
    }),
  ).toThrow('入力変換');
  // A type without a text label field has no name input.
  profile.edges.related.schema.label = { type: 'number' };
  expect(graphConnectionLabelField(profile, 'related')).toBeUndefined();
});

it('#378 the Playground relation Profile tells organisations, companies, financiers, authorities and people apart', () => {
  expect(isGraphProfile(relationProfile)).toBe(true);
  expect(
    Object.fromEntries(Object.entries(relationProfile.nodes).map(([k, t]) => [k, t.ui?.label])),
  ).toEqual({
    entity: 'Entity',
    organization: 'Organization',
    company: 'Company',
    financier: 'Bank or financier',
    authority: 'Government or regulator',
    person: 'Person',
  });
  const graph = createRelationGraph();
  graph.nodes.push({ id: 'bank', type: 'financier', attributes: { name: '国際協力銀行' } });
  expect(validateGraph(graph, relationProfile)).toEqual([]);
});
