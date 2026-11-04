import { expect, it } from 'vitest';
import { createArtifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { contentToNode, nodeToContent } from './engine';
import { isDocument, type DocumentContent } from './model';
import { documentChangedElementIds } from './proposal-diff';
import { documentTextAccess, documentTextEditCommand } from './text-access';

const adapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  text: documentTextAccess,
  changedElements: documentChangedElementIds,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
const authored = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'p1', type: 'paragraph', text: '朝が来た。' },
    { id: 'p2', type: 'paragraph', text: '彼は窓を開けた。' },
    { id: 'p3', type: 'paragraph', text: '鍵は机の上にある。' },
    { id: 'p4', type: 'paragraph', text: '風が冷たい。' },
  ],
});

// The engine's native projection, as a Document Surface saves it.
const chapter = () => {
  const doc = authored();
  return nodeToContent(contentToNode(doc), doc);
};

it('names only the paragraphs an accepted proposal rewrote', () => {
  const host = new ArtifactEditor(createArtifact('document', 'Chapter 1', chapter()), adapter, {
    put: async () => {},
  });
  host.propose({
    id: 'rewrite',
    summary: 'Rewrite two lines',
    commands: [
      documentTextEditCommand(host.content, [
        { segmentId: 'p2', start: 2, end: 8, expected: '窓を開けた。', text: 'カーテンを引いた。' },
        { segmentId: 'p4', start: 0, end: 1, expected: '風', text: '夜風' },
      ]),
    ],
  });
  const accepted = host.acceptProposal('rewrite');
  // The author's own paragraphs (p1, p3) are not listed, so a Host can tell them apart.
  expect(accepted).toMatchObject({ outcome: 'accepted', changedElementIds: ['p2', 'p4'] });
  host.undo();
  expect(host.content.blocks[1].text).toBe('彼は窓を開けた。');
});

it('names every list item and table paragraph inside an added or removed container', () => {
  const base = chapter();
  const list = {
    id: 'l',
    type: 'bulleted-list' as const,
    text: '鍵\n手紙',
    items: [
      { id: 'i1', rich: [{ text: '鍵' }] },
      { id: 'i2', rich: [{ text: '手紙' }] },
    ],
  };
  const table = { id: 't', type: 'table' as const, text: '', cells: [['名前', '年齢']] };
  const added = { ...base, blocks: [...base.blocks, list, table] };
  expect(documentChangedElementIds(base, added)).toEqual([
    'l',
    'i1',
    'i2',
    't',
    't:cell:0:0',
    't:cell:0:1',
  ]);
  expect(documentChangedElementIds(added, base)).toEqual([
    'l',
    'i1',
    'i2',
    't',
    't:cell:0:0',
    't:cell:0:1',
  ]);
  // A new item in an existing list is named by itself.
  const longer = {
    ...added,
    blocks: added.blocks.map((b) =>
      b.id === 'l' ? { ...list, items: [...list.items, { id: 'i3', rich: [{ text: '傘' }] }] } : b,
    ),
  };
  expect(documentChangedElementIds(added, longer)).toEqual(['i3']);
});
