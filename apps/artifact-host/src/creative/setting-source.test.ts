import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  contentHash,
  createArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { documentProposalDiff } from '@editor-platform/document';
import { contentToNode } from '@editor-platform/document/engine';
import type { DocumentContent, InlineSpan } from '@editor-platform/document/model';
import { documentTextEditCommand } from '@editor-platform/document/text';
import { command, EditorSession } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  checkHostProposal,
  loadHostArtifact,
  serializeHostNativeArtifact,
} from '@editor-platform/editor-host';
import {
  createSettingSectionCommand,
  editSettingFieldCommand,
  guardSettingSourceCommand,
  settingDocumentSeed,
  settingSourceAdapter,
  settingSourceCards,
} from './setting-source';

const card = (content: DocumentContent, id = 'LO-01') =>
  settingSourceCards(content).find((candidate) => candidate.id === id)!;
const fieldParagraph = (content: DocumentContent, label: string) => {
  const at = content.blocks.findIndex((block) => block.type === 'heading' && block.text === label);
  return content.blocks[at + 1];
};

async function fixture() {
  const initial = await commitVersion(
    createArtifact('document', '世界の覚え書き', settingDocumentSeed()),
    null,
    'Initial world notes',
  );
  const access = { edit: true, fail: false };
  let stored: Artifact<DocumentContent> = structuredClone(initial);
  const editor = new ArtifactEditor(
    initial,
    settingSourceAdapter,
    {
      put: async (artifact) => {
        if (access.fail) throw Error('World notes storage failed');
        stored = structuredClone(artifact);
      },
    },
    () => access.edit,
  );
  return { editor, access, initial, stored: () => stored };
}

