import { describe, expect, it } from 'vitest';
import {
  contentHash,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ArtifactEditor, type EditorHostAdapter, type HostSaveContext } from './index';

type Content = { text: string };
const adapter: EditorHostAdapter<Content> = {
  kind: 'example',
  validate: (value): value is Content =>
    !!value && typeof value === 'object' && 'text' in value && typeof value.text === 'string',
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
const edit = (text: string) => command<Content>('edit', 'Edit', () => ({ text }));
const propose = (host: ArtifactEditor<Content>, id: string) => {
  host.propose({ id, summary: id, commands: [edit(id)] });
  host.acceptProposal(id);
};

describe('Host storage save context', () => {
  it('captures flushed content and ancestry before IO, while later Undo stays unsaved', async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let saved: Artifact<Content> | undefined, context: HostSaveContext | undefined;
    const host = new ArtifactEditor(
      createArtifact('example', 'Example', { text: 'initial' }),
      adapter,
      {
        async put(value, captured) {
          saved = value;
          context = captured;
          release();
          await held;
        },
      },
    );
    propose(host, 'proposal');
    const transactions = [...host.proposalTransactions];
    let buffered = true;
    host.registerInputBoundary(() => {
      if (buffered) {
        buffered = false;
        host.execute(edit('flushed human edit'));
      }
    });
    let eventContext: HostSaveContext | undefined;
    host.onSaved((event) => {
      eventContext = event.saveContext;
      throw Error('consumer notification record failed');
    });
    const saving = host.save({ commitVersion: true });
    await entered;
    expect(saved!.draft.content.text).toBe('flushed human edit');
    expect(context).toMatchObject({
      schemaVersion: 1,
      artifactId: host.id,
      kind: 'example',
      baseVersionId: null,
      versionId: saved!.versions[0].versionId,
      committed: true,
      contentHash: await contentHash(saved!.draft.content),
      proposalTransactions: transactions,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context!.revision)).toBe(true);
    expect(Object.isFrozen(context!.proposalTransactions)).toBe(true);
    expect(() => {
      (context!.proposalTransactions as string[]).push('forged');
    }).toThrow();
    host.undo();
    host.undo();
    expect(host.proposalTransactions).toEqual([]);
    finish();
    const result = await saving;
    expect(result.dirty).toBe(true);
    expect(result.saveContext).toBe(context);
    expect(eventContext).toBe(context);
    expect(context!.proposalTransactions).toEqual(transactions);
  });

  it('reuses context identity after a lost response, including when later edits need a second save', async () => {
    const store = new MemoryStorage<Artifact<Content>>();
    const contexts: HostSaveContext[] = [],
      operationIds = new WeakMap<HostSaveContext, string>();
    let lose = true;
    const host = new ArtifactEditor(
      createArtifact('example', 'Example', { text: 'initial' }),
      adapter,
      {
        async put(value, context) {
          expect(context).toBeDefined();
          contexts.push(context!);
          if (!operationIds.has(context!))
            operationIds.set(context!, `operation-${contexts.length}`);
          await store.put(value);
          if (lose) {
            lose = false;
            throw Error('reply lost after storage');
          }
        },
      },
    );
    let notifications = 0;
    host.onSaved(() => {
      notifications++;
    });
    propose(host, 'first');
    await expect(host.save({ commitVersion: true })).rejects.toMatchObject({ code: 'save-failed' });
    expect(notifications).toBe(0);
    const first = contexts[0],
      persisted = (await store.get(host.id))!;
    expect(first.contentHash).toBe(persisted.versions[0].contentHash);
    expect(first.proposalTransactions).toHaveLength(1);
    host.undo();
    host.execute(edit('later human branch'));
    await host.save({ commitVersion: true });
    expect(contexts).toHaveLength(3);
    expect(contexts[1]).toBe(first);
    expect(operationIds.get(contexts[1])).toBe('operation-1');
    expect(contexts[2]).not.toBe(first);
    expect(contexts[2].proposalTransactions).toEqual([]);
    expect(contexts[2].baseVersionId).toBe(first.versionId);
    expect((await store.get(host.id))!.versions).toHaveLength(2);
    expect(notifications).toBe(2);
  });

  it('distinguishes draft-only writes and a new unchanged-content save from the same retry', async () => {
    const contexts: HostSaveContext[] = [];
    const host = new ArtifactEditor(
      createArtifact('example', 'Example', { text: 'initial' }),
      adapter,
      {
        async put(_value, context) {
          contexts.push(context!);
        },
      },
    );
    await host.save();
    await host.save();
    expect(contexts[0]).toMatchObject({
      committed: false,
      versionId: null,
      baseVersionId: null,
      proposalTransactions: [],
    });
    expect(contexts[0].contentHash).toBe(await contentHash({ text: 'initial' }));
    expect(contexts[1]).not.toBe(contexts[0]);
    expect(contexts[1]).toEqual(contexts[0]);
    expect(host.artifact.versions).toEqual([]);
    const fixed = await host.save({ commitVersion: true });
    host.execute(edit('new draft'));
    const draft = await host.save();
    expect(draft.saveContext).toMatchObject({
      committed: false,
      versionId: fixed.saveContext.versionId,
      baseVersionId: fixed.saveContext.versionId,
    });
    expect(draft.saveContext.contentHash).not.toBe(fixed.saveContext.contentHash);
    expect(host.artifact.versions).toHaveLength(1);
  });

  it('does not call storage with evidence after permission is revoked during preflight', async () => {
    let mayEdit = true,
      calls = 0;
    const host = new ArtifactEditor(
      createArtifact('example', 'Example', { text: 'initial' }),
      {
        ...adapter,
        preflight: async () => {
          mayEdit = false;
        },
      },
      {
        async put() {
          calls++;
        },
      },
      () => mayEdit,
    );
    await expect(host.save({ commitVersion: true })).rejects.toMatchObject({ code: 'read-only' });
    expect(calls).toBe(0);
  });
});
