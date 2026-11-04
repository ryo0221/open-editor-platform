import { describe, expect, it } from 'vitest';
import { canonicalJson, clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { documentText, documentTextEditCommand } from '@editor-platform/document/text';
import {
  designInstanceElements,
  isDesign,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import {
  creativeDesignAddressKey,
  creativeDesignEditCommand,
  designCreativeProposalDiff,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { CreativeProject, type CreativeStorage } from './project';
import { NotesFieldDraft } from './notes-field';
import { settingMode } from './setting-mode';
import { settingComponentId, settingGroups } from './setting-preset';
import { guardSettingSourceCommand, settingSourceCards } from './setting-source';

const day = 'instance-candidate-1';
const night = 'instance-candidate-2';
const room = 'instance-candidate-3';
const winter = 'instance-candidate-4';
const instanceIds = [day, night, room, winter];
const address = (elementId: string, instanceId?: string): CreativeDesignAddress => ({
  componentId: settingComponentId,
  elementId,
  ...(instanceId ? { instanceId } : {}),
});
function definition(content: DesignContent, id: string) {
  return content.components
    .find((component) => component.id === settingComponentId)!
    .elements!.find((part) => part.id === id)!;
}
function owner(content: DesignContent, id: string) {
  return content.elements.find((element) => element.id === id)!;
}
function projected(content: DesignContent, instanceId: string, partId: string) {
  return designInstanceElements(content, owner(content, instanceId)).find(
    (part) => part.id === partId,
  )!;
}
function localBounds(content: DesignContent, instanceId: string, partId: string) {
  const origin = owner(content, instanceId).bounds;
  const { x, y, width, height } = projected(content, instanceId, partId).bounds;
  return { x: x - origin.x, y: y - origin.y, width, height };
}
function unchangedParts(
  before: DesignContent,
  after: DesignContent,
  instanceId: string,
  changed: string[],
) {
  for (const part of settingGroups
    .flatMap((group) => group.parts)
    .filter((part) => !changed.includes(part.id)))
    expect(projected(after, instanceId, part.id)).toEqual(projected(before, instanceId, part.id));
}
const image = (color: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="${color}" d="M0 0h2v2H0Z"/></svg>`)}`;

async function fixture() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  const state = { mapping: undefined as unknown, writable: true };
  const io: CreativeStorage = {
    artifacts,
    readMapping: async () => clone(state.mapping),
    async writeMapping(value) {
      state.mapping = clone(value);
    },
  };
  const open = () => CreativeProject.open(settingMode, io, () => state.writable);
  const project = await open();
  const card = project.cards[0];
  const sourceBefore = canonicalJson(project.source.content);
  const editor = await project.ensureDesign(card);
  expect(canonicalJson(project.source.content)).toBe(sourceBefore);
  return { artifacts, state, open, project, card, editor };
}
function roofProposal(
  project: CreativeProject<DocumentContent>,
  patch: Partial<DesignElement>,
  instanceId = day,
) {
  const target = address('roof', instanceId);
  return project.propose(project.cards[0], [{ address: target, patch }], [target]);
}

describe('Setting Mode native project integration', () => {
  it('uses canonical LO headings, appends one native section and restores saved artwork choices', async () => {
    const { project, card, editor, state, open } = await fixture();
    const source = project.source.content;
    expect(isDocument(source)).toBe(true);
    expect(source.schemaVersion).toBe(2);
    expect(project.source.snapshot.kind).toBe('document');
    expect(card).toMatchObject({ id: 'LO-01', name: '風見の家' });
    expect(source.blocks.find((block) => block.id === card.elementId)).toMatchObject({
      type: 'heading',
      text: 'LO-01 風見の家',
    });
    expect(settingSourceCards(source)).toEqual(project.cards);
    const create = settingMode.create(source, '港の書庫', '船乗りたちの手記を集めた書庫。');
    expect(create.type).toBe('document.engine');
    project.source.execute(create);
    const added = project.cards.find((item) => item.id === 'LO-02')!;
    const after = project.source.content;
    expect(after.schemaVersion).toBe(source.schemaVersion);
    expect(after.blocks.slice(0, source.blocks.length)).toEqual(source.blocks);
    expect(added).toMatchObject({ name: '港の書庫', summary: '船乗りたちの手記を集めた書庫。' });
    project.source.undo();
    expect(project.source.content).toEqual(source);
    project.source.redo();
    expect(project.source.content).toEqual(after);
    const second = await project.ensureDesign(added);
    expect(project.editor(card)).toBe(editor);
    expect(project.source.content).toEqual(after);
    project.choose(card, 'candidate-2');
    project.choose(added, 'candidate-4');
    await project.save();
    const reloaded = await open();
    expect(reloaded.source.content).toEqual(after);
    expect(reloaded.cards).toEqual(project.cards);
    expect(reloaded.binding(reloaded.cards[0])?.chosenFrameId).toBe('candidate-2');
    expect(reloaded.binding(reloaded.cards[1])?.chosenFrameId).toBe('candidate-4');
    expect(reloaded.editor(reloaded.cards[1])?.content).toEqual(second.content);
    expect(
      project.mapping.bindings.every(
        (binding) =>
          Object.keys(binding).sort().join(',') === 'chosenFrameId,design,itemId,sourceElementId',
      ),
    ).toBe(true);
    expect(JSON.stringify(state.mapping)).not.toContain(added.summary);
    expect(JSON.stringify(state.mapping)).not.toContain('bounds');
  });

  it('applies the same native roof and window edits as the controls, retaining every other layer', async () => {
    const { project, card, editor } = await fixture();
    const before = editor.content;
    const source = canonicalJson(project.source.content);
    const bounds = { ...definition(before, 'roof').bounds, x: 93, y: 62, width: 270 };
    project.execute(card, creativeDesignEditCommand(address('roof', day), { bounds, rotation: 4 }));
    const roofEdited = editor.content;
    expect(localBounds(roofEdited, day, 'roof')).toEqual(bounds);
    expect(projected(roofEdited, day, 'roof').rotation).toBe(4);
    expect(roofEdited.components).toEqual(before.components);
    for (const id of instanceIds.slice(1)) expect(owner(roofEdited, id)).toEqual(owner(before, id));
    unchangedParts(before, roofEdited, day, ['roof']);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.content).toEqual(roofEdited);
    project.execute(
      card,
      creativeDesignEditCommand(address('windows', day), { opacity: 0.55, hidden: true }),
    );
    const windowsEdited = editor.content;
    expect(projected(windowsEdited, day, 'windows')).toMatchObject({ opacity: 0.55, hidden: true });
    unchangedParts(roofEdited, windowsEdited, day, ['windows']);
    expect(canonicalJson(project.source.content)).toBe(source);
    expect(isDesign(JSON.parse(JSON.stringify(windowsEdited)))).toBe(true);
  });

  it('propagates shared roof geometry and window color while retaining candidate-specific appearance', async () => {
    const { project, card, editor } = await fixture();
    const before = editor.content;
    const bounds = { ...definition(before, 'roof').bounds, x: 78, y: 61 };
    project.execute(card, creativeDesignEditCommand(address('roof'), { bounds }));
    project.execute(card, creativeDesignEditCommand(address('windows'), { fill: '#6699bb' }));
    const after = editor.content;
    for (const id of instanceIds) {
      expect(localBounds(after, id, 'roof')).toEqual(bounds);
      unchangedParts(before, after, id, ['roof', 'windows']);
    }
    expect(projected(after, day, 'windows').fill).toBe('#6699bb');
    expect(projected(after, winter, 'windows').fill).toBe('#6699bb');
    expect(projected(after, night, 'windows').fill).toBe('#ffe0a0');
    expect(projected(after, winter, 'roof').fill).toBe('#edf1ed');
    expect(projected(after, room, 'roof').hidden).toBe(true);
    expect(after.elements).toEqual(before.elements);
    editor.undo();
    editor.undo();
    expect(editor.content).toEqual(before);
    editor.redo();
    editor.redo();
    expect(editor.content).toEqual(after);
  });

  it('previews, rejects and applies a qualified roof proposal with the same native result and Undo/Redo', async () => {
    const { project, card, editor } = await fixture();
    const before = editor.content;
    const target = address('roof', day);
    const patch = { bounds: { ...definition(before, 'roof').bounds, y: 59 } };
    const expected = creativeDesignEditCommand(target, patch).apply(before);
    const review = roofProposal(project, patch);
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    expect(review.preview.content).toEqual(expected);
    const diff = designCreativeProposalDiff.diff(before, review.preview.content);
    expect(diff.fallback).toEqual([]);
    expect(diff.changes.map((change) => change.elementId)).toEqual([
      creativeDesignAddressKey(target),
    ]);
    expect(editor.rejectProposal(review.id).outcome).toBe('rejected');
    expect(editor.content).toEqual(before);
    const accepted = roofProposal(project, patch);
    expect(editor.acceptProposal(accepted.id).changedElementIds).toEqual([
      creativeDesignAddressKey(target),
    ]);
    expect(editor.content).toEqual(expected);
    for (const id of instanceIds.slice(1))
      expect(owner(editor.content, id)).toEqual(owner(before, id));
    unchangedParts(before, editor.content, day, ['roof']);
    expect(project.source.snapshot.dirty).toBe(false);
    expect(project.editor(card)).toBe(editor);
    editor.undo();
    expect(editor.content).toEqual(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.content).toEqual(expected);
  });

  it('keeps source edits in native Document and refuses proposals after source or Design revisions change', async () => {
    const { project, card, editor } = await fixture();
    const before = editor.content;
    const proposal = roofProposal(project, { fill: '#775544' });
    const source = project.source.content;
    const text = documentText(source);
    const description = text.segments.find(
      (segment) => text.text.slice(segment.start, segment.end) === card.summary,
    )!;
    const edit = documentTextEditCommand(source, [
      {
        segmentId: description.id,
        start: 0,
        end: card.summary.length,
        expected: card.summary,
        text: '港の東側にある、船大工の古い家。',
      },
    ]);
    project.source.execute(guardSettingSourceCommand(edit));
    expect(project.cards[0].summary).toContain('船大工');
    expect(project.cards[0].elementId).toBe(card.elementId);
    expect(project.source.content.schemaVersion).toBe(source.schemaVersion);
    expect(() => editor.acceptProposal(proposal.id)).toThrow(/正本/);
    expect(editor.content).toEqual(before);
    editor.rejectProposal(proposal.id);
    const current = roofProposal(project, { fill: '#775544' });
    project.execute(
      project.cards[0],
      creativeDesignEditCommand(address('windows', day), { fill: '#88aacc' }),
    );
    const edited = editor.content;
    expect(() => editor.acceptProposal(current.id)).toThrow(/changed after/i);
    expect(editor.content).toEqual(edited);
  });

  it('replaces only the night background and binds new provenance, then cleans it on a source-only replacement', async () => {
    const { project, card, editor, open } = await fixture();
    const before = editor.content;
    const target = address('background', night);
    const src = image('#526785');
    const provenance = { src, source: 'Test Host / 自作夜景', license: 'Test Host sample' };
    const review = project.propose(
      card,
      [{ address: target, patch: { src, provenance } }],
      [target],
    );
    expect(review.preview.content).toEqual(
      creativeDesignEditCommand(target, { src, provenance }).apply(before),
    );
    editor.acceptProposal(review.id);
    const replaced = editor.content;
    expect(projected(replaced, night, 'background')).toMatchObject({ src, provenance });
    for (const id of [day, room, winter]) expect(owner(replaced, id)).toEqual(owner(before, id));
    unchangedParts(before, replaced, night, ['background']);
    expect(replaced.components).toEqual(before.components);
    await project.save();
    const reloaded = await open();
    expect(
      projected(reloaded.editor(reloaded.cards[0])!.content, night, 'background').provenance,
    ).toEqual(provenance);
    const srcOnly = image('#81769a');
    project.execute(card, creativeDesignEditCommand(target, { src: srcOnly }));
    expect(projected(editor.content, night, 'background').src).toBe(srcOnly);
    expect(projected(editor.content, night, 'background').provenance).toBeUndefined();
    expect(definition(editor.content, 'background').provenance).toEqual(
      definition(before, 'background').provenance,
    );
    editor.undo();
    expect(editor.content).toEqual(replaced);
    editor.redo();
    expect(projected(editor.content, night, 'background').provenance).toBeUndefined();
  });

  it('allows derived provenance cleanup during a shared background proposal without editing other candidates', async () => {
    const { project, card, editor } = await fixture();
    const shared = address('background');
    const inherited = address('background', day);
    project.execute(
      card,
      creativeDesignEditCommand(inherited, {
        provenance: definition(editor.content, 'background').provenance,
      }),
    );
    const before = editor.content;
    expect(owner(before, day).overrides?.background?.provenance).toBeDefined();
    const src = image('#dbb988');
    const provenance = { src, source: 'Test Host / 自作昼景', license: 'Test Host sample' };
    const review = project.propose(
      card,
      [{ address: shared, patch: { src, provenance } }],
      [shared],
    );
    const diff = designCreativeProposalDiff.diff(before, review.preview.content);
    expect(diff.fallback).toEqual([]);
    expect(new Set(diff.changes.map((change) => change.elementId))).toEqual(
      new Set([creativeDesignAddressKey(shared), creativeDesignAddressKey(inherited)]),
    );
    editor.acceptProposal(review.id);
    const after = editor.content;
    expect(owner(after, day).overrides?.background?.provenance).toBeUndefined();
    expect(projected(after, day, 'background')).toMatchObject({ src, provenance });
    for (const id of [night, room, winter]) expect(owner(after, id)).toEqual(owner(before, id));
    for (const id of instanceIds) unchangedParts(before, after, id, ['background']);
    editor.undo();
    expect(editor.content).toEqual(before);
    editor.redo();
    expect(editor.content).toEqual(after);
  });

  it('refuses locked window edits and rechecks source permission before native edits, apply and save', async () => {
    const { project, card, editor, state } = await fixture();
    const windows = address('windows', day);
    project.execute(card, creativeDesignEditCommand(windows, { locked: true }));
    const locked = editor.content;
    expect(() =>
      project.execute(card, creativeDesignEditCommand(windows, { fill: '#fff' })),
    ).toThrow(/unlock/i);
    expect(() =>
      project.propose(
        card,
        [{ address: windows, patch: { hidden: true, fill: '#fff' } }],
        [windows],
      ),
    ).toThrow(/unlock/i);
    expect(editor.content).toEqual(locked);
    project.execute(card, creativeDesignEditCommand(windows, { locked: false }));
    const proposal = roofProposal(project, { fill: '#775544' });
    const sourceEdit = settingMode.edit(
      project.source.content,
      card,
      'history',
      '船大工が百年前に建てた。',
    );
    const source = project.source.content;
    const design = editor.content;
    state.writable = false;
    expect(() => project.source.execute(sourceEdit)).toThrow(/read-only/i);
    expect(() => editor.acceptProposal(proposal.id)).toThrow(/read-only/i);
    expect(() => roofProposal(project, { fill: '#654321' })).toThrow(/閲覧/);
    await expect(project.save()).rejects.toThrow(/閲覧/);
    expect(project.source.content).toEqual(source);
    expect(editor.content).toEqual(design);
    state.writable = true;
    expect(editor.acceptProposal(proposal.id).outcome).toBe('accepted');
  });
});

it('tracks the normalized native location name as the input base across consecutive commits', async () => {
  const { project, card } = await fixture();
  const draft = new NotesFieldDraft(card.name);
  draft.begin(card.name, card.name);
  draft.commit(project, card, 'name', '  風待ちの家  ');
  expect(project.cards[0].name).toBe('風待ちの家');
  draft.commit(project, card, 'name', '  港の家  ');
  expect(project.cards[0].name).toBe('港の家');
});
