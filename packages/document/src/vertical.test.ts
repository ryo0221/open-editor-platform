import { describe, expect, it } from 'vitest';
import { contentToNode } from './engine';
import { isDocument, isVerticalDocument, type DocumentContent } from './model';
import { layoutVerticalDocument, verticalTextLines } from './print-vertical';
import { uprightDigitDecorations, uprightDigitRanges } from './vertical';

const vertical: DocumentContent = {
  schemaVersion: 2,
  page: { size: 'A4', margin: 64, writingMode: 'vertical-rl' },
  blocks: [{ id: 'p', type: 'paragraph', text: '第1章、12時、2026年、１２月' }],
};

describe('Vertical manuscript setting', () => {
  it('validates the writing mode as a page setting', () => {
    expect(isDocument(vertical)).toBe(true);
    expect(isVerticalDocument(vertical)).toBe(true);
    expect(isVerticalDocument({ page: { size: 'A4', margin: 64 } })).toBe(false);
    expect(isDocument({ ...vertical, page: { size: 'A4', margin: 64, writingMode: 'tb' } })).toBe(
      false,
    );
  });

  it('sets runs of one or two ASCII digits upright, without changing positions', () => {
    expect(uprightDigitRanges('第1章、12時、2026年、１２月')).toEqual([
      [1, 2],
      [4, 6],
    ]);
    const doc = contentToNode(vertical);
    const decorations = uprightDigitDecorations(doc);
    expect(decorations.map((d) => doc.textBetween(d.from, d.to))).toEqual(['1', '12']);
    // Decorations are cached per immutable document.
    expect(uprightDigitDecorations(doc)).toBe(decorations);
  });

  it('finds digit runs over the whole block, never per formatting run', () => {
    const doc = contentToNode({
      ...vertical,
      blocks: [
        {
          id: 'p',
          type: 'paragraph',
          text: '2026年、12月、3日',
          rich: [
            { text: '20', bold: true },
            { text: '26年、1' },
            { text: '2', bold: true },
            { text: '月、3日' },
          ],
        },
      ],
    });
    // 2026 stays in the text direction; 12 split by formatting is not set as two groups.
    expect(uprightDigitDecorations(doc).map((d) => doc.textBetween(d.from, d.to))).toEqual(['3']);
  });
});

