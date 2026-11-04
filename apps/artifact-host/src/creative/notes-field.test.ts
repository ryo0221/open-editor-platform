import { describe, expect, it } from 'vitest';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { characterMode } from './character-mode';
import { defaultCharacterColumns } from './character-source';
import { NotesFieldDraft } from './notes-field';
import { CreativeProject } from './project';
import { settingMode } from './setting-mode';

async function fixture() {
  let mapping: unknown;
  const access = { writable: true };
  const project = await CreativeProject.open(
    characterMode,
    {
      artifacts: new MemoryStorage<Artifact<unknown>>(),
      readMapping: async () => clone(mapping),
      async writeMapping(value) {
        mapping = clone(value);
      },
    },
    () => access.writable,
  );
  const card = project.cards[0];
  const editor = await project.ensureDesign(card);
  const field = card.fields.find((candidate) => candidate.id === defaultCharacterColumns.name)!;
  const draft = new NotesFieldDraft(field.value);
  draft.begin(field.value, field.value);
  const external = (fieldId: string, value: string) =>
    project.source.execute(
      characterMode.edit(project.source.content, project.cards[0], fieldId, value),
    );
  const commit = (value: string) => draft.commit(project, card, field.id, value);
  return { project, card, editor, draft, access, external, commit };
}

describe('Creative notes input base', () => {
  it('returns the stored normalized location name so its input can finish the same commit', async () => {
    let mapping: unknown;
    const project = await CreativeProject.open(settingMode, {
      artifacts: new MemoryStorage<Artifact<unknown>>(),
      readMapping: async () => clone(mapping),
      writeMapping: async (value) => {
        mapping = clone(value);
      },
    });
    const card = project.cards[0];
    const field = card.fields.find((field) => field.id === 'name')!;
    const draft = new NotesFieldDraft(field.value);
    expect(draft.commit(project, card, field.id, '  港を望む家  ')).toBe('港を望む家');
    expect(project.cards[0].name).toBe('港を望む家');
    expect(draft.commit(project, card, field.id, '  港を望む家 別名  ')).toBe('港を望む家 別名');
  });

  it('refuses a same-field source update during input and keeps the rejected draft base on refocus', async () => {
    const { project, card, editor, draft, external, commit } = await fixture();
    const design = editor.content;
    external(defaultCharacterColumns.name, '外部から更新した名前');
    const source = project.source.content;
    const revision = project.source.revision;
    expect(() => commit('手元の入力')).toThrow(/入力中に正本の同じ項目/);
    expect(project.source.content).toEqual(source);
    expect(project.source.revision).toEqual(revision);
    expect(editor.content).toEqual(design);
    // Error-driven focus and a later retry must retain the original observed field value.
    draft.begin(project.cards[0].name, '手元の入力');
    expect(() => commit('手元の入力')).toThrow(/入力中に正本の同じ項目/);
    project.source.undo();
    expect(project.cards[0].name).toBe(card.name);
    expect(project.source.canUndo).toBe(false);
  });

  it('preserves unrelated source changes when committing against the same observed field value', async () => {
    const { project, editor, external, commit } = await fixture();
    const design = editor.content;
    external(defaultCharacterColumns.description, '別の場所から更新した説明。');
    commit('手元の名前');
    expect(project.cards[0]).toMatchObject({
      name: '手元の名前',
      summary: '別の場所から更新した説明。',
    });
    expect(editor.content).toEqual(design);
    project.source.undo();
    expect(project.cards[0]).toMatchObject({ name: '美緒', summary: '別の場所から更新した説明。' });
    project.source.redo();
    expect(project.cards[0].name).toBe('手元の名前');
  });

  it('advances the base after each successful native commit and allows an explicit fresh editing session', async () => {
    const { project, draft, external, commit } = await fixture();
    commit('澪');
    commit('澪の新しい名前');
    expect(project.cards[0].name).toBe('澪の新しい名前');
    project.source.undo();
    expect(project.cards[0].name).toBe('澪');
    project.source.redo();
    external(defaultCharacterColumns.name, '新しい正本の名前');
    expect(() => commit('古い入力')).toThrow(/入力中に正本/);
    // Escape/reload has replaced the displayed private draft with the latest source.
    draft.begin('新しい正本の名前', '新しい正本の名前');
    commit('確認後の名前');
    expect(project.cards[0].name).toBe('確認後の名前');
  });

  it('rechecks source permission without changing the captured base or adding history', async () => {
    const { project, access, commit } = await fixture();
    const before = project.source.content;
    access.writable = false;
    expect(() => commit('権限なしの入力')).toThrow(/read-only/i);
    expect(project.source.content).toEqual(before);
    expect(project.source.canUndo).toBe(false);
    access.writable = true;
    commit('再試行した名前');
    expect(project.cards[0].name).toBe('再試行した名前');
    project.source.undo();
    expect(project.source.content).toEqual(before);
  });
});
