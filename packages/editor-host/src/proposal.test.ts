import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  createArtifact,
  MemoryStorage,
  serializeArtifact,
  type Artifact,
  type CurrentRead,
} from '@editor-platform/artifact-core';
import { command, type ProposedCommands } from '@editor-platform/editor-core';
import {
  applyHostProposal,
  ArtifactEditor,
  checkHostProposal,
  loadHostArtifact,
  previewHostProposal,
  type EditorHostAdapter,
  type HostProposalApplied,
} from './index';

type Plan = { schemaVersion: 1; lines: { id: string; text: string }[] };
const valid = (v: unknown): v is Plan =>
  !!v &&
  typeof v === 'object' &&
  (v as Plan).schemaVersion === 1 &&
  Array.isArray((v as Plan).lines) &&
  (v as Plan).lines.every((l) => typeof l?.id === 'string' && typeof l.text === 'string');
const adapter: EditorHostAdapter<Plan> = {
  kind: 'plan',
  validate: valid,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
const line = (id: string, text: string) => ({ id, text });
async function setup(mayEdit = () => true) {
  const saved = await commitVersion(
    createArtifact<Plan>('plan', '企画書', {
      schemaVersion: 1,
      lines: [line('launch', '発売：11月10日'), line('build', '制作：8週'), line('note', '備考')],
    }),
    'fixture',
    'version',
  );
  const storage = new MemoryStorage<Artifact<Plan>>();
  await storage.put(saved);
  const editor = new ArtifactEditor(saved, adapter, storage, mayEdit);
  // The Host's references: Calendar and Data, each at an exact committed version.
  const refs = new Map<string, CurrentRead>([
    ['calendar', { status: 'available', versionId: 'cal-v1' }],
    ['data', { status: 'available', versionId: 'data-v1' }],
  ]);
  return { editor, storage, refs, read: (id: string) => refs.get(id) };
}
/** A partial change over several lines, generated from Calendar cal-v1 and Data data-v1. */
function proposal(editor: ArtifactEditor<Plan>): ProposedCommands<Plan> {
  const set = (id: string, text: string) =>
    command<Plan>('plan.line', 'Edit line', (c) => ({
      ...c,
      lines: c.lines.map((l) => (l.id === id ? { ...l, text } : l)),
    }));
  return {
    id: 'proposal-1',
    summary: '発売日に合わせて日程を直す',
    baseLocalRevision: editor.revision,
    reads: {
      target: { artifactId: editor.id, versionId: editor.artifact.draft.baseVersionId },
      references: [
        { artifactId: 'calendar', versionId: 'cal-v1' },
        { artifactId: 'data', versionId: 'data-v1' },
      ],
    },
    commands: [set('launch', '発売：12月1日'), set('build', '制作：11週')],
  };
}
const texts = (p: Plan) => p.lines.map((l) => l.text);

describe('native proposal final guard and exact apply observation', () => {
  async function observed(mayEdit = () => true, errors: unknown[] = []) {
    const f = await setup();
    const editor = new ArtifactEditor(
      f.editor.artifact,
      {
        ...adapter,
        capabilities: { ...adapter.capabilities, proposals: true },
        changedElements: (before, after) =>
          after.lines.filter((l, i) => l.text !== before.lines[i]?.text).map((l) => l.id),
      },
      f.storage,
      mayEdit,
      (error) => {
        errors.push(error);
      },
    );
    return { editor, storage: f.storage };
  }
  it('guards normal accept and extracted commit commands without changing preview or history', async () => {
    const { editor } = await observed(),
      before = editor.content,
      revision = editor.revision;
    let allowed = false;
    const applied: HostProposalApplied<Plan>[] = [];
    const hooks = {
      beforeApply() {
        if (!allowed) throw Error('Host preflight required');
      },
      onApplied(event: HostProposalApplied<Plan>) {
        applied.push(event);
      },
    };
    const review = editor.propose(proposal(editor), hooks);
    expect(texts(review.preview.content)).toEqual(['発売：12月1日', '制作：11週', '備考']);
    expect(applied).toEqual([]);
    hooks.beforeApply = () => {};
    hooks.onApplied = () => {
      throw Error('replaced observer must not run');
    };
    expect(() => editor.acceptProposal(review.id)).toThrow('preflight required');
    expect(() => editor.execute(review.preview.proposal.commands[0])).toThrow('preflight required');
    expect(editor.content).toEqual(before);
    expect(editor.revision).toEqual(revision);
    expect(editor.canUndo).toBe(false);
    allowed = true;
    const outcome = editor.acceptProposal(review.id);
    expect(outcome.outcome).toBe('accepted');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      artifactId: editor.id,
      kind: 'plan',
      proposalId: review.id,
      beforeRevision: revision,
      revision: editor.revision,
      content: editor.content,
      changedElementIds: ['launch', 'build'],
    });
    expect(applied[0].transactionId).toMatch(/^transaction_/);
    expect(editor.snapshot.dirty).toBe(true);
    applied[0].content.lines[0].text = 'mutated callback data';
    expect(editor.content.lines[0].text).toBe('発売：12月1日');
    const accepted = editor.content;
    expect(() => editor.acceptProposal(review.id)).toThrow('Unknown proposal');
    expect(applied).toHaveLength(1);
    editor.undo();
    expect(editor.content).toEqual(before);
    editor.redo();
    expect(editor.content).toEqual(accepted);
    expect(applied).toHaveLength(1);
  });
  it('captures the actual accepted revision/content before a reentrant Surface edit', async () => {
    const { editor } = await observed(),
      before = editor.revision;
    const applied: HostProposalApplied<Plan>[] = [];
    let edited = false;
    editor.attach(() => {
      if (!edited && editor.revision.sequence === before.sequence + 1) {
        edited = true;
        editor.execute(
          command('after', 'Later local edit', (c) => ({
            ...c,
            lines: c.lines.map((l) => (l.id === 'note' ? { ...l, text: 'later edit' } : l)),
          })),
        );
      }
    });
    const review = editor.propose(proposal(editor), {
      onApplied: (event) => {
        applied.push(event);
      },
    });
    const result = editor.acceptProposal(review.id);
    expect(applied[0].revision.sequence).toBe(before.sequence + 1);
    expect(applied[0].content.lines[2].text).toBe('備考');
    expect(editor.content.lines[2].text).toBe('later edit');
    expect(result.revision.sequence).toBe(before.sequence + 2);
  });
  it('owns the reviewed preview when the caller retains a command result', async () => {
    const { editor } = await observed(),
      before = editor.content;
    let escaped: Plan | undefined;
    const review = editor.propose({
      ...proposal(editor),
      commands: [
        command('escaped', 'Edit launch', (content: Plan) => {
          escaped = {
            ...content,
            lines: content.lines.map((l) =>
              l.id === 'launch' ? { ...l, text: 'reviewed launch' } : l,
            ),
          };
          return escaped;
        }),
      ],
    });
    const reviewed = clone(review.preview.content);
    escaped!.lines[0].text = before.lines[0].text;
    escaped!.lines[2].text = 'unreviewed note';
    review.preview.baseContent.lines[1].text = 'mutated public base';
    review.preview.content.lines[1].text = 'mutated public preview';
    expect(editor.proposals[0].preview.baseContent).toEqual(before);
    expect(editor.proposals[0].preview.content).toEqual(reviewed);
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });
  it('reports the actual accepted elements despite a mutated escaped preview result', async () => {
    const { editor } = await observed(),
      before = editor.content,
      revision = editor.revision;
    let escaped: Plan | undefined;
    const receipts: HostProposalApplied<Plan>[] = [];
    const add = () =>
      editor.propose(
        {
          ...proposal(editor),
          commands: [
            command('escaped', 'Edit launch', (content: Plan) => {
              escaped = {
                ...content,
                lines: content.lines.map((l) =>
                  l.id === 'launch' ? { ...l, text: 'reviewed launch' } : l,
                ),
              };
              return escaped;
            }),
          ],
        },
        {
          onApplied: (event) => {
            receipts.push(event);
          },
        },
      );
    const review = add(),
      reviewed = canonicalJson(review.preview.content);
    escaped!.lines[0].text = before.lines[0].text;
    escaped!.lines[2].text = 'unreviewed note';
    const result = editor.acceptProposal(review.id);
    expect(canonicalJson(editor.content)).toBe(reviewed);
    expect(receipts).toHaveLength(1);
    expect(canonicalJson(receipts[0].content)).toBe(reviewed);
    expect(receipts[0]).toMatchObject({
      beforeRevision: revision,
      revision: editor.revision,
      changedElementIds: ['launch'],
    });
    expect(result.changedElementIds).toEqual(['launch']);
    // The final command result can escape too; it cannot change the commit/receipt.
    escaped!.lines[0].text = 'mutated after accept';
    expect(canonicalJson(editor.content)).toBe(reviewed);
    expect(canonicalJson(receipts[0].content)).toBe(reviewed);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(canonicalJson(editor.content)).toBe(reviewed);
    editor.rejectProposal(add().id);
    const stale = add();
    editor.execute(
      command('later', 'Later edit', (c) => ({ ...c, lines: [...c.lines, line('x', 'x')] })),
    );
    expect(() => editor.acceptProposal(stale.id)).toThrow('draft changed');
    expect(receipts).toHaveLength(1);
  });
  it('derives IDs from the validated commit using isolated diff inputs and an owned ID list', async () => {
    const f = await setup(),
      steps: string[] = [],
      ids = ['launch'],
      receipts: HostProposalApplied<Plan>[] = [];
    const editor = new ArtifactEditor(
      f.editor.artifact,
      {
        ...adapter,
        capabilities: { ...adapter.capabilities, proposals: true },
        validate(value): value is Plan {
          steps.push('validate');
          return valid(value);
        },
        changedElements(before, after) {
          steps.push('diff');
          expect(before).toEqual(f.editor.content);
          expect(after.lines[0].text).toBe('reviewed launch');
          // Even a diff adapter retaining/mutating its arguments cannot change the commit.
          before.lines[1].text = 'mutated diff base';
          after.lines[2].text = 'mutated diff result';
          return ids;
        },
      },
      f.storage,
    );
    const review = editor.propose(
      {
        ...proposal(editor),
        commands: [
          command('launch', 'Edit launch', (c: Plan) => {
            steps.push('apply');
            return {
              ...c,
              lines: c.lines.map((l) =>
                l.id === 'launch' ? { ...l, text: 'reviewed launch' } : l,
              ),
            };
          }),
        ],
      },
      {
        beforeApply() {
          steps.push('guard');
        },
        onApplied(event) {
          steps.push('applied');
          receipts.push(event);
          ids.push('unrelated');
        },
      },
    );
    editor.attach(() => {
      steps.push('surface');
    });
    const reviewed = clone(review.preview.content);
    steps.length = 0;
    const result = editor.acceptProposal(review.id);
    expect(steps.slice(0, 6)).toEqual(['guard', 'apply', 'validate', 'diff', 'applied', 'surface']);
    expect(editor.content).toEqual(reviewed);
    expect(receipts[0].content).toEqual(reviewed);
    expect(receipts[0].changedElementIds).toEqual(['launch']);
    expect(result.changedElementIds).toEqual(['launch']);
  });
  it('keeps the native draft and proposal when commit diff fails, then retries once', async () => {
    const f = await setup();
    let fail = true;
    const receipts: HostProposalApplied<Plan>[] = [];
    const editor = new ArtifactEditor(
      f.editor.artifact,
      {
        ...adapter,
        capabilities: { ...adapter.capabilities, proposals: true },
        changedElements() {
          if (fail) throw Error('diff unavailable');
          return ['launch', 'build'];
        },
      },
      f.storage,
    );
    const before = editor.content,
      revision = editor.revision;
    const review = editor.propose(proposal(editor), {
      onApplied: (event) => {
        receipts.push(event);
      },
    });
    expect(() => editor.acceptProposal(review.id)).toThrow('diff unavailable');
    expect(editor.content).toEqual(before);
    expect(editor.revision).toEqual(revision);
    expect(editor.canUndo).toBe(false);
    expect(editor.proposals[0].preview.content).toEqual(review.preview.content);
    expect(receipts).toEqual([]);
    fail = false;
    expect(editor.acceptProposal(review.id).outcome).toBe('accepted');
    expect(receipts).toHaveLength(1);
    expect(editor.revision.sequence).toBe(revision.sequence + 1);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });
  for (const change of ['permission', 'draft'] as const)
    it(`refuses a commit when the diff reader changes the ${change}`, async () => {
      const f = await setup();
      let writable = true;
      const receipts: HostProposalApplied<Plan>[] = [];
      const editor: ArtifactEditor<Plan> = new ArtifactEditor(
        f.editor.artifact,
        {
          ...adapter,
          capabilities: { ...adapter.capabilities, proposals: true },
          changedElements() {
            if (change === 'permission') writable = false;
            else
              editor.execute(
                command('local', 'Keep local edit', (c) => ({
                  ...c,
                  lines: [...c.lines, line('local', 'keep me')],
                })),
              );
            return ['launch', 'build'];
          },
        },
        f.storage,
        () => writable,
      );
      const before = editor.content,
        revision = editor.revision;
      const review = editor.propose(proposal(editor), {
        onApplied: (event) => {
          receipts.push(event);
        },
      });
      expect(() => editor.acceptProposal(review.id)).toThrow(
        change === 'permission' ? 'read-only' : 'draft changed during',
      );
      expect(receipts).toEqual([]);
      if (change === 'permission') {
        expect(editor.content).toEqual(before);
        expect(editor.revision).toEqual(revision);
        expect(editor.canUndo).toBe(false);
      } else {
        expect(editor.content).toEqual({
          ...before,
          lines: [...before.lines, line('local', 'keep me')],
        });
        editor.undo();
        expect(editor.content).toEqual(before);
        expect(editor.canUndo).toBe(false);
      }
    });
  it('does not overwrite a local edit made during the final assertion', async () => {
    const { editor } = await observed(),
      before = editor.content;
    const review = editor.propose(proposal(editor), {
      beforeApply() {
        editor.execute(
          command('local', 'Local edit', (c) => ({
            ...c,
            lines: [...c.lines, line('local', 'keep me')],
          })),
        );
      },
    });
    expect(() => editor.acceptProposal(review.id)).toThrow('draft changed during');
    expect(editor.content).toEqual({
      ...before,
      lines: [...before.lines, line('local', 'keep me')],
    });
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });
  it('rechecks native permission after the final assertion', async () => {
    let writable = true;
    const { editor } = await observed(() => writable),
      before = editor.content;
    const review = editor.propose(proposal(editor), {
      beforeApply() {
        writable = false;
      },
    });
    expect(() => editor.acceptProposal(review.id)).toThrow('read-only');
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });
  it('refuses a later command guard atomically without an applied observation', async () => {
    const { editor } = await observed(),
      before = editor.content,
      revision = editor.revision;
    let calls = 0,
      receipts = 0;
    const review = editor.propose(proposal(editor), {
      beforeApply() {
        if (++calls === 2) throw Error('later command forbidden');
      },
      onApplied() {
        receipts++;
      },
    });
    expect(() => editor.acceptProposal(review.id)).toThrow('later command forbidden');
    expect(editor.content).toEqual(before);
    expect(editor.revision).toEqual(revision);
    expect(editor.canUndo).toBe(false);
    expect(receipts).toBe(0);
  });
  for (const returns of [
    () => false,
    () => Promise.resolve(),
    () => Promise.reject(Error('async assertion')),
  ])
    it('refuses non-void/async apply assertions without awaiting or committing', async () => {
      const { editor } = await observed(),
        before = editor.content;
      const review = editor.propose(proposal(editor), { beforeApply: returns });
      expect(() => editor.acceptProposal(review.id)).toThrow('synchronous and return void');
      expect(editor.content).toEqual(before);
      expect(editor.canUndo).toBe(false);
    });
  it('keeps accepted native work when sync or async observation fails', async () => {
    const errors: unknown[] = [];
    const { editor } = await observed(() => true, errors);
    for (const callback of [
      () => {
        throw Error('record failed');
      },
      async () => {
        throw Error('async record failed');
      },
    ]) {
      const review = editor.propose(proposal(editor), { onApplied: callback });
      expect(editor.acceptProposal(review.id).outcome).toBe('accepted');
      expect(editor.content.lines[0].text).toBe('発売：12月1日');
      await Promise.resolve();
      await Promise.resolve();
      editor.undo();
    }
    expect(errors).toHaveLength(2);
  });
  it('emits no applied receipt for rejection, staleness, or saves after a pre-save Undo', async () => {
    const { editor } = await observed(),
      applied: HostProposalApplied<Plan>[] = [],
      saved: string[] = [];
    const add = () =>
      editor.propose(proposal(editor), {
        onApplied: (event) => {
          applied.push(event);
        },
      });
    editor.rejectProposal(add().id);
    expect(applied).toEqual([]);
    const stale = add();
    editor.execute(
      command('change', 'Change', (c) => ({ ...c, lines: [...c.lines, line('x', 'x')] })),
    );
    expect(() => editor.acceptProposal(stale.id)).toThrow('draft changed');
    expect(applied).toEqual([]);
    editor.undo();
    const review = add();
    editor.acceptProposal(review.id);
    const receipt = applied[0];
    editor.onSaved((event) => {
      if (
        event.committed &&
        event.revision.sequence === receipt.revision.sequence &&
        JSON.stringify(editor.readSaved(event.versionId!).content) ===
          JSON.stringify(receipt.content)
      )
        saved.push(event.versionId!);
    });
    editor.undo();
    await editor.save({ commitVersion: true });
    expect(saved).toEqual([]);
    expect(applied).toHaveLength(1);
  });
  it('removes the accepted proposal before notifying its apply observer', async () => {
    const { editor } = await observed(),
      outcomes: string[] = [];
    editor.onProposalResolved((result) => {
      outcomes.push(result.outcome);
    });
    const review = editor.propose(proposal(editor), {
      onApplied(event) {
        expect(editor.proposals).toEqual([]);
        expect(() => editor.acceptProposal(event.proposalId)).toThrow('Unknown proposal');
      },
    });
    editor.acceptProposal(review.id);
    expect(outcomes).toEqual(['accepted']);
  });
  it('keeps a new proposal registered reentrantly with the resolved ID', async () => {
    const { editor } = await observed();
    const review = editor.propose(proposal(editor), {
      onApplied() {
        editor.propose({ ...proposal(editor), summary: 'New review at the accepted revision' });
      },
    });
    editor.acceptProposal(review.id);
    expect(editor.proposals).toHaveLength(1);
    expect(editor.proposals[0]).toMatchObject({
      id: review.id,
      summary: 'New review at the accepted revision',
      stale: false,
      baseRevision: editor.revision,
    });
  });
});

