import { describe, expect, it } from 'vitest';
import { clone, commitVersion, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  designInstanceElements,
  updateComponentPart,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  creativeDesignAddressKey,
  designCreativeProposalDiff,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { setCells } from '@editor-platform/structured-data/views';
import type { StructuredData } from '@editor-platform/structured-data/model';
import {
  characterSourceConfig,
  defaultCharacterColumns,
  guardCharacterSourceCommand,
} from './character-source';
import { characterComponentId, characterGroups, createCharacterDesign } from './character-preset';
import {
  candidateFrames,
  candidateInstance,
  CreativeProject,
  readCreativeMapping,
  type CreativeMapping,
  type CreativeStorage,
} from './project';
import type { CreativeMode } from './types';

const mode: CreativeMode<StructuredData> = {
  ...characterSourceConfig,
  design: createCharacterDesign,
  componentId: characterComponentId,
  groups: characterGroups,
};
const eyes: CreativeDesignAddress = { componentId: characterComponentId, elementId: 'eyes' };
const bangs: CreativeDesignAddress = {
  componentId: characterComponentId,
  instanceId: 'instance-candidate-1',
  elementId: 'hair-front',
};

function storageFixture() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  const state = {
    mapping: undefined as unknown,
    writable: true,
    failMapping: false,
    failArtifactId: '',
    mappingWrites: 0,
    artifactWrites: [] as string[],
  };
  const io: CreativeStorage = {
    artifacts: {
      list: () => artifacts.list(),
      get: (id) => artifacts.get(id),
      remove: (id) => artifacts.remove(id),
      async put(value) {
        state.artifactWrites.push(value.id);
        if (value.id === state.failArtifactId) throw Error('Injected artifact save failure');
        await artifacts.put(value);
      },
    },
    async readMapping() {
      return clone(state.mapping);
    },
    async writeMapping(value) {
      state.mappingWrites++;
      if (state.failMapping) throw Error('Injected mapping save failure');
      state.mapping = clone(value);
    },
  };
  return {
    artifacts,
    state,
    io,
    open: () => CreativeProject.open(mode, io, () => state.writable),
  };
}
async function linkedFixture() {
  const fixture = storageFixture();
  const project = await fixture.open();
  const card = project.cards[0];
  const editor = await project.ensureDesign(card);
  return { ...fixture, project, card, editor };
}
function part(content: DesignContent, id: string) {
  return content.components
    .find((component) => component.id === characterComponentId)!
    .elements!.find((element) => element.id === id)!;
}
function proposeEyes(project: CreativeProject<StructuredData>, fill = '#bf7048') {
  return project.propose(project.cards[0], [{ address: eyes, patch: { fill } }], [eyes]);
}