describe('Setting Mode native Document source', () => {
  it('projects the LO heading and its four fields without creating another record', () => {
    const source = settingDocumentSeed();
    const before = canonicalJson(source);
    const projected = settingSourceCards(source);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: 'LO-01',
      name: '風見の家',
      summary: '丘の上から港を見渡す、小さな木造の家。',
    });
    expect(
      projected[0].fields.map(({ id, label, editable }) => ({
        id,
        label,
        editable,
      })),
    ).toEqual([
      { id: 'name', label: '場所名', editable: true },
      { id: 'description', label: '説明', editable: true },
      { id: 'history', label: '歴史', editable: true },
      { id: 'life', label: '生活', editable: true },
      { id: 'atmosphere', label: '雰囲気', editable: true },
    ]);
    expect(source.blocks.find((block) => block.id === projected[0].elementId)?.type).toBe(
      'heading',
    );
    expect(canonicalJson(source)).toBe(before);
  });

  it('adds a complete LO section with one native command and one Undo/Redo step', () => {
    const source = settingDocumentSeed();
    const session = new EditorSession(source);
    const create = createSettingSectionCommand(source, '港の集会所', '広場に面した石造りの建物。');
    expect(create.type).toBe('document.engine');
    session.execute(create);
    const added = session.content;
    expect(settingSourceCards(added).map(({ id }) => id)).toEqual(['LO-01', 'LO-02']);
    expect(card(added, 'LO-02').fields.every((field) => field.editable)).toBe(true);
    expect(added.blocks.slice(0, source.blocks.length)).toEqual(source.blocks);
    expect(new Set(added.blocks.map(({ id }) => id)).size).toBe(added.blocks.length);
    expect(contentToNode(added).check()).toBeUndefined();
    session.undo();
    expect(session.content).toEqual(source);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.content).toEqual(added);
  });

  it.each([1, 6])(
    'appends a nonnested LO after a native H%i location without changing existing blocks',
    (headingLevel) => {
      const source: DocumentContent = {
        schemaVersion: 2,
        blocks: [
          { id: 'existing-location', type: 'heading', level: headingLevel, text: 'LO-08 古い港' },
          {
            id: 'existing-prose',
            type: 'paragraph',
            text: '古い港に残る記録。',
            rich: [{ text: '古い港', bold: true }, { text: 'に残る記録。' }],
          },
        ],
      };
      const before = canonicalJson(source);
      const session = new EditorSession(source);
      session.execute(createSettingSectionCommand(source, '新しい桟橋', '港の東にある桟橋。'));
      const added = session.content;
      const newCard = card(added, 'LO-09');
      const newHeading = added.blocks.find(({ id }) => id === newCard.elementId)!;
      expect(newHeading.level).toBe(Math.min(2, headingLevel));
      expect(settingSourceAdapter.validate(added)).toBe(true);
      expect(settingSourceCards(added).map(({ id }) => id)).toEqual(['LO-08', 'LO-09']);
      expect(newCard.fields.every(({ editable }) => editable)).toBe(true);
      expect(added.blocks.slice(0, source.blocks.length)).toEqual(source.blocks);
      expect(
        added.blocks
          .slice(source.blocks.length + 1)
          .filter(({ type }) => type === 'heading')
          .every(({ level }) => level === newHeading.level! + 1),
      ).toBe(true);
      expect(canonicalJson(source)).toBe(before);
      session.undo();
      expect(session.content).toEqual(source);
      expect(session.canUndo).toBe(false);
      session.redo();
      expect(session.content).toEqual(added);
    },
  );

  it('uses native text edits with one history unit and keeps all unrelated rich blocks', () => {
    const seed = settingDocumentSeed();
    const source = createSettingSectionCommand(seed, '古い駅', '海辺の駅。').apply(seed);
    const foreign = source.blocks.at(-1)!;
    foreign.text = '静かな潮風';
    foreign.rich = [
      { text: '静かな', bold: true },
      { text: '潮風', italic: true },
    ];
    const before = structuredClone(source);
    const originalCard = card(source);
    const description = fieldParagraph(source, '説明');
    const session = new EditorSession(source);
    const edit = editSettingFieldCommand(
      source,
      originalCard,
      'description',
      '雨の日も暖かい家。\n窓から海が見える。',
    );
    expect(edit.type).toBe('document.engine');
    session.execute(edit);
    expect(card(session.content).summary).toBe('雨の日も暖かい家。\n窓から海が見える。');
    expect(session.content.blocks.map(({ id }) => id)).toEqual(before.blocks.map(({ id }) => id));
    expect(session.content.blocks.filter(({ id }) => id !== description.id)).toEqual(
      before.blocks.filter(({ id }) => id !== description.id),
    );
    expect(source).toEqual(before);
    const diff = documentProposalDiff.diff(source, session.content);
    expect(diff.fallback).toEqual([]);
    expect([...new Set(diff.changes.map(({ elementId }) => elementId))]).toEqual([description.id]);
    session.undo();
    expect(session.content).toEqual(before);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(card(session.content).summary).toContain('雨の日');
  });

  it.each<{ label: string; rich: InlineSpan[] }>([
    { label: 'mixed bold', rich: [{ text: '古い', bold: true }, { text: '港の家。' }] },
    {
      label: 'link',
      rich: [{ text: '港', link: 'https://example.test/harbor' }, { text: 'の家。' }],
    },
    {
      label: 'ruby',
      rich: [{ text: '港', ruby: { text: 'みなと', base: '港' } }, { text: 'の家。' }],
    },
    { label: 'italic', rich: [{ text: '古い', italic: true }, { text: '家。' }] },
    { label: 'underline', rich: [{ text: '古い', underline: true }, { text: '家。' }] },
    { label: 'strike', rich: [{ text: '古い', strike: true }, { text: '家。' }] },
    { label: 'code', rich: [{ text: '古い', code: true }, { text: '家。' }] },
    { label: 'color', rich: [{ text: '古い', color: '#345678' }, { text: '家。' }] },
    { label: 'highlight', rich: [{ text: '古い', highlight: '#ffeeaa' }, { text: '家。' }] },
    { label: 'emphasis dots', rich: [{ text: '古い', emphasisDots: true }, { text: '家。' }] },
    { label: 'explicit normal weight', rich: [{ text: '古い', bold: false }, { text: '家。' }] },
    {
      label: 'explicit default false attribute',
      rich: [{ text: '古い', italic: false }, { text: '家。' }],
    },
  ])(
    'keeps $label paragraphs readonly on cards and preserves native content/hash',
    async ({ rich }) => {
      const source = settingDocumentSeed();
      const description = fieldParagraph(source, '説明');
      description.rich = structuredClone(rich);
      description.text = rich.map(({ text }) => text).join('');
      const before = structuredClone(source);
      const beforeHash = await contentHash(source);
      const projected = card(source);
      expect(projected.fields.find(({ id }) => id === 'description')).toMatchObject({
        value: description.text,
        editable: false,
      });
      expect(
        projected.fields.filter(({ id }) => id !== 'description').every(({ editable }) => editable),
      ).toBe(true);
      expect(() =>
        editSettingFieldCommand(source, projected, 'description', '書式を失う置換'),
      ).toThrow(/元のLO見出し/);
      expect(await contentHash(source)).toBe(beforeHash);
      expect(source).toEqual(before);
      expect(card(source).fields.filter(({ id }) => id !== 'description')).toEqual(
        projected.fields.filter(({ id }) => id !== 'description'),
      );
    },
  );

  it('keeps text-only span paragraphs editable and preserves unrelated fields', () => {
    const source = settingDocumentSeed();
    const description = fieldParagraph(source, '説明');
    description.rich = [{ text: '海を見渡す' }, { text: '家。' }];
    description.text = '海を見渡す家。';
    const before = structuredClone(source);
    const projected = card(source);
    expect(projected.fields.find(({ id }) => id === 'description')?.editable).toBe(true);
    const next = editSettingFieldCommand(source, projected, 'description', '丘に建つ家。').apply(
      source,
    );
    expect(card(next).fields.find(({ id }) => id === 'description')).toMatchObject({
      value: '丘に建つ家。',
      editable: true,
    });
    expect(next.blocks.filter(({ id }) => id !== description.id)).toEqual(
      before.blocks.filter(({ id }) => id !== description.id),
    );
    expect(source).toEqual(before);
  });

  it('renames the source heading through native text without changing the LO identity', () => {
    const source = settingDocumentSeed();
    const current = card(source);
    const result = editSettingFieldCommand(source, current, 'name', '青い屋根の家').apply(source);
    expect(card(result)).toMatchObject({
      id: current.id,
      elementId: current.elementId,
      name: '青い屋根の家',
    });
    expect(result.blocks.filter(({ id }) => id !== current.elementId)).toEqual(
      source.blocks.filter(({ id }) => id !== current.elementId),
    );
  });

  it('refuses duplicate or malformed semantic IDs, duplicate native IDs and nested LO sections', () => {
    const source = settingDocumentSeed();
    const heading = source.blocks.find(({ id }) => id === card(source).elementId)!;
    const duplicate = structuredClone(source);
    duplicate.blocks.push({ ...heading, id: 'duplicate-heading' });
    expect(() => settingSourceCards(duplicate)).toThrow(/重複/);
    const nativeDuplicate = structuredClone(source);
    nativeDuplicate.blocks.push({ ...source.blocks[0] });
    expect(() => settingSourceCards(nativeDuplicate)).toThrow(/不正|重複/);
    const malformed = structuredClone(source);
    malformed.blocks[1].text = 'LO-1 識別子不明';
    malformed.blocks[1].rich = [{ text: malformed.blocks[1].text }];
    expect(() => settingSourceCards(malformed)).toThrow(/曖昧/);
    const nested = structuredClone(source);
    nested.blocks.push({
      id: 'nested-location',
      type: 'heading',
      level: 3,
      text: 'LO-02 小屋',
    });
    expect(() => settingSourceCards(nested)).toThrow(/入れ子/);
  });

  it('keeps unknown native structure readable and refuses card editing', () => {
    const source = settingDocumentSeed();
    source.blocks.splice(4, 0, {
      id: 'unhandled',
      type: 'code',
      text: 'retained native content',
    });
    const before = canonicalJson(source);
    const projected = card(source);
    expect(
      projected.fields.filter(({ id }) => id !== 'name').every(({ editable }) => !editable),
    ).toBe(true);
    expect(projected.summary).toContain('retained native content');
    expect(() => editSettingFieldCommand(source, projected, 'description', 'overwrite')).toThrow(
      /元のLO見出し/,
    );
    expect(canonicalJson(source)).toBe(before);
  });

  it('refuses ambiguous field paragraphs and duplicate field headings without removing them', () => {
    const source = settingDocumentSeed();
    source.blocks.splice(4, 0, {
      id: 'second-description',
      type: 'paragraph',
      text: '追加の説明。',
    });
    const projected = card(source);
    expect(projected.fields.find(({ id }) => id === 'description')).toMatchObject({
      editable: false,
    });
    expect(projected.summary).toContain('追加の説明。');
    expect(() => editSettingFieldCommand(source, projected, 'description', 'overwrite')).toThrow(
      /安全に部分編集/,
    );
    const duplicate = settingDocumentSeed();
    duplicate.blocks.push(
      { id: 'duplicate-history', type: 'heading', level: 3, text: '歴史' },
      { id: 'duplicate-history-text', type: 'paragraph', text: '別の歴史。' },
    );
    expect(
      card(duplicate)
        .fields.filter(({ id }) => id !== 'name')
        .every(({ editable }) => !editable),
    ).toBe(true);
    expect(() =>
      editSettingFieldCommand(duplicate, card(duplicate), 'history', 'overwrite'),
    ).toThrow();
  });

  it('rejects stale cards, changed exact bases and paragraphs moved into another location', () => {
    const seed = settingDocumentSeed();
    const source = createSettingSectionCommand(seed, '駅', '').apply(seed);
    const originalCard = card(source);
    const prepared = editSettingFieldCommand(source, originalCard, 'description', 'prepared');
    const changed = editSettingFieldCommand(
      source,
      originalCard,
      'history',
      '建てられて百年。',
    ).apply(source);
    expect(() => prepared.apply(changed)).toThrow(/changed/);
    expect(() =>
      editSettingFieldCommand(changed, originalCard, 'description', 'overwrite'),
    ).toThrow(/正本が変わり/);
    const moved = structuredClone(source);
    const description = fieldParagraph(moved, '説明');
    moved.blocks.splice(
      moved.blocks.findIndex(({ id }) => id === description.id),
      1,
    );
    moved.blocks.push(description);
    expect(() => editSettingFieldCommand(moved, originalCard, 'description', 'overwrite')).toThrow(
      /正本が変わり/,
    );
    expect(() => prepared.apply(moved)).toThrow(/changed/);
  });

  it('rejects invalid names, overlong fields and missing field targets before mutation', () => {
    const source = settingDocumentSeed();
    const before = canonicalJson(source);
    expect(() => createSettingSectionCommand(source, ' ', '')).toThrow();
    expect(() => createSettingSectionCommand(source, '場所\n見出し', '')).toThrow();
    expect(() =>
      editSettingFieldCommand(source, card(source), 'history', 'a'.repeat(20001)),
    ).toThrow();
    expect(() => editSettingFieldCommand(source, card(source), 'unknown', 'x')).toThrow();
    expect(() =>
      editSettingFieldCommand(source, { ...card(source), elementId: 'missing' }, 'history', 'x'),
    ).toThrow(/見出しがありません/);
    expect(canonicalJson(source)).toBe(before);
  });

  it('previews and rejects without mutation; acceptance is one native Undo transaction', async () => {
    const { editor } = await fixture();
    const before = canonicalJson(editor.content);
    const proposal = {
      id: 'setting-text',
      summary: '場所の歴史',
      baseLocalRevision: editor.revision,
      commands: [
        editSettingFieldCommand(
          editor.content,
          card(editor.content),
          'history',
          '百年前の船大工の家。',
        ),
      ],
    };
    editor.propose(proposal);
    expect(canonicalJson(editor.content)).toBe(before);
    editor.rejectProposal(proposal.id);
    expect(canonicalJson(editor.content)).toBe(before);
    editor.propose({ ...proposal, id: 'setting-text-accepted' });
    const result = editor.acceptProposal('setting-text-accepted');
    expect(result.changedElementIds).toEqual([fieldParagraph(editor.content, '歴史').id]);
    editor.undo();
    expect(canonicalJson(editor.content)).toBe(before);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(card(editor.content).fields.find(({ id }) => id === 'history')?.value).toContain(
      '船大工',
    );
  });

  it('checks trusted permission at headless edit, proposal acceptance, save and Undo boundaries', async () => {
    const { editor, access } = await fixture();
    const change = editSettingFieldCommand(
      editor.content,
      card(editor.content),
      'life',
      '毎朝、港へ歩く。',
    );
    editor.propose({
      id: 'revoked',
      summary: '生活',
      baseLocalRevision: editor.revision,
      commands: [change],
    });
    const before = canonicalJson(editor.content);
    access.edit = false;
    expect(() => editor.execute(change)).toThrow(/read-only/);
    expect(() => editor.acceptProposal('revoked')).toThrow(/read-only/);
    expect(() => editor.undo()).toThrow(/read-only/);
    await expect(editor.save()).rejects.toThrow(/read-only/);
    expect(canonicalJson(editor.content)).toBe(before);
    expect(editor.canUndo).toBe(false);
  });

  it('refuses a preview after a native source change and detects a changed exact source version', async () => {
    const { editor } = await fixture();
    const versionId = editor.artifact.draft.baseVersionId;
    const proposal = {
      id: 'old-source',
      summary: '歴史',
      baseLocalRevision: editor.revision,
      reads: { target: { artifactId: editor.id, versionId }, references: [] },
      commands: [
        editSettingFieldCommand(editor.content, card(editor.content), 'history', 'old proposal'),
      ],
    };
    editor.propose(proposal);
    editor.execute(
      editSettingFieldCommand(editor.content, card(editor.content), 'life', '現在の生活。'),
    );
    const current = canonicalJson(editor.content);
    expect(() => editor.acceptProposal(proposal.id)).toThrow(/changed after/);
    expect(canonicalJson(editor.content)).toBe(current);
    await editor.save({ commitVersion: true });
    const check = checkHostProposal(editor, proposal, () => undefined);
    expect(check.fresh).toBe(false);
    expect(check.stale.some(({ expectedVersionId }) => expectedVersionId === versionId)).toBe(true);
  });

  it('preserves failed saves and immutable versions, then saves and reloads all source fields', async () => {
    const { editor, access, initial, stored } = await fixture();
    const initialVersion = canonicalJson(initial.versions[0]);
    editor.execute(
      editSettingFieldCommand(
        editor.content,
        card(editor.content),
        'atmosphere',
        '雨音が屋根を静かにたたく。',
      ),
    );
    access.fail = true;
    await expect(editor.save({ commitVersion: true })).rejects.toThrow(
      /World notes storage failed/,
    );
    expect(editor.snapshot.dirty).toBe(true);
    expect(canonicalJson(stored())).toBe(canonicalJson(initial));
    expect(canonicalJson(editor.artifact.versions[0])).toBe(initialVersion);
    access.fail = false;
    await editor.save({ commitVersion: true });
    const reopened = await loadHostArtifact(
      serializeHostNativeArtifact(stored()),
      settingSourceAdapter,
    );
    expect(settingSourceCards(reopened.draft.content)).toEqual(settingSourceCards(editor.content));
    expect(reopened.draft.baseVersionId).toBe(editor.artifact.draft.baseVersionId);
    expect(reopened.versions).toHaveLength(2);
    expect(canonicalJson(reopened.versions[0])).toBe(initialVersion);
  });

  it('projects legacy free paragraphs and unknown child sections without rewriting the source', () => {
    const source: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        { id: 'world', type: 'heading', level: 1, text: '世界の覚え書き' },
        { id: 'legacy-place', type: 'heading', level: 2, text: 'LO-03 港の市場' },
        {
          id: 'legacy-description',
          type: 'paragraph',
          text: '朝の港には市場が開く。',
          rich: [{ text: '朝の港', bold: true }, { text: 'には市場が開く。' }],
        },
        { id: 'legacy-extra', type: 'paragraph', text: '船大工たちが道具を買いに来る。' },
        { id: 'legacy-heading', type: 'heading', level: 3, text: '祭りの記録' },
        { id: 'legacy-record', type: 'paragraph', text: '冬には灯りを飾る。' },
        { id: 'other-section', type: 'heading', level: 2, text: '交易の覚え書き' },
        { id: 'other-text', type: 'paragraph', text: 'この段落は場所の外。' },
      ],
    };
    const before = canonicalJson(source);
    const projected = card(source, 'LO-03');
    expect(projected.summary).toBe(
      '朝の港には市場が開く。\n\n船大工たちが道具を買いに来る。\n\n祭りの記録\n\n冬には灯りを飾る。',
    );
    expect(projected.fields.find(({ id }) => id === 'description')).toEqual({
      id: 'description',
      label: '説明',
      value: projected.summary,
      editable: false,
    });
    expect(projected.fields.find(({ id }) => id === 'name')).toMatchObject({
      value: '港の市場',
      editable: true,
    });
    expect(
      projected.fields.filter(({ id }) => id !== 'name').every(({ editable }) => !editable),
    ).toBe(true);
    expect(() => editSettingFieldCommand(source, projected, 'description', 'overwrite')).toThrow(
      /元のLO見出し/,
    );
    expect(settingSourceAdapter.validate(source)).toBe(true);
    expect(canonicalJson(source)).toBe(before);
  });

  it('offers plain heading names as fields and preserves their native LO prefix when renamed', () => {
    const source = settingDocumentSeed();
    const heading = source.blocks[1];
    heading.text = '  LO-01：風見の家  ';
    heading.rich = [{ text: heading.text }];
    const before = canonicalJson(source);
    const projected = card(source);
    expect(projected.fields.find(({ id }) => id === 'name')?.editable).toBe(true);
    const renamed = editSettingFieldCommand(source, projected, 'name', '青い屋根の家').apply(
      source,
    );
    expect(renamed.blocks[1].text).toBe('  LO-01：青い屋根の家');
    expect(card(renamed)).toMatchObject({
      id: 'LO-01',
      elementId: heading.id,
      name: '青い屋根の家',
    });
    expect(canonicalJson(source)).toBe(before);
  });

  it('keeps formatted heading names readonly on cards while native text editing retains formatting', () => {
    const source = settingDocumentSeed();
    const heading = source.blocks[1];
    heading.rich = [
      { text: 'LO-01 ', bold: true },
      { text: '風見の家', italic: true },
    ];
    const projected = card(source);
    expect(projected.fields.find(({ id }) => id === 'name')?.editable).toBe(false);
    const before = canonicalJson(source);
    expect(() => editSettingFieldCommand(source, projected, 'name', '青い家')).toThrow(
      /元のDocument/,
    );
    const native = documentTextEditCommand(source, [
      {
        segmentId: heading.id,
        start: 6,
        end: 10,
        expected: '風見の家',
        text: '青い家',
      },
    ]);
    const renamed = guardSettingSourceCommand(native).apply(source);
    expect(card(renamed)).toMatchObject({ id: 'LO-01', elementId: heading.id, name: '青い家' });
    expect(renamed.blocks[1].rich).toEqual([
      { text: 'LO-01 ', bold: true },
      { text: '青い家', italic: true },
    ]);
    expect(canonicalJson(source)).toBe(before);
  });

  it('guards native source edits against semantic/native LO identity changes, deletion and ambiguity', () => {
    const source = settingDocumentSeed();
    const before = canonicalJson(source);
    const variants: ((content: DocumentContent) => void)[] = [
      (value) => {
        value.blocks[1].text = 'LO-02 別の識別子';
        value.blocks[1].rich = [{ text: value.blocks[1].text }];
      },
      (value) => {
        value.blocks[1].id = 'replacement-native-heading';
      },
      (value) => {
        value.blocks.splice(1, 1);
      },
      (value) => {
        value.blocks[1].type = 'paragraph';
      },
      (value) => {
        value.blocks.push({ ...value.blocks[1], id: 'duplicate-semantic-heading' });
      },
      (value) => {
        value.blocks.push({
          id: 'nested-heading',
          type: 'heading',
          level: 3,
          text: 'LO-02 入れ子',
        });
      },
      (value) => {
        value.blocks[1].text = 'LO-';
        value.blocks[1].rich = [{ text: 'LO-' }];
      },
    ];
    for (const mutate of variants) {
      const session = new EditorSession(source);
      const revision = session.revision;
      const native = command(
        'document.native-test',
        'Edit native source',
        (value: DocumentContent) => {
          mutate(value);
          return value;
        },
      );
      const guarded = guardSettingSourceCommand(native);
      expect(() => guarded.apply(source)).toThrow();
      expect(canonicalJson(source)).toBe(before);
      expect(() => session.execute(guarded)).toThrow();
      expect(session.content).toEqual(source);
      expect(session.revision).toEqual(revision);
      expect(session.canUndo).toBe(false);
    }
  });

  it('rejects duplicate or nested source content at the public Host validation boundary', async () => {
    const { editor } = await fixture();
    const original = canonicalJson(editor.content);
    for (const nested of [false, true]) {
      const invalid = editor.content;
      invalid.blocks.push({
        id: nested ? 'invalid-nested-heading' : 'invalid-duplicate-heading',
        type: 'heading',
        level: nested ? 3 : 2,
        text: nested ? 'LO-02 入れ子' : 'LO-01 重複',
      });
      expect(settingSourceAdapter.validate(invalid)).toBe(false);
      expect(() =>
        editor.execute(command('invalid-source', 'Invalid source', () => invalid)),
      ).toThrow(/invalid native content/);
      expect(canonicalJson(editor.content)).toBe(original);
      expect(editor.canUndo).toBe(false);
    }
  });

  it('checks permission again when guarded native, card and creation commands apply', () => {
    const source = settingDocumentSeed();
    let writable = true;
    const mayEdit = () => writable;
    const change = editSettingFieldCommand(
      source,
      card(source),
      'history',
      '新しい歴史。',
      mayEdit,
    );
    const create = createSettingSectionCommand(source, '新しい場所', '', mayEdit);
    const native = guardSettingSourceCommand(
      documentTextEditCommand(source, [
        {
          segmentId: fieldParagraph(source, '説明').id,
          start: 0,
          end: 0,
          expected: '',
          text: '追記。',
        },
      ]),
      mayEdit,
    );
    const before = canonicalJson(source);
    writable = false;
    for (const operation of [change, create, native])
      expect(() => operation.apply(source)).toThrow(/read-only/);
    expect(canonicalJson(source)).toBe(before);
  });
});
