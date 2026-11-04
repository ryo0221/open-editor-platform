import { describe, expect, it, vi } from 'vitest';
import {
  createArtifact,
  MemoryStorage,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  command,
  type ProposalDiffAdapter,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  changedElementsFromDiff,
  EditorHostError,
  loadHostArtifact,
  type EditorHostAdapter,
  type HostProposalResult,
  type HostSavedEvent,
} from './index';

type Content = { schemaVersion: 1; text: string };
const valid = (v: unknown): v is Content =>
  !!v &&
  typeof v === 'object' &&
  'schemaVersion' in v &&
  v.schemaVersion === 1 &&
  'text' in v &&
  typeof v.text === 'string';
const adapter: EditorHostAdapter<Content> = {
  kind: 'example',
  validate: valid,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
  text: {
    read: (c) => ({
      text: c.text,
      segments: [{ id: 'text', blockId: 'text', start: 0, end: c.text.length }],
    }),
  },
};
const artifact = () =>
  createArtifact('example', 'Example', { schemaVersion: 1 as const, text: 'initial' });
const edit = (text: string) => command<Content>('edit', 'Edit text', (c) => ({ ...c, text }));
const proposal = (id: string, text: string): ProposedCommands<Content> => ({
  id,
  summary: 'Replace text',
  source: 'external-tool',
  commands: [edit(text)],
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorHostError) return error.code;
    throw error;
  }
  return 'ok';
};
function observe(host: ArtifactEditor<Content>) {
  const saved: HostSavedEvent[] = [],
    resolved: HostProposalResult[] = [];
  const release = [
    host.onSaved((e) => saved.push(e)),
    host.onProposalResolved((e) => resolved.push(e)),
  ];
  return { saved, resolved, release: () => release.forEach((r) => r()) };
}

