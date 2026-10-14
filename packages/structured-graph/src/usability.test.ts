import { expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createRelationGraph, relationProfile } from './reference';
import { routeGraphEdge, routeIntersects } from './routing';
import { prepareGraphDefinition, previewGraphDefinition } from './definition';
import {
  prepareGraphAttributeDraft,
  parseAttribute,
  emptyAttributeValue,
  formatAttribute,
} from './attribute-draft';
import { formatGraphDiagnostic } from './diagnostics';
import { validateGraph } from './profile';
it('routes around a middle node in both directions and reflows after moving it', () => {
  const source = { x: 20, y: 80, width: 200, height: 70 },
    target = { ...source, x: 680 };
  const obstacle = { ...source, x: 340 };
  for (const [a, b] of [
    [source, target],
    [target, source],
  ]) {
    const route = routeGraphEdge(a, b, [source, target, obstacle]);
    expect(route.path).not.toBe('');
    expect(
      route.points.some(
        (point, i) => i > 0 && routeIntersects(route.points[i - 1], point, obstacle),
      ),
    ).toBe(false);
    expect(route.source.x).toBe(a.x < b.x ? a.x + a.width : a.x);
    expect(route.target.x).toBe(a.x < b.x ? b.x : b.x + b.width);
    expect(routeGraphEdge(a, b, [a, b, { ...obstacle, y: 300 }]).path).not.toBe(route.path);
  }
});
it('uses vertical ports and preserves unobstructed self loops', () => {
  const a = { x: 60, y: 60, width: 200, height: 70 },
    b = { ...a, y: 350 };
  const route = routeGraphEdge(a, b, [a, b]);
  expect(route.source.y).toBe(130);
  expect(route.target.y).toBe(350);
  const loop = routeGraphEdge(a, a, [a], true);
  expect(loop.path).not.toBe('');
  expect(
    loop.points.some((point, i) => i > 0 && routeIntersects(loop.points[i - 1], point, a)),
  ).toBe(false);
});
it('distinguishes empty and whitespace enum values from the placeholder', () => {
  const schema = { type: 'enum' as const, enum: ['', ' ', '__ep_unset__', 0, false] };
  expect(parseAttribute('', schema)).toBe('');
  expect(parseAttribute(' ', schema)).toBe(' ');
  expect(parseAttribute(emptyAttributeValue(schema), schema)).toBeNull();
  expect(parseAttribute('0', schema)).toBe(0);
  expect(parseAttribute('false', schema)).toBe(false);
});
it('retains separate buffers, rejects edited source attributes, and keeps undeclared data', () => {
  const graph = createRelationGraph(),
    node = graph.nodes[0],
    schema = relationProfile.nodes[node.type].schema;
  const values = Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [
      key,
      formatAttribute(node.attributes[key], field),
    ]),
  );
  const draft = {
    id: node.id,
    scope: 'node' as const,
    original: clone(node.attributes),
    schema,
    values: { ...values, name: 'Edited' },
  };
  const intents = prepareGraphAttributeDraft(draft, node.attributes, schema);
  expect(intents).toEqual([
    { type: 'set-attribute', scope: 'node', id: node.id, path: ['name'], value: 'Edited' },
  ]);
  expect(() =>
    prepareGraphAttributeDraft(draft, { ...node.attributes, name: 'Remote' }, schema),
  ).toThrow('変更されました');
});
it('preserves readable incomplete Graph drafts while rejecting blocking attribute errors', () => {
  const original = { name: 'Incomplete', amount: 1 };
  const schema = {
    name: { type: 'string' as const, required: true },
    amount: { type: 'number' as const, minimum: 0 },
  };
  const draft = {
    id: 'n',
    scope: 'node' as const,
    original,
    schema,
    values: { name: '', amount: '2' },
  };
  expect(prepareGraphAttributeDraft(draft, original, schema)).toEqual([
    { type: 'set-attribute', scope: 'node', id: 'n', path: ['name'], value: null },
    { type: 'set-attribute', scope: 'node', id: 'n', path: ['amount'], value: 2 },
  ]);
  expect(() =>
    prepareGraphAttributeDraft({ ...draft, values: { name: '', amount: '-1' } }, original, schema),
  ).toThrow('range');
});
it('previews and commits a Profile migration in the same source history without changing old versions', () => {
  const source = { graph: createRelationGraph(), profile: clone(relationProfile) };
  const type = source.graph.nodes[0].type;
  source.graph.nodes.forEach((node, i) => {
    if (node.type === type) node.attributes.name = String(i + 10);
  });
  const change = {
    scope: 'node' as const,
    type,
    definition: {
      ...source.profile.nodes[type],
      schema: {
        ...source.profile.nodes[type].schema,
        name: { type: 'number' as const },
      },
    },
  };
  const preview = previewGraphDefinition(source, change);
  expect(preview.diagnostics).toEqual([]);
  expect(preview.convertedValues).toBeGreaterThan(0);
  const session = new EditorSession(source),
    edit = prepareGraphDefinition(source, change);
  session.execute(edit);
  expect(session.content.graph.profile.version).toBe(source.profile.version + 1);
  expect(typeof session.content.graph.nodes[0].attributes.name).toBe('number');
  expect(session.undo()).toEqual(source);
  expect(typeof source.graph.nodes[0].attributes.name).toBe('string');
  const stale = clone(source);
  stale.graph.nodes[0].attributes.name = '99';
  expect(() => edit.apply(stale)).toThrow('changed before migration');
  const invalid = clone(source);
  invalid.graph.nodes[0].attributes.name = 'Cannot convert';
  expect(
    previewGraphDefinition(invalid, change).diagnostics.some(
      (diagnostic) => diagnostic.code === 'type',
    ),
  ).toBe(true);
  expect(() => prepareGraphDefinition(invalid, change)).toThrow('無効');
});
it('formats named targets, localized reason and corrective action while retaining code and arguments', () => {
  const graph = createRelationGraph();
  graph.edges[0].to = graph.edges[0].from;
  const profile = clone(relationProfile);
  profile.edges.related.connection!.allowSelf = false;
  const diagnostic = validateGraph(graph, profile).find(
    (diagnostic) => diagnostic.code === 'self',
  )!;
  expect(diagnostic.args).toEqual({ elementId: diagnostic.elementId });
  const japanese = formatGraphDiagnostic(diagnostic, graph, profile, 'ja');
  expect(japanese).toContain('Research');
  expect(japanese).toContain('別のノード');
  expect(japanese).not.toContain(graph.nodes[0].id);
  expect(formatGraphDiagnostic(diagnostic, graph, profile, 'en')).toContain('Self connections');
  expect(canonicalJson(graph)).toContain(graph.nodes[0].id);
});
it('permits a definition display-label migration while retaining nonblocking incomplete draft diagnostics', () => {
  const source = { graph: createRelationGraph(), profile: clone(relationProfile) };
  delete source.graph.nodes[0].attributes.name;
  const change = {
    scope: 'node' as const,
    type: 'entity',
    definition: {
      ...source.profile.nodes.entity,
      ui: { ...source.profile.nodes.entity.ui, label: 'Renamed display' },
    },
  };
  const preview = previewGraphDefinition(source, change);
  expect(preview.diagnostics.length).toBeGreaterThan(0);
  expect(preview.diagnostics.every((diagnostic) => !diagnostic.blocking)).toBe(true);
  const next = prepareGraphDefinition(source, change).apply(source);
  expect(next.profile.nodes.entity.ui?.label).toBe('Renamed display');
  expect(next.graph.nodes[0].attributes.name).toBeUndefined();
});
