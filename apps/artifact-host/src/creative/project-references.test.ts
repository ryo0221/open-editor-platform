import { describe, expect, it } from 'vitest';
import {
  clone,
  commitVersion,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { updateComponentPart } from '@editor-platform/design/model';
import { createDocument } from '@editor-platform/document/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { characterSourceConfig, defaultCharacterColumns } from './character-source';
import { characterComponentId, characterGroups, createCharacterDesign } from './character-preset';
import { CreativeProject, type CreativeMapping, type CreativeStorage } from './project';
import type { CreativeMode } from './types';

const mode: CreativeMode<StructuredData> = {
  ...characterSourceConfig,
  design: createCharacterDesign,
  componentId: characterComponentId,
  groups: characterGroups,
};

function referenceStorage() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  const state = {
    writable: true,
    mapping: undefined as CreativeMapping | undefined,
    mappingWrites: 0,
    writes: [] as string[],
    beforeGet: undefined as ((id: string) => Promise<void>) | undefined,
  };
  const io: CreativeStorage = {
    artifacts: {
      list: () => artifacts.list(),
      async get(id) {
        await state.beforeGet?.(id);
        return artifacts.get(id);
      },
      async put(value) {
        state.writes.push(value.id);
        await artifacts.put(value);
      },
      remove: (id) => artifacts.remove(id),
    },
    async readMapping() {
      return clone(state.mapping);
    },
    async writeMapping(value) {
      state.mappingWrites++;
      state.mapping = clone(value);
    },
  };
  return {
    artifacts,
    state,
    io,
    open: (sourceId?: string) => CreativeProject.open(mode, io, () => state.writable, sourceId),
  };
}

async function existingSourceFixture() {
  const fixture = referenceStorage();
  const source = await commitVersion(
    { ...createArtifact('data', '既存作品の人物表', mode.seed()), id: 'existing-character-sheet' },
    null,
    'Existing canonical character sheet',
  );
  await fixture.artifacts.put(source);
  return { ...fixture, source };
}

async function linkedExistingFixture() {
  const fixture = await existingSourceFixture();
  const project = await fixture.open(fixture.source.id);
  const card = project.cards[0];
  const design = await project.ensureDesign(card);
  await project.save();
  return { ...fixture, project, card, design };
}

async function relatedDocument() {
  const first = await commitVersion(
    { ...createArtifact('document', '関連シーン', createDocument()), id: 'existing-scene' },
    null,
    'Fixed related scene',
  );
  return { first, second: await commitVersion(first, null, 'A later scene version') };
}

function pauseRead(fixture: ReturnType<typeof referenceStorage>, artifactId: string) {
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.state.beforeGet = async (id) => {
    if (id !== artifactId) return;
    fixture.state.beforeGet = undefined;
    signalEntered();
    await paused;
  };
  return { entered, release };
}