describe('proposal freshness at the Host boundary', () => {
  it('refuses each kind of stale reference without changing content or versions', async () => {
    const changes: [string, CurrentRead, string][] = [
      ['calendar', { status: 'available', versionId: 'cal-v2' }, 'version-changed'],
      ['data', { status: 'available', versionId: 'data-v2' }, 'version-changed'],
      ['data', { status: 'missing' }, 'missing'],
      ['calendar', { status: 'forbidden' }, 'forbidden'],
    ];
    for (const [id, now, reason] of changes) {
      const { editor, refs, read } = await setup();
      const p = proposal(editor),
        before = serializeArtifact(editor.artifact),
        content = texts(editor.content);
      refs.set(id, now);
      const review = previewHostProposal(editor, p, read);
      expect(review.preview).toBeUndefined();
      expect(review.check.stale).toEqual([
        expect.objectContaining({ artifactId: id, role: 'reference', reason }),
      ]);
      expect(applyHostProposal(editor, p, read).fresh).toBe(false);
      expect(texts(editor.content)).toEqual(content);
      expect(editor.canUndo).toBe(false);
      expect(serializeArtifact(editor.artifact)).toBe(before);
    }
  });
  it('refuses at apply when a reference changes after the preview', async () => {
    const { editor, refs, read } = await setup();
    const p = proposal(editor);
    const review = previewHostProposal(editor, p, read);
    expect(review.check.fresh).toBe(true);
    expect(texts(review.preview!.content)).toEqual(['発売：12月1日', '制作：11週', '備考']);
    expect(texts(editor.content)).toEqual(['発売：11月10日', '制作：8週', '備考']);
    refs.set('calendar', { status: 'available', versionId: 'cal-v2' });
    const check = applyHostProposal(editor, p, read);
    expect(check.stale).toEqual([
      {
        artifactId: 'calendar',
        role: 'reference',
        expectedVersionId: 'cal-v1',
        reason: 'version-changed',
        currentVersionId: 'cal-v2',
      },
    ]);
    expect(texts(editor.content)).toEqual(['発売：11月10日', '制作：8週', '備考']);
    expect(editor.artifact.versions).toHaveLength(1);
  });
  it('reports a changed target draft, a new target version and a lost permission', async () => {
    let writable = true;
    const { editor, read } = await setup(() => writable);
    const p = proposal(editor);
    editor.execute(command('edit', 'Edit', (c) => ({ ...c, lines: [...c.lines, line('x', '')] })));
    expect(checkHostProposal(editor, p, read).stale).toEqual([
      expect.objectContaining({ role: 'target', reason: 'draft-changed' }),
    ]);
    await editor.save({ commitVersion: true });
    expect(checkHostProposal(editor, p, read).stale).toEqual([
      expect.objectContaining({ role: 'target', reason: 'version-changed' }),
    ]);
    const q = proposal(editor);
    writable = false;
    expect(checkHostProposal(editor, q, read).stale).toEqual([
      expect.objectContaining({ role: 'target', reason: 'forbidden' }),
    ]);
    expect(applyHostProposal(editor, q, read).fresh).toBe(false);
  });
  it('rejects a proposal recorded for another Artifact', async () => {
    const { editor, read } = await setup();
    const p = proposal(editor);
    expect(() =>
      checkHostProposal(
        editor,
        { ...p, reads: { ...p.reads!, target: { artifactId: 'other', versionId: null } } },
        read,
      ),
    ).toThrow('Proposal targets another artifact');
  });
  it('applies the whole fresh proposal as one Undo step, then saves and reloads it', async () => {
    const { editor, storage, read } = await setup();
    const p = proposal(editor);
    expect(previewHostProposal(editor, p, read).check.fresh).toBe(true);
    expect(applyHostProposal(editor, p, read)).toEqual({ fresh: true, stale: [] });
    expect(texts(editor.content)).toEqual(['発売：12月1日', '制作：11週', '備考']);
    await editor.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(
      serializeArtifact((await storage.get(editor.id))!),
      adapter,
    );
    expect(texts(reloaded.draft.content)).toEqual(['発売：12月1日', '制作：11週', '備考']);
    expect(reloaded.versions).toHaveLength(2);
    editor.undo();
    expect(texts(editor.content)).toEqual(['発売：11月10日', '制作：8週', '備考']);
  });
});
