import { Decoration, DecorationSet } from 'prosemirror-view';
import { type EditorState } from 'prosemirror-state';
import { layoutDrawingText, type Drawing } from '@editor-platform/editor-core';
import { canvasTextValue } from './text-engine';
/** Display-only line breaks and fitted font sizes; the PM document retains the user's text. */
export function canvasTextLayout(state: EditorState, drawing: Drawing) {
  const value = canvasTextValue(state.doc, drawing.typography);
  const layout = layoutDrawingText({ ...drawing, ...value });
  const positions: number[] = [];
  let offset = 0;
  state.doc.forEach((paragraph, paragraphOffset, paragraphIndex) => {
    if (paragraphIndex) offset++;
    positions[offset] = paragraphOffset + 1;
    paragraph.forEach((node, childOffset) => {
      const length = node.isText ? node.text!.length : 1;
      for (let i = 0; i <= length; i++)
        positions[offset + i] = paragraphOffset + 1 + childOffset + i;
      offset += length;
    });
  });
  const decorations: Decoration[] = [];
  let textOffset = 0;
  layout.lines.forEach((line, i) => {
    textOffset += line.runs.reduce((length, run) => length + run.text.length, 0);
    if (i === layout.lines.length - 1) return;
    if (value.text[textOffset] === '\n') {
      textOffset++;
      return;
    }
    const position = positions[textOffset];
    if (position !== undefined)
      decorations.push(
        Decoration.widget(position, () => document.createElement('br'), {
          side: -1,
          ignoreSelection: true,
          key: `soft-wrap-${position}`,
        }),
      );
  });
  const original = drawing.typography?.fontSize ?? (drawing.kind === 'text' ? 28 : 18);
  state.doc.descendants((node, position) => {
    if (!node.isText) return;
    const size = node.marks.find((mark) => mark.type.name === 'fontSize')?.attrs.value ?? original;
    decorations.push(
      Decoration.inline(position, position + node.nodeSize, {
        style: `font-size:${Math.max(8, (size * layout.fontSize) / original)}px`,
      }),
    );
  });
  return { layout, decorations: DecorationSet.create(state.doc, decorations) };
}
