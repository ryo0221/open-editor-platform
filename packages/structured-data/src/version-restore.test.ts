import { expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  contentHash,
  createArtifact,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { type StructuredData } from './model';
import { setCells, deleteRows, updateColumn, insertRows } from './views';
import { DataSession, guardDataCommand, restoreDataVersion } from './session';
async function history() {
  const initial: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Name', type: 'text', defaultValue: 'New record' },
      { id: 'computed', name: 'Computed', type: 'formula', formula: '1' },
    ],
    rows: [{ id: 'r', values: { name: 'New record' } }],
  };
  const session = new DataSession(initial);
  let artifact = createArtifact('data', 'Saved Data', initial),
    readOnly = false;
  const changed = () => {
    artifact = updateDraft(artifact, session.content);
  };
  const execute = (cmd: EditorCommand<StructuredData>) => {
    session.execute(cmd);
    changed();
  };
  execute(setCells([{ rowId: 'r', columnId: 'name', value: 'Research' }]));
  execute(updateColumn('name', { readOnly: true }));
  artifact = await commitVersion(artifact, 'host', 'Protected saved record');
  const version = clone(artifact.versions[0]);
  execute(deleteRows(['r']));
  return {
    session,
    version,
    execute,
    changed,
    read: () => ({ artifact, revision: canonicalJson(session.revision), readOnly }),
    setAccess: (value: boolean) => {
      readOnly = value;
    },
    replace: (value: Artifact<StructuredData>) => {
      artifact = value;
    },
  };
}
it('restores verified protected rows as one canonical Undo/Redo edit and never changes saved versions or hashes', async () => {
  const h = await history(),
    deleted = h.session.content,
    versions = clone(h.read().artifact.versions);
  const cmd = await restoreDataVersion(h.version.versionId, h.read);
  h.execute(guardDataCommand(cmd));
  expect(h.session.content).toEqual(h.version.content);
  expect(h.session.content.rows[0].values.name).toBe('Research');
  expect(h.session.undo()).toEqual(deleted);
  h.changed();
  expect(h.session.redo()).toEqual(h.version.content);
  h.changed();
  expect(h.read().artifact.versions).toEqual(versions);
  expect(await contentHash(versions[0].content)).toBe(versions[0].contentHash);
});
it('normal insertions and forged restoration names or copied commands cannot grant saved-version privileges', async () => {
  const h = await history(),
    before = h.session.content,
    revision = h.session.revision;
  const verified = await restoreDataVersion(h.version.versionId, h.read);
  for (const cmd of [
    command<StructuredData>('host.restore', 'Forged restore', () => clone(h.version.content)),
    { ...verified },
    insertRows([{ id: 'forged', values: { name: 'Research' } }]),
    insertRows([{ id: 'forged', values: { name: 'New record', computed: 99 } }]),
  ])
    expect(() => h.execute(cmd)).toThrow(/read-only|formula/);
  expect(h.session.content).toEqual(before);
  expect(h.session.revision).toEqual(revision);
});
it.each(['missing', 'duplicate', 'foreign', 'hash', 'kind'] as const)(
  'refuses an unverified saved-version lookup (%s) without changing the session',
  async (failure) => {
    const h = await history(),
      artifact = clone(h.read().artifact),
      before = h.session.content,
      revision = h.session.revision;
    if (failure === 'duplicate') artifact.versions.push(clone(artifact.versions[0]));
    if (failure === 'foreign') artifact.versions[0].artifactId = 'another-artifact';
    if (failure === 'hash') artifact.versions[0].contentHash = 'wrong';
    if (failure === 'kind') artifact.kind = 'structured-graph';
    h.replace(artifact);
    await expect(
      restoreDataVersion(failure === 'missing' ? 'missing-version' : h.version.versionId, h.read),
    ).rejects.toThrow();
    expect(h.session.content).toEqual(before);
    expect(h.session.revision).toEqual(revision);
  },
);
it('rechecks permission, artifact/version bytes and revision even after edit then Undo returns the same content', async () => {
  const h = await history(),
    before = h.session.content,
    snapshot = clone(h.read().artifact);
  const cmd = await restoreDataVersion(h.version.versionId, h.read);
  h.setAccess(true);
  expect(() => h.execute(cmd)).toThrow('read only');
  h.setAccess(false);
  const tampered = clone(snapshot);
  tampered.versions[0].content.rows[0].values.name = 'Tampered';
  h.replace(tampered);
  expect(() => h.execute(cmd)).toThrow('stale');
  h.replace(snapshot);
  h.execute(insertRows([{ id: 'temporary', values: { name: 'New record' } }]));
  h.session.undo();
  h.changed();
  expect(h.session.content).toEqual(before);
  expect(() => h.execute(cmd)).toThrow('stale');
  expect(h.session.canRedo).toBe(true);
});
it('rechecks access after asynchronous hash verification before granting any restoration command', async () => {
  const h = await history(),
    revision = h.session.revision;
  const pending = restoreDataVersion(h.version.versionId, h.read);
  h.setAccess(true);
  await expect(pending).rejects.toThrow('read only');
  expect(h.session.revision).toEqual(revision);
});