describe('CreativeProject native lifecycle', () => {
  it('reuses unchanged saved owners on repeated save and after reopen', async () => {
    const { project, editor, state, open } = await linkedFixture();
    await project.save();
    const source = project.source.artifact;
    const design = editor.artifact;
    const writes = state.artifactWrites.length;
    await project.save();
    await project.save();
    expect(project.source.artifact).toEqual(source);
    expect(editor.artifact).toEqual(design);
    expect(state.artifactWrites).toHaveLength(writes);
    const reopened = await open();
    await reopened.save();
    expect(reopened.source.artifact).toEqual(source);
    expect(reopened.editor(reopened.cards[0])!.artifact).toEqual(design);
    expect(state.artifactWrites).toHaveLength(writes);
  });

  it('saves only the changed Design, keeping source and other artwork versions exact', async () => {
    const { project, card, editor, state } = await linkedFixture();
    const other = await project.ensureDesign(project.cards[1]);
    await project.save();
    const source = project.source.artifact;
    const otherSaved = other.artifact;
    const retained = editor.artifact.versions;
    const writes = state.artifactWrites.length;
    project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#123456' }));
    await project.save();
    expect(project.source.artifact).toEqual(source);
    expect(other.artifact).toEqual(otherSaved);
    expect(state.artifactWrites.slice(writes)).toEqual([editor.id]);
    expect(editor.artifact.versions.slice(0, -1)).toEqual(retained);
    expect(project.binding(card)!.design.versionId).toBe(editor.artifact.draft.baseVersionId);
  });

  it('can explicitly request another immutable version without pruning the former one', async () => {
    const { project, editor } = await linkedFixture();
    await project.save();
    const source = project.source.artifact.versions;
    const design = editor.artifact.versions;
    await project.save({ reuseSavedVersions: false });
    expect(project.source.artifact.versions.slice(0, -1)).toEqual(source);
    expect(editor.artifact.versions.slice(0, -1)).toEqual(design);
  });

  it('opens source cards, links a Design, chooses a candidate and reloads exact saved references', async () => {
    const { project, card, editor, state, open } = await linkedFixture();
    expect(card).toMatchObject({ id: 'CH-01', elementId: 'character-row-CH-01', name: '美緒' });
    expect(project.source.content.rows.find((row) => row.id === card.elementId)).toBeDefined();
    expect(await project.ensureDesign(card)).toBe(editor);
    expect(project.designs.size).toBe(1);
    project.choose(card, 'candidate-2');
    expect(project.binding(card)?.chosenFrameId).toBe('candidate-2');
    expect(project.mappingDirty).toBe(true);
    await project.save();
    expect(project.mappingDirty).toBe(false);
    const mapping = project.mapping;
    expect(mapping.source.versionId).toBe(project.source.artifact.draft.baseVersionId);
    expect(mapping.bindings[0].design.versionId).toBe(editor.artifact.draft.baseVersionId);
    expect(state.mapping).toEqual(mapping);
    const reloaded = await open();
    expect(reloaded.cards).toEqual(project.cards);
    expect(reloaded.binding(reloaded.cards[0])?.chosenFrameId).toBe('candidate-2');
    expect(reloaded.editor(reloaded.cards[0])?.content).toEqual(editor.content);
    expect(reloaded.problem(reloaded.cards[0])).toBeUndefined();
    expect(reloaded.source.canUndo).toBe(false);
    expect(reloaded.editor(reloaded.cards[0])?.canUndo).toBe(false);
    // The manifest contains only IDs and exact-version references.
    expect(Object.keys(mapping).sort()).toEqual(['bindings', 'mode', 'schemaVersion', 'source']);
    expect(Object.keys(mapping.source).sort()).toEqual(['artifactId', 'versionId']);
    expect(Object.keys(mapping.bindings[0]).sort()).toEqual([
      'chosenFrameId',
      'design',
      'itemId',
      'sourceElementId',
    ]);
    expect(Object.keys(mapping.bindings[0].design).sort()).toEqual(['artifactId', 'versionId']);
    const exposed = project.mapping;
    exposed.bindings[0].chosenFrameId = 'tampered';
    expect(project.binding(card)?.chosenFrameId).toBe('candidate-2');
    expect(JSON.stringify(mapping)).not.toContain(card.summary);
    expect(JSON.stringify(mapping)).not.toContain('bounds');
  });

  it('adds a native candidate with all children in one Undo and keeps stable IDs on Redo', async () => {
    const { project, card, editor } = await linkedFixture();
    const before = clone(editor.content);
    const chosen = project.binding(card)!.chosenFrameId;
    const id = project.addCandidate(card, 'candidate-2', '冬の私服');
    const copied = clone(editor.content);
    const frame = candidateFrames(editor.content).find((candidate) => candidate.id === id)!;
    expect(candidateFrames(editor.content)).toHaveLength(4);
    expect(frame.name).toBe('冬の私服');
    expect(frame.bounds.x).toBeGreaterThan(
      Math.max(
        ...candidateFrames(before).map((candidate) => candidate.bounds.x + candidate.bounds.width),
      ),
    );
    expect(candidateInstance(editor.content, id, characterComponentId).overrides).toEqual(
      candidateInstance(before, 'candidate-2', characterComponentId).overrides,
    );
    expect(editor.content.components).toEqual(before.components);
    expect(project.binding(card)!.chosenFrameId).toBe(chosen);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.content).toEqual(copied);
    expect(candidateFrames(editor.content).some((candidate) => candidate.id === id)).toBe(true);
  });

  it('edits native source rows through card and source-view commands while preserving Design drafts', async () => {
    const { project, card, editor, open } = await linkedFixture();
    await project.save();
    const originalDesign = clone(editor.content);
    project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#aa6677' }));
    const draft = clone(editor.content);
    project.source.execute(
      mode.edit(project.source.content, card, defaultCharacterColumns.name, '澪'),
    );
    expect(project.cards[0].name).toBe('澪');
    project.source.execute(
      guardCharacterSourceCommand(
        setCells([
          {
            rowId: card.elementId,
            columnId: defaultCharacterColumns.description,
            value: '表の通常編集から更新した人物説明',
          },
        ]),
      ),
    );
    expect(project.cards[0].summary).toBe('表の通常編集から更新した人物説明');
    project.source.execute(mode.create(project.source.content, '旅人', '追加した人物'));
    expect(project.cards.at(-1)).toMatchObject({
      id: 'CH-03',
      name: '旅人',
      summary: '追加した人物',
    });
    expect(project.editor(project.cards[0])).toBe(editor);
    expect(editor.content).toEqual(draft);
    expect(editor.snapshot.dirty).toBe(true);
    expect(project.source.snapshot.dirty).toBe(true);
    // Saving the native draft keeps its exact base version and the independent Design draft.
    await project.source.save();
    const reloaded = await open();
    expect(reloaded.cards).toEqual(project.cards);
    expect(reloaded.editor(reloaded.cards[0])?.content).toEqual(originalDesign);
    expect(editor.content).toEqual(draft);
    await project.save();
    const saved = await open();
    expect(saved.editor(saved.cards[0])?.content).toEqual(draft);
  });
});