describe('Host API: saved notification, saved read and proposal review', () => {
  it('goes edit → saved event → saved read → proposal → preview → accept → save → reload', async () => {
    const storage = new MemoryStorage<Artifact<Content>>(),
      host = new ArtifactEditor(artifact(), adapter, storage);
    const seen = observe(host);
    host.execute(edit('draft one'));
    const result = await host.save({ commitVersion: true, author: 'person' });
    expect(seen.saved).toHaveLength(1);
    const event = seen.saved[0];
    expect(event).toMatchObject({
      artifactId: host.id,
      kind: 'example',
      committed: true,
      dirty: false,
      versionId: result.artifact.versions[0].versionId,
    });
    expect(event.revision).toEqual(result.revision);
    // The saved read is persisted content, the same version the event names.
    const read = host.readSaved(event.versionId!);
    expect(read).toMatchObject({ source: 'version', content: { text: 'draft one' } });
    expect(read.contentHash).toBe(result.artifact.versions[0].contentHash);
    expect(host.readSaved()).toMatchObject({ source: 'saved-draft', versionId: event.versionId });
    expect(host.readText('saved').text).toBe('draft one');

    const review = host.propose({
      ...proposal('p1', 'from tool'),
      baseLocalRevision: event.revision,
    });
    expect(review.stale).toBe(false);
    expect(review.preview.baseContent.text).toBe('draft one');
    expect(review.preview.content.text).toBe('from tool');
    expect(host.content.text).toBe('draft one');
    expect(host.proposals.map((p) => p.id)).toEqual(['p1']);

    const accepted = host.acceptProposal('p1');
    expect(accepted).toMatchObject({ proposalId: 'p1', outcome: 'accepted', dirty: true });
    expect(seen.resolved).toEqual([accepted]);
    expect(host.content.text).toBe('from tool');
    expect(host.proposals).toEqual([]);
    // One Undo unit, and still unsaved until the Host saves it.
    host.undo();
    expect(host.content.text).toBe('draft one');
    host.redo();
    expect(host.snapshot.dirty).toBe(true);
    await host.save({ commitVersion: true });
    expect(seen.saved.at(-1)).toMatchObject({ committed: true, dirty: false });
    const reloaded = await loadHostArtifact(
      serializeArtifact((await storage.get(host.id))!),
      adapter,
    );
    expect(reloaded.draft.content.text).toBe('from tool');
    expect(reloaded.versions).toHaveLength(2);
  });

  it('sends no event for a failed save and never lets a late save overwrite newer edits', async () => {
    let fail = true,
      finish = () => {},
      entered = () => {};
    const putStarted = new Promise<void>((resolve) => (entered = resolve));
    const store = new MemoryStorage<Artifact<Content>>();
    const host = new ArtifactEditor(artifact(), adapter, {
      async put(value) {
        if (fail) throw new Error('offline');
        const done = new Promise<void>((resolve) => (finish = resolve));
        entered();
        await done;
        await store.put(value);
      },
    });
    const seen = observe(host);
    host.execute(edit('first'));
    await expect(host.save()).rejects.toMatchObject({ code: 'save-failed' });
    expect(seen.saved).toEqual([]);
    expect(host.readSaved().content.text).toBe('initial');
    fail = false;
    const pending = host.save({ commitVersion: true });
    const captured = host.revision;
    host.execute(edit('second'));
    await putStarted;
    finish();
    await pending;
    expect(host.content.text).toBe('second');
    expect(seen.saved).toHaveLength(1);
    expect(seen.saved[0].revision).toEqual(captured);
    expect(seen.saved[0].currentRevision).toEqual(host.revision);
    expect(seen.saved[0].dirty).toBe(true);
    expect(host.readSaved().content.text).toBe('first');
  });

  it('names the elements an accepted proposal changed when the adapter reads them', () => {
    const diff = (throws = false): ProposalDiffAdapter<Content> => ({
      domain: 'example',
      has: () => true,
      diff: (before, after) => {
        if (throws) throw new Error('diff failed');
        const change = (elementId: string) => ({
          domain: 'example',
          kind: 'text' as const,
          elementId,
          property: 'text',
        });
        return {
          // An artifact-level setting ('') is not an element; a repeated ID is listed once.
          changes: before.text === after.text ? [] : [change('text'), change(''), change('text')],
          view: [change('view')],
          fallback: [],
        };
      },
    });
    const host = new ArtifactEditor(
      artifact(),
      { ...adapter, changedElements: changedElementsFromDiff(diff()) },
      new MemoryStorage(),
    );
    const seen = observe(host);
    host.propose(proposal('changed', 'from tool'));
    const accepted = host.acceptProposal('changed');
    expect(accepted.changedElementIds).toEqual(['text']);
    expect(seen.resolved).toEqual([accepted]);
    host.propose(proposal('rejected', 'other'));
    expect(host.rejectProposal('rejected').changedElementIds).toBeUndefined();
    // Without a reader the result has no IDs; a failing reader keeps the proposal for review.
    const plain = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    plain.propose(proposal('p', 'x'));
    expect(plain.acceptProposal('p').changedElementIds).toBeUndefined();
    const broken = new ArtifactEditor(
      artifact(),
      { ...adapter, changedElements: changedElementsFromDiff(diff(true)) },
      new MemoryStorage(),
    );
    broken.propose(proposal('p', 'x'));
    expect(code(() => broken.acceptProposal('p'))).toBe('proposal-invalid');
    expect(broken.content.text).toBe('initial');
    expect(broken.proposals.map((p) => p.id)).toEqual(['p']);
  });

  it('rejects without changing content or history, and refuses stale proposals', () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    const seen = observe(host);
    host.propose(proposal('reject', 'no'));
    const before = host.snapshot;
    expect(host.rejectProposal('reject').outcome).toBe('rejected');
    expect(host.snapshot).toEqual(before);
    expect(host.canUndo).toBe(false);

    host.propose(proposal('late', 'tool text'));
    host.execute(edit('person typed'));
    expect(host.proposals[0].stale).toBe(true);
    expect(code(() => host.acceptProposal('late'))).toBe('proposal-stale');
    expect(host.content.text).toBe('person typed');
    expect(seen.resolved.map((r) => r.outcome)).toEqual(['rejected', 'stale']);
    expect(code(() => host.acceptProposal('late'))).toBe('proposal-missing');
    // A proposal prepared against an older revision is refused at registration.
    expect(
      code(() => host.propose({ ...proposal('old', 'x'), baseLocalRevision: before.revision })),
    ).toBe('proposal-stale');
    // Commands that throw or produce invalid native content never register.
    const bad = command<Content>('bad', 'Bad', () => ({ schemaVersion: 2 }) as unknown as Content);
    expect(code(() => host.propose({ id: 'bad', summary: 'Bad', commands: [bad] }))).toBe(
      'proposal-invalid',
    );
    expect(code(() => host.propose({ id: 'none', summary: 'None', commands: [] }))).toBe(
      'proposal-invalid',
    );
    expect(host.proposals).toEqual([]);
  });

  it('accepts only the reviewed commands and content', () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    const submitted = proposal('owned', 'reviewed');
    const review = host.propose(submitted);
    // Replacing the caller's commands after review cannot change what is accepted.
    submitted.commands[0] = edit('swapped');
    submitted.commands.push(edit('appended'));
    expect(() => {
      (review.preview.proposal.commands as unknown[]).push(edit('pushed'));
    }).toThrow();
    host.acceptProposal('owned');
    expect(host.content.text).toBe('reviewed');
    // A command whose result differs from its preview is refused and stays pending.
    let calls = 0;
    const drifting = command<Content>('drift', 'Drift', (c) => ({ ...c, text: 'run ' + ++calls }));
    host.propose({ id: 'drift', summary: 'Drift', commands: [drifting] });
    expect(code(() => host.acceptProposal('drift'))).toBe('proposal-invalid');
    expect(host.content.text).toBe('reviewed');
    expect(host.proposals.map((p) => p.id)).toEqual(['drift']);
  });

  it('keeps read-only, lost permission and pending input boundaries on the shared accept path', () => {
    let editable = true;
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage(), () => editable);
    host.propose(proposal('p', 'tool'));
    editable = false;
    expect(code(() => host.acceptProposal('p'))).toBe('read-only');
    expect(code(() => host.propose(proposal('q', 'x')))).toBe('read-only');
    expect(host.proposals.map((p) => p.id)).toEqual(['p']);
    editable = true;
    let composing = true;
    const unregister = host.registerInputBoundary(() => {
      if (composing) throw new EditorHostError('input-pending', host.id, 'Confirm input');
    });
    expect(code(() => host.acceptProposal('p'))).toBe('input-pending');
    expect(host.content.text).toBe('initial');
    expect(host.proposals.map((p) => p.id)).toEqual(['p']);
    composing = false;
    expect(host.acceptProposal('p').outcome).toBe('accepted');
    unregister();
  });

  it('declares unsupported capabilities with typed errors and releases listeners', async () => {
    const plain: EditorHostAdapter<Content> = {
      ...adapter,
      text: undefined,
      capabilities: { ...adapter.capabilities, proposals: undefined },
    };
    const host = new ArtifactEditor(artifact(), plain, new MemoryStorage());
    expect(code(() => host.propose(proposal('p', 'x')))).toBe('unsupported');
    expect(code(() => host.readText())).toBe('unsupported');
    expect(code(() => host.readSaved('missing'))).toBe('version-missing');

    const other = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    const seen = observe(other);
    let duplicate = 0;
    const extra = other.onSaved(() => duplicate++);
    extra();
    extra();
    other.execute(edit('a'));
    await other.save();
    expect(seen.saved).toHaveLength(1);
    expect(duplicate).toBe(0);
    seen.release();
    other.execute(edit('b'));
    await other.save();
    expect(seen.saved).toHaveLength(1);
    // Closing withdraws open proposals and ends every listener.
    const last = observe(other);
    other.propose(proposal('open', 'x'));
    other.close('discard');
    expect(last.resolved.map((r) => r.outcome)).toEqual(['withdrawn']);
    expect(code(() => other.onSaved(() => {}))).toBe('closed');
    expect(code(() => other.readSaved())).toBe('closed');
  });

  it('isolates observer failures and caller mutation of events', async () => {
    const errors: unknown[] = [];
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage(), undefined, (e) =>
      errors.push(e),
    );
    const seen: HostSavedEvent[] = [];
    host.onSaved((e) => {
      e.artifactId = 'mutated';
      throw new Error('observer');
    });
    host.onSaved((e) => seen.push(e));
    host.execute(edit('x'));
    await expect(host.save()).resolves.toMatchObject({ dirty: false });
    expect(errors).toHaveLength(1);
    expect(seen[0].artifactId).toBe(host.id);
  });
});

