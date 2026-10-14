import { expect, it } from 'vitest';
import { createGraph } from './model';
import { createGraphNode } from './commands';
import { GraphSession } from './session';
import { validateGraph, type GraphProfile } from './profile';
const profile: GraphProfile = {
  schemaVersion: 1,
  id: 'bounded',
  version: 1,
  graph: { schema: {} },
  edges: {},
  nodes: {
    item: {
      schema: {
        short: { type: 'string', maxLength: 3, required: true },
        empty: { type: 'string', maxLength: 0 },
        negative: { type: 'number', maximum: -1, required: true },
        both: { type: 'number', minimum: -10, maximum: -5 },
        positive: { type: 'number', minimum: 2, maximum: 4 },
        requiredObject: {
          type: 'object',
          required: true,
          properties: { count: { type: 'number', minimum: 1 } },
        },
        optionalArray: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};
it('creates a bounded draft that can be edited and undone, without committing out-of-range seeds or edits', () => {
  const session = new GraphSession(createGraph(profile), profile),
    original = session.content;
  session.execute(
    [{ type: 'add-node', node: createGraphNode(profile, 'item', 'new'), position: { x: 1, y: 2 } }],
    session.stamp,
  );
  expect(validateGraph(session.content, profile).filter((d) => d.blocking)).toEqual([]);
  expect(session.content.nodes[0].attributes.short).toHaveLength(3);
  expect(session.content.nodes[0].attributes.negative).toBeLessThanOrEqual(-1);
  expect(
    validateGraph(session.content, profile).some(
      (d) => d.code === 'required' && d.path[0] === 'requiredObject',
    ),
  ).toBe(true);
  const added = session.content,
    revision = session.revision;
  expect(() =>
    session.execute(
      [{ type: 'set-attribute', scope: 'node', id: 'new', path: ['negative'], value: 0 }],
      session.stamp,
    ),
  ).toThrow('range');
  expect(session.content).toEqual(added);
  expect(session.revision).toEqual(revision);
  session.execute(
    [{ type: 'set-attribute', scope: 'node', id: 'new', path: ['short'], value: 'OK' }],
    session.stamp,
  );
  expect(session.undo()).toEqual(added);
  expect(session.undo()).toEqual(original);
});
it('omits unsatisfiable enum seeds and permits required omissions as incomplete diagnostics', () => {
  const custom: GraphProfile = {
    ...profile,
    nodes: {
      item: {
        schema: {
          optional: { type: 'enum', enum: ['long'], maxLength: 1 },
          required: { type: 'enum', enum: [1], minimum: 2, required: true },
        },
      },
    },
  };
  const session = new GraphSession(createGraph(custom), custom);
  session.execute(
    [{ type: 'add-node', node: createGraphNode(custom, 'item', 'new'), position: { x: 1, y: 2 } }],
    session.stamp,
  );
  expect(session.content.nodes[0].attributes).toEqual({});
  expect(validateGraph(session.content, custom)).toMatchObject([
    { path: ['required'], code: 'required', blocking: false },
  ]);
});
