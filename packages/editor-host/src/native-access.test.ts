import { describe, expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  prepareHostTextReplacement,
  readHostElement,
  readHostElementText,
  type EditorHostAdapter,
} from './index';

type Cards = { entries: Record<string, { caption: string; position: number }> };
const adapter: EditorHostAdapter<Cards> = {
  kind: 'opaque-card-fixture',
  validate: (v: unknown): v is Cards =>
    !!v &&
    typeof v === 'object' &&
    !!(v as Cards).entries &&
    Object.values((v as Cards).entries).every(
      (e) => typeof e.caption === 'string' && Number.isFinite(e.position),
    ),
  capabilities: {
    proposals: true,
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
  },
  native: {
    read: (c, id) => c.entries[id] ?? null,
    text: {
      read(c, id) {
        if (!c.entries[id]) throw Error('Unknown card');
        return c.entries[id].caption;
      },
      replace(_c, v) {
        return command('card.caption', 'Replace caption', (c) => ({
          ...c,
          entries: { ...c.entries, [v.selector]: { ...c.entries[v.selector], caption: v.after } },
        }));
      },
    },
  },
};
const content = (): Cards => ({
  entries: { first: { caption: 'before', position: 3 }, second: { caption: 'keep', position: 7 } },
});
const change = () => ({ selector: 'first', before: 'before', after: 'after' });

describe('Opaque native adapter contract', () => {
  it('supports projection, proposal, Undo/Redo and captured save ancestry without knowing the content model', async () => {
    const artifact = await commitVersion(
      createArtifact(adapter.kind, 'fixture', content()),
      'test',
      'base',
    );
    const storage = new MemoryStorage<Artifact<Cards>>();
    await storage.put(artifact);
    const editor = new ArtifactEditor(artifact, adapter, storage);
    expect(readHostElement(adapter, editor.content, 'first')).toEqual({
      caption: 'before',
      position: 3,
    });
    const input = change(),
      prepared = prepareHostTextReplacement(adapter, editor.content, input);
    input.after = 'mutated request';
    editor.propose({
      id: 'proposal',
      summary: 'caption',
      baseLocalRevision: editor.revision,
      commands: [prepared],
    });
    expect(readHostElementText(adapter, editor.content, 'first')).toBe('before');
    editor.acceptProposal('proposal');
    expect(readHostElementText(adapter, editor.content, 'first')).toBe('after');
    editor.undo();
    expect(readHostElementText(adapter, editor.content, 'first')).toBe('before');
    editor.redo();
    expect(readHostElementText(adapter, editor.content, 'first')).toBe('after');
    const saved = await editor.save({ commitVersion: true });
    expect(saved.saveContext.proposalTransactions).toHaveLength(1);
    const persisted = await storage.get(editor.id);
    expect(persisted!.draft.content.entries.second).toEqual({ caption: 'keep', position: 7 });
    expect(persisted!.versions.at(-1)!.content.entries.first.caption).toBe('after');
    editor.close('discard');
  });
  it('does not infer an absent capability from kind and does not return mutable source elements', () => {
    const c = content(),
      copy = readHostElement(adapter, c, 'first') as { caption: string };
    copy.caption = 'changed';
    expect(c.entries.first.caption).toBe('before');
    expect(readHostElement(adapter, c, 'absent')).toBeNull();
    const absent = { ...adapter, kind: 'document', native: undefined };
    expect(() => readHostElement(absent, c, 'first')).toThrow('unsupported');
    expect(() => prepareHostTextReplacement(absent, c, change())).toThrow('unsupported');
    expect(() =>
      prepareHostTextReplacement(
        { ...adapter, capabilities: { ...adapter.capabilities, proposals: false } },
        c,
        change(),
      ),
    ).toThrow('unsupported');
  });
  it('rejects stale target text and permission revocation without mutation or history', async () => {
    const c = content(),
      prepared = prepareHostTextReplacement(adapter, c, change());
    const changed = content();
    changed.entries.first.caption = 'new';
    expect(() => prepared.apply(changed)).toThrow('changed');
    expect(changed.entries.first.caption).toBe('new');
    let mayEdit = true;
    const editor = new ArtifactEditor(
      createArtifact(adapter.kind, 'fixture', c),
      adapter,
      new MemoryStorage<Artifact<Cards>>(),
      () => mayEdit,
    );
    editor.propose({
      id: 'p',
      summary: 'caption',
      commands: [prepared],
      baseLocalRevision: editor.revision,
    });
    mayEdit = false;
    expect(() => editor.acceptProposal('p')).toThrow();
    expect(editor.content).toEqual(c);
    expect(editor.canUndo).toBe(false);
    editor.close('discard');
  });
});
