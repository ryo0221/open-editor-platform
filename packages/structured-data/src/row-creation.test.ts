import { expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  createArtifact,
  commitVersion,
  contentHash,
  updateDraft,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { createDataRows, DataSession, guardDataCommand } from './session';
import { type DataRow, type StructuredData } from './model';
import { setCells } from './views';

function fixture() {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'key', name: 'Key', type: 'text', required: true, readOnly: true },
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'derived', name: 'Derived', type: 'text', readOnly: true },
      { id: 'formula', name: 'Formula', type: 'formula', formula: '1' },
    ],
    rows: [{ id: 'one', values: { key: 'one', name: 'First', derived: null } }],
  };
  const session: DataSession = new DataSession(data, () => read());
  let datasetId = 'dataset',
    revision = '',
    readOnly = false,
    allowed = ['key'];
  const read = () => ({
    datasetId,
    revision: revision || canonicalJson(session.revision),
    content: session.content,
    readOnly,
    initialReadOnlyColumns: allowed,
  });
  const row: DataRow = { id: 'two', values: { key: 'two', name: 'Second', derived: null } };
  return {
    session,
    read,
    row,
    change: (kind: string) => {
      if (kind === 'dataset') datasetId = 'other';
      if (kind === 'revision') revision = 'later';
      if (kind === 'permission') readOnly = true;
      if (kind === 'policy') allowed = [];
    },
  };
}
it.each(['unknown', 'formula', 'name'])(
  'does not authorize invalid protected columns: %s',
  (column) => {
    const f = fixture();
    expect(() =>
      createDataRows([f.row], () => ({ ...f.read(), initialReadOnlyColumns: [column] })),
    ).toThrow();
  },
);
it('owns proposed values and rejects read-only or empty creation at preparation', () => {
  const f = fixture(),
    original = clone(f.row);
  expect(() => createDataRows([], f.read)).toThrow();
  expect(() => createDataRows([f.row], () => ({ ...f.read(), readOnly: true }))).toThrow(
    'read only',
  );
  const cmd = createDataRows([f.row], f.read);
  f.row.values.key = 'changed after preparation';
  f.session.execute(cmd);
  expect(f.session.content.rows.at(-1)).toEqual(original);
});
it('creates one atomic edit with protected initial values and stable Undo/Redo IDs', () => {
  const f = fixture(),
    before = f.session.content,
    cmd = createDataRows([f.row], f.read);
  // Hosts may preflight and guard twice; no mutation or token consumption during preparation.
  guardDataCommand(cmd, () => true, f.read).apply(before);
  f.session.execute(guardDataCommand(cmd, () => true, f.read));
  expect(f.session.content.rows).toEqual([...before.rows, f.row]);
  expect(f.session.undo()).toEqual(before);
  expect(f.session.redo().rows.at(-1)).toEqual(f.row);
  expect(() =>
    f.session.execute(setCells([{ rowId: 'two', columnId: 'key', value: 'changed' }])),
  ).toThrow();
  expect(() => f.session.execute(cmd)).toThrow('stale');
});
it.each(['dataset', 'revision', 'permission', 'policy'])(
  'refuses changed Host %s without changing history',
  (kind) => {
    const f = fixture(),
      cmd = createDataRows([f.row], f.read),
      before = f.session.content,
      rev = f.session.revision;
    f.change(kind);
    expect(() => f.session.execute(cmd)).toThrow();
    expect(f.session.content).toEqual(before);
    expect(f.session.revision).toEqual(rev);
  },
);
it('refuses changed schema/content and an old command even after Undo', () => {
  const f = fixture(),
    cmd = createDataRows([f.row], f.read),
    before = f.session.content;
  const changed = clone(before);
  changed.columns[0].name = 'Renamed';
  expect(() => guardDataCommand(cmd, () => true, f.read).apply(changed)).toThrow('stale');
  f.session.execute(setCells([{ rowId: 'one', columnId: 'name', value: 'Edited' }]));
  f.session.undo();
  expect(f.session.content).toEqual(before);
  expect(() => f.session.execute(cmd)).toThrow('stale');
});
it('does not grant privileges through a command name or copying an authorized command', () => {
  const f = fixture(),
    cmd = createDataRows([f.row], f.read),
    before = f.session.content;
  for (const forged of [
    { ...cmd },
    command<StructuredData>('data.create-records', 'Forged', (d) => ({
      ...d,
      rows: [...d.rows, f.row],
    })),
  ])
    expect(() => f.session.execute(forged)).toThrow('read-only');
  expect(f.session.content).toEqual(before);
});
it.each(['duplicate', 'existing', 'missing', 'unknown', 'formula', 'protected'])(
  'rejects invalid or unauthorized new values: %s',
  (kind) => {
    const f = fixture(),
      row = clone(f.row),
      rows = [row],
      before = f.session.content;
    if (kind === 'duplicate') rows.push(clone(row));
    if (kind === 'existing') row.id = 'one';
    if (kind === 'missing') row.values.name = '';
    if (kind === 'unknown') row.values.extra = 'no';
    if (kind === 'formula') row.values.formula = 99;
    if (kind === 'protected') row.values.derived = 'forged';
    expect(() => f.session.execute(createDataRows(rows, f.read))).toThrow();
    expect(f.session.content).toEqual(before);
  },
);

