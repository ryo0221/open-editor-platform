import { describe, expect, it } from 'vitest';
import { contentToNode, nodeToContent } from './engine';
import { documentCharacterCount, manuscriptPaperEstimate } from './manuscript';
import type { DocumentContent } from './model';

const authored = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'title', type: 'heading', level: 1, text: '第一章 雨' },
    {
      id: 'p1',
      type: 'paragraph',
      text: '　雨が降った。\n彼は傘を持たない。',
      rich: [
        { text: '　雨が' },
        { text: '降った', bold: true },
        { text: '。\n彼は傘を持たない。' },
      ],
    },
    { id: 'note', type: 'paragraph', text: '作者メモ', hidden: true },
    {
      id: 'list',
      type: 'bulleted-list',
      text: '',
      items: [{ id: 'a', paragraphId: 'a:text', rich: [{ text: '👩‍👩‍👧 家族' }] }],
    },
    { id: 'image', type: 'image', text: '', src: 'data:image/png;base64,AA==', alt: '挿絵' },
  ],
});
// The engine's native projection, as a Document Surface saves it.
const content = () => {
  const doc = authored();
  return nodeToContent(contentToNode(doc), doc);
};

describe('Document character count', () => {
  it('counts graphemes without whitespace, line breaks, hidden or embedded blocks by default', () => {
    const result = documentCharacterCount(content());
    expect(result.segments).toEqual([
      { id: 'title', blockId: 'title', count: 4 },
      { id: 'p1', blockId: 'p1', count: 15 },
      { id: 'a:text', blockId: 'list', count: 3 },
    ]);
    expect(result.total).toBe(22);
    expect(result.rule).toEqual({
      unit: 'grapheme',
      whitespace: false,
      lineBreaks: false,
      hidden: false,
    });
  });

  it('follows each counting option and echoes it', () => {
    const doc = content();
    expect(documentCharacterCount(doc, { whitespace: true }).total).toBe(25);
    expect(documentCharacterCount(doc, { lineBreaks: true }).total).toBe(23);
    const hidden = documentCharacterCount(doc, { hidden: true });
    expect(hidden.total).toBe(26);
    expect(hidden.segments.map((s) => s.id)).toContain('note');
    // The family emoji is one grapheme but five code points.
    expect(documentCharacterCount(doc, { unit: 'codepoint' }).total).toBe(26);
    expect(documentCharacterCount(doc, { unit: undefined }).rule.unit).toBe('grapheme');
  });

  it('returns the same result for the same input and does not change the content', () => {
    const doc = content();
    const before = JSON.stringify(doc);
    expect(documentCharacterCount(doc)).toEqual(documentCharacterCount(content()));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('counts an authored CRLF as one line break', () => {
    const authoredCrlf: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: 'a\r\nb' }],
    };
    const doc = nodeToContent(contentToNode(authoredCrlf), authoredCrlf);
    expect(documentCharacterCount(doc).total).toBe(2);
    expect(documentCharacterCount(doc, { lineBreaks: true }).total).toBe(3);
    expect(documentCharacterCount(doc, { whitespace: true }).total).toBe(2);
    expect(manuscriptPaperEstimate(doc, { columns: 1 }).lines).toBe(2);
  });

  it('refuses unknown counting rules', () => {
    expect(() =>
      documentCharacterCount(content(), { unit: 'byte' as unknown as 'grapheme' }),
    ).toThrow('unit');
    expect(() =>
      documentCharacterCount(content(), { hidden: 'yes' as unknown as boolean }),
    ).toThrow('hidden');
  });
});

describe('Manuscript paper estimate', () => {
  it('fills one cell per grapheme and starts a line per paragraph and hard_break', () => {
    const doc: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        { id: 'a', type: 'paragraph', text: 'あ'.repeat(41) },
        { id: 'b', type: 'paragraph', text: '' },
        { id: 'c', type: 'paragraph', text: '　短い。\n次の行。' },
      ],
    };
    expect(manuscriptPaperEstimate(doc)).toEqual({
      sheets: 1,
      lines: 6,
      columns: 20,
      rows: 20,
      lineBreaking: 'kinsoku',
      approximate: true,
    });
    expect(manuscriptPaperEstimate(doc, { columns: 10, rows: 4 })).toMatchObject({
      sheets: 2,
      lines: 8,
    });
  });

  it('lays lines out with kinsoku, hanging punctuation and unbroken ruby bases', () => {
    const line = (text: string, rich?: NonNullable<DocumentContent['blocks'][0]['rich']>) =>
      manuscriptPaperEstimate(
        {
          schemaVersion: 2,
          blocks: [{ id: 'p', type: 'paragraph', text, ...(rich ? { rich } : {}) }],
        },
        { columns: 4 },
      ).lines;
    // 。 hangs past the fourth cell instead of starting a line.
    expect(line('あいうえ。')).toBe(1);
    // 」 cannot start a line, so え」 move to the next one.
    expect(line('あいうえ」か')).toBe(2);
    // A ruby base is never split: 東京 moves whole.
    const ruby = { text: 'とうきょう', base: '東京' };
    expect(line('あいう東京かきく')).toBe(2);
    expect(
      line('あいう東京かきく', [{ text: 'あいう' }, { text: '東京', ruby }, { text: 'かきく' }]),
    ).toBe(3);
    expect(
      manuscriptPaperEstimate(
        { schemaVersion: 2, blocks: [{ id: 'p', type: 'paragraph', text: 'あいうえ。' }] },
        { columns: 4, lineBreaking: 'none' },
      ),
    ).toMatchObject({ lines: 2, lineBreaking: 'none' });
    expect(() =>
      manuscriptPaperEstimate({ schemaVersion: 2, blocks: [] }, { lineBreaking: 'loose' as never }),
    ).toThrow('line breaking');
  });

  it('skips hidden blocks unless requested and rejects invalid paper sizes', () => {
    const doc = content();
    expect(manuscriptPaperEstimate(doc).lines).toBe(4);
    expect(manuscriptPaperEstimate(doc, { hidden: true }).lines).toBe(5);
    // The engine keeps one empty paragraph in an empty Document.
    expect(manuscriptPaperEstimate({ schemaVersion: 2, blocks: [] })).toMatchObject({
      sheets: 1,
      lines: 1,
    });
    expect(() => manuscriptPaperEstimate(doc, { columns: 0 })).toThrow('columns');
    expect(() => manuscriptPaperEstimate(doc, { rows: 1.5 })).toThrow('rows');
  });
});
