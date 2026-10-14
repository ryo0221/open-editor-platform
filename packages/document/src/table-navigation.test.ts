import { it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { goToNextCell, selectedRect, TableMap } from 'prosemirror-tables';
import {
  contentToNode,
  nodeToContent,
  addTableRowAndSelect,
  nextTableCell,
  stableIds,
} from './engine';
import { type DocumentContent } from './model';
it('adds a row and selects its same column in the single transaction; Tab advances and appends only at the last cell', () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'table',
        type: 'table',
        text: '',
        cells: [
          ['見出し', '金額'],
          ['既存', '12'],
        ],
      },
    ],
  };
  let state = EditorState.create({ doc: contentToNode(content), plugins: [stableIds] });
  const map = TableMap.get(state.doc.firstChild!);
  state = state.apply(
    state.tr.setSelection(TextSelection.near(state.doc.resolve(1 + map.map[1] + 1))),
  );
  let count = 0;
  addTableRowAndSelect(state, (tr) => {
    count++;
    state = state.apply(tr);
  });
  expect(count).toBe(1);
  expect(selectedRect(state).left).toBe(1);
  expect(selectedRect(state).top).toBe(1);
  state = state.apply(state.tr.insertText('1.5'));
  expect(nodeToContent(state.doc, content).blocks[0].cells![1]).toEqual(['', '1.5']);
  goToNextCell(-1)(state, (tr) => {
    state = state.apply(tr);
  });
  expect(selectedRect(state).left).toBe(0);
  const nextMap = TableMap.get(state.doc.firstChild!);
  state = state.apply(
    state.tr.setSelection(TextSelection.near(state.doc.resolve(1 + nextMap.map.at(-1)! + 1))),
  );
  nextTableCell(state, (tr) => {
    state = state.apply(tr);
  });
  expect(nodeToContent(state.doc, content).blocks[0].cells).toHaveLength(4);
  expect(selectedRect(state).top).toBe(3);
});
