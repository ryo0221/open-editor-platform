import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { contentToNode, documentSchema, insertDocumentBreak, nodeToContent } from './engine';
import type { DocumentContent } from './model';

describe('document line break', () => {
  for (const type of ['paragraph', 'heading', 'code'] as const)
    it(`keeps the ${type} identity and round-trips its line break`, () => {
      const content: DocumentContent = {
        schemaVersion: 2,
        blocks: [
          { id: 'body', type, text: 'beforeafter', ...(type === 'heading' ? { level: 2 } : {}) },
        ],
      };
      let state = EditorState.create({ doc: contentToNode(content) });
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7)));
      let count = 0;
      expect(
        insertDocumentBreak(state, (tr) => {
          count++;
          state = state.apply(tr);
        }),
      ).toBe(true);
      expect(count).toBe(1);
      expect(state.doc.childCount).toBe(1);
      expect(state.doc.firstChild!.attrs.id).toBe('body');
      expect(state.doc.firstChild!.type.name).toBe(type === 'code' ? 'code_block' : type);
      const native = nodeToContent(state.doc, content);
      expect(native.blocks[0].text).toBe('before\nafter');
      expect(contentToNode(native).eq(state.doc)).toBe(true);
    });

  it('replaces selected text without creating a paragraph', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: 'one two three' }],
    };
    let state = EditorState.create({ doc: contentToNode(content) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5, 8)));
    insertDocumentBreak(state, (tr) => {
      state = state.apply(tr);
    });
    expect(nodeToContent(state.doc, content).blocks[0].text).toBe('one \n three');
    expect(state.doc.childCount).toBe(1);
  });
  it('retains active formatting for subsequent text without marking the break itself', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: 'bold', rich: [{ text: 'bold', bold: true }] }],
    };
    let state = EditorState.create({ doc: contentToNode(content) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)));
    insertDocumentBreak(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.storedMarks).toContainEqual(documentSchema.marks.bold.create());
    state = state.apply(state.tr.insertText('next'));
    const native = nodeToContent(state.doc, content);
    expect(native.blocks[0].rich).toEqual([
      { text: 'bold', bold: true },
      { text: '\n' },
      { text: 'next', bold: true },
    ]);
    expect(contentToNode(native).eq(state.doc)).toBe(true);
  });
});