describe('CreativeProject existing-source and related exact references', () => {
  it('connects the original source Artifact ID without creating or copying a second source', async () => {
    const fixture = await existingSourceFixture();
    const sourceBefore = clone(fixture.source);
    const project = await fixture.open(fixture.source.id);
    expect(project.source.id).toBe(fixture.source.id);
    expect(project.mapping.source).toEqual({
      artifactId: fixture.source.id,
      versionId: fixture.source.draft.baseVersionId,
    });
    expect(fixture.state.writes).toEqual([]);
    expect((await fixture.artifacts.list()).map((a) => a.id)).toEqual([fixture.source.id]);
    expect(await fixture.artifacts.get(fixture.source.id)).toEqual(sourceBefore);
    const card = project.cards[0];
    const design = await project.ensureDesign(card);
    expect(
      (await fixture.artifacts.list()).filter((a) => a.kind === 'data').map((a) => a.id),
    ).toEqual([fixture.source.id]);
    expect(fixture.state.writes).toEqual([design.id]);
    project.source.execute(
      mode.edit(
        project.source.content,
        card,
        defaultCharacterColumns.description,
        '既存正本への編集',
      ),
    );
    await project.save();
    const reloaded = await fixture.open(fixture.source.id);
    expect(reloaded.source.id).toBe(fixture.source.id);
    expect(reloaded.cards[0].summary).toBe('既存正本への編集');
    expect(reloaded.cards[0].elementId).toBe(card.elementId);
    const stored = await fixture.artifacts.get(fixture.source.id);
    expect(stored?.draft.content).toEqual(project.source.content);
    expect(JSON.stringify(project.mapping)).not.toContain('既存正本への編集');
    expect((await fixture.artifacts.list()).filter((a) => a.kind === 'data')).toHaveLength(1);
  });

  it('rejects an absent or uncommitted existing source without falling back to a seed', async () => {
    const fixture = referenceStorage();
    await expect(fixture.open('absent-source')).rejects.toThrow(/正本/);
    expect(await fixture.artifacts.list()).toEqual([]);
    expect(fixture.state.mappingWrites).toBe(0);
    const unsaved = {
      ...createArtifact('data', '未確定の人物表', mode.seed()),
      id: 'uncommitted-source',
    };
    await fixture.artifacts.put(unsaved);
    await expect(fixture.open(unsaved.id)).rejects.toThrow(/保存版/);
    expect(await fixture.artifacts.list()).toEqual([unsaved]);
    expect(fixture.state.writes).toEqual([]);
    expect(fixture.state.mappingWrites).toBe(0);
  });

  it('rejects a missing exact source version even while no artwork bindings exist', async () => {
    const fixture = await existingSourceFixture();
    const project = await fixture.open(fixture.source.id);
    const missing = project.mapping;
    missing.source.versionId = 'missing-source-version';
    fixture.state.mapping = clone(missing);
    const writes = [...fixture.state.writes],
      mappingWrites = fixture.state.mappingWrites;
    await expect(fixture.open(fixture.source.id)).rejects.toThrow(/正本.*版|版.*正本/);
    expect(fixture.state.mapping).toEqual(missing);
    expect(fixture.state.mappingWrites).toBe(mappingWrites);
    expect(fixture.state.writes).toEqual(writes);
  });

  it('rejects explicit source-ID mismatch and missing mapped source without replacing the mapping', async () => {
    const fixture = await existingSourceFixture();
    await fixture.open(fixture.source.id);
    const mapping = clone(fixture.state.mapping);
    const other = await commitVersion(
      { ...createArtifact('data', '別作品の人物表', mode.seed()), id: 'other-source' },
      null,
      'Other source',
    );
    await fixture.artifacts.put(other);
    await expect(fixture.open(other.id)).rejects.toThrow(/正本が異なります/);
    expect(fixture.state.mapping).toEqual(mapping);
    await fixture.artifacts.remove(fixture.source.id);
    await expect(fixture.open(fixture.source.id)).rejects.toThrow(/正本が見つかりません/);
    expect(fixture.state.mapping).toEqual(mapping);
    expect((await fixture.artifacts.list()).map((a) => a.id)).toEqual([other.id]);
  });

  it.each(['itemId', 'sourceElementId'] as const)(
    'rejects a saved %s binding that no longer matches its native source row',
    async (field) => {
      const fixture = await linkedExistingFixture();
      const mismatch = fixture.project.mapping;
      mismatch.bindings[0][field] = field === 'itemId' ? 'CH-99' : 'missing-native-row';
      fixture.state.mapping = clone(mismatch);
      const writes = [...fixture.state.writes];
      await expect(fixture.open(fixture.source.id)).rejects.toThrow(/正本|対応/);
      expect(fixture.state.mapping).toEqual(mismatch);
      expect(fixture.state.writes).toEqual(writes);
    },
  );

  it('keeps related references on their chosen immutable version through saving and reload', async () => {
    const fixture = await linkedExistingFixture();
    const { first, second } = await relatedDocument();
    await fixture.artifacts.put(second);
    const before = await fixture.artifacts.list();
    expect((await fixture.project.availableArtifacts()).map((a) => a.id).sort()).toEqual(
      before.map((a) => a.id).sort(),
    );
    const firstVersion = first.draft.baseVersionId!;
    await fixture.project.linkRelated(fixture.card, first.id, firstVersion);
    expect(fixture.project.binding(fixture.card)?.related).toEqual([
      { artifactId: first.id, versionId: firstVersion },
    ]);
    expect(fixture.project.mappingDirty).toBe(true);
    const fetched = await fixture.project.relatedArtifact(first.id);
    expect(fetched).toEqual(second);
    fetched!.name = 'Private reader copy';
    expect((await fixture.project.relatedArtifact(first.id))?.name).toBe(second.name);
    await fixture.project.save();
    expect(await fixture.artifacts.get(first.id)).toEqual(second);
    const mapping = fixture.project.mapping;
    const reloaded = await fixture.open(fixture.source.id);
    expect(reloaded.binding(reloaded.cards[0])?.related).toEqual([
      { artifactId: first.id, versionId: firstVersion },
    ]);
    expect(reloaded.mapping).toEqual(mapping);
    expect(reloaded.mappingDirty).toBe(false);
    await reloaded.linkRelated(reloaded.cards[0], first.id, firstVersion);
    expect(reloaded.binding(reloaded.cards[0])?.related).toHaveLength(1);
    expect(reloaded.mappingDirty).toBe(false);
    expect(JSON.stringify(mapping)).not.toContain('blocks');
    expect((await fixture.artifacts.list()).map((a) => a.id).sort()).toEqual(
      before.map((a) => a.id).sort(),
    );
    await reloaded.linkRelated(reloaded.cards[0], second.id, second.draft.baseVersionId!);
    reloaded.unlinkRelated(reloaded.cards[0], first.id, firstVersion);
    expect(reloaded.binding(reloaded.cards[0])?.related).toEqual([
      { artifactId: second.id, versionId: second.draft.baseVersionId },
    ]);
    await reloaded.save();
    expect((await fixture.open(fixture.source.id)).binding(reloaded.cards[0])?.related).toEqual([
      { artifactId: second.id, versionId: second.draft.baseVersionId },
    ]);
    expect(await fixture.artifacts.get(first.id)).toEqual(second);
  });

  it('rejects a related artifact or exact version that is absent without changing the selection', async () => {
    const fixture = await linkedExistingFixture();
    const { second } = await relatedDocument();
    await fixture.artifacts.put(second);
    const before = fixture.project.mapping;
    await expect(
      fixture.project.linkRelated(fixture.card, 'missing-artifact', 'missing-version'),
    ).rejects.toThrow(/保存版/);
    await expect(
      fixture.project.linkRelated(fixture.card, second.id, 'missing-version'),
    ).rejects.toThrow(/保存版/);
    expect(fixture.project.mapping).toEqual(before);
    expect(fixture.project.mappingDirty).toBe(false);
  });

  it('rejects a related immutable version whose content no longer matches its hash', async () => {
    const fixture = await linkedExistingFixture();
    const { first } = await relatedDocument();
    const corrupt = clone(first);
    corrupt.versions[0].contentHash = '0'.repeat(64);
    await fixture.artifacts.put(corrupt);
    const before = fixture.project.mapping;
    await expect(
      fixture.project.linkRelated(fixture.card, first.id, first.draft.baseVersionId!),
    ).rejects.toThrow(/破損/);
    expect(fixture.project.mapping).toEqual(before);
    expect(fixture.project.mappingDirty).toBe(false);
  });

  it.each(['artifact', 'version'] as const)(
    'preserves a missing persisted related %s and leaves its exact reference unresolved',
    async (missing) => {
      const fixture = await linkedExistingFixture();
      const { first, second } = await relatedDocument();
      await fixture.artifacts.put(second);
      await fixture.project.linkRelated(fixture.card, first.id, first.draft.baseVersionId!);
      await fixture.project.save();
      const mapping = clone(fixture.state.mapping),
        writes = [...fixture.state.writes];
      if (missing === 'artifact') await fixture.artifacts.remove(first.id);
      else {
        const replaced = await commitVersion(
          { ...createArtifact('document', second.name, createDocument()), id: second.id },
          null,
          'Replace retained version lineage',
        );
        await fixture.artifacts.put(replaced);
      }
      const reloaded = await fixture.open(fixture.source.id);
      const card = reloaded.cards[0];
      const related = await reloaded.relatedArtifact(first.id);
      if (missing === 'artifact') expect(related).toBeUndefined();
      else {
        expect(related).toBeDefined();
        expect(
          related?.versions.find((v) => v.versionId === first.draft.baseVersionId),
        ).toBeUndefined();
      }
      expect(reloaded.binding(card)?.related).toEqual([
        { artifactId: first.id, versionId: first.draft.baseVersionId },
      ]);
      expect(reloaded.mapping).toEqual(mapping);
      expect(reloaded.editor(card)).toBeDefined();
      expect(reloaded.problem(card)).toBeUndefined();
      expect(reloaded.mappingDirty).toBe(false);
      await expect(
        reloaded.linkRelated(card, first.id, first.draft.baseVersionId!),
      ).rejects.toThrow(/保存版/);
      expect(fixture.state.mapping).toEqual(mapping);
      expect(fixture.state.writes).toEqual(writes);
    },
  );

  it('permits related reads but refuses link/unlink and initial source connection while readonly', async () => {
    const fixture = await linkedExistingFixture();
    const { first } = await relatedDocument();
    await fixture.artifacts.put(first);
    await fixture.project.linkRelated(fixture.card, first.id, first.draft.baseVersionId!);
    await fixture.project.save();
    const mapping = fixture.project.mapping,
      writes = [...fixture.state.writes];
    fixture.state.writable = false;
    const project = await fixture.open(fixture.source.id);
    expect(await project.relatedArtifact(first.id)).toEqual(first);
    expect((await project.availableArtifacts()).map((a) => a.id)).toContain(first.id);
    await expect(
      project.linkRelated(project.cards[0], first.id, first.draft.baseVersionId!),
    ).rejects.toThrow(/閲覧/);
    expect(() =>
      project.unlinkRelated(project.cards[0], first.id, first.draft.baseVersionId!),
    ).toThrow(/閲覧/);
    expect(project.mapping).toEqual(mapping);
    expect(fixture.state.writes).toEqual(writes);
    const initial = await existingSourceFixture();
    initial.state.writable = false;
    await expect(initial.open(initial.source.id)).rejects.toThrow(/編集権限/);
    expect(initial.state.mappingWrites).toBe(0);
    expect(initial.state.writes).toEqual([]);
    expect(await initial.artifacts.list()).toEqual([initial.source]);
  });

  it('rechecks permission after awaiting a related artifact read', async () => {
    const fixture = await linkedExistingFixture();
    const { first } = await relatedDocument();
    await fixture.artifacts.put(first);
    const before = fixture.project.mapping,
      paused = pauseRead(fixture, first.id);
    const pending = fixture.project.linkRelated(fixture.card, first.id, first.draft.baseVersionId!);
    await paused.entered;
    fixture.state.writable = false;
    paused.release();
    await expect(pending).rejects.toThrow(/閲覧/);
    expect(fixture.project.mapping).toEqual(before);
    expect(fixture.project.mappingDirty).toBe(false);
  });

  it('rechecks permission before writing and binding artwork after an awaited source-artwork lookup', async () => {
    const fixture = await existingSourceFixture();
    const project = await fixture.open(fixture.source.id),
      card = project.cards[0];
    const designId = `creative:${JSON.stringify([mode.id, fixture.source.id, card.elementId])}`;
    const paused = pauseRead(fixture, designId),
      before = project.mapping;
    const pending = project.ensureDesign(card);
    await paused.entered;
    fixture.state.writable = false;
    paused.release();
    await expect(pending).rejects.toThrow(/閲覧/);
    expect(project.mapping).toEqual(before);
    expect(project.designs.size).toBe(0);
    expect(project.mappingDirty).toBe(false);
    expect(await fixture.artifacts.list()).toEqual([fixture.source]);
    expect(fixture.state.writes).toEqual([]);
  });
});