describe('Host saved-version witness and retry', () => {
  it('captures proposal ancestry with the saved revision, rather than edits made during IO', async () => {
    const store = new MemoryStorage<Artifact<Content>>();
    let release!: () => void,
      held = false;
    const storage = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      remove: store.remove.bind(store),
      put: async (a: Artifact<Content>) => {
        if (held)
          await new Promise<void>((r) => {
            release = r;
          });
        await store.put(a);
      },
    };
    const host = new ArtifactEditor(artifact(), adapter, storage),
      seen = observe(host);
    await host.save({ commitVersion: true });
    const base = host.artifact.draft.baseVersionId;
    let applied = '';
    host.propose(proposal('one', 'proposal'), {
      onApplied: (e) => {
        applied = e.transactionId;
      },
    });
    host.acceptProposal('one');
    held = true;
    const saving = host.save({ commitVersion: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    host.undo();
    host.execute(edit('new branch'));
    release();
    await saving;
    expect(seen.saved.at(-1)).toMatchObject({
      baseVersionId: base,
      proposalTransactions: [applied],
      dirty: true,
    });
    expect(host.readSaved().content.text).toBe('proposal');
    expect(host.content.text).toBe('new branch');
    expect(host.proposalTransactions).toEqual([]);
    held = false;
    await host.save({ commitVersion: true });
    expect(seen.saved.at(-1)!.proposalTransactions).toEqual([]);
  });
  for (const changed of [false, true])
    it(`reuses a lost immutable save without duplicate versions (later edit=${changed})`, async () => {
      const store = new MemoryStorage<Artifact<Content>>();
      let lose = true;
      const storage = {
        get: store.get.bind(store),
        list: store.list.bind(store),
        remove: store.remove.bind(store),
        put: async (a: Artifact<Content>) => {
          await store.put(a);
          if (lose) {
            lose = false;
            throw Error('lost response');
          }
        },
      };
      const host = new ArtifactEditor(artifact(), adapter, storage),
        seen = observe(host);
      // Unchanged content still needs protection if a new version's acknowledgement is lost.
      if (changed) host.execute(edit('saved candidate'));
      await expect(host.save({ commitVersion: true })).rejects.toMatchObject({
        code: 'save-failed',
      });
      expect(host.snapshot.dirty).toBe(true);
      expect(() => host.close('require-saved')).toThrow();
      const uncertain = (await store.get(host.id))!.versions[0];
      expect(seen.saved).toEqual([]);
      if (changed) host.execute(edit('later input'));
      await host.save({ commitVersion: true });
      const persisted = (await store.get(host.id))!;
      expect(persisted.versions).toHaveLength(changed ? 2 : 1);
      expect(persisted.versions[0]).toEqual(uncertain);
      expect(seen.saved[0].versionId).toBe(uncertain.versionId);
      expect(host.content.text).toBe(changed ? 'later input' : 'initial');
      expect(host.snapshot.dirty).toBe(false);
    });
});
