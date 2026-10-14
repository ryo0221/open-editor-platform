import { expect, it, vi } from 'vitest';
import { clone, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  GraphSession,
  relationProfile,
  createRelationGraph,
  readGraphArtifact,
  readGraphArtifactFile,
  graphArtifactByteLimit,
  type GraphIntent,
  type GraphDocument,
} from './headless';
function graphWithHidden() {
  const graph = createRelationGraph(),
    profile = clone(relationProfile);
  profile.nodes.entity.schema.details = {
    type: 'object',
    properties: {
      description: { type: 'string' },
      nested: { type: 'object', properties: { note: { type: 'string' } } },
    },
  };
  graph.attributes.unshown = { keep: 'Root metadata' };
  graph.nodes[0].attributes.details = {
    description: 'Original',
    retained: { secret: 'Keep' },
    nested: { note: 'Nested', hidden: 'Retain' },
  };
  return { graph, profile, session: new GraphSession(graph, profile) };
}
const details = (value: unknown): GraphIntent => ({
  type: 'set-attribute',
  scope: 'node',
  id: 'resource-a',
  path: ['details'],
  value: value as never,
});
it('native whole-object and nested edits preserve hidden children recursively and Undo restores the original', () => {
  const h = graphWithHidden();
  h.session.execute([details({ description: 'Changed', nested: { note: 'Updated' } })]);
  expect(h.session.content.nodes[0].attributes.details).toEqual({
    description: 'Changed',
    retained: { secret: 'Keep' },
    nested: { note: 'Updated', hidden: 'Retain' },
  });
  expect(h.session.undo()).toEqual(h.graph);
});
it('native batches and arbitrary headless snapshots cannot overwrite, clear or remove undeclared object data', () => {
  const h = graphWithHidden(),
    revision = h.session.revision,
    history = [h.session.canUndo, h.session.canRedo];
  for (const invalid of [
    details({ description: 'Changed', retained: { secret: 'Overwrite' } }),
    details({ nested: { hidden: 'Overwrite' } }),
    details(null),
    { type: 'remove-attribute', scope: 'node', id: 'resource-a', path: ['details'] } as GraphIntent,
  ]) {
    expect(() =>
      h.session.execute([
        {
          type: 'set-attribute',
          scope: 'node',
          id: 'resource-a',
          path: ['name'],
          value: 'Partial edit',
        },
        invalid,
      ]),
    ).toThrow('undeclared');
    expect(h.session.content).toEqual(h.graph);
    expect(h.session.revision).toEqual(revision);
    expect([h.session.canUndo, h.session.canRedo]).toEqual(history);
  }
  for (const edit of [
    (g: GraphDocument) => {
      g.nodes[0].attributes.details = { description: 'Lose children' };
    },
    (g: GraphDocument) => {
      g.attributes.unshown = null;
    },
    (g: GraphDocument) => {
      delete g.attributes.unshown;
    },
  ])
    expect(() =>
      h.session.executeCommand(
        command('headless', 'Replace snapshot', (g) => {
          edit(g);
          return g;
        }),
      ),
    ).toThrow('undeclared');
  expect(h.session.content).toEqual(h.graph);
  expect(h.session.revision).toEqual(revision);
});
it('object-array replacements preserve hidden members at the common boundary', () => {
  const h = graphWithHidden();
  h.profile.nodes.entity.schema.items = {
    type: 'array',
    items: { type: 'object', properties: { note: { type: 'string' } } },
  };
  h.graph.nodes[0].attributes.items = [{ note: 'Old', retained: 'Keep' }];
  const session = new GraphSession(h.graph, h.profile);
  const set = (value: unknown) => ({ ...details(value), path: ['items'] });
  session.execute([set([{ note: 'Updated', retained: 'Keep' }])]);
  expect(session.undo()).toEqual(h.graph);
  for (const value of [[], [{ note: 'Lose' }], [{ note: 'Old', retained: 'Overwrite' }]])
    expect(() => session.execute([set(value)])).toThrow('undeclared');
});
it('refuses oversized or invalid File metadata without ever materializing text', async () => {
  const text = vi.fn(async () => 'unused');
  for (const size of [graphArtifactByteLimit + 1, -1, NaN, Infinity, 0.5])
    await expect(readGraphArtifactFile({ size, text }, () => relationProfile)).rejects.toThrow(
      'file size',
    );
  expect(text).not.toHaveBeenCalled();
});
it('accepts the exact file-size metadata boundary and a real small valid native file', async () => {
  const serialized = serializeArtifact(
      createArtifact('structured-graph', 'Bounded', createRelationGraph()),
    ),
    text = vi.fn(async () => serialized);
  for (const size of [new TextEncoder().encode(serialized).length, graphArtifactByteLimit]) {
    const imported = await readGraphArtifactFile({ size, text }, () => relationProfile);
    expect(imported.draft.content).toEqual(JSON.parse(serialized).draft.content);
  }
  expect(text).toHaveBeenCalledTimes(2);
});
it('direct string import retains its size limit before parsing or resolving Profiles', async () => {
  const resolve = vi.fn(() => relationProfile);
  await expect(readGraphArtifact(' '.repeat(graphArtifactByteLimit + 1), resolve)).rejects.toThrow(
    '16 MB',
  );
  await expect(
    readGraphArtifact('🔥'.repeat(graphArtifactByteLimit / 4 + 1), resolve),
  ).rejects.toThrow('16 MB');
  expect(resolve).not.toHaveBeenCalled();
});
it('accepts initial unmapped native metadata and restores a deleted identity without making existing metadata editable', () => {
  const h = graphWithHidden();
  h.session.execute([{ type: 'delete-node', id: 'resource-a', cascade: true }]);
  const deleted = h.session.content;
  h.session.executeCommand(
    command('host.restore', 'Restore original native snapshot', () => clone(h.graph)),
  );
  expect(h.session.content).toEqual(h.graph);
  expect(h.session.undo()).toEqual(deleted);
  expect(h.session.redo()).toEqual(h.graph);
  expect(() => h.session.execute([details({ retained: 'Overwrite' })])).toThrow('undeclared');
});
