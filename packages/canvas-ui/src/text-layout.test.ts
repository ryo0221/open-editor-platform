import { expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { layoutDrawingText, type Drawing } from '@editor-platform/editor-core';
import { canvasTextDocument, canvasTextValue } from './text-engine';
import { canvasTextLayout } from './text-layout';
it('maps display-only Japanese/emoji wraps across paragraph and marked positions without changing text', () => {
  const text = '日本語🙂を折り返して編集\n\n段落末尾',
    runs = [{ text: '日本語🙂', style: { bold: true, fontSize: 30 } }, { text: text.slice(5) }];
  const drawing: Drawing = {
    id: 'text',
    kind: 'text',
    bounds: { x: 20, y: 30, width: 100, height: 160 },
    text,
    runs,
    fill: '#000000',
    typography: { padding: 12, fontSize: 22, overflow: 'fit', verticalAlign: 'middle' },
  };
  const state = EditorState.create({ doc: canvasTextDocument(text, runs) }),
    before = state.doc.toJSON();
  const result = canvasTextLayout(state, drawing);
  expect(result.layout).toEqual(layoutDrawingText({ ...drawing, ...canvasTextValue(state.doc) }));
  expect(
    result.decorations.find().some((decoration) => decoration.spec.key?.startsWith('soft-wrap-')),
  ).toBe(true);
  for (const decoration of result.decorations.find()) {
    expect(decoration.from).toBeGreaterThan(0);
    expect(decoration.to).toBeLessThan(state.doc.content.size);
    if (decoration.spec.key)
      expect(state.doc.resolve(decoration.from).parent.type.name).toBe('paragraph');
  }
  expect(state.doc.toJSON()).toEqual(before);
  expect(canvasTextValue(state.doc).text).toBe(text);
  expect(result.layout.fontSize).toBeLessThanOrEqual(22);
});
