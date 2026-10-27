import { describe, expect, it } from 'vitest';
import {
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