describe('CreativeProject proposal authority and native history', () => {
  it('previews and rejects without mutation, then applies one qualified shared change with Undo/Redo', async () => {
    const { project, card, editor } = await linkedFixture();
    const before = clone(editor.content);
    const review = proposeEyes(project);
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    expect(part(review.preview.content, 'eyes').fill).toBe('#bf7048');
    const diff = designCreativeProposalDiff.diff(
      review.preview.baseContent,
      review.preview.content,
    );
    expect(diff.fallback).toEqual([]);
    expect(diff.changes.map((change) => change.elementId)).toEqual([
      creativeDesignAddressKey(eyes),
    ]);
    expect(editor.rejectProposal(review.id).outcome).toBe('rejected');
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    const accepted = proposeEyes(project);
    expect(editor.acceptProposal(accepted.id)).toMatchObject({
      outcome: 'accepted',
      changedElementIds: [creativeDesignAddressKey(eyes)],
      dirty: true,
    });
    const after = clone(editor.content);
    for (const frame of candidateFrames(editor.content)) {
      const instance = candidateInstance(editor.content, frame.id, characterComponentId);
      expect(
        designInstanceElements(editor.content, instance).find((element) => element.id === 'eyes')
          ?.fill,
      ).toBe('#bf7048');
    }
    expect(project.source.snapshot.dirty).toBe(false);
    expect(project.editor(card)).toBe(editor);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.content).toEqual(after);
  });

  it('applies an instance-qualified proposal only to the addressed candidate', async () => {
    const { project, card, editor } = await linkedFixture();
    const before = clone(editor.content);
    const bounds = { ...part(before, 'hair-front').bounds, x: 94 };
    const review = project.propose(card, [{ address: bangs, patch: { bounds } }], [bangs]);
    expect(editor.acceptProposal(review.id).changedElementIds).toEqual([
      creativeDesignAddressKey(bangs),
    ]);
    expect(
      candidateInstance(editor.content, 'candidate-1', characterComponentId).overrides?.[
        'hair-front'
      ],
    ).toEqual({ bounds });
    for (const id of ['candidate-2', 'candidate-3'])
      expect(candidateInstance(editor.content, id, characterComponentId)).toEqual(
        candidateInstance(before, id, characterComponentId),
      );
    expect(editor.content.components).toEqual(before.components);
  });

  it('refuses a preview after source revision changes without modifying the Design', async () => {
    const { project, card, editor } = await linkedFixture();
    const before = clone(editor.content);
    const review = proposeEyes(project);
    project.source.execute(
      mode.edit(project.source.content, card, defaultCharacterColumns.name, '変更した名前'),
    );
    expect(() => editor.acceptProposal(review.id)).toThrow(/正本/);
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });

  it('rejects stale Design revisions at registration and at acceptance', async () => {
    const { project, card, editor } = await linkedFixture();
    const oldRevision = clone(editor.revision);
    const review = proposeEyes(project);
    project.execute(card, updateComponentPart(characterComponentId, 'mouth', { fill: '#b35a64' }));
    const changed = clone(editor.content);
    expect(() =>
      project.propose(card, [{ address: eyes, patch: { fill: '#123456' } }], [eyes], oldRevision),
    ).toThrow(/draft changed/i);
    expect(editor.proposals.find((pending) => pending.id === review.id)?.stale).toBe(true);
    expect(() => editor.acceptProposal(review.id)).toThrow(/draft changed/i);
    expect(editor.content).toEqual(changed);
  });

  it('checks revoked permissions at every mutation and retains the reviewed proposal', async () => {
    const { project, card, editor, state } = await linkedFixture();
    const review = proposeEyes(project);
    const before = clone(editor.content);
    state.writable = false;
    expect(() => editor.acceptProposal(review.id)).toThrow(/read-only/i);
    expect(() => project.choose(card, 'candidate-2')).toThrow(/閲覧/);
    expect(() => project.addCandidate(card, 'candidate-1', '権限なし')).toThrow(/閲覧/);
    expect(() =>
      project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#123456' })),
    ).toThrow(/閲覧/);
    expect(() => proposeEyes(project)).toThrow(/閲覧/);
    await expect(project.ensureDesign(card)).rejects.toThrow(/閲覧/);
    await expect(project.save()).rejects.toThrow(/閲覧/);
    expect(editor.content).toEqual(before);
    expect(editor.proposals.map((pending) => pending.id)).toEqual([review.id]);
    state.writable = true;
    expect(editor.acceptProposal(review.id).outcome).toBe('accepted');
  });

  it('rejects locked component edits and out-of-scope proposals without a partial edit', async () => {
    const { project, card, editor } = await linkedFixture();
    project.execute(
      card,
      updateComponentPart(characterComponentId, 'group-face', { locked: true }),
    );
    const locked = clone(editor.content);
    expect(() =>
      project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#123456' })),
    ).toThrow(/unlock/i);
    expect(() => proposeEyes(project)).toThrow(/unlock/i);
    expect(editor.content).toEqual(locked);
    editor.undo();
    const before = clone(editor.content);
    expect(() =>
      project.propose(card, [{ address: eyes, patch: { fill: '#123456' } }], [bangs]),
    ).toThrow();
    expect(editor.content).toEqual(before);
    expect(editor.proposals).toEqual([]);
  });
});