describe('Vertical print layout', () => {
  const page = { width: 794, height: 1123, margin: 64 };
  const latin = (text: string) => text.length * 8;
  const layout = (blocks: DocumentContent['blocks']) =>
    layoutVerticalDocument({ ...vertical, blocks }, page, latin);

  it('runs columns right to left with kinsoku, hanging 、。, ruby and upright digits', () => {
    const ruby = { text: 'とうきょう', base: '東京' };
    const result = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: '東京の12時、2026年。',
        rich: [{ text: '東京', ruby }, { text: 'の12時、2026年。' }],
      },
    ]);
    const [col] = result.pages[0];
    // 16px text with 1.75 line spacing: the first column centre is 14px inside the right margin.
    expect(col.x).toBe(794 - 64 - 14);
    expect(col.glyphs.map((g) => [g.text, g.kind])).toEqual([
      ['東', 'plain'],
      ['京', 'plain'],
      ['の', 'plain'],
      ['12', 'upright'],
      ['時', 'plain'],
      ['、', 'punctuation'],
      ['2', 'rotated'],
      ['0', 'rotated'],
      ['2', 'rotated'],
      ['6', 'rotated'],
      ['年', 'plain'],
      ['。', 'punctuation'],
    ]);
    // 縦中横 takes one cell; Latin digits take their measured width.
    expect(col.glyphs[4].y - col.glyphs[3].y).toBe(16);
    expect(col.glyphs[7].advance).toBe(8);
    expect(col.ruby).toMatchObject([{ text: 'とうきょう', y: 64, length: 32 }]);
    // Five 8px characters over a 32px base overhang it, but never above the top margin.
    expect(col.ruby[0].glyphs.map((g) => g.y)).toEqual([68, 76, 84, 92, 100]);
    expect(verticalTextLines(result)[0][0]).toMatchObject({
      text: '東京の12時、2026年。',
      vertical: true,
      y: 64,
    });
  });

  it('breaks long columns with the shared kinsoku rules and starts new pages on the left edge', () => {
    // 995px of column height holds 62 cells of 16px.
    const text = 'あ'.repeat(61) + 'い」う';
    const [first, second] = layout([{ id: 'p', type: 'paragraph', text }]).pages[0];
    expect(first.glyphs.map((g) => g.text).join('')).toBe('あ'.repeat(61));
    expect(second.glyphs.map((g) => g.text).join('')).toBe('い」う');
    expect(second.glyphs[1].kind).toBe('rotated');
    const many = layout(
      Array.from({ length: 40 }, (_, i) => ({
        id: `p${i}`,
        type: 'paragraph' as const,
        text: '本文',
      })),
    );
    // Each paragraph takes one 28px column plus 10px after it: 17 fit across 666px.
    expect(many.pages.map((p) => p.length)).toEqual([17, 17, 6]);
    expect(Math.min(...many.pages[0].map((c) => c.x))).toBeGreaterThanOrEqual(64);
  });

  it('aligns along the column and refuses a ruby base longer than a column', () => {
    const [centred, end] = layout([
      { id: 'c', type: 'heading', level: 1, text: '題', align: 'center' },
      { id: 'e', type: 'paragraph', text: '署名', align: 'right' },
    ]).pages[0];
    // 995px of column height: a 34px heading is centred, a 32px signature ends at the bottom.
    expect(centred.glyphs[0].y).toBeCloseTo(64 + (995 - 34) / 2);
    expect(end.glyphs[1].y + end.glyphs[1].advance).toBeCloseTo(64 + 995);
    const base = '長'.repeat(100);
    expect(() =>
      layout([
        {
          id: 'p',
          type: 'paragraph',
          text: base,
          rich: [{ text: base, ruby: { text: 'ながい', base } }],
        },
      ]),
    ).toThrow('縦書きの1行より長い');
  });

  it('keeps keycap digits whole, turns ruby ー on its side and never places a column off the page', () => {
    expect(uprightDigitRanges('時刻1️⃣です、2⃣と12')).toEqual([[11, 13]]);
    const [col] = layout([{ id: 'p', type: 'paragraph', text: '時刻1️⃣です' }]).pages[0];
    expect(col.glyphs.map((g) => g.text).join('')).toBe('時刻1️⃣です');
    const emoji = layout([{ id: 'p', type: 'paragraph', text: '晴れ☀️と😀と1️⃣とAB' }]).pages[0][0];
    expect(emoji.glyphs.map((g) => [g.text, g.kind])).toEqual([
      ['晴', 'plain'],
      ['れ', 'plain'],
      ['☀️', 'plain'],
      ['と', 'plain'],
      ['😀', 'plain'],
      ['と', 'plain'],
      ['1️⃣', 'plain'],
      ['と', 'plain'],
      ['A', 'rotated'],
      ['B', 'rotated'],
    ]);
    const spaced = layout([
      { id: 'p', type: 'paragraph', text: '本文', style: { spaceBefore: 600 } },
    ]);
    expect(spaced.pages).toHaveLength(1);
    expect(spaced.pages[0][0].x).toBe(794 - 64 - 14);
    expect(() =>
      layoutVerticalDocument(
        { ...vertical, blocks: [{ id: 'p', type: 'paragraph', text: '本文' }] },
        { width: 140, height: 400, margin: 60 },
        latin,
      ),
    ).toThrow('用紙に収まりません');
  });

  it('keeps long readings at full size, apart and inside the page', () => {
    const reading = (text: string, base: string) => ({ text: base, ruby: { text, base } });
    const [col] = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: '本当の志と心',
        rich: [{ text: '本当の' }, reading('こころざし', '志'), reading('こころ', '心')],
      },
      {
        id: 'q',
        type: 'paragraph',
        text: '字',
        rich: [reading('よ'.repeat(64), '字')],
      },
    ]).pages[0];
    const [kokorozashi, kokoro] = col.ruby;
    // 志 is at 112–128: its five 8px characters overhang equally, 100–140.
    expect(kokorozashi.glyphs.map((g) => [g.y, g.size])).toEqual([
      [104, 8],
      [112, 8],
      [120, 8],
      [128, 8],
      [136, 8],
    ]);
    // 心 follows directly; its reading is pushed below the previous one instead of overlapping.
    expect(kokoro.glyphs[0].y - 4).toBeGreaterThanOrEqual(140);
    const long = layout([
      { id: 'q', type: 'paragraph', text: '字', rich: [reading('よ'.repeat(64), '字')] },
    ]).pages[0][0].ruby[0];
    expect(long.glyphs[0].y - 4).toBeGreaterThanOrEqual(64);
    const huge = layoutVerticalDocument(
      {
        ...vertical,
        blocks: [
          {
            id: 'q',
            type: 'paragraph',
            text: '字',
            style: { fontSize: 72 },
            rich: [reading('よ'.repeat(64), '字')],
          },
        ],
      },
      page,
      latin,
    ).pages[0][0].ruby[0];
    // 64 readings of 48px cannot fit 995px: they shrink to fit between the margins.
    expect(huge.glyphs[0].size).toBeCloseTo(995 / 64);
    expect(huge.glyphs.at(-1)!.y + huge.glyphs.at(-1)!.size / 2).toBeLessThanOrEqual(
      1123 - 64 + 0.01,
    );
  });

  it('fits adjacent readings at the bottom of a column without overlapping', () => {
    const reading = (text: string, base: string) => ({ text: base, ruby: { text, base } });
    const body = 'あ'.repeat(60);
    const [col] = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: body + '志心',
        rich: [{ text: body }, reading('こころざし', '志'), reading('こころ', '心')],
      },
    ]).pages[0];
    const [a, b] = col.ruby.map((r) => r.glyphs);
    expect(a.at(-1)!.y + 4).toBeLessThanOrEqual(b[0].y - 4 + 0.01);
    expect(b.at(-1)!.y + 4).toBeLessThanOrEqual(1123 - 64 + 0.01);
    expect(a[0].size).toBe(8);
  });

  it('spaces a ruby column so its reading clears the previous column', () => {
    const reading = (text: string, base: string) => ({ text: base, ruby: { text, base } });
    const body = 'あ'.repeat(62);
    const [first, second] = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: body + '漢',
        style: { lineHeight: 1 },
        rich: [{ text: body }, reading('かん', '漢')],
      },
    ]).pages[0];
    expect(second.ruby).toHaveLength(1);
    // The reading is painted from x + 8 + 1 to x + 8 + 1 + 8 and must not reach 16px body text.
    expect(second.x + 8 + 1 + 8).toBeLessThanOrEqual(first.x - 8 + 0.01);
    // A column that starts a page keeps its reading on the paper.
    const [big] = layoutVerticalDocument(
      {
        ...vertical,
        blocks: [
          {
            id: 'p',
            type: 'paragraph',
            text: '漢',
            style: { fontSize: 54, lineHeight: 1 },
            rich: [reading('かん', '漢')],
          },
        ],
      },
      { width: 794, height: 1123, margin: 24 },
      latin,
    ).pages[0];
    expect(big.x + 36 + 1 + 36).toBeLessThanOrEqual(794 + 0.01);
  });

  it('puts 傍点 beside each character, on the far side under a ruby, and spaces columns for it', () => {
    const body = 'あ'.repeat(62);
    const [first, second] = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: body + '本当、東京',
        style: { lineHeight: 1 },
        rich: [
          { text: body },
          { text: '本当、', emphasisDots: true },
          { text: '東京', emphasisDots: true, ruby: { text: 'とうきょう', base: '東京' } },
        ],
      },
      { id: 'q', type: 'paragraph', text: 'い'.repeat(70), style: { lineHeight: 1 } },
    ]).pages[0];
    expect(second.glyphs.map((g) => [g.text, g.dot])).toEqual([
      ['本', 'right'],
      ['当', 'right'],
      ['、', undefined],
      ['東', 'left'],
      ['京', 'left'],
    ]);
    // Right dots reach 8 + 0.3em past the centre and clear the previous column's text; left
    // dots push the next column away by the same amount.
    expect(second.x + 8 + 0.3 * 16).toBeLessThanOrEqual(first.x - 8 + 0.01);
    const third = layout([
      {
        id: 'p',
        type: 'paragraph',
        text: '東京' + 'い'.repeat(70),
        style: { lineHeight: 1 },
        rich: [
          { text: '東京', emphasisDots: true, ruby: { text: 'とうきょう', base: '東京' } },
          { text: 'い'.repeat(70) },
        ],
      },
    ]).pages[0];
    expect(third[1].x + 8).toBeLessThanOrEqual(third[0].x - 8 - 0.3 * 16 + 0.01);
  });

  it('lays out long paragraphs with many numbers and rubies in linear time', () => {
    const text = 'あ12'.repeat(10000);
    const started = performance.now();
    const result = layout([{ id: 'p', type: 'paragraph', text }]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(
      result.pages
        .flat()
        .flatMap((c) => c.glyphs)
        .filter((g) => g.kind === 'upright'),
    ).toHaveLength(10000);
  });

  it('needs a figure renderer for upright blocks instead of setting them horizontally', () => {
    expect(() =>
      layout([
        { id: 'p', type: 'paragraph', text: '本文' },
        { id: 't', type: 'table', text: '' },
      ]),
    ).toThrow('表を置くには図の描画が必要です');
  });

  it('sets list items as indented columns with their markers', () => {
    const result = layout([
      {
        id: 'l',
        type: 'numbered-list',
        text: '',
        start: 3,
        items: [
          {
            id: 'a',
            rich: [{ text: '港' }],
            children: [{ id: 'b', rich: [{ text: '坂' }] }],
          },
          { id: 'c', rich: [{ text: '灯台' }] },
        ],
      },
      {
        id: 'k',
        type: 'check-list',
        text: '',
        items: [{ id: 'd', rich: [{ text: '済' }], checked: true }],
      },
    ]);
    const columns = result.pages[0];
    expect(columns.map((c) => c.glyphs.map((g) => g.text).join(''))).toEqual([
      '3．港',
      '・坂',
      '4．灯台',
      '■　済',
    ]);
    // A nested item starts one level (1.5em) lower; columns run right to left.
    expect(columns[1].top).toBe(columns[0].top + 1.5 * columns[0].size);
    expect(columns[1].x).toBeLessThan(columns[0].x);
  });

  it('reserves upright boxes for figures in the right-to-left flow, turning pages as needed', () => {
    const sizes: Record<string, { width: number; height: number }[]> = {
      i: [{ width: 300, height: 200 }],
      t: [
        { width: 600, height: 900 },
        { width: 600, height: 120 },
      ],
    };
    const result = layoutVerticalDocument(
      {
        ...vertical,
        blocks: [
          { id: 'p', type: 'paragraph', text: '前' },
          { id: 'i', type: 'image', text: '', src: 'data:,' },
          { id: 't', type: 'table', text: '' },
          { id: 'q', type: 'paragraph', text: '後' },
        ],
      },
      page,
      latin,
      (block, box) => {
        expect(box).toEqual({ maxWidth: 794 - 128, maxHeight: 1123 - 128 });
        return sizes[block.id];
      },
    );
    const [first, second, third] = result.figures;
    const before = result.pages[0][0];
    // The image stands left of the first column, at the top of the text area.
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ blockId: 'i', y: 64, width: 300, after: 1 });
    expect(first[0].x + 300).toBeLessThanOrEqual(before.x - before.size / 2);
    // Each table slice takes a page of its own when the one before has no room.
    expect(second).toEqual([
      { blockId: 't', slice: 0, x: 730 - 600, y: 64, width: 600, height: 900, after: 0 },
    ]);
    expect(third[0]).toMatchObject({ blockId: 't', slice: 1, x: 730 - 600 });
    // Text after the figure continues left of it.
    expect(result.pages[2][0].x).toBeLessThan(third[0].x);
    const lines = verticalTextLines(result, (fig) =>
      fig.blockId === 'i' ? [{ text: 'cap', x: 1, y: 2, size: 12, width: 20, order: 0 }] : [],
    );
    expect(lines[0].map((l) => [l.text, l.x, l.y, l.order])).toEqual([
      ['前', before.x, before.top, 0],
      ['cap', first[0].x + 1, 66, 1],
    ]);
  });
});
