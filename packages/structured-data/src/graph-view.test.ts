import { expect, it } from 'vitest';
import {
  clone,
  createArtifact,
  commitVersion,
  serializeArtifact,
  contentHash,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { addRow, createData, isStructuredData, dataDiff } from './model';
import { DataSession } from './session';
const fixture = () => {
  const d = addRow().apply(createData());
  d.graphView = {
    schemaVersion: 1,
    labelColumnId: d.columns[0].id,
    positions: { [d.rows[0].id]: { x: 10, y: 20 } },
  };
  return d;
};
it('reads persisted null Graph labels with columns without rewriting drafts or immutable versions', async () => {
  const data = fixture();
  data.graphView!.labelColumnId = null;
  const artifact = await commitVersion(
    createArtifact('data', 'Legacy label', data),
    'test',
    'Legacy',
  );
  const restored = JSON.parse(serializeArtifact(artifact)) as typeof artifact;
  expect(isStructuredData(restored.draft.content)).toBe(true);
  expect(isStructuredData(restored.versions[0].content)).toBe(true);
  expect(new DataSession(restored.draft.content).content).toEqual(data);
  expect(restored.versions[0].content.graphView!.labelColumnId).toBeNull();
  expect(await contentHash(restored.versions[0].content)).toBe(artifact.versions[0].contentHash);
  const bad = clone(data);
  bad.graphView!.labelColumnId = 'missing';
  expect(isStructuredData(bad)).toBe(false);
});
it.each([
  { x: 10, y: 20, metadata: 'extra' },
  { x: 10 },
  { x: Infinity, y: 20 },
  [10, 20],
  { x: 100001, y: 20 },
])(
  'refuses malformed Data graph positions without modifying a readable source (%j)',
  (position) => {
    const d = fixture(),
      bad = clone(d),
      id = d.rows[0].id;
    bad.graphView!.positions[id] = position as { x: number; y: number };
    expect(isStructuredData(bad)).toBe(false);
    const session = new DataSession(d),
      revision = session.revision;
    expect(() => new DataSession(bad)).toThrow('Invalid Data');
    expect(() => session.execute(command('invalid-position', 'Invalid move', () => bad))).toThrow(
      'Invalid Data',
    );
    expect(session.content).toEqual(d);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
    expect(
      JSON.parse(serializeArtifact(createArtifact('data', 'Retained source', bad))).draft.content
        .graphView,
    ).toEqual(JSON.parse(JSON.stringify(bad.graphView)));
  },
);
it('describes graph view creation/removal, label fields and stable row positions separately from cell values', async () => {
  const initial = fixture(),
    id = initial.rows[0].id,
    moved = clone(initial);
  moved.graphView!.positions[id] = { x: 30, y: 40 };
  expect(dataDiff(initial, moved).changes).toEqual([
    {
      elementId: id,
      path: 'Graph position',
      kind: 'changed',
      before: 'x: 10, y: 20',
      after: 'x: 30, y: 40',
    },
  ]);
  const labeled = clone(initial);
  labeled.graphView!.labelColumnId = initial.columns[1].id;
  expect(dataDiff(initial, labeled).changes).toEqual([
    {
      elementId: 'data-graph-view',
      path: 'Graph label field',
      kind: 'changed',
      before: 'Name',
      after: 'Status',
    },
  ]);
  const none = clone(initial);
  delete none.graphView;
  expect(dataDiff(none, initial).changes.map((c) => c.path)).toEqual([
    'Graph view settings',
    'Graph label field',
    'Graph position',
  ]);
  expect(dataDiff(initial, none).changes.find((c) => c.elementId === id)?.kind).toBe('removed');
  expect(dataDiff(initial, clone(initial)).changes).toEqual([]);
  const versions = await commitVersion(
    await commitVersion(createArtifact('data', 'Position comparison', initial), 'test', 'Initial'),
    'test',
    'Same layout',
  );
  const changed = await commitVersion(
    { ...versions, draft: { ...versions.draft, content: moved } },
    'test',
    'Moved',
  );
  expect(changed.versions[0].contentHash).not.toBe(changed.versions[2].contentHash);
  expect(dataDiff(changed.versions[0].content, changed.versions[2].content).changes[0].path).toBe(
    'Graph position',
  );
  expect(await contentHash(changed.versions[0].content)).toBe(changed.versions[0].contentHash);
});
