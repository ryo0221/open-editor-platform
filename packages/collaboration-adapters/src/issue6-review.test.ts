import { expect, it } from 'vitest';
import {
  Authority,
  initial,
  localAdapter,
  saveConfirmedVersion,
  type ConfirmedVersion,
  type Principal,
} from '@editor-platform/collaboration-core';
import { setCell, type StructuredData } from '@editor-platform/structured-data';
import { dataEditorCodec } from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';

const actor: Principal = {
  actorId: 'A',
  clientId: 'A',
  sessionId: 'A',
  writable: true,
  scopes: ['*'],
};
const data = (): StructuredData => ({
  schemaVersion: 2,
  columns: [{ id: 'value', name: '値', type: 'number' }],
  rows: [
    { id: 'first', values: { value: 0 } },
    { id: 'second', values: { value: 0 } },
  ],
});
async function fixture() {
  const authority = new Authority(dataEditorCodec, initial('review-6', dataEditorCodec, data()));
  const versions: ConfirmedVersion<StructuredData>[] = [];
  const adapter: EditorHostAdapter<StructuredData> = {
    ...localAdapter(authority, actor),
    versions: async () => versions,
    save: async (reason) => {
      const version = await saveConfirmedVersion(authority, actor.actorId, reason);
      versions.push(version);
      return version;
    },
    restore: async (id, revision) =>
      authority.restore(
        actor,
        versions.find((v) => v.version.versionId === id)!.version.content,
        revision,
      ),
    undo: async (id, redo) => authority.undo(actor, id, redo),
    registerProposal: async (p) => authority.register(p),
    previewProposal: async (id) => authority.preview(actor, id),
    applyProposal: async (id, token) => authority.applyProposal(actor, id, token),
    cancelProposal: async (id, reject) => {
      const proposal = authority.cancelProposal(id, reject);
      if (!proposal) throw new Error('Unknown proposal');
      return proposal;
    },
  };
  const session = new SharedEditorSession(dataEditorCodec, adapter);
  await session.open();
  return { authority, adapter, session };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function holdHistory(adapter: EditorHostAdapter<StructuredData>, when: 'before' | 'after') {
  const entered = gate(),
    held = gate(),
    original = adapter.undo;
  adapter.undo = async (id, redo) => {
    if (when === 'before') {
      entered.release();
      await held.promise;
    }
    const receipt = await original(id, redo);
    if (when === 'after') {
      entered.release();
      await held.promise;
    }
    return receipt;
  };
  return {
    entered: entered.promise,
    release: () => {
      adapter.undo = original;
      held.release();
    },
  };
}
const values = (s: SharedEditorSession<StructuredData>) =>
  s.content.rows.map((r) => r.values.value);

it.each(['before', 'after'] as const)(
  'R6-01: new edit during Undo held %s commit keeps its own Undo and replaces the redo branch',
  async (when) => {
    const { session, adapter } = await fixture();
    session.execute(setCell('first', 'value', 11));
    await session.flush();
    const held = holdHistory(adapter, when),
      undo = session.history('undo');
    await held.entered;
    session.execute(setCell('second', 'value', 22));
    await session.flush();
    held.release();
    await undo;
    expect(values(session)).toEqual([0, 22]);
    expect(session.canRedo).toBe(false);
    await session.history('undo');
    expect(values(session)).toEqual([0, 0]);
    await session.history('redo');
    expect(values(session)).toEqual([0, 22]);
    expect(session.canRedo).toBe(false);
    session.close();
  },
);

it.each(['before', 'after'] as const)(
  'R6-01: new edit during Redo held %s commit remains the next Undo target',
  async (when) => {
    const { session, adapter } = await fixture();
    session.execute(setCell('first', 'value', 11));
    await session.flush();
    await session.history('undo');
    const held = holdHistory(adapter, when),
      redo = session.history('redo');
    await held.entered;
    session.execute(setCell('second', 'value', 22));
    await session.flush();
    held.release();
    await redo;
    expect(values(session)).toEqual([11, 22]);
    expect(session.canRedo).toBe(false);
    await session.history('undo');
    expect(values(session)).toEqual([11, 0]);
    await session.history('undo');
    expect(values(session)).toEqual([0, 0]);
    session.close();
  },
);

it.each(['undo', 'redo'] as const)(
  'R6-01: checkpoint/resume keeps the new edit ahead of an acknowledged-late %s',
  async (direction) => {
    const { session, adapter, authority } = await fixture();
    session.execute(setCell('first', 'value', 11));
    await session.flush();
    if (direction === 'redo') await session.history('undo');
    const held = holdHistory(adapter, 'after'),
      history = session.history(direction);
    await held.entered;
    session.execute(setCell('second', 'value', 22));
    await session.flush();
    let checkpoint!: ReturnType<typeof session.checkpoint>;
    session.suspend((value) => {
      checkpoint = JSON.parse(session.serializeCheckpoint());
      expect(checkpoint).toEqual(JSON.parse(JSON.stringify(value)));
    });
    held.release();
    await history;
    const resumed = new SharedEditorSession(dataEditorCodec, {
      ...adapter,
      ...localAdapter(authority, actor),
    });
    resumed.resume(checkpoint);
    await resumed.open();
    expect(resumed.canRedo).toBe(false);
    await resumed.history('undo');
    expect(values(resumed)).toEqual([direction === 'undo' ? 0 : 11, 0]);
    resumed.close();
  },
);

it('R6-02: an Undo sync failure rejects that call but reconnect restores save and restore', async () => {
  const { session, adapter } = await fixture();
  session.execute(setCell('first', 'value', 11));
  await session.flush();
  const changes = adapter.changes;
  adapter.changes = async () => {
    throw new Error('One failed synchronization');
  };
  await expect(session.history('undo')).rejects.toThrow('One failed synchronization');
  adapter.changes = changes;
  await session.reconnect();
  await session.sync();
  expect(session.pendingCount).toBe(0);
  expect(values(session)).toEqual([0, 0]);
  const saved = await session.save('Recovered after Undo');
  expect(saved.version.content).toEqual(data());
  session.execute(setCell('second', 'value', 22));
  await session.flush();
  await session.restore(saved.version.versionId);
  expect(values(session)).toEqual([0, 0]);
  session.close();
});