describe('CreativeProject persistence failures and reference diagnostics', () => {
  it('rejects orphan source bindings before writing any artifact and keeps the saved project reopenable', async () => {
    const { project, state, io, open } = await linkedFixture();
    project.source.execute(mode.create(project.source.content, '追加した人物', '短い説明'));
    const added = project.cards.at(-1)!;
    await project.ensureDesign(added);
    await project.save();
    const savedArtifacts = await io.artifacts.list();
    const writes = state.artifactWrites.length;
    const savedMapping = clone(state.mapping);
    project.source.undo();
    expect(project.cards.some((card) => card.id === added.id)).toBe(false);
    await expect(project.save()).rejects.toThrow(/正本または選択候補/);
    expect(state.artifactWrites.length).toBe(writes);
    expect(await io.artifacts.list()).toEqual(savedArtifacts);
    expect(state.mapping).toEqual(savedMapping);
    const recovered = await open();
    expect(recovered.cards.some((card) => card.id === added.id)).toBe(true);
    project.source.redo();
    await project.save();
    expect(project.mappingDirty).toBe(false);
  });

  it('limits artwork bindings before creation and writes only mappings accepted by the reader', async () => {
    const { io, state } = storageFixture();
    const seed = mode.seed();
    seed.rows = Array.from({ length: 257 }, (_, i) => ({
      id: `row-${i}`,
      values: {
        ...seed.rows[0].values,
        [defaultCharacterColumns.id]: `CH-${String(i + 1).padStart(2, '0')}`,
      },
    }));
    const largeMode = { ...mode, seed: () => seed };
    const project = await CreativeProject.open(largeMode, io);
    const cards = project.cards;
    for (const card of cards.slice(0, 256)) await project.ensureDesign(card);
    const writes = state.artifactWrites.length;
    await expect(project.ensureDesign(cards[256])).rejects.toThrow(/256/);
    expect(state.artifactWrites.length).toBe(writes);
    expect(project.mapping.bindings).toHaveLength(256);
    await project.save();
    expect(readCreativeMapping(state.mapping, mode.id)).toEqual(project.mapping);
  }, 20000);

  it('keeps the manifest dirty after a mapping failure even when only native content was edited', async () => {
    const { project, card, editor, state } = await linkedFixture();
    await project.save();
    project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#748262' }));
    expect(project.mappingDirty).toBe(false);
    state.failMapping = true;
    await expect(project.save()).rejects.toThrow(/mapping save failure/);
    expect(editor.snapshot.dirty).toBe(false);
    expect(project.source.snapshot.dirty).toBe(false);
    expect(project.mappingDirty).toBe(true);
    state.failMapping = false;
    await project.save();
    expect(project.mappingDirty).toBe(false);
  });

  it('does not report success if native history changes while the manifest write is pending', async () => {
    const { project, card, editor, io } = await linkedFixture();
    await project.save();
    project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#748262' }));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = io.writeMapping;
    io.writeMapping = async (mapping) => {
      enter();
      await paused;
      await write(mapping);
    };
    const saving = project.save();
    await entered;
    editor.undo();
    release();
    await expect(saving).rejects.toThrow(/保存中に編集/);
    expect(project.mappingDirty).toBe(true);
    expect(editor.snapshot.dirty).toBe(true);
    io.writeMapping = write;
    await project.save();
    expect(project.mappingDirty).toBe(false);
    expect(editor.snapshot.dirty).toBe(false);
  });

  it('returns caller-owned binding references and rejects group proposals without visible native effect', async () => {
    const { project, card, editor } = await linkedFixture();
    const binding = project.binding(card)!;
    binding.chosenFrameId = 'tampered';
    expect(project.binding(card)?.chosenFrameId).toBe('candidate-1');
    const group = { componentId: characterComponentId, elementId: 'group-hair' };
    expect(() =>
      project.propose(card, [{ address: group, patch: { opacity: 0.5 } }], [group]),
    ).toThrow(/個々の部位/);
    expect(editor.proposals).toEqual([]);
    const proposal = project.propose(card, [{ address: group, patch: { hidden: true } }], [group]);
    editor.acceptProposal(proposal.id);
    expect(part(editor.content, 'group-hair').hidden).toBe(true);
  });

  it('retains artifact saves and the old manifest when mapping save fails, then retries', async () => {
    const { project, card, editor, state, artifacts, open } = await linkedFixture();
    await project.save();
    const original = clone(state.mapping);
    project.choose(card, 'candidate-3');
    project.execute(card, updateComponentPart(characterComponentId, 'eyes', { fill: '#8a5522' }));
    state.failMapping = true;
    await expect(project.save()).rejects.toThrow(/mapping save failure/);
    expect(project.saving).toBe(false);
    expect(project.mappingDirty).toBe(true);
    expect(state.mapping).toEqual(original);
    expect((await artifacts.get(editor.id))?.draft.content).toEqual(editor.content);
    expect(project.binding(card)?.chosenFrameId).toBe('candidate-3');
    expect(project.problem(card)).toMatch(/保存版/);
    const stale = await open();
    expect(stale.problem(stale.cards[0])).toMatch(/保存版/);
    state.failMapping = false;
    await project.save();
    expect(project.mappingDirty).toBe(false);
    const reloaded = await open();
    expect(reloaded.problem(reloaded.cards[0])).toBeUndefined();
    expect(reloaded.binding(reloaded.cards[0])?.chosenFrameId).toBe('candidate-3');
    expect(reloaded.editor(reloaded.cards[0])?.content).toEqual(editor.content);
  });

  it('keeps unsaved Design work and the manifest after a partial artifact save, then retries', async () => {
    const { project, card, editor, state, artifacts, open } = await linkedFixture();
    await project.save();
    const original = clone(state.mapping);
    const storedDesign = await artifacts.get(editor.id);
    project.source.execute(
      mode.edit(project.source.content, card, defaultCharacterColumns.name, '保存途中の名前'),
    );
    project.execute(
      card,
      updateComponentPart(characterComponentId, 'hair-front', { fill: '#703d59' }),
    );
    const draft = clone(editor.content);
    state.failArtifactId = editor.id;
    await expect(project.save()).rejects.toThrow(/artifact save failure/);
    expect(project.saving).toBe(false);
    expect(project.source.snapshot.dirty).toBe(false);
    expect(editor.snapshot.dirty).toBe(true);
    expect(editor.content).toEqual(draft);
    expect(state.mapping).toEqual(original);
    expect(await artifacts.get(editor.id)).toEqual(storedDesign);
    state.failArtifactId = '';
    await project.save();
    const reloaded = await open();
    expect(reloaded.cards[0].name).toBe('保存途中の名前');
    expect(reloaded.editor(reloaded.cards[0])?.content).toEqual(draft);
    expect(reloaded.problem(reloaded.cards[0])).toBeUndefined();
  });

  it.each(['source', 'design'] as const)(
    'diagnoses externally advanced %s versions without silently rebasing',
    async (target) => {
      const { project, editor, state, artifacts, open } = await linkedFixture();
      await project.save();
      const mapping = clone(state.mapping);
      const artifact = (await artifacts.get(target === 'source' ? project.source.id : editor.id))!;
      const advanced = await commitVersion(artifact, null, 'Another Host saved');
      await artifacts.put(advanced);
      const reloaded = await open();
      const reloadedCard = reloaded.cards[0];
      expect(reloaded.problem(reloadedCard)).toMatch(
        target === 'source' ? /正本の保存版/ : /設定画の保存版/,
      );
      expect(state.mapping).toEqual(mapping);
      await expect(reloaded.ensureDesign(reloadedCard)).rejects.toThrow(/保存版/);
      expect(() => proposeEyes(reloaded)).toThrow(/保存版/);
      await reloaded.save();
      expect(reloaded.problem(reloadedCard)).toBeUndefined();
    },
  );

  it.each(['source', 'design'] as const)(
    'fails clearly for a missing %s artifact and preserves its mapping',
    async (target) => {
      const { project, editor, state, artifacts, open } = await linkedFixture();
      await project.save();
      const mapping = clone(state.mapping);
      await artifacts.remove(target === 'source' ? project.source.id : editor.id);
      await expect(open()).rejects.toThrow(
        target === 'source' ? /正本が見つかりません/ : /設定画が見つかりません/,
      );
      expect(state.mapping).toEqual(mapping);
    },
  );

  it('admits existing read-only projects and refuses initial read-only creation without writes', async () => {
    const existing = await linkedFixture();
    await existing.project.save();
    existing.state.writable = false;
    const writes = existing.state.artifactWrites.length;
    const readOnly = await existing.open();
    expect(readOnly.source.readOnly).toBe(true);
    expect(readOnly.editor(readOnly.cards[0])?.readOnly).toBe(true);
    expect(existing.state.artifactWrites).toHaveLength(writes);
    await expect(readOnly.save()).rejects.toThrow(/閲覧/);
    const empty = storageFixture();
    empty.state.writable = false;
    await expect(empty.open()).rejects.toThrow(/編集権限/);
    expect(await empty.artifacts.list()).toEqual([]);
    expect(empty.state.mappingWrites).toBe(0);
  });
});

