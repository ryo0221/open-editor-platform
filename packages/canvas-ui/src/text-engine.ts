import { Schema, type MarkSpec, type Node as PMNode } from 'prosemirror-model';
import { normalizedRuns, type TextRun, type TextStyle } from '@editor-platform/editor-core';
import type { EditorState } from 'prosemirror-state';

export const canvasTextMarks: Record<string, MarkSpec> = {};
for (const [name, tag, css] of [
  ['bold', 'strong', 'font-weight'],
  ['italic', 'em', 'font-style'],
  ['underline', 'u', 'text-decoration'],
  ['strike', 's', 'text-decoration'],
])
  canvasTextMarks[name] = {
    toDOM: () => [tag, 0],
    parseDOM: [
      { tag },
      {
        style: css,
        getAttrs: (value) =>
          (
            name === 'bold'
              ? /bold|[6-9]00/.test(value)
              : name === 'italic'
                ? value === 'italic'
                : value.includes(name === 'underline' ? 'underline' : 'line-through')
          )
            ? null
            : false,
      },
    ],
  };
canvasTextMarks.color = {
  attrs: { value: {} },
  toDOM: (mark) => ['span', { style: `color:${mark.attrs.value}` }, 0],
  parseDOM: [
    {
      style: 'color',
      getAttrs: (value) => {
        if (/^#[0-9a-f]{3,8}$/i.test(value)) return { value };
        const match = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
        return match
          ? {
              value:
                '#' +
                match
                  .slice(1)
                  .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
                  .join(''),
            }
          : false;
      },
    },
  ],
};
canvasTextMarks.fontSize = {
  attrs: { value: {} },
  toDOM: (mark) => ['span', { style: `font-size:${mark.attrs.value}px` }, 0],
  parseDOM: [
    {
      style: 'font-size',
      getAttrs: (value) =>
        /^\d+(\.\d+)?px$/.test(value) && parseFloat(value) >= 8 && parseFloat(value) <= 300
          ? { value: parseFloat(value) }
          : false,
    },
  ],
};
canvasTextMarks.fontFamily = {
  attrs: { value: {} },
  toDOM: (mark) => ['span', { style: `font-family:${mark.attrs.value}` }, 0],
  parseDOM: [
    {
      style: 'font-family',
      getAttrs: (value) => (/^[a-zA-Z ,'-]+$/.test(value) ? { value } : false),
    },
  ],
};
export const canvasTextSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }, { tag: 'div' }],
    },
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
  },
  marks: canvasTextMarks,
});
export function canvasTextDocument(text: string, runs?: TextRun[], base: TextStyle = {}): PMNode {
  const paragraphs: PMNode[][] = [[]];
  for (const run of normalizedRuns(text, runs)) {
    const styles = Object.entries({ ...base, ...run.style }).flatMap(([name, value]) =>
      canvasTextSchema.marks[name] && value !== false && value !== undefined
        ? [canvasTextSchema.marks[name].create(typeof value === 'boolean' ? undefined : { value })]
        : [],
    );
    run.text.split('\n').forEach((part, i) => {
      if (i) paragraphs.push([]);
      if (part) paragraphs.at(-1)!.push(canvasTextSchema.text(part, styles));
    });
  }
  return canvasTextSchema.nodes.doc.create(
    null,
    paragraphs.map((nodes) => canvasTextSchema.nodes.paragraph.create(null, nodes)),
  );
}
export function canvasTextValue(
  doc: PMNode,
  base: TextStyle = {},
): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  doc.forEach((paragraph, _, index) => {
    if (index) runs.push({ text: '\n' });
    paragraph.forEach((node) => {
      const style: TextStyle = {};
      for (const mark of node.marks)
        Object.assign(style, { [mark.type.name]: mark.attrs.value ?? true });
      // Absence of an engine mark means an explicit removal when the base is true.
      // Check before removing redundant inherited values from the native run.
      for (const name of ['bold', 'italic', 'underline', 'strike'] as const)
        if (base[name] && !style[name]) style[name] = false;
      for (const name of Object.keys(style) as (keyof TextStyle)[])
        if (style[name] === base[name]) delete style[name];
      runs.push({ text: node.isText ? node.text! : '\n', style });
    });
  });
  const text = runs.map((r) => r.text).join('');
  return { text, runs: normalizedRuns(text, runs) };
}
/** Convert an Inspector text edit to the smallest engine replacement, including newlines. */
export function canvasTextReplacement(
  state: EditorState,
  text: string,
  runs?: TextRun[],
  base: TextStyle = {},
) {
  const next = canvasTextDocument(text, runs, base),
    start = state.doc.content.findDiffStart(next.content);
  if (start === null) return state.tr;
  const end = state.doc.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(end.a, end.b);
  if (overlap > 0) {
    end.a += overlap;
    end.b += overlap;
  }
  return state.tr.replace(start, end.a, next.slice(start, end.b));
}
