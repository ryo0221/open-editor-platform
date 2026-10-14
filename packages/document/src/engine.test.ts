import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlock, toggleMark } from 'prosemirror-commands';
import { addRowAfter, addColumnAfter } from 'prosemirror-tables';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  contentToNode,
  nodeToContent,
  documentSchema,
  stableIds,
  captureDocumentUpdate,
  replayDocumentUpdate,
  documentUpdateCommand,
  formatBlock,
} from './engine';
import { type DocumentContent, documentTextBlocks, isDocument } from './model';
const base: DocumentContent = {
  schemaVersion: 2,
  blocks: [
    { id: 'title', type: 'heading', text: '提案書', level: 1 },
    {
      id: 'body',
      type: 'paragraph',
      text: 'One two three',
      rich: [{ text: 'One ' }, { text: 'two', bold: true }, { text: ' three' }],
    },
  ],
};
function state(content = base) {
  return EditorState.create({ doc: contentToNode(content), plugins: [stableIds] });
}
describe('document engine boundary', () => {
  it('keeps merged-cell text anchors after native engine content crosses JSON transport', () => {
    const source: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        {
          id: 'table',
          type: 'table',
          text: '',
          cells: [
            ['merged', '', 'tail'],
            ['bottom', 'other', 'last'],
          ],
          merges: [{ row: 0, col: 0, rows: 1, cols: 2 }],
        },
      ],
    };
    const local = nodeToContent(contentToNode(source), source),
      wire = JSON.parse(JSON.stringify(local)) as DocumentContent;
    expect(wire.blocks[0].cellParagraphs![0][1]).toBeNull();
    expect(isDocument(wire)).toBe(true);
    const blocks = documentTextBlocks(wire);
    expect(blocks).toEqual(documentTextBlocks(local));
    expect([...blocks.keys()].every((id) => typeof id === 'string' && !!id)).toBe(true);
    expect([...blocks.values()]).toContain('merged');
    expect(nodeToContent(contentToNode(wire), wire).blocks[0].merges).toEqual(
      source.blocks[0].merges,
    );
  });
  it('replays a captured IME-like text/mark transaction and its inverse, retaining range mapping', () => {
    const s = state(),
      tr = s.tr.insertText('日本語', 10, 10).addMark(10, 13, documentSchema.marks.italic.create());
    const result = s.applyTransaction(tr),
      update = JSON.parse(JSON.stringify(captureDocumentUpdate(result.transactions)));
    const replay = replayDocumentUpdate(s.doc, update);
    expect(replay.doc.eq(result.state.doc)).toBe(true);
    expect(replay.mapping.map(13)).toBe(16);
    expect(replayDocumentUpdate(replay.doc, update, true).doc.eq(s.doc)).toBe(true);
    const cmd = documentUpdateCommand(base, update, { origin: 'local', transactionId: 'typing-1' });
    expect(cmd.apply(base)).toEqual(cmd.apply(base));
    expect(() => cmd.apply({ ...base, blocks: [] })).toThrow('draft changed');
    const mutable = structuredClone(base);
    const owned = documentUpdateCommand(mutable, update, {
      origin: 'local',
      transactionId: 'owned-typing',
    });
    mutable.blocks[1].text = 'changed after preparation';
    expect(() => owned.apply(mutable)).toThrow('draft changed');
    expect(owned.apply(base)).toEqual(cmd.apply(base));
    expect(() => replayDocumentUpdate(replay.doc, update)).toThrow('stale');
  });
  it('retains block IDs through heading changes, assigns split IDs once, and persists the split', () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 9)));
    formatBlock(
      s,
      (tr) => {
        s = s.applyTransaction(tr).state;
      },
      'heading',
      2,
    );
    expect(s.doc.child(1).attrs.id).toBe('body');
    expect(s.doc.child(1).attrs.level).toBe(2);
    const before = s;
    let transactions: ReturnType<EditorState['applyTransaction']>['transactions'] = [];
    splitBlock(s, (tr) => {
      const result = s.applyTransaction(tr);
      s = result.state;
      transactions = result.transactions;
    });
    const update = captureDocumentUpdate(transactions),
      ids = Array.from({ length: s.doc.childCount }, (_, i) => s.doc.child(i).attrs.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('body');
    expect(replayDocumentUpdate(before.doc, update).doc.eq(s.doc)).toBe(true);
    expect(contentToNode(nodeToContent(s.doc, base)).eq(s.doc)).toBe(true);
  });
  it('round trips nested list IDs/checks and table cell marks/geometry without private engine state in the model', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        {
          id: 'list',
          type: 'check-list',
          text: 'a\nb',
          items: [
            {
              id: 'item-a',
              checked: true,
              rich: [{ text: 'a', italic: true }],
              children: [{ id: 'item-b', checked: false, rich: [{ text: 'b' }] }],
            },
          ],
        },
        {
          id: 'table',
          type: 'table',
          text: '',
          cells: [
            ['A', 'B'],
            ['C', 'D'],
          ],
          cellRich: [
            [[{ text: 'A', bold: true }], [{ text: 'B' }]],
            [[{ text: 'C' }], [{ text: 'D', underline: true }]],
          ],
          columnWidths: [120, 200],
        },
      ],
    };
    const doc = contentToNode(content),
      serialized = nodeToContent(doc, content);
    expect(contentToNode(serialized).eq(doc)).toBe(true);
    expect(serialized.blocks[0].items?.[0].children?.[0].id).toBe('item-b');
    expect(serialized.blocks[1].cellRich?.[1][1][0].underline).toBe(true);
    expect(canonicalJson(serialized)).not.toContain('prosemirror');
  });
  it('preserves adjacent nested ordered and bullet lists without flattening their identities', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        {
          id: 'outline',
          type: 'bulleted-list',
          text: '親\n番号\n箇条書き',
          items: [
            {
              id: 'parent',
              rich: [{ text: '親' }],
              childLists: [
                {
                  id: 'ordered',
                  type: 'ordered_list',
                  items: [{ id: 'numbered', rich: [{ text: '番号', bold: true }] }],
                },
                {
                  id: 'bullets',
                  type: 'bullet_list',
                  items: [{ id: 'bullet', rich: [{ text: '箇条書き' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const node = contentToNode(content),
      stored = nodeToContent(node, content);
    expect(contentToNode(stored).eq(node)).toBe(true);
    expect(stored.blocks[0].items![0].childLists!.map((list) => [list.id, list.type])).toEqual([
      ['ordered', 'ordered_list'],
      ['bullets', 'bullet_list'],
    ]);
    expect(stored.blocks[0].text).toBe('親\n番号\n箇条書き');
  });
  it('keeps table insert operations as one valid replayable batch', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        {
          id: 'table',
          type: 'table',
          text: '',
          cells: [
            ['A', 'B'],
            ['C', 'D'],
          ],
        },
      ],
    };
    let s = state(content);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 4)));
    const initial = s;
    const batches: import('prosemirror-state').Transaction[] = [];
    for (const op of [addRowAfter, addColumnAfter])
      expect(
        op(s, (tr) => {
          const next = s.applyTransaction(tr);
          s = next.state;
          batches.push(...next.transactions);
        }),
      ).toBe(true);
    s.doc.check();
    const result = replayDocumentUpdate(initial.doc, captureDocumentUpdate(batches));
    expect(result.doc.eq(s.doc)).toBe(true);
    const stored = nodeToContent(s.doc, content);
    expect(stored.blocks[0].cells).toHaveLength(3);
    expect(stored.blocks[0].cells?.[0]).toHaveLength(3);
    expect(contentToNode(stored).eq(s.doc)).toBe(true);
  });
  it('retains engine-native marks across semantic persistence', () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 6, 9)));
    toggleMark(documentSchema.marks.underline)(s, (tr) => {
      s = s.applyTransaction(tr).state;
    });
    expect(contentToNode(nodeToContent(s.doc, base)).eq(s.doc)).toBe(true);
  });
});