it('refuses a creation command in another session with identical content or no Host target', () => {
  const f = fixture(),
    other = fixture(),
    cmd = createDataRows([f.row], f.read);
  expect(other.session.content).toEqual(f.session.content);
  const before = other.session.revision;
  expect(() => other.session.execute(cmd)).toThrow('execution target');
  expect(other.session.revision).toEqual(before);
  expect(() => new DataSession(f.session.content).execute(cmd)).toThrow('execution target');
  expect(() => guardDataCommand(cmd).apply(f.session.content)).toThrow('execution target');
});

it.each(['undo', 'undoView', 'redo', 'redoView'] as const)(
  '%s enforces current Host authorization and preserves rejected history',
  (direction) => {
    const f = fixture();
    f.session.execute(createDataRows([f.row], f.read));
    if (direction.startsWith('redo')) f.session.undo();
    const before = f.session.content,
      revision = f.session.revision;
    for (const reason of ['dataset', 'permission']) {
      f.change(reason);
      expect(() =>
        f.session[direction](() => {
          const current = f.read();
          if (reason === 'dataset' ? current.datasetId !== 'dataset' : current.readOnly)
            throw new Error('Host denied');
        }),
      ).toThrow('Host denied');
      expect(f.session.content).toEqual(before);
      expect(f.session.revision).toEqual(revision);
    }
    f.session.readOnly = true;
    expect(() => f.session[direction]()).toThrow('read only');
    f.session.readOnly = false;
    let checked = false;
    f.session[direction]((candidate) => {
      checked = true;
      expect(candidate.rows.some((r) => r.id === f.row.id)).toBe(direction.startsWith('redo'));
    });
    expect(checked).toBe(true);
  },
);

it('rejects permission revocation at the post-apply boundary without a partial edit', () => {
  const f = fixture();
  const cmd = createDataRows([f.row], f.read);
  const before = f.session.content,
    revision = f.session.revision;
  let reads = 0;
  const guarded = guardDataCommand(
    cmd,
    () => true,
    () => {
      if (++reads === 2) f.change('permission');
      return f.read();
    },
  );
  expect(() => f.session.execute(guarded)).toThrow();
  expect(f.session.content).toEqual(before);
  expect(f.session.revision).toEqual(revision);
});

it('round trips created rows and hashes without changing an existing native version', async () => {
  const f = fixture();
  let artifact = await commitVersion(
    createArtifact('data', 'Creation', f.session.content),
    'host',
    'Before creation',
  );
  const oldVersion = clone(artifact.versions[0]);
  f.session.execute(createDataRows([f.row], f.read));
  artifact = await commitVersion(
    updateDraft(artifact, f.session.content),
    'host',
    'After creation',
  );
  const loaded = JSON.parse(JSON.stringify(artifact));
  expect(loaded.versions[0]).toEqual(oldVersion);
  expect(loaded.draft.content.rows).toEqual(f.session.content.rows);
  for (const version of loaded.versions)
    expect(await contentHash(version.content)).toBe(version.contentHash);
  expect(new DataSession(loaded.draft.content).content).toEqual(f.session.content);
});
