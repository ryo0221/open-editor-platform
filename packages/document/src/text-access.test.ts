import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { contentToNode, nodeToContent } from './engine';
import type { DocumentContent } from './model';
import {
  documentText,
  documentTextEditCommand,
  findDocumentText,
  locateDocumentText,
} from './text-access';

const authored = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'title', type: 'heading', level: 1, text: 'Plan' },
    {
      id: 'body',
      type: 'paragraph',
      text: 'first line\nsecond line\nthird',
      rich: [{ text: 'first ' }, { text: 'line', bold: true }, { text: '\nsecond line\nthird' }],
    },
    {
      id: 'list',
      type: 'bulleted-list',
      text: '',
      items: [
        { id: 'a', paragraphId: 'a:text', rich: [{ text: 'alpha' }] },
        { id: 'b', paragraphId: 'b:text', rich: [{ text: 'beta' }] },
      ],
    },
    { id: 'code', type: 'code', language: 'ts', text: 'let a = 1;\nlet b = 2;' },
    { id: 'image', type: 'image', text: '', src: 'data:image/png;base64,AA==', alt: '' },
  ],
});

// The engine's native projection, as a Document Surface saves it.
const content = () => {
  const doc = authored();
  return nodeToContent(contentToNode(doc), doc);
};
describe('Document text for external tools', () => {
  it('keeps native hard_break as a newline that ProseMirror textContent drops', () => {
    const doc = content();
    // The Adapter bug this replaces: textContent has no character for hard_break.
    expect(contentToNode(doc).child(1).textContent).toBe('first linesecond linethird');
    const value = documentText(doc);
    expect(value.segments.map((s) => [s.id, s.blockId])).toEqual([
      ['title', 'title'],
      ['body', 'body'],
      ['a:text', 'list'],
      ['b:text', 'list'],
      ['code', 'code'],
    ]);
    const body = value.segments[1];
    expect(value.text.slice(body.start, body.end)).toBe('first line\nsecond line\nthird');
    expect(value.text).toBe(
      'Plan\n\nfirst line\nsecond line\nthird\n\nalpha\n\nbeta\n\nlet a = 1;\nlet b = 2;',
    );
  });

  it('replaces one unique range across a hard_break with native positions and stable IDs', () => {
    const doc = content();
    const range = findDocumentText(doc, 'line\nsecond');
    expect(range).toEqual({ segmentId: 'body', start: 6, end: 17, expected: 'line\nsecond' });
    const session = new EditorSession(doc);
    session.execute(documentTextEditCommand(doc, [{ ...range, text: 'row\nnext\n2nd' }]));
    const next = session.content;
    expect(next.blocks.map((b) => b.id)).toEqual(doc.blocks.map((b) => b.id));
    expect(next.blocks[1].text).toBe('first row\nnext\n2nd line\nthird');
    // Adjacent characters and formatting of the first replaced character are kept.
    expect(next.blocks[1].rich).toEqual([
      { text: 'first ' },
      { text: 'row', bold: true },
      { text: '\n' },
      { text: 'next', bold: true },
      { text: '\n' },
      { text: '2nd', bold: true },
      { text: ' line' },
      { text: '\n' },
      { text: 'third' },
    ]);
    expect(next.blocks.filter((_, i) => i !== 1)).toEqual(doc.blocks.filter((_, i) => i !== 1));
    // Native round trip through the engine is exact.
    expect(contentToNode(next).eq(contentToNode(nodeToContent(contentToNode(next), next)))).toBe(
      true,
    );
    session.undo();
    expect(session.content).toEqual(doc);
  });

  it('maps a whole-text range to a segment and edits code and list paragraphs', () => {
    const doc = content();
    const value = documentText(doc);
    const at = value.text.indexOf('let b');
    const code = locateDocumentText(value, at, at + 5);
    expect(code).toEqual({ segmentId: 'code', start: 11, end: 16, expected: 'let b' });
    const beta = findDocumentText(doc, 'beta');
    const next = documentTextEditCommand(doc, [
      { ...code, text: 'const b' },
      { ...beta, text: 'gamma' },
    ]).apply(doc);
    expect(next.blocks[3].text).toBe('let a = 1;\nconst b = 2;');
    expect(next.blocks[2].items!.map((i) => [i.id, i.paragraphId, i.rich])).toEqual([
      ['a', 'a:text', [{ text: 'alpha' }]],
      ['b', 'b:text', [{ text: 'gamma' }]],
    ]);
  });

  it('refuses ambiguous, missing, cross-segment, stale and overlapping ranges', () => {
    const doc = content();
    expect(() => findDocumentText(doc, 'line')).toThrow(/2 times/);
    expect(() => findDocumentText(doc, 'absent')).toThrow(/not found/);
    const value = documentText(doc);
    expect(() => locateDocumentText(value, 0, value.text.indexOf('first') + 3)).toThrow(
      /inside one/,
    );
    expect(() =>
      documentTextEditCommand(doc, [
        { segmentId: 'body', start: 0, end: 5, expected: 'other', text: 'x' },
      ]),
    ).toThrow(/changed/);
    expect(() =>
      documentTextEditCommand(doc, [
        { segmentId: 'body', start: 0, end: 5, expected: 'first', text: 'x' },
        { segmentId: 'body', start: 3, end: 8, expected: 'st li', text: 'y' },
      ]),
    ).toThrow(/overlap/);
    expect(() =>
      documentTextEditCommand(doc, [
        { segmentId: 'image', start: 0, end: 0, expected: '', text: 'x' },
      ]),
    ).toThrow(/Unknown/);
    // A command prepared on an older draft is refused when applied to a changed one.
    const command = documentTextEditCommand(doc, [
      { ...findDocumentText(doc, 'Plan'), text: 'Goal' },
    ]);
    const changed = { ...doc, blocks: doc.blocks.slice(1) };
    expect(() => command.apply(changed)).toThrow(/changed before/);
  });
});