it('keeps artwork IDs disjoint for source/native ID tuples containing separators', async () => {
  const fixture = referenceStorage();
  const sourceA = mode.seed();
  sourceA.rows = [{ ...sourceA.rows[0], id: 'c' }];
  const sourceB = mode.seed();
  sourceB.rows = [{ ...sourceB.rows[0], id: 'b:c' }];
  for (const [id, content] of [
    ['a:b', sourceA],
    ['a', sourceB],
  ] as const) {
    await fixture.artifacts.put(
      await commitVersion(
        { ...createArtifact('data', '既存人物表', content), id },
        null,
        'Existing source',
      ),
    );
  }
  async function connect(id: string) {
    let mapping: unknown;
    const project = await CreativeProject.open(
      mode,
      {
        artifacts: fixture.io.artifacts,
        readMapping: async () => clone(mapping),
        writeMapping: async (value) => {
          mapping = clone(value);
        },
      },
      () => true,
      id,
    );
    const card = project.cards[0];
    return { project, card, editor: await project.ensureDesign(card) };
  }
  const a = await connect('a:b');
  a.project.execute(a.card, updateComponentPart(characterComponentId, 'eyes', { fill: '#112233' }));
  const b = await connect('a');
  expect(a.editor.id).not.toBe(b.editor.id);
  expect(b.editor.content).not.toEqual(a.editor.content);
  expect(
    (await fixture.artifacts.list()).filter((artifact) => artifact.kind === 'design'),
  ).toHaveLength(2);
  await a.project.save();
  await b.project.save();
  expect(a.project.binding(a.card)?.design.artifactId).not.toBe(
    b.project.binding(b.card)?.design.artifactId,
  );
});