describe('CreativeProject mapping admission', () => {
  it('rejects malformed, duplicate and content-bearing manifests without replacing the saved value', async () => {
    const { project, state, open } = await linkedFixture();
    await project.save();
    const original = project.mapping;
    const binding = original.bindings[0];
    const invalid: unknown[] = [
      {},
      { ...original, schemaVersion: 2 },
      { ...original, mode: 'another-mode' },
      { ...original, source: { ...original.source, versionId: '' } },
      { ...original, bindings: [binding, clone(binding)] },
      { ...original, summary: '本文を対応表にコピーしない' },
      { ...original, source: { ...original.source, content: { rows: [] } } },
      { ...original, bindings: [{ ...binding, bounds: { x: 0, y: 0, width: 1, height: 1 } }] },
      { ...original, bindings: [{ ...binding, design: { ...binding.design, content: {} } }] },
    ];
    for (const raw of invalid) {
      expect(() => readCreativeMapping(raw, mode.id)).toThrow();
      state.mapping = clone(raw);
      await expect(open()).rejects.toThrow();
      expect(state.mapping).toEqual(raw);
    }
    state.mapping = clone(original);
    const accepted = readCreativeMapping(state.mapping, mode.id);
    accepted.bindings[0].chosenFrameId = 'caller-owned';
    expect((state.mapping as CreativeMapping).bindings[0].chosenFrameId).toBe('candidate-1');
  });
});
