import { expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { canvasTextDocument, canvasTextSchema, canvasTextValue } from './text-engine';

const base = { bold: true, italic: true, underline: true, strike: true, fontSize: 28 };
it('preserves inherited boolean formatting after appending text and native roundtrip', () => {
  const state = EditorState.create({
    doc: canvasTextDocument('Hello', undefined, base),
  });
  const edited = state.apply(state.tr.insertText('!', 6));
  const native = canvasTextValue(edited.doc, base);
  expect(native.text).toBe('Hello!');
  expect(native.runs.every((run) => Object.keys(run.style ?? {}).length === 0)).toBe(true);
  const reopened = canvasTextDocument(native.text, native.runs, base);
  expect(reopened).toEqual(edited.doc);
});

it.each(['bold', 'italic', 'underline', 'strike'] as const)(
  'preserves an explicit %s removal only on the selected text',
  (name) => {
    let state = EditorState.create({
      doc: canvasTextDocument('Hello', undefined, base),
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 4)));
    toggleMark(canvasTextSchema.marks[name])(state, (transaction) => {
      state = state.apply(transaction);
    });
    const native = canvasTextValue(state.doc, base);
    expect(native.runs).toEqual([
      { text: 'H' },
      { text: 'el', style: { [name]: false } },
      { text: 'lo' },
    ]);
    const reopened = canvasTextDocument(native.text, native.runs, base);
    expect(reopened).toEqual(state.doc);
  },
);
